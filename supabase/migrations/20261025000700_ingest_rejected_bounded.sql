-- Estate OS · 0007 · ingest_lead records signature failures through the bounded recorder (0006)
-- Same as 0004 except the rejected branch, which previously inserted one unique row per call.

create or replace function public.ingest_lead(p_org uuid, p_provider text, p_event_id text, p_payload jsonb, p_signature_ok boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  evt_id uuid;
  v_name text := left(trim(p_payload ->> 'name'), 160);
  v_phone text := nullif(trim(p_payload ->> 'phone'), '');
  v_email text := lower(nullif(trim(p_payload ->> 'email'), ''));
  v_locations text[] := coalesce((select array_agg(left(x, 120)) from (select x from jsonb_array_elements_text(coalesce(p_payload -> 'locations', '[]')) x limit 10) l), '{}');
  v_contact uuid;
  v_lead uuid;
  ch text;
begin
  if not exists (select 1 from public.organizations where id = p_org and deleted_at is null) then
    perform private.fail('NOT_FOUND', 'Unknown organization');
  end if;
  if not p_signature_ok then
    perform public.record_rejected_webhook(p_org, p_provider);
    return jsonb_build_object('status', 'rejected');
  end if;

  insert into public.webhook_events (organization_id, provider, provider_event_id, event_type, signature_verified)
  values (p_org, p_provider, p_event_id, 'lead.created', true)
  on conflict (organization_id, provider, provider_event_id) do nothing
  returning id into evt_id;
  if evt_id is null then
    update public.webhook_events set attempt_count = attempt_count + 1
    where organization_id = p_org and provider = p_provider and provider_event_id = p_event_id;
    return jsonb_build_object('status', 'duplicate_event',
      'lead_id', (select lead_id from public.webhook_events where organization_id = p_org and provider = p_provider and provider_event_id = p_event_id));
  end if;

  if v_name is null or v_name = '' or (v_phone is null and v_email is null)
     or (v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
     or (v_phone is not null and length(regexp_replace(v_phone, '\D', '', 'g')) < 10) then
    update public.webhook_events set processing_status = 'failed', last_error = 'Payload validation failed: name and a valid phone or email are required', processed_at = now() where id = evt_id;
    return jsonb_build_object('status', 'invalid');
  end if;

  select id into v_contact from public.contacts
  where organization_id = p_org and ((v_phone is not null and phone_e164 = private.normalize_phone(v_phone)) or (v_email is not null and email_normalized = v_email))
  order by created_at limit 1;

  if v_contact is null then
    insert into public.contacts (organization_id, display_name, email, phone, roles, source)
    values (p_org, v_name, v_email, v_phone, array['buyer'], left(p_provider, 80)) returning id into v_contact;
    foreach ch in array array['phone', 'whatsapp', 'sms', 'email'] loop
      insert into public.communication_consents (organization_id, contact_id, channel, status)
      values (p_org, v_contact, ch, case when ch = any (coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p_payload -> 'consent_channels', '[]')) x), '{}')) then 'granted' else 'unknown' end);
    end loop;
  end if;

  insert into public.leads (organization_id, contact_id, title, source, source_campaign, source_external_id, assigned_to, desired_locations,
    budget_max, summary, next_follow_up_at)
  values (p_org, v_contact, v_name, left(coalesce(p_payload ->> 'source', p_provider), 80), left(p_payload ->> 'campaign', 120), left(p_event_id, 200),
    private.pick_assignee(p_org, v_locations), v_locations,
    case when (p_payload ->> 'budget_max') ~ '^[0-9]+(\.[0-9]+)?$' then (p_payload ->> 'budget_max')::numeric end,
    left(p_payload ->> 'message', 2000), now() + interval '15 minutes')
  returning id into v_lead;

  update public.webhook_events set processing_status = 'processed', lead_id = v_lead, processed_at = now() where id = evt_id;
  return jsonb_build_object('status', 'created', 'lead_id', v_lead, 'contact_existed', v_contact is not null);
end;
$$;
