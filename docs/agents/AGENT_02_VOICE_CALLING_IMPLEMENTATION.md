# Agent 02 — AI Voice Calling Agent (`voice_calling_agent`)

Status: **implemented; provider integration not yet exercised with real credentials** (2026-10-25). Sections 1–9 are the plan; 10 onward record what was built and verified.

## 1. Existing architecture (audited 2026-10-25)

| Area | Found | Reuse |
|---|---|---|
| Backend | Supabase Postgres + RLS; business rules in SECURITY DEFINER RPCs (`search_path = ''`); Deno Edge Functions for provider traffic | Same pattern: SQL owns state and rules, Edge Functions own HTTP to Retell/Claude |
| Calls | **No call tables.** `DATABASE_SCHEMA.md` §8.6–8.9 specifies `calls`, `call_transcripts`, `communication_events`. The Calls page, the lead "AI qualification call" button and `outboundPolicy()` exist in **demo mode only** | Build the tables per the spec (named `voice_calls`, `voice_call_transcripts`, `voice_call_events`) and connect the existing UI places |
| Consent | `communication_consents (contact, channel, purpose, status)` with purposes `service`, `marketing`, `ai_call`, `appointment_reminder`; `contacts.lifecycle_status = 'do_not_contact'`; `opt_out_contact`; kill switch `settings.outbound_paused`; `settings.calling_hours`, `business_hours`, org `timezone` | All pre-call checks use these. `ai_call` consent is distinct from phone `service` consent |
| Permissions | `calls.place` (owner/admin/manager/agent), `calls.recordings` (owner/admin/manager), `integrations.manage`, `logs.view` | Initiation, transcript/recording access, settings, runs |
| Agent runtime (from Agent 01) | `agent_runs`, `agent_run_steps`, `outbox_events` + `outbox_claim/ack`, `review_items`, pg_cron worker | One run per call (`agent_id = 'voice_calling_agent'`); handoff events through the outbox |
| Intake (Agent 01) | `intake_receive` / `intake_process` with `source_kind = 'voice'` | Inbound calls from unknown numbers become leads through the intake agent |
| Claude | `@anthropic-ai/sdk@0.133.0` in Edge Functions; evidence-checked structured extraction pattern | Same pattern for post-call analysis |
| Retell | Nothing | New provider adapter |

## 2. Verified Retell contract (docs.retellai.com, read 2026-10-25)

- Create call: `POST https://api.retellai.com/v2/create-phone-call`, `Authorization: Bearer <key>`.
  - Body: `from_number`, `to_number` (both E.164).
  - Optional: `override_agent_id`, `metadata`, `retell_llm_dynamic_variables`.
  - Optional `idempotency_key` (5–255 chars, `[A-Za-z0-9_-]`): resending it within **1 hour** returns the same call instead of creating another one.
  - Responds 201 with `call_id`, `agent_id`, `call_status` (`registered | not_connected | ongoing | ended | error`).
- Get call: `GET https://api.retellai.com/v2/get-call/{call_id}`.
- Webhooks:
  - Delivered as a POST of `{event, call}`.
  - Default events are `call_started`, `call_ended` and `call_analyzed`. Calls that never connect get no `call_started`, but still get `call_ended` and `call_analyzed`.
  - A 2xx must arrive within 10 s, otherwise the webhook is retried up to 3 times.
  - Deduplicate on `event + call_id`.
- Signature: header `X-Retell-Signature: v=<unix ms>,d=<hex>`.
  - The digest is `HMAC_SHA256(key = API key with the webhook badge, message = raw_body + timestamp)`.
  - Reject the request when the timestamp is more than 5 minutes off.
  - Allowlisted source IP: 100.20.5.228.
- Call fields used:
  - Identity and routing: `call_id`, `agent_id`, `direction`, `from_number`, `to_number`.
  - Timing: `start_timestamp`, `end_timestamp` (ms) and `duration_ms`.
  - Outcome: `disconnection_reason`, with values such as `user_hangup`, `agent_hangup`, `user_requested_dnc`, `user_requested_callback`, `call_transfer`, `voicemail_reached`, `dial_busy`, `dial_failed`, `dial_no_answer`, `invalid_destination` and `error_*`.
  - Content: `transcript`, `recording_url` (signed and expiring when `opt_in_signed_url` is set), and `call_analysis.{call_summary, in_voicemail, user_sentiment, call_successful, custom_analysis_data}`.

