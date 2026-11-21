# Client Replication Guide — Estate OS

How a developer takes the core Estate OS repository on GitHub, makes a dedicated copy for a new client, customizes it,
and takes it to production — using Claude Code for each step.

**Read first:** `CLAUDE.md` (architecture and rules), `docs/LOCAL_DEVELOPMENT.md`,
`docs/production/PRODUCTION_DEPLOYMENT_RUNBOOK.md` (the per-release procedure this guide follows in Phase 6) and
`docs/production/PRODUCTION_LAUNCH_CHECKLIST.md`.

**Golden rules for the whole process**

1. **Never paste a secret into Claude Code, a ticket or chat.** API keys go straight into the Supabase dashboard,
   Vercel or your own terminal (`npx supabase secrets set …`). If a key is ever pasted into a conversation, rotate it.
2. **Customize through configuration first, code second.** The fewer files a client copy changes, the easier it is to
   pull core fixes into it later (Phase 8).
3. **No client-only database migrations.** A schema change a client needs goes into the core repository as a general,
   optional feature, then flows to every client. Migrations that exist only in one client repo break the ordering of
   future core migrations.
4. **Production is never edited by hand from Claude Code.** Claude Code may read production (advisors, logs, read-only
   SQL); every write goes through the reviewed release steps in Phase 6.

---

## Phase 0 — Decide the deployment model (once per client)

| Model | When | What the client gets |
|---|---|---|
| **A. New workspace on a shared production** | Small agencies, no code changes, lowest cost | Their own workspace on one shared Estate OS deployment. Data isolation is enforced by row-level security (every table, every request). |
| **B. Dedicated deployment** (this guide) | Branding, custom features, their own domain, their own provider accounts, or a contract that requires separate infrastructure | Their own GitHub repo, Supabase project, Vercel project, domain and provider accounts |

Model A needs no new deployment: the client signs up on the shared site and creates a workspace. The rest of this guide
is model B.

**Account ownership — decide and write down before starting:**

| Service | Recommended owner | Why |
|---|---|---|
| Supabase (production project) | Client's organization, you as member — or yours, billed on | Holds all of the client's data |
| Vercel | Yours or client's | Hosts the frontend only |
| Anthropic (Claude API) | Client's | Usage is billed per call |
| Retell AI + phone number | Client's | Per-minute call costs; the number is theirs |
| Postmark | Client's | Sends from the client's domain |
| Cloudflare (Turnstile) | Client's or yours | Free |
| Domain + DNS | Client's | Needed for email sender verification and the site |

---

## Phase 1 — Create the client repository

The core repository stays the single source of truth (`upstream`). Each client gets a private repository that tracks it,
so core fixes can be merged in later.

1. On GitHub, create an **empty private repository**, for example `estate-os-<client>` (no README, no licence).
2. Clone the core and point it at the new repository:
   ```bash
   git clone https://github.com/akshay0820/estate-os.git estate-os-<client>
   cd estate-os-<client>
   git remote rename origin upstream
   git remote add origin https://github.com/<org>/estate-os-<client>.git
   git push -u origin main
   ```
3. Install and check the baseline (Node 20+):
   ```bash
   cd frontend
   npm ci
   npm run lint && npm run typecheck && npm run check:functions && npm test && npm run build && npm run predeploy
   ```
   Every command must pass **before** any client change. If one fails, fix it in the core repo first.
4. In the client repo on GitHub: **Settings → Actions** is enabled (CI runs on every push) and **branch protection on
   `main`** requires the `ci` check.

**Claude Code:** open the client folder in Claude Code. It loads `CLAUDE.md` automatically, so it already knows the
architecture, the commands and the rules. Ask it to run step 3 and report — it uses the project's own scripts.

---

## Phase 2 — Run it locally

1. **Demo mode (no backend):** `npm run dev` with no `frontend/.env.local` → sample data in the browser only. Use it to
   show the client the product before anything is provisioned.
2. **Live mode against shared staging:** create `frontend/.env.local` with the staging URL and publishable key
   (see `docs/LOCAL_DEVELOPMENT.md`). Build and test client customizations here, in a dedicated test workspace.
3. **Claude Code preview:** `.claude/launch.json` defines `estate-os` (port 5180, live) and `estate-os-demo`
   (port 5181, demo). In the Claude Code desktop app, Claude starts these itself and checks pages in the built-in
   browser after UI changes.

