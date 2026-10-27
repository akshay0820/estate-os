-- Fixes to 0020 (code review). Additive: replaces public.ops_health and public.ai_usage_summary (same signatures) and adds
-- one trigger.
-- 1. ops_health: events held because their consumer agent is paused for that workspace are not a backlog; dead letters
--    flip the status only when new in the last 15 minutes (24-hour counts stay in the signals).
-- 2. Model usage of earlier drafting / explanation calls is kept when a later call replaces follow_ups.model_meta or
--    property_match_runs.model_meta (prior_calls / prior_input_tokens / prior_output_tokens), and ai_usage_summary adds it.

create or replace function private.carry_model_usage()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  o jsonb := old.model_meta;
begin
  -- Appends to the same call's meta (e.g. marking a timeout) keep the old keys; only a replacement by a new call carries.
  if o is null or new.model_meta is null or new.model_meta @> (o - 'outcome' - 'rejected') then
    return new;
  end if;
  new.model_meta := new.model_meta || jsonb_build_object(
    'prior_calls', coalesce((o ->> 'prior_calls')::int, 0) + case when jsonb_typeof(o -> 'input_tokens') = 'number' then 1 else 0 end,
    'prior_input_tokens', coalesce((o ->> 'prior_input_tokens')::bigint, 0) + coalesce(case when jsonb_typeof(o -> 'input_tokens') = 'number' then (o ->> 'input_tokens')::bigint end, 0),
    'prior_output_tokens', coalesce((o ->> 'prior_output_tokens')::bigint, 0) + coalesce(case when jsonb_typeof(o -> 'output_tokens') = 'number' then (o ->> 'output_tokens')::bigint end, 0));
  return new;
end;
$$;
create trigger follow_ups_carry_model_usage before update of model_meta on public.follow_ups
  for each row execute function private.carry_model_usage();
create trigger property_match_runs_carry_model_usage before update of model_meta on public.property_match_runs
  for each row execute function private.carry_model_usage();
revoke execute on function private.carry_model_usage() from public, anon, authenticated;

