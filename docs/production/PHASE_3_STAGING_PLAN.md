# Phase 3 Staging Plan — Estate OS

Date: 2026-10-26. Inputs:
- the Phase 1 reports (`PRODUCTION_READINESS_AUDIT.md`, `FEATURE_VERIFICATION_MATRIX.md`, `TECHNICAL_REMEDIATION_BACKLOG.md`, `INTEGRATION_AND_AGENT_MAP.md`);
- the Phase 2 reports (`PHASE_2_REMEDIATION_PLAN.md`, `PHASE_2_REMEDIATION_REPORT.md`).

All six were present and re-read.

## 1. Staging target and authorization

| Item | Decision / evidence |
|---|---|
| Staging project | **Supabase "Estate OS" (`jvdnapofyoarhfctbpyi`, ap-south-1, Postgres 17).** The owner designated it as staging in chat on 2026-10-26 |
| Why not a new project | The org is on the **free plan**. Two projects are active ("ARKA", "Estate OS") and the free plan allows two. A new project costs $0 (`get_cost`) but needs another project paused; the owner chose to reuse Estate OS |
| Isolation | Contains only synthetic data: 3 users, all `@estate-os.test`; 2 workspaces (`e2e-realty-a`, `e2e-realty-b`). No customer has ever used it. No other environment exists, so nothing can be cross-connected |
| Consequence for production | **Production must be a new, separate project.** It must never be created by promoting this database. Migrations 0001–0018 are applied fresh there |
| Data caution | Synthetic contacts use realistic-looking `+91` mobile numbers. No provider can contact them today (none is configured), but before Retell or messaging is enabled in staging these must be replaced with numbers the team owns, or voice must stay disabled for those leads |
| Deployment authority | Applying migration 0018 and deploying Edge Functions to this project: authorized. Production: none exists; nothing will be done |

## 2. Components (repository evidence)

| Component | Responsibility | Runtime | Config | Startup | Health check | Deployment | Data access | If unavailable |
|---|---|---|---|---|---|---|---|---|
| Web app (`frontend/`) | UI for all modules | Vite 6 / React 18 SPA (static files) | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | `npm run build` → `dist/`; `npm run dev` locally | Page loads; login works | **None: no host configured** (PRA-011). Runs locally against staging | Supabase REST, RPC, Auth, Storage, Functions with the user JWT | Users have no UI. The backend keeps working |
| Database | Data, RLS, business rules, RPCs, outbox | Supabase Postgres 17 | Vault entries (§3) | Managed | `select 1`; advisors; §8 operator queries | Migrations via MCP `apply_migration` (CLI after the history repair, PRA-012) | n/a | Everything stops |
| Auth | Sign-up / sign-in, JWT | Supabase Auth | `config.toml [auth]` | Managed | Sign-in of a test user | Dashboard / `config.toml` | `auth.users` | No sign-in |
| Storage | `documents` bucket (private) | Supabase Storage | Policies in migration 0003 | Managed | Upload / read as a member | Migration | Bucket objects | Document upload fails |
| Scheduler | 12 pg_cron jobs, every minute | pg_cron + pg_net | Vault URL and secret per worker | With the DB | `cron.job_run_details`, `net._http_response` | Migrations | DB; HTTP to workers | Agents stop advancing; data is kept and resumes |
| Edge Functions (12) | Webhook intake, workers, user-triggered AI | Supabase Edge (Deno) | §3 | Deployed per function | Per function (§8) | MCP `deploy_edge_function` / `supabase functions deploy` (with `config.toml`) | DB via service role (workers, intake) or the caller's JWT (user functions) | See the agent map |
| Anthropic | Model calls (9 sites) | External API | `ANTHROPIC_API_KEY` | n/a | `voice-calls/status` → `analysis_configured` | Edge secret | n/a | Deterministic fallbacks; AI features return `not_configured` |
| Retell | Outbound calls and webhooks | External API | `RETELL_API_KEY` | n/a | `voice-calls/status` → `retell_configured` | Edge secret | n/a | Calls blocked with a reason; nothing dialled |
| Messaging / calendar providers | none | none | none | none | none | **Not implemented** (PRA-006) | none | Manual follow-up; no calendar sync |
| Monitoring | none beyond tables and dashboard logs | none | none | none | none | **Not implemented** (PRA-003) | none | none |

## 3. Environment variables and secrets

The full list is in `STAGING_ENVIRONMENT_REFERENCE.md`. In summary:
- the browser receives only the project URL and the publishable key;
- Edge Functions read `SUPABASE_*` (platform-injected), `ANTHROPIC_API_KEY`, `RETELL_API_KEY` and 9 optional model overrides;
- the database reads 10 Vault entries (5 worker URLs, 5 worker shared secrets).

## 4. Database

