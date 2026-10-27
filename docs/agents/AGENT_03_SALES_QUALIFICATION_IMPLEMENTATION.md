# Agent 03 — AI Sales & Qualification Agent (`sales_qualification_agent`)

Status: **implemented and verified** (2026-10-25); the optional Claude step is wired but not exercised with a real key. Sections 1–9 are the plan; 10 onward record what was built.

## 1. Discovered architecture (2026-10-25)

| Area | Found | Decision |
|---|---|---|
| Backend | Supabase Postgres + RLS. Rules live in SECURITY DEFINER SQL; Deno Edge Functions handle provider/LLM HTTP; pg_cron is the scheduler | Same split: the engine is deterministic SQL, the LLM step is an Edge Function |
| Runtime | `agent_runs`, `agent_run_steps`, `outbox_events` (+ `outbox_claim/ack`, lease and backoff), `review_items` | Reused unchanged. Agent 3 is the existing `sales_qualification_agent` outbox consumer |
| Upstream events | `lead.ready_for_qualification` (Agent 01, ids + `missing_information`) and `voice_call.completed` (Agent 02, ids + outcome + `requires`) | Both consumed. The payload is never trusted beyond ids; the lead is re-read in the event's org |
| Lead data | `leads` has requirement columns (`desired_transaction`, `lead_type`, budget, currency, type, bedrooms, locations, timeline, amenities), `ai_extracted_fields` (AI provenance), and `metadata.intake.missing` (intent unknown at intake) | Lead columns stay the CRM source of truth; nothing is written to them without a person |
| Existing scoring | `leads.lead_score` from trigger `private.score_lead`: a fixed completeness heuristic shown as the score pill | **Kept.** The readiness score is a new, separate, configurable, evidence-based score on the qualification record, so behaviour that UI and reports depend on is not changed. Documented in the UI as "readiness" |
| Pipeline | `leads.status` includes `qualified` (sets `qualified_at`) | Moved to `qualified` only from `new`, `attempting` or `contacted`, and never moved backwards |
| Calls | `voice_calls.analysis` (evidence-checked extraction, `conflicts`, `unanswered_questions`), `outcome`, `human_handoff_status` | Used as evidence and engagement, never as verified facts |
| Consent | `communication_consents`, `contacts.lifecycle_status` | Recommendations never imply contact when suppressed |
| Review / tasks | `tasks` (assignee notification triggers), permission `approvals.decide` (owner/admin/manager) | Review = a task plus a review status on the record; deciding requires `approvals.decide` |
| Claude | `@anthropic-ai/sdk@0.133.0` with an evidence-quote validation pattern (Agents 01/02) | Same pattern; the model sees only the needed text, without names, phones or emails |

## 2. Data model (additive migration 0012)

- `qualification_settings` (per org, optional; defaults used when absent): versioned `rules` jsonb containing:
  - weights;
  - required fields per intent;
  - thresholds;
  - service scope (transactions, locations, property types);
  - max questions;
  - LLM on/off.
- `lead_qualifications`: one row per completed evaluation, so history is kept. Each row holds:
  - status, score (nullable = insufficient evidence) and breakdown;
  - `requirements` (merged view, with provenance per field), missing, conflicts, questions;
  - recommended action, review flags and review status;
  - analysis status, model meta, ruleset version, run id, trigger.

  Exactly one row per lead is `is_current`.
- `leads.qualification_status` + `leads.qualification_id`: guarded columns. Clients cannot write them; same pattern as intake status.

## 3. Qualification design

- **Context:**
  - the lead's requirement columns, with provenance: `crm`, or `ai_extracted` when listed in `ai_extracted_fields`;
  - intake missing info;
  - the latest analysed call: outcome, analysis, conflicts, handoff;
  - engagement evidence: connected calls, repeat enquiries, appointments, human call/message activity;
  - consent/suppression flags;
  - for the LLM only: inquiry text, the 3 latest call summaries and the 3 latest notes (≤ 1,000 characters each).
- **Claude (optional):** proposes intent, requirements, purpose, constraints, contradictions and suggested questions. Every value must carry a quote found in the provided source text.
  - The proposal is validated twice: in TypeScript, then with SQL normalization (the intake normalizer).
  - It only fills **empty** fields in the merged view, marked `stated` or `inferred`.
  - Differences from CRM values become **conflicts**; nothing is overwritten.
