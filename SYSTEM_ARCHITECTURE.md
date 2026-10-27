# Real Estate AI OS: System Architecture

**Product:** Real Estate AI OS\
**Owner:** BlazeReach AI\
**Document type:** System architecture specification\
**Version:** 1.0\
**Status:** Initial implementation blueprint\
**Last updated:** 24 October 2026\
**Related document:** `PRD.md`

> **As-built note (2026-10-26).** This blueprint predates the implementation, and several stack choices were changed when it was built:
> - The web app is a **Vite + React SPA with custom CSS**, not Next.js / Tailwind / shadcn.
> - Orchestration is **pg_cron + pg_net + a transactional outbox (`outbox_events`) + durable `agent_runs`**, not n8n. No-code automation platforms are not used (see `REAL_ESTATE_AI_OS_AGENT_WORKFLOW.md`).
> - The LLM is called through the **Anthropic SDK directly** (JSON-schema outputs validated with zod), not a provider-neutral adapter.
> - There is **no external monitoring or hosting** configured yet.
>
> Where this document and the code disagree, the code and `docs/production/` (audit, Phase 2 remediation) describe the system as it is.

------------------------------------------------------------------------

## 1. Purpose

This document defines the technical architecture for Real Estate AI OS,
a multi-tenant SaaS platform for real estate agencies. It describes the
system boundaries, application layers, data flow, integrations, AI
execution model, security controls, operational workflows, deployment
approach, and implementation sequence.

It is intended to guide implementation with Claude Code and related
development tools. It is a blueprint, not a claim that all providers,
integrations, or deployment settings have already been configured.
Confirm current provider documentation, regional availability, API
permissions, and commercial requirements before implementing an
integration.

## 2. Architecture Goals

The architecture must:

1.  Support multiple agencies in one SaaS application with strict data
    isolation.
2.  Connect leads, contacts, properties, conversations, calls,
    appointments, deals, tasks, and reporting.
3.  Process provider webhooks and background tasks reliably.
4.  Use AI for language-heavy tasks without allowing AI to bypass
    business rules or permissions.
5.  Keep external provider dependencies replaceable.
6.  Make automated actions observable, traceable, retryable, and
    stoppable.
7.  Support human handoff and approvals for sensitive actions.
8.  Start with a maintainable modular monolith and scale selectively.
9.  Protect personal data, credentials, recordings, transcripts, and
    financial information.
10. Support gradual implementation from a lead-to-appointment MVP.

## 3. Architecture Principles

-   **Modular monolith first:** One main web application and domain
    codebase. Separate workers and integration processes only where
    asynchronous execution or scaling requires them.
-   **Server owns business rules:** The browser must never be the
    authority for permissions, financial calculations, consent,
    appointment conflicts, or workflow state transitions.
-   **PostgreSQL is the source of truth:** Core business state lives in
    Supabase PostgreSQL. Provider systems are sources of events, not the
    canonical source for the application's business records.
-   **Event-driven execution:** Domain events initiate workflows. Events
    and jobs are persisted and processed with idempotency.
-   **AI is bounded:** AI proposes structured outputs and invokes
    explicitly defined tools. Backend code validates and authorizes
    every action.
-   **Least privilege:** Every user, worker, integration, and agent has
    only the permissions it needs.
-   **One owner per workflow:** Do not implement the same workflow
    independently in the application and n8n.
-   **Provider adapters:** Voice, messaging, email, calendar, and model
    providers are hidden behind internal interfaces.
-   **Observable by design:** Every important workflow has status,
    timestamps, logs, failure paths, and relevant usage/cost data.
-   **Secure defaults:** RLS, server authorization, secret isolation,
    retention policies, and audit trails are designed from the start.

------------------------------------------------------------------------

## 4. System Context

### 4.1 External actors

-   Agency owner and administrators.
-   Sales managers and salespeople.
-   Operations and finance staff.
-   Prospective buyers, sellers, tenants, and landlords.
-   Lead sources and advertising platforms.
-   Voice and telephony providers.
-   Messaging and email providers.
-   Calendar providers.
-   AI model providers.
-   Optional automation platform such as n8n.

### 4.2 System boundary

Real Estate AI OS owns: - Organization and user membership. - Leads and
contacts. - Property inventory and its verification status. - Deal and
appointment state. - Internal tasks and workflow state. - Permission and
approval decisions. - AI agent configurations and execution records. -
Audit and usage records. - Integration configuration metadata.

External providers own their own delivery infrastructure and
provider-specific records. Real Estate AI OS stores provider IDs and
verified outcomes necessary to coordinate work. A request accepted by a
provider is not treated as proof that a call, message, or appointment
succeeded.

### 4.3 High-level context diagram

``` mermaid
flowchart LR
    Staff[Agency Staff] --> Web[Next.js Web Application]
    Customers[Leads and Clients] --> Channels[Phone, WhatsApp, SMS, Email, Web Forms]
    Sources[Portals and Ad Platforms] --> Intake[Integration and Intake Layer]
    Channels --> Providers[Communication Providers]
    Web --> App[Application and Domain Layer]
    Intake --> App
    Providers --> Webhooks[Verified Webhook Endpoints]
    Webhooks --> Jobs[Durable Jobs and Event Processing]
    App --> DB[(Supabase PostgreSQL)]
    App --> Storage[Supabase Storage]
    Jobs --> DB
    Jobs --> AI[AI Provider Adapter]
    Jobs --> Voice[Voice Provider Adapter]
    Jobs --> Messaging[Messaging Provider Adapter]
    Jobs --> Calendar[Calendar Adapter]
    AI --> Jobs
    Voice --> Providers
    Messaging --> Providers
    Calendar --> ExternalCalendar[Calendar Provider]
    DB --> Reports[Dashboard and Reporting]
    Jobs --> Observability[Logs, Metrics, Alerts]
    App --> Observability
```

------------------------------------------------------------------------

