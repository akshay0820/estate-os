# Integration and Agent Map — Estate OS

Audit date: 2026-10-26. Sources:
- [STATIC] migrations and `supabase/functions/`;
- [RUNTIME] the live project's function list, cron jobs, outbox counts and the `voice-calls/status` probe.

No secret values are shown; Vault and secret entries are listed by purpose only.

## 1. Agents

| # | Agent (`source` / consumer id) | Trigger | Main tables | Edge Functions (deployed?) | Cron | External dependency | State |
|---|---|---|---|---|---|---|---|
| 01 | Lead intake (`lead_intake_agent`) | Signed webhook, manual entry | `leads`, `agent_runs`, `review_items`, `webhook_events` | `lead-intake` (yes) | `lead-intake-worker` (SQL) | Lead sources (HMAC webhook); Claude optional | Live; Claude step blocked |
| 02 | Voice calling (`voice_calling_agent`) | Manual or policy request | `voice_settings`, `voice_calls`, `voice_call_transcripts`, `voice_call_events` | `voice-calls`, `voice-worker`, `voice-webhook` (yes) | `voice-worker` (pg_net) | **Retell** (not configured), Claude analysis (not configured) | Never run |
| 03 | Sales qualification (`sales_qualification_agent`) | `lead.ready_for_qualification`, voice completion | `lead_qualifications`, `qualification_settings` | `qualification-worker` (yes) | `qualification-tick` (SQL), `qualification-worker` (pg_net) | Claude optional | Live, deterministic |
| 04 | Property matching (`property_matching_agent`) | `lead.qualification.completed`, listing changes | `property_match_runs`, `property_matches` | `property-matching-worker` (yes) | `property-matching-tick`, `property-matching-worker` | Claude optional | Live, deterministic |
| 05 | Follow-up (`follow_up_agent`) | Fan-out trigger from matching, consent, appointment and other events | `follow_ups`, `follow_up_settings` | `follow-up-worker` (yes) | `follow-up-tick`, `follow-up-worker` | **Messaging provider: none**; Claude optional | Live, manual send only |
| 06 | Appointments | User RPCs, lifecycle triggers | `appointments`, `appointment_history`, `scheduling_settings`, `staff_working_hours`, `availability_blocks`, `calendar_sync_state` | `calendar-sync-worker`, `appointment-assistant` (yes) | `appointment-tick`, `calendar-sync-worker` | **Calendar provider: none**; Claude optional | Live; sync unsupported |
| 07 | CRM data quality (`crm_data_agent`) | Change-queue triggers, scans | `data_quality_*`, `duplicate_candidates`, `record_merges`, `field_provenance` | `crm-enrichment` (yes) | `crm-data-tick` (SQL) | Claude optional | Live |
| 08 | Sales intelligence (`sales_intelligence_agent`) | On-request RPCs, daily evaluation | `sales_*` (7 tables) | `sales-intelligence-recommend`, `sales-analyst` (**no, 404**) | `sales-intelligence-tick` (SQL) | Claude optional | Live except the AI features |

There are exactly the 12 cron jobs named above, all on `* * * * *`, all active, with 0 failures in 24 h [RUNTIME `cron.job`].

## 2. Event flow (transactional outbox, `private.emit_event`)

```
lead-intake webhook ─► Agent 01 ── lead.ready_for_qualification ─► Agent 03
                                   lead.intake_completed / intake_failed / review_required
Agent 02 ── voice_call.completed / human_handoff_requested ─► Agent 03 (handoff)
Agent 03 ── lead.qualification.completed ─► Agent 04
            lead.qualification.needs_information / human_review_required ─► Agent 05 (fan-out)
Agent 04 ── property_matching.completed / no_matches / needs_information ─► Agent 05 (fan-out)
consent / contact / lead changes ── lead.communication_opted_out ─► Agent 05 (synchronous stop triggers)
Agent 06 ── appointment.* (booked, confirmed, rescheduled, cancelled, reminder_due, ...) ─► Agent 05 (by trigger)
Agent 07 ── crm.* (issue detected / resolved, merges, enrichment, scan completed) ─► (no consumer)
Agent 08 ── sales.* (insight_detected / expired, recommendations_generated,
                     forecast_completed, report_completed) ─► (no consumer)
```

