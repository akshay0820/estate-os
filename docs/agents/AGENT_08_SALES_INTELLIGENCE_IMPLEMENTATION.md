# Agent 08 — AI Sales Intelligence Agent (`sales_intelligence_agent`)

Status: **implemented, tested, applied and verified live** (2026-10-26). The two Claude Edge Functions are written and unit-tested but **not yet deployed** (see 13). Sections 1–8 are the design and metric catalogue; 9 onward record what was built and verified.

## 1. Discovered data (2026-10-26)

| Business concept | In the repository | Use |
|---|---|---|
| Leads | `leads` (source, campaign, assignee, transaction, property type, status, `first_response_at` = first move out of `new`, `qualified_at`, `next_follow_up_at`, `archived_at`; merged duplicates are archived with `metadata.merged_into`) | Cohorts, attribution (source recorded at capture), funnel |
| Stage history | `lead_status_history` (from → to, timestamp) | "Reached stage" independent of the current status |
| Qualification | `lead_qualifications` (current row, status, review status) | Awaiting qualification, human review |
| Calls | `voice_calls` (requested / initiated / started / ended, `outcome = connected`) | Attempts vs connections, time to first call / connection |
| Follow-ups | `follow_ups` (`sent` / `delivered` / `failed`, `sent_via` manual / provider) | Sent vs delivered; **delivery is only observable with a messaging provider (none connected)** |
| Matching | `property_match_runs`, `property_matches` | Leads matched, match → appointment |
| Appointments | `appointments` (`confirmed_at`, status completed / no_show / cancelled, `starts_at`) | Booked (confirmed only), attendance, cancellations |
| Deals | `deals` (stage qualification → under_contract / won / lost, `expected_value`, `currency`, `commission_pct`, `expected_close_date`, `owner_user_id`, `closed_at`) | Pipeline, closed transaction value, win rate, forecast |
| Commission | `commissions` (gross commission, status estimated / approved / payable / paid, currency) | Commission revenue (approved or later) |
| Data quality | Agent 07 `crm_data_quality_context`, `data_quality_issues`, `duplicate_candidates` | Caveats and canonical counting |
| Existing analytics | `dashboard_metrics` (dashboard), demo-only Reports page | Dashboard kept; Reports page becomes live via Agent 08 |
| Missing | Deal stage history, sales targets, advertising spend, multi-touch attribution, messaging delivery receipts | Reported as unavailable; targets become optional settings |

## 2. Financial definitions (kept separate)