## 5. Recommended Technology Stack

Use maintained, compatible versions and commit lockfiles. Check current
documentation before implementation.

  -----------------------------------------------------------------------
  Area                    Initial choice          Responsibility
  ----------------------- ----------------------- -----------------------
  Web framework           Next.js with TypeScript Application shell,
                                                  pages, server endpoints

  UI                      Tailwind CSS and        Reusable interface
                          shadcn/ui               components

  Forms and validation    Zod or equivalent typed Validate user and
                          validation              provider inputs

  Server state/data       Server-side application Data fetching and
  access                  services; client query  mutation lifecycle
                          library where useful    

  Database                Supabase PostgreSQL     Canonical business
                                                  records

  Authentication          Supabase Auth           Identity and sessions

  Authorization           PostgreSQL RLS plus     Tenant and record
                          server-side capability  access
                          checks                  

  File storage            Supabase Storage        Property media and
                                                  protected documents

  Realtime                Supabase Realtime where Selected live updates
                          justified               

  Semantic search         pgvector, introduced    Semantic retrieval and
                          when needed             ranking

  Background processing   Durable queue/worker    Calls, messages,
                          pattern                 imports, retries,
                                                  scheduled work

  Integration automation  n8n for selected        Connector-heavy
                          external workflows      workflows with clear
                                                  ownership

  AI                      Provider-neutral LLM    Structured extraction,
                          adapter                 summaries, drafting

  Voice                   Voice-provider adapter, AI call execution and
                          initially one provider  call events

  Messaging               Official channel APIs   Message send/receive
                                                  and delivery events

  Email                   Transactional email     Email delivery and
                          provider                inbound events if
                                                  supported

  Calendar                Calendar provider       Availability and
                          adapter                 synchronization

  Monitoring              Error tracking and      Exceptions, latency,
                          structured logs         provider failures

  Hosting                 Managed                 Deployment and
                          Next.js-compatible host operations
                          and managed Supabase    
  -----------------------------------------------------------------------

### 5.1 Avoid premature complexity

Do not start with Kubernetes, multiple domain microservices, a dedicated
vector database, or a custom AI orchestration framework unless a
specific requirement justifies it. A modular monolith, PostgreSQL,
durable jobs, and well-defined provider adapters are sufficient for the
first product iteration.

### 5.2 Background execution decision

Do not rely on a web request remaining open while a model responds, a
phone call completes, or a workflow waits for a future time.

Use a durable job mechanism that fits the deployment environment. It may
be a managed queue, a dedicated worker, a database-backed job table with
controlled claiming, or another maintained solution. Confirm retry,
visibility timeout, concurrency, scheduling, and dead-letter behavior
before choosing.

Supabase Edge Functions can be useful for bounded webhook and
integration tasks, but long-running work should follow current platform
execution limits. Do not assume a function can safely wait for a full
voice call or long-running workflow.

------------------------------------------------------------------------

## 6. Logical Architecture Layers

### 6.1 Presentation layer

Responsibilities: - Render dashboard and operational screens. - Collect
and validate form input for user experience. - Display permissions-aware
navigation. - Show workflow status, errors, and activity. - Subscribe to
selected authorized real-time updates.

Must not: - Hold service-role keys or provider secrets. - Decide whether
a user has access to a record. - Execute sensitive provider actions
directly from the browser. - Treat client-supplied organization IDs as
proof of membership.

### 6.2 Application/API layer

Responsibilities: - Authenticate the request. - Resolve the active
organization from a validated membership. - Check capability and
record-level access. - Validate request payloads. - Invoke domain
services. - Return stable, sanitized responses. - Apply rate limits and
request-size limits. - Emit audit events for relevant actions.

### 6.3 Domain layer

Contains business rules for: - Leads and contact identity. - Property
inventory and verification. - Deal stages. - Appointment booking and
conflicts. - Tasks and escalation. - Communication eligibility. -
Consent and suppression. - Workflow lifecycle. - Approval
requirements. - Usage and cost attribution.

Domain rules should be testable without calling an LLM or a real
provider.

### 6.4 Data layer

Responsibilities: - PostgreSQL queries and transactions. - RLS
policies. - Schema migrations. - Indexes and constraints. - Storage
metadata. - Data retention and deletion workflows. - Reporting queries
and aggregates.

### 6.5 Integration layer

Contains adapters for: - Lead sources. - Voice. - Messaging. - Email. -
Calendar. - AI model providers. - Optional accounting or e-signature
tools.

Adapters translate external request/response formats into internal
contracts. Domain services should not depend directly on a provider's
SDK data model.

### 6.6 Execution layer

Responsibilities: - Persist and claim jobs. - Execute workflow steps. -
Schedule delayed actions. - Retry transient failures. - Record step
outcomes. - Recover abandoned work. - Apply concurrency limits and usage
budgets. - Cancel or re-evaluate work after opt-outs, human takeover, or
state changes.

### 6.7 AI layer

Responsibilities: - Extract structured requirements from
conversations. - Summarize calls and messages. - Draft responses. -
Assist property matching. - Suggest next actions. - Use explicitly
defined tools when necessary.

The AI layer does not own authorization, truth about inventory,
financial arithmetic, consent enforcement, or durable workflow state.

### 6.8 Observability layer

Collect: - Structured application logs. - Error events. - Job and
workflow metrics. - Provider latency and failure rates. - AI usage and
cost. - Security/audit events. - Alerts for repeated failures or
degraded integrations.

Avoid logging full conversation bodies, secrets, call transcripts, or
sensitive documents by default.

------------------------------------------------------------------------

## 7. Suggested Codebase Structure

A feature-oriented modular structure is recommended. Adjust names to the
chosen Next.js router and project conventions.

