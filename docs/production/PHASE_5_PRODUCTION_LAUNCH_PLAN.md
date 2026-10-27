# Phase 5 Production Launch Plan — Estate OS

Date: 2026-10-27.

## 1. Evidence review (Phases 1–4)

**Reports present:** all 12 listed for `docs/production/`, plus 8 in `docs/pilot/`. Every document named in the brief exists.

**What actually happened, not what was prepared:**

| Question | Answer | Evidence |
|---|---|---|
| Did the pilot run? | **No.** Phase 4 concluded `PILOT NOT READY`; no agency was onboarded | `docs/pilot/PHASE_4_PILOT_READINESS_ASSESSMENT.md` §6 |
| Confirmed business outcomes | **None.** No customer data, no baseline, no pilot metrics | n/a |
| Customer feedback | **None** | The feedback log template is empty |
| Actual usage and operating costs | **None measured.** Only test traffic on staging; Anthropic key not reaching functions (`analysis_configured: false`, last checked 2026-10-26 19:09 UTC) | Phase 4 §1 |
| Production or pilot project | **Does not exist.** `list_projects` shows only staging ("Estate OS") active for this product; the organization is on the free plan | `list_projects`, `get_organization` (2026-10-27) |
| Version control | **None.** Not a git repository | `git status` |
| Hosting | **None** for the frontend | Phase 3 |
| Monitoring | **None external.** Pilot operations page and SQL runbook only | Phase 4 |
| Billing / subscriptions | **None in the code.** No plan, subscription, invoice or payment code | Repository search |

**Verified and stable:**
- tenant isolation (44-table sweep, role tests, catalog invariants);
- the deterministic workflow (intake → qualification → matching → follow-up drafts → internal appointments → analytics);
- per-workspace agent pause;
- AI request guard and limits;
- 267 local tests;
- 92 + 11 staging checks.

## 2. Release-gate matrix

Owner roles: CTO, Eng (engineering), Ops (operations), Legal, Commercial (business owner).

