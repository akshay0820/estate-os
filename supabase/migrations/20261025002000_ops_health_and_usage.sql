-- Phase 5: operational health signal and AI usage metering. Additive, except ai_request_finish, which is replaced by a
-- version with two more optional parameters (the previous four-argument calls keep working through named arguments).
--
-- 1. public.ops_health() — service role only. Aggregate, platform-level signals for an uptime monitor (via the `health`
--    Edge Function): failed cron runs and worker HTTP errors in the last 15 minutes, dead-lettered runs and events, the age
--    of the oldest due event, webhook rejections, AI request failures. No tenant identifiers, no personal data.
-- 2. Provider-reported token usage on user-triggered AI requests, and public.ai_usage_summary(org, from, to): model calls
--    and tokens per agent for one organization, from the usage each step already stores (agent_runs.model_meta,
--    property_match_runs.model_meta, follow_ups.model_meta, voice_calls.analysis_meta, ai_requests). No cost is computed:
--    prices are not stored, so cost = tokens × the provider's published price is a documented manual step.

alter table public.ai_requests
  add column input_tokens int check (input_tokens is null or input_tokens between 0 and 10000000),
  add column output_tokens int check (output_tokens is null or output_tokens between 0 and 10000000);

drop function public.ai_request_finish(uuid, text, int, text);
create function public.ai_request_finish(p_request uuid, p_status text, p_duration_ms int default null, p_model text default null,
  p_input_tokens int default null, p_output_tokens int default null)
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
         model = left(p_model, 100),
         input_tokens = case when p_input_tokens between 0 and 10000000 then p_input_tokens end,
         output_tokens = case when p_output_tokens between 0 and 10000000 then p_output_tokens end
   where id = p_request and user_id = auth.uid() and status = 'started';
  get diagnostics n = row_count;
  return n = 1;
end;
$$;
revoke execute on function public.ai_request_finish(uuid, text, int, text, int, int) from public, anon;
grant execute on function public.ai_request_finish(uuid, text, int, text, int, int) to authenticated;

-- ───────────────────────── usage summary ─────────────────────────

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
          'model_responses', count(*) filter (where u.m ? 'input_tokens'),
          'not_reaching_model', count(*) filter (where not (u.m ? 'input_tokens')),
          'input_tokens', coalesce(sum((u.m ->> 'input_tokens')::bigint) filter (where jsonb_typeof(u.m -> 'input_tokens') = 'number'), 0),
          'output_tokens', coalesce(sum((u.m ->> 'output_tokens')::bigint) filter (where jsonb_typeof(u.m -> 'output_tokens') = 'number'), 0),
          'models', coalesce((select jsonb_agg(distinct u2.m ->> 'model') from u u2 where u2.agent = u.agent and u2.m ? 'input_tokens' and u2.m ->> 'model' is not null), '[]')) x
        from u group by u.agent) s)
  );
end;
$$;
revoke execute on function public.ai_usage_summary(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.ai_usage_summary(uuid, timestamptz, timestamptz) to authenticated;

-- ───────────────────────── ops health ─────────────────────────

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
  select round(extract(epoch from now() - min(created_at)))::int into oldest_due from public.outbox_events where status = 'pending' and available_at <= now();
  select count(*) into dead_runs from public.agent_runs where status = 'dead_letter' and coalesce(completed_at, received_at) > now() - interval '24 hours';
  select count(*) into dead_events from public.outbox_events where status = 'dead_letter' and created_at > now() - interval '24 hours';
  select coalesce(sum(attempt_count), 0) into rejected from public.webhook_events where processing_status = 'rejected' and received_at > now() - interval '1 hour';
  select count(*) into ai_failed from public.ai_requests where status in ('model_error', 'timeout', 'error') and created_at > now() - interval '1 hour';

  if coalesce(cron_failed, 0) > 0 then reasons := array_append(reasons, 'cron_failures'); end if;
  if coalesce(worker_errors, 0) >= 3 then reasons := array_append(reasons, 'worker_http_errors'); end if;
  if coalesce(oldest_due, 0) > 900 then reasons := array_append(reasons, 'event_backlog'); end if;
  if dead_runs > 0 or dead_events > 0 then reasons := array_append(reasons, 'dead_letters'); end if;

  return jsonb_build_object(
    'status', case when cardinality(reasons) = 0 then 'ok' else 'degraded' end,
    'reasons', to_jsonb(reasons),
    'checked_at', now(),
    'signals', jsonb_build_object(
      'cron_failed_15m', cron_failed, 'worker_calls_15m', worker_calls, 'worker_errors_15m', worker_errors,
      'oldest_due_event_seconds', oldest_due, 'dead_letter_runs_24h', dead_runs, 'dead_letter_events_24h', dead_events,
      'webhook_rejections_1h', rejected, 'ai_request_failures_1h', ai_failed,
      'paused_agent_controls', (select count(*) from public.agent_controls where paused),
      'workspaces_outbound_paused', (select count(*) from public.organizations where coalesce((settings ->> 'outbound_paused')::boolean, false))));
end;
$$;
revoke execute on function public.ops_health() from public, anon, authenticated;
grant execute on function public.ops_health() to service_role;
