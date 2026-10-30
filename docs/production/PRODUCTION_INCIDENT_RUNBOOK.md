# Production Incident Runbook — Estate OS

**Roles, not names** (fill in the on-call roster at launch):

| Role | Responsibility |
|---|---|
| **On-call Engineer** | First responder |
| **Incident Commander (IC)** | Decides SEV-1/SEV-2 actions, restores, customer notices |
| **Customer Lead** | Talks to affected agencies |
| **CTO** | Credential and security decisions |

**Evidence rules:**
- Never delete records to "clean up" an incident.
- Export the relevant rows, Logs Explorer entries (request ids) and audit-log entries **before** changing anything.
- Write a timeline as you go.

## Severity

| SEV | Definition | Detection | Containment (first 15 min) | Owner | Customer communication | Recovery | Evidence | After |
|---|---|---|---|---|---|---|---|---|
| **SEV-1** | Security incident, cross-tenant exposure, major data corruption, unauthorized high-impact action | Health/alerts, audit log, customer report, isolation tests | Contain with the kill switches below; rotate exposed secrets (CTO); preserve evidence | IC | Affected agencies within 1 h of confirmation; written summary in 24 h; legal review for notification duties | Fix → tests (incl. isolation) → deploy → resume with approval | Mandatory, complete | Written root-cause analysis within 5 business days; regression test; checklist update |
| **SEV-2** | Critical workflow unavailable (intake down, cron chain stalled, sign-in failing) | Health 503, monitor, daily runbook | Pause the affected agent if it behaves wrongly; agencies use the manual process | IC | Same business day | Fix forward or roll back the application | Required | Root-cause analysis in the weekly review |
| **SEV-3** | Degraded, with a workaround | Daily runbook, support | Document the workaround | On-call | Next update | Scheduled fix | Ticket | Backlog |
| **SEV-4** | Minor defect or request | Support | n/a | On-call | Weekly | Backlog | Ticket | n/a |

## Kill switches (all server-enforced; each change is audited)

| Switch | Effect | How |
|---|---|---|
| Pause one agent for one workspace | Events and runs held; voice calls refused; that agent's AI features refused. Nothing deleted | App: Pilot operations → Pause (owner or admin of that workspace). Operator path (SQL editor, service role): see the template below |
| All outbound for one workspace | Voice and follow-up policies refuse outbound | App: sidebar Outbound switch (owner or admin) |
| A lead source | Signed webhooks rejected | Integrations → rotate the secret (owner) |
| AI for everyone | All AI steps fall back or report `not_configured` | Remove the `ANTHROPIC_API_KEY` secret (`npx supabase secrets unset ANTHROPIC_API_KEY --project-ref <ref>`). Functions pick it up on the next cold start |
| Voice for everyone | Voice cron does nothing | Delete the `voice_worker_url` Vault secret, and the `RETELL_API_KEY` secret |
| All background processing | Ticks and workers stop | `select cron.unschedule('<jobname>');` per job. Re-create from the migration's `cron.schedule` statement. **Last resort: affects every tenant** |

**Operator pause template** (SQL editor):

```sql
insert into public.agent_controls (organization_id, agent_id, paused, reason)
values ('<org id>', '<agent_id>', true, 'Incident <id>')
on conflict (organization_id, agent_id) do update set paused = true, reason = excluded.reason, changed_at = now();
```

- Runs already queued keep `next_attempt_at`; hold them too with `update public.agent_runs set next_attempt_at = 'infinity' where organization_id = '<org id>' and agent_id = '<agent_id>' and status in ('received', 'retry_scheduled');`.
- The audit trigger records the change.
- Prefer the app path; it does both steps.

## Procedures

### 1. Application outage (health 503, or the site down)

1. Check the health signals (with `x-health-token`).
   - `down` = database or function unreachable: go to §2.
   - `degraded`: read `reasons`.
2. Frontend only: check the host status and redeploy the last good build.
3. Functions: Logs Explorer → `function_edge_logs` with status ≥ 500, grouped by function. If a release just shipped, roll the function back (deployment runbook §13).
4. SEV-2. Tell the cohort if it lasts more than 30 min.

### 2. Database outage

1. Check the Supabase status page and the project dashboard (compute, disk, connections).
2. **Do not restore from backup for an outage**; restores are for data loss.
3. When back:
   - check cron (`cron.job_run_details`) and the outbox backlog (`oldest_due_event_seconds`);
   - runs and events resume on their own;
   - nothing was sent during the outage (no provider), so no duplicate risk.

### 3. Tenant-isolation failure (any evidence that workspace X saw or changed workspace Y's data)

**SEV-1.**

1. Preserve:
   - the request (Logs request id);
   - the user and both workspace ids;
   - the affected rows;
   - the audit-log entries.