``` text
real-estate-ai-os/
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   ├── (dashboard)/
│   │   ├── api/
│   │   │   ├── webhooks/
│   │   │   │   ├── leads/
│   │   │   │   ├── voice/
│   │   │   │   └── messaging/
│   │   └── layout.tsx
│   ├── components/
│   │   ├── ui/
│   │   ├── layout/
│   │   └── shared/
│   ├── features/
│   │   ├── dashboard/
│   │   ├── leads/
│   │   ├── contacts/
│   │   ├── properties/
│   │   ├── conversations/
│   │   ├── calls/
│   │   ├── appointments/
│   │   ├── deals/
│   │   ├── tasks/
│   │   ├── agents/
│   │   ├── workflows/
│   │   ├── integrations/
│   │   ├── finance/
│   │   └── settings/
│   ├── lib/
│   │   ├── env/
│   │   ├── validation/
│   │   ├── logging/
│   │   └── rate-limit/
│   ├── server/
│   │   ├── auth/
│   │   ├── authorization/
│   │   ├── domain/
│   │   ├── services/
│   │   ├── repositories/
│   │   ├── events/
│   │   ├── jobs/
│   │   ├── workflows/
│   │   ├── ai/
│   │   └── integrations/
│   │       ├── voice/
│   │       ├── messaging/
│   │       ├── email/
│   │       ├── calendar/
│   │       └── lead-sources/
│   └── types/
├── supabase/
│   ├── migrations/
│   ├── seed.sql
│   └── config.toml
├── workers/
│   └── workflow-worker/       # Add when durable worker is needed
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── security/
│   └── e2e/
├── docs/
│   ├── PRD.md
│   ├── SYSTEM_ARCHITECTURE.md
│   ├── DATABASE_ARCHITECTURE.md
│   ├── INTEGRATIONS.md
│   └── DECISIONS.md
├── .env.example
└── README.md
```

### Code ownership rules

-   `features/` contains UI and feature-specific client code.
-   `server/domain/` contains framework-independent business rules.
-   `server/services/` orchestrates domain operations and transactions.
-   `server/repositories/` contains data access functions.
-   `server/integrations/` contains provider adapters.
-   `server/workflows/` defines workflow plans and execution contracts.
-   `workers/` contains durable job consumers if a separate process is
    required.
-   `supabase/migrations/` is the source of truth for database schema
    changes.

Avoid creating layers that merely forward calls without adding
validation, authorization, or a useful abstraction.

------------------------------------------------------------------------

## 8. Multi-Tenant Identity and Authorization

### 8.1 Tenant model

An organization represents one agency workspace. Users are linked to
organizations through membership records. A user may belong to multiple
organizations if the product permits it, but every request must operate
in an explicitly validated active organization context.

Every organization-owned record must have a direct `organization_id` or
an enforceable parent relationship that cannot cross tenants.

### 8.2 Request authorization sequence

For every protected operation:

1.  Validate the user session.
2.  Resolve the active organization from a trusted membership record.
3.  Check that the membership is active.
4.  Check the required capability.
5.  Apply record-level constraints.
6.  Execute through a scoped repository/query.
7.  Enforce RLS as a second layer.
8.  Write audit data for high-impact actions.
9.  Return only fields the user is allowed to see.

Never trust an organization ID supplied by the browser without verifying
membership. Never use user-editable profile metadata as an authorization
source.

### 8.3 RLS policy approach

-   Enable RLS on every exposed organization-owned table.
-   Use policies that check membership and permissions, not merely
    whether the requester is authenticated.
-   Ensure `UPDATE` policies include appropriate `USING` and
    `WITH CHECK` conditions.
-   Prevent users from changing tenant ownership fields.
-   Protect Storage objects with policies consistent with their parent
    records.
-   Treat views, RPCs, triggers, and privileged functions as
    security-sensitive.
-   Avoid `SECURITY DEFINER` functions unless there is a documented need
    and a reviewed safe implementation.
-   Test with at least two organizations and several role types.

Use server-side privileged credentials only in trusted server/worker
contexts. When privileged credentials bypass RLS, the service must
explicitly validate the caller and organization before accessing
records.

### 8.4 Realtime authorization

Use Realtime only for data that benefits from immediate updates. Confirm
channel authorization and RLS behavior for the chosen subscription
design. Do not broadcast private customer details or transcripts to
broad organization channels when a narrow event such as `lead.updated`
is sufficient.

------------------------------------------------------------------------

## 9. Core Domain Model and Ownership

The detailed ERD and column-level schema belong in
`DATABASE_ARCHITECTURE.md`. At the architecture level, the major
entities are:

-   Organization and membership.
-   Contact and lead/opportunity.
-   Property and property media.
-   Conversation, message, and call.
-   Appointment and task.
-   Deal and deal activity.
-   AI agent configuration and version.
-   Agent run and tool call.
-   Workflow definition/version/run/step.
-   Integration and inbound event.
-   Approval.
-   Audit log.
-   Usage/cost record.
-   Later: campaign, invoice, expense, commission, document.

### 9.1 Source of truth

-   PostgreSQL: business entities and workflow state.
-   Object storage: images, recordings, and documents, with protected
    metadata in PostgreSQL.
-   Provider APIs: external delivery and provider-specific state.
-   AI model output: untrusted suggestion/extraction until validated and
    persisted.
-   Analytics: derived data, with documented definitions and refresh
    timing.

### 9.2 Data integrity

-   Use foreign keys and check constraints for critical relationships.
-   Use unique constraints for provider event IDs and scoped idempotency
    keys.
-   Use transactions for multi-record operations that must succeed
    together.
-   Use exact numeric or integer minor units for money.
-   Store timestamps in UTC and render in configured time zones.
-   Use explicit state transitions.
-   Use soft deletion only where justified; define actual deletion and
    retention separately.

------------------------------------------------------------------------

## 10. Event-Driven Processing

### 10.1 Event envelope

Use a consistent internal envelope for domain and integration events:

