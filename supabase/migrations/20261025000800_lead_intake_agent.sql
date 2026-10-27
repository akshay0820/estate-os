-- Estate OS · 0008 · Agent 01 — Lead Intake Agent (lead_intake_agent)
-- Durable runs, a transactional outbox, a human review queue, and the deterministic intake pipeline:
-- validate → normalize → dedupe (tenant-scoped) → create/link → assign → activity → handoff event.
-- Additive only: new tables, two nullable lead columns, and replaced function bodies. No data is changed or removed.

-- ───────────────────────── agent runs ─────────────────────────

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  agent_id text not null check (agent_id ~ '^[a-z][a-z0-9_]{2,59}$'),
  agent_version text not null check (char_length(agent_version) between 1 and 40),
  trigger_event text not null check (char_length(trigger_event) between 1 and 80),
  source_kind text not null check (source_kind in ('webhook', 'manual', 'import', 'voice', 'integration')),
  provider text not null check (provider ~ '^[a-z0-9][a-z0-9_.-]{0,59}$'),
  external_event_id text check (char_length(external_event_id) <= 200),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 300),
  correlation_id uuid not null default gen_random_uuid(),
  status text not null default 'received'
    check (status in ('received', 'succeeded', 'review_required', 'invalid', 'retry_scheduled', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz,
  -- The validated submission, kept only until the run finishes successfully (then redacted).
  input jsonb not null default '{}',
  -- Model proposal after schema validation; untrusted, merged under the structured fields.
  extraction jsonb,
  -- Model id, prompt version, latency, token counts and outcome. Never prompt or response text.
  model_meta jsonb,
  -- Duplicate / assignment outcome, warnings, missing fields. Ids and codes only.
  outcome jsonb not null default '{}',
  lead_id uuid references public.leads (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  error_category text check (error_category in ('validation', 'database', 'dependency', 'unknown')),
  error_message text check (char_length(error_message) <= 500),
  received_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer,
  unique (organization_id, agent_id, idempotency_key)
);
create index agent_runs_org_received_idx on public.agent_runs (organization_id, received_at desc);
create index agent_runs_due_idx on public.agent_runs (status, next_attempt_at) where status in ('received', 'retry_scheduled');
create index agent_runs_lead_idx on public.agent_runs (lead_id) where lead_id is not null;

create table public.agent_run_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  run_id uuid not null references public.agent_runs (id) on delete cascade,
  step text not null check (step ~ '^[a-z_]{2,40}$'),
  status text not null check (status in ('ok', 'skipped', 'warning', 'failed')),
  detail jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp()
);
create index agent_run_steps_run_idx on public.agent_run_steps (run_id, created_at);

-- ───────────────────────── outbox ─────────────────────────

create table public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  event_type text not null check (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  schema_version smallint not null default 1,
  record_type text not null,
  record_id uuid not null,
  correlation_id uuid,
  payload jsonb not null default '{}',
  -- Null consumer = informational business event (status 'published'); otherwise delivered to that consumer.
  consumer text check (consumer ~ '^[a-z][a-z0-9_]{2,59}$'),
  status text not null default 'pending' check (status in ('published', 'pending', 'processing', 'delivered', 'dead_letter')),
  attempts integer not null default 0,
  max_attempts integer not null default 10,
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  delivered_at timestamptz,
  last_error text check (char_length(last_error) <= 300),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 300),
  created_at timestamptz not null default now(),
  unique (organization_id, dedupe_key)
);
create index outbox_events_claim_idx on public.outbox_events (consumer, status, available_at) where status in ('pending', 'processing');
create index outbox_events_record_idx on public.outbox_events (organization_id, record_type, record_id);

-- ───────────────────────── review queue ─────────────────────────

