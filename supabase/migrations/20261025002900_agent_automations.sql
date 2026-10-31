-- Agent automations and the AI call queue (additive).
-- Owners and admins (workflows.manage) schedule automations that run on their own at a local time on chosen weekdays.
-- They prepare work and never contact anyone themselves: a daily briefing notification, follow-up tasks for overdue
-- leads, follow-up message drafts (which go through the Follow-Up Agent's approval flow), and a queue of AI calls for new
-- leads. A queued call is placed only when a person with calls.place approves it in the app, through voice-calls, which
-- re-runs the full call policy (consent, calling hours, attempt limits, daily cap, kill switch).
-- pg_cron runs public.automations_tick() every 5 minutes where available (skipped in local PGlite tests).

create table public.agent_automations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 80),
  kind text not null check (kind in ('daily_briefing', 'overdue_follow_ups', 'call_new_leads', 'reengage_stale')),
  enabled boolean not null default true,
  run_at time not null default '09:00',
  days smallint[] not null default '{1,2,3,4,5}' check (days <@ '{0,1,2,3,4,5,6}'::smallint[] and cardinality(days) between 1 and 7),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_result jsonb,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agent_automations_due_idx on public.agent_automations (next_run_at) where enabled;
create index agent_automations_org_idx on public.agent_automations (organization_id);

create table public.agent_call_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  lead_id uuid not null references public.leads (id) on delete cascade,
  automation_id uuid references public.agent_automations (id) on delete set null,
  reason text not null check (char_length(reason) <= 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'expired')),
  call_id uuid,
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index agent_call_queue_one_pending on public.agent_call_queue (lead_id) where status = 'pending';
create index agent_call_queue_org_idx on public.agent_call_queue (organization_id, status, created_at desc);

alter table public.agent_automations enable row level security;
alter table public.agent_call_queue enable row level security;
create policy agent_automations_read on public.agent_automations for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy agent_call_queue_read on public.agent_call_queue for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
revoke all on public.agent_automations, public.agent_call_queue from anon, authenticated;
grant select on public.agent_automations, public.agent_call_queue to authenticated;

