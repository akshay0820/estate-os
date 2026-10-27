-- Fixes from the 2026-10-27 full test (additive: replaces two functions with the same signatures, adds one trigger).
-- 1. Cancelling a lead's only open viewing moves the lead from "visit_scheduled" back to its status before the booking
--    (from lead_status_history; "contacted" when unknown). Completed and rescheduled visits are unchanged.
-- 2. dashboard_metrics: "Viewings booked" and the viewings series no longer count cancelled viewings, matching "Lead -> visit".
-- 3. A contact follows its leads: it takes the lead owner when it has none, becomes "active" when a lead is worked and
--    "client" when one is won. It never overrides an existing owner or a do-not-contact / inactive state.
-- 4. pilot_overview: the "not measured" note for AI cost no longer says token usage is unrecorded (0020 records it).

create or replace function private.appointments_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.add_activity(new.organization_id, new.lead_id, new.contact_id, null, 'appointment', new.title || ' booked',
      to_char(new.starts_at at time zone new.timezone, 'Dy DD Mon, HH12:MI am'));
    update public.leads set status = 'visit_scheduled'
    where id = new.lead_id and new.appointment_type = 'viewing' and status in ('new', 'attempting', 'contacted', 'qualified', 'matching');
    if new.assigned_to is distinct from auth.uid() then
      perform private.notify(new.organization_id, new.assigned_to, 'appointment', 'Appointment booked: ' || new.title,
        to_char(new.starts_at at time zone new.timezone, 'Dy DD Mon, HH12:MI am'), 'appointments', 'appointment', new.id, 'appt_booked:' || new.id);
    end if;
    return null;
  end if;
  if new.status is distinct from old.status then
    perform private.add_activity(new.organization_id, new.lead_id, new.contact_id, null, 'appointment',
      new.title || ' — ' || replace(new.status, '_', ' '), coalesce(new.cancellation_reason, new.feedback));
    if new.status = 'completed' then
      update public.leads set status = 'visit_completed' where id = new.lead_id and status = 'visit_scheduled';
    end if;
    -- A cancelled viewing that leaves the lead with no other open viewing puts the lead back where it was before the booking.
    if new.status = 'cancelled' and new.appointment_type = 'viewing' and new.lead_id is not null
       and not exists (select 1 from public.appointments x where x.lead_id = new.lead_id and x.id <> new.id and x.appointment_type = 'viewing'
                       and x.status in ('requested', 'pending', 'confirmed', 'reschedule_requested')) then
      update public.leads l set status = coalesce((
          select h.from_status from public.lead_status_history h
          where h.lead_id = new.lead_id and h.to_status = 'visit_scheduled'
            and h.from_status in ('new', 'attempting', 'contacted', 'qualified', 'matching')
          order by h.created_at desc limit 1), 'contacted')
      where l.id = new.lead_id and l.status = 'visit_scheduled';
    end if;
    if new.status = 'cancelled' and new.assigned_to is distinct from auth.uid() then
      perform private.notify(new.organization_id, new.assigned_to, 'appointment', 'Appointment cancelled: ' || new.title,
        new.cancellation_reason, 'appointments', 'appointment', new.id, 'appt_cancelled:' || new.id);
    end if;
  elsif new.starts_at <> old.starts_at then
    perform private.add_activity(new.organization_id, new.lead_id, new.contact_id, null, 'appointment', new.title || ' rescheduled',
      to_char(new.starts_at at time zone new.timezone, 'Dy DD Mon, HH12:MI am'));
  end if;
  return null;
end;
$$;

create or replace function public.dashboard_metrics(p_org uuid, p_from timestamptz, p_to timestamptz, p_bucket text default 'day')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  tz text;
  sla int;
  span interval := p_to - p_from;
  pf timestamptz := p_from - (p_to - p_from);
  step interval;
  result jsonb;
  qual text[] := array['qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won'];