create table public.review_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  review_type text not null check (review_type in ('possible_duplicate')),
  status text not null default 'open' check (status in ('open', 'resolved')),
  lead_id uuid not null references public.leads (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  candidate_contact_ids uuid[] not null default '{}',
  reasons text[] not null default '{}',
  run_id uuid references public.agent_runs (id) on delete set null,
  resolution text check (resolution in ('distinct', 'duplicate')),
  resolved_lead_id uuid references public.leads (id) on delete set null,
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index review_items_one_open_uniq on public.review_items (lead_id, review_type) where status = 'open';
create index review_items_org_status_idx on public.review_items (organization_id, status, created_at desc);

-- ───────────────────────── lead columns ─────────────────────────

alter table public.leads
  add column intake_status text check (intake_status in ('completed', 'review_required')),
  add column duplicate_status text check (duplicate_status in ('unique', 'linked_contact', 'possible_duplicate', 'resolved_distinct', 'merged'));

-- Clients cannot set intake state; only SECURITY DEFINER intake functions (running as the owner) can.
create or replace function private.leads_intake_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.intake_status := 'completed';
      new.duplicate_status := null;
    else
      new.intake_status := old.intake_status;
      new.duplicate_status := old.duplicate_status;
    end if;
  end if;
  return new;
end;
$$;
create trigger leads_intake_guard before insert or update on public.leads for each row execute function private.leads_intake_guard();

-- Agent-written activities keep their actor name; client-written ones are still stamped by the server.
create or replace function private.activities_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.assert_same_org('leads', new.lead_id, new.organization_id);
  perform private.assert_same_org('contacts', new.contact_id, new.organization_id);
  perform private.assert_same_org('deals', new.deal_id, new.organization_id);
  if new.lead_id is not null and new.contact_id is null then
    select contact_id into new.contact_id from public.leads where id = new.lead_id;
  end if;
  if current_user in ('authenticated', 'anon') or new.actor_name is null or new.actor_name = 'System' then
    new.actor_name := private.actor_name();
  end if;
  new.occurred_at := now();
  return new;
end;
$$;

-- ───────────────────────── RLS ─────────────────────────

alter table public.agent_runs enable row level security;
alter table public.agent_run_steps enable row level security;
alter table public.outbox_events enable row level security;
alter table public.review_items enable row level security;
create policy agent_runs_read on public.agent_runs for select to authenticated using (public.has_perm(organization_id, 'logs.view'));
create policy agent_run_steps_read on public.agent_run_steps for select to authenticated using (public.has_perm(organization_id, 'logs.view'));
create policy outbox_events_read on public.outbox_events for select to authenticated using (public.has_perm(organization_id, 'logs.view'));
create policy review_items_read on public.review_items for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
revoke all on public.agent_runs, public.agent_run_steps, public.outbox_events, public.review_items from anon;
revoke insert, update, delete, truncate on public.agent_runs, public.agent_run_steps, public.outbox_events, public.review_items from authenticated;

-- ───────────────────────── organization settings ─────────────────────────
-- Adds the optional `intake` object: { source_rules: [{source, user_id}], fallback_user_id, extraction_enabled }.

create or replace function private.validate_org_settings()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s jsonb := new.settings;
  i jsonb := new.settings -> 'intake';
  uuid_re text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(s) <> 'object'
     or (s -> 'business_hours' ->> 'start')::int not between 0 and 23
     or (s -> 'business_hours' ->> 'end')::int not between 1 and 24
     or (s -> 'business_hours' ->> 'start')::int >= (s -> 'business_hours' ->> 'end')::int
     or (s -> 'calling_hours' ->> 'start')::int not between 0 and 23
     or (s -> 'calling_hours' ->> 'end')::int not between 1 and 24
     or (s -> 'calling_hours' ->> 'start')::int >= (s -> 'calling_hours' ->> 'end')::int
     or (s ->> 'sla_minutes')::int not between 1 and 1440
     or (s ->> 'assignment') not in ('round_robin', 'least_loaded', 'by_locality')
     or jsonb_typeof(s -> 'outbound_paused') <> 'boolean'
     or jsonb_typeof(s -> 'business_hours' -> 'days') <> 'array'
  then
    perform private.fail('VALIDATION_ERROR', 'Organization settings are invalid');
  end if;
  if i is not null then
    if jsonb_typeof(i) <> 'object'
       or (i ? 'extraction_enabled' and jsonb_typeof(i -> 'extraction_enabled') <> 'boolean')
       or (i ? 'fallback_user_id' and jsonb_typeof(i -> 'fallback_user_id') <> 'null'
           and (coalesce(i ->> 'fallback_user_id', '') !~ uuid_re or not private.is_active_member(new.id, (i ->> 'fallback_user_id')::uuid)))
       or (i ? 'source_rules' and (jsonb_typeof(i -> 'source_rules') <> 'array' or jsonb_array_length(i -> 'source_rules') > 50))
       or exists (
         select 1 from jsonb_array_elements(case when jsonb_typeof(i -> 'source_rules') = 'array' then i -> 'source_rules' else '[]' end) r
         where jsonb_typeof(r) <> 'object' or char_length(coalesce(r ->> 'source', '')) not between 1 and 80
           or coalesce(r ->> 'user_id', '') !~ uuid_re or not private.is_active_member(new.id, (r ->> 'user_id')::uuid))
    then
      perform private.fail('VALIDATION_ERROR', 'Lead intake rules are invalid (assignees must be active members)');
    end if;
  end if;
  return new;
exception
  when invalid_text_representation or null_value_not_allowed then
    perform private.fail('VALIDATION_ERROR', 'Organization settings are invalid');
    return null;
end;
$$;

-- ───────────────────────── deterministic helpers ─────────────────────────

-- Trimmed, whitespace-collapsed string value of a JSON key; null for non-strings and blanks.
create or replace function private.j_text(p jsonb, k text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when jsonb_typeof(p -> k) = 'string' then nullif(regexp_replace(trim(p ->> k), '\s+', ' ', 'g'), '') end;
$$;

-- Numeric value of a JSON number or plain numeric string; null otherwise.
create or replace function private.j_num(p jsonb, k text)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p -> k) = 'number' then (p ->> k)::numeric
    when jsonb_typeof(p -> k) = 'string' and trim(p ->> k) ~ '^[0-9]{1,15}(\.[0-9]{1,4})?$' then trim(p ->> k)::numeric
  end;
$$;

-- De-duplicated (case-insensitive) list of trimmed strings, bounded in count and length.
create or replace function private.j_text_array(p jsonb, k text, max_items int, max_len int)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(v order by ord), '{}') from (
    select v, ord from (
      select distinct on (lower(v)) v, ord from (
        select regexp_replace(trim(e.value #>> '{}'), '\s+', ' ', 'g') v, e.ord
        from jsonb_array_elements(case when jsonb_typeof(p -> k) = 'array' then p -> k else '[]' end) with ordinality e(value, ord)
        where jsonb_typeof(e.value) = 'string'
      ) x where v <> '' and char_length(v) <= max_len
      order by lower(v), ord
    ) d order by ord limit max_items
  ) y;
$$;

-- E.164 from raw input. Numbers without an explicit +country code are only accepted for India (the
-- submitted phone_country or the organization's country); anything else is ambiguous and returns null.
create or replace function private.intake_phone(raw text, country text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := regexp_replace(coalesce(raw, ''), '\D', '', 'g');
  intl boolean := coalesce(raw, '') ~ '^\s*(\+|00)';
begin
  if d = '' then return null; end if;
  if intl then
    if coalesce(raw, '') ~ '^\s*00' then d := substring(d from 3); end if;
    if char_length(d) between 8 and 15 and d !~ '^0' then return '+' || d; end if;
    return null;
  end if;
  if country = 'IN' then
    if char_length(d) = 10 and d !~ '^0' then return '+91' || d; end if;
    if char_length(d) = 11 and d ~ '^0[1-9]' then return '+91' || substring(d from 2); end if;
    if char_length(d) = 12 and d ~ '^91[1-9]' then return '+' || d; end if;
  end if;
  return null;
end;
$$;

create or replace function private.name_tokens(n text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array_agg(distinct t), '{}')
  from unnest(regexp_split_to_array(lower(regexp_replace(coalesce(n, ''), '[^[:alpha:][:space:]]', ' ', 'g')), '\s+')) t
  where char_length(t) >= 2;
$$;

-- True unless both names have tokens and share none. Names never prove identity; they only veto.
create or replace function private.names_related(a text, b text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(private.name_tokens(a)) = 0 or cardinality(private.name_tokens(b)) = 0
      or private.name_tokens(a) && private.name_tokens(b);
$$;

-- Validates and normalizes an intake submission. Pure: no reads, no writes.
-- Returns { ok, errors[], warnings[], missing[], ...normalized fields }.
create or replace function private.intake_normalize(p jsonb, org_country text, org_currency text, default_source text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  errors text[] := '{}';
  warnings text[] := '{}';
  missing text[] := '{}';
  allowed text[] := array['name', 'first_name', 'last_name', 'email', 'phone', 'phone_country', 'preferred_contact_method', 'preferred_language',
    'source', 'campaign', 'external_lead_id', 'message', 'intent', 'lead_type', 'locations', 'budget_min', 'budget_max', 'currency',
    'property_type', 'bedrooms', 'amenities', 'timeline', 'consent_channels', 'property_ref'];
  v_name text; v_email text; v_phone text; v_raw_phone text; v_country text;
  v_intent text; v_type text; v_ptype text; v_beds numeric; v_bmin numeric; v_bmax numeric; v_cur text;
  v_timeline text; v_channel text; v_lang text; v_source text; v_campaign text; v_ext text; v_msg text; v_ref text;
  v_consent text[];
begin
  if jsonb_typeof(p) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'errors', jsonb_build_array('payload_not_object'), 'warnings', '[]'::jsonb, 'missing', '[]'::jsonb);
  end if;
  if exists (select 1 from jsonb_object_keys(p) k where k <> all (allowed)) then warnings := warnings || 'unknown_fields_ignored'::text; end if;

  -- Name: never invented. A missing name is recorded as missing information.
  v_name := coalesce(private.j_text(p, 'name'), nullif(concat_ws(' ', private.j_text(p, 'first_name'), private.j_text(p, 'last_name')), ''));
  if char_length(v_name) > 160 then v_name := left(v_name, 160); warnings := warnings || 'name_truncated'::text; end if;
  if v_name is null then missing := missing || 'name'::text; end if;

  -- Email: syntax only. Valid syntax says nothing about deliverability.
  if p ? 'email' and jsonb_typeof(p -> 'email') <> 'null' then
    v_email := lower(private.j_text(p, 'email'));
    if v_email is null or char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      warnings := warnings || 'email_invalid'::text;
      v_email := null;
    end if;
  end if;

  -- Phone: E.164 using the submitted or organization country; ambiguous numbers are dropped, not guessed.
  v_raw_phone := private.j_text(p, 'phone');
  v_country := upper(coalesce(private.j_text(p, 'phone_country'), org_country));
  if v_country !~ '^[A-Z]{2}$' then warnings := warnings || 'phone_country_invalid'::text; v_country := org_country; end if;
  if v_raw_phone is not null then
    v_phone := private.intake_phone(v_raw_phone, v_country);
    if v_phone is null then
      warnings := warnings || case when v_raw_phone !~ '^\s*(\+|00)' and v_country <> 'IN' then 'phone_needs_country_code' else 'phone_invalid' end::text;
    end if;
  end if;
  if v_phone is null and v_email is null then errors := errors || 'contact_method_required'::text; end if;

  v_source := coalesce(left(private.j_text(p, 'source'), 80), default_source);
  v_campaign := left(private.j_text(p, 'campaign'), 120);
  v_ext := private.j_text(p, 'external_lead_id');
  if char_length(v_ext) > 200 then warnings := warnings || 'external_id_invalid'::text; v_ext := null; end if;
  v_msg := case when jsonb_typeof(p -> 'message') = 'string' then nullif(left(trim(p ->> 'message'), 4000), '') end;

  -- Intent → desired_transaction / lead_type.
  v_intent := lower(private.j_text(p, 'intent'));
  if v_intent = 'lease' then v_intent := 'let'; end if;
  if v_intent is not null and v_intent not in ('buy', 'rent', 'sell', 'let', 'invest') then
    if v_intent <> 'other' then warnings := warnings || 'intent_invalid'::text; end if;
    v_intent := null;
  end if;
  v_type := lower(private.j_text(p, 'lead_type'));
  if v_type is not null and v_type not in ('buyer', 'seller', 'tenant', 'landlord', 'investor') then warnings := warnings || 'lead_type_invalid'::text; v_type := null; end if;
  if v_type is null then
    v_type := case v_intent when 'rent' then 'tenant' when 'sell' then 'seller' when 'let' then 'landlord' when 'invest' then 'investor' when 'buy' then 'buyer' end;
  end if;
  if v_intent is null then
    v_intent := case v_type when 'tenant' then 'rent' when 'seller' then 'sell' when 'landlord' then 'let' when 'investor' then 'invest' when 'buyer' then 'buy' end;
  end if;
  if v_intent is null then missing := missing || 'intent'::text; end if;

  v_ptype := lower(private.j_text(p, 'property_type'));
  v_ptype := case v_ptype when 'flat' then 'apartment' when 'bungalow' then 'villa' when 'land' then 'plot' when 'shop' then 'retail' else v_ptype end;
  if v_ptype is not null and v_ptype not in ('apartment', 'penthouse', 'villa', 'house', 'townhouse', 'plot', 'office', 'retail', 'commercial', 'other') then
    warnings := warnings || 'property_type_invalid'::text;
    v_ptype := null;
  end if;
  if v_ptype is null then missing := missing || 'property_type'::text; end if;

  if p ? 'bedrooms' and jsonb_typeof(p -> 'bedrooms') <> 'null' then
    v_beds := private.j_num(p, 'bedrooms');
    if v_beds is null or v_beds <> trunc(v_beds) or v_beds not between 0 and 20 then warnings := warnings || 'bedrooms_invalid'::text; v_beds := null; end if;
  end if;
  if v_beds is null and coalesce(v_ptype, '') not in ('plot', 'office', 'retail', 'commercial') then missing := missing || 'bedrooms'::text; end if;

  -- Budget: numeric, positive, min ≤ max, one currency. Inverted or malformed ranges are dropped, not repaired.
  if p ? 'budget_min' and jsonb_typeof(p -> 'budget_min') <> 'null' then
    v_bmin := private.j_num(p, 'budget_min');
    if v_bmin is null or v_bmin < 0 or v_bmin > 1e11 then warnings := warnings || 'budget_invalid'::text; v_bmin := null; end if;
  end if;
  if p ? 'budget_max' and jsonb_typeof(p -> 'budget_max') <> 'null' then
    v_bmax := private.j_num(p, 'budget_max');
    if v_bmax is null or v_bmax <= 0 or v_bmax > 1e11 then warnings := warnings || 'budget_invalid'::text; v_bmax := null; end if;
  end if;
  if v_bmin is not null and v_bmax is not null and v_bmin > v_bmax then
    warnings := warnings || 'budget_range_inverted'::text;
    v_bmin := null;
    v_bmax := null;
  end if;
  v_cur := upper(private.j_text(p, 'currency'));
  if v_cur is null then
    v_cur := org_currency;
  elsif v_cur !~ '^[A-Z]{3}$' then
    warnings := warnings || 'currency_invalid'::text;
    v_cur := org_currency;
    if v_bmin is not null or v_bmax is not null then warnings := warnings || 'budget_dropped_unknown_currency'::text; v_bmin := null; v_bmax := null; end if;
  elsif v_cur <> org_currency and (v_bmin is not null or v_bmax is not null) then
    warnings := warnings || 'currency_differs_from_org'::text;
  end if;
  if v_bmin is null and v_bmax is null then missing := missing || 'budget'::text; end if;

  v_timeline := private.j_text(p, 'timeline');
  if char_length(v_timeline) > 40 then warnings := warnings || 'timeline_truncated'::text; v_timeline := left(v_timeline, 40); end if;
  if v_timeline is null then missing := missing || 'timeline'::text; end if;

  v_channel := lower(private.j_text(p, 'preferred_contact_method'));
  if v_channel is not null and v_channel not in ('phone', 'email', 'sms', 'whatsapp') then warnings := warnings || 'contact_method_invalid'::text; v_channel := null; end if;
  v_lang := private.j_text(p, 'preferred_language');
  if v_lang is not null and v_lang !~ '^[A-Za-z]{2,3}(-[A-Za-z]{2})?$' then warnings := warnings || 'language_invalid'::text; v_lang := null; end if;
  v_consent := array(select x from unnest(private.j_text_array(p, 'consent_channels', 4, 10)) x where lower(x) in ('phone', 'whatsapp', 'sms', 'email'));
  v_ref := private.j_text(p, 'property_ref');
  if v_ref is not null and v_ref !~ '^[A-Za-z0-9._/-]{1,40}$' then warnings := warnings || 'property_ref_invalid'::text; v_ref := null; end if;
  if cardinality(private.j_text_array(p, 'locations', 10, 120)) = 0 then missing := missing || 'locations'::text; end if;

  return jsonb_build_object(
    'ok', cardinality(errors) = 0, 'errors', to_jsonb(errors), 'warnings', to_jsonb(warnings), 'missing', to_jsonb(missing),
    'name', v_name, 'email', v_email, 'phone', v_phone, 'preferred_channel', v_channel, 'preferred_language', v_lang,
    'source', v_source, 'campaign', v_campaign, 'external_id', v_ext, 'message', v_msg,
    'intent', v_intent, 'lead_type', coalesce(v_type, 'buyer'),
    'locations', to_jsonb(private.j_text_array(p, 'locations', 10, 120)),
    'budget_min', v_bmin, 'budget_max', v_bmax, 'currency', v_cur,
    'property_type', v_ptype, 'bedrooms', v_beds, 'amenities', to_jsonb(private.j_text_array(p, 'amenities', 20, 60)),
    'timeline', v_timeline, 'consent_channels', to_jsonb(array(select lower(x) from unnest(v_consent) x)), 'property_ref', v_ref);
end;
$$;

-- Model output → payload keys. Only the requirement fields; everything else (names, contact data, ids) is discarded.
create or replace function private.intake_extraction_fields(e jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(k, v), '{}') from (
    select case key when 'preferred_locations' then 'locations' else key end k, value v
    from jsonb_each(case when jsonb_typeof(e) = 'object' then e else '{}' end)
    where key in ('intent', 'preferred_locations', 'property_type', 'bedrooms', 'budget_min', 'budget_max', 'currency', 'timeline', 'amenities')
      and jsonb_typeof(value) <> 'null'
  ) x;
$$;

-- Assignment candidates must be active members in a lead-handling role.
create or replace function private.intake_eligible(org uuid, member uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select member is not null and exists (
    select 1 from public.organization_memberships m
    where m.organization_id = org and m.user_id = member and m.status = 'active' and m.role in ('owner', 'admin', 'manager', 'agent'));
$$;

-- Deterministic assignment: property → source rule → contact owner → org policy → fallback → unassigned.
-- Serialized per organization so round-robin and least-loaded stay correct under concurrent intake.
create or replace function private.intake_assign(org uuid, n jsonb, p_contact uuid, out user_id uuid, out rule text, out notes text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg jsonb := private.org_setting(org, array['intake']);
  candidate uuid;
  r jsonb;
begin
  notes := '{}';
  perform pg_advisory_xact_lock(hashtextextended('intake-assign:' || org::text, 0));

  if n ->> 'property_ref' is not null then
    select p.listing_agent_id into candidate from public.properties p
    where p.organization_id = org and upper(p.reference_code) = upper(n ->> 'property_ref');
    if not found then notes := notes || 'property_ref_not_found'::text;
    elsif private.intake_eligible(org, candidate) then user_id := candidate; rule := 'property_listing_agent'; return;
    else notes := notes || 'listing_agent_unavailable'::text;
    end if;
  end if;

  for r in select x from jsonb_array_elements(case when jsonb_typeof(cfg -> 'source_rules') = 'array' then cfg -> 'source_rules' else '[]' end) x loop
    if lower(r ->> 'source') = lower(n ->> 'source') then
      candidate := case when (r ->> 'user_id') ~ '^[0-9a-f-]{36}$' then (r ->> 'user_id')::uuid end;
      if private.intake_eligible(org, candidate) then user_id := candidate; rule := 'source_rule'; return; end if;
      notes := notes || 'source_rule_assignee_unavailable'::text;
    end if;
  end loop;

  if p_contact is not null then
    select c.assigned_to into candidate from public.contacts c where c.id = p_contact and c.organization_id = org;
    if private.intake_eligible(org, candidate) then user_id := candidate; rule := 'contact_owner'; return; end if;
  end if;

  candidate := private.pick_assignee(org, array(select jsonb_array_elements_text(n -> 'locations')));
  if private.intake_eligible(org, candidate) then
    user_id := candidate;
    rule := 'policy_' || coalesce(private.org_setting(org, array['assignment']) #>> '{}', 'least_loaded');
    return;
  end if;
  notes := notes || 'no_active_agent'::text;

  candidate := case when (cfg ->> 'fallback_user_id') ~ '^[0-9a-f-]{36}$' then (cfg ->> 'fallback_user_id')::uuid end;
  if private.intake_eligible(org, candidate) then user_id := candidate; rule := 'fallback'; return; end if;

  rule := 'unassigned_queue';
end;
$$;

create or replace function private.run_step(r public.agent_runs, p_step text, p_status text, p_detail jsonb default '{}')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.agent_run_steps (organization_id, run_id, step, status, detail) values (r.organization_id, r.id, p_step, p_status, coalesce(p_detail, '{}'));
$$;

create or replace function private.emit_event(org uuid, p_type text, p_record_type text, p_record uuid, p_corr uuid, p_payload jsonb, p_consumer text, p_dedupe text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.outbox_events (organization_id, event_type, record_type, record_id, correlation_id, payload, consumer, status, dedupe_key)
  values (org, p_type, p_record_type, p_record, p_corr, coalesce(p_payload, '{}'), p_consumer, case when p_consumer is null then 'published' else 'pending' end, p_dedupe)
  on conflict (organization_id, dedupe_key) do nothing;
$$;

-- Timeline entry attributed to the agent rather than "System".
create or replace function private.agent_activity(org uuid, p_lead uuid, p_contact uuid, kind text, title text, body text, src text, meta jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.activities (organization_id, lead_id, contact_id, activity_type, title, description, source, actor_name, metadata)
  values (org, p_lead, p_contact, kind, left(title, 300), left(body, 4000), src, 'Lead Intake Agent', coalesce(meta, '{}'));
$$;

-- The Agent 2 handoff. Once per lead; the consumer must re-read the lead through the backend.
create or replace function private.emit_ready_for_qualification(org uuid, p_lead uuid, p_corr uuid, p_missing jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.emit_event(org, 'lead.ready_for_qualification', 'lead', p_lead, p_corr,
    jsonb_build_object('event_type', 'lead.ready_for_qualification', 'schema_version', 1, 'organization_id', org, 'lead_id', p_lead,
      'source', 'lead_intake_agent', 'correlation_id', p_corr, 'missing_information', coalesce(p_missing, '[]'::jsonb)),
    'sales_qualification_agent', 'ready_for_qualification:' || p_lead::text);
$$;

-- ───────────────────────── intake pipeline ─────────────────────────

-- Records an incoming submission as a run (idempotent per provider event). Service role only.
create or replace function public.intake_receive(p_org uuid, p_source_kind text, p_provider text, p_event_id text, p_payload jsonb,
  p_trigger text default 'lead.received_from_integration')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.agent_runs;
  o public.organizations;
  missing_req int;
begin
  select * into o from public.organizations where id = p_org and deleted_at is null;
  if o.id is null then perform private.fail('NOT_FOUND', 'Unknown organization'); end if;
  if p_source_kind not in ('webhook', 'voice', 'integration', 'import')
     or coalesce(p_provider, '') !~ '^[a-z0-9][a-z0-9_.-]{0,59}$'
     or coalesce(p_event_id, '') !~ '^[A-Za-z0-9._:-]{1,200}$'
     or coalesce(p_trigger, '') !~ '^[a-z_]+\.[a-z_]+$'
     or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text) > 65536 then
    perform private.fail('VALIDATION_ERROR', 'Invalid intake submission');
  end if;

  insert into public.agent_runs (organization_id, agent_id, agent_version, trigger_event, source_kind, provider, external_event_id, idempotency_key, input)
  values (p_org, 'lead_intake_agent', '1.0.0', p_trigger, p_source_kind, p_provider, p_event_id, p_provider || ':' || p_event_id, p_payload)
  on conflict (organization_id, agent_id, idempotency_key) do nothing
  returning * into r;

  if r.id is null then
    select * into r from public.agent_runs where organization_id = p_org and agent_id = 'lead_intake_agent' and idempotency_key = p_provider || ':' || p_event_id;
    update public.webhook_events set attempt_count = attempt_count + 1
    where organization_id = p_org and provider = p_provider and provider_event_id = p_event_id;
    return jsonb_build_object('status', 'duplicate_event', 'run_id', r.id, 'run_status', r.status, 'lead_id', r.lead_id, 'needs_extraction', false);
  end if;

  if p_source_kind = 'webhook' then
    insert into public.webhook_events (organization_id, provider, provider_event_id, event_type, signature_verified)
    values (p_org, p_provider, p_event_id, 'lead.created', true)
    on conflict (organization_id, provider, provider_event_id) do update set attempt_count = public.webhook_events.attempt_count + 1;
  end if;
  perform private.run_step(r, 'receive', 'ok', jsonb_build_object('source_kind', p_source_kind, 'provider', p_provider));

  -- Model extraction is only worth it for free text when requirement fields are missing.
  select count(*) into missing_req from unnest(array['intent', 'locations', 'budget_max', 'property_type', 'bedrooms', 'timeline']) k
  where not (p_payload ? k) or jsonb_typeof(p_payload -> k) = 'null';
  return jsonb_build_object('status', 'received', 'run_id', r.id, 'correlation_id', r.correlation_id,
    'needs_extraction', coalesce((o.settings -> 'intake' ->> 'extraction_enabled')::boolean, true)
      and char_length(coalesce(p_payload ->> 'message', '')) >= 15 and missing_req > 0,
    'currency', o.default_currency, 'country', o.country_code);
end;
$$;

-- Stores a validated model proposal (or only its failure metadata) on a run that has not been processed yet.
create or replace function public.intake_attach_extraction(p_run uuid, p_extraction jsonb, p_meta jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.agent_runs;
  meta jsonb;
begin
  select * into r from public.agent_runs where id = p_run for update;
  if r.id is null then perform private.fail('NOT_FOUND', 'Run not found'); end if;
  if r.status <> 'received' or r.extraction is not null then return; end if;
  meta := (select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each(case when jsonb_typeof(p_meta) = 'object' then p_meta else '{}' end)
           where key in ('model', 'prompt_version', 'latency_ms', 'input_tokens', 'output_tokens', 'outcome', 'attempts') and jsonb_typeof(value) in ('string', 'number'));
  if p_extraction is not null and (jsonb_typeof(p_extraction) <> 'object' or octet_length(p_extraction::text) > 8192) then
    meta := meta || '{"outcome": "invalid_output"}';
    p_extraction := null;
  end if;
  update public.agent_runs set extraction = p_extraction, model_meta = meta where id = r.id;
  perform private.run_step(r, 'extract', case when p_extraction is null then 'skipped' else 'ok' end,
    jsonb_build_object('outcome', meta ->> 'outcome', 'model', meta ->> 'model', 'fields', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(private.intake_extraction_fields(p_extraction)) k)));
end;
$$;

-- One attempt of the pipeline. Runs inside intake_process's sub-transaction: any error rolls all of it back.
create or replace function private.intake_execute(r public.agent_runs)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  combined jsonb := r.input;
  ext jsonb := private.intake_extraction_fields(r.extraction);
  ai_keys text[] := '{}';
  ai_fields text[] := '{}';
  n jsonb;
  k text;
  lock_keys text[];
  existing public.leads;
  cand uuid[];
  c public.contacts;
  matched_phone boolean;
  matched_email boolean;
  dup text;
  dup_reasons text[] := '{}';
  v_contact uuid;
  v_lead uuid;
  v_name text;
  a record;
  ch text;
  review_id uuid;
  result_status text;
  sla int;
  outcome jsonb;
  m record;
begin
  select * into o from public.organizations where id = r.organization_id and deleted_at is null;
  if o.id is null then perform private.fail('NOT_FOUND', 'Organization no longer exists'); end if;

  -- 1. Model proposal (untrusted) fills only fields the submission left empty. A structured budget keeps its currency.
  for k in select jsonb_object_keys(ext) loop
    if (combined ? k and jsonb_typeof(combined -> k) <> 'null')
       or (k in ('budget_min', 'budget_max', 'currency') and (combined ? 'budget_min' or combined ? 'budget_max')) then
      continue;
    end if;
    combined := combined || jsonb_build_object(k, ext -> k);
    ai_keys := ai_keys || k;
  end loop;

  -- 2. Validate and normalize.
  n := private.intake_normalize(combined, o.country_code, o.default_currency, case r.source_kind when 'webhook' then 'Website' when 'voice' then 'Inbound call' else 'Integration' end);
  if not (n ->> 'ok')::boolean then
    perform private.run_step(r, 'validate', 'failed', jsonb_build_object('errors', n -> 'errors', 'warnings', n -> 'warnings'));
    return jsonb_build_object('status', 'invalid', 'errors', n -> 'errors', 'warnings', n -> 'warnings');
  end if;
  -- Contradictions the model noticed are surfaced for people, never acted on.
  if jsonb_typeof(r.extraction -> 'contradictions') = 'array' and jsonb_array_length(r.extraction -> 'contradictions') > 0 then
    n := jsonb_set(n, '{warnings}', (n -> 'warnings') || '["ai_flagged_contradiction"]'::jsonb);
  end if;
  perform private.run_step(r, 'validate', case when jsonb_array_length(n -> 'warnings') > 0 then 'warning' else 'ok' end,
    jsonb_build_object('warnings', n -> 'warnings', 'missing', n -> 'missing'));
  -- AI provenance only for proposals that survived validation.
  ai_fields := array(select distinct case x when 'budget_min' then 'budget' when 'budget_max' then 'budget' when 'property_type' then 'propertyType' else x end
                     from unnest(ai_keys) x
                     where x <> 'currency' and jsonb_typeof(n -> x) not in ('null') and not (jsonb_typeof(n -> x) = 'array' and jsonb_array_length(n -> x) = 0));

  -- 3. Serialize concurrent submissions for the same identity (sorted → no deadlocks).
  lock_keys := array(select x from unnest(array[n ->> 'phone', n ->> 'email', 'ext:' || coalesce(n ->> 'external_id', r.external_event_id)]) x where x is not null order by x);
  foreach k in array lock_keys loop
    perform pg_advisory_xact_lock(hashtextextended('intake:' || o.id::text || ':' || k, 0));
  end loop;

  -- 4a. Layer 1: the same enquiry by stable external id (or event id) from the same source.
  select * into existing from public.leads
  where organization_id = o.id and source = n ->> 'source' and source_external_id = coalesce(n ->> 'external_id', r.external_event_id);
  if existing.id is not null then
    dup := 'same_external_id';
    v_contact := existing.contact_id;
  else
    -- 4b. Layer 2: normalized phone / email within this organization only.
    select array_agg(distinct x.id) into cand from public.contacts x
    where x.organization_id = o.id
      and ((n ->> 'phone' is not null and x.phone_e164 = n ->> 'phone') or (n ->> 'email' is not null and x.email_normalized = n ->> 'email'));
    if cand is null then
      dup := 'none';
    elsif cardinality(cand) > 1 then
      dup := 'ambiguous';
      dup_reasons := array['phone_and_email_match_different_contacts'];
    else
      select * into c from public.contacts where id = cand[1];
      matched_phone := n ->> 'phone' is not null and c.phone_e164 = n ->> 'phone';
      matched_email := n ->> 'email' is not null and c.email_normalized = n ->> 'email';
      if (n ->> 'email' is not null and c.email_normalized is not null and c.email_normalized <> n ->> 'email')
         or (n ->> 'phone' is not null and c.phone_e164 is not null and c.phone_e164 <> n ->> 'phone') then
        dup := 'ambiguous';
        dup_reasons := array[case when matched_phone then 'same_phone_different_email' else 'same_email_different_phone' end];
      elsif matched_phone and not matched_email and not private.names_related(c.display_name, n ->> 'name') then
        dup := 'ambiguous';
        dup_reasons := array['same_phone_different_name'];
      else
        dup := 'match';
        dup_reasons := array_remove(array[case when matched_phone then 'same_phone' end, case when matched_email then 'same_email' end], null);
        v_contact := c.id;
        -- 4c. An open enquiry for this contact absorbs the repeat instead of creating a parallel lead.
        select * into existing from public.leads
        where organization_id = o.id and contact_id = c.id and archived_at is null and status not in ('won', 'lost')
        order by created_at desc limit 1;
      end if;
    end if;
  end if;
  perform private.run_step(r, 'deduplicate', case when dup = 'ambiguous' then 'warning' else 'ok' end,
    jsonb_build_object('outcome', dup, 'reasons', to_jsonb(dup_reasons), 'candidates', coalesce(cardinality(cand), 0)));

  sla := coalesce((o.settings ->> 'sla_minutes')::int, 5);

  if existing.id is not null then
    -- Repeat enquiry: enrich only empty fields; never overwrite or null existing values.
    update public.leads l set
      budget_min = coalesce(l.budget_min, case when l.budget_max is null and l.budget_currency = n ->> 'currency' then (n ->> 'budget_min')::numeric end),
      budget_max = coalesce(l.budget_max, case when l.budget_min is null and l.budget_currency = n ->> 'currency' then (n ->> 'budget_max')::numeric end),
      desired_property_type = coalesce(l.desired_property_type, n ->> 'property_type'),
      desired_locations = case when cardinality(l.desired_locations) = 0 then array(select jsonb_array_elements_text(n -> 'locations')) else l.desired_locations end,
      bedrooms = coalesce(l.bedrooms, (n ->> 'bedrooms')::smallint),
      timeline = coalesce(l.timeline, n ->> 'timeline'),
      required_amenities = case when cardinality(l.required_amenities) = 0 then array(select jsonb_array_elements_text(n -> 'amenities')) else l.required_amenities end,
      summary = coalesce(l.summary, n ->> 'message'),
      ai_extracted_fields = array(select distinct x from unnest(l.ai_extracted_fields || ai_fields) x),
      metadata = l.metadata || jsonb_build_object('last_enquiry_at', now(), 'enquiry_count', coalesce((l.metadata ->> 'enquiry_count')::int, 1) + 1)
    where l.id = existing.id;
    v_lead := existing.id;
    v_contact := existing.contact_id;
    update public.contacts set email = coalesce(email, n ->> 'email'), phone = coalesce(phone, n ->> 'phone') where id = v_contact;
    perform private.agent_activity(o.id, v_lead, v_contact, 'updated', 'Repeat enquiry via ' || (n ->> 'source'),
      left(n ->> 'message', 1000), 'workflow', jsonb_build_object('run_id', r.id, 'agent', 'lead_intake_agent', 'duplicate', dup));
    result_status := 'repeat_enquiry';
    select null::uuid as user_id, 'kept_existing'::text as rule, '{}'::text[] as notes into a;
    perform private.run_step(r, 'persist', 'ok', jsonb_build_object('action', 'repeat_enquiry', 'lead_id', v_lead));
  else
    if v_contact is null then
      insert into public.contacts (organization_id, display_name, email, phone, roles, source, preferred_contact_channel, custom_fields)
      values (o.id, coalesce(n ->> 'name', 'Unnamed enquiry'), n ->> 'email', n ->> 'phone', array[n ->> 'lead_type'], n ->> 'source',
              coalesce(n ->> 'preferred_channel', case when n ->> 'phone' is null then 'email' else 'whatsapp' end),
              case when n ->> 'preferred_language' is null then '{}'::jsonb else jsonb_build_object('preferred_language', n ->> 'preferred_language') end)
      returning id into v_contact;
      foreach ch in array array['phone', 'whatsapp', 'sms', 'email'] loop
        insert into public.communication_consents (organization_id, contact_id, channel, status, captured_via)
        values (o.id, v_contact, ch, case when (n -> 'consent_channels') ? ch then 'granted' else 'unknown' end,
                case when (n -> 'consent_channels') ? ch then left('Lead intake: ' || (n ->> 'source'), 80) end);
      end loop;
    else
      update public.contacts set email = coalesce(email, n ->> 'email'), phone = coalesce(phone, n ->> 'phone') where id = v_contact;
    end if;
    select display_name into v_name from public.contacts where id = v_contact;

    select * into a from private.intake_assign(o.id, n, case when dup = 'match' then v_contact end);
    perform private.run_step(r, 'assign', case when a.user_id is null then 'warning' else 'ok' end,
      jsonb_build_object('rule', a.rule, 'notes', to_jsonb(a.notes), 'assignee', a.user_id));

    insert into public.leads (organization_id, contact_id, title, lead_type, desired_transaction, source, source_campaign, source_external_id,
      assigned_to, budget_min, budget_max, budget_currency, desired_property_type, desired_locations, bedrooms, timeline, required_amenities,
      ai_extracted_fields, summary, next_follow_up_at, metadata, intake_status, duplicate_status)
    values (o.id, v_contact, v_name, n ->> 'lead_type', coalesce(n ->> 'intent', 'buy'), n ->> 'source', n ->> 'campaign',
      coalesce(n ->> 'external_id', r.external_event_id), a.user_id, (n ->> 'budget_min')::numeric, (n ->> 'budget_max')::numeric, n ->> 'currency',
      n ->> 'property_type', array(select jsonb_array_elements_text(n -> 'locations')), (n ->> 'bedrooms')::smallint, n ->> 'timeline',
      array(select jsonb_array_elements_text(n -> 'amenities')), ai_fields, n ->> 'message', now() + make_interval(mins => sla),
      jsonb_build_object('intake', jsonb_build_object('run_id', r.id, 'source_kind', r.source_kind, 'missing', n -> 'missing',
        'ai_contradictions', (select coalesce(jsonb_agg(left(x, 200)), '[]') from jsonb_array_elements_text(
          case when jsonb_typeof(r.extraction -> 'contradictions') = 'array' then r.extraction -> 'contradictions' else '[]' end) with ordinality t(x, i) where i <= 3))),
      case when dup = 'ambiguous' then 'review_required' else 'completed' end,
      case dup when 'ambiguous' then 'possible_duplicate' when 'match' then 'linked_contact' else 'unique' end)
    returning id into v_lead;
    if a.user_id is not null then
      update public.lead_assignments set reason = 'Lead Intake Agent: ' || a.rule
      where lead_id = v_lead and from_user_id is null and to_user_id = a.user_id;
    end if;
    perform private.run_step(r, 'persist', 'ok', jsonb_build_object('action', case when dup = 'match' then 'new_lead_existing_contact' else 'new_lead_new_contact' end, 'lead_id', v_lead));

    if dup = 'ambiguous' then
      insert into public.review_items (organization_id, review_type, lead_id, contact_id, candidate_contact_ids, reasons, run_id)
      values (o.id, 'possible_duplicate', v_lead, v_contact, cand, dup_reasons, r.id)
      returning id into review_id;
      for m in select mm.user_id from public.organization_memberships mm
               where mm.organization_id = o.id and mm.status = 'active'
                 and mm.role in (select rp.role from public.role_permissions rp where rp.permission = 'leads.merge') loop
        perform private.notify(o.id, m.user_id, 'lead', 'Possible duplicate: ' || v_name, 'Review before qualification starts', 'leads', 'lead', v_lead, 'intake_review:' || review_id::text);
      end loop;
      perform private.emit_event(o.id, 'lead.review_required', 'lead', v_lead, r.correlation_id,
        jsonb_build_object('review_id', review_id, 'reasons', to_jsonb(dup_reasons)), null, 'review_required:' || review_id::text);
      result_status := 'review_required';
    else
      result_status := 'created';
    end if;
    if a.user_id is null then
      for m in select mm.user_id from public.organization_memberships mm
               where mm.organization_id = o.id and mm.status = 'active'
                 and mm.role in (select rp.role from public.role_permissions rp where rp.permission = 'leads.assign') loop
        perform private.notify(o.id, m.user_id, 'lead', 'Unassigned lead: ' || v_name, 'No eligible agent matched the intake rules', 'leads', 'lead', v_lead, 'intake_unassigned:' || v_lead::text);
      end loop;
    end if;
    perform private.agent_activity(o.id, v_lead, v_contact, 'workflow',
      case when dup = 'ambiguous' then 'Possible duplicate — waiting for review' else 'Intake completed' end,
      concat_ws(' · ',
        case dup when 'match' then 'Linked to existing contact' when 'none' then 'New contact' when 'ambiguous' then 'Kept separate until reviewed' end,
        case when a.user_id is null then 'Unassigned: no eligible agent' else 'Assigned by ' || replace(a.rule, '_', ' ') end,
        case when cardinality(ai_fields) > 0 then 'AI-extracted: ' || array_to_string(ai_fields, ', ') end),
      'workflow', jsonb_build_object('run_id', r.id, 'agent', 'lead_intake_agent'));
  end if;

  outcome := jsonb_build_object(
    'duplicate', jsonb_build_object('outcome', dup, 'reasons', to_jsonb(dup_reasons), 'candidates', coalesce(cardinality(cand), 0)),
    'assignment', jsonb_build_object('rule', a.rule, 'notes', to_jsonb(coalesce(a.notes, '{}')), 'assignee', a.user_id),
    'warnings', n -> 'warnings', 'missing', n -> 'missing', 'ai_fields', to_jsonb(ai_fields),
    'action', result_status);

  perform private.emit_event(o.id, 'lead.intake_completed', 'lead', v_lead, r.correlation_id,
    jsonb_build_object('run_id', r.id, 'result', result_status, 'duplicate', dup, 'assignment', a.rule), null, 'intake_completed:' || r.id::text);
  if result_status <> 'review_required' then
    perform private.emit_ready_for_qualification(o.id, v_lead, r.correlation_id, n -> 'missing');
  end if;
  perform private.run_step(r, 'handoff', case when result_status = 'review_required' then 'skipped' else 'ok' end,
    jsonb_build_object('event', 'lead.ready_for_qualification', 'reason', case when result_status = 'review_required' then 'awaiting_review' end));

  return jsonb_build_object('status', result_status, 'lead_id', v_lead, 'contact_id', v_contact, 'outcome', outcome);
end;
$$;

-- Processes a run once. Idempotent: finished runs return their recorded result. Service role only.
create or replace function public.intake_process(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.agent_runs;
  res jsonb;
  v_state text;
  v_msg text;
  final text;
  t0 timestamptz := clock_timestamp();
begin
  select * into r from public.agent_runs where id = p_run for update;
  if r.id is null then perform private.fail('NOT_FOUND', 'Run not found'); end if;
  if r.status not in ('received', 'retry_scheduled') then
    return jsonb_build_object('status', case r.status when 'succeeded' then coalesce(r.outcome ->> 'action', 'created') else r.status end,
      'run_id', r.id, 'lead_id', r.lead_id, 'replayed', true);
  end if;
  update public.agent_runs set attempt_count = attempt_count + 1, started_at = coalesce(started_at, now()) where id = r.id returning * into r;

  begin
    res := private.intake_execute(r);
  exception when others then
    -- Every write of this attempt has been rolled back; record the failure outside it.
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    final := case when r.attempt_count >= r.max_attempts then 'dead_letter' else 'retry_scheduled' end;
    update public.agent_runs set status = final,
      next_attempt_at = case when final = 'retry_scheduled' then now() + make_interval(mins => power(2, r.attempt_count - 1)::int) end,
      error_category = case when v_state ~ '^(22|23|40|53|57)' then 'database' else 'unknown' end,
      error_message = left(v_state || ' ' || v_msg, 300),
      completed_at = case when final = 'dead_letter' then now() end,
      duration_ms = (extract(epoch from clock_timestamp() - t0) * 1000)::int
    where id = r.id;
    perform private.run_step(r, 'attempt', 'failed', jsonb_build_object('attempt', r.attempt_count, 'sqlstate', v_state, 'next', final));
    if final = 'dead_letter' then
      perform private.emit_event(r.organization_id, 'lead.intake_failed', 'agent_run', r.id, r.correlation_id,
        jsonb_build_object('run_id', r.id, 'reason', 'retries_exhausted'), null, 'intake_failed:' || r.id::text);
      update public.webhook_events set processing_status = 'dead_letter', last_error = 'Processing failed after retries', processed_at = now()
      where organization_id = r.organization_id and provider = r.provider and provider_event_id = r.external_event_id;
    end if;
    return jsonb_build_object('status', final, 'run_id', r.id);
  end;

  if res ->> 'status' = 'invalid' then
    update public.agent_runs set status = 'invalid', error_category = 'validation', outcome = jsonb_build_object('errors', res -> 'errors', 'warnings', res -> 'warnings'),
      completed_at = now(), duration_ms = (extract(epoch from clock_timestamp() - t0) * 1000)::int
    where id = r.id;
    perform private.emit_event(r.organization_id, 'lead.intake_failed', 'agent_run', r.id, r.correlation_id,
      jsonb_build_object('run_id', r.id, 'reason', 'validation', 'errors', res -> 'errors'), null, 'intake_failed:' || r.id::text);
    update public.webhook_events set processing_status = 'failed', last_error = 'Payload validation failed: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(res -> 'errors') x), processed_at = now()
    where organization_id = r.organization_id and provider = r.provider and provider_event_id = r.external_event_id;
    return jsonb_build_object('status', 'invalid', 'run_id', r.id, 'errors', res -> 'errors');
  end if;

  -- Success: keep ids and outcome, drop the customer's contact details from the run.
  update public.agent_runs set
    status = case when res ->> 'status' = 'review_required' then 'review_required' else 'succeeded' end,
    lead_id = (res ->> 'lead_id')::uuid, contact_id = (res ->> 'contact_id')::uuid, outcome = res -> 'outcome',
    input = jsonb_build_object('redacted', true, 'fields', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(r.input) k)),
    error_category = null, error_message = null, next_attempt_at = null,
    completed_at = now(), duration_ms = (extract(epoch from clock_timestamp() - t0) * 1000)::int
  where id = r.id;
  update public.webhook_events set processing_status = 'processed', lead_id = (res ->> 'lead_id')::uuid, last_error = null, processed_at = now()
  where organization_id = r.organization_id and provider = r.provider and provider_event_id = r.external_event_id;
  return jsonb_build_object('status', res ->> 'status', 'run_id', r.id, 'lead_id', res ->> 'lead_id', 'contact_id', res ->> 'contact_id',
    'duplicate', res -> 'outcome' -> 'duplicate' ->> 'outcome', 'assignment', res -> 'outcome' -> 'assignment' ->> 'rule',
    'warnings', res -> 'outcome' -> 'warnings', 'missing', res -> 'outcome' -> 'missing');
end;
$$;

-- Worker: abandoned submissions (no process call within 2 minutes) and due retries. Run by pg_cron.
create or replace function public.intake_process_due(p_limit int default 25)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  id uuid;
  n int := 0;
begin
  for id in
    select ar.id from public.agent_runs ar
    where ar.agent_id = 'lead_intake_agent'
      and ((ar.status = 'received' and ar.received_at < now() - interval '2 minutes') or (ar.status = 'retry_scheduled' and ar.next_attempt_at <= now()))
    order by ar.received_at
    limit least(greatest(p_limit, 1), 200)
    for update skip locked
  loop
    perform public.intake_process(id);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Webhook path kept for existing callers; now a thin wrapper over the agent pipeline.
create or replace function public.ingest_lead(p_org uuid, p_provider text, p_event_id text, p_payload jsonb, p_signature_ok boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec jsonb;
  res jsonb;
begin
  if not exists (select 1 from public.organizations where id = p_org and deleted_at is null) then
    perform private.fail('NOT_FOUND', 'Unknown organization');
  end if;
  if not p_signature_ok then
    perform public.record_rejected_webhook(p_org, p_provider);
    return jsonb_build_object('status', 'rejected');
  end if;
  rec := public.intake_receive(p_org, 'webhook', p_provider, p_event_id, p_payload);
  if rec ->> 'status' = 'duplicate_event' then
    return jsonb_build_object('status', 'duplicate_event', 'lead_id', rec -> 'lead_id');
  end if;
  res := public.intake_process((rec ->> 'run_id')::uuid);
  return jsonb_build_object('status', res ->> 'status', 'lead_id', res -> 'lead_id');
end;
$$;

-- ───────────────────────── manual / import path ─────────────────────────

-- Leads created by people (create_lead, CSV import) get an intake run and the same handoff.
create or replace function private.record_manual_intake(p_lead uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.leads;
  r public.agent_runs;
  missing jsonb;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null or not public.has_perm(l.organization_id, 'leads.edit') then perform private.fail('FORBIDDEN', 'You cannot create leads'); end if;
  missing := to_jsonb(array_remove(array[
    case when l.budget_max is null and l.budget_min is null then 'budget' end,
    case when cardinality(l.desired_locations) = 0 then 'locations' end,
    case when l.desired_property_type is null then 'property_type' end,
    case when l.bedrooms is null and coalesce(l.desired_property_type, '') not in ('plot', 'office', 'retail', 'commercial') then 'bedrooms' end,
    case when l.timeline is null then 'timeline' end], null));
  insert into public.agent_runs (organization_id, agent_id, agent_version, trigger_event, source_kind, provider, idempotency_key, status,
    attempt_count, lead_id, contact_id, outcome, started_at, completed_at, duration_ms)
  values (l.organization_id, 'lead_intake_agent', '1.0.0', 'lead.created', 'manual', 'os', 'lead:' || l.id::text, 'succeeded', 1, l.id, l.contact_id,
    jsonb_build_object('duplicate', jsonb_build_object('outcome', 'checked_by_user'), 'assignment', jsonb_build_object('rule', case when l.assigned_to is null then 'unassigned_queue' else 'set_at_creation' end),
      'missing', missing, 'action', 'created'),
    now(), now(), 0)
  on conflict (organization_id, agent_id, idempotency_key) do nothing
  returning * into r;
  if r.id is null then return; end if;
  update public.leads set metadata = metadata || jsonb_build_object('intake', jsonb_build_object('run_id', r.id, 'source_kind', 'manual', 'missing', missing)) where id = l.id;
  perform private.run_step(r, 'persist', 'ok', jsonb_build_object('action', 'created_by_user', 'lead_id', l.id));
  perform private.emit_event(l.organization_id, 'lead.intake_completed', 'lead', l.id, r.correlation_id,
    jsonb_build_object('run_id', r.id, 'result', 'created', 'duplicate', 'checked_by_user'), null, 'intake_completed:' || r.id::text);
  perform private.emit_ready_for_qualification(l.organization_id, l.id, r.correlation_id, missing);
  perform private.run_step(r, 'handoff', 'ok', jsonb_build_object('event', 'lead.ready_for_qualification'));
end;
$$;

create or replace function private.leads_manual_intake()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then perform private.record_manual_intake(new.id); end if;
  return null;
end;
$$;
create trigger leads_manual_intake after insert on public.leads for each row execute function private.leads_manual_intake();

-- ───────────────────────── review resolution ─────────────────────────

-- 'distinct': a different person → normal intake continues. 'duplicate': merge the new enquiry into an
-- existing lead of one of the candidate contacts (history moved, new lead archived). Needs leads.merge.
create or replace function public.resolve_intake_review(p_review uuid, p_decision text, p_keep_lead uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rv public.review_items;
  l public.leads;
  k public.leads;
  corr uuid;
begin
  select * into rv from public.review_items where id = p_review for update;
  if rv.id is null or not public.has_perm(rv.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Review not found'); end if;
  if not public.has_perm(rv.organization_id, 'leads.merge') then perform private.fail('FORBIDDEN', 'You cannot resolve duplicate reviews'); end if;
  if rv.status <> 'open' then perform private.fail('CONFLICT', 'This review has already been resolved'); end if;
  if p_decision not in ('distinct', 'duplicate') then perform private.fail('VALIDATION_ERROR', 'Invalid decision'); end if;
  select * into l from public.leads where id = rv.lead_id for update;
  select correlation_id into corr from public.agent_runs where id = rv.run_id;

  if p_decision = 'distinct' then
    update public.leads set intake_status = 'completed', duplicate_status = 'resolved_distinct' where id = l.id;
    update public.review_items set status = 'resolved', resolution = 'distinct', resolved_by = auth.uid(), resolved_at = now() where id = rv.id;
    perform private.add_activity(l.organization_id, l.id, l.contact_id, null, 'workflow', 'Duplicate review: different person', null);
    perform private.emit_ready_for_qualification(l.organization_id, l.id, coalesce(corr, gen_random_uuid()), l.metadata -> 'intake' -> 'missing');
    perform private.write_audit(l.organization_id, 'review_items.resolved', 'review_items', rv.id, jsonb_build_object('resolution', 'distinct'));
    return jsonb_build_object('status', 'resolved', 'lead_id', l.id);
  end if;

  select * into k from public.leads
  where id = p_keep_lead and organization_id = rv.organization_id and contact_id = any (rv.candidate_contact_ids) and archived_at is null;
  if k.id is null then perform private.fail('INVALID_REFERENCE', 'Choose an open lead of one of the matching contacts'); end if;

  update public.activities set lead_id = k.id, contact_id = k.contact_id where lead_id = l.id;
  update public.appointments set lead_id = k.id where lead_id = l.id;
  update public.tasks set related_lead_id = k.id where related_lead_id = l.id;
  update public.deals set lead_id = k.id where lead_id = l.id;
  update public.leads set
    budget_min = coalesce(k.budget_min, case when k.budget_max is null and k.budget_currency = l.budget_currency then l.budget_min end),
    budget_max = coalesce(k.budget_max, case when k.budget_min is null and k.budget_currency = l.budget_currency then l.budget_max end),
    desired_locations = (select coalesce(array_agg(distinct x), '{}') from unnest(k.desired_locations || l.desired_locations) x),
    timeline = coalesce(k.timeline, l.timeline),
    bedrooms = coalesce(k.bedrooms, l.bedrooms),
    desired_property_type = coalesce(k.desired_property_type, l.desired_property_type),
    summary = coalesce(k.summary, l.summary)
  where id = k.id;
  update public.leads set archived_at = now(), intake_status = 'completed', duplicate_status = 'merged',
    metadata = metadata || jsonb_build_object('merged_into', k.id) where id = l.id;
  if not exists (select 1 from public.leads where contact_id = l.contact_id and id <> l.id) then
    update public.contacts set lifecycle_status = 'inactive', tags = array(select distinct x from unnest(tags || array['duplicate']) x) where id = l.contact_id;
  end if;
  update public.review_items set status = 'resolved', resolution = 'duplicate', resolved_lead_id = k.id, resolved_by = auth.uid(), resolved_at = now() where id = rv.id;
  perform private.add_activity(k.organization_id, k.id, k.contact_id, null, 'workflow', 'Duplicate enquiry merged after review',
    format('%s enquiry from %s merged; history preserved.', l.source, to_char(l.created_at, 'DD Mon YYYY')));
  perform private.write_audit(k.organization_id, 'review_items.resolved', 'review_items', rv.id, jsonb_build_object('resolution', 'duplicate', 'kept', k.id, 'merged', l.id));
  return jsonb_build_object('status', 'resolved', 'lead_id', k.id);
end;
$$;

-- Read model for the lead screen: intake state, handoff and open review, for anyone who can see the lead.
create or replace function public.lead_intake_summary(p_lead uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l public.leads;
  r public.agent_runs;
  ev public.outbox_events;
  rv public.review_items;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null or not public.has_perm(l.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
  select * into r from public.agent_runs where organization_id = l.organization_id and agent_id = 'lead_intake_agent' and lead_id = l.id order by received_at desc limit 1;
  select * into ev from public.outbox_events where organization_id = l.organization_id and dedupe_key = 'ready_for_qualification:' || l.id::text;
  select * into rv from public.review_items where lead_id = l.id order by created_at desc limit 1;
  return jsonb_build_object(
    'intake_status', l.intake_status, 'duplicate_status', l.duplicate_status,
    'run', case when r.id is null then null else jsonb_build_object('id', r.id, 'status', r.status, 'source_kind', r.source_kind, 'provider', r.provider,
      'received_at', r.received_at, 'completed_at', r.completed_at, 'attempts', r.attempt_count, 'warnings', r.outcome -> 'warnings',
      'missing', r.outcome -> 'missing', 'assignment', r.outcome -> 'assignment' ->> 'rule', 'duplicate', r.outcome -> 'duplicate' ->> 'outcome',
      'ai_fields', r.outcome -> 'ai_fields', 'model', r.model_meta ->> 'model', 'model_outcome', r.model_meta ->> 'outcome') end,
    'handoff', case when ev.id is null then null else jsonb_build_object('status', ev.status, 'created_at', ev.created_at, 'delivered_at', ev.delivered_at, 'attempts', ev.attempts) end,
    'review', case when rv.id is null then null else jsonb_build_object('id', rv.id, 'status', rv.status, 'reasons', to_jsonb(rv.reasons), 'resolution', rv.resolution,
      'resolved_at', rv.resolved_at,
      'candidates', (select coalesce(jsonb_agg(jsonb_build_object('contact_id', c.id, 'name', c.display_name,
          'leads', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'status', x.status, 'source', x.source, 'created_at', x.created_at) order by x.created_at desc), '[]')
                    from (select * from public.leads x where x.contact_id = c.id and x.organization_id = l.organization_id and x.archived_at is null and x.id <> l.id order by x.created_at desc limit 5) x))), '[]')
        from public.contacts c where c.id = any (rv.candidate_contact_ids) and c.organization_id = l.organization_id)) end);
end;
$$;

-- ───────────────────────── outbox delivery (consumers) ─────────────────────────

create or replace function public.outbox_claim(p_consumer text, p_types text[], p_limit int default 10)
returns setof public.outbox_events
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.outbox_events set status = 'dead_letter', last_error = 'Lease expired after the final attempt'
  where consumer = p_consumer and status = 'processing' and locked_until < now() and attempts >= max_attempts;
  return query
  update public.outbox_events o set status = 'processing', attempts = o.attempts + 1, locked_until = now() + interval '5 minutes'
  where o.id in (
    select e.id from public.outbox_events e
    where e.consumer = p_consumer and e.event_type = any (p_types)
      and ((e.status = 'pending' and e.available_at <= now()) or (e.status = 'processing' and e.locked_until < now()))
    order by e.created_at
    limit least(greatest(p_limit, 1), 100)
    for update skip locked)
  returning o.*;
end;
$$;

create or replace function public.outbox_ack(p_event uuid, p_consumer text, p_ok boolean, p_error text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.outbox_events;
begin
  select * into e from public.outbox_events where id = p_event and consumer = p_consumer for update;
  if e.id is null or e.status <> 'processing' then perform private.fail('CONFLICT', 'Event is not leased by this consumer'); end if;
  if p_ok then
    update public.outbox_events set status = 'delivered', delivered_at = now(), locked_until = null, last_error = null where id = e.id;
    return 'delivered';
  end if;
  update public.outbox_events set
    status = case when e.attempts >= e.max_attempts then 'dead_letter' else 'pending' end,
    available_at = now() + make_interval(mins => least(power(2, e.attempts)::int, 60)),
    locked_until = null, last_error = left(p_error, 300)
  where id = e.id;
  return case when e.attempts >= e.max_attempts then 'dead_letter' else 'pending' end;
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke all on function private.j_text(jsonb, text), private.j_num(jsonb, text), private.j_text_array(jsonb, text, int, int),
  private.intake_phone(text, text), private.name_tokens(text), private.names_related(text, text), private.intake_normalize(jsonb, text, text, text),
  private.intake_extraction_fields(jsonb), private.intake_eligible(uuid, uuid), private.intake_assign(uuid, jsonb, uuid),
  private.run_step(public.agent_runs, text, text, jsonb), private.emit_event(uuid, text, text, uuid, uuid, jsonb, text, text),
  private.emit_ready_for_qualification(uuid, uuid, uuid, jsonb), private.intake_execute(public.agent_runs),
  private.agent_activity(uuid, uuid, uuid, text, text, text, text, jsonb),
  private.leads_intake_guard(), private.leads_manual_intake()
  from public, anon, authenticated;
-- Called from the AFTER INSERT trigger while the client's own role is active; re-checks leads.edit itself.
revoke all on function private.record_manual_intake(uuid) from public, anon;
grant execute on function private.record_manual_intake(uuid) to authenticated;

revoke execute on function public.intake_receive(uuid, text, text, text, jsonb, text), public.intake_attach_extraction(uuid, jsonb, jsonb),
  public.intake_process(uuid), public.intake_process_due(int), public.outbox_claim(text, text[], int), public.outbox_ack(uuid, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.intake_receive(uuid, text, text, text, jsonb, text), public.intake_attach_extraction(uuid, jsonb, jsonb),
  public.intake_process(uuid), public.intake_process_due(int), public.outbox_claim(text, text[], int), public.outbox_ack(uuid, text, boolean, text)
  to service_role;

revoke execute on function public.resolve_intake_review(uuid, text, uuid), public.lead_intake_summary(uuid) from public, anon;
grant execute on function public.resolve_intake_review(uuid, text, uuid), public.lead_intake_summary(uuid) to authenticated;
