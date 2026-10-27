# Agent 07 — AI CRM & Data Intelligence Agent (`crm_data_agent`)

Status: **implemented, tested, applied and verified live** (2026-10-26). Sections 1–9 are the design; 10 onward record what was built and verified.

## 1. Discovered architecture (2026-10-26)

| Area | Found in the repository | Decision |
|---|---|---|
| CRM entities | `contacts` (`email_normalized`, `phone_e164` computed by `contacts_before`), `leads` (one contact each; `source`, `source_external_id`, budgets with `budget_currency`, `ai_extracted_fields`, `archived_at`, `metadata.merged_into`), `properties` (`reference_code` unique per org, `verified_at`), `appointments`, `deals`, `activities`, `communication_consents` | **Reused.** No parallel CRM tables. Two nullable redirect columns (`contacts.merged_into`, `properties.merged_into`) |
| Normalization | SQL: `private.normalize_phone` (10 digits → `+91…`, otherwise `+digits`), `lower(email)`, `private.intake_normalize` (Agent 01), `names_related` | Kept as the write-path normalizers (changing them would change existing identities). Agent 07 adds *checks* on top: E.164 plausibility (strict for +91), "country assumed" flag, stricter email syntax, whitespace in names, budget plausibility per transaction and currency |
| Duplicates | Agent 01 dedupes at intake (external id → phone / email, `review_items` for ambiguous). `merge_leads` merges two leads of the same contact. No contact or property merge; nothing finds historical duplicates | Agent 07 adds background candidate detection for contacts, leads and properties with explainable signals, a review queue and **human-approved** merges (contacts and properties new; leads reuse `merge_leads`) |
| Audit | `audit_logs` (append-only, changed column names), `private.write_audit`, `private.audit_row` on CRM tables | Reused for every Agent 07 decision. No second audit log |
| Events / jobs | `outbox_events` (transactional, dedupe key), `agent_runs`, pg_cron + pg_net, Vault | Agent 07 events go to the outbox. Work is driven by a SQL tick (pg_cron) — no Edge Function is needed for deterministic work |
| Activities | `activities` via `private.add_activity` | Merge and correction activities only for real persisted operations |
| Integrations | `integrations` (status, `last_synced_at`, `last_error`); `webhook_events` (lead intake). **No CRM import, listing-inventory or calendar provider adapters exist** | Integration health and staleness are checked honestly. External identity for leads is the existing `(source, source_external_id)`; collisions are flagged. No sync engine is invented |
| Claude | Anthropic SDK in Edge Functions (`claude-opus-5-5`, JSON schema output, zod validation, `not_configured` without a key) | Optional `crm-enrichment` function: extracts *stated* facts with evidence quotes from a lead's notes into **proposals**; never applied automatically |
| Permissions | `has_perm` + `role_permissions` (`leads.view`, `leads.edit`, `contacts.edit`, `properties.edit`, `appointments.edit`, `leads.merge`, `integrations.manage`, `agents.manage`, `settings.manage`) | Reused; **no new permissions** (the frontend permission matrix stays in sync) |
| Frontend | Vite + React, `features/*.tsx`, `backend/live.ts`, `useServerQuery`, `attempt`, `Tabs`/`Badge`/`Empty` components, `NAV` | New "Data quality" page under AI operations; a record quality panel in the lead, contact and property drawers; Agent 07 card |

Discrepancies noted: the phone normalizer assumes India for 10-digit numbers (now surfaced as an informational finding instead of silently trusted); the email normalizer lower-cases the local part (kept for matching, documented; the original `email` column is preserved).

## 2. Data model (additive)

| Table | Purpose |
|---|---|
| `data_quality_settings` | Per-org rule overrides (thresholds, disabled rules, severity overrides), versioned |
| `data_quality_issues` | Findings: entity, rule id + version, severity, dimension, message, evidence (field names / codes, no raw personal data), recommended action, optional proposed fix, lifecycle, **fingerprint** unique per org (rescans update, never duplicate) |
| `duplicate_candidates` | Ordered pair per entity type: signals, conflicts, score, strength, explanation, proposed canonical, review state, a **state hash** of both records (a merge is refused if either changed since detection) |
| `record_merges` | Executed merges: canonical, merged, moved row ids per table (for recovery), filled fields, conflicts, idempotency key, revert state |
| `field_provenance` | Current source per important field (contact name / email / phone; lead budgets, type, locations, bedrooms, timeline; property price / status / address): source type and reference, actor, capture time, verification, value hash (not the value), previous source |
| `data_quality_scans` | Requested / running / completed / partial / failed / cancelled scans with a keyset checkpoint and counts |
| `data_quality_queue` | Records changed since their last evaluation (one row per record; idempotent) |
| `data_quality_daily` | One metric snapshot per org per day (baseline for anomaly rules) |

