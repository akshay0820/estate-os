# Pilot Operations Handbook — Estate OS

For the BlazeReach team running the first agency pilot. Written so that a trained team member can follow it.

- **[MANUAL]** marks steps done outside the app.
- **[APP]** marks steps the app supports today, verified in the repository and on staging.
- Nothing here relies on a feature that does not exist.

**Related documents** (all in `docs/pilot/`):
- `PHASE_4_PILOT_READINESS_ASSESSMENT.md`
- `AGENCY_ONBOARDING_CHECKLIST.md`
- `PILOT_SCOPE_AGREEMENT_TEMPLATE.md`
- `PILOT_SUCCESS_CRITERIA.md`
- `PILOT_DAILY_RUNBOOK.md`
- `PILOT_REVIEW_TEMPLATE.md`
- `PILOT_FEEDBACK_LOG_TEMPLATE.md`

## 1. Pilot purpose

Establish, with one agency, whether Estate OS delivers measurable value safely. It is a learning exercise, not maximum automation:
- start in shadow;
- add human-approved steps;
- consider narrow autonomy only on evidence.

## 2. Scope and exclusions

The default scope is in `PILOT_SCOPE_AGREEMENT_TEMPLATE.md`.

**Always excluded until separately verified and approved:**
- AI voice calls;
- automated message delivery;
- calendar sync;
- writes to the agency's existing CRM;
- Claude-generated content (the AI key is not working on staging yet).

## 3. Agency onboarding

**[MANUAL + APP]** Follow `AGENCY_ONBOARDING_CHECKLIST.md`, sections A–D.

**Collect only what configuration needs.** Never pre-fill with invented data.

## 4. Tenant configuration

**[APP]**
1. The agency's owner creates the workspace at sign-up.
2. Settings: time zone, hours, SLA and assignment.

**Tenant isolation is enforced by the database** (RLS and RPC checks, swept across 44 tables on staging). No one becomes an admin of a workspace by knowing its id. The pilot runs in its **own Supabase project**, never staging.

## 5. User roles (least privilege)

| Role | Can | Give to |
|---|---|---|
| `owner` | Everything, including pausing agents, rotating webhook secrets, granting owner | One person at the agency |
| `admin` | Like owner, except granting owner and finance editing | The agency's administrator, if needed |
| `manager` | Team, reports, pilot operations (view), approvals | Sales leads |
| `agent` | Their own leads, appointments, follow-ups | Salespeople |
| `viewer` | Read only | Observers |
| `finance` | Finance pages | Accounts only |

The BlazeReach operator gets **manager** (sees Pilot operations, cannot pause agents), unless the agency grants more in writing.

## 6. Integration setup

1. **[APP]** Lead intake webhook: Integrations → signing secret (owner).
2. **[MANUAL]** The agency's web or portal developer signs each POST (HMAC-SHA256 over `timestamp.body`, headers `X-Estate-Event-Id`, `X-Estate-Timestamp`, `X-Estate-Signature`). Repeated event ids are ignored.
3. Test with one enquiry.

Every other provider (messaging, calendar, voice, CRM) is **not available**.

## 7. Data import

**No import feature exists.** Use one of:
- listings: entered in Properties by the agency;
- leads: arrive through the webhook, or are created by staff;
- historical data for the baseline: stays in the agency's own export (spreadsheet), used only to compute baseline metrics.

**Before any data enters the app, record:**
- what data, and why it is required;
- who authorized it;
- how it is validated;
- how errors are corrected;
- how it would be removed.

## 8. Agent activation

**[APP]** Pilot operations → Agent controls. Owner or admin; the reason is mandatory and audited. **Lead intake cannot be paused**: stop a source by rotating its secret.

**Effect of a pause, per agent:**

| Agent | While paused |
|---|---|
| Voice | New calls refused |
| Qualification, Matching | Events and runs held (nothing lost; processed on resume) |
| Follow-up | No new plans; existing drafts can still be approved or sent manually |
| Appointment | AI assistant refused; staff booking still works |
| CRM & data | AI enrichment refused; rule checks continue |
| Sales intelligence | AI recommendations and questions refused; metrics continue |

Runs being processed at the moment of pausing finish. Pausing never deletes or skips work, and other agencies are unaffected (tested locally and live).

**Default stage plan:**

