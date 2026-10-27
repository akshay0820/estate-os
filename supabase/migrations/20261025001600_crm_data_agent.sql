-- Estate OS · 0016 · Agent 07 — CRM & Data Intelligence Agent (crm_data_agent)
-- Deterministic data quality over the existing CRM (contacts, leads, properties, appointments, integrations): versioned rules,
-- fingerprinted findings with a lifecycle, explainable duplicate candidates with human-approved (and revertible) merges,
-- field provenance with verified-value protection, incremental + checkpointed scans driven by pg_cron, daily metric
-- snapshots for anomaly rules, read models for the dashboard and Agent 08, and outbox events.
-- Additive only: new tables, two nullable redirect columns (contacts / properties.merged_into), a generated address key on
-- properties, and one replaced function body (private.leads_before: a lead may move to another contact only inside an
-- approved contact merge).

-- ───────────────────────── tables ─────────────────────────

alter table public.contacts add column merged_into uuid references public.contacts (id) on delete set null;
alter table public.properties add column merged_into uuid references public.properties (id) on delete set null;
create index contacts_merged_into_idx on public.contacts (merged_into) where merged_into is not null;
create index properties_merged_into_idx on public.properties (merged_into) where merged_into is not null;

create table public.data_quality_settings (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  rules jsonb not null default '{}',
  version integer not null default 1,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger data_quality_settings_updated_at before update on public.data_quality_settings for each row execute function public.set_updated_at();
create trigger data_quality_settings_audit after insert or update on public.data_quality_settings for each row execute function private.audit_row();

create table public.data_quality_scans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null check (kind in ('full', 'scheduled')),
  status text not null default 'requested' check (status in ('requested', 'running', 'completed', 'partial', 'failed', 'cancelled')),
  requested_by uuid references public.profiles (id) on delete set null,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 120),
  -- Keyset checkpoint: the entity type being scanned and the last id processed.
  cursor jsonb not null default '{"entity": "contact", "after": null}',
  counts jsonb not null default '{}',
  error text check (char_length(error) <= 300),
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (organization_id, idempotency_key)
);
create unique index data_quality_scans_one_active on public.data_quality_scans (organization_id) where status in ('requested', 'running');
create index data_quality_scans_org_idx on public.data_quality_scans (organization_id, requested_at desc);

create table public.data_quality_issues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  entity_type text not null check (entity_type in ('contact', 'lead', 'property', 'appointment', 'integration', 'organization')),
  entity_id uuid not null,
  rule_id text not null check (rule_id ~ '^[a-z_]+\.[a-z_]+$'),
  rule_version integer not null default 1,
  origin text not null default 'rule' check (origin in ('rule', 'provenance', 'ai_extraction', 'anomaly')),
  dimension text not null check (dimension in ('completeness', 'validity', 'consistency', 'uniqueness', 'freshness', 'referential_integrity',
    'provenance', 'sync_integrity', 'workflow_integrity', 'anomaly')),
  severity text not null check (severity in ('info', 'warning', 'high', 'critical')),
  status text not null default 'open' check (status in ('open', 'under_review', 'proposed', 'resolved', 'dismissed', 'reopened')),
  message text not null check (char_length(message) <= 300),
  -- Field names, codes and counts. Never full contact details or transcripts.
  evidence jsonb not null default '{}',
  recommended_action text check (char_length(recommended_action) <= 300),
  -- {field, value}: a correction a person can apply in one step.
  proposed_fix jsonb,
  fingerprint text not null check (char_length(fingerprint) <= 300),
  occurrence integer not null default 1,
  detection_count integer not null default 1,
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  assigned_to uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  resolution text check (resolution in ('no_longer_detected', 'corrected', 'fixed_elsewhere', 'dismissed', 'record_removed', 'record_closed')),
  resolution_note text check (char_length(resolution_note) <= 500),
  scan_id uuid references public.data_quality_scans (id) on delete set null,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, fingerprint)
);
create index data_quality_issues_org_status_idx on public.data_quality_issues (organization_id, status, severity, last_detected_at desc);
create index data_quality_issues_entity_idx on public.data_quality_issues (organization_id, entity_type, entity_id);
create index data_quality_issues_rule_idx on public.data_quality_issues (organization_id, rule_id);
create trigger data_quality_issues_updated_at before update on public.data_quality_issues for each row execute function public.set_updated_at();

create table public.duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  entity_type text not null check (entity_type in ('contact', 'lead', 'property')),
  record_a uuid not null,
  record_b uuid not null,
  score smallint not null check (score between 0 and 100),
  strength text not null check (strength in ('strong', 'possible', 'weak')),
  signals jsonb not null default '[]',
  conflicts jsonb not null default '[]',
  explanation text not null check (char_length(explanation) <= 500),
  proposed_canonical uuid not null,
  -- Both records' versions when detected; a merge is refused if either changed since.
  state_hash text not null,
  status text not null default 'open' check (status in ('open', 'merged', 'rejected', 'stale')),
  occurrence integer not null default 1,
  detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (char_length(review_note) <= 500),
  merge_id uuid,
  constraint duplicate_candidates_order check (record_a < record_b),
  constraint duplicate_candidates_canonical check (proposed_canonical in (record_a, record_b)),
  unique (organization_id, entity_type, record_a, record_b)
);
create index duplicate_candidates_org_idx on public.duplicate_candidates (organization_id, status, strength, last_detected_at desc);
create index duplicate_candidates_a_idx on public.duplicate_candidates (record_a);
create index duplicate_candidates_b_idx on public.duplicate_candidates (record_b);

create table public.record_merges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  entity_type text not null check (entity_type in ('contact', 'lead', 'property')),
  canonical_id uuid not null,
  merged_id uuid not null,
  candidate_id uuid references public.duplicate_candidates (id) on delete set null,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 120),
  status text not null default 'completed' check (status in ('completed', 'reverted')),
  revertible boolean not null default true,
  -- Row ids moved per table (recovery), fields filled on the canonical record (value hashes), fields that differed (kept canonical).
  moved jsonb not null default '{}',
  filled jsonb not null default '{}',
  conflicts jsonb not null default '[]',
  consent_changes jsonb not null default '[]',
  source_state jsonb not null default '{}',
  merged_by uuid references public.profiles (id) on delete set null,
  merged_at timestamptz not null default now(),
  reverted_by uuid references public.profiles (id) on delete set null,
  reverted_at timestamptz,
  revert_note text check (char_length(revert_note) <= 500),
  correlation_id uuid not null default gen_random_uuid(),
  unique (organization_id, idempotency_key)
);
create unique index record_merges_one_per_source on public.record_merges (organization_id, entity_type, merged_id) where status = 'completed';
create index record_merges_org_idx on public.record_merges (organization_id, merged_at desc);
alter table public.duplicate_candidates add constraint duplicate_candidates_merge_fk foreign key (merge_id) references public.record_merges (id) on delete set null;

-- Current source of each tracked field. Value hashes only (no copies of personal data); history lives in audit_logs.
create table public.field_provenance (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  entity_type text not null check (entity_type in ('contact', 'lead', 'property')),
  entity_id uuid not null,
  field text not null check (field ~ '^[a-z_0-9]{2,40}$'),
  source_type text not null check (source_type in ('user_entry', 'lead_intake', 'ai_extraction', 'system', 'correction', 'merge', 'legacy')),
  source_label text check (char_length(source_label) <= 120),
  source_ref uuid,
  actor_user uuid references public.profiles (id) on delete set null,
  captured_at timestamptz not null default now(),
  value_hash text,
  verification_status text not null default 'unverified' check (verification_status in ('unverified', 'verified')),
  verified_at timestamptz,
  verified_by uuid references public.profiles (id) on delete set null,
  previous_source_type text,
  change_count integer not null default 0,
  change_reason text check (char_length(change_reason) <= 200),
  primary key (entity_type, entity_id, field)
);
create index field_provenance_org_idx on public.field_provenance (organization_id, entity_type, entity_id);

-- Records changed since they were last evaluated (one row per record).
create table public.data_quality_queue (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  entity_type text not null check (entity_type in ('contact', 'lead', 'property', 'appointment', 'integration')),
  entity_id uuid not null,
  enqueued_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text check (char_length(last_error) <= 300),
  primary key (organization_id, entity_type, entity_id)
);
create index data_quality_queue_due_idx on public.data_quality_queue (organization_id, enqueued_at) where attempts < 5;

create table public.data_quality_daily (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  day date not null,
  metrics jsonb not null,
  anomalies jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (organization_id, day)
);

alter table public.data_quality_settings enable row level security;
alter table public.data_quality_scans enable row level security;
alter table public.data_quality_issues enable row level security;
alter table public.duplicate_candidates enable row level security;
alter table public.record_merges enable row level security;
alter table public.field_provenance enable row level security;
alter table public.data_quality_queue enable row level security;
alter table public.data_quality_daily enable row level security;
create policy data_quality_settings_read on public.data_quality_settings for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy data_quality_scans_read on public.data_quality_scans for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy data_quality_issues_read on public.data_quality_issues for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy duplicate_candidates_read on public.duplicate_candidates for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy record_merges_read on public.record_merges for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy field_provenance_read on public.field_provenance for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy data_quality_daily_read on public.data_quality_daily for select to authenticated using (public.has_perm(organization_id, 'reports.view'));
revoke all on public.data_quality_settings, public.data_quality_scans, public.data_quality_issues, public.duplicate_candidates, public.record_merges,
  public.field_provenance, public.data_quality_queue, public.data_quality_daily from anon;
revoke insert, update, delete, truncate on public.data_quality_settings, public.data_quality_scans, public.data_quality_issues, public.duplicate_candidates,
  public.record_merges, public.field_provenance, public.data_quality_queue, public.data_quality_daily from authenticated;
revoke select on public.data_quality_queue from authenticated;

-- ───────────────────────── rules & normalization helpers ─────────────────────────

create or replace function private.dq_default_rules()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{
    "disabled_rules": [], "severity_overrides": {},
    "qualification_stale_days": 30, "property_stale_days": 90, "integration_stale_hours": 48,
    "budget_plausibility": {"INR": {"rent_max": 2000000, "purchase_min": 500000}},
    "property_price_plausibility": {"INR": {"rent_max": 2000000, "sale_min": 500000}},
    "anomaly": {"min_baseline_days": 7, "spike_factor": 3, "spike_min_count": 5, "inventory_drop_pct": 30, "source_shift_pct": 40},
    "batch_per_org": 200, "scan_batch": 500, "daily_scan": true
  }'::jsonb;
$$;