---

## Phase 3 — Collect the client brief

Fill this in before writing any code. Paste it into Claude Code at the start of Phase 4 (it contains no secrets).

```
Client name:                    Agency legal name, trading name
Product name shown to users:    e.g. "Estate OS" or a white-label name
Brand:                          logo (SVG), accent colour (hex), favicon
Production domain:              e.g. app.clientagency.com
Country / currency / timezone:  e.g. US / USD / America/Chicago
Calling hours, business days:   e.g. 9–21, Mon–Sat
Teams and roles:                owner, admins, managers, agents (count of each)
Lead sources:                   website form, portals, ad platforms
Channels in scope:              voice (Retell) yes/no, email (Postmark) yes/no
Voice agent:                    agent name, spoken agency name, voice, inbound/outbound, number
Email:                          sending address, sender name
Agents to enable:               which of the 8 agents; which stay paused at launch
Data to import:                 existing leads/contacts (CSV), listings
Custom features requested:      list — each one becomes a core change or a config change (Phase 4)
Compliance:                     consent rules, recording disclosure, data retention days
```

---

## Phase 4 — Customize

Work in this order. **Start every customization in Claude Code's plan mode** (Shift+Tab until "plan mode" shows), give
it the brief, and approve the plan before it edits anything.

### 4.1 Configuration only — no code changes

These are set in the running app or in the database, not in the repository:

| What | Where |
|---|---|
| Currency, country, timezone | Created with the workspace; owner can change in **Settings** |
| Calling hours, business days | **Settings** (organization settings) |
| Team members and roles | **Team** → invite (owner/admin) |
| Voice calling | **Calls → Voice settings** (Phase 5.4) |
| Email | **Unified inbox → Email settings** (Phase 5.5) |
| Third-party credentials | **Integrations** (stored in Vault) |
| Lead webhook secret | **Integrations → Lead intake webhook** → rotate secret |
| Agent schedules | **Automations** |
| Pause an agent at launch | **Pilot operations** (agent controls) |
| Lead import | **Leads → Import** (CSV) |

### 4.2 Branding — small, contained code changes

Keep all branding edits in one commit titled `Client branding: <client>` so they are easy to see in future merges.

| File | What to change |
|---|---|
| `frontend/index.html` | `<title>` (currently `Estate OS — BlazeReach`) and the favicon |
| `frontend/src/layout/Brand.tsx` | Logo mark, wordmark, the "by BlazeReach" line |
| `frontend/src/styles/tokens.css` | `--ember` / `--accent` (brand colour), light and dark themes |
| `frontend/src/App.tsx` | Product name in the "Page not found" text |
| `supabase/functions/_shared/assistant.ts` | Product name in the Estate AI system prompt |
| `supabase/functions/_shared/retell-agent-config.ts` | `DEFAULT_DYNAMIC_VARIABLES.agency_name`, agent name in `buildRetellAgentConfig` (`agentName` default), `boosted_keywords` |
| `frontend/src/lib/assistantDemo.ts`, `frontend/src/store/seed.ts` | Demo-mode sample data and names (demo mode only). If you change seed content, bump the persist key `estate-os:data:vN` in `frontend/src/store/store.ts` so browsers reload it |

**Claude Code prompt:** *"In plan mode: rebrand the product for <client> using this brief. Find every user-visible
product-name and brand-colour string (grep for Estate OS, BlazeReach, Blaze Estate and the accent token). Don't touch
migrations or test fixtures. Show me the list before editing."* Then run the app in the preview and check the sidebar,
sign-in page, Estate AI panel, light and dark themes.

### 4.3 Voice persona (if voice is in scope)

The voice agent's script, voice and pacing live in `supabase/functions/_shared/retell-agent-config.ts`
(`BLAZE_ESTATE_GENERAL_PROMPT`). Edit the persona name, tone and any client-specific rules there. Keep every existing
guardrail: AI disclosure, no invented listings or prices, no claimed bookings, immediate opt-out. The tests in
`frontend/tests/retell-agent-config.test.ts` fail if a guardrail is removed — they must keep passing.

### 4.4 Feature changes

Every requested feature that is not configuration becomes a change **in the core repository** (as an optional feature,
behind a setting where it is client-specific), then merges into the client repo (Phase 8). Follow `CLAUDE.md`:

