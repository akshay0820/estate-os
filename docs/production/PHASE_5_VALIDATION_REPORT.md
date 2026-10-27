# Phase 5 Validation Report — Estate OS

Date: 2026-10-27. **Decision: `PRODUCTION NOT READY`** (§9).

## 1. Starting point (verified, not assumed)

- **No pilot ran; no customer.** Phase 4 ended `PILOT NOT READY`. There are no business outcomes, customer feedback, real usage or costs to report.
- **No production or pilot project, no paid plan, no git repository, no frontend host.** Checked on 2026-10-27 with `list_projects`, `get_organization` and `git status`.
- **The Anthropic key still does not reach the Estate OS functions:** `analysis_configured: false` at 2026-10-26 20:51 UTC.

## 2. Implemented in Phase 5

| Change | Files | Why |
|---|---|---|
| `public.ops_health()` (service role only) + `health` Edge Function (public `{status}`; signals behind `HEALTH_TOKEN`; 200 / 503) | `supabase/migrations/20261025002000_ops_health_and_usage.sql`, `supabase/functions/health/index.ts`, `_shared/health.ts`, `config.toml` | G7: an uptime monitor needs a status endpoint; no tenant data exposed |
| AI usage metering: token columns on `ai_requests`; `ai_request_finish` accepts provider usage; `ai_usage_summary(org, from, to)` (`usage.view`) from stored provider usage; the 4 AI functions pass `res.usage` | Same migration; `_shared/ai-guard.ts`; the 4 AI functions | G17: per-tenant cost attribution; no invented cost |
| Worker auth: 503 + log when the secret check cannot run, 401 only for a wrong secret | `_shared/worker-auth.ts`; 5 workers | PRA-031 |
| Environment guard: `VITE_APP_ENV` pill in the app for non-production; `scripts/predeploy-check.mjs` (`npm run predeploy`, also in CI) | `src/backend/client.ts`, `src/layout/Shell.tsx`, `.env.example`, `package.json`, `.github/workflows/ci.yml` | G4/G5: staging must not ship as production; no secrets in the bundle; function and config consistency; no destructive migrations |
| Production-safe smoke suite | `frontend/scripts/smoke.mjs` | Post-deployment verification without calls, messages, appointments or payments |
| Documents | `PHASE_5_PRODUCTION_LAUNCH_PLAN.md`, `PRODUCTION_DEPLOYMENT_RUNBOOK.md`, `PRODUCTION_INCIDENT_RUNBOOK.md`, `PRODUCTION_LAUNCH_CHECKLIST.md`, `COMMERCIAL_LAUNCH_READINESS.md`, this report | |

**Not implemented, by rule:**
- billing and subscriptions (no provider or pricing decision);
- operator-initiated provisioning;
- bulk import;
- a per-workspace background AI budget (G18).

## 3. Commands executed and results

**Local** (`frontend/`):

