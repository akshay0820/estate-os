---
name: new-client
description: Walk a dedicated Estate OS deployment for a new client from brief to go-live, tracked in CLIENT.md.
disable-model-invocation: true
argument-hint: "<client name>"
---

# New client deployment

Drive one client deployment through the phases of `docs/production/CLIENT_REPLICATION_GUIDE.md` (the **guide**), one
phase at a time, with progress kept in `CLIENT.md` at the repository root so any later session can resume.

The guide is the reference for *how* each phase is done. This skill is the order, the gates and the tracking. Read the
guide's phase before starting it; quote its steps rather than restating them from memory.

## Hard rules

- **Secrets stay with the operator.** Ask the operator to enter every key in a dashboard or their own terminal, then
  confirm by name only (`npx supabase secrets list`, a status endpoint, a settings banner). If a secret appears in the
  conversation anyway, stop, tell the operator to rotate it, and carry on with the new one entered privately.
- **Production is read-only for you.** On the client's production project, you run verification only (read-only SQL,
  advisors, logs, `schema:fingerprint`). The operator runs migrations, function deploys, Vault writes and `db push`.
- **Real-world actions need the operator's go-ahead in this conversation:** a real call, a real email, a Retell sync with
  a real key.

## Start or resume

1. If `CLIENT.md` exists, read it, report the current phase and the first unchecked item, and continue from there.
2. Otherwise create it from the template below, with the client name from `$ARGUMENTS` (ask if empty), and add one line
   to the end of `CLAUDE.md`: `**This deployment:** see CLIENT.md (client brief and go-live status).`

`CLIENT.md` belongs to the client repository only. While `git remote get-url origin` still points at the core
repository (`akshay0820/estate-os`), keep `CLIENT.md` and the `CLAUDE.md` line uncommitted and do Phase 1 first.

Done when `CLIENT.md` exists and you have told the operator which phase is next.

## Phases

Work through them in order. A phase is done only when every item under it in `CLIENT.md` is checked and its **gate**
holds; record the evidence (command output summary, URL, date) next to the item.

| Phase | Gate |
|---|---|
| **0 Model** | Deployment model and account owners recorded. If model A (shared workspace), stop here: no deployment work. |
| **1 Repo** | `origin` is the client repo, `upstream` the core; `npm run lint`, `typecheck`, `check:functions`, `test`, `build`, `predeploy` all pass on the untouched copy |
| **2 Local** | App runs in demo (`estate-os-demo`) and live-on-staging (`estate-os`) preview |
| **3 Brief** | Every field of the brief filled; open questions listed for the operator |
| **4 Customize** | Each brief item classified as configuration (4.1), branding (4.2), voice persona (4.3) or core feature (4.4); branding in one commit; core features landed in the core repo, not here; all checks green; `/code-review` run on the diff (plus `/security-review` for auth, RLS, permissions, webhooks, secrets, CSP) |
| **5 Provision** | Each service in the guide's 5.1–5.8 confirmed by the operator and verified by name or status check |
| **6 Release** | Runbook §4–§8 complete; health 200; 13 cron jobs active; no advisor ERROR; smoke tests pass |
| **7 Go-live** | One real inbound lead qualified, one real test call completed, one real email received and answered — each with the operator's go-ahead |
| **8 Handover** | Training done, incident contacts recorded, uptime alert confirmed reaching on-call |

Plan mode first for Phase 4: present the classification and the branding file list, and edit only after approval.

## Ending a session

Update `CLIENT.md` (checked items, evidence, next item), then tell the operator the next action and who owns it (you or
them).

## CLIENT.md template

```markdown
# Client: <name>

## Brief (guide Phase 3)
- Product name shown to users:
- Brand (logo, accent colour, favicon):
- Production domain:
- Country / currency / timezone:
- Calling hours, business days:
- Team (roles and counts):
- Lead sources:
- Channels: voice yes/no, email yes/no
- Voice agent (name, spoken agency name, voice, inbound/outbound, number):
- Email (sending address, sender name):
- Agents enabled / paused at launch:
- Data to import:
- Custom features requested:
- Compliance (consent, recording disclosure, retention days):

## Accounts (guide Phase 0)
- Deployment model: A shared / B dedicated
- Supabase / Vercel / Anthropic / Retell / Postmark / Cloudflare / Domain owner:

## Open questions

## Status
- [ ] 0 Model
- [ ] 1 Repo
- [ ] 2 Local
- [ ] 3 Brief
- [ ] 4 Customize
- [ ] 5 Provision: 5.1 Supabase · 5.2 DB/functions/workers · 5.3 secrets · 5.4 voice · 5.5 email · 5.6 Turnstile · 5.7 Vercel · 5.8 monitoring
- [ ] 6 Release
- [ ] 7 Go-live: lead · call · email
- [ ] 8 Handover

## Log
<!-- date — what was done — evidence -->
```