## 3. Approach

```text
UI (lead drawer / Calls page) ──JWT──► Edge fn voice-calls  POST /call {lead_id, idempotency_key}
   1. voice_call_request (SQL, as the user): permission, tenant, policy, limits → reserves voice_calls row 'initiating'
   2. RetellVoiceProvider.createPhoneCall(idempotency_key = internal call id)
   3a. 201 → voice_call_mark_initiated (provider call id, status 'dialing')
   3b. definite 4xx → voice_call_mark_failed
   3c. timeout / 5xx / network → stays 'initiating'; worker re-sends the SAME idempotency key (safe ≤ 1 h), then 'unknown'
Retell ──signed──► Edge fn voice-webhook → verify → voice_webhook_ingest (SQL, one transaction):
   dedupe (event+call_id) → resolve call by provider id (tenant from OUR row, never from metadata)
   → monotonic state transition → transcript (if allowed) → outcome, opt-out, handoff, lead activity → 204
   → EdgeRuntime.waitUntil(Claude analysis) for completed calls
pg_cron ──pg_net──► Edge fn voice-worker (shared secret from Vault): analysis retries, initiation reconciliation, stale calls
SQL: voice_call_finalize → voice_call.completed (+ handoff / opt-out events) through outbox_events
```

## 4. Database changes (additive migration 0010)

- `voice_settings` (one row per org):
  - enabled flag, Retell outbound agent id and inbound agent id (each unique across orgs), from number, spoken agency name;
  - consent basis (`ai_call` or `phone`), recording/transcript flags, Claude analysis flag, transcript retention days;
  - per-lead and daily limits, minimum gap between attempts.
- `voice_calls`: the call record.
  - Status, direction, provider ids, numbers, timestamps, duration, disconnection reason, outcome, summary.
  - Analysis status and result, handoff, opt-out, `idempotency_key` unique per org, `correlation_id`.
- `voice_call_transcripts`: separate table, readable only with `calls.recordings`, with a `retain_until` date.
- `voice_call_events`: webhook dedupe ledger, unique on `(provider, event_key)`.
- New RPCs:
  - for users: `voice_call_preflight`, `voice_call_request`, `voice_settings_save`, `set_ai_call_consent`, `voice_call_detail`;
  - service-role only: the webhook/worker functions.
- Worker: pg_cron job calls the Edge worker through `pg_net`, with the shared secret kept in Vault.

## 5. Call lifecycle

`initiating → dialing → in_progress → completed | no_answer | busy | voicemail | failed`. A call can also end as `unknown` (initiation outcome unknowable) or `blocked` (never sent).

- Status only moves forward: an event can never move a call back to an earlier stage.
- Terminal states are final, so late or duplicate webhooks cannot rewrite them.
- Duration comes only from provider timestamps.

## 6. Security

- Tenant identity:
  - Outbound calls: derived from the authenticated user's membership plus a tenant-scoped lead lookup.
  - Webhooks: from the stored call row, or for inbound calls from the org whose configured inbound agent id matches.
  - Provider metadata is never trusted for tenant identity.
- Users cannot choose the Retell agent, number or settings. Those come from `voice_settings`, which only `integrations.manage` can save.
- All pre-call checks run in deterministic SQL:
  - consent, `do_not_contact`, kill switch, calling hours and days in the org timezone;
  - frequency, the daily cap, one active call per lead, and a valid E.164 number.
- Opt-out:
  - Triggered by provider `user_requested_dnc` or an analysis flag.
  - Revokes phone consent for every purpose and emits `lead.communication_opted_out`.
  - The preflight blocks all later calls to that contact.
- Transcripts are kept only when the org allows it, and are readable only by `calls.recordings`.
- Recordings are never stored as URLs. They are fetched on demand through the authorized Edge endpoint, which returns Retell's (signed, when enabled) link.
- Secrets live only as Edge Function secrets (`RETELL_API_KEY`, `ANTHROPIC_API_KEY`). The frontend only ever sees a "configured: yes/no" flag.

