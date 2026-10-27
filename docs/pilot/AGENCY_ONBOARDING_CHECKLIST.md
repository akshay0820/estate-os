# Agency Onboarding Checklist — Estate OS pilot

Fill in **with the agency**. Do not pre-fill real details with fictional data. Leave a field blank until the agency provides it.

Each step names the app feature that already exists for it. Where there is none, it says **MANUAL**.

## A. Agency information (collect only what configuration needs)

| Item | Value | Where it goes in the app | Status |
|---|---|---|---|
| Agency name | | Workspace name (created at sign-up: `create_organization`) | ☐ |
| Primary administrator (name, work email) | | Signs up and creates the workspace; becomes **owner** | ☐ |
| Authorized team members and roles | | Team → Invite member (role per person) | ☐ |
| Operating locations (localities, city) | | Settings (city); agents' localities on Team; listings' localities | ☐ |
| Business hours and time zone | | Settings → time zone, business hours, calling hours | ☐ |
| Lead sources used | | Integrations → lead intake webhook (one signing secret per workspace) | ☐ |
| Current CRM / lead system | | **MANUAL**: no CRM connector exists; the pilot runs alongside it | ☐ |
| Property data source | | Properties → add listing (manual entry). **No bulk import exists** | ☐ |
| Appointment-booking process | | Appointments (internal booking). **No calendar sync** | ☐ |
| Communication channels required | | Consent per channel on contacts. **No delivery provider**: messages are sent manually | ☐ |
| Pilot objectives | | `PILOT_SUCCESS_CRITERIA.md` §1 | ☐ |
| Escalation contact (role and channel) | | Handbook §13 roster | ☐ |
| Agreed support process | | Handbook §16 | ☐ |

## B. Workflow discovery (agency's current process)

For each question, record the answer, then mark the step: **A** = the platform will automate it in the pilot; **H** = it stays human-operated.

| # | Question | Current process | A / H |
|---|---|---|---|
| 1 | Where do new leads originate? (forms, portals, walk-ins, calls) | | |
| 2 | How do leads reach the sales team today? | | |
| 3 | Who responds to each lead, and how is it assigned? | | |
| 4 | How are leads qualified? (criteria, who decides) | | |
| 5 | How are properties recommended? | | |
| 6 | How are follow-ups scheduled and sent? (channels, frequency) | | |
| 7 | How are appointments booked? (calendar tool) | | |
| 8 | How are CRM records updated? | | |
| 9 | How is performance measured today? (which reports, how often) | | |
| 10 | What happens today when something fails? | | |

## C. Technical setup (operator, with the agency's owner signed in)

1. **Confirm the target environment is the pilot project, not staging** (runbook "Before activation" #1).
2. The owner signs up, confirms their email, and creates the workspace with the agency's name, city and time zone.
3. **Settings:** business hours, calling hours, SLA minutes, assignment rule.
4. **Team:** invite each person with the least privilege role:

   | Role | For whom |
   |---|---|
   | `agent` | Salespeople |
   | `manager` | Team leads (reports and pilot operations) |
   | `admin` | The agency administrator |
   | `viewer` | Read-only observers |
   | `finance` | Accounts only |

   The invitation is a link; send it to each person through a channel you trust. No email is sent by the app.
5. **Pilot operations:** pause every agent not in Stage 1 scope, with the reason "Not in pilot stage 1". Pause **Voice calling** in all cases.
6. **Sidebar:** set **Outbound** to paused until a stage allows outbound.
7. **Lead source:**
   1. Integrations → generate the signing secret (owner only).
   2. Give it to the agency's web developer or portal through a secure channel; never by email or chat in plain text.
   3. Send one test enquiry and confirm it appears.
8. **Listings:** the agency (or the operator, with written authorization) enters the active listings in scope.
   - Mark listings **verified** only after checking them with the agency.
   - Unverified listings are flagged in match results.
9. **Consent:** for each channel the agency will use, confirm how consent is captured (form wording) and that it is recorded on contacts.
10. **Data import:** none is available. If historical leads are needed for the baseline, use the agency's own export **outside** the app (spreadsheet) for baseline metrics only. Do not load historical personal data into the app unless the scope agreement requires it and it is authorized.
11. Run the "Before activation" checks in `PILOT_DAILY_RUNBOOK.md`.

## D. Sign-off

| Item | Signed by (role) | Date |
|---|---|---|
| Scope agreement (`PILOT_SCOPE_AGREEMENT_TEMPLATE.md`) | | |
| Success criteria (`PILOT_SUCCESS_CRITERIA.md`) | | |
| Data-processing terms and consent wording (legal review) | | |
| Stage 1 activation | | |
