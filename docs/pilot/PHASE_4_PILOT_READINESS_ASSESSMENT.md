# Phase 4 Pilot Readiness Assessment — Estate OS

Date: 2026-10-27. **Decision: `PILOT NOT READY`** (§6). Phase 4 has prepared everything on the product side that does not need external accounts or decisions. What remains is infrastructure, credentials and agency inputs.

## 1. Phase 1–3 review

All ten reports listed in the brief exist in `docs/production/` and were re-read.

**Phase 3 did not conclude `READY FOR CONTROLLED PILOT`.** Its decision was `STAGING DEPLOYED — VALIDATION INCOMPLETE`:
- the backend is validated on staging (92 / 92);
- the UI is not hosted;
- 7 functions run an older build;
- every AI and provider path is blocked.

**Since Phase 3:**
- The owner reported setting `ANTHROPIC_API_KEY`. Two fresh-boot checks (2026-10-26 18:55 and 19:09 UTC) still show **`analysis_configured: false`**, so the key does not reach the Estate OS functions. **No AI step has been validated.**
- Phase 4 added migration 0019 (pilot controls) and the Pilot operations page. They are verified locally (267 / 267 tests) and live on staging (pilot-controls probe 11 / 11; the function bodies match a fresh install).

## 2. Issues and classification

| # | Issue | Source | Class | Why |
|---|---|---|---|---|
| 1 | No frontend hosting: agency staff cannot reach the app | PRA-011 | **PILOT_BLOCKER** | No pilot without a URL |
| 2 | No production (pilot) project; staging must not be used for a real agency; free plan, no PITR backups | PRA-002, PRA-010 | **PILOT_BLOCKER** | Real lead data needs a separate project with backups |
| 3 | No monitoring or alerting; failures only visible by daily checks | PRA-003 | **REQUIRED_BEFORE_ACTIVATION** | The daily runbook is a documented manual substitute for the first agency. Alerting is needed before Stage 2 |
| 4 | No git or CI; the deployed version is not reproducible | PRA-004 | **PILOT_BLOCKER** | Patches during a live pilot must be reviewable and reversible |
| 5 | Leaked-password protection off | PRA-008 | **REQUIRED_BEFORE_ACTIVATION** | Dashboard setting on the pilot project |
| 6 | Legal review: consent wording, retention, privacy notice, data residency | PRA-020 | **PILOT_BLOCKER** for real contacts | Real personal data cannot be processed without it |
| 7 | Anthropic key not visible to functions; all AI steps unverified | PRA-005 | **ACCEPTABLE_WITH_DOCUMENTED_LIMITATION** | The pilot runs with deterministic engines and AI off; AI steps are added later behind shadow validation |
| 8 | No Retell; voice unverified | PRA-005 | **ACCEPTABLE_WITH_DOCUMENTED_LIMITATION** | Voice is out of pilot scope and paused |
| 9 | No messaging provider | PRA-006 | **ACCEPTABLE_WITH_DOCUMENTED_LIMITATION** | Staff send approved drafts manually |
| 10 | No calendar sync | PRA-006 | **ACCEPTABLE_WITH_DOCUMENTED_LIMITATION** | Internal booking plus a weekly manual reconciliation |
| 11 | No bulk import (leads or listings) | Phase 4 inspection | **ACCEPTABLE_WITH_DOCUMENTED_LIMITATION** if the in-scope listings are few enough to enter by hand; otherwise **REQUIRED_BEFORE_ACTIVATION** | No CSV or import feature exists; only exports |
| 12 | No CRM connector to the agency's existing system | Phase 4 inspection | **ACCEPTABLE_WITH_DOCUMENTED_LIMITATION** | The pilot runs alongside it (shadow) |
| 13 | Unconnected pages (Inbox, Workflows, Approvals, Logs) | PRA-022 | **POST_PILOT_IMPROVEMENT** | Hide them or explain them in training |
| 14 | Qualification and matching update lead status automatically (no "suggest-only" mode) | Phase 4 inspection | **ACCEPTABLE_WITH_DOCUMENTED_LIMITATION** | In shadow they act on the pilot copy only; the agency's own CRM is untouched. A suggest-only mode is a post-pilot item |
| 15 | Worker reports a transient secret-check failure as 401 | PRA-031 | **POST_PILOT_IMPROVEMENT** | Self-recovers; covered by the daily check |
| 16 | 7 functions run an older build | Phase 3 | **REQUIRED_BEFORE_ACTIVATION** | Deploy all 12 from git to the pilot project |
| 17 | AI functions return 503 `guard_unavailable` instead of 423 `paused` when an agent is paused (the new mapping is not deployed) | Phase 4 | **POST_PILOT_IMPROVEMENT** | Fails closed either way; redeploy with #16 |
| 18 | Tester password file and a password fragment exposed in a session | PRA-007 | **REQUIRED_BEFORE_ACTIVATION** | Staging only, but rotate or delete |
| 19 | Agency information, objectives, baseline, consent wording, escalation roster | Brief | **REQUIRED_BEFORE_ACTIVATION** | Must come from the agency; nothing invented |
| 20 | Operational controls: per-tenant agent pause, observable state, audit | Phase 4 (implemented) | **Resolved** | Migration 0019; tests 7 local + 11 live |

