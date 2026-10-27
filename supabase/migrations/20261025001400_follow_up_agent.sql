-- Estate OS · 0014 · Agent 05 — AI Follow-Up Agent (follow_up_agent)
-- Plans follow-ups from persisted state (Agent 04 matches, Agent 03 missing information, Agent 02 calls / handoffs /
-- opt-outs), drafts grounded messages (template first, optional Claude rewrite), routes every message through one
-- deterministic policy (consent, suppression, windows, frequency, human ownership) at planning, approval and send time.
-- No email / SMS / WhatsApp provider exists in this product: approved messages are sent by a person and recorded as
-- sent via 'manual'. A provider dispatch path (lease, idempotency, ambiguous outcomes) is in place for a future adapter.
-- Additive only.

-- ───────────────────────── tables ─────────────────────────

create table public.follow_up_settings (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  rules jsonb not null default '{}',
  version integer not null default 1,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger follow_up_settings_updated_at before update on public.follow_up_settings for each row execute function public.set_updated_at();
create trigger follow_up_settings_audit after insert or update on public.follow_up_settings for each row execute function private.audit_row();

create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  lead_id uuid not null references public.leads (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  run_id uuid references public.agent_runs (id) on delete set null,
  trigger text not null check (char_length(trigger) <= 80),
  purpose text not null check (purpose in ('share_property_recommendations', 'clarify_requirements', 'answer_call_questions', 'callback_request', 're_engagement')),
  kind text not null check (kind in ('message', 'task')),
  channel text not null check (channel in ('whatsapp', 'sms', 'email', 'task')),
  consent_purpose text check (consent_purpose in ('service', 'marketing')),
  status text not null check (status in ('pending_approval', 'approved', 'scheduled', 'processing', 'sent', 'delivered', 'failed', 'cancelled',
    'suppressed', 'expired', 'handed_off')),
  status_reason text check (char_length(status_reason) <= 300),
  reason text not null check (char_length(reason) <= 500),
  scheduled_for timestamptz,
  timezone text,
  subject text check (char_length(subject) <= 200),
  body text check (char_length(body) <= 4000),
  content_version integer not null default 1,
  generated_by text not null default 'template' check (generated_by in ('template', 'ai', 'human')),
  draft_status text not null default 'not_requested' check (draft_status in ('not_requested', 'pending', 'succeeded', 'failed', 'not_configured')),
  draft_lease_until timestamptz,
  model_meta jsonb,
  property_ids uuid[] not null default '{}',
  match_run_id uuid references public.property_match_runs (id) on delete set null,
  call_id uuid references public.voice_calls (id) on delete set null,
  qualification_id uuid references public.lead_qualifications (id) on delete set null,
  task_id uuid references public.tasks (id) on delete set null,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  approved_version integer,
  rejected_by uuid references public.profiles (id) on delete set null,
  rejection_note text check (char_length(rejection_note) <= 500),
  sent_at timestamptz,
  sent_via text check (sent_via in ('manual', 'provider')),
  sent_by uuid references public.profiles (id) on delete set null,
  provider text check (char_length(provider) <= 60),
  provider_message_id text check (char_length(provider_message_id) <= 200),
  delivered_at timestamptz,
  attempt_count integer not null default 0,
  lease_until timestamptz,
  last_error_category text check (last_error_category in ('transient', 'permanent', 'ambiguous', 'unsupported', 'policy')),
  last_error text check (char_length(last_error) <= 300),
  -- Last policy evaluation (checks only, no message text).
  policy jsonb not null default '{}',
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 300),
  correlation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);
-- At most one active follow-up per lead and purpose: duplicate triggers cannot stack messages.
create unique index follow_ups_active_purpose_uniq on public.follow_ups (lead_id, purpose)
  where status in ('pending_approval', 'approved', 'scheduled', 'processing');
create index follow_ups_lead_idx on public.follow_ups (lead_id, created_at desc);
create index follow_ups_org_status_idx on public.follow_ups (organization_id, status, scheduled_for);
create index follow_ups_contact_idx on public.follow_ups (contact_id) where status in ('pending_approval', 'approved', 'scheduled', 'processing');
create index follow_ups_draft_idx on public.follow_ups (created_at) where draft_status = 'pending';
create trigger follow_ups_updated_at before update on public.follow_ups for each row execute function public.set_updated_at();
create trigger follow_ups_org_immutable before update on public.follow_ups for each row execute function private.prevent_org_change();

alter table public.follow_up_settings enable row level security;
alter table public.follow_ups enable row level security;
create policy follow_up_settings_read on public.follow_up_settings for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy follow_ups_read on public.follow_ups for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
revoke all on public.follow_up_settings, public.follow_ups from anon;
revoke insert, update, delete, truncate on public.follow_up_settings, public.follow_ups from authenticated;

-- ───────────────────────── rules & helpers ─────────────────────────

create or replace function private.fu_default_rules()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{
    "enabled": true,
    "channels": ["whatsapp", "email", "sms"],
    "window": {"start": 9, "end": 20},
    "max_per_week": 3, "min_hours_between": 48, "max_unanswered": 3, "human_cooldown_hours": 24,
    "max_properties": 3, "share_unverified": false, "max_questions": 2,
    "use_cases": {"share_property_recommendations": true, "clarify_requirements": true, "answer_call_questions": true, "re_engagement": false},
    "reengage_after_days": 45,
    "llm_drafting": true,
    "expiry_hours": 72
  }'::jsonb;
$$;

