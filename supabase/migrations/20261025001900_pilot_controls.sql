-- Phase 4 pilot controls. Additive, except two function replacements (public.outbox_claim, public.ai_request_begin) that
-- keep their signatures and add one condition each.
--
-- 1. Per-tenant agent pause (PRA-032). An owner or admin (agents.manage) pauses one agent for one organization. While paused:
--    * the agent's outbox events for that organization stay pending (outbox_claim skips them);
--    * its queued and newly created agent runs are held (next_attempt_at = 'infinity'), including retries;
--    * Voice: new calls are refused (voice_calls insert guard);
--    * the user-triggered AI features of the agent are refused (ai_request_begin → AGENT_PAUSED).
--    Nothing is deleted or skipped: resuming releases held runs and events, which then process normally. Runs already
--    being processed when the pause is set finish. Human actions (approvals, manual sends, bookings by staff) stay available
--    as the manual fallback. Lead intake cannot be paused: captured leads must never be dropped (stop a source by rotating
--    its webhook secret instead). Other organizations are unaffected.
-- 2. pilot_overview: a tenant-scoped operational summary for the pilot, built only from persisted records.

create table public.agent_controls (
  id uuid not null default gen_random_uuid() unique,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  agent_id text not null check (agent_id in ('voice_calling_agent', 'sales_qualification_agent', 'property_matching_agent', 'follow_up_agent',
    'appointment_agent', 'crm_data_agent', 'sales_intelligence_agent')),
  paused boolean not null default false,
  reason text not null check (char_length(reason) between 5 and 300),
  changed_by uuid references public.profiles (id) on delete set null,
  changed_at timestamptz not null default now(),
  primary key (organization_id, agent_id)
);
alter table public.agent_controls enable row level security;
-- Every member can see whether an agent is paused (the state must be observable); only the RPC writes.
create policy agent_controls_read on public.agent_controls for select to authenticated using (public.is_org_member(organization_id));
revoke all on public.agent_controls from anon;
revoke insert, update, delete, truncate on public.agent_controls from authenticated;
create trigger agent_controls_audit after insert or update on public.agent_controls for each row execute function private.audit_row();

create or replace function private.agent_paused(p_org uuid, p_agent text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.agent_controls c where c.organization_id = p_org and c.agent_id = p_agent and c.paused);
$$;

create or replace function public.agent_control_set(p_org uuid, p_agent text, p_paused boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int := 0;
begin
  if p_org is null or not public.is_org_member(p_org) then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if not public.has_perm(p_org, 'agents.manage') then perform private.fail('FORBIDDEN', 'Only owners and admins can pause or resume agents'); end if;
  if p_agent is null or p_agent not in ('voice_calling_agent', 'sales_qualification_agent', 'property_matching_agent', 'follow_up_agent',
      'appointment_agent', 'crm_data_agent', 'sales_intelligence_agent') then
    perform private.fail('VALIDATION_ERROR', 'Unknown or non-pausable agent');
  end if;
  if p_paused is null or char_length(coalesce(trim(p_reason), '')) not between 5 and 300 then
    perform private.fail('VALIDATION_ERROR', 'A reason of 5–300 characters is required');
  end if;

  insert into public.agent_controls (organization_id, agent_id, paused, reason, changed_by, changed_at)
  values (p_org, p_agent, p_paused, trim(p_reason), auth.uid(), now())
  on conflict (organization_id, agent_id) do update
    set paused = excluded.paused, reason = excluded.reason, changed_by = excluded.changed_by, changed_at = excluded.changed_at;

  if p_paused then
    update public.agent_runs set next_attempt_at = 'infinity'
     where organization_id = p_org and agent_id = p_agent and status in ('received', 'retry_scheduled')
       and next_attempt_at is distinct from 'infinity'::timestamptz;
  else
    update public.agent_runs set next_attempt_at = now()
     where organization_id = p_org and agent_id = p_agent and status in ('received', 'retry_scheduled')
       and next_attempt_at = 'infinity'::timestamptz;
  end if;
  get diagnostics n = row_count;
  return jsonb_build_object('agent_id', p_agent, 'paused', p_paused, case when p_paused then 'held_runs' else 'released_runs' end, n);
end;
$$;

-- Runs of a paused agent are held, whether they are created now or rescheduled by a retry.
create or replace function private.agent_runs_hold_if_paused()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('received', 'retry_scheduled') and private.agent_paused(new.organization_id, new.agent_id) then
    new.next_attempt_at := 'infinity';
  end if;
  return new;
end;
$$;
create trigger agent_runs_hold_if_paused before insert or update of status, next_attempt_at on public.agent_runs
  for each row execute function private.agent_runs_hold_if_paused();

create or replace function private.voice_calls_refuse_if_paused()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.agent_paused(new.organization_id, 'voice_calling_agent') then
    perform private.fail('AGENT_PAUSED', 'AI calling is paused for this agency');
  end if;
  return new;
end;
$$;
create trigger voice_calls_refuse_if_paused before insert on public.voice_calls
  for each row execute function private.voice_calls_refuse_if_paused();

-- Same as 0008, plus: events for an organization whose consumer agent is paused stay pending.
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
      and not exists (select 1 from public.agent_controls c where c.organization_id = e.organization_id and c.agent_id = p_consumer and c.paused)
    order by e.created_at
    limit least(greatest(p_limit, 1), 100)
    for update skip locked)
  returning o.*;
