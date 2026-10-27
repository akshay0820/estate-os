# Commercial Launch Readiness — Estate OS

Date: 2026-10-27.

**Basis:** repository inspection plus Phases 1–5 test evidence.

**Important:**
- **No pilot has run and no customer has used the product.** Every statement below is about verified software behaviour on staging with synthetic data, not customer outcomes.
- **Pricing, currency, tax, contract terms and the billing provider are business decisions not yet made.** Nothing here sets them.

## 1. Verified product capabilities (staging, synthetic data)

| Capability | Evidence |
|---|---|
| Multi-tenant workspaces, roles (owner, admin, manager, agent, viewer, finance), invite by link | DB tests; staging ROLE-01…10; isolation sweep across 44 tables |
| Lead capture from signed web/portal webhooks, with replay and duplicate handling | Staging INT-01…10 |
| Rule-based lead qualification with explanation and staff override | Staging QUA-01…05; local suites |
| Property matching against the agency's own listings (budget, area, type, availability) with honest empty results | Staging MAT-01…05 |
| Follow-up **drafts** grounded in real matches; approval workflow; **manual sending** | Staging FUP-01…06 |
| Internal appointment booking: availability in the agency's time zone, conflict-safe, reschedule and cancel | Staging APT-01…07 |
| Data quality: duplicate detection, human-approved revertible merges, field provenance | Local (16 tests); staging DQ-01…03 |
| Sales metrics and funnel reconciled to independent counts; reports with CSV / JSON export | Staging ANL-01…04, SI-01…03 |
| Per-workspace agent pause, outbound switch, AI request limits, AI usage (tokens) summary, health endpoint | Phases 4–5 tests; staging pilot-controls 11/11; smoke 16/16 |

## 2. Suitable for commercial use in the first release

Only these, after the release gates in `PHASE_5_PRODUCTION_LAUNCH_PLAN.md` are met:
- CRM: leads, contacts, properties, deals, tasks, appointments (internal);
- lead capture by signed webhook;
- rule-based qualification and matching;
- follow-up drafts with manual sending;
- data-quality review;
- sales metrics and reports.

**Positioning:** "decision support and workflow automation with human approval", not "autonomous AI agents".

## 3. Limited or unavailable

| Feature | Status |
|---|---|
| AI (Claude) steps in all agents | **Unverified.** The key has not reached staging functions. Sell as "coming", or off, until verified |
| AI voice calling | **Unavailable** (no provider; legal review needed) |
| Automated message delivery (email, SMS, WhatsApp) | **Unavailable** (no provider) |
| Calendar sync | **Unavailable** |
| CRM connectors (import from or sync with other CRMs) | **Unavailable** |
| Bulk import (CSV) of leads or listings | **Unavailable**; manual entry or webhook only |
| Unified inbox, workflow builder, central approvals and logs pages | **Not connected** in live mode |
| Billing and subscriptions in the app | **None** (see §8) |

## 4. Supported customer profile (initial cohort)

Proposed; the Commercial owner decides.

- **Cohort:** 1–3 agencies.
- **Lead sources:** sources that can post a signed webhook (their own website, or a portal that supports webhooks via their developer).
- **Listings:** a manageable number entered by hand (no bulk import).
- **Process:** willing to keep human approval on every outbound message, and to send messages from their own tools.
- **Region:** India (time zones and data stored in ap-south-1). Other regions need a data-residency decision.
- **Staff:** an owner or admin who can run the daily review (Pilot operations).

## 5. Onboarding requirements

Per agency (`docs/pilot/AGENCY_ONBOARDING_CHECKLIST.md`; about 2–4 operator hours, an estimate):

| Step | Automation level |
|---|---|
| Workspace creation by the agency's owner at sign-up (atomic: workspace and owner membership in one transaction) | **Automated** |
| Settings, invitations, webhook secret | **Partially automated** (in-app; done by the owner) |
| Invitation delivery | **Manual** until custom SMTP is configured |
| Listings | **Manual** |
| Agent stage set-up (pause / resume) | **Partially automated** (in-app) |
| Scope agreement, success criteria, consent wording | **Manual** |
| Operator-initiated provisioning and onboarding status tracking | **Not implemented**; tracked in the checklist |