- New or changed SQL goes in a **new** migration (`YYYYMMDDHHMMSS_name.sql`), copying the latest definition of any
  function it replaces. Never edit an applied migration. Add it to `docs/DATABASE_MIGRATIONS.md`.
- Permission checks with `public.has_perm(org, 'perm')`, errors with `private.fail('CODE', 'message')`.
- Pages call `src/data/actions.ts`; demo and live stay in step.
- Database tests in `frontend/tests/db/` (PGlite) for every new RPC: permissions, tenant isolation, validation.

**Claude Code workflow for each feature:**
1. Plan mode → approve the plan.
2. Let it implement, then run `npm run lint`, `npm run typecheck`, `npm run check:functions`, `npm test`.
3. Run **`/code-review`** on the diff. For anything touching auth, RLS, RPC permissions, webhooks or secrets, also run
   **`/security-review`**.
4. UI changes: Claude checks them in the built-in browser preview.
5. Apply new migrations to **staging** (Supabase MCP `apply_migration`) and test in the staging test workspace.
6. Commit and open a PR (`gh pr create`); CI must pass before merge.

---

## Phase 5 — Provision the client's production services

Do these in the order shown. Values go into dashboards or your own terminal — **never into Claude Code**.

### 5.1 Supabase production project

1. Create the project in the agreed organization, on a paid plan with **Point-in-Time Recovery** (runbook §1). Pick the
   region closest to the client's users.
2. **Auth → URL configuration:** Site URL and redirect URLs = the production domain.
3. **Auth → Email:** confirmations on; **custom SMTP** (Postmark SMTP works) so invitations and confirmations come from
   the client's domain.
4. **Auth → Attack protection:** leaked-password protection on; CAPTCHA (Turnstile) secret key — see 5.6.
5. Note the project ref. Add it **nowhere** in `predeploy`'s non-production list; add the shared staging ref and any
   client staging refs to `PREDEPLOY_NONPROD_REFS` instead.

### 5.2 Database, functions and worker wiring

Follow `PRODUCTION_DEPLOYMENT_RUNBOOK.md` §4–§8 exactly. Current counts for its checks: **31 migrations**
(latest `20261025003100_email_channel.sql`), **16 Edge Functions**, **13 cron jobs**.

```bash
npx supabase login
npx supabase link --project-ref <client-prod-ref>
npx supabase db push
npx supabase functions deploy --project-ref <client-prod-ref>
```

Then in the SQL editor, one statement per worker (the migrations already created the shared secrets):

```sql
select vault.create_secret('https://<ref>.supabase.co/functions/v1/qualification-worker', 'qualification_worker_url');
select vault.create_secret('https://<ref>.supabase.co/functions/v1/property-matching-worker', 'property_matching_worker_url');
select vault.create_secret('https://<ref>.supabase.co/functions/v1/follow-up-worker', 'follow_up_worker_url');
select vault.create_secret('https://<ref>.supabase.co/functions/v1/calendar-sync-worker', 'calendar_sync_worker_url');
-- Only once voice is approved and tested:
select vault.create_secret('https://<ref>.supabase.co/functions/v1/voice-worker', 'voice_worker_url');
```

### 5.3 Edge Function secrets

Set from your own terminal (`npx supabase secrets set --project-ref <ref> NAME=value …`) or Dashboard → Edge Functions →
Secrets. Check with `npx supabase secrets list` (shows names and hashes only).

| Secret | Required | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes, for any AI step | All agents, Estate AI, call analysis. Without it AI steps record `not_configured` |
| `HEALTH_TOKEN` | Yes | `health` function, uptime monitor |
| `RETELL_API_KEY` | If voice | `voice-calls`, `voice-webhook`, `voice-worker` |
| `POSTMARK_SERVER_TOKEN` | If email | `inbox-email` (sending) |
| `POSTMARK_INBOUND_SECRET` | If email | `email-inbound` (Basic Auth password in the Postmark webhook URL) |
| `*_MODEL` (e.g. `ASSISTANT_MODEL`, `QUALIFICATION_MODEL`, `VOICE_ANALYSIS_MODEL`) | Optional | Model overrides; default `claude-opus-5-5` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase automatically.

### 5.4 Voice (Retell) — if in scope

1. In the client's Retell account: buy or import the phone number. For US destinations prefer a **Retell-native
   number**; a custom SIP (e.g. Twilio-trunked) number needs its trunk allowed to call the destination country.
   *Known issue:* our staging test with a Twilio SIP-imported number returned `404` from `create-phone-call`; resolve
   any such number with Retell before go-live.
