# Production Deployment Runbook — Estate OS

**Status: prepared, never executed.** No production project exists yet (2026-10-27). Every step is to be run by an authorized operator. Steps marked **[APPROVAL]** need written sign-off first.

**Architecture** (from the repository):
- static SPA (`frontend/`, Vite build to `dist/`);
- a Supabase project for Postgres with RLS, Auth, Storage, pg_cron + pg_net, Vault, and 13 Edge Functions in `supabase/functions` (12 product functions plus `health`);
- no other runtime.

**Tooling:** the Supabase CLI (`npx supabase …`, run from the repository root) and the npm scripts in `frontend/package.json`. The Supabase MCP tools may be used instead where noted.

## 1. Release prerequisites

| # | Prerequisite | Verify |
|---|---|---|
| 1 | Release gates G3–G6, G10–G12 met (`PHASE_5_PRODUCTION_LAUNCH_PLAN.md` §2) | Launch checklist signed |
| 2 | Production project in a **separate, paid organization**: Small compute or larger, PITR enabled **[APPROVAL: cost]** | Dashboard → Settings → Add-ons shows PITR; Database → Backups → Point in time shows a recovery window |
| 3 | Frontend host chosen; production URL known | DNS **[APPROVAL]** |
| 4 | Release commit tagged in git; CI green on it | CI run link |
| 5 | Operator has the production ref and a CLI login (`npx supabase login`) | `npx supabase projects list` shows the ref |

## 2. Approved version

Record before starting:
- the git tag and commit SHA;
- the CI run;
- the migration list (latest: `20261025002000_ops_health_and_usage.sql`);
- the function list (13).

## 3. Environment configuration (no values in tickets or chat)

| Where | Setting |
|---|---|
| Host build env | `VITE_SUPABASE_URL` (production URL); `VITE_SUPABASE_PUBLISHABLE_KEY`; `VITE_APP_ENV=production` |
| Edge Function secrets | `npx supabase secrets set --project-ref <prod-ref> ANTHROPIC_API_KEY=… HEALTH_TOKEN=…`. Optionally the model overrides. `RETELL_API_KEY` **only** after voice is approved |
| Auth (Dashboard) | Site URL and redirect URLs = the production host; email confirmations on; **leaked-password protection on**; custom SMTP for invitations and confirmations; signup policy per business decision |

**Verify without revealing values:**
- `npx supabase secrets list --project-ref <prod-ref>` shows names and hashes only.
- `GET /functions/v1/voice-calls/status` (signed in) reports `analysis_configured` as expected.

## 4. Pre-deployment tests (from `frontend/`, on the release commit)

```bash
npm ci
npm run lint
npm run typecheck
npm run check:functions
npm test
npm run build
npm run predeploy -- --env production
npm audit --omit=dev
```

`predeploy -- --env production` must pass. It refuses:
- a build not labelled `production`;
- a build pointing at a known non-production project (staging `jvdnapofyoarhfctbpyi`, plus any in `PREDEPLOY_NONPROD_REFS`);
- server secrets in the bundle;
- undeclared functions, unpinned imports, or destructive migration statements.

**Also run on staging, against the same commit:**
- `scripts/staging-e2e.mjs` — 0 failures;
- `scripts/staging-pilot-controls.mjs` — 0 failures;
- `scripts/smoke.mjs` with the staging smoke workspaces.

## 5. Database migration review **[APPROVAL]**

- **Read the diff** of every migration since the last release. All are additive. Function replacements keep their signatures, except `ai_request_finish`, which gains optional parameters; old callers keep working.
- `predeploy` reports no table or column drops, truncates or unfiltered deletes.
- **First install:** the project is empty, so no history repair is needed. For later releases, `npx supabase migration list --linked` must show local = remote before `db push`.
- **Never** edit an applied migration; fix forward with a new one.

## 6. Backup verification (before every migration)

- **PITR:** Dashboard → Database → Backups → Point in Time. The latest recovery point is within minutes of now. Record it.
- **First release:** run the restore drill in §13 *before* the first customer is onboarded (G4).

## 7. Deployment steps

1. **Link:**
   ```bash
   npx supabase link --project-ref <prod-ref>
   ```
2. **Migrations [APPROVAL]:**
   ```bash
   npx supabase db push
   ```
   Then confirm with `npx supabase migration list --linked`.
3. **Worker URLs** (first install only; the migrations already created the worker secrets): in the SQL editor, run one statement per worker:
   ```sql
   select vault.create_secret('https://<prod-ref>.supabase.co/functions/v1/qualification-worker', 'qualification_worker_url');
   ```
   Repeat for `property-matching-worker`, `follow-up-worker` and `calendar-sync-worker`.

   **Do not create `voice_worker_url` until voice is approved.** Without the URL, the voice cron job does nothing.