- **Deterministic engine** (`private.qual_evaluate`): missing fields per intent, conflicts, score, status, action and questions. Claude never decides the status or score.
- **Score (0–100, readiness):** six dimensions with configurable weights, normalized over the dimensions that apply to the intent.

  | Dimension | Default weight | What earns it |
  |---|---|---|
  | Intent clarity | 25 | Intent stated (inferred counts 60%) |
  | Requirement completeness | 20 | Share of required requirement fields present |
  | Budget clarity | 15 | Budget present; skipped for sell/let |
  | Timeline clarity | 15 | Timeline present (near-term or explicit counts more) |
  | Engagement evidence | 15 | Connected call, repeat enquiry, appointment, logged human contact. **Unanswered calls never subtract** |
  | Service fit | 10 | Inside the agency's configured scope |

  When intent is unknown and fewer than 2 dimensions are known, the score is `null` and the result is **insufficient evidence**.
- **Status:**
  - `needs_information`: a required field is missing.
  - `qualified`: required fields present and score ≥ threshold (default 60).
  - `high_intent`: score ≥ 80, timeline within 3 months, and engagement evidence present.
  - `nurture`: complete, but a far timeline or low score.
  - `human_review_required`: high-impact conflicts, possible withdrawal or wrong number, outside service scope, or a low-confidence (inferred-only) intent.
  - `disqualified`: only through a human decision.
  - `unqualified` / `in_progress`: the defaults before and during evaluation.

  Opt-out is a contact restriction, not a qualification status.
- **Actions:**
  - `recommend_property_matching` (emits the Agent 4 event);
  - `request_clarification` (creates one clarification task per lead, deduplicated);
  - `request_human_review` (task + review);
  - `request_human_callback` (when the call already requested a person; no duplicate task);
  - `continue_nurture`;
  - `no_action` (when do-not-contact applies);
  - `await_more_information`.

  A recommendation never contacts anyone.

## 4. Execution

```text
pg_cron qualification-tick (SQL, every minute)
  ├─ outbox_claim('sales_qualification_agent', [lead.ready_for_qualification, voice_call.completed]) → enqueue run (idempotent per event id) → ack
  └─ process runs that need no LLM, or whose LLM step finished / timed out (10 min)
pg_cron → pg_net → Edge Function qualification-worker (Vault shared secret)
  └─ claim runs awaiting analysis → minimal text → Claude → validate → attach → process
UI "Run qualification" → RPC qualification_request (leads.edit, idempotency key) → enqueue run
```

- Runs for the same lead are serialized; an older pending run is marked superseded.
- A failed attempt rolls back fully and retries with backoff (2 → 4 → 8 min, then dead letter).
- A failed or absent LLM never erases the previous result: the engine still runs on the deterministic data, with `analysis_status` = failed/skipped.

## 5. Events (outbox, schema_version 1, ids only)

| Event | Consumer | Dedupe |
|---|---|---|
| `lead.qualification.completed` | `property_matching_agent` | lead + requirements fingerprint, so unchanged requirements never re-trigger matching |
| `lead.qualification.needs_information` | published | qualification id |
| `lead.qualification.human_review_required` | published | qualification id |

Payload: `{event_type, schema_version, organization_id, lead_id, qualification_id, agent_run_id, correlation_id, occurred_at, status, recommended_action}`.

## 6. Security

- Org and lead come from the outbox row (written only by SQL) or from the caller's membership; every query is scoped to `lead.organization_id`.
- RLS: qualifications readable with `leads.view`, no client writes. Settings need `settings.manage`, review needs `approvals.decide`, requests need `leads.edit`.
- Model input is minimal and treated as data. The prompt says it is untrusted, output is schema-validated, quotes must exist in the source, and no ids or SQL are accepted.

## 7. API (RPC, following existing conventions)

- `qualification_request(lead, idempotency_key)`;
- `lead_qualification(lead)`: the current result, history and the latest run status;
- `qualification_review(qualification, decision approve|reject|override, status?, edits?, note)`:
  - edits are confirmed values written to the lead by a person, which triggers re-qualification;
- `qualification_settings_save(org, rules)`;
- service role only: `qualification_tick()`, `qualification_analysis_claim()`, `qualification_attach_analysis()`.

## 8. Frontend