``` json
{
  "event_id": "uuid",
  "event_type": "lead.created.v1",
  "organization_id": "uuid",
  "occurred_at": "2026-10-24T12:00:00Z",
  "source": "website_form",
  "correlation_id": "uuid",
  "idempotency_key": "scoped-key",
  "payload": {
    "lead_id": "uuid"
  }
}
```

This is illustrative. Avoid including unnecessary personal data in the
event envelope. Payloads should be validated against a versioned schema.

### 10.2 Initial event types

-   `lead.created.v1`
-   `lead.updated.v1`
-   `lead.qualified.v1`
-   `conversation.message_received.v1`
-   `call.requested.v1`
-   `call.completed.v1`
-   `appointment.booked.v1`
-   `appointment.cancelled.v1`
-   `deal.stage_changed.v1`
-   `workflow.failed.v1`
-   `integration.health_changed.v1`
-   `contact.opted_out.v1`

### 10.3 Transactional outbox pattern

For important database changes that must trigger work, avoid committing
a record and then relying on a separate in-memory event publish that
could fail.

Recommended pattern: 1. In one database transaction, write the business
change and an outbox event. 2. A worker claims unpublished outbox
events. 3. The worker publishes or schedules the corresponding job. 4.
The event is marked published only after the next durable step succeeds.
5. Consumers are idempotent because delivery can occur more than once.

An outbox table and polling worker are suitable initial choices. A
different broker can replace them later without changing domain
semantics.

### 10.4 Event handling rules

-   Verify external webhook authenticity before trusting the payload.
-   Persist enough information to recover processing.
-   Deduplicate repeated events.
-   Keep webhook response paths short.
-   Move long-running AI and provider tasks to background jobs.
-   Retry transient failures with bounded exponential backoff and
    jitter.
-   Do not retry non-retryable errors indefinitely.
-   Record exhausted jobs in a review/dead-letter state.
-   Re-check current lead status and consent before delayed actions
    execute.

------------------------------------------------------------------------

## 11. Background Jobs and Workflow Engine

### 11.1 Job envelope

A job should include: - Job ID. - Organization ID. - Job type and
version. - Correlation ID. - Idempotency key. - Scheduled time. -
Attempt count and maximum attempts. - Current state. - Minimal validated
payload or a reference to persisted data. - Created, started, and
completed timestamps. - Safe error code and diagnostic summary.

### 11.2 Job states

`queued`, `scheduled`, `running`, `retrying`, `waiting_for_approval`,
`succeeded`, `failed`, `cancelled`, `dead_letter`.

### 11.3 Worker behavior

-   Claim jobs atomically so multiple workers do not execute the same
    job concurrently.
-   Use leases or visibility timeouts to recover jobs abandoned by a
    crashed worker.
-   Enforce concurrency and rate limits per organization and provider.
-   Set explicit timeouts.
-   Retry only errors classified as transient.
-   Use idempotency at the action/provider boundary.
-   Record every attempt.
-   Re-evaluate cancellation, opt-out, and human ownership before
    sending.
-   Avoid storing large transcripts or documents in job payloads; store
    protected references.

### 11.4 Workflow definition

A workflow version should define: - Trigger. - Entry conditions. -
Ordered steps. - Step input/output schemas. - Delays and scheduling
rules. - Retry policy. - Exit conditions. - Failure branch. - Approval
requirements. - Allowed tools. - Version and activation state.

For the MVP, start with code-defined workflow templates and stored
configuration. Add a visual builder after the execution model is stable.

### 11.5 n8n boundary

Use n8n when it provides a practical advantage for connector-heavy
integrations. The application must remain the authority for core
records, permissions, opt-outs, workflow run identity, and business
state.

Every n8n-triggered operation should carry a verified organization scope
and correlation ID. Avoid putting unrestricted service credentials into
user-editable workflow nodes. If n8n executes a workflow, the
application should record the execution and should not also run the same
workflow independently.

------------------------------------------------------------------------

## 12. AI Agent Architecture

### 12.1 Agent runtime model

An AI agent is a bounded task runner, not an independent system
administrator.

Each agent run receives: - Organization context validated by the
backend. - A specific task and objective. - Minimum necessary
lead/property/conversation context. - A versioned prompt and output
schema. - An explicit allowlist of tools. - Token/time/cost limits. - An
escalation policy.

The runtime calls the model, validates its output, authorizes any tool
calls, executes allowed tools through server services, and records the
result.

### 12.2 Agent types

**Qualification agent** - Extracts intent, budget, location, property
requirements, timeline, and missing fields. - Produces structured JSON
matching a versioned schema. - Marks unknown fields as unknown.

**Conversation summarizer** - Summarizes calls/messages into a short,
factual history. - Separates customer statements from inferred
suggestions.

**Property matching assistant** - Uses structured database filters for
hard constraints. - May use semantic ranking for subjective
preferences. - Returns property IDs and explicit match reasons. - Does
not invent facts.

**Follow-up drafting agent** - Drafts messages based on verified context
and approved templates. - Sends only through a permitted tool after
policy checks.

**Sales copilot** - Summarizes deal status and suggests next actions. -
Does not make contractual commitments.

**Reporting assistant** - Summarizes precomputed, authorized metrics. -
Does not generate financial totals from arbitrary text when
deterministic queries are available.

### 12.3 Tool execution flow

``` mermaid
sequenceDiagram
    participant W as Workflow Worker
    participant R as AI Runtime
    participant M as Model Provider
    participant P as Policy/Permission Service
    participant T as Typed Tool
    participant DB as PostgreSQL
    W->>R: Start bounded agent run
    R->>M: Task + minimal context + tool schemas
    M-->>R: Structured output or tool request
    R->>P: Validate tool, organization, capability, policy
    P-->>R: Allow, deny, or require approval
    alt Allowed
        R->>T: Execute validated tool
        T->>DB: Scoped domain operation
        DB-->>T: Result
        T-->>R: Minimal result
        R->>M: Continue if needed
        M-->>R: Final structured output
    else Approval required
        R-->>W: Create approval request
    else Denied
        R-->>W: Record safe denial and escalate if required
    end
    R-->>W: Validated result + usage metadata
```

