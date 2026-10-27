# Phase 3 Staging Validation Report — Estate OS

Date: 2026-10-26 / 27 (UTC). **Release decision: `STAGING DEPLOYED — VALIDATION INCOMPLETE`** (see §11).

## 1. Deployment status

| Item | Status | Evidence |
|---|---|---|
| Staging target | Supabase **"Estate OS"** (`jvdnapofyoarhfctbpyi`, ap-south-1), designated staging by the owner in chat. Synthetic data only (3 `@estate-os.test` users, 2 test agencies) | `list_projects`, SQL counts |
| Database | **Migrations 0001–0018 applied.** 0018 applied in this phase (`20261026181753`); function bodies match a fresh local install (md5) | `apply_migration`, md5 comparison |
| Edge Functions | **12 deployed** (10 before, plus 2 new). `sales-intelligence-recommend` and `sales-analyst` deployed for the first time; `appointment-assistant`, `crm-enrichment` and `qualification-worker` redeployed. The other 7 run their previous version (known import-pin drift) | `deploy_edge_function` results; `get_edge_function` source check; AI-01 |
| Frontend | **Not deployed: there is no host** (PRA-011). Tested locally against staging in earlier phases; this phase tested the backend APIs directly | n/a |
| Version | No git commit exists (PRA-004). The version is the workspace state of 2026-10-26, identified by migration version and function versions | n/a |
| Staging URL | **None for the UI.** The API is the project's Supabase URL (in `.env.local`, not repeated here) | n/a |

## 2. Phase 2 verification and blocker list

**Phase 2 fixes were re-checked:**
- Migration 0018 is live, and the guard is enforced live (AI-02…04, ROLE-05, ROLE-08).
- `config.toml` matches the live `verify_jwt` flags.
- The suite (259) and the build pass.
- `npm audit` shows 0 vulnerabilities.
- No tenant-isolation issue was found (TEN-01…05; 44 tables swept).

| Blocker | Class | Reason |
|---|---|---|
| No Anthropic key: every AI step unverified (PRA-005) | **PILOT_BLOCKER** | Each agent's AI step is part of the product promise; deterministic fallbacks work but do not deliver the AI features |
| No Retell key: voice calling unverified (PRA-005) | **PILOT_BLOCKER** for any pilot that includes calling; NON_BLOCKING for a pilot without voice | Nothing can be dialled; policy and refusal paths work |
| No messaging provider (PRA-006) | **PILOT_BLOCKER** unless the pilot is scoped to manual sending | Follow-ups are drafted and approved, never delivered by the system (reported honestly) |
| No calendar provider (PRA-006) | **PILOT_BLOCKER** unless the pilot runs without calendar sync | Internal scheduling works |
| No frontend hosting (PRA-011) | **STAGING_BLOCKER** for UI validation; **PILOT_BLOCKER** | The UI cannot be used by anyone off this machine |
| No monitoring or alerting (PRA-003) | **PILOT_BLOCKER** | Failures are only visible by querying tables or logs (§9) |
| No backups / free plan (PRA-002) | **RELEASE_BLOCKER** (production); **PILOT_BLOCKER** | Pilot data would have no point-in-time recovery |
| No git or CI (PRA-004) | **PILOT_BLOCKER** | No reproducible, reviewable releases. The CI file exists but has never run |
| Production project does not exist; staging must not be promoted | **RELEASE_BLOCKER** | A separate production project is required |
| Leaked-password protection off (PRA-008) | **PILOT_BLOCKER** | Real users would be able to choose breached passwords |
| Data protection / legal review (PRA-020) | **PILOT_BLOCKER** | Real contacts and call recordings |
| 7 functions run an older build (import-pin drift) | NON_BLOCKING for staging | Behaviour live-verified; redeploy through the CLI pipeline |
| PRA-031 worker 401 on a transient secret-check failure | NON_BLOCKING (LOW) | Recovered next minute; observability defect |
| Test residue: plaintext tester password file; a password fragment was echoed once in a tool output this session | NON_BLOCKING for staging; must be fixed before any real user (PRA-007) | Staging-only synthetic account; delete or rotate it, and delete `frontend/test-login.local.md` |

**No critical vulnerability was found, so staging exposure is not unsafe.**

## 3. Database and migrations

- **Fresh install:** all 18 migrations applied on a disposable PGlite database (57 public tables), and the 259-test suite ran on it.
- **Staging:**
  - 0018 applied additively;
  - 57 tables, 0 without RLS;
  - `anon` can execute no public function;
  - the security advisor shows no new class of issue: 76 WARN for permission-checked definer RPCs (the intended pattern, including the two new guard RPCs), leaked-password protection still off, and 1 INFO for `data_quality_queue` (intentional).
- **Seed data:** generated per run by `staging-e2e.mjs` through the real APIs:
  - leads and contacts use only `@example.com` addresses and no phones;
  - listings are tagged `STG-<tag>`.
