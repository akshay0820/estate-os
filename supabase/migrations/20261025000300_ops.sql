-- Estate OS · 0003 · Notifications, audit, documents, integrations

-- ───────────────────────── notifications ─────────────────────────

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete cascade,
  notification_type text not null check (notification_type in ('lead', 'appointment', 'failure', 'approval', 'task', 'system')),
  title text not null check (char_length(title) <= 200),
  body text check (char_length(body) <= 1000),
  entity_type text,
  entity_id uuid,
  link text check (link is null or link ~ '^[a-z]+$'),
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (organization_id, user_id, read_at, created_at desc);
-- Retried events must not notify twice.
create unique index notifications_dedupe_uniq on public.notifications (organization_id, user_id, dedupe_key) where dedupe_key is not null;

alter table public.notifications enable row level security;
create policy notifications_read_own on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) and public.is_org_member(organization_id));
create policy notifications_mark_read on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke insert, update, delete on public.notifications from authenticated, anon;
grant update (read_at) on public.notifications to authenticated;

create or replace function private.notify(org uuid, recipient uuid, kind text, title text, body text, link text, entity_type text, entity_id uuid, dedupe text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if recipient is null or not private.is_active_member(org, recipient) then return; end if;
  insert into public.notifications (organization_id, user_id, notification_type, title, body, link, entity_type, entity_id, dedupe_key)
  values (org, recipient, kind, left(title, 200), left(body, 1000), link, entity_type, entity_id, dedupe)
  on conflict (organization_id, user_id, dedupe_key) where dedupe_key is not null do nothing;
end;
$$;

-- ───────────────────────── audit log (append-only) ─────────────────────────

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete restrict,
  actor_type text not null check (actor_type in ('user', 'ai_agent', 'system', 'integration', 'workflow')),
  actor_user_id uuid references public.profiles (id) on delete set null,
  actor_name text not null default 'System',
  action text not null,
  entity_type text,
  entity_id uuid,
  -- Changed column names and a few safe enum transitions only; never message bodies or secrets.
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (organization_id, entity_type, entity_id, created_at desc);

alter table public.audit_logs enable row level security;
create policy audit_logs_read on public.audit_logs for select to authenticated using (public.has_perm(organization_id, 'audit.view'));
revoke insert, update, delete, truncate on public.audit_logs from authenticated, anon;

create or replace function private.actor_name()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select nullif(full_name, '') from public.profiles where id = auth.uid()), case when auth.uid() is null then 'System' else 'User' end);
$$;

create or replace function private.write_audit(org uuid, action text, entity_type text, entity_id uuid, details jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (organization_id, actor_type, actor_user_id, actor_name, action, entity_type, entity_id, details)
  values (org, case when auth.uid() is null then 'system' else 'user' end, auth.uid(), private.actor_name(), action, entity_type, entity_id, coalesce(details, '{}'));
end;
$$;

-- Generic row auditor: records which columns changed, plus old→new for a few safe enum columns.
create or replace function private.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  n jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  changed text[];
  details jsonb := '{}';
  k text;
  org uuid;
  rec_id uuid;
begin
  org := coalesce((n ->> 'organization_id')::uuid, (o ->> 'organization_id')::uuid, (n ->> 'id')::uuid);
  if tg_table_name = 'organizations' then org := coalesce((n ->> 'id')::uuid, (o ->> 'id')::uuid); end if;
  rec_id := coalesce((n ->> 'id')::uuid, (o ->> 'id')::uuid);
  if tg_op = 'UPDATE' then
    select array_agg(key order by key) into changed
    from jsonb_each(n) e
    where key not in ('updated_at', 'lead_score', 'score_reasons', 'status_rank') and e.value is distinct from o -> key;
    if changed is null then return null; end if;
    details := jsonb_build_object('changed', to_jsonb(changed));
    foreach k in array array['status', 'stage', 'role', 'classification', 'lifecycle_status'] loop
      if k = any (changed) then
        details := details || jsonb_build_object(k, jsonb_build_object('from', o -> k, 'to', n -> k));
      end if;
    end loop;
  end if;
  perform private.write_audit(org, tg_table_name || '.' || lower(tg_op), tg_table_name, rec_id, details);
  return null;
end;
$$;

-- ───────────────────────── documents & storage ─────────────────────────

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 200),
  document_type text not null default 'other' check (document_type in ('agreement', 'id_proof', 'title_deed', 'floor_plan', 'brochure', 'invoice', 'other')),
  status text not null default 'uploaded' check (status in ('uploaded', 'ready', 'failed', 'archived')),
  storage_bucket text not null default 'documents' check (storage_bucket = 'documents'),
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  file_size_bytes bigint not null check (file_size_bytes between 1 and 20971520),
  uploaded_by uuid references public.profiles (id) on delete set null,
  related_contact_id uuid references public.contacts (id) on delete set null,
  related_lead_id uuid references public.leads (id) on delete set null,
  related_property_id uuid references public.properties (id) on delete set null,
  related_deal_id uuid references public.deals (id) on delete set null,
  classification text not null default 'confidential' check (classification in ('general', 'confidential', 'restricted')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Objects live under <organization_id>/<document_id>/<file>, generated by the client and checked here.
  constraint documents_path_scoped check (storage_path like organization_id::text || '/' || id::text || '/%')
);
create index documents_org_created_idx on public.documents (organization_id, created_at desc);