| Command | Result |
|---|---|
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm run check:functions` | pass (13 functions) |
| `npm test` | **27 files, 278 / 278** (+11: 6 health/usage DB tests, 5 health/worker-auth unit tests; 1 guard test updated for the new token arguments) |
| `npm run build` | pass |
| `npm run predeploy` | all checks passed |
| `npm audit` | 0 vulnerabilities |
| `VITE_APP_ENV=staging VITE_SUPABASE_URL=<staging> node scripts/predeploy-check.mjs --env production` | **correctly FAILS** (2 checks) |
| The same with a production label and another project ref | passes |

**Mutation-style checks:**
- The destructive-statement detector first flagged `revoke … truncate` grants (a false positive). It was fixed to statement level and re-run clean.

**Staging** (`jvdnapofyoarhfctbpyi`; staging only — nothing touched production, which does not exist):

| Step | Result |
|---|---|
| Migration 0020 applied | `ai_request_finish`, `ai_usage_summary`, `ops_health` bodies match a fresh local install (md5) |
| `ops_health()` live | `ok`; real signals (75 worker calls / 15 min, 0 errors, 0 cron failures) |
| Deployed `health` (v1) and `qualification-worker` (v3, shared auth helper) | 35 / 35 cron calls to workers → 200 after the deploy; wrong worker secret → 401; public `/health` → `{status, checked_at}` only; wrong `x-health-token` → no signals |
| `node scripts/smoke.mjs` (staging, `SMOKE_SLUG_PREFIX=e2e-`) | **16 / 16** (incl. qualification through cron, tenant denial, kill switch, restore); the guard refuses non-smoke slugs |
| `node scripts/staging-e2e.mjs` | **92 / 92** pass, 1 observation (JWT valid after logout), 8 measurements |
| `node scripts/staging-pilot-controls.mjs` | **11 / 11** |
| Security advisor | No new issue classes (Phase 3 baseline) |

**Not run:**
- production anything (no project, no authorization);
- a restore drill (no PITR);
- AI with a real key (key not visible);
- Deno runtime tests for the 3 AI functions changed in Phase 5. Type-checked only; not redeployed to staging.

## 4. Security

- **Authentication, authorization and tenant isolation:** re-verified on staging (e2e and smoke). No bypass found.
- **Secrets:** the bundle scan is automated (`predeploy`). The git-ignored plaintext test password file and an exposed fragment of a staging test password remain to be cleaned up (G3).
- **Data protection:**
  - health exposes only aggregates;
  - the usage summary stores and returns token counts, not prompts;
  - logs carry ids only.
- **No compliance claims.**

## 5. Database

| Item | Status |
|---|---|
| Migrations | 20 versioned, ordered and additive; apply fresh; `predeploy` enforces this |
| Backups | **None configured** (no production project; free plan) |
| Restore | **Unverified** |
| RPO / RTO | Undefined until PITR and a drill exist |

## 6. Agents in the initial production scope (if and when launched)

| Agent | Initial release |
|---|---|
| 1 Intake | **Permitted** (deterministic; AI extraction off) |
| 3 Qualification | **Permitted** (deterministic; AI step off) |
| 4 Matching | **Permitted** (deterministic; AI explanations off) |
| 5 Follow-up | **Drafts plus human approval plus manual sending only** |
| 6 Appointment | **Internal booking by staff only** |
| 7 CRM & data | **Permitted**; merges human-approved |
| 8 Sales intelligence | **Metrics permitted**; AI recommendations off |
| 2 Voice | **Not permitted** |
| All AI (Claude) steps | **Not permitted** until verified with a key |

## 7. Integrations

| Level | Integration |
|---|---|
| **Verified on staging** | Signed lead webhook; Supabase Auth; pg_cron → workers; health endpoint |
| **Mocked or unit only** | Claude validators; Retell signature (SDK golden vector); AI guard helper |
| **Not configured / not implemented** | Anthropic (key not visible), Retell, messaging, calendar, CRM connectors, billing |

## 8. Release blockers (all outside this repository's control)

| Gate | What is needed |
|---|---|
| G3 | Secret clean-up (test password file, staging test accounts) |
| G4 | Production project in a separate paid organization, with PITR, plus a restore drill |
| G5 | Git repository with CI green |
| G6 | Frontend hosting |
| G7 | External monitor polling `/health`, with a tested alert |
| G10 | Legal: terms, privacy, data processing, consent |
| Before onboarding (G11, G12) | Leaked-password protection; custom SMTP; all functions deployed from git |

## 9. Decision

**`PRODUCTION NOT READY`.** The release blockers G3–G7 and G10 are unmet. They require infrastructure, accounts, legal input and business decisions that this phase may not perform or invent.

The repository side is prepared:
- deployment and incident runbooks;
- predeploy guard;
- smoke suite;
- health endpoint;
- usage metering;
- launch checklist;
- commercial scope.

When the blockers are cleared, the next step is the deployment runbook. The status can then move to `READY FOR CONTROLLED PRODUCTION RELEASE` once the production smoke suite, the restore drill and the monitoring test pass.
