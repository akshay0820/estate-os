# API implementation status

Legend: **Implemented** (code exists) · **Tested** (automated tests run against real Postgres) · **Verified live** (exercised against the "Estate OS" Supabase project `jvdnapofyoarhfctbpyi` on 2026-10-25 — see Verification).

The "API" is Supabase: PostgREST over RLS-protected tables plus Postgres RPC functions. The browser calls it through `frontend/src/backend/live.ts`; pages call `frontend/src/data/actions.ts`.

## Conventions
* **Errors:** every failure becomes `{ code, message, details }` (`ApiError`). Database functions raise with `DETAIL` = stable code (`VALIDATION_ERROR`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INVALID_REFERENCE`, `INVALID_TRANSITION`, `APPOINTMENT_CONFLICT`, `OUTSIDE_BUSINESS_HOURS`, `PROPERTY_UNAVAILABLE`, `LAST_OWNER`, `INVALID_INVITATION`, `RATE_LIMITED`, `UNAUTHENTICATED`). Postgres/PostgREST codes are mapped without leaking internals.
* **Pagination:** server-side `range()`; page size capped at 100. Working-set caches are bounded (leads 2,000 open/recent, properties 2,000, deals 1,000, appointments 2,000 in a ±60-day window extended on navigation, tasks 2,000, activities 300 + per-record, audit 500, documents 500, notifications 50).
* **Sorting/filtering:** only whitelisted columns; search text is sanitized before entering PostgREST filter syntax.
* **Tenant scope:** the organization id selects a workspace; RLS (`has_perm`) decides access. Writes that reference other rows are checked by triggers to be in the same organization.
* **Idempotency:** webhook events (`organization_id, provider, provider_event_id` unique), notifications (`dedupe_key`), commissions (one per deal), lead external ids.

## Operations

| Area | Operation | Mechanism | Status |
|---|---|---|---|
| Auth | Sign up / sign in / sign out / reset / recovery / session restore & expiry | Supabase Auth (PKCE) | Implemented · password sign-in verified live (API) · email flows *not verified* |
| Tenancy | Create organization (creator = owner) | `create_organization` | Implemented · Tested |
| | Invite / revoke / accept (token or listed invite) | `invite_member`, `revoke_invitation`, `accept_invitation(_by_id)`, `my_invitations` | Implemented · Tested |
| | Change role / suspend / reactivate | `organization_memberships` update + guard trigger | Implemented · Tested |
| | Org settings & kill switch | `organizations` update (settings validated) | Implemented · Tested |
| Leads | List (quick views, status/source/owner filters, search, sort, paging) | `leads` select | Implemented |
| | Quick-view counts | `lead_view_counts` | Implemented · Tested |
| | Create with dedupe (`ask`/`link`/`create`) + assignment rules + consent capture | `create_lead` | Implemented · Tested |
| | Update fields / status (transition rules) / assign / archive | `leads` update + triggers | Implemented · Tested |
| | Merge duplicate enquiries | `merge_leads` | Implemented · Tested |
| | Notes | `activities` insert (notes only) | Implemented · Tested |
| | Import CSV (≤1,000 rows, duplicates skipped) / export CSV (≤10,000, audited) | `create_lead` per row / paged select + `record_export` | Implemented · export audit Tested |
| Contacts | List (search, role, lifecycle, paging), detail, edit | `contacts` select/update | Implemented |
| | Consent per channel, do-not-contact | `set_contact_consent`, `opt_out_contact` | Implemented · Tested |
| Properties | List, create, edit, archive, verify (server-timestamped, permission-gated) | `properties` | Implemented · Tested |
| Deals | Create, move stage (won → commission + lead won + property sold/let), edit close date | `deals` + triggers | Implemented · Tested |
| Appointments | Book (business hours, availability, conflict lock), reschedule, confirm/complete/no-show/cancel (reason required), free-slot suggestions | `appointments` + `appointment_free_slots` | Implemented · Tested |
| Tasks | Create, edit, snooze, complete, cancel | `tasks` | Implemented · Tested |
| Activity | Timeline per lead/contact, org feed | `activities` (written by triggers) | Implemented · Tested |
| Notifications | List mine, mark read, mark all read | `notifications`, `mark_all_notifications_read` | Implemented · Tested (privacy) |
| Dashboard | KPIs with previous period, series, sources, funnel, arrivals heatmap, response SLA | `dashboard_metrics` (SQL aggregates, org time zone) | Implemented · Tested |
| Audit | Read (audit.view), export (audited) | `audit_logs`, `record_export` | Implemented · Tested |
| Finance | Commission lifecycle estimated→approved→payable→paid / void | `commissions` + trigger | Implemented · Tested |
| Documents | Upload (content sniffed, ≤20 MB, private bucket), signed link (5 min), reclassify, archive | `documents` + Storage | Implemented · DB/policy side Tested · upload + signed URL verified live |
| Intake | Signed webhook → lead (idempotent) | Edge Function `lead-intake` + `ingest_lead` | Implemented · Tested · **Deployed and verified live** |
| | Secret generate/rotate (Vault) | `rotate_webhook_secret`, `webhook_secret_for` | Implemented · Tested (Vault shim) |

## Frontend pages

| Page | Live data | Notes |
|---|---|---|
| Dashboard | ✅ `dashboard_metrics` + caches | AI-spend and automation cards hidden in live (no data source yet) |
| Activity feed | ✅ | Latest 300 org-wide; full history per lead/contact |
| Leads | ✅ server-paged table; board uses open-lead cache | AI call / message buttons hidden in live |
| Contacts | ✅ server-paged | |
| Properties | ✅ | No photo pipeline yet — shows a neutral placeholder, never stock photos |
| Deals | ✅ | |
| Appointments | ✅ | Week navigation loads missing ranges |
| Tasks | ✅ | |
| Team | ✅ | Invite produces a link to share (no email delivery yet) |
| Settings | ✅ org settings & kill switch | Pipeline-stage toggles, retention and export request are demo-only (no backend) and hidden in live |
| Documents | ✅ | Delete = archive (record and object kept for retention review) |
| Finance | ✅ commissions | Expenses not modelled yet (hidden in live) |
| Integrations | ✅ intake endpoint, secret, event log | Provider connectors not implemented |
| Audit logs | ✅ latest 500 | |
| Inbox, Calls, Follow-ups, AI agents, Workflows, Approvals, Execution logs, Usage, Marketing, Reports | ❌ | Show an explicit "not connected yet" state in live mode; demo mode keeps illustrative versions |

## Metric definitions (dashboard)
* **New leads:** leads created in [from, to), not archived.
* **Qualified:** of those, status qualified or later (incl. won).
* **Viewings booked:** viewing appointments *created* in the period (any status).
* **Lead → visit:** share of new leads with a non-cancelled appointment.
* **Active deals:** deals not won/lost now; delta = deals opened this period vs previous.
* **Won value:** sum of `expected_value` for deals closed-won in the period (not commission, not cash).
* **Median first response:** minutes from lead creation to `first_response_at`.
* **Within SLA:** share of responded leads with response ≤ organization SLA.
* Buckets are computed in the organization's time zone; the previous period is the same length immediately before.

## Verification performed
* `npm test`: 236 tests (113 before Agent 03; Agent 03 added 17 qualification DB tests and 4 validator tests; Agent 04 added 16 matching DB tests and 4 explanation-validator tests; Agent 05 added 17 follow-up DB tests and 6 drafting / delivery tests; Agent 06 added 12 appointment DB tests and 6 assistant / calendar-adapter tests; Agent 07 added 16 data-quality DB tests and 4 enrichment-validator tests; Agent 08 added 15 sales-intelligence DB tests and 6 validator / formatter tests) — 25 isolation/escalation, 24 business rules, 25 Lead Intake Agent (`tests/db/intake-agent.test.ts`), 1 migration smoke, 1 permission-matrix sync, 4 webhook signature/validation, 5 model-output validation (all migrations incl. 0009).
* Sales & Qualification Agent (Agent 03): see `docs/agents/AGENT_03_SALES_QUALIFICATION_IMPLEMENTATION.md` (live 13/13 through the real crons).
* Property Matching Agent (Agent 04): see `docs/agents/AGENT_04_PROPERTY_MATCHING_IMPLEMENTATION.md` (live 15/15 through the real crons).
* Follow-Up Agent (Agent 05): see `docs/agents/AGENT_05_FOLLOW_UP_IMPLEMENTATION.md` (177 tests in total; live 16/16 through the real crons). No messaging provider: approved messages are sent by a person and recorded as sent manually.
* Appointment Agent (Agent 06): see `docs/agents/AGENT_06_APPOINTMENT_IMPLEMENTATION.md` (195 tests in total; live 28/28 including a parallel double-booking race). No calendar provider adapter: the internal calendar is the source of truth and nothing is reported as synced.
* CRM & Data Intelligence Agent (Agent 07): see `docs/agents/AGENT_07_CRM_DATA_INTELLIGENCE_IMPLEMENTATION.md` (215 tests in total; live 18/18 including a parallel merge race). Merges and corrections always need a person; no external CRM / inventory sync exists to reconcile.
* Sales Intelligence Agent (Agent 08): see `docs/agents/AGENT_08_SALES_INTELLIGENCE_IMPLEMENTATION.md` (236 tests in total; live 15/15). Metrics are computed in SQL from persisted records; the two Claude Edge Functions are not deployed yet.
* Voice Calling Agent (Agent 02): see `docs/agents/AGENT_02_VOICE_CALLING_IMPLEMENTATION.md` (113 tests; live boundary checks 17/17; no real call placed — Retell not configured).
* Lead Intake Agent (Agent 01): see `docs/agents/AGENT_01_LEAD_INTAKE_IMPLEMENTATION.md` (live verification 18/18, function v4).
* `npm run typecheck`, `npm run build`: pass.
* Browser: demo gate and demo mode re-checked after the refactor (create lead flow). With `.env.local` set, the app starts in live mode and shows the sign-in screen without console errors.
* **Live API end-to-end (2026-10-25): 42/42 checks passed** against `jvdnapofyoarhfctbpyi`, using only the publishable key, signed in as two test owners in two workspaces. The script mirrors the calls in `live.ts` (same tables, RPCs, Storage flow and Edge Function) but **not its exact query strings**: it used a reduced lead select (contact + consents embed only) and its own `or(ilike)` search, so the app's full `LEAD_SELECT`/`CONTACT_COLS` and `safeTerm` search filter are not covered by this run:
  * Auth: password sign-in for both users; anon gets `permission denied` on tables and on `has_perm`.
  * Tenancy: `create_organization` makes the caller an active owner.
  * Leads: `create_lead` (contact + 4 consents, score 84), duplicate detection by phone, embedded contact/consent select, `lead_view_counts`, `or(ilike)` search with `count: exact` + `range`, status update, note insert, trigger-written timeline.
  * Properties, tasks (create + complete), appointments (booking; `APPOINTMENT_CONFLICT`; `OUTSIDE_BUSINESS_HOURS`; `appointment_free_slots`; viewing → lead `visit_scheduled`).
  * Deals: won → commission 2 % (240,000), lead won, property sold.
  * `dashboard_metrics` returns the expected KPIs and ≥30 daily buckets.
  * Isolation: user B cannot read, update or insert into A's org, cannot read A's dashboard (`FORBIDDEN`), cannot reference A's lead (`INVALID_REFERENCE`), cannot call `ingest_lead`.
  * Storage: metadata-first upload to the private bucket, 5-minute signed URL downloads (HTTP 200), B cannot sign A's object, upload without a `documents` row is rejected.
  * **Edge Function `lead-intake` (deployed, JWT verification off):** signed request → 201 + lead; replay → 200 `duplicate_event` with same lead; forged signature → 401; stale timestamp → 401; invalid payload → 422; unknown org → 404; processed events logged in `webhook_events`. Since version 3: forged requests are stored through `record_rejected_webhook` as one row per org per minute (three forged requests → one row, `attempt_count` 3), so they show in the Integrations log without letting callers grow the table; the body is read with a 64 KB byte cap that stops reading early (a chunked 200 KB body → 413); and bodies must be valid UTF-8 (invalid → 400) so the signature is never checked against a lossy decoding. A signed non-ASCII body → 201.
  * Audit: `record_export` and secret rotation logged; `audit_logs` delete denied.
* **Browser, signed in (2026-10-25):** dashboard and all 13 live pages load against the project; all 31 Supabase requests returned 200 after fixing an ambiguous `organization_memberships → profiles` embed (two FKs: `user_id`, `invited_by`; now pinned with `!organization_memberships_user_id_fkey`). PGlite tests cannot catch this class of PostgREST error.
* **Not yet verified live:** create/edit flows through the browser UI, the app's lead search filter, sign-up confirmation email and password-reset email delivery, invitation acceptance across two real accounts, Realtime (not used).

## Blockers / open items
* Browser sign-in must be done by a person (automated browser sessions here don't enter passwords on hosted auth). Test accounts `e2e-a@estate-os.test` / `e2e-b@estate-os.test` exist in the project with confirmed emails and own workspaces "E2E Realty A/B"; their password is not stored in the repo. Delete them before going live (Dashboard → Authentication → Users).
* Auth URL configuration (Site URL / redirect URLs for `http://localhost:5180`) and SMTP must be set in the dashboard for confirmation and reset links to work; Supabase's built-in email sender is rate-limited and for testing only.
* No linter is configured in the repository (`npm run lint` does not exist); TypeScript strict mode is the static check in use.
