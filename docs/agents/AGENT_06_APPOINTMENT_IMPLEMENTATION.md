# Agent 06 — AI Appointment Agent (`appointment_agent`)

Status: **implemented, tested, applied and verified live** (2026-10-26). Sections 1–9 are the plan; 10 onward record what was built.

## 1. Discovered architecture (2026-10-26)

| Area | Found | Decision |
|---|---|---|
| Appointments | `public.appointments`: types `viewing / consultation / valuation / follow_up`; statuses `requested / pending / confirmed / reschedule_requested / cancelled / completed / no_show`; `starts_at` / `ends_at` timestamptz (UTC); `timezone` set from the org; `assigned_to`, `property_id`, `lead_id`, `location_text`, `source` | **Reused.** Types and statuses kept (`pending` = pending confirmation). Columns added for reference, version, idempotency, calendar sync, history |
| Validation | Trigger `appointments_before`: org business hours (days + hours, org time zone), "not in the past", viewing needs an active property, and **per-person advisory lock + overlap check** (concurrency-safe for staff) | Kept, and extended by a second BEFORE trigger: buffers, staff working hours, time off / closures, property double-booking (property lock), state machine, version |
| Side effects | `appointments_after`: activity, lead → `visit_scheduled` / `visit_completed`, assignee notification | Kept. A new AFTER trigger adds history, events and the Agent 05 handoff, so **every write path** (RPC or direct) behaves the same |
| Slots | `appointment_free_slots`: org hours + staff overlap only, no buffers / property / closures | Superseded by `appointment_availability` (kept for compatibility) |
| Client writes | The live UI inserted appointments directly and could pick `confirmed` | The UI now uses RPCs (idempotent, availability-checked). Direct writes remain for authorized staff but pass the same triggers; terminal states are locked |
| Staff hours / time off / property restrictions | None | New `staff_working_hours`, `availability_blocks` (closure, time off, property unavailable, external busy) |
| **Calendars** | **None.** `integrations.integration_type` allows `calendar`, but no provider code, tokens or webhooks | Integration **boundary** only: sync state per appointment, a claim / result protocol with stale-version protection, an adapter registry (empty), and a busy-period import. With no calendar connected, the internal calendar is the source of truth (`calendar_sync_status = not_required`). Nothing is reported as synced without a provider |
| Messaging | Agent 05: policy-checked drafts, manual send (no provider) | Confirmations, reschedule / cancellation notices and reminders are Agent 05 follow-ups tied to the appointment **version** |
| Time zones | Org IANA zone (`organizations.timezone`, default `Asia/Kolkata`); no staff or contact time zone | Staff hours and slots use the org zone; Postgres `AT TIME ZONE` handles DST. Nonexistent local times are skipped |

## 2. Appointment types and resources

| Type | Needs | Exclusive resources |
|---|---|---|
| `viewing` | Active property in the org; a staff member | Staff (with buffer), property (no overlapping viewings) |
| `consultation` / `valuation` | Staff; a location or link entered by a person | Staff |
| `follow_up` (call-back / meeting) | Staff | Staff |

No meeting links are generated (no meeting provider).

## 3. Availability (`appointment_availability`, deterministic)

1. **Window:** local dates in the org zone, clamped to `now + min_notice` … `now + horizon_days`.
2. **Candidate staff:** the requested person, else the lead's eligible owner, else active members who can book (max 10).
3. **Working windows:** the person's `staff_working_hours` for that weekday if any exist, otherwise the org business hours and days.
4. **Candidates:** every `slot_step` minutes, duration from the type (configurable). A slot must:
   - fit the window;
   - not hit a closure, the person's time off, external busy time, or a property restriction;
   - leave a `buffer` before and after the person's other active appointments;
   - not overlap another viewing of the same property.
5. **Calendar connected:** a person whose busy data is stale or failed is **unverified**. Their slots are not offered and the result says `unverified` (not "no slots").
6. **Ranking:** inside the preferred local time window first, then by start time, then by the person's load that day.
7. **Result:** `ok`, `no_slots`, `unverified` or `invalid` (with reasons), plus slots with UTC timestamps and local labels.

## 4. Booking, conflicts, lifecycle

