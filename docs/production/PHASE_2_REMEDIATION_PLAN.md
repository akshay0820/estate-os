# Phase 2 Remediation Plan — Estate OS

Date: 2026-10-26. Input: the four Phase 1 reports in this folder, re-checked against the code before this plan was written.

## Baseline (Stage A)

- **Git:** the workspace is **not a git repository** (`git status` → "not a git repository"). There is no history, so no user changes can be identified or protected by git. Every change in this phase is therefore listed file by file in `PHASE_2_REMEDIATION_REPORT.md`.
- **Baseline checks** (`frontend/`):
  - `npm run typecheck`: pass.
  - `npm test`: 21 files, 236/236 pass.
  - `npm run build`: pass.
  - No lint tool is configured.
  - `npm audit`: 8 vulnerabilities (2 critical, 2 high, 2 moderate, 2 low); `--omit=dev`: 3 (1 high, 2 low).
- **No Deno toolchain** on this machine. Edge Function entry points (`supabase/functions/*/index.ts`) cannot be type-checked or run locally. Their `_shared/` logic is covered by the vitest suite.
- **Constraints for this phase:**
  - no deploys to, or migrations on, the live project (it is the only project, so it is effectively production);
  - no commits;
  - no provider calls;
  - no changes to live records.

## New findings from the re-check

| ID | Finding | Evidence | Severity |
|---|---|---|---|
| PRA-029 | `sales-analyst`, `appointment-assistant` and `crm-enrichment` call Claude **before** checking the caller's feature permission. The check happens only in the RPC that runs afterwards. Any active member who can read the org or lead (for example a viewer) can trigger paid model calls | [STATIC] `sales-analyst/index.ts` (permission enforced only by `si_query` after the model call); `appointment-assistant/index.ts` (only a row read before the call); `crm-enrichment/index.ts` (`leads.edit` checked only in `dq_propose_enrichment`) | HIGH |
| PRA-030 | No per-user or per-org limit on user-triggered Claude calls (the 4 functions above plus `sales-intelligence-recommend`). Repeated clicks or a script can run up unbounded cost. There is also no record of AI requests for cost visibility | [STATIC] none of the four functions counts calls; the existing RPC limits cover only agent-run requests | HIGH (folds into PRA-017) |

The Phase 1 findings were re-checked; the evidence still holds for all of them. PRA-009 was re-confirmed by reading `supabase/config.toml` (4 function sections).

## Plan in dependency order

