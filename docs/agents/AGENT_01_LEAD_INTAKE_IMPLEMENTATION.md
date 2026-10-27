# Agent 01 — AI Lead Intake Agent (`lead_intake_agent`)

Status: **implemented and verified** (2026-10-25). Sections 1–10 are the plan written after the audit; sections 11–19 record what was built and tested.

## 1. Current architecture (audited 2026-10-25)

| Layer | What exists | Where |
|---|---|---|
| Frontend | Vite + React SPA, Supabase JS with the publishable key; RLS does the authorization | `frontend/src/backend/live.ts` |
| Database | Supabase Postgres, multi-tenant by `organization_id`, RLS on every tenant table, business rules in triggers and SECURITY DEFINER RPCs with `search_path = ''` | `supabase/migrations/*` |
| Intake endpoint | Edge Function `lead-intake`: HMAC (`timestamp.body`) per organization, secret in Vault, 64 KB streamed cap, strict zod schema, then `ingest_lead` RPC as service role | `supabase/functions/lead-intake`, `_shared/intake.ts` |
| Tests | Vitest + PGlite running every migration on a Supabase shim; RLS exercised as `authenticated` | `frontend/tests/db/*` |

**No agent runtime existed**: no agent run table, no outbox, no review queue, no worker. The Agents, Workflows, Approvals and Logs pages are marked "not connected" in live mode.

## 2. Existing functionality reused

- `leads`, `contacts`, `communication_consents`, `lead_assignments`, `lead_status_history`, `activities`, `notifications`, `audit_logs` (row triggers already write history, activity, audit and assignee notifications).
- `webhook_events` remains the integration-event ledger (unique `organization_id, provider, provider_event_id`).
- `leads_external_id_uniq` (`organization_id, source, source_external_id`) for Layer-1 dedupe.
- `private.pick_assignee` (least-loaded / round-robin / by-locality among active `agent` members), `private.assert_member`, `private.assert_same_org`, `private.normalize_phone`, `private.notify`, `private.write_audit`.
- `create_lead` (manual entry, interactive duplicate prompt) and the CSV import that calls it.
- The HMAC verification and body-cap code in the Edge Function.

## 3. Lead data model

`contacts (1) ── (n) leads`. A lead always has a contact (`contact_id` is immutable after insert). Contact identity keys are `email_normalized` and `phone_e164`, both computed by the contacts trigger and indexed (not unique: shared family phones are legitimate). The lead carries the requirement fields (`desired_transaction`, `lead_type`, `budget_min/max`, `budget_currency`, `desired_property_type`, `desired_locations`, `bedrooms`, `timeline`, `required_amenities`) and source attribution (`source`, `source_campaign`, `source_external_id`).

Added by this agent (only what the schema lacked):

| Addition | Why |
|---|---|
| `leads.intake_status` (`completed`, `review_required`) and `leads.duplicate_status` | The UI must show intake/duplicate state from the backend; guarded so clients cannot write them |
| `agent_runs`, `agent_run_steps` | Durable, observable execution state, retries, idempotency per trusted event id |
| `outbox_events` | Reliable handoff to the next agent (transactional with the lead write) |
| `review_items` | Ambiguous duplicates go to people; nothing is auto-merged |
| `organizations.settings.intake` (optional) | Source → agent rules and the fallback assignee |

## 4. Intake entry points

| Source | Path | Status |
|---|---|---|
| Authorized webhook (website forms, portals, CRM pushes) | `lead-intake` Edge Function → `intake_receive` → optional Claude extraction → `intake_process` | implemented |
| Manual entry in the OS | `create_lead` RPC (user decides on duplicates interactively) → trigger records an intake run and the handoff | implemented |
| CSV import | frontend → `create_lead` with `ask` (duplicates skipped) → same trigger | implemented |
| Retell inbound call (`call.lead_created`) | would call `intake_receive` with `p_source_kind = 'voice'` from a Retell webhook function | integration point only — no Retell account/webhook exists |
| Other integrations | any service-role caller of `intake_receive` with its own provider name | integration point |