| Stage | Active agents | Outbound |
|---|---|---|
| 0 Configuration | None except intake (capture) | Paused |
| 1 Shadow | Intake, Qualification, Matching, CRM & data, Sales intelligence | Paused |
| 2 Human-approved | + Follow-up (drafts, then manual send), Appointment (staff booking) | Paused (no provider) |
| 3 Limited autonomous | Not planned for the first pilot: needs a delivery provider, verified AI and monitoring | n/a |

## 9. Shadow-mode validation

The agency keeps working as today, and the platform processes the same leads in parallel.

- The salesperson records their own decision per lead in the feedback sheet (qualification; the listings they would send).
- The operator compares the two weekly (`PILOT_SUCCESS_CRITERIA.md` §5).

**Limitation:** qualification and matching update lead status **inside the pilot workspace**. This is acceptable because the agency's real system of record is untouched, but staff must be told.

## 10. Human approval workflow

Every approval is enforced by the backend, so direct API calls cannot bypass it (Phase 3 tests FUP-05/06, APT-07, ROLE-01…08).

| What | Approval mechanism |
|---|---|
| Follow-ups | Drafts → approve (version-checked) → send manually → mark as sent. Editing after approval clears the approval |
| Duplicates | Data quality → decide; merges are revertible |
| Qualification | Override or reject with a mandatory note |
| Matches | Shortlist, reject, share, revalidated on each action |
| Appointments | Booked by staff only |

## 11. Daily monitoring

`PILOT_DAILY_RUNBOOK.md`: before activation, daily checks and weekly review.

## 12. Incident severity levels