**No unresolved critical (SEV-1-class) defect is known.** Tenant isolation passed 44-table sweeps on staging.

## 3. What exists for onboarding (reused, not rebuilt)

| Step | Existing feature | Verified |
|---|---|---|
| Separate tenant | Sign-up → `create_organization` (rate-limited); the creator becomes the only owner; no tenant-id-based self-promotion | DB tests (privilege escalation suite); staging |
| Users and roles | Team → invite by single-use link; roles owner, admin, manager, agent, viewer, finance; last-owner protection | DB tests; staging role tests ROLE-01…10 |
| Settings | Settings page: time zone, business and calling hours, SLA, assignment, stages | Existing |
| Lead source | Integrations → signed webhook, per-workspace secret, rotation | Staging INT-01…10 |
| Listings | Properties page (manual entry, verification) | Existing |
| Consent | Per-contact, per-channel consent records; outbound policy checks | DB tests |
| Kill switches | **New:** per-agent pause (Pilot operations). **Existing:** workspace outbound switch, voice off by default, follow-up `enabled` setting, per-agent AI-step toggles | Local + live |
| Pilot metrics | **New:** Pilot operations page (`pilot_overview`). **Existing:** Sales intelligence for business KPIs | Local + live + browser |

No platform-administrator role exists or is needed. Every onboarding action is done by the agency's own owner inside their workspace, so no platform-level admin function is exposed.

## 4. Agent activation readiness (evidence-based)

| Agent | Shadow | Human-approved | Limited autonomous | Notes |
|---|---|---|---|---|
| 1 Lead intake | Ready | n/a | **Ready (internal only)** | Deterministic capture verified on staging; creates records only, no external action. AI extraction blocked (key) |
| 2 Voice calling | Not ready | Not ready | Not ready | No provider; keep paused |
| 3 Qualification | **Ready** | Ready (review and override exist) | Not ready | Deterministic engine verified; agreement with the agency unmeasured; AI step blocked |
| 4 Property matching | **Ready** | Ready (shortlist, reject, share) | Not ready | Constraint logic verified with synthetic listings; real listing quality unknown |
| 5 Follow-up | Ready (drafts) | **Ready** (approve, then manual send) | **Not ready** | No delivery provider; never sends by itself |
| 6 Appointment | Ready | **Ready** (staff booking) | Not ready | No calendar sync; AI assistant blocked |
| 7 CRM & data | **Ready** | Ready (merges always human) | Not ready | |
| 8 Sales intelligence | **Ready** (metrics) | n/a | n/a | KPIs reconciled with independent counts; AI recommendations blocked |

## 5. Path to `READY FOR SHADOW PILOT`

1. A git repository, with CI green.
2. A pilot Supabase project on a paid plan with PITR. Apply 0001–0019 fresh; deploy all 12 functions from git; set up the Vault worker secrets.
3. Frontend hosted on the pilot project's URL; Auth site URL and redirects set.
4. Leaked-password protection on.
5. Legal review of consent wording, retention and the privacy notice.
6. The agency completes `AGENCY_ONBOARDING_CHECKLIST.md`; scope and success criteria signed.
7. Stage 0 checks (runbook) pass.

AI steps join later: once the key is visible, run the AI validation on staging, then shadow in the pilot.

## 6. Decision

**`PILOT NOT READY`.** Items 1, 2, 4 and 6 in §2 are pilot blockers on BlazeReach's side, not customer setup.

The product-side preparation is done:
- controls, metrics, onboarding steps, the runbook, success criteria and templates exist and are tested where code is involved.

Once §5 steps 1–5 are complete, the status can move to `PILOT PREPARATION COMPLETE — CUSTOMER SETUP REQUIRED`, and after Stage 0 to `READY FOR SHADOW PILOT`.