create or replace function private.fu_rules(org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.fu_default_rules() || coalesce(s.rules, '{}') || jsonb_build_object('version', coalesce(s.version, 0))
  from (select 1) x left join public.follow_up_settings s on s.organization_id = org;
$$;

-- Next moment inside the messaging window (org time zone, business days), at or after p_at. Null if none in 14 days.
create or replace function private.fu_next_window(tz text, days jsonb, w jsonb, p_at timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  loc timestamp := p_at at time zone coalesce(tz, 'UTC');
  d date;
  s timestamp;
  e timestamp;
begin
  for i in 0..14 loop
    d := loc::date + i;
    continue when days is not null and jsonb_typeof(days) = 'array' and not (days @> to_jsonb(extract(dow from d)::int));
    s := d + make_interval(hours => coalesce((w ->> 'start')::int, 9));
    e := d + make_interval(hours => coalesce((w ->> 'end')::int, 20));
    if loc < s then return s at time zone coalesce(tz, 'UTC'); end if;
    if loc < e then return p_at; end if;
  end loop;
  return null;
end;
$$;

-- The single outbound policy. Hard blocks never pass; deferrals return the earliest allowed time.
create or replace function private.fu_policy(p_lead uuid, p_channel text, p_purpose text, p_at timestamptz default now(), p_self uuid default null)
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
  rules jsonb;
  checks jsonb := '[]';
  consent_ok boolean;
  revoked boolean;
  human_task boolean;
  sent7 int;
  oldest7 timestamptz;
  last_sent timestamptz;
  last_human timestamptz;
  unanswered int;
  nxt timestamptz;
  defer timestamptz;
begin
  select * into l from public.leads where id = p_lead;
  select * into c from public.contacts where id = l.contact_id and organization_id = l.organization_id;
  select * into o from public.organizations where id = l.organization_id;
  rules := private.fu_rules(l.organization_id);

  select exists (select 1 from public.communication_consents cc where cc.contact_id = c.id and cc.channel = p_channel and cc.purpose = p_purpose and cc.status = 'granted')
    into consent_ok;
  select exists (select 1 from public.communication_consents cc where cc.contact_id = c.id and cc.channel = p_channel
                   and cc.purpose in (p_purpose, 'service') and cc.status in ('revoked', 'denied')) into revoked;
  select exists (select 1 from public.tasks t where t.related_lead_id = l.id and t.status in ('open', 'in_progress') and t.title like 'Call back %') into human_task;
  select count(*), min(f.sent_at), max(f.sent_at) into sent7, oldest7, last_sent from public.follow_ups f
    where f.lead_id = l.id and f.status in ('sent', 'delivered') and f.kind = 'message' and f.sent_at > p_at - interval '7 days' and f.id is distinct from p_self;
  select max(x) into last_human from (
    -- A person's own call / message, not the record of a follow-up being sent (that is our outreach, not engagement).
    select max(a.occurred_at) x from public.activities a where a.lead_id = l.id and a.source = 'user' and a.activity_type in ('call', 'message') and not (a.metadata ? 'follow_up_id')
    union all select max(v.ended_at) from public.voice_calls v where v.lead_id = l.id and v.status = 'completed'
    union all select max(ap.created_at) from public.appointments ap where ap.lead_id = l.id) z;
  select count(*) into unanswered from public.follow_ups f
    where f.lead_id = l.id and f.kind = 'message' and f.status in ('sent', 'delivered') and f.sent_at > coalesce(last_human, '-infinity'::timestamptz) and f.id is distinct from p_self;
  nxt := private.fu_next_window(o.timezone, o.settings -> 'business_hours' -> 'days', rules -> 'window', p_at);

  checks := jsonb_build_array(
    jsonb_build_object('key', 'kill_switch', 'hard', true, 'label', 'Organization outbound switch', 'ok', not coalesce((o.settings ->> 'outbound_paused')::boolean, false)),
    jsonb_build_object('key', 'enabled', 'hard', true, 'label', 'Follow-up automation enabled', 'ok', coalesce((rules ->> 'enabled')::boolean, true)),
    jsonb_build_object('key', 'lead_open', 'hard', true, 'label', 'Lead is open', 'ok', l.archived_at is null and l.status not in ('won', 'lost')),
    jsonb_build_object('key', 'not_suppressed', 'hard', true, 'label', 'Not on the do-not-contact list', 'ok', c.lifecycle_status <> 'do_not_contact'),
    jsonb_build_object('key', 'channel_preference', 'hard', true, 'label', 'Contact accepts messages', 'ok', c.preferred_contact_channel <> 'none'),
    jsonb_build_object('key', 'reachable', 'hard', true, 'label', 'Address on record for ' || p_channel,
      'ok', case p_channel when 'email' then c.email is not null else c.phone_e164 is not null end),
    jsonb_build_object('key', 'consent', 'hard', true, 'label', format('%s consent (%s)', initcap(p_channel), p_purpose), 'ok', consent_ok and not revoked,
      'detail', case when revoked then 'Revoked or denied' when consent_ok then 'Granted' else 'Not granted; unknown is never treated as permission' end),
    jsonb_build_object('key', 'human_owner', 'hard', true, 'label', 'No open call-back for a person', 'ok', not human_task),
    jsonb_build_object('key', 'unanswered', 'hard', true, 'label', 'Unanswered follow-up limit', 'ok', unanswered < coalesce((rules ->> 'max_unanswered')::int, 3),
      'detail', format('%s unanswered of %s', unanswered, coalesce((rules ->> 'max_unanswered')::int, 3))),
    jsonb_build_object('key', 'window', 'hard', false, 'label', 'Messaging window', 'ok', nxt = p_at, 'until', nxt,
      'detail', format('%s:00–%s:00 %s', coalesce(rules -> 'window' ->> 'start', '9'), coalesce(rules -> 'window' ->> 'end', '20'), o.timezone)),
    jsonb_build_object('key', 'weekly_limit', 'hard', false, 'label', 'Weekly limit', 'ok', sent7 < coalesce((rules ->> 'max_per_week')::int, 3),
      'until', case when sent7 >= coalesce((rules ->> 'max_per_week')::int, 3) then oldest7 + interval '7 days' end,
      'detail', format('%s of %s in 7 days', sent7, coalesce((rules ->> 'max_per_week')::int, 3))),
    jsonb_build_object('key', 'min_gap', 'hard', false, 'label', 'Minimum gap between follow-ups',
      'ok', last_sent is null or last_sent <= p_at - make_interval(hours => coalesce((rules ->> 'min_hours_between')::int, 48)),
      'until', last_sent + make_interval(hours => coalesce((rules ->> 'min_hours_between')::int, 48))),
    jsonb_build_object('key', 'human_cooldown', 'hard', false, 'label', 'Cooldown after a person''s contact',
      'ok', last_human is null or last_human <= p_at - make_interval(hours => coalesce((rules ->> 'human_cooldown_hours')::int, 24)),
      'until', last_human + make_interval(hours => coalesce((rules ->> 'human_cooldown_hours')::int, 24))));

  select max((x ->> 'until')::timestamptz) into defer from jsonb_array_elements(checks) x where not (x ->> 'ok')::boolean and not (x ->> 'hard')::boolean;
  if defer is not null then defer := private.fu_next_window(o.timezone, o.settings -> 'business_hours' -> 'days', rules -> 'window', greatest(defer, p_at)); end if;
  return jsonb_build_object(
    'allowed', not exists (select 1 from jsonb_array_elements(checks) x where not (x ->> 'ok')::boolean),
    'blocked', exists (select 1 from jsonb_array_elements(checks) x where not (x ->> 'ok')::boolean and (x ->> 'hard')::boolean),
    'defer_until', defer, 'timezone', o.timezone, 'checks', checks,
    'failed', (select coalesce(jsonb_agg(x ->> 'label'), '[]') from jsonb_array_elements(checks) x where not (x ->> 'ok')::boolean));
end;
$$;

-- First channel the contact can be messaged on (address, consent, preference): preferred channel first, then the org's
-- order. Lead-level blocks (kill switch, ownership, limits) are left to the full policy, so they are recorded as suppressed.
create or replace function private.fu_pick_channel(p_lead uuid, p_purpose text, rules jsonb)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pref text;
  ch text;
begin
  select c.preferred_contact_channel into pref from public.leads l join public.contacts c on c.id = l.contact_id where l.id = p_lead;
  for ch in
    select x from (select pref x, 0 o union all select y, n from jsonb_array_elements_text(coalesce(rules -> 'channels', '[]')) with ordinality t(y, n)) z
    where x in ('whatsapp', 'sms', 'email') and coalesce(rules -> 'channels', '[]') ? x
    order by o
  loop
    if not exists (select 1 from jsonb_array_elements(private.fu_policy(p_lead, ch, p_purpose) -> 'checks') x
                   where x ->> 'key' in ('reachable', 'consent', 'channel_preference', 'not_suppressed') and not (x ->> 'ok')::boolean) then
      return ch;
    end if;
  end loop;
  return null;
end;
$$;

create or replace function private.fu_provider(org uuid, p_channel text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select i.provider from public.integrations i
  where i.organization_id = org and i.status = 'connected' and i.integration_type in ('messaging', 'email') and coalesce(i.configuration -> 'channels', '[]') ? p_channel
  order by i.created_at limit 1;
$$;

create or replace function private.fu_footer(p_channel text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_channel = 'email' then chr(10) || chr(10) || 'If you would rather not hear from us, reply "unsubscribe".' else chr(10) || 'Reply STOP to opt out.' end;
$$;

create or replace function private.fu_limit(p_channel text)
returns int
language sql
immutable
set search_path = ''
as $$
  select case p_channel when 'sms' then 640 when 'whatsapp' then 1000 else 4000 end;
$$;

-- Deterministic message from records only. ctx: first_name, agency, properties[{title, locality, price, currency, bedrooms, unverified}], questions[].
create or replace function private.fu_render(p_purpose text, p_channel text, ctx jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  hi text := 'Hi ' || coalesce(nullif(ctx ->> 'first_name', ''), 'there') || ', this is ' || coalesce(ctx ->> 'agency', 'your agent') || '.';
  b text;
begin
  b := case p_purpose
    when 'share_property_recommendations' then hi || ' Following up on your enquiry, these listings match what you told us:' || chr(10) ||
      (select string_agg(format('%s. %s, %s – %s, %s bed%s', n, x ->> 'title', x ->> 'locality', private.pm_money((x ->> 'price')::numeric, x ->> 'currency'), x ->> 'bedrooms',
              case when (x ->> 'unverified')::boolean then ' (availability to be confirmed)' else '' end), chr(10) order by n)
       from jsonb_array_elements(ctx -> 'properties') with ordinality t(x, n)) ||
      chr(10) || 'Would you like more details or to arrange a viewing of any of them?'
    when 'clarify_requirements' then hi || ' Thanks for your enquiry. To suggest suitable properties, could you tell us:' || chr(10) ||
      (select string_agg(format('%s. %s', n, q), chr(10) order by n) from jsonb_array_elements_text(ctx -> 'questions') with ordinality t(q, n))
    when 're_engagement' then hi || ' You enquired with us a while ago. Are you still looking for a property? Reply and we will share current options.'
  end;
  return jsonb_build_object(
    'subject', case when p_channel = 'email' then case p_purpose when 'share_property_recommendations' then 'Listings matching your enquiry'
      when 'clarify_requirements' then 'A quick question about your property search' else 'Still looking for a property?' end end,
    'body', b || private.fu_footer(p_channel));
end;
$$;

-- Content and facts still valid for sending? Returns null when fine, else a reason code.
create or replace function private.fu_content_problem(f public.follow_ups)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rules jsonb := private.fu_rules(f.organization_id);
begin
  if f.kind <> 'message' then return 'NOT_A_MESSAGE'; end if;
  if char_length(trim(coalesce(f.body, ''))) < 10 or char_length(f.body) > private.fu_limit(f.channel) then return 'INVALID_CONTENT'; end if;
  if position(trim(private.fu_footer(f.channel)) in f.body) = 0 then return 'MISSING_OPT_OUT'; end if;
  if f.channel = 'email' and char_length(trim(coalesce(f.subject, ''))) = 0 then return 'MISSING_SUBJECT'; end if;
  -- Every shared listing must still be shareable now (active, same org, recommendation not rejected / invalidated).
  if exists (select 1 from unnest(f.property_ids) pid
             where not exists (select 1 from public.properties p where p.id = pid and p.organization_id = f.organization_id and p.status = 'active'
                                 and (p.verified_at is not null or coalesce((rules ->> 'share_unverified')::boolean, false)))
                or exists (select 1 from public.property_matches m where m.lead_id = f.lead_id and m.property_id = pid and m.status in ('rejected', 'invalidated')
                             and m.match_run_id = (select r.id from public.property_match_runs r where r.lead_id = f.lead_id and r.is_current))) then
    return 'PROPERTY_UNAVAILABLE';
  end if;
  return null;
end;
$$;

create or replace function private.fu_can_act(org uuid, assigned uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_perm(org, 'inbox.reply') and private.pm_can_act(org, assigned);
$$;

create or replace function private.fu_activity(f public.follow_ups, title text, body text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.activities (organization_id, lead_id, contact_id, activity_type, title, description, source, actor_name, metadata)
  values (f.organization_id, f.lead_id, f.contact_id, 'workflow', left(title, 300), left(body, 4000), 'ai', 'Follow-Up Agent',
          jsonb_build_object('follow_up_id', f.id, 'agent', 'follow_up_agent'));
$$;

create or replace function private.fu_event(f public.follow_ups, p_type text)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.emit_event(f.organization_id, p_type, 'follow_up', f.id, f.correlation_id,
    jsonb_build_object('event_type', p_type, 'schema_version', 1, 'organization_id', f.organization_id, 'lead_id', f.lead_id, 'follow_up_id', f.id,
      'purpose', f.purpose, 'channel', f.channel, 'status', f.status, 'correlation_id', f.correlation_id, 'occurred_at', now()),
    null, p_type || ':' || f.id::text || ':' || f.content_version || ':' || f.status);
$$;

-- Cancels / suppresses a lead's or contact's active follow-ups. Synchronous: never relies on an event being delivered.
create or replace function private.fu_stop(p_lead uuid, p_contact uuid, p_channel text, p_status text, p_reason text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  update public.follow_ups set status = p_status, status_reason = left(p_reason, 300), lease_until = null
  where status in ('pending_approval', 'approved', 'scheduled', 'processing') and kind = 'message'
    and (p_lead is null or lead_id = p_lead) and (p_contact is null or contact_id = p_contact) and (p_channel is null or channel = p_channel);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ───────────────────────── planning ─────────────────────────

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
    -- Another active follow-up with this purpose already covers it.
    if exists (select 1 from public.follow_ups x where x.lead_id = l.id and x.purpose = p_purpose and x.status in ('pending_approval', 'approved', 'scheduled', 'processing')) then
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

create or replace function private.fu_enqueue(org uuid, p_lead uuid, p_trigger text, p_key text, p_kind text, p_corr uuid, p_input jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
begin
  if not exists (select 1 from public.leads where id = p_lead and organization_id = org) then return null; end if;
  insert into public.agent_runs (organization_id, agent_id, agent_version, trigger_event, source_kind, provider, idempotency_key, lead_id, input, correlation_id)
  values (org, 'follow_up_agent', '1.0.0', p_trigger, p_kind, 'os', p_key, p_lead, coalesce(p_input, '{}') || jsonb_build_object('lead_id', p_lead),
    coalesce(p_corr, (select correlation_id from public.agent_runs where organization_id = org and lead_id = p_lead order by received_at desc limit 1), gen_random_uuid()))
  on conflict (organization_id, agent_id, idempotency_key) do nothing
  returning id into rid;
  if rid is null then select id into rid from public.agent_runs where organization_id = org and agent_id = 'follow_up_agent' and idempotency_key = p_key; end if;
  return rid;
end;
$$;

-- One planning run. Re-reads persisted state; the event payload only names records.
create or replace function private.fu_execute(r public.agent_runs)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.leads;
  c public.contacts;
  o public.organizations;
  rules jsonb;
  purpose text := r.input ->> 'purpose';
  ch text;
  mr public.property_match_runs;
  q public.lead_qualifications;
  v public.voice_calls;
  props jsonb;
  pids uuid[];
  qs jsonb;
  ctx jsonb;
  f public.follow_ups;
  tid uuid;
  owner uuid;
  n int;
  res text := 'skipped';
  why text;
begin
  select * into l from public.leads where id = r.lead_id and organization_id = r.organization_id;
  if l.id is null then return jsonb_build_object('status', 'skipped', 'reason', 'lead_not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('followup:' || l.id::text, 0));
  select * into c from public.contacts where id = l.contact_id;
  select * into o from public.organizations where id = l.organization_id;
  rules := private.fu_rules(l.organization_id);
  owner := case when private.intake_eligible(l.organization_id, l.assigned_to) then l.assigned_to end;
  ctx := jsonb_build_object('first_name', split_part(trim(c.display_name), ' ', 1), 'agency', o.name);

  -- Opt-outs and hand-offs apply even to closed leads.
  if r.trigger_event = 'lead.communication_opted_out' then
    n := private.fu_stop(null, c.id, null, 'suppressed', 'Opted out (' || coalesce(r.input ->> 'channel', 'unknown') || ' via ' || coalesce(r.input ->> 'source', 'unknown') || '); pending messages stopped');
    return jsonb_build_object('status', 'stopped', 'count', n);
  end if;
  if r.trigger_event = 'voice_call.human_handoff_requested' then
    n := private.fu_stop(l.id, null, null, 'cancelled', 'The prospect asked for a person; automated messages paused');
    select t.id into tid from public.tasks t where t.related_lead_id = l.id and t.status in ('open', 'in_progress') and t.title like 'Call back %' order by t.created_at desc limit 1;
    f := private.fu_create(r, l, 'callback_request', 'task', 'task', null, 'The prospect asked for a person on the AI call; Agent 02 created the call-back task',
      ctx, null, 'handoff:' || coalesce(r.input ->> 'call_id', r.id::text), null, (r.input ->> 'call_id')::uuid, null, tid);
    return jsonb_build_object('status', 'handed_off', 'follow_up_id', f.id, 'cancelled', n);
  end if;
  if l.archived_at is not null or l.status in ('won', 'lost') then return jsonb_build_object('status', 'skipped', 'reason', 'lead_closed'); end if;

  purpose := coalesce(purpose, case r.trigger_event
    when 'property_matching.completed' then 'share_property_recommendations'
    when 'lead.qualification.needs_information' then 'clarify_requirements'
    when 'voice_call.completed' then 'answer_call_questions'
    when 'follow_up.re_engagement' then 're_engagement' end);
  if purpose is null then return jsonb_build_object('status', 'skipped', 'reason', 'unknown_trigger'); end if;
  if not coalesce((rules -> 'use_cases' ->> purpose)::boolean, false) then return jsonb_build_object('status', 'skipped', 'reason', 'use_case_disabled'); end if;

  if purpose = 'answer_call_questions' then
    select * into v from public.voice_calls where id = (r.input ->> 'call_id')::uuid and organization_id = l.organization_id and lead_id = l.id;
    if v.id is null or v.status <> 'completed' or jsonb_array_length(coalesce(v.analysis -> 'unanswered_questions', '[]')) = 0 then
      return jsonb_build_object('status', 'skipped', 'reason', 'nothing_to_follow_up');
    end if;
    -- Needs knowledge only a person has: a task, never an automated message.
    insert into public.tasks (organization_id, title, description, priority, due_at, assigned_to, related_lead_id, source)
    values (l.organization_id, left('Answer questions from the AI call: ' || c.display_name, 200),
      'Questions the AI could not answer (reply through an authorized channel):' || chr(10) ||
      (select string_agg('• ' || left(x, 200), chr(10)) from jsonb_array_elements_text(v.analysis -> 'unanswered_questions') with ordinality t(x, i) where i <= 5),
      'normal', now() + interval '1 day', owner, l.id, 'ai')
    returning id into tid;
    f := private.fu_create(r, l, purpose, 'task', 'task', null, 'The prospect asked questions on the call that need a person', ctx, null, 'callq:' || v.id::text, null, v.id, null, tid);
    return jsonb_build_object('status', 'handed_off', 'follow_up_id', f.id);
  end if;

  if purpose = 'share_property_recommendations' then
    select * into mr from public.property_match_runs where lead_id = l.id and organization_id = l.organization_id and is_current;
    if mr.id is null or (r.input ? 'matching_run_id' and mr.id::text <> r.input ->> 'matching_run_id') then
      return jsonb_build_object('status', 'skipped', 'reason', 'matching_run_superseded');
    end if;
    select jsonb_agg(jsonb_build_object('property_id', p.id, 'title', p.title, 'locality', p.locality, 'price', p.price, 'currency', p.currency,
             'bedrooms', p.bedrooms, 'unverified', m.availability <> 'verified') order by m.rank), array_agg(p.id order by m.rank)
      into props, pids
    from (select * from public.property_matches m where m.match_run_id = mr.id and m.status in ('recommended', 'viewed', 'shortlisted')
            and (m.availability = 'verified' or coalesce((rules ->> 'share_unverified')::boolean, false))
          order by m.rank limit least(greatest(coalesce((rules ->> 'max_properties')::int, 3), 1), 5)) m
    join public.properties p on p.id = m.property_id and p.organization_id = l.organization_id and p.status = 'active';
    if props is null then return jsonb_build_object('status', 'skipped', 'reason', 'nothing_shareable'); end if;
    ctx := ctx || jsonb_build_object('properties', props);
    ch := private.fu_pick_channel(l.id, 'service', rules);
    if ch is null then
      if not exists (select 1 from public.tasks t where t.related_lead_id = l.id and t.status in ('open', 'in_progress') and t.title like 'Share matched listings%') then
        insert into public.tasks (organization_id, title, description, priority, due_at, assigned_to, related_lead_id, source)
        values (l.organization_id, left('Share matched listings: ' || c.display_name, 200),
          'No messaging channel with consent on record, so nothing was drafted. Share these through an authorized channel or record consent first:' || chr(10) ||
          (select string_agg('• ' || (x ->> 'title') || ', ' || (x ->> 'locality'), chr(10)) from jsonb_array_elements(props) x),
          'normal', now() + interval '1 day', owner, l.id, 'ai')
        returning id into tid;
      end if;
      f := private.fu_create(r, l, purpose, 'task', 'task', null, 'Matched listings ready but no channel has consent; handed to a person', ctx, pids,
        'share_task:' || mr.id::text, mr.id, null, null, tid);
      return jsonb_build_object('status', 'handed_off', 'follow_up_id', f.id);
    end if;
    f := private.fu_create(r, l, purpose, 'message', ch, 'service', format('%s matched listing(s) from the current matching run', jsonb_array_length(props)),
      ctx, pids, 'share:' || mr.id::text, mr.id, null, null, null);
    return jsonb_build_object('status', coalesce(f.status, 'duplicate'), 'follow_up_id', f.id);
  end if;

  if purpose = 'clarify_requirements' then
    select * into q from public.lead_qualifications where lead_id = l.id and organization_id = l.organization_id and is_current;
    -- Only questions for fields that are still missing in the CRM right now.
    select jsonb_agg(x ->> 'question') into qs from (
      select x from jsonb_array_elements(coalesce(q.questions, '[]')) x
      where case x ->> 'field'
              when 'intent' then coalesce(l.metadata -> 'intake' -> 'missing', '[]') ? 'intent'
              when 'locations' then cardinality(l.desired_locations) = 0
              when 'budget' then l.budget_max is null and l.budget_min is null
              when 'property_type' then l.desired_property_type is null
              when 'bedrooms' then l.bedrooms is null
              when 'timeline' then l.timeline is null else false end
      limit least(greatest(coalesce((rules ->> 'max_questions')::int, 2), 1), 3)) z;
    if qs is null then return jsonb_build_object('status', 'skipped', 'reason', 'nothing_missing'); end if;
    ch := private.fu_pick_channel(l.id, 'service', rules);
    if ch is null then return jsonb_build_object('status', 'skipped', 'reason', 'no_permitted_channel'); end if;
    f := private.fu_create(r, l, purpose, 'message', ch, 'service', format('%s requirement(s) still missing after qualification', jsonb_array_length(qs)),
      ctx || jsonb_build_object('questions', qs), null, 'clarify:' || coalesce(q.id::text, r.id::text), null, null, q.id, null);
    return jsonb_build_object('status', coalesce(f.status, 'duplicate'), 'follow_up_id', f.id);
  end if;

  if purpose = 're_engagement' then
    ch := private.fu_pick_channel(l.id, 'marketing', rules);
    if ch is null then return jsonb_build_object('status', 'skipped', 'reason', 'no_marketing_consent'); end if;
    f := private.fu_create(r, l, purpose, 'message', ch, 'marketing', format('No contact for %s+ days', coalesce(rules ->> 'reengage_after_days', '45')),
      ctx, null, 'reengage:' || l.id::text || ':' || to_char(now(), 'IYYY-IW'), null, null, null, null);
    return jsonb_build_object('status', coalesce(f.status, 'duplicate'), 'follow_up_id', f.id);
  end if;
  return jsonb_build_object('status', res);
end;
$$;

create or replace function public.follow_up_process(p_run uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.agent_runs;
  res jsonb;
  v_state text;
  v_msg text;
  final text;
  t0 timestamptz := clock_timestamp();
begin
  select * into r from public.agent_runs where id = p_run and agent_id = 'follow_up_agent' for update;
  if r.id is null then perform private.fail('NOT_FOUND', 'Run not found'); end if;
  if r.status not in ('received', 'retry_scheduled') then return jsonb_build_object('status', r.status, 'run_id', r.id, 'replayed', true); end if;
  update public.agent_runs set attempt_count = attempt_count + 1, started_at = coalesce(started_at, now()) where id = r.id returning * into r;
  begin
    res := private.fu_execute(r);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    final := case when r.attempt_count >= r.max_attempts then 'dead_letter' else 'retry_scheduled' end;
    update public.agent_runs set status = final,
      next_attempt_at = case when final = 'retry_scheduled' then now() + make_interval(mins => power(2, r.attempt_count)::int) end,
      error_category = case when v_state ~ '^(22|23|40|53|57)' then 'database' else 'unknown' end,
      error_message = left(v_state || ' ' || v_msg, 300), completed_at = case when final = 'dead_letter' then now() end
    where id = r.id;
    perform private.run_step(r, 'attempt', 'failed', jsonb_build_object('attempt', r.attempt_count, 'sqlstate', v_state, 'next', final));
    return jsonb_build_object('status', final, 'run_id', r.id);
  end;
  perform private.run_step(r, 'plan', 'ok', res);
  update public.agent_runs set status = 'succeeded', outcome = res, completed_at = now(), next_attempt_at = null, error_category = null, error_message = null,
    duration_ms = (extract(epoch from clock_timestamp() - t0) * 1000)::int
  where id = r.id;
  return res || jsonb_build_object('run_id', r.id);
end;
$$;

-- Outbox consumer, due runs, re-engagement sweep, expiry and stuck dispatch reconciliation.
create or replace function public.follow_up_tick(p_limit int default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.outbox_events;
  lid uuid;
  consumed int := 0;
  processed int := 0;
  rid uuid;
  x record;
  f public.follow_ups;
begin
  for e in select * from public.outbox_claim('follow_up_agent', array['property_matching.completed', 'lead.qualification.needs_information', 'voice_call.completed',
             'voice_call.human_handoff_requested', 'lead.communication_opted_out'], 50) loop
    lid := case when (e.payload ->> 'lead_id') ~ '^[0-9a-f-]{36}$' then (e.payload ->> 'lead_id')::uuid end;
    if lid is null and e.event_type = 'lead.communication_opted_out' and (e.payload ->> 'contact_id') ~ '^[0-9a-f-]{36}$' then
      select id into lid from public.leads where contact_id = (e.payload ->> 'contact_id')::uuid and organization_id = e.organization_id order by created_at desc limit 1;
    end if;
    -- The event's org is trusted (outbox rows are written only by SQL); the lead must belong to it.
    if lid is not null and exists (select 1 from public.leads where id = lid and organization_id = e.organization_id) then
      perform private.fu_enqueue(e.organization_id, lid, e.event_type, 'evt:' || e.id::text, 'integration', e.correlation_id,
        jsonb_strip_nulls(jsonb_build_object('matching_run_id', e.payload ->> 'matching_run_id', 'call_id', e.payload ->> 'call_id',
          'channel', e.payload ->> 'channel', 'source', e.payload ->> 'source')));
    end if;
    perform public.outbox_ack(e.id, 'follow_up_agent', true);
    consumed := consumed + 1;
  end loop;

  -- Re-engagement (off unless an org enables it): silent open leads, one per ISO week at most.
  for x in
    select l.organization_id org, l.id lead from public.leads l
    join public.follow_up_settings s on s.organization_id = l.organization_id and coalesce((s.rules -> 'use_cases' ->> 're_engagement')::boolean, false)
    where l.archived_at is null and l.status in ('contacted', 'qualified', 'matching', 'nurture')
      and greatest(l.updated_at, coalesce(l.last_contact_at, l.created_at)) < now() - make_interval(days => coalesce((s.rules ->> 'reengage_after_days')::int, 45))
      and not exists (select 1 from public.follow_ups fx where fx.lead_id = l.id and fx.created_at > now() - make_interval(days => coalesce((s.rules ->> 'reengage_after_days')::int, 45)))
    limit 20
  loop
    perform private.fu_enqueue(x.org, x.lead, 'follow_up.re_engagement', 'reengage:' || x.lead::text || ':' || to_char(now(), 'IYYY-IW'), 'integration', null, '{}');
  end loop;

  for rid in
    select ar.id from public.agent_runs ar
    where ar.agent_id = 'follow_up_agent' and ar.status in ('received', 'retry_scheduled') and (ar.next_attempt_at is null or ar.next_attempt_at <= now())
    order by ar.received_at limit least(greatest(p_limit, 1), 200)
    for update skip locked
  loop
    perform public.follow_up_process(rid);
    processed := processed + 1;
  end loop;

  -- Drafts and approved-but-unsent messages expire; nothing old goes out by surprise.
  for f in
    update public.follow_ups fu set status = 'expired', status_reason = 'Not acted on within the expiry period'
    where fu.status in ('pending_approval', 'approved') and fu.updated_at < now() - make_interval(hours => coalesce((private.fu_rules(fu.organization_id) ->> 'expiry_hours')::int, 72))
    returning fu.*
  loop
    perform private.fu_event(f, 'follow_up.expired');
  end loop;
  -- A dispatch whose lease ran out without a result may have been sent: never resend, ask a person.
  for f in
    update public.follow_ups fu set status = 'failed', last_error_category = 'ambiguous', status_reason = 'Send outcome unknown (worker lease expired); check before resending'
    where fu.status = 'processing' and fu.lease_until < now()
    returning fu.*
  loop
    perform private.fu_event(f, 'follow_up.failed');
  end loop;
  update public.follow_ups set draft_status = 'failed', model_meta = coalesce(model_meta, '{}') || '{"outcome": "timeout"}'
  where draft_status = 'pending' and created_at < now() - interval '15 minutes';
  return jsonb_build_object('consumed', consumed, 'processed', processed);
end;
$$;

-- ───────────────────────── Claude drafting (service role) ─────────────────────────

create or replace function public.follow_up_draft_claim(p_limit int default 5)
returns table (follow_up_id uuid, content_version int, purpose text, channel text, facts jsonb, template jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with picked as (
    select f.id from public.follow_ups f
    where f.draft_status = 'pending' and f.status = 'pending_approval' and (f.draft_lease_until is null or f.draft_lease_until < now())
    order by f.created_at limit least(greatest(p_limit, 1), 10)
    for update skip locked
  ), leased as (
    update public.follow_ups f set draft_lease_until = now() + interval '3 minutes' from picked where f.id = picked.id returning f.*
  )
  select leased.id, leased.content_version, leased.purpose, leased.channel,
    jsonb_strip_nulls(jsonb_build_object(
      'agency', (select o.name from public.organizations o where o.id = leased.organization_id),
      'first_name', (select split_part(trim(c.display_name), ' ', 1) from public.contacts c where c.id = leased.contact_id),
      'max_length', private.fu_limit(leased.channel) - 60,
      'properties', (select jsonb_agg(jsonb_build_object('property_id', p.id, 'title', p.title, 'locality', p.locality, 'city', p.city, 'price', p.price,
          'currency', p.currency, 'bedrooms', p.bedrooms, 'property_type', p.property_type, 'availability_confirmed', p.verified_at is not null) order by i)
        from unnest(leased.property_ids) with ordinality u(pid, i) join public.properties p on p.id = u.pid and p.organization_id = leased.organization_id),
      'questions', (select q.questions from public.lead_qualifications q where q.id = leased.qualification_id))),
    jsonb_build_object('subject', leased.subject, 'body', leased.body)
  from leased;
end;
$$;

-- Accepts a validated rewrite only while the draft is still pending and unchanged. Code re-appends the opt-out line.
create or replace function public.follow_up_attach_draft(p_follow_up uuid, p_version int, p_result jsonb, p_meta jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.follow_ups;
  meta jsonb;
  b text;
  s text;
begin
  select * into f from public.follow_ups where id = p_follow_up for update;
  if f.id is null then perform private.fail('NOT_FOUND', 'Follow-up not found'); end if;
  if f.draft_status <> 'pending' then return; end if;
  meta := (select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each(case when jsonb_typeof(p_meta) = 'object' then p_meta else '{}' end)
           where key in ('model', 'prompt_version', 'latency_ms', 'input_tokens', 'output_tokens', 'outcome', 'dropped') and jsonb_typeof(value) in ('string', 'number'));
  b := trim(p_result ->> 'body');
  s := nullif(trim(coalesce(p_result ->> 'subject', '')), '');
  if f.status <> 'pending_approval' or f.content_version <> p_version or p_result is null or jsonb_typeof(p_result) <> 'object'
     or char_length(coalesce(b, '')) not between 20 and private.fu_limit(f.channel) - 60
     or (f.channel = 'email' and (s is null or char_length(s) > 150))
     or b ~* '\m(almost sold|selling fast|last chance|hurry|limited time|expires? (today|soon)|reserved for you|is confirmed|guarantee\w*|discount|% return|famil(y|ies)|children|bachelors?|caste|religio\w*)\M'
     or exists (select 1 from jsonb_array_elements_text(coalesce(p_result -> 'referenced_property_ids', '[]')) x where not (x ~ '^[0-9a-f-]{36}$' and x::uuid = any (f.property_ids))) then
    update public.follow_ups set draft_status = case when meta ->> 'outcome' = 'not_configured' then 'not_configured' else 'failed' end, draft_lease_until = null,
      model_meta = meta || case when p_result is not null and meta ->> 'outcome' is distinct from 'not_configured' then '{"rejected": "invalid_or_stale"}'::jsonb else '{}'::jsonb end
    where id = f.id;
    return;
  end if;
  update public.follow_ups set body = b || private.fu_footer(f.channel), subject = case when f.channel = 'email' then s else null end,
    content_version = content_version + 1, generated_by = 'ai', draft_status = 'succeeded', draft_lease_until = null, model_meta = meta
  where id = f.id;
end;
$$;

-- ───────────────────────── provider dispatch (service role; used only when an adapter exists) ─────────────────────────

-- Due scheduled messages. Policy and content are re-checked here, immediately before any send; the recipient is
-- resolved from the contact now, never stored from a client.
create or replace function public.follow_up_dispatch_claim(p_limit int default 10)
returns table (follow_up_id uuid, provider text, channel text, recipient text, subject text, body text, idempotency_key text, attempt int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.follow_ups;
  pol jsonb;
  prob text;
  c public.contacts;
begin
  for f in
    select * from public.follow_ups x where x.status = 'scheduled' and x.scheduled_for <= now() order by x.scheduled_for limit least(greatest(p_limit, 1), 50)
    for update skip locked
  loop
    pol := private.fu_policy(f.lead_id, f.channel, f.consent_purpose, now(), f.id);
    prob := private.fu_content_problem(f);
    if (pol ->> 'blocked')::boolean then
      update public.follow_ups set status = 'suppressed', status_reason = left('Blocked at send time: ' || (select string_agg(y, ', ') from jsonb_array_elements_text(pol -> 'failed') y), 300), policy = pol - 'checks' || jsonb_build_object('checks', pol -> 'checks')
      where id = f.id returning * into f;
      perform private.fu_event(f, 'follow_up.suppressed');
    elsif prob is not null then
      update public.follow_ups set status = 'cancelled', status_reason = 'Content no longer valid: ' || prob where id = f.id returning * into f;
      perform private.fu_event(f, 'follow_up.cancelled');
    elsif not (pol ->> 'allowed')::boolean then
      update public.follow_ups set scheduled_for = (pol ->> 'defer_until')::timestamptz, policy = pol - 'checks' || jsonb_build_object('checks', pol -> 'checks') where id = f.id;
    elsif f.approved_version is distinct from f.content_version or private.fu_provider(f.organization_id, f.channel) is null then
      update public.follow_ups set status = 'approved', status_reason = 'Needs re-approval or a connected provider' , approved_version = case when f.approved_version = f.content_version then f.approved_version end where id = f.id;
    else
      select * into c from public.contacts where id = f.contact_id;
      update public.follow_ups set status = 'processing', attempt_count = attempt_count + 1, lease_until = now() + interval '5 minutes',
        provider = private.fu_provider(f.organization_id, f.channel) where id = f.id returning * into f;
      follow_up_id := f.id; provider := f.provider; channel := f.channel; recipient := case when f.channel = 'email' then c.email else c.phone_e164 end;
      subject := f.subject; body := f.body; idempotency_key := 'fu_' || f.id::text; attempt := f.attempt_count;
      return next;
    end if;
  end loop;
end;
$$;

-- Outcome of one provider call. 'ambiguous' (timeout after sending) is never retried automatically.
create or replace function public.follow_up_dispatch_result(p_follow_up uuid, p_outcome text, p_provider_message_id text, p_error text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.follow_ups;
begin
  select * into f from public.follow_ups where id = p_follow_up for update;
  if f.id is null then perform private.fail('NOT_FOUND', 'Follow-up not found'); end if;
  if f.status <> 'processing' then return f.status; end if;
  if p_outcome = 'accepted' then
    update public.follow_ups set status = 'sent', sent_via = 'provider', sent_at = now(), provider_message_id = left(p_provider_message_id, 200), lease_until = null,
      last_error = null, last_error_category = null where id = f.id returning * into f;
    perform private.fu_after_send(f);
  elsif p_outcome = 'transient' and f.attempt_count < 3 then
    update public.follow_ups set status = 'scheduled', lease_until = null, last_error_category = 'transient', last_error = left(p_error, 300),
      scheduled_for = now() + make_interval(mins => power(2, f.attempt_count)::int) + make_interval(secs => floor(random() * 60)::int) where id = f.id;
  elsif p_outcome = 'unsupported' then
    update public.follow_ups set status = 'approved', lease_until = null, attempt_count = greatest(attempt_count - 1, 0), last_error_category = 'unsupported',
      status_reason = 'No sending adapter for this provider; send manually', last_error = left(p_error, 300) where id = f.id;
  else
    update public.follow_ups set status = 'failed', lease_until = null,
      last_error_category = case when p_outcome = 'ambiguous' then 'ambiguous' when p_outcome = 'transient' then 'transient' else 'permanent' end,
      last_error = left(p_error, 300),
      status_reason = case when p_outcome = 'ambiguous' then 'Send outcome unknown (timeout); check before resending' else 'Provider rejected or retries exhausted' end
    where id = f.id returning * into f;
    if p_outcome = 'ambiguous' then
      insert into public.tasks (organization_id, title, description, priority, due_at, related_lead_id, source)
      values (f.organization_id, 'Check whether a follow-up was delivered', 'The provider did not confirm or reject the message. Check the provider log before resending.',
        'normal', now() + interval '4 hours', f.lead_id, 'ai');
    end if;
    perform private.fu_event(f, 'follow_up.failed');
  end if;
  return (select status from public.follow_ups where id = f.id);
end;
$$;

-- Bookkeeping after an actual send (manual or provider): timeline, Agent 04 recommendation state, lead contact time, event.
create or replace function private.fu_after_send(f public.follow_ups)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.activities (organization_id, lead_id, contact_id, activity_type, title, description, source, actor_name, created_by, metadata)
  values (f.organization_id, f.lead_id, f.contact_id, 'message',
    format('Follow-up sent via %s (%s)', f.channel, case when f.sent_via = 'manual' then 'sent by a person' else 'provider accepted' end),
    left(f.body, 4000), case when f.sent_via = 'manual' then 'user' else 'ai' end, case when f.sent_via = 'manual' then private.actor_name() else 'Follow-Up Agent' end,
    f.sent_by, jsonb_build_object('follow_up_id', f.id, 'agent', 'follow_up_agent', 'sent_via', f.sent_via, 'content_version', f.content_version));
  if cardinality(f.property_ids) > 0 then
    update public.property_matches m set status = 'shared', decided_at = now(), decided_by = f.sent_by
    where m.lead_id = f.lead_id and m.property_id = any (f.property_ids) and m.status in ('recommended', 'viewed', 'shortlisted')
      and exists (select 1 from public.property_match_runs r where r.id = m.match_run_id and r.is_current);
    update public.leads set status = 'matching' where id = f.lead_id and status in ('contacted', 'qualified');
  end if;
  update public.leads set last_contact_at = now() where id = f.lead_id;
  perform private.fu_event(f, 'follow_up.sent');
end;
$$;

create or replace function public.follow_up_worker_secret_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_secret is not null and length(p_secret) >= 32
     and exists (select 1 from vault.decrypted_secrets where name = 'follow_up_worker_secret' and decrypted_secret = p_secret);
$$;

-- ───────────────────────── synchronous safety triggers ─────────────────────────

create or replace function private.fu_on_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('revoked', 'denied') and (tg_op = 'INSERT' or old.status is distinct from new.status) and new.channel in ('whatsapp', 'sms', 'email') then
    perform private.fu_stop(null, new.contact_id, new.channel, 'suppressed', format('%s consent %s', initcap(new.channel), new.status));
  end if;
  return null;
end;
$$;
create trigger consents_follow_up_stop after insert or update of status on public.communication_consents for each row execute function private.fu_on_consent();

create or replace function private.fu_on_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.lifecycle_status = 'do_not_contact' and old.lifecycle_status is distinct from 'do_not_contact' then
    perform private.fu_stop(null, new.id, null, 'suppressed', 'Contact added to the do-not-contact list');
  elsif new.preferred_contact_channel = 'none' and old.preferred_contact_channel is distinct from 'none' then
    perform private.fu_stop(null, new.id, null, 'suppressed', 'Contact asked not to be messaged');
  end if;
  return null;
end;
$$;
create trigger contacts_follow_up_stop after update of lifecycle_status, preferred_contact_channel on public.contacts for each row execute function private.fu_on_contact();

create or replace function private.fu_on_lead()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.status in ('won', 'lost') and old.status not in ('won', 'lost')) or (new.archived_at is not null and old.archived_at is null) then
    perform private.fu_stop(new.id, null, null, 'cancelled', 'Lead closed or archived');
  end if;
  return null;
end;
$$;
create trigger leads_follow_up_stop after update of status, archived_at on public.leads for each row execute function private.fu_on_lead();

-- A listing that stops being shareable cancels unsent messages that mention it.
create or replace function private.fu_on_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('invalidated', 'rejected') and old.status is distinct from new.status then
    update public.follow_ups set status = 'cancelled', status_reason = 'A listing in this message is no longer shareable (' || new.status || ')', lease_until = null
    where lead_id = new.lead_id and new.property_id = any (property_ids) and status in ('pending_approval', 'approved', 'scheduled');
  end if;
  return null;
end;
$$;
create trigger property_matches_follow_up_stop after update of status on public.property_matches for each row execute function private.fu_on_match();

-- Fan-out: events another agent consumes (or that are only published) also reach the follow-up agent.
create or replace function private.fu_fanout()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.event_type in ('voice_call.completed', 'voice_call.human_handoff_requested', 'lead.communication_opted_out', 'lead.qualification.needs_information')
     and new.consumer is distinct from 'follow_up_agent' then
    insert into public.outbox_events (organization_id, event_type, schema_version, record_type, record_id, correlation_id, payload, consumer, status, dedupe_key)
    values (new.organization_id, new.event_type, new.schema_version, new.record_type, new.record_id, new.correlation_id, new.payload, 'follow_up_agent', 'pending',
            'fu_fanout:' || new.id::text)
    on conflict (organization_id, dedupe_key) do nothing;
  end if;
  return null;
end;
$$;
create trigger outbox_follow_up_fanout after insert on public.outbox_events for each row execute function private.fu_fanout();

-- ───────────────────────── user-facing RPCs ─────────────────────────

create or replace function public.lead_follow_ups(p_lead uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l public.leads;
  r public.agent_runs;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null or not public.has_perm(l.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
  select * into r from public.agent_runs where organization_id = l.organization_id and agent_id = 'follow_up_agent' and lead_id = l.id order by received_at desc limit 1;
  return jsonb_build_object(
    'items', (select coalesce(jsonb_agg(to_jsonb(f) - 'organization_id' - 'draft_lease_until' - 'lease_until' - 'idempotency_key'
        || jsonb_build_object('properties', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'reference_code', p.reference_code, 'status', p.status)), '[]')
                                             from public.properties p where p.id = any (f.property_ids) and p.organization_id = f.organization_id))
        order by f.created_at desc), '[]')
      from (select * from public.follow_ups where lead_id = l.id and organization_id = l.organization_id order by created_at desc limit 30) f),
    'channels', (select jsonb_object_agg(ch, jsonb_build_object('policy', private.fu_policy(l.id, ch, 'service') - 'timezone', 'provider', private.fu_provider(l.organization_id, ch)))
                 from unnest(array['whatsapp', 'sms', 'email']) ch),
    'run', case when r.id is null then null else jsonb_build_object('id', r.id, 'status', r.status, 'trigger', r.trigger_event, 'received_at', r.received_at,
      'outcome', r.outcome, 'attempts', r.attempt_count) end,
    'can_act', private.fu_can_act(l.organization_id, l.assigned_to),
    'can_view_drafts', public.has_perm(l.organization_id, 'inbox.reply') or public.has_perm(l.organization_id, 'approvals.decide'));
end;
$$;

create or replace function public.follow_up_request(p_lead uuid, p_purpose text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.leads;
  rid uuid;
begin
  if coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9_-]{8,100}$' then perform private.fail('VALIDATION_ERROR', 'Invalid idempotency key'); end if;
  if p_purpose not in ('share_property_recommendations', 'clarify_requirements', 're_engagement') then perform private.fail('VALIDATION_ERROR', 'Invalid purpose'); end if;
  select * into l from public.leads where id = p_lead;
  if l.id is null or not public.has_perm(l.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
  if not private.fu_can_act(l.organization_id, l.assigned_to) then perform private.fail('FORBIDDEN', 'You cannot plan follow-ups for this lead'); end if;
  if (select count(*) from public.agent_runs where organization_id = l.organization_id and agent_id = 'follow_up_agent' and lead_id = l.id
        and received_at > now() - interval '1 hour' and trigger_event = 'follow_up.requested') >= 10 then
    perform private.fail('RATE_LIMITED', 'Too many follow-up requests for this lead; try again later');
  end if;
  rid := private.fu_enqueue(l.organization_id, l.id, 'follow_up.requested', 'manual:' || p_idempotency_key, 'manual', null, jsonb_build_object('purpose', p_purpose));
  perform private.write_audit(l.organization_id, 'follow_up.requested', 'leads', l.id, jsonb_build_object('run', rid, 'purpose', p_purpose));
  return jsonb_build_object('run_id', rid);
end;
$$;

-- Helper for the action RPCs: lock, authorize, and return the row with its lead.
create or replace function private.fu_load_for_action(p_follow_up uuid)
returns public.follow_ups
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.follow_ups;
  assigned uuid;
begin
  select * into f from public.follow_ups where id = p_follow_up for update;
  if f.id is null or not public.has_perm(f.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Follow-up not found'); end if;
  select assigned_to into assigned from public.leads where id = f.lead_id;
  if not private.fu_can_act(f.organization_id, assigned) then perform private.fail('FORBIDDEN', 'You cannot manage follow-ups for this lead'); end if;
  return f;
end;
$$;

-- A person edits the draft: new content version, approval cleared, AI rewrite cancelled.
create or replace function public.follow_up_update_draft(p_follow_up uuid, p_subject text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.follow_ups := private.fu_load_for_action(p_follow_up);
  b text := trim(coalesce(p_body, ''));
begin
  if f.status not in ('pending_approval', 'approved') or f.kind <> 'message' then perform private.fail('CONFLICT', 'Only unsent drafts can be edited'); end if;
  if position(trim(private.fu_footer(f.channel)) in b) = 0 then b := b || private.fu_footer(f.channel); end if;
  if char_length(b) < 10 or char_length(b) > private.fu_limit(f.channel) then perform private.fail('VALIDATION_ERROR', format('Message must be 10–%s characters', private.fu_limit(f.channel))); end if;
  if f.channel = 'email' and char_length(trim(coalesce(p_subject, ''))) not between 1 and 150 then perform private.fail('VALIDATION_ERROR', 'Email needs a subject'); end if;
  update public.follow_ups set body = b, subject = case when f.channel = 'email' then trim(p_subject) end, content_version = content_version + 1,
    generated_by = 'human', draft_status = case when draft_status = 'pending' then 'not_requested' else draft_status end,
    status = 'pending_approval', approved_by = null, approved_at = null, approved_version = null
  where id = f.id returning * into f;
  perform private.write_audit(f.organization_id, 'follow_up.edited', 'follow_ups', f.id, jsonb_build_object('version', f.content_version));
  return jsonb_build_object('status', f.status, 'content_version', f.content_version);
end;
$$;

-- approve (exact version), reject (note), cancel.
create or replace function public.follow_up_decide(p_follow_up uuid, p_decision text, p_expected_version int default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.follow_ups := private.fu_load_for_action(p_follow_up);
  pol jsonb;
  prov text;
begin
  if p_decision not in ('approve', 'reject', 'cancel') then perform private.fail('VALIDATION_ERROR', 'Invalid decision'); end if;
  if p_decision = 'approve' then
    if f.status <> 'pending_approval' then perform private.fail('CONFLICT', 'Only drafts awaiting approval can be approved'); end if;
    if p_expected_version is distinct from f.content_version then perform private.fail('CONFLICT', 'The draft changed; review the latest version'); end if;
    if private.fu_content_problem(f) is not null then perform private.fail('VALIDATION_ERROR', 'Draft cannot be sent: ' || private.fu_content_problem(f)); end if;
    pol := private.fu_policy(f.lead_id, f.channel, f.consent_purpose, now(), f.id);
    if (pol ->> 'blocked')::boolean then
      update public.follow_ups set status = 'suppressed', status_reason = left('Blocked: ' || (select string_agg(y, ', ') from jsonb_array_elements_text(pol -> 'failed') y), 300) where id = f.id;
      perform private.fail('POLICY_BLOCKED', 'Blocked by policy: ' || (select string_agg(y, ', ') from jsonb_array_elements_text(pol -> 'failed') y));
    end if;
    prov := private.fu_provider(f.organization_id, f.channel);
    update public.follow_ups set status = case when prov is null then 'approved' else 'scheduled' end, approved_by = auth.uid(), approved_at = now(),
      approved_version = f.content_version, draft_status = case when draft_status = 'pending' then 'not_requested' else draft_status end,
      scheduled_for = coalesce((pol ->> 'defer_until')::timestamptz, now()), status_reason = case when prov is null then 'No provider connected; send manually and mark as sent' end,
      policy = pol - 'checks' || jsonb_build_object('checks', pol -> 'checks')
    where id = f.id returning * into f;
    if f.status = 'scheduled' then perform private.fu_event(f, 'follow_up.scheduled'); end if;
  elsif p_decision = 'reject' then
    if f.status not in ('pending_approval', 'approved') then perform private.fail('CONFLICT', 'Only unsent drafts can be rejected'); end if;
    if char_length(trim(coalesce(p_note, ''))) < 3 then perform private.fail('VALIDATION_ERROR', 'Add a short note'); end if;
    update public.follow_ups set status = 'cancelled', rejected_by = auth.uid(), rejection_note = left(trim(p_note), 500), status_reason = 'Rejected by a reviewer'
    where id = f.id returning * into f;
  else
    if f.status not in ('pending_approval', 'approved', 'scheduled') then perform private.fail('CONFLICT', 'This follow-up can no longer be cancelled'); end if;
    update public.follow_ups set status = 'cancelled', status_reason = left(coalesce(nullif(trim(p_note), ''), 'Cancelled by a person'), 300) where id = f.id returning * into f;
  end if;
  perform private.write_audit(f.organization_id, 'follow_up.' || p_decision, 'follow_ups', f.id, jsonb_build_object('version', f.content_version, 'status', f.status));
  return jsonb_build_object('status', f.status, 'content_version', f.content_version);
end;
$$;

-- A person sent the approved text through their own channel. Policy and facts are re-checked now.
create or replace function public.follow_up_mark_sent(p_follow_up uuid, p_expected_version int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.follow_ups := private.fu_load_for_action(p_follow_up);
  pol jsonb;
  prob text;
begin
  if f.status <> 'approved' then perform private.fail('CONFLICT', 'Only approved messages can be marked as sent'); end if;
  if f.approved_version is distinct from f.content_version or p_expected_version is distinct from f.content_version then
    perform private.fail('CONFLICT', 'The message changed after approval; approve the latest version');
  end if;
  prob := private.fu_content_problem(f);
  if prob is not null then
    update public.follow_ups set status = 'cancelled', status_reason = 'Content no longer valid: ' || prob where id = f.id;
    return jsonb_build_object('status', 'cancelled', 'reason', prob);
  end if;
  pol := private.fu_policy(f.lead_id, f.channel, f.consent_purpose, now(), f.id);
  if (pol ->> 'blocked')::boolean then
    update public.follow_ups set status = 'suppressed', status_reason = left('Blocked at send time: ' || (select string_agg(y, ', ') from jsonb_array_elements_text(pol -> 'failed') y), 300) where id = f.id;
    return jsonb_build_object('status', 'suppressed', 'reason', pol -> 'failed');
  end if;
  if not (pol ->> 'allowed')::boolean then
    perform private.fail('POLICY_DEFERRED', 'Not allowed right now (' || (select string_agg(y, ', ') from jsonb_array_elements_text(pol -> 'failed') y) || '); earliest ' || coalesce(pol ->> 'defer_until', 'unknown'));
  end if;
  update public.follow_ups set status = 'sent', sent_via = 'manual', sent_at = now(), sent_by = auth.uid(), policy = pol - 'checks' || jsonb_build_object('checks', pol -> 'checks')
  where id = f.id returning * into f;
  perform private.fu_after_send(f);
  perform private.write_audit(f.organization_id, 'follow_up.sent_manually', 'follow_ups', f.id, jsonb_build_object('version', f.content_version, 'channel', f.channel));
  return jsonb_build_object('status', f.status);
end;
$$;

create or replace function public.follow_up_reschedule(p_follow_up uuid, p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.follow_ups := private.fu_load_for_action(p_follow_up);
  pol jsonb;
begin
  if f.status not in ('scheduled', 'approved') then perform private.fail('CONFLICT', 'Only approved or scheduled messages can be rescheduled'); end if;
  if p_at is null or p_at < now() - interval '1 minute' or p_at > now() + interval '30 days' then perform private.fail('VALIDATION_ERROR', 'Choose a time within the next 30 days'); end if;
  pol := private.fu_policy(f.lead_id, f.channel, f.consent_purpose, p_at, f.id);
  update public.follow_ups set scheduled_for = greatest(p_at, coalesce((pol ->> 'defer_until')::timestamptz, p_at)) where id = f.id returning * into f;
  return jsonb_build_object('status', f.status, 'scheduled_for', f.scheduled_for);
end;
$$;

-- Failed (not ambiguous) → back to approved, so a person can send it or the provider retries after re-approval.
create or replace function public.follow_up_retry(p_follow_up uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.follow_ups := private.fu_load_for_action(p_follow_up);
begin
  if f.status <> 'failed' then perform private.fail('CONFLICT', 'Only failed follow-ups can be retried'); end if;
  if f.last_error_category = 'ambiguous' then perform private.fail('CONFLICT', 'The send outcome is unknown; check the provider before resending'); end if;
  update public.follow_ups set status = 'pending_approval', approved_by = null, approved_at = null, approved_version = null, attempt_count = 0, status_reason = 'Retry requested; re-approve'
  where id = f.id returning * into f;
  return jsonb_build_object('status', f.status);
end;
$$;

create or replace function public.follow_up_settings_save(p_org uuid, p_rules jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ver int;
begin
  if not public.has_perm(p_org, 'settings.manage') then perform private.fail('FORBIDDEN', 'You cannot change follow-up rules'); end if;
  if jsonb_typeof(p_rules) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_rules) k where k not in ('enabled', 'channels', 'window', 'max_per_week', 'min_hours_between', 'max_unanswered',
          'human_cooldown_hours', 'max_properties', 'share_unverified', 'max_questions', 'use_cases', 'reengage_after_days', 'llm_drafting', 'expiry_hours'))
     or (p_rules ? 'enabled' and jsonb_typeof(p_rules -> 'enabled') <> 'boolean')
     or (p_rules ? 'share_unverified' and jsonb_typeof(p_rules -> 'share_unverified') <> 'boolean')
     or (p_rules ? 'llm_drafting' and jsonb_typeof(p_rules -> 'llm_drafting') <> 'boolean')
     or (p_rules ? 'channels' and (jsonb_typeof(p_rules -> 'channels') <> 'array'
         or exists (select 1 from jsonb_array_elements(p_rules -> 'channels') x where jsonb_typeof(x) <> 'string' or x #>> '{}' not in ('whatsapp', 'sms', 'email'))))
     or (p_rules ? 'window' and (jsonb_typeof(p_rules -> 'window') <> 'object'
         or coalesce((p_rules -> 'window' ->> 'start')::int, -1) not between 0 and 23 or coalesce((p_rules -> 'window' ->> 'end')::int, -1) not between 1 and 24
         or (p_rules -> 'window' ->> 'start')::int >= (p_rules -> 'window' ->> 'end')::int))
     or (p_rules ? 'max_per_week' and coalesce((p_rules ->> 'max_per_week')::int, 0) not between 1 and 14)
     or (p_rules ? 'min_hours_between' and coalesce((p_rules ->> 'min_hours_between')::int, -1) not between 1 and 336)
     or (p_rules ? 'max_unanswered' and coalesce((p_rules ->> 'max_unanswered')::int, 0) not between 1 and 10)
     or (p_rules ? 'human_cooldown_hours' and coalesce((p_rules ->> 'human_cooldown_hours')::int, -1) not between 0 and 336)
     or (p_rules ? 'max_properties' and coalesce((p_rules ->> 'max_properties')::int, 0) not between 1 and 5)
     or (p_rules ? 'max_questions' and coalesce((p_rules ->> 'max_questions')::int, 0) not between 1 and 3)
     or (p_rules ? 'reengage_after_days' and coalesce((p_rules ->> 'reengage_after_days')::int, 0) not between 14 and 365)
     or (p_rules ? 'expiry_hours' and coalesce((p_rules ->> 'expiry_hours')::int, 0) not between 1 and 720)
     or (p_rules ? 'use_cases' and (jsonb_typeof(p_rules -> 'use_cases') <> 'object'
         or exists (select 1 from jsonb_each(p_rules -> 'use_cases') e where e.key not in ('share_property_recommendations', 'clarify_requirements', 'answer_call_questions', 're_engagement')
                    or jsonb_typeof(e.value) <> 'boolean')))
  then
    perform private.fail('VALIDATION_ERROR', 'Follow-up rules are invalid');
  end if;
  insert into public.follow_up_settings (organization_id, rules, updated_by) values (p_org, p_rules, auth.uid())
  on conflict (organization_id) do update set rules = excluded.rules, version = public.follow_up_settings.version + 1, updated_by = excluded.updated_by
  returning version into ver;
  return ver;
exception
  when invalid_text_representation then perform private.fail('VALIDATION_ERROR', 'Follow-up rules are invalid'); return null;
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke all on function private.fu_default_rules(), private.fu_rules(uuid), private.fu_next_window(text, jsonb, jsonb, timestamptz),
  private.fu_policy(uuid, text, text, timestamptz, uuid), private.fu_pick_channel(uuid, text, jsonb), private.fu_provider(uuid, text), private.fu_footer(text),
  private.fu_limit(text), private.fu_render(text, text, jsonb), private.fu_content_problem(public.follow_ups), private.fu_can_act(uuid, uuid),
  private.fu_activity(public.follow_ups, text, text), private.fu_event(public.follow_ups, text), private.fu_stop(uuid, uuid, text, text, text),
  private.fu_create(public.agent_runs, public.leads, text, text, text, text, text, jsonb, uuid[], text, uuid, uuid, uuid, uuid),
  private.fu_enqueue(uuid, uuid, text, text, text, uuid, jsonb), private.fu_execute(public.agent_runs), private.fu_after_send(public.follow_ups),
  private.fu_on_consent(), private.fu_on_contact(), private.fu_on_lead(), private.fu_on_match(), private.fu_fanout(), private.fu_load_for_action(uuid)
  from public, anon, authenticated;
revoke execute on function public.follow_up_process(uuid), public.follow_up_tick(int), public.follow_up_draft_claim(int), public.follow_up_attach_draft(uuid, int, jsonb, jsonb),
  public.follow_up_dispatch_claim(int), public.follow_up_dispatch_result(uuid, text, text, text), public.follow_up_worker_secret_ok(text) from public, anon, authenticated;
grant execute on function public.follow_up_process(uuid), public.follow_up_tick(int), public.follow_up_draft_claim(int), public.follow_up_attach_draft(uuid, int, jsonb, jsonb),
  public.follow_up_dispatch_claim(int), public.follow_up_dispatch_result(uuid, text, text, text), public.follow_up_worker_secret_ok(text) to service_role;
revoke execute on function public.lead_follow_ups(uuid), public.follow_up_request(uuid, text, text), public.follow_up_update_draft(uuid, text, text),
  public.follow_up_decide(uuid, text, int, text), public.follow_up_mark_sent(uuid, int), public.follow_up_reschedule(uuid, timestamptz), public.follow_up_retry(uuid),
  public.follow_up_settings_save(uuid, jsonb) from public, anon;
grant execute on function public.lead_follow_ups(uuid), public.follow_up_request(uuid, text, text), public.follow_up_update_draft(uuid, text, text),
  public.follow_up_decide(uuid, text, int, text), public.follow_up_mark_sent(uuid, int), public.follow_up_reschedule(uuid, timestamptz), public.follow_up_retry(uuid),
  public.follow_up_settings_save(uuid, jsonb) to authenticated;

-- ───────────────────────── schedules ─────────────────────────
-- follow-up-tick: pure SQL (outbox consumer, planning, expiry, reconciliation).
-- follow-up-worker: pg_net → Edge Function for Claude drafting and provider dispatch; inactive until 'follow_up_worker_url' is in Vault.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'follow_up_worker_secret') then
    perform vault.create_secret(private.random_token() || private.random_token(), 'follow_up_worker_secret', 'Shared secret for the follow-up-worker Edge Function');
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if not exists (select 1 from cron.job where jobname = 'follow-up-tick') then
      perform cron.schedule('follow-up-tick', '* * * * *', 'select public.follow_up_tick(25)');
    end if;
    if exists (select 1 from pg_available_extensions where name = 'pg_net') and not exists (select 1 from cron.job where jobname = 'follow-up-worker') then
      create extension if not exists pg_net with schema extensions;
      perform cron.schedule('follow-up-worker', '* * * * *', $job$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'follow_up_worker_url'),
          headers := jsonb_build_object('Content-Type', 'application/json',
            'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'follow_up_worker_secret')),
          body := '{}'::jsonb, timeout_milliseconds := 55000)
        where exists (select 1 from vault.decrypted_secrets where name = 'follow_up_worker_url')
      $job$);
    end if;
  end if;
end;
$$;
