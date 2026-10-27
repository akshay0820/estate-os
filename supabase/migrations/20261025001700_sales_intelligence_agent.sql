-- Estate OS · 0017 · Agent 08 — Sales Intelligence Agent (sales_intelligence_agent)
-- A semantic metric layer over the persisted CRM (leads, status history, calls, follow-ups, matches, appointments, deals,
-- commissions) computed deterministically in SQL; cohort funnel with maturity; source and team breakdowns; daily anomaly
-- rules and findings with evidence; forecast runs with backtesting; report runs; recommendation snapshots for Claude;
-- a validated query layer for the natural-language analyst. Agent 07's data quality context is attached as caveats.
-- Additive only: new tables and functions. No existing table or function is changed.

-- ───────────────────────── tables ─────────────────────────

create table public.sales_intelligence_settings (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  rules jsonb not null default '{}',
  version integer not null default 1,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger sales_intelligence_settings_updated_at before update on public.sales_intelligence_settings for each row execute function public.set_updated_at();
create trigger sales_intelligence_settings_audit after insert or update on public.sales_intelligence_settings for each row execute function private.audit_row();

-- Exact analytical context given to the model, so every recommendation can be traced to the numbers it saw.
create table public.sales_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null check (kind in ('recommendation_context')),
  params jsonb not null default '{}',
  data jsonb not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index sales_snapshots_org_idx on public.sales_snapshots (organization_id, created_at desc);

create table public.sales_insights (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null check (kind in ('anomaly', 'finding', 'recommendation')),
  rule_id text check (rule_id ~ '^[a-z_]+\.[a-z_]+$'),
  category text not null check (category in ('lead_response', 'qualification', 'lead_source', 'follow_up', 'appointments', 'property_matching', 'workload',
    'pipeline', 'data_quality', 'forecast', 'operations', 'lead_intake')),
  priority text not null check (priority in ('low', 'medium', 'high')),
  status text not null default 'new' check (status in ('new', 'reviewed', 'accepted', 'dismissed', 'in_progress', 'completed', 'expired')),
  title text not null check (char_length(title) <= 160),
  summary text not null check (char_length(summary) <= 600),
  observation text check (char_length(observation) <= 600),
  interpretation text check (char_length(interpretation) <= 600),
  recommended_action text check (char_length(recommended_action) <= 600),
  expected_direction text check (char_length(expected_direction) <= 300),
  -- Rule, measured values, windows and sample sizes (or the snapshot metrics a recommendation cites).
  evidence jsonb not null default '{}',
  supporting_metrics jsonb not null default '[]',
  assumptions jsonb not null default '[]',
  limitations jsonb not null default '[]',
  observation_from timestamptz,
  observation_to timestamptz,
  generated_by text not null check (generated_by in ('rules', 'ai')),
  model text check (char_length(model) <= 80),
  prompt_version text check (char_length(prompt_version) <= 60),
  snapshot_id uuid references public.sales_snapshots (id) on delete set null,
  related_insight_ids uuid[] not null default '{}',
  fingerprint text not null check (char_length(fingerprint) <= 300),
  occurrence integer not null default 1,
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  feedback_note text check (char_length(feedback_note) <= 1000),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, fingerprint)
);
create index sales_insights_org_idx on public.sales_insights (organization_id, status, priority, last_detected_at desc);
create trigger sales_insights_updated_at before update on public.sales_insights for each row execute function public.set_updated_at();

create table public.sales_forecast_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  status text not null default 'queued' check (status in ('queued', 'completed', 'insufficient_data', 'failed')),
  horizon_start date not null,
  horizon_end date not null,
  requested_by uuid references public.profiles (id) on delete set null,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 120),
  method text,
  -- Per currency: forecast, scenario bounds, commission forecast, counts, win rate and its history.
  results jsonb not null default '{}',
  assumptions jsonb not null default '[]',
  caveats jsonb not null default '[]',
  computed_at timestamptz,
  actuals jsonb,
  abs_error jsonb,
  evaluated_at timestamptz,
  error text check (char_length(error) <= 300),
  created_at timestamptz not null default now(),
  constraint sales_forecast_runs_order check (horizon_start <= horizon_end),
  unique (organization_id, idempotency_key)
);
create index sales_forecast_runs_org_idx on public.sales_forecast_runs (organization_id, created_at desc);
create index sales_forecast_runs_due_idx on public.sales_forecast_runs (status, horizon_end) where evaluated_at is null;

create table public.sales_report_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null check (kind in ('executive_summary', 'lead_sources', 'funnel', 'team', 'appointments_follow_ups', 'pipeline_forecast', 'data_quality_impact', 'recommendations')),
  status text not null default 'queued' check (status in ('queued', 'completed', 'failed')),
  period_from timestamptz not null,
  period_to timestamptz not null,
  filters jsonb not null default '{}',
  -- Permissions of the requester at request time decide what the report may contain.
  includes_team boolean not null default false,
  includes_financials boolean not null default false,
  requested_by uuid references public.profiles (id) on delete set null,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 120),
  result jsonb,
  error text check (char_length(error) <= 300),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (organization_id, idempotency_key)
);
create index sales_report_runs_org_idx on public.sales_report_runs (organization_id, created_at desc);

-- Validated specs and outcomes only; the question text is not stored.
create table public.sales_analyst_queries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid references public.profiles (id) on delete set null,
  spec jsonb not null,
  status text not null check (status in ('answered', 'forbidden', 'invalid', 'unavailable')),
  created_at timestamptz not null default now()
);
create index sales_analyst_queries_org_idx on public.sales_analyst_queries (organization_id, created_at desc);

create table public.sales_daily_evaluations (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  day date not null,
  result jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (organization_id, day)
);

alter table public.sales_intelligence_settings enable row level security;
alter table public.sales_snapshots enable row level security;
alter table public.sales_insights enable row level security;
alter table public.sales_forecast_runs enable row level security;
alter table public.sales_report_runs enable row level security;
alter table public.sales_analyst_queries enable row level security;
alter table public.sales_daily_evaluations enable row level security;
create policy sales_intelligence_settings_read on public.sales_intelligence_settings for select to authenticated using (public.has_perm(organization_id, 'reports.view'));
create policy sales_snapshots_read on public.sales_snapshots for select to authenticated using (public.has_perm(organization_id, 'reports.view'));
create policy sales_insights_read on public.sales_insights for select to authenticated using (public.has_perm(organization_id, 'reports.view'));
create policy sales_forecast_runs_read on public.sales_forecast_runs for select to authenticated using (public.has_perm(organization_id, 'finance.view'));
create policy sales_report_runs_read on public.sales_report_runs for select to authenticated
  using (public.has_perm(organization_id, 'reports.view') and (not includes_financials or public.has_perm(organization_id, 'finance.view'))
         and (not includes_team or public.has_perm(organization_id, 'team.view')));
create policy sales_analyst_queries_read on public.sales_analyst_queries for select to authenticated using (public.has_perm(organization_id, 'audit.view'));
create policy sales_daily_evaluations_read on public.sales_daily_evaluations for select to authenticated using (public.has_perm(organization_id, 'reports.view'));
revoke all on public.sales_intelligence_settings, public.sales_snapshots, public.sales_insights, public.sales_forecast_runs, public.sales_report_runs,
  public.sales_analyst_queries, public.sales_daily_evaluations from anon;
revoke insert, update, delete, truncate on public.sales_intelligence_settings, public.sales_snapshots, public.sales_insights, public.sales_forecast_runs,
  public.sales_report_runs, public.sales_analyst_queries, public.sales_daily_evaluations from authenticated;

-- ───────────────────────── settings & catalogue ─────────────────────────

create or replace function private.si_default_rules()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select '{
    "min_sample": 10, "maturity_days": 30, "min_closed_deals": 10, "stage_probabilities": null, "targets": {},
    "no_next_action_share": 0.2, "attendance_floor": 0.7,
    "anomaly": {"baseline_weeks": 8, "min_baseline_weeks": 4, "z": 2, "intake_drop_pct": 30, "intake_spike_pct": 50, "min_intake": 10,
                "rate_min_n": 30, "cancel_min_n": 20, "response_ratio": 1.5, "response_min_n": 20}
  }'::jsonb;
$$;

