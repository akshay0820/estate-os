# Estate OS — frontend

The web client for **Real Estate AI OS** (BlazeReach), built from `real_estate_ai_os_prd.md`,
`SYSTEM_ARCHITECTURE.md`, `DATABASE_SCHEMA.md` and `SECURITY.md` in the parent folder.

```bash
npm install
npm run dev        # http://localhost:5180
npm run build      # typecheck + production bundle in dist/
```

## What's here

Every screen from the PRD's navigation (§7.1) is implemented and interactive:

| Area | Screens |
|---|---|
| Overview | Dashboard (date ranges, period comparison, funnel, arrival heatmap, SLA, spend), Activity feed |
| Sales | Leads (table + drag-and-drop board, filters, bulk actions, CSV import/export, duplicate detection, merge), Contacts (consent per channel), Properties (grid/table, verification freshness, matching leads), Deals (pipeline board, weighted forecast), Appointments (week calendar with conflict checks), Tasks |
| Communications | Unified inbox (take over / resume AI, internal notes, suggested replies, opt-out handling), Calls (policy-gated AI calls with live state), Follow-ups |
| AI operations | Agents (autonomy, tool allow-list, budgets, evals), Workflows (test runs), Approvals, Execution logs (retry / dead-letter), Usage & costs |
| Business | Marketing sources, Team (invites, roles, last-owner guard), Finance (commission lifecycle, expenses), Reports (metric definitions) |
| Administration | Documents (validated upload, classification), Integrations (webhook endpoint, secret rotation, event replay), Audit logs, Settings |

Global: light/dark theme, collapsible sidebar, organization switcher (two isolated tenants),
"View as role" to see the permission-aware UI, command palette (`Ctrl K` or `/`), notifications,
and an outbound kill switch.

## How it works

**Live mode** (when `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are set): data lives in Supabase Postgres.
Every request runs as the signed-in user and is authorized by Row Level Security; multi-step operations are
Postgres functions; audit, history and notifications are written by database triggers. Schema and rules live in
`../supabase/migrations`. Pages call `src/data/actions.ts`, which calls `src/backend/live.ts`.

**Demo mode** (no Supabase configured): after an explicit choice on the start screen, the app runs on deterministic
sample data in the browser (`src/store/`), clearly marked "Demo data". Demo data is never sent anywhere.

```bash
npm test          # database (PGlite) + unit tests
npm run typecheck
npm run build
```

Docs: `../docs/BACKEND_IMPLEMENTATION_PLAN.md`, `API_IMPLEMENTATION_STATUS.md`, `DATABASE_MIGRATIONS.md`,
`LOCAL_DEVELOPMENT.md`, `SECURITY_CHECKLIST.md`.