## 5. Deduplication strategy (tenant-scoped, inside one transaction)

1. **Event idempotency** — `agent_runs (organization_id, agent_id, idempotency_key)` unique, key = `provider:event_id`. A redelivered event returns the first outcome; nothing is rewritten.
2. **Layer 1, external id** — `external_lead_id` (or the event id) against `leads (organization_id, source, source_external_id)`. A hit is the same enquiry: enrich empty fields only.
3. **Layer 2, normalized contact keys** — `phone_e164` and `email_normalized` against the organization's contacts.
   - High confidence: exactly one contact matches, no supplied identifier contradicts it, and (for a phone-only match) the names share a token → link.
   - Ambiguous: two different contacts match, or a supplied identifier contradicts the match, or a phone-only match with unrelated names → create a separate contact + lead, mark `review_required`, open a `review_items` row with the candidates.
4. **Layer 3, names** — name similarity alone never links or merges. It is used only to downgrade a phone-only match to ambiguous.

Concurrency: transaction-scoped advisory locks on each normalized identifier (sorted, so no deadlocks) serialize two different events for the same person; the run row is locked `for update` so two deliveries of the same event cannot both process.

Linking policy (high confidence): if the contact has an open lead (not won/lost/archived), the enquiry becomes a "Repeat enquiry" activity on that lead and only **empty** fields are filled — existing values are never overwritten or nulled; otherwise a new lead is created on the existing contact. Missing email/phone on the contact is added, never replaced.

Limitations: no fuzzy matching on emails/phones (typos create a new contact), no cross-source person resolution beyond phone/email, families sharing a phone are only caught when names differ.

## 6. Lead assignment rules (deterministic, in order)

1. Lead already assigned (repeat enquiry) → keep.
2. Property rule: `property_ref` resolves to a property in the same organization whose `listing_agent_id` is an active member.
3. Source rule: `settings.intake.source_rules[].source` equals the lead source (case-insensitive) and the user is an active member.
4. Continuity: existing contact's `assigned_to`, if an active member.
5. Organization policy: `private.pick_assignee` (`settings.assignment`: least_loaded / round_robin / by_locality) among active agents, serialized per organization with an advisory lock so round-robin is concurrency-safe.
6. Fallback: `settings.intake.fallback_user_id` if an active member.
7. Otherwise unassigned queue (lead stays `assigned_to = null`, visible in the Unassigned view).

Every candidate is checked with `private.is_active_member`; invalid configured ids fall through to the next rule and are recorded in the run steps. The chosen rule is written to `lead_assignments.reason`.

## 7. Event-processing design

```text
webhook ─► Edge Function (verify HMAC, size, schema)
          ─► intake_receive(org, provider, event_id, payload)   — run row 'received' (idempotent)
          ─► [optional] Claude extraction ─► intake_attach_extraction(run, json)  — validated again in SQL
          ─► intake_process(run)  — one transaction: normalize → dedupe → write → assign → activity → outbox
pg_cron (every minute) ─► private.intake_process_due()  — abandoned 'received' runs and retryable failures
```

Run states: `received → succeeded | review_required | invalid` and on unexpected errors `retry_scheduled` (backoff 1, 2, 4, 8 min) → `dead_letter` after 5 attempts. A failed attempt rolls back all of its writes (sub-transaction), so a retry starts clean; the Claude result is stored on the run before processing, so retries never call the model again.

Outbox events (schema_version 1, minimal payload, ids only):

| Event | When | Consumer |
|---|---|---|
| `lead.intake_completed` | run succeeded (payload: duplicate and assignment outcome) | informational |
| `lead.review_required` | ambiguous duplicate | informational (review queue is the action) |
| `lead.ready_for_qualification` | lead clean and not awaiting review; once per lead | `sales_qualification_agent` |
| `lead.intake_failed` | dead letter or quarantine | informational |

