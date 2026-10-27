# Technical Remediation Backlog — Estate OS

Source: Phase 1 audit, 2026-10-26 (`PRODUCTION_READINESS_AUDIT.md`). The evidence tags are explained there: [STATIC] source or config, [TEST] automated suite, [RUNTIME] live read-only observation, [ENV] environment, [PRIOR] earlier session.

**Stage** says when a fix is needed:
- **S1**: before staging sign-off;
- **S2**: before a controlled pilot;
- **S3**: before general availability;
- **S4**: ongoing hygiene.

Phase 1 was read-only. Phase 2 statuses are below; the evidence is in `PHASE_2_REMEDIATION_REPORT.md`.

## Phase 2 status (2026-10-26)

| ID | Severity | Status | Note |
|---|---|---|---|
| PRA-001 | HIGH | FIXED_VERIFIED (P3) | Both functions deployed to staging after 0018; they answer 401 without a JWT and 503 `not_configured` with one. Real output is blocked by PRA-005 |
| PRA-002 | HIGH | BLOCKED | Billing / PITR decision |
| PRA-003 | HIGH | PARTIALLY_FIXED (P5) | Health endpoint ready (`/functions/v1/health`, 200 / 503); provider choice, polling and a tested alert still needed |
| PRA-004 | HIGH | PARTIALLY_FIXED | CI workflow added; no git repository or remote yet |
| PRA-005 | HIGH | BLOCKED | Keys in staging |
| PRA-006 | HIGH | BLOCKED | Provider choice |
| PRA-007 | HIGH | BLOCKED | Approval to delete live test data; owner deletes the local password file |
| PRA-008 | HIGH | BLOCKED | Dashboard setting |
| PRA-009 | HIGH | FIXED_VERIFIED | All 12 functions declared; flags match live |
| PRA-010 | HIGH | PARTIALLY_FIXED (P3) | Estate OS designated staging (owner, 2026-10-26) and validated. A separate production project and a hosted UI are still needed |
| PRA-011 | HIGH | BLOCKED | Host choice |
| PRA-012 | MEDIUM | NOT_FIXED | Needs CLI linked to the project |
| PRA-013 | MEDIUM | FIXED_VERIFIED | vite 6.4.5, vitest 4.1.12; `npm audit` 0 |
| PRA-014 | MEDIUM | PARTIALLY_FIXED | zod 4.6.7, supabase-js 2.50.5 (frontend), Edge imports pinned; no `deno.lock`; Deno runtime unexercised |
| PRA-015 | MEDIUM | FIXED_VERIFIED | Matches the official Retell SDK (golden vector); a real webhook is still blocked by PRA-005 |
| PRA-016 | MEDIUM | BLOCKED | Business decision |
| PRA-017 | MEDIUM | PARTIALLY_FIXED | AI requests limited (PRA-030); no general API limit |
| PRA-018 | MEDIUM | NOT_FIXED | Needs staging |
| PRA-019 | MEDIUM | FIXED_VERIFIED | As-built note |
| PRA-020 | MEDIUM | BLOCKED | Legal input |
| PRA-021 | MEDIUM | FIXED_VERIFIED | ESLint clean (frontend); functions covered by `check:functions` |
| PRA-022 | MEDIUM | BLOCKED | Product decision |
| PRA-023 | MEDIUM | FIXED_VERIFIED | Live probe 6/6; drawer rendering not browser-checked |
| PRA-024 | LOW | NOT_FIXED | Needs traffic evidence |
| PRA-025 | LOW | NOT_FIXED | Helpers used by invoker triggers and policies; needs per-function analysis |
| PRA-026 | LOW | FIXED_VERIFIED (P3) | 0018 applied on staging; `anon` executes no public function |
| PRA-027 | INFO | NOT_FIXED | Depends on hosting |
| PRA-028 | INFO | NOT_FIXED | S4 |
| PRA-029 | HIGH | FIXED_VERIFIED (P3, guard) | Guard live on staging: viewer and agent refused, other agency NOT_FOUND. The function-to-guard path before the model runs only once a key exists (it returns `not_configured` first); verified by code and type-check |
| PRA-030 | HIGH | FIXED_VERIFIED (P3, guard) | Live: 10 accepted, the 11th RATE_LIMITED; requests recorded in `ai_requests`. Same caveat as PRA-029 for the function path |
| PRA-032 | HIGH | FIXED_VERIFIED (P4, new) | No per-workspace way to pause an agent. Migration 0019 adds a server-enforced, audited pause per agent and per workspace; 7 DB tests (mutation-checked) plus 11 live checks on staging |
| PRA-031 | LOW | PARTIALLY_FIXED (P5) | Shared `authorizeWorker` (503 + log when the check cannot run; 401 only for a wrong secret) in all 5 workers; unit-tested; deployed only to staging `qualification-worker` (35/35 cron calls 200 after deploy). The other 4 deploy with the next release |
| PRA-033 | HIGH | PARTIALLY_FIXED (P5) | No health endpoint or usage metering for monitoring and cost attribution. `ops_health` + `health` function (staging, live `ok`) and `ai_usage_summary` (migration 0020). External monitor and alerts still to configure (PRA-003) |