| SEV | Definition | Detection | Owner (role) | Containment | Customer communication | Recovery | Evidence | Follow-up |
|---|---|---|---|---|---|---|---|---|
| **SEV-1** | Security incident, cross-tenant exposure, unauthorized high-impact action (for example a message or call nobody approved), serious data-integrity failure | Daily checks, agency report, audit log | Incident Commander | **Immediately:** pause the affected agent(s); outbound to paused; if exposure is suspected, rotate the affected secrets (owner); preserve rows and logs; never delete records | Agency Pilot Lead within 1 hour by the agreed channel; written summary within 24 h | Fix, test (incl. tenant suite), redeploy through CI, resume only with agency approval | SQL exports, Logs request ids, audit-log entries, timeline | Post-incident review; regression test; review entry |
| **SEV-2** | Primary pilot workflow unavailable or materially wrong (intake failing, the cron chain stalled more than 30 min, wrong qualification at scale) | Daily checks | Pilot Operator, then Engineer on duty | Pause the affected agent; the agency uses its manual process | Same business day | Fix and verify on staging, then pilot | Same as SEV-1 | Root cause in the review |
| **SEV-3** | Degraded, with a workaround (an appointment mismatch with the agency's calendar, a single failed run, a slow page) | Daily checks, feedback | Pilot Operator | Workaround documented | Weekly review | Scheduled fix | Feedback-log entry | Backlog |
| **SEV-4** | Minor issue or request | Feedback | Pilot Operator | n/a | Weekly review | Prioritized (§18) | Feedback-log entry | Backlog |

## 13. Escalation procedures

The roster uses roles; fill in names and channels with the agency. **Do not invent contacts.**

| Role | Responsibility | Name | Channel |
|---|---|---|---|
| Pilot Operator (BlazeReach) | Daily runbook, first response | | |
| Engineer on duty (BlazeReach) | Fixes, deployments | | |
| Incident Commander (BlazeReach) | SEV-1/2 decisions | | |
| Agency Pilot Lead | Approvals, agency communication | | |
| Agency Owner (app owner role) | Pausing and resuming agents, secrets | | |

**Escalation path:** Operator → Engineer (SEV-2 or SEV-3 needing code) → Incident Commander (SEV-1, or a SEV-2 open for more than 1 day) → Agency Pilot Lead.

## 14. Kill switches

All are server-enforced:

| Control | Where | Who | Enforced by |
|---|---|---|---|
| Pause one agent for this agency | Pilot operations → Pause | Owner or admin | `agent_control_set`; outbox claim, run hold, voice guard, AI guard |
| All outbound communication | Sidebar "Outbound" switch | Owner or admin (settings.manage) | `outbound_paused`, checked by the voice and follow-up policies |
| AI calling | Voice settings `enabled` (off by default) | Owner or admin | Voice pre-call policy |
| Follow-up automation | Follow-up settings `enabled` | Owner or admin | Follow-up policy |
| AI steps per agent | Intake `extraction_enabled`, qualification `llm_enabled`, voice `analysis_enabled` | Owner or admin | Each agent |
| A lead source | Rotate the webhook secret | Owner | Signature check |

Re-enabling needs the same permissions. Every change is in the audit log (`agent_controls.*`, `organizations.update`).

## 15. Rollback procedure

1. **Turn off:** pause the affected agent(s); set outbound to paused.
2. **Return to manual:** notify the Agency Pilot Lead; the agency follows its documented manual process (onboarding checklist §B).
3. **Preserve:** do not delete. Export the relevant rows if needed.
4. **Identify pending work:**
   - held runs (`agent_runs` with `next_attempt_at = 'infinity'`);
   - pending events (Pilot operations "Events waiting");
   - pending approvals.
5. **Prevent duplicates during recovery:**
   - nothing is sent automatically (no provider);
   - before resuming, decide with the agency whether the held work is still wanted.
   - If it is not, leave the agent paused. Cancel individual follow-ups or appointments in the app. There is no bulk-discard tool.
6. **Reconcile:** appointments against the agency's calendar; leads against the agency's lead list.
7. **Communicate:** written summary to the agency.

## 16. Customer support workflow

| Step | What happens |
|---|---|
| Intake | The agency reports through the agreed channel (roster) or the feedback log. The operator acknowledges within the agreed time (to agree; propose 4 business hours) |
| Classification | SEV (§12) and category (§18) |
| Work | Fixes go through git, CI and staging, then pilot. No direct database edits on the pilot project except documented, approved data corrections |

## 17. Metrics collection

**[APP]**
- Pilot operations (operational and quality signals);
- Sales intelligence (business KPIs: leads created, qualification rate, appointments, response time).

**[MANUAL]**
- baseline from the agency's history;
- time study for staff minutes;
- Anthropic console for AI cost;
- hosting and database costs from billing.

| Cost metric | Status |
|---|---|
| Cost per lead processed | Estimate: (AI + hosting + DB for the period) ÷ leads processed |
| Cost per qualification, follow-up or appointment | Same method |
| Infrastructure (hosting, database) | Measured from billing |
| AI spend | Measured from the Anthropic console |
| Per-call token cost | **Unknown** (not recorded per request) |
| Voice and messaging | **None** (no provider) |

Never present activity as savings; ROI only with an agreed method and enough data.

## 18. Feedback collection

Use `PILOT_FEEDBACK_LOG_TEMPLATE.md` (a shared spreadsheet). The app has no feedback feature.

**Prioritize in this order:**
1. security and data protection;
2. data integrity;
3. reliability;
4. the primary workflow;
5. customer value;
6. reusability across agencies;
7. cost and risk.

Do not hard-code this agency's preferences for every tenant. Use per-workspace settings where they exist.

## 19. Pilot review meetings

- **Weekly:** runbook §weekly.
- **End of each stage, and end of pilot:** `PILOT_REVIEW_TEMPLATE.md`.
- **Decisions are recorded with:** who decided, the evidence, and the conditions.

## 20. Exit and data-handling procedures

**[MANUAL + APP]**

1. **Pause all agents;** outbound to paused.
2. **Export the agency's data** if requested: CSV exports exist on several pages (exports are audited).
3. **Retention and deletion:**
   - no automated retention job exists except the voice transcript retention setting;
   - deletion of a workspace's data is a **manual, approved database operation** on the pilot project, after legal review of what must be kept;
   - record what was deleted, when, and by whom.
4. **Revoke access:** suspend members (Team); rotate or remove the webhook secret.
5. **Final review** (template), shared with the agency.

### Data protection summary

**Facts from the code:**

| Area | How it works |
|---|---|
| Lead contact details, preferences, AI notes | Stored in the pilot project, readable only by the workspace's members according to role (RLS) |
| Call recordings and transcripts | None (voice off). If enabled later: recording access needs `calls.recordings`; transcript retention is a setting |
| Data sent to Claude | Only the minimal text each step needs (the code strips names and numbers in qualification). Nothing while the key is absent |
| Logs | Worker logs carry ids and outcomes, not lead content |
| Exports | Audited (`record_export`) |
| Consent | Per channel; outbound policy refuses without it; opt-out stops pending drafts |

**Legal compliance is NOT claimed.** These need qualified legal review before real contacts are processed:
- telemarketing and calling rules;
- recording consent;
- data residency (ap-south-1 / India);
- retention periods;
- the privacy notice;
- the agency's data-processing terms.