## 7. Agent 3 handoff

`voice_call.completed` (consumer `sales_qualification_agent`):
- Sent once per call, after the call is terminal and analysis has finished, been skipped, or permanently failed.
- Payload: ids, outcome code, and a `requires` list. No transcript or contact data.

Also emitted:
- `voice_call.human_handoff_requested`, which creates a task and notifies the lead's owner;
- `lead.communication_opted_out`.

## 8. Testing plan

PGlite tests, no real calls. They cover:
- preflight and request rules;
- tenant isolation of calls, transcripts and settings;
- idempotent requests;
- the state machine, including out-of-order and duplicate events;
- inbound call ownership resolution;
- opt-out enforcement and handoff tasks;
- analysis application that fills only empty fields;
- finalize/outbox events and the reconcile query.

Unit tests cover:
- signature verification against the documented algorithm;
- the provider error classification;
- Claude output validation.

Live checks:
- function deploys;
- unsigned or forged webhooks are rejected;
- `/status` reports "not configured";
- requests while not configured return an explicit error;
- preflight blocks correctly.

## 9. Phases

1. Discovery and this doc.
2. Migration.
3. Provider adapter and the `voice-calls` function.
4. Webhook.
5. Analysis and worker.
6. Handoff events.
7. Dashboard: lead call panel, live Calls page, settings card.
8. Tests, live apply/deploy and docs.

---

## 10. What was built

| Piece | Where |
|---|---|
| Schema, policy, state machine, opt-out, handoff, analysis apply, finalize/outbox, worker SQL, cron | `supabase/migrations/20261025001000_voice_calling_agent.sql` |
| pg_net moved out of `public` | `supabase/migrations/20261025001100_pg_net_schema.sql` |
| `RetellVoiceProvider` (create call, get call, signature, failure classification, payload parsing) | `supabase/functions/_shared/retell.ts` |
| Post-call analysis schema, prompt, evidence-checked validation | `supabase/functions/_shared/voice-analysis.ts` |
| Claude call + dispatch helper (shared) | `supabase/functions/_shared/voice-runner.ts` |
| Signed-in API: `/status`, `/call`, `/recording` | `supabase/functions/voice-calls/index.ts` (JWT verified, deployed v1) |
| Retell webhook | `supabase/functions/voice-webhook/index.ts` (signature-verified, deployed v1) |
| Worker (retries, reconciliation, analysis, retention) | `supabase/functions/voice-worker/index.ts` (Vault shared secret, deployed v1; pg_cron every minute) |
| UI | `frontend/src/features/voice.tsx`:<br>• lead **AI call** modal with server-side checks and AI-call consent capture<br>• lead **AI calls** history<br>• live **Calls** page with call detail and **Voice settings**<br>`agentsLive.tsx`: Voice agent card<br>`backend/live.ts`: API calls |
| Tests | `frontend/tests/db/voice-agent.test.ts` (19), `frontend/tests/voice.test.ts` (9) |

### Call lifecycle as implemented

- **Statuses:**
  - Normal path: `initiating → dialing → in_progress → completed | no_answer | busy | voicemail | failed`.
  - `unknown` means we cannot know whether Retell dialed.
  - `blocked` means the policy refused the call; it was recorded with the reason and never sent.
- **Status mapping:** Retell's `disconnection_reason` is mapped in exactly one function (`private.voice_terminal_status`):
  - `user_requested_dnc` → opt-out;
  - `user_requested_callback` → handoff.
- **Order and duplicates:** transitions only move forward, so late `call_started` / `call_ended` events after a terminal state are logged as `stale`. Duplicates (same `event + call_id`) are dropped by the `voice_call_events` unique key before any side effect.
- **Duration:** taken only from Retell's `duration_ms` (or its start/end timestamps).
- **Ambiguous initiation:**
  - Timeouts and 5xx keep the call `initiating`.
  - The worker re-sends with the **same** `idempotency_key` (the internal call id) while inside Retell's 1-hour window. After 55 minutes the call becomes `unknown` and is never re-sent.
  - Definite 4xx responses fail the call immediately.
  - Reservations that never reached Retell are closed after 5 minutes.