- **`appointment_book`:**
  - Idempotent per key.
  - Locks the person, then the property (advisory transaction locks).
  - Re-runs every check; the trigger repeats the core ones under the same locks.
  - Status:
    - staff booking → `confirmed`;
    - AI / service booking → `pending` (a person confirms);
    - calendar unverified → `requested` + a review task;
    - `require_calendar_sync` with a calendar connected → `pending` until the sync succeeds.
- **State machine** (enforced in the trigger for every path):

  | From | To |
  |---|---|
  | `requested` | `pending`, `confirmed`, `reschedule_requested`, `cancelled` |
  | `pending` | `confirmed`, `reschedule_requested`, `cancelled` |
  | `confirmed` | `completed`, `no_show`, `reschedule_requested`, `cancelled` |
  | `reschedule_requested` | `pending`, `confirmed`, `cancelled` |
  | `cancelled`, `completed`, `no_show` | terminal; no time, person or status change |

- **Version:** incremented on every time, person or status change. Events, Agent 05 messages and calendar sync results carry it, and stale ones are ignored or cancelled.
- **Reschedule:** one atomic update, validated under the locks. If the new slot fails, nothing changes and the original booking stays.
- **Cancel:** idempotent; needs a reason; the record is kept.
- **History:** `appointment_history` records every change (old and new time, status, person).

## 5. Calendar boundary

- With a connected calendar integration (`integration_type = 'calendar'`, `status = 'connected'`), every booking change sets `calendar_sync_status = pending`.
- The `calendar-sync-worker` Edge Function claims jobs (lease, version) and calls the provider adapter. Outcomes:

  | Outcome | Result |
  |---|---|
  | `synced` | Stores `external_event_id` |
  | `transient` | Retried with backoff |
  | `ambiguous` | Fails, plus a task to check; never re-created blindly |
  | `permanent` / `unsupported` | Fails, plus a task |

- A result for an older version is ignored.
- Busy periods arrive through `calendar_busy_replace` (service role), which records freshness per person.
- **No adapter exists in this product**, so nothing is synced or imported until one is added; with no calendar connected, sync is `not_required`.

## 6. Events and Agent 05

- **Published** (ids + version only): `appointment.requested`, `.confirmed`, `.rescheduled`, `.cancelled`, `.completed`, `.no_show`, `.calendar_sync_failed`.
- **Agent 05 runs** (in the same transaction, idempotent per appointment and version):
  - confirmation on confirm or reschedule;
  - cancellation notice, only if a confirmation was sent;
  - reminder created by the appointment tick ~`reminder_hours_before` ahead.
- **Before any send**, Agent 05 checks:
  - the appointment still exists, has the same version and the right status, and is in the future;
  - consent and window;
  - for reminders, that they are due.

  A version change cancels pending appointment messages immediately.

## 7. Claude

The `appointment-assistant` Edge Function (user JWT) turns a sentence ("tomorrow afternoon, 45 minutes") into dates and a time window, resolved against the org's current local date and time zone. The output is schema-validated (real dates within the horizon, a valid window and duration), then **slots come only from `appointment_availability`**. With no key it returns `not_configured` and the UI uses the date / time pickers.

## 8. Security

- RLS read with `leads.view`. Booking and changes need `appointments.edit`; settings need `settings.manage`. A person may edit their own hours and time off; property restrictions need `properties.edit`.
- Lead, property and staff are always resolved within the caller's org.
- Calendar tokens never reach the client or the model (there are none yet).

## 9. Tests

- **PGlite:** slot generation (hours, buffers, closures, time off, property, notice, horizon, DST), booking, idempotency, conflicts (staff and property), state machine, reschedule safety, cancel, history, versions, events, Agent 05 confirmation / cancellation / reminder with stale suppression, calendar sync outcomes and stale results, unverified calendars, tenant isolation.
- **Node:** assistant output validation.
- **Live:** cron chain, real concurrent booking race against hosted Postgres, cross-tenant checks.

## 10. What was built