- Lead overview gets a **Qualification** panel:
  - status, readiness score with breakdown, requirements with provenance chips;
  - missing, conflicts, suggested questions and recommended action;
  - analysis state;
  - actions: run, approve/reject/override, confirm proposed values.
- Agents page: the Agent 03 card shows real counts.

## 9. Testing plan

- **PGlite:**
  - the engine: buyer/renter/seller, with and without a call;
  - inference vs CRM provenance, conflicts, insufficient evidence;
  - opt-out awareness, scope, weights from settings;
  - outbox consumption, duplicate events and supersede;
  - analysis attach, failure that preserves the last result, timeout fallback;
  - review flows, events and dedupe, the pipeline move;
  - tenant isolation;
  - the privileged functions.
- **Unit (Node):** the analysis validator (evidence, enums, ranges, injection-shaped output).
- **Live:** apply, function hashes, cron, a real run on test data, RLS and cross-tenant checks.

---

## 10. What was built

| Piece | Where |
|---|---|
| Schema, rules, engine, consumer, model-step endpoints, review, settings, crons | `supabase/migrations/20261025001200_sales_qualification_agent.sql` (applied live as version `20261025170921`) |
| Claude step: schema, prompt, evidence-checked validation | `supabase/functions/_shared/qualification-analysis.ts` |
| Worker that calls Claude (cron via pg_net, Vault shared secret) | `supabase/functions/qualification-worker/index.ts` (deployed v1) |
| UI: lead **Qualification** panel; Agent 03 card on the AI agents page | `frontend/src/features/qualification.tsx`, `agentsLive.tsx`, `leads.tsx`, `backend/live.ts` |
| Tests | `frontend/tests/db/qualification-agent.test.ts` (17), `frontend/tests/qualification.test.ts` (4) |

Migration 0012 also widens `outbox_events_event_type_check` to allow three-part event names such as `lead.qualification.completed`.

### APIs (RPC)

| RPC | Who | Purpose |
|---|---|---|
| `qualification_request(lead, idempotency_key)` | `leads.edit` | Queue a (re)qualification. Idempotent per key; at most 10 per lead per hour (`RATE_LIMITED`) |
| `lead_qualification(lead)` | `leads.view` | Current result, recent history, latest run status, and whether the caller can run or review |
| `qualification_review(qualification, decision, status?, edits?, note?)` | `approvals.decide` | Decisions: `approve`, `reject` (note required), `override` (sets a status; note required) and `edit` (confirm proposed values). Edits are written to the lead as that reviewer and trigger re-qualification |
| `qualification_settings_save(org, rules)` | `settings.manage` | Saves a validated ruleset; the version increments on every save |
| `qualification_tick`, `qualification_process`, `qualification_analysis_claim`, `qualification_attach_analysis` | service role / cron only | Orchestration |

### Default rules (`qualification_settings.rules`)

- Weights: intent 25, requirements 20, budget 15, timeline 15, engagement 15, fit 10.
- Required fields:
  - buy / rent: locations, budget, property type, timeline;
  - sell / let: locations, property type, timeline;
  - invest: locations, budget, timeline.
- Thresholds: qualified ≥ 60, high intent ≥ 80.
- Scope: every transaction type; no location or property-type restriction.
- `max_questions` 3, `llm_enabled` true.

Saved keys override the defaults. There is no settings screen yet; see §13 for saving rules through the RPC.

### Scoring

- The score is normalized over the dimensions that apply to the intent (budget is skipped for sell and let).
- The record stores each dimension's weight, value, points and a short evidence string.
- Inferred values earn less than confirmed or stated ones.
- Engagement never goes negative: unanswered calls cost nothing.
- `null` means insufficient evidence.
- A complete buyer lead with no engagement scores **85** with the default rules.
- The existing `leads.lead_score` is unchanged.

## 11. Agent 04 contract

`lead.qualification.completed`:
- consumer `property_matching_agent`; stays `pending` until Agent 04 acks it;
- dedupe key: the lead plus an md5 of requirements and status;
- emitted when the engine or a human sets `qualified` or `high_intent`.

```json
{ "event_type": "lead.qualification.completed", "schema_version": 1, "organization_id": "…", "lead_id": "…",
  "qualification_id": "…", "agent_run_id": "…", "correlation_id": "…", "occurred_at": "…",
  "status": "qualified|high_intent", "recommended_action": "recommend_property_matching" }
```