- **Missing webhooks:** calls with no terminal event for 2 hours are reconciled through `get-call`. After 3 failed fetches they are closed as `unknown`.

### Claude post-call analysis

- **When it runs:** only when the agency enabled it, transcript storage is on, and the call actually connected.
  - It runs after the webhook has been acknowledged (`EdgeRuntime.waitUntil`).
  - Retries go through the worker: up to 3 attempts with backoff, then `failed`. The call record is always kept and the handoff still happens.
- **Model call:** `claude-opus-5-5` at low effort, with structured JSON output and a server-side refusal fallback. Only the transcript plus the org's currency/country is sent.
- **Validation:** every field and flag must quote the customer's own words from the transcript, otherwise it is dropped. The result is then normalized by the same SQL as Agent 01.
- **Applying it to the lead:**
  - Only **empty** lead fields are filled.
  - Differing values are stored as `conflicts` (the event carries `requires: ["review_conflicts"]`) and are never overwritten.
  - A detected opt-out always suppresses calls (conservative). A human or call-back request creates the handoff.

## 11. Agent 3 contract

`outbox_events`:
- **Event:** `event_type = 'voice_call.completed'`, consumer `sales_qualification_agent`, `dedupe_key = 'voice_call_completed:<call_id>'`.
- **When:** emitted once per call, after the call is terminal **and** analysis has succeeded, been skipped, or permanently failed.
- **Payload:**
```json
{ "event_type": "voice_call.completed", "schema_version": 1, "organization_id": "…", "lead_id": "…", "call_id": "…",
  "provider_call_id": "…", "correlation_id": "…", "occurred_at": "…", "direction": "outbound|inbound",
  "outcome": "connected|no_answer|busy|voicemail|failed|opted_out|callback_requested|unknown",
  "analysis_status": "succeeded|skipped|failed", "requires": ["human_callback", "phone_opt_out", "review_conflicts"] }
```
- **Consuming:** use `outbox_claim('sales_qualification_agent', ['voice_call.completed', 'lead.ready_for_qualification'], n)` and `outbox_ack`, as for Agent 01. Re-read the lead and `voice_calls` row through the backend; the payload carries no transcript or contact data.
- **Other events (published, informational):**
  - `voice_call.human_handoff_requested`: `{call_id, lead_id, kind}`. A high-priority call-back task is created for the lead owner; if there is no eligible owner, everyone with `leads.assign` is notified.
  - `lead.communication_opted_out`: `{contact_id, lead_id, channel: "phone", source, call_id}`. Phone consent is revoked for every purpose.
- **Inbound calls from unknown numbers:** handed to Agent 01 (`intake_receive` with `source_kind = 'voice'`, `trigger = 'call.lead_created'`). Its `lead.ready_for_qualification` event then follows the normal path.

## 12. Tests and results (2026-10-25)

| Check | Result |
|---|---|
| `npm test` | **113/113 pass**: 19 voice DB tests, 9 voice unit tests, and all 85 earlier tests |
| `npm run typecheck`, `npm run build` | pass |
| Live boundary checks (`agent02_live.mjs`, scratchpad) | **17/17 pass** (below) |
| Live cron → `voice-worker` | `net._http_response` shows HTTP 200 `{"redispatched":0,"reconciled":0,"analysed":0}` |
| Function bodies live vs file | all 25 md5-identical |
| Security advisor | pg_net-in-public warning fixed by 0011. New "signed-in users can execute SECURITY DEFINER" warnings are expected for the 6 user RPCs, which all check permissions |
| Browser (owner of E2E Realty A) | **Calls page:** honest "not active" banner, empty state, settings dialog.<br>**Lead "AI call" modal:** shows the server's checks, disables "Place AI call", offers consent capture.<br>**Agents page:** Voice card shows "needs setup / Retell API key not set" |