### 12.4 Tool contracts

Examples: - `get_lead` - `update_lead_fields` - `search_properties` -
`get_verified_property_details` - `create_task` -
`check_appointment_availability` - `request_appointment_booking` -
`draft_customer_message` - `send_approved_message` -
`request_human_handoff`

Each tool must: - Validate input. - Validate organization membership and
scope. - Enforce capability and business rules. - Re-check
consent/suppression before external communication. - Return only
necessary fields. - Record actor, tool, target, and result. - Use
idempotency for side effects. - Require approval for configured
sensitive actions.

### 12.5 Prompt injection defense

Treat customer messages, transcripts, property descriptions, uploaded
documents, and retrieved content as untrusted data. They must not be
able to change the agent's instructions, expand tool permissions, reveal
secrets, or bypass approvals.

Use structured prompts, tool allowlists, strict schemas, minimal
context, and server-side authorization. Never rely on a prompt alone to
enforce access control.

### 12.6 AI provider abstraction

Define an internal interface for: - Structured extraction. - Text
generation. - Summarization. - Embeddings, if used. - Usage metadata.

The adapter should normalize provider errors, timeouts, token usage, and
model identifiers. Provider-specific request objects must not leak into
domain code.

------------------------------------------------------------------------

## 13. Voice Calling Architecture

### 13.1 Components

-   Call policy service.
-   Outbound call request service.
-   Durable call queue.
-   Voice provider adapter.
-   Provider webhook endpoint.
-   Call state processor.
-   Transcript/summary processor.
-   CRM update service.
-   Usage/cost recorder.
-   Human handoff mechanism.
-   Global outbound kill switch.

### 13.2 Outbound call sequence

``` mermaid
sequenceDiagram
    participant WF as Workflow Worker
    participant POL as Call Policy Service
    participant DB as PostgreSQL
    participant VP as Voice Provider
    participant WH as Verified Webhook
    participant AI as AI Processing
    WF->>POL: Request call for lead
    POL->>DB: Check org, consent, opt-out, hours, limits, status
    DB-->>POL: Current policy state
    alt Allowed
        POL->>DB: Persist call request and idempotency key
        POL-->>WF: Queue call job
        WF->>VP: Initiate call via adapter
        VP-->>WF: Provider call ID / accepted status
        VP->>WH: Call status events
        WH->>DB: Persist verified event idempotently
        WH-->>VP: Acknowledge promptly
        DB->>AI: Schedule transcript/result processing
        AI->>DB: Save validated summary and permitted fields
    else Not allowed
        POL-->>WF: Deny with safe reason
        WF->>DB: Record skipped/denied outcome
    end
```

### 13.3 Important call rules

-   Do not initiate outreach until applicable policy checks pass.
-   Check the suppression state immediately before the provider request.
-   Verify provider webhooks.
-   Deduplicate webhook event IDs and call IDs.
-   Treat provider "accepted" as accepted for processing, not as a
    completed call.
-   Handle call status events that arrive out of order.
-   Use a defined state transition table.
-   Do not automatically retry every no-answer result without configured
    limits.
-   Record the policy version or decision reference where appropriate.
-   Store recordings/transcripts only when permitted and configured.
-   Support a global and per-agent outbound stop control.

------------------------------------------------------------------------

## 14. Messaging and Unified Inbox Architecture

### 14.1 Inbound message flow

1.  Provider sends an event to the webhook endpoint.
2.  Verify signature and provider account mapping.
3.  Persist/deduplicate the event.
4.  Resolve the organization and conversation/contact.
5.  Store the message with provider ID and delivery metadata.
6.  Evaluate whether an AI response workflow is allowed.
7.  Queue the response workflow.
8.  Generate a draft or structured response using verified context.
9.  Re-check opt-out, channel policy, human ownership, and workflow
    state.
10. Send through the provider adapter.
11. Store the send result and delivery events.
12. Escalate if the message is ambiguous, sensitive, or outside approved
    scope.

### 14.2 Human ownership

A conversation should track: - Assigned user/team. - Ownership mode:
`ai`, `human`, or `unassigned`. - Automation pause state. - Last
inbound/outbound activity. - Escalation reason. - Current response SLA.

When a person takes over, pending automated sends must be cancelled or
re-evaluated. A race condition must not allow an AI reply to be sent
after the human has taken ownership.

### 14.3 Channel abstraction

Use a common internal message model while preserving provider-specific
metadata. Do not assume every channel supports the same template rules,
delivery receipts, interactive elements, or session windows.

------------------------------------------------------------------------

## 15. Property Matching Architecture

### 15.1 Matching pipeline

1.  Normalize the lead's stated requirements.
2.  Identify hard constraints: intent, availability, location, budget,
    and required configuration.
3.  Query PostgreSQL using indexed structured fields.
4.  Remove unavailable or ineligible properties.
5.  Rank remaining results by preferences.
6.  Optionally use embeddings for subjective preference similarity.
7.  Return property IDs, verified facts, freshness indicators, and match
    reasons.
8.  Present results for AI drafting or human review.
9.  Track which recommendations were shown and any customer feedback.

### 15.2 Ranking rules

-   Hard constraints must not be silently overridden by semantic
    similarity.
-   Price comparisons must use the correct currency and units.
-   Missing data should be represented as unknown, not as a match.
-   Availability must be checked again before making a definite claim or
    booking a visit.
-   Ranking should be explainable and testable.
-   Do not use protected characteristics or proxies for discriminatory
    housing decisions.

------------------------------------------------------------------------

## 16. Appointment and Calendar Architecture

### 16.1 Booking service

The booking service owns appointment state and is the only path for
booking/rescheduling through the application.