| Piece | Where |
|---|---|
| Migration (additive) | `supabase/migrations/20261025001500_appointment_agent.sql` — tables `scheduling_settings`, `staff_working_hours`, `availability_blocks`, `calendar_sync_state`, `appointment_history`; new `appointments` columns (reference, version, idempotency key, correlation id, pending reason, change reason, confirmed at / by, calendar sync state); `follow_ups.appointment_id` / `appointment_version` and three appointment purposes |
| Rules and helpers | `private.ap_rules` (defaults + per-org overrides), `ap_windows` (working windows per local date, DST via `AT TIME ZONE`), `ap_in_hours`, `ap_conflict` (closure → time off / busy → property restriction → staff overlap with buffer → property double-booking), `ap_staff_verified` |
| Triggers | `appointments_guard` (BEFORE: state machine, reference, version, working hours, property lock, conflicts, calendar sync flag) and `appointments_lifecycle` (AFTER: history, `appointment.*` event, stale-message cancellation, Agent 05 enqueue) |
| User RPCs | `appointment_availability`, `appointment_book`, `appointment_confirm`, `appointment_reschedule`, `appointment_cancel`, `appointment_set_outcome`, `appointment_detail`, `scheduling_settings_save`, `staff_working_hours_save`, `availability_block_add`, `availability_block_remove` |
| Service functions | `appointment_tick` (reminders, calendar lease reconciliation), `calendar_sync_claim`, `calendar_sync_result`, `calendar_busy_replace`, `calendar_sync_worker_secret_ok` — `service_role` only |
| Agent 05 integration | `fu_create` replaced (appointment messages dedupe per appointment and version); `fu_execute`, `fu_render`, `fu_content_problem`, `fu_policy` wrapped (originals renamed `*_base`): appointment templates, `APPOINTMENT_CHANGED` send-time check, transactional exemption from frequency limits (consent, window and suppression still apply), reminder due-gate |
| Crons | `appointment-tick` (SQL, every minute); `calendar-sync-worker` (pg_net → Edge Function, Vault URL + secret) |
| Edge Functions | `calendar-sync-worker` (secret-checked; adapter registry empty → `unsupported`); `appointment-assistant` (user JWT; Claude interprets text → validated dates / window → `appointment_availability` as the user) |
| Shared modules | `_shared/calendar-sync.ts` (adapter seam, outcome mapping, timeout → ambiguous); `_shared/scheduling-assistant.ts` (JSON schema, zod validation, prompt, `localToday` via Intl) |
| Frontend | `backend/live.ts`: booking / status / reschedule via RPCs, `appointmentAvailability`, `appointmentDetail`, `appointmentAgentOverview`. `features/appointments.tsx`: slot finder (verified slots only), no client-side hour guessing, drawer with reference, calendar state, pending reason, customer messages and history. `features/agentsLive.tsx`: Agent 06 card |

## 11. Event contract

Every event goes through `private.emit_event` into `public.outbox_events` in the same transaction as the change, with dedupe key `<event>:<appointment_id>:<version>`.

| Event | When |
|---|---|
| `appointment.requested` | Created as `requested` / `pending`, or moved back to it |
| `appointment.confirmed` | Created confirmed, or confirmed later |
| `appointment.rescheduled` | Time changed (including `reschedule_requested` → `confirmed` with a new time) |
| `appointment.reassigned` | Only the person changed |
| `appointment.reschedule_requested` / `.cancelled` / `.completed` / `.no_show` | Status changes |
| `appointment.calendar_sync_failed` | Provider failure, ambiguous result or expired lease |

Payload: `event_type`, `schema_version` (1), `organization_id`, `appointment_id`, `lead_id`, `property_id`, `version`, `status`, `correlation_id`, `occurred_at`. No names, phone numbers or message text.

## 12. Tests and results (2026-10-26)

- **Full suite: 195 / 195 pass** (17 files, `npx vitest run`). Typecheck clean; production build OK.
- `tests/db/appointment-agent.test.ts` (12 tests, PGlite with all migrations):
  - real slots inside hours with notice, horizon, buffers, preferred window;
  - property double-booking, closures, time off, property restrictions;
  - input validation (inactive property, missing property, bad window);
  - DST: working windows in `Europe/London` across the October change;
  - idempotent booking and conflicts;
  - AI / service bookings stay `pending` until a person confirms the current version;
  - state machine (terminal states, idempotent cancel with reason);
  - atomic reschedule (a conflict keeps the original, a stale version is refused, history keeps both times);
  - Agent 05: confirmation with reference, stale confirmation cancelled on reschedule, reminder due-gated, cancellation notice only when a confirmation was sent;
  - calendar: unverified hides slots, busy import blocks time, sync outcomes, stale results, lease expiry;
  - settings validation and permissions;
  - tenant isolation.
