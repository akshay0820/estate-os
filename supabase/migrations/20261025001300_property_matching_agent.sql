-- Estate OS · 0013 · Agent 04 — AI Property Matching Agent (property_matching_agent)
-- Consumes lead.qualification.completed (Agent 03) from the outbox, matches the lead against the organization's own
-- listings (hard constraints first, then an explainable configurable score), keeps runs and recommendations with history,
-- lets people shortlist / reject / share, invalidates recommendations when listings change, and emits
-- property_matching.* events for Agent 05. It never contacts anyone and never writes lead or property data.
-- Additive only.

-- ───────────────────────── tables ─────────────────────────

create table public.property_matching_settings (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  rules jsonb not null default '{}',
  version integer not null default 1,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger property_matching_settings_updated_at before update on public.property_matching_settings for each row execute function public.set_updated_at();
create trigger property_matching_settings_audit after insert or update on public.property_matching_settings for each row execute function private.audit_row();

-- One row per completed matching run. Runs in flight (pending / retrying / failed) live in agent_runs.
create table public.property_match_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  lead_id uuid not null references public.leads (id) on delete cascade,
  run_id uuid references public.agent_runs (id) on delete set null,
  qualification_id uuid references public.lead_qualifications (id) on delete set null,
  trigger text not null check (char_length(trigger) <= 80),
  status text not null check (status in ('completed', 'completed_with_warnings', 'needs_more_information', 'no_matches', 'not_applicable')),
  -- Requirements used (with provenance) and the prepared hard/soft criteria. Never contact details.
  criteria jsonb not null default '{}',
  inventory_scope text not null default 'organization' check (inventory_scope in ('organization')),
  inventory_count integer not null default 0,
  candidate_count integer not null default 0,
  eligible_count integer not null default 0,
  recommended_count integer not null default 0,
  rejections jsonb not null default '{}',
  warnings text[] not null default '{}',
  missing text[] not null default '{}',
  ruleset_version integer not null,
  explanation_status text not null default 'not_requested' check (explanation_status in ('not_requested', 'pending', 'succeeded', 'failed', 'not_configured')),
  explain_lease_until timestamptz,
  model_meta jsonb,
  results_fingerprint text,
  is_current boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index property_match_runs_current_uniq on public.property_match_runs (lead_id) where is_current;
create index property_match_runs_lead_idx on public.property_match_runs (lead_id, created_at desc);
create index property_match_runs_org_idx on public.property_match_runs (organization_id, created_at desc);
create index property_match_runs_explain_idx on public.property_match_runs (created_at) where explanation_status = 'pending';
create trigger property_match_runs_org_immutable before update on public.property_match_runs for each row execute function private.prevent_org_change();

create table public.property_matches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  match_run_id uuid not null references public.property_match_runs (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  property_id uuid not null references public.properties (id) on delete cascade,
  rank smallint not null check (rank between 1 and 100),
  score smallint not null check (score between 0 and 100),
  band text not null check (band in ('strong', 'good', 'partial')),
  breakdown jsonb not null default '[]',
  strengths jsonb not null default '[]',
  tradeoffs jsonb not null default '[]',
  caveats jsonb not null default '[]',
  availability text not null check (availability in ('verified', 'stale', 'unverified')),
  budget_fit text not null check (budget_fit in ('within', 'over_budget', 'below_min', 'unknown', 'not_requested')),
  explanation text not null check (char_length(explanation) <= 2000),
  ai_summary text check (char_length(ai_summary) <= 400),
  -- Listing state when matched, so later price / status changes are detectable.
  snapshot jsonb not null default '{}',
  status text not null default 'recommended' check (status in ('recommended', 'viewed', 'shortlisted', 'rejected', 'shared', 'appointment_requested', 'invalidated')),
  status_reason text check (char_length(status_reason) <= 300),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  price_changed boolean not null default false,
  invalidated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_run_id, property_id)
);
create index property_matches_run_idx on public.property_matches (match_run_id, rank);
create index property_matches_lead_idx on public.property_matches (lead_id, property_id);
create index property_matches_property_idx on public.property_matches (property_id) where status not in ('rejected', 'invalidated');
create index property_matches_org_idx on public.property_matches (organization_id, created_at desc);
create trigger property_matches_updated_at before update on public.property_matches for each row execute function public.set_updated_at();
create trigger property_matches_org_immutable before update on public.property_matches for each row execute function private.prevent_org_change();

alter table public.property_matching_settings enable row level security;
alter table public.property_match_runs enable row level security;
alter table public.property_matches enable row level security;
create policy property_matching_settings_read on public.property_matching_settings for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy property_match_runs_read on public.property_match_runs for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
create policy property_matches_read on public.property_matches for select to authenticated using (public.has_perm(organization_id, 'leads.view'));
revoke all on public.property_matching_settings, public.property_match_runs, public.property_matches from anon;
revoke insert, update, delete, truncate on public.property_matching_settings, public.property_match_runs, public.property_matches from authenticated;

-- ───────────────────────── rules & helpers ─────────────────────────

create or replace function private.pm_default_rules()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{
    "weights": {"location": 25, "budget": 25, "property_type": 15, "bedrooms": 15, "amenities": 10, "availability": 10},
    "min_score": 50, "good_min": 70, "strong_min": 85,
    "result_limit": 10, "max_candidates": 1000,
    "budget_flex_pct": 10, "freshness_days": 30, "unverified_policy": "flag",
    "location_flexible": false, "location_aliases": {},
    "llm_explanations": true
  }'::jsonb;
$$;