## 3. Workflow

CRM change → trigger enqueues the record (`data_quality_queue`) → `crm_data_tick` (pg_cron, every minute) evaluates queued records in bounded per-org batches → deterministic rules (`private.dq_evaluate`) → issues upserted by fingerprint (new → `crm.data_quality_issue_detected`; gone → auto-resolved, `crm.data_quality_issue_resolved`) → duplicate candidates for the record (`crm.duplicate_review_required`) → overview / Agent 8 context. A daily scheduled scan per org re-evaluates everything in checkpointed batches (time-based rules such as staleness), then records the daily snapshot and evaluates anomaly rules.

## 4. Rules (deterministic, versioned `dq-rules/1`)

Severity: **info** = unknown / optional information missing; **warning** = likely wrong or inconsistent, review soon; **high** = invalid value or broken workflow state that misleads people or agents; **critical** = integrity or security violation (cross-tenant reference) — also audited as a security event and notified to owners / admins.

- Contacts: invalid phone, phone country assumed, invalid email syntax, name needs whitespace cleanup (proposed fix), name looks like contact details, do-not-contact with granted consent, no consent decision for the preferred channel, missing source.
- Leads: rent budget looks like a purchase price / purchase budget looks like rent (INR thresholds; other currencies are not compared, no exchange rates), lead type vs transaction mismatch, no owner, qualified without budget, qualification older than N days, visit stage without an active / completed appointment, duplicate external id, cross-tenant contact.
- Properties: implausible price for sale / rent (INR), bedrooms on plots / commercial units, implausible area, active but never verified, active and not reviewed for N days, active with a won deal, missing city / address.
- Appointments (Agent 06 owns changes; Agent 07 only flags): active viewing of an inactive property, past appointment without an outcome, active appointment for a closed lead, assignee no longer active, calendar sync failed.
- Integrations: error / needs re-auth, connected but stale.
- Organization anomalies (need ≥ 7 daily snapshots, otherwise "no baseline" and no alert): invalid phone spike, duplicate spike, rejected webhook spike, active inventory drop, lead source shift.

Quality score `dq-score/1`: 100 − penalties of open issues (info 2, warning 8, high 20, critical 60; a critical issue caps the record at 40); the overview shows critical and high counts separately so an average never hides them.

## 5. Duplicates and merges

- Signals (score 0–100): contacts — same phone +60, same email +60, related names +15, different name with same phone −25, different other email / phone −20; leads (same contact) — both open +50, same transaction +20, overlapping locations +10, same source and external id +40; properties — same normalized address +40 (required), same type +10, same listing type +10, same bedrooms +10, area within 5 % +15, price within 10 % +5, different bedrooms −20, area differs > 20 % −20. Strength: ≥ 80 strong, 50–79 possible, else weak. Name similarity alone never creates a candidate; price / city / type never do.
- Merge: `duplicate_decide` with `leads.merge` (+ `properties.edit` for properties), a canonical choice, the state hash and an idempotency key. Under row locks it re-checks tenancy, that neither record was merged, and that both are unchanged; then moves relationships, fills only empty canonical fields (verified values never overwritten; differences recorded as conflicts), carries consent conservatively (revocations always win; a grant is carried only where the canonical record has no decision), marks the source `merged_into` (never deleted), audits, adds a timeline entry and emits `crm.duplicate_merge_completed`. Properties with active appointments or open deals are refused. Contact and property merges can be reverted (moved rows return; revocations are kept).

## 6. Provenance and precedence

Triggers record the source of each tracked field on insert / change: a signed-in person → `user_entry`; the intake service → `lead_intake`; AI-extracted lead fields → `ai_extraction`; corrections applied from Agent 07 → `correction`; merges → `merge`; otherwise `system` with the record's source label. A person can mark a field **verified**. Precedence rule (configured, deterministic): a service / AI write never replaces a verified value — the old value is kept and a conflict issue is opened for review. A person's edit is accepted and resets verification.

## 7. Claude

