# Security checklist — backend milestone 1

Status as of 2026-10-25. ✅ done and tested (locally and/or against the live "Estate OS" project) · 🟡 done, not verified live · ⬜ not done.

## Identity & sessions
* ✅ Supabase Auth (email/password, PKCE). No custom password storage. Password sign-in verified live.
* 🟡 Sessions refresh automatically; a lost session returns to sign-in with a notice.
* 🟡 Reset links don't reveal whether an account exists.
* ✅ JWT subject (`auth.uid()`) is the only identity used by policies and functions.
* ⬜ MFA for owners/admins (enable in Supabase Auth; UI not built).
* ⬜ Leaked-password protection — dashboard setting to enable.

## Tenant isolation & authorization
* ✅ RLS enabled on every tenant table; policies use `has_perm(org, capability)` from `role_permissions`.
* ✅ Org A users cannot read, insert into, update, or move records of org B (tests).
* ✅ Cross-tenant references rejected (appointments, tasks, deals, leads→contacts, documents paths).
* ✅ `organization_id` immutable; computed/protected columns not writable (column grants).
* ✅ No client insert/delete on memberships; joins only via `create_organization` / invitation acceptance (token hash + email match + expiry, single use).
* ✅ No self role change; only owners grant/remove owner; last active owner protected.
* ✅ Agents edit only their own/unassigned leads; reassignment needs `leads.assign`.
* ✅ Frontend permission matrix tested against the database seed.
* ✅ Anonymous role has no table privileges and cannot call the authorization helpers (verified live: `permission denied`).
* ✅ Suspended members lose access on their next request.

## Data integrity
* ✅ Check constraints (money > 0, budget order, time order, enum values), FKs, unique keys.
* ✅ Status transition rules (lead won terminal, lost → nurture/contacted only; deal closed terminal; commission lifecycle ordered).
* ✅ Appointment double-booking prevented with per-assignee advisory lock + overlap check.
* ✅ Money as `numeric(14,2)`; arithmetic in SQL.

## Audit & observability
* ✅ Append-only `audit_logs` written by definer triggers; owners cannot insert/update/delete.
* ✅ Audit details hold changed column names and safe enum transitions only — no message bodies or secrets.
* ✅ Exports recorded server-side with the verified actor.
* 🟡 Edge Function logs are structured JSON without payload contents (by code review; logs not inspected live).
* ⬜ Alerting on repeated failures / signature failures.

## Files
* ✅ Private bucket; object access requires an authorized `documents` row for that exact path; restricted documents need `documents.restricted`.
* ✅ Paths scoped `org_id/doc_id/file`; no overwrite (no update policy; `upsert:false`).
* 🟡 MIME checked by magic bytes in the client, by DB constraint, and by bucket `allowed_mime_types`; 20 MB limit. (Bucket MIME/size limits not exercised live.)
* ✅ Upload without an authorized `documents` row rejected (verified live).
* ✅ Downloads via 5-minute signed URLs only; another tenant cannot sign the object (verified live).
* ⬜ Malware scanning (not implemented; UI no longer claims it in live mode).

## Webhooks & secrets
* ✅ HMAC-SHA256 over `timestamp.body`, constant-time compare, ±5 min window (unit tests).
* ✅ Idempotent by event id; invalid payloads recorded as failed. Forged requests are recorded as one `rejected` row per org per minute (`record_rejected_webhook`, repeats bump `attempt_count`), so admins see them while unauthenticated callers cannot grow `webhook_events` (verified live).
* ✅ Intake RPCs executable by `service_role` only.
* ✅ Signing secret in Vault, shown once; integrations rows hold only the Vault id.
* 🟡 Function returns the same 404 for unknown org and disabled intake (no workspace enumeration) — unknown org verified live; disabled intake not probed.
* ✅ Deployed with JWT verification off; forged/stale signatures → 401, replays idempotent, bodies over 64 KB (counted in bytes, reading stops at the cap) → 413, non-UTF-8 bodies → 400 (verified live).
* ⬜ Rate limiting on the intake endpoint (rely on platform limits for now; add per-org limit before public launch).
* ✅ No secrets in the repo; `.env.local` ignored; only `VITE_SUPABASE_URL` and the publishable key reach the browser.

## Browser
* ✅ No `dangerouslySetInnerHTML`; React escaping throughout.
* ✅ Live mode keeps tenant data in memory only (no `localStorage` persistence).
* 🟡 Session token in `localStorage` (supabase-js default) → XSS is the main risk. ✅ Strict Content-Security-Policy in `frontend/vercel.json` (scripts from the site only, no inline scripts; `npm run predeploy` checks both and that `connect-src` allows `VITE_SUPABASE_URL`). The policy also blocks the Vercel preview toolbar (`vercel.live`): the toolbar is turned off for Preview with `VERCEL_PREVIEW_FEEDBACK_ENABLED=0` (set on the `estate-os` Vercel project, Preview environment, 2026-10-30) rather than widening the policy. A copy of the product on a new Vercel project needs the same variable, or the toolbar turned off in Settings → General → Vercel Toolbar.
* ✅ Bearer-token auth (no ambient cookies) → classic CSRF not applicable.

## Known gaps / follow-ups
1. Live API verification done (42/42, 2026-10-25). Still to do by a person: browser sign-in on the live project, confirmation/reset emails (needs Auth URL config + SMTP), and removing the `e2e-a/b@estate-os.test` test accounts before launch.
2. MFA, leaked-password protection, CSP headers, intake rate limiting.
3. Outbound communication (calls/messages) intentionally not implemented; consent table and kill switch are in place for when it is.
4. `SECURITY DEFINER` functions reviewed for fixed `search_path` and explicit permission checks; re-review on every change. Supabase security advisor: only the intended signed-in RPC warnings remain (see `DATABASE_MIGRATIONS.md`).