begin
  if not public.has_perm(p_org, 'leads.view') then perform private.fail('FORBIDDEN', 'Not allowed'); end if;
  if p_to <= p_from or span > interval '400 days' then perform private.fail('VALIDATION_ERROR', 'Invalid date range'); end if;
  if p_bucket not in ('day', 'week', 'month') then perform private.fail('VALIDATION_ERROR', 'Invalid bucket'); end if;
  select timezone, (settings ->> 'sla_minutes')::int into tz, sla from public.organizations where id = p_org;
  step := ('1 ' || p_bucket)::interval;

  with
  cur as (select * from public.leads where organization_id = p_org and archived_at is null and created_at >= p_from and created_at < p_to),
  prev as (select * from public.leads where organization_id = p_org and archived_at is null and created_at >= pf and created_at < p_from),
  appt_leads as (select distinct lead_id from public.appointments where organization_id = p_org and lead_id is not null and status <> 'cancelled'),
  buckets as (
    select gs as b_start, gs + step as b_end
    from generate_series(date_trunc(p_bucket, p_from at time zone tz) at time zone tz, p_to - interval '1 second', step) gs
  ),
  series as (
    select b.b_start,
      (select count(*) from cur where created_at >= b.b_start and created_at < b.b_end) as leads,
      (select count(*) from cur where created_at >= b.b_start and created_at < b.b_end and status = any (qual)) as qualified,
      (select count(*) from prev where created_at >= b.b_start - span and created_at < b.b_end - span) as prev_leads,
      (select count(*) from public.appointments a where a.organization_id = p_org and a.appointment_type = 'viewing' and a.status <> 'cancelled' and a.created_at >= b.b_start and a.created_at < b.b_end) as viewings,
      (select coalesce(sum(expected_value), 0) from public.deals d where d.organization_id = p_org and d.stage = 'won' and d.closed_at >= b.b_start and d.closed_at < b.b_end) as won_value
    from buckets b
  ),
  resp as (select extract(epoch from (first_response_at - created_at)) / 60 as minutes from cur where first_response_at is not null),
  prev_resp as (select extract(epoch from (first_response_at - created_at)) / 60 as minutes from prev where first_response_at is not null)
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'bucket', p_bucket, 'timezone', tz),
    'kpis', jsonb_build_object(
      'new_leads', jsonb_build_object('current', (select count(*) from cur), 'previous', (select count(*) from prev)),
      'qualified', jsonb_build_object('current', (select count(*) from cur where status = any (qual)), 'previous', (select count(*) from prev where status = any (qual))),
      'viewings_booked', jsonb_build_object(
        'current', (select count(*) from public.appointments where organization_id = p_org and appointment_type = 'viewing' and status <> 'cancelled' and created_at >= p_from and created_at < p_to),
        'previous', (select count(*) from public.appointments where organization_id = p_org and appointment_type = 'viewing' and status <> 'cancelled' and created_at >= pf and created_at < p_from)),
      'lead_to_visit', jsonb_build_object(
        'current', coalesce((select count(*) filter (where id in (select lead_id from appt_leads))::numeric / nullif(count(*), 0) from cur), 0),
        'previous', coalesce((select count(*) filter (where id in (select lead_id from appt_leads))::numeric / nullif(count(*), 0) from prev), 0)),
      'active_deals', jsonb_build_object(
        'current', (select count(*) from public.deals where organization_id = p_org and stage not in ('won', 'lost')),
        'pipeline_value', (select coalesce(sum(expected_value), 0) from public.deals where organization_id = p_org and stage not in ('won', 'lost')),
        'opened', (select count(*) from public.deals where organization_id = p_org and created_at >= p_from and created_at < p_to),
        'opened_previous', (select count(*) from public.deals where organization_id = p_org and created_at >= pf and created_at < p_from)),
      'won_value', jsonb_build_object(
        'current', (select coalesce(sum(expected_value), 0) from public.deals where organization_id = p_org and stage = 'won' and closed_at >= p_from and closed_at < p_to),
        'previous', (select coalesce(sum(expected_value), 0) from public.deals where organization_id = p_org and stage = 'won' and closed_at >= pf and closed_at < p_from)),
      'active_properties', (select count(*) from public.properties where organization_id = p_org and status = 'active'),
      'tasks_completed', (select count(*) from public.tasks where organization_id = p_org and completed_at >= p_from and completed_at < p_to)
    ),
    'series', coalesce((select jsonb_agg(jsonb_build_object('start', b_start, 'leads', leads, 'qualified', qualified, 'previous_leads', prev_leads, 'viewings', viewings, 'won_value', won_value) order by b_start) from series), '[]'),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'leads', n, 'qualified', q) order by n desc)
                from (select source, count(*) n, count(*) filter (where status = any (qual)) q from cur group by source) s), '[]'),
    'funnel', jsonb_build_array(
      jsonb_build_object('label', 'New enquiries', 'n', (select count(*) from cur)),
      jsonb_build_object('label', 'Contacted', 'n', (select count(*) from cur where first_response_at is not null or status not in ('new', 'attempting'))),
      jsonb_build_object('label', 'Qualified', 'n', (select count(*) from cur where status = any (qual))),
      jsonb_build_object('label', 'Visit booked', 'n', (select count(*) from cur where id in (select lead_id from appt_leads))),
      jsonb_build_object('label', 'Negotiation', 'n', (select count(*) from cur where status in ('negotiation', 'won'))),
      jsonb_build_object('label', 'Won', 'n', (select count(*) from cur where status = 'won'))
    ),
    -- Weekday (Mon=1..Sun=7) × two-hour block starting 08:00, in org time.
    'arrivals', coalesce((select jsonb_agg(jsonb_build_object('dow', dow, 'block', blk, 'n', n))
                  from (select extract(isodow from created_at at time zone tz)::int dow,
                               floor((extract(hour from created_at at time zone tz) - 8) / 2)::int blk, count(*) n
                        from cur where extract(hour from created_at at time zone tz) between 8 and 23 group by 1, 2) h), '[]'),
    'response', jsonb_build_object(
      'median_minutes', (select percentile_cont(0.5) within group (order by minutes) from resp),
      'previous_median_minutes', (select percentile_cont(0.5) within group (order by minutes) from prev_resp),
      'within_sla', coalesce((select count(*) filter (where minutes <= sla)::numeric / nullif(count(*), 0) from resp), 0),
      'sla_minutes', sla,
      'awaiting_first_contact', (select count(*) from cur where first_response_at is null)
    )
  ) into result;
  return result;