2. Push the persona from the client repo (your own terminal, not Claude Code):
   ```bash
   cd frontend
   RETELL_API_KEY=… node scripts/sync-retell-agent.mjs --voice-id <voice-from-retell-dashboard> \
     --webhook-url https://<ref>.supabase.co/functions/v1/voice-webhook
   ```
   It prints the LLM id and agent id. Rerun with `--llm-id` / `--agent-id` to update in place.
3. **Publish the agent** (Retell dashboard, or `POST https://api.retellai.com/publish-agent-version/<agent_id>` with
   `{"version": 0}`). The sync script creates a draft only.
4. In the app: **Calls → Voice settings** — enable, agent id, calling number in strict E.164 **without spaces**
   (`+13025551234`), spoken agency name, consent basis, limits (keep minimum gap at 240 minutes).
5. Create `voice_worker_url` (5.2) only after a successful test call.

### 5.5 Email (Postmark) — if in scope

1. Create a Postmark server. **Sender Signatures → Add Domain**, add the DKIM and Return-Path DNS records, wait for
   verification.
2. **Inbound stream → Settings → Webhook URL:**
   `https://postmark:<POSTMARK_INBOUND_SECRET>@<ref>.supabase.co/functions/v1/email-inbound`
3. Copy the inbound address Postmark shows (`…@inbound.postmarkapp.com`) and the **Server API token**.
4. Set `POSTMARK_SERVER_TOKEN` and `POSTMARK_INBOUND_SECRET` (5.3).
5. In the app: **Unified inbox → Email settings** — from address, sender name, inbound address, enable.

### 5.6 Cloudflare Turnstile

1. Cloudflare dashboard → **Turnstile → Add widget**, domain = the production domain.
2. Site key → Vercel env `VITE_TURNSTILE_SITE_KEY` (5.7). Secret key → Supabase **Auth → Attack protection → CAPTCHA**
   (provider Turnstile).

### 5.7 Vercel (frontend)

1. New Vercel project from the **client** GitHub repo, **Root Directory `frontend/`** (`frontend/vercel.json` holds the
   build settings, security headers and CSP).