`crm-enrichment` (user JWT): reads the lead's summary and recent notes as the caller, asks Claude for explicitly stated facts with exact evidence quotes (schema-validated; the quote must appear in the source text; values are domain-checked; inferred facts are dropped) and stores them as `proposed` issues with a proposed fix. A person applies or dismisses them. Without a key: `not_configured`.

## 8. Security

RLS read with `leads.view` on all new tables; no direct writes. All mutations are SECURITY DEFINER RPCs that resolve the tenant from the record and check permissions per entity. Duplicate detection and merges are tenant-scoped by construction and re-checked at merge time. Event payloads carry ids, rule ids and severities only.

## 9. Tests

PGlite: rules, fingerprint idempotency, auto-resolve / reopen / dismiss, proposed fix, provenance + verified precedence, duplicate scoring for contacts / leads / properties, merge (relationships moved, consent, redirect, idempotent, stale refused, concurrent second merge refused, revert), permission and tenant isolation, scans with checkpoints, anomaly baseline, Agent 8 context, events. Node: enrichment validator (schema, evidence, stated-only). Live: the tick on the hosted project, merge with real users, cross-tenant refusal.

## 10. What was built

| Piece | Where |
|---|---|
| Migration (additive) | `supabase/migrations/20261025001600_crm_data_agent.sql`: tables `data_quality_settings`, `data_quality_scans`, `data_quality_issues`, `duplicate_candidates`, `record_merges`, `field_provenance`, `data_quality_queue`, `data_quality_daily`; columns `contacts.merged_into`, `properties.merged_into`, generated `properties.address_key` (built-in functions only, indexed); `private.leads_before` replaced (a lead may change contact only inside an approved merge) |
| Rule engine | `private.dq_findings` (35 record rules: contact 8, lead 10, listing 9, appointment 6, integration 2; `dq-rules/1`), `dq_anomalies` (5 organization rules), `dq_phone_check`, `dq_email_ok`, `dq_process` (per-record advisory lock, fingerprint upsert, auto-resolve), `dq_upsert_issue` (dismissed stays dismissed, resolved reopens, critical → audit `security.integrity_violation` + owner / admin notification) |
| Duplicates | `dq_detect_duplicates` (indexed exact signals, tenant-scoped, ≤ 25 candidates per record), `dq_upsert_candidate` (explanation text, stale / reopen), `dq_state_hash` |
| Merges | `duplicate_decide` (permission, idempotency key, candidate row lock, state-hash check), `dq_merge_contact`, `dq_merge_property`, leads via the existing `merge_leads`; `record_merge_revert` |
| Provenance | BEFORE triggers `contacts_provenance`, `leads_provenance`, `properties_provenance` (`private.dq_provenance`); `dq_verify_field` |
| Corrections | `dq_issue_apply_fix` (field allow-list, normal audited update, provenance `correction`, activity), `dq_issue_action` (review / assign / dismiss with reason / reopen / resolve with re-check) |
| Enrichment | `supabase/functions/_shared/crm-enrichment.ts` (schema, zod, evidence-quote validation, stated-only), `supabase/functions/crm-enrichment/index.ts` (user JWT, deployed), `dq_propose_enrichment` (domain check through the table type; stored as `proposed`) |
| Jobs | Change triggers on contacts, leads, properties, appointments, consents, qualifications, deals, integrations → `data_quality_queue`; `public.crm_data_tick` (pg_cron `crm-data-tick`, every minute): per-org batches with backoff retries, daily snapshot + anomaly rules, daily scheduled scan, one checkpointed batch per active scan |
| Read models | `crm_data_quality_overview`, `dq_issues` (filters, paging), `dq_duplicates`, `duplicate_candidate_detail`, `crm_record_quality`, `crm_data_quality_context` (Agent 08) |
| Frontend | `features/dataQuality.tsx` (Data quality page: KPIs, Issues, Duplicates with side-by-side review, Merge history with revert; `RecordQualityPanel` in the lead, contact and property drawers with field sources, verification and "Suggest from notes"), `backend/live.ts` (Agent 07 section), nav item "Data quality" (`leads.view`), Agent 07 card on AI agents ("7 of 8 built") |

### API (Supabase RPC, all `authenticated`, each re-checks tenancy and permission)

