-- Estate OS · 0015 · Agent 06 — AI Appointment Agent (appointment_agent)
-- Builds on public.appointments (types, statuses, business-hours validation, per-person lock) with: staff working hours,
-- closures / time off / property restrictions / external busy time, buffers, property double-booking prevention, a state
-- machine and version, booking reference, idempotent booking RPCs, deterministic availability, history, events, a calendar
-- sync boundary (no provider adapter exists in this product), and Agent 05 confirmations / reminders tied to the version.
-- Additive only. Agent 05: fu_create is replaced (appointment messages dedupe per appointment and version) and four functions
-- (fu_execute, fu_render, fu_content_problem, fu_policy) are wrapped by renaming the originals to *_base.

-- ───────────────────────── tables ─────────────────────────

create table public.scheduling_settings (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  rules jsonb not null default '{}',
  version integer not null default 1,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger scheduling_settings_updated_at before update on public.scheduling_settings for each row execute function public.set_updated_at();
create trigger scheduling_settings_audit after insert or update on public.scheduling_settings for each row execute function private.audit_row();

-- Weekly hours per person, in the org time zone. A person with no rows works the org business hours.
create table public.staff_working_hours (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  constraint staff_working_hours_order check (start_time < end_time),
  unique (organization_id, user_id, weekday, start_time)
);
create index staff_working_hours_user_idx on public.staff_working_hours (organization_id, user_id, weekday);
create trigger staff_working_hours_audit after insert or update or delete on public.staff_working_hours for each row execute function private.audit_row();

-- Time that cannot be booked: org closures, a person's time off, busy time imported from their calendar, property restrictions.
create table public.availability_blocks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null check (kind in ('closure', 'time_off', 'external_busy', 'property_unavailable')),
  user_id uuid references public.profiles (id) on delete cascade,
  property_id uuid references public.properties (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text check (char_length(reason) <= 200),
  source text not null default 'user' check (source in ('user', 'calendar')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint availability_blocks_order check (starts_at < ends_at),
  constraint availability_blocks_target check (
    (kind = 'closure' and user_id is null and property_id is null) or (kind in ('time_off', 'external_busy') and user_id is not null and property_id is null)
    or (kind = 'property_unavailable' and property_id is not null and user_id is null))
);
create index availability_blocks_lookup_idx on public.availability_blocks (organization_id, kind, starts_at, ends_at);
create index availability_blocks_user_idx on public.availability_blocks (user_id, starts_at) where user_id is not null;
create index availability_blocks_property_idx on public.availability_blocks (property_id, starts_at) where property_id is not null;

-- Freshness of each person's external busy data (only meaningful when a calendar is connected).
create table public.calendar_sync_state (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null check (char_length(provider) <= 60),
  status text not null check (status in ('ok', 'error', 'revoked')),
  last_synced_at timestamptz,
  last_error text check (char_length(last_error) <= 300),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

alter table public.appointments
  add column booking_reference text,
  add column version integer not null default 1,
  add column idempotency_key text check (idempotency_key ~ '^[A-Za-z0-9_:-]{8,120}$'),
  add column correlation_id uuid,
  add column pending_reason text check (pending_reason in ('needs_staff_confirmation', 'calendar_unverified', 'awaiting_calendar_sync')),
  add column change_reason text check (char_length(change_reason) <= 200),
  add column confirmed_at timestamptz,
  add column confirmed_by uuid references public.profiles (id) on delete set null,
  add column calendar_sync_status text not null default 'not_required' check (calendar_sync_status in ('not_required', 'pending', 'processing', 'synced', 'failed')),
  add column calendar_provider text check (char_length(calendar_provider) <= 60),
  add column external_event_id text check (char_length(external_event_id) <= 300),
  add column calendar_synced_version integer,
  add column calendar_sync_attempts integer not null default 0,
  add column calendar_sync_error text check (char_length(calendar_sync_error) <= 300),
  add column calendar_lease_until timestamptz;
-- Existing rows get a reference (no other change).
update public.appointments set booking_reference = 'APT-' || upper(substr(md5(id::text), 1, 8)) where booking_reference is null;
create unique index appointments_reference_uniq on public.appointments (organization_id, booking_reference);
create unique index appointments_idempotency_uniq on public.appointments (organization_id, idempotency_key) where idempotency_key is not null;
create index appointments_property_starts_idx on public.appointments (property_id, starts_at) where property_id is not null;
create index appointments_sync_idx on public.appointments (calendar_sync_status) where calendar_sync_status in ('pending', 'processing');

create table public.appointment_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  version integer not null,
  action text not null check (action in ('created', 'status', 'rescheduled', 'reassigned')),
  from_status text,
  to_status text,
  from_starts_at timestamptz,
  to_starts_at timestamptz,
  from_assigned_to uuid,
  to_assigned_to uuid,
  actor uuid references public.profiles (id) on delete set null,
  reason text check (char_length(reason) <= 300),
  created_at timestamptz not null default now()
);
create index appointment_history_appt_idx on public.appointment_history (appointment_id, version);

alter table public.scheduling_settings enable row level security;
alter table public.staff_working_hours enable row level security;
alter table public.availability_blocks enable row level security;
alter table public.calendar_sync_state enable row level security;
alter table public.appointment_history enable row level security;
create policy scheduling_settings_read on public.scheduling_settings for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy staff_working_hours_read on public.staff_working_hours for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy availability_blocks_read on public.availability_blocks for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy calendar_sync_state_read on public.calendar_sync_state for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy appointment_history_read on public.appointment_history for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
revoke all on public.scheduling_settings, public.staff_working_hours, public.availability_blocks, public.calendar_sync_state, public.appointment_history from anon;
revoke insert, update, delete, truncate on public.scheduling_settings, public.staff_working_hours, public.availability_blocks, public.calendar_sync_state, public.appointment_history from authenticated;

-- Agent 05: appointment messages are follow-ups bound to an appointment version.
alter table public.follow_ups
  add column appointment_id uuid references public.appointments (id) on delete set null,
  add column appointment_version integer;
alter table public.follow_ups drop constraint follow_ups_purpose_check;
alter table public.follow_ups add constraint follow_ups_purpose_check check (purpose in ('share_property_recommendations', 'clarify_requirements', 'answer_call_questions',
  'callback_request', 're_engagement', 'appointment_confirmation', 'appointment_reminder', 'appointment_cancellation'));
create index follow_ups_appointment_idx on public.follow_ups (appointment_id) where appointment_id is not null;

-- ───────────────────────── rules & helpers ─────────────────────────

create or replace function private.ap_default_rules()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{
    "durations": {"viewing": 45, "consultation": 60, "valuation": 60, "follow_up": 30},
    "buffer_minutes": 15, "min_notice_minutes": 60, "horizon_days": 60, "slot_step_minutes": 30, "max_slots": 12,
    "require_calendar_sync": false, "calendar_freshness_minutes": 30,
    "reminder_hours_before": 24, "ai_bookings_need_confirmation": true
  }'::jsonb;
$$;

create or replace function private.ap_rules(org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.ap_default_rules() || coalesce(s.rules, '{}') || jsonb_build_object('version', coalesce(s.version, 0))
  from (select 1) x left join public.scheduling_settings s on s.organization_id = org;
$$;

create or replace function private.ap_calendar_provider(org uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select i.provider from public.integrations i where i.organization_id = org and i.integration_type = 'calendar' and i.status = 'connected' order by i.created_at limit 1;
$$;

-- With a calendar connected, a person's busy data must be fresh and healthy before their time is offered.
create or replace function private.ap_staff_verified(org uuid, p_user uuid, rules jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.calendar_sync_state s where s.organization_id = org and s.user_id = p_user and s.status = 'ok'
                 and s.last_synced_at > now() - make_interval(mins => coalesce((rules ->> 'calendar_freshness_minutes')::int, 30)));
$$;

-- Working windows for one person on one local date (org time zone). Postgres applies the zone's DST rules.
create or replace function private.ap_windows(org uuid, p_user uuid, d date)
returns table (ws timestamptz, we timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tz text;
  bh jsonb;
begin
  select o.timezone, o.settings -> 'business_hours' into tz, bh from public.organizations o where o.id = org;
  if p_user is not null and exists (select 1 from public.staff_working_hours h where h.organization_id = org and h.user_id = p_user) then
    return query select (d + h.start_time) at time zone tz, (d + h.end_time) at time zone tz
      from public.staff_working_hours h where h.organization_id = org and h.user_id = p_user and h.weekday = extract(dow from d)::int order by h.start_time;
  elsif coalesce(bh -> 'days', '[]') @> to_jsonb(extract(dow from d)::int) then
    return query select (d + make_interval(hours => (bh ->> 'start')::int)) at time zone tz, (d + make_interval(hours => (bh ->> 'end')::int)) at time zone tz;
  end if;
end;
$$;

create or replace function private.ap_in_hours(org uuid, p_user uuid, s timestamptz, e timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from private.ap_windows(org, p_user, (s at time zone (select o.timezone from public.organizations o where o.id = org))::date) w
                 where w.ws <= s and e <= w.we);
$$;

-- First reason the interval cannot be used, or null. Shared by availability, booking and the trigger.
create or replace function private.ap_conflict(org uuid, p_user uuid, p_property uuid, p_type text, s timestamptz, e timestamptz, p_exclude uuid, buffer_min int)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  buf interval := make_interval(mins => greatest(coalesce(buffer_min, 0), 0));
begin
  if exists (select 1 from public.availability_blocks b where b.organization_id = org and b.kind = 'closure' and b.starts_at < e and s < b.ends_at) then return 'CLOSED'; end if;
  if p_user is not null and exists (select 1 from public.availability_blocks b where b.organization_id = org and b.user_id = p_user and b.kind in ('time_off', 'external_busy')
                                      and b.starts_at < e and s < b.ends_at) then return 'STAFF_UNAVAILABLE'; end if;
  if p_property is not null and exists (select 1 from public.availability_blocks b where b.organization_id = org and b.property_id = p_property and b.kind = 'property_unavailable'
                                          and b.starts_at < e and s < b.ends_at) then return 'PROPERTY_UNAVAILABLE'; end if;
  if p_user is not null and exists (select 1 from public.appointments a where a.organization_id = org and a.assigned_to = p_user and a.id is distinct from p_exclude
                                      and a.status in ('requested', 'pending', 'confirmed', 'reschedule_requested') and a.starts_at < e + buf and s - buf < a.ends_at) then
    return 'APPOINTMENT_CONFLICT';
  end if;
  if p_type = 'viewing' and p_property is not null and exists (select 1 from public.appointments a where a.organization_id = org and a.property_id = p_property
        and a.appointment_type = 'viewing' and a.id is distinct from p_exclude and a.status in ('requested', 'pending', 'confirmed', 'reschedule_requested')
        and a.starts_at < e and s < a.ends_at) then
    return 'PROPERTY_BOOKED';
  end if;
  return null;
end;
$$;

create or replace function private.ap_conflict_message(code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case code
    when 'CLOSED' then 'The office is closed at that time'
    when 'STAFF_UNAVAILABLE' then 'This person is unavailable then (time off or calendar busy)'
    when 'PROPERTY_UNAVAILABLE' then 'The property is not available for viewings then'
    when 'APPOINTMENT_CONFLICT' then 'This person already has an appointment (including the buffer) at that time'
    when 'PROPERTY_BOOKED' then 'Another viewing of this property is booked then'
    else 'That time is not available' end;
$$;

-- ───────────────────────── lifecycle triggers ─────────────────────────

-- Runs after appointments_before (name order). State machine, version, reference, extra availability rules, calendar sync.
create or replace function private.ap_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  active text[] := array['requested', 'pending', 'confirmed', 'reschedule_requested'];
  allowed text[];
  rules jsonb := private.ap_rules(new.organization_id);
  code text;
  timing boolean;
  cal text := private.ap_calendar_provider(new.organization_id);
begin
  if tg_op = 'UPDATE' then
    if old.status in ('cancelled', 'completed', 'no_show') and (new.status is distinct from old.status or new.starts_at <> old.starts_at
         or new.ends_at <> old.ends_at or new.assigned_to is distinct from old.assigned_to) then
      perform private.fail('INVALID_TRANSITION', format('This appointment is closed (%s)', replace(old.status, '_', ' ')));
    end if;
    if new.status is distinct from old.status then
      allowed := case old.status
        when 'requested' then array['pending', 'confirmed', 'reschedule_requested', 'cancelled']
        when 'pending' then array['confirmed', 'reschedule_requested', 'cancelled']
        when 'confirmed' then array['completed', 'no_show', 'reschedule_requested', 'cancelled']
        when 'reschedule_requested' then array['pending', 'confirmed', 'cancelled'] else '{}' end;
      if not (new.status = any (allowed)) then
        perform private.fail('INVALID_TRANSITION', format('Cannot change an appointment from %s to %s', replace(old.status, '_', ' '), replace(new.status, '_', ' ')));
      end if;
    end if;
    new.booking_reference := old.booking_reference;
    new.idempotency_key := old.idempotency_key;
    new.correlation_id := old.correlation_id;
    -- A change reason belongs to the update that set it.
    if new.change_reason is not distinct from old.change_reason then new.change_reason := null; end if;
  else
    new.booking_reference := 'APT-' || upper(substr(md5(new.id::text || clock_timestamp()::text), 1, 8));
    new.correlation_id := coalesce(new.correlation_id, gen_random_uuid());
    new.calendar_sync_status := 'not_required';
    new.version := 1;
  end if;

  timing := tg_op = 'INSERT' or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at or new.assigned_to is distinct from old.assigned_to
            or (new.status = any (active) and not old.status = any (active));
  if timing and new.status = any (active) then
    if new.assigned_to is not null and not private.ap_in_hours(new.organization_id, new.assigned_to, new.starts_at, new.ends_at) then
      perform private.fail('OUTSIDE_WORKING_HOURS', 'Outside this person''s working hours');
    end if;
    -- The person is already locked by appointments_before; also serialize viewings of the same property.
    if new.appointment_type = 'viewing' and new.property_id is not null then
      perform pg_advisory_xact_lock(hashtextextended('appt-prop:' || new.property_id::text, 0));
    end if;
    code := private.ap_conflict(new.organization_id, new.assigned_to, new.property_id, new.appointment_type, new.starts_at, new.ends_at, new.id,
                                coalesce((rules ->> 'buffer_minutes')::int, 15));
    if code is not null then perform private.fail(code, private.ap_conflict_message(code)); end if;
  end if;

  -- Calendar: every booking change must be pushed when a calendar is connected; otherwise the internal calendar is authoritative.
  if cal is not null and (tg_op = 'INSERT' or timing or (new.status is distinct from old.status and new.status = 'cancelled')) then
    new.calendar_sync_status := 'pending';
    new.calendar_provider := cal;
    new.calendar_sync_error := null;
    new.calendar_sync_attempts := 0;
    new.calendar_lease_until := null;
  end if;
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status <> 'confirmed') then
    if new.calendar_sync_status in ('pending', 'processing') and coalesce((rules ->> 'require_calendar_sync')::boolean, false) then
      -- Not confirmed until the calendar has the event.
      new.status := case when tg_op = 'INSERT' then 'pending' else old.status end;
      new.pending_reason := 'awaiting_calendar_sync';
    else
      new.confirmed_at := now();
      new.confirmed_by := auth.uid();
      new.pending_reason := null;
    end if;
  end if;

  if tg_op = 'UPDATE' then
    new.version := old.version + case when new.starts_at <> old.starts_at or new.ends_at <> old.ends_at or new.assigned_to is distinct from old.assigned_to
                                        or new.status is distinct from old.status then 1 else 0 end;
  end if;
  return new;
end;
$$;
create trigger appointments_guard before insert or update on public.appointments for each row execute function private.ap_guard();

-- History, events, Agent 05 handoff and stale-message cancellation for every write path.
create or replace function private.ap_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ev text;
begin
  if tg_op = 'UPDATE' and new.version = old.version then return null; end if;
  insert into public.appointment_history (organization_id, appointment_id, version, action, from_status, to_status, from_starts_at, to_starts_at,
    from_assigned_to, to_assigned_to, actor, reason)
  values (new.organization_id, new.id, new.version,
    case when tg_op = 'INSERT' then 'created' when new.status is distinct from old.status then 'status'
         when new.starts_at <> old.starts_at or new.ends_at <> old.ends_at then 'rescheduled' else 'reassigned' end,
    case when tg_op = 'UPDATE' then old.status end, new.status, case when tg_op = 'UPDATE' then old.starts_at end, new.starts_at,
    case when tg_op = 'UPDATE' then old.assigned_to end, new.assigned_to, auth.uid(),
    left(coalesce(case when new.status = 'cancelled' then new.cancellation_reason end, new.change_reason), 300));

  ev := case
    when tg_op = 'INSERT' then case when new.status = 'confirmed' then 'appointment.confirmed' else 'appointment.requested' end
    when new.status is distinct from old.status then case new.status
      when 'confirmed' then case when new.starts_at <> old.starts_at then 'appointment.rescheduled' else 'appointment.confirmed' end
      when 'cancelled' then 'appointment.cancelled' when 'completed' then 'appointment.completed' when 'no_show' then 'appointment.no_show'
      when 'reschedule_requested' then 'appointment.reschedule_requested' else 'appointment.requested' end
    when new.starts_at <> old.starts_at or new.ends_at <> old.ends_at then 'appointment.rescheduled'
    else 'appointment.reassigned' end;
  perform private.emit_event(new.organization_id, ev, 'appointment', new.id, new.correlation_id,
    jsonb_build_object('event_type', ev, 'schema_version', 1, 'organization_id', new.organization_id, 'appointment_id', new.id, 'lead_id', new.lead_id,
      'property_id', new.property_id, 'version', new.version, 'status', new.status, 'correlation_id', new.correlation_id, 'occurred_at', now()),
    null, ev || ':' || new.id::text || ':' || new.version);

  -- Any change makes earlier appointment messages stale: they are cancelled before anyone can send them.
  update public.follow_ups set status = 'cancelled', status_reason = format('Appointment changed (now version %s)', new.version)
  where appointment_id = new.id and appointment_version < new.version and status in ('pending_approval', 'approved', 'scheduled');

  if new.lead_id is not null then
    if new.status = 'confirmed' and ev in ('appointment.confirmed', 'appointment.rescheduled') then
      perform private.fu_enqueue(new.organization_id, new.lead_id, ev, 'appt:' || new.id::text || ':' || new.version, 'integration', new.correlation_id,
        jsonb_build_object('appointment_id', new.id, 'appointment_version', new.version));
    elsif new.status = 'cancelled' and ev = 'appointment.cancelled' then
      perform private.fu_enqueue(new.organization_id, new.lead_id, ev, 'apptc:' || new.id::text, 'integration', new.correlation_id,
        jsonb_build_object('appointment_id', new.id, 'appointment_version', new.version));
    end if;
  end if;
  return null;
end;
$$;
create trigger appointments_lifecycle after insert or update on public.appointments for each row execute function private.ap_after();

-- ───────────────────────── availability ─────────────────────────

-- Verified free slots. Dates and the preferred window are local to the org time zone. Never returns unverifiable time.
create or replace function public.appointment_availability(p_lead uuid, p_type text, p_property uuid default null, p_assignee uuid default null,
  p_date_from date default null, p_date_to date default null, p_pref_start time default null, p_pref_end time default null, p_duration int default null, p_org uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l public.leads;
  org uuid := p_org;
  o public.organizations;
  p public.properties;
  rules jsonb;
  dur int;
  buf int;
  step interval;
  notice_ts timestamptz;
  horizon_ts timestamptz;
  d_from date;
  d_to date;
  staff uuid[];
  u uuid;
  d date;
  w record;
  s timestamptz;
  cal text;
  unverified int := 0;
  cand jsonb := '[]';
  slots jsonb;
begin
  if p_lead is not null then
    select * into l from public.leads where id = p_lead;
    if l.id is null or not public.has_perm(l.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
    org := l.organization_id;
  end if;
  if org is null or not public.has_perm(org, 'leads.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if not public.has_perm(org, 'appointments.edit') then perform private.fail('FORBIDDEN', 'You cannot book appointments'); end if;
  if coalesce(p_type, '') not in ('viewing', 'consultation', 'valuation', 'follow_up') then perform private.fail('VALIDATION_ERROR', 'Invalid appointment type'); end if;
  select * into o from public.organizations where id = org;
  rules := private.ap_rules(org);
  if p_property is not null then
    select * into p from public.properties where id = p_property and organization_id = org;
    if p.id is null then perform private.fail('NOT_FOUND', 'Property not found'); end if;
    if p.status <> 'active' then return jsonb_build_object('status', 'invalid', 'reasons', jsonb_build_array('property_not_active'), 'timezone', o.timezone); end if;
  elsif p_type = 'viewing' then
    return jsonb_build_object('status', 'invalid', 'reasons', jsonb_build_array('property_required'), 'timezone', o.timezone);
  end if;
  dur := coalesce(p_duration, (rules -> 'durations' ->> p_type)::int, 45);
  if dur not between 15 and 240 then perform private.fail('VALIDATION_ERROR', 'Duration must be 15–240 minutes'); end if;
  buf := coalesce((rules ->> 'buffer_minutes')::int, 15);
  step := make_interval(mins => greatest(coalesce((rules ->> 'slot_step_minutes')::int, 30), 5));
  notice_ts := now() + make_interval(mins => coalesce((rules ->> 'min_notice_minutes')::int, 60));
  horizon_ts := now() + make_interval(days => coalesce((rules ->> 'horizon_days')::int, 60));
  d_from := coalesce(p_date_from, (now() at time zone o.timezone)::date);
  d_to := least(coalesce(p_date_to, d_from + 6), d_from + 13);
  if d_to < d_from then perform private.fail('VALIDATION_ERROR', 'The end date is before the start date'); end if;
  if (p_pref_start is null) <> (p_pref_end is null) or p_pref_start >= p_pref_end then
    if p_pref_start is not null or p_pref_end is not null then perform private.fail('VALIDATION_ERROR', 'Invalid preferred time window'); end if;
  end if;

  if p_assignee is not null then
    if not private.is_active_member(org, p_assignee) then perform private.fail('NOT_FOUND', 'Team member not found'); end if;
    staff := array[p_assignee];
  elsif l.assigned_to is not null and private.is_active_member(org, l.assigned_to) then
    staff := array[l.assigned_to];
  else
    staff := array(select m.user_id from public.organization_memberships m where m.organization_id = org and m.status = 'active'
                     and m.role in (select rp.role from public.role_permissions rp where rp.permission = 'appointments.edit') order by m.created_at limit 10);
  end if;

  cal := private.ap_calendar_provider(org);
  foreach u in array staff loop
    if cal is not null and not private.ap_staff_verified(org, u, rules) then
      unverified := unverified + 1;
      continue;
    end if;
    for d in select generate_series(d_from, d_to, interval '1 day')::date loop
      for w in select * from private.ap_windows(org, u, d) loop
        s := w.ws;
        while s + make_interval(mins => dur) <= w.we loop
          if s >= notice_ts and s + make_interval(mins => dur) <= horizon_ts
             and private.ap_conflict(org, u, p_property, p_type, s, s + make_interval(mins => dur), null, buf) is null then
            cand := cand || jsonb_build_array(jsonb_build_object('starts_at', s, 'ends_at', s + make_interval(mins => dur), 'assignee_id', u,
              'preferred', p_pref_start is null or ((s at time zone o.timezone)::time >= p_pref_start and ((s + make_interval(mins => dur)) at time zone o.timezone)::time <= p_pref_end),
              'load', (select count(*) from public.appointments a where a.assigned_to = u and a.organization_id = org
                         and a.status in ('requested', 'pending', 'confirmed', 'reschedule_requested')
                         and (a.starts_at at time zone o.timezone)::date = d)));
          end if;
          s := s + step;
        end loop;
      end loop;
    end loop;
  end loop;

  -- One person per start time (least loaded), preferred window first, then earliest. Deterministic.
  select coalesce(jsonb_agg(x || jsonb_build_object('assignee_name', (select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr where pr.id = (x ->> 'assignee_id')::uuid),
           'local_label', to_char(((x ->> 'starts_at')::timestamptz) at time zone o.timezone, 'Dy DD Mon, HH12:MI AM')) - 'load' order by rk), '[]')
    into slots
  from (select x, row_number() over (order by (x ->> 'preferred')::boolean desc, (x ->> 'starts_at')::timestamptz, (x ->> 'load')::int, x ->> 'assignee_id') rk
        from (select x, row_number() over (partition by x ->> 'starts_at' order by (x ->> 'load')::int, x ->> 'assignee_id') per_time
              from jsonb_array_elements(cand) x) y where per_time = 1) z
  where rk <= coalesce((rules ->> 'max_slots')::int, 12);

  return jsonb_build_object(
    'status', case when jsonb_array_length(slots) > 0 then 'ok' when unverified > 0 then 'unverified' else 'no_slots' end,
    'slots', slots, 'timezone', o.timezone, 'duration', dur, 'buffer_minutes', buf, 'date_from', d_from, 'date_to', d_to,
    'unverified_staff', unverified, 'calendar_provider', cal);
end;
$$;

-- ───────────────────────── booking & changes ─────────────────────────

create or replace function public.appointment_book(p_lead uuid, p_type text, p_starts_at timestamptz, p_assignee uuid, p_idempotency_key text,
  p_property uuid default null, p_duration int default null, p_location text default null, p_title text default null, p_org uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.leads;
  org uuid := p_org;
  p public.properties;
  a public.appointments;
  rules jsonb;
  dur int;
  e timestamptz;
  code text;
  cal text;
  verified boolean;
  st text;
  reason text;
  is_service boolean := auth.uid() is null;
begin
  if coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9_:-]{8,120}$' then perform private.fail('VALIDATION_ERROR', 'Invalid idempotency key'); end if;
  if p_lead is not null then
    select * into l from public.leads where id = p_lead;
    if l.id is null or (not is_service and not public.has_perm(l.organization_id, 'leads.view')) then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
    org := l.organization_id;
  end if;
  if org is null or (not is_service and not public.has_perm(org, 'leads.view')) then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if not is_service and not public.has_perm(org, 'appointments.edit') then perform private.fail('FORBIDDEN', 'You cannot book appointments'); end if;

  select * into a from public.appointments where organization_id = org and idempotency_key = p_idempotency_key;
  if a.id is not null then
    return jsonb_build_object('appointment_id', a.id, 'status', a.status, 'booking_reference', a.booking_reference, 'replayed', true);
  end if;

  if l.id is not null and (l.archived_at is not null or l.status in ('won', 'lost')) then perform private.fail('VALIDATION_ERROR', 'This lead is closed'); end if;
  if coalesce(p_type, '') not in ('viewing', 'consultation', 'valuation', 'follow_up') then perform private.fail('VALIDATION_ERROR', 'Invalid appointment type'); end if;
  if p_type = 'viewing' and p_property is null then perform private.fail('VALIDATION_ERROR', 'Choose the property to view'); end if;
  if p_property is not null then
    select * into p from public.properties where id = p_property and organization_id = org;
    if p.id is null then perform private.fail('NOT_FOUND', 'Property not found'); end if;
    if p.status <> 'active' then perform private.fail('PROPERTY_UNAVAILABLE', 'This property is not available for viewings'); end if;
  end if;
  if p_assignee is null or not private.is_active_member(org, p_assignee) then perform private.fail('VALIDATION_ERROR', 'Choose an active team member'); end if;
  rules := private.ap_rules(org);
  dur := coalesce(p_duration, (rules -> 'durations' ->> p_type)::int, 45);
  if dur not between 15 and 240 then perform private.fail('VALIDATION_ERROR', 'Duration must be 15–240 minutes'); end if;
  e := p_starts_at + make_interval(mins => dur);
  if p_starts_at < now() + make_interval(mins => coalesce((rules ->> 'min_notice_minutes')::int, 60)) then
    perform private.fail('VALIDATION_ERROR', format('Book at least %s minutes ahead', coalesce((rules ->> 'min_notice_minutes')::int, 60)));
  end if;
  if p_starts_at > now() + make_interval(days => coalesce((rules ->> 'horizon_days')::int, 60)) then
    perform private.fail('VALIDATION_ERROR', format('Book within the next %s days', coalesce((rules ->> 'horizon_days')::int, 60)));
  end if;

  -- Same lock order as the trigger: person, then property. Re-check everything under the locks.
  perform pg_advisory_xact_lock(hashtextextended('appt:' || p_assignee::text, 0));
  if p_type = 'viewing' then perform pg_advisory_xact_lock(hashtextextended('appt-prop:' || p_property::text, 0)); end if;
  if not private.ap_in_hours(org, p_assignee, p_starts_at, e) then perform private.fail('OUTSIDE_WORKING_HOURS', 'Outside this person''s working hours'); end if;
  code := private.ap_conflict(org, p_assignee, p_property, p_type, p_starts_at, e, null, coalesce((rules ->> 'buffer_minutes')::int, 15));
  if code is not null then perform private.fail(code, private.ap_conflict_message(code)); end if;

  cal := private.ap_calendar_provider(org);
  verified := cal is null or private.ap_staff_verified(org, p_assignee, rules);
  st := case when not verified then 'requested'
             when is_service and coalesce((rules ->> 'ai_bookings_need_confirmation')::boolean, true) then 'pending' else 'confirmed' end;
  reason := case when not verified then 'calendar_unverified' when st = 'pending' then 'needs_staff_confirmation' end;
  begin
    insert into public.appointments (organization_id, title, appointment_type, status, lead_id, property_id, assigned_to, starts_at, ends_at, location_text,
      source, idempotency_key, pending_reason)
    values (org, left(coalesce(nullif(trim(p_title), ''), case p_type when 'viewing' then 'Site visit — ' || p.title when 'valuation' then 'Property valuation'
                                                               when 'consultation' then 'Requirement consultation' else 'Follow-up meeting' end), 200),
      p_type, st, l.id, p_property, p_assignee, p_starts_at, e,
      left(coalesce(nullif(trim(p_location), ''), case when p.id is not null then p.locality || coalesce(', ' || p.city, '') else 'Office' end), 300),
      case when is_service then 'ai' else 'user' end, p_idempotency_key, reason)
    returning * into a;
  exception when unique_violation then
    select * into a from public.appointments where organization_id = org and idempotency_key = p_idempotency_key;
    return jsonb_build_object('appointment_id', a.id, 'status', a.status, 'booking_reference', a.booking_reference, 'replayed', true);
  end;
  if not verified then
    insert into public.tasks (organization_id, title, description, priority, due_at, assigned_to, related_lead_id, source)
    values (org, left('Confirm availability: ' || a.title, 200), 'The calendar could not be verified for this time. Check the calendar, then confirm or reschedule.',
      'high', least(a.starts_at, now() + interval '2 hours'), p_assignee, l.id, 'ai');
  end if;
  perform private.write_audit(org, 'appointment.booked', 'appointments', a.id, jsonb_build_object('status', a.status, 'source', a.source));
  return jsonb_build_object('appointment_id', a.id, 'status', a.status, 'booking_reference', a.booking_reference, 'starts_at', a.starts_at, 'ends_at', a.ends_at,
    'pending_reason', a.pending_reason, 'calendar_sync_status', a.calendar_sync_status, 'version', a.version);
end;
$$;

create or replace function private.ap_load(p_appt uuid)
returns public.appointments
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
begin
  select * into a from public.appointments where id = p_appt for update;
  if a.id is null or not public.has_perm(a.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Appointment not found'); end if;
  if not public.has_perm(a.organization_id, 'appointments.edit') then perform private.fail('FORBIDDEN', 'You cannot change appointments'); end if;
  return a;
end;
$$;

-- A person confirms a requested / pending appointment after re-checking it is still free.
create or replace function public.appointment_confirm(p_appt uuid, p_version int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments := private.ap_load(p_appt);
  rules jsonb := private.ap_rules(a.organization_id);
  code text;
begin
  if a.version <> p_version then perform private.fail('CONFLICT', 'The appointment changed; reload it'); end if;
  if a.status not in ('requested', 'pending', 'reschedule_requested') then perform private.fail('CONFLICT', 'Only requested or pending appointments can be confirmed'); end if;
  if a.starts_at <= now() then perform private.fail('VALIDATION_ERROR', 'That time has passed; reschedule instead'); end if;
  if a.assigned_to is null then perform private.fail('VALIDATION_ERROR', 'Assign a team member first'); end if;
  perform pg_advisory_xact_lock(hashtextextended('appt:' || a.assigned_to::text, 0));
  if a.appointment_type = 'viewing' and a.property_id is not null then perform pg_advisory_xact_lock(hashtextextended('appt-prop:' || a.property_id::text, 0)); end if;
  if a.property_id is not null and (select status from public.properties where id = a.property_id) <> 'active' then
    perform private.fail('PROPERTY_UNAVAILABLE', 'This property is no longer available');
  end if;
  code := private.ap_conflict(a.organization_id, a.assigned_to, a.property_id, a.appointment_type, a.starts_at, a.ends_at, a.id, coalesce((rules ->> 'buffer_minutes')::int, 15));
  if code is not null then perform private.fail(code, private.ap_conflict_message(code)); end if;
  if private.ap_calendar_provider(a.organization_id) is not null and not private.ap_staff_verified(a.organization_id, a.assigned_to, rules) then
    perform private.fail('CALENDAR_UNVERIFIED', 'The calendar cannot be verified right now; try again after it syncs');
  end if;
  update public.appointments set status = 'confirmed', change_reason = 'Confirmed by a person' where id = a.id returning * into a;
  perform private.write_audit(a.organization_id, 'appointment.confirmed', 'appointments', a.id, jsonb_build_object('version', a.version));
  return jsonb_build_object('status', a.status, 'version', a.version, 'pending_reason', a.pending_reason);
end;
$$;

-- Atomic move: the old time is kept unless the new one is validated and stored.
create or replace function public.appointment_reschedule(p_appt uuid, p_starts_at timestamptz, p_version int, p_reason text default null, p_assignee uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments := private.ap_load(p_appt);
  rules jsonb := private.ap_rules(a.organization_id);
  dur interval := a.ends_at - a.starts_at;
  who uuid := coalesce(p_assignee, a.assigned_to);
  code text;
begin
  if a.version <> p_version then perform private.fail('CONFLICT', 'The appointment changed; reload it'); end if;
  if a.status not in ('requested', 'pending', 'confirmed', 'reschedule_requested') then perform private.fail('INVALID_TRANSITION', 'This appointment can no longer be rescheduled'); end if;
  if p_starts_at < now() + make_interval(mins => coalesce((rules ->> 'min_notice_minutes')::int, 60)) then
    perform private.fail('VALIDATION_ERROR', format('Book at least %s minutes ahead', coalesce((rules ->> 'min_notice_minutes')::int, 60)));
  end if;
  if p_starts_at > now() + make_interval(days => coalesce((rules ->> 'horizon_days')::int, 60)) then perform private.fail('VALIDATION_ERROR', 'Too far ahead'); end if;
  if who is null or not private.is_active_member(a.organization_id, who) then perform private.fail('VALIDATION_ERROR', 'Choose an active team member'); end if;
  perform pg_advisory_xact_lock(hashtextextended('appt:' || who::text, 0));
  if a.appointment_type = 'viewing' and a.property_id is not null then perform pg_advisory_xact_lock(hashtextextended('appt-prop:' || a.property_id::text, 0)); end if;
  if not private.ap_in_hours(a.organization_id, who, p_starts_at, p_starts_at + dur) then perform private.fail('OUTSIDE_WORKING_HOURS', 'Outside this person''s working hours'); end if;
  code := private.ap_conflict(a.organization_id, who, a.property_id, a.appointment_type, p_starts_at, p_starts_at + dur, a.id, coalesce((rules ->> 'buffer_minutes')::int, 15));
  if code is not null then perform private.fail(code, private.ap_conflict_message(code)); end if;
  update public.appointments set starts_at = p_starts_at, ends_at = p_starts_at + dur, assigned_to = who,
    status = case when status = 'reschedule_requested' then 'confirmed' else status end, change_reason = left(nullif(trim(coalesce(p_reason, '')), ''), 200)
  where id = a.id returning * into a;
  perform private.write_audit(a.organization_id, 'appointment.rescheduled', 'appointments', a.id, jsonb_build_object('version', a.version, 'starts_at', a.starts_at));
  return jsonb_build_object('status', a.status, 'version', a.version, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'pending_reason', a.pending_reason);
end;
$$;

-- Idempotent: cancelling a cancelled appointment returns its state.
create or replace function public.appointment_cancel(p_appt uuid, p_reason text, p_version int default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments := private.ap_load(p_appt);
begin
  if a.status = 'cancelled' then return jsonb_build_object('status', a.status, 'version', a.version, 'replayed', true); end if;
  if p_version is not null and a.version <> p_version then perform private.fail('CONFLICT', 'The appointment changed; reload it'); end if;
  if a.status in ('completed', 'no_show') then perform private.fail('INVALID_TRANSITION', 'This appointment is closed'); end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 3 and 200 then perform private.fail('VALIDATION_ERROR', 'Give a short cancellation reason'); end if;
  update public.appointments set status = 'cancelled', cancellation_reason = trim(p_reason) where id = a.id returning * into a;
  return jsonb_build_object('status', a.status, 'version', a.version);
end;
$$;

create or replace function public.appointment_set_outcome(p_appt uuid, p_outcome text, p_feedback text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments := private.ap_load(p_appt);
begin
  if p_outcome not in ('completed', 'no_show') then perform private.fail('VALIDATION_ERROR', 'Invalid outcome'); end if;
  if a.status = p_outcome then return jsonb_build_object('status', a.status, 'replayed', true); end if;
  update public.appointments set status = p_outcome, feedback = coalesce(left(nullif(trim(coalesce(p_feedback, '')), ''), 2000), feedback) where id = a.id returning * into a;
  return jsonb_build_object('status', a.status, 'version', a.version);
end;
$$;

-- Read model for the appointment drawer.
create or replace function public.appointment_detail(p_appt uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.appointments;
begin
  select * into a from public.appointments where id = p_appt;
  if a.id is null or not public.has_perm(a.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Appointment not found'); end if;
  return jsonb_build_object(
    'appointment', to_jsonb(a) - 'organization_id' - 'idempotency_key' - 'calendar_lease_until',
    'history', (select coalesce(jsonb_agg(to_jsonb(h) - 'organization_id' order by h.version, h.created_at), '[]') from public.appointment_history h where h.appointment_id = a.id),
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'purpose', f.purpose, 'status', f.status, 'status_reason', f.status_reason, 'channel', f.channel,
        'appointment_version', f.appointment_version, 'scheduled_for', f.scheduled_for, 'sent_at', f.sent_at, 'sent_via', f.sent_via) order by f.created_at), '[]')
      from public.follow_ups f where f.appointment_id = a.id),
    'assignee_name', (select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr where pr.id = a.assigned_to),
    'calendar_provider', private.ap_calendar_provider(a.organization_id),
    'can_edit', public.has_perm(a.organization_id, 'appointments.edit'));
end;
$$;

-- ───────────────────────── availability settings ─────────────────────────

create or replace function public.scheduling_settings_save(p_org uuid, p_rules jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ver int;
begin
  if not public.has_perm(p_org, 'settings.manage') then perform private.fail('FORBIDDEN', 'You cannot change scheduling rules'); end if;
  if jsonb_typeof(p_rules) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_rules) k where k not in ('durations', 'buffer_minutes', 'min_notice_minutes', 'horizon_days', 'slot_step_minutes', 'max_slots',
          'require_calendar_sync', 'calendar_freshness_minutes', 'reminder_hours_before', 'ai_bookings_need_confirmation'))
     or (p_rules ? 'durations' and (jsonb_typeof(p_rules -> 'durations') <> 'object'
         or exists (select 1 from jsonb_each(p_rules -> 'durations') e where e.key not in ('viewing', 'consultation', 'valuation', 'follow_up')
                    or jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::int not between 15 and 240)))
     or (p_rules ? 'buffer_minutes' and coalesce((p_rules ->> 'buffer_minutes')::int, -1) not between 0 and 120)
     or (p_rules ? 'min_notice_minutes' and coalesce((p_rules ->> 'min_notice_minutes')::int, -1) not between 0 and 10080)
     or (p_rules ? 'horizon_days' and coalesce((p_rules ->> 'horizon_days')::int, 0) not between 1 and 365)
     or (p_rules ? 'slot_step_minutes' and coalesce((p_rules ->> 'slot_step_minutes')::int, 0) not in (10, 15, 20, 30, 45, 60))
     or (p_rules ? 'max_slots' and coalesce((p_rules ->> 'max_slots')::int, 0) not between 1 and 50)
     or (p_rules ? 'calendar_freshness_minutes' and coalesce((p_rules ->> 'calendar_freshness_minutes')::int, 0) not between 5 and 1440)
     or (p_rules ? 'reminder_hours_before' and coalesce((p_rules ->> 'reminder_hours_before')::int, 0) not between 1 and 168)
     or (p_rules ? 'require_calendar_sync' and jsonb_typeof(p_rules -> 'require_calendar_sync') <> 'boolean')
     or (p_rules ? 'ai_bookings_need_confirmation' and jsonb_typeof(p_rules -> 'ai_bookings_need_confirmation') <> 'boolean')
  then
    perform private.fail('VALIDATION_ERROR', 'Scheduling rules are invalid');
  end if;
  insert into public.scheduling_settings (organization_id, rules, updated_by) values (p_org, p_rules, auth.uid())
  on conflict (organization_id) do update set rules = excluded.rules, version = public.scheduling_settings.version + 1, updated_by = excluded.updated_by
  returning version into ver;
  return ver;
exception
  when invalid_text_representation then perform private.fail('VALIDATION_ERROR', 'Scheduling rules are invalid'); return null;
end;
$$;

-- Replaces a person's weekly hours. Admins for anyone; a person for themselves.
create or replace function public.staff_working_hours_save(p_org uuid, p_user uuid, p_hours jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  x jsonb;
  n int := 0;
begin
  if not (public.has_perm(p_org, 'settings.manage') or (p_user = auth.uid() and public.has_perm(p_org, 'appointments.edit'))) then
    perform private.fail('FORBIDDEN', 'You cannot change these working hours');
  end if;
  if not private.is_active_member(p_org, p_user) then perform private.fail('NOT_FOUND', 'Team member not found'); end if;
  if jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 21 then perform private.fail('VALIDATION_ERROR', 'Invalid working hours'); end if;
  delete from public.staff_working_hours where organization_id = p_org and user_id = p_user;
  for x in select * from jsonb_array_elements(p_hours) loop
    if jsonb_typeof(x) <> 'object' or coalesce((x ->> 'weekday')::int, -1) not between 0 and 6 or coalesce(x ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(x ->> 'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$|^24:00$' or (x ->> 'start') >= (x ->> 'end') then
      perform private.fail('VALIDATION_ERROR', 'Each entry needs weekday 0–6 and start < end (HH:MM)');
    end if;
    insert into public.staff_working_hours (organization_id, user_id, weekday, start_time, end_time)
    values (p_org, p_user, (x ->> 'weekday')::smallint, (x ->> 'start')::time, case when x ->> 'end' = '24:00' then '23:59:59'::time else (x ->> 'end')::time end);
    n := n + 1;
  end loop;
  return n;
exception
  when unique_violation then perform private.fail('VALIDATION_ERROR', 'Two entries start at the same time on one day'); return null;
end;
$$;

create or replace function public.availability_block_add(p_org uuid, p_kind text, p_starts_at timestamptz, p_ends_at timestamptz, p_user uuid default null,
  p_property uuid default null, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  bid uuid;
begin
  if not public.has_perm(p_org, 'leads.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if p_kind not in ('closure', 'time_off', 'property_unavailable') then perform private.fail('VALIDATION_ERROR', 'Invalid kind'); end if;
  if p_starts_at is null or p_ends_at is null or p_starts_at >= p_ends_at or p_ends_at - p_starts_at > interval '90 days' then
    perform private.fail('VALIDATION_ERROR', 'Choose a start before the end, at most 90 days long');
  end if;
  if p_kind = 'closure' and not public.has_perm(p_org, 'settings.manage') then perform private.fail('FORBIDDEN', 'You cannot add closures'); end if;
  if p_kind = 'time_off' then
    if not (public.has_perm(p_org, 'settings.manage') or (p_user = auth.uid() and public.has_perm(p_org, 'appointments.edit'))) then perform private.fail('FORBIDDEN', 'You cannot add time off for this person'); end if;
    if not private.is_active_member(p_org, p_user) then perform private.fail('NOT_FOUND', 'Team member not found'); end if;
  end if;
  if p_kind = 'property_unavailable' then
    if not public.has_perm(p_org, 'properties.edit') then perform private.fail('FORBIDDEN', 'You cannot restrict viewings'); end if;
    if not exists (select 1 from public.properties where id = p_property and organization_id = p_org) then perform private.fail('NOT_FOUND', 'Property not found'); end if;
  end if;
  insert into public.availability_blocks (organization_id, kind, user_id, property_id, starts_at, ends_at, reason, created_by)
  values (p_org, p_kind, case when p_kind = 'time_off' then p_user end, case when p_kind = 'property_unavailable' then p_property end,
    p_starts_at, p_ends_at, left(nullif(trim(coalesce(p_reason, '')), ''), 200), auth.uid())
  returning id into bid;
  perform private.write_audit(p_org, 'availability.block_added', 'availability_blocks', bid, jsonb_build_object('kind', p_kind));
  return bid;
end;
$$;

create or replace function public.availability_block_remove(p_block uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.availability_blocks;
begin
  select * into b from public.availability_blocks where id = p_block;
  if b.id is null or not public.has_perm(b.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Block not found'); end if;
  if b.kind = 'external_busy' then perform private.fail('FORBIDDEN', 'Calendar busy time is managed by the calendar sync'); end if;
  if not (public.has_perm(b.organization_id, 'settings.manage')
          or (b.kind = 'time_off' and b.user_id = auth.uid() and public.has_perm(b.organization_id, 'appointments.edit'))
          or (b.kind = 'property_unavailable' and public.has_perm(b.organization_id, 'properties.edit'))) then
    perform private.fail('FORBIDDEN', 'You cannot remove this block');
  end if;
  delete from public.availability_blocks where id = b.id;
  perform private.write_audit(b.organization_id, 'availability.block_removed', 'availability_blocks', b.id, jsonb_build_object('kind', b.kind));
end;
$$;

-- ───────────────────────── service: reminders & calendar boundary ─────────────────────────

-- Reminders are created close to the appointment (never stale-dated), and stuck calendar syncs are reconciled.
create or replace function public.appointment_tick(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x record;
  n int := 0;
  m int := 0;
begin
  for x in
    select a.id, a.organization_id, a.lead_id, a.version, a.correlation_id from public.appointments a
    where a.status = 'confirmed' and a.lead_id is not null and a.starts_at > now() + interval '1 hour'
      and a.starts_at <= now() + make_interval(hours => coalesce((private.ap_rules(a.organization_id) ->> 'reminder_hours_before')::int, 24))
      and not exists (select 1 from public.agent_runs ar where ar.organization_id = a.organization_id and ar.agent_id = 'follow_up_agent'
                        and ar.idempotency_key = 'apptrem:' || a.id::text || ':' || a.version)
    order by a.starts_at limit least(greatest(p_limit, 1), 200)
  loop
    perform private.fu_enqueue(x.organization_id, x.lead_id, 'appointment.reminder_due', 'apptrem:' || x.id::text || ':' || x.version, 'integration', x.correlation_id,
      jsonb_build_object('appointment_id', x.id, 'appointment_version', x.version));
    n := n + 1;
  end loop;
  -- A sync whose lease ran out without a result may have created the event: never re-create blindly.
  for x in
    update public.appointments a set calendar_sync_status = 'failed', calendar_sync_error = 'Outcome unknown (worker lease expired); check the calendar before retrying',
      calendar_lease_until = null
    where a.calendar_sync_status = 'processing' and a.calendar_lease_until < now()
    returning a.id, a.organization_id, a.version, a.correlation_id
  loop
    perform private.emit_event(x.organization_id, 'appointment.calendar_sync_failed', 'appointment', x.id, x.correlation_id,
      jsonb_build_object('event_type', 'appointment.calendar_sync_failed', 'schema_version', 1, 'appointment_id', x.id, 'version', x.version, 'occurred_at', now()),
      null, 'appointment.calendar_sync_failed:' || x.id::text || ':' || x.version || ':lease');
    m := m + 1;
  end loop;
  return jsonb_build_object('reminders', n, 'sync_reconciled', m);
end;
$$;

create or replace function public.calendar_sync_claim(p_limit int default 10)
returns table (appointment_id uuid, version int, provider text, action text, external_event_id text, starts_at timestamptz, ends_at timestamptz,
  timezone text, title text, location text, assignee_email text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with picked as (
    select a.id from public.appointments a
    where a.calendar_sync_status = 'pending' and (a.calendar_lease_until is null or a.calendar_lease_until < now())
    order by a.updated_at limit least(greatest(p_limit, 1), 50)
    for update skip locked
  ), leased as (
    update public.appointments a set calendar_sync_status = 'processing', calendar_lease_until = now() + interval '5 minutes', calendar_sync_attempts = a.calendar_sync_attempts + 1
    from picked where a.id = picked.id returning a.*
  )
  select leased.id, leased.version, leased.calendar_provider,
    case when leased.status = 'cancelled' then 'cancel' when leased.external_event_id is null then 'create' else 'update' end,
    leased.external_event_id, leased.starts_at, leased.ends_at, leased.timezone, leased.title, leased.location_text,
    (select pr.email from public.profiles pr where pr.id = leased.assigned_to)
  from leased;
end;
$$;

-- Result of one provider call. A result for an older version only records the event id and queues a resync.
create or replace function public.calendar_sync_result(p_appt uuid, p_version int, p_outcome text, p_external_event_id text, p_error text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.appointments;
begin
  select * into a from public.appointments where id = p_appt for update;
  if a.id is null then perform private.fail('NOT_FOUND', 'Appointment not found'); end if;
  if a.calendar_sync_status <> 'processing' then return a.calendar_sync_status; end if;
  if p_outcome not in ('synced', 'transient', 'permanent', 'ambiguous', 'unsupported') then perform private.fail('VALIDATION_ERROR', 'Invalid outcome'); end if;
  if a.version <> p_version then
    update public.appointments set calendar_sync_status = 'pending', calendar_lease_until = null,
      external_event_id = coalesce(case when p_outcome = 'synced' then left(p_external_event_id, 300) end, external_event_id)
    where id = a.id;
    return 'stale';
  end if;
  if p_outcome = 'synced' then
    update public.appointments set calendar_sync_status = 'synced', calendar_lease_until = null, calendar_sync_error = null,
      external_event_id = coalesce(left(p_external_event_id, 300), external_event_id), calendar_synced_version = version
    where id = a.id returning * into a;
    if a.status = 'pending' and a.pending_reason = 'awaiting_calendar_sync' then
      update public.appointments set status = 'confirmed', change_reason = 'Calendar event created' where id = a.id;
    end if;
  elsif p_outcome = 'transient' and a.calendar_sync_attempts < 3 then
    update public.appointments set calendar_sync_status = 'pending', calendar_sync_error = left(p_error, 300),
      calendar_lease_until = now() + make_interval(mins => power(2, a.calendar_sync_attempts)::int) where id = a.id;
  else
    update public.appointments set calendar_sync_status = 'failed', calendar_lease_until = null,
      calendar_sync_error = left(coalesce(p_error, p_outcome), 300) where id = a.id returning * into a;
    insert into public.tasks (organization_id, title, description, priority, due_at, assigned_to, related_lead_id, source)
    values (a.organization_id, left('Calendar sync failed: ' || a.title, 200),
      case when p_outcome = 'ambiguous' then 'The calendar did not confirm or reject the change. Check the calendar before retrying.'
           else 'The calendar rejected the change: ' || coalesce(left(p_error, 200), p_outcome) end,
      'high', now() + interval '2 hours', a.assigned_to, a.lead_id, 'ai');
    perform private.emit_event(a.organization_id, 'appointment.calendar_sync_failed', 'appointment', a.id, a.correlation_id,
      jsonb_build_object('event_type', 'appointment.calendar_sync_failed', 'schema_version', 1, 'appointment_id', a.id, 'version', a.version, 'outcome', p_outcome, 'occurred_at', now()),
      null, 'appointment.calendar_sync_failed:' || a.id::text || ':' || a.version);
  end if;
  return (select calendar_sync_status from public.appointments where id = a.id);
end;
$$;

-- Busy periods imported from a person's calendar (by a future adapter), with freshness for verification.
create or replace function public.calendar_busy_replace(p_org uuid, p_user uuid, p_provider text, p_ok boolean, p_blocks jsonb, p_error text default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int := 0;
begin
  if not private.is_active_member(p_org, p_user) then perform private.fail('NOT_FOUND', 'Team member not found'); end if;
  insert into public.calendar_sync_state (organization_id, user_id, provider, status, last_synced_at, last_error, updated_at)
  values (p_org, p_user, left(p_provider, 60), case when p_ok then 'ok' else 'error' end, case when p_ok then now() end, left(p_error, 300), now())
  on conflict (organization_id, user_id) do update set provider = excluded.provider, status = excluded.status,
    last_synced_at = coalesce(excluded.last_synced_at, public.calendar_sync_state.last_synced_at), last_error = excluded.last_error, updated_at = now();
  if not p_ok then return 0; end if;
  delete from public.availability_blocks where organization_id = p_org and user_id = p_user and kind = 'external_busy';
  insert into public.availability_blocks (organization_id, kind, user_id, starts_at, ends_at, reason, source)
  select p_org, 'external_busy', p_user, (x ->> 'starts_at')::timestamptz, (x ->> 'ends_at')::timestamptz, 'Busy in calendar', 'calendar'
  from jsonb_array_elements(coalesce(p_blocks, '[]')) x
  where (x ->> 'starts_at')::timestamptz < (x ->> 'ends_at')::timestamptz and (x ->> 'ends_at')::timestamptz > now();
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.calendar_sync_worker_secret_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_secret is not null and length(p_secret) >= 32
     and exists (select 1 from vault.decrypted_secrets where name = 'calendar_sync_worker_secret' and decrypted_secret = p_secret);
$$;

-- ───────────────────────── Agent 05: appointment messages ─────────────────────────

-- One active message per lead and purpose, except appointment messages: one per appointment, purpose and version.
drop index public.follow_ups_active_purpose_uniq;
create unique index follow_ups_active_purpose_uniq on public.follow_ups (lead_id, purpose)
  where status in ('pending_approval', 'approved', 'scheduled', 'processing') and appointment_id is null;
create unique index follow_ups_active_appointment_uniq on public.follow_ups (appointment_id, purpose, appointment_version)
  where status in ('pending_approval', 'approved', 'scheduled', 'processing') and appointment_id is not null;

create or replace function private.fu_create(r public.agent_runs, l public.leads, p_purpose text, p_kind text, p_channel text, p_cpurpose text, p_reason text,
  p_ctx jsonb, p_props uuid[], p_key text, p_match uuid, p_call uuid, p_qual uuid, p_task uuid)
returns public.follow_ups
language plpgsql
security definer
set search_path = ''
as $$
declare
  rules jsonb := private.fu_rules(l.organization_id);
  pol jsonb;
  msg jsonb;
  f public.follow_ups;
  st text;
begin
  select * into f from public.follow_ups where organization_id = l.organization_id and idempotency_key = p_key;
  if f.id is not null then return f; end if;
  if p_kind = 'message' then
    -- Another active follow-up with this purpose already covers it. Appointment messages are per appointment and version
    -- (their idempotency key), so a lead with two appointments gets both confirmations.
    if p_purpose not in ('appointment_confirmation', 'appointment_reminder', 'appointment_cancellation')
       and exists (select 1 from public.follow_ups x where x.lead_id = l.id and x.purpose = p_purpose and x.status in ('pending_approval', 'approved', 'scheduled', 'processing')) then
      return null;
    end if;
    pol := private.fu_policy(l.id, p_channel, p_cpurpose);
    msg := private.fu_render(p_purpose, p_channel, p_ctx);
    st := case when (pol ->> 'blocked')::boolean then 'suppressed' else 'pending_approval' end;
  else
    st := 'handed_off';
  end if;
  insert into public.follow_ups (organization_id, lead_id, contact_id, run_id, trigger, purpose, kind, channel, consent_purpose, status, status_reason, reason,
    scheduled_for, timezone, subject, body, draft_status, property_ids, match_run_id, call_id, qualification_id, task_id, policy, idempotency_key, correlation_id)
  select l.organization_id, l.id, l.contact_id, r.id, r.trigger_event, p_purpose, p_kind, p_channel, p_cpurpose, st,
    case when st = 'suppressed' then left('Blocked: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(pol -> 'failed') x), 300) end,
    left(p_reason, 500), coalesce((pol ->> 'defer_until')::timestamptz, now()), pol ->> 'timezone', msg ->> 'subject', msg ->> 'body',
    case when st = 'pending_approval' and coalesce((rules ->> 'llm_drafting')::boolean, true) then 'pending' else 'not_requested' end,
    coalesce(p_props, '{}'), p_match, p_call, p_qual, p_task, coalesce(pol - 'checks' || jsonb_build_object('checks', pol -> 'checks'), '{}'), p_key, r.correlation_id
  returning * into f;
  perform private.fu_activity(f,
    case f.status when 'pending_approval' then format('Follow-up drafted for approval: %s via %s', replace(f.purpose, '_', ' '), f.channel)
                  when 'suppressed' then format('Follow-up blocked by policy: %s', replace(f.purpose, '_', ' '))
                  else format('Follow-up handed to a person: %s', replace(f.purpose, '_', ' ')) end,
    concat_ws(' · ', f.reason, f.status_reason));
  perform private.fu_event(f, case f.status when 'pending_approval' then 'follow_up.human_review_required' when 'suppressed' then 'follow_up.suppressed' else 'follow_up.handed_off' end);
  return f;
end;
$$;

alter function private.fu_execute(public.agent_runs) rename to fu_execute_base;
alter function private.fu_render(text, text, jsonb) rename to fu_render_base;
alter function private.fu_content_problem(public.follow_ups) rename to fu_content_problem_base;
alter function private.fu_policy(uuid, text, text, timestamptz, uuid) rename to fu_policy_base;

create or replace function private.fu_render(p_purpose text, p_channel text, ctx jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  hi text := 'Hi ' || coalesce(nullif(ctx ->> 'first_name', ''), 'there') || ', this is ' || coalesce(ctx ->> 'agency', 'your agent') || '.';
  what text := coalesce(ctx ->> 'type_label', 'appointment') || coalesce(' of ' || (ctx ->> 'property'), '');
  at text := (ctx ->> 'when') || ' (' || (ctx ->> 'timezone') || ')' || coalesce(' at ' || (ctx ->> 'location'), '');
  b text;
begin
  if p_purpose not in ('appointment_confirmation', 'appointment_reminder', 'appointment_cancellation') then
    return private.fu_render_base(p_purpose, p_channel, ctx);
  end if;
  b := case p_purpose
    when 'appointment_confirmation' then hi || format(' Your %s %s %s. Reference: %s. Reply to this message if you need to change it.', what,
      case when (ctx ->> 'rescheduled')::boolean then 'has been moved to' else 'is booked for' end, at, ctx ->> 'reference')
    when 'appointment_reminder' then hi || format(' A reminder of your %s on %s. Reference: %s. Reply to this message if you need to change it.', what, at, ctx ->> 'reference')
    else hi || format(' Your %s on %s (%s) has been cancelled. Reply if you would like to arrange another time.', what, ctx ->> 'when', ctx ->> 'timezone') end;
  return jsonb_build_object('subject', case when p_channel = 'email' then case p_purpose when 'appointment_confirmation' then 'Your appointment: ' || (ctx ->> 'when')
      when 'appointment_reminder' then 'Reminder: ' || (ctx ->> 'when') else 'Appointment cancelled' end end,
    'body', b || private.fu_footer(p_channel));
end;
$$;

-- Appointment messages must still describe the appointment as it is now.
create or replace function private.fu_content_problem(f public.follow_ups)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.appointments;
begin
  if f.purpose in ('appointment_confirmation', 'appointment_reminder', 'appointment_cancellation') then
    select * into a from public.appointments where id = f.appointment_id and organization_id = f.organization_id;
    if a.id is null or a.version is distinct from f.appointment_version then return 'APPOINTMENT_CHANGED'; end if;
    if f.purpose <> 'appointment_cancellation' and (a.status <> 'confirmed' or a.starts_at <= now()) then return 'APPOINTMENT_CHANGED'; end if;
    if f.purpose = 'appointment_cancellation' and a.status <> 'cancelled' then return 'APPOINTMENT_CHANGED'; end if;
  end if;
  return private.fu_content_problem_base(f);
end;
$$;

-- Appointment messages are transactional: frequency / ownership limits do not apply (consent, window, suppression still do).
-- Reminders are deferred until due.
create or replace function private.fu_policy(p_lead uuid, p_channel text, p_purpose text, p_at timestamptz default now(), p_self uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  res jsonb := private.fu_policy_base(p_lead, p_channel, p_purpose, p_at, p_self);
  fx public.follow_ups;
  transactional boolean;
  checks jsonb;
  defer timestamptz;
  o public.organizations;
begin
  if p_self is not null then select * into fx from public.follow_ups where id = p_self; end if;
  transactional := coalesce(current_setting('app.fu_transactional', true), '') = 'on'
                   or coalesce(fx.purpose in ('appointment_confirmation', 'appointment_reminder', 'appointment_cancellation'), false);
  if not transactional then return res; end if;
  checks := (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(res -> 'checks') x
             where x ->> 'key' not in ('weekly_limit', 'min_gap', 'unanswered', 'human_cooldown', 'human_owner'));
  if fx.purpose = 'appointment_reminder' and fx.scheduled_for > p_at then
    checks := checks || jsonb_build_array(jsonb_build_object('key', 'reminder_due', 'hard', false, 'label', 'Reminder not due yet', 'ok', false, 'until', fx.scheduled_for));
  end if;
  select max((x ->> 'until')::timestamptz) into defer from jsonb_array_elements(checks) x where not (x ->> 'ok')::boolean and not (x ->> 'hard')::boolean;
  if defer is not null then
    select * into o from public.organizations where id = (select organization_id from public.leads where id = p_lead);
    defer := private.fu_next_window(o.timezone, o.settings -> 'business_hours' -> 'days', private.fu_rules(o.id) -> 'window', greatest(defer, p_at));
  end if;
  return res || jsonb_build_object(
    'allowed', not exists (select 1 from jsonb_array_elements(checks) x where not (x ->> 'ok')::boolean),
    'blocked', exists (select 1 from jsonb_array_elements(checks) x where not (x ->> 'ok')::boolean and (x ->> 'hard')::boolean),
    'defer_until', defer, 'checks', checks,
    'failed', (select coalesce(jsonb_agg(x ->> 'label'), '[]') from jsonb_array_elements(checks) x where not (x ->> 'ok')::boolean));
end;
$$;

create or replace function private.fu_execute(r public.agent_runs)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.leads;
  a public.appointments;
  c public.contacts;
  o public.organizations;
  p public.properties;
  rules jsonb;
  v_purpose text;
  ch text;
  f public.follow_ups;
  ctx jsonb;
  hrs int;
begin
  if r.trigger_event not in ('appointment.confirmed', 'appointment.rescheduled', 'appointment.reminder_due', 'appointment.cancelled') then
    return private.fu_execute_base(r);
  end if;
  select * into l from public.leads where id = r.lead_id and organization_id = r.organization_id;
  if l.id is null then return jsonb_build_object('status', 'skipped', 'reason', 'lead_not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('followup:' || l.id::text, 0));
  select * into a from public.appointments where id = (r.input ->> 'appointment_id')::uuid and organization_id = l.organization_id and lead_id = l.id;
  if a.id is null then return jsonb_build_object('status', 'skipped', 'reason', 'appointment_not_found'); end if;
  if r.trigger_event = 'appointment.cancelled' then
    if a.status <> 'cancelled' then return jsonb_build_object('status', 'skipped', 'reason', 'appointment_changed'); end if;
    -- Only tell people who were told about it.
    if not exists (select 1 from public.follow_ups x where x.appointment_id = a.id and x.purpose in ('appointment_confirmation', 'appointment_reminder')
                     and x.status in ('sent', 'delivered')) then
      return jsonb_build_object('status', 'skipped', 'reason', 'no_confirmation_was_sent');
    end if;
    v_purpose := 'appointment_cancellation';
  else
    if a.status <> 'confirmed' or a.version <> (r.input ->> 'appointment_version')::int or a.starts_at <= now() then
      return jsonb_build_object('status', 'skipped', 'reason', 'appointment_changed');
    end if;
    v_purpose := case when r.trigger_event = 'appointment.reminder_due' then 'appointment_reminder' else 'appointment_confirmation' end;
  end if;
  rules := private.fu_rules(l.organization_id);
  ch := private.fu_pick_channel(l.id, 'service', rules);
  if ch is null then return jsonb_build_object('status', 'skipped', 'reason', 'no_permitted_channel'); end if;
  select * into c from public.contacts where id = l.contact_id;
  select * into o from public.organizations where id = l.organization_id;
  select * into p from public.properties where id = a.property_id and organization_id = a.organization_id;
  ctx := jsonb_strip_nulls(jsonb_build_object('first_name', split_part(trim(c.display_name), ' ', 1), 'agency', o.name,
    'type_label', case a.appointment_type when 'viewing' then 'property viewing' when 'valuation' then 'valuation visit' when 'consultation' then 'consultation' else 'meeting' end,
    'property', p.title, 'when', to_char(a.starts_at at time zone a.timezone, 'Dy DD Mon YYYY, HH12:MI AM'), 'timezone', a.timezone, 'location', a.location_text,
    'reference', a.booking_reference, 'rescheduled', r.trigger_event = 'appointment.rescheduled'));
  perform set_config('app.fu_transactional', 'on', true);
  f := private.fu_create(r, l, v_purpose, 'message', ch, 'service',
    case v_purpose when 'appointment_confirmation' then format('Appointment %s %s (version %s)', a.booking_reference, case when r.trigger_event = 'appointment.rescheduled' then 'rescheduled' else 'confirmed' end, a.version)
                 when 'appointment_reminder' then format('Reminder for appointment %s', a.booking_reference) else format('Appointment %s cancelled', a.booking_reference) end,
    ctx, null, case v_purpose when 'appointment_confirmation' then 'apptconf:' when 'appointment_reminder' then 'apptrem:' else 'apptcanc:' end || a.id::text || ':' || a.version,
    null, null, null, null);
  perform set_config('app.fu_transactional', 'off', true);
  if f.id is null then return jsonb_build_object('status', 'duplicate'); end if;
  hrs := coalesce((private.ap_rules(a.organization_id) ->> 'reminder_hours_before')::int, 24);
  update public.follow_ups set appointment_id = a.id, appointment_version = a.version, draft_status = 'not_requested',
    scheduled_for = case when v_purpose = 'appointment_reminder' then greatest(scheduled_for, a.starts_at - make_interval(hours => hrs)) else scheduled_for end
  where id = f.id returning * into f;
  return jsonb_build_object('status', f.status, 'follow_up_id', f.id, 'purpose', v_purpose);
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke all on function private.ap_default_rules(), private.ap_rules(uuid), private.ap_calendar_provider(uuid), private.ap_staff_verified(uuid, uuid, jsonb),
  private.ap_windows(uuid, uuid, date), private.ap_in_hours(uuid, uuid, timestamptz, timestamptz),
  private.ap_conflict(uuid, uuid, uuid, text, timestamptz, timestamptz, uuid, int), private.ap_conflict_message(text), private.ap_guard(), private.ap_after(),
  private.ap_load(uuid), private.fu_render(text, text, jsonb), private.fu_content_problem(public.follow_ups),
  private.fu_policy(uuid, text, text, timestamptz, uuid), private.fu_execute(public.agent_runs)
  from public, anon, authenticated;
revoke execute on function public.appointment_tick(int), public.calendar_sync_claim(int), public.calendar_sync_result(uuid, int, text, text, text),
  public.calendar_busy_replace(uuid, uuid, text, boolean, jsonb, text), public.calendar_sync_worker_secret_ok(text) from public, anon, authenticated;
grant execute on function public.appointment_tick(int), public.calendar_sync_claim(int), public.calendar_sync_result(uuid, int, text, text, text),
  public.calendar_busy_replace(uuid, uuid, text, boolean, jsonb, text), public.calendar_sync_worker_secret_ok(text) to service_role;
revoke execute on function public.appointment_availability(uuid, text, uuid, uuid, date, date, time, time, int, uuid),
  public.appointment_book(uuid, text, timestamptz, uuid, text, uuid, int, text, text, uuid), public.appointment_confirm(uuid, int),
  public.appointment_reschedule(uuid, timestamptz, int, text, uuid), public.appointment_cancel(uuid, text, int), public.appointment_set_outcome(uuid, text, text),
  public.appointment_detail(uuid), public.scheduling_settings_save(uuid, jsonb), public.staff_working_hours_save(uuid, uuid, jsonb),
  public.availability_block_add(uuid, text, timestamptz, timestamptz, uuid, uuid, text), public.availability_block_remove(uuid) from public, anon;
grant execute on function public.appointment_availability(uuid, text, uuid, uuid, date, date, time, time, int, uuid),
  public.appointment_book(uuid, text, timestamptz, uuid, text, uuid, int, text, text, uuid), public.appointment_confirm(uuid, int),
  public.appointment_reschedule(uuid, timestamptz, int, text, uuid), public.appointment_cancel(uuid, text, int), public.appointment_set_outcome(uuid, text, text),
  public.appointment_detail(uuid), public.scheduling_settings_save(uuid, jsonb), public.staff_working_hours_save(uuid, uuid, jsonb),
  public.availability_block_add(uuid, text, timestamptz, timestamptz, uuid, uuid, text), public.availability_block_remove(uuid) to authenticated;
-- AI / service bookings arrive as 'pending' (a person confirms).
grant execute on function public.appointment_book(uuid, text, timestamptz, uuid, text, uuid, int, text, text, uuid) to service_role;

-- ───────────────────────── schedules ─────────────────────────
-- appointment-tick: pure SQL (reminders, calendar lease reconciliation).
-- calendar-sync-worker: pg_net → Edge Function; inactive until 'calendar_sync_worker_url' is in Vault (and does nothing without a calendar adapter).

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'calendar_sync_worker_secret') then
    perform vault.create_secret(private.random_token() || private.random_token(), 'calendar_sync_worker_secret', 'Shared secret for the calendar-sync-worker Edge Function');
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if not exists (select 1 from cron.job where jobname = 'appointment-tick') then
      perform cron.schedule('appointment-tick', '* * * * *', 'select public.appointment_tick(50)');
    end if;
    if exists (select 1 from pg_available_extensions where name = 'pg_net') and not exists (select 1 from cron.job where jobname = 'calendar-sync-worker') then
      create extension if not exists pg_net with schema extensions;
      perform cron.schedule('calendar-sync-worker', '* * * * *', $job$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'calendar_sync_worker_url'),
          headers := jsonb_build_object('Content-Type', 'application/json',
            'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'calendar_sync_worker_secret')),
          body := '{}'::jsonb, timeout_milliseconds := 55000)
        where exists (select 1 from vault.decrypted_secrets where name = 'calendar_sync_worker_url')
      $job$);
    end if;
  end if;
end;
$$;