/** The next local run after `after`: run_at on one of `days` (0 = Sunday) in the agency's time zone. */
create or replace function private.automation_next_run(p_run_at time, p_days smallint[], p_tz text, p_after timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  d date := (p_after at time zone p_tz)::date;
  ts timestamptz;
begin
  for i in 0..7 loop
    ts := ((d + i) + p_run_at) at time zone p_tz;
    if extract(dow from d + i)::smallint = any (p_days) and ts > p_after then return ts; end if;
  end loop;
  return null;
end;
$$;

/** Settings for a kind, with defaults and bounds; unknown keys are dropped. */
create or replace function private.automation_settings(p_kind text, p jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'daily_briefing' then jsonb_build_object('audience', case when p ->> 'audience' = 'everyone' then 'everyone' else 'managers' end)
    when 'overdue_follow_ups' then jsonb_build_object('draft_messages', coalesce((p ->> 'draft_messages')::boolean, false),
      'max', least(greatest(coalesce((p ->> 'max')::int, 25), 1), 50))
    when 'call_new_leads' then jsonb_build_object('within_hours', least(greatest(coalesce((p ->> 'within_hours')::int, 24), 1), 168),
      'max', least(greatest(coalesce((p ->> 'max')::int, 20), 1), 50))
    when 'reengage_stale' then jsonb_build_object('stale_days', least(greatest(coalesce((p ->> 'stale_days')::int, 14), 7), 180),
      'max', least(greatest(coalesce((p ->> 'max')::int, 15), 1), 50))
  end;
$$;

/** Create or update an automation. Input: { id?, name, kind, enabled?, run_at 'HH:MM', days [0-6], settings? }. */
create or replace function public.automation_save(p_org uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(p_input ->> 'id', '')::uuid;
  v_kind text := p_input ->> 'kind';
  v_name text := trim(coalesce(p_input ->> 'name', ''));
  v_time time;
  v_days smallint[];
  v_tz text;
  a public.agent_automations;
begin
  if not public.has_perm(p_org, 'workflows.manage') then perform private.fail('FORBIDDEN', 'Only owners and admins can manage automations'); end if;
  if v_kind not in ('daily_briefing', 'overdue_follow_ups', 'call_new_leads', 'reengage_stale') then perform private.fail('VALIDATION_ERROR', 'Unknown automation type'); end if;
  if char_length(v_name) not between 1 and 80 then perform private.fail('VALIDATION_ERROR', 'Give the automation a name'); end if;
  if coalesce(p_input ->> 'run_at', '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then perform private.fail('VALIDATION_ERROR', 'Time must be HH:MM'); end if;
  v_time := (p_input ->> 'run_at')::time;
  select coalesce(array_agg(distinct x::smallint order by x::smallint), '{}') into v_days from jsonb_array_elements_text(coalesce(p_input -> 'days', '[]')) x where x ~ '^[0-6]$';
  if cardinality(v_days) = 0 then perform private.fail('VALIDATION_ERROR', 'Pick at least one day'); end if;
  select timezone into v_tz from public.organizations where id = p_org;

  if v_id is null then
    insert into public.agent_automations (organization_id, name, kind, enabled, run_at, days, settings, created_by, next_run_at)
    values (p_org, v_name, v_kind, coalesce((p_input ->> 'enabled')::boolean, true), v_time, v_days,
      private.automation_settings(v_kind, coalesce(p_input -> 'settings', '{}')), auth.uid(), private.automation_next_run(v_time, v_days, v_tz, now()))
    returning * into a;
  else
    update public.agent_automations set name = v_name, kind = v_kind, enabled = coalesce((p_input ->> 'enabled')::boolean, enabled), run_at = v_time, days = v_days,
      settings = private.automation_settings(v_kind, coalesce(p_input -> 'settings', settings)), next_run_at = private.automation_next_run(v_time, v_days, v_tz, now()), updated_at = now()
    where id = v_id and organization_id = p_org
    returning * into a;
    if a.id is null then perform private.fail('NOT_FOUND', 'Automation not found'); end if;
  end if;
  perform private.write_audit(p_org, 'automation.saved', 'agent_automations', a.id, jsonb_build_object('kind', a.kind, 'enabled', a.enabled, 'run_at', a.run_at, 'days', a.days));
  return to_jsonb(a);
end;
$$;

create or replace function public.automation_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.agent_automations;
begin
  select * into a from public.agent_automations where id = p_id;
  if a.id is null or not public.has_perm(a.organization_id, 'workflows.manage') then perform private.fail('NOT_FOUND', 'Automation not found'); end if;
  delete from public.agent_automations where id = p_id;
  perform private.write_audit(a.organization_id, 'automation.deleted', 'agent_automations', a.id, jsonb_build_object('kind', a.kind, 'name', a.name));
end;
$$;

/** Does one automation's work now. Prepares work only: notifications, tasks, message drafts for approval, queued calls. */
create or replace function private.automation_run(a public.agent_automations)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.organizations;
  l record;
  n_tasks int := 0;
  n_drafts int := 0;
  n_queued int := 0;
  n_skipped int := 0;
  stamp text;
  p jsonb;
  body text;
  ok boolean;
  cnt jsonb;
  m record;
begin
  select * into o from public.organizations where id = a.organization_id;
  stamp := to_char(now() at time zone o.timezone, 'YYYY-MM-DD');

  if a.kind = 'daily_briefing' then
    select jsonb_build_object(
      'new_24h', count(*) filter (where l2.created_at >= now() - interval '24 hours'),
      'overdue', count(*) filter (where l2.next_follow_up_at < now() and l2.status not in ('won', 'lost')),
      'uncontacted', count(*) filter (where l2.first_response_at is null and l2.status not in ('won', 'lost')),
      'hot', count(*) filter (where l2.lead_score >= 70 and l2.status not in ('won', 'lost')))
      into cnt from public.leads l2 where l2.organization_id = a.organization_id and l2.archived_at is null;
    cnt := cnt || jsonb_build_object(
      'tasks_overdue', (select count(*) from public.tasks t where t.organization_id = a.organization_id and t.status in ('open', 'in_progress') and t.due_at < now()),
      'showings_today', (select count(*) from public.appointments ap where ap.organization_id = a.organization_id and ap.status not in ('cancelled', 'no_show')
                         and (ap.starts_at at time zone o.timezone)::date = (now() at time zone o.timezone)::date),
      'calls_waiting', (select count(*) from public.agent_call_queue q where q.organization_id = a.organization_id and q.status = 'pending'));
    body := format('%s new leads in the last 24 h · %s hot · %s overdue follow-ups · %s never contacted · %s overdue tasks · %s showings today%s',
      cnt ->> 'new_24h', cnt ->> 'hot', cnt ->> 'overdue', cnt ->> 'uncontacted', cnt ->> 'tasks_overdue', cnt ->> 'showings_today',
      case when (cnt ->> 'calls_waiting')::int > 0 then format(' · %s AI calls waiting for approval', cnt ->> 'calls_waiting') else '' end);
    for m in select mm.user_id from public.organization_memberships mm where mm.organization_id = a.organization_id and mm.status = 'active'
               and (a.settings ->> 'audience' = 'everyone' or mm.role in ('owner', 'admin', 'manager')) loop
      perform private.notify(a.organization_id, m.user_id, 'system', 'Daily briefing', body, 'dashboard', 'agent_automations', a.id, 'briefing:' || a.id || ':' || stamp);
      n_tasks := n_tasks + 1;
    end loop;
    return jsonb_build_object('kind', a.kind, 'notified', n_tasks, 'summary', body) || cnt;

  elsif a.kind = 'overdue_follow_ups' then
    for l in select ld.id, ld.assigned_to, coalesce(c.display_name, ld.title) name, ld.next_follow_up_at from public.leads ld left join public.contacts c on c.id = ld.contact_id
             where ld.organization_id = a.organization_id and ld.archived_at is null and ld.status not in ('won', 'lost') and ld.next_follow_up_at < now()
             order by ld.lead_score desc nulls last, ld.next_follow_up_at limit (a.settings ->> 'max')::int loop
      if not exists (select 1 from public.tasks t where t.related_lead_id = l.id and t.status in ('open', 'in_progress') and t.source = 'workflow' and t.title like 'Follow up with %') then
        insert into public.tasks (organization_id, title, description, status, priority, due_at, assigned_to, related_lead_id, source)
        values (a.organization_id, left('Follow up with ' || l.name, 200), 'Follow-up was due ' || to_char(l.next_follow_up_at at time zone o.timezone, 'Mon DD, HH12:MI am') || '. Created by the “' || a.name || '” automation.',
          'open', 'high', now() + interval '2 hours', case when private.is_active_member(a.organization_id, l.assigned_to) then l.assigned_to end, l.id, 'workflow');
        n_tasks := n_tasks + 1;
      end if;
      if (a.settings ->> 'draft_messages')::boolean then
        if private.fu_enqueue(a.organization_id, l.id, 'follow_up.requested', 'auto_' || replace(a.id::text, '-', '') || '_' || replace(l.id::text, '-', '') || '_' || replace(stamp, '-', ''),
             'manual', null, jsonb_build_object('purpose', 'clarify_requirements', 'automation_id', a.id)) is not null then
          n_drafts := n_drafts + 1;
        end if;
      end if;
    end loop;
    return jsonb_build_object('kind', a.kind, 'tasks_created', n_tasks, 'drafts_requested', n_drafts);

  elsif a.kind = 'call_new_leads' then
    for l in select ld.id, ld.source from public.leads ld
             where ld.organization_id = a.organization_id and ld.archived_at is null and ld.status not in ('won', 'lost')
               and ld.first_response_at is null and ld.created_at >= now() - make_interval(hours => (a.settings ->> 'within_hours')::int)
               and not exists (select 1 from public.agent_call_queue q where q.lead_id = ld.id and (q.status = 'pending' or q.created_at > now() - interval '24 hours'))
               and not exists (select 1 from public.voice_calls v where v.lead_id = ld.id and v.requested_at > now() - interval '24 hours')
             order by ld.created_at desc limit (a.settings ->> 'max')::int loop
      -- Queue only leads the call policy would let us call on consent and number; time-of-day checks run at approval.
      p := private.voice_policy(l.id);
      select bool_and((x ->> 'ok')::boolean) into ok from jsonb_array_elements(p -> 'checks') x where x ->> 'key' in ('consent', 'phone_valid', 'not_suppressed', 'lead_open');
      if coalesce(ok, false) then
        insert into public.agent_call_queue (organization_id, lead_id, automation_id, reason)
        values (a.organization_id, l.id, a.id, left('New lead from ' || coalesce(l.source, 'unknown source') || ', not contacted yet', 300))
        on conflict do nothing;
        n_queued := n_queued + 1;
      else
        n_skipped := n_skipped + 1;
      end if;
    end loop;
    if n_queued > 0 then
      for m in select mm.user_id from public.organization_memberships mm where mm.organization_id = a.organization_id and mm.status = 'active' and mm.role in ('owner', 'admin', 'manager') loop
        perform private.notify(a.organization_id, m.user_id, 'approval', format('%s AI calls ready to approve', n_queued),
          'New leads with AI-call consent are queued. Nothing is dialed until someone approves.', 'automations', 'agent_automations', a.id, 'callq:' || a.id || ':' || stamp || ':' || n_queued);
      end loop;
    end if;
    return jsonb_build_object('kind', a.kind, 'queued', n_queued, 'skipped_no_consent', n_skipped);

  elsif a.kind = 'reengage_stale' then
    for l in select ld.id from public.leads ld
             where ld.organization_id = a.organization_id and ld.archived_at is null and ld.status not in ('won', 'lost')
               and coalesce(ld.last_contact_at, ld.created_at) < now() - make_interval(days => (a.settings ->> 'stale_days')::int)
             order by ld.lead_score desc nulls last limit (a.settings ->> 'max')::int loop
      if private.fu_enqueue(a.organization_id, l.id, 'follow_up.requested', 'auto_' || replace(a.id::text, '-', '') || '_' || replace(l.id::text, '-', '') || '_' || replace(stamp, '-', ''),
           'manual', null, jsonb_build_object('purpose', 're_engagement', 'automation_id', a.id)) is not null then
        n_drafts := n_drafts + 1;
      end if;
    end loop;
    return jsonb_build_object('kind', a.kind, 'drafts_requested', n_drafts);
  end if;
  return jsonb_build_object('kind', a.kind, 'error', 'unknown kind');
end;
$$;

/** Run an automation now (owners and admins). */
create or replace function public.automation_run_now(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.agent_automations;
  r jsonb;
begin
  select * into a from public.agent_automations where id = p_id;
  if a.id is null or not public.has_perm(a.organization_id, 'workflows.manage') then perform private.fail('NOT_FOUND', 'Automation not found'); end if;
  r := private.automation_run(a);
  update public.agent_automations set last_run_at = now(), last_result = r || jsonb_build_object('manual', true) where id = a.id;
  perform private.write_audit(a.organization_id, 'automation.run', 'agent_automations', a.id, r);
  return r;
end;
$$;

/** Scheduler entry point (pg_cron): runs due automations and expires stale queued calls. */
create or replace function public.automations_tick(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.agent_automations;
  r jsonb;
  ran int := 0;
  tz text;
  expired int;
begin
  for a in select * from public.agent_automations where enabled and next_run_at <= now() order by next_run_at for update skip locked limit greatest(1, least(p_limit, 100)) loop
    begin
      r := private.automation_run(a);
    exception when others then
      r := jsonb_build_object('kind', a.kind, 'error', left(sqlerrm, 300));
    end;
    select timezone into tz from public.organizations where id = a.organization_id;
    update public.agent_automations set last_run_at = now(), last_result = r, next_run_at = private.automation_next_run(a.run_at, a.days, tz, now()) where id = a.id;
    ran := ran + 1;
  end loop;
  update public.agent_call_queue set status = 'expired' where status = 'pending' and created_at < now() - interval '3 days';
  get diagnostics expired = row_count;
  return jsonb_build_object('ran', ran, 'expired_calls', expired);
end;
$$;

/** Record a decision on a queued call. Approve after the call was placed (voice-calls returned a call id); decline anytime. */
create or replace function public.call_queue_decide(p_item uuid, p_decision text, p_call uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.agent_call_queue;
begin
  select * into q from public.agent_call_queue where id = p_item for update;
  if q.id is null or not public.has_perm(q.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Queued call not found'); end if;
  if not public.has_perm(q.organization_id, 'calls.place') then perform private.fail('FORBIDDEN', 'You cannot approve calls'); end if;
  if q.status <> 'pending' then perform private.fail('CONFLICT', 'This call was already decided'); end if;
  if p_decision not in ('approved', 'declined') then perform private.fail('VALIDATION_ERROR', 'Invalid decision'); end if;
  if p_decision = 'approved' and (p_call is null or not exists (select 1 from public.voice_calls v where v.id = p_call and v.lead_id = q.lead_id)) then
    perform private.fail('VALIDATION_ERROR', 'Approve a queued call by placing it first');
  end if;
  update public.agent_call_queue set status = p_decision, call_id = p_call, decided_by = auth.uid(), decided_at = now() where id = q.id returning * into q;
  perform private.write_audit(q.organization_id, 'call_queue.' || p_decision, 'agent_call_queue', q.id, jsonb_build_object('lead', q.lead_id, 'call', p_call));
  return to_jsonb(q);
end;
$$;

/** For the workspace assistant (SECURITY INVOKER): automations with their schedule and last result, and calls waiting. */
create or replace function public.assistant_automations(p_org uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  perform private.assistant_member(p_org);
  return jsonb_build_object(
    'automations', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'enabled', a.enabled, 'run_at', to_char(a.run_at, 'HH24:MI'),
        'days', a.days, 'settings', a.settings, 'next_run_at', a.next_run_at, 'last_run_at', a.last_run_at, 'last_result', a.last_result) order by a.run_at)
      from public.agent_automations a where a.organization_id = p_org), '[]'::jsonb),
    'calls_waiting_for_approval', (select count(*) from public.agent_call_queue q where q.organization_id = p_org and q.status = 'pending'));
end;
$$;

revoke execute on function public.assistant_automations(uuid) from public, anon;
grant execute on function public.assistant_automations(uuid) to authenticated;

revoke execute on function public.automation_save(uuid, jsonb), public.automation_delete(uuid), public.automation_run_now(uuid), public.call_queue_decide(uuid, text, uuid) from public, anon;
grant execute on function public.automation_save(uuid, jsonb), public.automation_delete(uuid), public.automation_run_now(uuid), public.call_queue_decide(uuid, text, uuid) to authenticated;
revoke execute on function public.automations_tick(integer) from public, anon, authenticated;
revoke execute on function private.automation_run(public.agent_automations), private.automation_next_run(time, smallint[], text, timestamptz), private.automation_settings(text, jsonb) from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if not exists (select 1 from cron.job where jobname = 'agent-automations') then
      perform cron.schedule('agent-automations', '*/5 * * * *', 'select public.automations_tick(20)');
    end if;
  end if;
end;
$$;