create or replace function private.si_rules(org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.si_default_rules() || coalesce(s.rules, '{}') || jsonb_build_object('version', coalesce(s.version, 0))
  from (select 1) x left join public.sales_intelligence_settings s on s.organization_id = org;
$$;

-- The semantic layer: every metric, its unit, time basis, allowed dimensions and permission.
create or replace function private.si_catalogue()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with d(fam, dims) as (values
    ('cohort', '["source","assignee","property_type","transaction","lead_type","day","week","month"]'::jsonb),
    ('lead_snapshot', '["source","assignee","property_type","transaction","lead_type"]'::jsonb),
    ('appointment', '["source","assignee","property_type","transaction","appointment_type","day","week","month"]'::jsonb),
    ('activity', '["source","assignee","day","week","month"]'::jsonb),
    ('deal', '["source","assignee","day","week","month"]'::jsonb),
    ('deal_snapshot', '["source","assignee"]'::jsonb))
  select jsonb_object_agg(m.id, jsonb_build_object('label', m.label, 'unit', m.unit, 'basis', m.basis, 'perm', m.perm, 'definition', m.def,
    'dims', (select dims from d where d.fam = m.fam)))
  from (values
    ('leads_created', 'New leads', 'count', 'cohort', 'cohort', 'reports.view', 'Leads created in the period (archived and merged duplicates excluded)'),
    ('leads_contacted', 'Leads contacted', 'count', 'cohort', 'cohort', 'reports.view', 'Leads created in the period that reached Contacted or later, or had a connected call'),
    ('leads_qualified', 'Qualified leads', 'count', 'cohort', 'cohort', 'reports.view', 'Leads created in the period that reached Qualified or later'),
    ('qualification_rate', 'Lead → qualified', 'rate', 'cohort', 'cohort', 'reports.view', 'Qualified leads ÷ leads created in the period (same cohort)'),
    ('leads_matched', 'Leads with matches', 'count', 'cohort', 'cohort', 'reports.view', 'Leads created in the period with at least one recommended property'),
    ('qualified_to_appointment_rate', 'Qualified → appointment', 'rate', 'cohort', 'cohort', 'reports.view', 'Qualified cohort leads with a confirmed appointment ÷ qualified cohort leads'),
    ('median_first_response_minutes', 'First response (median)', 'minutes', 'cohort', 'cohort', 'reports.view', 'Lead created → first recorded move out of New, by a person or an agent'),
    ('median_first_call_minutes', 'First call attempt (median)', 'minutes', 'cohort', 'cohort', 'reports.view', 'Lead created → first initiated call'),
    ('median_first_connection_minutes', 'First connected call (median)', 'minutes', 'cohort', 'cohort', 'reports.view', 'Lead created → first connected call'),
    ('median_days_to_qualified', 'Time to qualified (median)', 'days', 'cohort', 'cohort', 'reports.view', 'Lead created → qualified'),
    ('leads_awaiting_qualification', 'Awaiting qualification', 'count', 'snapshot', 'lead_snapshot', 'reports.view', 'Open leads with no qualification yet or one still in progress (now)'),
    ('leads_human_review', 'Needs human review', 'count', 'snapshot', 'lead_snapshot', 'reports.view', 'Open leads whose current qualification awaits a person''s review (now)'),
    ('leads_no_next_action', 'No next action', 'count', 'snapshot', 'lead_snapshot', 'reports.view', 'Open leads with no future follow-up date, no active appointment, no active follow-up and no open task (now)'),
    ('leads_follow_up_overdue', 'Follow-up overdue', 'count', 'snapshot', 'lead_snapshot', 'reports.view', 'Open leads whose next follow-up date has passed (now)'),
    ('appointments_booked', 'Appointments booked', 'count', 'period', 'appointment', 'reports.view', 'Appointments created in the period that were confirmed; requests and proposals are not bookings'),
    ('appointments_completed', 'Appointments completed', 'count', 'period', 'appointment', 'reports.view', 'Appointments starting in the period marked completed'),
    ('appointments_no_show', 'No-shows', 'count', 'period', 'appointment', 'reports.view', 'Appointments starting in the period marked no-show'),
    ('appointments_cancelled', 'Appointments cancelled', 'count', 'period', 'appointment', 'reports.view', 'Appointments starting in the period that were cancelled'),
    ('appointments_outcome_unknown', 'Outcome not recorded', 'count', 'period', 'appointment', 'reports.view', 'Confirmed appointments that ended in the period without an outcome'),
    ('attendance_rate', 'Attendance rate', 'rate', 'period', 'appointment', 'reports.view', 'Completed ÷ (completed + no-show) for appointments starting in the period; unknown outcomes excluded'),
    ('calls_attempted', 'Calls attempted', 'count', 'period', 'activity', 'reports.view', 'AI calls initiated in the period (blocked requests excluded)'),
    ('calls_connected', 'Calls connected', 'count', 'period', 'activity', 'reports.view', 'AI calls initiated in the period with outcome connected'),
    ('follow_ups_sent', 'Follow-ups sent', 'count', 'period', 'activity', 'reports.view', 'Messages sent in the period (provider-accepted or recorded as sent by a person)'),
    ('follow_ups_delivered', 'Follow-ups delivered', 'count', 'period', 'activity', 'reports.view', 'Messages with a provider delivery receipt in the period'),
    ('follow_ups_failed', 'Follow-ups failed', 'count', 'period', 'activity', 'reports.view', 'Messages created in the period that failed'),
    ('deals_opened', 'Deals opened', 'count', 'period', 'deal', 'reports.view', 'Deals created in the period'),
    ('deals_won', 'Deals won', 'count', 'period', 'deal', 'reports.view', 'Deals won with a close date in the period'),
    ('deal_win_rate', 'Deal win rate', 'rate', 'period', 'deal', 'reports.view', 'Won ÷ (won + lost) for deals closed in the period'),
    ('closed_deal_value', 'Closed transaction value', 'money', 'period', 'deal', 'finance.view', 'Sum of expected value of deals won in the period (transaction value, not agency revenue), per currency'),
    ('average_deal_value', 'Average won deal value', 'money', 'period', 'deal', 'finance.view', 'Average expected value of deals won in the period, per currency'),
    ('commission_revenue', 'Commission revenue', 'money', 'period', 'deal', 'finance.view', 'Approved, payable or paid commission on deals won in the period, per currency'),
    ('open_deals', 'Open deals', 'count', 'snapshot', 'deal_snapshot', 'reports.view', 'Deals not won or lost (now)'),
    ('pipeline_value', 'Pipeline value', 'money', 'snapshot', 'deal_snapshot', 'reports.view', 'Sum of expected value of open deals, per currency (now)')
  ) as m(id, label, unit, basis, fam, perm, def);
$$;

create or replace function public.si_metric_catalogue()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.si_catalogue();
$$;

-- ───────────────────────── compute ─────────────────────────

create or replace function private.si_key(dim text, tz text, p_source text, p_owner uuid, p_ptype text, p_trans text, p_ltype text, p_atype text, ts timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case dim
    when 'source' then coalesce(p_source, '(none)') when 'assignee' then coalesce(p_owner::text, 'unassigned')
    when 'property_type' then coalesce(p_ptype, '(not set)') when 'transaction' then coalesce(p_trans, '(not set)')
    when 'lead_type' then coalesce(p_ltype, '(not set)') when 'appointment_type' then coalesce(p_atype, '(none)')
    when 'day' then to_char(date_trunc('day', ts at time zone tz), 'YYYY-MM-DD')
    when 'week' then to_char(date_trunc('week', ts at time zone tz), 'YYYY-MM-DD')
    when 'month' then to_char(date_trunc('month', ts at time zone tz), 'YYYY-MM-DD')
    else 'all' end;
$$;

create or replace function private.si_lead_ok(l public.leads, f jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select l.id is not null and l.archived_at is null
    and (f ->> 'source' is null or l.source = f ->> 'source')
    and (f ->> 'property_type' is null or l.desired_property_type = f ->> 'property_type')
    and (f ->> 'transaction' is null or l.desired_transaction = f ->> 'transaction')
    and (f ->> 'lead_status' is null or l.status = f ->> 'lead_status');
$$;

create or replace function private.si_has_lead_filter(f jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(f, '{}') ?| array['source', 'property_type', 'transaction', 'lead_status'];
$$;

-- One metric, grouped by one optional dimension: (key, currency, numerator, denominator). No permission checks here:
-- callers (public functions, the tick for already-authorized jobs) decide what may be computed.
create or replace function private.si_compute(org uuid, metric text, p_from timestamptz, p_to timestamptz, f jsonb, dim text, tz text)
returns table (k text, cur text, num numeric, den numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  prog text[] := array['qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won'];
  cont text[] := array['contacted', 'qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won'];
  owner uuid := nullif(f ->> 'assignee', '')::uuid;
  lf boolean := private.si_has_lead_filter(f);
begin
  f := coalesce(f, '{}');
  if metric in ('leads_created', 'leads_contacted', 'leads_qualified', 'qualification_rate', 'leads_matched', 'qualified_to_appointment_rate',
                'median_first_response_minutes', 'median_first_call_minutes', 'median_first_connection_minutes', 'median_days_to_qualified') then
    return query
    with c as (
      select l.id, l.created_at, l.first_response_at, l.qualified_at, l.status,
        private.si_key(dim, tz, l.source, l.assigned_to, l.desired_property_type, l.desired_transaction, l.lead_type, null, l.created_at) kk
      from public.leads l
      where l.organization_id = org and l.created_at >= p_from and l.created_at < p_to and private.si_lead_ok(l, f)
        and (owner is null or l.assigned_to = owner)),
    x as (
      select c.*,
        (c.qualified_at is not null or c.status = any (prog) or exists (select 1 from public.lead_status_history h where h.lead_id = c.id and h.to_status = any (prog))) qual,
        (c.status = any (cont) or exists (select 1 from public.lead_status_history h where h.lead_id = c.id and h.to_status = any (cont))
          or exists (select 1 from public.voice_calls v where v.lead_id = c.id and v.outcome = 'connected')) contacted,
        exists (select 1 from public.property_matches m where m.lead_id = c.id) matched,
        exists (select 1 from public.appointments a where a.lead_id = c.id and a.confirmed_at is not null) booked,
        (select min(v.initiated_at) from public.voice_calls v where v.lead_id = c.id and v.initiated_at is not null and v.status <> 'blocked') first_call,
        (select min(coalesce(v.started_at, v.initiated_at)) from public.voice_calls v where v.lead_id = c.id and v.outcome = 'connected') first_conn
      from c)
    select x.kk, null::text,
      (case metric
        when 'leads_created' then count(*)::numeric
        when 'leads_contacted' then count(*) filter (where x.contacted)::numeric
        when 'leads_qualified' then count(*) filter (where x.qual)::numeric
        when 'qualification_rate' then count(*) filter (where x.qual)::numeric
        when 'leads_matched' then count(*) filter (where x.matched)::numeric
        when 'qualified_to_appointment_rate' then count(*) filter (where x.qual and x.booked)::numeric
        when 'median_first_response_minutes' then (percentile_cont(0.5) within group (order by extract(epoch from x.first_response_at - x.created_at)::float8 / 60)
                                                   filter (where x.first_response_at is not null))::numeric
        when 'median_first_call_minutes' then (percentile_cont(0.5) within group (order by extract(epoch from x.first_call - x.created_at)::float8 / 60)
                                               filter (where x.first_call is not null))::numeric
        when 'median_first_connection_minutes' then (percentile_cont(0.5) within group (order by extract(epoch from x.first_conn - x.created_at)::float8 / 60)
                                                     filter (where x.first_conn is not null))::numeric
        else (percentile_cont(0.5) within group (order by extract(epoch from x.qualified_at - x.created_at)::float8 / 86400)
              filter (where x.qualified_at is not null))::numeric end),
      (case metric
        when 'qualification_rate' then count(*)::numeric
        when 'qualified_to_appointment_rate' then count(*) filter (where x.qual)::numeric
        when 'median_first_response_minutes' then count(*) filter (where x.first_response_at is not null)::numeric
        when 'median_first_call_minutes' then count(*) filter (where x.first_call is not null)::numeric
        when 'median_first_connection_minutes' then count(*) filter (where x.first_conn is not null)::numeric
        when 'median_days_to_qualified' then count(*) filter (where x.qualified_at is not null)::numeric
        else null end)
    from x group by x.kk;

  elsif metric in ('leads_awaiting_qualification', 'leads_human_review', 'leads_no_next_action', 'leads_follow_up_overdue') then
    return query
    select private.si_key(dim, tz, l.source, l.assigned_to, l.desired_property_type, l.desired_transaction, l.lead_type, null, l.created_at), null::text,
      count(*) filter (where case metric
        when 'leads_awaiting_qualification' then not exists (select 1 from public.lead_qualifications q where q.lead_id = l.id and q.is_current
                                                               and q.status not in ('unqualified', 'in_progress', 'needs_information'))
        when 'leads_human_review' then exists (select 1 from public.lead_qualifications q where q.lead_id = l.id and q.is_current and q.review_status = 'pending')
        when 'leads_follow_up_overdue' then l.next_follow_up_at < now()
        else (l.next_follow_up_at is null or l.next_follow_up_at < now())
          and not exists (select 1 from public.appointments a where a.lead_id = l.id and a.status in ('requested', 'pending', 'confirmed', 'reschedule_requested'))
          and not exists (select 1 from public.follow_ups fu where fu.lead_id = l.id and fu.status in ('pending_approval', 'approved', 'scheduled', 'processing'))
          and not exists (select 1 from public.tasks t where t.related_lead_id = l.id and t.status in ('open', 'in_progress')) end)::numeric,
      null::numeric
    from public.leads l
    where l.organization_id = org and l.status not in ('won', 'lost') and private.si_lead_ok(l, f) and (owner is null or l.assigned_to = owner)
    group by 1;

  elsif metric in ('appointments_booked', 'appointments_completed', 'appointments_no_show', 'appointments_cancelled', 'appointments_outcome_unknown', 'attendance_rate') then
    return query
    select private.si_key(dim, tz, l.source, a.assigned_to, l.desired_property_type, l.desired_transaction, l.lead_type, a.appointment_type,
             case metric when 'appointments_booked' then a.created_at when 'appointments_outcome_unknown' then a.ends_at else a.starts_at end), null::text,
      (case metric
        when 'appointments_booked' then count(*) filter (where a.confirmed_at is not null)
        when 'appointments_completed' then count(*) filter (where a.status = 'completed')
        when 'appointments_no_show' then count(*) filter (where a.status = 'no_show')
        when 'appointments_cancelled' then count(*) filter (where a.status = 'cancelled')
        when 'appointments_outcome_unknown' then count(*) filter (where a.status = 'confirmed' and a.ends_at < now())
        else count(*) filter (where a.status = 'completed') end)::numeric,
      (case when metric = 'attendance_rate' then count(*) filter (where a.status in ('completed', 'no_show')) end)::numeric
    from public.appointments a left join public.leads l on l.id = a.lead_id
    where a.organization_id = org
      and (case metric when 'appointments_booked' then a.created_at when 'appointments_outcome_unknown' then a.ends_at else a.starts_at end) >= p_from
      and (case metric when 'appointments_booked' then a.created_at when 'appointments_outcome_unknown' then a.ends_at else a.starts_at end) < p_to
      and (not lf or private.si_lead_ok(l, f)) and (owner is null or a.assigned_to = owner)
    group by 1;

  elsif metric in ('calls_attempted', 'calls_connected') then
    return query
    select private.si_key(dim, tz, l.source, l.assigned_to, null, null, null, null, v.initiated_at), null::text,
      (case when metric = 'calls_connected' then count(*) filter (where v.outcome = 'connected') else count(*) end)::numeric, null::numeric
    from public.voice_calls v left join public.leads l on l.id = v.lead_id
    where v.organization_id = org and v.initiated_at >= p_from and v.initiated_at < p_to and v.status <> 'blocked'
      and (not lf or private.si_lead_ok(l, f)) and (owner is null or l.assigned_to = owner)
    group by 1;

  elsif metric in ('follow_ups_sent', 'follow_ups_delivered', 'follow_ups_failed') then
    return query
    select private.si_key(dim, tz, l.source, l.assigned_to, null, null, null, null,
             case metric when 'follow_ups_sent' then fu.sent_at when 'follow_ups_delivered' then fu.delivered_at else fu.created_at end), null::text,
      count(*)::numeric, null::numeric
    from public.follow_ups fu left join public.leads l on l.id = fu.lead_id
    where fu.organization_id = org and fu.kind = 'message'
      and case metric
        when 'follow_ups_sent' then fu.status in ('sent', 'delivered') and fu.sent_at >= p_from and fu.sent_at < p_to
        when 'follow_ups_delivered' then fu.delivered_at >= p_from and fu.delivered_at < p_to
        else fu.status = 'failed' and fu.created_at >= p_from and fu.created_at < p_to end
      and (not lf or private.si_lead_ok(l, f)) and (owner is null or l.assigned_to = owner)
    group by 1;

  elsif metric in ('deals_opened', 'deals_won', 'deal_win_rate', 'closed_deal_value', 'average_deal_value') then
    return query
    select private.si_key(dim, tz, l.source, d.owner_user_id, null, null, null, null, case when metric = 'deals_opened' then d.created_at else d.closed_at end),
      case when metric in ('closed_deal_value', 'average_deal_value') then d.currency::text end,
      (case metric
        when 'deals_opened' then count(*)
        when 'deals_won' then count(*) filter (where d.stage = 'won')
        when 'deal_win_rate' then count(*) filter (where d.stage = 'won')
        when 'closed_deal_value' then sum(d.expected_value) filter (where d.stage = 'won')
        else avg(d.expected_value) filter (where d.stage = 'won') end)::numeric,
      (case metric when 'deal_win_rate' then count(*) filter (where d.stage in ('won', 'lost'))
                   when 'average_deal_value' then count(*) filter (where d.stage = 'won') end)::numeric
    from public.deals d left join public.leads l on l.id = d.lead_id
    where d.organization_id = org
      and case when metric = 'deals_opened' then d.created_at >= p_from and d.created_at < p_to
               else d.closed_at >= p_from and d.closed_at < p_to and d.stage in ('won', 'lost') end
      and (not lf or (l.id is not null and private.si_lead_ok(l, f))) and (owner is null or d.owner_user_id = owner)
    group by 1, 2
    having metric in ('deals_opened', 'deals_won', 'deal_win_rate') or count(*) filter (where d.stage = 'won') > 0;

  elsif metric = 'commission_revenue' then
    return query
    select private.si_key(dim, tz, l.source, d.owner_user_id, null, null, null, null, d.closed_at), cm.currency::text, sum(cm.gross_commission)::numeric, count(*)::numeric
    from public.commissions cm join public.deals d on d.id = cm.deal_id left join public.leads l on l.id = d.lead_id
    where cm.organization_id = org and d.stage = 'won' and d.closed_at >= p_from and d.closed_at < p_to and cm.status in ('approved', 'payable', 'paid')
      and (not lf or (l.id is not null and private.si_lead_ok(l, f))) and (owner is null or d.owner_user_id = owner)
    group by 1, 2;

  elsif metric in ('open_deals', 'pipeline_value') then
    return query
    select private.si_key(dim, tz, l.source, d.owner_user_id, null, null, null, null, d.created_at),
      case when metric = 'pipeline_value' then d.currency::text end,
      (case when metric = 'pipeline_value' then sum(d.expected_value) else count(*) end)::numeric, null::numeric
    from public.deals d left join public.leads l on l.id = d.lead_id
    where d.organization_id = org and d.stage not in ('won', 'lost')
      and (not lf or (l.id is not null and private.si_lead_ok(l, f))) and (owner is null or d.owner_user_id = owner)
    group by 1, 2;
  end if;
end;
$$;

-- Period presets in the org's time zone.
create or replace function private.si_period(p_preset text, p_from date, p_to date, tz text)
returns table (f timestamptz, t timestamptz, pf timestamptz, pt timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  today date := (now() at time zone tz)::date;
  a date;
  b date;
  pa date;
  pb date;
begin
  case coalesce(p_preset, 'custom')
    when 'today' then a := today; b := today + 1;
    when 'last_7_days' then a := today - 6; b := today + 1;
    when 'last_30_days' then a := today - 29; b := today + 1;
    when 'last_90_days' then a := today - 89; b := today + 1;
    when 'this_month' then a := date_trunc('month', today)::date; b := today + 1;
    when 'last_month' then a := (date_trunc('month', today) - interval '1 month')::date; b := date_trunc('month', today)::date;
    when 'this_quarter' then a := date_trunc('quarter', today)::date; b := today + 1;
    when 'last_quarter' then a := (date_trunc('quarter', today) - interval '3 months')::date; b := date_trunc('quarter', today)::date;
    when 'this_year' then a := date_trunc('year', today)::date; b := today + 1;
    else a := p_from; b := p_to + 1;
  end case;
  if a is null or b is null or b <= a or b - a > 400 then perform private.fail('VALIDATION_ERROR', 'Choose a period of 1–400 days'); end if;
  -- The comparison window has the same length and ends where the period starts; calendar presets compare whole units.
  if p_preset in ('this_month', 'last_month') then pa := (date_trunc('month', a) - interval '1 month')::date; pb := pa + (b - a);
  elsif p_preset in ('this_quarter', 'last_quarter') then pa := (date_trunc('quarter', a) - interval '3 months')::date; pb := pa + (b - a);
  elsif p_preset = 'this_year' then pa := (a - interval '1 year')::date; pb := pa + (b - a);
  else pa := a - (b - a); pb := a; end if;
  return query select a::timestamp at time zone tz, b::timestamp at time zone tz, pa::timestamp at time zone tz, pb::timestamp at time zone tz;
end;
$$;

-- Agent 07 context reduced to what changes how a number should be read.
create or replace function private.si_quality_caveats(org uuid, metric_basis text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  dup int;
  hc int;
  q int;
  last_scan timestamptz;
  res jsonb := '[]';
begin
  select count(distinct l.id) into dup from public.leads l where l.organization_id = org and l.archived_at is null and (
    exists (select 1 from public.duplicate_candidates d where d.organization_id = org and d.entity_type = 'lead' and d.status = 'open' and d.strength <> 'weak' and l.id in (d.record_a, d.record_b))
    or exists (select 1 from public.duplicate_candidates d where d.organization_id = org and d.entity_type = 'contact' and d.status = 'open' and d.strength <> 'weak' and l.contact_id in (d.record_a, d.record_b)));
  select count(*) into hc from public.data_quality_issues where organization_id = org and status in ('open', 'under_review', 'proposed', 'reopened')
    and severity in ('high', 'critical') and entity_type in ('lead', 'contact', 'appointment');
  select count(*) into q from public.data_quality_queue where organization_id = org and attempts < 5;
  select max(completed_at) into last_scan from public.data_quality_scans where organization_id = org and status in ('completed', 'partial');
  if dup > 0 and metric_basis in ('cohort', 'lead_snapshot', 'snapshot') then
    res := res || jsonb_build_object('code', 'possible_duplicates', 'count', dup, 'text', format('%s open leads may be duplicates awaiting review; lead counts may be slightly high', dup));
  end if;
  if hc > 0 then
    res := res || jsonb_build_object('code', 'high_severity_issues', 'count', hc, 'text', format('%s high or critical data quality issues on leads, contacts or appointments are unresolved', hc));
  end if;
  if last_scan is null then
    res := res || jsonb_build_object('code', 'no_quality_scan', 'text', 'No data quality scan has completed yet');
  end if;
  if q > 50 then
    res := res || jsonb_build_object('code', 'quality_backlog', 'count', q, 'text', format('%s recent changes have not been quality-checked yet', q));
  end if;
  return res;
end;
$$;

-- Runs one validated spec (already authorized) and shapes the answer: rows with value, previous value, change and sample flags.
create or replace function private.si_run(org uuid, metric text, dim text, p_from timestamptz, p_to timestamptz, p_pfrom timestamptz, p_pto timestamptz,
  f jsonb, p_compare boolean, p_sort text, p_limit int)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cat jsonb := private.si_catalogue() -> metric;
  unit text := cat ->> 'unit';
  basis text := cat ->> 'basis';
  tz text := (select timezone from public.organizations where id = org);
  rules jsonb := private.si_rules(org);
  minn int := coalesce((rules ->> 'min_sample')::int, 10);
  rows jsonb;
  avail jsonb := jsonb_build_object('available', true);
  cmp boolean := coalesce(p_compare, false) and basis <> 'snapshot';
  caveats jsonb := '[]';
begin
  if metric = 'follow_ups_delivered' and not exists (select 1 from public.integrations where organization_id = org and integration_type = 'messaging' and status = 'connected') then
    return jsonb_build_object('metric', metric, 'label', cat ->> 'label', 'unit', unit, 'definition', cat ->> 'definition', 'group_by', dim,
      'available', false, 'reason', 'No messaging provider is connected, so delivery receipts cannot be observed. Sent messages are reported as follow_ups_sent.', 'rows', '[]'::jsonb);
  end if;
  with cur as (select * from private.si_compute(org, metric, p_from, p_to, f, dim, tz)),
  prev as (select * from private.si_compute(org, metric, p_pfrom, p_pto, f, dim, tz) where cmp),
  keys as (select k, cur from cur union select k, cur from prev),
  j as (
    select keys.k, keys.cur, c.num cn, c.den cd, p.num pn, p.den pd,
      case when unit = 'rate' then c.num / nullif(c.den, 0) when unit = 'count' then coalesce(c.num, case when dim is null then 0 end) else c.num end cv,
      case when not cmp then null when unit = 'rate' then p.num / nullif(p.den, 0) when unit = 'count' then coalesce(p.num, 0) else p.num end pv
    from keys left join cur c on c.k = keys.k and c.cur is not distinct from keys.cur
    left join prev p on p.k = keys.k and p.cur is not distinct from keys.cur)
  select coalesce(jsonb_agg(s.r order by s.rk), '[]')
    into rows
  from (select row_number() over (order by case when p_sort = 'key' then null else j.cv end desc nulls last, case when p_sort = 'key' then j.k end, j.k, j.cur) rk,
      jsonb_strip_nulls(jsonb_build_object(
      'key', j.k, 'currency', j.cur,
      'label', case when dim = 'assignee' and j.k <> 'unassigned' then (select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr where pr.id = j.k::uuid)
                    when dim = 'assignee' then 'Unassigned' else j.k end,
      'value', round(j.cv, 4), 'numerator', j.cn, 'denominator', j.cd,
      'previous_value', round(j.pv, 4),
      'change', case when cmp and j.cv is not null and j.pv is not null then round(j.cv - j.pv, 4) end,
      'change_pct', case when cmp and unit in ('count', 'money', 'minutes', 'days') and j.pv > 0 and j.cv is not null then round(100 * (j.cv - j.pv) / j.pv, 1) end,
      'low_sample', case when unit in ('rate', 'minutes', 'days') then coalesce(j.cd, 0) < minn end)) r
    from j
    where j.k is not null
    order by 1
    limit least(greatest(coalesce(p_limit, 50), 1), 200)) s;
  -- An ungrouped count over an empty period is a real zero; an ungrouped rate or median with no denominator is "no data".
  if dim is null and jsonb_array_length(rows) = 0 and unit = 'count' then
    rows := jsonb_build_array(jsonb_build_object('key', 'all', 'label', 'all', 'value', 0) || case when cmp then jsonb_build_object('previous_value', 0, 'change', 0) else '{}'::jsonb end);
  end if;
  if basis = 'cohort' and p_to > now() - make_interval(days => coalesce((rules ->> 'maturity_days')::int, 30)) then
    caveats := caveats || jsonb_build_object('code', 'immature_cohort', 'text',
      format('Leads created in the last %s days may still progress; cohort rates for this period are provisional', coalesce((rules ->> 'maturity_days')::int, 30)));
  end if;
  caveats := caveats || private.si_quality_caveats(org, basis);
  return jsonb_build_object('metric', metric, 'label', cat ->> 'label', 'unit', unit, 'basis', basis, 'definition', cat ->> 'definition', 'group_by', dim,
    'period', case when basis = 'snapshot' then jsonb_build_object('as_of', now()) else jsonb_build_object('from', p_from, 'to', p_to, 'timezone', tz) end,
    'previous_period', case when cmp then jsonb_build_object('from', p_pfrom, 'to', p_pto) end,
    'available', true, 'rows', rows, 'caveats', caveats, 'min_sample', minn, 'computed_at', now(), 'catalogue_version', 'si-metrics/1');
end;
$$;

-- ───────────────────────── query layer (dashboard, team, sources, analyst) ─────────────────────────

-- Validates a query spec against the catalogue and the caller's permissions, then runs it. Never executes free-form SQL.
create or replace function public.si_query(p_org uuid, p_spec jsonb, p_log boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cat jsonb := private.si_catalogue();
  m text := p_spec ->> 'metric';
  dim text := nullif(p_spec ->> 'group_by', '');
  f jsonb := coalesce(p_spec -> 'filters', '{}');
  tz text;
  pr record;
  res jsonb;
  bad text;
begin
  if not public.has_perm(p_org, 'reports.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if jsonb_typeof(p_spec) <> 'object' or exists (select 1 from jsonb_object_keys(p_spec) x where x not in ('metric', 'group_by', 'preset', 'from', 'to', 'compare', 'filters', 'sort', 'limit')) then
    bad := 'Unsupported fields in the query';
  elsif m is null or not cat ? m then
    bad := 'Unknown metric';
  elsif dim is not null and not (cat -> m -> 'dims') ? dim then
    bad := format('%s cannot be grouped by %s', cat -> m ->> 'label', dim);
  elsif jsonb_typeof(f) <> 'object' or exists (select 1 from jsonb_each(f) e where e.key not in ('source', 'assignee', 'property_type', 'transaction', 'lead_status') or jsonb_typeof(e.value) <> 'string') then
    bad := 'Unsupported filter';
  elsif f ? 'assignee' and f ->> 'assignee' !~ '^[0-9a-f-]{36}$' then
    bad := 'Invalid assignee';
  elsif coalesce(p_spec ->> 'preset', 'custom') not in ('custom', 'today', 'last_7_days', 'last_30_days', 'last_90_days', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year') then
    bad := 'Unknown period';
  elsif coalesce(p_spec ->> 'sort', 'value') not in ('value', 'key') or coalesce((p_spec ->> 'limit')::int, 50) not between 1 and 200 then
    bad := 'Invalid sort or limit';
  end if;
  -- With logging (the analyst), refusals are returned rather than raised so the log row is kept.
  if bad is not null then
    if p_log then
      insert into public.sales_analyst_queries (organization_id, user_id, spec, status) values (p_org, auth.uid(), p_spec, 'invalid');
      return jsonb_build_object('error', 'VALIDATION_ERROR', 'message', bad);
    end if;
    perform private.fail('VALIDATION_ERROR', bad);
  end if;
  if not public.has_perm(p_org, cat -> m ->> 'perm')
     or ((dim = 'assignee' or (f ? 'assignee' and (f ->> 'assignee')::uuid is distinct from auth.uid())) and not public.has_perm(p_org, 'team.view')) then
    bad := case when cat -> m ->> 'perm' = 'finance.view' and not public.has_perm(p_org, 'finance.view') then 'Financial metrics need finance access'
                else 'Team breakdowns need team access' end;
    if p_log then
      insert into public.sales_analyst_queries (organization_id, user_id, spec, status) values (p_org, auth.uid(), p_spec, 'forbidden');
      return jsonb_build_object('error', 'FORBIDDEN', 'message', bad);
    end if;
    perform private.fail('FORBIDDEN', bad);
  end if;
  select timezone into tz from public.organizations where id = p_org;
  begin
    -- No period given: the last 30 days (snapshot metrics ignore the period).
    select * into pr from private.si_period(case when p_spec ->> 'preset' is null and p_spec ->> 'from' is null then 'last_30_days' else p_spec ->> 'preset' end,
      nullif(p_spec ->> 'from', '')::date, nullif(p_spec ->> 'to', '')::date, tz);
  exception when invalid_datetime_format or datetime_field_overflow then
    perform private.fail('VALIDATION_ERROR', 'Invalid date');
  end;
  res := private.si_run(p_org, m, dim, pr.f, pr.t, pr.pf, pr.pt, f, coalesce((p_spec ->> 'compare')::boolean, false), p_spec ->> 'sort', (p_spec ->> 'limit')::int);
  if p_log then
    insert into public.sales_analyst_queries (organization_id, user_id, spec, status)
    values (p_org, auth.uid(), p_spec, case when (res ->> 'available')::boolean then 'answered' else 'unavailable' end);
  end if;
  return res;
end;
$$;

-- The executive dashboard: KPI set for one period with its comparison, plus targets, freshness and caveats.
create or replace function public.si_overview(p_org uuid, p_preset text, p_from date, p_to date, p_filters jsonb default '{}')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tz text;
  pr record;
  f jsonb := coalesce(p_filters, '{}');
  fin boolean := public.has_perm(p_org, 'finance.view');
  m text;
  kpis jsonb := '{}';
  rules jsonb := private.si_rules(p_org);
  ids text[] := array['leads_created', 'leads_contacted', 'leads_qualified', 'qualification_rate', 'qualified_to_appointment_rate', 'leads_awaiting_qualification',
    'leads_human_review', 'leads_no_next_action', 'leads_follow_up_overdue', 'median_first_response_minutes', 'median_first_call_minutes',
    'calls_attempted', 'calls_connected', 'follow_ups_sent', 'follow_ups_delivered', 'follow_ups_failed', 'appointments_booked', 'appointments_completed',
    'appointments_no_show', 'appointments_cancelled', 'appointments_outcome_unknown', 'attendance_rate', 'deals_opened', 'deals_won', 'deal_win_rate',
    'open_deals', 'pipeline_value', 'closed_deal_value', 'average_deal_value', 'commission_revenue'];
begin
  if not public.has_perm(p_org, 'reports.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if jsonb_typeof(f) <> 'object' or exists (select 1 from jsonb_each(f) e where e.key not in ('source', 'assignee', 'property_type', 'transaction', 'lead_status') or jsonb_typeof(e.value) <> 'string') then
    perform private.fail('VALIDATION_ERROR', 'Unsupported filter');
  end if;
  if f ? 'assignee' and (f ->> 'assignee' !~ '^[0-9a-f-]{36}$' or ((f ->> 'assignee')::uuid is distinct from auth.uid() and not public.has_perm(p_org, 'team.view'))) then
    perform private.fail('FORBIDDEN', 'Team breakdowns need team access');
  end if;
  select timezone into tz from public.organizations where id = p_org;
  select * into pr from private.si_period(p_preset, p_from, p_to, tz);
  foreach m in array ids loop
    if (private.si_catalogue() -> m ->> 'perm') = 'finance.view' and not fin then
      kpis := kpis || jsonb_build_object(m, jsonb_build_object('metric', m, 'label', private.si_catalogue() -> m ->> 'label', 'restricted', true));
    else
      kpis := kpis || jsonb_build_object(m, private.si_run(p_org, m, null, pr.f, pr.t, pr.pf, pr.pt, f, true, null, 50) - 'caveats');
    end if;
  end loop;
  return jsonb_build_object('period', jsonb_build_object('from', pr.f, 'to', pr.t, 'timezone', tz, 'preset', p_preset),
    'previous_period', jsonb_build_object('from', pr.pf, 'to', pr.pt), 'filters', f, 'kpis', kpis,
    'targets', coalesce(rules -> 'targets', '{}'), 'caveats', private.si_quality_caveats(p_org, 'cohort') ||
      case when pr.t > now() - make_interval(days => coalesce((rules ->> 'maturity_days')::int, 30))
           then jsonb_build_array(jsonb_build_object('code', 'immature_cohort', 'text', format('Leads created in the last %s days may still progress; cohort rates are provisional', coalesce((rules ->> 'maturity_days')::int, 30))))
           else '[]'::jsonb end,
    'can', jsonb_build_object('finance', fin, 'team', public.has_perm(p_org, 'team.view'), 'settings', public.has_perm(p_org, 'settings.manage')),
    'unavailable', jsonb_build_object('cost_per_lead', 'No advertising spend is recorded', 'targets', case when coalesce(rules -> 'targets', '{}') = '{}' then 'No targets configured' end,
      'attribution', 'Single-touch: the lead source recorded at capture. No campaign interaction history exists for multi-touch attribution'),
    'computed_at', now());
end;
$$;

-- Several metrics for one dimension (sources, team, trends). Team access is enforced by si_query's rules.
create or replace function public.si_breakdown(p_org uuid, p_dim text, p_metrics text[], p_preset text, p_from date, p_to date, p_filters jsonb default '{}')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m text;
  res jsonb := '{}';
begin
  if not public.has_perm(p_org, 'reports.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if cardinality(p_metrics) > 12 then perform private.fail('VALIDATION_ERROR', 'Too many metrics'); end if;
  foreach m in array p_metrics loop
    if (private.si_catalogue() -> m ->> 'perm') = 'finance.view' and not public.has_perm(p_org, 'finance.view') then
      res := res || jsonb_build_object(m, jsonb_build_object('metric', m, 'restricted', true));
    else
      res := res || jsonb_build_object(m, public.si_query(p_org, jsonb_strip_nulls(jsonb_build_object('metric', m, 'group_by', p_dim, 'preset', p_preset, 'from', p_from, 'to', p_to,
        'filters', coalesce(p_filters, '{}'), 'compare', p_dim not in ('day', 'week', 'month'), 'limit', 200, 'sort', case when p_dim in ('day', 'week', 'month') then 'key' end))));
    end if;
  end loop;
  return jsonb_build_object('dimension', p_dim, 'metrics', res, 'computed_at', now(),
    'notes', case when p_dim = 'assignee' then jsonb_build_array('Assigned is not the same as actively handled', 'Missing activity records do not prove that work was not done',
                                                                  'Small samples are flagged; compare people only over the same period')
                  when p_dim = 'source' then jsonb_build_array('Attribution: single-touch, the source recorded when the lead was captured', 'No advertising spend is recorded, so cost per lead and ROI are unavailable')
                  else '[]'::jsonb end);
end;
$$;

-- ───────────────────────── funnel ─────────────────────────

create or replace function private.si_funnel_compute(org uuid, p_from timestamptz, p_to timestamptz, f jsonb, p_mature_only boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rules jsonb := private.si_rules(org);
  mat interval := make_interval(days => coalesce((rules ->> 'maturity_days')::int, 30));
  prog text[] := array['qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won'];
  cont text[] := array['contacted', 'qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won'];
  owner uuid := nullif(f ->> 'assignee', '')::uuid;
  res jsonb;
begin
  f := coalesce(f, '{}');
  with c as (
    select l.* from public.leads l
    where l.organization_id = org and l.created_at >= p_from and l.created_at < p_to and private.si_lead_ok(l, f) and (owner is null or l.assigned_to = owner)
      and (not coalesce(p_mature_only, false) or l.created_at < now() - mat)),
  s as (
    select c.id, c.created_at, c.created_at >= now() - mat immature,
      least((select min(h.created_at) from public.lead_status_history h where h.lead_id = c.id and h.to_status = any (cont)),
            (select min(coalesce(v.started_at, v.initiated_at)) from public.voice_calls v where v.lead_id = c.id and v.outcome = 'connected'),
            case when c.status = any (cont) then coalesce(c.first_response_at, c.updated_at) end) t_contacted,
      coalesce(c.qualified_at, (select min(h.created_at) from public.lead_status_history h where h.lead_id = c.id and h.to_status = any (prog)),
               case when c.status = any (prog) then c.updated_at end) t_qualified,
      (select min(m.created_at) from public.property_matches m where m.lead_id = c.id) t_matched,
      (select min(a.confirmed_at) from public.appointments a where a.lead_id = c.id and a.confirmed_at is not null) t_booked,
      (select min(a.starts_at) from public.appointments a where a.lead_id = c.id and a.status = 'completed') t_attended,
      (select min(d.created_at) from public.deals d where d.lead_id = c.id) t_deal,
      coalesce((select min(d.closed_at) from public.deals d where d.lead_id = c.id and d.stage = 'won'), case when c.status = 'won' then c.closed_at end) t_won
    from c),
  st(ord, id, label) as (values (1, 'captured', 'Lead captured'), (2, 'contacted', 'Contacted'), (3, 'qualified', 'Qualified'), (4, 'matched', 'Property matched'),
    (5, 'booked', 'Appointment booked'), (6, 'attended', 'Appointment attended'), (7, 'deal', 'Deal opened'), (8, 'won', 'Deal won')),
  r as (
    select st.ord, st.id, st.label,
      count(*) filter (where case st.id when 'captured' then true when 'contacted' then t_contacted is not null when 'qualified' then t_qualified is not null
        when 'matched' then t_matched is not null when 'booked' then t_booked is not null when 'attended' then t_attended is not null
        when 'deal' then t_deal is not null else t_won is not null end) n,
      percentile_cont(0.5) within group (order by extract(epoch from case st.id when 'contacted' then t_contacted - created_at when 'qualified' then t_qualified - created_at
        when 'matched' then t_matched - created_at when 'booked' then t_booked - created_at when 'attended' then t_attended - created_at
        when 'deal' then t_deal - created_at when 'won' then t_won - created_at end)::float8 / 86400) median_days
    from st cross join s group by st.ord, st.id, st.label),
  pairs as (
    select st.ord,
      count(*) filter (where (case st.ord - 1 when 1 then true when 2 then t_contacted is not null when 3 then t_qualified is not null when 4 then t_matched is not null
          when 5 then t_booked is not null when 6 then t_attended is not null when 7 then t_deal is not null end)
        and (case st.id when 'contacted' then t_contacted is not null when 'qualified' then t_qualified is not null when 'matched' then t_matched is not null
          when 'booked' then t_booked is not null when 'attended' then t_attended is not null when 'deal' then t_deal is not null when 'won' then t_won is not null end)) both_n,
      count(*) filter (where case st.ord - 1 when 1 then true when 2 then t_contacted is not null when 3 then t_qualified is not null when 4 then t_matched is not null
          when 5 then t_booked is not null when 6 then t_attended is not null when 7 then t_deal is not null end) prev_n
    from st cross join s where st.ord > 1 group by st.ord, st.id)
  select jsonb_build_object(
    'cohort', jsonb_build_object('from', p_from, 'to', p_to, 'leads', (select count(*) from s), 'immature', (select count(*) from s where immature),
      'maturity_days', (rules ->> 'maturity_days')::int, 'mature_only', coalesce(p_mature_only, false)),
    'stages', coalesce((select jsonb_agg(jsonb_build_object('stage', r.id, 'label', r.label, 'leads', r.n,
        'share_of_cohort', case when (select count(*) from s) > 0 then round(r.n::numeric / (select count(*) from s), 4) end,
        'step_conversion', case when p.prev_n > 0 then round(p.both_n::numeric / p.prev_n, 4) end, 'step_base', p.prev_n,
        'drop_off', case when p.prev_n is not null then p.prev_n - p.both_n end,
        'median_days_from_capture', round(r.median_days::numeric, 2), 'low_sample', coalesce(p.prev_n, (select count(*) from s)) < coalesce((rules ->> 'min_sample')::int, 10))
      order by r.ord) from r left join pairs p on p.ord = r.ord), '[]'),
    'definition', 'Cohort: leads created in the period. Each stage counts leads with recorded evidence of reaching it (status history, connected calls, matches, confirmed or completed appointments, deals). Step conversion: leads that reached this stage among those that reached the previous one.')
  into res;
  return res;
end;
$$;

create or replace function public.si_funnel(p_org uuid, p_preset text, p_from date, p_to date, p_filters jsonb default '{}', p_mature_only boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tz text;
  pr record;
  f jsonb := coalesce(p_filters, '{}');
begin
  if not public.has_perm(p_org, 'reports.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if jsonb_typeof(f) <> 'object' or exists (select 1 from jsonb_each(f) e where e.key not in ('source', 'assignee', 'property_type', 'transaction', 'lead_status') or jsonb_typeof(e.value) <> 'string') then
    perform private.fail('VALIDATION_ERROR', 'Unsupported filter');
  end if;
  if f ? 'assignee' and (f ->> 'assignee' !~ '^[0-9a-f-]{36}$' or ((f ->> 'assignee')::uuid is distinct from auth.uid() and not public.has_perm(p_org, 'team.view'))) then
    perform private.fail('FORBIDDEN', 'Team breakdowns need team access');
  end if;
  select timezone into tz from public.organizations where id = p_org;
  select * into pr from private.si_period(p_preset, p_from, p_to, tz);
  return private.si_funnel_compute(p_org, pr.f, pr.t, f, p_mature_only) || jsonb_build_object('timezone', tz, 'caveats', private.si_quality_caveats(p_org, 'cohort'), 'computed_at', now());
end;
$$;

-- ───────────────────────── forecast ─────────────────────────

create or replace function private.si_forecast_compute(org uuid, h_start date, h_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rules jsonb := private.si_rules(org);
  minc int := coalesce((rules ->> 'min_closed_deals')::int, 10);
  probs jsonb := rules -> 'stage_probabilities';
  tz text := (select timezone from public.organizations where id = org);
  s timestamptz := h_start::timestamp at time zone tz;
  e timestamptz := (h_end + 1)::timestamp at time zone tz;
  cu record;
  results jsonb := '{}';
  won int;
  closed int;
  rate numeric;
  wsum numeric;
  csum numeric;
  method text;
  any_ok boolean := false;
begin
  for cu in select distinct currency::text c from public.deals where organization_id = org loop
    select count(*) filter (where stage = 'won'), count(*) into won, closed
    from public.deals where organization_id = org and currency = cu.c and stage in ('won', 'lost') and closed_at >= s - interval '365 days' and closed_at < least(s, now());
    rate := case when closed >= minc then won::numeric / closed end;
    if jsonb_typeof(probs) = 'object' then
      method := 'configured_stage_probabilities';
      select sum(d.expected_value * coalesce((probs ->> d.stage)::numeric, 0)), sum(d.expected_value * coalesce((probs ->> d.stage)::numeric, 0) * d.commission_pct / 100)
        into wsum, csum
      from public.deals d where d.organization_id = org and d.currency = cu.c and d.stage not in ('won', 'lost') and d.expected_close_date between h_start and h_end;
    elsif rate is not null then
      method := 'historical_win_rate';
      select sum(d.expected_value) * rate, sum(d.expected_value * d.commission_pct / 100) * rate into wsum, csum
      from public.deals d where d.organization_id = org and d.currency = cu.c and d.stage not in ('won', 'lost') and d.expected_close_date between h_start and h_end;
    else
      method := null; wsum := null; csum := null;
    end if;
    results := results || jsonb_build_object(cu.c, jsonb_build_object(
      'status', case when method is null then 'insufficient_data' else 'completed' end,
      'method', method,
      'forecast_value', round(coalesce(wsum, case when method is not null then 0 end), 2),
      'commission_forecast', round(coalesce(csum, case when method is not null then 0 end), 2),
      'scenario_low_committed', (select coalesce(sum(expected_value), 0) from public.deals where organization_id = org and currency = cu.c and stage = 'under_contract'
                                   and expected_close_date between h_start and h_end),
      'scenario_high_all_open', (select coalesce(sum(expected_value), 0) from public.deals where organization_id = org and currency = cu.c and stage not in ('won', 'lost')
                                   and expected_close_date between h_start and h_end),
      'open_deals_in_window', (select count(*) from public.deals where organization_id = org and currency = cu.c and stage not in ('won', 'lost') and expected_close_date between h_start and h_end),
      'open_deals_without_close_date', (select count(*) from public.deals where organization_id = org and currency = cu.c and stage not in ('won', 'lost') and expected_close_date is null),
      'open_deals_overdue', (select count(*) from public.deals where organization_id = org and currency = cu.c and stage not in ('won', 'lost') and expected_close_date < h_start),
      'historical_win_rate', round(rate, 4), 'closed_deals_in_history', closed, 'won_in_history', won, 'min_closed_deals', minc));
    any_ok := any_ok or method is not null;
  end loop;
  return jsonb_build_object('status', case when any_ok then 'completed' else 'insufficient_data' end, 'results', results,
    'method', case when jsonb_typeof(probs) = 'object' then 'configured_stage_probabilities' else 'historical_win_rate' end,
    'assumptions', jsonb_build_array('Only open deals with an expected close date inside the horizon are included',
      'Each deal is weighted by the same historical win rate of its currency (or the configured stage probability); no per-deal probability is claimed',
      'Commission forecast uses each deal''s own commission %'),
    'caveats', jsonb_build_array('Scenario bounds are not a statistical confidence interval: low = deals under contract, high = every open deal in the window',
      'Win rate uses deals closed in the 365 days before the horizon start'),
    'input_window', jsonb_build_object('history_from', s - interval '365 days', 'history_to', least(s, now()), 'horizon_start', h_start, 'horizon_end', h_end));
end;
$$;

create or replace function public.si_forecast_request(p_org uuid, p_horizon_start date, p_horizon_end date, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.sales_forecast_runs;
begin
  if not public.has_perm(p_org, 'reports.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if not public.has_perm(p_org, 'finance.view') then perform private.fail('FORBIDDEN', 'Forecasts need finance access'); end if;
  if coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9_:-]{8,120}$' then perform private.fail('VALIDATION_ERROR', 'Invalid idempotency key'); end if;
  if p_horizon_start is null or p_horizon_end is null or p_horizon_end < p_horizon_start or p_horizon_end - p_horizon_start > 366 then
    perform private.fail('VALIDATION_ERROR', 'Choose a horizon of up to one year');
  end if;
  select * into r from public.sales_forecast_runs where organization_id = p_org and idempotency_key = p_idempotency_key;
  if r.id is not null then return jsonb_build_object('forecast_id', r.id, 'status', r.status, 'replayed', true); end if;
  insert into public.sales_forecast_runs (organization_id, horizon_start, horizon_end, requested_by, idempotency_key)
  values (p_org, p_horizon_start, p_horizon_end, auth.uid(), p_idempotency_key) returning * into r;
  perform private.write_audit(p_org, 'sales.forecast_requested', 'sales_forecast_runs', r.id, jsonb_build_object('start', p_horizon_start, 'end', p_horizon_end));
  return jsonb_build_object('forecast_id', r.id, 'status', r.status);
end;
$$;

-- ───────────────────────── insights (anomalies, findings, recommendations) ─────────────────────────

create or replace function private.si_upsert_insight(org uuid, p_kind text, p_rule text, p_category text, p_priority text, p_title text, p_summary text,
  p_observation text, p_interpretation text, p_action text, p_evidence jsonb, p_from timestamptz, p_to timestamptz, p_limitations jsonb)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  fp text := p_rule;
  x public.sales_insights;
  outcome text;
  was text;
begin
  select * into x from public.sales_insights where organization_id = org and fingerprint = fp for update;
  was := x.status;
  if x.id is null then
    insert into public.sales_insights (organization_id, kind, rule_id, category, priority, title, summary, observation, interpretation, recommended_action, evidence,
      observation_from, observation_to, generated_by, fingerprint, limitations)
    values (org, p_kind, p_rule, p_category, p_priority, left(p_title, 160), left(p_summary, 600), left(p_observation, 600), left(p_interpretation, 600), left(p_action, 600),
      p_evidence, p_from, p_to, 'rules', fp, coalesce(p_limitations, '[]'))
    on conflict (organization_id, fingerprint) do nothing returning * into x;
    if x.id is not null then outcome := 'new'; else select * into x from public.sales_insights where organization_id = org and fingerprint = fp for update; end if;
  end if;
  if outcome is null then
    if x.status in ('dismissed', 'completed') then
      update public.sales_insights set last_detected_at = now() where id = x.id;
      return 'kept';
    end if;
    update public.sales_insights set priority = p_priority, title = left(p_title, 160), summary = left(p_summary, 600), observation = left(p_observation, 600),
      interpretation = left(p_interpretation, 600), recommended_action = left(p_action, 600), evidence = p_evidence, observation_from = p_from, observation_to = p_to,
      limitations = coalesce(p_limitations, '[]'), last_detected_at = now(),
      status = case when status = 'expired' then 'new' else status end, occurrence = occurrence + case when status = 'expired' then 1 else 0 end, expired_at = null
    where id = x.id returning * into x;
    outcome := case when was = 'expired' then 'reopened' else 'updated' end;
  end if;
  if outcome in ('new', 'reopened') then
    perform private.emit_event(org, 'sales.insight_detected', 'sales_insight', x.id, null,
      jsonb_build_object('event_type', 'sales.insight_detected', 'schema_version', 1, 'organization_id', org, 'insight_id', x.id, 'kind', p_kind, 'rule_id', p_rule,
        'priority', p_priority, 'source', 'sales_intelligence_agent', 'occurred_at', now()),
      null, 'sales.insight_detected:' || x.id::text || ':' || x.occurrence);
  end if;
  return outcome;
end;
$$;

-- Two-proportion z statistic (pooled). Null when either sample is empty.
create or replace function private.si_z(x1 numeric, n1 numeric, x2 numeric, n2 numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case when n1 > 0 and n2 > 0 and (x1 + x2) > 0 and (x1 + x2) < (n1 + n2) then
    (x1 / n1 - x2 / n2) / sqrt(((x1 + x2) / (n1 + n2)) * (1 - (x1 + x2) / (n1 + n2)) * (1 / n1 + 1 / n2)) end;
$$;

-- Daily deterministic evaluation: anomaly rules against baselines and current-state findings. Each refreshes or expires.
create or replace function private.si_evaluate(org uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rules jsonb := private.si_rules(org);
  a jsonb := rules -> 'anomaly';
  minn int := coalesce((rules ->> 'min_sample')::int, 10);
  zc numeric := coalesce((a ->> 'z')::numeric, 2);
  o public.organizations;
  found text[] := '{}';
  cur numeric; mean numeric; sd numeric; weeks int;
  x1 numeric; n1 numeric; x2 numeric; n2 numeric; z numeric;
  m1 numeric; m2 numeric;
  fun jsonb; worst jsonb;
  ctx jsonb;
  x public.sales_insights;
  nna int; openl int; overdue int;
begin
  select * into o from public.organizations where id = org;

  -- Lead intake vs the previous weeks (only weeks the organization existed).
  select count(*) into cur from public.leads where organization_id = org and archived_at is null and created_at >= now() - interval '7 days';
  select count(*), avg(n), stddev_samp(n) into weeks, mean, sd from (
    select w, (select count(*) from public.leads l where l.organization_id = org and l.archived_at is null
                 and l.created_at >= now() - make_interval(days => 7 * (w + 1)) and l.created_at < now() - make_interval(days => 7 * w)) n
    from generate_series(1, coalesce((a ->> 'baseline_weeks')::int, 8)) w
    where now() - make_interval(days => 7 * (w + 1)) >= o.created_at) b;
  if weeks >= coalesce((a ->> 'min_baseline_weeks')::int, 4) and mean >= coalesce((a ->> 'min_intake')::numeric, 10) then
    if cur < mean - zc * coalesce(sd, 0) and cur <= mean * (1 - coalesce((a ->> 'intake_drop_pct')::numeric, 30) / 100) then
      perform private.si_upsert_insight(org, 'anomaly', 'sales.intake_drop', 'lead_intake', 'high', 'Lead intake dropped',
        format('%s leads in the last 7 days against a usual %s per week.', cur, round(mean, 1)),
        format('New leads in the last 7 days: %s. Baseline: %s per week (sd %s) over %s weeks.', cur, round(mean, 1), round(coalesce(sd, 0), 1), weeks),
        'A drop in intake can come from a paused campaign, a broken lead source or seasonality; the data does not show which.',
        'Check that every lead source and webhook is still delivering, and compare with campaign changes.',
        jsonb_build_object('rule', 'weekly count below mean − z·sd and ≥ drop %', 'current', cur, 'baseline_mean', round(mean, 2), 'baseline_sd', round(coalesce(sd, 0), 2),
          'baseline_weeks', weeks, 'z', zc, 'metric', 'leads_created'), now() - interval '7 days', now(), '["Weekly seasonality is not modelled"]');
      found := found || 'sales.intake_drop'::text;
    elsif cur > mean + zc * coalesce(sd, 0) and cur >= mean * (1 + coalesce((a ->> 'intake_spike_pct')::numeric, 50) / 100) then
      perform private.si_upsert_insight(org, 'anomaly', 'sales.intake_spike', 'lead_intake', 'medium', 'Unusual increase in new leads',
        format('%s leads in the last 7 days against a usual %s per week.', cur, round(mean, 1)),
        format('New leads in the last 7 days: %s. Baseline: %s per week over %s weeks.', cur, round(mean, 1), weeks),
        'A spike can be real demand, a campaign, or duplicate / spam submissions; check the duplicate queue before acting on it.',
        'Make sure first responses keep up with the volume and review the duplicate queue.',
        jsonb_build_object('rule', 'weekly count above mean + z·sd and ≥ spike %', 'current', cur, 'baseline_mean', round(mean, 2), 'baseline_sd', round(coalesce(sd, 0), 2),
          'baseline_weeks', weeks, 'metric', 'leads_created'), now() - interval '7 days', now(), '["Weekly seasonality is not modelled"]');
      found := found || 'sales.intake_spike'::text;
    end if;
  end if;

  -- Qualification within 7 days of capture, two mature cohorts compared at equal maturity.
  select count(*) filter (where qualified_at <= created_at + interval '7 days'), count(*) into x1, n1 from public.leads
  where organization_id = org and archived_at is null and created_at >= now() - interval '35 days' and created_at < now() - interval '7 days';
  select count(*) filter (where qualified_at <= created_at + interval '7 days'), count(*) into x2, n2 from public.leads
  where organization_id = org and archived_at is null and created_at >= now() - interval '63 days' and created_at < now() - interval '35 days';
  z := private.si_z(x1, n1, x2, n2);
  if n1 >= coalesce((a ->> 'rate_min_n')::int, 30) and n2 >= coalesce((a ->> 'rate_min_n')::int, 30) and abs(z) >= zc then
    perform private.si_upsert_insight(org, 'anomaly', 'sales.qualification_rate_change', 'qualification', case when z < 0 then 'high' else 'low' end,
      case when z < 0 then 'Fewer leads are qualified within a week' else 'More leads are qualified within a week' end,
      format('%s%% of leads were qualified within 7 days, against %s%% for the previous cohort.', round(100 * x1 / n1, 1), round(100 * x2 / n2, 1)),
      format('Cohort created 7–35 days ago: %s of %s qualified within 7 days. Cohort created 35–63 days ago: %s of %s.', x1, n1, x2, n2),
      'The change is statistically unusual for these sample sizes; its cause is not established by the data.',
      case when z < 0 then 'Look at first-response times and the qualification queue for the recent cohort, by source.' else 'Check which sources or owners drove the improvement.' end,
      jsonb_build_object('rule', 'two-proportion z-test, qualified within 7 days', 'recent', jsonb_build_object('qualified', x1, 'leads', n1), 'previous', jsonb_build_object('qualified', x2, 'leads', n2),
        'z', round(z, 2), 'metric', 'qualification_rate'), now() - interval '35 days', now() - interval '7 days', '["Correlation, not cause"]');
    found := found || 'sales.qualification_rate_change'::text;
  end if;

  -- Appointment cancellations.
  select count(*) filter (where status = 'cancelled'), count(*) filter (where status in ('confirmed', 'completed', 'no_show', 'cancelled')) into x1, n1
  from public.appointments where organization_id = org and starts_at >= now() - interval '28 days' and starts_at < now();
  select count(*) filter (where status = 'cancelled'), count(*) filter (where status in ('confirmed', 'completed', 'no_show', 'cancelled')) into x2, n2
  from public.appointments where organization_id = org and starts_at >= now() - interval '56 days' and starts_at < now() - interval '28 days';
  z := private.si_z(x1, n1, x2, n2);
  if n1 >= coalesce((a ->> 'cancel_min_n')::int, 20) and n2 >= coalesce((a ->> 'cancel_min_n')::int, 20) and z >= zc then
    perform private.si_upsert_insight(org, 'anomaly', 'sales.cancellation_rise', 'appointments', 'high', 'Appointment cancellations rose',
      format('%s%% of appointments in the last 28 days were cancelled, against %s%% before.', round(100 * x1 / n1, 1), round(100 * x2 / n2, 1)),
      format('Last 28 days: %s cancelled of %s. Previous 28 days: %s of %s.', x1, n1, x2, n2),
      'More cancellations may reflect scheduling, reminders or lead fit; the data does not show which.',
      'Review cancellation reasons and confirmation / reminder handling for recent appointments.',
      jsonb_build_object('rule', 'two-proportion z-test', 'recent', jsonb_build_object('cancelled', x1, 'appointments', n1), 'previous', jsonb_build_object('cancelled', x2, 'appointments', n2),
        'z', round(z, 2), 'metric', 'appointments_cancelled'), now() - interval '28 days', now(), '["Correlation, not cause"]');
    found := found || 'sales.cancellation_rise'::text;
  end if;

  -- First-response time.
  select percentile_cont(0.5) within group (order by extract(epoch from first_response_at - created_at)::float8 / 60), count(*) into m1, n1
  from public.leads where organization_id = org and archived_at is null and first_response_at is not null and created_at >= now() - interval '28 days';
  select percentile_cont(0.5) within group (order by extract(epoch from first_response_at - created_at)::float8 / 60), count(*) into m2, n2
  from public.leads where organization_id = org and archived_at is null and first_response_at is not null and created_at >= now() - interval '56 days' and created_at < now() - interval '28 days';
  if n1 >= coalesce((a ->> 'response_min_n')::int, 20) and n2 >= coalesce((a ->> 'response_min_n')::int, 20) and m2 > 0
     and m1 >= m2 * coalesce((a ->> 'response_ratio')::numeric, 1.5) then
    perform private.si_upsert_insight(org, 'anomaly', 'sales.response_slowdown', 'lead_response', 'high', 'First responses got slower',
      format('Median first response: %s min in the last 28 days, against %s min before.', round(m1), round(m2)),
      format('Median minutes from capture to the first recorded response: %s (n=%s) vs %s (n=%s).', round(m1, 1), n1, round(m2, 1), n2),
      'Slower first responses often go with lower engagement, but the data does not prove that here.',
      'Review assignment rules and the queue of new leads waiting for a first response.',
      jsonb_build_object('rule', 'median ratio ≥ threshold', 'recent_median', round(m1, 2), 'recent_n', n1, 'previous_median', round(m2, 2), 'previous_n', n2,
        'metric', 'median_first_response_minutes'), now() - interval '28 days', now(), '["First response = first recorded move out of New"]');
    found := found || 'sales.response_slowdown'::text;
  end if;

  -- Follow-up failures.
  select count(*) filter (where status = 'failed'), count(*) filter (where status in ('sent', 'delivered', 'failed')) into x1, n1
  from public.follow_ups where organization_id = org and kind = 'message' and created_at >= now() - interval '28 days';
  select count(*) filter (where status = 'failed'), count(*) filter (where status in ('sent', 'delivered', 'failed')) into x2, n2
  from public.follow_ups where organization_id = org and kind = 'message' and created_at >= now() - interval '56 days' and created_at < now() - interval '28 days';
  z := private.si_z(x1, n1, x2, n2);
  if n1 >= minn and n2 >= minn and z >= zc then
    perform private.si_upsert_insight(org, 'anomaly', 'sales.follow_up_failures', 'follow_up', 'medium', 'More follow-ups failed',
      format('%s of %s follow-ups failed in the last 28 days, against %s of %s before.', x1, n1, x2, n2),
      format('Failure share %s%% vs %s%%.', round(100 * x1 / n1, 1), round(100 * x2 / n2, 1)), 'Delivery problems are likely provider or contact-data related; check the failure reasons.',
      'Review the failed follow-ups and the contact details they were sent to.',
      jsonb_build_object('rule', 'two-proportion z-test', 'recent', jsonb_build_object('failed', x1, 'messages', n1), 'previous', jsonb_build_object('failed', x2, 'messages', n2),
        'z', round(z, 2), 'metric', 'follow_ups_failed'), now() - interval '28 days', now(), '[]');
    found := found || 'sales.follow_up_failures'::text;
  end if;

  -- Findings on the current state.
  select count(*) into openl from public.leads where organization_id = org and archived_at is null and status not in ('won', 'lost');
  select coalesce(sum(num), 0) into nna from private.si_compute(org, 'leads_no_next_action', now(), now(), '{}', null, o.timezone);
  if nna >= 5 and openl > 0 and nna::numeric / openl >= coalesce((rules ->> 'no_next_action_share')::numeric, 0.2) then
    perform private.si_upsert_insight(org, 'finding', 'sales.no_next_action', 'workload', 'high', 'Open leads without a next action',
      format('%s of %s open leads have no follow-up date, appointment, pending follow-up or open task.', nna, openl),
      format('%s open leads (%s%%) have nothing scheduled.', nna, round(100.0 * nna / openl, 1)),
      'Leads with nothing scheduled are at risk of going cold; some may be legitimately parked.',
      'Filter leads by "no next action" and give each an owner and a next step.',
      jsonb_build_object('rule', 'share of open leads with no next action ≥ threshold', 'leads_no_next_action', nna, 'open_leads', openl, 'metric', 'leads_no_next_action'),
      null, now(), '["Activity outside the CRM is not visible"]');
    found := found || 'sales.no_next_action'::text;
  end if;
  select coalesce(sum(num), 0) into overdue from private.si_compute(org, 'leads_follow_up_overdue', now(), now(), '{}', null, o.timezone);
  if overdue >= 5 then
    perform private.si_upsert_insight(org, 'finding', 'sales.follow_up_overdue', 'follow_up', 'medium', 'Follow-ups are overdue',
      format('%s open leads have a follow-up date in the past.', overdue), format('%s leads with next_follow_up_at < now.', overdue),
      'Overdue follow-ups may mean the dates were not updated after contact, or that contact did not happen.',
      'Work through overdue follow-ups or update their dates.', jsonb_build_object('rule', 'overdue count ≥ 5', 'leads_follow_up_overdue', overdue, 'metric', 'leads_follow_up_overdue'),
      null, now(), '[]');
    found := found || 'sales.follow_up_overdue'::text;
  end if;

  -- Largest funnel drop-off in the mature cohort (created 30–120 days ago).
  fun := private.si_funnel_compute(org, now() - interval '120 days', now() - make_interval(days => coalesce((rules ->> 'maturity_days')::int, 30)), '{}', false);
  select s into worst from jsonb_array_elements(fun -> 'stages') s
  where (s ->> 'step_base')::int >= minn and s ->> 'step_conversion' is not null and s ->> 'stage' in ('contacted', 'qualified', 'booked', 'attended')
  order by (s ->> 'step_conversion')::numeric limit 1;
  if worst is not null and (worst ->> 'step_conversion')::numeric < 0.5 then
    perform private.si_upsert_insight(org, 'finding', 'sales.funnel_bottleneck', 'qualification', 'medium',
      format('Biggest drop-off before "%s"', worst ->> 'label'),
      format('%s%% of leads that reached the previous stage reached "%s" (%s of %s).', round(100 * (worst ->> 'step_conversion')::numeric, 1), worst ->> 'label',
        (worst ->> 'step_base')::int - (worst ->> 'drop_off')::int, worst ->> 'step_base'),
      format('Mature cohort (created 30–120 days ago, %s leads): step conversion into "%s" is the lowest at %s%%.', fun -> 'cohort' ->> 'leads', worst ->> 'label',
        round(100 * (worst ->> 'step_conversion')::numeric, 1)),
      'This is where most leads stop progressing in this cohort; the reason is not recorded in the data.',
      'Review leads that stalled at this step and the actions available to move them on.',
      jsonb_build_object('rule', 'lowest step conversion < 50 % with base ≥ min sample', 'stage', worst, 'cohort', fun -> 'cohort', 'metric', 'funnel'),
      now() - interval '120 days', now() - interval '30 days', '["Stages are counted from recorded evidence; unrecorded work is invisible"]');
    found := found || 'sales.funnel_bottleneck'::text;
  end if;

  -- Attendance.
  select coalesce(sum(num), 0), coalesce(sum(den), 0) into x1, n1 from private.si_compute(org, 'attendance_rate', now() - interval '30 days', now(), '{}', null, o.timezone);
  if n1 >= minn and x1 / n1 < coalesce((rules ->> 'attendance_floor')::numeric, 0.7) then
    perform private.si_upsert_insight(org, 'finding', 'sales.low_attendance', 'appointments', 'medium', 'Many appointments end as no-shows',
      format('%s of %s appointments with a recorded outcome were attended in the last 30 days.', x1, n1), format('Attendance rate %s%%.', round(100 * x1 / n1, 1)),
      'No-shows may relate to confirmation and reminders, lead fit or timing; the data does not show which.',
      'Check that confirmations and reminders reach leads, and call leads the day before.',
      jsonb_build_object('rule', 'attendance below floor', 'attended', x1, 'with_outcome', n1, 'metric', 'attendance_rate'), now() - interval '30 days', now(),
      '["Appointments without a recorded outcome are excluded"]');
    found := found || 'sales.low_attendance'::text;
  end if;

  -- Unmatched requirements.
  select count(*) into x1 from public.property_match_runs r join public.leads l on l.id = r.lead_id
  where r.organization_id = org and r.is_current and r.status = 'no_matches' and l.archived_at is null and l.status not in ('won', 'lost');
  if x1 >= 3 then
    perform private.si_upsert_insight(org, 'finding', 'sales.unmatched_requirements', 'property_matching', 'medium', 'Open leads with no matching listings',
      format('%s open leads have no matching listing in the current inventory.', x1), format('%s current match runs ended with no matches.', x1),
      'Inventory may not cover these requirements, or the requirements may be too narrow.',
      'Review the requirements of these leads and the inventory gaps they share.',
      jsonb_build_object('rule', 'current match runs with no matches ≥ 3', 'leads', x1,
        'by_property_type', (select coalesce(jsonb_object_agg(coalesce(t, '(not set)'), n), '{}') from (select l.desired_property_type t, count(*) n from public.property_match_runs r
          join public.leads l on l.id = r.lead_id where r.organization_id = org and r.is_current and r.status = 'no_matches' and l.archived_at is null and l.status not in ('won', 'lost') group by 1) g),
        'metric', 'leads_matched'), null, now(), '["Availability at the time of past matches is not reconstructed"]');
    found := found || 'sales.unmatched_requirements'::text;
  end if;

  -- Data quality that affects these numbers (Agent 07).
  ctx := private.si_quality_caveats(org, 'cohort');
  if exists (select 1 from jsonb_array_elements(ctx) c where c ->> 'code' in ('possible_duplicates', 'high_severity_issues')) then
    perform private.si_upsert_insight(org, 'finding', 'sales.data_quality_risk', 'data_quality', 'medium', 'Data quality issues affect sales numbers',
      (select string_agg(c ->> 'text', '. ') from jsonb_array_elements(ctx) c where c ->> 'code' in ('possible_duplicates', 'high_severity_issues')) || '.',
      'Reported by the CRM & Data Intelligence Agent.', 'Duplicates inflate lead counts; unresolved high-severity issues can hide or misstate activity.',
      'Review the duplicate queue and high-severity issues on the Data quality page.', jsonb_build_object('rule', 'Agent 07 context', 'caveats', ctx), null, now(), '[]');
    found := found || 'sales.data_quality_risk'::text;
  end if;

  -- Expire rule insights whose condition cleared; people keep their accepted / in-progress items.
  for x in select * from public.sales_insights where organization_id = org and generated_by = 'rules' and status in ('new', 'reviewed') and not (rule_id = any (found)) loop
    update public.sales_insights set status = 'expired', expired_at = now() where id = x.id;
    perform private.emit_event(org, 'sales.insight_expired', 'sales_insight', x.id, null,
      jsonb_build_object('event_type', 'sales.insight_expired', 'schema_version', 1, 'organization_id', org, 'insight_id', x.id, 'rule_id', x.rule_id, 'source', 'sales_intelligence_agent', 'occurred_at', now()),
      null, 'sales.insight_expired:' || x.id::text || ':' || x.occurrence);
  end loop;
  return jsonb_build_object('detected', to_jsonb(found), 'intake_baseline_weeks', weeks);
end;
$$;

-- People move insights through review. Completion is something a person states, with what was done.
create or replace function public.si_insight_feedback(p_insight uuid, p_status text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  x public.sales_insights;
  allowed text[];
begin
  select * into x from public.sales_insights where id = p_insight for update;
  if x.id is null or not public.has_perm(x.organization_id, 'reports.view') then perform private.fail('NOT_FOUND', 'Insight not found'); end if;
  if not (public.has_perm(x.organization_id, 'team.view') or public.has_perm(x.organization_id, 'settings.manage')) then
    perform private.fail('FORBIDDEN', 'Managers review sales insights');
  end if;
  if x.status = p_status then return jsonb_build_object('status', x.status, 'replayed', true); end if;
  allowed := case x.status when 'new' then array['reviewed', 'accepted', 'dismissed'] when 'reviewed' then array['accepted', 'dismissed']
    when 'accepted' then array['in_progress', 'completed', 'dismissed'] when 'in_progress' then array['completed', 'dismissed']
    when 'expired' then array['dismissed'] else '{}' end;
  if not (p_status = any (allowed)) then perform private.fail('INVALID_TRANSITION', format('Cannot move from %s to %s', x.status, p_status)); end if;
  if p_status in ('dismissed', 'completed') and char_length(trim(coalesce(p_note, ''))) < 3 then
    perform private.fail('VALIDATION_ERROR', case when p_status = 'completed' then 'Say what was done' else 'Say why it is dismissed' end);
  end if;
  update public.sales_insights set status = p_status, feedback_note = coalesce(left(nullif(trim(coalesce(p_note, '')), ''), 1000), feedback_note),
    decided_by = auth.uid(), decided_at = now() where id = x.id;
  perform private.write_audit(x.organization_id, 'sales.insight_' || p_status, 'sales_insights', x.id, jsonb_build_object('kind', x.kind, 'rule_id', x.rule_id));
  return jsonb_build_object('status', p_status);
end;
$$;

-- The analytical context a recommendation run sees, stored so every recommendation can be traced to it.
create or replace function public.si_recommendation_context(p_org uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ov jsonb;
  fun jsonb;
  metrics jsonb := '{}';
  k text;
  v jsonb;
  ins jsonb;
  snap uuid;
  data jsonb;
begin
  if not public.has_perm(p_org, 'reports.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if not (public.has_perm(p_org, 'team.view') or public.has_perm(p_org, 'settings.manage')) then perform private.fail('FORBIDDEN', 'Managers generate recommendations'); end if;
  ov := public.si_overview(p_org, 'last_30_days', null, null, '{}');
  for k, v in select * from jsonb_each(ov -> 'kpis') loop
    continue when (v ->> 'restricted')::boolean is true or (v ->> 'available')::boolean is false;
    metrics := metrics || jsonb_build_object(k, jsonb_strip_nulls(jsonb_build_object('label', v ->> 'label', 'unit', v ->> 'unit', 'definition', v ->> 'definition',
      'rows', (select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('currency', r ->> 'currency', 'value', r -> 'value', 'previous_value', r -> 'previous_value',
                 'denominator', r -> 'denominator', 'low_sample', r -> 'low_sample'))) from jsonb_array_elements(v -> 'rows') r))));
  end loop;
  fun := public.si_funnel(p_org, 'last_90_days', null, null, '{}', true);
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'rule_id', i.rule_id, 'category', i.category, 'priority', i.priority, 'title', i.title,
    'observation', i.observation, 'evidence', i.evidence) order by i.priority, i.last_detected_at desc), '[]') into ins
  from public.sales_insights i where i.organization_id = p_org and i.generated_by = 'rules' and i.status in ('new', 'reviewed', 'accepted', 'in_progress');
  data := jsonb_build_object('period', ov -> 'period', 'previous_period', ov -> 'previous_period', 'metrics', metrics,
    'funnel', jsonb_build_object('cohort', fun -> 'cohort', 'stages', fun -> 'stages'), 'findings', ins, 'caveats', ov -> 'caveats', 'unavailable', ov -> 'unavailable');
  insert into public.sales_snapshots (organization_id, kind, params, data, created_by) values (p_org, 'recommendation_context', jsonb_build_object('preset', 'last_30_days'), data, auth.uid())
  returning id into snap;
  return jsonb_build_object('snapshot_id', snap, 'data', data);
end;
$$;

-- Stores validated model recommendations. Cited metric values and finding ids are re-checked against the stored snapshot.
create or replace function public.si_recommendations_save(p_snapshot uuid, p_recs jsonb, p_model text, p_prompt_version text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.sales_snapshots;
  r jsonb;
  ref jsonb;
  n int := 0;
  idx int := 0;
  ids uuid[];
  ok boolean;
begin
  select * into s from public.sales_snapshots where id = p_snapshot;
  if s.id is null or not public.has_perm(s.organization_id, 'reports.view') then perform private.fail('NOT_FOUND', 'Snapshot not found'); end if;
  if not (public.has_perm(s.organization_id, 'team.view') or public.has_perm(s.organization_id, 'settings.manage')) then perform private.fail('FORBIDDEN', 'Managers generate recommendations'); end if;
  if s.created_at < now() - interval '1 hour' then perform private.fail('CONFLICT', 'The analytical snapshot is too old; generate again'); end if;
  if exists (select 1 from public.sales_insights where snapshot_id = s.id) then perform private.fail('CONFLICT', 'Recommendations were already saved for this snapshot'); end if;
  if jsonb_typeof(p_recs) <> 'array' or jsonb_array_length(p_recs) > 8 then perform private.fail('VALIDATION_ERROR', 'Invalid recommendations'); end if;
  for r in select * from jsonb_array_elements(p_recs) loop
    idx := idx + 1;
    ok := jsonb_typeof(r -> 'supporting_metrics') = 'array' and jsonb_array_length(r -> 'supporting_metrics') between 1 and 6
      and coalesce(r ->> 'category', '') in ('lead_response', 'qualification', 'lead_source', 'follow_up', 'appointments', 'property_matching', 'workload', 'pipeline',
        'data_quality', 'forecast', 'operations', 'lead_intake')
      and coalesce(r ->> 'priority', '') in ('low', 'medium', 'high');
    if ok then
      for ref in select * from jsonb_array_elements(r -> 'supporting_metrics') loop
        -- Each cited value must be exactly a value in the snapshot (current or previous) for that metric.
        if not exists (select 1 from jsonb_array_elements(s.data -> 'metrics' -> (ref ->> 'metric') -> 'rows') row
                       where (row -> 'value' = ref -> 'value' or row -> 'previous_value' = ref -> 'value')) then
          ok := false;
        end if;
      end loop;
    end if;
    ids := array(select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(r -> 'finding_ids', '[]')) x
                 where x #>> '{}' ~ '^[0-9a-f-]{36}$');
    if ok and exists (select 1 from unnest(ids) i where not exists (select 1 from jsonb_array_elements(s.data -> 'findings') fi where fi ->> 'id' = i::text)) then
      ok := false;
    end if;
    if not ok then perform private.fail('VALIDATION_ERROR', format('Recommendation %s cites data that is not in the snapshot', idx)); end if;
    insert into public.sales_insights (organization_id, kind, category, priority, title, summary, observation, interpretation, recommended_action, expected_direction,
      supporting_metrics, assumptions, limitations, evidence, observation_from, observation_to, generated_by, model, prompt_version, snapshot_id, related_insight_ids, fingerprint)
    values (s.organization_id, 'recommendation', r ->> 'category', r ->> 'priority', left(r ->> 'title', 160), left(r ->> 'summary', 600), left(r ->> 'observation', 600),
      left(r ->> 'interpretation', 600), left(r ->> 'recommended_action', 600), left(r ->> 'expected_direction', 300), r -> 'supporting_metrics',
      coalesce(r -> 'assumptions', '[]'), coalesce(r -> 'limitations', '[]'), jsonb_build_object('snapshot_id', s.id, 'finding_ids', to_jsonb(ids)),
      (s.data -> 'period' ->> 'from')::timestamptz, (s.data -> 'period' ->> 'to')::timestamptz, 'ai', left(p_model, 80), left(p_prompt_version, 60), s.id, ids,
      'ai:' || s.id::text || ':' || idx);
    n := n + 1;
  end loop;
  perform private.emit_event(s.organization_id, 'sales.recommendations_generated', 'sales_snapshot', s.id, null,
    jsonb_build_object('event_type', 'sales.recommendations_generated', 'schema_version', 1, 'organization_id', s.organization_id, 'snapshot_id', s.id, 'count', n,
      'source', 'sales_intelligence_agent', 'occurred_at', now()), null, 'sales.recommendations_generated:' || s.id::text);
  return jsonb_build_object('saved', n, 'snapshot_id', s.id);
end;
$$;

-- ───────────────────────── reports ─────────────────────────

create or replace function public.si_report_request(p_org uuid, p_kind text, p_preset text, p_from date, p_to date, p_filters jsonb, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.sales_report_runs;
  pr record;
  tz text;
  f jsonb := coalesce(p_filters, '{}');
begin
  if not public.has_perm(p_org, 'reports.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if coalesce(p_idempotency_key, '') !~ '^[A-Za-z0-9_:-]{8,120}$' then perform private.fail('VALIDATION_ERROR', 'Invalid idempotency key'); end if;
  if p_kind not in ('executive_summary', 'lead_sources', 'funnel', 'team', 'appointments_follow_ups', 'pipeline_forecast', 'data_quality_impact', 'recommendations') then
    perform private.fail('VALIDATION_ERROR', 'Unknown report');
  end if;
  if p_kind = 'team' and not public.has_perm(p_org, 'team.view') then perform private.fail('FORBIDDEN', 'Team reports need team access'); end if;
  if p_kind = 'pipeline_forecast' and not public.has_perm(p_org, 'finance.view') then perform private.fail('FORBIDDEN', 'Pipeline and forecast reports need finance access'); end if;
  if jsonb_typeof(f) <> 'object' or exists (select 1 from jsonb_each(f) e where e.key not in ('source', 'assignee', 'property_type', 'transaction', 'lead_status') or jsonb_typeof(e.value) <> 'string')
     or (f ? 'assignee' and (f ->> 'assignee' !~ '^[0-9a-f-]{36}$' or ((f ->> 'assignee')::uuid is distinct from auth.uid() and not public.has_perm(p_org, 'team.view')))) then
    perform private.fail('VALIDATION_ERROR', 'Invalid filters');
  end if;
  select * into r from public.sales_report_runs where organization_id = p_org and idempotency_key = p_idempotency_key;
  if r.id is not null then return jsonb_build_object('report_id', r.id, 'status', r.status, 'replayed', true); end if;
  select timezone into tz from public.organizations where id = p_org;
  select * into pr from private.si_period(p_preset, p_from, p_to, tz);
  insert into public.sales_report_runs (organization_id, kind, period_from, period_to, filters, includes_team, includes_financials, requested_by, idempotency_key)
  values (p_org, p_kind, pr.f, pr.t, f, p_kind = 'team',
    public.has_perm(p_org, 'finance.view') and p_kind in ('executive_summary', 'pipeline_forecast', 'lead_sources', 'team'), auth.uid(), p_idempotency_key)
  returning * into r;
  perform private.write_audit(p_org, 'sales.report_requested', 'sales_report_runs', r.id, jsonb_build_object('kind', p_kind));
  return jsonb_build_object('report_id', r.id, 'status', r.status);
end;
$$;

-- Builds a report from the same computations as the dashboard, within what the requester was allowed at request time.
create or replace function private.si_report_build(r public.sales_report_runs)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid := r.organization_id;
  tz text := (select timezone from public.organizations where id = org);
  span interval := r.period_to - r.period_from;
  pf timestamptz := r.period_from - span;
  m text;
  sec jsonb := '{}';
  mets text[];
  dim text;
  cat jsonb := private.si_catalogue();
begin
  mets := case r.kind
    when 'executive_summary' then array['leads_created', 'leads_qualified', 'qualification_rate', 'qualified_to_appointment_rate', 'appointments_booked', 'attendance_rate',
      'median_first_response_minutes', 'deals_won', 'deal_win_rate', 'open_deals', 'pipeline_value', 'closed_deal_value', 'commission_revenue']
    when 'lead_sources' then array['leads_created', 'qualification_rate', 'qualified_to_appointment_rate', 'appointments_booked', 'deals_won', 'median_days_to_qualified', 'closed_deal_value']
    when 'team' then array['leads_created', 'leads_contacted', 'median_first_response_minutes', 'leads_qualified', 'appointments_booked', 'appointments_completed', 'deals_won',
      'leads_no_next_action', 'closed_deal_value']
    when 'appointments_follow_ups' then array['appointments_booked', 'appointments_completed', 'appointments_no_show', 'appointments_cancelled', 'appointments_outcome_unknown',
      'attendance_rate', 'follow_ups_sent', 'follow_ups_delivered', 'follow_ups_failed', 'calls_attempted', 'calls_connected']
    when 'pipeline_forecast' then array['open_deals', 'pipeline_value', 'deals_opened', 'deals_won', 'deal_win_rate', 'closed_deal_value', 'average_deal_value', 'commission_revenue']
    else array['leads_created', 'leads_awaiting_qualification', 'leads_no_next_action'] end;
  dim := case r.kind when 'lead_sources' then 'source' when 'team' then 'assignee' end;
  foreach m in array mets loop
    continue when (cat -> m ->> 'perm') = 'finance.view' and not r.includes_financials;
    sec := sec || jsonb_build_object(m, private.si_run(org, m, dim, r.period_from, r.period_to, pf, r.period_from, r.filters, true, null, 200));
  end loop;
  return jsonb_build_object(
    'title', case r.kind when 'executive_summary' then 'Executive sales summary' when 'lead_sources' then 'Lead source performance' when 'funnel' then 'Sales funnel analysis'
      when 'team' then 'Representative performance' when 'appointments_follow_ups' then 'Appointments and follow-ups' when 'pipeline_forecast' then 'Pipeline and forecast'
      when 'data_quality_impact' then 'Data quality impact' else 'Sales intelligence recommendations' end,
    'organization', (select name from public.organizations where id = org), 'kind', r.kind,
    'period', jsonb_build_object('from', r.period_from, 'to', r.period_to, 'timezone', tz), 'previous_period', jsonb_build_object('from', pf, 'to', r.period_from),
    'filters', r.filters, 'generated_at', now(), 'catalogue_version', 'si-metrics/1', 'metrics', sec,
    'funnel', case when r.kind in ('funnel', 'executive_summary') then private.si_funnel_compute(org, r.period_from, r.period_to, r.filters, false) end,
    'forecast', case when r.kind = 'pipeline_forecast' then (select jsonb_build_object('id', id, 'status', status, 'horizon_start', horizon_start, 'horizon_end', horizon_end,
        'method', method, 'results', results, 'assumptions', assumptions, 'caveats', caveats, 'computed_at', computed_at)
        from public.sales_forecast_runs where organization_id = org and status in ('completed', 'insufficient_data') order by created_at desc limit 1) end,
    'insights', case when r.kind in ('recommendations', 'executive_summary') then (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'title', title, 'priority', priority,
        'status', status, 'summary', summary, 'recommended_action', recommended_action, 'evidence', evidence, 'generated_by', generated_by) order by priority, last_detected_at desc), '[]')
        from public.sales_insights where organization_id = org and status in ('new', 'reviewed', 'accepted', 'in_progress')) end,
    'data_quality', case when r.kind = 'data_quality_impact' then public.crm_data_quality_context(org) end,
    'caveats', private.si_quality_caveats(org, 'cohort'),
    'definitions', (select jsonb_object_agg(k, cat -> k ->> 'definition') from unnest(mets) k),
    'excluded', case when not r.includes_financials then jsonb_build_array('Financial metrics (requires finance access)') else '[]'::jsonb end);
end;
$$;

-- ───────────────────────── settings ─────────────────────────

create or replace function public.si_settings_save(p_org uuid, p_rules jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ver int;
begin
  if not public.has_perm(p_org, 'settings.manage') then perform private.fail('FORBIDDEN', 'You cannot change sales intelligence settings'); end if;
  if jsonb_typeof(p_rules) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_rules) k where k not in ('min_sample', 'maturity_days', 'min_closed_deals', 'stage_probabilities', 'targets',
          'no_next_action_share', 'attendance_floor', 'anomaly'))
     or (p_rules ? 'min_sample' and coalesce((p_rules ->> 'min_sample')::int, 0) not between 3 and 1000)
     or (p_rules ? 'maturity_days' and coalesce((p_rules ->> 'maturity_days')::int, 0) not between 1 and 365)
     or (p_rules ? 'min_closed_deals' and coalesce((p_rules ->> 'min_closed_deals')::int, 0) not between 3 and 1000)
     or (p_rules ? 'no_next_action_share' and coalesce((p_rules ->> 'no_next_action_share')::numeric, -1) not between 0 and 1)
     or (p_rules ? 'attendance_floor' and coalesce((p_rules ->> 'attendance_floor')::numeric, -1) not between 0 and 1)
     or (p_rules ? 'anomaly' and jsonb_typeof(p_rules -> 'anomaly') <> 'object')
     or (p_rules ? 'targets' and jsonb_typeof(p_rules -> 'targets') <> 'object')
     or (p_rules ? 'stage_probabilities' and jsonb_typeof(p_rules -> 'stage_probabilities') <> 'null' and (jsonb_typeof(p_rules -> 'stage_probabilities') <> 'object'
         or exists (select 1 from jsonb_each(p_rules -> 'stage_probabilities') e where e.key not in ('qualification', 'viewing', 'offer', 'negotiation', 'under_contract')
                    or jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric not between 0 and 1)))
     or (p_rules ? 'targets' and exists (select 1 from jsonb_each(p_rules -> 'targets') e where e.key not in ('leads_created', 'leads_qualified', 'appointments_booked', 'deals_won')
          or jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric < 0))
  then
    perform private.fail('VALIDATION_ERROR', 'Sales intelligence settings are invalid');
  end if;
  insert into public.sales_intelligence_settings (organization_id, rules, updated_by) values (p_org, p_rules, auth.uid())
  on conflict (organization_id) do update set rules = excluded.rules, version = public.sales_intelligence_settings.version + 1, updated_by = excluded.updated_by
  returning version into ver;
  return ver;
exception
  when invalid_text_representation then perform private.fail('VALIDATION_ERROR', 'Sales intelligence settings are invalid'); return null;
end;
$$;

-- ───────────────────────── worker tick (pg_cron) ─────────────────────────

create or replace function public.sales_intelligence_tick(p_limit int default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.sales_report_runs;
  fr public.sales_forecast_runs;
  o record;
  res jsonb;
  tz text;
  act jsonb;
  err jsonb;
  reports int := 0;
  forecasts int := 0;
  evaluated int := 0;
  orgs int := 0;
begin
  for r in select * from public.sales_report_runs where status = 'queued' order by created_at limit p_limit for update skip locked loop
    begin
      res := private.si_report_build(r);
      update public.sales_report_runs set status = 'completed', result = res, completed_at = now() where id = r.id;
      perform private.emit_event(r.organization_id, 'sales.report_completed', 'sales_report_run', r.id, null,
        jsonb_build_object('event_type', 'sales.report_completed', 'schema_version', 1, 'organization_id', r.organization_id, 'report_id', r.id, 'kind', r.kind,
          'source', 'sales_intelligence_agent', 'occurred_at', now()), null, 'sales.report_completed:' || r.id::text);
    exception when others then
      update public.sales_report_runs set status = 'failed', error = left(sqlerrm, 300), completed_at = now() where id = r.id;
    end;
    reports := reports + 1;
  end loop;

  for fr in select * from public.sales_forecast_runs where status = 'queued' order by created_at limit p_limit for update skip locked loop
    begin
      res := private.si_forecast_compute(fr.organization_id, fr.horizon_start, fr.horizon_end);
      update public.sales_forecast_runs set status = res ->> 'status', method = res ->> 'method', results = res -> 'results', assumptions = res -> 'assumptions',
        caveats = (res -> 'caveats') || jsonb_build_array(jsonb_build_object('input_window', res -> 'input_window')), computed_at = now() where id = fr.id;
      perform private.emit_event(fr.organization_id, 'sales.forecast_completed', 'sales_forecast_run', fr.id, null,
        jsonb_build_object('event_type', 'sales.forecast_completed', 'schema_version', 1, 'organization_id', fr.organization_id, 'forecast_id', fr.id, 'status', res ->> 'status',
          'source', 'sales_intelligence_agent', 'occurred_at', now()), null, 'sales.forecast_completed:' || fr.id::text);
    exception when others then
      update public.sales_forecast_runs set status = 'failed', error = left(sqlerrm, 300), computed_at = now() where id = fr.id;
    end;
    forecasts := forecasts + 1;
  end loop;

  -- Backtest: once a horizon has ended, record what actually closed and the absolute error per currency.
  for fr in select * from public.sales_forecast_runs where status = 'completed' and evaluated_at is null and horizon_end < current_date limit p_limit for update skip locked loop
    select timezone into tz from public.organizations where id = fr.organization_id;
    select coalesce(jsonb_object_agg(currency, v), '{}') into act from (select currency::text, sum(expected_value) v from public.deals
      where organization_id = fr.organization_id and stage = 'won' and closed_at >= fr.horizon_start::timestamp at time zone tz
        and closed_at < (fr.horizon_end + 1)::timestamp at time zone tz group by 1) a;
    select coalesce(jsonb_object_agg(k, abs(coalesce((act ->> k)::numeric, 0) - (fr.results -> k ->> 'forecast_value')::numeric)), '{}') into err
    from jsonb_object_keys(fr.results) k where fr.results -> k ->> 'forecast_value' is not null;
    update public.sales_forecast_runs set actuals = act, abs_error = err, evaluated_at = now() where id = fr.id;
    evaluated := evaluated + 1;
  end loop;

  for o in select org.id from public.organizations org
           where not exists (select 1 from public.sales_daily_evaluations d where d.organization_id = org.id and d.day = current_date) limit 20 loop
    begin
      res := private.si_evaluate(o.id);
    exception when others then
      res := jsonb_build_object('error', left(sqlerrm, 300));
    end;
    insert into public.sales_daily_evaluations (organization_id, day, result) values (o.id, current_date, res) on conflict do nothing;
    orgs := orgs + 1;
  end loop;
  return jsonb_build_object('reports', reports, 'forecasts', forecasts, 'evaluated_forecasts', evaluated, 'orgs_evaluated', orgs);
end;
$$;

-- Lets a manager re-run today's evaluation on demand (same rules, same idempotent insights).
create or replace function public.si_evaluate_now(p_org uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  res jsonb;
begin
  if not public.has_perm(p_org, 'reports.view') then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
  if not (public.has_perm(p_org, 'team.view') or public.has_perm(p_org, 'settings.manage')) then perform private.fail('FORBIDDEN', 'Managers run the evaluation'); end if;
  res := private.si_evaluate(p_org);
  insert into public.sales_daily_evaluations (organization_id, day, result) values (p_org, current_date, res)
  on conflict (organization_id, day) do update set result = excluded.result;
  return res;
end;
$$;

-- ───────────────────────── privileges ─────────────────────────

revoke all on function private.si_default_rules(), private.si_rules(uuid), private.si_catalogue(), private.si_key(text, text, text, uuid, text, text, text, text, timestamptz),
  private.si_lead_ok(public.leads, jsonb), private.si_has_lead_filter(jsonb), private.si_compute(uuid, text, timestamptz, timestamptz, jsonb, text, text),
  private.si_period(text, date, date, text), private.si_quality_caveats(uuid, text),
  private.si_run(uuid, text, text, timestamptz, timestamptz, timestamptz, timestamptz, jsonb, boolean, text, int),
  private.si_funnel_compute(uuid, timestamptz, timestamptz, jsonb, boolean), private.si_forecast_compute(uuid, date, date),
  private.si_upsert_insight(uuid, text, text, text, text, text, text, text, text, text, jsonb, timestamptz, timestamptz, jsonb), private.si_z(numeric, numeric, numeric, numeric),
  private.si_evaluate(uuid), private.si_report_build(public.sales_report_runs)
  from public, anon, authenticated;
revoke execute on function public.sales_intelligence_tick(int) from public, anon, authenticated;
grant execute on function public.sales_intelligence_tick(int) to service_role;
revoke execute on function public.si_metric_catalogue(), public.si_query(uuid, jsonb, boolean), public.si_overview(uuid, text, date, date, jsonb),
  public.si_breakdown(uuid, text, text[], text, date, date, jsonb), public.si_funnel(uuid, text, date, date, jsonb, boolean),
  public.si_forecast_request(uuid, date, date, text), public.si_insight_feedback(uuid, text, text), public.si_recommendation_context(uuid),
  public.si_recommendations_save(uuid, jsonb, text, text), public.si_report_request(uuid, text, text, date, date, jsonb, text), public.si_settings_save(uuid, jsonb),
  public.si_evaluate_now(uuid) from public, anon;
grant execute on function public.si_metric_catalogue(), public.si_query(uuid, jsonb, boolean), public.si_overview(uuid, text, date, date, jsonb),
  public.si_breakdown(uuid, text, text[], text, date, date, jsonb), public.si_funnel(uuid, text, date, date, jsonb, boolean),
  public.si_forecast_request(uuid, date, date, text), public.si_insight_feedback(uuid, text, text), public.si_recommendation_context(uuid),
  public.si_recommendations_save(uuid, jsonb, text, text), public.si_report_request(uuid, text, text, date, date, jsonb, text), public.si_settings_save(uuid, jsonb),
  public.si_evaluate_now(uuid) to authenticated;

-- ───────────────────────── schedule ─────────────────────────

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if not exists (select 1 from cron.job where jobname = 'sales-intelligence-tick') then
      perform cron.schedule('sales-intelligence-tick', '* * * * *', 'select public.sales_intelligence_tick(10)');
    end if;
  end if;
end;
$$;