end;
$$;

create or replace function private.contact_follow_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.contact_id is null then return null; end if;
  if new.assigned_to is not null and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) then
    update public.contacts set assigned_to = new.assigned_to where id = new.contact_id and assigned_to is null;
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'won' then
      update public.contacts set lifecycle_status = 'client' where id = new.contact_id and lifecycle_status in ('new', 'active', 'nurture');
    elsif new.status not in ('new', 'lost', 'nurture') then
      update public.contacts set lifecycle_status = 'active' where id = new.contact_id and lifecycle_status = 'new';
    end if;
  end if;
  return null;
end;
$$;
create trigger leads_contact_follow after insert or update of assigned_to, status on public.leads
  for each row execute function private.contact_follow_lead();
revoke execute on function private.contact_follow_lead() from public, anon, authenticated;

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
      jsonb_build_object('metric', 'ai_cost', 'reason', 'Cost in currency is not stored. Tokens per agent are recorded (AI usage summary); multiply them by the provider''s published price per model'),
      jsonb_build_object('metric', 'voice_cost', 'reason', 'No voice provider is configured'),
      jsonb_build_object('metric', 'messaging_cost', 'reason', 'No messaging provider is integrated'),
      jsonb_build_object('metric', 'staff_time_saved', 'reason', 'Not recorded by the system; collect with the agency (time study)'))
  );
end;
$$;
