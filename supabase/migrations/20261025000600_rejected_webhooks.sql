-- Estate OS · 0006 · Bounded record of webhook signature failures
-- One row per organization, provider and minute; repeats only bump attempt_count, so forged traffic cannot grow the table
-- without bound while admins still see failures in the Integrations event log.

create or replace function public.record_rejected_webhook(p_org uuid, p_provider text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.webhook_events (organization_id, provider, provider_event_id, event_type, signature_verified, processing_status, last_error)
  values (p_org, p_provider, 'rejected:' || to_char(now() at time zone 'utc', 'YYYYMMDDHH24MI'), 'lead.created', false, 'rejected', 'Invalid signature')
  on conflict (organization_id, provider, provider_event_id) do update set attempt_count = public.webhook_events.attempt_count + 1;
$$;

revoke execute on function public.record_rejected_webhook(uuid, text) from public, anon, authenticated;
grant execute on function public.record_rejected_webhook(uuid, text) to service_role;