create or replace function public.ai_usage_summary(p_org uuid, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t timestamptz := coalesce(p_to, now());
  f timestamptz := coalesce(p_from, coalesce(p_to, now()) - interval '30 days');
begin
  if p_org is null or not public.is_org_member(p_org) then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if not public.has_perm(p_org, 'usage.view') then perform private.fail('FORBIDDEN', 'Usage needs usage access'); end if;
  if f >= t or t - f > interval '400 days' then perform private.fail('VALIDATION_ERROR', 'Invalid period (at most 400 days)'); end if;

  return jsonb_build_object(
    'period', jsonb_build_object('from', f, 'to', t),
    'source', 'Token counts as reported by the model provider and stored with each step. Steps that never reached the provider (not configured, no text) are not counted.',
    'cost', jsonb_build_object('available', false, 'reason', 'Prices are not stored; multiply tokens by the provider''s published price per model'),
    'by_agent', (
      with u as (
        select 'lead_intake_agent' agent, ar.model_meta m from public.agent_runs ar
          where ar.organization_id = p_org and ar.agent_id = 'lead_intake_agent' and ar.received_at >= f and ar.received_at < t and ar.model_meta is not null
        union all
        select 'sales_qualification_agent', ar.model_meta from public.agent_runs ar
          where ar.organization_id = p_org and ar.agent_id = 'sales_qualification_agent' and ar.received_at >= f and ar.received_at < t and ar.model_meta is not null
        union all
        select 'property_matching_agent', r.model_meta from public.property_match_runs r
          where r.organization_id = p_org and r.created_at >= f and r.created_at < t and r.model_meta is not null
        union all
        select 'follow_up_agent', fu.model_meta from public.follow_ups fu
          where fu.organization_id = p_org and fu.created_at >= f and fu.created_at < t and fu.model_meta is not null
        union all
        select 'voice_calling_agent', v.analysis_meta from public.voice_calls v
          where v.organization_id = p_org and v.requested_at >= f and v.requested_at < t and v.analysis_meta is not null
        union all
        select private.ai_feature_agent(q.feature), jsonb_strip_nulls(jsonb_build_object('model', q.model, 'outcome', q.status,
            'input_tokens', q.input_tokens, 'output_tokens', q.output_tokens))
          from public.ai_requests q where q.organization_id = p_org and q.created_at >= f and q.created_at < t and q.status <> 'started'
      )
      select coalesce(jsonb_object_agg(s.agent, s.x), '{}') from (
        select u.agent, jsonb_build_object(
          'model_responses', count(*) filter (where u.m ? 'input_tokens') + coalesce(sum((u.m ->> 'prior_calls')::int), 0),
          'not_reaching_model', count(*) filter (where not (u.m ? 'input_tokens')),
          'input_tokens', coalesce(sum((u.m ->> 'input_tokens')::bigint) filter (where jsonb_typeof(u.m -> 'input_tokens') = 'number'), 0)
            + coalesce(sum((u.m ->> 'prior_input_tokens')::bigint), 0),
          'output_tokens', coalesce(sum((u.m ->> 'output_tokens')::bigint) filter (where jsonb_typeof(u.m -> 'output_tokens') = 'number'), 0)
            + coalesce(sum((u.m ->> 'prior_output_tokens')::bigint), 0),
          'models', coalesce((select jsonb_agg(distinct u2.m ->> 'model') from u u2 where u2.agent = u.agent and u2.m ? 'input_tokens' and u2.m ->> 'model' is not null), '[]')) x
        from u group by u.agent) s)
  );
end;
$$;

create or replace function public.ops_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cron_failed int;
  worker_calls int;
  worker_errors int;
  oldest_due int;
  dead_runs int;
  dead_events int;
  dead_recent int;
  rejected int;
  ai_failed int;
  reasons text[] := '{}';
begin
  -- pg_cron and pg_net exist on Supabase; elsewhere (tests) these signals are reported as null, not as healthy zeros.
  if to_regclass('cron.job_run_details') is not null then
    execute $q$select count(*) from cron.job_run_details where start_time > now() - interval '15 minutes' and status = 'failed'$q$ into cron_failed;
  end if;
  if to_regclass('net._http_response') is not null then
    execute $q$select count(*), count(*) filter (where status_code is null or status_code >= 400) from net._http_response where created > now() - interval '15 minutes'$q$
      into worker_calls, worker_errors;
  end if;
  -- Events held on purpose (their consumer agent is paused for that workspace) are not a backlog.
  select round(extract(epoch from now() - min(e.created_at)))::int into oldest_due from public.outbox_events e
   where e.status = 'pending' and e.available_at <= now()
     and not exists (select 1 from public.agent_controls c where c.organization_id = e.organization_id and c.agent_id = e.consumer and c.paused);
  select count(*) into dead_runs from public.agent_runs where status = 'dead_letter' and coalesce(completed_at, received_at) > now() - interval '24 hours';
  select count(*) into dead_events from public.outbox_events where status = 'dead_letter' and created_at > now() - interval '24 hours';
  -- Only new dead letters change the status; older ones are reported in the signals for the daily review.
  select (select count(*) from public.agent_runs where status = 'dead_letter' and coalesce(completed_at, received_at) > now() - interval '15 minutes')
       + (select count(*) from public.outbox_events where status = 'dead_letter' and coalesce(locked_until, created_at) > now() - interval '15 minutes')
    into dead_recent;
  select coalesce(sum(attempt_count), 0) into rejected from public.webhook_events where processing_status = 'rejected' and received_at > now() - interval '1 hour';
  select count(*) into ai_failed from public.ai_requests where status in ('model_error', 'timeout', 'error') and created_at > now() - interval '1 hour';

  if coalesce(cron_failed, 0) > 0 then reasons := array_append(reasons, 'cron_failures'); end if;
  if coalesce(worker_errors, 0) >= 3 then reasons := array_append(reasons, 'worker_http_errors'); end if;
  if coalesce(oldest_due, 0) > 900 then reasons := array_append(reasons, 'event_backlog'); end if;
  if dead_recent > 0 then reasons := array_append(reasons, 'dead_letters'); end if;

  return jsonb_build_object(
    'status', case when cardinality(reasons) = 0 then 'ok' else 'degraded' end,
    'reasons', to_jsonb(reasons),
    'checked_at', now(),
    'signals', jsonb_build_object(
      'cron_failed_15m', cron_failed, 'worker_calls_15m', worker_calls, 'worker_errors_15m', worker_errors,
      'oldest_due_event_seconds', oldest_due, 'dead_letter_runs_24h', dead_runs, 'dead_letter_events_24h', dead_events,
      'dead_letters_15m', dead_recent, 'webhook_rejection_attempts_1h', rejected, 'ai_request_failures_1h', ai_failed,
      'paused_agent_controls', (select count(*) from public.agent_controls where paused),
      'workspaces_outbound_paused', (select count(*) from public.organizations where coalesce((settings ->> 'outbound_paused')::boolean, false))));
end;
$$;
