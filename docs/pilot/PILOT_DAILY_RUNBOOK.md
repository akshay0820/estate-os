# Pilot Daily Runbook — Estate OS

**Who:** the BlazeReach pilot operator (role: *Pilot Operator*), with the agency's pilot lead (role: *Agency Pilot Lead*). No named people are assumed; fill in the roster in the handbook §16.

**Where:**
- the app's **Pilot operations** page (owner, admin or manager);
- the Supabase dashboard for the **pilot's own project** (SQL editor, Logs);
- the Anthropic console.

All SQL below is read-only. Replace `:org` with the pilot agency's organization id.

## Before activation (and before every stage change)

| # | Check | How | Pass when |
|---|---|---|---|
| 1 | Correct environment | `.env` / host config points at the pilot project ref, **not** staging (`jvdnapofyoarhfctbpyi` is staging) | The ref matches the pilot project |
| 2 | Correct tenant | Pilot operations header shows the agency's name and time zone | The name and time zone match the onboarding form |
| 3 | Configuration | Settings: business hours, time zone, SLA, assignment rules | Matches the signed scope |
| 4 | Permissions | Team page: every user, their role and status | Only the people on the roster; least privilege (§5 of the handbook) |
| 5 | Agent states | Pilot operations → Agent controls | Exactly the agents agreed for this stage are Active; the rest Paused, with a reason |
| 6 | Outbound | Sidebar "Outbound" switch; Pilot operations banner | Paused unless the stage explicitly allows outbound |
| 7 | Voice | Pilot operations tag "AI calling setting: off" | Off (voice is out of scope until verified) |
| 8 | Integration health | Integrations page: webhook secret version and recent events | The agency's sources send signed events; no unexplained rejections |
| 9 | Tenant isolation | Run `scripts/staging-e2e.mjs` on staging (tenant section) | 0 failures |
| 10 | Approval | Written agency approval of this stage's workflows | On file |
| 11 | Fallback | The agency knows the manual process for each workflow | Confirmed in writing |

## Daily checks (about 15 minutes)

1. **Pilot operations (last 24 h)**, in this order:
   1. Failed events (must be 0);
   2. agent runs with `Failed` or `Invalid` > 0;
   3. Events waiting with oldest > 10 min (the cron chain is stuck);
   4. Webhooks rejected (should match known tests or a misconfigured source);
   5. Human review backlog (drafts, qualifications, duplicates).
2. **Workers and cron**, in the Supabase SQL editor:
   ```sql
   select status_code, count(*) from net._http_response where created > now() - interval '24 hours' group by 1;
   select status, count(*) from cron.job_run_details where start_time > now() - interval '24 hours' group by 1;
   ```
   Any status other than 200, or any non-`succeeded` cron run: find the function in Logs Explorer (`function_edge_logs`, filter on status). Record it in the incident log if it was not a single self-recovering blip (see PRA-031).
3. **Failed executions:**
   ```sql
   select agent_id, status, error_category, attempt_count, received_at from public.agent_runs
   where organization_id = :org and status in ('dead_letter', 'invalid') and received_at > now() - interval '24 hours';
   ```
4. **Pending approvals:**
   - Follow-ups page "Awaiting approval";
   - Data quality page "Duplicates";
   - Leads with qualification in review.
   - Remind the Agency Pilot Lead if anything is older than 1 business day.
5. **Duplicates and inconsistent records:** Data quality page. New strong duplicates are decided by agency staff, never by the operator.
6. **Appointments:** compare today's confirmed appointments (Appointments page) with the agency's own calendar. There is **no calendar sync**, so every mismatch is an incident (SEV-3) to correct manually.
7. **Opt-outs and complaints:**
   ```sql
   select channel, status, count(*) from public.communication_consents
   where organization_id = :org and updated_at > now() - interval '24 hours' group by 1, 2;
   ```
   Plus anything the agency reports.
8. **Cost and usage:**
   - Anthropic console spend against the cap;
   - Pilot operations "AI requests";
   - anomalies (more than twice the previous day) are investigated.
9. **Disabled stays disabled:** Pilot operations controls match the stage plan; Outbound and Voice settings unchanged. The audit log (Audit logs page) shows no unexpected `agent_controls.*` or `organizations.update` entries.
10. **Record:** the daily line in the pilot log (date, checks done, anomalies, incident ids).

## Weekly review (about 60 minutes, with the agency)

1. Baseline versus current metrics (success criteria §3), with sample sizes.
2. Agent quality:
   - shadow comparison sheet;
   - corrections (qualifications corrected, matches rejected, drafts edited).
3. Failure rates, with every failure explained.
4. Customer feedback log: triage new items (handbook §18).
5. Cost and operational burden (operator hours this week).
6. Agree changes. **Any configuration change is made by the agency's owner or admin in the app, or by the operator with written approval.**
7. Stage decision: next stage only if success criteria §6 holds. **Never because N days have passed.**
8. Fill in the weekly section of `PILOT_REVIEW_TEMPLATE.md`.

## Emergency (any SEV-1)

1. **Pause the affected agent:** Pilot operations → Pause, with a reason. If outbound is involved, switch Outbound to paused (sidebar).
2. **Preserve evidence:** export the relevant rows (SQL above), note the request ids from Logs. **Do not delete records.**
3. Escalate to the *Incident Commander* role (handbook §13) and notify the *Agency Pilot Lead* by the agreed channel.