end;
$$;

-- Which agent owns each user-triggered AI feature (for the pause check).
create or replace function private.ai_feature_agent(p_feature text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_feature
    when 'appointment_assistant' then 'appointment_agent'
    when 'crm_enrichment' then 'crm_data_agent'
    when 'sales_recommendations' then 'sales_intelligence_agent'
    when 'sales_analyst' then 'sales_intelligence_agent'
  end;
$$;

-- Same as 0018, plus: refused with AGENT_PAUSED while the owning agent is paused for the organization.
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
  if private.agent_paused(p_org, private.ai_feature_agent(p_feature)) then
    perform private.fail('AGENT_PAUSED', 'This AI feature is paused for this agency');
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

-- ───────────────────────── pilot overview ─────────────────────────

-- Operational summary for one organization over [p_from, p_to). Counts come only from persisted records; anything the
-- system does not record (provider cost, staff time) is reported as unavailable, never as zero.
create or replace function public.pilot_overview(p_org uuid, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t timestamptz := coalesce(p_to, now());
  f timestamptz := coalesce(p_from, coalesce(p_to, now()) - interval '7 days');
  o public.organizations;
begin
  if p_org is null or not public.is_org_member(p_org) then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if not public.has_perm(p_org, 'logs.view') then perform private.fail('FORBIDDEN', 'The pilot overview needs operations access'); end if;
  if f >= t or t - f > interval '400 days' then perform private.fail('VALIDATION_ERROR', 'Invalid period (at most 400 days)'); end if;
  select * into o from public.organizations where id = p_org;

  return jsonb_build_object(
    'organization', jsonb_build_object('id', o.id, 'name', o.name, 'timezone', o.timezone,
      'outbound_paused', coalesce((o.settings ->> 'outbound_paused')::boolean, false)),
    'period', jsonb_build_object('from', f, 'to', t),
    'computed_at', now(),
    'controls', (
      select jsonb_agg(jsonb_build_object('agent_id', a.agent_id, 'paused', coalesce(c.paused, false), 'reason', c.reason, 'changed_at', c.changed_at) order by a.ord)
      from (values ('voice_calling_agent', 2), ('sales_qualification_agent', 3), ('property_matching_agent', 4), ('follow_up_agent', 5),
                   ('appointment_agent', 6), ('crm_data_agent', 7), ('sales_intelligence_agent', 8)) a(agent_id, ord)
      left join public.agent_controls c on c.organization_id = p_org and c.agent_id = a.agent_id),
    'settings', jsonb_build_object(
      'voice_enabled', coalesce((select vs.enabled from public.voice_settings vs where vs.organization_id = p_org), false),
      'follow_up_enabled', coalesce((select (s.rules ->> 'enabled')::boolean from public.follow_up_settings s where s.organization_id = p_org), true),
      'intake_extraction_enabled', coalesce((o.settings -> 'intake' ->> 'extraction_enabled')::boolean, true),
      'qualification_llm_enabled', coalesce((select (s.rules ->> 'llm_enabled')::boolean from public.qualification_settings s where s.organization_id = p_org), true)),
    'intake', jsonb_build_object(
      'leads_created', (select count(*) from public.leads l where l.organization_id = p_org and l.created_at >= f and l.created_at < t),
      'webhooks_processed', (select count(*) from public.webhook_events w where w.organization_id = p_org and w.received_at >= f and w.received_at < t and w.processing_status = 'processed'),
      'webhooks_rejected', (select coalesce(sum(w.attempt_count), 0) from public.webhook_events w where w.organization_id = p_org and w.received_at >= f and w.received_at < t and w.processing_status = 'rejected'),
      'by_source_kind', (select coalesce(jsonb_object_agg(k, n), '{}') from (select ar.source_kind k, count(*) n from public.agent_runs ar
         where ar.organization_id = p_org and ar.agent_id = 'lead_intake_agent' and ar.received_at >= f and ar.received_at < t group by 1) s),
      'open_duplicate_reviews', (select count(*) from public.review_items r where r.organization_id = p_org and r.status = 'open')),
    'agents', (select coalesce(jsonb_object_agg(s.agent_id, s.x), '{}') from (
      select ar.agent_id, jsonb_build_object(
        'runs', count(*),
        'succeeded', count(*) filter (where ar.status = 'succeeded'),
        'review_required', count(*) filter (where ar.status = 'review_required'),
        'invalid', count(*) filter (where ar.status = 'invalid'),
        'dead_letter', count(*) filter (where ar.status = 'dead_letter'),
        'waiting', count(*) filter (where ar.status in ('received', 'retry_scheduled') and ar.next_attempt_at is distinct from 'infinity'::timestamptz),
        'held', count(*) filter (where ar.status in ('received', 'retry_scheduled') and ar.next_attempt_at = 'infinity'::timestamptz),
        'retried', count(*) filter (where ar.attempt_count > 1),
        'p50_seconds', round((percentile_cont(0.5) within group (order by extract(epoch from ar.completed_at - ar.received_at)) filter (where ar.completed_at is not null))::numeric, 1),
        'p95_seconds', round((percentile_cont(0.95) within group (order by extract(epoch from ar.completed_at - ar.received_at)) filter (where ar.completed_at is not null))::numeric, 1),
        'last_succeeded_at', (select max(x.completed_at) from public.agent_runs x where x.organization_id = p_org and x.agent_id = ar.agent_id and x.status = 'succeeded')) x
      from public.agent_runs ar where ar.organization_id = p_org and ar.received_at >= f and ar.received_at < t group by ar.agent_id) s),
    'events', jsonb_build_object(
      'pending', (select count(*) from public.outbox_events e where e.organization_id = p_org and e.status in ('pending', 'processing')),
      'oldest_pending_seconds', (select round(extract(epoch from now() - min(e.created_at))) from public.outbox_events e where e.organization_id = p_org and e.status = 'pending'),
      'dead_letter', (select count(*) from public.outbox_events e where e.organization_id = p_org and e.status = 'dead_letter')),
    'qualification', (select jsonb_build_object(
        'results', count(*),
        'by_status', coalesce((select jsonb_object_agg(z.status, z.n) from (select q2.status, count(*) n from public.lead_qualifications q2
           where q2.organization_id = p_org and q2.created_at >= f and q2.created_at < t group by 1) z), '{}'),
        'review_pending', count(*) filter (where q.review_status = 'pending'),
        'approved', count(*) filter (where q.review_status = 'approved'),
        'corrected', count(*) filter (where q.review_status in ('rejected', 'overridden')),
        'ai_succeeded', count(*) filter (where q.analysis_status = 'succeeded'),
        'ai_failed', count(*) filter (where q.analysis_status = 'failed'),
        'ai_not_configured', count(*) filter (where q.analysis_status = 'not_configured'))
      from public.lead_qualifications q where q.organization_id = p_org and q.created_at >= f and q.created_at < t),
    'matching', (select jsonb_build_object(
        'recommendations', count(*),
        'accepted', count(*) filter (where m.status in ('shortlisted', 'shared', 'appointment_requested')),
        'rejected_by_staff', count(*) filter (where m.status = 'rejected'),
        'invalidated', count(*) filter (where m.status = 'invalidated'),
        'unverified_listing', count(*) filter (where m.availability <> 'verified'),
        'runs_without_matches', (select count(*) from public.property_match_runs r where r.organization_id = p_org and r.created_at >= f and r.created_at < t and r.status = 'no_matches'))
      from public.property_matches m where m.organization_id = p_org and m.created_at >= f and m.created_at < t),
    'follow_ups', (select jsonb_build_object(
        'created', count(*),
        'pending_approval', count(*) filter (where fu.status = 'pending_approval'),
        'approved', count(*) filter (where fu.status in ('approved', 'scheduled', 'processing')),
        'sent', count(*) filter (where fu.status in ('sent', 'delivered')),
        'delivered', count(*) filter (where fu.status = 'delivered'),
        'failed', count(*) filter (where fu.status = 'failed'),
        'suppressed', count(*) filter (where fu.status = 'suppressed'),
        'handed_off', count(*) filter (where fu.status = 'handed_off'),
        'edited_by_staff', count(*) filter (where fu.generated_by = 'human'),
        'ai_drafted', count(*) filter (where fu.generated_by = 'ai'))
      from public.follow_ups fu where fu.organization_id = p_org and fu.created_at >= f and fu.created_at < t),
    'appointments', (select jsonb_build_object(
        'created', count(*),
        'confirmed', count(*) filter (where a.confirmed_at is not null),
        'by_status', coalesce((select jsonb_object_agg(z.status, z.n) from (select a2.status, count(*) n from public.appointments a2
           where a2.organization_id = p_org and a2.created_at >= f and a2.created_at < t group by 1) z), '{}'))
      from public.appointments a where a.organization_id = p_org and a.created_at >= f and a.created_at < t),
    'data_quality', jsonb_build_object(
      'open_issues', (select coalesce(jsonb_object_agg(z.severity, z.n), '{}') from (select i.severity, count(*) n from public.data_quality_issues i
         where i.organization_id = p_org and i.status in ('open', 'reopened', 'under_review', 'proposed') group by 1) z),
      'duplicates_open', (select count(*) from public.duplicate_candidates d where d.organization_id = p_org and d.status = 'open'),
      'duplicates_merged', (select count(*) from public.duplicate_candidates d where d.organization_id = p_org and d.status = 'merged' and d.reviewed_at >= f and d.reviewed_at < t),
      'duplicates_rejected', (select count(*) from public.duplicate_candidates d where d.organization_id = p_org and d.status = 'rejected' and d.reviewed_at >= f and d.reviewed_at < t)),
    'voice', jsonb_build_object(
      'calls', (select count(*) from public.voice_calls v where v.organization_id = p_org and v.requested_at >= f and v.requested_at < t),
      'by_status', (select coalesce(jsonb_object_agg(z.status, z.n), '{}') from (select v.status, count(*) n from public.voice_calls v
         where v.organization_id = p_org and v.requested_at >= f and v.requested_at < t group by 1) z)),
    'ai_requests', (select coalesce(jsonb_object_agg(z.feature, z.x), '{}') from (
      select r.feature, jsonb_build_object('requests', count(*), 'ok', count(*) filter (where r.status = 'ok'),
        'failed', count(*) filter (where r.status in ('model_error', 'timeout', 'invalid_output', 'error')),
        'p50_ms', percentile_cont(0.5) within group (order by r.duration_ms) filter (where r.duration_ms is not null)) x
      from public.ai_requests r where r.organization_id = p_org and r.created_at >= f and r.created_at < t group by r.feature) z),
    'review_backlog', jsonb_build_object(
      'intake_duplicates', (select count(*) from public.review_items r where r.organization_id = p_org and r.status = 'open'),
      'qualifications', (select count(*) from public.lead_qualifications q where q.organization_id = p_org and q.review_status = 'pending'),
      'follow_ups', (select count(*) from public.follow_ups fu where fu.organization_id = p_org and fu.status = 'pending_approval'),
      'duplicate_candidates', (select count(*) from public.duplicate_candidates d where d.organization_id = p_org and d.status = 'open'),
      'data_quality_proposals', (select count(*) from public.data_quality_issues i where i.organization_id = p_org and i.status = 'proposed')),
    'unavailable', jsonb_build_array(
      jsonb_build_object('metric', 'ai_cost', 'reason', 'Token usage of user-triggered AI requests and model prices are not recorded; read the Anthropic console'),
      jsonb_build_object('metric', 'voice_cost', 'reason', 'No voice provider is configured'),
      jsonb_build_object('metric', 'messaging_cost', 'reason', 'No messaging provider is integrated'),
      jsonb_build_object('metric', 'staff_time_saved', 'reason', 'Not recorded by the system; collect with the agency (time study)'))
  );
end;
$$;

revoke execute on function public.agent_control_set(uuid, text, boolean, text), public.pilot_overview(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.agent_control_set(uuid, text, boolean, text), public.pilot_overview(uuid, timestamptz, timestamptz) to authenticated;
revoke execute on function private.agent_paused(uuid, text), private.ai_feature_agent(text), private.agent_runs_hold_if_paused(),
  private.voice_calls_refuse_if_paused() from public, anon, authenticated;