**Live deliveries** [RUNTIME]: sales_qualification 20, follow_up 9, property_matching 5. The outbox has 126 published events and no dead letters. Agent 07 and 08 events are published without consumers (PRA-028). Agent 08 reads the Agent 07 context directly via SQL.

## 3. External integrations

| Integration | Direction | Implementation | Auth | Configured live? | Verified? |
|---|---|---|---|---|---|
| Lead sources (portals, website forms) | Inbound webhook | `lead-intake` | Per-integration HMAC with timestamp; rotatable | Yes, one `lead_source` | **Yes**: 22 processed, 4 rejected [RUNTIME] |
| Retell AI | Outbound API plus inbound webhook | `_shared/retell.ts`, `voice-calls`, `voice-worker`, `voice-webhook` | API key (secret); webhook HMAC | **No** | **No** (PRA-005, PRA-015) |
| Anthropic Claude | Outbound API | `@anthropic-ai/sdk@0.133.0`, model `claude-opus-5-5` (configurable per function) | `ANTHROPIC_API_KEY` | **No** | **No** (PRA-005) |
| Email / SMS / WhatsApp | Outbound | Dispatch boundary in Agent 05 only | none | No adapter | **No** (PRA-006) |
| Google / Microsoft calendar | Two-way | Sync boundary in Agent 06 only | none | No adapter | **No** (PRA-006) |
| Supabase Auth mailer | Outbound | Platform | Platform | Default | Confirmation flow used [PRIOR] |
| pg_cron → Edge Function workers | Internal | `pg_net` with Vault URL and shared secret | Shared secret per worker | Yes (voice, qualification, matching, follow-up, calendar) | **Yes**: cron runs succeed [RUNTIME] |

## 4. AI (Claude) call inventory [STATIC]

| # | Call site | Purpose | Output control | Fallback without a key |
|---|---|---|---|---|
| 1 | `lead-intake` | Extract structured lead fields from free text | JSON schema + zod | Deterministic normalization only |
| 2 | Voice analysis (`voice-worker` / runner) | Summarize a call, extract requirements and intent | JSON schema + zod | Analysis marked failed or unavailable; human review |
| 3 | `qualification-worker` | Qualitative qualification notes and signals | JSON schema + zod; engine decides the status | Deterministic engine result |
| 4 | `property-matching-worker` | Plain-language match explanations | JSON schema + zod; scores stay deterministic | Rule-based strengths / trade-offs |
| 5 | `follow-up-worker` | Draft follow-up messages | JSON schema + zod; policy checks; human approval | Manual drafting |
| 6 | `appointment-assistant` | Scheduling suggestions | JSON schema + zod; booking via RPC only | Manual scheduling |
| 7 | `crm-enrichment` | Propose field corrections | JSON schema + zod; proposals need approval; verified values protected | Rules only |
| 8 | `sales-intelligence-recommend` (not deployed) | Recommendations from a metric snapshot | Schema + validator: cited values in the snapshot; no invented numbers or findings | Rule-based insights |
| 9 | `sales-analyst` (not deployed) | Natural language → validated metric query spec | Schema + catalogue-only validator; deterministic answer formatter | Query builder |

All 9 are unit-tested at the validator level [TEST]. None has been called against the live API.

**Phase 2:** call sites 6–9 (the user-triggered ones) now call `ai_request_begin` before the model. It checks the feature permission and applies the per-user and per-org limits, and each request is recorded in `ai_requests` with its outcome (migration 0018, not yet applied live). Call sites 1–5 run from workers and are bounded by the existing per-lead request limits.

## 5. Secrets and config by name (values not read)

- **Vault:** worker URL and shared secret for voice, qualification, property matching, follow-up and calendar; one webhook secret.
- **Edge Function secrets, expected:**
  - `ANTHROPIC_API_KEY` and optional model overrides (for example `SALES_INTELLIGENCE_MODEL`, `SALES_ANALYST_MODEL`);
  - `RETELL_API_KEY`;
  - Supabase-provided `SUPABASE_URL` and the service role key.
  - The status probe confirms the Anthropic and Retell secrets are absent.
- **Frontend:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (public).
