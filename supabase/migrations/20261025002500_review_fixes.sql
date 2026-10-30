-- Code-review fixes (additive).
-- 1. Changing a workspace's country re-reads every contact phone saved without a country code with the new country's
--    code, so duplicate checks keep matching (a +91 number becomes +1 when the workspace moves from IN to US).
--    contacts_before now checks the owner only when it is set or changed: re-reading phones (or any edit) no longer fails
--    for a contact whose owner has since left the workspace.
-- 2. create_organization takes the country (p_country, default US), so a new workspace is created in one step; the old
--    three-argument function is replaced (positional calls with up to three arguments keep working).
-- 3. import_leads(p_org, p_rows): up to 200 rows per call, each through create_lead in its own savepoint, returning one
--    result per row in order. The CSV import sends batches instead of one request per row.

create or replace function private.contacts_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := nullif(trim(new.email), '');
  new.phone := nullif(trim(new.phone), '');
  new.email_normalized := lower(new.email);
  new.phone_e164 := private.normalize_phone(new.phone, (select o.country_code from public.organizations o where o.id = new.organization_id));
  -- Check the owner only when it is set or changed, so editing a contact whose owner has since left still works.
  if tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to then
    perform private.assert_member(new.organization_id, new.assigned_to, 'Owner');
  end if;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;

create or replace function private.org_country_renormalize()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.country_code is distinct from old.country_code then
    -- contacts_before recomputes phone_e164 from the (already updated) workspace country.
    update public.contacts c set phone = c.phone
    where c.organization_id = new.id and c.phone is not null and c.phone !~ '^\s*(\+|00)';
  end if;
  return null;
end;
$$;
create trigger organizations_country_renormalize after update of country_code on public.organizations
  for each row execute function private.org_country_renormalize();
revoke execute on function private.org_country_renormalize() from public, anon, authenticated;

drop function public.create_organization(text, text, text);
create or replace function public.create_organization(p_name text, p_city text default null, p_timezone text default 'America/New_York', p_country text default 'US')
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
  if p_country is null or p_country !~ '^[A-Z]{2}$' then perform private.fail('VALIDATION_ERROR', 'Country must be a two-letter code'); end if;
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

  insert into public.organizations (name, slug, city, timezone, country_code, created_by)
  values (trim(p_name), candidate, nullif(trim(p_city), ''), coalesce(nullif(p_timezone, ''), 'America/New_York'), p_country, uid)
  returning id into org_id;

  insert into public.organization_memberships (organization_id, user_id, role, title)
  values (org_id, uid, 'owner', 'Owner');
  return org_id;
end;
$$;
revoke execute on function public.create_organization(text, text, text, text) from public, anon;
grant execute on function public.create_organization(text, text, text, text) to authenticated;

create or replace function public.import_leads(p_org uuid, p_rows jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r jsonb;
  res jsonb;
  out jsonb := '[]';
  v_code text;
  v_msg text;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 200 then
    perform private.fail('VALIDATION_ERROR', 'Send at most 200 rows per call');
  end if;
  if not public.has_perm(p_org, 'leads.edit') then perform private.fail('FORBIDDEN', 'You cannot create leads'); end if;
  for r in select x.value from jsonb_array_elements(p_rows) with ordinality x(value, n) order by x.n loop
    begin
      res := public.create_lead(p_org, r, 'ask');
      out := out || jsonb_build_array(jsonb_build_object('status', res ->> 'status', 'lead_id', res ->> 'lead_id'));
    exception when others then
      get stacked diagnostics v_code = pg_exception_detail, v_msg = message_text;
      out := out || jsonb_build_array(jsonb_build_object('status', 'error', 'code', nullif(v_code, ''), 'message', v_msg));
    end;
  end loop;
  return out;
end;
$$;
revoke execute on function public.import_leads(uuid, jsonb) from public, anon;
grant execute on function public.import_leads(uuid, jsonb) to authenticated;