Consumers use `outbox_claim(consumer, types, limit)` (`for update skip locked`, lease 5 min) and `outbox_ack(id, ok, error)`.

## 8. Security considerations

- Organization context comes only from the verified signing secret (webhook) or `auth.uid()` membership (manual). Payload fields such as `organization_id` are rejected by the strict schema; the model never sees or returns ids.
- All new RPCs are SECURITY DEFINER with `search_path = ''`; intake RPCs are granted to `service_role` only; review resolution requires `leads.merge` in the review's organization.
- New tables have RLS; clients have no insert/update/delete. Leads' intake columns are forced by trigger for client writes.
- Cross-tenant: property, contact, lead and assignee ids are always re-resolved with `organization_id = run.organization_id`.
- Logs carry ids, outcomes and timings only — no names, phones, emails or message text.
- Claude: only the free-text message and the org's currency/country are sent; output is schema-validated in TypeScript and again in SQL; no tools; 10 s timeout, one retry.

## 9. Implementation phases

1. Audit + this plan. 2. Intake service (normalize/validate). 3. Dedupe + review queue. 4. Assignment. 5. Runs, outbox, retries, cron. 6. Claude extraction. 7. Frontend (lead intake/duplicate status, review resolution, source). 8. Tests + live verification. 9. Docs.

## 10. Acceptance criteria

- Structured lead → contact + lead + assignment + activity + `lead.ready_for_qualification`, verified by tests and live.
- Same event twice (sequential and concurrent) → one lead, one handoff event.
- Ambiguous match → separate lead, `review_required`, review item, no handoff until resolved.
- Cross-tenant contact/property/assignee impossible; users cannot call intake RPCs or forge intake columns; invalid signatures rejected.
- Model failure → structured intake still succeeds; invalid model output ignored.
- Typecheck, build and all tests pass.

---

## 11. What was built

| Piece | Where |
|---|---|
| Tables, lead columns, pipeline, review, outbox, privileges | `supabase/migrations/20261025000800_lead_intake_agent.sql` |
| Worker schedule (pg_cron, every minute) | `supabase/migrations/20261025000900_intake_worker_schedule.sql` |
| Webhook entry (HMAC → receive → optional Claude → process) | `supabase/functions/lead-intake/index.ts` (deployed v4, `verify_jwt = false`) |
| Claude call (SDK `@anthropic-ai/sdk@0.133.0`, structured output, 10 s timeout, 1 retry, server-side refusal fallback) | `supabase/functions/lead-intake/extract.ts` |
| Extraction schema, prompt, untrusted-output validation | `supabase/functions/_shared/extraction.ts` |
| Webhook payload shape (strict) | `supabase/functions/_shared/intake.ts` |
| Lead screen: "Review" badge, header badge, Intake panel with review resolution | `frontend/src/features/leads.tsx` (`IntakePanel`), `backend/live.ts`, `backend/mappers.ts`, `store/types.ts` |
| Tests | `frontend/tests/db/intake-agent.test.ts`, `frontend/tests/extraction.test.ts` |

There was no agent runtime to reuse, so this adds the minimal shared pieces. `agent_runs` / `agent_run_steps` (keyed by `agent_id`), `outbox_events` + `outbox_claim` / `outbox_ack`, and `review_items` are written generically so Agents 2–8 can use them unchanged. Agent-specific code lives only in the `intake_*` functions.

### Tools (backend functions; the model never calls any of them)

| Conceptual tool | Implementation |
|---|---|
| validate_lead_payload / normalize_lead_fields | zod shape check in the Edge Function; `private.intake_normalize` (authoritative) |
| search_possible_duplicates / get_existing_contact / get_existing_lead | Layers 1–3 inside `private.intake_execute` (tenant-scoped, advisory-locked) |
| create_lead / create_contact_if_required / link_lead_to_contact / update_lead_fields | `private.intake_execute` (fills empty fields only) |
| get_assignment_policy / get_eligible_agents / assign_lead | `private.intake_assign` + `private.intake_eligible` + existing `private.pick_assignee` |
| create_activity | `private.agent_activity` (actor "Lead Intake Agent") + existing lead triggers |
| create_review_item | `review_items` insert + notifications to `leads.merge` holders; `public.resolve_intake_review` |
| emit_business_event | `private.emit_event`, `private.emit_ready_for_qualification` |