It must: - Validate organization, user, lead, property, and appointment
policy. - Resolve the correct time zone. - Check availability at booking
time. - Prevent double-booking through a transaction, constraint, lock,
or provider-supported reservation mechanism as appropriate. - Persist
the appointment before sending confirmation. - Create the related
calendar synchronization job. - Create reminders and follow-up jobs. -
Cancel or revise related jobs on appointment changes.

### 16.2 External calendar sync

The internal appointment is the application's source of truth for its
booking workflow. External calendar events are synchronized
representations unless a documented integration design says otherwise.

Handle: - Provider rate limits. - Revoked access. - Event edits made
externally. - Duplicate sync events. - Time-zone and daylight-saving
changes. - Cancellation and rescheduling. - Sync conflicts.

Do not claim a booking is confirmed if the required availability check
or persistence operation failed.

------------------------------------------------------------------------

## 17. Security Architecture

### 17.1 Secrets and environment configuration

-   Use separate development, staging, and production environments.
-   Store secrets in the deployment platform's secret manager or a
    suitable encrypted store.
-   Keep `.env.example` limited to variable names and safe placeholders.
-   Never commit real credentials.
-   Never use `NEXT_PUBLIC_` for service-role keys, provider secrets, or
    private tokens.
-   Rotate credentials after suspected exposure.
-   Use distinct credentials and scopes for different
    providers/environments.

### 17.2 Request security

-   Validate every body, query parameter, and path parameter.
-   Apply request size limits.
-   Apply rate limits to public forms, authentication, expensive AI
    tasks, and outbound communication.
-   Verify webhook signatures and timestamps/replay protections where
    the provider supports them.
-   Avoid trusting arbitrary callback URLs or fetching user-supplied
    URLs without SSRF controls.
-   Use secure session/cookie settings according to the framework's
    current guidance.
-   Return sanitized errors to clients.

### 17.3 File security

-   Store private documents in protected buckets.
-   Use signed, short-lived access URLs when appropriate.
-   Validate file type, size, and upload permissions.
-   Do not expose predictable public paths for sensitive files.
-   Enforce parent-record authorization before generating download
    links.
-   Define malware scanning and retention needs for uploaded files
    before broad production use.

### 17.4 Sensitive data

-   Limit access to call recordings, transcripts, identity documents,
    and finance data.
-   Avoid copying complete provider payloads into general logs.
-   Encrypt data in transit and use provider-supported encryption at
    rest.
-   Define retention and deletion schedules.
-   Record access to sensitive resources where justified.
-   Do not send sensitive data to an AI provider unless the use case,
    provider terms, and customer configuration permit it.

### 17.5 AI and action safety

-   AI outputs are untrusted until schema-validated.
-   Authorization is enforced by server code.
-   Outbound actions re-check policy immediately before execution.
-   Sensitive actions use approvals.
-   Every agent has bounded tools, context, and usage limits.
-   Agents can be paused independently.
-   A global outbound kill switch must stop new call/message jobs and
    cause pending jobs to re-check policy.
-   Human handoff overrides conflicting automated replies.

------------------------------------------------------------------------

## 18. Data Privacy, Consent, and Retention

The launch market must be decided before enabling production outreach.
Requirements may differ by jurisdiction, channel, recipient type, and
recording method.

Architecture requirements: - Store channel-specific communication
permissions and opt-out state. - Record the source and timestamp of
permission where required. - Check applicable policies immediately
before sending or calling. - Honor opt-outs promptly and cancel pending
jobs when applicable. - Define retention periods for lead data,
messages, call recordings, transcripts, documents, and logs. - Support
authorized export, correction, and deletion workflows. - Maintain
necessary suppression records where legally appropriate without
retaining unnecessary data. - Document provider subprocessors and
cross-border processing. - Obtain appropriate recording notices/consents
where required. - Clearly identify AI involvement where required or
appropriate. - Provide human contact or escalation options.

Do not treat possession of a phone number or an enquiry as blanket
permission for every channel and every future outreach purpose. Legal
and provider requirements must be reviewed for the selected market
before launch.

------------------------------------------------------------------------

## 19. Observability and Operations

### 19.1 Correlation IDs

Carry a correlation ID across: - Lead intake. - Domain events. -
Workflow runs. - Agent runs. - Tool calls. - Provider requests. -
Webhook callbacks. - Audit records.

This allows an operator to reconstruct a lead journey without searching
unrelated logs.

### 19.2 Structured log fields

Where appropriate: - Timestamp. - Environment. - Service/component. -
Organization ID. - Correlation ID. - Workflow/job/run ID. - Provider
name. - Action type. - Result status. - Duration. - Error code. - Retry
attempt.

Do not log credentials, full payment details, or complete conversation
bodies by default.

### 19.3 Metrics

-   Request latency and error rate.
-   Queue depth and oldest job age.
-   Workflow success/failure rate.
-   Retry and dead-letter counts.
-   Provider latency and availability.
-   Call and message outcome rates.
-   AI latency, token usage, and estimated cost.
-   Cost per organization/workflow.
-   Webhook processing delay.
-   Appointment conflict rate.
-   Integration synchronization lag.

### 19.4 Alerts

Alert on: - Sustained queue backlog. - Repeated provider failures. -
Webhook signature failures above baseline. - Sudden increases in
call/message volume or cost. - Outbound kill switch activation. -
Repeated RLS/authorization failures. - Jobs stuck in running state. -
Integration credentials expiring or being revoked. - Backup/recovery
failures where monitoring is available.

### 19.5 Incident controls

Document how to: - Pause outbound calls and messages. - Disable a single
integration. - Pause a workflow version. - Stop a worker safely. -
Rotate provider credentials. - Reprocess a failed job without
duplication. - Restore data from backup. - Communicate an incident to
affected customers.

------------------------------------------------------------------------