- **Earlier phases' data:** older test contacts carry realistic `+91` numbers. Replace them before voice or messaging is ever enabled in staging.

## 4. Security tests (staging)

All pass. Details are in `PHASE_3_E2E_TEST_REPORT.md`.

- **Login and logout:**
  - valid sign-in works; a wrong password is rejected;
  - after logout the refresh token is revoked;
  - **observation:** an issued access token stays valid until it expires (1 h).
- **Tokens:** malformed and forged JWTs → 401 on REST and RPC; every user function rejects calls without a JWT.
- **Anonymous access:** the REST read of `leads` → 401.
- **Roles** (agent and viewer):
  - no analytics, no secret rotation, no audit logs, no editing others' leads, no AI recommendations, no export;
  - a viewer cannot create leads or trigger AI enrichment, but **can** read the agency's leads, so authorized access works.
- **Tenant isolation:**
  - B reads 0 rows of A across 44 tenant tables, while A reads its own in 35 of them;
  - B cannot update, delete or insert A's records, and the targeted rows were intact afterwards;
  - B cannot rotate A's secret, export A's data, read A's qualification, matches, data quality or analytics, approve A's follow-ups, book or cancel A's appointments, or start AI requests against A.
- **Webhooks:**
  - bad signature → 401, nothing saved;
  - A's secret against B → refused;
  - forged Retell webhook → refused;
  - wrong worker secrets → 401 on all 5 workers.

## 5. End-to-end workflow (staging, real cron)

All stages pass:
1. **Lead received and validated:** 201 for a valid lead; 422 for a malformed one.
2. **Saved in the correct agency.**
3. **Qualified** by cron in about 20 s. The analysis step is recorded as `not_configured`.
4. **Matched** to the only valid listing. Over-budget, rental, other-area, withdrawn and B listings are excluded, and an empty result is honest.
5. **Follow-up** drafted from the real matches. Approval is not reported as delivered.
6. **Appointment:** availability in Asia/Kolkata; confirmed booking with a reference; idempotent replay; race → 1 win; reschedule bumps the version; a stale reschedule is refused.
7. **CRM:** the lead moves to `visit_scheduled`; history is recorded; the confirmation hand-off is not sent.
8. **Analytics:**
   - `leads_created` rose by exactly the 12 new leads, with replays and duplicates not counted, and equals an independent count (12 = 12);
   - B unchanged;
   - `appointments_booked` equals an independent count of confirmed appointments in the window.

## 6. AI agents

See `PHASE_3_AGENT_VALIDATION_MATRIX.md`.

- **Agents 1, 3, 4, 5, 6, 7, 8:** **PARTIAL**. The deterministic cores pass on staging; every AI step is **BLOCKED** (no key) and reports `not_configured` instead of faking output.
- **Agent 2:** **BLOCKED** (no Retell).

## 7. Integrations

See `PHASE_3_INTEGRATION_REPORT.md`.

| Verification level | Integrations |
|---|---|
| **Verified on staging** | Lead webhook, Auth, pg_cron → workers |
| **Mocked / local only** | Claude validators and the AI guard helper; the Retell signature (SDK golden vector); Storage policies |
| **Blocked** | Anthropic, Retell |
| **Not implemented** | Messaging, calendar, monitoring |

## 8. Performance

Measured from one client in India against ap-south-1. This is **smoke and small-concurrency testing only, not a load test**. Run 2, n = 5–15 sequential samples each:

| Operation | p50 | p95 |
|---|---|---|
| Lead list (50) | 52 ms | 94 ms |
| Lead detail | 52 ms | 311 ms |
| Property search | 44 ms | 57 ms |
| Appointment availability | 68 ms | 108 ms |
| Sales overview (30 KPIs) | 127 ms | 208 ms |
| `create_lead` | 126 ms | 272 ms |
| Sign-in | 99 ms | one 15 s outlier (likely Auth throttling after many sign-ins from one IP) |

- **10 concurrent lead-list reads:** 208 ms wall, 0 errors.
- **Concurrency correctness:**
  - 8 parallel distinct webhooks → 8 leads;
  - one event ×5 → 1 lead;
  - parallel booking → 1 win;
  - the AI limit is enforced under an advisory lock.
- **Capacity:** no claim is made about 500 agencies or any load.

**Suggested starting SLOs, to be confirmed with real usage:**
- p95 < 500 ms for list, detail and search;
- p95 < 1 s for analytics;
- webhook p95 < 1 s;
- cron chain to qualification < 2 min.

## 9. Observability and operations (runbook)

