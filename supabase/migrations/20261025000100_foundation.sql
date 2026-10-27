-- Estate OS · 0001 · Tenancy foundation
-- Profiles, organizations, memberships, invitations and capability-based permissions.
-- Every later migration relies on is_org_member() / has_perm().

create schema if not exists private;
revoke all on schema private from public;

-- ───────────────────────── utilities ─────────────────────────

-- 32 random bytes as hex, from the server's strong RNG (gen_random_uuid uses pg_strong_random).
create or replace function private.random_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;

create or replace function private.sha256_hex(input text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(input, ''), 'UTF8')), 'hex');
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Raises a client-safe error with a stable code in DETAIL (mapped by the API layer).
create or replace function private.fail(code text, message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using message = message, detail = code, errcode = 'P0001';
end;
$$;

-- ───────────────────────── profiles ─────────────────────────

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 120),
  email text,
  avatar_url text check (avatar_url is null or avatar_url ~ '^https://'),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  locale text not null default 'en-IN',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- A profile is created for every auth user; name comes from sign-up metadata, email from auth.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1), ''), 120),
    lower(new.email)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

create or replace function private.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = lower(new.email) where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function private.handle_user_email_change();

-- ───────────────────────── organizations ─────────────────────────

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  legal_name text,
  city text,
  default_currency char(3) not null default 'INR' check (default_currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'Asia/Kolkata',
  country_code char(2) not null default 'IN' check (country_code ~ '^[A-Z]{2}$'),
  -- Non-secret operating rules. Validated by private.validate_org_settings().
  settings jsonb not null default jsonb_build_object(
    'business_hours', jsonb_build_object('start', 9, 'end', 20, 'days', jsonb_build_array(1, 2, 3, 4, 5, 6)),
    'calling_hours', jsonb_build_object('start', 9, 'end', 21),
    'sla_minutes', 5,
    'assignment', 'least_loaded',
    'outbound_paused', false
  ),
  webhook_secret_version integer not null default 0,
  subscription_status text not null default 'trial'
    check (subscription_status in ('trial', 'active', 'past_due', 'cancelled', 'suspended')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create trigger organizations_updated_at before update on public.organizations
  for each row execute function public.set_updated_at();

create or replace function private.validate_org_settings()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  s jsonb := new.settings;
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
  return new;
exception
  when invalid_text_representation or null_value_not_allowed then
    perform private.fail('VALIDATION_ERROR', 'Organization settings are invalid');
    return null;
end;
$$;

create trigger organizations_validate_settings before insert or update of settings on public.organizations
  for each row execute function private.validate_org_settings();

-- ───────────────────────── memberships & permissions ─────────────────────────

create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  role text not null check (role in ('owner', 'admin', 'manager', 'agent', 'operations', 'finance', 'viewer')),
  status text not null default 'active' check (status in ('active', 'suspended', 'removed')),
  title text check (char_length(title) <= 80),
  localities text[] not null default '{}',
  invited_by uuid references public.profiles (id) on delete set null,
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index organization_memberships_user_org_status_idx on public.organization_memberships (user_id, organization_id, status);
create index organization_memberships_org_status_role_idx on public.organization_memberships (organization_id, status, role);

create trigger organization_memberships_updated_at before update on public.organization_memberships
  for each row execute function public.set_updated_at();

create table public.role_permissions (
  role text not null,
  permission text not null,
  primary key (role, permission)
);

-- Capability matrix. Mirrored in frontend/src/lib/permissions.ts (kept in sync by a test).
insert into public.role_permissions (role, permission)
select r, p
from (values
  ('owner', array['leads.view','leads.edit','leads.edit_any','leads.assign','leads.import','leads.export','leads.merge','contacts.edit','properties.edit','properties.verify','deals.edit','appointments.edit','tasks.edit','inbox.reply','calls.place','calls.recordings','agents.manage','workflows.manage','approvals.decide','outbound.kill','logs.view','usage.view','marketing.view','team.view','team.manage','finance.view','finance.edit','reports.view','documents.edit','documents.restricted','integrations.manage','audit.view','settings.manage']),
  ('admin', array['leads.view','leads.edit','leads.edit_any','leads.assign','leads.import','leads.export','leads.merge','contacts.edit','properties.edit','properties.verify','deals.edit','appointments.edit','tasks.edit','inbox.reply','calls.place','calls.recordings','agents.manage','workflows.manage','approvals.decide','outbound.kill','logs.view','usage.view','marketing.view','team.view','team.manage','finance.view','reports.view','documents.edit','documents.restricted','integrations.manage','audit.view','settings.manage']),
  ('manager', array['leads.view','leads.edit','leads.edit_any','leads.assign','leads.import','leads.export','leads.merge','contacts.edit','properties.edit','properties.verify','deals.edit','appointments.edit','tasks.edit','inbox.reply','calls.place','calls.recordings','approvals.decide','logs.view','usage.view','marketing.view','team.view','reports.view','documents.edit']),
  ('agent', array['leads.view','leads.edit','contacts.edit','properties.edit','deals.edit','appointments.edit','tasks.edit','inbox.reply','calls.place','documents.edit']),
  ('operations', array['leads.view','leads.edit','leads.edit_any','contacts.edit','properties.edit','properties.verify','appointments.edit','tasks.edit','logs.view','team.view','documents.edit','audit.view']),
  ('finance', array['leads.view','finance.view','finance.edit','usage.view','reports.view','audit.view','marketing.view']),
  ('viewer', array['leads.view','reports.view'])
) as m(r, perms), unnest(perms) as p;

alter table public.role_permissions enable row level security;
create policy role_permissions_read on public.role_permissions for select to authenticated using (true);

-- Helpers. SECURITY DEFINER so policies on memberships don't recurse; search_path pinned.
create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships m
    where m.organization_id = target_org and m.user_id = (select auth.uid()) and m.status = 'active'
  );
$$;

create or replace function public.has_perm(target_org uuid, perm text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships m
    join public.role_permissions rp on rp.role = m.role
    where m.organization_id = target_org
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and rp.permission = perm
  );
$$;

create or replace function public.org_role(target_org uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.organization_memberships m
  where m.organization_id = target_org and m.user_id = (select auth.uid()) and m.status = 'active';
$$;

-- Is `member` an active member of `target_org`? Used to validate assignee columns.
create or replace function private.is_active_member(target_org uuid, member uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select member is null or exists (
    select 1 from public.organization_memberships m
    where m.organization_id = target_org and m.user_id = member and m.status = 'active'
  );
$$;

create or replace function private.shares_org(other uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships a
    join public.organization_memberships b on b.organization_id = a.organization_id
    where a.user_id = (select auth.uid()) and a.status = 'active'
      and b.user_id = other and b.status in ('active', 'suspended')
  );
$$;

-- Guard rails for membership changes, whatever path they take.
create or replace function private.guard_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role text;
  owners int;
begin
  if tg_op = 'UPDATE' then
    if new.organization_id <> old.organization_id or new.user_id <> old.user_id then
      perform private.fail('FORBIDDEN', 'Membership cannot be moved');
    end if;
    -- Service-level operations (no JWT) are trusted server code.
    if actor is not null then
      actor_role := public.org_role(new.organization_id);
      if new.user_id = actor and new.role <> old.role then
        perform private.fail('FORBIDDEN', 'You cannot change your own role');
      end if;
      if (new.role = 'owner' or old.role = 'owner') and new.role <> old.role and actor_role is distinct from 'owner' then
        perform private.fail('FORBIDDEN', 'Only an owner can grant or remove the owner role');
      end if;
    end if;
    if old.role = 'owner' and old.status = 'active' and (new.role <> 'owner' or new.status <> 'active') then
      select count(*) into owners from public.organization_memberships
      where organization_id = old.organization_id and role = 'owner' and status = 'active' and id <> old.id;
      if owners = 0 then
        perform private.fail('LAST_OWNER', 'An organization needs at least one active owner. Transfer ownership first.');
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger organization_memberships_guard before update on public.organization_memberships
  for each row execute function private.guard_membership();

-- ───────────────────────── invitations ─────────────────────────

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  email_normalized text not null check (email_normalized ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('admin', 'manager', 'agent', 'operations', 'finance', 'viewer')),
  token_hash text not null unique,
  invited_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index invitations_one_open_per_email on public.invitations (organization_id, email_normalized)
  where accepted_at is null and revoked_at is null;

-- ───────────────────────── RLS ─────────────────────────

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.invitations enable row level security;

create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_org(id));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy organizations_read on public.organizations for select to authenticated
  using (public.is_org_member(id));
create policy organizations_update on public.organizations for update to authenticated
  using (public.has_perm(id, 'settings.manage')) with check (public.has_perm(id, 'settings.manage'));

create policy memberships_read on public.organization_memberships for select to authenticated
  using (user_id = (select auth.uid()) or public.has_perm(organization_id, 'team.view') or public.is_org_member(organization_id));
create policy memberships_update on public.organization_memberships for update to authenticated
  using (public.has_perm(organization_id, 'team.manage')) with check (public.has_perm(organization_id, 'team.manage'));
-- No insert/delete policies: memberships are created only by create_organization() / accept_invitation().

create policy invitations_read on public.invitations for select to authenticated
  using (public.has_perm(organization_id, 'team.manage'));
-- Writes only through invite_member() / revoke_invitation().

-- Column privileges: clients may only edit the columns listed (mass-assignment guard).
revoke update on public.profiles from authenticated;
grant update (full_name, avatar_url, phone_e164, locale) on public.profiles to authenticated;
revoke update on public.organizations from authenticated;
grant update (name, legal_name, city, timezone, settings) on public.organizations to authenticated;
revoke update on public.organization_memberships from authenticated;
grant update (role, status, title, localities) on public.organization_memberships to authenticated;
revoke insert, delete on public.organizations, public.organization_memberships, public.invitations, public.role_permissions from authenticated, anon;

-- ───────────────────────── RPCs ─────────────────────────

create or replace function public.create_organization(p_name text, p_city text default null, p_timezone text default 'Asia/Kolkata')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  base text;
  candidate text;
  n int := 0;
  org_id uuid;
begin
  if uid is null then perform private.fail('UNAUTHENTICATED', 'Sign in first'); end if;
  if p_name is null or char_length(trim(p_name)) < 2 or char_length(trim(p_name)) > 120 then
    perform private.fail('VALIDATION_ERROR', 'Organization name must be 2–120 characters');
  end if;
  if (select count(*) from public.organization_memberships where user_id = uid and role = 'owner') >= 10 then
    perform private.fail('RATE_LIMITED', 'Too many organizations for this account');
  end if;
  base := trim(both '-' from regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g'));
  if base = '' then base := 'workspace'; end if;
  base := left(base, 50);
  candidate := base;
  while exists (select 1 from public.organizations where slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;

  insert into public.organizations (name, slug, city, timezone, created_by)
  values (trim(p_name), candidate, nullif(trim(p_city), ''), coalesce(nullif(p_timezone, ''), 'Asia/Kolkata'), uid)
  returning id into org_id;

  insert into public.organization_memberships (organization_id, user_id, role, title)
  values (org_id, uid, 'owner', 'Owner');
  return org_id;
end;
$$;

create or replace function public.invite_member(p_org uuid, p_email text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
  raw_token text;
  inv_id uuid;
begin
  if not public.has_perm(p_org, 'team.manage') then perform private.fail('FORBIDDEN', 'You cannot invite members'); end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform private.fail('VALIDATION_ERROR', 'Enter a valid email address'); end if;
  if p_role not in ('admin', 'manager', 'agent', 'operations', 'finance', 'viewer') then
    perform private.fail('VALIDATION_ERROR', 'Invalid role');
  end if;
  if p_role = 'admin' and public.org_role(p_org) <> 'owner' then
    perform private.fail('FORBIDDEN', 'Only an owner can invite admins');
  end if;
  if exists (
    select 1 from public.organization_memberships m join public.profiles p on p.id = m.user_id
    where m.organization_id = p_org and p.email = v_email and m.status = 'active'
  ) then
    perform private.fail('CONFLICT', 'This person is already a member');
  end if;
  if exists (select 1 from public.invitations where organization_id = p_org and email_normalized = v_email and accepted_at is null and revoked_at is null and expires_at > now()) then
    perform private.fail('CONFLICT', 'An invitation is already pending for this email');
  end if;
  -- Close any expired open invite so the partial unique index allows a new one.
  update public.invitations set revoked_at = now()
  where organization_id = p_org and email_normalized = v_email and accepted_at is null and revoked_at is null;

  raw_token := private.random_token();
  insert into public.invitations (organization_id, email_normalized, role, token_hash, invited_by, expires_at)
  values (p_org, v_email, p_role, private.sha256_hex(raw_token), auth.uid(), now() + interval '7 days')
  returning id into inv_id;
  -- The raw token is returned once and never stored.
  return jsonb_build_object('id', inv_id, 'token', raw_token);
end;
$$;

create or replace function public.revoke_invitation(p_invitation uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
begin
  select organization_id into org from public.invitations where id = p_invitation;
  if org is null or not public.has_perm(org, 'team.manage') then perform private.fail('NOT_FOUND', 'Invitation not found'); end if;
  update public.invitations set revoked_at = now() where id = p_invitation and accepted_at is null;
end;
$$;

create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  my_email text;
  inv public.invitations;
begin
  if uid is null then perform private.fail('UNAUTHENTICATED', 'Sign in first'); end if;
  select lower(email) into my_email from auth.users where id = uid;
  select * into inv from public.invitations
  where token_hash = private.sha256_hex(p_token)
  for update;
  if inv.id is null or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at < now() then
    perform private.fail('INVALID_INVITATION', 'This invitation is invalid or has expired');
  end if;
  if inv.email_normalized <> my_email then
    perform private.fail('INVALID_INVITATION', 'This invitation was sent to a different email address');
  end if;
  insert into public.organization_memberships (organization_id, user_id, role, invited_by)
  values (inv.organization_id, uid, inv.role, inv.invited_by)
  on conflict (organization_id, user_id) do update set status = 'active', role = excluded.role;
  update public.invitations set accepted_at = now() where id = inv.id;
  return inv.organization_id;
end;
$$;

-- Pending invitations addressed to the signed-in user (no token needed to see them).
create or replace function public.my_invitations()
returns table (id uuid, organization_id uuid, organization_name text, role text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.organization_id, o.name, i.role, i.expires_at
  from public.invitations i
  join public.organizations o on o.id = i.organization_id
  where i.email_normalized = (select lower(email) from auth.users where id = auth.uid())
    and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();
$$;

create or replace function public.accept_invitation_by_id(p_invitation uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  inv public.invitations;
begin
  if uid is null then perform private.fail('UNAUTHENTICATED', 'Sign in first'); end if;
  select * into inv from public.invitations where id = p_invitation for update;
  if inv.id is null or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at < now()
     or inv.email_normalized <> (select lower(email) from auth.users where id = uid) then
    perform private.fail('INVALID_INVITATION', 'This invitation is invalid or has expired');
  end if;
  insert into public.organization_memberships (organization_id, user_id, role, invited_by)
  values (inv.organization_id, uid, inv.role, inv.invited_by)
  on conflict (organization_id, user_id) do update set status = 'active', role = excluded.role;
  update public.invitations set accepted_at = now() where id = inv.id;
  return inv.organization_id;
end;
$$;

-- Lock down function execution: only signed-in users may call RPCs; helpers stay private.
revoke all on all functions in schema private from public, anon, authenticated;
revoke execute on function public.create_organization(text, text, text), public.invite_member(uuid, text, text),
  public.revoke_invitation(uuid), public.accept_invitation(text), public.my_invitations(), public.accept_invitation_by_id(uuid)
  from public, anon;
grant execute on function public.create_organization(text, text, text), public.invite_member(uuid, text, text),
  public.revoke_invitation(uuid), public.accept_invitation(text), public.my_invitations(), public.accept_invitation_by_id(uuid)
  to authenticated;
grant usage on schema private to authenticated;
grant execute on function private.shares_org(uuid), private.is_active_member(uuid, uuid), private.fail(text, text) to authenticated;