DB tests cover:
- **Settings:** validation, and Retell agent uniqueness across workspaces.
- **Consent:** explicit consent is required (unknown ≠ permission).
- **Requests:** blocked attempts are recorded; requests are idempotent per key; one active call per lead; the minimum gap is enforced.
- **Dispatch:** sends minimal dynamic variables. Ambiguous failures stay retryable inside the 1-hour window and become `unknown` after it. Unsent reservations are closed.
- **Webhooks:**
  - ordered events, plus duplicate and stale events;
  - duration taken from the provider;
  - transcript storage;
  - lead status → contacted;
  - recording URL never stored;
  - `call_analyzed` arriving before `call_ended`; no-answer calls.
- **Outcomes:**
  - provider opt-out revokes phone consent and blocks every later call, and AI consent cannot be re-granted over it;
  - a call-back request creates a task for the owner plus the handoff event;
  - analysis fills only empty fields, records conflicts and strips injected keys;
  - analysis failures retry, then finalize.
- **Matching:**
  - metadata hint linking only on matching number and agent;
  - inbound ownership by agent id (a forged `metadata.organization_id` is ignored);
  - unknown callers become leads through Agent 01.
- **Worker:** reconciliation of stale calls; transcript retention purge.
- **Security:**
  - service-role-only functions;
  - no direct writes;
  - tenant isolation of calls, transcripts, recordings, settings and consent;
  - agents get no transcripts or recordings, and viewers see nothing;
  - the kill switch and calling hours are enforced.

Unit tests cover:
- the signature algorithm, including tampering, wrong key, stale and malformed headers;
- failure classification;
- request-body mapping;
- the documented endpoint, timeouts reported as ambiguous, and 422 as permanent;
- event parsing;
- recording URLs never kept;
- analysis evidence checks, extra keys, ranges and inverted budgets.

Live checks cover:
- the webhook returns 503 while Retell is unconfigured and 405 for non-POST;
- the worker returns 401 without the secret;
- the API returns 401 without a session;
- `/status` returns booleans only;
- `/call` returns 503 `NOT_CONFIGURED` with nothing reserved;
- preflight blocks;
- enabling without an agent or number is refused;
- the other org cannot preflight, request, change settings, record consent or see calls;
- users cannot call ingestion or dispatch.

**Not executed:**
- No real phone call, and no real Retell webhook. There is no Retell account or key, and tests never dial.
- No real Claude analysis call (no `ANTHROPIC_API_KEY`).

## 13. Setup (external accounts required)

1. **Retell account:**
   - Create or import a phone number. India destinations need your own telephony (SIP), since Retell numbers only call US destinations.
   - Create the voice agent with the prompt in §14.
   - In Retell, enable **signed URLs** (`opt_in_signed_url`) on the agent, so recording links expire.
2. **Webhook:**
   - Point the agent-level (or account-level) webhook URL to `https://jvdnapofyoarhfctbpyi.supabase.co/functions/v1/voice-webhook`.
   - Keep the default events (`call_started`, `call_ended`, `call_analyzed`).
3. **Server secrets** (Supabase dashboard → Edge Functions → Secrets, or the CLI). Never put them in the repo or in chat:
   - `RETELL_API_KEY`: the Retell API key **with the webhook badge**. It both places calls and verifies webhook signatures.
   - `ANTHROPIC_API_KEY`: optional; enables post-call analysis (and Agent 01 extraction).
   - Optional: `VOICE_ANALYSIS_MODEL` (default `claude-opus-5-5`).
4. **In the app** (Calls → Voice settings, needs `integrations.manage`):
   - Enter the agent id(s), calling number and spoken agency name, then enable AI calling.
   - Choose the consent basis, transcript storage and retention, analysis, recording access and limits.
   - Calling hours and days come from the organization settings.
5. **Consent:** a call is allowed only when the contact has **AI-call consent** recorded (or phone consent, if you choose that basis). Record it from the lead's AI call dialog, stating how it was captured.
6. **Verify without a real call:**
   - Calls → banner shows "AI calling is on".
   - A lead's AI call dialog shows all checks green.
   - Optionally, send a signed test event to the webhook (sign `body + ms` with your key, as `voice.test.ts` does): an unknown `call_id` is acknowledged and logged as `unmatched`.