| Question | How to answer it today | Evidence this run |
|---|---|---|
| Is a service unhealthy? | `select status_code, count(*) from net._http_response where created > now() - interval '15 minutes' group by 1` (worker HTTP results). Then `select status, count(*) from cron.job_run_details where start_time > now() - interval '1 hour' group by 1` | 74 × 200 and 1 × 401 since the canary; 15,822 cron runs succeeded in 24 h |
| Which worker failed? | Logs Explorer: `function_edge_logs` filtered on `response.status_code` (shows the URL and `pg_net` user agent) | Located the 401 at `property-matching-worker` 18:31:01 |
| A failed agent execution | `select agent_id, status, error_category, attempts from agent_runs where status in ('failed','dead') order by received_at desc` | 0 failed; 2 `review_required` |
| A failed webhook | `select provider, processing_status, last_error, received_at from webhook_events where processing_status = 'rejected' order by received_at desc` | 6 rejected (from the tests) |
| Is the event flow stuck? | `select status, count(*), min(created_at) from outbox_events group by 1` | 12 pending, oldest 0 min |
| AI usage and failures | `select feature, status, count(*) from ai_requests group by 1, 2` | 11 probe rows (`error`) |
| Is a deployment healthy? | `list_edge_functions` (versions, `verify_jwt`); OPTIONS on each user function; worker 200s for 5 minutes; `voice-calls/status` (booleans only, no secrets) | All checked in this phase |
| Recover from a bad function deploy | Redeploy the previous source. There is no platform rollback in the tooling; keep the previous source in git once it exists | n/a |

- **Redaction:** the `voice-calls/status` response exposes only booleans. Worker logs carry ids and outcomes, not lead content (from the code).
- **Missing:**
  - error tracking and alerting (PRA-003);
  - request correlation ids end to end (each function logs its own fields; the platform request id exists in `net._http_response.headers`).

## 10. Regression and build (local)

All run in `frontend/`:

| Command | Result |
|---|---|
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run check:functions` | pass |
| `npm test` | 24 files, 259 / 259 |
| `npm run build` | pass, 494.5 kB |
| `npm audit` / `npm audit --omit=dev` | 0 / 0 vulnerabilities |
| `node scripts/staging-e2e.mjs` | 92 pass, 0 fail (run 2) |

**Not run:**
- **E2E UI tests:** there is no UI host and no browser framework in the repository.
- **Deno runtime tests:** there is no Deno toolchain; the deployed functions were exercised live instead.
- **Load tests:** out of scope for a free-plan staging project.

## 11. Release gates

| Gate | Result | Why |
|---|---|---|
| **A: staging deployment ready** | **PASS** | Architecture, environment variables, migrations and rollback are documented. No critical vulnerability. Separation: staging is the only environment; production does not exist and must be created separately (no shared config is possible yet) |
| **B: staging deployment verified** | **PARTIAL** | Backend verified: DB at 0018; 12 functions running; Auth; health; errors visible. **Not verified:** the UI is not deployed; 7 functions run an older build; there is no commit to identify the version |
| **C: end-to-end validation** | **PASS for the deterministic workflow; BLOCKED for AI and providers** | Core workflow, tenant isolation, regression and analytics all match independent values; no false success. The AI steps, voice, messaging and calendar could not run |
| **D: controlled pilot ready** | **FAIL** | Pilot blockers in §2: providers, AI key, hosting, monitoring, backups, git/CI, leaked-password protection, legal review, onboarding and support procedures (none exist) |

**Decision: `STAGING DEPLOYED — VALIDATION INCOMPLETE`.** The staging backend is deployed and its deterministic behaviour is validated with evidence. Validation is incomplete because:
- the UI is not hosted;
- 7 functions are not at the repository build;
- every AI and provider path is blocked by missing credentials or adapters.

## 12. Manual actions required

1. **Anthropic:** set `ANTHROPIC_API_KEY` (a staging key with a spend cap) as an Edge Function secret. Then re-run the suite, and run each AI feature once and review the output.
2. **Retell:** a test agent, a number the team owns, and `RETELL_API_KEY`. Replace the `+91` test contacts first.
3. **Providers:** decide on messaging and calendar, or scope the pilot to manual sending and no sync.
4. **Hosting:** choose a static host for `frontend/` and set the Auth site URL and redirects to it.
5. **Git and CI:** create a repository; check that `.env.local` and `*.local.md` are ignored; push; let CI run. Then redeploy all 12 functions with `supabase functions deploy` (after the `supabase migration repair` in `docs/DATABASE_MIGRATIONS.md`).
6. **Production:** create a separate project on a paid plan with PITR and apply 0001–0018 fresh.
7. **Dashboard:** enable leaked-password protection; consider MFA for owners and admins.
8. **Test accounts:** delete `frontend/test-login.local.md`, and rotate or delete the `tester@estate-os.test` password (a fragment was echoed once in this session).
9. **Legal:** retention, erasure, call-recording consent and a privacy notice.
10. **Pilot operations:** monitoring and alerting provider; onboarding and support runbook for pilot agencies.