- `tests/appointment.test.ts` (6 tests, Node): interpretation validation (horizon, past dates, ranges, windows), `localToday` via Intl, adapter outcome mapping, timeout → ambiguous.
- **Live on "Estate OS"** (test workspaces only): **28 / 28 pass**.
  - Availability is verified, deterministic and respects notice.
  - A staff booking is confirmed with a reference; the same key replays it; the booked time and its buffer leave availability.
  - **Parallel race from two sessions: exactly one booking succeeds, the other gets `APPOINTMENT_CONFLICT`, and the database holds one row.**
  - Bookings outside hours or inside the notice period are refused.
  - Agent 05 drafts the confirmation through the real crons (pending approval, not sent).
  - Stale-version and conflicting reschedules are refused and the original time is kept. A valid reschedule bumps the version, cancels the v1 confirmation and drafts a v2 one; history records both.
  - Another workspace cannot read, cancel, search or book (`NOT_FOUND`); history is not user-writable.
  - Cancel is idempotent, leaves no sendable message, and the terminal state is enforced; no cancellation notice is drafted when nothing was sent.
  - Calendar claim is service-only; the worker rejects a wrong secret (401); the assistant answers `not_configured` without a key (503) and requires sign-in (401).
  - Outbox for the test appointment: `appointment.confirmed` v1 → `.rescheduled` v2 → `.cancelled` v3.
- Migration applied as version `20261025215932`; all 32 function bodies match the file (md5 of `prosrc`); crons `appointment-tick` and `calendar-sync-worker` are active. Security advisors: no new finding types (user RPCs are SECURITY DEFINER with their own permission checks, as before; service functions are not exposed).
- Browser (signed in, live mode): the booking modal shows verified slots from the server, and "Choose the property to view first" for a viewing without one. The drawer shows the reference, "No calendar connected — this record is the source of truth", both cancelled confirmations and the v1 → v3 history. The agents page shows "6 of 8 built" and the Agent 06 card.

## 13. Setup and operations

- Nothing to configure for internal scheduling. Org business hours apply until a person's weekly hours are saved (`staff_working_hours_save`).
- Optional: `ANTHROPIC_API_KEY` (and `APPOINTMENT_MODEL`) as Edge Function secrets enable the natural-language assistant; without them it answers `not_configured`.
- Vault: `calendar_sync_worker_secret` (generated by the migration) and `calendar_sync_worker_url` (set on 2026-10-26). The worker does nothing until an organization connects a calendar **and** an adapter exists.
- Per-org rules via `scheduling_settings_save`: durations, buffer, notice, horizon, step, max slots, reminder lead time, `require_calendar_sync`, `ai_bookings_need_confirmation`.

## 14. Limitations

- **No calendar provider adapter.** External calendars are neither written nor read. A connected calendar integration would make every sync fail visibly (`unsupported` plus a task), never report success.
- Staff hours use the org time zone (no per-person or per-contact time zone in the schema).
- No meeting links (no meeting provider). No customer self-service booking page.
- Messages are drafted and policy-checked by Agent 05 but sent manually by a person (no messaging provider).
- The `appointment-assistant` was not exercised against the model (no API key configured); its validator is unit-tested.
- The older `appointment_free_slots` RPC is kept for compatibility and does not know buffers or blocks; the UI no longer uses it.
- No settings UI yet for working hours, time off, closures or scheduling rules (the RPCs exist and are tested).

## 15. Next step: Agent 07 (CRM & Data Intelligence)

Agent 07 can consume the `appointment.*` events and history (attendance, no-show rate, time-to-visit, reschedule churn) together with the data from Agents 01–05, for lead summaries, data hygiene and conflict detection. Keep the same rules: deterministic computations in SQL, Claude only for summaries with validated output, tenant-scoped reads, additive migrations.