7. **Staging test:** call a test number you own, with consent recorded on that contact. Check that:
   - the call moves Dialing → In progress → Completed;
   - the activity appears;
   - `voice_call.completed` is queued.

Workers: nothing to start. pg_cron calls `voice-worker` every minute (URL and secret in Vault). `lead-intake-worker` runs in SQL.

## 14. Recommended Retell agent prompt (configure in Retell)

Available per call (dynamic variables): `{{agency_name}}`, `{{customer_first_name}}`, `{{known_intent}}`, `{{known_locations}}`, `{{known_budget}}`, `{{known_property_type}}`, `{{known_bedrooms}}`, `{{known_timeline}}`.

> You are a virtual assistant calling on behalf of {{agency_name}}, a real-estate agency. Open with: "Hello{{customer_first_name}}, this is the virtual assistant calling on behalf of {{agency_name}} about your recent property enquiry. Is now a convenient time for a brief conversation?"
>
> **Always:**
> - If asked whether you are an AI, say yes.
> - Never claim to be a person or a licensed agent.
> - Be brief and polite, and let the person interrupt.
> - Do not repeat a question that has already been answered; already known: intent {{known_intent}}, locations {{known_locations}}, budget {{known_budget}}, type {{known_property_type}}, bedrooms {{known_bedrooms}}, timeline {{known_timeline}}.
> - Ask only about what is missing, and only while the conversation allows it: buy/rent/sell/invest, preferred area, approximate budget, property type, bedrooms, timeline.
>
> **Never:**
> - Never mention specific properties, prices, availability, discounts, legal terms or agency policies.
> - Never promise a viewing, a call-back time or that anything "has been booked or updated". Say a team member will confirm.
>
> **When the call needs to change course:**
> - If the person asks not to be called again, acknowledge it, thank them and end the call (use **end call with reason "user requested do-not-call"**).
> - If they want a person, or a call back, acknowledge it, say a team member will call back, and end the call (use the **callback** end reason).
> - If they are driving, busy or distressed, offer a call back and end the call.
>
> Do not collect ID numbers, financial account details or other sensitive data.

Recording/transcription notice: if your jurisdiction or policy requires it, add the notice to the opening line in Retell, and keep **Store transcripts** off until it is in place.

## 15. Limitations

- **Untested against real services.** The integration is verified against Retell's documented contract, but no live call or real webhook has been exchanged yet. Neither has a real Claude call.
- **One Retell account for the platform.** The key is a single server secret. Per-workspace Retell keys would need per-tenant secret storage and signature verification by tenant.
- **No live transfer.** A "human" request becomes a call-back task. Transfers configured in Retell are recorded only through `disconnection_reason = call_transfer` (outcome connected).
- **Mid-call tools are not exposed.** Retell function calls into the OS (`search_properties`, `request_appointment`) do not exist yet. The agent therefore cannot quote listings or book; this is deliberate until Agents 4 and 6.
- **Recordings stay at Retell.** They are fetched on demand. If signed URLs are off in Retell, the returned link is Retell's unsigned URL.
- **Retention:**
  - Transcripts are purged by retention (default 90 days).
  - Call summaries and analysis stay on the call record; no retention rule applies to them yet.
  - Blocked attempts are kept for audit.
- **Calling windows:**
  - The calling window uses org-level hours and days only.
  - No per-contact time zone, and no national DND-registry lookup. India's TRAI DND checks, for example, would need a registry provider.
- **Minimum gap:** the 5-minute minimum gap between attempts is the floor; production defaults are 240 minutes and 2 per day.

## 16. Next step: Agent 3 (Sales & Qualification)

Build Agent 3 as a scheduled consumer of `outbox_claim('sales_qualification_agent', ['lead.ready_for_qualification', 'voice_call.completed'])`. For each event it should:
1. Read the lead and, where present, the call row and its `analysis` (the `conflicts` and `unanswered_questions`).
2. Decide the next qualification action. When information is missing and consent and policy allow it, that action can be a `voice_call_request`.
3. Treat `requires` as human work, not AI work.
4. Ack the event after its own state is durably written.

It can reuse `agent_runs`, `review_items` and the outbox unchanged.
