-- Estate OS · 0031 · Unified inbox, email channel (Postmark). Live backend for the previously demo-only Inbox page:
-- conversations, messages, per-org email settings, and the RPCs the frontend and the email-inbound/inbox-email Edge
-- Functions call. WhatsApp and SMS are not built yet; `channel` is constrained to 'email' alone so this cannot be
-- half-wired for a channel with no adapter behind it. There is no AI auto-responder for email yet — a new
-- conversation always starts 'unassigned'/'human'; `conversation_resume_ai` exists for schema forward-compatibility
-- but nothing currently answers while owner = 'ai'. Additive only.

-- ───────────────────────── settings ─────────────────────────

create table public.email_settings (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  enabled boolean not null default false,
  from_address text check (from_address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  from_name text check (char_length(from_name) between 2 and 80),
  -- The Postmark inbound stream's address for this org (its own "hash@inbound.postmarkapp.com", or a custom forward).
  -- The inbound webhook routes a message to an org by matching this, not by trusting anything in the payload.
  inbound_address text unique check (inbound_address ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger email_settings_updated_at before update on public.email_settings for each row execute function public.set_updated_at();
create trigger email_settings_audit after insert or update on public.email_settings for each row execute function private.audit_row();
alter table public.email_settings enable row level security;
create policy email_settings_read on public.email_settings for select to authenticated using (public.has_perm(organization_id, 'integrations.manage'));
revoke all on public.email_settings from anon;
revoke insert, update, delete, truncate on public.email_settings from authenticated;

create or replace function public.email_settings_save(p_org uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_perm(p_org, 'integrations.manage') then perform private.fail('FORBIDDEN', 'You cannot manage integrations'); end if;
  if jsonb_typeof(p) is distinct from 'object' then perform private.fail('VALIDATION_ERROR', 'Invalid settings'); end if;
  begin
    insert into public.email_settings (organization_id, enabled, from_address, from_name, inbound_address, updated_by)
    values (p_org, coalesce((p ->> 'enabled')::boolean, false), nullif(lower(trim(p ->> 'from_address')), ''),
      nullif(trim(p ->> 'from_name'), ''), nullif(lower(trim(p ->> 'inbound_address')), ''), auth.uid())
    on conflict (organization_id) do update set enabled = excluded.enabled, from_address = excluded.from_address,
      from_name = excluded.from_name, inbound_address = excluded.inbound_address, updated_by = excluded.updated_by;
  exception
    when unique_violation then perform private.fail('CONFLICT', 'That inbound address is already linked to another workspace');
    when check_violation or invalid_text_representation then perform private.fail('VALIDATION_ERROR', 'One or more email settings are invalid');
  end;
  if coalesce((p ->> 'enabled')::boolean, false) and exists (select 1 from public.email_settings where organization_id = p_org
      and (from_address is null or from_name is null or inbound_address is null)) then
    perform private.fail('VALIDATION_ERROR', 'From address, sender name and inbound address are required to enable email');
  end if;
end;
$$;
revoke execute on function public.email_settings_save(uuid, jsonb) from public, anon;
grant execute on function public.email_settings_save(uuid, jsonb) to authenticated;

-- ───────────────────────── conversations & messages ─────────────────────────

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contact_id uuid not null references public.contacts (id) on delete restrict,
  lead_id uuid references public.leads (id) on delete set null,
  channel text not null check (channel in ('email')),
  status text not null default 'open' check (status in ('open', 'pending', 'resolved')),
  owner text not null default 'unassigned' check (owner in ('ai', 'human', 'unassigned')),
  assigned_to uuid references public.profiles (id) on delete set null,
  unread integer not null default 0 check (unread >= 0),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id, channel)
);
create index conversations_org_last_message_idx on public.conversations (organization_id, last_message_at desc);
create trigger conversations_updated_at before update on public.conversations for each row execute function public.set_updated_at();
alter table public.conversations enable row level security;
create policy conversations_read on public.conversations for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
revoke all on public.conversations from anon;
revoke insert, update, delete, truncate on public.conversations from authenticated;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  direction text not null check (direction in ('in', 'out', 'internal', 'system')),
  sender text not null check (sender in ('contact', 'user', 'ai', 'system')),
  sender_name text not null check (char_length(sender_name) <= 120),
  subject text check (char_length(subject) <= 500),
  body text not null check (char_length(body) <= 20000),
  status text not null default 'sent' check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'received', 'blocked')),
  last_error text,
  provider text check (provider in ('postmark')),
  provider_message_id text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);