### Public API (RPC)

| RPC | Caller | Purpose |
|---|---|---|
| `intake_receive(org, source_kind, provider, event_id, payload, trigger?)` | service role | Durable, idempotent run; returns `needs_extraction` |
| `intake_attach_extraction(run, extraction, meta)` | service role | Stores the validated model proposal (or only its failure metadata) |
| `intake_process(run)` | service role | One transactional attempt; replays the result for finished runs |
| `intake_process_due(limit)` | service role / pg_cron | Abandoned runs (>2 min) and due retries |
| `outbox_claim(consumer, types, limit)` / `outbox_ack(event, consumer, ok, error)` | service role | Lease-based delivery for the next agents |
| `lead_intake_summary(lead)` | signed-in (`leads.view`) | Read model for the lead screen |
| `resolve_intake_review(review, decision, keep_lead?)` | signed-in (`leads.merge`) | Human decision on ambiguous matches (`distinct` or `duplicate`) |
| `ingest_lead(...)` | service role | Kept for compatibility; delegates to receive + process |

## 12. Event contracts (schema_version 1)

Every `outbox_events` row has:
- `event_type`, `schema_version` and `organization_id`;
- `record_type` and `record_id`;
- `correlation_id` (the run's);
- `payload`;
- a `dedupe_key` that is unique per organization.

| Event | Consumer / status | `dedupe_key` | Payload |
|---|---|---|---|
| `lead.ready_for_qualification` | `sales_qualification_agent` / `pending` | `ready_for_qualification:<lead_id>` (once per lead) | `event_type, schema_version, organization_id, lead_id, source = "lead_intake_agent", correlation_id, missing_information[]` |
| `lead.intake_completed` | none / `published` | `intake_completed:<run_id>` | `run_id, result, duplicate, assignment` |
| `lead.review_required` | none / `published` | `review_required:<review_id>` | `review_id, reasons[]` |
| `lead.intake_failed` | none / `published` | `intake_failed:<run_id>` | `run_id, reason (validation or retries_exhausted), errors?` |

The duplicate-detection and assignment outcomes are carried in `lead.intake_completed`, not as separate events. No event carries names, phone numbers, emails or message text.

## 13. Configuration

| Setting | Where | Default |
|---|---|---|
| Assignment policy | `organizations.settings.assignment` (existing) | `least_loaded` |
| Source → user rules, fallback assignee, extraction on/off | `organizations.settings.intake = {source_rules: [{source, user_id}], fallback_user_id, extraction_enabled}`; validated on save, and users must be active members | absent (no rules, extraction on) |
| Claude API key | Edge Function secret `ANTHROPIC_API_KEY` | **not set**: extraction is skipped and recorded as `disabled` |
| Model | Edge Function secret `INTAKE_MODEL` | `claude-opus-5-5`, effort `low` |
| Worker | pg_cron job `lead-intake-worker` | every minute, up to 25 runs |

To turn extraction on, the project owner sets the key themselves, never in chat or the repo: `supabase secrets set ANTHROPIC_API_KEY=… --project-ref jvdnapofyoarhfctbpyi`. The intake rules have no settings screen yet; they are edited in `organizations.settings`.

## 14. Tests and results (2026-10-25)

| Check | Result |
|---|---|
| `npm test` (PGlite, migrations 0001–0009) | **85/85 pass**: 25 Agent 01 DB tests and 5 model-output tests, plus the existing 55, which are unchanged (the original webhook idempotency test now runs through the agent) |
| `npm run typecheck` / `npm run build` | pass |
| Live run (hosted project, function v4, scratchpad script `agent01_live.mjs`) | **18/18 pass** (below) |
| Supabase security advisor after 0008 | No RLS findings. The only new warnings are the expected "signed-in users can execute SECURITY DEFINER" ones for `lead_intake_summary` and `resolve_intake_review`, which both check permissions themselves |
| Browser (live mode, owner of E2E Realty A) | The list shows the "Review" badge, and the drawer shows the Intake panel with its candidates. Clicking "Different person — continue" resolved the review, cleared the badge and showed "Queued for the Sales & Qualification agent" |

DB tests cover:
- **Normalization:** names, email, E.164 phone numbers with and without a country, budgets, currency and missing information.
- **Creation:** assignment reason, activity, handoff payload, the redacted run and its steps.
- **Idempotency:** redelivery and replay.
- **Matching:**
  - repeat enquiries fill only empty fields;
  - external-id matching;
  - a new lead on an existing contact whose earlier lead is closed;
  - both kinds of ambiguous match go to review, which can be resolved as a different person or merged.
- **Assignment:** by property, source rule, fallback, unassigned queue and round-robin. Settings reject assignees from another organization.
- **Model proposals:**
  - fill gaps without overriding structured data or currency;
  - are dropped when invalid or oversized;
  - a missing model is recorded.
- **Failure handling:**
  - invalid payloads are quarantined;
  - a failed attempt rolls back and a retry then succeeds;
  - dead letters are recorded;
  - abandoned runs are recovered.
- **Outbox:** leasing, acknowledgement and backoff.
- **Manual path:** leads created in the OS get a run and a handoff.
- **Security:**
  - signed-in users cannot call intake functions or write runs, events, reviews or intake columns;
  - tenant isolation of runs, events, reviews and summaries;
  - property references from another organization are ignored.

Live checks cover:
- **Structured lead:** returns 201 with intake state, run, activity and handoff.
- **Concurrency:**
  - the **same event sent 5× at once creates one lead**;
  - **5 different events for one new person sent at once create one lead and 4 repeat enquiries**.
- **Review:** an ambiguous match goes to review with no handoff, and resolving it queues the handoff.
- **Free text without a model key:** still creates the lead and records the model outcome.
- **Security:**
  - the other organization cannot read the summary or the runs;
  - a signed-in user cannot call `intake_receive` or write `intake_status`;
  - a forged signature returns 401 and an invalid payload returns 422.
- **Manual lead:** gets a run and a handoff.

**Not executed:** no real Claude call has run. No API key is configured, so live runs only recorded the `disabled` outcome, and the tests use simulated model output. PGlite tests run on a single connection, so concurrency is verified only by the live checks.

## 15. Limitations

- **Matching:**
  - Duplicates are matched only on exact normalized phone/email and a per-source external id.
  - Typos, a second phone number or a new email create a new contact.
  - Name similarity can only stop a phone-only match from linking; it never links on its own.
- **Phone numbers:** without `+country` they are accepted only for India (`IN`). For other countries the sender must include the country code or `phone_country`; otherwise the phone is dropped with a warning.
- **Unknown intent:** the schema's `desired_transaction` default (`buy`) is stored, and `intent` is listed in `missing_information`.
- **No name:** the contact is labelled "Unnamed enquiry" and `name` is listed as missing.
- **Repeat enquiries:** they only fill empty fields. A changed budget or location from a later enquiry appears in the activity text but is not applied.
- **Manual and CSV leads:** they keep the existing interactive duplicate prompt rather than the agent's ambiguity rules, but they still get a run and a handoff.
- **Retell and portal adapters:** these are integration points only, via `intake_receive` with `p_source_kind` set to `voice` or `integration`. No credentials or webhooks exist for them yet.
- **Claude:** the model call is configured but has not run live, and the `fallbacks: "default"` parameter is untested against the live API.
- **Runs page:** there is none yet. `logs.view` roles can read runs through RLS, and the lead screen shows each lead's summary.

## 16. Handoff to Agent 2 (Sales & Qualification): contract

- **When a lead is ready:**
  - It is persisted and not waiting for duplicate review (`intake_status = 'completed'`). This includes webhook, manual and import leads, and leads whose review was resolved as a different person.
  - The event is written in the same transaction as the lead, so one never exists without the other.
- **Consuming:**
  - Call `outbox_claim('sales_qualification_agent', ['lead.ready_for_qualification'], n)`. It leases events for 5 minutes using `for update skip locked`, so two workers never get the same event.
  - Re-read the lead through the backend with `organization_id = event.organization_id` and `id = event.lead_id`. Trust nothing in the payload beyond the ids.
- **Acknowledging:**
  - Call `outbox_ack(id, consumer, true)` once the qualification work is durably recorded.
  - Passing `false` with an error reschedules the event with backoff of 2^attempts minutes, capped at 60. It is dead-lettered after 10 attempts.
  - An expired lease can be claimed again.
- **If qualification is unavailable:** events stay `pending`, as they do now because Agent 2 does not exist yet. Nothing is lost, and the lead screen shows "Queued for the Sales & Qualification agent".
- **Duplicate delivery:** there is one event per lead, enforced by `dedupe_key`. Agent 2 must still be idempotent per `lead_id` + `correlation_id`, because a crash between finishing the work and acking re-delivers the event.
- **How the handoff is recorded:** the run gets a `handoff` step, and the outbox row carries `status` / `delivered_at`. The intake agent never marks qualification complete; only Agent 2's ack sets `delivered`.
- **Failed handoff:** the row goes to `dead_letter`, visible to `logs.view` roles. It can be re-queued by setting `status = 'pending'`, which only the service role can do.

## 17. Security notes

- **Organization context:** taken only from the per-org HMAC secret (webhook) or `auth.uid()` membership (manual). The strict payload schema rejects fields like `organization_id` and `assigned_to`, and SQL ignores unknown keys.
- **References:** every referenced id is re-resolved inside the run's organization: contacts, leads and properties by `organization_id`, assignees through `intake_eligible`. Settings reject assignees who are not members.
- **Writes:** clients cannot write runs, steps, events, reviews or the lead intake columns (column grants, backed by a guard trigger). The intake functions are service-role only.
- **Model output:**
  - It can only fill empty requirement fields and cannot carry ids.
  - It is validated twice: zod with an evidence-in-text check, then SQL normalization.
  - The free-text message is the only customer data sent to the model.
- **Personal data:**
  - Run inputs (contact details) are redacted on success. They are kept only on invalid and dead-lettered runs, for troubleshooting.
  - Edge Function logs contain only ids, outcomes and timings.

## 18. Remaining concerns

- Invalid and dead-lettered runs keep the raw payload (personal data) with no retention job. Add a purge (for example after 30 days) before production.
- Nothing alerts on dead letters or on a growing `pending` outbox count. Wire these into monitoring when Agent 2 lands.
- Intake rules have no settings screen. Mistakes are caught by validation, but the rules can only be edited in the settings JSON.
- The live checks left test data in the E2E Realty A workspace: leads titled "… 8918041", "Rohan Mehta" and "Deepa Pillai". Delete it along with the test accounts before go-live.

## 19. Recommended next step (Agent 2)

Build the Sales & Qualification worker as a scheduled Edge Function, or a pg_cron + `pg_net` trigger. Each run it should:
1. Claim `lead.ready_for_qualification` events.
2. Load the lead and its consent state.
3. Use `missing_information` to decide what to ask, through consent-gated channels only.
4. Record the answers as lead updates with AI provenance.
5. Ack the event.

It can reuse these unchanged:
- `agent_runs`, with `agent_id = 'sales_qualification_agent'`;
- `agent_run_steps`;
- `review_items`;
- the outbox.
