-- Estate OS · 0002 · CRM and operations tables
-- Every tenant-owned row carries organization_id. RLS checks membership + capability.
-- Integrity rules that must hold regardless of client live in triggers (0003).

-- ───────────────────────── shared guards ─────────────────────────

create or replace function private.prevent_org_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    perform private.fail('FORBIDDEN', 'Records cannot be moved between organizations');
  end if;
  return new;
end;
$$;

-- Raises unless row `ref_id` in `tbl` belongs to `org`. Reads across tenants only to compare ids.
create or replace function private.assert_same_org(tbl text, ref_id uuid, org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  ref_org uuid;
begin
  if ref_id is null then return; end if;
  execute format('select organization_id from public.%I where id = $1', tbl) into ref_org using ref_id;
  if ref_org is null or ref_org <> org then
    perform private.fail('INVALID_REFERENCE', format('Referenced %s does not exist in this organization', replace(tbl, '_', ' ')));
  end if;
end;
$$;

create or replace function private.assert_member(org uuid, member uuid, label text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not private.is_active_member(org, member) then
    perform private.fail('INVALID_REFERENCE', format('%s must be an active member of this organization', label));
  end if;
end;
$$;

create or replace function private.normalize_phone(raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when raw is null or regexp_replace(raw, '\D', '', 'g') = '' then null
    when length(regexp_replace(raw, '\D', '', 'g')) = 10 then '+91' || regexp_replace(raw, '\D', '', 'g')
    else '+' || regexp_replace(raw, '\D', '', 'g')
  end;
$$;

-- ───────────────────────── contacts ─────────────────────────

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contact_type text not null default 'person' check (contact_type in ('person', 'company')),
  display_name text not null check (char_length(display_name) between 1 and 160),
  email text check (email is null or char_length(email) <= 254),
  email_normalized text,
  phone text check (phone is null or char_length(phone) <= 32),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  roles text[] not null default '{}' check (roles <@ array['buyer', 'seller', 'tenant', 'landlord', 'investor', 'owner', 'other']),
  preferred_contact_channel text not null default 'whatsapp' check (preferred_contact_channel in ('phone', 'email', 'sms', 'whatsapp', 'none')),
  lifecycle_status text not null default 'new' check (lifecycle_status in ('new', 'active', 'nurture', 'client', 'inactive', 'do_not_contact')),
  source text check (char_length(source) <= 80),
  assigned_to uuid references public.profiles (id) on delete set null,
  tags text[] not null default '{}',
  custom_fields jsonb not null default '{}',
  last_contacted_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_reachable check (email is not null or phone is not null),
  constraint contacts_email_format check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

create index contacts_org_status_created_idx on public.contacts (organization_id, lifecycle_status, created_at desc);
create index contacts_org_assignee_idx on public.contacts (organization_id, assigned_to);
create index contacts_org_email_idx on public.contacts (organization_id, email_normalized) where email_normalized is not null;
create index contacts_org_phone_idx on public.contacts (organization_id, phone_e164) where phone_e164 is not null;

create table public.communication_consents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  channel text not null check (channel in ('phone', 'sms', 'email', 'whatsapp')),
  purpose text not null default 'service' check (purpose in ('service', 'marketing', 'ai_call', 'appointment_reminder')),
  status text not null default 'unknown' check (status in ('unknown', 'granted', 'denied', 'revoked')),
  captured_via text check (char_length(captured_via) <= 80),
  granted_at timestamptz,
  revoked_at timestamptz,
  captured_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id, channel, purpose)
);

create index communication_consents_org_idx on public.communication_consents (organization_id, contact_id);

-- ───────────────────────── leads ─────────────────────────

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contact_id uuid not null references public.contacts (id) on delete restrict,
  title text not null check (char_length(title) between 1 and 160),
  status text not null default 'new' check (status in ('new', 'attempting', 'contacted', 'qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won', 'lost', 'nurture')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  lead_type text not null default 'buyer' check (lead_type in ('buyer', 'seller', 'tenant', 'landlord', 'investor')),
  desired_transaction text not null default 'buy' check (desired_transaction in ('buy', 'rent', 'sell', 'let', 'invest')),
  source text not null check (char_length(source) between 1 and 80),
  source_campaign text check (char_length(source_campaign) <= 120),
  source_external_id text check (char_length(source_external_id) <= 200),
  assigned_to uuid references public.profiles (id) on delete set null,
  lead_score numeric(5, 2) not null default 0,
  score_reasons text[] not null default '{}',
  budget_min numeric(14, 2) check (budget_min is null or budget_min >= 0),
  budget_max numeric(14, 2) check (budget_max is null or budget_max > 0),
  budget_currency char(3) not null default 'INR',
  desired_property_type text check (desired_property_type in ('apartment', 'penthouse', 'villa', 'house', 'townhouse', 'plot', 'office', 'retail', 'commercial', 'other')),
  desired_locations text[] not null default '{}',
  bedrooms smallint check (bedrooms is null or bedrooms between 0 and 20),
  timeline text check (char_length(timeline) <= 40),
  required_amenities text[] not null default '{}',
  ai_extracted_fields text[] not null default '{}',
  summary text check (char_length(summary) <= 4000),
  next_follow_up_at timestamptz,
  first_response_at timestamptz,
  last_contact_at timestamptz,
  qualified_at timestamptz,
  closed_at timestamptz,
  lost_reason text check (char_length(lost_reason) <= 200),
  archived_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  metadata jsonb not null default '{}',
  -- Pipeline order, so lists can sort by stage on the server.
  status_rank smallint generated always as (case status when 'new' then 1 when 'attempting' then 2 when 'contacted' then 3
    when 'qualified' then 4 when 'matching' then 5 when 'visit_scheduled' then 6 when 'visit_completed' then 7 when 'negotiation' then 8
    when 'won' then 9 when 'lost' then 10 else 11 end) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_budget_order check (budget_min is null or budget_max is null or budget_min <= budget_max),
  constraint leads_lost_needs_reason check (status <> 'lost' or lost_reason is not null)
);

create index leads_org_status_created_idx on public.leads (organization_id, status, created_at desc);
create index leads_org_assignee_status_idx on public.leads (organization_id, assigned_to, status);
create index leads_org_created_idx on public.leads (organization_id, created_at desc);
create index leads_org_followup_idx on public.leads (organization_id, next_follow_up_at)
  where next_follow_up_at is not null and archived_at is null;
create index leads_contact_idx on public.leads (contact_id);
create unique index leads_external_id_uniq on public.leads (organization_id, source, source_external_id)
  where source_external_id is not null;

create table public.lead_status_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  lead_id uuid not null references public.leads (id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references public.profiles (id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);
create index lead_status_history_lead_idx on public.lead_status_history (lead_id, created_at desc);
create index lead_status_history_org_idx on public.lead_status_history (organization_id, created_at desc);

create table public.lead_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  lead_id uuid not null references public.leads (id) on delete cascade,
  from_user_id uuid references public.profiles (id) on delete set null,
  to_user_id uuid references public.profiles (id) on delete set null,
  assigned_by uuid references public.profiles (id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);
create index lead_assignments_lead_idx on public.lead_assignments (lead_id, created_at desc);

-- ───────────────────────── properties ─────────────────────────

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  reference_code text not null check (char_length(reference_code) between 1 and 40),
  title text not null check (char_length(title) between 4 and 200),
  description text check (char_length(description) <= 8000),
  property_type text not null check (property_type in ('apartment', 'penthouse', 'villa', 'house', 'townhouse', 'plot', 'office', 'retail', 'commercial', 'other')),
  listing_type text not null check (listing_type in ('sale', 'rent')),
  status text not null default 'draft' check (status in ('draft', 'active', 'under_offer', 'reserved', 'let', 'sold', 'withdrawn', 'archived')),
  price numeric(14, 2) not null check (price > 0),
  currency char(3) not null default 'INR',
  bedrooms smallint not null default 0 check (bedrooms between 0 and 20),
  bathrooms numeric(4, 1) not null default 1 check (bathrooms between 0 and 20),
  area_value numeric(12, 2) not null check (area_value > 0),
  area_unit text not null default 'sqft' check (area_unit in ('sqft', 'sqm', 'acre', 'hectare')),
  furnishing text not null default 'semi' check (furnishing in ('unfurnished', 'semi', 'full')),
  address_line_1 text,
  locality text not null check (char_length(locality) between 1 and 120),
  city text,
  postal_code text,
  amenities text[] not null default '{}',
  owner_contact_id uuid references public.contacts (id) on delete set null,
  listing_agent_id uuid references public.profiles (id) on delete set null,
  verified_at timestamptz,
  verified_by uuid references public.profiles (id) on delete set null,
  cover_image_path text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, reference_code)
);

