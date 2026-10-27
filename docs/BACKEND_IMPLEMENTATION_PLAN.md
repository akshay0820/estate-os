# Backend implementation plan — Real Estate AI OS

**Status:** living document · **Date:** 2026-10-25
**Inputs:** `real_estate_ai_os_prd.md`, `SYSTEM_ARCHITECTURE.md`, `DATABASE_SCHEMA.md`, `SECURITY.md`, the `frontend/` codebase.
(No `API_SPECIFICATION.md`, `AI_AGENT_ARCHITECTURE.md` or `WORKFLOW_ENGINE_SPECIFICATION.md` exist; API contracts below are derived from the PRD §13 and the frontend's needs.)

---

## 1. Existing architecture (audit)

| Item | Finding |
|---|---|
| Frontend | Vite 5 + React 18 SPA, TypeScript 5.6 (strict), npm |
| Routing | Hand-rolled hash router (`src/lib/router.ts`), 24 pages lazily loaded (`src/App.tsx`) |
| State | Zustand store (`src/store/store.ts`) persisted to `localStorage`; deterministic seed data (`src/store/seed.ts`) |
| Data fetching | None — every page reads tenant-scoped lists through `store/hooks.ts → useOrgList()` |
| Business rules | Client-side in `src/lib/domain.ts` (policy gate, matching, scoring, conflicts) and in store actions |
| Auth | **None.** Current user is hard-coded (`aanya@skylinerealty.in`); "View as role" is a UI preview |
| Database / backend | **None in the repo.** No API routes, no migrations, no env files, no tests |
| UI kit | Own components (`components/ui.tsx`, `charts.tsx`, `dialogs.tsx`), hand-written CSS tokens |
| Validation | Inline form checks only; no library |
| Deployment | None configured; `npm run build` produces a static bundle |

**Supabase account (inspected read-only):** one free organization, two active projects.
`Blaze Estate OS` contains an earlier, **incompatible single-tenant schema** (16 migrations; tables such as `leads`, `clients`, `agents` with JSON `data` columns and no `organization_id`; all tables empty). It is not referenced by this repository. Re-using it would require dropping its tables, so it is **left untouched**. A new project was approved by the owner but Supabase rejected creation (free-plan limit of 2 active projects) — see §7 Blockers.

## 2. Pages and their data requirements

| Page | Reads | Writes | Milestone |
|---|---|---|---|
| Dashboard | aggregate metrics, upcoming appointments, tasks due | — | **M1** (server RPC `dashboard_metrics`) |
| Activity feed | activities (paged) | — | **M1** |
| Leads | leads (server-paged, filtered, sorted), counts per quick view | create, update, status, assign, archive, merge, import/export, notes | **M1** |
| Contacts | contacts + consents (paged) | edit, consent, opt-out | **M1** |
| Properties | properties | create, edit, verify, archive | **M1** |
| Deals | open + recently closed deals | create, stage move, edit | **M1** |
| Appointments | appointments in a date window | book (conflict-checked), reschedule, cancel, complete, no-show | **M1** |
| Tasks | tasks | create, edit, complete, cancel | **M1** |
| Team | memberships + profiles + invitations | invite, role change, suspend, revoke | **M1** |
| Settings | organization settings | update settings, kill switch | **M1** |
| Audit logs | audit_logs (paged) | export | **M1** |
| Notifications (top bar) | notifications for me | mark read | **M1** |
| Documents | documents | upload (Storage), classify, delete, signed URL | **M1** (storage) |
| Integrations | webhook events, integrations | rotate secret, replay | **M2** (intake Edge Function + RPC ready in M1) |
| Finance | commissions, expenses | advance commission | M2 (commissions already written by deal triggers) |
| Inbox, Calls, Follow-ups, Agents, Workflows, Approvals, Execution logs, Usage, Marketing, Reports | provider- and AI-dependent data | — | M2–M3; in connected mode these pages show an honest "not connected yet" state instead of sample data |

## 3. Existing backend functionality
None. All behaviour is simulated in the browser. The client-side rules are a useful *specification* and are ported to the database where they protect data (scoring, status transitions, booking conflicts, consent).

## 4. Database & auth state
No database or auth in the repo. Target: Supabase Postgres + Supabase Auth (email/password) + Supabase Storage, as recommended by the PRD §11.1.

## 5. Missing backend capabilities (M1 scope)
Authentication; profiles; organizations, memberships, invitations; capability-based authorization; tenant-isolated CRM tables; server-side business rules; activity, audit and notification records; dashboard aggregation; document storage; webhook lead intake.

## 6. Recommended architecture

**Keep the Vite SPA. Do not migrate to Next.js** — that would rebuild the frontend, which the brief forbids without need. The "server" is Supabase:

```
Browser (Vite SPA, publishable key + user JWT)
  └── supabase-js ──► PostgREST ──► Postgres
                          │            ├── RLS on every tenant table  (authorization boundary)
                          │            ├── constraints + triggers      (integrity, history, audit)
                          │            └── RPC functions               (multi-step operations, transactional)
                          ├──► Supabase Auth (sessions, password reset)
                          └──► Storage (private bucket, path-scoped policies)
Providers ──► Edge Function `lead-intake` (HMAC verify) ──► RPC `ingest_lead` (service role only)
```

* **Identity** is verified server-side: PostgREST validates the JWT; `auth.uid()` is the only identity used in policies.
* **Tenant access** is derived from `organization_memberships` (status `active`) — never from a client-supplied organization id.
* **Capabilities** live in `role_permissions` and are checked with `has_perm(org, perm)` in policies and RPCs. The frontend mirrors the same matrix only to shape the UI; a test keeps them in sync.
* **Cross-tenant references** (e.g. an appointment pointing at another org's lead) are rejected by triggers.
* **Business operations that must be atomic** (create lead with dedupe + assignment, deal won → commission + lead + property, booking with conflict lock, invitations) are Postgres functions. Ordinary CRUD goes through PostgREST under RLS.
* **Audit and system activity** are written by `SECURITY DEFINER` triggers; authenticated users have no insert/update/delete on `audit_logs`.
* **No service-role key in the browser.** It is used only by the Edge Function.
* **CSRF:** supabase-js sends the JWT in the `Authorization` header (no ambient cookies), so classic CSRF does not apply. The session lives in `localStorage`, so XSS is the main session risk → strict CSP recommended at deploy.
* **Demo mode** (existing sample data) remains available only when no Supabase URL is configured, behind an explicit, labelled choice. It never mixes with real data and never persists real records.

## 7. Documentation conflicts / ambiguities and decisions

| # | Conflict | Decision |
|---|---|---|
| 1 | Lead statuses: PRD (incl. matching, visit_completed, nurture) vs schema (incl. disqualified, viewing_scheduled) | Use the PRD set the UI already uses: `new, attempting, contacted, qualified, matching, visit_scheduled, visit_completed, negotiation, won, lost, nurture` |
| 2 | Deal stages: schema `completed/cancelled` vs UI `won` | `qualification, viewing, offer, negotiation, under_contract, won, lost` |
| 3 | Roles: PRD lists 6, schema 7 (`operations`) | Implement all 7; `operations` gets inventory + operational scope |
| 4 | `profiles` has no email; Team page needs it | Add `profiles.email`, synced from `auth.users` by trigger, readable only by people sharing an organization |
| 5 | `desired_locations jsonb`, `features[] + amenities jsonb` | `text[]` columns (`desired_locations`, `amenities`) — one representation each, as the schema doc itself recommends |
| 6 | Consents in a separate table vs UI map | `communication_consents` table (per channel, purpose `service`), exposed to the UI as a map |
| 7 | Archive vs soft delete | Leads use `archived_at` (user-reversible); no hard deletes from the client |
| 8 | Webhook secrets "not in tables" | Stored in Supabase Vault; `integrations.secret_reference` holds only the Vault id |

**Blockers**
* Remote database: project creation rejected (free-plan active-project limit). Migrations are written and verified locally; applying them needs one existing project paused/upgraded, or another target chosen by the owner.
* Email delivery for invitations/password reset uses Supabase's built-in mailer (rate-limited on free plans); custom SMTP is an owner setup task.
* No voice/WhatsApp/AI provider credentials exist — those features stay unconnected (not simulated) in connected mode.

## 8. Security risks (and mitigations)
| Risk | Mitigation |
|---|---|
| Cross-tenant reads/writes | RLS + membership helper + cross-reference triggers + `organization_id` immutability; tested with 2 orgs × 4 roles |
| Privilege escalation via membership edits | Only `team.manage` may change memberships; self-role changes blocked; only owners grant `owner`; last active owner protected |
| Joining an org without authorization | No insert policy on memberships; only `create_organization` / `accept_invitation` (token hash + email match + expiry) create them |
| Forged audit history | No client write access to `audit_logs`; written by definer triggers |
| `SECURITY DEFINER` misuse | Fixed `search_path`, explicit membership/permission checks inside, `EXECUTE` revoked from `public`/`anon` |
| Mass assignment | RPCs accept explicit parameters; column-level grants block client writes to computed/protected columns (score, timestamps, org id) |
| Private files | Private bucket; object path `org/<org_id>/…` checked against membership + permission; signed URLs only |
| Webhook forgery/replay | HMAC-SHA256 over raw body with timestamp tolerance; unique `(provider, provider_event_id)` |
| XSS stealing session | No `dangerouslySetInnerHTML`; React escaping; CSP documented |

## 9. Phases
1. **Foundation** — env config, Supabase client, auth screens, profiles, organizations, memberships, invitations, permissions.
2. **Database & security** — CRM schema, constraints, indexes, RLS, triggers, audit; PGlite test harness with Supabase auth shim; isolation + escalation tests.
3. **Core APIs** — RPCs + PostgREST access for leads, contacts, properties, deals, tasks, appointments, activities, notifications, dashboard metrics.
4. **API standards** — typed API module with one error format, pagination limits, whitelisted sort/filter fields.
5. **Frontend integration** — connected mode wiring per page; demo mode kept separate.
6. **Storage** — documents bucket and policies, upload/download via signed URLs.
7. **Intake & jobs** — `ingest_lead` RPC + `lead-intake` Edge Function (HMAC, idempotency).
8. **AI & automation** (M2+) — not started; prerequisites in place (consent table, kill switch setting, activity provenance).

## 10. Dependencies
1 → 2 → 3 → (4, 6, 7) → 5. Phase 5 for each page depends on that page's API in 3. Phase 8 depends on 2, 3 and 7.

## 11. Acceptance criteria
* **P1:** sign up / sign in / sign out / reset work; a user without membership sees onboarding only; org creation makes the creator owner.
* **P2:** every tenant table has RLS; tests prove org A cannot read or write org B, agents cannot do admin actions, nobody can self-escalate or self-join, cross-tenant references and org transfers fail.
* **P3:** each RPC validates input, membership and permission; dashboard numbers are SQL aggregates over real rows and return zeros for empty orgs.
* **P4:** errors map to `{ error: { code, message, details } }`; page size ≤ 100.
* **P5:** connected pages show loading / empty / error states, persist every mutation, and contain no sample data.
* **P6:** files outside the caller's org path are unreadable; MIME + size validated.
* **P7:** bad signature → 401 and nothing written; same event twice → one lead.
* **Verification:** `npm run typecheck`, `npm test`, `npm run build` pass.
