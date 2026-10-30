# Production Launch Checklist — Estate OS

Status as of 2026-10-27.

| Status | Meaning |
|---|---|
| **Done** | Verified with the evidence cited |
| **Partial** | Some of the item is verified; the rest is listed under "Remaining" |
| **Open** | Not done |
| **Blocked** | Waiting on a decision or access outside engineering |

## Security

| Item | Status | Evidence | Role | Remaining | Blocks launch |
|---|---|---|---|---|---|
| Authentication and authorization | Done (staging) | AUTH-01…07, ROLE-01…10, AI guard tests | Eng | Re-run smoke on production. Note: access tokens stay valid for up to 1 h after logout (standard; shorten JWT expiry if needed) | No |
| Tenant isolation | Done (staging and local) | 44-table sweep, catalog invariants, indirect-RPC tests, smoke SM-04/07/13 | Eng | Run smoke on production | No (yes, if the production smoke fails) |
| Secrets protection | Partial | Repository and bundle scans; `predeploy` bundle check; Vault for worker secrets | CTO | Delete `frontend/test-login.local.md`; rotate or delete the staging test accounts; set production secrets fresh (never copy from staging) | **Yes** (G3) |
| API security | Done | `verify_jwt` per function (`config.toml`, `predeploy` check); HMAC webhooks; worker secrets; rate limits on AI and org creation | Eng | General API rate limiting is platform default only | No |
| Data access controls | Done | RLS on every table (catalog test); definer RPCs with permission checks; anon has no access | Eng | — | No |
| Sensitive-data logging | Done (code review) | Workers log ids and outcomes only; health has no tenant data; analyst logs store the spec, not the question | Eng | Review production logs after the first week | No |
| Integration permissions | Done | Webhook secret rotation is owner-only; `integrations.manage` | Eng | — | No |
| Leaked-password protection | Open | Advisor WARN on staging | Ops | Enable on production | **Yes** (before onboarding) |

## Infrastructure

| Item | Status | Evidence | Role | Remaining | Blocks launch |
|---|---|---|---|---|---|
| Environment separation | Partial | `VITE_APP_ENV` banner; `predeploy --env production` refuses non-production targets (tested) | CTO | **The production project does not exist** | **Yes** (G4) |
| Production configuration | Open | Deployment runbook §3 | Ops | Set up on the new project | **Yes** |
| Database readiness | Partial | 20 migrations apply fresh (PGlite); staging function hashes match | Eng | Apply on production (`db push`) | **Yes** |
| Migration review | Done | `predeploy`: versioned, ordered, no destructive statements | Eng | Review at each release | No |
| Backups | Open | None on the free plan | CTO, Commercial | Pro + PITR on the production organization (about $130/mo) | **Yes** |
| Restore verification | Open | Never performed | Ops | Restore drill into a new project (deployment runbook §13) | **Yes** |
| Deployment process | Partial | Deployment runbook; CI file; `predeploy`; smoke suite | CTO | Git repository, CI run, frontend host | **Yes** (G5, G6) |
| Recovery plan | Done (documented) | Deployment runbook §13; incident runbook §11 | Ops | Drill | Covered above |

## Application quality

| Item | Status | Evidence | Role | Remaining | Blocks launch |
|---|---|---|---|---|---|
| Build and tests | Done | 278/278 local; lint, typecheck, `check:functions`, build, audit 0 | Eng | CI on the release commit | No |
| Core workflows | Done (staging) | Staging e2e 92/92 (phase 3–5 runs), smoke 16/16 | Eng | Production smoke | No |
| Frontend/backend consistency | Partial | Browser checks of key pages; 4 pages "not connected" | Commercial | Hide or explain the unconnected pages | No |
| Agent validation | Partial | Deterministic paths verified; **AI steps unverified** | Eng | Verify with the key on staging | No (AI off at launch) |
| Integration validation | Partial | Lead webhook verified; Anthropic, Retell, messaging and calendar not | Eng | Per `COMMERCIAL_LAUNCH_READINESS.md` §3 | No (out of scope) |
| Regression coverage | Done | DB, unit and staging suites; mutation-checked safety tests | Eng | — | No |
| All 13 functions at the release build | Open | 8 functions on staging run older builds | Eng | `supabase functions deploy` from git | **Yes** (before onboarding) |

## Operations

| Item | Status | Evidence | Role | Remaining | Blocks launch |
|---|---|---|---|---|---|
| Health checks | Done (staging) | `/functions/v1/health` deployed; `ops_health` live `ok` with real signals | Eng | Deploy to production; set `HEALTH_TOKEN` | No |
| Monitoring | Partial | Endpoint ready; GitHub Actions uptime monitor every 5 min with issue alerts (`UPTIME_MONITORING.md`); usage summary | Ops | Run and record the test alert; point it at production; optionally add a second independent monitor | **Yes** (G7) |
| Alerting | Open | No external alert configured or tested | Ops | Alert on non-200 to the on-call role; send a test alert | **Yes** |
| Incident runbook | Done | `PRODUCTION_INCIDENT_RUNBOOK.md` | Ops | Fill in the roster | No |
| Kill switches | Done | Agent pause (local 7, live 11, smoke SM-15); outbound; AI-step toggles | Eng | — | No |
| Support process | Partial | Runbooks; feedback log | Commercial | Support hours, channel | No (before onboarding) |
| Usage and cost monitoring | Partial | `ai_usage_summary` (tokens); AI request limits | Ops | Anthropic spend cap; per-workspace background AI budget (G18) | No (manual control for a small cohort) |

## Customer onboarding

| Item | Status | Evidence | Role | Remaining | Blocks launch |
|---|---|---|---|---|---|
| Tenant provisioning | Partial | Self-service workspace creation (atomic); checklist | Ops | Operator-led provisioning tracking (manual) | No |
| User roles | Done | Role tests | Eng | — | No |
| Integration setup | Done | Webhook secret, signed intake | Ops | Per agency | No |
| Data import | Open | None | Eng | Manual entry for the first cohort; bulk import later (G20) | No (small cohort) |
| Agent activation | Done | Pilot operations stage controls | Ops | Per agency | No |
| Customer training | Open | — | Commercial | Short guide per role | Before onboarding |
| Support handoff | Open | — | Commercial | Roster, channel | Before onboarding |
| Invitation email delivery | Open | Supabase default mailer limits (not verified) | Ops | Custom SMTP | Before onboarding |

## Commercial readiness

| Item | Status | Evidence | Role | Remaining | Blocks launch |
|---|---|---|---|---|---|
| Pricing decisions | Blocked | None | Commercial | Decide | **Yes** (for *paid* launch) |
| Subscription and billing | Blocked | Design only (`COMMERCIAL_LAUNCH_READINESS.md` §8) | Commercial, Eng | Provider choice, then implementation | No for an invoiced first cohort; yes for self-serve |
| Customer terms | Open | None | Legal | Draft and review | **Yes** |
| Privacy documentation | Open | None | Legal | Notice, data processing, subprocessors, retention | **Yes** |
| Supported product scope | Done | `COMMERCIAL_LAUNCH_READINESS.md` §2–3 | Commercial | Approve | No |
| Customer-facing claims | Done | §9 list of claims to avoid | Commercial | Enforce in marketing | No |
| Support commitments | Open | — | Commercial | Hours and SLAs (no uptime history yet) | Before onboarding |