2. Contain:
   - pause the agents involved in both workspaces;
   - if the path is an RPC or table, revoke its EXECUTE or SELECT from `authenticated` in a hot-fix migration (fix forward). That stops the leak for everyone and may break a feature, which is acceptable for a SEV-1.
3. Reproduce in staging with `scripts/staging-e2e.mjs` (tenant section) plus a new test for the path. Fix, test, deploy.
4. Legal review of notification obligations. Inform the affected agencies.

### 4. Credential exposure (a key or secret seen in a log, repo, ticket or chat)

**SEV-1 if it is a server secret.**

1. Rotate (CTO):

   | Secret | How to rotate |
   |---|---|
   | Anthropic key | Provider console, then `supabase secrets set` |
   | Service role / JWT secret | Supabase dashboard API settings (invalidates sessions) |
   | Worker secrets | `update vault.secrets set secret = … where name = '<x>_worker_secret'`, or delete and re-create with `vault.create_secret` |
   | Webhook secret | Integrations → rotate; tell the source's developer |
   | `HEALTH_TOKEN` | `supabase secrets set`, then the monitor |

2. Review usage since the exposure:
   - provider console;
   - `ai_requests`;
   - Logs Explorer.
3. Remove the secret from where it leaked. **Do not rewrite shared history without the CTO.**

### 5. Provider outage (Anthropic; later messaging, calendar, Retell)

1. AI steps record `timeout` or `model_error` and fall back to deterministic results or human review. **No action is lost.**
2. Watch `ai_request_failures_1h` and the agent runs' review rates.
3. SEV-3 unless a workflow the cohort depends on is blocked.

### 6. Failed deployment

1. Stop; do not continue with the remaining steps.
2. Roll back the frontend and functions (deployment runbook §13).
3. If a migration failed mid-way:
   - check `npx supabase migration list --linked`, and whether the objects in the failing file exist. Do not assume it was rolled back as a whole;
   - write any repair as a new migration (fix forward) and re-run.
4. Re-run the smoke suite.

### 7. Agent malfunction (materially wrong qualification, matches or drafts at scale)

1. Pause that agent for the affected workspaces (SEV-2).
2. Its held work waits. Review a sample with the agency.
3. Fix and verify on staging; resume with the agency's approval.

### 8. Unexpected communication activity

There is no delivery provider, so the system cannot send. Any report of a message or call nobody approved is **SEV-1**:

1. Outbound to paused for the workspace.
2. Delete `voice_worker_url`.
3. Check `voice_calls` and `follow_ups` status changes and the audit log for who or what acted.

### 9. Incorrect appointment synchronization

There is no calendar sync. A mismatch between the app and the agency's own calendar is a data-entry issue (SEV-3):

1. Correct it in the app (reschedule or cancel; both are versioned and audited).
2. Record it for the weekly reconciliation.

### 10. Excessive AI usage

1. Find the tenant with `ai_usage_summary` (per workspace) or by summing `ai_requests` and run `model_meta` tokens across workspaces in the SQL editor.
2. Contain:
   - pause the relevant agent for that workspace; or
   - turn off the AI step in its settings (`llm_enabled`, `extraction_enabled`); or
   - globally, unset the key.
3. User-triggered features are already capped (per user per hour, 1,000 per workspace per day).
4. **There is no automatic per-workspace token budget for worker steps** (G18). Detection is by monitoring.

### 11. Suspected data loss

**SEV-1.**

1. Stop the writes involved (pause agents; maintenance banner if needed).
2. Establish what is missing and the time window, using:
   - the audit log;
   - row histories;
   - `appointment_history`;
   - `lead_status_history`.
3. **Recovery:**
   - restore the PITR point *before* the loss **into a new project**;
   - extract the missing rows;
   - re-insert them through a reviewed migration or script.
   - **Only restore production in place** if the IC decides the whole database is compromised. That loses later writes.
4. Inform the affected agencies.

## Alerts — present and missing

| Alert | Status |
|---|---|
| Health endpoint non-200 (cron failures, worker errors ≥ 3 in 15 min, event backlog > 15 min, dead letters) | **Monitored** by `.github/workflows/uptime.yml` every 5 min: it opens an `uptime` GitHub issue on failure and closes it on recovery (see `UPTIME_MONITORING.md`). The test alert is still to be run and recorded |
| Database unreachable | Same endpoint (`down`, 503) |
| Backup failures | Not observable from the app. Rely on the Supabase dashboard; check PITR in the daily runbook |
| Excessive AI cost | Provider-side spend cap (Anthropic console). In-app: usage summary, manual |
| Tenant-isolation incidents | No automated detector. Prevention by tests; detection by reports and audit review |
| Elevated auth errors | Supabase Auth logs (dashboard); no alert configured |