| Call | Permission | Purpose |
|---|---|---|
| `crm_data_quality_overview(p_org, p_since)` | `leads.view` | Dashboard metrics, score, last scan, queue, baseline, what the caller may do |
| `dq_issues(p_org, status[], severity[], entity, rule, assigned, since, entity_id, page, size)` | `leads.view` | Paged findings with record labels |
| `dq_issue_action(issue, action, note, assignee)` | edit permission of the record type | `start_review`, `assign`, `dismiss` (reason; critical cannot be dismissed), `reopen`, `resolve` (re-checked) |
| `dq_issue_apply_fix(issue)` | edit permission of the record type | Apply a proposed correction |
| `dq_duplicates(...)`, `duplicate_candidate_detail(candidate)` | `leads.view` | Review queue and side-by-side comparison |
| `duplicate_decide(candidate, decision, canonical, state_hash, idempotency_key, note)` | `leads.merge` (+ `properties.edit`) | Merge or mark as different |
| `record_merge_revert(merge, note)` | `leads.merge` | Undo a contact / property merge |
| `crm_record_quality(entity_type, id)`, `dq_verify_field(...)` | `leads.view` / edit permission | Record panel; verify a field |
| `data_quality_scan_request(org, key)`, `data_quality_scan_cancel(scan)` | `agents.manage` | Asynchronous full scan (returns the scan id and its real status) |
| `data_quality_settings_save(org, rules)` | `settings.manage` | Validated rule overrides |
| `dq_propose_enrichment(lead, proposals, model)` | `leads.edit` | Called by `crm-enrichment` as the user |
| `crm_data_quality_context(org)` | `leads.view` (+ `service_role`) | Agent 08 context |
| `crm_data_tick(limit)` | `service_role` only | Worker |

## 11. Event contract

All through `private.emit_event` into `public.outbox_events` in the same transaction as the change (published, no consumer yet), `schema_version` 1, `source` `crm_data_agent`. Payloads carry ids, rule ids, severities and counts only.

| Event | When | Dedupe key |
|---|---|---|
| `crm.data_quality_issue_detected` | A finding is created or reopens | `crm.issue_detected:<issue>:<occurrence>` |
| `crm.data_quality_issue_resolved` | Auto-resolved, fixed or record closed | `crm.issue_resolved:<issue>:<occurrence>` |
| `crm.duplicate_review_required` | A strong / possible candidate appears or returns | `crm.duplicate_review_required:<candidate>:<occurrence>` |
| `crm.duplicate_merge_completed` / `crm.duplicate_merge_reverted` | After the merge / revert committed | `…:<merge>` |
| `crm.record_enrichment_proposed` / `crm.record_enriched` | A model proposal is stored / applied by a person | issue keys |
| `crm.anomaly_detected` | Daily anomaly rules fire | `crm.anomaly_detected:<day>:<rules>` |
| `crm.data_scan_completed` | A scan reaches `completed` or `partial` | `crm.data_scan_completed:<scan>` |

No `crm.data_sync_*` events are emitted: there is no external synchronization to report.

## 12. Tests and results (2026-10-26)

- **Full suite: 215 / 215 pass** (19 files, `npx vitest run`). Typecheck (`tsc --noEmit`) clean; production build OK. Lint: the repository has no ESLint configuration, so no linter was run.
- `tests/db/crm-data-agent.test.ts` (16, PGlite with all migrations):
  - fingerprinted findings, rescans update instead of duplicating, event payload has no personal data;
  - auto-resolve, reopen with occurrence, dismiss needs a reason, viewers cannot dismiss, manual resolve refused while still detected;
  - proposed correction applied with `correction` provenance, audit and activity;
  - lead / property rules, records not changed by the agent;
  - provenance: user entry recorded, automated write cannot replace a verified phone (review finding opened), a person's edit wins and resets verification, hashes only;
  - contact candidates with signals and explanation (strong 100, weak with conflicts), one row per pair;
  - contact merge: forbidden for agents, `NOT_FOUND` across tenants, refused after a record changed, idempotent replay, second merge refused, leads / consent / filled fields / conflicts, lead contact still immutable outside a merge (column grant and trigger), revert restores and keeps revocations;
  - lead merge through `merge_leads`, not revertible;
  - listings: corroborated pair strong (90), other unit at the same address not proposed, merge refused while a viewing is active, merge + revert;
  - checkpointed scan completes with the exact record count, idempotent request, agents cannot start scans;
  - failed evaluation retried with backoff, then succeeds;
  - anomalies only with ≥ 7 baseline days; spike and inventory drop detected; owners notified once;
  - cross-tenant reference → critical finding, security audit, notification, cannot be dismissed;
  - Agent 08 context and overview;
  - enrichment proposals: invalid ones skipped, nothing applied until a person applies;
  - tenant isolation for every table and RPC; no direct writes; tick and queue closed to users.