create index properties_org_status_listing_price_idx on public.properties (organization_id, status, listing_type, price);
create index properties_org_locality_idx on public.properties (organization_id, locality, status);

-- ───────────────────────── deals & commissions ─────────────────────────

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  title text not null check (char_length(title) between 1 and 200),
  lead_id uuid references public.leads (id) on delete set null,
  primary_contact_id uuid not null references public.contacts (id) on delete restrict,
  property_id uuid references public.properties (id) on delete set null,
  stage text not null default 'qualification' check (stage in ('qualification', 'viewing', 'offer', 'negotiation', 'under_contract', 'won', 'lost')),
  expected_value numeric(14, 2) not null check (expected_value > 0),
  commission_pct numeric(6, 2) not null default 0 check (commission_pct between 0 and 100),
  currency char(3) not null default 'INR',
  expected_close_date date,
  owner_user_id uuid references public.profiles (id) on delete set null,
  lost_reason text check (char_length(lost_reason) <= 200),
  stage_changed_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deals_lost_needs_reason check (stage <> 'lost' or lost_reason is not null)
);
create index deals_org_stage_idx on public.deals (organization_id, stage, stage_changed_at desc);
create index deals_lead_idx on public.deals (lead_id);

create table public.commissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  deal_id uuid not null unique references public.deals (id) on delete restrict,
  beneficiary_user_id uuid references public.profiles (id) on delete set null,
  gross_commission numeric(14, 2) not null check (gross_commission >= 0),
  currency char(3) not null default 'INR',
  status text not null default 'estimated' check (status in ('estimated', 'approved', 'payable', 'paid', 'void')),
  calculation_snapshot jsonb not null default '{}',
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index commissions_org_status_idx on public.commissions (organization_id, status);