| ID | Title | Severity | Component | Evidence | Impact | Fix | Dependencies | Verification | Stage |
|---|---|---|---|---|---|---|---|---|---|
| PRA-001 | Agent 08 Claude functions not deployed | HIGH | Edge Functions `sales-intelligence-recommend`, `sales-analyst` | [RUNTIME] HTTP 404 on both. [STATIC] code and unit tests present | "Generate AI recommendations" and natural-language "Ask" fail in the UI | Deploy both with `verify_jwt = true` once PRA-009 is fixed | PRA-009; PRA-005 for meaningful output | `list_edge_functions` shows both. An authenticated call without a key returns a clean "not configured" error; with a key, returns a validated result | S1 |
| PRA-002 | No documented backups; project appears to be on the free plan | HIGH | Supabase project / operations | [STATIC] `docs/DATABASE_MIGRATIONS.md` ("free-plan slot"). [ENV] plan not confirmed | Data loss on an incident; the project can be paused when inactive; no PITR | Move production to a paid plan with PITR; document backup and restore; run one restore drill | Business approval for cost | Dashboard shows the PITR window; the restore drill is recorded | S2 |
| PRA-003 | No monitoring, error tracking or alerting | HIGH | Operations | [STATIC] no SDK or config. State only in tables | Failed agent runs, cron failures and webhook rejections go unnoticed | Add error tracking for the SPA and Edge Functions; schedule alerts on `agent_runs.status = failed`, `cron.job_run_details` failures, outbox backlog age and `webhook_events` rejections | none | Induce one failure in staging; an alert arrives | S2 |
| PRA-004 | No version control and no CI | HIGH | Repository | [STATIC] not a git repository; no CI files | Source can be lost; no review, no reproducible builds; `.gitignore` is not enforced | `git init`; confirm `.env.local` and `test-login.local.md` are ignored before the first commit; push to a private remote; CI runs `npm ci`, typecheck, test, build and lint (PRA-021) | none | CI is green on the main branch; `git status` shows no secrets tracked | S1 |
| PRA-005 | Anthropic and Retell keys not configured; AI steps unverified | HIGH | Edge Function secrets, all agents' Claude steps, Agent 02 | [RUNTIME] `voice-calls/status`: `retell_configured: false`, `analysis_configured: false` | All 9 Claude call sites and voice calling have never run end to end. Quality, cost and latency are unknown | Set the secrets in **staging** first; run each AI step on test data; record outcomes; set per-org usage caps | PRA-010 | Each Claude step produces a validated result and an `agent_runs` row in staging; one real test call completes with its webhook received | S1 |
| PRA-006 | No messaging or calendar provider integrated | HIGH | Agent 05 dispatch, Agent 06 calendar sync, invitations | [STATIC] no adapter. [RUNTIME] 0 provider sends; only a `lead_source` integration connected | Follow-ups are manual only; calendar sync is unsupported; invites are links only | Choose providers (for example email/SMS/WhatsApp, Google/Microsoft calendar); implement adapters behind the existing dispatch and sync boundaries; **or** scope the pilot to manual operation and say so in the UI | Business decision | A provider send in staging moves `follow_ups` to `sent`, with delivery status recorded | S2 |
| PRA-007 | Test residue in the production project and a plaintext test password on disk | HIGH | Live auth users and orgs; `frontend/test-login.local.md` | [RUNTIME] 2 orgs and 3 users, all test. [STATIC] file present (value not reproduced) | Known credentials for a live account; test data mixed with production | Before the pilot: delete the local file, remove the test users and workspaces (or recreate production fresh), and keep test accounts in staging only | PRA-010 | The file is absent; `auth.users` contains only real staff | S2 |
| PRA-008 | Leaked-password protection disabled | HIGH | Supabase Auth | [RUNTIME] security advisor | Users can choose known-breached passwords | Enable it in Auth settings; consider MFA for owners and admins | none | The advisor warning disappears | S2 |
| PRA-009 | `config.toml` declares only 4 of 12 functions | HIGH | `supabase/config.toml` | [STATIC] only `lead-intake`, `voice-webhook`, `voice-worker`, `voice-calls` | A CLI redeploy sets `verify_jwt = true` on `qualification-worker`, `property-matching-worker`, `follow-up-worker` and `calendar-sync-worker`, so pg_net calls get 401 and Agents 03–06 stop | Add `[functions.<name>]` for all 13: `verify_jwt = false` for the four workers (they check the Vault secret); `true` for `appointment-assistant`, `crm-enrichment`, `sales-*` | none | `supabase functions deploy` in staging; the cron-triggered workers still return 200 | S1 |
| PRA-010 | No staging environment | HIGH | Environments | [STATIC, RUNTIME] one active project, used for all live verification | Changes are first exercised on what becomes production | Create a staging project; apply the migrations through the CLI; mirror the Vault and secrets set-up with staging values | PRA-004, PRA-012 | Staging passes the live smoke checks from the agent docs | S1 |
| PRA-011 | No frontend hosting or deployment configuration | HIGH | `frontend/` | [STATIC] no host configuration; only the dev server has been used | The app cannot be delivered to users; there is no CSP or security headers | Choose a static host; add the build and deploy to CI; set security headers (CSP restricted to the Supabase origin) | PRA-004 | The staging URL loads, logs in and passes the smoke flow; the headers are present | S2 |
| PRA-012 | Live migration history versions differ from the files | MEDIUM | Supabase migration history | [RUNTIME] `list_migrations`. [STATIC] repair commands in `docs/DATABASE_MIGRATIONS.md` | `supabase db push` refuses to run or re-runs migrations | Run the two documented `supabase migration repair` commands once, then use the CLI only | none | `supabase migration list` matches; `db push` reports nothing to apply | S1 |
| PRA-013 | Dev-dependency vulnerabilities (vitest/tinypool critical, vite high, esbuild moderate) | MEDIUM | `frontend` devDependencies | [TEST] `npm audit` | Remote code execution or file read on a developer machine while the dev or Vitest server runs and a malicious site is visited. No production exposure | Upgrade vitest (and @vitest/*) and vite to patched versions; rerun the suite | none | `npm audit` is clean for these packages; 236 tests still pass | S1 |
| PRA-014 | Runtime dependency advisories and unpinned Deno imports | MEDIUM | `frontend` dependencies (zod high, supabase-js/auth-js low); `supabase/functions` | [TEST] `npm audit --omit=dev`: 3 (1 high, 2 low). [STATIC] `jsr:@supabase/supabase-js@2` floating; no `deno.lock` | Client memory exhaustion on oversized input (frontend zod); non-reproducible function builds | Upgrade zod and supabase-js in the frontend; check whether Edge `zod@3.24.1` is affected; pin supabase-js and commit a `deno.lock` | none | `npm audit --omit=dev` is clean; function deploys are reproducible | S2 |
| PRA-015 | Retell webhook signature scheme unverified | MEDIUM | `_shared/retell.ts`, `voice-webhook` | [STATIC] `v=<ms>,d=<hex>` HMAC implemented from documentation; no provider test | Fails closed: if the format is wrong, every call webhook is rejected and Agent 02 never records outcomes | Compare with Retell's official SDK verification; add a fixture test from a real signed payload | PRA-005 | A real staging call's webhook is accepted; a tampered one is rejected | S2 |
| PRA-016 | Open self-service signup | MEDIUM | Supabase Auth (`enable_signup = true`) | [STATIC] `config.toml` | Anyone can create accounts and workspaces (rate-limited per RPC); spam or cost exposure once AI keys are set | Decide: invite-only for the pilot (disable signup) or keep it with CAPTCHA and per-org AI quotas | Business decision; PRA-005 quotas | Signup behaves per the decision in staging | S2 |
| PRA-017 | No general API rate limiting | MEDIUM | PostgREST / Edge Functions | [STATIC] limits only in specific RPCs | Authenticated users can drive load or AI cost with repeated calls | Add per-user and per-org quotas on the AI-calling functions; rely on platform limits elsewhere and monitor them | PRA-003 | Burst test in staging gets 429s at the configured thresholds | S2 |
| PRA-018 | No frontend, component or e2e tests | MEDIUM | `frontend/tests` | [STATIC] DB and Node tests only | UI regressions are caught only manually | Add Playwright smoke flows (login, create lead, book appointment, follow-up approval, reports) against staging; add a few component tests | PRA-010 | The e2e suite runs in CI | S2 |
| PRA-019 | Architecture docs out of date | MEDIUM | `SYSTEM_ARCHITECTURE.md`, PRD | [STATIC] they describe Next.js, Tailwind/shadcn, n8n, a neutral LLM adapter | Misleads reviewers and new engineers; the PRD contradicts the workflow doc on n8n | Update the docs to the as-built design (this audit's §4) and mark superseded decisions | none | Docs review | S3 |
| PRA-020 | Data protection gaps (retention, erasure, call-recording consent, privacy notice) | MEDIUM | Product / compliance | [STATIC] no such tooling or text | Legal risk once real contacts are processed and calls are recorded | Legal review; retention jobs; erasure RPC; consent wording in voice scripts; privacy notice | Legal input | Checklist sign-off | S2 |
| PRA-021 | No lint configuration | MEDIUM | `frontend` | [STATIC] no ESLint/Prettier configuration | Hook-rule and unused-code issues go undetected | Add ESLint (typescript-eslint, react-hooks) and run it in CI | PRA-004 | Lint is clean in CI | S1 |
| PRA-022 | Inbox, Workflows, Approvals and Logs not connected in LIVE | MEDIUM | `App.tsx` `NOT_CONNECTED` | [STATIC] | Those modules are unavailable to production users; approvals happen per agent page instead | Either implement them on the existing tables (`review_items`, `agent_runs`, `audit_logs`) or hide them from the LIVE nav | Product decision | LIVE nav shows only working modules | S2 |
| PRA-023 | Property drawer uses client-side matching in LIVE | MEDIUM | `features/properties.tsx` (around lines 186–199), `lib/domain.ts` | [STATIC] | "Leads this fits" can disagree with Agent 04's server-side recommendations | Read `property_matches` for the property instead of `matchProperties` in LIVE | none | The drawer's list equals the server matches for a fixture | S2 |
| PRA-024 | Unindexed foreign keys (96) and unused indexes (18) | LOW | Database | [RUNTIME] performance advisor (INFO) | Slower deletes and joins at scale | Index the FKs used in filters and joins; leave pure audit columns; revisit unused indexes after real traffic | Real traffic | Advisor count reduced; query plans checked | S4 |
| PRA-025 | 12 `private` helpers executable by `authenticated` | LOW | Database grants | [RUNTIME] | Not reachable via PostgREST (schema not exposed); only a defence-in-depth gap | Revoke EXECUTE from `authenticated` where the helper is only used inside definer functions | Test suite | Grants query; tests pass | S4 |
| PRA-026 | `anon` can execute the `set_updated_at` trigger function | LOW | Database grants | [RUNTIME] | No practical effect (a trigger function) | Revoke EXECUTE from `anon` and `public` | none | Grants query | S4 |
| PRA-027 | CORS `*` on JWT-authenticated functions | INFO | Edge Functions | [STATIC] | A JWT is still required; low risk | Restrict to the app origin once hosting exists | PRA-011 | Response headers | S3 |
| PRA-029 | User-triggered Claude calls ran before the feature-permission check (found in Phase 2) | HIGH | `sales-analyst`, `appointment-assistant`, `crm-enrichment` | [STATIC] the permission was enforced only by the RPC called after the model | Any active member able to read the org or lead (for example a viewer) could trigger paid model calls | `ai_request_begin` before the model, failing closed | Migration 0018 | PGlite tests; staging calls as a viewer → 403 | S1 |
| PRA-031 | Workers report a failed secret check as 401, without logging (found in Phase 3) | LOW | 5 worker functions | [RUNTIME] `net._http_response` 401 at 18:31:01 UTC, `property-matching-worker`, pg_net user agent; no DB error at that time | A transient failure looks like an auth failure and is invisible in function logs; one minute of processing skipped (recovered) | Distinguish an RPC error (503 + structured log) from a mismatch (401) | none | Unit-test the handler branch; staging logs show 503 + reason on a forced failure | S3 |
| PRA-030 | No limit or record of user-triggered Claude calls (found in Phase 2) | HIGH | The 4 user-triggered AI functions | [STATIC] | Unbounded AI cost from repeated clicks or scripts | Per-user hourly and per-org daily limits; `ai_requests` | Migration 0018 | PGlite tests; staging 429 | S1 |
| PRA-028 | `appointment.*`, `crm.*` and `sales.*` events have no consumers | INFO | Outbox | [STATIC] | None today; events accumulate as published-without-delivery | Add a retention/archival job for published events; wire consumers when needed | none | Outbox size stays bounded | S4 |

## Top 5 by priority
1. **PRA-004 + PRA-010:** git, CI and a staging project. Everything else needs them.
2. **PRA-009 → PRA-001:** declare every function in `config.toml`, then deploy the two Agent 08 functions.
3. **PRA-005 + PRA-015:** configure Anthropic and Retell in staging and verify each AI step and one real call.
4. **PRA-002 + PRA-003:** backups or PITR, and alerting on failed runs and cron jobs.
5. **PRA-007 + PRA-008 + PRA-013:** remove the test residue and the password file, enable leaked-password protection, and patch the vulnerable dependencies.
