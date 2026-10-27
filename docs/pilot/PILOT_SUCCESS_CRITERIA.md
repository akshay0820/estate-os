# Pilot Success Criteria — Estate OS (draft for customer approval)

**Status: DRAFT.** Every target below is a *proposal* with its rationale. None applies until the agency and BlazeReach agree on it in writing before activation (Stage 0). No universal threshold is assumed.

## 1. Customer-approved objectives (to fill in with the agency)

| # | Objective (agency's words) | Agreed? | Owner |
|---|---|---|---|
| 1 | *e.g. "every web and portal enquiry reaches a salesperson within 5 minutes"* | ☐ | Agency pilot lead |
| 2 | *e.g. "salespeople stop re-typing enquiries"* | ☐ | |
| 3 | *e.g. "a weekly funnel report we trust"* | ☐ | |

These rows are examples to prompt the conversation. Replace them with the agency's own objectives.

## 2. Baseline period

- **Preferred:** the 4–8 weeks before activation, from the agency's existing CRM or lead export, if they hold one.
- **If no historical data exists:** a prospective manual-workflow observation period of at least 2 weeks with Stage 1 (shadow) running. The agency's staff record their own decisions, and the system records its suggestions.
- **Record for each baseline metric:** the source (system, spreadsheet, staff estimate), the period, and known gaps.
- **If a baseline cannot be established:** mark it "unavailable" and say how it will be collected. **Do not invent values.**

## 3. Metrics, measurement method and proposed targets

| Area | Metric | Measured how (today) | Proposed target (for agreement) | Rationale |
|---|---|---|---|---|
| Intake | Successful capture rate | Pilot operations → intake (`leads_created`, `webhooks_processed`, `webhooks_rejected`); compared with the agency's count of enquiries sent | **No accepted enquiry lost**; rejected webhooks explained 100% | A lost lead is worse than no automation |
| Intake | Time from submission to CRM | Webhook response time (201 within the request; staging p50 ≈ 0.5 s) | < 1 min end to end | Staging measurement; confirm with the agency's sources |
| Intake | Unintended duplicate rate | Duplicate reviews (`review_items`) and duplicate candidates resolved as "merged" ÷ leads | Agree after 2 weeks of shadow data | No baseline yet |
| Qualification | Agreement with staff decisions | Shadow comparison sheet (§5) plus qualification overrides (`corrected` on Pilot operations) | Propose ≥ 80% agreement on "qualified / not yet" after ≥ 50 reviewed leads | Below this, staff will not trust it; the sample must be large enough to mean anything |
| Qualification | Missing-information detection | Leads marked `needs_information` that staff agree lacked information | Agree after shadow | |
| Matching | Acceptance rate | Pilot operations → matching: `accepted` ÷ (`accepted` + `rejected_by_staff`) | Agree after shadow; propose ≥ 50% of shown recommendations not rejected | Depends heavily on listing data quality |
| Matching | Unavailable-listing rate | Recommendations later invalidated ÷ recommendations | Propose < 5% | Shown listings must be real and available |
| Follow-up | Drafts approved without edit | `approved` vs `edited_by_staff` | Agree after shadow | Measures draft usefulness |
| Follow-up | Duplicate or unauthorized sends | Incident log; `follow_ups` sent without approval | **0** (hard requirement) | Safety |
| Appointment | Double bookings | Incident log; `APPOINTMENT_CONFLICT` refusals are correct behaviour, not incidents | **0** (hard requirement) | Safety |
| Appointment | Booking state matches the agency's calendar | Weekly manual reconciliation (no calendar sync exists) | 100% reconciled weekly | No provider sync |
| Data quality | Incorrect merges | Merges reverted ÷ merges | **0 unreverted incorrect merges** | Merges are human-approved and revertible |
| Analytics | KPI accuracy | Weekly reconciliation of 3 KPIs against an independent count (as in the Phase 3 tests) | Exact match on counts | Deterministic SQL; any difference is a defect |
| Reliability | Agent failures | Pilot operations → agent runs `dead_letter` / `invalid`; cron failures (runbook) | Propose < 1% of runs; every failure explained | |
| Security | Tenant isolation | Re-run `scripts/staging-e2e.mjs` (tenant section) before each stage change | **100% pass** (hard requirement) | Release gate |
| Security | Unauthorized external action | Incident log | **0** (hard requirement) | |
| Cost | AI spend | Anthropic console (spend cap) and `ai_requests` counts | Within the agreed monthly cap | Cost per call is not recorded in the product |
| Value | Staff time saved | Time study: minutes per lead for intake, qualification and matching, before vs during | Agreed with the agency; **report as measured, not claimed** | Not recorded by the system |
| Feedback | Staff satisfaction | Weekly 3-question survey (handbook §18) | Agree with the agency | |

## 4. Evidence requirements

- **Sample size:** no rate is reported as "met" on fewer than an agreed minimum (propose 50 leads for qualification and matching rates, 20 for follow-up approval rates). Below that, report counts only.
- **Reconciliation:** each weekly review reconciles leads, qualifications and appointments against an independent count (SQL or the agency's own records).

## 5. Shadow comparison method (Stage 1)

For each lead in the shadow period, the agency's salesperson records independently, in the feedback sheet:
- their qualification decision ("qualified / not yet / not a fit");
- the listings they would send.

The system's output is then compared:
- **Qualification:** agreement or disagreement, and the reason.
- **Matching:** the overlap between the system's recommendations and the listings the salesperson chose.

**Define "agreement" before looking at results.**

## 6. Conditions for moving to the next stage

All of these must hold:
- the stage's targets are met on the agreed sample;
- no open SEV-1 or SEV-2;
- the tenant-isolation suite passes;
- the agency approves in writing.

**Time alone is never a reason to expand.**

## 7. Conditions for pausing

Any one of these pauses the affected agent (Pilot operations → Pause) and triggers a review within 1 business day:
- any SEV-1;
- a SEV-2 open for more than 2 business days;
- an agreed hard requirement breached (see §3);
- the agency asks;
- AI spend reaching the cap.

## 8. Conditions for ending the pilot

- The agency asks.
- Repeated SEV-1.
- Hard requirements cannot be met.
- No measurable value after the agreed duration.

Exit follows handbook §20.