- Migrations `20261025000100` … `20261025001800`, in filename order.
- 0001–0017 are applied on staging. **0018 is pending** (Phase 2).
- Required extensions: `pg_cron`, `pg_net` (in `extensions`), `vault` (Supabase default), `pgcrypto` built-ins.
- **Fresh-install check:** run all 18 migrations on a disposable database (PGlite in `npm test`, plus the catalog-invariant tests) before applying to staging.
- **Seed:** synthetic fixtures only (§6 of `PHASE_3_E2E_TEST_REPORT.md`), created through the application's own RPCs and webhook, never with direct table writes.

## 5. Deployment steps (staging)

1. **Pre-checks, all green before anything is deployed:**
   - `npm run lint`, `typecheck`, `check:functions`, `test`, `build`;
   - `npm audit --omit=dev`.
2. **Apply migration 0018** with MCP `apply_migration`. Then confirm with `list_migrations`, and compare the md5 of the live function bodies (`ai_request_begin`, `ai_request_finish`, `private.ai_limits`) with the same functions created from the file locally.
3. **Deploy Edge Functions:**
   - `sales-analyst` and `sales-intelligence-recommend` (first deployment, PRA-001);
   - `appointment-assistant` and `crm-enrichment` (AI guard);
   - `qualification-worker` (canary for the new pinned `supabase-js@2.118.0` / `zod@4.6.7` imports under cron load).
   - `verify_jwt` as in `config.toml`. Afterwards compare the md5 of every deployed source file with the repository.
4. **Not redeployed in this phase**, to limit hand-transcribed deployments; each still runs its previous, live-verified version: `lead-intake`, `voice-calls`, `voice-webhook`, `voice-worker`, `property-matching-worker`, `follow-up-worker`, `calendar-sync-worker`. Their only repository change is the import pin and zod version, so this is recorded as known drift.
5. **Smoke checks:**
   - the canary worker keeps returning 200 to cron;
   - the new functions answer OPTIONS, 401 without a JWT, and 503 `not_configured` with a JWT (no key);
   - `ai_request_begin` enforces permissions and limits live.

## 6. Validation plan

| Area | Method | Where |
|---|---|---|
| Regression | Full vitest suite (PGlite), lint, typecheck, function type-check, build, audit | Local |
| Auth and tenant isolation | Signed-in REST/RPC probes as each test user against every org-scoped table and the key RPCs; anonymous probes; invalid and expired tokens | Staging |
| Lead → appointment workflow | Signed webhook → intake → cron qualification → cron matching → follow-up plan → appointment booking → CRM state → Agent 08 metrics vs direct counts | Staging (real cron, no providers) |
| Agents | The above plus agent-specific probes; AI steps BLOCKED without a key | Staging + local |
| Failure and recovery | Invalid signature, replayed webhook, duplicate submissions, concurrent booking, unauthorized AI trigger, provider absent | Staging + local tests |
| Performance | Latency of key reads and RPCs (sequential and 10-way concurrent); concurrency duplicate checks. **Smoke and concurrency only, not a load test** | Staging |
| Observability | `cron.job_run_details`, `net._http_response`, `agent_runs`, `outbox_events`, `webhook_events`, `ai_requests`; health of each function | Staging |

## 7. Rollback and recovery

- **Migration 0018** is additive. To roll back, drop `ai_request_begin`, `ai_request_finish`, `private.ai_limits` and `ai_requests`, and re-grant EXECUTE on `set_updated_at`. **Deploy the previous function code first**, because the new AI functions fail closed without the guard.
- **Edge Functions:** redeploy the previous source. The pre-Phase-2 versions differ only in the guard and the import pins; the four AI functions' old bodies are in the Phase 2 report history. The platform keeps version numbers but the MCP tool has no rollback, so a rollback is a redeploy.
- **Data:** staging only, synthetic. Test records are tagged (`STG-`) and archived through RPCs after the run. A full reset means a new project and the migrations applied fresh (no backups on the free plan).

## 8. Required human approvals and blockers

| Item | Status |
|---|---|
| Use Estate OS as staging; apply 0018; deploy functions | **Approved** (owner, 2026-10-26) |
| Anthropic key in staging (all AI steps) | **Needed**: owner sets `ANTHROPIC_API_KEY` as an Edge Function secret |
| Retell key, a test agent and a phone number the team owns | **Needed** before any voice test |
| Messaging and calendar providers | **Needed**: product decision (PRA-006) |
| Frontend hosting for staging | **Needed**: host choice (PRA-011). Until then the UI is tested locally against staging |
| Monitoring and alerting provider | **Needed** (PRA-003) |
| Git repository | **Needed** (PRA-004); the deployed version is identified by file md5s instead of a commit |
| Production project (separate), paid plan with PITR | **Needed** before any pilot (PRA-002) |
| Legal / consent review | **Needed** before real contacts (PRA-020) |