2. Production environment variables:
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_ENV=production`, `VITE_TURNSTILE_SITE_KEY`.
3. Add the custom domain; set DNS at the client's registrar.
4. If the client's Supabase uses a **custom domain** instead of `*.supabase.co`, add it to `connect-src` (and `img-src`)
   in `frontend/vercel.json`; `predeploy` checks this.

### 5.8 Monitoring

In the client repo's GitHub **Settings → Variables**, set `HEALTH_URL` and `SITE_URL` for `.github/workflows/uptime.yml`
(see `docs/production/UPTIME_MONITORING.md`). Confirm one test alert reaches the on-call person.

---

## Phase 6 — Release to production

Follow `PRODUCTION_DEPLOYMENT_RUNBOOK.md` end to end. Summary:

1. On the release commit (tagged), from `frontend/`:
   ```bash
   npm ci && npm run lint && npm run typecheck && npm run check:functions && npm test && npm run build
   npm run predeploy -- --env production
   npm audit --omit=dev
   ```
2. Backup check (PITR recovery point recorded), migrations, worker URLs, functions, frontend — runbook §6–§7.
3. Health checks (runbook §8): `GET /functions/v1/health` returns 200; `select jobname, active from cron.job;` shows
   13 active jobs; Security Advisor has no new ERROR; no public table without RLS.
4. Smoke tests with two `smoke-` workspaces (runbook §9–§10). Never use a customer workspace.

**Claude Code's role here:** read-only help. Use the Supabase MCP connected **read-only** to the production project to
run the runbook's verification queries, read advisors and logs, and compare function hashes
(`npm run schema:fingerprint -- --compare remote.json`). The operator runs every write step.

---

## Phase 7 — Onboard the client and go live

1. Owner signs up on the production domain, confirms email, creates the workspace (currency/country/timezone).
2. Owner invites the team (**Team**).
3. Import leads and listings (**Leads → Import**).
4. Connect lead sources: give each source the **lead intake webhook** URL and secret (**Integrations**).
5. Configure voice and email settings (5.4, 5.5), automations, and which agents are paused (**Pilot operations**).
6. **End-to-end proof before calling it live:**
   - one real inbound lead arrives through the webhook and gets qualified;
   - one real AI call to a staff member's own phone, with AI-call consent recorded, completes and shows a summary;
   - one real email received and one reply sent from the Unified inbox.
7. Hand over: training session, `docs/production/PRODUCTION_INCIDENT_RUNBOOK.md` contacts, support channel.

**Legal:** `docs/legal/` are drafts for attorney review only. Do not publish them for a client without the client's
lawyer approving them.

---

## Phase 8 — Maintain and update

### Pull core fixes into a client

```bash
git fetch upstream
git checkout -b update-from-core
git merge upstream/main
cd frontend && npm ci && npm run lint && npm run typecheck && npm run check:functions && npm test && npm run build && npm run predeploy
```

Conflicts should only appear in the branding files (4.2). **Claude Code:** *"Resolve the merge conflicts from
upstream/main, keeping the client's branding and the core's logic; then run all checks."* Open a PR, let CI pass, then
release with Phase 6 (new migrations go through runbook §5 review).

### Routine

| Frequency | Task |
|---|---|
| Daily | Health endpoint, uptime alerts, `cron.job_run_details` failures |
| Weekly | Agent activity and held work (**Pilot operations**), dead letters in `outbox_events`, voice/email delivery issues, AI spend (`ai_usage_summary` RPC, Anthropic console) |
| Monthly | Security Advisor, `npm audit`, dependency updates via core, review call transcripts quality |
| Quarterly | PITR restore drill into a new project (runbook §13) |

---

## Using Claude Code — reference for the team

| Claude Code feature | Use it for |
|---|---|
| **`CLAUDE.md`** (auto-loaded) | Architecture, commands and rules. In a client repo, add a short `## Client: <name>` section at the end listing the client's domain, enabled channels and customizations, so every session knows the context |
| **Plan mode** (Shift+Tab) | Every customization and feature: review the plan before any edit |
| **Supabase MCP server** | Staging: apply migrations, run SQL, deploy functions, read logs and advisors. Production: connect **read-only**, for verification only |
| **Built-in browser preview** (`.claude/launch.json`) | Checking UI changes in live (5180) and demo (5181) mode |
| **`/code-review`** | Every diff before merge |
| **`/security-review`** | Changes to auth, RLS, permissions, webhooks, secrets, CSP |
| **Subagents** (Explore, fork) | Codebase questions and parallel research without filling the main session |
| **`gh` CLI through Claude** | Branches, PRs, CI status |
| **Hooks** (`.claude/settings.json`) | Optional guardrails, e.g. block edits to files under `supabase/migrations/` that are already committed, or run `npm run lint` after edits |
| **Project skills** (`.claude/skills/`) | Optional: turn Phases 3–7 into a `/new-client` checklist skill the team runs per client |

**Prompts that work well**

- *"Read CLAUDE.md and docs/production/CLIENT_REPLICATION_GUIDE.md, then run the Phase 1 baseline checks and report."*
- *"Plan mode. Here is the client brief: … Separate what is configuration (4.1), branding (4.2) and code (4.4)."*
- *"Add <feature> to the core as an optional organization setting. New migration, RPC with has_perm, DB tests for
  permissions and tenant isolation, demo and live clients in step. Then /code-review."*
- *"Using the Supabase MCP read-only on <ref>: run the runbook §8 health queries and list any advisor errors."*

**Never ask Claude Code to:** paste or store a secret, write to a production database directly, run
`sync-retell-agent.mjs` with a real key on your behalf, place real calls or send real emails without the owner's
explicit go-ahead, or skip `predeploy`.

---

## Known gaps to state in every client proposal

- **Channels:** only email is connected in the Unified inbox. WhatsApp and SMS are not built.
- **Live mode placeholders:** Workflows, Approvals and Execution logs show "not connected yet" in live mode.
- **Email AI:** no AI auto-replies to email; a person replies.
- **Voice:** the agent gathers information and hands over; it cannot book or confirm anything during a call.
- **Integrations marketplace:** API-key tools store credentials only; no provider adapter sends or syncs data yet.
  OAuth tools (Google Workspace, Microsoft 365, …) need developer setup per client.
- **Runbook counts:** `PRODUCTION_DEPLOYMENT_RUNBOOK.md` still lists 13 functions and 12 cron jobs; the current numbers
  are in Phase 5.2 of this guide.