create or replace function private.dq_rules(org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.dq_default_rules() || coalesce(s.rules, '{}') || jsonb_build_object('version', coalesce(s.version, 0))
  from (select 1) x left join public.data_quality_settings s on s.organization_id = org;
$$;

-- Phone plausibility on top of the stored E.164 value. +91: 10 national digits starting 2–9. Other country codes: only
-- the E.164 length (8–15 digits) can be checked here; no country rules are guessed.
create or replace function private.dq_phone_check(raw text, e164 text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when raw is null then null
    when e164 is null then 'invalid'
    when e164 like '+91%' and substr(e164, 4) !~ '^[2-9][0-9]{9}$' then 'invalid'
    when e164 !~ '^\+[1-9][0-9]{7,14}$' then 'invalid'
    when raw !~ '^\s*(\+|00)' and length(regexp_replace(raw, '\D', '', 'g')) = 10 then 'country_assumed'
    else null end;
$$;

-- Stricter syntax than the table constraint: dot-atom local part (≤ 64), labelled domain with an alphabetic TLD.
-- Syntax only: a well-formed address is not a verified address.
create or replace function private.dq_email_ok(e text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select e is null or (
    e ~ '^[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&''*+/=?^_`{|}~-]+)*@([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$'
    and length(split_part(e, '@', 1)) <= 64 and length(e) <= 254);
$$;

-- Comparison key for a street address (never shown): built-in functions only, so any writer can maintain it.
-- Null when the address is too short to identify a building.
alter table public.properties add column address_key text generated always as (
  case when length(trim(coalesce(address_line_1, ''))) < 5 then null
    else trim(regexp_replace(lower(address_line_1), '[^a-z0-9]+', ' ', 'g')) || '|' || trim(regexp_replace(lower(coalesce(locality, '')), '[^a-z0-9]+', ' ', 'g'))
      || '|' || trim(regexp_replace(lower(coalesce(city, '')), '[^a-z0-9]+', ' ', 'g')) end) stored;
create index properties_address_key_idx on public.properties (organization_id, address_key) where merged_into is null and address_key is not null;

create or replace function private.dq_f(p_rule text, p_sev text, p_dim text, p_msg text, p_ev jsonb, p_action text, p_fix jsonb default null)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('rule', p_rule, 'severity', p_sev, 'dimension', p_dim, 'message', p_msg, 'evidence', coalesce(p_ev, '{}'),
    'action', p_action, 'fix', p_fix);
$$;

create or replace function private.dq_event(org uuid, p_type text, p_record_type text, p_record uuid, p_corr uuid, p_payload jsonb, p_dedupe text)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.emit_event(org, p_type, p_record_type, p_record, p_corr,
    jsonb_build_object('event_type', p_type, 'schema_version', 1, 'organization_id', org, 'source', 'crm_data_agent', 'occurred_at', now()) || coalesce(p_payload, '{}'),
    null, p_dedupe);
$$;

-- Owners and admins hear about critical integrity problems and serious anomalies.
create or replace function private.dq_alert(org uuid, p_title text, p_body text, p_entity_type text, p_entity uuid, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
begin
  for m in select user_id from public.organization_memberships where organization_id = org and status = 'active' and role in ('owner', 'admin') loop
    perform private.notify(org, m.user_id, 'failure', p_title, p_body, 'dataquality', p_entity_type, p_entity, p_dedupe);
  end loop;
end;
$$;

-- Insert or refresh one finding by fingerprint. Dismissed findings stay dismissed; resolved ones reopen.
create or replace function private.dq_upsert_issue(org uuid, et text, eid uuid, p_rule text, p_sev text, p_dim text, p_msg text, p_ev jsonb,
  p_action text, p_fix jsonb, p_origin text, p_disc text, p_scan uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  fp text := p_rule || ':' || et || ':' || eid::text || coalesce(':' || p_disc, '');
  x public.data_quality_issues;
  outcome text;
begin
  select * into x from public.data_quality_issues where organization_id = org and fingerprint = fp for update;
  if x.id is null then
    insert into public.data_quality_issues (organization_id, entity_type, entity_id, rule_id, origin, dimension, severity, status, message, evidence,
      recommended_action, proposed_fix, fingerprint, scan_id)
    values (org, et, eid, p_rule, p_origin, p_dim, p_sev, case when p_origin = 'ai_extraction' then 'proposed' else 'open' end, left(p_msg, 300),
      coalesce(p_ev, '{}'), left(p_action, 300), p_fix, fp, p_scan)
    on conflict (organization_id, fingerprint) do nothing
    returning * into x;
    if x.id is null then
      select * into x from public.data_quality_issues where organization_id = org and fingerprint = fp for update;
    else
      outcome := 'new';
    end if;
  end if;
  if outcome is null then
    if x.status = 'dismissed' then
      update public.data_quality_issues set last_detected_at = now(), detection_count = detection_count + 1 where id = x.id;
      return 'dismissed';
    elsif x.status = 'resolved' then
      update public.data_quality_issues set status = 'reopened', occurrence = occurrence + 1, resolved_at = null, resolved_by = null, resolution = null,
        resolution_note = null, severity = p_sev, message = left(p_msg, 300), evidence = coalesce(p_ev, '{}'), recommended_action = left(p_action, 300),
        proposed_fix = p_fix, last_detected_at = now(), detection_count = detection_count + 1, scan_id = coalesce(p_scan, scan_id)
      where id = x.id returning * into x;
      outcome := 'reopened';
    else
      update public.data_quality_issues set severity = p_sev, message = left(p_msg, 300), evidence = coalesce(p_ev, '{}'), recommended_action = left(p_action, 300),
        proposed_fix = p_fix, last_detected_at = now(), detection_count = detection_count + 1, scan_id = coalesce(p_scan, scan_id)
      where id = x.id;
      return 'updated';
    end if;
  end if;
  perform private.dq_event(org, case when x.origin = 'ai_extraction' then 'crm.record_enrichment_proposed' else 'crm.data_quality_issue_detected' end,
    'data_quality_issue', x.id, x.correlation_id,
    jsonb_build_object('issue_id', x.id, 'entity_type', et, 'entity_id', eid, 'rule_id', p_rule, 'severity', x.severity, 'origin', x.origin),
    'crm.issue_detected:' || x.id::text || ':' || x.occurrence);
  if x.severity = 'critical' then
    perform private.write_audit(org, 'security.integrity_violation', et, eid, jsonb_build_object('rule_id', p_rule, 'issue_id', x.id));
    perform private.dq_alert(org, 'Critical data integrity problem', left(p_msg, 300), et, eid, 'dq-critical:' || x.id::text || ':' || x.occurrence);
  end if;
  return outcome;
end;
$$;

create or replace function private.dq_resolve(x public.data_quality_issues, p_resolution text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.data_quality_issues set status = case when p_resolution = 'dismissed' then 'dismissed' else 'resolved' end, resolution = p_resolution,
    resolved_at = now(), resolved_by = auth.uid(), resolution_note = left(p_note, 500)
  where id = x.id;
  if p_resolution <> 'dismissed' then
    perform private.dq_event(x.organization_id, case when x.origin = 'ai_extraction' and p_resolution = 'corrected' then 'crm.record_enriched' else 'crm.data_quality_issue_resolved' end,
      'data_quality_issue', x.id, x.correlation_id,
      jsonb_build_object('issue_id', x.id, 'entity_type', x.entity_type, 'entity_id', x.entity_id, 'rule_id', x.rule_id, 'resolution', p_resolution),
      'crm.issue_resolved:' || x.id::text || ':' || x.occurrence);
  end if;
end;
$$;

-- ───────────────────────── rules ─────────────────────────

-- Findings for one record (deterministic; ruleset dq-rules/1). Returns a JSON array of dq_f objects.
create or replace function private.dq_findings(et text, eid uuid, rules jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  res jsonb := '[]';
  c public.contacts;
  l public.leads;
  p public.properties;
  a public.appointments;
  i public.integrations;
  q public.lead_qualifications;
  chk text;
  v_name text;
  th jsonb;
  allowed text[];
  active text[] := array['requested', 'pending', 'confirmed', 'reschedule_requested'];
  residential text[] := array['apartment', 'penthouse', 'villa', 'house', 'townhouse'];
  v_org uuid;
begin
  if et = 'contact' then
    select * into c from public.contacts where id = eid;
    chk := private.dq_phone_check(c.phone, c.phone_e164);
    if chk = 'invalid' then
      res := res || private.dq_f('contact.phone_invalid', 'high', 'validity', 'The phone number is not a valid number',
        jsonb_build_object('field', 'phone'), 'Correct the phone number or remove it');
    elsif chk = 'country_assumed' then
      res := res || private.dq_f('contact.phone_country_assumed', 'info', 'validity', 'The phone number had no country code, so India (+91) was assumed',
        jsonb_build_object('field', 'phone', 'assumed_country_code', '+91'), 'Confirm the country code with the contact');
    end if;
    if not private.dq_email_ok(c.email) then
      res := res || private.dq_f('contact.email_malformed', 'warning', 'validity', 'The email address looks malformed',
        jsonb_build_object('field', 'email'), 'Check the spelling of the email address');
    end if;
    v_name := regexp_replace(trim(c.display_name), '\s+', ' ', 'g');
    if v_name <> c.display_name and v_name <> '' then
      res := res || private.dq_f('contact.name_whitespace', 'info', 'consistency', 'The name has extra spaces',
        jsonb_build_object('field', 'display_name'), 'Apply the cleaned-up name', jsonb_build_object('field', 'display_name', 'value', v_name));
    end if;
    if c.display_name ~ '^[+0-9 ().-]{6,}$' or position('@' in c.display_name) > 0 then
      res := res || private.dq_f('contact.name_is_contact_detail', 'warning', 'validity', 'The name field contains a phone number or email address',
        jsonb_build_object('field', 'display_name'), 'Ask for the contact''s name and update it');
    end if;
    if c.lifecycle_status = 'do_not_contact' and exists (select 1 from public.communication_consents x where x.contact_id = c.id and x.status = 'granted') then
      res := res || private.dq_f('contact.dnc_consent_conflict', 'high', 'consistency', 'The contact is on the do-not-contact list but still has a granted consent',
        jsonb_build_object('channels', (select jsonb_agg(x.channel || ':' || x.purpose) from public.communication_consents x where x.contact_id = c.id and x.status = 'granted')),
        'Revoke the remaining consents or confirm the contact''s wishes');
    end if;
    if c.lifecycle_status <> 'do_not_contact' and c.preferred_contact_channel <> 'none'
       and not exists (select 1 from public.communication_consents x where x.contact_id = c.id and x.channel = c.preferred_contact_channel
                         and x.purpose = 'service' and x.status <> 'unknown') then
      res := res || private.dq_f('contact.consent_unknown', 'info', 'completeness', 'No consent decision is recorded for the preferred channel',
        jsonb_build_object('channel', c.preferred_contact_channel), 'Record the contact''s consent for this channel');
    end if;
    if c.source is null then
      res := res || private.dq_f('contact.source_missing', 'info', 'provenance', 'Where this contact came from is not recorded',
        jsonb_build_object('field', 'source'), 'Add the source');
    end if;

  elsif et = 'lead' then
    select * into l from public.leads where id = eid;
    select organization_id into v_org from public.contacts where id = l.contact_id;
    if v_org is distinct from l.organization_id then
      res := res || private.dq_f('lead.cross_tenant_contact', 'critical', 'referential_integrity', 'The lead points to a contact outside this workspace',
        jsonb_build_object('field', 'contact_id'), 'Stop using this lead and contact support');
    end if;
    th := rules -> 'budget_plausibility' -> l.budget_currency::text;
    if th is not null and l.budget_max is not null then
      if l.desired_transaction = 'rent' and l.budget_max > (th ->> 'rent_max')::numeric then
        res := res || private.dq_f('lead.rent_budget_implausible', 'warning', 'consistency', 'The rent budget looks like a purchase price',
          jsonb_build_object('field', 'budget_max', 'threshold', th -> 'rent_max', 'currency', l.budget_currency), 'Check whether the lead wants to rent or buy, and the budget');
      elsif l.desired_transaction in ('buy', 'invest') and l.budget_max < (th ->> 'purchase_min')::numeric then
        res := res || private.dq_f('lead.purchase_budget_implausible', 'warning', 'consistency', 'The purchase budget looks like a monthly rent',
          jsonb_build_object('field', 'budget_max', 'threshold', th -> 'purchase_min', 'currency', l.budget_currency), 'Check whether the lead wants to buy or rent, and the budget');
      end if;
    end if;
    allowed := case l.lead_type when 'buyer' then array['buy', 'invest'] when 'investor' then array['buy', 'invest'] when 'tenant' then array['rent']
                                when 'seller' then array['sell'] when 'landlord' then array['let'] end;
    if not (l.desired_transaction = any (allowed)) then
      res := res || private.dq_f('lead.type_transaction_mismatch', 'warning', 'consistency',
        format('A %s lead is marked as wanting to %s', l.lead_type, l.desired_transaction),
        jsonb_build_object('fields', jsonb_build_array('lead_type', 'desired_transaction')), 'Correct the lead type or the transaction');
    end if;
    if l.assigned_to is null and l.status not in ('won', 'lost') then
      res := res || private.dq_f('lead.unassigned', 'warning', 'workflow_integrity', 'Nobody owns this open lead',
        jsonb_build_object('field', 'assigned_to'), 'Assign an owner');
    end if;
    if l.status in ('qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation') and l.budget_max is null and l.desired_transaction in ('buy', 'rent', 'invest') then
      res := res || private.dq_f('lead.budget_missing', 'info', 'completeness', 'The lead is past qualification but has no budget',
        jsonb_build_object('field', 'budget_max', 'status', l.status), 'Ask for and record the budget');
    end if;
    select * into q from public.lead_qualifications x where x.lead_id = l.id and x.is_current order by x.created_at desc limit 1;
    if q.id is not null and l.status not in ('won', 'lost') and q.created_at < now() - make_interval(days => coalesce((rules ->> 'qualification_stale_days')::int, 30)) then
      res := res || private.dq_f('lead.qualification_stale', 'info', 'freshness', 'The qualification is old; requirements may have changed',
        jsonb_build_object('age_days', extract(day from now() - q.created_at)::int), 'Re-qualify the lead');
    end if;
    if l.status = 'visit_scheduled' and not exists (select 1 from public.appointments x where x.lead_id = l.id and x.status = any (active)) then
      res := res || private.dq_f('lead.visit_without_appointment', 'warning', 'workflow_integrity', 'The lead is at "visit scheduled" but has no active appointment',
        jsonb_build_object('status', l.status), 'Book the visit or move the lead to the right stage');
    elsif l.status = 'visit_completed' and not exists (select 1 from public.appointments x where x.lead_id = l.id and x.status = 'completed') then
      res := res || private.dq_f('lead.visit_unrecorded', 'info', 'workflow_integrity', 'The lead is at "visit completed" but no appointment is recorded as completed',
        jsonb_build_object('status', l.status), 'Record the visit outcome on the appointment');
    end if;
    if l.source_external_id is not null and exists (select 1 from public.leads x where x.organization_id = l.organization_id and x.id <> l.id and x.archived_at is null
                                                     and x.source = l.source and x.source_external_id = l.source_external_id) then
      res := res || private.dq_f('lead.external_id_collision', 'high', 'uniqueness', 'Another open lead has the same source and external id',
        jsonb_build_object('fields', jsonb_build_array('source', 'source_external_id')), 'Review the duplicate enquiry and merge or correct it');
    end if;

  elsif et = 'property' then
    select * into p from public.properties where id = eid;
    if p.owner_contact_id is not null then
      select organization_id into v_org from public.contacts where id = p.owner_contact_id;
      if v_org is distinct from p.organization_id then
        res := res || private.dq_f('property.cross_tenant_owner', 'critical', 'referential_integrity', 'The listing''s owner contact is outside this workspace',
          jsonb_build_object('field', 'owner_contact_id'), 'Remove the owner link and contact support');
      end if;
    end if;
    th := rules -> 'property_price_plausibility' -> p.currency::text;
    if th is not null then
      if p.listing_type = 'sale' and p.price < (th ->> 'sale_min')::numeric then
        res := res || private.dq_f('property.sale_price_implausible', 'warning', 'consistency', 'The sale price looks like a monthly rent',
          jsonb_build_object('field', 'price', 'threshold', th -> 'sale_min', 'currency', p.currency), 'Check the price and the listing type');
      elsif p.listing_type = 'rent' and p.price > (th ->> 'rent_max')::numeric then
        res := res || private.dq_f('property.rent_price_implausible', 'warning', 'consistency', 'The rent looks like a sale price',
          jsonb_build_object('field', 'price', 'threshold', th -> 'rent_max', 'currency', p.currency), 'Check the price and the listing type');
      end if;
    end if;
    if p.property_type in ('plot', 'office', 'retail', 'commercial') and p.bedrooms > 0 then
      res := res || private.dq_f('property.bedrooms_not_applicable', 'warning', 'validity', format('A %s listing has %s bedrooms', p.property_type, p.bedrooms),
        jsonb_build_object('field', 'bedrooms'), 'Set bedrooms to 0 or correct the property type');
    end if;
    if p.property_type = any (residential) and ((p.area_unit = 'sqft' and (p.area_value < 150 or p.area_value > 50000))
                                                or (p.area_unit = 'sqm' and (p.area_value < 15 or p.area_value > 5000))) then
      res := res || private.dq_f('property.area_implausible', 'warning', 'validity', format('The area (%s %s) is unusual for a %s', p.area_value, p.area_unit, p.property_type),
        jsonb_build_object('fields', jsonb_build_array('area_value', 'area_unit')), 'Check the area and its unit');
    end if;
    if p.status = 'active' and p.verified_at is null then
      res := res || private.dq_f('property.unverified_active', 'info', 'provenance', 'The listing is active but has never been verified',
        jsonb_build_object('field', 'verified_at'), 'Verify the listing details');
    end if;
    if p.status = 'active' and greatest(p.updated_at, coalesce(p.verified_at, p.updated_at)) < now() - make_interval(days => coalesce((rules ->> 'property_stale_days')::int, 90)) then
      res := res || private.dq_f('property.stale_listing', 'warning', 'freshness', 'The active listing has not been updated or verified for a long time',
        jsonb_build_object('days_since_update', extract(day from now() - greatest(p.updated_at, coalesce(p.verified_at, p.updated_at)))::int),
        'Confirm the listing is still available and its price is current');
    end if;
    if p.status = 'active' and exists (select 1 from public.deals d where d.property_id = p.id and d.stage = 'won') then
      res := res || private.dq_f('property.active_with_won_deal', 'high', 'workflow_integrity', 'The listing is active but a deal on it is won',
        jsonb_build_object('field', 'status'), 'Mark the listing sold or let');
    end if;
    if p.address_line_1 is null or p.city is null then
      res := res || private.dq_f('property.address_incomplete', 'info', 'completeness', 'The address is incomplete',
        jsonb_build_object('missing', to_jsonb(array_remove(array[case when p.address_line_1 is null then 'address_line_1' end, case when p.city is null then 'city' end], null))),
        'Add the street address and city');
    end if;

  elsif et = 'appointment' then
    select * into a from public.appointments where id = eid;
    if (a.lead_id is not null and (select organization_id from public.leads where id = a.lead_id) is distinct from a.organization_id)
       or (a.property_id is not null and (select organization_id from public.properties where id = a.property_id) is distinct from a.organization_id) then
      res := res || private.dq_f('appointment.cross_tenant_reference', 'critical', 'referential_integrity', 'The appointment points to a record outside this workspace',
        jsonb_build_object('fields', jsonb_build_array('lead_id', 'property_id')), 'Cancel the appointment and contact support');
    end if;
    if a.status = any (active) and a.appointment_type = 'viewing' and a.property_id is not null
       and (select status from public.properties where id = a.property_id) <> 'active' then
      res := res || private.dq_f('appointment.property_unavailable', 'high', 'workflow_integrity', 'An active viewing is booked for a listing that is no longer active',
        jsonb_build_object('field', 'property_id'), 'Reschedule to another listing or cancel the viewing');
    end if;
    if a.status = any (active) and a.ends_at < now() - interval '24 hours' then
      res := res || private.dq_f('appointment.outcome_missing', 'warning', 'workflow_integrity', 'The appointment is over but its outcome was not recorded',
        jsonb_build_object('status', a.status), 'Mark it completed, no-show or cancelled');
    end if;
    if a.status = any (active) and a.starts_at > now() and a.lead_id is not null
       and exists (select 1 from public.leads x where x.id = a.lead_id and (x.archived_at is not null or x.status in ('won', 'lost'))) then
      res := res || private.dq_f('appointment.lead_closed', 'warning', 'consistency', 'An upcoming appointment belongs to a closed or archived lead',
        jsonb_build_object('field', 'lead_id'), 'Cancel the appointment or reopen the lead');
    end if;
    if a.status = any (active) and a.starts_at > now() and a.assigned_to is not null and not private.is_active_member(a.organization_id, a.assigned_to) then
      res := res || private.dq_f('appointment.assignee_inactive', 'high', 'workflow_integrity', 'An upcoming appointment is assigned to someone no longer active',
        jsonb_build_object('field', 'assigned_to'), 'Reassign the appointment');
    end if;
    if a.status = any (active) and a.calendar_sync_status = 'failed' then
      res := res || private.dq_f('appointment.calendar_sync_failed', 'warning', 'sync_integrity', 'The appointment could not be written to the connected calendar',
        jsonb_build_object('field', 'calendar_sync_status'), 'Check the calendar and the task created for it');
    end if;

  elsif et = 'integration' then
    select * into i from public.integrations where id = eid;
    if i.status in ('error', 'needs_reauth') then
      res := res || private.dq_f('integration.unhealthy', 'high', 'sync_integrity', format('%s is %s', i.display_name, replace(i.status, '_', ' ')),
        jsonb_build_object('status', i.status, 'type', i.integration_type), 'Reconnect the integration');
    elsif i.status = 'connected' and (i.last_synced_at is null or i.last_synced_at < now() - make_interval(hours => coalesce((rules ->> 'integration_stale_hours')::int, 48))) then
      res := res || private.dq_f('integration.stale', 'warning', 'sync_integrity', format('%s has no recent successful sync', i.display_name),
        jsonb_build_object('last_synced_at', i.last_synced_at, 'type', i.integration_type), 'Check the integration');
    end if;
  end if;
  return res;
end;
$$;

-- ───────────────────────── duplicates ─────────────────────────

create or replace function private.dq_state_hash(et text, x uuid, y uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a uuid := least(x, y);
  b uuid := greatest(x, y);
begin
  return md5(case et
    when 'contact' then (select string_agg(coalesce(c.updated_at::text, '') || '/' || coalesce(c.merged_into::text, ''), '|' order by c.id) from public.contacts c where c.id in (a, b))
    when 'lead' then (select string_agg(coalesce(l.updated_at::text, '') || '/' || coalesce(l.archived_at::text, ''), '|' order by l.id) from public.leads l where l.id in (a, b))
    else (select string_agg(coalesce(p.updated_at::text, '') || '/' || coalesce(p.merged_into::text, ''), '|' order by p.id) from public.properties p where p.id in (a, b)) end);
end;
$$;

create or replace function private.dq_signal_label(s text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case s
    when 'same_phone' then 'same phone' when 'same_email' then 'same email' when 'related_names' then 'names share a word'
    when 'different_names' then 'names differ' when 'different_phone' then 'other phone differs' when 'different_email' then 'other email differs'
    when 'same_contact_open_leads' then 'two open enquiries from the same contact' when 'same_transaction' then 'same transaction'
    when 'different_transaction' then 'different transaction' when 'overlapping_locations' then 'overlapping locations'
    when 'same_external_id' then 'same source reference' when 'same_address' then 'same address' when 'same_type' then 'same property type'
    when 'different_type' then 'different property type' when 'same_listing_type' then 'same listing type' when 'different_listing_type' then 'different listing type'
    when 'same_bedrooms' then 'same bedrooms' when 'different_bedrooms' then 'different bedrooms' when 'similar_area' then 'area within 5%'
    when 'different_area' then 'area differs by more than 20%' when 'similar_price' then 'price within 10%' else replace(s, '_', ' ') end;
$$;

create or replace function private.dq_upsert_candidate(org uuid, et text, x uuid, y uuid, p_score int, p_signals jsonb, p_conflicts jsonb, p_canonical uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  sc int := greatest(0, least(100, p_score));
  st text := case when sc >= 80 then 'strong' when sc >= 50 then 'possible' else 'weak' end;
  expl text := initcap(left((select string_agg(private.dq_signal_label(s ->> 'signal'), ', ') from jsonb_array_elements(p_signals) s), 1))
    || substr((select string_agg(private.dq_signal_label(s ->> 'signal'), ', ') from jsonb_array_elements(p_signals) s), 2)
    || coalesce('. Against: ' || (select string_agg(private.dq_signal_label(s ->> 'signal'), ', ') from jsonb_array_elements(p_conflicts) s), '') || '.';
  d public.duplicate_candidates;
  was text;
begin
  select status into was from public.duplicate_candidates where organization_id = org and entity_type = et and record_a = least(x, y) and record_b = greatest(x, y);
  insert into public.duplicate_candidates (organization_id, entity_type, record_a, record_b, score, strength, signals, conflicts, explanation, proposed_canonical, state_hash)
  values (org, et, least(x, y), greatest(x, y), sc, st, p_signals, p_conflicts, left(expl, 500), p_canonical, private.dq_state_hash(et, x, y))
  on conflict (organization_id, entity_type, record_a, record_b) do update set score = excluded.score, strength = excluded.strength, signals = excluded.signals,
    conflicts = excluded.conflicts, explanation = excluded.explanation, proposed_canonical = excluded.proposed_canonical, state_hash = excluded.state_hash,
    last_detected_at = now(),
    status = case when public.duplicate_candidates.status = 'stale' then 'open' else public.duplicate_candidates.status end,
    occurrence = public.duplicate_candidates.occurrence + case when public.duplicate_candidates.status = 'stale' then 1 else 0 end
  returning * into d;
  if (was is null or was = 'stale') and d.status = 'open' and d.strength in ('strong', 'possible') then
    perform private.dq_event(org, 'crm.duplicate_review_required', 'duplicate_candidate', d.id, null,
      jsonb_build_object('candidate_id', d.id, 'entity_type', et, 'record_a', d.record_a, 'record_b', d.record_b, 'strength', d.strength, 'score', d.score),
      'crm.duplicate_review_required:' || d.id::text || ':' || d.occurrence);
  end if;
end;
$$;

-- Tenant-scoped candidates for one record, from indexed exact signals only (no all-pairs comparison).
create or replace function private.dq_detect_duplicates(org uuid, et text, eid uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  seen uuid[] := '{}';
  c public.contacts;
  oc public.contacts;
  l public.leads;
  ol public.leads;
  p public.properties;
  op public.properties;
  sig jsonb;
  con jsonb;
  sc int;
  k text;
  canon uuid;
  n int := 0;
begin
  if et = 'contact' then
    select * into c from public.contacts where id = eid and organization_id = org and merged_into is null;
    if c.id is not null then
      for oc in select * from public.contacts x where x.organization_id = org and x.id <> c.id and x.merged_into is null
                  and ((c.phone_e164 is not null and x.phone_e164 = c.phone_e164) or (c.email_normalized is not null and x.email_normalized = c.email_normalized))
                order by x.created_at limit 25 loop
        sig := '[]'; con := '[]'; sc := 0;
        if c.phone_e164 is not null and oc.phone_e164 = c.phone_e164 then sig := sig || '[{"signal": "same_phone", "weight": 60}]'; sc := sc + 60;
        elsif c.phone_e164 is not null and oc.phone_e164 is not null then con := con || '[{"signal": "different_phone", "weight": -20}]'; sc := sc - 20; end if;
        if c.email_normalized is not null and oc.email_normalized = c.email_normalized then sig := sig || '[{"signal": "same_email", "weight": 60}]'; sc := sc + 60;
        elsif c.email_normalized is not null and oc.email_normalized is not null then con := con || '[{"signal": "different_email", "weight": -20}]'; sc := sc - 20; end if;
        if private.names_related(c.display_name, oc.display_name) then sig := sig || '[{"signal": "related_names", "weight": 15}]'; sc := sc + 15;
        else con := con || '[{"signal": "different_names", "weight": -25}]'; sc := sc - 25; end if;
        -- Canonical: the record with more open enquiries, then the older one.
        select x.id into canon from public.contacts x where x.id in (c.id, oc.id)
        order by (select count(*) from public.leads y where y.contact_id = x.id and y.archived_at is null) desc, x.created_at, x.id limit 1;
        perform private.dq_upsert_candidate(org, 'contact', c.id, oc.id, sc, sig, con, canon);
        seen := seen || oc.id; n := n + 1;
      end loop;
    end if;
  elsif et = 'lead' then
    select * into l from public.leads where id = eid and organization_id = org and archived_at is null and status not in ('won', 'lost');
    if l.id is not null then
      for ol in select * from public.leads x where x.organization_id = org and x.contact_id = l.contact_id and x.id <> l.id and x.archived_at is null
                  and x.status not in ('won', 'lost') order by x.created_at limit 25 loop
        sig := '[{"signal": "same_contact_open_leads", "weight": 50}]'; con := '[]'; sc := 50;
        if ol.desired_transaction = l.desired_transaction then sig := sig || '[{"signal": "same_transaction", "weight": 20}]'; sc := sc + 20;
        else con := con || '[{"signal": "different_transaction", "weight": -20}]'; sc := sc - 20; end if;
        if ol.desired_locations && l.desired_locations then sig := sig || '[{"signal": "overlapping_locations", "weight": 10}]'; sc := sc + 10; end if;
        if l.source_external_id is not null and ol.source = l.source and ol.source_external_id = l.source_external_id then
          sig := sig || '[{"signal": "same_external_id", "weight": 40}]'; sc := sc + 40;
        end if;
        select x.id into canon from public.leads x where x.id in (l.id, ol.id) order by x.status_rank desc, x.created_at, x.id limit 1;
        perform private.dq_upsert_candidate(org, 'lead', l.id, ol.id, sc, sig, con, canon);
        seen := seen || ol.id; n := n + 1;
      end loop;
    end if;
  elsif et = 'property' then
    select * into p from public.properties where id = eid and organization_id = org and merged_into is null and status <> 'archived';
    k := p.address_key;
    if p.id is not null and k is not null then
      for op in select * from public.properties x where x.organization_id = org and x.id <> p.id and x.merged_into is null and x.status <> 'archived'
                  and x.address_key = k order by x.created_at limit 25 loop
        sig := '[{"signal": "same_address", "weight": 40}]'; con := '[]'; sc := 40;
        if op.property_type = p.property_type then sig := sig || '[{"signal": "same_type", "weight": 10}]'; sc := sc + 10;
        else con := con || '[{"signal": "different_type", "weight": -10}]'; sc := sc - 10; end if;
        if op.listing_type = p.listing_type then sig := sig || '[{"signal": "same_listing_type", "weight": 10}]'; sc := sc + 10;
        else con := con || '[{"signal": "different_listing_type", "weight": -10}]'; sc := sc - 10; end if;
        if op.bedrooms = p.bedrooms then sig := sig || '[{"signal": "same_bedrooms", "weight": 10}]'; sc := sc + 10;
        else con := con || '[{"signal": "different_bedrooms", "weight": -20}]'; sc := sc - 20; end if;
        if op.area_unit = p.area_unit and abs(op.area_value - p.area_value) <= 0.05 * greatest(op.area_value, p.area_value) then
          sig := sig || '[{"signal": "similar_area", "weight": 15}]'; sc := sc + 15;
        elsif op.area_unit = p.area_unit and abs(op.area_value - p.area_value) > 0.2 * greatest(op.area_value, p.area_value) then
          con := con || '[{"signal": "different_area", "weight": -20}]'; sc := sc - 20;
        end if;
        if op.currency = p.currency and abs(op.price - p.price) <= 0.1 * greatest(op.price, p.price) then sig := sig || '[{"signal": "similar_price", "weight": 5}]'; sc := sc + 5; end if;
        -- Same building, different units is common: only corroborated pairs are worth a person's review.
        if sc >= 50 then
          select x.id into canon from public.properties x where x.id in (p.id, op.id)
          order by (x.verified_at is not null) desc, (x.status = 'active') desc, x.created_at, x.id limit 1;
          perform private.dq_upsert_candidate(org, 'property', p.id, op.id, sc, sig, con, canon);
          seen := seen || op.id; n := n + 1;
        end if;
      end loop;
    end if;
  end if;
  update public.duplicate_candidates d set status = 'stale', last_detected_at = now()
  where d.organization_id = org and d.entity_type = et and d.status = 'open' and (d.record_a = eid or d.record_b = eid)
    and not (case when d.record_a = eid then d.record_b else d.record_a end = any (seen));
  return n;
end;
$$;

-- ───────────────────────── evaluation ─────────────────────────

-- Evaluate one record: refresh its findings (new / updated / reopened), auto-resolve rule findings that no longer apply,
-- and refresh its duplicate candidates. Serialized per record.
create or replace function private.dq_process(org uuid, et text, eid uuid, p_scan uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rules jsonb := private.dq_rules(org);
  present boolean;
  applicable boolean;
  f jsonb;
  sev text;
  outcome text;
  rule_ids text[] := '{}';
  x public.data_quality_issues;
  n_new int := 0;
  n_upd int := 0;
  n_res int := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('dq:' || eid::text, 0));
  if et = 'contact' then select true, merged_into is null into present, applicable from public.contacts where id = eid and organization_id = org;
  elsif et = 'lead' then select true, archived_at is null into present, applicable from public.leads where id = eid and organization_id = org;
  elsif et = 'property' then select true, merged_into is null and status <> 'archived' into present, applicable from public.properties where id = eid and organization_id = org;
  elsif et = 'appointment' then select true, true into present, applicable from public.appointments where id = eid and organization_id = org;
  elsif et = 'integration' then select true, true into present, applicable from public.integrations where id = eid and organization_id = org;
  end if;
  if not coalesce(present, false) or not coalesce(applicable, false) then
    for x in select * from public.data_quality_issues where organization_id = org and entity_type = et and entity_id = eid
               and status in ('open', 'under_review', 'proposed', 'reopened') loop
      perform private.dq_resolve(x, case when coalesce(present, false) then 'record_closed' else 'record_removed' end, null);
      n_res := n_res + 1;
    end loop;
    update public.duplicate_candidates set status = 'stale', last_detected_at = now()
    where organization_id = org and entity_type = et and status = 'open' and (record_a = eid or record_b = eid);
    return jsonb_build_object('new', 0, 'updated', 0, 'resolved', n_res);
  end if;

  for f in select * from jsonb_array_elements(private.dq_findings(et, eid, rules)) loop
    continue when coalesce(rules -> 'disabled_rules', '[]') ? (f ->> 'rule');
    sev := case when f ->> 'severity' = 'critical' then 'critical' else coalesce(rules -> 'severity_overrides' ->> (f ->> 'rule'), f ->> 'severity') end;
    outcome := private.dq_upsert_issue(org, et, eid, f ->> 'rule', sev, f ->> 'dimension', f ->> 'message', f -> 'evidence', f ->> 'action',
      case when jsonb_typeof(f -> 'fix') = 'object' then f -> 'fix' end, 'rule', null, p_scan);
    rule_ids := rule_ids || (f ->> 'rule');
    if outcome in ('new', 'reopened') then n_new := n_new + 1; elsif outcome = 'updated' then n_upd := n_upd + 1; end if;
  end loop;
  for x in select * from public.data_quality_issues where organization_id = org and entity_type = et and entity_id = eid and origin = 'rule'
             and status in ('open', 'under_review', 'proposed', 'reopened') and not (rule_id = any (rule_ids)) loop
    perform private.dq_resolve(x, 'no_longer_detected', null);
    n_res := n_res + 1;
  end loop;
  if et in ('contact', 'lead', 'property') then perform private.dq_detect_duplicates(org, et, eid); end if;
  return jsonb_build_object('new', n_new, 'updated', n_upd, 'resolved', n_res);
end;
$$;

create or replace function private.dq_enqueue(org uuid, et text, eid uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.data_quality_queue (organization_id, entity_type, entity_id) values (org, et, eid)
  on conflict (organization_id, entity_type, entity_id) do update set enqueued_at = now(), attempts = 0, last_error = null;
$$;

create or replace function private.dq_on_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  n jsonb := to_jsonb(new);
begin
  case tg_table_name
    when 'contacts' then perform private.dq_enqueue(new.organization_id, 'contact', new.id);
    when 'leads' then perform private.dq_enqueue(new.organization_id, 'lead', new.id);
    when 'properties' then perform private.dq_enqueue(new.organization_id, 'property', new.id);
    when 'appointments' then
      perform private.dq_enqueue(new.organization_id, 'appointment', new.id);
      if n ->> 'lead_id' is not null then perform private.dq_enqueue(new.organization_id, 'lead', (n ->> 'lead_id')::uuid); end if;
    when 'communication_consents' then perform private.dq_enqueue(new.organization_id, 'contact', (n ->> 'contact_id')::uuid);
    when 'lead_qualifications' then perform private.dq_enqueue(new.organization_id, 'lead', (n ->> 'lead_id')::uuid);
    when 'deals' then
      if n ->> 'property_id' is not null then perform private.dq_enqueue(new.organization_id, 'property', (n ->> 'property_id')::uuid); end if;
    when 'integrations' then perform private.dq_enqueue(new.organization_id, 'integration', new.id);
    else null;
  end case;
  return null;
end;
$$;
create trigger contacts_data_quality after insert or update on public.contacts for each row execute function private.dq_on_change();
create trigger leads_data_quality after insert or update on public.leads for each row execute function private.dq_on_change();
create trigger properties_data_quality after insert or update on public.properties for each row execute function private.dq_on_change();
create trigger appointments_data_quality after insert or update on public.appointments for each row execute function private.dq_on_change();
create trigger consents_data_quality after insert or update on public.communication_consents for each row execute function private.dq_on_change();
create trigger lead_qualifications_data_quality after insert or update on public.lead_qualifications for each row execute function private.dq_on_change();
create trigger deals_data_quality after insert or update on public.deals for each row execute function private.dq_on_change();
create trigger integrations_data_quality after insert or update on public.integrations for each row execute function private.dq_on_change();

-- ───────────────────────── provenance & precedence ─────────────────────────

-- Records the source of tracked fields and enforces the precedence rule: an automated write never replaces a verified value
-- (the verified value is kept and a review finding is opened). Runs after the tables' own BEFORE triggers (name order).
create or replace function private.dq_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  et text := tg_argv[0];
  fields text[] := case tg_argv[0]
    when 'contact' then array['display_name', 'email', 'phone']
    when 'lead' then array['budget_min', 'budget_max', 'budget_currency', 'desired_transaction', 'desired_property_type', 'desired_locations', 'bedrooms', 'timeline', 'source']
    else array['price', 'currency', 'status', 'address_line_1', 'locality', 'city', 'bedrooms', 'area_value'] end;
  n jsonb := to_jsonb(new);
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  fld text;
  nv jsonb;
  ov jsonb;
  pv public.field_provenance;
  guc text := nullif(current_setting('app.dq_source', true), '');
  src text;
  ai_key text;
  patch jsonb := '{}';
begin
  foreach fld in array fields loop
    nv := n -> fld;
    ov := o -> fld;
    continue when tg_op = 'UPDATE' and nv is not distinct from ov;
    continue when tg_op = 'INSERT' and (nv is null or jsonb_typeof(nv) = 'null' or nv = '[]'::jsonb);
    select * into pv from public.field_provenance where entity_type = et and entity_id = new.id and field = fld;
    if tg_op = 'UPDATE' and pv.verification_status = 'verified' and auth.uid() is null and coalesce(guc, '') not in ('merge', 'correction') then
      patch := patch || jsonb_build_object(fld, ov);
      if fld = 'email' then patch := patch || jsonb_build_object('email_normalized', o -> 'email_normalized'); end if;
      if fld = 'phone' then patch := patch || jsonb_build_object('phone_e164', o -> 'phone_e164'); end if;
      perform private.dq_upsert_issue(new.organization_id, et, new.id, 'provenance.verified_value_protected', 'warning', 'provenance',
        format('An automated update tried to change the verified %s; the verified value was kept', replace(fld, '_', ' ')),
        jsonb_build_object('field', fld, 'attempted_source', coalesce(guc, 'system')),
        'Check which value is right; edit the field yourself if the new value is correct', null, 'provenance', fld, null);
      continue;
    end if;
    ai_key := case fld when 'budget_min' then 'budget' when 'budget_max' then 'budget' when 'desired_locations' then 'locations'
                       when 'desired_property_type' then 'propertyType' else fld end;
    src := coalesce(guc, case
      when auth.uid() is not null then 'user_entry'
      when et = 'lead' and coalesce(n -> 'ai_extracted_fields', '[]') ? ai_key then 'ai_extraction'
      when et = 'lead' and coalesce(n -> 'metadata', '{}') ? 'intake' then 'lead_intake'
      else 'system' end);
    insert into public.field_provenance (organization_id, entity_type, entity_id, field, source_type, source_label, source_ref, actor_user, captured_at,
      value_hash, verification_status, change_count, change_reason)
    values (new.organization_id, et, new.id, fld, src,
      left(case src when 'user_entry' then private.actor_name() when 'lead_intake' then n ->> 'source' when 'ai_extraction' then 'AI extraction (unverified)'
                    when 'system' then coalesce(n ->> 'source', 'Automated') else initcap(src) end, 120),
      case when src = 'lead_intake' then nullif(n -> 'metadata' -> 'intake' ->> 'run_id', '')::uuid else nullif(current_setting('app.dq_ref', true), '')::uuid end,
      auth.uid(), now(), md5(coalesce(nv #>> '{}', '')), 'unverified', case when tg_op = 'INSERT' then 0 else 1 end,
      left(nullif(current_setting('app.dq_reason', true), ''), 200))
    on conflict (entity_type, entity_id, field) do update set source_type = excluded.source_type, source_label = excluded.source_label,
      source_ref = excluded.source_ref, actor_user = excluded.actor_user, captured_at = excluded.captured_at, value_hash = excluded.value_hash,
      verification_status = 'unverified', verified_at = null, verified_by = null, previous_source_type = public.field_provenance.source_type,
      change_count = public.field_provenance.change_count + 1, change_reason = excluded.change_reason;
  end loop;
  if patch <> '{}'::jsonb then
    new := jsonb_populate_record(new, patch);
  end if;
  return new;
end;
$$;
create trigger contacts_provenance before insert or update on public.contacts for each row execute function private.dq_provenance('contact');
create trigger leads_provenance before insert or update on public.leads for each row execute function private.dq_provenance('lead');
create trigger properties_provenance before insert or update on public.properties for each row execute function private.dq_provenance('property');

-- A lead may move to another contact only inside an approved contact merge (flag set by private.dq_merge_contact).
create or replace function private.leads_before()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  sc record;
  progressed text[] := array['qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won'];
begin
  perform private.assert_same_org('contacts', new.contact_id, new.organization_id);
  perform private.assert_member(new.organization_id, new.assigned_to, 'Assignee');
  new.desired_locations := coalesce(new.desired_locations, '{}');

  if tg_op = 'INSERT' then
    new.created_by := uid;
    if new.status <> 'new' and new.first_response_at is null then new.first_response_at := now(); end if;
  else
    if new.contact_id <> old.contact_id and coalesce(current_setting('app.crm_merge', true), '') <> 'on' then
      perform private.fail('FORBIDDEN', 'A lead cannot be moved to another contact');
    end if;
    -- Reassignment needs leads.assign, except an agent claiming an unassigned lead.
    if uid is not null and new.assigned_to is distinct from old.assigned_to
       and not public.has_perm(new.organization_id, 'leads.assign')
       and not (old.assigned_to is null and new.assigned_to = uid) then
      perform private.fail('FORBIDDEN', 'You cannot reassign leads');
    end if;
    -- Status transitions: won is terminal; lost can only move to nurture or be reopened as contacted.
    if new.status is distinct from old.status then
      if old.status = 'won' then
        perform private.fail('INVALID_TRANSITION', 'A won lead is closed. Create a new enquiry instead.');
      end if;
      if old.status = 'lost' and new.status not in ('nurture', 'contacted') then
        perform private.fail('INVALID_TRANSITION', 'A lost lead can only move to Nurture or be reopened as Contacted');
      end if;
      if old.status = 'new' and new.first_response_at is null then new.first_response_at := now(); end if;
    end if;
    -- Edited by a person → no longer AI-extracted.
    if uid is not null then
      if new.budget_max is distinct from old.budget_max then new.ai_extracted_fields := array_remove(new.ai_extracted_fields, 'budget'); end if;
      if new.desired_locations is distinct from old.desired_locations then new.ai_extracted_fields := array_remove(new.ai_extracted_fields, 'locations'); end if;
      if new.bedrooms is distinct from old.bedrooms then new.ai_extracted_fields := array_remove(new.ai_extracted_fields, 'bedrooms'); end if;
      if new.timeline is distinct from old.timeline then new.ai_extracted_fields := array_remove(new.ai_extracted_fields, 'timeline'); end if;
      if new.desired_property_type is distinct from old.desired_property_type then new.ai_extracted_fields := array_remove(new.ai_extracted_fields, 'propertyType'); end if;
    end if;
  end if;

  if new.status = any (progressed) and new.qualified_at is null then new.qualified_at := now(); end if;
  if new.status in ('won', 'lost') then new.closed_at := coalesce(new.closed_at, now()); new.next_follow_up_at := null;
  else new.closed_at := null; end if;
  if new.status <> 'lost' then new.lost_reason := null; end if;

  select * into sc from private.score_lead(new);
  new.lead_score := sc.score;
  new.score_reasons := sc.reasons;
  new.updated_by := uid;
  return new;
end;
$$;

-- ───────────────────────── merges ─────────────────────────

create or replace function private.dq_entity_perm(et text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case et when 'contact' then 'contacts.edit' when 'lead' then 'leads.edit' when 'property' then 'properties.edit'
    when 'appointment' then 'appointments.edit' when 'integration' then 'integrations.manage' else 'settings.manage' end;
$$;

-- Moves every relationship of the duplicate contact to the canonical one, fills only empty fields, carries consent
-- conservatively, and keeps the duplicate as a redirect. Caller holds leads.merge and has locked the candidate.
create or replace function private.dq_merge_contact(org uuid, keep_id uuid, drop_id uuid, cand uuid, p_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  k public.contacts;
  d public.contacts;
  moved jsonb := '{}';
  filled jsonb := '{}';
  conflicts jsonb := '[]';
  consent jsonb := '[]';
  cs record;
  kc public.communication_consents;
  ids jsonb;
  m public.record_merges;
  fld text;
begin
  perform 1 from public.contacts where id in (keep_id, drop_id) order by id for update;
  select * into k from public.contacts where id = keep_id and organization_id = org;
  select * into d from public.contacts where id = drop_id and organization_id = org;
  if k.id is null or d.id is null then perform private.fail('NOT_FOUND', 'Contact not found'); end if;
  if k.merged_into is not null or d.merged_into is not null then perform private.fail('CONFLICT', 'One of these contacts was already merged'); end if;
  perform set_config('app.crm_merge', 'on', true);
  perform set_config('app.dq_source', 'merge', true);
  perform set_config('app.dq_reason', 'Duplicate contact merged after review', true);

  with u as (update public.leads set contact_id = keep_id where contact_id = drop_id returning id) select coalesce(jsonb_agg(id), '[]') into ids from u;
  moved := moved || jsonb_build_object('leads', ids);
  with u as (update public.deals set primary_contact_id = keep_id where primary_contact_id = drop_id returning id) select coalesce(jsonb_agg(id), '[]') into ids from u;
  moved := moved || jsonb_build_object('deals', ids);
  with u as (update public.appointments set contact_id = keep_id where contact_id = drop_id returning id) select coalesce(jsonb_agg(id), '[]') into ids from u;
  moved := moved || jsonb_build_object('appointments', ids);
  with u as (update public.activities set contact_id = keep_id where contact_id = drop_id returning id) select coalesce(jsonb_agg(id), '[]') into ids from u;
  moved := moved || jsonb_build_object('activities', ids);
  with u as (update public.documents set related_contact_id = keep_id where related_contact_id = drop_id returning id) select coalesce(jsonb_agg(id), '[]') into ids from u;
  moved := moved || jsonb_build_object('documents', ids);
  with u as (update public.voice_calls set contact_id = keep_id where contact_id = drop_id returning id) select coalesce(jsonb_agg(id), '[]') into ids from u;
  moved := moved || jsonb_build_object('voice_calls', ids);
  with u as (update public.follow_ups set contact_id = keep_id where contact_id = drop_id returning id) select coalesce(jsonb_agg(id), '[]') into ids from u;
  moved := moved || jsonb_build_object('follow_ups', ids);
  with u as (update public.properties set owner_contact_id = keep_id where owner_contact_id = drop_id returning id) select coalesce(jsonb_agg(id), '[]') into ids from u;
  moved := moved || jsonb_build_object('properties', ids);

  -- Only empty canonical fields are filled; differing values are recorded, never overwritten.
  if k.email is null and d.email is not null then
    update public.contacts set email = d.email where id = keep_id;
    filled := filled || jsonb_build_object('email', md5(d.email));
  end if;
  if k.phone is null and d.phone is not null then
    update public.contacts set phone = d.phone where id = keep_id;
    filled := filled || jsonb_build_object('phone', md5(d.phone));
  end if;
  if k.source is null and d.source is not null then
    update public.contacts set source = d.source where id = keep_id;
    filled := filled || jsonb_build_object('source', md5(d.source));
  end if;
  foreach fld in array array['display_name', 'email_normalized', 'phone_e164'] loop
    if to_jsonb(k) ->> fld is not null and to_jsonb(d) ->> fld is not null and to_jsonb(k) ->> fld <> to_jsonb(d) ->> fld then
      conflicts := conflicts || to_jsonb(fld);
    end if;
  end loop;

  -- Consent: a revocation or denial always carries over; a grant only where the canonical contact has no decision.
  for cs in select * from public.communication_consents where contact_id = drop_id loop
    select * into kc from public.communication_consents where contact_id = keep_id and channel = cs.channel and purpose = cs.purpose;
    if cs.status in ('revoked', 'denied') and kc.status is distinct from cs.status and coalesce(kc.status, 'unknown') <> 'revoked' then
      insert into public.communication_consents (organization_id, contact_id, channel, purpose, status, captured_via)
      values (org, keep_id, cs.channel, cs.purpose, cs.status, 'Carried from merged duplicate contact')
      on conflict (contact_id, channel, purpose) do update set status = excluded.status, captured_via = excluded.captured_via;
      consent := consent || jsonb_build_object('channel', cs.channel, 'purpose', cs.purpose, 'to', cs.status, 'from', coalesce(kc.status, 'none'));
    elsif cs.status = 'granted' and coalesce(kc.status, 'unknown') = 'unknown' and k.lifecycle_status <> 'do_not_contact' then
      insert into public.communication_consents (organization_id, contact_id, channel, purpose, status, captured_via)
      values (org, keep_id, cs.channel, cs.purpose, 'granted', left('Carried from merged duplicate: ' || coalesce(cs.captured_via, 'recorded consent'), 80))
      on conflict (contact_id, channel, purpose) do update set status = excluded.status, captured_via = excluded.captured_via;
      consent := consent || jsonb_build_object('channel', cs.channel, 'purpose', cs.purpose, 'to', 'granted', 'from', coalesce(kc.status, 'none'));
    end if;
  end loop;
  if d.lifecycle_status = 'do_not_contact' and k.lifecycle_status <> 'do_not_contact' then
    update public.contacts set lifecycle_status = 'do_not_contact' where id = keep_id;
    consent := consent || jsonb_build_object('lifecycle', 'do_not_contact', 'from', k.lifecycle_status);
  end if;

  update public.contacts set merged_into = keep_id,
    lifecycle_status = case when lifecycle_status = 'do_not_contact' then lifecycle_status else 'inactive' end,
    tags = array(select distinct x from unnest(tags || array['merged']) x)
  where id = drop_id;
  perform set_config('app.crm_merge', 'off', true);
  perform set_config('app.dq_source', '', true);
  perform set_config('app.dq_reason', '', true);

  insert into public.record_merges (organization_id, entity_type, canonical_id, merged_id, candidate_id, idempotency_key, moved, filled, conflicts, consent_changes,
    source_state, merged_by)
  values (org, 'contact', keep_id, drop_id, cand, p_key, moved, filled, conflicts, consent,
    jsonb_build_object('lifecycle_status', d.lifecycle_status, 'tags', to_jsonb(d.tags)), auth.uid())
  returning * into m;
  perform private.add_activity(org, (select id from public.leads where contact_id = keep_id order by created_at desc limit 1), keep_id, null, 'workflow',
    'Duplicate contact merged after review', format('Records of a duplicate contact were moved here (%s leads). Nothing was deleted.', jsonb_array_length(moved -> 'leads')));
  return m.id;
end;
$$;

create or replace function private.dq_merge_property(org uuid, keep_id uuid, drop_id uuid, cand uuid, p_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  k public.properties;
  d public.properties;
  moved jsonb := '{}';
  filled jsonb := '{}';
  conflicts jsonb := '[]';
  ids jsonb;
  m public.record_merges;
  fld text;
begin
  perform 1 from public.properties where id in (keep_id, drop_id) order by id for update;
  select * into k from public.properties where id = keep_id and organization_id = org;
  select * into d from public.properties where id = drop_id and organization_id = org;
  if k.id is null or d.id is null then perform private.fail('NOT_FOUND', 'Property not found'); end if;
  if k.merged_into is not null or d.merged_into is not null then perform private.fail('CONFLICT', 'One of these listings was already merged'); end if;
  if exists (select 1 from public.appointments where property_id = drop_id and status in ('requested', 'pending', 'confirmed', 'reschedule_requested')) then
    perform private.fail('CONFLICT', 'The duplicate listing has active appointments; reschedule or cancel them first');
  end if;
  if exists (select 1 from public.deals where property_id = drop_id and stage not in ('won', 'lost')) then
    perform private.fail('CONFLICT', 'The duplicate listing has open deals; move or close them first');
  end if;
  perform set_config('app.dq_source', 'merge', true);
  perform set_config('app.dq_reason', 'Duplicate listing merged after review', true);
  with u as (update public.tasks set related_property_id = keep_id where related_property_id = drop_id returning id) select coalesce(jsonb_agg(id), '[]') into ids from u;
  moved := moved || jsonb_build_object('tasks', ids);
  with u as (update public.documents set related_property_id = keep_id where related_property_id = drop_id returning id) select coalesce(jsonb_agg(id), '[]') into ids from u;
  moved := moved || jsonb_build_object('documents', ids);
  with u as (update public.availability_blocks set property_id = keep_id where property_id = drop_id returning id) select coalesce(jsonb_agg(id), '[]') into ids from u;
  moved := moved || jsonb_build_object('availability_blocks', ids);
  foreach fld in array array['address_line_1', 'city', 'postal_code', 'description'] loop
    if to_jsonb(k) ->> fld is null and to_jsonb(d) ->> fld is not null then
      execute format('update public.properties set %I = $1 where id = $2', fld) using to_jsonb(d) ->> fld, keep_id;
      filled := filled || jsonb_build_object(fld, md5(to_jsonb(d) ->> fld));
    end if;
  end loop;
  if k.owner_contact_id is null and d.owner_contact_id is not null then
    update public.properties set owner_contact_id = d.owner_contact_id where id = keep_id;
    filled := filled || jsonb_build_object('owner_contact_id', md5(d.owner_contact_id::text));
  end if;
  foreach fld in array array['price', 'bedrooms', 'area_value', 'status', 'listing_type', 'property_type', 'reference_code'] loop
    if to_jsonb(k) ->> fld is distinct from to_jsonb(d) ->> fld then conflicts := conflicts || to_jsonb(fld); end if;
  end loop;
  -- Archiving invalidates the duplicate's current matches (Agent 04 trigger).
  update public.properties set status = 'archived', merged_into = keep_id where id = drop_id;
  perform set_config('app.dq_source', '', true);
  perform set_config('app.dq_reason', '', true);
  insert into public.record_merges (organization_id, entity_type, canonical_id, merged_id, candidate_id, idempotency_key, moved, filled, conflicts, source_state, merged_by)
  values (org, 'property', keep_id, drop_id, cand, p_key, moved, filled, conflicts, jsonb_build_object('status', d.status), auth.uid())
  returning * into m;
  return m.id;
end;
$$;

-- Review decision on a duplicate candidate: reject (distinct records) or merge into the chosen canonical record.
create or replace function public.duplicate_decide(p_candidate uuid, p_decision text, p_canonical uuid, p_state_hash text, p_idempotency_key text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.duplicate_candidates;
  m public.record_merges;
  drop_id uuid;
  mid uuid;
  cur text;
begin
  if coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9_:-]{8,120}$' then perform private.fail('VALIDATION_ERROR', 'Invalid idempotency key'); end if;
  select * into c from public.duplicate_candidates where id = p_candidate for update;
  if c.id is null or not public.has_perm(c.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Duplicate candidate not found'); end if;
  if not public.has_perm(c.organization_id, 'leads.merge') or (c.entity_type = 'property' and not public.has_perm(c.organization_id, 'properties.edit')) then
    perform private.fail('FORBIDDEN', 'You cannot review duplicates');
  end if;
  select * into m from public.record_merges where organization_id = c.organization_id and idempotency_key = p_idempotency_key;
  if m.id is not null then return jsonb_build_object('status', 'merged', 'merge_id', m.id, 'replayed', true); end if;
  if p_decision not in ('merge', 'reject') then perform private.fail('VALIDATION_ERROR', 'Invalid decision'); end if;
  if c.status = 'rejected' and p_decision = 'reject' then return jsonb_build_object('status', 'rejected', 'replayed', true); end if;
  if c.status <> 'open' then perform private.fail('CONFLICT', format('This candidate is %s', c.status)); end if;

  if p_decision = 'reject' then
    update public.duplicate_candidates set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(nullif(trim(coalesce(p_note, '')), ''), 500)
    where id = c.id;
    perform private.write_audit(c.organization_id, 'crm.duplicate_rejected', c.entity_type || 's', c.proposed_canonical, jsonb_build_object('candidate_id', c.id));
    return jsonb_build_object('status', 'rejected');
  end if;

  if p_canonical is null or p_canonical not in (c.record_a, c.record_b) then perform private.fail('VALIDATION_ERROR', 'Choose which record to keep'); end if;
  cur := private.dq_state_hash(c.entity_type, c.record_a, c.record_b);
  if p_state_hash is distinct from c.state_hash or cur <> c.state_hash then
    perform private.fail('CONFLICT', 'One of the records changed since the comparison; reload it');
  end if;
  drop_id := case when p_canonical = c.record_a then c.record_b else c.record_a end;
  if c.entity_type = 'contact' then
    mid := private.dq_merge_contact(c.organization_id, p_canonical, drop_id, c.id, p_idempotency_key);
  elsif c.entity_type = 'property' then
    mid := private.dq_merge_property(c.organization_id, p_canonical, drop_id, c.id, p_idempotency_key);
  else
    -- Leads: the existing merge (same contact; history moved; duplicate archived). Not revertible.
    perform public.merge_leads(p_canonical, drop_id);
    update public.leads set duplicate_status = 'merged' where id = drop_id;
    insert into public.record_merges (organization_id, entity_type, canonical_id, merged_id, candidate_id, idempotency_key, revertible, merged_by)
    values (c.organization_id, 'lead', p_canonical, drop_id, c.id, p_idempotency_key, false, auth.uid()) returning id into mid;
  end if;
  update public.duplicate_candidates set status = 'merged', reviewed_by = auth.uid(), reviewed_at = now(), merge_id = mid,
    review_note = left(nullif(trim(coalesce(p_note, '')), ''), 500)
  where id = c.id;
  -- Other open candidates that involve the merged record are no longer meaningful.
  update public.duplicate_candidates set status = 'stale', last_detected_at = now()
  where organization_id = c.organization_id and entity_type = c.entity_type and status = 'open' and id <> c.id and (record_a = drop_id or record_b = drop_id);
  perform private.write_audit(c.organization_id, 'crm.records_merged', c.entity_type || 's', p_canonical,
    jsonb_build_object('merged', drop_id, 'merge_id', mid, 'candidate_id', c.id));
  perform private.dq_event(c.organization_id, 'crm.duplicate_merge_completed', 'record_merge', mid, (select correlation_id from public.record_merges where id = mid),
    jsonb_build_object('merge_id', mid, 'entity_type', c.entity_type, 'canonical_id', p_canonical, 'merged_id', drop_id, 'candidate_id', c.id),
    'crm.duplicate_merge_completed:' || mid::text);
  perform private.dq_enqueue(c.organization_id, c.entity_type, p_canonical);
  return jsonb_build_object('status', 'merged', 'merge_id', mid, 'canonical_id', p_canonical, 'merged_id', drop_id);
end;
$$;

-- Undo a contact or property merge: moved rows that still point at the canonical record go back, filled fields that were
-- not changed since are cleared, the duplicate is restored. Consent revocations are kept (the safe direction).
create or replace function public.record_merge_revert(p_merge uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.record_merges;
  t text;
  fld text;
  ch jsonb;
  n int := 0;
  cnt int;
begin
  select * into m from public.record_merges where id = p_merge for update;
  if m.id is null or not public.has_perm(m.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Merge not found'); end if;
  if not public.has_perm(m.organization_id, 'leads.merge') then perform private.fail('FORBIDDEN', 'You cannot revert merges'); end if;
  if m.status = 'reverted' then return jsonb_build_object('status', 'reverted', 'replayed', true); end if;
  if not m.revertible then perform private.fail('CONFLICT', 'Lead merges cannot be reverted automatically'); end if;
  if char_length(trim(coalesce(p_note, ''))) < 3 then perform private.fail('VALIDATION_ERROR', 'Say why the merge is being reverted'); end if;
  perform set_config('app.crm_merge', 'on', true);
  perform set_config('app.dq_source', 'merge', true);
  perform set_config('app.dq_reason', 'Merge reverted', true);
  if m.entity_type = 'contact' then
    perform 1 from public.contacts where id in (m.canonical_id, m.merged_id) order by id for update;
    foreach t in array array['leads:contact_id', 'deals:primary_contact_id', 'appointments:contact_id', 'activities:contact_id', 'documents:related_contact_id',
                             'voice_calls:contact_id', 'follow_ups:contact_id', 'properties:owner_contact_id'] loop
      execute format('update public.%I set %I = $1 where %I = $2 and id in (select (jsonb_array_elements_text($3))::uuid)',
        split_part(t, ':', 1), split_part(t, ':', 2), split_part(t, ':', 2))
        using m.merged_id, m.canonical_id, coalesce(m.moved -> split_part(t, ':', 1), '[]');
      get diagnostics cnt = row_count;
      n := n + cnt;
    end loop;
    for fld in select jsonb_object_keys(m.filled) loop
      execute format('update public.contacts set %I = null where id = $1 and md5(%I::text) = $2 and (email is not null or phone is not null)', fld, fld)
        using m.canonical_id, m.filled ->> fld;
    end loop;
    -- Grants carried from the duplicate go back to "no decision"; revocations stay.
    for ch in select * from jsonb_array_elements(m.consent_changes) loop
      if ch ->> 'to' = 'granted' then
        update public.communication_consents set status = 'unknown', captured_via = 'Merge reverted'
        where contact_id = m.canonical_id and channel = ch ->> 'channel' and purpose = ch ->> 'purpose' and status = 'granted'
          and captured_via like 'Carried from merged duplicate%';
      end if;
    end loop;
    update public.contacts set merged_into = null, lifecycle_status = coalesce(m.source_state ->> 'lifecycle_status', lifecycle_status),
      tags = coalesce(array(select jsonb_array_elements_text(m.source_state -> 'tags')), tags)
    where id = m.merged_id;
  else
    perform 1 from public.properties where id in (m.canonical_id, m.merged_id) order by id for update;
    foreach t in array array['tasks:related_property_id', 'documents:related_property_id', 'availability_blocks:property_id'] loop
      execute format('update public.%I set %I = $1 where %I = $2 and id in (select (jsonb_array_elements_text($3))::uuid)',
        split_part(t, ':', 1), split_part(t, ':', 2), split_part(t, ':', 2))
        using m.merged_id, m.canonical_id, coalesce(m.moved -> split_part(t, ':', 1), '[]');
      get diagnostics cnt = row_count;
      n := n + cnt;
    end loop;
    for fld in select jsonb_object_keys(m.filled) loop
      execute format('update public.properties set %I = null where id = $1 and md5(%I::text) = $2', fld, fld) using m.canonical_id, m.filled ->> fld;
    end loop;
    update public.properties set merged_into = null, status = coalesce(m.source_state ->> 'status', 'draft') where id = m.merged_id;
  end if;
  perform set_config('app.crm_merge', 'off', true);
  perform set_config('app.dq_source', '', true);
  perform set_config('app.dq_reason', '', true);
  update public.record_merges set status = 'reverted', reverted_by = auth.uid(), reverted_at = now(), revert_note = left(trim(p_note), 500) where id = m.id;
  update public.duplicate_candidates set status = 'rejected', review_note = left('Merge reverted: ' || trim(p_note), 500), reviewed_by = auth.uid(), reviewed_at = now()
  where id = m.candidate_id;
  perform private.write_audit(m.organization_id, 'crm.merge_reverted', m.entity_type || 's', m.canonical_id, jsonb_build_object('merge_id', m.id, 'restored', m.merged_id, 'rows', n));
  perform private.dq_event(m.organization_id, 'crm.duplicate_merge_reverted', 'record_merge', m.id, m.correlation_id,
    jsonb_build_object('merge_id', m.id, 'entity_type', m.entity_type, 'canonical_id', m.canonical_id, 'merged_id', m.merged_id), 'crm.duplicate_merge_reverted:' || m.id::text);
  perform private.dq_enqueue(m.organization_id, m.entity_type, m.canonical_id);
  perform private.dq_enqueue(m.organization_id, m.entity_type, m.merged_id);
  return jsonb_build_object('status', 'reverted', 'rows_restored', n);
end;
$$;

-- ───────────────────────── issue actions, corrections, verification ─────────────────────────

create or replace function public.dq_issue_action(p_issue uuid, p_action text, p_note text default null, p_assignee uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x public.data_quality_issues;
  r jsonb;
begin
  select * into x from public.data_quality_issues where id = p_issue for update;
  if x.id is null or not public.has_perm(x.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Issue not found'); end if;
  if not public.has_perm(x.organization_id, private.dq_entity_perm(x.entity_type)) then perform private.fail('FORBIDDEN', 'You cannot act on this issue'); end if;
  if p_action = 'start_review' then
    if x.status not in ('open', 'reopened', 'proposed') then perform private.fail('CONFLICT', 'Only open issues can be taken for review'); end if;
    update public.data_quality_issues set status = 'under_review', assigned_to = coalesce(assigned_to, auth.uid()) where id = x.id;
  elsif p_action = 'assign' then
    if p_assignee is not null and not private.is_active_member(x.organization_id, p_assignee) then perform private.fail('VALIDATION_ERROR', 'Choose an active team member'); end if;
    update public.data_quality_issues set assigned_to = p_assignee where id = x.id;
  elsif p_action = 'dismiss' then
    if x.status in ('resolved', 'dismissed') then return jsonb_build_object('status', x.status, 'replayed', true); end if;
    if char_length(trim(coalesce(p_note, ''))) < 3 then perform private.fail('VALIDATION_ERROR', 'Say why this is not a problem'); end if;
    if x.severity = 'critical' then perform private.fail('FORBIDDEN', 'Critical integrity issues cannot be dismissed'); end if;
    perform private.dq_resolve(x, 'dismissed', trim(p_note));
  elsif p_action = 'reopen' then
    if x.status <> 'dismissed' then perform private.fail('CONFLICT', 'Only dismissed issues can be reopened'); end if;
    update public.data_quality_issues set status = 'reopened', occurrence = occurrence + 1, resolution = null, resolved_at = null, resolved_by = null,
      resolution_note = left(nullif(trim(coalesce(p_note, '')), ''), 500) where id = x.id;
  elsif p_action = 'resolve' then
    if x.status in ('resolved', 'dismissed') then return jsonb_build_object('status', x.status, 'replayed', true); end if;
    if x.origin = 'rule' then
      r := private.dq_process(x.organization_id, x.entity_type, x.entity_id, null);
      select * into x from public.data_quality_issues where id = x.id;
      if x.status not in ('resolved', 'dismissed') then perform private.fail('CONFLICT', 'The problem is still detected; correct the record or dismiss the issue'); end if;
      update public.data_quality_issues set resolution = 'fixed_elsewhere', resolved_by = auth.uid(), resolution_note = left(nullif(trim(coalesce(p_note, '')), ''), 500)
      where id = x.id and resolution = 'no_longer_detected';
    else
      if char_length(trim(coalesce(p_note, ''))) < 3 then perform private.fail('VALIDATION_ERROR', 'Say how it was resolved'); end if;
      perform private.dq_resolve(x, 'fixed_elsewhere', trim(p_note));
    end if;
  else
    perform private.fail('VALIDATION_ERROR', 'Invalid action');
  end if;
  perform private.write_audit(x.organization_id, 'crm.issue_' || p_action, 'data_quality_issues', x.id, jsonb_build_object('rule_id', x.rule_id));
  return jsonb_build_object('status', (select status from public.data_quality_issues where id = x.id));
end;
$$;

-- Apply the issue's proposed correction through a normal, audited update (provenance: correction).
create or replace function public.dq_issue_apply_fix(p_issue uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x public.data_quality_issues;
  fld text;
  tbl text;
  allowed text[];
  lead_id uuid;
  contact_id uuid;
begin
  select * into x from public.data_quality_issues where id = p_issue for update;
  if x.id is null or not public.has_perm(x.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Issue not found'); end if;
  if not public.has_perm(x.organization_id, private.dq_entity_perm(x.entity_type)) then perform private.fail('FORBIDDEN', 'You cannot edit this record'); end if;
  if x.status in ('resolved', 'dismissed') then perform private.fail('CONFLICT', 'This issue is already closed'); end if;
  if jsonb_typeof(x.proposed_fix) <> 'object' then perform private.fail('VALIDATION_ERROR', 'This issue has no proposed correction'); end if;
  fld := x.proposed_fix ->> 'field';
  tbl := case x.entity_type when 'contact' then 'contacts' when 'lead' then 'leads' when 'property' then 'properties' end;
  allowed := case x.entity_type when 'contact' then array['display_name']
                                when 'lead' then array['budget_min', 'budget_max', 'desired_property_type', 'bedrooms', 'timeline', 'desired_transaction']
                                when 'property' then array['city', 'address_line_1'] else '{}' end;
  if tbl is null or not (fld = any (allowed)) then perform private.fail('VALIDATION_ERROR', 'This correction cannot be applied automatically'); end if;
  perform set_config('app.dq_source', 'correction', true);
  perform set_config('app.dq_ref', x.id::text, true);
  perform set_config('app.dq_reason', left('Applied data quality correction: ' || x.rule_id, 200), true);
  begin
    execute format('update public.%I t set %I = (jsonb_populate_record(null::public.%I, $1)).%I where id = $2 and organization_id = $3', tbl, fld, tbl, fld)
      using jsonb_build_object(fld, x.proposed_fix -> 'value'), x.entity_id, x.organization_id;
  exception when check_violation or invalid_text_representation or numeric_value_out_of_range or not_null_violation then
    perform private.fail('VALIDATION_ERROR', 'The proposed value is not valid for this field');
  end;
  perform set_config('app.dq_source', '', true);
  perform set_config('app.dq_ref', '', true);
  perform set_config('app.dq_reason', '', true);
  if x.origin <> 'rule' then
    perform private.dq_resolve(x, 'corrected', null);
  end if;
  perform private.dq_process(x.organization_id, x.entity_type, x.entity_id, null);
  update public.data_quality_issues set resolution = 'corrected', resolved_by = auth.uid() where id = x.id and resolution = 'no_longer_detected';
  if x.entity_type = 'lead' then
    select l.id, l.contact_id into lead_id, contact_id from public.leads l where l.id = x.entity_id;
  elsif x.entity_type = 'contact' then
    contact_id := x.entity_id;
  end if;
  if lead_id is not null or contact_id is not null then
    perform private.add_activity(x.organization_id, lead_id, contact_id, null, 'updated', format('Data correction applied: %s', replace(fld, '_', ' ')),
      case when x.origin = 'ai_extraction' then 'Proposed from the lead''s notes and approved by a person.' else 'Approved by a person.' end);
  end if;
  perform private.write_audit(x.organization_id, 'crm.correction_applied', tbl, x.entity_id, jsonb_build_object('field', fld, 'issue_id', x.id, 'origin', x.origin));
  return jsonb_build_object('status', (select status from public.data_quality_issues where id = x.id));
end;
$$;

-- A person confirms (or withdraws confirmation of) a field value. Verified values are protected from automated overwrites.
create or replace function public.dq_verify_field(p_entity_type text, p_entity_id uuid, p_field text, p_verified boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
  v jsonb;
  allowed text[] := case p_entity_type when 'contact' then array['display_name', 'email', 'phone']
    when 'lead' then array['budget_min', 'budget_max', 'budget_currency', 'desired_transaction', 'desired_property_type', 'desired_locations', 'bedrooms', 'timeline', 'source']
    when 'property' then array['price', 'currency', 'status', 'address_line_1', 'locality', 'city', 'bedrooms', 'area_value'] else '{}' end;
begin
  if not (coalesce(p_field, '') = any (allowed)) then perform private.fail('VALIDATION_ERROR', 'This field cannot be verified'); end if;
  if p_entity_type = 'contact' then select organization_id, to_jsonb(c) -> p_field into org, v from public.contacts c where id = p_entity_id;
  elsif p_entity_type = 'lead' then select organization_id, to_jsonb(l) -> p_field into org, v from public.leads l where id = p_entity_id;
  else select organization_id, to_jsonb(p) -> p_field into org, v from public.properties p where id = p_entity_id; end if;
  if org is null or not public.has_perm(org, 'leads.view') then perform private.fail('NOT_FOUND', 'Record not found'); end if;
  if not public.has_perm(org, private.dq_entity_perm(p_entity_type)) then perform private.fail('FORBIDDEN', 'You cannot verify this record'); end if;
  if p_verified and (v is null or jsonb_typeof(v) = 'null') then perform private.fail('VALIDATION_ERROR', 'An empty value cannot be verified'); end if;
  insert into public.field_provenance (organization_id, entity_type, entity_id, field, source_type, source_label, captured_at, value_hash, verification_status, verified_at, verified_by)
  values (org, p_entity_type, p_entity_id, p_field, 'legacy', 'Recorded before provenance tracking', now(), md5(coalesce(v #>> '{}', '')),
    case when p_verified then 'verified' else 'unverified' end, case when p_verified then now() end, case when p_verified then auth.uid() end)
  on conflict (entity_type, entity_id, field) do update set verification_status = excluded.verification_status, verified_at = excluded.verified_at,
    verified_by = excluded.verified_by;
  perform private.write_audit(org, case when p_verified then 'crm.field_verified' else 'crm.field_unverified' end, p_entity_type || 's', p_entity_id, jsonb_build_object('field', p_field));
  return jsonb_build_object('field', p_field, 'verification_status', case when p_verified then 'verified' else 'unverified' end);
end;
$$;

-- Model-proposed values from a lead's own notes (called by the crm-enrichment Edge Function as the signed-in user).
-- Stored as proposals with evidence; never applied here.
create or replace function public.dq_propose_enrichment(p_lead uuid, p_proposals jsonb, p_model text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.leads;
  x jsonb;
  fld text;
  val jsonb;
  cur jsonb;
  probe public.leads;
  n int := 0;
  skipped int := 0;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null or not public.has_perm(l.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
  if not public.has_perm(l.organization_id, 'leads.edit') then perform private.fail('FORBIDDEN', 'You cannot edit this lead'); end if;
  if jsonb_typeof(p_proposals) <> 'array' or jsonb_array_length(p_proposals) > 10 then perform private.fail('VALIDATION_ERROR', 'Invalid proposals'); end if;
  for x in select * from jsonb_array_elements(p_proposals) loop
    fld := x ->> 'field';
    val := x -> 'value';
    if fld is null or not (fld = any (array['budget_min', 'budget_max', 'desired_property_type', 'bedrooms', 'timeline', 'desired_transaction']))
       or char_length(coalesce(x ->> 'evidence', '')) not between 3 and 300 then
      skipped := skipped + 1; continue;
    end if;
    -- Domain check through the table's own types and constraints, without writing anything.
    begin
      probe := jsonb_populate_record(l, jsonb_build_object(fld, val));
      if (fld in ('budget_min', 'budget_max') and (to_jsonb(probe) ->> fld)::numeric <= 0)
         or (fld = 'bedrooms' and (to_jsonb(probe) ->> fld)::int not between 0 and 20)
         or (fld = 'desired_property_type' and not (to_jsonb(probe) ->> fld = any (array['apartment', 'penthouse', 'villa', 'house', 'townhouse', 'plot', 'office', 'retail', 'commercial', 'other'])))
         or (fld = 'desired_transaction' and not (to_jsonb(probe) ->> fld = any (array['buy', 'rent', 'sell', 'let', 'invest'])))
         or (fld = 'timeline' and char_length(to_jsonb(probe) ->> fld) > 40) then
        skipped := skipped + 1; continue;
      end if;
    exception when others then
      skipped := skipped + 1; continue;
    end;
    cur := to_jsonb(l) -> fld;
    if cur is not distinct from (to_jsonb(probe) -> fld) then skipped := skipped + 1; continue; end if;
    perform private.dq_upsert_issue(l.organization_id, 'lead', l.id, 'enrichment.proposed_value', 'info', 'completeness',
      format('The notes suggest a value for %s', replace(fld, '_', ' ')),
      jsonb_build_object('field', fld, 'evidence', left(x ->> 'evidence', 300), 'source', 'lead_notes', 'model', left(p_model, 60), 'replaces_existing', cur is not null and jsonb_typeof(cur) <> 'null',
        'current_value_verified', exists (select 1 from public.field_provenance fp where fp.entity_type = 'lead' and fp.entity_id = l.id and fp.field = fld and fp.verification_status = 'verified')),
      'Check the evidence, then apply or dismiss', jsonb_build_object('field', fld, 'value', to_jsonb(probe) -> fld), 'ai_extraction', fld || ':' || md5((to_jsonb(probe) -> fld)::text), null);
    n := n + 1;
  end loop;
  return jsonb_build_object('proposed', n, 'skipped', skipped);
end;
$$;

-- ───────────────────────── scans, settings ─────────────────────────

create or replace function public.data_quality_scan_request(p_org uuid, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.data_quality_scans;
begin
  if not public.has_perm(p_org, 'leads.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if not public.has_perm(p_org, 'agents.manage') then perform private.fail('FORBIDDEN', 'You cannot start scans'); end if;
  if coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9_:-]{8,120}$' then perform private.fail('VALIDATION_ERROR', 'Invalid idempotency key'); end if;
  select * into s from public.data_quality_scans where organization_id = p_org and idempotency_key = p_idempotency_key;
  if s.id is not null then return jsonb_build_object('scan_id', s.id, 'status', s.status, 'replayed', true); end if;
  select * into s from public.data_quality_scans where organization_id = p_org and status in ('requested', 'running');
  if s.id is not null then return jsonb_build_object('scan_id', s.id, 'status', s.status, 'already_running', true); end if;
  insert into public.data_quality_scans (organization_id, kind, requested_by, idempotency_key) values (p_org, 'full', auth.uid(), p_idempotency_key) returning * into s;
  perform private.write_audit(p_org, 'crm.scan_requested', 'data_quality_scans', s.id, '{}');
  return jsonb_build_object('scan_id', s.id, 'status', s.status);
end;
$$;

create or replace function public.data_quality_scan_cancel(p_scan uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.data_quality_scans;
begin
  select * into s from public.data_quality_scans where id = p_scan for update;
  if s.id is null or not public.has_perm(s.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Scan not found'); end if;
  if not public.has_perm(s.organization_id, 'agents.manage') then perform private.fail('FORBIDDEN', 'You cannot cancel scans'); end if;
  if s.status not in ('requested', 'running') then return jsonb_build_object('status', s.status, 'replayed', true); end if;
  update public.data_quality_scans set status = 'cancelled', completed_at = now() where id = s.id;
  return jsonb_build_object('status', 'cancelled');
end;
$$;

create or replace function public.data_quality_settings_save(p_org uuid, p_rules jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ver int;
  e record;
begin
  if not public.has_perm(p_org, 'settings.manage') then perform private.fail('FORBIDDEN', 'You cannot change data quality rules'); end if;
  if jsonb_typeof(p_rules) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_rules) k where k not in ('disabled_rules', 'severity_overrides', 'qualification_stale_days', 'property_stale_days',
          'integration_stale_hours', 'budget_plausibility', 'property_price_plausibility', 'anomaly', 'batch_per_org', 'scan_batch', 'daily_scan'))
     or (p_rules ? 'disabled_rules' and (jsonb_typeof(p_rules -> 'disabled_rules') <> 'array'
         or exists (select 1 from jsonb_array_elements(p_rules -> 'disabled_rules') r where jsonb_typeof(r) <> 'string' or r #>> '{}' !~ '^[a-z_]+\.[a-z_]+$')))
     or (p_rules ? 'severity_overrides' and (jsonb_typeof(p_rules -> 'severity_overrides') <> 'object'
         or exists (select 1 from jsonb_each(p_rules -> 'severity_overrides') s where s.key !~ '^[a-z_]+\.[a-z_]+$' or s.value #>> '{}' not in ('info', 'warning', 'high'))))
     or (p_rules ? 'qualification_stale_days' and coalesce((p_rules ->> 'qualification_stale_days')::int, 0) not between 1 and 365)
     or (p_rules ? 'property_stale_days' and coalesce((p_rules ->> 'property_stale_days')::int, 0) not between 1 and 730)
     or (p_rules ? 'integration_stale_hours' and coalesce((p_rules ->> 'integration_stale_hours')::int, 0) not between 1 and 720)
     or (p_rules ? 'batch_per_org' and coalesce((p_rules ->> 'batch_per_org')::int, 0) not between 10 and 1000)
     or (p_rules ? 'scan_batch' and coalesce((p_rules ->> 'scan_batch')::int, 0) not between 50 and 2000)
     or (p_rules ? 'daily_scan' and jsonb_typeof(p_rules -> 'daily_scan') <> 'boolean')
     or (p_rules ? 'anomaly' and jsonb_typeof(p_rules -> 'anomaly') <> 'object')
  then
    perform private.fail('VALIDATION_ERROR', 'Data quality rules are invalid');
  end if;
  for e in select * from jsonb_each(coalesce(p_rules -> 'budget_plausibility', '{}') || coalesce(p_rules -> 'property_price_plausibility', '{}')) loop
    if e.key !~ '^[A-Z]{3}$' or jsonb_typeof(e.value) <> 'object'
       or exists (select 1 from jsonb_each(e.value) v where v.key not in ('rent_max', 'purchase_min', 'sale_min') or jsonb_typeof(v.value) <> 'number' or (v.value #>> '{}')::numeric <= 0) then
      perform private.fail('VALIDATION_ERROR', 'Plausibility thresholds are invalid');
    end if;
  end loop;
  insert into public.data_quality_settings (organization_id, rules, updated_by) values (p_org, p_rules, auth.uid())
  on conflict (organization_id) do update set rules = excluded.rules, version = public.data_quality_settings.version + 1, updated_by = excluded.updated_by
  returning version into ver;
  return ver;
exception
  when invalid_text_representation then perform private.fail('VALIDATION_ERROR', 'Data quality rules are invalid'); return null;
end;
$$;

-- ───────────────────────── daily snapshot & anomalies ─────────────────────────

create or replace function private.dq_snapshot(org uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m jsonb;
begin
  m := jsonb_build_object(
    'contacts_24h', (select count(*) from public.contacts where organization_id = org and created_at > now() - interval '24 hours'),
    'invalid_phones_24h', (select count(*) from public.contacts where organization_id = org and created_at > now() - interval '24 hours'
                             and private.dq_phone_check(phone, phone_e164) = 'invalid'),
    'duplicates_24h', (select count(*) from public.duplicate_candidates where organization_id = org and detected_at > now() - interval '24 hours' and strength <> 'weak'),
    'webhook_rejected_24h', (select count(*) from public.webhook_events where organization_id = org and received_at > now() - interval '24 hours'
                               and processing_status in ('rejected', 'failed', 'dead_letter')),
    'active_properties', (select count(*) from public.properties where organization_id = org and status = 'active' and merged_into is null),
    'leads_24h', (select count(*) from public.leads where organization_id = org and created_at > now() - interval '24 hours'),
    'lead_sources_24h', (select coalesce(jsonb_object_agg(source, n), '{}') from (select source, count(*) n from public.leads
                          where organization_id = org and created_at > now() - interval '24 hours' group by source) s));
  insert into public.data_quality_daily (organization_id, day, metrics) values (org, current_date, m) on conflict (organization_id, day) do nothing;
  return m;
end;
$$;

-- Deterministic anomaly rules against the trailing 28-day baseline. Without enough history nothing is alerted.
create or replace function private.dq_anomalies(org uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rules jsonb := private.dq_rules(org);
  cfg jsonb := rules -> 'anomaly';
  today jsonb;
  days int;
  met text;
  base numeric;
  cur numeric;
  found text[] := '{}';
  top_src text;
  share_today numeric;
  share_base numeric;
  x public.data_quality_issues;
  res jsonb;
begin
  select metrics into today from public.data_quality_daily where organization_id = org and day = current_date;
  select count(*) into days from public.data_quality_daily where organization_id = org and day < current_date and day >= current_date - 28;
  if today is null or days < coalesce((cfg ->> 'min_baseline_days')::int, 7) then
    res := jsonb_build_object('evaluated', false, 'baseline_days', days, 'reason', 'not_enough_history');
    update public.data_quality_daily set anomalies = res where organization_id = org and day = current_date;
    return res;
  end if;
  foreach met in array array['invalid_phones_24h', 'duplicates_24h', 'webhook_rejected_24h'] loop
    select avg((metrics ->> met)::numeric) into base from public.data_quality_daily where organization_id = org and day < current_date and day >= current_date - 28;
    cur := (today ->> met)::numeric;
    if cur > greatest(coalesce((cfg ->> 'spike_min_count')::numeric, 5), coalesce((cfg ->> 'spike_factor')::numeric, 3) * coalesce(base, 0)) then
      perform private.dq_upsert_issue(org, 'organization', org, 'anomaly.' || replace(met, '_24h', '') || '_spike', 'warning', 'anomaly',
        format('%s in the last 24 hours: %s (usual: %s per day)', initcap(replace(replace(met, '_24h', ''), '_', ' ')), cur, round(coalesce(base, 0), 1)),
        jsonb_build_object('metric', met, 'today', cur, 'baseline_avg', round(coalesce(base, 0), 2), 'baseline_days', days),
        'Check the recent imports and integrations', null, 'anomaly', null, null);
      found := found || ('anomaly.' || replace(met, '_24h', '') || '_spike');
    end if;
  end loop;
  select avg((metrics ->> 'active_properties')::numeric) into base from public.data_quality_daily where organization_id = org and day < current_date and day >= current_date - 28;
  cur := (today ->> 'active_properties')::numeric;
  if base >= 5 and cur < base * (1 - coalesce((cfg ->> 'inventory_drop_pct')::numeric, 30) / 100) then
    perform private.dq_upsert_issue(org, 'organization', org, 'anomaly.inventory_drop', 'high', 'anomaly',
      format('Active listings dropped to %s (usual: %s)', cur, round(base)), jsonb_build_object('today', cur, 'baseline_avg', round(base, 2), 'baseline_days', days),
      'Check whether listings were withdrawn or archived by mistake', null, 'anomaly', null, null);
    found := found || 'anomaly.inventory_drop'::text;
    perform private.dq_alert(org, 'Active listings dropped sharply', format('Active listings: %s (usual about %s).', cur, round(base)), 'organization', org,
      'dq-inventory-drop:' || current_date);
  end if;
  if (today ->> 'leads_24h')::int >= 10 then
    select key, (value #>> '{}')::numeric / (today ->> 'leads_24h')::numeric into top_src, share_today
    from jsonb_each(today -> 'lead_sources_24h') order by (value #>> '{}')::numeric desc limit 1;
    select coalesce(sum((d.metrics -> 'lead_sources_24h' ->> top_src)::numeric), 0) / nullif(sum((d.metrics ->> 'leads_24h')::numeric), 0) into share_base
    from public.data_quality_daily d where d.organization_id = org and d.day < current_date and d.day >= current_date - 28;
    if share_base is not null and abs(share_today - share_base) * 100 > coalesce((cfg ->> 'source_shift_pct')::numeric, 40) then
      perform private.dq_upsert_issue(org, 'organization', org, 'anomaly.source_shift', 'info', 'anomaly',
        format('%s%% of today''s leads came from %s (usual: %s%%)', round(share_today * 100), top_src, round(share_base * 100)),
        jsonb_build_object('source', top_src, 'share_today', round(share_today, 3), 'share_baseline', round(share_base, 3), 'baseline_days', days),
        'Check the lead source configuration and campaigns', null, 'anomaly', null, null);
      found := found || 'anomaly.source_shift'::text;
    end if;
  end if;
  for x in select * from public.data_quality_issues where organization_id = org and entity_type = 'organization' and origin = 'anomaly'
             and status in ('open', 'under_review', 'reopened') and not (rule_id = any (found)) loop
    perform private.dq_resolve(x, 'no_longer_detected', null);
  end loop;
  res := jsonb_build_object('evaluated', true, 'baseline_days', days, 'detected', to_jsonb(found));
  update public.data_quality_daily set anomalies = res where organization_id = org and day = current_date;
  if cardinality(found) > 0 then
    perform private.dq_event(org, 'crm.anomaly_detected', 'organization', org, null, jsonb_build_object('rules', to_jsonb(found), 'day', current_date),
      'crm.anomaly_detected:' || current_date || ':' || array_to_string(found, ','));
  end if;
  return res;
end;
$$;

-- ───────────────────────── worker tick (pg_cron) ─────────────────────────

-- One bounded pass: changed records (fair share per org), active scans (one checkpointed batch each), daily snapshot,
-- anomaly rules and the daily scheduled scan. A failing record is retried with backoff and never blocks the others.
create or replace function public.crm_data_tick(p_limit int default 1000)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o record;
  q record;
  s public.data_quality_scans;
  rules jsonb;
  done int := 0;
  failed int := 0;
  scanned int := 0;
  r jsonb;
  ent text;
  after_id uuid;
  ids uuid[];
  eid uuid;
  v_counts jsonb;
  order_ents text[] := array['contact', 'lead', 'property', 'appointment', 'integration'];
  idx int;
  snaps int := 0;
begin
  -- 1. Changed records.
  for o in select distinct organization_id from public.data_quality_queue where attempts < 5 and enqueued_at <= now() limit 50 loop
    rules := private.dq_rules(o.organization_id);
    for q in select * from public.data_quality_queue where organization_id = o.organization_id and attempts < 5 and enqueued_at <= now()
               order by enqueued_at limit least(coalesce((rules ->> 'batch_per_org')::int, 200), greatest(p_limit - done, 1)) for update skip locked loop
      begin
        perform private.dq_process(q.organization_id, q.entity_type, q.entity_id, null);
        delete from public.data_quality_queue where organization_id = q.organization_id and entity_type = q.entity_type and entity_id = q.entity_id
          and enqueued_at = q.enqueued_at;
        done := done + 1;
      exception when others then
        update public.data_quality_queue set attempts = attempts + 1, last_error = left(sqlerrm, 300),
          enqueued_at = now() + make_interval(mins => power(2, attempts + 1)::int)
        where organization_id = q.organization_id and entity_type = q.entity_type and entity_id = q.entity_id;
        failed := failed + 1;
      end;
    end loop;
    exit when done >= p_limit;
  end loop;

  -- 2. Daily snapshot, anomaly rules and scheduled scan (once per org per day).
  for o in select org.id from public.organizations org
           where not exists (select 1 from public.data_quality_daily d where d.organization_id = org.id and d.day = current_date) limit 20 loop
    perform private.dq_snapshot(o.id);
    perform private.dq_anomalies(o.id);
    if coalesce((private.dq_rules(o.id) ->> 'daily_scan')::boolean, true) then
      insert into public.data_quality_scans (organization_id, kind, idempotency_key) values (o.id, 'scheduled', 'daily:' || current_date)
      on conflict do nothing;
    end if;
    snaps := snaps + 1;
  end loop;

  -- 3. Scans: one checkpointed batch per active scan.
  for s in select * from public.data_quality_scans where status in ('requested', 'running') order by requested_at limit 20 for update skip locked loop
    rules := private.dq_rules(s.organization_id);
    v_counts := s.counts;
    ent := coalesce(s.cursor ->> 'entity', 'contact');
    after_id := nullif(s.cursor ->> 'after', '')::uuid;
    ids := case ent
      when 'contact' then array(select id from public.contacts where organization_id = s.organization_id and (after_id is null or id > after_id) order by id limit (rules ->> 'scan_batch')::int)
      when 'lead' then array(select id from public.leads where organization_id = s.organization_id and (after_id is null or id > after_id) order by id limit (rules ->> 'scan_batch')::int)
      when 'property' then array(select id from public.properties where organization_id = s.organization_id and (after_id is null or id > after_id) order by id limit (rules ->> 'scan_batch')::int)
      when 'appointment' then array(select id from public.appointments where organization_id = s.organization_id and (after_id is null or id > after_id)
                                      and (status in ('requested', 'pending', 'confirmed', 'reschedule_requested') or calendar_sync_status = 'failed') order by id limit (rules ->> 'scan_batch')::int)
      else array(select id from public.integrations where organization_id = s.organization_id and (after_id is null or id > after_id) order by id limit (rules ->> 'scan_batch')::int) end;
    foreach eid in array ids loop
      begin
        r := private.dq_process(s.organization_id, ent, eid, s.id);
        v_counts := jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_counts,
          '{evaluated}', to_jsonb(coalesce((v_counts ->> 'evaluated')::int, 0) + 1)),
          '{issues_new}', to_jsonb(coalesce((v_counts ->> 'issues_new')::int, 0) + (r ->> 'new')::int)),
          '{issues_updated}', to_jsonb(coalesce((v_counts ->> 'issues_updated')::int, 0) + (r ->> 'updated')::int)),
          '{issues_resolved}', to_jsonb(coalesce((v_counts ->> 'issues_resolved')::int, 0) + (r ->> 'resolved')::int));
      exception when others then
        v_counts := jsonb_set(v_counts, '{failed}', to_jsonb(coalesce((v_counts ->> 'failed')::int, 0) + 1));
      end;
      scanned := scanned + 1;
    end loop;
    if cardinality(ids) = (rules ->> 'scan_batch')::int then
      update public.data_quality_scans set status = 'running', started_at = coalesce(started_at, now()), counts = v_counts,
        cursor = jsonb_build_object('entity', ent, 'after', ids[cardinality(ids)]) where id = s.id;
    else
      idx := array_position(order_ents, ent);
      if idx < cardinality(order_ents) then
        update public.data_quality_scans set status = 'running', started_at = coalesce(started_at, now()), counts = v_counts,
          cursor = jsonb_build_object('entity', order_ents[idx + 1], 'after', null) where id = s.id;
      else
        update public.data_quality_scans set status = case when coalesce((v_counts ->> 'failed')::int, 0) > 0 then 'partial' else 'completed' end,
          started_at = coalesce(started_at, now()), completed_at = now(), counts = v_counts, cursor = jsonb_build_object('entity', ent, 'after', null)
        where id = s.id;
        perform private.dq_event(s.organization_id, 'crm.data_scan_completed', 'data_quality_scan', s.id, null,
          jsonb_build_object('scan_id', s.id, 'kind', s.kind, 'status', case when coalesce((v_counts ->> 'failed')::int, 0) > 0 then 'partial' else 'completed' end,
            'counts', v_counts), 'crm.data_scan_completed:' || s.id::text);
      end if;
    end if;
  end loop;
  return jsonb_build_object('processed', done, 'failed', failed, 'scanned', scanned, 'snapshots', snaps);
end;
$$;

-- ───────────────────────── read models ─────────────────────────

create or replace function private.dq_entity_label(et text, eid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case et
    when 'contact' then (select display_name from public.contacts where id = eid)
    when 'lead' then (select title from public.leads where id = eid)
    when 'property' then (select reference_code || ' · ' || title from public.properties where id = eid)
    when 'appointment' then (select title || ' · ' || to_char(starts_at at time zone timezone, 'DD Mon HH24:MI') from public.appointments where id = eid)
    when 'integration' then (select display_name from public.integrations where id = eid)
    else 'Workspace' end;
$$;

create or replace function public.crm_data_quality_overview(p_org uuid, p_since timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  active text[] := array['open', 'under_review', 'proposed', 'reopened'];
  n int;
  pen numeric;
  res jsonb;
  since timestamptz := coalesce(p_since, now() - interval '30 days');
begin
  if not public.has_perm(p_org, 'leads.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  with ents as (
    select 'contact' et, id from public.contacts where organization_id = p_org and merged_into is null
    union all select 'lead', id from public.leads where organization_id = p_org and archived_at is null
    union all select 'property', id from public.properties where organization_id = p_org and merged_into is null and status <> 'archived'),
  p as (
    select entity_type, entity_id, least(100, sum(case severity when 'info' then 2 when 'warning' then 8 when 'high' then 20 else 60 end)) pen, bool_or(severity = 'critical') crit
    from public.data_quality_issues where organization_id = p_org and status = any (active) and entity_type in ('contact', 'lead', 'property') group by 1, 2)
  select count(*), coalesce(sum(case when p.crit then greatest(p.pen, 60) else coalesce(p.pen, 0) end), 0) into n, pen
  from ents left join p on p.entity_type = ents.et and p.entity_id = ents.id;

  res := jsonb_build_object(
    'generated_at', now(),
    'records', jsonb_build_object(
      'contacts', (select count(*) from public.contacts where organization_id = p_org and merged_into is null),
      'leads', (select count(*) from public.leads where organization_id = p_org and archived_at is null),
      'properties', (select count(*) from public.properties where organization_id = p_org and merged_into is null and status <> 'archived'),
      'appointments_active', (select count(*) from public.appointments where organization_id = p_org and status in ('requested', 'pending', 'confirmed', 'reschedule_requested'))),
    'issues', (select jsonb_build_object(
      'open', count(*),
      'critical', count(*) filter (where severity = 'critical'), 'high', count(*) filter (where severity = 'high'),
      'warning', count(*) filter (where severity = 'warning'), 'info', count(*) filter (where severity = 'info'),
      'records_affected', count(distinct (entity_type, entity_id)),
      'incomplete_records', count(distinct (entity_type, entity_id)) filter (where dimension = 'completeness'),
      'invalid_records', count(distinct (entity_type, entity_id)) filter (where dimension = 'validity'),
      'stale_records', count(distinct (entity_type, entity_id)) filter (where dimension = 'freshness'),
      'sync_problems', count(*) filter (where dimension = 'sync_integrity'),
      'proposed_corrections', count(*) filter (where status = 'proposed'),
      'by_entity', (select coalesce(jsonb_object_agg(entity_type, c), '{}') from (select entity_type, count(*) c from public.data_quality_issues
                    where organization_id = p_org and status = any (active) group by 1) e))
      from public.data_quality_issues where organization_id = p_org and status = any (active)),
    'resolved_since', (select count(*) from public.data_quality_issues where organization_id = p_org and status = 'resolved' and resolved_at >= since),
    'since', since,
    'duplicates', (select jsonb_build_object('open', count(*) filter (where status = 'open'),
      'awaiting_review', count(*) filter (where status = 'open' and strength in ('strong', 'possible')),
      'strong', count(*) filter (where status = 'open' and strength = 'strong'), 'possible', count(*) filter (where status = 'open' and strength = 'possible'),
      'weak', count(*) filter (where status = 'open' and strength = 'weak'))
      from public.duplicate_candidates where organization_id = p_org),
    'merges_since', (select count(*) from public.record_merges where organization_id = p_org and status = 'completed' and merged_at >= since),
    'score', jsonb_build_object('version', 'dq-score/1', 'average', case when n > 0 then round(100 - pen / n, 1) end, 'records', n,
      'note', 'Average record score; critical and high issues are counted separately and are never hidden by the average'),
    'last_scan', (select jsonb_build_object('id', id, 'kind', kind, 'status', status, 'requested_at', requested_at, 'completed_at', completed_at, 'counts', counts, 'cursor', cursor)
                  from public.data_quality_scans where organization_id = p_org order by requested_at desc limit 1),
    'queue', (select jsonb_build_object('pending', count(*) filter (where attempts < 5), 'failing', count(*) filter (where attempts > 0),
                'oldest', min(enqueued_at) filter (where attempts < 5)) from public.data_quality_queue where organization_id = p_org),
    'baseline', (select anomalies from public.data_quality_daily where organization_id = p_org order by day desc limit 1),
    'integrations', (select jsonb_build_object('connected', count(*) filter (where status = 'connected'), 'failing', count(*) filter (where status in ('error', 'needs_reauth')),
                       'total', count(*)) from public.integrations where organization_id = p_org),
    'can', jsonb_build_object('merge', public.has_perm(p_org, 'leads.merge'), 'scan', public.has_perm(p_org, 'agents.manage'), 'settings', public.has_perm(p_org, 'settings.manage')));
  return res;
end;
$$;

create or replace function public.dq_issues(p_org uuid, p_status text[] default null, p_severity text[] default null, p_entity text default null, p_rule text default null,
  p_assigned uuid default null, p_since timestamptz default null, p_entity_id uuid default null, p_page int default 0, p_page_size int default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  sz int := least(greatest(coalesce(p_page_size, 25), 1), 100);
  st text[] := coalesce(p_status, array['open', 'under_review', 'proposed', 'reopened']);
begin
  if not public.has_perm(p_org, 'leads.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  return (
    with f as (
      select * from public.data_quality_issues x
      where x.organization_id = p_org and x.status = any (st) and (p_severity is null or x.severity = any (p_severity))
        and (p_entity is null or x.entity_type = p_entity) and (p_rule is null or x.rule_id = p_rule) and (p_assigned is null or x.assigned_to = p_assigned)
        and (p_since is null or x.last_detected_at >= p_since) and (p_entity_id is null or x.entity_id = p_entity_id))
    select jsonb_build_object('total', (select count(*) from f), 'page', coalesce(p_page, 0), 'page_size', sz,
      'items', coalesce((select jsonb_agg(to_jsonb(y) || jsonb_build_object('entity_label', private.dq_entity_label(y.entity_type, y.entity_id),
          'assignee_name', (select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr where pr.id = y.assigned_to)) order by y.rk)
        from (select f.*, row_number() over (order by case f.severity when 'critical' then 0 when 'high' then 1 when 'warning' then 2 else 3 end, f.last_detected_at desc, f.id) rk
              from f order by rk offset coalesce(p_page, 0) * sz limit sz) y), '[]')));
end;
$$;

create or replace function public.dq_duplicates(p_org uuid, p_status text default 'open', p_entity text default null, p_strength text[] default null, p_page int default 0, p_page_size int default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  sz int := least(greatest(coalesce(p_page_size, 25), 1), 100);
begin
  if not public.has_perm(p_org, 'leads.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  return (
    with f as (select * from public.duplicate_candidates d where d.organization_id = p_org and d.status = coalesce(p_status, 'open')
               and (p_entity is null or d.entity_type = p_entity) and (p_strength is null or d.strength = any (p_strength)))
    select jsonb_build_object('total', (select count(*) from f), 'page', coalesce(p_page, 0), 'page_size', sz,
      'items', coalesce((select jsonb_agg(to_jsonb(y) - 'rk' || jsonb_build_object('label_a', private.dq_entity_label(y.entity_type, y.record_a),
          'label_b', private.dq_entity_label(y.entity_type, y.record_b)) order by y.rk)
        from (select f.*, row_number() over (order by f.score desc, f.last_detected_at desc, f.id) rk from f order by rk offset coalesce(p_page, 0) * sz limit sz) y), '[]')));
end;
$$;

-- Side-by-side comparison for a review: values, matching / conflicting signals and what a merge would move.
create or replace function public.duplicate_candidate_detail(p_candidate uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.duplicate_candidates;
  rec jsonb := '[]';
  r uuid;
begin
  select * into c from public.duplicate_candidates where id = p_candidate;
  if c.id is null or not public.has_perm(c.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Duplicate candidate not found'); end if;
  foreach r in array array[c.record_a, c.record_b] loop
    rec := rec || jsonb_build_array(case c.entity_type
      when 'contact' then (select jsonb_build_object('id', x.id, 'fields', jsonb_build_object('Name', x.display_name, 'Phone', x.phone, 'Email', x.email, 'Source', x.source,
          'Preferred channel', x.preferred_contact_channel, 'Status', x.lifecycle_status, 'Created', x.created_at),
        'related', jsonb_build_object('leads', (select count(*) from public.leads y where y.contact_id = x.id),
          'deals', (select count(*) from public.deals y where y.primary_contact_id = x.id),
          'appointments', (select count(*) from public.appointments y where y.contact_id = x.id),
          'activities', (select count(*) from public.activities y where y.contact_id = x.id),
          'calls', (select count(*) from public.voice_calls y where y.contact_id = x.id),
          'follow_ups', (select count(*) from public.follow_ups y where y.contact_id = x.id),
          'documents', (select count(*) from public.documents y where y.related_contact_id = x.id),
          'owned_listings', (select count(*) from public.properties y where y.owner_contact_id = x.id)),
        'consents', (select coalesce(jsonb_object_agg(y.channel || ' (' || y.purpose || ')', y.status), '{}') from public.communication_consents y where y.contact_id = x.id),
        'merged_into', x.merged_into) from public.contacts x where x.id = r)
      when 'lead' then (select jsonb_build_object('id', x.id, 'fields', jsonb_build_object('Title', x.title, 'Status', x.status, 'Source', x.source,
          'Transaction', x.desired_transaction, 'Budget', case when x.budget_max is null then null else x.budget_currency || ' ' || x.budget_max end,
          'Locations', array_to_string(x.desired_locations, ', '), 'Created', x.created_at),
        'related', jsonb_build_object('activities', (select count(*) from public.activities y where y.lead_id = x.id),
          'appointments', (select count(*) from public.appointments y where y.lead_id = x.id),
          'tasks', (select count(*) from public.tasks y where y.related_lead_id = x.id),
          'deals', (select count(*) from public.deals y where y.lead_id = x.id)),
        'archived', x.archived_at is not null) from public.leads x where x.id = r)
      else (select jsonb_build_object('id', x.id, 'fields', jsonb_build_object('Reference', x.reference_code, 'Title', x.title, 'Type', x.property_type,
          'Listing', x.listing_type, 'Status', x.status, 'Price', x.currency || ' ' || x.price, 'Bedrooms', x.bedrooms, 'Area', x.area_value || ' ' || x.area_unit,
          'Address', x.address_line_1, 'Locality', x.locality, 'City', x.city, 'Verified', x.verified_at),
        'related', jsonb_build_object('active_appointments', (select count(*) from public.appointments y where y.property_id = x.id
                                        and y.status in ('requested', 'pending', 'confirmed', 'reschedule_requested')),
          'open_deals', (select count(*) from public.deals y where y.property_id = x.id and y.stage not in ('won', 'lost')),
          'tasks', (select count(*) from public.tasks y where y.related_property_id = x.id),
          'documents', (select count(*) from public.documents y where y.related_property_id = x.id)),
        'merged_into', x.merged_into) from public.properties x where x.id = r) end);
  end loop;
  return jsonb_build_object('candidate', to_jsonb(c), 'records', rec,
    'current_state_hash', private.dq_state_hash(c.entity_type, c.record_a, c.record_b),
    'can_merge', public.has_perm(c.organization_id, 'leads.merge') and (c.entity_type <> 'property' or public.has_perm(c.organization_id, 'properties.edit')),
    'revertible', c.entity_type <> 'lead',
    'merge', (select to_jsonb(m) from public.record_merges m where m.id = c.merge_id));
end;
$$;

-- Quality panel for one record: score, open issues, field provenance, duplicate candidates and merges.
create or replace function public.crm_record_quality(p_entity_type text, p_entity_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  org uuid;
  tracked text[] := case p_entity_type when 'contact' then array['display_name', 'email', 'phone']
    when 'lead' then array['budget_min', 'budget_max', 'budget_currency', 'desired_transaction', 'desired_property_type', 'desired_locations', 'bedrooms', 'timeline', 'source']
    when 'property' then array['price', 'currency', 'status', 'address_line_1', 'locality', 'city', 'bedrooms', 'area_value'] else '{}' end;
  pen int;
  crit boolean;
begin
  org := case p_entity_type when 'contact' then (select organization_id from public.contacts where id = p_entity_id)
    when 'lead' then (select organization_id from public.leads where id = p_entity_id)
    when 'property' then (select organization_id from public.properties where id = p_entity_id)
    when 'appointment' then (select organization_id from public.appointments where id = p_entity_id) end;
  if org is null or not public.has_perm(org, 'leads.view') then perform private.fail('NOT_FOUND', 'Record not found'); end if;
  select least(100, coalesce(sum(case severity when 'info' then 2 when 'warning' then 8 when 'high' then 20 else 60 end), 0)), coalesce(bool_or(severity = 'critical'), false)
    into pen, crit
  from public.data_quality_issues where organization_id = org and entity_type = p_entity_type and entity_id = p_entity_id and status in ('open', 'under_review', 'proposed', 'reopened');
  return jsonb_build_object(
    'score', case when crit then least(40, 100 - pen) else 100 - pen end, 'score_version', 'dq-score/1',
    'evaluated', not exists (select 1 from public.data_quality_queue q where q.entity_type = p_entity_type and q.entity_id = p_entity_id),
    'issues', (select coalesce(jsonb_agg(to_jsonb(x) order by case x.severity when 'critical' then 0 when 'high' then 1 when 'warning' then 2 else 3 end, x.last_detected_at desc), '[]')
               from public.data_quality_issues x where x.organization_id = org and x.entity_type = p_entity_type and x.entity_id = p_entity_id
                 and x.status in ('open', 'under_review', 'proposed', 'reopened')),
    'provenance', (select coalesce(jsonb_agg(jsonb_build_object('field', f, 'source_type', fp.source_type, 'source_label', fp.source_label, 'captured_at', fp.captured_at,
        'verification_status', coalesce(fp.verification_status, 'unverified'), 'verified_at', fp.verified_at, 'previous_source_type', fp.previous_source_type,
        'change_count', fp.change_count, 'recorded', fp.field is not null) order by array_position(tracked, f)), '[]')
      from unnest(tracked) f left join public.field_provenance fp on fp.entity_type = p_entity_type and fp.entity_id = p_entity_id and fp.field = f),
    'duplicates', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'strength', d.strength, 'score', d.score, 'explanation', d.explanation,
        'other_id', case when d.record_a = p_entity_id then d.record_b else d.record_a end,
        'other_label', private.dq_entity_label(d.entity_type, case when d.record_a = p_entity_id then d.record_b else d.record_a end))), '[]')
      from public.duplicate_candidates d where d.organization_id = org and d.entity_type = p_entity_type and d.status = 'open' and (d.record_a = p_entity_id or d.record_b = p_entity_id)),
    'merges', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'status', m.status, 'role', case when m.canonical_id = p_entity_id then 'canonical' else 'merged' end,
        'merged_at', m.merged_at, 'other_label', private.dq_entity_label(m.entity_type, case when m.canonical_id = p_entity_id then m.merged_id else m.canonical_id end))
        order by m.merged_at desc), '[]')
      from public.record_merges m where m.organization_id = org and m.entity_type = p_entity_type and (m.canonical_id = p_entity_id or m.merged_id = p_entity_id)),
    'can_edit', public.has_perm(org, private.dq_entity_perm(p_entity_type)));
end;
$$;

-- Data quality context for Agent 08 (sales intelligence): how far the CRM can be trusted right now, with definitions.
create or replace function public.crm_data_quality_context(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  active text[] := array['open', 'under_review', 'proposed', 'reopened'];
  open_leads int;
begin
  if not public.has_perm(p_org, 'leads.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  select count(*) into open_leads from public.leads where organization_id = p_org and archived_at is null;
  return jsonb_build_object(
    'schema', 'crm-context/1', 'organization_id', p_org, 'generated_at', now(),
    'open_issues', (select jsonb_build_object('critical', count(*) filter (where severity = 'critical'), 'high', count(*) filter (where severity = 'high'),
        'warning', count(*) filter (where severity = 'warning'), 'info', count(*) filter (where severity = 'info'))
      from public.data_quality_issues where organization_id = p_org and status = any (active)),
    'unresolved_high_severity', exists (select 1 from public.data_quality_issues where organization_id = p_org and status = any (active) and severity in ('high', 'critical')),
    'by_entity', (select coalesce(jsonb_object_agg(entity_type, jsonb_build_object('records_with_high_or_critical', n_hc, 'records_with_any', n_any)), '{}')
      from (select entity_type, count(distinct entity_id) filter (where severity in ('high', 'critical')) n_hc, count(distinct entity_id) n_any
            from public.data_quality_issues where organization_id = p_org and status = any (active) group by entity_type) e),
    'duplicates', jsonb_build_object(
      'open_strong', (select count(*) from public.duplicate_candidates where organization_id = p_org and status = 'open' and strength = 'strong'),
      'open_possible', (select count(*) from public.duplicate_candidates where organization_id = p_org and status = 'open' and strength = 'possible'),
      'open_leads_possibly_duplicated', (select count(distinct l.id) from public.leads l where l.organization_id = p_org and l.archived_at is null and (
          exists (select 1 from public.duplicate_candidates d where d.organization_id = p_org and d.entity_type = 'lead' and d.status = 'open' and d.strength <> 'weak' and l.id in (d.record_a, d.record_b))
          or exists (select 1 from public.duplicate_candidates d where d.organization_id = p_org and d.entity_type = 'contact' and d.status = 'open' and d.strength <> 'weak' and l.contact_id in (d.record_a, d.record_b))))),
    'merged', jsonb_build_object(
      'contacts', (select count(*) from public.contacts where organization_id = p_org and merged_into is not null),
      'properties', (select count(*) from public.properties where organization_id = p_org and merged_into is not null),
      'leads', (select count(*) from public.leads where organization_id = p_org and metadata ? 'merged_into')),
    'coverage', jsonb_build_object('open_leads', open_leads,
      'with_budget_pct', (select round(100.0 * count(*) filter (where budget_max is not null) / nullif(count(*), 0), 1) from public.leads where organization_id = p_org and archived_at is null),
      'with_owner_pct', (select round(100.0 * count(*) filter (where assigned_to is not null) / nullif(count(*), 0), 1) from public.leads where organization_id = p_org and archived_at is null),
      'with_current_qualification_pct', (select round(100.0 * count(*) filter (where exists (select 1 from public.lead_qualifications q where q.lead_id = l.id and q.is_current)) / nullif(count(*), 0), 1)
                                         from public.leads l where l.organization_id = p_org and l.archived_at is null)),
    'freshness', jsonb_build_object(
      'last_completed_scan_at', (select max(completed_at) from public.data_quality_scans where organization_id = p_org and status in ('completed', 'partial')),
      'scan_in_progress', exists (select 1 from public.data_quality_scans where organization_id = p_org and status in ('requested', 'running')),
      'records_awaiting_evaluation', (select count(*) from public.data_quality_queue where organization_id = p_org and attempts < 5),
      'oldest_unevaluated_change', (select min(enqueued_at) from public.data_quality_queue where organization_id = p_org and attempts < 5)),
    'integrations', (select jsonb_build_object('connected', count(*) filter (where status = 'connected'), 'failing', count(*) filter (where status in ('error', 'needs_reauth')))
                     from public.integrations where organization_id = p_org),
    'definitions', jsonb_build_object(
      'canonical_contacts', 'contacts where merged_into is null',
      'canonical_properties', 'properties where merged_into is null and status <> archived',
      'open_leads', 'leads where archived_at is null (merged leads are archived with metadata.merged_into)',
      'issue_active_statuses', to_jsonb(active)),
    'limitations', jsonb_build_array(
      'Duplicate candidates are proposals until a person merges them; counts may include records that are really distinct.',
      'No external CRM, listing inventory or calendar provider is connected, so there is no synchronization to verify.',
      'Budgets are compared only within one currency; no exchange rates are applied.'));
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke all on function private.dq_default_rules(), private.dq_rules(uuid), private.dq_phone_check(text, text), private.dq_email_ok(text),
  private.dq_f(text, text, text, text, jsonb, text, jsonb),
  private.dq_event(uuid, text, text, uuid, uuid, jsonb, text), private.dq_alert(uuid, text, text, text, uuid, text),
  private.dq_upsert_issue(uuid, text, uuid, text, text, text, text, jsonb, text, jsonb, text, text, uuid), private.dq_resolve(public.data_quality_issues, text, text),
  private.dq_findings(text, uuid, jsonb), private.dq_state_hash(text, uuid, uuid), private.dq_signal_label(text),
  private.dq_upsert_candidate(uuid, text, uuid, uuid, int, jsonb, jsonb, uuid), private.dq_detect_duplicates(uuid, text, uuid),
  private.dq_process(uuid, text, uuid, uuid), private.dq_enqueue(uuid, text, uuid), private.dq_on_change(), private.dq_provenance(),
  private.dq_entity_perm(text), private.dq_merge_contact(uuid, uuid, uuid, uuid, text), private.dq_merge_property(uuid, uuid, uuid, uuid, text),
  private.dq_snapshot(uuid), private.dq_anomalies(uuid), private.dq_entity_label(text, uuid)
  from public, anon, authenticated;
revoke execute on function public.crm_data_tick(int) from public, anon, authenticated;
grant execute on function public.crm_data_tick(int) to service_role;
revoke execute on function public.duplicate_decide(uuid, text, uuid, text, text, text), public.record_merge_revert(uuid, text),
  public.dq_issue_action(uuid, text, text, uuid), public.dq_issue_apply_fix(uuid), public.dq_verify_field(text, uuid, text, boolean),
  public.dq_propose_enrichment(uuid, jsonb, text), public.data_quality_scan_request(uuid, text), public.data_quality_scan_cancel(uuid),
  public.data_quality_settings_save(uuid, jsonb), public.crm_data_quality_overview(uuid, timestamptz),
  public.dq_issues(uuid, text[], text[], text, text, uuid, timestamptz, uuid, int, int), public.dq_duplicates(uuid, text, text, text[], int, int),
  public.duplicate_candidate_detail(uuid), public.crm_record_quality(text, uuid), public.crm_data_quality_context(uuid) from public, anon;
grant execute on function public.duplicate_decide(uuid, text, uuid, text, text, text), public.record_merge_revert(uuid, text),
  public.dq_issue_action(uuid, text, text, uuid), public.dq_issue_apply_fix(uuid), public.dq_verify_field(text, uuid, text, boolean),
  public.dq_propose_enrichment(uuid, jsonb, text), public.data_quality_scan_request(uuid, text), public.data_quality_scan_cancel(uuid),
  public.data_quality_settings_save(uuid, jsonb), public.crm_data_quality_overview(uuid, timestamptz),
  public.dq_issues(uuid, text[], text[], text, text, uuid, timestamptz, uuid, int, int), public.dq_duplicates(uuid, text, text, text[], int, int),
  public.duplicate_candidate_detail(uuid), public.crm_record_quality(text, uuid), public.crm_data_quality_context(uuid) to authenticated;
grant execute on function public.crm_data_quality_context(uuid) to service_role;

-- ───────────────────────── schedule ─────────────────────────
-- crm-data-tick: pure SQL, every minute. Existing records are picked up by the first daily scheduled scan.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if not exists (select 1 from cron.job where jobname = 'crm-data-tick') then
      perform cron.schedule('crm-data-tick', '* * * * *', 'select public.crm_data_tick(1000)');
    end if;
  end if;
end;
$$;
