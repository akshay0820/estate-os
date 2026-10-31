# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Estate OS (BlazeReach) is a multi-tenant real-estate CRM with eight AI agents. Product and design sources live at the
root: `real_estate_ai_os_prd.md`, `SYSTEM_ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`,
`REAL_ESTATE_AI_OS_AGENT_WORKFLOW.md`. Per-agent design docs are in `docs/agents/`. Operations, launch and runbooks are
in `docs/production/`. The legal drafts in `docs/legal/` are for attorney review only and must not be published.

## Commands

All npm commands run from `frontend/`. Node 20+ is required.

```bash
npm run dev                # http://localhost:5180 (live mode if frontend/.env.local has Supabase vars, else demo)
npm test                   # all tests: unit tests + database tests on PGlite
npm run test:db            # database tests only
npx vitest run tests/db/review-fixes.test.ts -t "batch lead import"   # one file / one test
npm run lint
npm run typecheck          # frontend
npm run check:functions    # type-checks supabase/functions/** (Deno code) via tsconfig.functions.json
npm run build              # tsc + vite build into dist/
npm run predeploy          # release guard: migration names and order, no destructive SQL, supabase-js pin, no secrets in the bundle, CSP rules
npm run schema:fingerprint # md5 of every DB function; `-- --compare remote.json` reports drift against a project
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, check:functions, test, build, predeploy and an audit on every push.
`.github/workflows/uptime.yml` is an external uptime monitor; see `docs/production/UPTIME_MONITORING.md`.

## Architecture

**Three parts:**
- `frontend/`: Vite + React 18 + TypeScript, with a zustand store.
- `supabase/migrations/`: Postgres. Nearly all business logic lives here.
- `supabase/functions/`: 14 Deno Edge Functions, with shared code in `_shared/`.

**The database is the backend.**
- Every table is protected by row-level security on organization membership. The browser calls PostgREST with the
  user's JWT and the publishable key.
- Multi-step operations are `public.*` SECURITY DEFINER or INVOKER RPCs, for example `create_lead`, `import_leads`
  and `merge_leads`. They check permissions with `public.has_perm(org, 'perm')` and raise errors with
  `private.fail('CODE', 'message')`. The frontend maps these codes in `src/backend/errors.ts`.
- Internal helpers live in the `private` schema.
- Triggers write audit rows, status history, activities and notifications. Don't duplicate that in application code.

**Migrations are additive and versioned:** `YYYYMMDDHHMMSS_name.sql`.
- To change a function, add a new migration that `create or replace`s it. Copy the **latest** definition: grep
  `create or replace function <name>` across `supabase/migrations/`; the highest-numbered file wins.
- `predeploy` rejects drops, truncates and unfiltered deletes.
- Add every new migration to the table in `docs/DATABASE_MIGRATIONS.md`.

**Agents run on an outbox pattern.**
1. Domain events land in outbox and run tables.
2. `pg_cron` calls the worker functions (`*-worker`) every minute through `pg_net`, sending a per-worker shared secret
   from Vault. Workers verify it with `_shared/worker-auth.ts`.
3. A worker claims a batch with an RPC, calls Claude, validates the JSON output against the source data (validators in
   `_shared/*.ts`), and writes the result back with an RPC.

Deterministic logic always runs. The Claude step is optional: without `ANTHROPIC_API_KEY` it records `not_configured`,
and nothing blocks waiting for it. User-triggered AI functions go through `_shared/ai-guard.ts`, which checks
permissions, applies rate limits and records the request before the model is called.

Outbound messages and calls always need human approval.

**Workspace assistant (Estate AI).** `layout/Assistant.tsx` is the chat panel (Ctrl/⌘ J). Live mode calls the
`assistant` Edge Function: Claude answers with read tools that call the `assistant_*` SECURITY INVOKER RPCs as the user,
and write tools only *propose* changes (`_shared/assistant.ts` validates them). The app shows each proposal as a card
and runs it through `data/actions.ts` when the user confirms (`lib/assistant.ts`). Demo mode answers from sample data
with rules in `lib/assistantDemo.ts`. Keep the tool list, the proposal kinds and both clients in step.

**Automations (Agent schedules).** `features/automations.tsx` manages `agent_automations` (migration 0029); pg_cron runs
`automations_tick()` every 5 minutes. Automations prepare work only (briefing notifications, follow-up tasks, Follow-Up
Agent drafts, `agent_call_queue` rows). A queued AI call is placed only when a person approves it: the app calls
`voice-calls/call` (full call policy) and then records it with `call_queue_decide`. Demo mode mirrors this in
`lib/automationsDemo.ts`; schedule and settings rules shared with tests live in `lib/automationRules.ts`.

Edge Functions:
- Import `jsr:@supabase/supabase-js@2.118.0` exactly; predeploy enforces the pin.
- Take model names from `*_MODEL` env vars, defaulting to `claude-opus-5-5`.
- Webhook functions set `verify_jwt = false` in `supabase/config.toml` and authenticate with an HMAC signature
  (`lead-intake`) or a Retell signature (`voice-webhook`).

**Frontend data flow.** Pages call `src/data/actions.ts`, which branches once on `LIVE`:
- live mode goes to `src/backend/live.ts` (Supabase), with row mapping in `src/backend/mappers.ts`;
- demo mode goes to the in-browser sample store, `src/store/store.ts`, and never leaves the browser.

Pages never branch on the mode for writes. Pages are lazy-loaded in `src/App.tsx` and keyed by page plus workspace
region. Duplicate detection and other domain rules have client mirrors in `src/lib/domain.ts`. Keep them consistent
with the SQL versions.

**Workspace region.** `organizations.default_currency` (default USD) and `country_code` (default US) drive:
- money formatting: `src/lib/format.ts`, `money`;
- phone normalization: `src/lib/util.ts`, `normalizePhone`, mirroring `private.normalize_phone(raw, country)`.

Both helpers hold module-level state, set by `src/store/regionSync.ts` and subscribed in `src/store/region.ts`.

## Testing

Database tests (`frontend/tests/db/`) apply every migration to PGlite, with `supabase-shim.sql` standing in for
`auth.uid()`, roles, vault and storage. They exercise RLS by switching to the `authenticated` role.
- Use `createDb()` and its helpers from `harness.ts`: `t.user`, `t.org`, `t.member`, `t.lead`, `t.as(user, sql)` and
  `t.fails(...)`.
- **The harness defaults workspaces to India (`IN`, INR, Asia/Kolkata), unlike production.** Pass
  `createDb({ region: 'US' })` to test US defaults.
- PGlite is a single connection, so true concurrency (locks, deadlocks) can't be tested there.

Unit tests in `frontend/tests/*.test.ts` import `supabase/functions/_shared/*` and `src/*` directly. Importing the
zustand store needs a DOM, so test pure helpers from modules that don't import `src/store/store.ts`.

## Deployment and environments

- **Frontend:** Vercel project `estate-os`, root `frontend/`, auto-deploys from `main` (production alias
  `estate-os-smoky.vercel.app`). Security headers and the Content-Security-Policy are in `frontend/vercel.json`.
  - `script-src 'self'`: **no inline scripts.** Put pre-paint code in `frontend/public/`, like `theme.js`.
  - `connect-src` must allow the Supabase URL; predeploy checks this.
- **Supabase:** staging is project `jvdnapofyoarhfctbpyi`, and `frontend/.env.local` points at it. There is no
  production project yet. Deployment steps are in `docs/production/PRODUCTION_DEPLOYMENT_RUNBOOK.md`.
- `frontend/test-login.local.md` holds staging test credentials. It is git-ignored; never print its contents.
- The working copy is on Windows (CRLF). `schema:fingerprint` normalizes line endings.
