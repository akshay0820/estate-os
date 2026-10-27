# Production Readiness Audit — BlazeReach AI Real Estate OS ("Estate OS")

Phase 1: repository and architecture audit. Audit date: **2026-10-26**. Auditor: Claude Code (Opus 5.5), working from the local workspace `D:\BZ ESTATE` and read-only access to the Supabase project "Estate OS" (`jvdnapofyoarhfctbpyi`, ap-south-1, Postgres 17).

Companion reports in this folder:
- `FEATURE_VERIFICATION_MATRIX.md` gives a status for every feature.
- `TECHNICAL_REMEDIATION_BACKLOG.md` lists every finding with its fix and how to verify it.
- `INTEGRATION_AND_AGENT_MAP.md` maps the agents, events, AI calls and external integrations.

---

## 1. Scope, method and evidence levels

**In scope:**
- `frontend/` (the React SPA, its tests and the PGlite DB test harness);
- `supabase/` (17 migrations, 12 Edge Functions plus `_shared`, `config.toml`);
- `docs/` and the root design documents;
- the live Supabase project, read-only.

**Out of scope:** load testing, penetration testing, provider sandboxes (Retell, Anthropic, messaging, calendar), legal and compliance review.

Every claim is tagged with the strongest evidence behind it:

| Tag | Meaning |
|---|---|
| **[STATIC]** | Read in source, migrations, config or docs |
| **[TEST]** | Exercised by the automated suite run during this audit |
| **[RUNTIME]** | Observed on the live Supabase project: read-only SQL, advisors, function list, unauthenticated or OPTIONS HTTP probes |
| **[ENV]** | Depends on environment configuration that was observed to be present or absent |
| **[PRIOR]** | Verified earlier in this working session (during implementation), not re-run during this audit |
| **[UNVERIFIED]** | No evidence that it works end to end |

**Constraints kept:**
- No source, schema, migration, configuration or deployed resource was changed.
- Nothing was deployed or migrated, and no data was written.
- No secrets or personal data are reproduced in this report.
- The only files created are the four reports in `docs/production/`.

## 2. Executive summary

Estate OS is a multi-tenant real-estate CRM with eight database-centred "agents", built on Supabase:
1. lead intake;
2. voice calling;
3. qualification;
4. property matching;
5. follow-up;
6. appointments;
7. CRM data quality;
8. sales intelligence.

The core is solid:
- Every one of the 56 public tables has row-level security.
- Business rules are in SQL with permission checks.
- Background work uses a transactional outbox and a durable run queue.
- 236 automated tests pass against a real Postgres engine (PGlite).

The live project has all 17 migrations applied and 12 cron jobs running with no failures in the last 24 hours.

It is **not ready for customers**. The deterministic CRM is in good shape. What is missing is everything around it:
- **The AI and provider layer is unconfigured.** No Anthropic key and no Retell key are set [RUNTIME]. No messaging, calendar or voice provider is connected. Every Claude step, every outbound message and every phone call is therefore **unverified in a real environment**.
- **Two Agent 08 Edge Functions are not deployed** [RUNTIME 404]. The "Generate AI recommendations" and "Ask" actions in the UI fail.
- **There is no delivery pipeline.**
  - The workspace is not a git repository.
  - There is no CI, no lint step, no staging environment, no monitoring or alerting, and no documented backups.
  - The project appears to be on the free plan, per the migration doc.
- **`supabase/config.toml` declares only 4 of 12 functions.** A routine CLI redeploy would turn JWT verification on for the cron-called workers and stop agents 3–6 from processing [STATIC].
- **Test residue exists in the production project:**
  - test users and workspaces;
  - a git-ignored local file holding a plaintext test password.

**Recommendation: ready for further testing and internal staging hardening, not for a controlled customer pilot yet** (see §20).

## 3. Repository inventory [STATIC]