## 6. Support model (proposed)

| Item | Proposal |
|---|---|
| Support hours | To decide; propose business hours IST, with SEV-1 on-call |
| Channel | One agreed channel per agency, plus the feedback log |
| Incident handling | `PRODUCTION_INCIDENT_RUNBOOK.md` |
| Daily operations | `docs/pilot/PILOT_DAILY_RUNBOOK.md`, which works for any workspace |
| Admin diagnostics | In-app: Pilot operations, Data quality, Audit logs, Integrations (webhook events), Sales intelligence. Platform level: health endpoint, SQL queries in the runbooks. **No ticketing system**; use an existing tool (not built into the product) |

## 7. Usage and cost constraints

| Item | Status |
|---|---|
| **Measured** | AI tokens per workspace and agent (`ai_usage_summary`, provider-reported); AI request counts and failures; agent runs |
| **Not measured** | Cost in currency (prices not stored; tokens × published price is a manual calculation); hosting share per tenant; staff time saved |
| **Enforced limits** | User-triggered AI features: per user per hour (10–60 by feature) and 1,000 per workspace per day; server-enforced, returns 429 |
| **Not enforced** | A per-workspace budget for **background** AI steps (G18). Until it exists: an Anthropic spend cap, the daily review of the usage summary, and per-workspace pause or AI toggles |
| **Platform cost** | Supabase Pro organization with 7-day PITR on Small compute: about **$130 / month** (Supabase docs, 2026-10-27), plus Anthropic usage and hosting |

## 8. Billing and subscriptions: design only (blocked on business decisions)

There is no billing code. Before any implementation, decide:
1. the provider;
2. the plans and what each includes (users, workspaces, AI volume, voice minutes);
3. currency and tax treatment (for India, GST: needs tax advice);
4. trial policy;
5. what happens on payment failure (grace period, read-only mode);
6. cancellation and data export terms.

**Integration points in the current architecture** (for when it is decided):

| Piece | Design |
|---|---|
| Subscription state | A `subscriptions` table per organization (plan, status, period, provider customer and subscription ids), written **only** by a service-role webhook function |
| Webhook | A provider webhook Edge Function (`verify_jwt = false`) verifying the provider signature, idempotent on the provider event id, the same pattern as `lead-intake` + `webhook_events` |
| Enforcement | Server-side, at the existing choke points: `ai_request_begin` (AI volume per plan), `invite_member` (seats), `agent_control_set` / agent ticks (which agents a plan includes), voice pre-call policy (minutes). **Never by hiding frontend features** |
| Payments | Card data never touches the app (provider-hosted checkout). "Paid" is recorded only from the provider's confirmed event |

## 9. Claims marketing must avoid until validated

- Any conversion, revenue, response-time or labour-saving improvement: **no customer evidence exists**.
- "Fully autonomous" or "AI does it for you": every outbound action is human-approved, and the AI steps are unverified.
- "AI calls your leads", "sends WhatsApp / SMS / email", "syncs with your calendar or CRM", "import your data in one click": not available.
- Any regulatory compliance claim (DPDP Act, TRAI/DND, GDPR or similar): **not reviewed**.
- Specific uptime or support SLAs: no monitoring history.

## 10. Customer terms and privacy (needs qualified review; not drafted here)

**Required before the first paying customer:**
- customer agreement;
- privacy notice;
- data-processing terms;
- acceptable-use policy (especially for outbound communication);
- support policy;
- service limitations (this document §3);
- data retention and deletion policy (none is automated today);
- subprocessor list (Supabase, Anthropic, the hosting provider, later messaging, voice and calendar providers);
- customer responsibilities (consent capture on their forms, accuracy of listings);
- AI and automation limitations;
- communication-consent requirements (DND / telemarketing rules for any future calling or messaging).

**Open legal and tax questions:**
- data residency (India);
- consent wording;
- call recording (if voice is ever enabled);
- GST on subscriptions;
- liability for AI-generated content sent by agencies.