## 20. Reliability and Failure Handling

  -----------------------------------------------------------------------
  Failure                             Expected behavior
  ----------------------------------- -----------------------------------
  Duplicate lead webhook              Deduplicate by provider
                                      event/idempotency key

  Provider timeout                    Mark outcome unknown or retryable;
                                      reconcile before repeating side
                                      effect

  Duplicate message event             Store once; do not trigger
                                      duplicate response

  Out-of-order call events            Apply valid state transitions and
                                      retain event history

  LLM timeout                         Bounded retry or safe fallback;
                                      never assume success

  Invalid model output                Reject, retry with a controlled
                                      policy, or escalate

  Appointment conflict                Reject booking and return
                                      alternative slots

  Opt-out during queued workflow      Re-check suppression and cancel
                                      applicable action

  Human takes over during AI response Re-check ownership immediately
                                      before send

  Worker crashes                      Lease/visibility timeout permits
                                      recovery

  Provider account disconnected       Pause affected actions and notify
                                      authorized users

  Cost limit reached                  Block or pause applicable
                                      nonessential actions and alert

  Database transaction fails          Roll back related writes; do not
                                      emit success event

  Calendar sync fails                 Keep internal state visible and
                                      mark sync pending/failed
  -----------------------------------------------------------------------

Use exponential backoff with jitter for retryable failures. Never retry
indefinitely. For operations where the provider may have completed an
action despite a timeout, reconcile using the provider's idempotency
mechanism or query its status before attempting the side effect again.

------------------------------------------------------------------------

## 21. Performance and Scaling Strategy

### 21.1 MVP scale

Start with: - One Next.js application. - One Supabase project per
environment. - PostgreSQL indexes and paginated queries. - A durable
worker process for long-running tasks. - One voice provider and one
primary messaging channel. - Limited, measured use of Realtime. -
Precomputed or query-optimized dashboard metrics where necessary.

### 21.2 Growth stages

**Stage 1: Pilot** - Modular monolith. - Core relational tables. -
Code-defined workflows. - One worker deployment. - Basic monitoring and
provider cost attribution.

**Stage 2: Early commercial** - Dedicated queues for voice, messaging,
and general workflows if contention appears. - Better workflow
dashboards and dead-letter review. - Query optimization and aggregate
tables. - Per-organization quotas and provider rate limits. - Stronger
operational runbooks.

**Stage 3: Larger scale** - Separate workers by workload or provider. -
Dedicated analytics pipeline if operational queries affect
transactions. - Partition high-volume event tables if measurement
justifies it. - Dedicated search service only if PostgreSQL search is
insufficient. - More sophisticated tenant-level capacity controls.

Do not split services simply because modules have different names. Split
when there is a clear scaling, security, deployment, or ownership
reason.

------------------------------------------------------------------------

## 22. Deployment and Environment Strategy

### 22.1 Environments

-   **Local:** Mock providers, seeded test data, no real outreach.
-   **Development:** Shared development integrations with test
    credentials.
-   **Staging:** Production-like configuration, synthetic or approved
    test data, provider sandbox accounts.
-   **Production:** Real customer data, restricted credentials,
    monitoring, backups, approved outbound communication.

Never use production customer data as casual development seed data.

### 22.2 CI/CD checks

Before merging or deploying: - Formatting and lint. - Type checking. -
Unit tests. - Integration tests where infrastructure is available. -
RLS/tenant isolation tests. - Build. - Dependency/security checks. -
Migration review. - Environment variable validation. - Deployment smoke
tests.

### 22.3 Database migration policy

-   Every schema change is version-controlled.
-   Review migrations before production.
-   Test migrations against staging data shape.
-   Prefer backward-compatible expand-and-contract changes for deployed
    systems.
-   Have a rollback or forward-fix plan.
-   Never let an AI coding tool silently modify production schema.
-   Seed development data separately from production data.
-   Review RLS and indexes alongside schema changes.

### 22.4 Backups and recovery

-   Confirm database backup capabilities and retention for the selected
    plan.
-   Back up critical configuration and migration files.
-   Test restoration periodically.
-   Document recovery point objective (RPO) and recovery time objective
    (RTO).
-   Do not assume a backup is useful until restoration has been tested.

------------------------------------------------------------------------

## 23. API and Integration Contracts

### 23.1 Internal API conventions

-   Use typed request and response schemas.
-   Return consistent error codes and messages.
-   Use pagination for collections.
-   Validate all IDs against organization scope.
-   Apply rate limits and request timeouts.
-   Use idempotency keys for side-effecting requests.
-   Avoid exposing internal provider error bodies.
-   Version external contracts when compatibility requires it.

### 23.2 Integration adapter contract

Each provider adapter should implement the relevant subset of
operations, such as: - `validateConfiguration` - `sendMessage` -
`initiateCall` - `getCallStatus` - `verifyWebhook` -
`normalizeWebhookEvent` - `getUsage` - `disconnect` or `revoke`, where
supported

Use capability discovery rather than assuming every provider supports
every operation. Normalize errors into categories such as retryable,
non-retryable, rate-limited, unauthorized, invalid input, and unknown
outcome.

### 23.3 Webhook processing contract

1.  Receive request with size/time limits.
2.  Verify signature and replay protections where supported.
3.  Parse and validate provider payload.
4.  Resolve provider account to an organization through trusted
    integration metadata.
5.  Deduplicate provider event ID.
6.  Persist the event or durable processing job.
7.  Acknowledge promptly.
8.  Process asynchronously.
9.  Record final status and alert on exhaustion.

Do not trust an organization ID embedded in an unverified webhook
payload.

------------------------------------------------------------------------

## 24. Dashboard and Reporting Architecture

### 24.1 Data flow

-   Core records remain in normalized tables.
-   Small, operational metrics can be calculated with indexed SQL
    queries.
-   Expensive aggregates can use views or summary tables.
-   Views exposed to authenticated clients must be reviewed for RLS
    behavior. Prefer security-invoker views where supported, or keep
    sensitive reporting behind protected server-side queries.
