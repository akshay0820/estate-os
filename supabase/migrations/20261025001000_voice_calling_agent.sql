-- Estate OS · 0010 · Agent 02 — AI Voice Calling Agent (voice_calling_agent), Retell AI
-- Call records, transcripts (separately protected), a webhook dedupe ledger, per-org voice settings,
-- a deterministic pre-call policy, a monotonic call state machine, opt-out / handoff handling,
-- post-call analysis application and the Agent 3 handoff through outbox_events.
-- Additive only.

-- ───────────────────────── settings ─────────────────────────

create table public.voice_settings (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  enabled boolean not null default false,
  outbound_agent_id text unique check (outbound_agent_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  inbound_agent_id text unique check (inbound_agent_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  from_number text check (from_number ~ '^\+[1-9][0-9]{6,14}$'),
  agency_spoken_name text check (char_length(agency_spoken_name) between 2 and 80),
  -- 'ai_call': only explicit AI-call consent counts. 'phone': phone service consent also counts.
  consent_basis text not null default 'ai_call' check (consent_basis in ('ai_call', 'phone')),
  store_transcripts boolean not null default false,
  analysis_enabled boolean not null default false,
  recording_access boolean not null default false,
  transcript_retention_days integer not null default 90 check (transcript_retention_days between 1 and 730),
  max_attempts_per_lead_per_day integer not null default 2 check (max_attempts_per_lead_per_day between 1 and 10),
  min_minutes_between_attempts integer not null default 240 check (min_minutes_between_attempts between 5 and 10080),
  max_calls_per_day integer not null default 100 check (max_calls_per_day between 1 and 5000),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger voice_settings_updated_at before update on public.voice_settings for each row execute function public.set_updated_at();
create trigger voice_settings_audit after insert or update on public.voice_settings for each row execute function private.audit_row();

-- ───────────────────────── calls ─────────────────────────

create table public.voice_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  lead_id uuid references public.leads (id) on delete set null,
  contact_id uuid references public.contacts (id) on delete set null,
  direction text not null check (direction in ('outbound', 'inbound')),
  status text not null check (status in ('initiating', 'dialing', 'in_progress', 'completed', 'no_answer', 'busy', 'voicemail', 'failed', 'unknown', 'blocked')),
  provider text not null default 'retell' check (provider = 'retell'),
  provider_call_id text unique check (provider_call_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  provider_agent_id text check (char_length(provider_agent_id) <= 64),
  from_number text check (char_length(from_number) <= 32),
  to_number text check (char_length(to_number) <= 32),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{8,100}$'),
  initiated_by text not null check (initiated_by in ('user', 'ai_agent', 'automation', 'provider')),
  initiated_by_user_id uuid references public.profiles (id) on delete set null,
  correlation_id uuid not null default gen_random_uuid(),
  run_id uuid references public.agent_runs (id) on delete set null,
  provider_attempts integer not null default 0,
  last_provider_error text check (char_length(last_provider_error) <= 300),
  block_reason text check (char_length(block_reason) <= 300),
  requested_at timestamptz not null default now(),
  initiated_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  last_event_at timestamptz,
  duration_seconds integer check (duration_seconds >= 0),
  disconnection_reason text check (char_length(disconnection_reason) <= 60),
  outcome text check (outcome in ('connected', 'no_answer', 'busy', 'voicemail', 'failed', 'opted_out', 'callback_requested', 'unknown')),
  summary text check (char_length(summary) <= 4000),
  provider_analysis jsonb not null default '{}',
  recording_available boolean not null default false,
  transcript_stored boolean not null default false,
  analysis_status text not null default 'not_requested' check (analysis_status in ('not_requested', 'pending', 'succeeded', 'failed', 'skipped')),
  analysis_attempts integer not null default 0,
  analysis_next_at timestamptz,
  analysis jsonb,
  analysis_meta jsonb,
  human_handoff_status text check (human_handoff_status in ('task_created', 'notified')),
  opt_out_detected boolean not null default false,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);
create index voice_calls_org_requested_idx on public.voice_calls (organization_id, requested_at desc);
create index voice_calls_lead_idx on public.voice_calls (lead_id, requested_at desc);
create index voice_calls_contact_idx on public.voice_calls (contact_id, requested_at desc);
create index voice_calls_open_idx on public.voice_calls (status, requested_at) where status in ('initiating', 'dialing', 'in_progress');
create index voice_calls_analysis_idx on public.voice_calls (analysis_status, analysis_next_at) where analysis_status = 'pending';
create trigger voice_calls_updated_at before update on public.voice_calls for each row execute function public.set_updated_at();
create trigger voice_calls_org_immutable before update on public.voice_calls for each row execute function private.prevent_org_change();

-- Transcripts are kept apart from call records: separate permission (calls.recordings) and retention.
create table public.voice_call_transcripts (
  call_id uuid primary key references public.voice_calls (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  transcript text not null check (char_length(transcript) <= 200000),
  retain_until timestamptz not null,
  created_at timestamptz not null default now()
);
create index voice_call_transcripts_retention_idx on public.voice_call_transcripts (retain_until);

-- Webhook ledger: one row per (event, provider call); duplicates are dropped here.
create table public.voice_call_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete restrict,
  call_id uuid references public.voice_calls (id) on delete set null,
  provider text not null default 'retell',
  event_key text not null check (char_length(event_key) <= 200),
  event_type text not null check (char_length(event_type) <= 60),
  result text not null check (result in ('applied', 'ignored', 'unmatched', 'stale')),
  received_at timestamptz not null default now(),
  unique (provider, event_key)
);
create index voice_call_events_call_idx on public.voice_call_events (call_id, received_at);

-- ───────────────────────── RLS ─────────────────────────

alter table public.voice_settings enable row level security;
alter table public.voice_calls enable row level security;
alter table public.voice_call_transcripts enable row level security;
alter table public.voice_call_events enable row level security;
create policy voice_settings_read on public.voice_settings for select to authenticated
  using (public.has_perm(organization_id, 'calls.place') or public.has_perm(organization_id, 'integrations.manage'));
create policy voice_calls_read on public.voice_calls for select to authenticated
  using (public.has_perm(organization_id, 'calls.place') or public.has_perm(organization_id, 'logs.view'));
create policy voice_call_transcripts_read on public.voice_call_transcripts for select to authenticated
  using (public.has_perm(organization_id, 'calls.recordings'));
create policy voice_call_events_read on public.voice_call_events for select to authenticated
  using (public.has_perm(organization_id, 'logs.view'));
revoke all on public.voice_settings, public.voice_calls, public.voice_call_transcripts, public.voice_call_events from anon;
revoke insert, update, delete, truncate on public.voice_settings, public.voice_calls, public.voice_call_transcripts, public.voice_call_events from authenticated;

-- ───────────────────────── helpers ─────────────────────────

create or replace function private.voice_is_terminal(s text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select s in ('completed', 'no_answer', 'busy', 'voicemail', 'failed', 'blocked');
$$;

-- Lifecycle order. Transitions only move forward; terminal states never change.
create or replace function private.voice_rank(s text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case s when 'initiating' then 1 when 'unknown' then 1 when 'dialing' then 2 when 'in_progress' then 3 else 4 end;
$$;

-- The single mapping from Retell's disconnection_reason to our terminal status.
create or replace function private.voice_terminal_status(reason text, connected boolean, in_voicemail boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when in_voicemail or reason = 'voicemail_reached' then 'voicemail'
    when reason in ('dial_no_answer', 'user_declined', 'ivr_reached') then 'no_answer'
    when reason = 'dial_busy' then 'busy'
    when reason in ('dial_failed', 'invalid_destination', 'telephony_provider_permission_denied', 'telephony_provider_unavailable',
                    'sip_routing_error', 'marked_as_spam', 'network_blocked', 'concurrency_limit_reached', 'no_concurrency_fallback',
                    'no_valid_payment', 'credit_exhausted', 'budget_reached', 'scam_detected', 'registered_call_timeout')
         or reason like 'error\_%' then 'failed'
    when connected then 'completed'
    else 'failed'
  end;
$$;

create or replace function private.voice_outcome(status text, reason text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when reason = 'user_requested_dnc' then 'opted_out'
    when reason = 'user_requested_callback' then 'callback_requested'
    when status = 'completed' then 'connected'
    when status in ('no_answer', 'busy', 'voicemail', 'failed') then status
    else 'unknown'
  end;
$$;

-- Deterministic pre-call policy. Every check is evaluated (so the UI can show all reasons), none is optional.
create or replace function private.voice_policy(p_lead uuid, p_at timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l public.leads;
  c public.contacts;
  o public.organizations;
  vs public.voice_settings;
  checks jsonb := '[]';
  local_ts timestamp;
  hr numeric;
  dow int;
  attempts int;
  last_at timestamptz;
  today_count int;
  consent_ok boolean;
  revoked boolean;
  active boolean;
begin
  select * into l from public.leads where id = p_lead;
  select * into o from public.organizations where id = l.organization_id;
  select * into c from public.contacts where id = l.contact_id;
  select * into vs from public.voice_settings where organization_id = l.organization_id;

  local_ts := p_at at time zone coalesce(o.timezone, 'UTC');
  hr := extract(hour from local_ts) + extract(minute from local_ts) / 60.0;
  dow := extract(isodow from local_ts)::int;
  select exists (select 1 from public.communication_consents cc where cc.contact_id = c.id and cc.channel = 'phone' and cc.status in ('revoked', 'denied'))
    into revoked;
  select exists (select 1 from public.communication_consents cc where cc.contact_id = c.id and cc.channel = 'phone' and cc.status = 'granted'
                   and (cc.purpose = 'ai_call' or (coalesce(vs.consent_basis, 'ai_call') = 'phone' and cc.purpose = 'service')))
    into consent_ok;
  select exists (select 1 from public.voice_calls v where v.lead_id = l.id and v.status in ('initiating', 'dialing', 'in_progress')) into active;
  select count(*), max(v.requested_at) into attempts, last_at from public.voice_calls v
    where v.lead_id = l.id and v.direction = 'outbound' and v.status <> 'blocked' and v.requested_at > p_at - interval '24 hours';
  select count(*) into today_count from public.voice_calls v
    where v.organization_id = l.organization_id and v.direction = 'outbound' and v.status <> 'blocked'
      and (v.requested_at at time zone coalesce(o.timezone, 'UTC'))::date = local_ts::date;

  checks := jsonb_build_array(
    jsonb_build_object('key', 'voice_configured', 'label', 'AI calling configured for this agency',
      'ok', coalesce(vs.enabled, false) and vs.outbound_agent_id is not null and vs.from_number is not null and vs.agency_spoken_name is not null,
      'detail', case when vs.organization_id is null or not vs.enabled then 'AI calling is turned off' when vs.outbound_agent_id is null or vs.from_number is null or vs.agency_spoken_name is null then 'Agent, number or agency name missing' else 'Enabled' end),
    jsonb_build_object('key', 'kill_switch', 'label', 'Organization outbound switch',
      'ok', not coalesce((o.settings ->> 'outbound_paused')::boolean, false),
      'detail', case when coalesce((o.settings ->> 'outbound_paused')::boolean, false) then 'All outbound paused' else 'Enabled' end),
    jsonb_build_object('key', 'lead_open', 'label', 'Lead is open', 'ok', l.archived_at is null and l.status not in ('won', 'lost'),
      'detail', case when l.archived_at is not null then 'Archived' when l.status in ('won', 'lost') then 'Closed (' || l.status || ')' else 'Open' end),
    jsonb_build_object('key', 'phone_valid', 'label', 'Valid phone number', 'ok', c.phone_e164 is not null and c.phone_e164 ~ '^\+[1-9][0-9]{6,14}$',
      'detail', case when c.phone_e164 is null then 'No phone on record' else 'E.164 number on record' end),
    jsonb_build_object('key', 'not_suppressed', 'label', 'Not on do-not-contact / phone opt-out', 'ok', c.lifecycle_status <> 'do_not_contact' and not revoked,
      'detail', case when c.lifecycle_status = 'do_not_contact' then 'Contact is on the do-not-contact list' when revoked then 'Phone consent revoked or denied' else 'Not suppressed' end),
    jsonb_build_object('key', 'consent', 'label', case when coalesce(vs.consent_basis, 'ai_call') = 'ai_call' then 'AI-call consent' else 'Phone consent' end,
      'ok', consent_ok, 'detail', case when consent_ok then 'Granted' else 'Not granted — unknown is never treated as permission' end),
    jsonb_build_object('key', 'calling_hours', 'label', 'Calling hours', 'ok',
      hr >= coalesce((o.settings -> 'calling_hours' ->> 'start')::numeric, 9) and hr < coalesce((o.settings -> 'calling_hours' ->> 'end')::numeric, 21)
        and coalesce((o.settings -> 'business_hours' -> 'days') @> to_jsonb(dow), true),
      'detail', format('%s:00–%s:00 %s, days %s', coalesce(o.settings -> 'calling_hours' ->> 'start', '9'), coalesce(o.settings -> 'calling_hours' ->> 'end', '21'), o.timezone, coalesce(o.settings -> 'business_hours' ->> 'days', 'all'))),
    jsonb_build_object('key', 'no_active_call', 'label', 'No call already in progress', 'ok', not active, 'detail', case when active then 'A call to this lead is still in progress' else 'None' end),
    jsonb_build_object('key', 'lead_frequency', 'label', 'Attempt limits for this lead', 'ok',
      attempts < coalesce(vs.max_attempts_per_lead_per_day, 2) and (last_at is null or last_at < p_at - make_interval(mins => coalesce(vs.min_minutes_between_attempts, 240))),
      'detail', format('%s of %s attempts in 24 h; minimum gap %s min', attempts, coalesce(vs.max_attempts_per_lead_per_day, 2), coalesce(vs.min_minutes_between_attempts, 240))),
    jsonb_build_object('key', 'daily_cap', 'label', 'Agency daily call limit', 'ok', today_count < coalesce(vs.max_calls_per_day, 100),
      'detail', format('%s of %s today', today_count, coalesce(vs.max_calls_per_day, 100))));

  return jsonb_build_object('allowed', not exists (select 1 from jsonb_array_elements(checks) x where not (x ->> 'ok')::boolean),
    'checks', checks, 'organization_id', l.organization_id, 'contact_id', c.id, 'to_number', c.phone_e164);
end;
$$;

create or replace function private.voice_run_step(p_call public.voice_calls, p_step text, p_status text, p_detail jsonb default '{}')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.agent_run_steps (organization_id, run_id, step, status, detail)
  select p_call.organization_id, p_call.run_id, p_step, p_status, coalesce(p_detail, '{}') where p_call.run_id is not null;
$$;

create or replace function private.voice_activity(p_call public.voice_calls, kind text, title text, body text, meta jsonb default '{}')
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.activities (organization_id, lead_id, contact_id, activity_type, title, description, source, actor_name, metadata)
  select p_call.organization_id, p_call.lead_id, p_call.contact_id, kind, left(title, 300), left(body, 4000), 'ai', 'Voice Calling Agent',
         coalesce(meta, '{}') || jsonb_build_object('call_id', p_call.id, 'agent', 'voice_calling_agent')
  where p_call.lead_id is not null or p_call.contact_id is not null;
$$;

-- ───────────────────────── user-facing RPCs ─────────────────────────

-- Policy result for the UI. No side effects.
create or replace function public.voice_call_preflight(p_lead uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  org uuid;
  p jsonb;
begin
  select organization_id into org from public.leads where id = p_lead;
  if org is null or not public.has_perm(org, 'leads.view') then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
  if not public.has_perm(org, 'calls.place') then perform private.fail('FORBIDDEN', 'You cannot place calls'); end if;
  p := private.voice_policy(p_lead);
  return jsonb_build_object('allowed', p -> 'allowed', 'checks', p -> 'checks');
end;
$$;

-- Reserves an outbound call (idempotent per key). The Edge Function then dials through Retell.
create or replace function public.voice_call_request(p_lead uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.leads;
  c public.contacts;
  vs public.voice_settings;
  o public.organizations;
  p jsonb;
  v public.voice_calls;
  v_run uuid;
  failed text;
begin
  if coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9_-]{8,100}$' then perform private.fail('VALIDATION_ERROR', 'Invalid idempotency key'); end if;
  select * into l from public.leads where id = p_lead;
  if l.id is null or not public.has_perm(l.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
  if not public.has_perm(l.organization_id, 'calls.place') then perform private.fail('FORBIDDEN', 'You cannot place calls'); end if;

  -- One request at a time per lead, so two clicks cannot both pass "no active call".
  perform pg_advisory_xact_lock(hashtextextended('voice-lead:' || l.id::text, 0));
  select * into v from public.voice_calls where organization_id = l.organization_id and idempotency_key = p_idempotency_key;
  if v.id is not null then
    if v.lead_id is distinct from l.id then perform private.fail('CONFLICT', 'Idempotency key already used for another call'); end if;
    return jsonb_build_object('status', v.status, 'call_id', v.id, 'replayed', true, 'dispatch', v.status = 'initiating' and v.provider_attempts = 0);
  end if;

  p := private.voice_policy(l.id);
  select * into c from public.contacts where id = l.contact_id;
  select * into vs from public.voice_settings where organization_id = l.organization_id;
  select * into o from public.organizations where id = l.organization_id;

  if not (p ->> 'allowed')::boolean then
    select string_agg(x ->> 'label', ', ') into failed from jsonb_array_elements(p -> 'checks') x where not (x ->> 'ok')::boolean;
    insert into public.voice_calls (organization_id, lead_id, contact_id, direction, status, idempotency_key, initiated_by, initiated_by_user_id, block_reason, to_number)
    values (l.organization_id, l.id, c.id, 'outbound', 'blocked', p_idempotency_key, 'user', auth.uid(), left('Blocked: ' || failed, 300), c.phone_e164)
    returning * into v;
    perform private.write_audit(l.organization_id, 'voice_calls.blocked', 'voice_calls', v.id, jsonb_build_object('failed', failed));
    return jsonb_build_object('status', 'blocked', 'call_id', v.id, 'checks', p -> 'checks', 'reason', failed);
  end if;

  insert into public.voice_calls (organization_id, lead_id, contact_id, direction, status, provider_agent_id, from_number, to_number,
    idempotency_key, initiated_by, initiated_by_user_id)
  values (l.organization_id, l.id, c.id, 'outbound', 'initiating', vs.outbound_agent_id, vs.from_number, c.phone_e164,
    p_idempotency_key, 'user', auth.uid())
  returning * into v;
  insert into public.agent_runs (organization_id, agent_id, agent_version, trigger_event, source_kind, provider, external_event_id, idempotency_key,
    correlation_id, status, attempt_count, lead_id, contact_id, started_at, input)
  values (l.organization_id, 'voice_calling_agent', '1.0.0', 'voice_call.requested', 'manual', 'retell', v.id::text, 'call:' || v.id::text,
    v.correlation_id, 'received', 1, l.id, c.id, now(), jsonb_build_object('direction', 'outbound', 'call_id', v.id))
  returning id into v_run;
  update public.voice_calls set run_id = v_run where id = v.id returning * into v;
  perform private.voice_run_step(v, 'policy', 'ok', jsonb_build_object('checks', jsonb_array_length(p -> 'checks')));
  perform private.write_audit(l.organization_id, 'voice_calls.requested', 'voice_calls', v.id, jsonb_build_object('lead', l.id));
  return jsonb_build_object('status', 'initiating', 'call_id', v.id, 'dispatch', true);
end;
$$;

-- Records explicit consent to AI calls (purpose 'ai_call'), captured by staff.
create or replace function public.set_ai_call_consent(p_contact uuid, p_status text, p_source text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
begin
  select organization_id into org from public.contacts where id = p_contact;
  if org is null or not public.has_perm(org, 'leads.view') then perform private.fail('NOT_FOUND', 'Contact not found'); end if;
  if not public.has_perm(org, 'contacts.edit') then perform private.fail('FORBIDDEN', 'You cannot change consent'); end if;
  if p_status not in ('granted', 'revoked', 'denied') then perform private.fail('VALIDATION_ERROR', 'Invalid consent status'); end if;
  if char_length(trim(coalesce(p_source, ''))) not between 3 and 80 then perform private.fail('VALIDATION_ERROR', 'Say how the consent was captured'); end if;
  if p_status = 'granted' and exists (select 1 from public.contacts where id = p_contact and lifecycle_status = 'do_not_contact') then
    perform private.fail('FORBIDDEN', 'This contact is on the do-not-contact list');
  end if;
  if p_status = 'granted' and exists (select 1 from public.communication_consents where contact_id = p_contact and channel = 'phone' and status in ('revoked', 'denied') and purpose <> 'ai_call') then
    perform private.fail('FORBIDDEN', 'Phone contact was revoked; the person must re-consent to phone contact first');
  end if;
  insert into public.communication_consents (organization_id, contact_id, channel, purpose, status, captured_via)
  values (org, p_contact, 'phone', 'ai_call', p_status, left(trim(p_source), 80))
  on conflict (contact_id, channel, purpose) do update set status = excluded.status, captured_via = excluded.captured_via;
  perform private.write_audit(org, 'consents.ai_call_' || p_status, 'contacts', p_contact, '{}');
end;
$$;

create or replace function public.voice_settings_save(p_org uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_perm(p_org, 'integrations.manage') then perform private.fail('FORBIDDEN', 'You cannot manage integrations'); end if;
  if jsonb_typeof(p) is distinct from 'object' then perform private.fail('VALIDATION_ERROR', 'Invalid settings'); end if;
  begin
    insert into public.voice_settings (organization_id, enabled, outbound_agent_id, inbound_agent_id, from_number, agency_spoken_name, consent_basis,
      store_transcripts, analysis_enabled, recording_access, transcript_retention_days, max_attempts_per_lead_per_day, min_minutes_between_attempts,
      max_calls_per_day, updated_by)
    values (p_org, coalesce((p ->> 'enabled')::boolean, false), nullif(trim(p ->> 'outbound_agent_id'), ''), nullif(trim(p ->> 'inbound_agent_id'), ''),
      nullif(trim(p ->> 'from_number'), ''), nullif(trim(p ->> 'agency_spoken_name'), ''), coalesce(p ->> 'consent_basis', 'ai_call'),
      coalesce((p ->> 'store_transcripts')::boolean, false), coalesce((p ->> 'analysis_enabled')::boolean, false), coalesce((p ->> 'recording_access')::boolean, false),
      coalesce((p ->> 'transcript_retention_days')::int, 90), coalesce((p ->> 'max_attempts_per_lead_per_day')::int, 2),
      coalesce((p ->> 'min_minutes_between_attempts')::int, 240), coalesce((p ->> 'max_calls_per_day')::int, 100), auth.uid())
    on conflict (organization_id) do update set enabled = excluded.enabled, outbound_agent_id = excluded.outbound_agent_id,
      inbound_agent_id = excluded.inbound_agent_id, from_number = excluded.from_number, agency_spoken_name = excluded.agency_spoken_name,
      consent_basis = excluded.consent_basis, store_transcripts = excluded.store_transcripts, analysis_enabled = excluded.analysis_enabled,
      recording_access = excluded.recording_access, transcript_retention_days = excluded.transcript_retention_days,
      max_attempts_per_lead_per_day = excluded.max_attempts_per_lead_per_day, min_minutes_between_attempts = excluded.min_minutes_between_attempts,
      max_calls_per_day = excluded.max_calls_per_day, updated_by = excluded.updated_by;
  exception
    when unique_violation then perform private.fail('CONFLICT', 'That Retell agent is already linked to another workspace');
    when check_violation or invalid_text_representation then perform private.fail('VALIDATION_ERROR', 'One or more voice settings are invalid');
  end;
  if coalesce((p ->> 'enabled')::boolean, false) and exists (select 1 from public.voice_settings where organization_id = p_org
      and (outbound_agent_id is null or from_number is null or agency_spoken_name is null)) then
    perform private.fail('VALIDATION_ERROR', 'Agent id, calling number and spoken agency name are required to enable AI calling');
  end if;
end;
$$;

-- Recording access check (recordings are never stored as URLs; the Edge Function fetches a link per request).
create or replace function public.voice_call_recording_access(p_call uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.voice_calls;
begin
  select * into v from public.voice_calls where id = p_call;
  if v.id is null or not (public.has_perm(v.organization_id, 'calls.place') or public.has_perm(v.organization_id, 'logs.view')) then
    perform private.fail('NOT_FOUND', 'Call not found');
  end if;
  if not public.has_perm(v.organization_id, 'calls.recordings') then perform private.fail('FORBIDDEN', 'You cannot access call recordings'); end if;
  if not coalesce((select recording_access from public.voice_settings where organization_id = v.organization_id), false) then
    perform private.fail('FORBIDDEN', 'Recording access is turned off for this agency');
  end if;
  if not v.recording_available or v.provider_call_id is null then perform private.fail('NOT_FOUND', 'No recording for this call'); end if;
  perform private.write_audit(v.organization_id, 'voice_calls.recording_accessed', 'voice_calls', v.id, '{}');
  return v.provider_call_id;
end;
$$;

-- ───────────────────────── dispatch (service role) ─────────────────────────

-- What the Edge Function needs to dial. Records a provider attempt BEFORE the HTTP request,
-- so a crash mid-request is visible and reconcilable.
create or replace function public.voice_call_dispatch(p_call uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.voice_calls;
  vs public.voice_settings;
  l public.leads;
  c public.contacts;
  o public.organizations;
begin
  select * into v from public.voice_calls where id = p_call for update;
  if v.id is null then perform private.fail('NOT_FOUND', 'Call not found'); end if;
  if v.status <> 'initiating' then return jsonb_build_object('dispatch', false, 'status', v.status); end if;
  if v.requested_at < now() - interval '55 minutes' then
    -- Retell honours an idempotency key for one hour; past that a re-send could dial twice.
    update public.voice_calls set status = 'unknown', outcome = 'unknown',
      last_provider_error = 'Initiation outcome unknown; not retried to avoid a duplicate call' where id = v.id returning * into v;
    perform private.voice_run_step(v, 'dispatch', 'failed', jsonb_build_object('reason', 'idempotency_window_expired'));
    return jsonb_build_object('dispatch', false, 'status', 'unknown');
  end if;
  select * into vs from public.voice_settings where organization_id = v.organization_id;
  if not coalesce(vs.enabled, false) or (select coalesce((settings ->> 'outbound_paused')::boolean, false) from public.organizations where id = v.organization_id) then
    update public.voice_calls set status = 'blocked', block_reason = 'AI calling disabled or outbound paused before dialing' where id = v.id and provider_attempts = 0 returning * into v;
    if v.status = 'blocked' then return jsonb_build_object('dispatch', false, 'status', 'blocked'); end if;
  end if;
  update public.voice_calls set provider_attempts = provider_attempts + 1 where id = v.id returning * into v;
  select * into l from public.leads where id = v.lead_id;
  select * into c from public.contacts where id = v.contact_id;
  select * into o from public.organizations where id = v.organization_id;
  perform private.voice_run_step(v, 'dispatch', 'ok', jsonb_build_object('attempt', v.provider_attempts));
  -- Minimal context for the voice agent: agency, first name, and what is already known (so it is not asked again).
  return jsonb_build_object('dispatch', true, 'status', v.status, 'call_id', v.id, 'idempotency_key', v.id::text,
    'from_number', v.from_number, 'to_number', v.to_number, 'agent_id', v.provider_agent_id,
    'dynamic_variables', jsonb_build_object(
      'agency_name', vs.agency_spoken_name,
      'customer_first_name', coalesce(split_part(nullif(c.display_name, 'Unnamed enquiry'), ' ', 1), ''),
      'known_intent', coalesce(l.desired_transaction, ''),
      'known_locations', array_to_string(l.desired_locations, ', '),
      'known_budget', case when l.budget_max is not null then l.budget_currency || ' ' || l.budget_max::bigint::text else '' end,
      'known_property_type', coalesce(l.desired_property_type, ''),
      'known_bedrooms', coalesce(l.bedrooms::text, ''),
      'known_timeline', coalesce(l.timeline, '')));
end;
$$;

create or replace function public.voice_call_mark_initiated(p_call uuid, p_provider_call_id text, p_agent_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.voice_calls;
begin
  if coalesce(p_provider_call_id, '') !~ '^[A-Za-z0-9_-]{8,128}$' then perform private.fail('VALIDATION_ERROR', 'Invalid provider call id'); end if;
  select * into v from public.voice_calls where id = p_call for update;
  if v.id is null then perform private.fail('NOT_FOUND', 'Call not found'); end if;
  if v.provider_call_id is not null and v.provider_call_id <> p_provider_call_id then perform private.fail('CONFLICT', 'Call already linked to another provider call'); end if;
  update public.voice_calls set provider_call_id = p_provider_call_id, provider_agent_id = coalesce(left(p_agent_id, 64), provider_agent_id),
    initiated_at = coalesce(initiated_at, now()), last_provider_error = null,
    status = case when status in ('initiating', 'unknown') then 'dialing' else status end
  where id = v.id returning * into v;
  perform private.voice_run_step(v, 'provider_accepted', 'ok', jsonb_build_object('status', v.status));
end;
$$;

-- p_permanent: the provider definitively refused (4xx). Otherwise the outcome is ambiguous and the worker reconciles.
create or replace function public.voice_call_mark_failed(p_call uuid, p_error text, p_permanent boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.voice_calls;
begin
  select * into v from public.voice_calls where id = p_call for update;
  if v.id is null then perform private.fail('NOT_FOUND', 'Call not found'); end if;
  if v.status <> 'initiating' then return; end if;
  if p_permanent then
    update public.voice_calls set status = 'failed', outcome = 'failed', ended_at = now(), last_provider_error = left(p_error, 300),
      analysis_status = 'skipped' where id = v.id returning * into v;
    perform private.voice_run_step(v, 'dispatch', 'failed', jsonb_build_object('error', left(p_error, 120), 'permanent', true));
    perform private.voice_activity(v, 'call', 'AI call could not be placed', left(p_error, 300));
    perform private.voice_call_finalize(v.id);
  else
    update public.voice_calls set last_provider_error = left(p_error, 300) where id = v.id returning * into v;
    perform private.voice_run_step(v, 'dispatch', 'warning', jsonb_build_object('error', left(p_error, 120), 'permanent', false));
  end if;
end;
$$;

-- ───────────────────────── opt-out & handoff ─────────────────────────

create or replace function private.voice_apply_opt_out(p_call uuid, p_source text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.voice_calls;
  pur text;
begin
  select * into v from public.voice_calls where id = p_call for update;
  if v.contact_id is null or v.opt_out_detected then
    update public.voice_calls set opt_out_detected = true where id = p_call;
    return;
  end if;
  -- Phone contact for every purpose; future calls are blocked by voice_policy. Other channels follow their own consent.
  foreach pur in array array['service', 'ai_call', 'marketing', 'appointment_reminder'] loop
    insert into public.communication_consents (organization_id, contact_id, channel, purpose, status, captured_via)
    values (v.organization_id, v.contact_id, 'phone', pur, 'revoked', left('Voice call opt-out (' || p_source || ')', 80))
    on conflict (contact_id, channel, purpose) do update set status = 'revoked', captured_via = excluded.captured_via
    where public.communication_consents.status <> 'revoked';
  end loop;
  update public.voice_calls set opt_out_detected = true, outcome = 'opted_out' where id = v.id returning * into v;
  perform private.voice_run_step(v, 'opt_out', 'ok', jsonb_build_object('source', p_source));
  perform private.write_audit(v.organization_id, 'consents.phone_opt_out', 'contacts', v.contact_id, jsonb_build_object('call', v.id, 'source', p_source));
  perform private.emit_event(v.organization_id, 'lead.communication_opted_out', 'contact', v.contact_id, v.correlation_id,
    jsonb_build_object('contact_id', v.contact_id, 'lead_id', v.lead_id, 'channel', 'phone', 'source', p_source, 'call_id', v.id), null,
    'opted_out:' || v.id::text);
end;
$$;

create or replace function private.voice_request_handoff(p_call uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.voice_calls;
  owner uuid;
  who text;
  m record;
begin
  select * into v from public.voice_calls where id = p_call for update;
  if v.human_handoff_status is not null or v.opt_out_detected then return; end if;
  select l.assigned_to into owner from public.leads l where l.id = v.lead_id;
  if not private.intake_eligible(v.organization_id, owner) then owner := null; end if;
  select display_name into who from public.contacts where id = v.contact_id;
  if v.lead_id is not null then
    insert into public.tasks (organization_id, title, description, priority, due_at, assigned_to, related_lead_id, source)
    values (v.organization_id, left('Call back ' || coalesce(who, 'caller') || ' (requested on AI call)', 200),
      case p_kind when 'human_requested' then 'Asked to speak with a person during the AI call.' else 'Asked for a call back during the AI call.' end,
      'high', now() + interval '2 hours', owner, v.lead_id, 'ai');
    update public.voice_calls set human_handoff_status = 'task_created', outcome = coalesce(nullif(outcome, 'connected'), 'callback_requested') where id = v.id;
  else
    update public.voice_calls set human_handoff_status = 'notified' where id = v.id;
  end if;
  if owner is null then
    for m in select mm.user_id from public.organization_memberships mm where mm.organization_id = v.organization_id and mm.status = 'active'
             and mm.role in (select rp.role from public.role_permissions rp where rp.permission = 'leads.assign') loop
      perform private.notify(v.organization_id, m.user_id, 'lead', 'Call-back requested: ' || coalesce(who, 'caller'), 'Asked for a person on an AI call', 'calls', 'lead', v.lead_id, 'voice_handoff:' || v.id::text);
    end loop;
  end if;
  perform private.voice_run_step(v, 'handoff', 'ok', jsonb_build_object('kind', p_kind, 'task', v.lead_id is not null));
  perform private.emit_event(v.organization_id, 'voice_call.human_handoff_requested', 'voice_call', v.id, v.correlation_id,
    jsonb_build_object('call_id', v.id, 'lead_id', v.lead_id, 'kind', p_kind), null, 'voice_handoff:' || v.id::text);
end;
$$;

-- ───────────────────────── finalize & Agent 3 handoff ─────────────────────────

create or replace function private.voice_call_finalize(p_call uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.voice_calls;
  rec jsonb;
  res jsonb;
  ph text;
begin
  select * into v from public.voice_calls where id = p_call for update;
  if v.id is null or v.finalized_at is not null or v.status = 'blocked' or not private.voice_is_terminal(v.status)
     or v.analysis_status in ('not_requested', 'pending') then
    return;
  end if;

  -- Inbound call from an unknown number: hand it to the Lead Intake Agent (Agent 01) to create the lead.
  if v.direction = 'inbound' and v.lead_id is null and v.status = 'completed' and not v.opt_out_detected
     and private.intake_phone(v.from_number, 'XX') is not null then
    ph := v.from_number;
    rec := public.intake_receive(v.organization_id, 'voice', 'retell', v.provider_call_id,
      jsonb_strip_nulls(jsonb_build_object('phone', ph, 'source', 'Inbound call', 'message', left(v.summary, 4000),
        'intent', v.analysis ->> 'intent', 'locations', v.analysis -> 'preferred_locations', 'budget_min', v.analysis -> 'budget_min',
        'budget_max', v.analysis -> 'budget_max', 'currency', v.analysis ->> 'currency', 'property_type', v.analysis ->> 'property_type',
        'bedrooms', v.analysis -> 'bedrooms', 'timeline', v.analysis ->> 'timeline')),
      'call.lead_created');
    if rec ->> 'status' = 'received' then
      res := public.intake_process((rec ->> 'run_id')::uuid);
    else
      res := rec;
    end if;
    if res ->> 'lead_id' is not null then
      update public.voice_calls set lead_id = (res ->> 'lead_id')::uuid,
        contact_id = (select contact_id from public.leads where id = (res ->> 'lead_id')::uuid) where id = v.id returning * into v;
      perform private.voice_activity(v, 'call', 'Inbound AI call', v.summary);
    end if;
  end if;

  update public.voice_calls set finalized_at = now() where id = v.id returning * into v;
  update public.agent_runs set status = 'succeeded', lead_id = coalesce(lead_id, v.lead_id), contact_id = coalesce(contact_id, v.contact_id),
    completed_at = now(), duration_ms = (extract(epoch from now() - started_at) * 1000)::int,
    outcome = jsonb_build_object('action', v.outcome, 'call_status', v.status, 'analysis', v.analysis_status, 'handoff', v.human_handoff_status, 'opt_out', v.opt_out_detected),
    input = jsonb_build_object('redacted', true)
  where id = v.run_id;
  perform private.voice_run_step(v, 'finalize', 'ok', jsonb_build_object('outcome', v.outcome));
  if v.lead_id is not null then
    perform private.emit_event(v.organization_id, 'voice_call.completed', 'voice_call', v.id, v.correlation_id,
      jsonb_build_object('event_type', 'voice_call.completed', 'schema_version', 1, 'organization_id', v.organization_id, 'lead_id', v.lead_id,
        'call_id', v.id, 'provider_call_id', v.provider_call_id, 'correlation_id', v.correlation_id, 'occurred_at', coalesce(v.ended_at, now()),
        'direction', v.direction, 'outcome', v.outcome, 'analysis_status', v.analysis_status,
        'requires', to_jsonb(array_remove(array[
          case when v.human_handoff_status is not null then 'human_callback' end,
          case when v.opt_out_detected then 'phone_opt_out' end,
          case when v.analysis -> 'conflicts' is not null and jsonb_array_length(v.analysis -> 'conflicts') > 0 then 'review_conflicts' end], null))),
      'sales_qualification_agent', 'voice_call_completed:' || v.id::text);
  end if;
end;
$$;

-- ───────────────────────── webhook ingestion (service role) ─────────────────────────

-- One verified Retell event. Tenant comes from our stored call (or the org owning the inbound agent), never from metadata.
create or replace function public.voice_webhook_ingest(p_event text, p_call jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pcid text := p_call ->> 'call_id';
  v public.voice_calls;
  vs public.voice_settings;
  hint uuid;
  ev_id uuid;
  reason text := left(p_call ->> 'disconnection_reason', 60);
  started timestamptz;
  ended timestamptz;
  dur int;
  new_status text;
  was_terminal boolean;
  in_vm boolean := coalesce((p_call -> 'call_analysis' ->> 'in_voicemail')::boolean, false);
  c_id uuid;
  ld uuid;
  lead_row public.leads;
  needs_analysis boolean := false;
  tr text;
begin
  if coalesce(pcid, '') !~ '^[A-Za-z0-9_-]{8,128}$' or coalesce(p_event, '') !~ '^[a-z_]{3,40}$' then
    perform private.fail('VALIDATION_ERROR', 'Invalid webhook payload');
  end if;

  select * into v from public.voice_calls where provider = 'retell' and provider_call_id = pcid for update;
  if v.id is null then
    -- Race: Retell can call back before our mark_initiated commits. The metadata id is only a hint; it must match the
    -- reserved call's number and agent, and that call must not be linked to another provider call yet.
    hint := case when (p_call -> 'metadata' ->> 'voice_call_id') ~ '^[0-9a-f-]{36}$' then (p_call -> 'metadata' ->> 'voice_call_id')::uuid end;
    if hint is not null then
      select * into v from public.voice_calls where id = hint and provider_call_id is null and status in ('initiating', 'unknown')
        and direction = 'outbound' and to_number = p_call ->> 'to_number' and provider_agent_id = p_call ->> 'agent_id' for update;
      if v.id is not null then
        update public.voice_calls set provider_call_id = pcid, initiated_at = coalesce(initiated_at, now()), status = 'dialing' where id = v.id returning * into v;
      end if;
    end if;
  end if;
  if v.id is null and p_call ->> 'direction' = 'inbound' and coalesce(p_call ->> 'agent_id', '') <> '' then
    select * into vs from public.voice_settings where inbound_agent_id = p_call ->> 'agent_id' and enabled;
    if vs.organization_id is not null then
      -- Caller matched only when exactly one contact in this org has the number.
      select (array_agg(x.id))[1] into c_id from public.contacts x
      where x.organization_id = vs.organization_id and x.phone_e164 = p_call ->> 'from_number' having count(*) = 1;
      if c_id is not null then
        select id into ld from public.leads where contact_id = c_id and archived_at is null and status not in ('won', 'lost') order by created_at desc limit 1;
      end if;
      insert into public.voice_calls (organization_id, lead_id, contact_id, direction, status, provider_call_id, provider_agent_id, from_number, to_number,
        idempotency_key, initiated_by, initiated_at)
      values (vs.organization_id, ld, c_id, 'inbound', 'dialing', pcid, left(p_call ->> 'agent_id', 64), left(p_call ->> 'from_number', 32),
        left(p_call ->> 'to_number', 32), 'in_' || pcid, 'provider', now())
      on conflict (organization_id, idempotency_key) do nothing
      returning * into v;
      if v.id is null then select * into v from public.voice_calls where provider_call_id = pcid for update; end if;
      if v.run_id is null then
        insert into public.agent_runs (organization_id, agent_id, agent_version, trigger_event, source_kind, provider, external_event_id, idempotency_key,
          correlation_id, status, attempt_count, lead_id, contact_id, started_at, input)
        values (v.organization_id, 'voice_calling_agent', '1.0.0', 'voice_call.inbound', 'voice', 'retell', pcid, 'call:' || v.id::text,
          v.correlation_id, 'received', 1, v.lead_id, v.contact_id, now(), jsonb_build_object('direction', 'inbound'))
        on conflict (organization_id, agent_id, idempotency_key) do nothing;
        update public.voice_calls set run_id = (select id from public.agent_runs where organization_id = v.organization_id and agent_id = 'voice_calling_agent' and idempotency_key = 'call:' || v.id::text)
        where id = v.id returning * into v;
      end if;
    end if;
  end if;

  if v.id is null then
    insert into public.voice_call_events (provider, event_key, event_type, result) values ('retell', p_event || ':' || pcid, p_event, 'unmatched')
    on conflict (provider, event_key) do nothing;
    return jsonb_build_object('result', 'unmatched');
  end if;

  insert into public.voice_call_events (organization_id, call_id, provider, event_key, event_type, result)
  values (v.organization_id, v.id, 'retell', p_event || ':' || pcid, p_event,
          case when p_event in ('call_started', 'call_ended', 'call_analyzed') then 'applied' else 'ignored' end)
  on conflict (provider, event_key) do nothing
  returning id into ev_id;
  if ev_id is null then return jsonb_build_object('result', 'duplicate', 'call_id', v.id); end if;
  if p_event not in ('call_started', 'call_ended', 'call_analyzed') then
    return jsonb_build_object('result', 'ignored', 'call_id', v.id);
  end if;

  select * into vs from public.voice_settings where organization_id = v.organization_id;
  was_terminal := private.voice_is_terminal(v.status);
  started := case when (p_call ->> 'start_timestamp') ~ '^[0-9]{10,14}$' then to_timestamp((p_call ->> 'start_timestamp')::bigint / 1000.0) end;
  ended := case when (p_call ->> 'end_timestamp') ~ '^[0-9]{10,14}$' then to_timestamp((p_call ->> 'end_timestamp')::bigint / 1000.0) end;
  dur := case when (p_call ->> 'duration_ms') ~ '^[0-9]{1,10}$' then round((p_call ->> 'duration_ms')::bigint / 1000.0)::int
              when started is not null and ended is not null then greatest(0, extract(epoch from ended - started)::int) end;

  update public.voice_calls set last_event_at = now(), started_at = coalesce(started_at, started) where id = v.id returning * into v;

  if p_event = 'call_started' then
    if private.voice_rank(v.status) < 3 then
      update public.voice_calls set status = 'in_progress' where id = v.id returning * into v;
    else
      update public.voice_call_events set result = 'stale' where id = ev_id;
    end if;
    perform private.voice_run_step(v, 'call_started', 'ok', '{}');
    return jsonb_build_object('result', 'applied', 'call_id', v.id);
  end if;

  -- call_ended / call_analyzed: both carry the terminal facts; whichever arrives first sets them (call_analyzed may arrive alone).
  if not was_terminal and (reason is not null or p_event = 'call_ended' or p_call ->> 'call_status' in ('ended', 'error', 'not_connected')) then
    new_status := private.voice_terminal_status(reason, started is not null or v.started_at is not null, in_vm);
    update public.voice_calls set status = new_status, outcome = private.voice_outcome(new_status, reason),
      disconnection_reason = reason, ended_at = coalesce(ended, now()), duration_seconds = dur,
      recording_available = coalesce(p_call ->> 'recording_url', '') <> ''
    where id = v.id returning * into v;
    perform private.voice_run_step(v, 'call_ended', 'ok', jsonb_build_object('status', new_status, 'reason', reason));

    tr := left(p_call ->> 'transcript', 200000);
    if coalesce(vs.store_transcripts, false) and coalesce(tr, '') <> '' then
      insert into public.voice_call_transcripts (call_id, organization_id, transcript, retain_until)
      values (v.id, v.organization_id, tr, now() + make_interval(days => vs.transcript_retention_days))
      on conflict (call_id) do nothing;
      update public.voice_calls set transcript_stored = true where id = v.id returning * into v;
    end if;

    -- CRM effects happen exactly once, on the transition into a terminal state.
    if v.lead_id is not null then
      select * into lead_row from public.leads where id = v.lead_id;
      update public.leads set
        last_contact_at = case when v.status = 'completed' then now() else last_contact_at end,
        status = case
          when v.status = 'completed' and status in ('new', 'attempting') then 'contacted'
          when v.status in ('no_answer', 'busy', 'voicemail') and status = 'new' then 'attempting'
          else status end
      where id = v.lead_id and archived_at is null;
    end if;
    if v.contact_id is not null and v.status = 'completed' then
      update public.contacts set last_contacted_at = now() where id = v.contact_id;
    end if;
    perform private.voice_activity(v, 'call',
      case v.status when 'completed' then 'AI call completed' when 'no_answer' then 'AI call — no answer' when 'busy' then 'AI call — line busy'
        when 'voicemail' then 'AI call — reached voicemail' else 'AI call failed' end
        || case when v.duration_seconds is not null and v.status = 'completed' then format(' (%s:%s)', v.duration_seconds / 60, lpad((v.duration_seconds % 60)::text, 2, '0')) else '' end,
      null, jsonb_build_object('direction', v.direction, 'reason', reason));

    if reason = 'user_requested_dnc' then perform private.voice_apply_opt_out(v.id, 'caller_request'); end if;
    if reason = 'user_requested_callback' then perform private.voice_request_handoff(v.id, 'callback_requested'); end if;
    select * into v from public.voice_calls where id = v.id;
  elsif was_terminal and p_event = 'call_ended' then
    update public.voice_call_events set result = 'stale' where id = ev_id;
  end if;

  if p_event = 'call_analyzed' then
    update public.voice_calls set
      summary = coalesce(left(p_call -> 'call_analysis' ->> 'call_summary', 4000), summary),
      provider_analysis = jsonb_strip_nulls(jsonb_build_object(
        'call_successful', p_call -> 'call_analysis' -> 'call_successful', 'in_voicemail', p_call -> 'call_analysis' -> 'in_voicemail',
        'user_sentiment', left(p_call -> 'call_analysis' ->> 'user_sentiment', 20))),
      analysis_status = case
        when analysis_status <> 'not_requested' then analysis_status
        when status = 'completed' and coalesce(vs.analysis_enabled, false) and transcript_stored then 'pending'
        else 'skipped' end,
      analysis_next_at = case when analysis_status = 'not_requested' then now() else analysis_next_at end
    where id = v.id returning * into v;
    if v.summary is not null and v.lead_id is not null then
      perform private.voice_activity(v, 'ai_update', 'Call summary', v.summary);
    end if;
    needs_analysis := v.analysis_status = 'pending';
    perform private.voice_call_finalize(v.id);
  end if;

  return jsonb_build_object('result', 'applied', 'call_id', v.id, 'needs_analysis', needs_analysis);
end;
$$;

-- ───────────────────────── post-call analysis (service role) ─────────────────────────

-- Leases pending analyses to the worker; returns only what the model needs.
create or replace function public.voice_analysis_claim(p_limit int default 5)
returns table (call_id uuid, transcript text, currency text, country text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with picked as (
    select v.id from public.voice_calls v
    where v.analysis_status = 'pending' and (v.analysis_next_at is null or v.analysis_next_at <= now())
    order by v.ended_at nulls last
    limit least(greatest(p_limit, 1), 20)
    for update skip locked
  ), leased as (
    update public.voice_calls v set analysis_attempts = v.analysis_attempts + 1, analysis_next_at = now() + interval '10 minutes'
    from picked where v.id = picked.id
    returning v.id, v.organization_id
  )
  select leased.id, t.transcript, o.default_currency::text, o.country_code::text
  from leased join public.voice_call_transcripts t on t.call_id = leased.id
  join public.organizations o on o.id = leased.organization_id;
end;
$$;

-- Applies a validated analysis. Lead fields are only filled when empty; differing values become conflicts for review.
create or replace function public.voice_analysis_complete(p_call uuid, p_ok boolean, p_result jsonb, p_meta jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.voice_calls;
  l public.leads;
  o public.organizations;
  n jsonb;
  conflicts text[] := '{}';
  filled text[] := '{}';
  meta jsonb;
  res jsonb;
begin
  select * into v from public.voice_calls where id = p_call for update;
  if v.id is null then perform private.fail('NOT_FOUND', 'Call not found'); end if;
  if v.analysis_status <> 'pending' then return v.analysis_status; end if;
  meta := (select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each(case when jsonb_typeof(p_meta) = 'object' then p_meta else '{}' end)
           where key in ('model', 'prompt_version', 'latency_ms', 'input_tokens', 'output_tokens', 'outcome') and jsonb_typeof(value) in ('string', 'number'));

  if not p_ok or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text) > 16384 then
    if v.analysis_attempts >= 3 then
      update public.voice_calls set analysis_status = 'failed', analysis_meta = meta, analysis_next_at = null where id = v.id returning * into v;
      perform private.voice_run_step(v, 'analysis', 'failed', jsonb_build_object('attempts', v.analysis_attempts, 'outcome', meta ->> 'outcome'));
      perform private.voice_call_finalize(v.id);
      return 'failed';
    end if;
    update public.voice_calls set analysis_meta = meta, analysis_next_at = now() + make_interval(mins => power(2, v.analysis_attempts)::int) where id = v.id;
    return 'retry_scheduled';
  end if;

  select * into o from public.organizations where id = v.organization_id;
  -- Same normalization as intake: enums, ranges, budget order, currency.
  n := private.intake_normalize(jsonb_strip_nulls(jsonb_build_object('email', 'x@x.invalid', 'intent', p_result ->> 'intent', 'locations', p_result -> 'preferred_locations',
         'budget_min', p_result -> 'budget_min', 'budget_max', p_result -> 'budget_max', 'currency', p_result ->> 'currency',
         'property_type', p_result ->> 'property_type', 'bedrooms', p_result -> 'bedrooms', 'timeline', p_result ->> 'timeline')),
       o.country_code, o.default_currency, 'Voice call');

  if v.lead_id is not null then
    select * into l from public.leads where id = v.lead_id for update;
    if n ->> 'budget_max' is not null then
      if l.budget_max is null and l.budget_min is null and l.budget_currency = n ->> 'currency' then filled := filled || 'budget'::text;
      elsif l.budget_max is distinct from (n ->> 'budget_max')::numeric or l.budget_currency <> n ->> 'currency' then conflicts := conflicts || 'budget'::text; end if;
    end if;
    if n ->> 'property_type' is not null then
      if l.desired_property_type is null then filled := filled || 'propertyType'::text; elsif l.desired_property_type <> n ->> 'property_type' then conflicts := conflicts || 'property_type'::text; end if;
    end if;
    if n ->> 'bedrooms' is not null then
      if l.bedrooms is null then filled := filled || 'bedrooms'::text; elsif l.bedrooms <> (n ->> 'bedrooms')::int then conflicts := conflicts || 'bedrooms'::text; end if;
    end if;
    if n ->> 'timeline' is not null then
      if l.timeline is null then filled := filled || 'timeline'::text; elsif l.timeline <> n ->> 'timeline' then conflicts := conflicts || 'timeline'::text; end if;
    end if;
    if jsonb_array_length(n -> 'locations') > 0 then
      if cardinality(l.desired_locations) = 0 then filled := filled || 'locations'::text;
      elsif not (array(select jsonb_array_elements_text(n -> 'locations')) <@ l.desired_locations) then conflicts := conflicts || 'locations'::text; end if;
    end if;
    update public.leads set
      budget_min = case when 'budget' = any (filled) then (n ->> 'budget_min')::numeric else budget_min end,
      budget_max = case when 'budget' = any (filled) then (n ->> 'budget_max')::numeric else budget_max end,
      desired_property_type = case when 'propertyType' = any (filled) then n ->> 'property_type' else desired_property_type end,
      bedrooms = case when 'bedrooms' = any (filled) then (n ->> 'bedrooms')::smallint else bedrooms end,
      timeline = case when 'timeline' = any (filled) then n ->> 'timeline' else timeline end,
      desired_locations = case when 'locations' = any (filled) then array(select jsonb_array_elements_text(n -> 'locations')) else desired_locations end,
      ai_extracted_fields = array(select distinct x from unnest(ai_extracted_fields || filled) x)
    where id = l.id and cardinality(filled) > 0;
  end if;

  res := jsonb_strip_nulls(jsonb_build_object(
    'call_outcome', left(p_result ->> 'call_outcome', 40), 'intent', n ->> 'intent', 'preferred_locations', n -> 'locations',
    'budget_min', n -> 'budget_min', 'budget_max', n -> 'budget_max', 'currency', case when n ->> 'budget_max' is not null or n ->> 'budget_min' is not null then n ->> 'currency' end,
    'property_type', n ->> 'property_type', 'bedrooms', n -> 'bedrooms', 'timeline', n ->> 'timeline',
    'human_requested', coalesce((p_result ->> 'human_requested')::boolean, false), 'callback_requested', coalesce((p_result ->> 'callback_requested')::boolean, false),
    'opt_out_detected', coalesce((p_result ->> 'opt_out_detected')::boolean, false),
    'unanswered_questions', (select coalesce(jsonb_agg(left(x, 200)), '[]') from jsonb_array_elements_text(case when jsonb_typeof(p_result -> 'unanswered_questions') = 'array' then p_result -> 'unanswered_questions' else '[]' end) with ordinality t(x, i) where i <= 5),
    'next_recommended_action', left(p_result ->> 'next_recommended_action', 40),
    'summary', left(p_result ->> 'conversation_summary', 1500),
    'filled', to_jsonb(filled), 'conflicts', to_jsonb(conflicts), 'warnings', n -> 'warnings'));
  update public.voice_calls set analysis_status = 'succeeded', analysis = res, analysis_meta = meta, analysis_next_at = null,
    summary = coalesce(summary, res ->> 'summary') where id = v.id returning * into v;
  perform private.voice_run_step(v, 'analysis', 'ok', jsonb_build_object('filled', to_jsonb(filled), 'conflicts', to_jsonb(conflicts)));
  if v.lead_id is not null then
    perform private.voice_activity(v, 'ai_update', 'Call analysis',
      concat_ws(' · ', case when cardinality(filled) > 0 then 'Filled: ' || array_to_string(filled, ', ') end,
        case when cardinality(conflicts) > 0 then 'Differs from CRM (not changed): ' || array_to_string(conflicts, ', ') end));
  end if;
  -- Conservative direction: a detected opt-out always suppresses future calls.
  if (res ->> 'opt_out_detected')::boolean then perform private.voice_apply_opt_out(v.id, 'post_call_analysis'); end if;
  if (res ->> 'human_requested')::boolean or (res ->> 'callback_requested')::boolean then
    perform private.voice_request_handoff(v.id, case when (res ->> 'human_requested')::boolean then 'human_requested' else 'callback_requested' end);
  end if;
  perform private.voice_call_finalize(v.id);
  return 'succeeded';
end;
$$;

-- ───────────────────────── worker (service role) ─────────────────────────

-- Housekeeping and the list of calls the Edge worker must reconcile with Retell.
create or replace function public.voice_worker_tick()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  redispatch jsonb;
  stale jsonb;
  n_purged int;
  r record;
begin
  -- Reserved but never sent (no provider attempt within 5 min): fail, nothing was dialed.
  for r in select id from public.voice_calls where status = 'initiating' and provider_attempts = 0 and requested_at < now() - interval '5 minutes' loop
    perform public.voice_call_mark_failed(r.id, 'Not sent to the provider', true);
  end loop;
  -- Ambiguous initiations: re-send with the same idempotency key (safe for 1 h); voice_call_dispatch marks older ones 'unknown'.
  select coalesce(jsonb_agg(id), '[]') into redispatch from (
    select id from public.voice_calls where status = 'initiating' and provider_attempts > 0 and requested_at < now() - interval '1 minute'
    order by requested_at limit 20) x;
  -- Calls without a terminal event for 2 h, or terminal calls whose call_analyzed never arrived: fetch from Retell.
  select coalesce(jsonb_agg(jsonb_build_object('call_id', id, 'provider_call_id', provider_call_id)), '[]') into stale from (
    select id, provider_call_id from public.voice_calls
    where provider_call_id is not null and finalized_at is null
      and ((status in ('dialing', 'in_progress') and coalesce(last_event_at, initiated_at, requested_at) < now() - interval '2 hours')
        or (private.voice_is_terminal(status) and analysis_status = 'not_requested' and ended_at < now() - interval '15 minutes'))
    order by requested_at limit 20) x;
  delete from public.voice_call_transcripts where retain_until < now();
  get diagnostics n_purged = row_count;
  update public.voice_calls v set transcript_stored = false
  where v.transcript_stored and not exists (select 1 from public.voice_call_transcripts t where t.call_id = v.id);
  return jsonb_build_object('redispatch', redispatch, 'stale', stale, 'transcripts_purged', n_purged);
end;
$$;

-- After 3 failed fetches a stale call is closed as 'unknown' rather than guessed.
create or replace function public.voice_call_close_unresolved(p_call uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.voice_calls;
begin
  select * into v from public.voice_calls where id = p_call for update;
  if v.id is null or v.finalized_at is not null then return; end if;
  if private.voice_is_terminal(v.status) then
    update public.voice_calls set analysis_status = case when analysis_status = 'not_requested' then 'skipped' else analysis_status end where id = v.id;
    perform private.voice_call_finalize(v.id);
  else
    update public.voice_calls set status = 'unknown', outcome = 'unknown', last_provider_error = 'No final status from provider' where id = v.id;
  end if;
end;
$$;

create or replace function public.voice_worker_secret_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_secret is not null and length(p_secret) >= 32
     and exists (select 1 from vault.decrypted_secrets where name = 'voice_worker_secret' and decrypted_secret = p_secret);
$$;

-- Lead/call read model for the UI (transcript only with calls.recordings).
create or replace function public.voice_call_detail(p_call uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.voice_calls;
  t text;
begin
  select * into v from public.voice_calls where id = p_call;
  if v.id is null or not (public.has_perm(v.organization_id, 'calls.place') or public.has_perm(v.organization_id, 'logs.view')) then
    perform private.fail('NOT_FOUND', 'Call not found');
  end if;
  if public.has_perm(v.organization_id, 'calls.recordings') then
    select transcript into t from public.voice_call_transcripts where call_id = v.id;
  end if;
  return jsonb_build_object('call', to_jsonb(v) - 'provider_analysis' || jsonb_build_object('provider_analysis', v.provider_analysis),
    'transcript', t, 'can_view_transcript', public.has_perm(v.organization_id, 'calls.recordings'),
    'recording_access', coalesce((select recording_access from public.voice_settings where organization_id = v.organization_id), false));
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke all on function private.voice_is_terminal(text), private.voice_rank(text), private.voice_terminal_status(text, boolean, boolean),
  private.voice_outcome(text, text), private.voice_policy(uuid, timestamptz), private.voice_run_step(public.voice_calls, text, text, jsonb),
  private.voice_activity(public.voice_calls, text, text, text, jsonb), private.voice_apply_opt_out(uuid, text),
  private.voice_request_handoff(uuid, text), private.voice_call_finalize(uuid)
  from public, anon, authenticated;

revoke execute on function public.voice_call_dispatch(uuid), public.voice_call_mark_initiated(uuid, text, text), public.voice_call_mark_failed(uuid, text, boolean),
  public.voice_webhook_ingest(text, jsonb), public.voice_analysis_claim(int), public.voice_analysis_complete(uuid, boolean, jsonb, jsonb),
  public.voice_worker_tick(), public.voice_call_close_unresolved(uuid), public.voice_worker_secret_ok(text)
  from public, anon, authenticated;
grant execute on function public.voice_call_dispatch(uuid), public.voice_call_mark_initiated(uuid, text, text), public.voice_call_mark_failed(uuid, text, boolean),
  public.voice_webhook_ingest(text, jsonb), public.voice_analysis_claim(int), public.voice_analysis_complete(uuid, boolean, jsonb, jsonb),
  public.voice_worker_tick(), public.voice_call_close_unresolved(uuid), public.voice_worker_secret_ok(text)
  to service_role;

revoke execute on function public.voice_call_preflight(uuid), public.voice_call_request(uuid, text), public.set_ai_call_consent(uuid, text, text),
  public.voice_settings_save(uuid, jsonb), public.voice_call_recording_access(uuid), public.voice_call_detail(uuid) from public, anon;
grant execute on function public.voice_call_preflight(uuid), public.voice_call_request(uuid, text), public.set_ai_call_consent(uuid, text, text),
  public.voice_settings_save(uuid, jsonb), public.voice_call_recording_access(uuid), public.voice_call_detail(uuid) to authenticated;

-- ───────────────────────── worker schedule ─────────────────────────
-- pg_cron → pg_net → Edge Function voice-worker. The URL and shared secret live in Vault; the job does nothing until
-- the 'voice_worker_url' secret is set. Skipped where pg_cron / pg_net are unavailable (local tests).

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'voice_worker_secret') then
    perform vault.create_secret(private.random_token() || private.random_token(), 'voice_worker_secret', 'Shared secret for the voice-worker Edge Function');
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
    if not exists (select 1 from cron.job where jobname = 'voice-worker') then
      perform cron.schedule('voice-worker', '* * * * *', $job$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'voice_worker_url'),
          headers := jsonb_build_object('Content-Type', 'application/json',
            'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'voice_worker_secret')),
          body := '{}'::jsonb, timeout_milliseconds := 55000)
        where exists (select 1 from vault.decrypted_secrets where name = 'voice_worker_url')
      $job$);
    end if;
  end if;
end;
$$;