| Area | Contents |
|---|---|
| `frontend/` | Vite 5, React 18, TypeScript 5.6. zustand store, custom CSS, lucide-react, zod. Around 30 feature modules in `src/features/`. `src/backend/live.ts` holds the Supabase data layer; `src/store/seed.ts` holds demo data |
| `frontend/tests/` | 21 vitest files: 8 DB suites on PGlite in `tests/db/`, plus Node unit tests for the Edge Function helpers and validators |
| `supabase/migrations/` | 17 additive migrations, `20261025000100` … `20261025001700` |
| `supabase/functions/` | 12 functions plus `_shared/` (Retell adapter, Claude helpers, workers' runners). `deno.json` pins zod 3.24.1 and `@anthropic-ai/sdk` 0.133.0. `supabase-js` is imported as `jsr:@supabase/supabase-js@2` (floating minor). No `deno.lock` |
| `supabase/config.toml` | Auth settings and per-function `verify_jwt` for 4 functions only |
| Root docs | `real_estate_ai_os_prd.md`, `SYSTEM_ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md` (pre-implementation, 2026-10-24); `REAL_ESTATE_AI_OS_AGENT_WORKFLOW.md` |
| `docs/` | `API_IMPLEMENTATION_STATUS.md`, `BACKEND_IMPLEMENTATION_PLAN.md`, `DATABASE_MIGRATIONS.md`, `LOCAL_DEVELOPMENT.md`, `SECURITY_CHECKLIST.md`, `agents/AGENT_01..08_*.md` |
| Absent | git metadata, CI/CD configuration, ESLint/Prettier configuration, frontend hosting configuration, IaC, monitoring or error tracking, e2e or component tests |

## 4. Architecture as built vs as documented

| Concern | Documented (`SYSTEM_ARCHITECTURE.md` §5, PRD) | Built | Evidence |
|---|---|---|---|
| Web app | Next.js, Tailwind, shadcn/ui | Vite SPA, custom CSS | [STATIC] `frontend/package.json` |
| Orchestration | n8n (PRD) | pg_cron + pg_net + outbox + `agent_runs`. n8n is explicitly forbidden by `REAL_ESTATE_AI_OS_AGENT_WORKFLOW.md` | [STATIC] |
| LLM | Provider-neutral adapter | Direct `@anthropic-ai/sdk` (`claude-opus-5-5`), JSON-schema output with zod validation | [STATIC] |
| Hosting | Next.js host | None configured for the SPA. Supabase for everything else | [STATIC] |
| Observability | Monitoring / error tracking | `agent_runs`, `audit_logs`, `webhook_events` tables only. No external monitoring | [STATIC] |

The documentation and the implementation disagree. The as-built design is coherent, but the root architecture docs would mislead a new engineer or reviewer (finding PRA-019).

**Runtime model:**
1. The browser calls Supabase (PostgREST and RPCs) with the user's JWT.
2. Writes go through SECURITY DEFINER RPCs that call `has_perm`.
3. Each state change emits an outbox event in the same transaction (`private.emit_event`).
4. Every minute, pg_cron runs SQL "ticks" and uses pg_net to call worker Edge Functions, authenticated with Vault-held shared secrets.
5. The workers claim `agent_runs`, call Claude or a provider where configured, and write results back through service-role RPCs.

## 5. Frontend [STATIC, TEST, PRIOR]

- **Two modes.** When `VITE_SUPABASE_URL` and the publishable key are set the app is LIVE; without them it runs in demo mode (seed data in memory). In LIVE the store starts empty and is filled by server loaders. `data/actions.ts` routes writes to `backend/live.ts`.
- **Pages not connected in LIVE** (`NOT_CONNECTED` in `App.tsx`): Inbox, Workflows, Approvals, Logs. In LIVE they show a "not connected" state rather than demo data, which is correct but means those modules are **MISSING** for production.
- **Inconsistency:** the property drawer's "Leads this fits" panel (`features/properties.tsx` around lines 186–199) uses client-side `matchProperties` from `lib/domain.ts` even in LIVE. It can disagree with Agent 04's server-side recommendations.
- **Team invites** return a shareable link; no invitation email is sent (no email provider).
- **No `dangerouslySetInnerHTML`, `eval` or `new Function`** found [STATIC].
- **Build:** `npm run build` succeeds. The main bundle is 485.9 kB (147.6 kB gzip), a single chunk with no code splitting [TEST].
- **No component, accessibility or e2e tests.** Browser checks were manual during implementation [PRIOR].

## 6. Backend, RPC and database [STATIC, RUNTIME]

- **17 migrations applied live** [RUNTIME `list_migrations`]. The live history records MCP apply times (for example `20261025113324_…`), not the file versions. `docs/DATABASE_MIGRATIONS.md` documents the `supabase migration repair` commands needed before using `supabase db push` (PRA-012).
- **Function bodies** of migrations 0008, 0010 and 0012–0017 were checked by md5 against the files during implementation [PRIOR].
- **56 public tables, all with RLS enabled** [RUNTIME]. `data_quality_queue` has RLS and no policy, so only internal definer functions can reach it; this is intentional.
- **Business logic** sits in SECURITY DEFINER RPCs with `search_path = ''` and explicit `has_perm` checks. No definer function lacks a fixed search_path [RUNTIME].
- **Permissions:**
  - `role_permissions` matrix (119 rows at 0007 [PRIOR]);
  - no self-escalation, owner-only owner grants, last-owner protection [STATIC, TEST].
- **Performance advisor:** 96 unindexed foreign keys and 18 unused indexes, all INFO [RUNTIME] (PRA-024).
- **Data volume:** 2 orgs and 3 users. All present data is test data [RUNTIME].

## 7. Authentication and authorization [STATIC, RUNTIME]

- Supabase Auth with email confirmation (`enable_confirmations = true`).
- **`enable_signup = true`**: anyone can register and create a workspace. RPC-level rate limiting exists on organization creation [STATIC]. Whether open self-service signup is wanted is a business decision (PRA-016).
- **Leaked-password protection is disabled** [RUNTIME advisor] (PRA-008).
- **No MFA configuration** is present in `config.toml` [STATIC].
- An anonymous REST read of `leads` returns 401/42501 [RUNTIME].
- No table grants exist for `anon`. The only function `anon` can execute is `set_updated_at`, a trigger function (PRA-026).
- **12 `private` helper functions are executable by `authenticated`.** The `private` schema is not exposed through PostgREST, so they are not reachable via the API [RUNTIME] (PRA-025).
- **About 62 advisor WARNs** say that authenticated users can execute SECURITY DEFINER functions. This is the intended pattern: each function checks `has_perm` [RUNTIME, STATIC].

## 8. Multi-tenancy [TEST, PRIOR]

Every agent's DB suite includes a tenant-isolation test: another workspace gets `NOT_FOUND` and reads nothing. Org-immutability triggers and cross-tenant reference checks are in `0002` and `0004`. The live cross-tenant checks for Agents 06–08 passed [PRIOR]. Status: **VERIFIED (test + prior runtime)**.

## 9. Secrets and configuration [STATIC, RUNTIME, ENV]

- `.env.local` (git-ignored) contains only the Supabase URL and the publishable key, which are both public by design.
- **Vault holds worker URLs and shared secrets** for voice, qualification, property matching, follow-up and calendar, plus one webhook secret [RUNTIME names only; values not read].
- **Edge Function secrets:** `voice-calls/status` reports `retell_configured: false` and `analysis_configured: false` [RUNTIME]. `ANTHROPIC_API_KEY` and `RETELL_API_KEY` are therefore not set.
- **`frontend/test-login.local.md`** (git-ignored) contains a plaintext password for a live test account. The value is not reproduced here (PRA-007).
- There is no git repository, so `.gitignore` is not enforced by anything until a repository is created (PRA-004).

## 10. Webhooks and inbound integrations [STATIC, RUNTIME]

- **`lead-intake`:**
  - HMAC signature with timestamp tolerance;
  - per-integration secret, rotatable via `rotate_webhook_secret`;
  - bounded body read;
  - rejected signatures recorded at one row per org, provider and minute [STATIC, TEST].
  - Live state: `webhook_events` holds 22 processed and 4 rejected [RUNTIME].
- **`voice-webhook`:** Retell signature check implemented as `v=<ms>,d=<hex HMAC>` over body plus timestamp. **This format has not been checked against Retell's SDK or a real webhook** (PRA-015). It fails closed: a mismatch would reject events rather than accept forged ones.
- **Workers** (`*-worker`, called by pg_net) authenticate with a Vault shared secret and run with `verify_jwt = false` [STATIC].

## 11. AI layer [STATIC, TEST, ENV]

There are 9 Claude call sites, listed in `INTEGRATION_AND_AGENT_MAP.md` §4. Every one:
- uses JSON-schema structured output;
- is followed by zod validation and domain validators (for example, a cited value must exist in the snapshot, and invented numbers or "already done" claims are rejected);
- falls back to a deterministic path or human review when the call fails.

The validators are unit-tested [TEST]. **No call has run against the live API** because no key is configured [ENV]. Model output quality, latency, cost and refusal handling are **UNVERIFIED** (PRA-005).

## 12. Background processing, events and idempotency [STATIC, RUNTIME, TEST]

- **12 pg_cron jobs, all active, 0 failed runs in 24 h** [RUNTIME].
- **Outbox:**
  - 126 events, all published;
  - consumer deliveries: follow-up 9, property matching 5, qualification 20;
  - no dead letters [RUNTIME].
- **`agent_runs`:** all `succeeded` or `review_required` (2) [RUNTIME].
- Idempotency keys exist on intake, voice calls, appointments and follow-ups. Webhook dedupe uses `voice_call_events` and `webhook_events`. Advisory locks protect bookings [STATIC, TEST].
- **Events without consumers.** Agents 06, 07 and 08 publish events with no consumer: `appointment.*` (except the Agent 05 hand-off, done by trigger), `crm.*` and `sales.*`. That is by design for now, but nothing reads them (INFO, PRA-028).

## 13. Outbound communication [STATIC, RUNTIME, ENV]

- **Follow-ups (Agent 05):** drafted, approved and sent manually; the provider dispatch endpoint exists. **No messaging provider is integrated.** Live: 4 cancelled, 1 handed off, 1 suppressed, 2 pending approval, 0 sent by provider [RUNTIME] (PRA-006).
- **Voice (Agent 02):** the Retell adapter exists, but `voice_calls` has 0 rows and no call has ever been placed [RUNTIME].
- **Calendar (Agent 06):** the sync boundary exists (claim, result, busy import) but there is **no provider adapter**, so sync is effectively unsupported [STATIC].
- **Email:** only Supabase Auth's built-in mailer. Invitations are links only.

Consent, DNC, opt-out and quiet-hours policy are enforced in SQL before any outbound action [STATIC, TEST].

## 14. Rate limiting and abuse controls [STATIC]

- **RPC-level limits:**
  - organization creation;
  - per-lead qualification, matching and follow-up requests;
  - retry handling for Anthropic and Retell 429 responses.
- **No general API rate limiting** beyond Supabase platform defaults (PRA-017).
- **CORS `*`** on JWT-authenticated functions (INFO, PRA-027).
- Webhook bodies are size-bounded.

## 15. Reliability, timeouts and failure handling [STATIC, TEST]

- Timeouts are present in the calendar-sync, follow-up-delivery, retell and voice-runner modules.
- Runs move through `queued → running → succeeded / failed / review_required` with retry counts.
- Stale-claim recovery happens in the ticks.
- Failure paths are tested in the DB suites (for example, provider unavailable, analysis failed, sync failed).

## 16. Observability and operations [STATIC]

- **No error tracking, log shipping, uptime checks or alerting.** Operational state lives only in tables (`agent_runs`, `outbox_events`, `audit_logs`) and in the Supabase dashboard logs (PRA-003).
- **No runbooks** for stuck runs, dead letters, secret rotation or incident response. The agent docs contain setup notes only.
- **Backups:**
  - not documented;
  - `docs/DATABASE_MIGRATIONS.md` says a project was paused "to free a free-plan slot", which suggests the free plan: no PITR, and automatic pausing on inactivity [STATIC, ENV; plan not confirmed via billing] (PRA-002).

## 17. Testing and quality gates [TEST]

Commands run in this audit, in `frontend/`:

| Command | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | exit 0 |
| `npm test` (`vitest run`) | **21 files, 236 / 236 tests pass** |
| `npm run build` (`tsc --noEmit && vite build`) | exit 0; built in 4.18 s; main JS 485.90 kB (147.56 kB gzip) |
| `npm audit` | 8 vulnerabilities: 2 low, 2 moderate, 2 high, 2 critical |
| `npm audit --omit=dev` | 3 vulnerabilities: 2 low, 1 high |

**Dependency audit:**
- **Critical, dev only:** `vitest` and `tinypool` (RCE while the Vitest API server is listening).
- **High, dev only:** `vite` (dev-server request and `fs.deny` bypass); `esbuild` is moderate.
- **High, runtime:** `zod` (memory exhaustion validating oversized constrained collections) in the frontend. Edge Functions pin `zod@3.24.1` separately; whether that version is affected was not checked.
- **Low:** `@supabase/auth-js` / `supabase-js` (insecure path routing).

None of these was fixed during this audit (PRA-013, PRA-014).

**Gaps:**
- no lint configuration (PRA-021);
- no frontend, component or e2e tests (PRA-018);
- Edge Function handlers are tested only through their extracted `_shared` logic; the Deno entry points are not run in CI (there is no CI) [STATIC].

## 18. Deployment readiness [STATIC, RUNTIME]

- **Live Edge Functions:** 10 deployed (corrected in Phase 2 from "11" after a fresh `list_edge_functions`). `sales-analyst` and `sales-intelligence-recommend` return 404 [RUNTIME] (PRA-001).
- **`config.toml`** declares `verify_jwt` only for `lead-intake`, `voice-webhook`, `voice-worker` and `voice-calls`. `supabase functions deploy` of the others would use the default `verify_jwt = true`. For the pg_net-called workers (`qualification-worker`, `property-matching-worker`, `follow-up-worker`, `calendar-sync-worker`) that would reject every cron call (PRA-009).
- **No frontend hosting.** The SPA has only ever run on the local dev server (PRA-011).
- **No staging project.** All live verification happened in the single project that would become production (PRA-010).

## 19. Data protection and compliance [STATIC]

- **Present:**
  - consent records;
  - DNC and opt-out handling;
  - append-only `audit_logs`;
  - private `documents` storage bucket with org-scoped policies;
  - export audit (`record_export`);
  - Agent 08 analyst logs store the spec and status only, not the question text [STATIC, TEST].
- **Not present:**
  - data-retention or deletion jobs;
  - subject-access or erasure tooling;
  - a privacy policy or terms in the app;
  - call-recording consent wording for voice;
  - a documented data-residency statement (the project is in ap-south-1).

These need legal input before a pilot with real contacts (PRA-020).

## 20. Findings summary and recommendation

| Severity | Count | IDs |
|---|---|---|
| CRITICAL | 0 | none |
| HIGH | 11 | PRA-001 … PRA-011 |
| MEDIUM | 12 | PRA-012 … PRA-023 |
| LOW | 3 | PRA-024 … PRA-026 |
| INFO | 2 | PRA-027, PRA-028 |

No finding was rated CRITICAL. No data exposure path, no authentication bypass and no broken tenancy control was found. The HIGH findings are blockers to **launch**, not active vulnerabilities.

**Recommendation: further testing and staging hardening.** Do not start a controlled pilot until:
1. A git repository, CI (typecheck, tests, build, lint) and a separate staging Supabase project exist.
2. `config.toml` declares every function, and the two Agent 08 functions are deployed and smoke-tested.
3. Anthropic and Retell keys are set in **staging**, and each AI step and a real test call are verified end to end. A messaging provider is chosen and integrated, or the pilot is explicitly scoped to manual follow-up.
4. The production project is on a plan with backups, has leaked-password protection on, and has had its test users, workspaces and the local plaintext password file removed.
5. Basic error tracking and alerting on `agent_runs` failures and cron failures are in place.

---

## 21. Phase 2 remediation summary (2026-10-26)

Details: `PHASE_2_REMEDIATION_PLAN.md`, `PHASE_2_REMEDIATION_REPORT.md`. All Phase 2 work is **in the workspace only**: nothing was deployed, no migration was applied to the hosted project, and nothing was committed.

**Resolved (with evidence):**
- **PRA-009:** every Edge Function is declared in `config.toml` with the correct `verify_jwt`, matching the live flags.
- **PRA-013 / PRA-014 (most of it):** `npm audit` and `npm audit --omit=dev` both report 0 vulnerabilities after targeted upgrades (vite 6.4.5, vitest 4.1.12, zod 4.6.7, supabase-js 2.50.5). The Edge supabase-js import is pinned.
- **PRA-021:** ESLint added and clean. A `check:functions` type-check now covers all 12 Edge Functions.
- **PRA-015:** the Retell signature algorithm matches the official SDK (golden vector).
- **PRA-023:** the property drawer uses server matches; the live probe agrees with each lead's recommendations, and the other tenant reads nothing.
- **PRA-019:** as-built note added.
- **New catalog-level security tests:**
  - RLS on every table;
  - pinned `search_path` on every definer function;
  - no anon privileges;
  - a cross-tenant sweep of every org-scoped table;
  - indirect RPC access.
  - Each fails when the property it guards is removed (mutation check).
- **Tests:** 259 / 259 pass, up from 236.

**Fixed in code, not yet in any deployed environment:**
- **PRA-029 (HIGH, new):** three AI functions called Claude before the permission check.
- **PRA-030 (HIGH, new):** no AI usage limits.
- Both are fixed by migration 0018 and the guard in the four functions, and must be applied and deployed in staging (migration first).
- **PRA-026** is in the same migration.

**Still outstanding (unchanged):**
- **PRA-001:** the Agent 08 functions are not deployed.
- **PRA-002:** backups.
- **PRA-003:** monitoring.
- **PRA-004:** git (CI file ready).
- **PRA-005:** AI and voice keys; every Claude step and every call is still unverified.
- **PRA-006:** messaging and calendar providers.
- **PRA-007:** test residue and the local password file.
- **PRA-008:** leaked-password protection.
- **PRA-010:** staging.
- **PRA-011:** hosting.

All of these need human decisions, credentials or approvals.

**Recommendation after Phase 2:** unchanged. Ready for further local testing and a **staging deployment** once a staging project and the AI and voice keys exist. Not ready for a controlled pilot, and not for production.

---

## 22. Phase 3 staging summary (2026-10-26 / 27)

Details: `PHASE_3_STAGING_PLAN.md`, `STAGING_ENVIRONMENT_REFERENCE.md`, `PHASE_3_E2E_TEST_REPORT.md`, `PHASE_3_AGENT_VALIDATION_MATRIX.md`, `PHASE_3_INTEGRATION_REPORT.md`, `PHASE_3_STAGING_VALIDATION_REPORT.md`.

**What was done:**
- "Estate OS" was designated **staging** by the owner.
- Migration 0018 was applied; its function bodies match a fresh install.
- `sales-intelligence-recommend`, `sales-analyst`, `appointment-assistant`, `crm-enrichment` and `qualification-worker` were deployed.
- The repository suite `frontend/scripts/staging-e2e.mjs` ran against staging: **92 pass, 0 fail**, covering auth, roles, tenant isolation across 44 tables, the cron-driven lead → qualification → matching → follow-up → appointment → CRM → analytics workflow, failure handling and latency.
- Analytics match independent counts.

**Resolved by Phase 3:**
- **PRA-001:** the Agent 08 functions are deployed.
- **PRA-026:** verified live.
- **PRA-029 / PRA-030:** the guard is verified live.
- **PRA-010:** partially resolved (staging designated).

**New finding:** PRA-031 (LOW), a worker returns 401 when its secret check fails transiently.

**Still blocking a pilot:**
- AI key and Retell (every AI step and every call is unverified);
- messaging and calendar providers;
- UI hosting;
- monitoring and alerting;
- backups and a separate production project;
- git and CI;
- leaked-password protection;
- legal review.

**Decision: `STAGING DEPLOYED — VALIDATION INCOMPLETE`.**

---

## 23. Phase 5 summary (2026-10-27)

Details: `PHASE_5_PRODUCTION_LAUNCH_PLAN.md`, `PHASE_5_VALIDATION_REPORT.md`, `PRODUCTION_DEPLOYMENT_RUNBOOK.md`, `PRODUCTION_INCIDENT_RUNBOOK.md`, `PRODUCTION_LAUNCH_CHECKLIST.md`, `COMMERCIAL_LAUNCH_READINESS.md`.

**Added:**
- health endpoint (`ops_health` + `health` function);
- AI token metering and a per-workspace usage summary (migration 0020);
- worker-auth fix (PRA-031);
- predeploy guard (in CI);
- environment pill;
- production-safe smoke suite.

**Verified:**
- 278 / 278 local tests;
- staging e2e 92 / 92, pilot controls 11 / 11, smoke 16 / 16;
- health `ok` live.

**No pilot ran, and no production environment exists.**

**Decision: `PRODUCTION NOT READY`.** Release blockers G3–G7 and G10 need infrastructure, accounts, legal review and business decisions.