-- Inbound dedupe: Postmark may retry a webhook delivery; the same provider message must only ever land once.
create unique index messages_provider_dedupe_idx on public.messages (provider, provider_message_id) where provider_message_id is not null;
alter table public.messages enable row level security;
create policy messages_read on public.messages for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
revoke all on public.messages from anon;
revoke insert, update, delete, truncate on public.messages from authenticated;

-- ───────────────────────── outbound: reply / note ─────────────────────────

/**
 * Policy mirror of frontend/src/lib/domain.ts outboundPolicy(..., { purpose: 'service' }). Keep both in step.
 * Returns jsonb {ok, reason} rather than OUT parameters, which `select fn() into v1, v2` does not reliably unpack
 * across every Postgres-compatible engine this is tested against.
 */
create or replace function private.inbox_outbound_allowed(p_org uuid, p_contact uuid, p_channel text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  paused boolean;
  dnc boolean;
  consent text;
begin
  select coalesce((settings ->> 'outbound_paused')::boolean, false) into paused from public.organizations where id = p_org;
  if paused then return jsonb_build_object('ok', false, 'reason', 'Organization outbound switch: all outbound paused by kill switch'); end if;
  select lifecycle_status = 'do_not_contact' into dnc from public.contacts where id = p_contact;
  if coalesce(dnc, true) then return jsonb_build_object('ok', false, 'reason', 'Suppression list: contact is on the do-not-contact list'); end if;
  select status into consent from public.communication_consents where contact_id = p_contact and channel = p_channel and purpose = 'service';
  if coalesce(consent, 'unknown') is distinct from 'granted' then return jsonb_build_object('ok', false, 'reason', format('%s consent: not granted', initcap(p_channel))); end if;
  return jsonb_build_object('ok', true);
end;
$$;

/**
 * Reserves an outbound reply or records an internal note. An internal note needs no provider send and is complete
 * on return (dispatch = false). A reply is inserted 'queued' and reserved here; the inbox-email Edge Function sends
 * it through Postmark and reports the outcome with conversation_message_mark_sent / _failed.
 */
create or replace function public.conversation_send_request(p_conv uuid, p_body text, p_internal boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.conversations;
  es public.email_settings;
  me uuid := auth.uid();
  my_name text;
  body text := trim(coalesce(p_body, ''));
  policy jsonb;
  reason text;
  msg public.messages;
begin
  select * into c from public.conversations where id = p_conv;
  if c.id is null or not public.has_perm(c.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Conversation not found'); end if;
  if not public.has_perm(c.organization_id, 'inbox.reply') then perform private.fail('FORBIDDEN', 'You cannot reply in the inbox'); end if;
  if char_length(body) = 0 or char_length(body) > 20000 then perform private.fail('VALIDATION_ERROR', 'Message cannot be empty'); end if;
  my_name := private.actor_name();

  if p_internal then
    insert into public.messages (organization_id, conversation_id, direction, sender, sender_name, body, status, created_by)
    values (c.organization_id, c.id, 'internal', 'user', coalesce(my_name, 'Teammate'), body, 'sent', me)
    returning * into msg;
    update public.conversations set last_message_at = now() where id = c.id;
    return jsonb_build_object('dispatch', false, 'message_id', msg.id);
  end if;

  policy := private.inbox_outbound_allowed(c.organization_id, c.contact_id, c.channel);
  if not (policy ->> 'ok')::boolean then
    -- A normal return, not an exception: perform private.fail would roll back the blocked-message insert below
    -- along with it, in the same transaction. voice_call_request's 'blocked' result is the same pattern.
    reason := policy ->> 'reason';
    insert into public.messages (organization_id, conversation_id, direction, sender, sender_name, body, status, created_by)
    values (c.organization_id, c.id, 'system', 'system', 'Policy', format('Not sent — %s', reason), 'blocked', me);
    return jsonb_build_object('dispatch', false, 'blocked', true, 'reason', reason);
  end if;

  select * into es from public.email_settings where organization_id = c.organization_id;
  if not coalesce(es.enabled, false) or es.from_address is null then perform private.fail('VALIDATION_ERROR', 'Email is not configured for this workspace'); end if;

  insert into public.messages (organization_id, conversation_id, direction, sender, sender_name, body, status, created_by)
  values (c.organization_id, c.id, 'out', 'user', coalesce(my_name, 'Teammate'), body, 'queued', me)
  returning * into msg;
  update public.conversations set
    owner = case when owner in ('ai', 'unassigned') then 'human' else owner end,
    assigned_to = coalesce(assigned_to, me), status = 'open', last_message_at = now()
  where id = c.id;

  return jsonb_build_object('dispatch', true, 'message_id', msg.id,
    'to_address', (select email from public.contacts where id = c.contact_id),
    'from_address', es.from_address, 'from_name', es.from_name,
    'subject', coalesce((select 'Re: ' || l.title from public.leads l where l.id = c.lead_id), 'Re: your enquiry'), 'body', body);
end;
$$;
revoke execute on function public.conversation_send_request(uuid, text, boolean) from public, anon;
grant execute on function public.conversation_send_request(uuid, text, boolean) to authenticated;

create or replace function public.conversation_message_mark_sent(p_message uuid, p_provider_message_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare org uuid;
begin
  select organization_id into org from public.messages where id = p_message;
  if org is null then perform private.fail('NOT_FOUND', 'Message not found'); end if;
  update public.messages set status = 'sent', provider = 'postmark', provider_message_id = p_provider_message_id where id = p_message;
end;
$$;

create or replace function public.conversation_message_mark_failed(p_message uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare org uuid;
begin
  select organization_id into org from public.messages where id = p_message;
  if org is null then perform private.fail('NOT_FOUND', 'Message not found'); end if;
  update public.messages set status = 'failed', last_error = left(coalesce(p_error, 'Send failed'), 300) where id = p_message;
end;
$$;
revoke execute on function public.conversation_message_mark_sent(uuid, text), public.conversation_message_mark_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.conversation_message_mark_sent(uuid, text), public.conversation_message_mark_failed(uuid, text) to service_role;

-- ───────────────────────── ownership & status ─────────────────────────

create or replace function public.conversation_take_over(p_conv uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare c public.conversations; my_name text;
begin
  select * into c from public.conversations where id = p_conv;
  if c.id is null or not public.has_perm(c.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Conversation not found'); end if;
  if not public.has_perm(c.organization_id, 'inbox.reply') then perform private.fail('FORBIDDEN', 'You cannot manage this conversation'); end if;
  my_name := private.actor_name();
  update public.conversations set owner = 'human', assigned_to = auth.uid() where id = p_conv;
  insert into public.messages (organization_id, conversation_id, direction, sender, sender_name, body, status, created_by)
  values (c.organization_id, c.id, 'system', 'system', 'System', format('%s took over. AI paused for this conversation.', my_name), 'sent', auth.uid());
end;
$$;

create or replace function public.conversation_resume_ai(p_conv uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare c public.conversations; my_name text;
begin
  select * into c from public.conversations where id = p_conv;
  if c.id is null or not public.has_perm(c.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Conversation not found'); end if;
  if not public.has_perm(c.organization_id, 'inbox.reply') then perform private.fail('FORBIDDEN', 'You cannot manage this conversation'); end if;
  my_name := private.actor_name();
  update public.conversations set owner = 'ai' where id = p_conv;
  insert into public.messages (organization_id, conversation_id, direction, sender, sender_name, body, status, created_by)
  values (c.organization_id, c.id, 'system', 'system', 'System', format('%s handed the conversation back to AI.', my_name), 'sent', auth.uid());
end;
$$;

create or replace function public.conversation_set_status(p_conv uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare org uuid;
begin
  if p_status not in ('open', 'pending', 'resolved') then perform private.fail('VALIDATION_ERROR', 'Invalid status'); end if;
  select organization_id into org from public.conversations where id = p_conv;
  if org is null or not public.has_perm(org, 'leads.view') then perform private.fail('NOT_FOUND', 'Conversation not found'); end if;
  if not public.has_perm(org, 'inbox.reply') then perform private.fail('FORBIDDEN', 'You cannot manage this conversation'); end if;
  update public.conversations set status = p_status where id = p_conv;
end;
$$;

create or replace function public.conversation_mark_read(p_conv uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare org uuid;
begin
  select organization_id into org from public.conversations where id = p_conv;
  if org is null or not public.has_perm(org, 'leads.view') then perform private.fail('NOT_FOUND', 'Conversation not found'); end if;
  update public.conversations set unread = 0 where id = p_conv;
end;
$$;
revoke execute on function public.conversation_take_over(uuid), public.conversation_resume_ai(uuid), public.conversation_set_status(uuid, text), public.conversation_mark_read(uuid) from public, anon;
grant execute on function public.conversation_take_over(uuid), public.conversation_resume_ai(uuid), public.conversation_set_status(uuid, text), public.conversation_mark_read(uuid) to authenticated;

-- ───────────────────────── inbound (service role only, from the email-inbound Edge Function) ─────────────────────────

/**
 * Finds or creates the contact and conversation for an inbound email, records the message, detects an opt-out, and
 * leaves a lead-timeline activity when a lead already exists. Org is resolved by the caller (matching the Postmark
 * recipient address against email_settings.inbound_address) — this function trusts p_org once given it, the same
 * way ingest_lead/intake_receive trust their caller's org resolution.
 */
create or replace function public.email_inbound_ingest(p_org uuid, p_from_email text, p_from_name text, p_subject text, p_body text, p_provider_message_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_from_email, '')));
  v_contact public.contacts;
  v_conv public.conversations;
  v_lead_id uuid;
  v_body text := left(coalesce(p_body, ''), 20000);
  opted_out boolean;
begin
  if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform private.fail('VALIDATION_ERROR', 'Invalid sender address'); end if;
  if p_provider_message_id is not null and exists (select 1 from public.messages where provider = 'postmark' and provider_message_id = p_provider_message_id) then
    return jsonb_build_object('result', 'duplicate');
  end if;

  select * into v_contact from public.contacts where organization_id = p_org and email_normalized = v_email limit 1;
  if v_contact.id is null then
    insert into public.contacts (organization_id, display_name, email, roles, source)
    values (p_org, coalesce(nullif(trim(p_from_name), ''), v_email), v_email, array['buyer'], 'Email')
    returning * into v_contact;
    insert into public.communication_consents (organization_id, contact_id, channel, purpose, status, captured_via)
    values (p_org, v_contact.id, 'email', 'service', 'granted', 'Emailed the agency first');
  end if;
  select id into v_lead_id from public.leads where contact_id = v_contact.id order by created_at desc limit 1;

  select * into v_conv from public.conversations where contact_id = v_contact.id and channel = 'email';
  if v_conv.id is null then
    insert into public.conversations (organization_id, contact_id, lead_id, channel, status, owner, unread, last_message_at)
    values (p_org, v_contact.id, v_lead_id, 'email', 'open', 'unassigned', 1, now())
    returning * into v_conv;
  else
    update public.conversations set unread = unread + 1, last_message_at = now(),
      status = case when status = 'resolved' then 'open' else status end
    where id = v_conv.id returning * into v_conv;
  end if;

  insert into public.messages (organization_id, conversation_id, direction, sender, sender_name, subject, body, status, provider, provider_message_id)
  values (p_org, v_conv.id, 'in', 'contact', coalesce(nullif(trim(p_from_name), ''), v_email), nullif(trim(p_subject), ''), v_body, 'received', 'postmark', p_provider_message_id);

  -- No trailing \b: word-boundary support varies across Postgres-compatible engines this is tested against, and an
  -- opt-out phrase mistakenly matching inside a longer first word (e.g. "unsubscribed...") is the safer failure mode.
  opted_out := v_body ~* '^\s*(stop|unsubscribe|opt[\s-]?out|don''?t (call|message|contact) me|remove me)' or coalesce(p_subject, '') ~* '^\s*(stop|unsubscribe)';
  if opted_out then
    update public.communication_consents set status = 'revoked', revoked_at = now()
    where contact_id = v_contact.id and channel = 'email' and purpose = 'service';
    insert into public.messages (organization_id, conversation_id, direction, sender, sender_name, body, status)
    values (p_org, v_conv.id, 'system', 'system', 'System', 'Opt-out recorded for email. No further automated messages.', 'sent');
    perform private.add_activity(p_org, v_lead_id, v_contact.id, null, 'opt_out', 'Opted out of email', coalesce(nullif(trim(p_subject), ''), left(v_body, 200)), 'integration');
  else
    perform private.add_activity(p_org, v_lead_id, v_contact.id, null, 'message', 'Email received', coalesce(nullif(trim(p_subject), ''), left(v_body, 200)), 'integration');
  end if;

  return jsonb_build_object('result', case when opted_out then 'opt_out' else 'ingested' end, 'conversation_id', v_conv.id);
end;
$$;
revoke execute on function public.email_inbound_ingest(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.email_inbound_ingest(uuid, text, text, text, text, text) to service_role;

/** Resolves which org a Postmark inbound address belongs to. Service role only — this is routing, not a client read. */
create or replace function public.email_settings_org_for_inbound(p_inbound_address text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select organization_id from public.email_settings where inbound_address = lower(trim(p_inbound_address)) and enabled;
$$;
revoke execute on function public.email_settings_org_for_inbound(text) from public, anon, authenticated;
grant execute on function public.email_settings_org_for_inbound(text) to service_role;
