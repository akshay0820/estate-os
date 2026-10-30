# Uptime monitoring (gate G7)

## What runs

`.github/workflows/uptime.yml` runs on GitHub's servers every 5 minutes, outside Supabase and Vercel. It checks:

| Check | URL (repository variable, default) | Up when |
|---|---|---|
| Health endpoint | `HEALTH_URL`, default `https://jvdnapofyoarhfctbpyi.supabase.co/functions/v1/health` | HTTP 200. The endpoint answers 503 when the database is unreachable, or when `ops_health()` reports cron failures, worker errors, an event backlog or dead letters |
| Web app | `SITE_URL`, default `https://estate-os-smoky.vercel.app` | HTTP 200 |

A check counts as down only after **3 failed tries, 20 seconds apart**, so one slow response does not raise an alert.
The check itself is `.github/scripts/uptime-check.sh`; you can run it locally with the same environment variables.

## Alerts

- **Down:** the run fails, and an issue titled **"Estate OS is down"** with the label `uptime` is opened. There is one
  issue per outage, with no repeat comments while it stays down.
- **Recovered:** the next passing run comments "Recovered" and closes the issue.
- **Who is notified:** GitHub notifies people watching the repository about new issues. GitHub also emails the user who
  last changed the workflow's schedule when a scheduled run fails.
  **Owner:** make sure the on-call person watches the repository (Watch → All activity, or Custom → Issues). Make sure
  email notifications for Actions are on: GitHub → Settings → Notifications → Actions.
- No secrets are needed. The workflow uses the built-in `GITHUB_TOKEN` with `issues: write` only.

## Test the alert (required by the launch checklist)

1. GitHub → **Actions → uptime → Run workflow**, tick **Simulate a failure**, then run it. The run turns red and an
   "Estate OS is down" issue opens. Confirm the on-call person received the notification.
2. Run it again **unticked**. The issue gets "Recovered" and closes.
3. Record the date and who received the alert in the launch checklist.

## When production exists

Set the repository variables `HEALTH_URL` (the production project's `/functions/v1/health`) and `SITE_URL` (the
production domain) under Settings → Secrets and variables → Actions → Variables. No workflow change is needed.

## Limits of this monitor

- GitHub can **delay scheduled runs** by several minutes, or occasionally skip them, at busy times. Expect detection
  within about 5–15 minutes, not to the minute.
- GitHub **pauses scheduled workflows in a public repository after 60 days with no commits**. It shows a banner, and the
  schedule can be re-enabled from the Actions tab.
- It only sees what is public: HTTP status codes. Detailed signals need the `x-health-token` header; see the incident
  runbook.
- **Recommended for a paying customer:** add a second, independent monitor on a dedicated uptime service that polls the
  same `HEALTH_URL` every 1–5 minutes and alerts by email or SMS. The owner must create that account; no code change is
  needed.