create or replace function private.pm_rules(org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.pm_default_rules() || coalesce(s.rules, '{}') || jsonb_build_object('version', coalesce(s.version, 0))
  from (select 1) x left join public.property_matching_settings s on s.organization_id = org;
$$;

create or replace function private.pm_norm(x text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(lower(regexp_replace(trim(x), '\s+', ' ', 'g')), '');
$$;

-- Normalized location with the org's configured aliases applied (e.g. "bandra west" → "bandra").
create or replace function private.pm_loc(x text, aliases jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce((select private.pm_norm(e.value #>> '{}') from jsonb_each(coalesce(aliases, '{}')) e where private.pm_norm(e.key) = private.pm_norm(x) limit 1),
                  private.pm_norm(x));
$$;

create or replace function private.pm_category(t text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when t is null then null
              when t in ('apartment', 'penthouse', 'villa', 'house', 'townhouse') then 'residential'
              when t = 'plot' then 'land'
              when t in ('office', 'retail', 'commercial') then 'commercial' else 'other' end;
$$;

create or replace function private.pm_money(n numeric, cur text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(cur, '') || ' ' || to_char(n, 'FM999,999,999,999,990');
$$;

-- ───────────────────────── criteria ─────────────────────────

-- Requirements for one lead: current CRM values (authoritative, 'confirmed' unless AI-extracted), with gaps filled from
-- the current qualification's call / model proposals ('stated' / 'inferred'). Works without any qualification.
create or replace function private.pm_criteria(p_lead uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l public.leads;
  q public.lead_qualifications;
  ai text[];
  crm jsonb;
  extra jsonb := '{}';
begin
  select * into l from public.leads where id = p_lead;
  select * into q from public.lead_qualifications where lead_id = l.id and organization_id = l.organization_id and is_current;
  ai := l.ai_extracted_fields;
  crm := jsonb_strip_nulls(jsonb_build_object(
    'intent', case when not (coalesce(l.metadata -> 'intake' -> 'missing', '[]') ? 'intent') then
      jsonb_build_object('value', l.desired_transaction, 'certainty', case when 'intent' = any (ai) then 'ai_extracted' else 'confirmed' end, 'source', 'crm') end,
    'locations', case when cardinality(l.desired_locations) > 0 then
      jsonb_build_object('value', to_jsonb(l.desired_locations), 'certainty', case when 'locations' = any (ai) then 'ai_extracted' else 'confirmed' end, 'source', 'crm') end,
    'budget', case when l.budget_max is not null or l.budget_min is not null then
      jsonb_build_object('value', jsonb_build_object('min', l.budget_min, 'max', l.budget_max, 'currency', l.budget_currency),
        'certainty', case when 'budget' = any (ai) then 'ai_extracted' else 'confirmed' end, 'source', 'crm') end,
    'property_type', case when l.desired_property_type is not null then
      jsonb_build_object('value', l.desired_property_type, 'certainty', case when 'propertyType' = any (ai) then 'ai_extracted' else 'confirmed' end, 'source', 'crm') end,
    'bedrooms', case when l.bedrooms is not null then
      jsonb_build_object('value', l.bedrooms, 'certainty', case when 'bedrooms' = any (ai) then 'ai_extracted' else 'confirmed' end, 'source', 'crm') end));
  if q.id is not null then
    select coalesce(jsonb_object_agg(key, value), '{}') into extra from jsonb_each(q.requirements)
    where key in ('intent', 'locations', 'budget', 'property_type', 'bedrooms') and value ->> 'source' is distinct from 'crm'
      and value ->> 'certainty' in ('stated', 'inferred');
  end if;
  return jsonb_build_object('lead_id', l.id, 'qualification_id', q.id, 'qualification_status', coalesce(q.status, l.qualification_status),
    'requirements', extra || crm, 'amenities', to_jsonb(l.required_amenities), 'currency', l.budget_currency);
end;
$$;

-- Flattened hard / soft criteria. Only 'confirmed' (set by a person in the CRM) values are hard constraints.
create or replace function private.pm_prepare(crit jsonb, rules jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  req jsonb := coalesce(crit -> 'requirements', '{}');
  aliases jsonb := coalesce(rules -> 'location_aliases', '{}');
  intent text := req -> 'intent' ->> 'value';
  b jsonb := req -> 'budget' -> 'value';
begin
  return jsonb_strip_nulls(jsonb_build_object(
    'intent', intent,
    'intent_certainty', req -> 'intent' ->> 'certainty',
    'listing_type', case when intent in ('buy', 'invest') then 'sale' when intent = 'rent' then 'rent' end,
    'locs', (select jsonb_agg(distinct private.pm_loc(x, aliases)) from jsonb_array_elements_text(coalesce(req -> 'locations' -> 'value', '[]')) x where private.pm_norm(x) is not null),
    'loc_label', (select string_agg(x, ', ') from jsonb_array_elements_text(coalesce(req -> 'locations' -> 'value', '[]')) x),
    'loc_hard', case when req ? 'locations' then req -> 'locations' ->> 'certainty' = 'confirmed' end,
    'bmin', case when jsonb_typeof(b -> 'min') = 'number' then b -> 'min' end,
    'bmax', case when jsonb_typeof(b -> 'max') = 'number' then b -> 'max' end,
    'bcur', case when b is not null then coalesce(b ->> 'currency', crit ->> 'currency') end,
    'budget_hard', case when req ? 'budget' then req -> 'budget' ->> 'certainty' = 'confirmed' end,
    'ptype', req -> 'property_type' ->> 'value',
    'ptype_hard', case when req ? 'property_type' then req -> 'property_type' ->> 'certainty' = 'confirmed' end,
    'beds', case when jsonb_typeof(req -> 'bedrooms' -> 'value') = 'number' then req -> 'bedrooms' -> 'value' end,
    'beds_hard', case when req ? 'bedrooms' then req -> 'bedrooms' ->> 'certainty' = 'confirmed' end,
    'amen_labels', case when jsonb_array_length(coalesce(crit -> 'amenities', '[]')) > 0 then crit -> 'amenities' end,
    'aliases', case when aliases <> '{}'::jsonb then aliases end));
end;
$$;

-- ───────────────────────── the engine ─────────────────────────

-- One listing against prepared criteria. Hard constraints first (returns eligible=false + a reason code), then the score.
-- p is to_jsonb(properties row). Pure: same inputs → same output.
create or replace function private.pm_evaluate(c jsonb, p jsonb, rules jsonb, p_now timestamptz)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  w jsonb := rules -> 'weights';
  dims jsonb := '[]';
  st jsonb := '[]';
  tr jsonb := '[]';
  cv jsonb := '[]';
  v numeric;
  num numeric;
  den numeric;
  score int;
  price numeric := (p ->> 'price')::numeric;
  cur text := p ->> 'currency';
  flex numeric := coalesce((rules ->> 'budget_flex_pct')::numeric, 10);
  over numeric;
  bmax numeric := (c ->> 'bmax')::numeric;
  bmin numeric := (c ->> 'bmin')::numeric;
  ploc text := private.pm_loc(p ->> 'locality', c -> 'aliases');
  pcity text := private.pm_loc(p ->> 'city', c -> 'aliases');
  beds int := (p ->> 'bedrooms')::int;
  want int := (c ->> 'beds')::int;
  verified timestamptz := (p ->> 'verified_at')::timestamptz;
  avail text;
  budget_fit text := 'not_requested';
  have text[];
  got text[];
  lacking text[];
begin
  -- 1. Hard constraints.
  if p ->> 'listing_type' is distinct from c ->> 'listing_type' then return jsonb_build_object('eligible', false, 'reject', 'TRANSACTION_TYPE_MISMATCH'); end if;
  if p ->> 'status' is distinct from 'active' then return jsonb_build_object('eligible', false, 'reject', 'LISTING_UNAVAILABLE'); end if;
  avail := case when verified is null then 'unverified'
                when verified >= p_now - make_interval(days => coalesce((rules ->> 'freshness_days')::int, 30)) then 'verified' else 'stale' end;
  if avail <> 'verified' and rules ->> 'unverified_policy' = 'exclude' then return jsonb_build_object('eligible', false, 'reject', 'REQUIRED_DATA_UNVERIFIED'); end if;

  if c ? 'locs' and not ((c -> 'locs') ? coalesce(ploc, '') or (c -> 'locs') ? coalesce(pcity, ''))
     and coalesce((c ->> 'loc_hard')::boolean, false) and not coalesce((rules ->> 'location_flexible')::boolean, false) then
    return jsonb_build_object('eligible', false, 'reject', 'OUTSIDE_MANDATORY_LOCATION');
  end if;
  if bmax is not null and cur = c ->> 'bcur' and price > bmax and coalesce((c ->> 'budget_hard')::boolean, false)
     and 100 * (price - bmax) / bmax > flex then
    return jsonb_build_object('eligible', false, 'reject', 'EXCEEDS_HARD_BUDGET');
  end if;
  if c ? 'ptype' and coalesce((c ->> 'ptype_hard')::boolean, false) and private.pm_category(p ->> 'property_type') <> private.pm_category(c ->> 'ptype') then
    return jsonb_build_object('eligible', false, 'reject', 'PROPERTY_TYPE_MISMATCH');
  end if;
  if want is not null and beds < want and coalesce((c ->> 'beds_hard')::boolean, false) then
    return jsonb_build_object('eligible', false, 'reject', 'BEDROOM_REQUIREMENT_NOT_MET');
  end if;

  -- 2. Score. A dimension the lead gave no preference for is not applicable; one the listing cannot be evaluated on scores 0.
  if c ? 'locs' then
    if (c -> 'locs') ? coalesce(ploc, '') then
      v := 1; st := st || jsonb_build_array(jsonb_build_object('code', 'IN_PREFERRED_LOCALITY', 'text', 'In ' || (p ->> 'locality')));
    elsif (c -> 'locs') ? coalesce(pcity, '') then
      v := 0.7; st := st || jsonb_build_array(jsonb_build_object('code', 'IN_PREFERRED_CITY', 'text', format('In %s (%s)', p ->> 'city', p ->> 'locality')));
    else
      v := 0; tr := tr || jsonb_build_array(jsonb_build_object('code', 'OUTSIDE_PREFERRED_AREAS', 'text', format('In %s, outside the preferred areas (%s)', p ->> 'locality', c ->> 'loc_label')));
    end if;
    dims := dims || jsonb_build_array(jsonb_build_object('key', 'location', 'label', 'Location', 'weight', (w ->> 'location')::numeric, 'value', v));
  end if;

  if bmax is not null or bmin is not null then
    if cur is distinct from c ->> 'bcur' then
      v := 0; budget_fit := 'unknown';
      cv := cv || jsonb_build_array(jsonb_build_object('code', 'CURRENCY_MISMATCH', 'text', format('Listed in %s; the budget is in %s, so the price was not compared', cur, c ->> 'bcur')));
    elsif bmax is not null and price > bmax then
      over := 100 * (price - bmax) / bmax;
      v := greatest(0, 1 - over / greatest(2 * flex, 10)); budget_fit := 'over_budget';
      tr := tr || jsonb_build_array(jsonb_build_object('code', 'OVER_BUDGET', 'text', format('%s%% over the budget (%s of %s)', round(over, 1), private.pm_money(price, cur), private.pm_money(bmax, cur))));
    elsif bmin is not null and price < bmin then
      v := 0.9; budget_fit := 'below_min';
      tr := tr || jsonb_build_array(jsonb_build_object('code', 'BELOW_MIN_BUDGET', 'text', format('Below the stated minimum (%s of %s)', private.pm_money(price, cur), private.pm_money(bmin, cur))));
    else
      v := 1; budget_fit := 'within';
      st := st || jsonb_build_array(jsonb_build_object('code', 'WITHIN_BUDGET', 'text',
        case when bmax is not null then format('Within budget (%s of %s)', private.pm_money(price, cur), private.pm_money(bmax, cur))
             else format('Above the stated minimum (%s)', private.pm_money(price, cur)) end));
    end if;
    dims := dims || jsonb_build_array(jsonb_build_object('key', 'budget', 'label', 'Budget', 'weight', (w ->> 'budget')::numeric, 'value', round(v, 2)));
  end if;

  if c ? 'ptype' then
    if p ->> 'property_type' = c ->> 'ptype' then
      v := 1; st := st || jsonb_build_array(jsonb_build_object('code', 'TYPE_MATCH', 'text', initcap(p ->> 'property_type') || ' as requested'));
    elsif private.pm_category(p ->> 'property_type') = private.pm_category(c ->> 'ptype') then
      v := 0.6; tr := tr || jsonb_build_array(jsonb_build_object('code', 'SIMILAR_TYPE', 'text', format('%s rather than %s', initcap(p ->> 'property_type'), c ->> 'ptype')));
    else
      v := 0; tr := tr || jsonb_build_array(jsonb_build_object('code', 'DIFFERENT_TYPE', 'text', format('%s; %s requested', initcap(p ->> 'property_type'), c ->> 'ptype')));
    end if;
    dims := dims || jsonb_build_array(jsonb_build_object('key', 'property_type', 'label', 'Property type', 'weight', (w ->> 'property_type')::numeric, 'value', v));
  end if;

  if want is not null then
    if beds = want then
      v := 1; st := st || jsonb_build_array(jsonb_build_object('code', 'BEDROOMS_MATCH', 'text', format('%s bedroom(s) as requested', beds)));
    elsif beds < want then
      v := 0.3; tr := tr || jsonb_build_array(jsonb_build_object('code', 'FEWER_BEDROOMS', 'text', format('%s bedroom(s); %s requested', beds, want)));
    else
      v := case when beds = want + 1 then 0.7 else 0.4 end;
      tr := tr || jsonb_build_array(jsonb_build_object('code', 'MORE_BEDROOMS', 'text', format('%s bedrooms; %s requested', beds, want)));
    end if;
    dims := dims || jsonb_build_array(jsonb_build_object('key', 'bedrooms', 'label', 'Bedrooms', 'weight', (w ->> 'bedrooms')::numeric, 'value', v));
  end if;

  if c ? 'amen_labels' then
    have := array(select private.pm_norm(x) from jsonb_array_elements_text(coalesce(p -> 'amenities', '[]')) x);
    got := array(select a from jsonb_array_elements_text(c -> 'amen_labels') a where private.pm_norm(a) = any (have));
    lacking := array(select a from jsonb_array_elements_text(c -> 'amen_labels') a where not (private.pm_norm(a) = any (have)));
    v := round(cardinality(got)::numeric / jsonb_array_length(c -> 'amen_labels'), 2);
    if cardinality(got) > 0 then st := st || jsonb_build_array(jsonb_build_object('code', 'HAS_AMENITIES', 'text', 'Has ' || array_to_string(got, ', '))); end if;
    -- "Not listed" is not "does not have": the listing may simply not record it.
    if cardinality(lacking) > 0 then tr := tr || jsonb_build_array(jsonb_build_object('code', 'AMENITIES_NOT_LISTED', 'text', array_to_string(lacking, ', ') || ' not listed for this property')); end if;
    dims := dims || jsonb_build_array(jsonb_build_object('key', 'amenities', 'label', 'Amenities', 'weight', (w ->> 'amenities')::numeric, 'value', v));
  end if;

  v := case avail when 'verified' then 1 when 'stale' then 0.5 else 0 end;
  if avail = 'verified' then
    st := st || jsonb_build_array(jsonb_build_object('code', 'AVAILABILITY_VERIFIED', 'text', 'Availability verified ' || to_char(verified, 'DD Mon YYYY')));
  elsif avail = 'stale' then
    cv := cv || jsonb_build_array(jsonb_build_object('code', 'AVAILABILITY_STALE', 'text', 'Availability last verified ' || to_char(verified, 'DD Mon YYYY') || '; confirm before sharing'));
  else
    cv := cv || jsonb_build_array(jsonb_build_object('code', 'AVAILABILITY_UNVERIFIED', 'text', 'Availability has not been verified; confirm before sharing'));
  end if;
  dims := dims || jsonb_build_array(jsonb_build_object('key', 'availability', 'label', 'Availability confidence', 'weight', (w ->> 'availability')::numeric, 'value', v));

  select sum((d ->> 'weight')::numeric * (d ->> 'value')::numeric), sum((d ->> 'weight')::numeric) into num, den from jsonb_array_elements(dims) d;
  score := case when den > 0 then round(100 * num / den)::int else 0 end;
  dims := (select coalesce(jsonb_agg(d || jsonb_build_object('points', case when den > 0 then round(100 * (d ->> 'weight')::numeric * (d ->> 'value')::numeric / den, 1) end,
             'status', case when (d ->> 'value')::numeric >= 1 then 'matched' when (d ->> 'value')::numeric > 0 then 'partial'
                            when d ->> 'key' = 'budget' and budget_fit = 'unknown' or d ->> 'key' = 'availability' then 'unknown' else 'unmet' end)), '[]')
           from jsonb_array_elements(dims) d);
  return jsonb_build_object('eligible', true, 'score', score, 'breakdown', dims, 'strengths', st, 'tradeoffs', tr, 'caveats', cv,
    'availability', avail, 'budget_fit', budget_fit,
    'band', case when score >= coalesce((rules ->> 'strong_min')::int, 85) then 'strong' when score >= coalesce((rules ->> 'good_min')::int, 70) then 'good' else 'partial' end);
end;
$$;

create or replace function private.pm_explain(e jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(concat_ws(' ',
    case when jsonb_array_length(e -> 'strengths') > 0 then 'Matches: ' || (select string_agg(x ->> 'text', '; ') from jsonb_array_elements(e -> 'strengths') x) || '.' end,
    case when jsonb_array_length(e -> 'tradeoffs') > 0 then 'Trade-offs: ' || (select string_agg(x ->> 'text', '; ') from jsonb_array_elements(e -> 'tradeoffs') x) || '.' end,
    case when jsonb_array_length(e -> 'caveats') > 0 then 'Note: ' || (select string_agg(x ->> 'text', '; ') from jsonb_array_elements(e -> 'caveats') x) || '.' end), 2000);
$$;

create or replace function private.pm_can_act(org uuid, assigned uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_perm(org, 'leads.edit_any') or (public.has_perm(org, 'leads.edit') and (assigned = auth.uid() or assigned is null));
$$;

-- ───────────────────────── runs ─────────────────────────

create or replace function private.pm_enqueue(org uuid, p_lead uuid, p_trigger text, p_key text, p_kind text, p_corr uuid)
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
  values (org, 'property_matching_agent', '1.0.0', p_trigger, p_kind, 'os', p_key, p_lead, jsonb_build_object('lead_id', p_lead),
    coalesce(p_corr, (select correlation_id from public.agent_runs where organization_id = org and lead_id = p_lead and agent_id = 'sales_qualification_agent' order by received_at desc limit 1), gen_random_uuid()))
  on conflict (organization_id, agent_id, idempotency_key) do nothing
  returning id into rid;
  if rid is null then
    select id into rid from public.agent_runs where organization_id = org and agent_id = 'property_matching_agent' and idempotency_key = p_key;
  end if;
  return rid;
end;
$$;

-- One matching run inside a sub-transaction: criteria → bounded candidates → eligibility → score → rank → persist → events.
create or replace function private.pm_execute(r public.agent_runs)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l public.leads;
  rules jsonb;
  crit jsonb;
  c jsonb;
  p public.properties;
  e jsonb;
  results jsonb := '[]';
  ranked jsonb;
  rej jsonb := '{}';
  warnings text[] := '{}';
  missing text[];
  inv int;
  cand int := 0;
  elig int := 0;
  rec int := 0;
  lim int;
  maxc int;
  minscore int;
  st text;
  prev uuid;
  mrid uuid;
  fp text;
  owner uuid;
  who text;
  ev jsonb;
  bmax numeric;
  x jsonb;
  i int;
begin
  select * into l from public.leads where id = r.lead_id and organization_id = r.organization_id;
  if l.id is null then return jsonb_build_object('status', 'skipped', 'reason', 'lead_not_found'); end if;
  if l.archived_at is not null or l.status in ('won', 'lost') then return jsonb_build_object('status', 'skipped', 'reason', 'lead_closed'); end if;
  perform pg_advisory_xact_lock(hashtextextended('match:' || l.id::text, 0));

  rules := private.pm_rules(l.organization_id);
  crit := private.pm_criteria(l.id);
  c := private.pm_prepare(crit, rules);
  lim := least(greatest(coalesce((rules ->> 'result_limit')::int, 10), 1), 25);
  maxc := least(greatest(coalesce((rules ->> 'max_candidates')::int, 1000), 50), 2000);
  minscore := coalesce((rules ->> 'min_score')::int, 50);
  bmax := (c ->> 'bmax')::numeric;

  missing := array_remove(array[
    case when not c ? 'intent' then 'intent' end,
    case when not c ? 'locs' then 'locations' end,
    case when not (c ? 'bmax' or c ? 'bmin') then 'budget' end,
    case when not c ? 'ptype' then 'property_type' end,
    case when not c ? 'beds' and coalesce(private.pm_category(c ->> 'ptype'), 'residential') = 'residential' then 'bedrooms' end], null);
  if crit ->> 'qualification_id' is null then warnings := warnings || 'qualification_missing'::text;
  elsif coalesce(crit ->> 'qualification_status', '') not in ('qualified', 'high_intent') then warnings := warnings || 'qualification_not_complete'::text; end if;

  select count(*) into inv from public.properties where organization_id = l.organization_id and status = 'active';

  if not c ? 'intent' or not (c ? 'locs' or c ? 'bmax' or c ? 'bmin') then
    st := 'needs_more_information';
  elsif c ->> 'listing_type' is null then
    st := 'not_applicable';
  else
    -- Bounded retrieval on the (organization_id, status, listing_type, price) index. Only this org's listings.
    for p in
      select * from public.properties pr
      where pr.organization_id = l.organization_id and pr.listing_type = c ->> 'listing_type' and pr.status in ('active', 'under_offer', 'reserved')
      order by (pr.status = 'active') desc, case when bmax is not null then abs(pr.price - bmax) end nulls last, pr.verified_at desc nulls last, pr.updated_at desc, pr.id
      limit maxc
    loop
      cand := cand + 1;
      e := private.pm_evaluate(c, to_jsonb(p), rules, now());
      if not (e ->> 'eligible')::boolean then
        rej := rej || jsonb_build_object(e ->> 'reject', coalesce((rej ->> (e ->> 'reject'))::int, 0) + 1);
        continue;
      end if;
      elig := elig + 1;
      if (e ->> 'score')::int < minscore then
        rej := rej || jsonb_build_object('BELOW_MIN_SCORE', coalesce((rej ->> 'BELOW_MIN_SCORE')::int, 0) + 1);
        continue;
      end if;
      results := results || jsonb_build_array(e || jsonb_build_object('property_id', p.id,
        'snapshot', jsonb_build_object('price', p.price, 'currency', p.currency, 'status', p.status, 'listing_type', p.listing_type, 'verified_at', p.verified_at, 'updated_at', p.updated_at),
        'avail_rank', case e ->> 'availability' when 'verified' then 0 when 'stale' then 1 else 2 end,
        'closeness', case when bmax is not null and p.currency = c ->> 'bcur' then abs(p.price - bmax) end));
    end loop;
    if cand >= maxc then warnings := warnings || 'candidate_limit_reached'::text; end if;
    if inv = 0 then warnings := warnings || 'inventory_empty'::text; end if;

    -- Deterministic order: score, availability, verification recency, price closeness, last update, id.
    select coalesce(jsonb_agg(y order by n), '[]') into ranked from (
      select y, row_number() over (order by (y ->> 'score')::int desc, (y ->> 'avail_rank')::int, (y -> 'snapshot' ->> 'verified_at')::timestamptz desc nulls last,
        (y ->> 'closeness')::numeric nulls last, (y -> 'snapshot' ->> 'updated_at')::timestamptz desc, y ->> 'property_id') n
      from jsonb_array_elements(results) y) z where n <= lim;
    rec := jsonb_array_length(ranked);
    if exists (select 1 from jsonb_array_elements(ranked) y where y ->> 'availability' <> 'verified') then warnings := warnings || 'unverified_listings'::text; end if;
    if exists (select 1 from jsonb_array_elements(ranked) y where y ->> 'budget_fit' = 'unknown') then warnings := warnings || 'currency_mismatch'::text; end if;
    st := case when rec = 0 then 'no_matches' when cardinality(warnings) > 0 then 'completed_with_warnings' else 'completed' end;
  end if;
  perform private.run_step(r, 'evaluate', 'ok', jsonb_build_object('status', st, 'inventory', inv, 'candidates', cand, 'eligible', elig, 'recommended', rec, 'rejections', rej));

  -- Persist: new current run; human decisions on the same listings carry over from the previous run.
  select id into prev from public.property_match_runs where lead_id = l.id and is_current;
  update public.property_match_runs set is_current = false where lead_id = l.id and is_current;
  fp := md5(coalesce((select string_agg((y ->> 'property_id') || ':' || n || ':' || (y -> 'snapshot' ->> 'price'), ',' order by n) from jsonb_array_elements(ranked) with ordinality t(y, n)), ''));
  insert into public.property_match_runs (organization_id, lead_id, run_id, qualification_id, trigger, status, criteria, inventory_count, candidate_count, eligible_count,
    recommended_count, rejections, warnings, missing, ruleset_version, explanation_status, results_fingerprint)
  values (l.organization_id, l.id, r.id, (crit ->> 'qualification_id')::uuid, r.trigger_event, st,
    jsonb_build_object('requirements', crit -> 'requirements', 'amenities', crit -> 'amenities', 'prepared', c, 'qualification_status', crit ->> 'qualification_status'),
    inv, cand, elig, rec, rej, warnings, missing, coalesce((rules ->> 'version')::int, 0),
    case when rec > 0 and coalesce((rules ->> 'llm_explanations')::boolean, true) then 'pending' else 'not_requested' end, fp)
  returning id into mrid;

  i := 0;
  for x in select y from jsonb_array_elements(coalesce(ranked, '[]')) y loop
    i := i + 1;
    insert into public.property_matches (organization_id, match_run_id, lead_id, property_id, rank, score, band, breakdown, strengths, tradeoffs, caveats,
      availability, budget_fit, explanation, snapshot, status, status_reason, decided_by, decided_at)
    select l.organization_id, mrid, l.id, (x ->> 'property_id')::uuid, i, (x ->> 'score')::int, x ->> 'band', x -> 'breakdown', x -> 'strengths', x -> 'tradeoffs', x -> 'caveats',
      x ->> 'availability', x ->> 'budget_fit', private.pm_explain(x), x -> 'snapshot',
      coalesce(pm.status, 'recommended'), pm.status_reason, pm.decided_by, pm.decided_at
    from (select 1) one
    left join lateral (select m.status, m.status_reason, m.decided_by, m.decided_at from public.property_matches m
                       where m.match_run_id = prev and m.property_id = (x ->> 'property_id')::uuid and m.status in ('viewed', 'shortlisted', 'rejected', 'shared', 'appointment_requested')) pm on true;
  end loop;

  insert into public.activities (organization_id, lead_id, contact_id, activity_type, title, description, source, actor_name, metadata)
  values (l.organization_id, l.id, l.contact_id, 'workflow',
    case st when 'needs_more_information' then 'Property matching: more information needed'
            when 'not_applicable' then 'Property matching: not applicable for this lead type'
            when 'no_matches' then 'Property matching: no suitable listings'
            else format('Property matching: %s recommended', rec) end,
    concat_ws(' · ', case when st not in ('needs_more_information', 'not_applicable') then format('%s listing(s) evaluated, %s eligible', cand, elig) end,
      case when rej <> '{}'::jsonb then 'Excluded: ' || (select string_agg(lower(replace(k, '_', ' ')) || ' ' || v, ', ') from jsonb_each_text(rej) t(k, v)) end,
      case when cardinality(missing) > 0 then 'Would help: ' || array_to_string(array(select replace(m, '_', ' ') from unnest(missing) m), ', ') end),
    'ai', 'Property Matching Agent', jsonb_build_object('match_run_id', mrid, 'run_id', r.id, 'agent', 'property_matching_agent'));

  -- Work for people when nothing fits. Never a message to the customer.
  if st = 'no_matches' and not exists (select 1 from public.tasks t where t.related_lead_id = l.id and t.status in ('open', 'in_progress') and t.title like 'No property matches%') then
    owner := case when private.intake_eligible(l.organization_id, l.assigned_to) then l.assigned_to end;
    select display_name into who from public.contacts where id = l.contact_id;
    insert into public.tasks (organization_id, title, description, priority, due_at, assigned_to, related_lead_id, source)
    values (l.organization_id, left('No property matches: ' || coalesce(who, 'lead'), 200),
      case when inv = 0 then 'There are no active listings. Add or activate inventory, then re-run matching.'
           else format('%s listing(s) evaluated; none met the requirements. Review the requirements with the prospect or check new inventory.', cand) end,
      'normal', now() + interval '2 days', owner, l.id, 'ai');
  end if;

  ev := jsonb_build_object('schema_version', 1, 'organization_id', l.organization_id, 'lead_id', l.id, 'matching_run_id', mrid,
    'qualification_id', crit ->> 'qualification_id', 'recommended_count', rec, 'agent_run_id', r.id, 'correlation_id', r.correlation_id, 'occurred_at', now());
  if rec > 0 then
    -- Same listings, ranks and prices → same key → Agent 05 is not re-triggered by an unchanged result.
    perform private.emit_event(l.organization_id, 'property_matching.completed', 'lead', l.id, r.correlation_id,
      ev || jsonb_build_object('event_type', 'property_matching.completed'), 'follow_up_agent', 'property_matching_completed:' || l.id::text || ':' || fp);
  elsif st = 'no_matches' then
    perform private.emit_event(l.organization_id, 'property_matching.no_matches', 'lead', l.id, r.correlation_id,
      ev || jsonb_build_object('event_type', 'property_matching.no_matches'), null, 'property_matching_none:' || mrid::text);
  elsif st = 'needs_more_information' then
    perform private.emit_event(l.organization_id, 'property_matching.needs_information', 'lead', l.id, r.correlation_id,
      ev || jsonb_build_object('event_type', 'property_matching.needs_information', 'missing', to_jsonb(missing)), null, 'property_matching_info:' || mrid::text);
  end if;
  perform private.run_step(r, 'persist', 'ok', jsonb_build_object('match_run_id', mrid, 'recommended', rec));
  return jsonb_build_object('status', st, 'match_run_id', mrid, 'recommended', rec, 'eligible', elig, 'candidates', cand);
end;
$$;

create or replace function public.property_matching_process(p_run uuid)
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
  select * into r from public.agent_runs where id = p_run and agent_id = 'property_matching_agent' for update;
  if r.id is null then perform private.fail('NOT_FOUND', 'Run not found'); end if;
  if r.status not in ('received', 'retry_scheduled') then
    return jsonb_build_object('status', r.status, 'run_id', r.id, 'replayed', true, 'match_run_id', r.outcome ->> 'match_run_id');
  end if;
  if exists (select 1 from public.agent_runs n where n.organization_id = r.organization_id and n.agent_id = r.agent_id and n.lead_id = r.lead_id
               and n.status in ('received', 'retry_scheduled') and n.received_at > r.received_at) then
    update public.agent_runs set status = 'succeeded', outcome = jsonb_build_object('action', 'superseded'), completed_at = now() where id = r.id;
    return jsonb_build_object('status', 'superseded', 'run_id', r.id);
  end if;
  update public.agent_runs set attempt_count = attempt_count + 1, started_at = coalesce(started_at, now()) where id = r.id returning * into r;
  begin
    res := private.pm_execute(r);
  exception when others then
    -- Nothing from the failed attempt is kept (no partial run, no "no matches"); the previous result stays current.
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
  update public.agent_runs set status = 'succeeded', outcome = res, completed_at = now(), next_attempt_at = null, error_category = null, error_message = null,
    duration_ms = (extract(epoch from clock_timestamp() - t0) * 1000)::int
  where id = r.id;
  return res || jsonb_build_object('run_id', r.id);
end;
$$;

-- Outbox consumer + processing of due runs + expiry of explanation steps that never finished.
create or replace function public.property_matching_tick(p_limit int default 25)
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
  for e in select * from public.outbox_claim('property_matching_agent', array['lead.qualification.completed'], 50) loop
    lid := case when (e.payload ->> 'lead_id') ~ '^[0-9a-f-]{36}$' then (e.payload ->> 'lead_id')::uuid end;
    -- The event's org is trusted (outbox rows are written only by SQL); the lead must belong to it.
    if lid is not null and exists (select 1 from public.leads where id = lid and organization_id = e.organization_id) then
      perform private.pm_enqueue(e.organization_id, lid, e.event_type, 'evt:' || e.id::text, 'integration', e.correlation_id);
    end if;
    perform public.outbox_ack(e.id, 'property_matching_agent', true);
    consumed := consumed + 1;
  end loop;

  for rid in
    select ar.id from public.agent_runs ar
    where ar.agent_id = 'property_matching_agent' and ar.status in ('received', 'retry_scheduled') and (ar.next_attempt_at is null or ar.next_attempt_at <= now())
    order by ar.received_at
    limit least(greatest(p_limit, 1), 200)
    for update skip locked
  loop
    perform public.property_matching_process(rid);
    processed := processed + 1;
  end loop;

  update public.property_match_runs set explanation_status = 'failed', model_meta = coalesce(model_meta, '{}') || '{"outcome": "timeout"}'
  where explanation_status = 'pending' and created_at < now() - interval '15 minutes';
  return jsonb_build_object('consumed', consumed, 'processed', processed);
end;
$$;

-- ───────────────────────── Claude explanations (service role) ─────────────────────────

-- Runs whose recommendations wait for a summary. Only display facts and a sanitized description excerpt:
-- no lead identity, no address line, no owner, no phone numbers or emails.
create or replace function public.property_matching_explain_claim(p_limit int default 3)
returns table (match_run_id uuid, criteria jsonb, matches jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with picked as (
    select pr.id from public.property_match_runs pr
    where pr.explanation_status = 'pending' and pr.is_current and (pr.explain_lease_until is null or pr.explain_lease_until < now())
    order by pr.created_at limit least(greatest(p_limit, 1), 10)
    for update skip locked
  ), leased as (
    update public.property_match_runs pr set explain_lease_until = now() + interval '3 minutes' from picked where pr.id = picked.id
    returning pr.id, pr.criteria
  )
  select leased.id,
    jsonb_strip_nulls(jsonb_build_object('intent', leased.criteria -> 'prepared' ->> 'intent', 'locations', leased.criteria -> 'prepared' ->> 'loc_label',
      'budget_min', leased.criteria -> 'prepared' -> 'bmin', 'budget_max', leased.criteria -> 'prepared' -> 'bmax', 'currency', leased.criteria -> 'prepared' ->> 'bcur',
      'property_type', leased.criteria -> 'prepared' ->> 'ptype', 'bedrooms', leased.criteria -> 'prepared' -> 'beds', 'amenities', leased.criteria -> 'prepared' -> 'amen_labels')),
    (select coalesce(jsonb_agg(jsonb_build_object('match_id', m.id, 'rank', m.rank, 'title', p.title, 'property_type', p.property_type, 'listing_type', p.listing_type,
       'locality', p.locality, 'city', p.city, 'price', p.price, 'currency', p.currency, 'bedrooms', p.bedrooms, 'bathrooms', p.bathrooms,
       'area', p.area_value, 'area_unit', p.area_unit, 'furnishing', p.furnishing, 'amenities', p.amenities,
       'strengths', (select coalesce(jsonb_agg(s ->> 'text'), '[]') from jsonb_array_elements(m.strengths) s),
       'tradeoffs', (select coalesce(jsonb_agg(s ->> 'text'), '[]') from jsonb_array_elements(m.tradeoffs) s),
       'caveats', (select coalesce(jsonb_agg(s ->> 'text'), '[]') from jsonb_array_elements(m.caveats) s),
       'description', left(regexp_replace(regexp_replace(coalesce(p.description, ''), '[^\s@]+@[^\s@]+', '[email removed]', 'g'), '\+?[0-9][0-9 ()-]{6,}[0-9]', '[number removed]', 'g'), 600))
       order by m.rank), '[]')
     from public.property_matches m join public.properties p on p.id = m.property_id and p.organization_id = m.organization_id
     where m.match_run_id = leased.id and m.status <> 'invalidated')
  from leased;
end;
$$;

-- Stores validated summaries (already checked by the worker against the facts), or the failure.
create or replace function public.property_matching_attach_explanations(p_match_run uuid, p_result jsonb, p_meta jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  pr public.property_match_runs;
  meta jsonb;
  x jsonb;
  accepted int := 0;
begin
  select * into pr from public.property_match_runs where id = p_match_run for update;
  if pr.id is null then perform private.fail('NOT_FOUND', 'Run not found'); end if;
  if pr.explanation_status <> 'pending' then return; end if;
  meta := (select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each(case when jsonb_typeof(p_meta) = 'object' then p_meta else '{}' end)
           where key in ('model', 'prompt_version', 'latency_ms', 'input_tokens', 'output_tokens', 'outcome', 'dropped') and jsonb_typeof(value) in ('string', 'number'));
  if p_result is not null and jsonb_typeof(p_result -> 'explanations') = 'array' and octet_length(p_result::text) <= 32768 then
    for x in select y from jsonb_array_elements(p_result -> 'explanations') y loop
      continue when jsonb_typeof(x) <> 'object' or coalesce(x ->> 'match_id', '') !~ '^[0-9a-f-]{36}$'
        or char_length(coalesce(x ->> 'summary', '')) not between 10 and 400
        or (x ->> 'summary') ~* '\m(perfect|guarantee[ds]?|best investment|famil(y|ies)|children|kids|bachelors?|caste|religio\w*|communit(y|ies))\M';
      update public.property_matches set ai_summary = trim(x ->> 'summary')
      where id = (x ->> 'match_id')::uuid and match_run_id = pr.id and organization_id = pr.organization_id;
      if found then accepted := accepted + 1; end if;
    end loop;
  end if;
  update public.property_match_runs set explain_lease_until = null, model_meta = meta,
    explanation_status = case when accepted > 0 then 'succeeded' when meta ->> 'outcome' = 'not_configured' then 'not_configured' else 'failed' end
  where id = pr.id;
end;
$$;

create or replace function public.property_matching_worker_secret_ok(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_secret is not null and length(p_secret) >= 32
     and exists (select 1 from vault.decrypted_secrets where name = 'property_matching_worker_secret' and decrypted_secret = p_secret);
$$;

-- ───────────────────────── listing changes → recommendation lifecycle ─────────────────────────

create or replace function private.pm_property_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status or new.listing_type is distinct from old.listing_type then
    if new.status <> 'active' or new.listing_type is distinct from old.listing_type then
      update public.property_matches m set status = 'invalidated', invalidated_at = now(),
        status_reason = case when new.status <> 'active' then 'LISTING_UNAVAILABLE' else 'TRANSACTION_TYPE_MISMATCH' end
      where m.property_id = new.id and m.status not in ('rejected', 'invalidated')
        and exists (select 1 from public.property_match_runs pr where pr.id = m.match_run_id and pr.is_current);
    end if;
  end if;
  if new.price is distinct from old.price or new.currency is distinct from old.currency then
    update public.property_matches m set price_changed = true
    where m.property_id = new.id and m.status not in ('rejected', 'invalidated')
      and exists (select 1 from public.property_match_runs pr where pr.id = m.match_run_id and pr.is_current);
  end if;
  return null;
end;
$$;
create trigger properties_match_lifecycle after update of status, listing_type, price, currency on public.properties
  for each row execute function private.pm_property_changed();

create or replace function private.pm_appointment_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.lead_id is not null and new.property_id is not null then
    update public.property_matches m set status = 'appointment_requested'
    where m.lead_id = new.lead_id and m.property_id = new.property_id and m.organization_id = new.organization_id
      and m.status in ('recommended', 'viewed', 'shortlisted', 'shared')
      and exists (select 1 from public.property_match_runs pr where pr.id = m.match_run_id and pr.is_current);
  end if;
  return null;
end;
$$;
create trigger appointments_match_lifecycle after insert on public.appointments for each row execute function private.pm_appointment_created();

-- ───────────────────────── user-facing RPCs ─────────────────────────

create or replace function public.property_matching_request(p_lead uuid, p_idempotency_key text)
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
  if not private.pm_can_act(l.organization_id, l.assigned_to) then perform private.fail('FORBIDDEN', 'You cannot run matching for this lead'); end if;
  if l.archived_at is not null or l.status in ('won', 'lost') then perform private.fail('VALIDATION_ERROR', 'Closed leads are not matched'); end if;
  if (select count(*) from public.agent_runs where organization_id = l.organization_id and agent_id = 'property_matching_agent' and lead_id = l.id
        and received_at > now() - interval '1 hour' and trigger_event = 'property_matching.requested') >= 10 then
    perform private.fail('RATE_LIMITED', 'Too many matching requests for this lead; try again later');
  end if;
  rid := private.pm_enqueue(l.organization_id, l.id, 'property_matching.requested', 'manual:' || p_idempotency_key, 'manual', null);
  perform private.write_audit(l.organization_id, 'property_matching.requested', 'leads', l.id, jsonb_build_object('run', rid));
  return jsonb_build_object('run_id', rid, 'status', (select status from public.agent_runs where id = rid));
end;
$$;

-- Read model for the lead screen. Display-safe listing fields only (no address line, owner or internal notes).
create or replace function public.lead_property_matches(p_lead uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l public.leads;
  pr public.property_match_runs;
  r public.agent_runs;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null or not public.has_perm(l.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
  select * into pr from public.property_match_runs where lead_id = l.id and organization_id = l.organization_id and is_current;
  select * into r from public.agent_runs where organization_id = l.organization_id and agent_id = 'property_matching_agent' and lead_id = l.id order by received_at desc limit 1;
  return jsonb_build_object(
    'current', case when pr.id is null then null else to_jsonb(pr) - 'organization_id' - 'explain_lease_until' end,
    'outdated', pr.id is not null and pr.qualification_id is distinct from l.qualification_id and l.qualification_id is not null,
    'matches', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'rank', m.rank, 'score', m.score, 'band', m.band, 'breakdown', m.breakdown,
        'strengths', m.strengths, 'tradeoffs', m.tradeoffs, 'caveats', m.caveats, 'availability', m.availability, 'budget_fit', m.budget_fit,
        'explanation', m.explanation, 'ai_summary', m.ai_summary, 'status', m.status, 'status_reason', m.status_reason, 'decided_at', m.decided_at,
        'price_changed', m.price_changed or p.price is distinct from (m.snapshot ->> 'price')::numeric, 'snapshot', m.snapshot,
        'property', jsonb_build_object('id', p.id, 'reference_code', p.reference_code, 'title', p.title, 'property_type', p.property_type, 'listing_type', p.listing_type,
          'status', p.status, 'price', p.price, 'currency', p.currency, 'bedrooms', p.bedrooms, 'bathrooms', p.bathrooms, 'area_value', p.area_value, 'area_unit', p.area_unit,
          'furnishing', p.furnishing, 'locality', p.locality, 'city', p.city, 'amenities', p.amenities, 'verified_at', p.verified_at, 'updated_at', p.updated_at,
          'cover_image_path', p.cover_image_path)) order by m.rank), '[]')
      from public.property_matches m join public.properties p on p.id = m.property_id and p.organization_id = m.organization_id
      where m.match_run_id = pr.id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'status', h.status, 'recommended_count', h.recommended_count, 'eligible_count', h.eligible_count,
        'candidate_count', h.candidate_count, 'trigger', h.trigger, 'created_at', h.created_at) order by h.created_at desc), '[]')
      from (select * from public.property_match_runs where lead_id = l.id and organization_id = l.organization_id order by created_at desc limit 10) h),
    'run', case when r.id is null then null else jsonb_build_object('id', r.id, 'status', r.status, 'received_at', r.received_at, 'completed_at', r.completed_at,
      'attempts', r.attempt_count, 'error_category', r.error_category) end,
    'can_act', private.pm_can_act(l.organization_id, l.assigned_to));
end;
$$;

-- People manage recommendations. shortlist / share re-check the listing against the run's criteria first.
create or replace function public.property_match_action(p_match uuid, p_action text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.property_matches;
  pr public.property_match_runs;
  l public.leads;
  p public.properties;
  e jsonb;
  who text;
begin
  select * into m from public.property_matches where id = p_match for update;
  if m.id is null or not public.has_perm(m.organization_id, 'leads.view') then perform private.fail('NOT_FOUND', 'Recommendation not found'); end if;
  if p_action not in ('view', 'shortlist', 'reject', 'share', 'restore', 'request_review') then perform private.fail('VALIDATION_ERROR', 'Invalid action'); end if;
  select * into pr from public.property_match_runs where id = m.match_run_id;
  select * into l from public.leads where id = m.lead_id and organization_id = m.organization_id;
  if p_action = 'view' then
    if m.status = 'recommended' and pr.is_current then update public.property_matches set status = 'viewed' where id = m.id returning * into m; end if;
    return jsonb_build_object('status', m.status);
  end if;
  if not private.pm_can_act(m.organization_id, l.assigned_to) then perform private.fail('FORBIDDEN', 'You cannot change recommendations for this lead'); end if;
  if not pr.is_current then perform private.fail('CONFLICT', 'A newer matching run exists; use its recommendations'); end if;
  if m.status = 'invalidated' and p_action <> 'request_review' then perform private.fail('STALE_MATCH', 'This listing changed after matching; re-run matching'); end if;
  if char_length(coalesce(p_note, '')) > 300 then perform private.fail('VALIDATION_ERROR', 'Keep the note under 300 characters'); end if;
  select * into p from public.properties where id = m.property_id and organization_id = m.organization_id;

  if p_action in ('shortlist', 'share') then
    -- Revalidate against the current listing; never shortlist or share something that no longer fits.
    e := private.pm_evaluate(pr.criteria -> 'prepared', to_jsonb(p), private.pm_rules(m.organization_id), now());
    if p.id is null or not (e ->> 'eligible')::boolean then
      update public.property_matches set status = 'invalidated', invalidated_at = now(), status_reason = coalesce(e ->> 'reject', 'LISTING_UNAVAILABLE') where id = m.id;
      return jsonb_build_object('status', 'invalidated', 'reason', coalesce(e ->> 'reject', 'LISTING_UNAVAILABLE'));
    end if;
    update public.property_matches set score = (e ->> 'score')::int, band = e ->> 'band', breakdown = e -> 'breakdown', strengths = e -> 'strengths',
      tradeoffs = e -> 'tradeoffs', caveats = e -> 'caveats', availability = e ->> 'availability', budget_fit = e ->> 'budget_fit', explanation = private.pm_explain(e),
      snapshot = jsonb_build_object('price', p.price, 'currency', p.currency, 'status', p.status, 'listing_type', p.listing_type, 'verified_at', p.verified_at, 'updated_at', p.updated_at),
      price_changed = false
    where id = m.id;
  end if;

  if p_action = 'request_review' then
    if not exists (select 1 from public.tasks t where t.related_lead_id = l.id and t.status in ('open', 'in_progress') and t.title like 'Review property matches%') then
      select display_name into who from public.contacts where id = l.contact_id;
      insert into public.tasks (organization_id, title, description, priority, due_at, assigned_to, related_lead_id, related_property_id, source)
      values (m.organization_id, left('Review property matches: ' || coalesce(who, 'lead'), 200), coalesce(nullif(trim(p_note), ''), 'Review the recommended listings for this lead.'),
        'normal', now() + interval '1 day', case when private.intake_eligible(m.organization_id, l.assigned_to) then l.assigned_to end, l.id, m.property_id, 'manual');
    end if;
  else
    update public.property_matches set
      status = case p_action when 'shortlist' then 'shortlisted' when 'reject' then 'rejected' when 'share' then 'shared' else 'recommended' end,
      status_reason = case when p_action = 'reject' then nullif(trim(p_note), '') else null end,
      decided_by = auth.uid(), decided_at = now()
    where id = m.id returning * into m;
  end if;

  if p_action = 'share' then
    -- Records that a person shared it through their own channel. Agent 04 sends nothing.
    perform private.add_activity(m.organization_id, l.id, l.contact_id, null, 'property_sent', left(format('Shared %s (%s)', p.title, p.reference_code), 300), nullif(trim(p_note), ''));
    update public.leads set status = 'matching' where id = l.id and status in ('contacted', 'qualified');
  end if;
  perform private.write_audit(m.organization_id, 'property_match.' || p_action, 'property_matches', m.id, jsonb_build_object('property', m.property_id, 'lead', l.id));
  return jsonb_build_object('status', (select status from public.property_matches where id = m.id));
end;
$$;

create or replace function public.property_matching_settings_save(p_org uuid, p_rules jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  w jsonb := p_rules -> 'weights';
  ver int;
begin
  if not public.has_perm(p_org, 'settings.manage') then perform private.fail('FORBIDDEN', 'You cannot change matching rules'); end if;
  if jsonb_typeof(p_rules) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_rules) k where k not in ('weights', 'min_score', 'good_min', 'strong_min', 'result_limit', 'max_candidates',
          'budget_flex_pct', 'freshness_days', 'unverified_policy', 'location_flexible', 'location_aliases', 'llm_explanations'))
     or (w is not null and (jsonb_typeof(w) <> 'object'
         or exists (select 1 from jsonb_each(w) e where e.key not in ('location', 'budget', 'property_type', 'bedrooms', 'amenities', 'availability')
                    or jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric not between 0 and 100)
         or (select sum((e.value #>> '{}')::numeric) from jsonb_each(w) e) <= 0))
     or (p_rules ? 'min_score' and coalesce((p_rules ->> 'min_score')::int, -1) not between 0 and 100)
     or (p_rules ? 'good_min' and coalesce((p_rules ->> 'good_min')::int, -1) not between 1 and 100)
     or (p_rules ? 'strong_min' and coalesce((p_rules ->> 'strong_min')::int, -1) not between 1 and 100)
     or coalesce((p_rules ->> 'min_score')::int, 50) > coalesce((p_rules ->> 'good_min')::int, 70)
     or coalesce((p_rules ->> 'good_min')::int, 70) > coalesce((p_rules ->> 'strong_min')::int, 85)
     or (p_rules ? 'result_limit' and coalesce((p_rules ->> 'result_limit')::int, 0) not between 1 and 25)
     or (p_rules ? 'max_candidates' and coalesce((p_rules ->> 'max_candidates')::int, 0) not between 50 and 2000)
     or (p_rules ? 'budget_flex_pct' and coalesce((p_rules ->> 'budget_flex_pct')::numeric, -1) not between 0 and 50)
     or (p_rules ? 'freshness_days' and coalesce((p_rules ->> 'freshness_days')::int, 0) not between 1 and 365)
     or (p_rules ? 'unverified_policy' and coalesce(p_rules ->> 'unverified_policy', '') not in ('flag', 'exclude'))
     or (p_rules ? 'location_flexible' and jsonb_typeof(p_rules -> 'location_flexible') <> 'boolean')
     or (p_rules ? 'llm_explanations' and jsonb_typeof(p_rules -> 'llm_explanations') <> 'boolean')
     or (p_rules ? 'location_aliases' and (jsonb_typeof(p_rules -> 'location_aliases') <> 'object'
         or (select count(*) from jsonb_object_keys(p_rules -> 'location_aliases')) > 200
         or exists (select 1 from jsonb_each(p_rules -> 'location_aliases') e where jsonb_typeof(e.value) <> 'string'
                    or char_length(e.key) not between 1 and 120 or char_length(e.value #>> '{}') not between 1 and 120)))
  then
    perform private.fail('VALIDATION_ERROR', 'Matching rules are invalid');
  end if;
  insert into public.property_matching_settings (organization_id, rules, updated_by) values (p_org, p_rules, auth.uid())
  on conflict (organization_id) do update set rules = excluded.rules, version = public.property_matching_settings.version + 1, updated_by = excluded.updated_by
  returning version into ver;
  return ver;
exception
  when invalid_text_representation then perform private.fail('VALIDATION_ERROR', 'Matching rules are invalid'); return null;
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke all on function private.pm_default_rules(), private.pm_rules(uuid), private.pm_norm(text), private.pm_loc(text, jsonb), private.pm_category(text),
  private.pm_money(numeric, text), private.pm_criteria(uuid), private.pm_prepare(jsonb, jsonb), private.pm_evaluate(jsonb, jsonb, jsonb, timestamptz),
  private.pm_explain(jsonb), private.pm_can_act(uuid, uuid), private.pm_enqueue(uuid, uuid, text, text, text, uuid), private.pm_execute(public.agent_runs),
  private.pm_property_changed(), private.pm_appointment_created()
  from public, anon, authenticated;
revoke execute on function public.property_matching_process(uuid), public.property_matching_tick(int), public.property_matching_explain_claim(int),
  public.property_matching_attach_explanations(uuid, jsonb, jsonb), public.property_matching_worker_secret_ok(text) from public, anon, authenticated;
grant execute on function public.property_matching_process(uuid), public.property_matching_tick(int), public.property_matching_explain_claim(int),
  public.property_matching_attach_explanations(uuid, jsonb, jsonb), public.property_matching_worker_secret_ok(text) to service_role;
revoke execute on function public.property_matching_request(uuid, text), public.lead_property_matches(uuid), public.property_match_action(uuid, text, text),
  public.property_matching_settings_save(uuid, jsonb) from public, anon;
grant execute on function public.property_matching_request(uuid, text), public.lead_property_matches(uuid), public.property_match_action(uuid, text, text),
  public.property_matching_settings_save(uuid, jsonb) to authenticated;

-- ───────────────────────── schedules ─────────────────────────
-- property-matching-tick: pure SQL (outbox consumer + deterministic matching).
-- property-matching-worker: pg_net → Edge Function for the optional Claude summaries; inactive until 'property_matching_worker_url' is in Vault.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'property_matching_worker_secret') then
    perform vault.create_secret(private.random_token() || private.random_token(), 'property_matching_worker_secret', 'Shared secret for the property-matching-worker Edge Function');
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if not exists (select 1 from cron.job where jobname = 'property-matching-tick') then
      perform cron.schedule('property-matching-tick', '* * * * *', 'select public.property_matching_tick(25)');
    end if;
    if exists (select 1 from pg_available_extensions where name = 'pg_net') and not exists (select 1 from cron.job where jobname = 'property-matching-worker') then
      create extension if not exists pg_net with schema extensions;
      perform cron.schedule('property-matching-worker', '* * * * *', $job$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'property_matching_worker_url'),
          headers := jsonb_build_object('Content-Type', 'application/json',
            'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'property_matching_worker_secret')),
          body := '{}'::jsonb, timeout_milliseconds := 55000)
        where exists (select 1 from vault.decrypted_secrets where name = 'property_matching_worker_url')
      $job$);
    end if;
  end if;
end;
$$;