The payload carries ids only, with no names, phones or requirement values. Unchanged requirements never produce a second event. `lead.qualification.needs_information` and `lead.qualification.human_review_required` are published as informational events.

## 12. Tests and results (2026-10-25)

| Check | Result |
|---|---|
| `npm test` (PGlite + vitest) | **134/134 pass**: 17 qualification DB tests, 4 validator tests and the earlier suites |
| `npm run typecheck`, `npm run build` | pass |
| Live script against the hosted project (real crons, test workspace E2E Realty A) | **13/13 pass** |
| Live function bodies vs migration file | all 16 identical (md5) |
| Cron → `qualification-worker` | HTTP 200 |
| Supabase advisors | only the expected SECURITY DEFINER warnings for the 4 user RPCs, each of which checks permissions itself |
| Browser | The lead panel showed: Qualified, readiness 85/100, default rules, all fields marked CRM. The Agents page shows Agent 03 live with real counts |

Live checks covered:
- the cron consumed the backlog of existing intake events (8 qualifications);
- a structured lead went through intake and qualification (85) to the Agent 04 event, and the pipeline moved to Qualified;
- free text with no Claude key → `not_configured` → needs information, plus one clarification task;
- the manual request is idempotent;
- a re-run adds history without a second Agent 04 event;
- an override without a note is refused, and one with a note is recorded with the reviewer;
- another organization cannot read, run, review or reconfigure;
- users cannot run the tick or write the qualification status;
- the worker rejects a wrong secret.

**Not executed:** a real Claude call (`ANTHROPIC_API_KEY` is not set). The validator and the attach path are tested with hand-written model outputs only.

## 13. Setup and operations

- **Claude (optional):** set `ANTHROPIC_API_KEY` as an Edge Function secret (optionally `QUALIFICATION_MODEL`; default `claude-opus-5-5`). Without it, results use CRM and call data only, with `analysis_status = not_configured`.
- **Jobs:** nothing to start.
  - `qualification-tick` (pure SQL, every minute) consumes events and processes runs.
  - `qualification-worker` (pg_net → Edge Function) handles the model step. Its URL and secret are in Vault (`qualification_worker_url`, `qualification_worker_secret`).
- **Trigger a qualification:**
  - The lead's Qualification panel → **Run qualification** (needs `leads.edit`), or the RPC `qualification_request`.
  - New leads and completed calls are qualified automatically.
- **Configure rules** (owner/admin): `select public.qualification_settings_save('<org>', '{"scope":{"locations":["Mumbai"]},"qualified_min_score":65}'::jsonb);`
- **Inspect:**
  - Runs: `agent_runs` / `agent_run_steps` where `agent_id = 'sales_qualification_agent'`. Failed runs show `retry_scheduled` or `dead_letter`.
  - Events: `outbox_events` where `event_type like 'lead.qualification.%'`.
  - Results: `lead_qualifications`.

## 14. Limitations

- **Claude:** never called live. Its proposals only fill gaps, are labelled stated or inferred, and reach the CRM only through a person.
- **Rules:** no settings screen; save them through the RPC.
- **Requirements:** only those with CRM columns are scored: intent, locations, budget, property type, bedrooms and timeline.
- **Re-qualification:** ordinary CRM edits do not re-qualify automatically; use Run qualification.
- **Two scores:** the old completeness `lead_score` still drives the score pill and lists. The readiness score appears in the Qualification panel only.
- **Review:** handled through tasks and the review status on the record; there is no dedicated queue screen.
- **History:** no retention policy yet.
- **Agent 04:** not built, so `lead.qualification.completed` events wait as `pending`.
- **Test data:** remains in the test workspace E2E Realty A.

## 15. Next step: Agent 04 (Property Matching)

Build Agent 04 as a consumer of `lead.qualification.completed`. For each event it should:
1. Claim it with `outbox_claim('property_matching_agent', ['lead.qualification.completed'], n)`.
2. Re-read the current qualification in the event's organization.
3. Use the requirements: `confirmed` values as hard filters, `stated` / `inferred` values as soft preferences.
4. Search verified, active properties in the same organization by transaction type, locality, budget, property type and bedrooms.
5. Rank them deterministically and store the matches with reasons.
6. Ack the event, then emit `lead.matches.ready`.

Agent 04 must not contact the lead.