| # | Requirement | Category | Evidence today | Owner | Status |
|---|---|---|---|---|---|
| G1 | No cross-tenant access | RELEASE_BLOCKER | Staging TEN-01…05, 44 tables; local catalog tests; mutation-checked | Eng | **Met** (re-run on production after deploy) |
| G2 | No auth or authorization bypass | RELEASE_BLOCKER | AUTH-01…07, ROLE-01…10, AI guard, worker secrets | Eng | **Met** (with the documented 1 h JWT validity after logout) |
| G3 | No exposed secrets | RELEASE_BLOCKER | Repository scans clean. A local plaintext test password exists in a git-ignored file, plus one fragment echoed in a session (staging test account) | Eng | **Open**: delete the file and rotate the test account (PRA-007) |
| G4 | Separate production project with backups and restore verified | RELEASE_BLOCKER | None exists | CTO, Commercial (cost) | **Open** |
| G5 | Reproducible, reviewable releases (git + CI) | RELEASE_BLOCKER | CI file exists; never run; no repository | CTO | **Open** |
| G6 | Frontend hosted on production | RELEASE_BLOCKER | None | CTO | **Open** |
| G7 | Monitoring able to detect outages, failed jobs, cost spikes | RELEASE_BLOCKER (detection of failures) | Only manual runbook | Ops | **Partially addressed in Phase 5** (health endpoint, usage summary); an external monitor still needs choosing and configuring |
| G8 | No false success in core workflows | RELEASE_BLOCKER | FUP-05, AI-01, APT tests; providers report "not configured" honestly | Eng | **Met** |
| G9 | Migrations safe and reproducible on a fresh database | RELEASE_BLOCKER | Fresh 0001–0019 on PGlite; staging function hashes match | Eng | **Met** (Phase 5 re-checks) |
| G10 | Legal: terms, privacy notice, data processing, consent wording | REQUIRED_BEFORE_CUSTOMER_ONBOARDING | None | Legal | **Open** |
| G11 | Leaked-password protection; email delivery for invites and confirmations (custom SMTP) | REQUIRED_BEFORE_CUSTOMER_ONBOARDING | Off / not configured | Ops | **Open** |
| G12 | All 12 functions deployed from version control | REQUIRED_BEFORE_CUSTOMER_ONBOARDING | 7 run an older build on staging | Eng | **Open** |
| G13 | AI steps verified with a real key | REQUIRED_BEFORE_AUTONOMOUS_ACTIVATION (AI features off until then) | Blocked: key not reaching functions | Eng, Ops | **Open** |
| G14 | Messaging provider (delivery, status, opt-out) | REQUIRED_BEFORE_AUTONOMOUS_ACTIVATION | Not implemented | Commercial, Eng | **Open** (the launch scope uses manual sending) |
| G15 | Voice provider (Retell) + legal calling review | REQUIRED_BEFORE_AUTONOMOUS_ACTIVATION | Not configured | Commercial, Legal | **Open** (voice excluded from launch) |
| G16 | Calendar sync | REQUIRED_BEFORE_AUTONOMOUS_ACTIVATION | Not implemented | Eng | **Open** (internal booking only) |
| G17 | AI usage measured per tenant (tokens) | REQUIRED_FOR_COMMERCIAL_SCALE | Worker tokens stored; user-triggered not; no summary | Eng | **Addressed in Phase 5** (migration 0020) |
| G18 | Per-tenant AI budget across all agents | REQUIRED_FOR_COMMERCIAL_SCALE | Limits exist only for user-triggered features | Eng | **Open** (manual controls and alerting until then) |
| G19 | Billing and subscriptions | REQUIRED_FOR_COMMERCIAL_SCALE | None; no provider or pricing decided | Commercial | **Blocked on a business decision** (design in `COMMERCIAL_LAUNCH_READINESS.md`) |
| G20 | Bulk import (listings and leads) | REQUIRED_FOR_COMMERCIAL_SCALE | None | Eng | **Open** |
| G21 | Operator-initiated provisioning with onboarding status | POST_LAUNCH_IMPROVEMENT | Self-service sign-up is atomic (org + owner in one transaction); checklist is manual | Eng | Documented |
| G22 | Worker reports transient secret-check failure as 401 (PRA-031) | POST_LAUNCH_IMPROVEMENT | One observed blip | Eng | **Fixed in code in Phase 5** (deploy with G12) |
| G23 | Unconnected pages in LIVE (PRA-022) | POST_LAUNCH_IMPROVEMENT | "Not connected" message | Commercial | Open |

## 3. Phase 5 implementation (in the repository, plus staging verification only)

1. **Health check** (G7):
   - `public.ops_health()` (service role only): aggregate platform signals, no tenant data;
   - Edge Function `health`: coarse public status, details only with a secret header;
   - an external uptime monitor can poll it.
2. **AI usage metering** (G17):
   - record provider-reported tokens on user-triggered AI requests;
   - `public.ai_usage_summary(org, from, to)` (`usage.view`): per-agent model calls and tokens from the stored provider usage;
   - cost is not invented: the published price × tokens is a documented manual step.
3. **Worker authentication reporting** (G22): one shared helper; 503 with a log line when the secret check cannot run, 401 only for a wrong secret.
4. **Environment guard** (G4 separation):
   - `VITE_APP_ENV` shows a non-production banner;
   - `scripts/predeploy-check.mjs` refuses a production build that points at a known non-production project or embeds server secrets, and checks function and config consistency.
5. **Production smoke suite:** `scripts/smoke.mjs`. Safe operations only, against dedicated smoke workspaces; no calls, messages, appointments or payments.
6. **Documents:** deployment runbook, incident runbook, launch checklist, commercial readiness, validation report.

**Not done (requires authorization or decisions):**
- creating paid infrastructure;
- deploying to production;
- DNS;
- credentials;
- billing provider integration;
- legal documents.