-- ───────────────────────── appointments ─────────────────────────

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  title text not null check (char_length(title) between 1 and 200),
  appointment_type text not null default 'viewing' check (appointment_type in ('viewing', 'consultation', 'valuation', 'follow_up')),
  status text not null default 'confirmed' check (status in ('requested', 'pending', 'confirmed', 'completed', 'cancelled', 'no_show', 'reschedule_requested')),
  lead_id uuid references public.leads (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  property_id uuid references public.properties (id) on delete set null,
  assigned_to uuid references public.profiles (id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Asia/Kolkata',
  location_text text check (char_length(location_text) <= 300),
  source text not null default 'user' check (source in ('user', 'ai', 'workflow', 'integration')),
  cancellation_reason text check (char_length(cancellation_reason) <= 200),
  feedback text check (char_length(feedback) <= 2000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_time_order check (ends_at > starts_at),
  constraint appointments_max_length check (ends_at - starts_at <= interval '8 hours')
);
create index appointments_org_starts_idx on public.appointments (organization_id, starts_at);
create index appointments_assignee_starts_idx on public.appointments (assigned_to, starts_at);
create index appointments_lead_idx on public.appointments (lead_id);

-- ───────────────────────── tasks ─────────────────────────

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  title text not null check (char_length(title) between 1 and 200),
  description text check (char_length(description) <= 4000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'completed', 'cancelled')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  due_at timestamptz not null,
  completed_at timestamptz,
  assigned_to uuid references public.profiles (id) on delete set null,
  related_lead_id uuid references public.leads (id) on delete set null,
  related_deal_id uuid references public.deals (id) on delete set null,
  related_property_id uuid references public.properties (id) on delete set null,
  source text not null default 'manual' check (source in ('manual', 'workflow', 'ai', 'integration')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_org_assignee_status_due_idx on public.tasks (organization_id, assigned_to, status, due_at);
create index tasks_org_due_idx on public.tasks (organization_id, due_at);

-- ───────────────────────── activities (timeline) ─────────────────────────

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  lead_id uuid references public.leads (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  deal_id uuid references public.deals (id) on delete cascade,
  activity_type text not null check (activity_type in ('created', 'status', 'assigned', 'call', 'message', 'note', 'appointment', 'property_sent', 'ai_update', 'opt_out', 'deal', 'task', 'workflow', 'updated')),
  title text not null check (char_length(title) between 1 and 300),
  description text check (char_length(description) <= 4000),
  source text not null default 'user' check (source in ('user', 'ai', 'system', 'integration', 'workflow')),
  actor_name text not null default 'System',
  created_by uuid references public.profiles (id) on delete set null,
  metadata jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index activities_org_occurred_idx on public.activities (organization_id, occurred_at desc);
create index activities_lead_idx on public.activities (lead_id, occurred_at desc);
create index activities_contact_idx on public.activities (contact_id, occurred_at desc);

-- ───────────────────────── triggers: org immutability & timestamps ─────────────────────────

do $$
declare
  t text;
begin
  foreach t in array array['contacts', 'communication_consents', 'leads', 'properties', 'deals', 'commissions', 'appointments', 'tasks'] loop
    execute format('create trigger %1$s_updated_at before update on public.%1$s for each row execute function public.set_updated_at()', t);
  end loop;
  foreach t in array array['contacts', 'communication_consents', 'leads', 'lead_status_history', 'lead_assignments', 'properties', 'deals', 'commissions', 'appointments', 'tasks', 'activities'] loop
    execute format('create trigger %1$s_org_immutable before update on public.%1$s for each row execute function private.prevent_org_change()', t);
  end loop;
end;
$$;

-- ───────────────────────── RLS ─────────────────────────

alter table public.contacts enable row level security;
alter table public.communication_consents enable row level security;
alter table public.leads enable row level security;
alter table public.lead_status_history enable row level security;
alter table public.lead_assignments enable row level security;
alter table public.properties enable row level security;
alter table public.deals enable row level security;
alter table public.commissions enable row level security;
alter table public.appointments enable row level security;
alter table public.tasks enable row level security;
alter table public.activities enable row level security;

create policy contacts_read on public.contacts for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy contacts_insert on public.contacts for insert to authenticated with check (public.has_perm(organization_id, 'contacts.edit'));
create policy contacts_update on public.contacts for update to authenticated
  using (public.has_perm(organization_id, 'contacts.edit')) with check (public.has_perm(organization_id, 'contacts.edit'));

create policy consents_read on public.communication_consents for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy consents_insert on public.communication_consents for insert to authenticated with check (public.has_perm(organization_id, 'contacts.edit'));
create policy consents_update on public.communication_consents for update to authenticated
  using (public.has_perm(organization_id, 'contacts.edit')) with check (public.has_perm(organization_id, 'contacts.edit'));

create policy leads_read on public.leads for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy leads_insert on public.leads for insert to authenticated with check (public.has_perm(organization_id, 'leads.edit'));
-- Agents may edit leads assigned to them (or unassigned ones they claim); managers and up may edit any.
create policy leads_update on public.leads for update to authenticated
  using (
    public.has_perm(organization_id, 'leads.edit_any')
    or (public.has_perm(organization_id, 'leads.edit') and (assigned_to = (select auth.uid()) or assigned_to is null))
  )
  with check (
    public.has_perm(organization_id, 'leads.edit_any')
    or (public.has_perm(organization_id, 'leads.edit') and assigned_to = (select auth.uid()))
  );

create policy lead_status_history_read on public.lead_status_history for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy lead_assignments_read on public.lead_assignments for select to authenticated using (public.has_perm(organization_id, 'leads.view'));

create policy properties_read on public.properties for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy properties_insert on public.properties for insert to authenticated with check (public.has_perm(organization_id, 'properties.edit'));
create policy properties_update on public.properties for update to authenticated
  using (public.has_perm(organization_id, 'properties.edit')) with check (public.has_perm(organization_id, 'properties.edit'));

create policy deals_read on public.deals for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy deals_insert on public.deals for insert to authenticated with check (public.has_perm(organization_id, 'deals.edit'));
create policy deals_update on public.deals for update to authenticated
  using (public.has_perm(organization_id, 'deals.edit')) with check (public.has_perm(organization_id, 'deals.edit'));

create policy commissions_read on public.commissions for select to authenticated
  using (public.has_perm(organization_id, 'finance.view') or beneficiary_user_id = (select auth.uid()));
create policy commissions_update on public.commissions for update to authenticated
  using (public.has_perm(organization_id, 'finance.edit')) with check (public.has_perm(organization_id, 'finance.edit'));

create policy appointments_read on public.appointments for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy appointments_insert on public.appointments for insert to authenticated with check (public.has_perm(organization_id, 'appointments.edit'));
create policy appointments_update on public.appointments for update to authenticated
  using (public.has_perm(organization_id, 'appointments.edit')) with check (public.has_perm(organization_id, 'appointments.edit'));

create policy tasks_read on public.tasks for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy tasks_insert on public.tasks for insert to authenticated with check (public.has_perm(organization_id, 'tasks.edit'));
create policy tasks_update on public.tasks for update to authenticated
  using (public.has_perm(organization_id, 'tasks.edit')) with check (public.has_perm(organization_id, 'tasks.edit'));

create policy activities_read on public.activities for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
-- People may add notes in their own name; everything else is written by triggers.
create policy activities_insert_note on public.activities for insert to authenticated
  with check (
    activity_type = 'note' and source = 'user' and created_by = (select auth.uid())
    and public.has_perm(organization_id, 'leads.edit')
  );

-- ───────────────────────── column privileges (mass-assignment guard) ─────────────────────────

revoke insert, update, delete on public.contacts, public.communication_consents, public.leads, public.lead_status_history,
  public.lead_assignments, public.properties, public.deals, public.commissions, public.appointments, public.tasks, public.activities
  from authenticated, anon;

grant insert (organization_id, contact_type, display_name, email, phone, roles, preferred_contact_channel, lifecycle_status, source, assigned_to, tags, custom_fields)
  on public.contacts to authenticated;
grant update (display_name, email, phone, roles, preferred_contact_channel, lifecycle_status, assigned_to, tags, custom_fields, last_contacted_at)
  on public.contacts to authenticated;

grant insert (organization_id, contact_id, channel, purpose, status, captured_via) on public.communication_consents to authenticated;
grant update (status, captured_via) on public.communication_consents to authenticated;

grant insert (organization_id, contact_id, title, status, priority, lead_type, desired_transaction, source, source_campaign, assigned_to,
  budget_min, budget_max, desired_property_type, desired_locations, bedrooms, timeline, required_amenities, summary, next_follow_up_at)
  on public.leads to authenticated;
grant update (title, status, priority, lead_type, desired_transaction, assigned_to, budget_min, budget_max, desired_property_type,
  desired_locations, bedrooms, timeline, required_amenities, summary, next_follow_up_at, last_contact_at, lost_reason, archived_at)
  on public.leads to authenticated;

grant insert (organization_id, reference_code, title, description, property_type, listing_type, status, price, bedrooms, bathrooms,
  area_value, area_unit, furnishing, address_line_1, locality, city, postal_code, amenities, owner_contact_id, listing_agent_id, cover_image_path)
  on public.properties to authenticated;
grant update (title, description, property_type, listing_type, status, price, bedrooms, bathrooms, area_value, area_unit, furnishing,
  address_line_1, locality, city, postal_code, amenities, owner_contact_id, listing_agent_id, verified_at, cover_image_path)
  on public.properties to authenticated;

grant insert (organization_id, title, lead_id, primary_contact_id, property_id, stage, expected_value, commission_pct, expected_close_date, owner_user_id)
  on public.deals to authenticated;
grant update (title, property_id, stage, expected_value, commission_pct, expected_close_date, owner_user_id, lost_reason)
  on public.deals to authenticated;

grant update (status) on public.commissions to authenticated;

grant insert (organization_id, title, appointment_type, status, lead_id, contact_id, property_id, assigned_to, starts_at, ends_at, location_text)
  on public.appointments to authenticated;
grant update (title, status, starts_at, ends_at, location_text, assigned_to, cancellation_reason, feedback)
  on public.appointments to authenticated;

grant insert (organization_id, title, description, status, priority, due_at, assigned_to, related_lead_id, related_deal_id, related_property_id)
  on public.tasks to authenticated;
grant update (title, description, status, priority, due_at, assigned_to) on public.tasks to authenticated;

grant insert (organization_id, lead_id, contact_id, deal_id, activity_type, title, description, source, created_by) on public.activities to authenticated;