4. **Functions** (uses `supabase/config.toml` for `verify_jwt`):
   ```bash
   npx supabase functions deploy --project-ref <prod-ref>
   ```
   Confirm all 13 with `npx supabase functions list --project-ref <prod-ref>`.
5. **Frontend:** deploy `frontend/dist` from the same commit to the host.
6. **Record:** in the release log, the version, operator, time, migration versions and function versions.

## 8. Post-deployment health checks (within 15 minutes)

| Check | Pass when |
|---|---|
| `GET https://<prod-ref>.supabase.co/functions/v1/health` | 200, `"status":"ok"`. With `x-health-token: <HEALTH_TOKEN>`, the signals show `worker_errors_15m` = 0 and `cron_failed_15m` = 0 after 5 minutes |
| `select jobname, active from cron.job;` | 12 jobs active |
| Security advisor (Dashboard → Advisors) | No new ERROR. Known WARNs: definer RPCs (intended) |
| `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;` | 0 |

## 9. Tenant-isolation smoke tests

`scripts/smoke.mjs` SM-04, SM-07, SM-13 (below). It needs two dedicated smoke users, each owning a smoke workspace with a slug starting `smoke-`. Create them once, through the production sign-up, with `@example.com` addresses. **Never use a customer workspace.**

## 10. Core workflow smoke tests

From `frontend/`, with `.env.production` holding the production URL and publishable key:

```bash
SMOKE_PROJECT_REF=<prod-ref> SMOKE_EMAIL_A=… SMOKE_EMAIL_B=… SMOKE_PASSWORD_A=… SMOKE_PASSWORD_B=… SMOKE_ORG_A=smoke-a SMOKE_ORG_B=smoke-b node scripts/smoke.mjs --env-file .env.production
```

It covers:
- health, sign-in and tenant denial;
- lead creation and retrieval;
- qualification and matching through the real cron chain;
- analytics, the usage summary and integration status;
- kill-switch enforcement, with the control restored afterwards.

It makes no calls, messages, appointments or payments. **All checks must pass.**

## 11. Monitoring verification

- The external uptime monitor (`.github/workflows/uptime.yml`, see `UPTIME_MONITORING.md`) polls `/functions/v1/health` and the site every 5 minutes and alerts on non-200; set its `HEALTH_URL` and `SITE_URL` repository variables to production. **Confirm one test alert reaches the on-call role.**
- The daily runbook queries return expected values.

## 12. Rollback criteria

**Roll back the application if:**
- any smoke check fails on a core workflow or tenant isolation;
- health stays non-200 for 15 minutes after deploy;
- the error rate rises after deploy (worker 5xx or cron failures).

**Declare a SEV-1 instead** (incident runbook) for cross-tenant exposure or data corruption.

## 13. Rollback and recovery

| Kind | How | Notes |
|---|---|---|
| **Frontend rollback** | Redeploy the previous `dist` (previous tag) on the host | Instant where the host keeps previous deploys |
| **Function rollback** | `git checkout <previous tag>`, then `npx supabase functions deploy <name> --project-ref <prod-ref>` | Not instantaneous; one function at a time is fine. The previous code is compatible with the current schema because all migrations are additive. Exception: AI functions older than migration 0018 do not use the guard and should not be restored |
| **Database: no down migrations** | Fix forward with a new migration | |
| **Database restore (PITR)** | Data recovery only, never a code rollback. Dashboard → Database → Backups → Point in Time → Start a restore | **The project is offline during the restore, and every write after the restore point is lost.** SEV-1 decision by the Incident Commander only |
| **Restore drill** (first release, then quarterly) | Restore into a **new, separate project** (Dashboard "Restore to a new project" / clone), never over production. Then verify: table count; RLS on every table; function hashes; a sample of tenant rows; that the app can sign in and read | Record the duration (RTO) and the recovery point (RPO) |

**Before any recovery is declared complete:**

- **Interrupted jobs.** Runs in `received` or `retry_scheduled` are retried by cron. Events in `processing` with an expired lease are re-claimed. Dead letters stay for a person to review.
- **Duplicate actions.** Follow-ups are never sent automatically (no provider). Appointments and voice calls carry idempotency keys. Before resuming any paused agent, review the held work (Pilot operations).
- **Provider callbacks.** None are active except lead webhooks. Senders retry with the same event id, which is deduplicated.

## 14. Customer communication

- **Scheduled releases:** notice to the cohort's admins 2 business days ahead if downtime is expected (database restores only).
- **Incidents:** incident runbook. Never promise an instant rollback.

## 15. Release sign-off

| Role | Sign-off |
|---|---|
| CTO | Release approved; gates met |
| Operator | Steps 7–11 executed; evidence attached |
| Ops on-call | Monitoring confirmed |
| Commercial | Customer notice, if any |
