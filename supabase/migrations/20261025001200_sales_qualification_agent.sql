-- Estate OS · 0012 · Agent 03 — AI Sales & Qualification Agent (sales_qualification_agent)
-- Consumes lead.ready_for_qualification (Agent 01) and voice_call.completed (Agent 02) from the outbox, builds an
-- explainable qualification (requirements with provenance, missing/conflicting info, readiness score, status,
-- next action), keeps history, routes review to people, and emits lead.qualification.* events for Agent 04.
-- Lead requirement columns stay the CRM source of truth: this agent never writes them; only a person (review edits) does.
-- Additive only.

-- ───────────────────────── tables ─────────────────────────

-- Event names may have up to four dot-separated parts (e.g. lead.qualification.completed). Only widens the check.
alter table public.outbox_events drop constraint outbox_events_event_type_check;
alter table public.outbox_events add constraint outbox_events_event_type_check check (event_type ~ '^[a-z_]+(\.[a-z_]+){1,3}$');

create table public.qualification_settings (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  rules jsonb not null default '{}',
  version integer not null default 1,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger qualification_settings_updated_at before update on public.qualification_settings for each row execute function public.set_updated_at();
create trigger qualification_settings_audit after insert or update on public.qualification_settings for each row execute function private.audit_row();

create table public.lead_qualifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  lead_id uuid not null references public.leads (id) on delete cascade,
  run_id uuid references public.agent_runs (id) on delete set null,
  trigger text not null check (char_length(trigger) <= 60),
  status text not null check (status in ('unqualified', 'in_progress', 'needs_information', 'qualified', 'high_intent', 'nurture', 'human_review_required', 'disqualified')),
  -- Readiness for the next sales step, 0–100. Null = insufficient evidence for a meaningful score.
  score smallint check (score between 0 and 100),
  score_breakdown jsonb not null default '[]',
  -- Merged view: per field {value, certainty: confirmed|ai_extracted|stated|inferred, source}. Not written back to the lead.
  requirements jsonb not null default '{}',
  missing text[] not null default '{}',
  conflicts jsonb not null default '[]',
  questions jsonb not null default '[]',
  recommended_action text not null check (recommended_action in ('request_clarification', 'recommend_property_matching', 'request_human_review',
    'request_human_callback', 'continue_nurture', 'no_action', 'await_more_information')),
  human_review_required boolean not null default false,
  review_reasons text[] not null default '{}',
  review_status text not null default 'not_required' check (review_status in ('not_required', 'pending', 'approved', 'rejected', 'overridden')),
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (char_length(review_note) <= 1000),
  analysis_status text not null default 'not_requested' check (analysis_status in ('not_requested', 'succeeded', 'failed', 'skipped', 'not_configured')),
  model_meta jsonb,
  summary text check (char_length(summary) <= 1000),
  ruleset_version integer not null,
  is_current boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index lead_qualifications_current_uniq on public.lead_qualifications (lead_id) where is_current;
create index lead_qualifications_lead_idx on public.lead_qualifications (lead_id, created_at desc);
create index lead_qualifications_org_idx on public.lead_qualifications (organization_id, created_at desc);
create trigger lead_qualifications_org_immutable before update on public.lead_qualifications for each row execute function private.prevent_org_change();

-- Current qualification on the lead. Not in the client column grants, so only these functions write them.
alter table public.leads
  add column qualification_status text check (qualification_status in ('unqualified', 'in_progress', 'needs_information', 'qualified', 'high_intent', 'nurture', 'human_review_required', 'disqualified')),
  add column qualification_id uuid references public.lead_qualifications (id) on delete set null;

alter table public.qualification_settings enable row level security;
alter table public.lead_qualifications enable row level security;
create policy qualification_settings_read on public.qualification_settings for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy lead_qualifications_read on public.lead_qualifications for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
revoke all on public.qualification_settings, public.lead_qualifications from anon;
revoke insert, update, delete, truncate on public.qualification_settings, public.lead_qualifications from authenticated;

-- ───────────────────────── rules ─────────────────────────

create or replace function private.qual_default_rules()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{
    "weights": {"intent": 25, "requirements": 20, "budget": 15, "timeline": 15, "engagement": 15, "fit": 10},
    "required": {
      "buy": ["locations", "budget", "property_type", "timeline"],
      "rent": ["locations", "budget", "property_type", "timeline"],
      "sell": ["locations", "property_type", "timeline"],
      "let": ["locations", "property_type", "timeline"],
      "invest": ["locations", "budget", "timeline"]
    },
    "qualified_min_score": 60,
    "high_intent_min_score": 80,
    "scope": {"transactions": ["buy", "rent", "sell", "let", "invest"], "locations": [], "property_types": []},
    "max_questions": 3,
    "llm_enabled": true
  }'::jsonb;
$$;

-- Effective rules: defaults overlaid with the org's saved top-level keys; plus the ruleset version.
create or replace function private.qual_rules(org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.qual_default_rules() || coalesce(s.rules, '{}') || jsonb_build_object('version', coalesce(s.version, 0))
  from (select 1) x left join public.qualification_settings s on s.organization_id = org;
$$;

-- ───────────────────────── context & evaluation ─────────────────────────

-- Minimal, tenant-scoped context for one lead. Free text is not included here (only the LLM step reads it).
create or replace function private.qual_context(p_lead uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l public.leads;
  c public.contacts;
  call public.voice_calls;
  ai text[];
begin
  select * into l from public.leads where id = p_lead;
  select * into c from public.contacts where id = l.contact_id;
  select * into call from public.voice_calls v
  where v.lead_id = l.id and v.organization_id = l.organization_id and v.finalized_at is not null and v.status = 'completed'
  order by v.ended_at desc nulls last limit 1;
  ai := l.ai_extracted_fields;
  return jsonb_build_object(
    'lead_id', l.id, 'organization_id', l.organization_id, 'status', l.status, 'archived', l.archived_at is not null,
    'intent', case when coalesce(l.metadata -> 'intake' -> 'missing', '[]') ? 'intent' then null else l.desired_transaction end,
    'intent_ai', 'intent' = any (ai),
    'locations', to_jsonb(l.desired_locations), 'locations_ai', 'locations' = any (ai),
    'budget_min', l.budget_min, 'budget_max', l.budget_max, 'currency', l.budget_currency, 'budget_ai', 'budget' = any (ai),
    'property_type', l.desired_property_type, 'property_type_ai', 'propertyType' = any (ai),
    'bedrooms', l.bedrooms, 'bedrooms_ai', 'bedrooms' = any (ai),
    'timeline', l.timeline, 'timeline_ai', 'timeline' = any (ai),
    'do_not_contact', c.lifecycle_status = 'do_not_contact',
    'phone_revoked', exists (select 1 from public.communication_consents cc where cc.contact_id = c.id and cc.channel = 'phone' and cc.status in ('revoked', 'denied')),
    'call', case when call.id is null then null else jsonb_build_object('id', call.id, 'outcome', call.outcome, 'analysis', call.analysis,
      'handoff', call.human_handoff_status, 'call_outcome', call.analysis ->> 'call_outcome') end,
    'engagement', jsonb_build_object(
      'connected_calls', (select count(*) from public.voice_calls v where v.lead_id = l.id and v.status = 'completed'),
      'appointments', (select count(*) from public.appointments a where a.lead_id = l.id and a.status not in ('cancelled')),
      'repeat_enquiries', greatest(coalesce((l.metadata ->> 'enquiry_count')::int, 1) - 1, 0),
      'human_contacts', (select count(*) from public.activities a where a.lead_id = l.id and a.activity_type in ('call', 'message') and a.source = 'user')));
end;
$$;

-- The deterministic engine. Inputs: context, proposals {field: {value, certainty, source}} (model or call), rules.
-- Output: requirements with provenance, missing, conflicts, score + breakdown, status, action, review reasons, questions.
create or replace function private.qual_evaluate(ctx jsonb, proposals jsonb, rules jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  req jsonb := '{}';
  conflicts jsonb := '[]';
  missing text[] := '{}';
  reasons text[] := '{}';
  f text;
  crm jsonb;
  prop jsonb;
  intent text;
  required text[];
  w jsonb := rules -> 'weights';
  dims jsonb := '[]';
  num numeric := 0;
  den numeric := 0;
  v numeric;
  cert_factor numeric;
  present int;
  eng jsonb := ctx -> 'engagement';
  engv numeric;
  fit numeric;
  near boolean;
  score int;
  status text;
  action text;
  questions jsonb := '[]';
  q text;
  scope jsonb := rules -> 'scope';
  locs text[];
  known_dims int;
  call_conf jsonb;
begin
  -- 1. Merge CRM values (authoritative) with proposals (only fill gaps; differences become conflicts).
  foreach f in array array['intent', 'locations', 'budget', 'property_type', 'bedrooms', 'timeline'] loop
    crm := case f
      when 'intent' then case when ctx ->> 'intent' is not null then jsonb_build_object('value', ctx ->> 'intent', 'certainty', case when (ctx ->> 'intent_ai')::boolean then 'ai_extracted' else 'confirmed' end, 'source', 'crm') end
      when 'locations' then case when jsonb_array_length(ctx -> 'locations') > 0 then jsonb_build_object('value', ctx -> 'locations', 'certainty', case when (ctx ->> 'locations_ai')::boolean then 'ai_extracted' else 'confirmed' end, 'source', 'crm') end
      when 'budget' then case when ctx ->> 'budget_max' is not null or ctx ->> 'budget_min' is not null then jsonb_build_object('value', jsonb_build_object('min', ctx -> 'budget_min', 'max', ctx -> 'budget_max', 'currency', ctx ->> 'currency'), 'certainty', case when (ctx ->> 'budget_ai')::boolean then 'ai_extracted' else 'confirmed' end, 'source', 'crm') end
      else case when ctx ->> f is not null then jsonb_build_object('value', ctx -> f, 'certainty', case when (ctx ->> (f || '_ai'))::boolean then 'ai_extracted' else 'confirmed' end, 'source', 'crm') end
    end;
    prop := proposals -> f;
    if prop is not null and jsonb_typeof(prop -> 'value') = 'null' then prop := null; end if;
    if crm is not null then
      req := req || jsonb_build_object(f, crm);
      if prop is not null and (
           (f = 'locations' and not (select bool_and(lower(p) = any (select lower(x) from jsonb_array_elements_text(crm -> 'value') x)) from jsonb_array_elements_text(prop -> 'value') p))
        or (f = 'budget' and ((prop -> 'value' ->> 'max') is not null and (crm -> 'value' ->> 'max') is not null and (prop -> 'value' ->> 'max')::numeric <> (crm -> 'value' ->> 'max')::numeric
                              or (prop -> 'value' ->> 'currency') is distinct from (crm -> 'value' ->> 'currency') and (prop -> 'value' ->> 'max') is not null))
        or (f not in ('locations', 'budget') and (prop -> 'value') <> (crm -> 'value'))) then
        conflicts := conflicts || jsonb_build_array(jsonb_build_object('field', f, 'crm', crm -> 'value', 'proposed', prop -> 'value', 'source', prop ->> 'source'));
      end if;
    elsif prop is not null then
      req := req || jsonb_build_object(f, prop);
    end if;
  end loop;
  -- Conflicts the call analysis already found against the CRM (Agent 02).
  for call_conf in select jsonb_build_object('field', x, 'source', 'call:' || (ctx -> 'call' ->> 'id'), 'note', 'Differs from CRM on the last call')
                   from jsonb_array_elements_text(coalesce(ctx -> 'call' -> 'analysis' -> 'conflicts', '[]')) x loop
    if not exists (select 1 from jsonb_array_elements(conflicts) e where e ->> 'field' = call_conf ->> 'field') then
      conflicts := conflicts || jsonb_build_array(call_conf);
    end if;
  end loop;
  for call_conf in select x from jsonb_array_elements(coalesce(proposals -> 'contradictions', '[]')) x loop
    conflicts := conflicts || jsonb_build_array(jsonb_build_object('field', left(call_conf ->> 'field', 40), 'note', left(call_conf ->> 'note', 200), 'source', 'analysis'));
  end loop;

  -- 2. Missing required information for the intent.
  intent := req -> 'intent' ->> 'value';
  required := case when intent is null then array['intent', 'locations', 'budget', 'property_type', 'timeline']
                   else array(select jsonb_array_elements_text(coalesce(rules -> 'required' -> intent, '[]'))) end;
  missing := array(select x from unnest(required) x where not (req ? x));

  -- 3. Readiness score (only dimensions that apply to the intent).
  cert_factor := case req -> 'intent' ->> 'certainty' when 'confirmed' then 1 when 'ai_extracted' then 0.8 when 'stated' then 0.8 when 'inferred' then 0.5 else 0 end;
  dims := dims || jsonb_build_array(jsonb_build_object('key', 'intent', 'label', 'Intent clarity', 'weight', (w ->> 'intent')::numeric, 'value', cert_factor,
    'evidence', case when intent is null then 'Intent not stated' else format('%s (%s, %s)', intent, req -> 'intent' ->> 'certainty', req -> 'intent' ->> 'source') end));

  present := 0; v := 0;
  foreach f in array array(select x from unnest(required) x where x in ('locations', 'property_type', 'bedrooms')) loop
    present := present + 1;
    if req ? f then v := v + case when req -> f ->> 'certainty' = 'inferred' then 0.5 else 1 end; end if;
  end loop;
  if present > 0 then
    dims := dims || jsonb_build_array(jsonb_build_object('key', 'requirements', 'label', 'Requirement completeness', 'weight', (w ->> 'requirements')::numeric,
      'value', round(v / present, 2), 'evidence', format('%s of %s requirement fields known', (select count(*) from unnest(required) x where x in ('locations', 'property_type', 'bedrooms') and req ? x), present)));
  end if;

  if 'budget' = any (required) then
    v := case when not (req ? 'budget') then 0
              when (req -> 'budget' -> 'value' ->> 'max') is not null then 1 else 0.6 end
         * case when req -> 'budget' ->> 'certainty' = 'inferred' then 0.5 else 1 end;
    dims := dims || jsonb_build_array(jsonb_build_object('key', 'budget', 'label', 'Budget clarity', 'weight', (w ->> 'budget')::numeric, 'value', v,
      'evidence', case when req ? 'budget' then format('%s %s (%s)', req -> 'budget' -> 'value' ->> 'currency', coalesce(req -> 'budget' -> 'value' ->> 'max', req -> 'budget' -> 'value' ->> 'min'), req -> 'budget' ->> 'certainty') else 'Budget not stated' end));
  end if;

  near := coalesce(req -> 'timeline' ->> 'value', '') in ('Immediate', '1 month', '0-3 months');
  if 'timeline' = any (required) then
    v := case when not (req ? 'timeline') then 0 when near then 1 else 0.8 end * case when req -> 'timeline' ->> 'certainty' = 'inferred' then 0.5 else 1 end;
    dims := dims || jsonb_build_array(jsonb_build_object('key', 'timeline', 'label', 'Timeline clarity', 'weight', (w ->> 'timeline')::numeric, 'value', v,
      'evidence', coalesce(req -> 'timeline' ->> 'value', 'Timeline not stated')));
  end if;

  -- Engagement only adds; an unanswered call never subtracts.
  engv := least(1, 0.6 * coalesce((eng ->> 'connected_calls')::numeric, 0) + 0.6 * coalesce((eng ->> 'appointments')::numeric, 0)
                 + 0.4 * least(coalesce((eng ->> 'repeat_enquiries')::numeric, 0), 1) + 0.3 * coalesce((eng ->> 'human_contacts')::numeric, 0));
  dims := dims || jsonb_build_array(jsonb_build_object('key', 'engagement', 'label', 'Engagement evidence', 'weight', (w ->> 'engagement')::numeric, 'value', round(engv, 2),
    'evidence', format('%s connected call(s), %s appointment(s), %s repeat enquiry(ies), %s logged contact(s)', eng ->> 'connected_calls', eng ->> 'appointments', eng ->> 'repeat_enquiries', eng ->> 'human_contacts')));

  locs := array(select lower(x) from jsonb_array_elements_text(coalesce(req -> 'locations' -> 'value', '[]')) x);
  fit := least(
    case when intent is null then 0.5 when scope -> 'transactions' ? intent then 1 else 0 end,
    case when jsonb_array_length(coalesce(scope -> 'locations', '[]')) = 0 then 1 when cardinality(locs) = 0 then 0.5
         when exists (select 1 from jsonb_array_elements_text(scope -> 'locations') s where lower(s) = any (locs)) then 1 else 0 end,
    case when jsonb_array_length(coalesce(scope -> 'property_types', '[]')) = 0 then 1 when not (req ? 'property_type') then 0.5
         when scope -> 'property_types' ? (req -> 'property_type' ->> 'value') then 1 else 0 end);
  dims := dims || jsonb_build_array(jsonb_build_object('key', 'fit', 'label', 'Fit with agency services', 'weight', (w ->> 'fit')::numeric, 'value', fit,
    'evidence', case when fit = 0 then 'Outside the configured service scope' when fit < 1 then 'Not enough information to check scope' else 'Within configured scope' end));

  select sum((d ->> 'weight')::numeric * (d ->> 'value')::numeric), sum((d ->> 'weight')::numeric) into num, den from jsonb_array_elements(dims) d;
  select count(*) into known_dims from jsonb_array_elements(dims) d where d ->> 'key' in ('requirements', 'budget', 'timeline') and (d ->> 'value')::numeric > 0;
  score := case when den > 0 and not (intent is null and known_dims < 2) then round(100 * num / den)::int end;
  dims := (select coalesce(jsonb_agg(d || jsonb_build_object('points', case when den > 0 then round(100 * (d ->> 'weight')::numeric * (d ->> 'value')::numeric / den, 1) end)), '[]') from jsonb_array_elements(dims) d);

  -- 4. Review reasons (never decided by the model).
  if exists (select 1 from jsonb_array_elements(conflicts) e where e ->> 'field' in ('intent', 'budget', 'locations', 'property_type')) then reasons := reasons || 'conflicting_information'::text; end if;
  if ctx -> 'call' ->> 'call_outcome' = 'not_interested' then reasons := reasons || 'possible_withdrawal'::text; end if;
  if ctx -> 'call' ->> 'call_outcome' = 'wrong_number' then reasons := reasons || 'possible_wrong_number'::text; end if;
  if fit = 0 then reasons := reasons || 'outside_service_scope'::text; end if;
  if req -> 'intent' ->> 'certainty' = 'inferred' then reasons := reasons || 'low_confidence_intent'::text; end if;

  -- 5. Status and next action.
  if cardinality(reasons) > 0 then
    status := 'human_review_required'; action := 'request_human_review';
  elsif cardinality(missing) > 0 or score is null then
    status := 'needs_information'; action := case when (ctx ->> 'do_not_contact')::boolean then 'no_action' else 'request_clarification' end;
  elsif score >= coalesce((rules ->> 'high_intent_min_score')::int, 80) and near and engv > 0 then
    status := 'high_intent'; action := 'recommend_property_matching';
  elsif score >= coalesce((rules ->> 'qualified_min_score')::int, 60) then
    status := 'qualified'; action := 'recommend_property_matching';
  else
    status := 'nurture'; action := case when (ctx ->> 'do_not_contact')::boolean then 'no_action' else 'continue_nurture' end;
  end if;
  if ctx -> 'call' ->> 'handoff' is not null and status not in ('qualified', 'high_intent', 'human_review_required') then action := 'request_human_callback'; end if;

  -- 6. Smallest useful set of questions: missing fields first, then conflicts. Model wording only for those fields.
  foreach f in array missing loop
    exit when jsonb_array_length(questions) >= coalesce((rules ->> 'max_questions')::int, 3);
    q := coalesce((select left(x ->> 'question', 200) from jsonb_array_elements(coalesce(proposals -> 'questions', '[]')) x where x ->> 'field' = f limit 1),
      case f
        when 'intent' then 'Are you looking to buy, rent, sell or invest?'
        when 'locations' then 'Which areas would you prefer?'
        when 'budget' then case when intent = 'rent' then 'What monthly rent are you comfortable with?' else 'What approximate budget do you have in mind?' end
        when 'property_type' then case when intent in ('sell', 'let') then 'What type of property is it?' else 'What type of property are you looking for (apartment, villa, plot…)?' end
        when 'bedrooms' then 'How many bedrooms do you need?'
        when 'timeline' then case intent when 'rent' then 'When would you like to move in?' when 'sell' then 'When would you like to sell?' when 'let' then 'When is the property available?' else 'When are you hoping to buy?' end
      end);
    questions := questions || jsonb_build_array(jsonb_build_object('field', f, 'question', q));
  end loop;
  for call_conf in select e from jsonb_array_elements(conflicts) e loop
    exit when jsonb_array_length(questions) >= coalesce((rules ->> 'max_questions')::int, 3);
    if call_conf ->> 'field' in ('budget', 'locations', 'property_type', 'bedrooms', 'timeline', 'intent') then
      questions := questions || jsonb_build_array(jsonb_build_object('field', call_conf ->> 'field', 'question',
        format('Please confirm the %s: our records and the latest conversation differ.', replace(call_conf ->> 'field', '_', ' '))));
    end if;
  end loop;

  return jsonb_build_object('requirements', req, 'missing', to_jsonb(missing), 'conflicts', conflicts, 'score', score, 'breakdown', dims,
    'status', status, 'action', action, 'review_reasons', to_jsonb(reasons), 'questions', questions);
end;
$$;

-- Call analysis (Agent 02, already evidence-checked) → proposals.
create or replace function private.qual_call_proposals(ctx jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when a is null then '{}'::jsonb else jsonb_strip_nulls(jsonb_build_object(
    'intent', case when a ->> 'intent' is not null then jsonb_build_object('value', a ->> 'intent', 'certainty', 'stated', 'source', s) end,
    'locations', case when jsonb_array_length(coalesce(a -> 'preferred_locations', '[]')) > 0 then jsonb_build_object('value', a -> 'preferred_locations', 'certainty', 'stated', 'source', s) end,
    'budget', case when a ->> 'budget_max' is not null or a ->> 'budget_min' is not null then jsonb_build_object('value', jsonb_build_object('min', a -> 'budget_min', 'max', a -> 'budget_max', 'currency', a ->> 'currency'), 'certainty', 'stated', 'source', s) end,
    'property_type', case when a ->> 'property_type' is not null then jsonb_build_object('value', a -> 'property_type', 'certainty', 'stated', 'source', s) end,
    'bedrooms', case when a ->> 'bedrooms' is not null then jsonb_build_object('value', a -> 'bedrooms', 'certainty', 'stated', 'source', s) end,
    'timeline', case when a ->> 'timeline' is not null then jsonb_build_object('value', a -> 'timeline', 'certainty', 'stated', 'source', s) end)) end
  from (select ctx -> 'call' -> 'analysis' a, 'call:' || (ctx -> 'call' ->> 'id') s) x;
$$;

-- ───────────────────────── runs ─────────────────────────

create or replace function private.qual_enqueue(org uuid, p_lead uuid, p_trigger text, p_key text, p_kind text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  rules jsonb := private.qual_rules(org);
  has_text boolean;
begin
  select (l.summary is not null)
      or exists (select 1 from public.voice_calls v where v.lead_id = l.id and v.summary is not null)
      or exists (select 1 from public.activities a where a.lead_id = l.id and a.activity_type = 'note' and a.source = 'user' and a.description is not null)
    into has_text from public.leads l where l.id = p_lead and l.organization_id = org;
  if has_text is null then return null; end if;
  insert into public.agent_runs (organization_id, agent_id, agent_version, trigger_event, source_kind, provider, idempotency_key, lead_id, input, correlation_id)
  values (org, 'sales_qualification_agent', '1.0.0', p_trigger, p_kind, 'os', p_key, p_lead,
    jsonb_build_object('lead_id', p_lead, 'needs_analysis', coalesce((rules ->> 'llm_enabled')::boolean, true) and has_text),
    coalesce((select correlation_id from public.agent_runs where organization_id = org and lead_id = p_lead and agent_id = 'lead_intake_agent' order by received_at desc limit 1), gen_random_uuid()))
  on conflict (organization_id, agent_id, idempotency_key) do nothing
  returning id into rid;
  if rid is null then
    select id into rid from public.agent_runs where organization_id = org and agent_id = 'sales_qualification_agent' and idempotency_key = p_key;
  else
    update public.leads set qualification_status = case when qualification_status is null then 'in_progress' else qualification_status end where id = p_lead;
  end if;
  return rid;
end;
$$;

-- One evaluation inside a sub-transaction. Writes the qualification, lead pointer, activity, tasks and events.
create or replace function private.qual_execute(r public.agent_runs)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.leads;
  ctx jsonb;
  rules jsonb;
  props jsonb;
  ext jsonb := r.extraction;
  res jsonb;
  qid uuid;
  owner uuid;
  who text;
  st text;
  ev_payload jsonb;
begin
  select * into l from public.leads where id = r.lead_id and organization_id = r.organization_id;
  if l.id is null then return jsonb_build_object('status', 'skipped', 'reason', 'lead_not_found'); end if;
  if l.archived_at is not null or l.status in ('won', 'lost') then return jsonb_build_object('status', 'skipped', 'reason', 'lead_closed'); end if;
  perform pg_advisory_xact_lock(hashtextextended('qualify:' || l.id::text, 0));

  ctx := private.qual_context(l.id);
  rules := private.qual_rules(l.organization_id);
  -- Model proposals win over call proposals only for fields the model actually supported with evidence.
  props := private.qual_call_proposals(ctx) || coalesce(ext -> 'fields', '{}')
           || jsonb_build_object('questions', coalesce(ext -> 'questions', '[]'), 'contradictions', coalesce(ext -> 'contradictions', '[]'));
  res := private.qual_evaluate(ctx, props, rules);
  perform private.run_step(r, 'evaluate', 'ok', jsonb_build_object('status', res ->> 'status', 'score', res -> 'score', 'missing', res -> 'missing'));

  update public.lead_qualifications set is_current = false where lead_id = l.id and is_current;
  insert into public.lead_qualifications (organization_id, lead_id, run_id, trigger, status, score, score_breakdown, requirements, missing, conflicts, questions,
    recommended_action, human_review_required, review_reasons, review_status, analysis_status, model_meta, summary, ruleset_version)
  values (l.organization_id, l.id, r.id, r.trigger_event, res ->> 'status', (res ->> 'score')::smallint, res -> 'breakdown', res -> 'requirements',
    array(select jsonb_array_elements_text(res -> 'missing')), res -> 'conflicts', res -> 'questions', res ->> 'action',
    res ->> 'status' = 'human_review_required', array(select jsonb_array_elements_text(res -> 'review_reasons')),
    case when res ->> 'status' = 'human_review_required' then 'pending' else 'not_required' end,
    case when not coalesce((r.input ->> 'needs_analysis')::boolean, false) then 'not_requested'
         when ext is not null then 'succeeded'
         when r.model_meta ->> 'outcome' = 'not_configured' then 'not_configured'
         when r.model_meta is not null then 'failed' else 'skipped' end,
    r.model_meta, left(ext ->> 'summary', 1000), coalesce((rules ->> 'version')::int, 0))
  returning id into qid;

  st := res ->> 'status';
  update public.leads set qualification_status = st, qualification_id = qid,
    status = case when st in ('qualified', 'high_intent') and status in ('new', 'attempting', 'contacted') then 'qualified' else status end
  where id = l.id;

  insert into public.activities (organization_id, lead_id, contact_id, activity_type, title, description, source, actor_name, metadata)
  values (l.organization_id, l.id, l.contact_id, 'workflow',
    'Qualification: ' || replace(st, '_', ' ') || coalesce(' · readiness ' || (res ->> 'score'), ''),
    concat_ws(' · ', case when jsonb_array_length(res -> 'missing') > 0 then 'Missing: ' || (select string_agg(replace(x, '_', ' '), ', ') from jsonb_array_elements_text(res -> 'missing') x) end,
      case when jsonb_array_length(res -> 'conflicts') > 0 then 'Conflicts: ' || (select string_agg(distinct replace(e ->> 'field', '_', ' '), ', ') from jsonb_array_elements(res -> 'conflicts') e) end,
      'Next: ' || replace(res ->> 'action', '_', ' ')),
    'ai', 'Sales & Qualification Agent', jsonb_build_object('qualification_id', qid, 'run_id', r.id, 'agent', 'sales_qualification_agent'));

  -- Work for people. One open task of each kind per lead; never a message to the customer.
  owner := case when private.intake_eligible(l.organization_id, l.assigned_to) then l.assigned_to end;
  select display_name into who from public.contacts where id = l.contact_id;
  if res ->> 'action' = 'request_clarification' and not exists (
       select 1 from public.tasks t where t.related_lead_id = l.id and t.status in ('open', 'in_progress') and t.title like 'Clarify requirements%') then
    insert into public.tasks (organization_id, title, description, priority, due_at, assigned_to, related_lead_id, source)
    values (l.organization_id, left('Clarify requirements: ' || coalesce(who, 'lead'), 200),
      'Suggested questions (do not send automatically):' || chr(10) || (select string_agg('• ' || (x ->> 'question'), chr(10)) from jsonb_array_elements(res -> 'questions') x),
      'normal', now() + interval '1 day', owner, l.id, 'ai');
  end if;
  if st = 'human_review_required' and not exists (
       select 1 from public.tasks t where t.related_lead_id = l.id and t.status in ('open', 'in_progress') and t.title like 'Review qualification%') then
    insert into public.tasks (organization_id, title, description, priority, due_at, assigned_to, related_lead_id, source)
    values (l.organization_id, left('Review qualification: ' || coalesce(who, 'lead'), 200),
      'Reasons: ' || (select string_agg(replace(x, '_', ' '), ', ') from jsonb_array_elements_text(res -> 'review_reasons') x), 'high', now() + interval '4 hours', owner, l.id, 'ai');
  end if;

  ev_payload := jsonb_build_object('schema_version', 1, 'organization_id', l.organization_id, 'lead_id', l.id, 'qualification_id', qid, 'agent_run_id', r.id,
    'correlation_id', r.correlation_id, 'occurred_at', now(), 'status', st, 'recommended_action', res ->> 'action');
  if st in ('qualified', 'high_intent') then
    -- Same requirements → same key → Agent 04 is not re-triggered for an unchanged qualification.
    perform private.emit_event(l.organization_id, 'lead.qualification.completed', 'lead', l.id, r.correlation_id,
      ev_payload || jsonb_build_object('event_type', 'lead.qualification.completed'), 'property_matching_agent',
      'qualification_completed:' || l.id::text || ':' || md5((res -> 'requirements')::text || st));
  elsif st = 'needs_information' then
    perform private.emit_event(l.organization_id, 'lead.qualification.needs_information', 'lead', l.id, r.correlation_id,
      ev_payload || jsonb_build_object('event_type', 'lead.qualification.needs_information'), null, 'qualification_needs_info:' || qid::text);
  elsif st = 'human_review_required' then
    perform private.emit_event(l.organization_id, 'lead.qualification.human_review_required', 'lead', l.id, r.correlation_id,
      ev_payload || jsonb_build_object('event_type', 'lead.qualification.human_review_required'), null, 'qualification_review:' || qid::text);
  end if;
  perform private.run_step(r, 'persist', 'ok', jsonb_build_object('qualification_id', qid, 'action', res ->> 'action'));
  return jsonb_build_object('status', st, 'qualification_id', qid, 'score', res -> 'score', 'action', res ->> 'action');
end;
$$;

create or replace function public.qualification_process(p_run uuid)
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
  select * into r from public.agent_runs where id = p_run and agent_id = 'sales_qualification_agent' for update;
  if r.id is null then perform private.fail('NOT_FOUND', 'Run not found'); end if;
  if r.status not in ('received', 'retry_scheduled') then
    return jsonb_build_object('status', r.status, 'run_id', r.id, 'replayed', true, 'qualification_id', r.outcome ->> 'qualification_id');
  end if;
  -- A newer pending run for the same lead will see everything this one would: skip this one.
  if exists (select 1 from public.agent_runs n where n.organization_id = r.organization_id and n.agent_id = r.agent_id and n.lead_id = r.lead_id
               and n.status in ('received', 'retry_scheduled') and n.received_at > r.received_at) then
    update public.agent_runs set status = 'succeeded', outcome = jsonb_build_object('action', 'superseded'), completed_at = now() where id = r.id;
    return jsonb_build_object('status', 'superseded', 'run_id', r.id);
  end if;
  update public.agent_runs set attempt_count = attempt_count + 1, started_at = coalesce(started_at, now()) where id = r.id returning * into r;
  begin
    res := private.qual_execute(r);
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
  update public.agent_runs set
    status = case when res ->> 'status' = 'human_review_required' then 'review_required' else 'succeeded' end,
    outcome = res, completed_at = now(), next_attempt_at = null, error_category = null, error_message = null,
    duration_ms = (extract(epoch from clock_timestamp() - t0) * 1000)::int
  where id = r.id;
  return res || jsonb_build_object('run_id', r.id);
end;
$$;

-- Outbox consumer + processing of runs that are ready (no LLM needed, LLM step attached, or LLM step timed out).
create or replace function public.qualification_tick(p_limit int default 25)
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
begin
  for e in select * from public.outbox_claim('sales_qualification_agent', array['lead.ready_for_qualification', 'voice_call.completed'], 50) loop
    lid := case when (e.payload ->> 'lead_id') ~ '^[0-9a-f-]{36}$' then (e.payload ->> 'lead_id')::uuid end;
    -- The event's org is trusted (outbox rows are written only by SQL); the lead must belong to it.
    if lid is not null and exists (select 1 from public.leads where id = lid and organization_id = e.organization_id) then
      perform private.qual_enqueue(e.organization_id, lid, e.event_type, 'evt:' || e.id::text, 'integration');
    end if;
    perform public.outbox_ack(e.id, 'sales_qualification_agent', true);
    consumed := consumed + 1;
  end loop;

  for rid in
    select ar.id from public.agent_runs ar
    where ar.agent_id = 'sales_qualification_agent' and ar.status in ('received', 'retry_scheduled')
      and (ar.next_attempt_at is null or ar.next_attempt_at <= now())
      and (not coalesce((ar.input ->> 'needs_analysis')::boolean, false) or ar.extraction is not null or ar.model_meta is not null
           or ar.received_at < now() - interval '10 minutes')
    order by ar.received_at
    limit least(greatest(p_limit, 1), 200)
    for update skip locked
  loop
    perform public.qualification_process(rid);
    processed := processed + 1;
  end loop;
  return jsonb_build_object('consumed', consumed, 'processed', processed);
end;
$$;

-- ───────────────────────── Claude step (service role) ─────────────────────────

-- Runs waiting for the model, with the minimum text: inquiry, last call summaries, last staff notes. No names or numbers.
create or replace function public.qualification_analysis_claim(p_limit int default 5)
returns table (run_id uuid, sources jsonb, known jsonb, currency text, country text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with picked as (
    select ar.id from public.agent_runs ar
    where ar.agent_id = 'sales_qualification_agent' and ar.status = 'received' and coalesce((ar.input ->> 'needs_analysis')::boolean, false)
      and ar.extraction is null and ar.model_meta is null and (ar.next_attempt_at is null or ar.next_attempt_at <= now())
      and ar.received_at > now() - interval '10 minutes'
    order by ar.received_at limit least(greatest(p_limit, 1), 20)
    for update skip locked
  ), leased as (
    update public.agent_runs ar set next_attempt_at = now() + interval '3 minutes' from picked where ar.id = picked.id
    returning ar.id, ar.organization_id, ar.lead_id
  )
  select leased.id,
    (select coalesce(jsonb_agg(s), '[]') from (
       select jsonb_build_object('id', 'inquiry', 'text', left(l.summary, 1500)) s where l.summary is not null
       union all
       select * from (select jsonb_build_object('id', 'call:' || v.id, 'text', left(v.summary, 1000)) from public.voice_calls v
         where v.lead_id = l.id and v.summary is not null order by v.ended_at desc nulls last limit 3) c
       union all
       select * from (select jsonb_build_object('id', 'note:' || a.id, 'text', left(a.description, 1000)) from public.activities a
         where a.lead_id = l.id and a.activity_type = 'note' and a.source = 'user' and a.description is not null order by a.occurred_at desc limit 3) n) z),
    jsonb_strip_nulls(jsonb_build_object('intent', case when coalesce(l.metadata -> 'intake' -> 'missing', '[]') ? 'intent' then null else l.desired_transaction end,
      'locations', case when cardinality(l.desired_locations) > 0 then to_jsonb(l.desired_locations) end, 'budget_max', l.budget_max, 'property_type', l.desired_property_type,
      'bedrooms', l.bedrooms, 'timeline', l.timeline)),
    o.default_currency::text, o.country_code::text
  from leased join public.leads l on l.id = leased.lead_id and l.organization_id = leased.organization_id
  join public.organizations o on o.id = leased.organization_id;
end;
$$;

-- Stores a validated model proposal (normalized again here), or only its failure metadata, then processing can proceed.
create or replace function public.qualification_attach_analysis(p_run uuid, p_result jsonb, p_meta jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.agent_runs;
  o public.organizations;
  meta jsonb;
  n jsonb;
  fields jsonb := '{}';
  f text;
  item jsonb;
  src text;
  valid_sources text[];
begin
  select * into r from public.agent_runs where id = p_run and agent_id = 'sales_qualification_agent' for update;
  if r.id is null then perform private.fail('NOT_FOUND', 'Run not found'); end if;
  if r.status <> 'received' or r.extraction is not null or r.model_meta is not null then return; end if;
  meta := (select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each(case when jsonb_typeof(p_meta) = 'object' then p_meta else '{}' end)
           where key in ('model', 'prompt_version', 'latency_ms', 'input_tokens', 'output_tokens', 'outcome') and jsonb_typeof(value) in ('string', 'number'));
  if p_result is null or jsonb_typeof(p_result) <> 'object' or octet_length(p_result::text) > 16384 then
    update public.agent_runs set model_meta = meta || case when p_result is null then '{}'::jsonb else '{"outcome": "invalid_output"}'::jsonb end, next_attempt_at = null where id = r.id;
    perform private.run_step(r, 'analysis', 'skipped', jsonb_build_object('outcome', meta ->> 'outcome'));
    return;
  end if;

  -- Sources the model may cite: only this lead's inquiry, calls and notes.
  valid_sources := array['inquiry']
    || array(select 'call:' || v.id from public.voice_calls v where v.lead_id = r.lead_id and v.organization_id = r.organization_id)
    || array(select 'note:' || a.id from public.activities a where a.lead_id = r.lead_id and a.organization_id = r.organization_id and a.activity_type = 'note');
  select * into o from public.organizations where id = r.organization_id;
  -- Same normalization as intake (enums, ranges, budget order, currency).
  n := private.intake_normalize(jsonb_strip_nulls(jsonb_build_object('email', 'x@x.invalid',
         'intent', p_result -> 'intent' ->> 'value', 'locations', p_result -> 'locations' -> 'values',
         'budget_min', p_result -> 'budget' -> 'min', 'budget_max', p_result -> 'budget' -> 'max', 'currency', p_result -> 'budget' ->> 'currency',
         'property_type', p_result -> 'property_type' ->> 'value', 'bedrooms', p_result -> 'bedrooms' -> 'value', 'timeline', p_result -> 'timeline' ->> 'value')),
       o.country_code, o.default_currency, 'Qualification');
  foreach f in array array['intent', 'locations', 'budget', 'property_type', 'bedrooms', 'timeline'] loop
    item := p_result -> f;
    src := item ->> 'source';
    continue when item is null or jsonb_typeof(item) <> 'object' or not (src = any (valid_sources)) or coalesce(item ->> 'certainty', '') not in ('stated', 'inferred');
    if f = 'intent' and n ->> 'intent' is not null and p_result -> 'intent' ->> 'value' is not null then
      fields := fields || jsonb_build_object(f, jsonb_build_object('value', n ->> 'intent', 'certainty', item ->> 'certainty', 'source', src));
    elsif f = 'locations' and jsonb_array_length(n -> 'locations') > 0 then
      fields := fields || jsonb_build_object(f, jsonb_build_object('value', n -> 'locations', 'certainty', item ->> 'certainty', 'source', src));
    elsif f = 'budget' and (n ->> 'budget_max' is not null or n ->> 'budget_min' is not null) and p_result -> 'budget' ->> 'currency' is not null then
      fields := fields || jsonb_build_object(f, jsonb_build_object('value', jsonb_build_object('min', n -> 'budget_min', 'max', n -> 'budget_max', 'currency', n ->> 'currency'), 'certainty', item ->> 'certainty', 'source', src));
    elsif f in ('property_type', 'bedrooms', 'timeline') and n ->> f is not null then
      fields := fields || jsonb_build_object(f, jsonb_build_object('value', n -> f, 'certainty', item ->> 'certainty', 'source', src));
    end if;
  end loop;
  update public.agent_runs set next_attempt_at = null, model_meta = meta, extraction = jsonb_build_object(
    'fields', fields,
    'purpose', case when p_result ->> 'purpose' in ('primary_residence', 'relocation', 'family_use', 'investment', 'rental_income', 'business', 'other') then p_result ->> 'purpose' end,
    'constraints', (select coalesce(jsonb_agg(left(x, 120)), '[]') from jsonb_array_elements_text(case when jsonb_typeof(p_result -> 'constraints') = 'array' then p_result -> 'constraints' else '[]' end) with ordinality t(x, i) where i <= 5),
    'contradictions', (select coalesce(jsonb_agg(jsonb_build_object('field', left(x ->> 'field', 40), 'note', left(x ->> 'note', 200))), '[]')
       from jsonb_array_elements(case when jsonb_typeof(p_result -> 'contradictions') = 'array' then p_result -> 'contradictions' else '[]' end) with ordinality t(x, i)
       where i <= 5 and x ->> 'field' in ('intent', 'locations', 'budget', 'property_type', 'bedrooms', 'timeline')),
    'questions', (select coalesce(jsonb_agg(jsonb_build_object('field', x ->> 'field', 'question', left(x ->> 'question', 200))), '[]')
       from jsonb_array_elements(case when jsonb_typeof(p_result -> 'questions') = 'array' then p_result -> 'questions' else '[]' end) with ordinality t(x, i)
       where i <= 5 and x ->> 'field' in ('intent', 'locations', 'budget', 'property_type', 'bedrooms', 'timeline') and char_length(x ->> 'question') between 5 and 200),
    'summary', left(p_result ->> 'summary', 600))
  where id = r.id;
  perform private.run_step(r, 'analysis', 'ok', jsonb_build_object('fields', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(fields) k), 'outcome', meta ->> 'outcome'));
end;
$$;

create or replace function public.qualification_worker_secret_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_secret is not null and length(p_secret) >= 32
     and exists (select 1 from vault.decrypted_secrets where name = 'qualification_worker_secret' and decrypted_secret = p_secret);
$$;

-- ───────────────────────── user-facing RPCs ─────────────────────────

create or replace function public.qualification_request(p_lead uuid, p_idempotency_key text)
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
  select * into l from public.leads where id = p_lead;
  if l.id is null or not public.has_perm(l.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
  if not public.has_perm(l.organization_id, 'leads.edit') then perform private.fail('FORBIDDEN', 'You cannot run qualification'); end if;
  if l.archived_at is not null or l.status in ('won', 'lost') then perform private.fail('VALIDATION_ERROR', 'Closed leads are not qualified'); end if;
  if (select count(*) from public.agent_runs where organization_id = l.organization_id and agent_id = 'sales_qualification_agent' and lead_id = l.id
        and received_at > now() - interval '1 hour' and trigger_event = 'qualification.requested') >= 10 then
    perform private.fail('RATE_LIMITED', 'Too many qualification requests for this lead; try again later');
  end if;
  rid := private.qual_enqueue(l.organization_id, l.id, 'qualification.requested', 'manual:' || p_idempotency_key, 'manual');
  perform private.write_audit(l.organization_id, 'qualification.requested', 'leads', l.id, jsonb_build_object('run', rid));
  return jsonb_build_object('run_id', rid, 'status', (select status from public.agent_runs where id = rid));
end;
$$;

-- Read model for the lead screen.
create or replace function public.lead_qualification(p_lead uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l public.leads;
  q public.lead_qualifications;
  r public.agent_runs;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null or not public.has_perm(l.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
  select * into q from public.lead_qualifications where lead_id = l.id and is_current;
  select * into r from public.agent_runs where organization_id = l.organization_id and agent_id = 'sales_qualification_agent' and lead_id = l.id order by received_at desc limit 1;
  return jsonb_build_object(
    'status', l.qualification_status,
    'current', case when q.id is null then null else to_jsonb(q) - 'organization_id' end,
    'history', (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'status', h.status, 'score', h.score, 'trigger', h.trigger, 'review_status', h.review_status, 'created_at', h.created_at) order by h.created_at desc), '[]')
                from (select * from public.lead_qualifications where lead_id = l.id order by created_at desc limit 10) h),
    'run', case when r.id is null then null else jsonb_build_object('id', r.id, 'status', r.status, 'received_at', r.received_at, 'completed_at', r.completed_at,
      'attempts', r.attempt_count, 'error_category', r.error_category, 'awaiting_analysis', r.status = 'received' and coalesce((r.input ->> 'needs_analysis')::boolean, false) and r.extraction is null and r.model_meta is null,
      'analysis_outcome', r.model_meta ->> 'outcome') end,
    'can_review', public.has_perm(l.organization_id, 'approvals.decide'), 'can_run', public.has_perm(l.organization_id, 'leads.edit'));
end;
$$;

-- Human decision. approve: accept as proposed. reject: proposal not accepted. override: set a status (with a note).
-- edit: only confirm values. p_edits (any decision): values a person confirms; written to the lead (as that person) and re-qualified.
create or replace function public.qualification_review(p_qualification uuid, p_decision text, p_status text default null, p_edits jsonb default null, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.lead_qualifications;
  l public.leads;
  o public.organizations;
  n jsonb;
  rid uuid;
begin
  select * into q from public.lead_qualifications where id = p_qualification for update;
  if q.id is null or not public.has_perm(q.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Qualification not found'); end if;
  if not public.has_perm(q.organization_id, 'approvals.decide') then perform private.fail('FORBIDDEN', 'You cannot review qualifications'); end if;
  if not q.is_current then perform private.fail('CONFLICT', 'A newer qualification exists; review that one'); end if;
  if p_decision not in ('approve', 'reject', 'override', 'edit') then perform private.fail('VALIDATION_ERROR', 'Invalid decision'); end if;
  if p_decision = 'edit' and (p_edits is null or jsonb_typeof(p_edits) <> 'object' or p_edits = '{}'::jsonb) then perform private.fail('VALIDATION_ERROR', 'Nothing to confirm'); end if;
  if p_decision in ('reject', 'override') and char_length(trim(coalesce(p_note, ''))) < 3 then perform private.fail('VALIDATION_ERROR', 'Add a short note explaining the decision'); end if;
  if p_decision = 'approve' and q.status = 'human_review_required' then perform private.fail('VALIDATION_ERROR', 'Choose a status (override) or correct the details for a case that needs review'); end if;
  if p_decision = 'override' and coalesce(p_status, '') not in ('qualified', 'high_intent', 'nurture', 'needs_information', 'disqualified') then
    perform private.fail('VALIDATION_ERROR', 'Choose a valid status');
  end if;
  select * into l from public.leads where id = q.lead_id for update;

  if p_decision <> 'edit' then
    update public.lead_qualifications set review_status = case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'overridden' end,
      reviewed_by = auth.uid(), reviewed_at = now(), review_note = left(trim(p_note), 1000),
      status = case when p_decision = 'override' then p_status else status end
    where id = q.id returning * into q;
  end if;
  if p_decision = 'override' then
    update public.leads set qualification_status = p_status,
      status = case when p_status in ('qualified', 'high_intent') and status in ('new', 'attempting', 'contacted') then 'qualified' else status end
    where id = l.id;
    if p_status in ('qualified', 'high_intent') then
      perform private.emit_event(q.organization_id, 'lead.qualification.completed', 'lead', l.id, null,
        jsonb_build_object('event_type', 'lead.qualification.completed', 'schema_version', 1, 'organization_id', q.organization_id, 'lead_id', l.id,
          'qualification_id', q.id, 'agent_run_id', q.run_id, 'occurred_at', now(), 'status', p_status, 'recommended_action', 'recommend_property_matching', 'decided_by', 'human'),
        'property_matching_agent', 'qualification_completed:' || l.id::text || ':' || md5(q.requirements::text || p_status));
    end if;
  end if;
  if p_decision <> 'edit' then
    update public.tasks set status = 'completed' where related_lead_id = l.id and status in ('open', 'in_progress') and title like 'Review qualification%';
  end if;
  perform private.add_activity(q.organization_id, l.id, l.contact_id, null, 'workflow',
    case p_decision when 'approve' then 'Qualification approved' when 'reject' then 'Qualification rejected' when 'edit' then 'Qualification details confirmed'
      else 'Qualification set to ' || replace(p_status, '_', ' ') end, left(trim(p_note), 1000));
  perform private.write_audit(q.organization_id, 'qualification.reviewed', 'lead_qualifications', q.id,
    jsonb_build_object('decision', p_decision, 'status', p_status, 'edited', p_edits is not null));

  -- Confirmed values: written by the reviewer to the CRM, then re-qualified.
  if p_edits is not null and jsonb_typeof(p_edits) = 'object' and p_edits <> '{}'::jsonb then
    if not (public.has_perm(q.organization_id, 'leads.edit_any') or (public.has_perm(q.organization_id, 'leads.edit') and l.assigned_to = auth.uid())) then
      perform private.fail('FORBIDDEN', 'You cannot edit this lead');
    end if;
    select * into o from public.organizations where id = q.organization_id;
    n := private.intake_normalize(p_edits || '{"email":"x@x.invalid"}'::jsonb, o.country_code, o.default_currency, 'Review');
    if jsonb_array_length(n -> 'warnings') > 0 and exists (select 1 from jsonb_array_elements_text(n -> 'warnings') w where w <> 'unknown_fields_ignored' and w <> 'currency_differs_from_org') then
      perform private.fail('VALIDATION_ERROR', 'Some values are invalid: ' || (select string_agg(w, ', ') from jsonb_array_elements_text(n -> 'warnings') w));
    end if;
    update public.leads set
      desired_transaction = case when p_edits ? 'intent' then coalesce(n ->> 'intent', desired_transaction) else desired_transaction end,
      lead_type = case when p_edits ? 'intent' then coalesce(n ->> 'lead_type', lead_type) else lead_type end,
      desired_locations = case when p_edits ? 'locations' then array(select jsonb_array_elements_text(n -> 'locations')) else desired_locations end,
      budget_min = case when p_edits ? 'budget_min' or p_edits ? 'budget_max' then (n ->> 'budget_min')::numeric else budget_min end,
      budget_max = case when p_edits ? 'budget_min' or p_edits ? 'budget_max' then (n ->> 'budget_max')::numeric else budget_max end,
      budget_currency = case when p_edits ? 'currency' then n ->> 'currency' else budget_currency end,
      desired_property_type = case when p_edits ? 'property_type' then n ->> 'property_type' else desired_property_type end,
      bedrooms = case when p_edits ? 'bedrooms' then (n ->> 'bedrooms')::smallint else bedrooms end,
      timeline = case when p_edits ? 'timeline' then n ->> 'timeline' else timeline end,
      ai_extracted_fields = array(select x from unnest(ai_extracted_fields) x where not (
        (x = 'intent' and p_edits ? 'intent') or (x = 'locations' and p_edits ? 'locations') or (x = 'budget' and (p_edits ? 'budget_max' or p_edits ? 'budget_min'))
        or (x = 'propertyType' and p_edits ? 'property_type') or (x = 'bedrooms' and p_edits ? 'bedrooms') or (x = 'timeline' and p_edits ? 'timeline'))),
      metadata = case when p_edits ? 'intent' then jsonb_set(metadata, '{intake,missing}', coalesce(metadata -> 'intake' -> 'missing', '[]') - 'intent') else metadata end
    where id = l.id;
    rid := private.qual_enqueue(q.organization_id, l.id, 'qualification.edited', 'review:' || q.id::text || ':' || extract(epoch from now())::bigint, 'manual');
  end if;
  return jsonb_build_object('status', q.status, 'review_status', q.review_status, 'requalify_run', rid);
end;
$$;

create or replace function public.qualification_settings_save(p_org uuid, p_rules jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  w jsonb := p_rules -> 'weights';
  ver int;
  fields text[] := array['locations', 'budget', 'property_type', 'bedrooms', 'timeline'];
begin
  if not public.has_perm(p_org, 'settings.manage') then perform private.fail('FORBIDDEN', 'You cannot change qualification rules'); end if;
  if jsonb_typeof(p_rules) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_rules) k where k not in ('weights', 'required', 'qualified_min_score', 'high_intent_min_score', 'scope', 'max_questions', 'llm_enabled'))
     or (w is not null and (jsonb_typeof(w) <> 'object'
         or exists (select 1 from jsonb_each(w) e where e.key not in ('intent', 'requirements', 'budget', 'timeline', 'engagement', 'fit') or jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric not between 0 and 100)
         or (select sum((e.value #>> '{}')::numeric) from jsonb_each(w) e) <= 0))
     or (p_rules ? 'required' and (jsonb_typeof(p_rules -> 'required') <> 'object'
         or exists (select 1 from jsonb_each(p_rules -> 'required') e where e.key not in ('buy', 'rent', 'sell', 'let', 'invest') or jsonb_typeof(e.value) <> 'array'
                    or exists (select 1 from jsonb_array_elements_text(e.value) x where x <> all (fields)))))
     or (p_rules ? 'qualified_min_score' and coalesce((p_rules ->> 'qualified_min_score')::int, -1) not between 1 and 100)
     or (p_rules ? 'high_intent_min_score' and coalesce((p_rules ->> 'high_intent_min_score')::int, -1) not between 1 and 100)
     or (coalesce((p_rules ->> 'qualified_min_score')::int, 60) > coalesce((p_rules ->> 'high_intent_min_score')::int, 80))
     or (p_rules ? 'max_questions' and coalesce((p_rules ->> 'max_questions')::int, 0) not between 1 and 5)
     or (p_rules ? 'llm_enabled' and jsonb_typeof(p_rules -> 'llm_enabled') <> 'boolean')
     or (p_rules ? 'scope' and (jsonb_typeof(p_rules -> 'scope') <> 'object'
         or exists (select 1 from jsonb_each(p_rules -> 'scope') e where e.key not in ('transactions', 'locations', 'property_types') or jsonb_typeof(e.value) <> 'array' or jsonb_array_length(e.value) > 50)))
  then
    perform private.fail('VALIDATION_ERROR', 'Qualification rules are invalid');
  end if;
  insert into public.qualification_settings (organization_id, rules, updated_by) values (p_org, p_rules, auth.uid())
  on conflict (organization_id) do update set rules = excluded.rules, version = public.qualification_settings.version + 1, updated_by = excluded.updated_by
  returning version into ver;
  return ver;
exception
  when invalid_text_representation then perform private.fail('VALIDATION_ERROR', 'Qualification rules are invalid'); return null;
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke all on function private.qual_default_rules(), private.qual_rules(uuid), private.qual_context(uuid), private.qual_evaluate(jsonb, jsonb, jsonb),
  private.qual_call_proposals(jsonb), private.qual_enqueue(uuid, uuid, text, text, text), private.qual_execute(public.agent_runs)
  from public, anon, authenticated;
revoke execute on function public.qualification_process(uuid), public.qualification_tick(int), public.qualification_analysis_claim(int),
  public.qualification_attach_analysis(uuid, jsonb, jsonb), public.qualification_worker_secret_ok(text) from public, anon, authenticated;
grant execute on function public.qualification_process(uuid), public.qualification_tick(int), public.qualification_analysis_claim(int),
  public.qualification_attach_analysis(uuid, jsonb, jsonb), public.qualification_worker_secret_ok(text) to service_role;
revoke execute on function public.qualification_request(uuid, text), public.lead_qualification(uuid), public.qualification_review(uuid, text, text, jsonb, text),
  public.qualification_settings_save(uuid, jsonb) from public, anon;
grant execute on function public.qualification_request(uuid, text), public.lead_qualification(uuid), public.qualification_review(uuid, text, text, jsonb, text),
  public.qualification_settings_save(uuid, jsonb) to authenticated;

-- ───────────────────────── schedules ─────────────────────────
-- qualification-tick: pure SQL (outbox consumer + deterministic processing).
-- qualification-worker: pg_net → Edge Function for the optional Claude step; inactive until 'qualification_worker_url' is set in Vault.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'qualification_worker_secret') then
    perform vault.create_secret(private.random_token() || private.random_token(), 'qualification_worker_secret', 'Shared secret for the qualification-worker Edge Function');
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if not exists (select 1 from cron.job where jobname = 'qualification-tick') then
      perform cron.schedule('qualification-tick', '* * * * *', 'select public.qualification_tick(25)');
    end if;
    if exists (select 1 from pg_available_extensions where name = 'pg_net') and not exists (select 1 from cron.job where jobname = 'qualification-worker') then
      create extension if not exists pg_net with schema extensions;
      perform cron.schedule('qualification-worker', '* * * * *', $job$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'qualification_worker_url'),
          headers := jsonb_build_object('Content-Type', 'application/json',
            'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'qualification_worker_secret')),
          body := '{}'::jsonb, timeout_milliseconds := 55000)
        where exists (select 1 from vault.decrypted_secrets where name = 'qualification_worker_url')
      $job$);
    end if;
  end if;
end;
$$;
