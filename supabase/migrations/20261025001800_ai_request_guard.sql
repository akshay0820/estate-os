-- Phase 2 remediation (PRA-029, PRA-030, PRA-026). Additive; no existing object changed except one EXECUTE grant.
--
-- The four Edge Functions that call Claude on a user's request (appointment-assistant, crm-enrichment,
-- sales-intelligence-recommend, sales-analyst) used to check the feature permission only in the RPC that ran *after*
-- the model call, and none of them limited how often a user could call them. ai_request_begin is called first, as the
-- user: it checks the permission for the feature, applies a per-user hourly and a per-organization daily limit, and
-- records the request. ai_request_finish records the outcome. Failed model calls count towards the limits (they cost).

create table public.ai_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null,
  feature text not null check (feature in ('appointment_assistant', 'crm_enrichment', 'sales_recommendations', 'sales_analyst')),
  status text not null default 'started' check (status in ('started', 'ok', 'no_result', 'invalid_output', 'model_error', 'timeout', 'refused', 'error')),
  model text check (model is null or length(model) <= 100),
  duration_ms int check (duration_ms is null or duration_ms between 0 and 3600000),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index ai_requests_org_idx on public.ai_requests (organization_id, created_at desc);
create index ai_requests_user_idx on public.ai_requests (user_id, feature, created_at desc);

alter table public.ai_requests enable row level security;
create policy ai_requests_read on public.ai_requests for select to authenticated using (public.has_perm(organization_id, 'usage.view'));
revoke all on public.ai_requests from anon;
revoke insert, update, delete, truncate on public.ai_requests from authenticated;

-- Limits. Conservative defaults; change them here (a new migration) rather than per request.
create or replace function private.ai_limits(p_feature text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_feature
    when 'appointment_assistant' then '{"per_user_hour": 60, "permission": "appointments.edit"}'
    when 'crm_enrichment' then '{"per_user_hour": 30, "permission": "leads.edit"}'
    when 'sales_recommendations' then '{"per_user_hour": 10, "permission": "reports.view"}'
    when 'sales_analyst' then '{"per_user_hour": 60, "permission": "reports.view"}'
  end::jsonb || '{"per_org_day": 1000}'::jsonb;
$$;

create or replace function public.ai_request_begin(p_org uuid, p_feature text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  lim jsonb := private.ai_limits(p_feature);
  uid uuid := auth.uid();
  used_user int;
  used_org int;
  rid uuid;
begin
  if uid is null then perform private.fail('UNAUTHENTICATED', 'Sign in required'); end if;
  if lim is null or lim->>'permission' is null then perform private.fail('VALIDATION_ERROR', 'Unknown AI feature'); end if;
  -- The organization is never taken on trust: the caller must be an active member, or it does not exist for them.
  if p_org is null or not public.is_org_member(p_org) then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if not public.has_perm(p_org, lim->>'permission') then perform private.fail('FORBIDDEN', 'You do not have access to this AI feature'); end if;
  -- Same rule as si_recommendation_context: managers (team.view) or admins (settings.manage) generate recommendations.
  if p_feature = 'sales_recommendations' and not (public.has_perm(p_org, 'team.view') or public.has_perm(p_org, 'settings.manage')) then
    perform private.fail('FORBIDDEN', 'Managers generate recommendations');
  end if;

  -- One request at a time per organization while counting, so concurrent calls cannot both pass the limit.
  perform pg_advisory_xact_lock(hashtextextended('ai_request:' || p_org::text, 0));
  select count(*) into used_user from public.ai_requests
   where user_id = uid and organization_id = p_org and feature = p_feature and created_at > now() - interval '1 hour';
  if used_user >= (lim->>'per_user_hour')::int then
    perform private.fail('RATE_LIMITED', 'Too many AI requests for this feature; try again later');
  end if;
  select count(*) into used_org from public.ai_requests where organization_id = p_org and created_at > now() - interval '1 day';
  if used_org >= (lim->>'per_org_day')::int then
    perform private.fail('RATE_LIMITED', 'This workspace has reached its daily AI request limit');
  end if;

  insert into public.ai_requests (organization_id, user_id, feature) values (p_org, uid, p_feature) returning id into rid;
  return jsonb_build_object('request_id', rid, 'remaining_user_hour', (lim->>'per_user_hour')::int - used_user - 1);
end;
$$;

create or replace function public.ai_request_finish(p_request uuid, p_status text, p_duration_ms int default null, p_model text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  if p_status is null or p_status not in ('ok', 'no_result', 'invalid_output', 'model_error', 'timeout', 'refused', 'error') then
    perform private.fail('VALIDATION_ERROR', 'Invalid status');
  end if;
  -- Only the requesting user, only once.
  update public.ai_requests
     set status = p_status, finished_at = now(),
         duration_ms = case when p_duration_ms between 0 and 3600000 then p_duration_ms end,
         model = left(p_model, 100)
   where id = p_request and user_id = auth.uid() and status = 'started';
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke execute on function public.ai_request_begin(uuid, text), public.ai_request_finish(uuid, text, int, text) from public, anon;
grant execute on function public.ai_request_begin(uuid, text), public.ai_request_finish(uuid, text, int, text) to authenticated;
revoke execute on function private.ai_limits(text) from public, anon, authenticated;

-- PRA-026: set_updated_at is only ever used as a trigger function, and PostgreSQL checks EXECUTE on a trigger
-- function when the trigger is created, not when it fires (the existing suite's updates as `authenticated` prove it).
revoke execute on function public.set_updated_at() from public, anon, authenticated;
