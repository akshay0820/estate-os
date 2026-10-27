# Phase 2 Remediation Report — Estate OS

Date: 2026-10-26. Plan: `PHASE_2_REMEDIATION_PLAN.md`.

**Scope of this phase:**
- Changes were made to code, config and docs in the workspace only.
- **Nothing was deployed and no migration was applied to the hosted project. Nothing was committed** (the workspace is not a git repository).
- No provider was called and no live record was changed.
- The live project was used read-only: an edge-function list, a cron list, and one probe that signs in as the test accounts and reads data.

## Commands executed and results

All commands were run in `frontend/` unless noted.

**Baseline (before any change):**

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | 21 files, 236/236 pass |
| `npm run build` | pass (main JS 485.9 kB) |
| `npm audit` | 8 vulnerabilities (2 critical, 2 high, 2 moderate, 2 low) |

**Final:**

| Command | Result |
|---|---|
| `npm run lint` (new: ESLint 9 + typescript-eslint + react-hooks) | **pass, 0 problems** |
| `npm run typecheck` | **pass** |
| `npm run check:functions` (new: `tsc` over all 12 Edge Functions and `_shared`, with the pinned SDK types and a Deno shim) | **pass** |
| `npm test` | **24 files, 259/259 pass** (+23 tests) |
| `npm run build` | **pass**, main JS 494.5 kB (147.6 → 150.5 kB gzip) |
| `npm audit` / `npm audit --omit=dev` | **0 vulnerabilities** / **0 vulnerabilities** |

**Mutation check:** I temporarily removed the permission check, the membership check and the `set_updated_at` revoke from migration 0018 and ran `npx vitest run tests/db/ai-guard.test.ts tests/db/security-invariants.test.ts`. **4 tests failed**, as they should. With the migration restored, 14/14 pass.

**Retell cross-check:**
- `retell-sdk@6.2.12` was installed in the scratchpad only, and its `lib/webhook_auth` was read.
- `symmetric.sign` and our `retellSignature` produce the identical signature for a fixed vector.
- `symmetric.verify` accepts the signature our code produces (`true`).

**Live read-only probe** (`scratchpad/phase2_drawer_probe.mjs`, signed in as the two e2e test accounts): **6/6 pass**. Every lead the new property-drawer query returns agrees with that lead's own `lead_property_matches`, with the same score. The other workspace reads none of them.

**Edge Functions on the live project:** 10 deployed, and the `verify_jwt` flags match the new `config.toml` entries. `sales-analyst` and `sales-intelligence-recommend` are still not deployed.

## Results per finding