- `tests/crm-enrichment.test.ts` (4, Node): stated + evidence-backed facts kept; inferred, invented evidence, out-of-domain, duplicate fields and prompt-injection values dropped; unexpected fields and contradictory budgets rejected.
- **Live on "Estate OS"** (test workspaces only): **18 / 18 pass**.
  - Overview and Agent 08 context load.
  - Two contacts with the same phone in different formats are detected by the real cron tick ("Same phone, names share a word", 75).
  - **Two sessions merging at once: exactly one merge, the other `CONFLICT`.** The lead moved, the duplicate became a redirect, the empty email was filled, and moved rows were recorded.
  - Another workspace gets `NOT_FOUND` on issues, record quality, candidate detail, revert and context, and reads nothing from the tables.
  - Revert restores both records.
  - A whitespace finding with a proposed correction was applied, resolved as `corrected`, with provenance `correction` over `user_entry`.
  - The tick is closed to users (42501); `crm-enrichment` answers 503 `not_configured` (no model key) and 401 without sign-in.
- Live data: migration `20261025225050`; all 41 function bodies match the file (md5 of `prosrc`); cron `crm-data-tick` succeeding every minute. The scheduled scans found real issues in the test workspaces (unassigned leads, unknown consent, a country-assumed phone, an active viewing booked on a withdrawn listing) and duplicate listings created by earlier test fixtures. They were left for review, not merged. Outbox: `crm.data_quality_issue_detected` 48, `crm.duplicate_review_required` 9, merge completed / reverted 1 / 1.
- Security advisors: no new warning types. The new user RPCs are SECURITY DEFINER with their own checks, like the rest of the API. `data_quality_queue` reports "RLS enabled, no policy" (INFO): intentional, since the table has no user access.
- Browser (signed in): Data quality page with live KPIs, the issue table and duplicate review (signals with weights, side-by-side values, merge / not-duplicates). The lead drawer shows the Data quality panel with field sources; "Suggest from notes" reports that AI suggestions are not configured.

## 13. Setup and operations

- Nothing to configure: the cron job and daily scans run automatically; existing records are picked up by the first daily scheduled scan.
- Optional: `ANTHROPIC_API_KEY` (and `ENRICHMENT_MODEL`) as Edge Function secrets enable "Suggest from notes"; without them it answers `not_configured`.
- Rules per org via `data_quality_settings_save` (disabled rules, severity overrides except critical, staleness thresholds, plausibility thresholds per currency, anomaly thresholds, batch sizes, daily scan on / off).
- Recovery: a failing record is retried 5 times with exponential backoff (visible as "could not be checked" on the page); a scan can be cancelled; merges of contacts and listings can be reverted.

## 14. Limitations

- **No external CRM, listing inventory or calendar adapters** exist, so there is no synchronization or external-id mapping beyond the existing lead `(source, source_external_id)`, whose collisions are flagged. No sync health is claimed.
- Phone checks: full number-plan validation only for +91; other country codes are checked for E.164 length only (no phone library in Postgres). 10-digit numbers without a country code were stored as +91 by the existing normalizer; Agent 07 flags them rather than changing them.
- Emails are syntax-checked only (never marked verified); matching uses the existing lower-cased `email_normalized`.
- No fuzzy (trigram) name matching: candidates come from exact phone / email / address keys, so differently-spelled duplicates without a shared identifier are not found.
- Lead merges use the existing `merge_leads` and cannot be reverted automatically.
- Provenance is recorded from now on; values captured before this migration show "Not recorded" (they can still be verified).
- `crm-enrichment` was not exercised against the model (no API key configured); its validator is unit-tested.
- No settings UI for the rule overrides yet (the RPC is validated and tested).
- Anomaly rules need 7 days of snapshots before they can alert.

## 15. Next step: Agent 08 (Sales Intelligence)

Agent 08 should read `crm_data_quality_context` before computing metrics, count only canonical records (`merged_into is null`, `archived_at is null`), and state when unresolved high-severity issues or open duplicate candidates may affect a number. Its own insights should follow the same pattern: deterministic aggregates in SQL, Claude only for narrative with validated output, and tenant-scoped reads.