- **Closed transaction value**: sum of `deals.expected_value` for deals won (`closed_at` in period), per currency. It is the property transaction value, **not agency revenue** (the existing dashboard's "won value" is this figure).
- **Commission revenue**: sum of `commissions.gross_commission` with status approved, payable or paid, for deals won in the period, per currency. Estimated commissions are shown separately and never as revenue.
- **Pipeline value**: sum of `expected_value` of open deals (not won / lost), per currency, as of now.
- **Weighted pipeline / forecast**: see section 6. Currencies are never added together.

## 3. Metric catalogue (`si-metrics/1`)

Every metric is computed in SQL by `private.si_compute` from persisted rows; the same function serves the dashboard, team and source views, reports and the natural-language analyst.

| Id | Basis | Definition (numerator / denominator) |
|---|---|---|
| `leads_created` | leads created in period | Non-archived leads (merged duplicates excluded) |
| `leads_contacted` | cohort | Cohort leads that reached `contacted` or later (history or current), or had a connected call |
| `leads_qualified` | cohort | Cohort leads that reached `qualified` or later (history, current status or `qualified_at`) |
| `qualification_rate` | cohort | `leads_qualified` / `leads_created` |
| `leads_matched` | cohort | Cohort leads with at least one recommended property |
| `qualified_to_appointment_rate` | cohort | Qualified cohort leads with a confirmed appointment / qualified cohort leads |
| `appointments_booked` | appointments created in period | Appointments that were confirmed (`confirmed_at` set). Requested / pending proposals are not bookings |
| `appointments_completed`, `appointments_no_show`, `appointments_cancelled` | appointments starting in period | Final status |
| `attendance_rate` | appointments starting in period | completed / (completed + no-show); past confirmed appointments without an outcome are excluded and counted as `outcome_unknown` |
| `calls_attempted`, `calls_connected` | calls initiated in period | Initiated calls (blocked requests excluded); `outcome = connected` |
| `follow_ups_sent` | follow-ups sent in period | `sent` or `delivered` messages (manual sends recorded by a person included) |
| `follow_ups_delivered` | — | **Unavailable** unless a messaging integration is connected (no delivery receipts otherwise) |
| `follow_ups_failed` | follow-ups created in period | Status `failed` |
| `median_first_response_minutes` | cohort | Median of `first_response_at − created_at` (first recorded move out of `new`, by a person or an agent) |
| `median_first_call_minutes` | cohort | Median of first initiated call − created |
| `median_first_connection_minutes` | cohort | Median of first connected call − created |
| `median_days_to_qualified` | cohort | Median of `qualified_at − created_at` |
| `leads_awaiting_qualification`, `leads_human_review`, `leads_no_next_action`, `leads_follow_up_overdue` | snapshot now | Open leads with no current qualification or one still in progress; current qualification pending review; no future follow-up date, no active appointment, no active follow-up and no open task; `next_follow_up_at` in the past |
| `deals_opened`, `deals_won`, `deal_win_rate` | deals | Created in period; won with `closed_at` in period; won / (won + lost) closed in period |
| `closed_deal_value`, `average_deal_value`, `commission_revenue` | won deals in period | Per currency; requires `finance.view` |
| `open_deals`, `pipeline_value` | snapshot now | Per currency |

Dimensions: `source`, `assignee` (the record's owner: lead assignee, appointment assignee, deal owner), `property_type`, `transaction`, `lead_type`, `appointment_type`, `day` / `week` / `month` (org time zone). Filters: source, assignee, property type, transaction, lead status. Rates with a denominator below the configured minimum sample (default 10) are flagged `low_sample`. Percentage change is returned only when the previous value is positive; rates report percentage-point change.

## 4. Funnel (cohort)

Leads created in the period, each stage counted independently from persisted evidence: captured → contacted → qualified → matched → appointment booked (confirmed) → attended (completed) → deal opened → won. For each stage: count, share of the cohort, step conversion (reached this stage among those that reached the previous one), drop-off, and median days from creation where a timestamp exists. Maturity: leads younger than `maturity_days` (default 30) are counted separately and can be excluded (`mature_only`), so recent leads are not counted as lost.

## 5. Anomalies and findings (deterministic, daily)

Weekly windows against an 8-week baseline (needs ≥ 4 baseline weeks): lead intake drop / spike (≥ 2 standard deviations and ≥ 30 % / 50 %); qualification rate change on mature cohorts (two-proportion z ≥ 2, n ≥ 30); cancellation rate rise (z ≥ 2, n ≥ 20); first-response slowdown (median ×1.5, n ≥ 20); follow-up failure rate rise. Findings: largest funnel drop-off, leads without a next action, overdue follow-ups, low attendance, unmatched requirements, unresolved high-severity data quality issues. Each is fingerprinted, refreshed while true and expired when the condition clears; evidence stores the rule, values, windows and sample sizes. Correlation is never presented as cause.

## 6. Forecast

- Inputs: open deals with `expected_close_date` inside the horizon, per currency; closed deals of the previous 365 days for the win rate.
- Method `historical_win_rate`: forecast = Σ expected value × win rate, with ≥ `min_closed_deals` (default 10) closed deals; otherwise **insufficient data**. `configured_stage_probabilities` when an admin configures them.
- Scenario bounds (labelled as scenarios, not a confidence interval): low = deals under contract; high = all open deals closing in the window.
- Commission forecast: Σ weighted value × the deal's own `commission_pct`.
- Backtest: when a horizon ends, the actual won value is recorded and the absolute error stored; mean absolute error is shown only over evaluated runs.

## 7. Claude

- `sales-intelligence-recommend` (user JWT): the server builds an analytical snapshot (metrics + findings), stores it, and asks Claude for structured recommendations that cite only snapshot metric ids and finding ids. Every cited value must match the snapshot, and invented ids or numbers are rejected. The output is stored as recommendations with a lifecycle.
- `sales-analyst` (user JWT): Claude maps a question to a query spec (catalogue metrics and dimensions only). The spec is validated and executed by `si_query` as the user; the answer text is generated deterministically from the results. No SQL is generated by the model. Without a key both functions answer `not_configured`; deterministic findings and the structured query builder still work.

## 8. Security

`reports.view` for the analytics; team breakdowns need `team.view` (otherwise only the caller's own records); money metrics need `finance.view`; settings need `settings.manage`. The tenant comes from the record or is checked with `has_perm` on every call. Snapshots, reports and insights are RLS-scoped (financial reports also need `finance.view`). The analyst stores the validated spec and status only, not the question text.

## 9. What was built

| Piece | Where |
|---|---|
| Migration (additive) | `supabase/migrations/20261025001700_sales_intelligence_agent.sql`: tables `sales_intelligence_settings`, `sales_snapshots`, `sales_insights`, `sales_forecast_runs`, `sales_report_runs`, `sales_analyst_queries`, `sales_daily_evaluations` (all RLS, no direct user writes); no existing object changed |
| Metric layer | `private.si_catalogue` (33 metrics, `si-metrics/1`), `si_compute` (every metric, grouped by one dimension), `si_period` (presets in the org time zone and comparison windows), `si_run` (values, previous values, change, percentage change only when the previous value is positive, percentage points for rates, small-sample flags, maturity and data quality caveats) |
| Public API (RPC) | `si_metric_catalogue`, `si_query` (validated spec; optional logging for the analyst), `si_overview`, `si_breakdown` (source / team / trends), `si_funnel`, `si_forecast_request`, `si_report_request`, `si_insight_feedback`, `si_evaluate_now`, `si_recommendation_context`, `si_recommendations_save`, `si_settings_save` |
| Jobs | `public.sales_intelligence_tick` (pg_cron `sales-intelligence-tick`, every minute, `service_role` only): queued reports and forecasts, forecast backtests, daily evaluation per org |
| Insights | `private.si_evaluate`: anomaly rules (intake drop / spike, qualification-within-7-days change, cancellation rise, first-response slowdown, follow-up failures) and findings (no next action, overdue follow-ups, funnel bottleneck, low attendance, unmatched requirements, data quality risk); fingerprinted, refreshed while true, expired when cleared |
| Claude | `_shared/sales-intelligence.ts` (recommendation schema + validator: cited values must be in the snapshot, numbers in the prose must be derivable, unknown findings and "already done" claims rejected; analyst spec schema + validator; deterministic answer formatter); `sales-intelligence-recommend/index.ts`; `sales-analyst/index.ts` |
| Frontend | `features/salesIntelligence.tsx`: Sales intelligence page (filters: period, source, owner, property type, transaction; tabs Overview, Funnel, Lead sources, Team, Trends, Insights, Forecast, Ask) and the live Reports page (generate, status, CSV / JSON download); `backend/live.ts` Agent 08 section; nav "Sales intelligence" (`reports.view`); Agent 08 card ("8 of 8 built") |

## 10. Event contract

Published to `public.outbox_events` in the same transaction (no consumer yet), `schema_version` 1, `source` `sales_intelligence_agent`, ids only:
`sales.insight_detected` (new or reopened anomaly / finding), `sales.insight_expired`, `sales.recommendations_generated`, `sales.forecast_completed`, `sales.report_completed`.
Agent 08 does not consume events to maintain aggregates: metrics are computed from persisted records on request (indexed, bounded to 400 days), so there is no cache to invalidate and no event-ordering problem; reports and forecasts are stored snapshots with their computation time.

## 11. Tests and results (2026-10-26)

- **Full suite: 236 / 236 pass** (21 files, `npx vitest run`). Typecheck clean; production build OK. The repository has no ESLint configuration, so no linter ran.
- `tests/db/sales-intelligence-agent.test.ts` (15, PGlite):
  - catalogue-only queries (unknown metric, extra `sql` field, bad dimension / filter / period rejected);
  - cohort counts from evidence (archived duplicate excluded, qualified-then-lost still qualified, contacted via connected call);
  - comparisons without invented percentages;
  - only confirmed appointments counted as booked, unknown outcomes excluded from attendance;
  - delivery unavailable without a provider;
  - money behind `finance.view`, currencies never mixed, commission separate from transaction value, no won deals → no value (not zero revenue);
  - team breakdowns need `team.view`;
  - funnel stage counts, step conversion and maturity;
  - forecast: finance only, insufficient history, configured probabilities per currency with a commission forecast, backtest against actual closings;
  - intake-drop anomaly against an 8-week baseline, idempotent refresh, expiry when cleared; no-next-action finding;
  - insight lifecycle (permissions, notes, transitions, completed not reopened);
  - recommendations rejected when citing a value or finding not in the snapshot, saved once per snapshot;
  - reports scoped to the requester's permissions and hidden from others by RLS;
  - tenant isolation of every RPC and table;
  - analyst log stores the spec and status (answered / forbidden), not the question.
- `tests/sales-intelligence.test.ts` (6, Node): recommendation validator (kept, invented value, stray number, unknown finding, "already done" claim, schema), analyst spec validator (defaults, unknown metric, bad dimension / range, extra fields, unsupported passthrough), deterministic answers.
- **Live on "Estate OS"** (test workspaces): **15 / 15 pass**.
  - 30 KPIs with comparison windows; delivery shown as unavailable; Agent 07 caveats attached.
  - `leads_created` equals a direct row count of the same window (23 = 23) and the funnel cohort; the source breakdown sums to the total.
  - Invalid specs are rejected; the analyst path logs its query.
  - A forecast run completed by the cron as `insufficient_data` (1 closed deal, 10 needed).
  - The executive report completed with financials for the owner.
  - On-demand evaluation detected overdue follow-ups and a data quality risk.
  - A recommendation citing an invented value was refused.
  - Another workspace gets `NOT_FOUND` everywhere and reads nothing; the tick is closed to users.
- Migration applied as `20261026080656`; all 29 function bodies match the file (md5 of `prosrc`); cron `sales-intelligence-tick` active; all 7 new tables have RLS with a read policy.
- Browser (owner, live): every tab renders real data. That includes KPIs with windows, the caveat banner linking to Data quality, the funnel with its maturity note and small-sample marks, the source and team tables with notes, insights with lifecycle buttons, the forecast showing insufficient history and scenario bounds labelled as not a confidence interval, the query builder, and the live Reports page with CSV / JSON downloads.

## 12. Setup and operations

- Nothing is required for metrics, the funnel, insights, forecasts and reports (the cron runs every minute; the daily evaluation runs once per org per day).
- Optional settings (`si_settings_save`, `settings.manage`): `min_sample`, `maturity_days`, `min_closed_deals`, `stage_probabilities` (per open stage, 0–1), monthly `targets` (leads_created, leads_qualified, appointments_booked, deals_won), anomaly thresholds.
- Optional `ANTHROPIC_API_KEY` (and `SALES_INTELLIGENCE_MODEL`, `SALES_ANALYST_MODEL`) as Edge Function secrets for AI recommendations and natural-language questions.

## 13. Limitations and pending work

- **Edge Functions not deployed.** `sales-intelligence-recommend` and `sales-analyst` are written and unit-tested, but this session's Supabase deploy tool had no parameter schema, so they could not be deployed. Until they are, "Generate AI recommendations" and natural-language "Ask" report an error; the rule-based insights and the query builder work. Deploy with `supabase functions deploy sales-intelligence-recommend sales-analyst` (JWT verification on).
- There are no sales targets, advertising spend or multi-touch attribution in the data. Cost per lead, ROI and target attainment are shown as unavailable (targets become available once configured).
- There is no deal stage history. Forecasts use one win rate per currency (or configured stage probabilities), not stage-to-stage conversion. With fewer than 10 closed deals in a year the forecast is `insufficient_data` (the live workspace has 1).
- "First response" is the first recorded move out of New (by a person or an agent); calls and connections are separate metrics. Business hours are not applied.
- Follow-up delivery cannot be observed without a messaging provider, and replies to follow-ups are not recorded, so no response rate is computed.
- Funnel stages count recorded evidence only; work not recorded in the CRM is invisible.
- Seasonality is not modelled; anomaly rules need 4+ baseline weeks and minimum samples.
- Metrics are computed on request rather than cached. That is fine at current volumes, but they should move to snapshots if tenants grow to hundreds of thousands of leads.