-   Report definitions must document cohort, time zone, date basis, and
    status inclusion.
-   AI reporting summarizes authorized query results; it does not
    replace the query engine.

### 24.2 Metric definitions

For every displayed metric, define: - Numerator and denominator. - Date
field used. - Time zone. - Included/excluded statuses. - Attribution
method. - Refresh delay. - Permission scope.

Avoid mixing projected commission, invoiced revenue, and cash received
in a single number.

------------------------------------------------------------------------

## 25. Testing Strategy

### 25.1 Unit tests

-   Domain state transitions.
-   Permission evaluation.
-   Consent and suppression rules.
-   Lead normalization and duplicate matching.
-   Property filtering and ranking.
-   Financial arithmetic.
-   Workflow retry rules.
-   Event idempotency.
-   Metric definitions.
-   Provider error classification.

### 25.2 Integration tests

-   Supabase RLS for multiple organizations.
-   Storage policy enforcement.
-   Lead webhook verification and ingestion.
-   Voice/messaging adapter sandbox behavior.
-   Calendar availability and conflict handling.
-   Job retry and recovery.
-   Transactional outbox processing.
-   Audit and usage recording.
-   AI output schema validation.

### 25.3 End-to-end tests

-   New agency setup and invitation.
-   Lead intake to CRM.
-   AI qualification using mocked/sandbox call results.
-   Property matching.
-   Appointment booking.
-   Follow-up cancellation after opt-out.
-   Human takeover preventing automated send.
-   Provider timeout recovery.
-   Cross-tenant access denial.
-   Agent pause and global outbound kill switch.

### 25.4 AI evaluations

Maintain a versioned evaluation set for: - Correct extraction. - Missing
information. - Hallucination resistance. - Property match accuracy. -
Prompt injection. - Escalation decisions. - Opt-out handling. -
Structured output compliance. - Relevant languages and accents.

A prompt or model change should be evaluated before rollout, especially
when it changes outbound behavior.

------------------------------------------------------------------------

## 26. Architecture Decision Records

Record decisions in `docs/DECISIONS.md`. Each entry should contain
context, options, decision, consequences, owner, and date.

Initial decisions to document: 1. Modular monolith vs. services. 2.
Background job/queue technology. 3. Voice provider and abstraction. 4.
Messaging provider and channel. 5. Whether n8n is platform-managed or
customer-managed. 6. Tenant membership and permission model. 7. Contact
vs. lead identity model. 8. Recording/transcript storage and retention.
9. Hosting region and data residency. 10. Reporting and analytics
strategy. 11. AI model provider and data-processing terms. 12.
Customer-managed vs. platform-managed provider credentials.

------------------------------------------------------------------------

## 27. Implementation Order

### Phase 1: Foundation

-   Repository and environments.
-   Supabase Auth.
-   Organization and membership model.
-   Authorization utilities and RLS.
-   Database migrations and seed data.
-   UI shell and design system.
-   Logging and audit framework.
-   CI checks.

**Exit criteria:** Multiple test organizations are isolated and all
protected actions verify membership and permissions.

### Phase 2: Core CRM

-   Leads and contacts.
-   Properties.
-   Tasks.
-   Appointments.
-   Deals.
-   Activity timeline.
-   Dashboard basics.

**Exit criteria:** Users can complete the core manual workflow with
accurate data and no AI dependency.

### Phase 3: Event and integration foundation

-   Webhook verification.
-   Integration records.
-   Idempotency.
-   Event/outbox processing.
-   Durable jobs and retry behavior.
-   Integration health display.

**Exit criteria:** Duplicate events do not duplicate business actions;
failed events can be reviewed and recovered.

### Phase 4: AI qualification and voice

-   Provider adapter.
-   Call policy service.
-   Call queue and state machine.
-   Webhook event processing.
-   Structured extraction.
-   Human handoff.
-   Cost tracking.

**Exit criteria:** Simulated or sandbox calls update CRM correctly,
respect suppression, and can be stopped.

### Phase 5: Follow-up and appointments

-   Workflow templates.
-   Delayed jobs.
-   Appointment availability checks.
-   Reminders and cancellation behavior.
-   Human ownership and stop conditions.

**Exit criteria:** The lead-to-appointment flow works end to end under
success, failure, duplicate-event, opt-out, and human-takeover
scenarios.

### Phase 6: Hardening and pilot

-   Tenant-isolation review.
-   Security testing.
-   Provider outage tests.
-   Monitoring and alerts.
-   Backup restore test.
-   Privacy and consent review.
-   Pilot metrics and support process.

**Exit criteria:** The product meets agreed release gates and can be
operated safely for a limited pilot.

------------------------------------------------------------------------

## 28. Definition of Architecture Complete

The architecture is ready for MVP implementation when: - The module
boundaries are understood. - The tenant and permission model is
documented. - The database design is mapped to the domain model. - The
event/job model is selected. - Provider contracts are defined. - The
lead-to-appointment workflow is documented. - AI tools and their
permissions are enumerated. - Opt-out, human takeover, retry, and
kill-switch behavior is defined. - Environments, migrations, testing,
monitoring, and recovery procedures are planned. - Open decisions are
recorded rather than silently guessed.

## 29. Final Recommendation

Build Real Estate AI OS as a secure, event-driven modular monolith using
Next.js, TypeScript, Supabase PostgreSQL, and a durable background
execution mechanism. Keep domain rules deterministic, place provider
integrations behind adapters, and restrict AI agents to typed tools with
server-enforced permissions.

The first production-quality milestone should be a complete
lead-to-appointment workflow with tenant isolation, consent-aware
outreach, reliable webhook handling, structured AI qualification,
property matching, human takeover, workflow observability, and cost
tracking. Expand the system only after that workflow is proven reliable
with a pilot agency.
