# Feature Verification Matrix — Estate OS

Audit date: 2026-10-26, updated after Phase 2 the same day. Evidence tags are defined in `PRODUCTION_READINESS_AUDIT.md` §1. Phase 2 changes are marked **(P2)**. The test count is now 259 / 259 (24 files).

**Statuses:**

| Status | Meaning |
|---|---|
| **VERIFIED** | Automated tests pass in this audit **and** the feature was exercised on the live project (in this audit or, marked [PRIOR], earlier in this working session) |
| **IMPLEMENTED_UNVERIFIED** | Code exists and may be unit-tested, but it has not run end to end against the real dependency |
| **PARTIAL** | Works, with a documented functional gap |
| **BROKEN** | Fails in the deployed environment |
| **MISSING** | Not implemented |
| **BLOCKED** | Implemented, but cannot run until configuration or a provider exists |

The 236 / 236 test result was re-run in this audit [TEST]. Live exercises of individual flows are [PRIOR] unless stated otherwise.

## Platform

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Sign-up / login / email confirmation | VERIFIED | [TEST] foundation suite; [PRIOR] browser login | Leaked-password protection off (PRA-008); signup open (PRA-016) |
| Workspace creation, roles, permission matrix | VERIFIED | [TEST]; [RUNTIME] `role_permissions` | Self-escalation and last-owner guards tested |
| Team invitations | PARTIAL | [TEST] | Link only; no email sent (PRA-006) |
| Tenant isolation (RLS, cross-tenant checks) | VERIFIED | [TEST] every agent suite; [RUNTIME] RLS on 56/56 tables; anon read gets 401 | |
| Audit log (append-only) | VERIFIED | [TEST]; [STATIC] | No viewer in LIVE (Logs page not connected) |
| Documents (private storage) | VERIFIED | [RUNTIME] bucket private with policies; [TEST] | |
| Notifications | VERIFIED | [TEST]; [PRIOR] | In-app only |
| Demo mode | VERIFIED | [PRIOR] browser | Seed data, no backend |

## CRM modules (frontend, LIVE)

| Feature | Status | Evidence | Notes |
|---|---|---|---|
| Dashboard | VERIFIED | [TEST] `dashboard_metrics`; [PRIOR] browser | "Won value" is deal value, not commission (labelled) |
| Leads (list, detail, create, merge, status, assignment) | VERIFIED | [TEST]; [PRIOR] | |
| Contacts and consent / opt-out | VERIFIED | [TEST]; [PRIOR] | |
| Properties | VERIFIED | [TEST]; [RUNTIME] live probe 6/6 **(P2)** | "Leads this fits" now reads Agent 04's current matches in LIVE (PRA-023 fixed). The drawer rendering itself was not browser-checked |
| Deals and commissions | VERIFIED | [TEST] deal→commission cascade; [PRIOR] | |
| Appointments | VERIFIED | [TEST]; [PRIOR] live 28/28 | See Agent 06 |
| Tasks, activities | VERIFIED | [TEST]; [PRIOR] | |
| Finance view | VERIFIED | [TEST] `finance.view` gating; [PRIOR] | |
| Settings, integrations page | PARTIAL | [STATIC]; [RUNTIME] only a `lead_source` webhook connected | Provider integrations do not exist (PRA-006) |
| Reports (live) | VERIFIED | [TEST]; [PRIOR] live report with CSV / JSON | |
| Data quality page | VERIFIED | [TEST]; [PRIOR] live 18/18 | |
| Sales intelligence page | PARTIAL | [TEST]; [PRIOR] browser | AI recommendations and "Ask" are now deployed but BLOCKED by the missing Anthropic key **(P3)**; the query builder works |
| Inbox | MISSING | [STATIC] `NOT_CONNECTED` | PRA-022 |
| Workflows | MISSING | [STATIC] `NOT_CONNECTED` | PRA-022 |
| Approvals (central) | MISSING | [STATIC] `NOT_CONNECTED` | Per-agent review queues exist |
| Logs | MISSING | [STATIC] `NOT_CONNECTED` | |

## Agents