create trigger documents_updated_at before update on public.documents for each row execute function public.set_updated_at();
create trigger documents_org_immutable before update on public.documents for each row execute function private.prevent_org_change();

alter table public.documents enable row level security;
create policy documents_read on public.documents for select to authenticated
  using (public.has_perm(organization_id, 'documents.edit') and (classification <> 'restricted' or public.has_perm(organization_id, 'documents.restricted')));
create policy documents_insert on public.documents for insert to authenticated
  with check (public.has_perm(organization_id, 'documents.edit') and uploaded_by = (select auth.uid())
    and (classification <> 'restricted' or public.has_perm(organization_id, 'documents.restricted')));
create policy documents_update on public.documents for update to authenticated
  using (public.has_perm(organization_id, 'documents.edit') and (classification <> 'restricted' or public.has_perm(organization_id, 'documents.restricted')))
  with check (public.has_perm(organization_id, 'documents.edit') and (classification <> 'restricted' or public.has_perm(organization_id, 'documents.restricted')));
revoke insert, update, delete on public.documents from authenticated, anon;
grant insert (id, organization_id, name, document_type, storage_path, mime_type, file_size_bytes, uploaded_by, related_contact_id,
  related_lead_id, related_property_id, related_deal_id, classification, expires_at) on public.documents to authenticated;
grant update (name, document_type, status, classification, expires_at) on public.documents to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520,
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Object access follows the document row (and therefore its organization and classification).
create or replace function private.can_access_document_object(object_name text, need_write boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.documents d
    where d.storage_path = object_name
      and public.has_perm(d.organization_id, 'documents.edit')
      and (d.classification <> 'restricted' or public.has_perm(d.organization_id, 'documents.restricted'))
      and (not need_write or d.status <> 'archived')
  );
$$;
grant execute on function private.can_access_document_object(text, boolean) to authenticated;

create policy documents_objects_read on storage.objects for select to authenticated
  using (bucket_id = 'documents' and private.can_access_document_object(name, false));
-- Upload only after the metadata row exists (row insert is itself permission-checked), and never overwrite.
create policy documents_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and private.can_access_document_object(name, true));
create policy documents_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and private.can_access_document_object(name, true));

-- ───────────────────────── integrations & webhook events ─────────────────────────

create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  provider text not null check (char_length(provider) <= 60),
  integration_type text not null check (integration_type in ('lead_source', 'telephony', 'messaging', 'calendar', 'email', 'ai', 'automation', 'other')),
  display_name text not null,
  status text not null default 'disconnected' check (status in ('connected', 'disconnected', 'error', 'needs_reauth', 'paused')),
  configuration jsonb not null default '{}',
  -- Vault secret id only; never the secret itself.
  secret_reference uuid,
  scopes text[] not null default '{}',
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);
create trigger integrations_updated_at before update on public.integrations for each row execute function public.set_updated_at();

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete restrict,
  provider text not null,
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 200),
  event_type text not null,
  signature_verified boolean not null,
  processing_status text not null default 'received' check (processing_status in ('received', 'processed', 'duplicate', 'failed', 'rejected', 'dead_letter')),
  attempt_count integer not null default 1,
  lead_id uuid references public.leads (id) on delete set null,
  last_error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (organization_id, provider, provider_event_id)
);
create index webhook_events_org_received_idx on public.webhook_events (organization_id, received_at desc);

alter table public.integrations enable row level security;
alter table public.webhook_events enable row level security;
create policy integrations_read on public.integrations for select to authenticated using (public.has_perm(organization_id, 'integrations.manage'));
create policy integrations_update on public.integrations for update to authenticated
  using (public.has_perm(organization_id, 'integrations.manage')) with check (public.has_perm(organization_id, 'integrations.manage'));
create policy webhook_events_read on public.webhook_events for select to authenticated using (public.has_perm(organization_id, 'integrations.manage'));
revoke insert, update, delete on public.integrations, public.webhook_events from authenticated, anon;
grant update (status, display_name) on public.integrations to authenticated;