| ID | Sev. | Root cause | Change | Tests added | Final status |
|---|---|---|---|---|---|
| PRA-029 | HIGH (new) | `sales-analyst`, `appointment-assistant` and `crm-enrichment` called Claude before any feature-permission check; only the RPC run *after* the model checked it | New `public.ai_request_begin` (membership via `is_org_member`, never trusting the client's org id; feature permission; manager rule for recommendations). New `_shared/ai-guard.ts`, which **fails closed** (503 `guard_unavailable`) if the guard cannot run. All 4 user-triggered AI functions call it **before** the model | `tests/db/ai-guard.test.ts` (9), `tests/ai-guard.test.ts` (8) | **FIXED_UNVERIFIED** in deployment: proven in PGlite and type-checked, but migration 0018 and the new function code are not on the hosted project |
| PRA-030 / PRA-017 (AI part) | HIGH | No limit on user-triggered model calls; no record of them | Per-user hourly limits per feature (60 / 30 / 10 / 60), per-org daily limit of 1000, counted under a per-org advisory lock (no race). Failed calls count. `ai_requests` records feature, outcome, duration and model; readable with `usage.view`; no client writes. UI shows "Too many AI requests…" | Included above (limit, window, other feature / user / org unaffected, finish once and own-only) | **FIXED_UNVERIFIED** in deployment (as above). The general API rate limit (non-AI) remains **NOT_FIXED** |
| PRA-009 | HIGH | `config.toml` stopped at Agent 02 | 9 function sections added. Workers `verify_jwt = false`; user functions `true`. Matches the live flags | Static comparison with live `list_edge_functions` | **FIXED_VERIFIED** (config). A real CLI deploy in staging is still advisable |
| PRA-013 | MEDIUM | Old dev tooling | vite 5.4.11 → 6.4.5, vitest 2.1.8 → 4.1.12, @vitejs/plugin-react 4.3.4 → 4.7.0 | Whole suite unchanged and green | **FIXED_VERIFIED** |
| PRA-014 | MEDIUM | zod < 4.6.6; supabase-js ≤ 2.49.10; floating Deno import | zod 3.24.1 → 4.6.7 (frontend tests and `deno.json`); frontend supabase-js 2.49.4 → **2.50.5** (smallest release outside the advisory range; 2.118 added about 113 kB to the bundle); Edge imports pinned from `@2` to `@2.118.0` in all 13 files | Validator suites (all zod schemas) unchanged and green; `check:functions` | **PARTIALLY_FIXED**: no `deno.lock` (no Deno toolchain here); the Deno runtime with zod 4 is not executed until a staging deploy |
| PRA-021 | MEDIUM | No linter | `eslint.config.js`, `npm run lint`. 3 findings fixed (below) | n/a | **FIXED_VERIFIED** for `frontend/`. `supabase/functions` is covered by `check:functions`, not lint (`deno lint` needs Deno) |
| PRA-015 | MEDIUM | Signature format written from docs | No code change needed: matches Retell's SDK exactly. Golden vector from the SDK added | `tests/voice.test.ts` (+1) | **FIXED_VERIFIED** for algorithm conformance. A real Retell webhook is still **BLOCKED** (no key) |
| PRA-023 | MEDIUM | Drawer reused the demo matcher in LIVE | `live.propertyCurrentMatches` (current runs, not rejected or invalidated, RLS-scoped); drawer uses it in LIVE with loading, error and empty states; demo unchanged | Live probe 6/6 | **FIXED_VERIFIED** for data agreement and isolation. Drawer rendering checked by typecheck and build, not in the browser |
| PRA-026 | LOW | Default grants | EXECUTE on `set_updated_at` revoked from public, anon and authenticated (trigger-only) | `security-invariants.test.ts` (anon executes no public function); full suite proves triggers still fire | **FIXED_UNVERIFIED** in deployment (migration not applied) |
| PRA-004 (part) | HIGH | No CI | `.github/workflows/ci.yml`: lint, typecheck, `check:functions`, tests, build, runtime audit; no secrets | n/a | **PARTIALLY_FIXED**: the workflow cannot run until a git repository and remote exist |
| PRA-019 | MEDIUM | Blueprint predates build | As-built note at the top of `SYSTEM_ARCHITECTURE.md` | n/a | **FIXED_VERIFIED** (doc) |
| P0 regression gap | n/a | Isolation tests named tables explicitly | `tests/db/security-invariants.test.ts`: RLS on every public table, pinned `search_path` on every definer function, no anon table or function privileges, a cross-tenant sweep of every table with `organization_id` (≥ 6 with B data), and indirect RPCs keyed by B ids → NOT_FOUND / FORBIDDEN | 5 tests | **FIXED_VERIFIED** (tests) |

**Lint fixes:**
- `features/leads.tsx`: a ternary used as a statement, now `if`/`else`; same behaviour.
- `tests/db/follow-up-agent.test.ts`: a `… || true && …` filter that was always equivalent to the name check, simplified to that check; the assertion is unchanged.
- `tests/db/sales-intelligence-agent.test.ts`: an unused variable.

## Not fixed or blocked (unchanged from Phase 1)

| ID | Status | Needed |
|---|---|---|
| PRA-001 Agent 08 functions not deployed | **BLOCKED** | Approval to deploy and a working deploy path. Order: apply 0018 first, then deploy all four AI functions |
| PRA-002 backups / plan | **BLOCKED** | Billing decision, PITR, restore drill |
| PRA-003 monitoring | **BLOCKED** | Choice of provider. `ai_requests` adds AI request visibility, but there is no alerting |
| PRA-004 git | **BLOCKED** | Owner creates the repository (check that `.gitignore` excludes `.env.local` and `*.local.md` before the first commit) |
| PRA-005 AI and voice keys | **BLOCKED** | Anthropic and Retell keys in staging |
| PRA-006 providers | **BLOCKED** | Product choice |
| PRA-007 test residue | **BLOCKED** | Approval to delete live test users and orgs; owner deletes `frontend/test-login.local.md` |
| PRA-008 leaked-password protection | **BLOCKED** | Dashboard setting |
| PRA-010 staging | **BLOCKED** | New project |
| PRA-011 hosting | **BLOCKED** | Choice of host |
| PRA-012 migration history | **NOT_FIXED** | CLI linked to the project (writes migration history) |
| PRA-016, PRA-020, PRA-022 | **BLOCKED** | Business, legal and product decisions |
| PRA-017 general API rate limit | **NOT_FIXED** | Platform-level control; AI part fixed (PRA-030) |
| PRA-018 e2e tests | **NOT_FIXED** | Needs staging (PRA-010) and test accounts there. No E2E framework exists to extend |
| PRA-024, PRA-025, PRA-027, PRA-028 | **NOT_FIXED** | Low / info; reasons in the plan |

## Behaviour changes to know about

- **AI functions now refuse when the guard is missing.** The redeployed `appointment-assistant`, `crm-enrichment`, `sales-intelligence-recommend` and `sales-analyst` return 503 `guard_unavailable` until migration 0018 exists. **Apply 0018 before deploying them.** The currently deployed `appointment-assistant` and `crm-enrichment` are the old code and are unaffected until they are redeployed.
- **New refusals:**
  - Viewers and finance users now get 403 from `crm-enrichment` and `appointment-assistant` before any model call.
  - Anyone over a limit gets 429 `rate_limited`.
- **`appointment-assistant` is not called by the frontend** (no caller in `src/`), so its guard has no UI path today.
- **Two supabase-js versions:** the frontend uses 2.50.5; the Edge Functions use 2.118.0, which the `supabase-js-edge` devDependency alias exists only to type-check against. Keep the versions in `deno.json`, the Edge import pins and these devDependencies in step.

## Changed files

| File | Why |
|---|---|
| `supabase/migrations/20261025001800_ai_request_guard.sql` (new) | PRA-029 / PRA-030 / PRA-026 |
| `supabase/functions/_shared/ai-guard.ts` (new) | Shared guard, fails closed |
| `supabase/functions/{sales-analyst,sales-intelligence-recommend,crm-enrichment,appointment-assistant}/index.ts` | Guard before the model; outcome recorded on every path |
| `supabase/functions/**/*.ts` (13 files) | supabase-js import pinned to 2.118.0 |
| `supabase/functions/deno.json` | zod 4.6.7 |
| `supabase/config.toml` | PRA-009 |
| `frontend/package.json`, `package-lock.json` | Upgrades; lint and `check:functions` scripts; dev-only `@anthropic-ai/sdk` and `supabase-js-edge` for type-checking functions |
| `frontend/eslint.config.js`, `tsconfig.functions.json`, `types/deno-shims.d.ts` (new) | Lint and function type-check |
| `frontend/src/backend/live.ts`, `src/features/properties.tsx` | PRA-023 |
| `frontend/src/features/{dataQuality,salesIntelligence}.tsx` | Messages for `rate_limited`, `refused`, `guard_unavailable` |
| `frontend/src/features/leads.tsx`, two test files | Lint findings |
| `frontend/tests/db/{ai-guard,security-invariants}.test.ts`, `tests/ai-guard.test.ts` (new); `tests/voice.test.ts` | Regression tests |
| `.github/workflows/ci.yml` (new) | CI |
| `SYSTEM_ARCHITECTURE.md`, `docs/DATABASE_MIGRATIONS.md` | As-built note; migration 0018 and deploy order |
| `docs/production/*` | Plan, this report, updated backlog, matrix and audit |

## Manual verification still required

1. In staging:
   - Apply migration 0018.
   - Deploy all 12 functions with the CLI (`config.toml` now complete).
   - Confirm the four workers still return 200 from cron.
2. Call each AI function as:
   - a viewer, expecting 403;
   - a permitted user without a key, expecting 503 `not_configured`;
   - a permitted user with a key, expecting a result and one `ai_requests` row with an outcome;
   - a permitted user over the limit, expecting 429.
3. Run a real Retell test call; confirm the webhook is accepted and a tampered one is rejected.
4. Open a property drawer in the LIVE app and confirm the panel shows the server matches.