| Order | Finding | Root cause | Fix | Migration / config? | Verification | Risk if done wrong |
|---|---|---|---|---|---|---|
| 1 | PRA-009 (HIGH) | `config.toml` was never extended past Agent 02 | Add `[functions.*]` for all 12 functions: `verify_jwt = false` for the 4 pg_net workers, `true` for the 5 user functions | Config | Static diff against the live `verify_jwt` flags (read-only `list_edge_functions`) | Wrong flag → workers get 401, or user functions become reachable without a JWT. Checked against live |
| 2 | PRA-029 + PRA-030 (HIGH) | Permission check placed after the model call; no quota | New migration `20261025001800_ai_request_guard.sql`: table `ai_requests` (RLS, read-only to `usage.view`), RPC `ai_request_begin(org, feature)` (permission per feature, per-user hourly and per-org daily limits under an advisory lock, returns a request id), `ai_request_finish(id, status, ms)`. Shared helper `_shared/ai-guard.ts`; call it in all 4 user-triggered AI functions **before** Claude | Additive migration (not applied live) | New PGlite tests: permission per feature, cross-tenant refusal, quota → `RATE_LIMITED`, finish only own request, no client writes. Unit tests for the helper's error mapping | Too-strict limits block legitimate use. Constants are documented and conservative |
| 3 | PRA-026 (LOW) | Supabase default grants | Same migration: revoke EXECUTE on `public.set_updated_at` from `anon` (trigger functions are not permission-checked when they fire) | Migration | Grant test in PGlite; full suite still passes | none |
| 4 | P0 regression gap | Isolation tests cover named tables only | Catalog-driven tests: every public table has RLS; every public SECURITY DEFINER function has a fixed `search_path`; `anon` has no table privileges; a sweep of every table with `organization_id` shows tenant A reads 0 rows of tenant B | none | New tests pass, and fail if an invariant is broken | none |
| 5 | PRA-013 (MEDIUM) | Outdated dev tooling | Targeted upgrade: `vite` 6.4.x, `vitest` 4.1.12+, `@vitejs/plugin-react` 4.7.x | `package.json` / lockfile | `npm audit`; full suite, typecheck and build | Test runner behaviour change. Reverted if the suite does not pass unchanged |
| 6 | PRA-014 (MEDIUM) | zod < 4.6.6 (GHSA-mrhx-c7xc-m3w5); supabase-js ≤ 2.49.10; floating Deno import | Upgrade `zod` to 4.x in both the frontend (used only by the tests of `_shared`) and `supabase/functions/deno.json`; upgrade `@supabase/supabase-js`; pin `jsr:@supabase/supabase-js` to an exact version via `deno.json` | Lockfile / `deno.json` | Validator tests (zod-heavy) pass unchanged; `npm audit --omit=dev` clean | zod 4 API differences. The validators' tests cover all schemas. Deno side not runnable here → staging check |
| 7 | PRA-021 (MEDIUM) | No lint | ESLint flat config (typescript-eslint, react-hooks); fix real findings | devDependencies | `npm run lint` clean | Rule churn. Correctness rules only |
| 8 | PRA-015 (MEDIUM) | Signature format implemented from docs | Compare `_shared/retell.ts` with Retell's official SDK verification code; add a fixture test (valid, tampered, stale, malformed) | none | Unit test. A real webhook remains BLOCKED (no Retell key) | A wrong change would reject all webhooks. Kept identical unless a difference is proven |
| 9 | PRA-023 (MEDIUM) | Drawer reused the demo-mode matcher | In LIVE, read `property_matches` for the property (server-ranked, RLS-scoped); keep `matchProperties` for demo | none | Typecheck and build; browser check against live test data (read-only) | Wrong query → empty panel. Empty state shown honestly |
| 10 | PRA-004 (part), PRA-019 | No CI file; docs out of date | Add `.github/workflows/ci.yml` (`npm ci`, lint, typecheck, test, build, audit of runtime deps); as-built note in `SYSTEM_ARCHITECTURE.md` | CI file | Cannot run without a remote → FIXED_UNVERIFIED | none |

## Blocked: needs a human decision, credentials or access

| Finding | What is needed |
|---|---|
| PRA-001 deploy of Agent 08 functions | Approval to deploy to the live project (or a staging project), plus a working deploy tool or the Supabase CLI |
| PRA-002 backups / plan | Billing decision (paid plan with PITR) and a restore drill |
| PRA-003 monitoring | Choice of error-tracking and alerting provider and its credentials. Failed-run visibility is partly covered by `ai_requests` and the existing tables |
| PRA-004 git / CI | Owner creates the repository and remote (no commits are made by this phase) |
| PRA-005 AI and voice keys | Anthropic and Retell keys in a staging project |
| PRA-006 providers | Product choice of messaging and calendar providers |
| PRA-007 test residue | Approval to delete live test users and orgs; the owner deletes `frontend/test-login.local.md` |
| PRA-008 leaked-password protection | Dashboard setting (account setting change) |
| PRA-010 staging | A new Supabase project (cost / plan decision) |
| PRA-011 hosting | Choice of host |
| PRA-016 signup policy | Business decision |
| PRA-020 compliance | Legal input |
| PRA-022 unconnected pages | Product decision: build or hide |

## Not planned in this phase (with reason)

| Finding | Reason |
|---|---|
| PRA-024 (indexes) | No query evidence yet; needs real traffic |
| PRA-025 (private helpers) | Several are called by invoker triggers and RLS policies, so revoking EXECUTE would break writes. Needs per-function analysis; LOW |
| PRA-027 (CORS) | Depends on hosting (PRA-011) |
| PRA-028 (outbox retention) | S4 hygiene |
| PRA-012 (migration history) | Needs the CLI linked to the live project (a write to migration history) |
