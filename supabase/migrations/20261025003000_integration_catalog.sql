-- Self-serve integration connections (additive). Lets a member with integrations.manage store a provider API key,
-- access token or webhook URL for one of the catalog's api_key-type tools (frontend: lib/integrationCatalog.ts) in the
-- database Vault, and marks the integration connected. OAuth providers (Google Workspace, Microsoft 365, DocuSign,
-- QuickBooks, Meta Lead Ads, Google Lead Form Ads, Zoom) are not connected through this path — they need an OAuth app
-- registered by a developer first — and env-configured ones (Anthropic, Retell AI Voice) are configured on the server,
-- outside this page.
--
-- Nothing here sends a message, places a call or syncs a calendar: no provider adapter exists yet
-- (see supabase/functions/_shared/follow-up-delivery.ts and _shared/calendar-sync.ts, both empty ADAPTERS maps), so a
-- connected row here only changes what this page shows until a developer wires a real adapter for that provider.

alter table public.integrations drop constraint if exists integrations_integration_type_check;
alter table public.integrations add constraint integrations_integration_type_check
  check (integration_type in ('lead_source', 'telephony', 'messaging', 'calendar', 'email', 'ai', 'automation', 'productivity', 'marketing', 'payments', 'esignature', 'other'));

/** Stores a credential in Vault and marks the integration connected; creates the row on first connect, otherwise
    rotates the stored credential in place. The credential itself is never returned or logged. */
create or replace function public.integration_connect_api_key(p_org uuid, p_provider text, p_type text, p_display_name text, p_credential text, p_scopes text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ref uuid;
  rec public.integrations;
begin
  if not public.has_perm(p_org, 'integrations.manage') then perform private.fail('FORBIDDEN', 'You cannot manage integrations'); end if;
  if coalesce(p_provider, '') = '' or char_length(p_provider) > 60 then perform private.fail('VALIDATION_ERROR', 'Unknown integration'); end if;
  if coalesce(trim(p_display_name), '') = '' then perform private.fail('VALIDATION_ERROR', 'Missing integration name'); end if;
  if coalesce(trim(p_credential), '') = '' or char_length(p_credential) > 4000 then perform private.fail('VALIDATION_ERROR', 'Enter a key, token or URL'); end if;

  select secret_reference into ref from public.integrations where organization_id = p_org and provider = p_provider;
  if ref is null then
    ref := vault.create_secret(p_credential, 'integration:' || p_org::text || ':' || p_provider, p_display_name || ' credential');
    insert into public.integrations (organization_id, provider, integration_type, display_name, status, secret_reference, scopes)
    values (p_org, p_provider, p_type, p_display_name, 'connected', ref, coalesce(p_scopes, '{}'))
    returning * into rec;
  else
    perform vault.update_secret(ref, p_credential);
    update public.integrations set status = 'connected', integration_type = p_type, display_name = p_display_name, scopes = coalesce(p_scopes, '{}'), last_error = null, updated_at = now()
    where organization_id = p_org and provider = p_provider
    returning * into rec;
  end if;
  perform private.write_audit(p_org, 'integrations.connected', 'integrations', rec.id, jsonb_build_object('provider', p_provider));
  return to_jsonb(rec) - 'secret_reference';
end;
$$;

/** Disconnects an integration. The row and its history stay; the stored credential is simply no longer used. */
create or replace function public.integration_disconnect(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
begin
  select organization_id into org from public.integrations where id = p_id;
  if org is null or not public.has_perm(org, 'integrations.manage') then perform private.fail('NOT_FOUND', 'Integration not found'); end if;
  update public.integrations set status = 'disconnected', updated_at = now() where id = p_id;
  perform private.write_audit(org, 'integrations.disconnected', 'integrations', p_id, '{}');
end;
$$;

/** Confirms the stored credential still decrypts and refreshes last_synced_at. Never calls the provider — there is
    nothing to call yet (no adapter); this only checks that what we stored is still readable. */
create or replace function public.integration_check(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rec public.integrations;
  secret text;
begin
  select * into rec from public.integrations where id = p_id;
  if rec.id is null or not public.has_perm(rec.organization_id, 'integrations.manage') then perform private.fail('NOT_FOUND', 'Integration not found'); end if;
  if rec.secret_reference is not null then
    select decrypted_secret into secret from vault.decrypted_secrets where id = rec.secret_reference;
    if secret is null then
      update public.integrations set status = 'error', last_error = 'Stored credential could not be read' where id = rec.id returning * into rec;
      perform private.write_audit(rec.organization_id, 'integrations.check_failed', 'integrations', rec.id, '{}');
      return jsonb_build_object('ok', false, 'status', rec.status);
    end if;
  end if;
  update public.integrations set last_synced_at = now(), last_error = null where id = rec.id returning * into rec;
  perform private.write_audit(rec.organization_id, 'integrations.checked', 'integrations', rec.id, '{}');
  return jsonb_build_object('ok', true, 'status', rec.status, 'last_synced_at', rec.last_synced_at);
end;
$$;

revoke execute on function public.integration_connect_api_key(uuid, text, text, text, text, text[]), public.integration_disconnect(uuid), public.integration_check(uuid) from public, anon;
grant execute on function public.integration_connect_api_key(uuid, text, text, text, text, text[]), public.integration_disconnect(uuid), public.integration_check(uuid) to authenticated;