| Agent / capability | Status | Evidence | Notes |
|---|---|---|---|
| **01 Lead intake**: signed webhook, normalization, dedupe, scoring, pipeline | VERIFIED | [TEST]; [RUNTIME] 22 processed / 4 rejected webhook events; cron active | |
| 01: Claude extraction from free text | BLOCKED | [ENV] no Anthropic key | Deterministic path works |
| **02 Voice calling**: policy, state machine, handoff | IMPLEMENTED_UNVERIFIED | [TEST] DB suite; [RUNTIME] `voice_calls` = 0 | Never placed a real call |
| 02: Retell call placement and webhook | BLOCKED | [RUNTIME] `retell_configured: false` | Signature algorithm now matches the official Retell SDK **(P2, PRA-015)**; a real webhook is untested |
| 02: Transcript analysis (Claude) | BLOCKED | [RUNTIME] `analysis_configured: false` | |
| **03 Qualification**: deterministic engine, outbox consumer, review | VERIFIED | [TEST]; [RUNTIME] 20 deliveries; runs succeeded | |
| 03: Claude analysis step | BLOCKED | [ENV] | |
| **04 Property matching**: eligibility, scoring, lifecycle, invalidation | VERIFIED | [TEST]; [RUNTIME] 5 deliveries | |
| 04: Claude match explanations | BLOCKED | [ENV] | |
| **05 Follow-up**: policy, planner, approval, manual send, stop triggers | VERIFIED | [TEST]; [RUNTIME] 9 deliveries; states cancelled / handed_off / suppressed / pending_approval | |
| 05: Claude drafting | BLOCKED | [ENV] | Templates / manual drafting work |
| 05: Provider dispatch (email / SMS / WhatsApp) | MISSING | [STATIC] no adapter | PRA-006 |
| **06 Appointments**: availability, booking, reschedule, cancel, outcomes, reminders | VERIFIED | [TEST]; [PRIOR] live 28/28 | |
| 06: Scheduling assistant (Claude) | BLOCKED | [ENV]; [RUNTIME] function deployed | |
| 06: External calendar sync | MISSING | [STATIC] boundary only, no adapter | `calendar-sync-worker` deployed but has nothing to sync |
| **07 CRM data quality**: rules, duplicates, merges / revert, provenance | VERIFIED | [TEST]; [PRIOR] live 18/18 | |
| 07: Claude enrichment proposals | BLOCKED | [ENV]; [RUNTIME] `crm-enrichment` deployed | |
| **08 Sales intelligence**: metrics, funnel, breakdowns, forecasts, reports, insights | VERIFIED | [TEST]; [PRIOR] live 15/15 | Forecast `insufficient_data` (1 closed deal) |
| 08: AI recommendations | BLOCKED | [RUNTIME] deployed **(P3)**; 503 `not_configured` | Deployed; needs the Anthropic key |
| 08: Natural-language analyst | BLOCKED | [RUNTIME] deployed **(P3)**; 503 `not_configured` | Same |

## Operations

| Capability | Status | Evidence |
|---|---|---|
| Cron scheduling (12 jobs) | VERIFIED | [RUNTIME] all active, 0 failures in 24 h |
| Outbox and consumer delivery | VERIFIED | [RUNTIME] 126 published, no dead letters; [TEST] |
| Worker authentication (Vault shared secrets) | VERIFIED | [RUNTIME] cron → worker calls succeeding; [STATIC] |
| Redeploy safety (`config.toml`) | VERIFIED (config) | [STATIC] all 12 functions declared; flags match live **(P2)**. A real CLI deploy is still to be done in staging |
| Monitoring / alerting | MISSING | PRA-003 |
| Backups / restore | MISSING (undocumented) | PRA-002 |
| CI/CD, version control | PARTIAL | CI workflow file added **(P2)**; no git repository, so it has never run (PRA-004) |
| Lint | VERIFIED | `npm run lint` clean **(P2)** |
| Edge Function type-check | VERIFIED | `npm run check:functions` (tsc; pinned SDK types) **(P2)**. Not a Deno runtime test |
| AI request authorization and limits | VERIFIED (guard, P3 staging) | [TEST] 9 DB + 8 unit tests **(P2)**; migration 0018 and new function code not deployed (PRA-029 / PRA-030) |
| Staging environment | PARTIAL | Estate OS designated staging and validated **(P3)**: `PHASE_3_STAGING_VALIDATION_REPORT.md`. No hosted UI |
| Frontend hosting | MISSING | PRA-011 |
