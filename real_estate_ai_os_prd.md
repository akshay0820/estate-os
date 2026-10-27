# Real Estate AI OS

## Product Requirements Document (PRD)

**Working product name:** Real Estate AI OS\
**Product owner:** BlazeReach AI\
**Document status:** Initial product specification\
**Version:** 1.0\
**Last updated:** 24 October 2026\
**Primary implementation approach:** Claude Code, Next.js, Supabase,
AI/voice providers, and selected workflow tools

------------------------------------------------------------------------

## 1. Executive Summary

Real Estate AI OS is a multi-tenant SaaS platform designed to help real
estate agencies manage and automate their day-to-day operations from one
workspace. It combines lead capture, CRM, property inventory, AI voice
and messaging agents, follow-up workflows, appointment scheduling, deal
tracking, team operations, basic finance tracking, analytics, and
integration monitoring.

The product is not merely a CRM with AI features. It is an operational
system that receives business events, coordinates workflows, uses AI for
tasks that benefit from language understanding, executes approved
actions, records outcomes, and escalates exceptions to people.

The initial product should focus on a reliable end-to-end workflow:

**Lead received → record created or matched → assigned → contacted
through an approved channel → requirements captured → suitable
properties identified → appointment booked → salesperson notified →
follow-up scheduled → results tracked.**

The product aims to reduce repetitive manual work substantially, with a
long-term target of automating approximately 60--80% of suitable
repetitive tasks. This is a target to validate with pilot customers, not
a guaranteed outcome. Human judgment remains important for negotiation,
contractual commitments, sensitive customer issues, financial approvals,
and exceptional cases.

## 2. Product Vision

Give every real estate agency an AI-enabled operating system that helps
its team respond to enquiries faster, keep customer information
accurate, coordinate property visits, move opportunities through the
sales pipeline, and understand business performance.

### 2.1 Product principles

1.  **One operational workspace:** Keep leads, properties,
    conversations, appointments, deals, tasks, and AI activity
    connected.
2.  **Automation with accountability:** Every automated action has a
    trigger, execution record, outcome, and responsible workflow.
3.  **Human control:** Staff can take over conversations, pause agents,
    approve sensitive actions, and override automation.
4.  **Reliable before autonomous:** Prefer deterministic business rules
    for predictable tasks and AI for language-heavy tasks.
5.  **Secure by default:** Tenant isolation, least-privilege access,
    consent checks, and auditability are foundational.
6.  **Evidence-based AI:** Agents answer property questions from
    approved, current records rather than inventing details.
7.  **Measurable value:** Track response time, qualified leads,
    appointments, conversion, time saved, and AI operating cost.
8.  **Configurable operations:** Agencies can configure pipelines,
    fields, assignment rules, business hours, templates, and workflows.

## 3. Problem Statement

Real estate agencies often manage enquiries across website forms,
listing portals, advertising platforms, phone calls, WhatsApp, email,
and spreadsheets. Information is fragmented, response times vary,
follow-ups are missed, property availability becomes outdated, and
managers struggle to see which activities generate revenue.

Salespeople spend time on repetitive work such as calling every new
lead, asking the same qualification questions, sending reminders,
updating CRM records, finding properties, and preparing activity
reports. Existing tools may solve individual problems but do not always
coordinate the entire workflow.

### 3.1 Problems to solve

-   Leads arrive through disconnected channels.
-   Enquiries are not always contacted quickly.
-   Customer requirements are stored inconsistently.
-   Follow-ups depend on individual discipline.
-   Suitable properties are difficult to identify at scale.
-   Appointment booking and reminders require manual coordination.
-   Managers cannot easily trace what an AI or employee did.
-   AI and telephony costs are difficult to attribute to outcomes.
-   Owners lack a consolidated view of sales, operations, and financial
    indicators.

## 4. Goals and Non-Goals

### 4.1 Product goals

-   Centralize agency leads, contacts, properties, conversations,
    appointments, deals, and tasks.
-   Capture leads through configured integrations and secure webhooks.
-   Reduce time between enquiry and first permitted response.
-   Automate repeatable qualification, follow-up, reminder, and
    record-update workflows.
-   Provide AI voice and messaging workflows with human handoff.
-   Match customer requirements against verified property inventory.
-   Give owners a consolidated operational dashboard.
-   Track workflow failures, AI activity, provider usage, and estimated
    costs.
-   Support multiple agencies securely from one application.
-   Provide a foundation that can grow from a pilot product into a
    commercial SaaS.

### 4.2 Non-goals for the initial release

-   Replacing a full accounting or ERP system.
-   Replacing property listing marketplaces.
-   Building a proprietary foundation model or telephony network.
-   Fully autonomous negotiation or contract execution.
-   Automatically making legal conclusions about property documents.
-   Supporting every portal, country, language, and communication
    provider at launch.
-   Guaranteeing a fixed percentage of work will be automated before
    pilot validation.
-   Building a complex microservices architecture before scale requires
    it.

## 5. Target Customers and Personas

### 5.1 Primary customer

A real estate agency or brokerage that receives regular buyer, seller,
tenant, landlord, or investor enquiries and has a team responsible for
converting those enquiries into property visits and transactions.

### 5.2 Personas

**Agency owner** - Wants to see leads, appointments, deals, commissions,
team activity, and AI performance. - Needs control over costs,
permissions, and risky actions. - Measures success through response
speed, conversion, revenue, and operational efficiency.

**Sales manager** - Assigns leads, monitors follow-ups, reviews stalled
deals, and coaches salespeople. - Needs workload visibility, escalation
rules, and team reports.

**Salesperson / property consultant** - Needs a clear daily task list,
complete customer context, suitable property recommendations, and a fast
way to take over AI conversations.

**Operations administrator** - Configures pipelines, imports data,
maintains inventory, manages users, and connects integrations.

**Customer / lead** - Wants timely, accurate answers, relevant
properties, convenient appointment scheduling, and an easy way to reach
a person or stop communications.

## 6. Product Scope and Release Strategy

### 6.1 MVP scope

The MVP should complete one valuable workflow end to end and include
enough supporting functionality for a real agency to use it.

1.  Authentication and organization workspaces.
2.  Roles and permissions.
3.  Lead and contact CRM.
4.  Property inventory.
5.  Basic deal pipeline and tasks.
6.  Lead intake via website form and generic webhook.
7.  Duplicate detection and lead assignment.
8.  One AI voice provider integration, behind a provider abstraction.
9.  One approved messaging channel, prioritized by pilot-market needs.
10. Lead qualification and structured extraction.
11. Property matching using structured filters.
12. Appointment scheduling and confirmation.
13. Configurable follow-up workflow with stop conditions.
14. Activity timeline and unified execution logs.
15. Executive dashboard with core metrics.
16. AI agent controls, usage monitoring, and human handoff.
17. Audit logs, tenant isolation, and operational monitoring.

### 6.2 Post-MVP scope

-   Additional property portal and advertising integrations.
-   Advanced marketing attribution.
-   Finance and commission management.
-   Document classification and field extraction.
-   Advanced forecasting and recommendations.
-   Custom workflow builder.
-   Multiple AI providers and advanced routing.
-   Client portal.
-   White-label branding.
-   Advanced enterprise permissions and reporting.

### 6.3 Suggested implementation milestones

**Milestone 1: Foundation** - Project setup, auth, organization
membership, RLS, UI shell, migrations, audit framework.

**Milestone 2: Core operations** - Leads, contacts, properties, tasks,
appointments, deals, activity timeline.

**Milestone 3: Lead ingestion** - Web forms, webhook endpoint,
deduplication, assignment, integration status.

**Milestone 4: AI qualification** - Voice integration, call events,
structured extraction, human handoff, call logs.

**Milestone 5: Follow-up and scheduling** - Workflow triggers, durable
jobs, stop conditions, appointment calendar, reminders.

**Milestone 6: Reporting and production readiness** - Dashboard, cost
tracking, error handling, tenant-isolation tests, monitoring, backup and
recovery checks.

------------------------------------------------------------------------

## 7. Information Architecture and Navigation

The application should use a consistent left sidebar, top navigation,
global search, organization selector, notification center, and account
menu.

### 7.1 Proposed navigation

**Overview** - Dashboard - Activity Feed

**Sales** - Leads - Contacts - Properties - Deals - Appointments - Tasks

**Communications** - Unified Inbox - Calls - Follow-ups

**AI Operations** - AI Agents - Workflows - Approvals - Execution Logs -
Usage and Costs

**Business** - Marketing Sources - Team - Finance - Reports

**Administration** - Documents - Integrations - Audit Logs - Settings

Navigation items should be permission-aware. A user should not see
administrative features they are not allowed to access.

## 8. Functional Requirements

Priority definitions: - **P0:** Required for MVP. - **P1:** Important
next release. - **P2:** Later enhancement.

### 8.1 Authentication, organizations, and access control

**Requirements** - P0: Users can sign up or accept an invitation, sign
in, sign out, and recover access. - P0: A user can belong to one or more
organizations if explicitly supported by membership records. - P0:
Organization data is isolated from all other organizations. - P0:
Organization owners/admins can invite and deactivate members. - P0:
Every protected server operation verifies the authenticated user and
organization membership. - P0: Database policies enforce
organization-level access. - P0: High-impact actions are recorded in
audit logs. - P1: Optional SSO and advanced enterprise provisioning.

**Initial roles** - Owner: Full organization control, billing and
sensitive configuration. - Admin: Manage settings, users, integrations,
and operational data, subject to owner-only restrictions. - Manager:
View team data, assign leads, manage pipelines, and review
performance. - Agent: Manage assigned leads, conversations,
appointments, tasks, and permitted records. - Finance: Access finance
and commission records without broad access to unrelated sensitive
data. - Read-only: View explicitly permitted records and reports.

Permissions should be implemented as explicit capabilities, not
scattered role-name checks. The final permission matrix should be
documented and tested.

### 8.2 Executive dashboard

**Requirements** - P0: Show date-range filters and organization time
zone. - P0: Show total and new leads, qualified leads, appointments,
active deals, won deals, and lead-to-appointment conversion. - P0: Show
lead source breakdown and sales funnel. - P0: Show upcoming appointments
and tasks requiring attention. - P0: Show recent automation activity and
failed workflow alerts. - P0: Show AI call and message volume with clear
cost attribution where data is available. - P1: Revenue, commission,
expense, and profitability cards. - P1: Team performance and lead
response SLA reports. - P2: Custom dashboard widgets and saved dashboard
layouts.

**Rules** - Every metric must have a documented definition, date basis,
and data source. - Dashboard numbers must respect permissions and
organization boundaries. - Loading, empty, partial-data, and error
states must be designed. - Avoid claiming "real time" where data is
delayed by provider webhooks or scheduled synchronization.

### 8.3 Lead management CRM

**Lead fields** - Organization ID. - Name. - Phone and normalized
phone. - Email and normalized email. - Preferred communication
channel. - Lead source and campaign reference. - Lead type: buyer,
seller, tenant, landlord, investor, other. - Interested property or
properties. - Budget minimum and maximum. - Preferred locations. -
Property type and configuration. - Move/purchase timeline. -
Qualification status and reason. - Lead owner / assigned employee. -
Lead score and score explanation. - Contact permission and
channel-specific consent metadata where applicable. - Last contact
timestamp. - Next follow-up timestamp. - Lifecycle status. - Tags and
custom fields. - Created/updated timestamps.

**Requirements** - P0: Create, read, update, archive, search, filter,
sort, and paginate leads. - P0: Support table and Kanban views. - P0:
Show complete activity history. - P0: Assign or reassign a lead with
audit trail. - P0: Detect likely duplicates using normalized contact
details and configurable matching rules. - P0: Allow authorized users to
merge duplicate records while preserving relevant history. - P0: Import
and export with permission checks and validation. - P0: Support manual
lead creation. - P0: Record source attribution and original creation
time. - P1: Custom fields and saved views. - P1: Bulk actions with
confirmation and job status. - P1: Lead scoring configuration and score
explanation.

**Lead lifecycle** Suggested defaults: New → Attempting Contact →
Contacted → Qualified → Property Matching → Visit Scheduled → Visit
Completed → Negotiation → Won / Lost / Nurture.

Agencies can configure their own stages. Won/Lost should be terminal for
a particular opportunity but should not prevent a person from having a
future opportunity.

**Acceptance criteria** - A valid incoming lead creates exactly one lead
record per idempotency key. - Duplicate detection shows a possible match
instead of silently overwriting a record. - A user cannot access another
organization's lead by guessing its ID. - A lead detail view shows the
current owner, lifecycle, requirements, activities, and next action. -
Every AI-originated update records the agent/workflow and timestamp.

### 8.4 Contact management

-   P0: Maintain contact records for buyers, sellers, tenants,
    landlords, property owners, and other parties.
-   P0: Link contacts to leads, properties, appointments, conversations,
    and deals.
-   P0: Support multiple roles for one person.
-   P0: Store communication preferences and relevant opt-out status.
-   P1: Contact relationship map and household/company relationships.
-   P1: Duplicate merge and data quality tools.

Contact and lead models should avoid unnecessary duplication. Decide
whether a lead is a separate opportunity record linked to a
person/contact, rather than treating every enquiry as a separate person.

### 8.5 Property and inventory management

**Property fields** - Organization ID and unique property reference. -
Title and description. - Sale/rent type. - Property type. - Price and
currency. - Address, locality, city, region, postal code, and optional
coordinates. - Bedrooms, bathrooms, area, area unit, furnishing,
amenities. - Availability and listing status. - Images and media
references. - Owner/developer relationship. - Assigned agent. - Source
and external listing ID where relevant. - Verification status and
last-verified timestamp. - Commission terms, with appropriate
permissions. - Created/updated timestamps.

**Requirements** - P0: Create, edit, view, archive, search, and filter
properties. - P0: Filter by price, location, type, bedrooms,
availability, and relevant attributes. - P0: Track property status and
availability changes. - P0: Associate leads and deals with properties. -
P0: Upload and manage images through secure storage. - P0: Mark key
facts as verified/unverified and show last verification time. - P1:
Import/export and external listing synchronization. - P1:
Natural-language property search using structured filters plus semantic
ranking. - P1: AI-assisted listing description drafts. - P2: Advanced
map search and portfolio analytics.

**Property matching** - First apply hard constraints such as
availability, sale/rent intent, and defined budget range. - Rank
remaining candidates using preferences such as location, configuration,
amenities, and timing. - Explain why each property matched. - Never
invent property features or imply availability is confirmed if the
record is stale. - If no suitable property exists, say so and offer the
next best permitted action.

### 8.6 Lead intake and integrations

**Requirements** - P0: Provide a secure, configurable webhook endpoint
for lead intake. - P0: Provide a basic website form or embeddable
form. - P0: Validate payloads and normalize supported fields. - P0:
Authenticate webhooks using signatures or provider-specific
verification. - P0: Store external event IDs and process events
idempotently. - P0: Log processing status without exposing secrets or
unnecessary personal data. - P0: Provide retry and dead-letter/review
handling for failed events. - P0: Assign a source to each lead. - P1:
Integrations for selected advertising platforms, portals, email, and
messaging services. - P1: Integration health page with last successful
sync and error details.

The system must not claim that an integration is supported until the
provider API, account permissions, commercial terms, and regional
availability have been validated. Prefer official APIs and approved
partner methods. Do not scrape restricted services or bypass access
controls.

### 8.7 Unified communication inbox

**Requirements** - P0: Display supported messages and call summaries in
a unified contact timeline. - P0: Link conversations to a lead/contact
and, when applicable, a property/deal. - P0: Support assignment to a
human employee. - P0: Allow human takeover and pause conflicting
automation. - P0: Show channel, timestamps, delivery status, and
sender/recipient context. - P0: Support internal notes separate from
customer-visible messages. - P0: Respect channel permissions, consent,
opt-outs, and provider policies. - P1: Shared team inbox with collision
prevention and assignment status. - P1: AI-suggested replies and
summaries. - P2: Advanced inbox analytics and sentiment indicators, used
cautiously.

### 8.8 AI voice calling

**Requirements** - P0: Integrate one voice provider through a
server-side adapter. - P0: Support inbound and permitted outbound calls
according to the provider's capabilities. - P0: Link calls to a
lead/contact when identifiable. - P0: Receive and verify provider
webhooks for call status and outcomes. - P0: Store call metadata,
duration, outcome, provider call ID, and cost if available. - P0: Store
recordings/transcripts only when available, lawfully obtained, and
configured under retention policy. - P0: Generate structured summaries
and qualification fields from available transcripts/events. - P0:
Provide human transfer or callback task when the call needs
escalation. - P0: Apply calling-hour, consent, retry, opt-out, and
suppression rules before initiating a call. - P0: Provide an
organization-level outbound calling kill switch. - P1: Multiple voice
providers, language configuration, and advanced routing. - P1: Call
quality review and outcome analytics.

**Call workflow** 1. Validate organization, lead, permission, and
calling policy. 2. Create an outbound call request and idempotency key.
3. Queue the call request through a controlled worker. 4. Invoke the
provider server-side. 5. Process signed/verified status webhooks. 6.
Update call state and related activity. 7. Process transcript or
structured result if available. 8. Validate extracted fields and update
only permitted CRM fields. 9. Create next task or appointment
suggestion. 10. Record cost and workflow outcome. 11. Escalate failures
for review.

**Call states** Queued, Initiating, Ringing, In Progress, Completed, No
Answer, Busy, Failed, Cancelled, Needs Review.

**Acceptance criteria** - Duplicate provider webhooks do not create
duplicate calls or activities. - A call is not initiated if a relevant
suppression or opt-out rule applies. - Call completion updates the
correct lead and activity timeline. - A failed call does not trigger
unlimited retries. - Authorized users can pause all outbound calls for
an organization. - Call recordings and transcripts follow configured
access and retention controls.

### 8.9 AI messaging agent

-   P0: Support one selected messaging channel suitable for the pilot
    market.
-   P0: Send and receive messages through approved APIs.
-   P0: Use approved templates where a channel requires them.
-   P0: Store provider message IDs and delivery statuses.
-   P0: Check opt-out and channel policy before sending.
-   P0: Provide human handoff and stop automation when appropriate.
-   P0: Prevent duplicate sends through idempotency.
-   P1: Multiple channels, language options, and template management.
-   P1: Suggested replies based on approved knowledge.
-   P2: Advanced conversation analytics.

### 8.10 AI qualification and structured extraction

The qualification agent should gather relevant requirements and return
structured fields, not an unconstrained essay.

**Example output** - Intent. - Budget range and currency. - Preferred
locations. - Property type and configuration. - Purchase/rental
timeline. - Required amenities. - Contact preference. - Qualification
status. - Missing information. - Summary. - Suggested next action. -
Confidence or review flags.

**Requirements** - P0: Define a versioned schema for extraction. - P0:
Validate model output against that schema. - P0: Treat customer messages
and external content as untrusted input. - P0: Do not let instructions
inside a customer message override system permissions or tools. - P0:
Only update fields the agent is authorized to modify. - P0: Preserve
original source text or references where appropriate for review, subject
to privacy policy. - P0: Mark uncertain fields as unknown rather than
inventing values. - P0: Allow employees to correct AI-extracted
information. - P1: Configurable qualification criteria and explainable
lead scores.

### 8.11 Follow-up and workflow automation

**Workflow triggers** - Lead created. - Lead status changed. - Call
completed. - Message received. - Appointment
booked/cancelled/completed. - Deal stage changed. - Task due. -
Scheduled time reached. - Integration event received.

**Workflow capabilities** - P0: Define versioned workflows with trigger,
conditions, actions, delays, and exit rules. - P0: Support a small
curated set of templates before building a full visual editor. - P0:
Support retries with bounded attempts and backoff. - P0: Prevent
duplicate actions using idempotency keys. - P0: Support pause, resume,
cancel, and failure states. - P0: Respect business hours, channel
policy, consent, opt-outs, and suppression lists. - P0: Stop or
re-evaluate sequences when a lead replies, books, opts out, becomes
disqualified, or is taken over by a human, according to configured
rules. - P0: Log each step, input/output summary, duration, and
result. - P1: Visual workflow builder. - P1: Workflow versioning, test
mode, and simulation. - P2: Cross-workspace template marketplace.

**Initial workflow templates** 1. New lead acknowledgement and
qualification. 2. No-answer callback sequence. 3. Qualified lead
property recommendations. 4. Appointment confirmation and reminder. 5.
Post-site-visit feedback. 6. Stale lead re-engagement where permitted.
7. Failed integration alert. 8. Lead response SLA escalation.

A workflow must have a single execution owner. If n8n is used for a
workflow, the application should track its run and outcome instead of
independently executing the same steps in another engine.

### 8.12 Appointment and calendar management

-   P0: Create, view, update, cancel, and reschedule appointments.
-   P0: Link appointment to lead/contact, property, assigned employee,
    and organization.
-   P0: Validate availability on the server before booking.
-   P0: Prevent conflicting bookings where supported.
-   P0: Record appointment status and cancellation reason.
-   P0: Send permitted confirmation and reminder messages.
-   P0: Handle time zones explicitly.
-   P1: Google Calendar synchronization.
-   P1: Customer self-service rescheduling link.
-   P1: Check-in and post-visit feedback.
-   P2: Multi-property tour planning and route optimization.

**Appointment states:** Requested, Pending Confirmation, Confirmed,
Completed, Cancelled, No Show, Reschedule Requested.

### 8.13 Deal and pipeline management

-   P0: Create and manage opportunities linked to a contact, lead,
    property, and owner.
-   P0: Support configurable deal stages.
-   P0: Record expected value, expected commission, expected close date,
    and status.
-   P0: Record stage changes and loss reasons.
-   P0: Create tasks and reminders related to deals.
-   P0: Show a deal timeline.
-   P1: Forecasting based on configured stage probabilities and
    historical outcomes.
-   P1: Stalled-deal alerts.
-   P2: Advanced sales forecasting and portfolio analysis.

AI may summarize and recommend actions but must not make binding
commitments, change contractual terms, or send sensitive negotiation
messages without appropriate authorization.

### 8.14 Tasks and notifications

-   P0: Create tasks manually or through workflows.
-   P0: Assign tasks to a user and set due dates and priority.
-   P0: Support open, in progress, completed, and cancelled states.
-   P0: Show overdue tasks and tasks due today.
-   P0: Provide in-app notifications for assignments, appointment
    changes, failures, and approvals.
-   P1: Email or messaging notifications based on user preferences.
-   P1: Recurring tasks and configurable SLA escalation.

### 8.15 Finance and commission management

**MVP:** Basic usage/cost visibility and optional simple commission
records. Do not represent this as a full accounting system.

**P1 requirements** - Track income records, invoices/receivables,
expenses, commissions, due dates, and payment status. - Distinguish
expected, invoiced, received, and recognized amounts where applicable. -
Support currency and date-range filters. - Record who created or changed
financial records. - Restrict access through finance-specific
permissions. - Provide reports by period, source, salesperson, property,
and category. - Track AI/telephony/messaging costs by organization and
workflow when providers expose the necessary data. - Never initiate
payments or refunds autonomously in the initial product.

Financial calculations must be deterministic and tested. AI can
summarize financial data but must not be the source of truth for
arithmetic.

### 8.16 Documents

-   P1: Upload and link documents to properties, contacts, and deals.
-   P1: Store document metadata, access rules, version, and retention
    status.
-   P1: Support signed download URLs and restricted access.
-   P1: Allow document classification and extraction only with
    appropriate access controls.
-   P1: Track required-document checklists and expiration reminders.
-   P2: E-signature integrations and advanced document workflows.

AI output must be treated as an extraction aid, not a legal opinion or
proof of document validity.

### 8.17 AI agent command center

Each agent configuration should include: - Name and purpose. - Agent
type and version. - Enabled/paused status. - Permitted tools and data
scope. - Model/provider configuration reference. - Knowledge sources. -
Trigger/workflow associations. - Usage limits and cost controls. -
Escalation conditions. - Last run and recent run history.

**Agent monitoring requirements** - P0: List agents and current
status. - P0: View execution history, outcomes, failures, and related
records. - P0: Pause an agent or workflow. - P0: Configure a global
outbound communication kill switch. - P0: Show costs/usage where
available. - P0: Restrict tool access and enforce permissions
server-side. - P1: Agent configuration testing and evaluation suite. -
P1: Version comparison and controlled rollout. - P2: Advanced
multi-agent coordination.

Do not let an agent create arbitrary tools or acquire permissions
dynamically. Tool access should be explicitly configured and validated
by the backend.

### 8.18 Marketing and attribution

-   P0: Record lead source and campaign information where provided.
-   P1: Connect selected advertising sources through supported APIs.
-   P1: Track campaign spend where available and calculate cost per lead
    and qualified lead.
-   P1: Generate AI-assisted listing and campaign copy for human review.
-   P2: Campaign recommendations and more advanced attribution models.

Avoid attributing revenue to a channel without defining the attribution
model and handling multiple touchpoints.

### 8.19 Team management

-   P0: Maintain team members and role assignments.
-   P0: Assign leads, appointments, and tasks.
-   P0: Show workload and overdue tasks.
-   P1: Configure lead assignment rules by geography, property type,
    availability, or workload.
-   P1: Team reports with clearly defined metrics.
-   P2: Advanced performance coaching and capacity planning.

### 8.20 Integrations and settings

-   P0: Store integration metadata, status, capabilities, last sync, and
    error summaries.
-   P0: Keep secrets server-side and never return them to the browser.
-   P0: Support connect, test, disconnect, and reconnect flows where the
    provider allows.
-   P0: Show the scopes/permissions requested and any required
    administrator action.
-   P0: Support webhook signature validation and safe secret rotation.
-   P1: Integration health dashboard and configurable alerts.
-   P1: Provider abstraction for voice, messaging, email, and AI models.

### 8.21 Audit logs and approvals

-   P0: Record high-impact user and system actions.
-   P0: Include organization, actor, action, target type/ID, timestamp,
    and safe metadata.
-   P0: Distinguish human, AI agent, workflow, and external integration
    actors.
-   P0: Do not store secrets or unnecessary sensitive payloads in logs.
-   P0: Support approvals for configured high-risk actions.
-   P0: Approval records include requested action, requester/agent,
    reviewer, status, timestamps, and decision.
-   P1: Searchable audit log and export for authorized administrators.

------------------------------------------------------------------------

## 9. Core End-to-End User Journeys

### 9.1 New inbound lead to appointment

1.  A lead submits a form or arrives through an authorized integration.
2.  The intake service validates and normalizes the payload.
3.  The service checks idempotency and likely duplicates.
4.  A lead/contact record is created or linked.
5.  The lead is assigned based on organization rules.
6.  The system checks contact permissions and channel eligibility.
7.  The qualification workflow starts.
8.  An AI voice or messaging agent contacts the lead through the
    configured provider.
9.  The agent captures structured requirements and a summary.
10. The backend validates and saves permitted fields.
11. Property matching returns available candidates.
12. The agent offers suitable next steps.
13. An appointment is booked only after availability validation and
    customer confirmation.
14. The salesperson is notified.
15. The system schedules reminders and post-visit follow-up.
16. The dashboard and activity timeline update.
17. Any failure enters a retry or human-review path.

### 9.2 Human takes over an AI conversation

1.  A staff member opens a conversation.
2.  The staff member selects Take Over.
3.  The system marks the conversation as human-owned and pauses
    conflicting automation.
4.  The staff member sees prior messages, call summaries, requirements,
    and suggested properties.
5.  The staff member responds.
6.  The system records the action and keeps the AI paused until the
    configured resume condition is met.
7.  The staff member can resume automation or leave the conversation
    human-owned.

### 9.3 Lead opts out

1.  A lead communicates a clear opt-out or an authorized employee
    records it.
2.  The system records the opt-out with channel, time, source, and
    applicable scope.
3.  Pending sends/calls for that scope are cancelled or re-evaluated.
4.  Future workflow executions check the suppression state before
    sending.
5.  The opt-out event is visible in the activity history.
6.  Any legally required retention is handled according to the
    applicable policy.

### 9.4 Provider failure

1.  A provider request fails or times out.
2.  The workflow records a sanitized error.
3.  Retryable failures are retried using bounded exponential backoff.
4.  Non-retryable or exhausted failures enter a review queue.
5.  The responsible user receives an alert.
6.  The system does not silently mark the action successful.
7.  The dashboard shows degraded integration status where appropriate.

------------------------------------------------------------------------

## 10. UX and Design Requirements

### 10.1 Visual direction

-   Modern, minimal, premium B2B SaaS.
-   Dark charcoal, grey, white, and restrained bright accents such as
    blue, orange, or yellow.
-   Strong typography, clear hierarchy, consistent spacing, and
    accessible contrast.
-   Avoid excessive gradients, unnecessary glass effects, and decorative
    animation.
-   Use color consistently for statuses, with text/icon labels so color
    is not the only signal.

### 10.2 Layout

-   Collapsible sidebar.
-   Top bar with global search, organization selector, notifications,
    and profile menu.
-   Responsive main workspace.
-   Side panels for quick inspection where appropriate.
-   Consistent tables, filters, pagination, forms, empty states, and
    confirmation dialogs.

### 10.3 UX standards

-   Every async action shows loading, success, failure, and retry states
    where appropriate.
-   Destructive actions require confirmation and permission checks.
-   Forms show field-level validation and actionable errors.
-   Long-running imports and workflows show status and progress.
-   AI-generated information is visually distinguishable from verified
    human-entered facts.
-   The user can see why an automation ran and how to stop it.
-   Accessibility target: WCAG 2.2 AA where reasonably achievable.
-   Support keyboard navigation and sensible focus management.
-   Mobile layouts should support essential tasks, even if the full
    desktop dashboard is the primary experience.

------------------------------------------------------------------------

## 11. Technical Architecture

### 11.1 Recommended initial stack

-   **Frontend:** Next.js with TypeScript.
-   **UI:** Tailwind CSS and shadcn/ui.
-   **Charts:** Recharts or an equivalent maintained library.
-   **Database:** Supabase PostgreSQL.
-   **Authentication:** Supabase Auth.
-   **Authorization:** PostgreSQL Row Level Security plus server-side
    checks.
-   **Storage:** Supabase Storage.
-   **Realtime:** Supabase Realtime where it adds value.
-   **Search:** PostgreSQL full-text and structured filters; pgvector
    for later semantic search.
-   **AI:** Provider adapter for selected LLM services.
-   **Voice:** One selected voice provider, behind an internal adapter.
-   **Messaging:** Official APIs for the chosen channel.
-   **Workflow automation:** n8n for selected integrations initially,
    with clear ownership per workflow.
-   **Background jobs:** Durable queue/worker approach appropriate to
    expected volume; do not rely on an HTTP request remaining open for
    long-running work.
-   **Monitoring:** Error tracking, structured logs, provider health,
    and usage metrics.
-   **Deployment:** A managed web host plus managed Supabase, with
    environment separation and tested deployment procedures.

### 11.2 Logical architecture

1.  **Presentation layer:** Next.js UI.
2.  **Application/API layer:** Authenticated server-side actions and API
    routes.
3.  **Domain layer:** Lead, property, appointment, deal, permissions,
    and workflow rules.
4.  **Integration layer:** Adapters for voice, messaging, email,
    calendars, and lead sources.
5.  **Execution layer:** Durable jobs, scheduled workflows, retries, and
    event processing.
6.  **AI layer:** Structured extraction, summaries, property matching
    assistance, and approved tool calls.
7.  **Data layer:** Supabase PostgreSQL, Storage, and optional vector
    search.
8.  **Observability layer:** Audit logs, workflow logs, errors, usage,
    and alerts.

### 11.3 Architectural rules

-   Start with a modular monolith, not premature microservices.
-   Keep domain logic out of UI components.
-   Keep provider credentials on the server.
-   Validate every request at the server boundary.
-   Use database transactions for related critical writes.
-   Use durable background processing for calls, messages, retries,
    imports, and scheduled tasks.
-   Verify provider webhook signatures where supported.
-   Use idempotency keys for external events and outbound actions.
-   Make workflow steps observable and resumable where possible.
-   Keep provider-specific details behind adapters.
-   Never expose Supabase service-role credentials in the client bundle.
-   Never rely on the frontend alone for tenant isolation or
    authorization.

### 11.4 Suggested repository structure

``` text
src/
  app/
    (auth)/
    (dashboard)/
    api/
  components/
    ui/
    layout/
    shared/
  features/
    dashboard/
    leads/
    contacts/
    properties/
    conversations/
    calls/
    appointments/
    deals/
    tasks/
    agents/
    workflows/
    finance/
    settings/
  lib/
    auth/
    supabase/
    permissions/
    validation/
    observability/
  server/
    domain/
    services/
    repositories/
    integrations/
      voice/
      messaging/
      email/
      calendar/
      lead-sources/
    workflows/
    jobs/
    ai/
  types/
supabase/
  migrations/
  seed.sql
tests/
  unit/
  integration/
  e2e/
docs/
```

This is a starting organization, not a rigid rule. Follow the
conventions of the chosen framework and avoid needless abstraction.

------------------------------------------------------------------------

## 12. Initial Database Model

All organization-owned records must have an organization scope directly
or through a validated parent relationship. The schema below is a
planning model and must be refined into migrations with explicit foreign
keys, indexes, constraints, and RLS policies.

### 12.1 Core tables

-   `organizations`
-   `organization_members`
-   `profiles`
-   `roles` / `role_permissions` or equivalent capability model
-   `contacts`
-   `leads`
-   `lead_sources`
-   `properties`
-   `property_media`
-   `property_contacts` or `property_owners`
-   `deals`
-   `deal_activities`
-   `appointments`
-   `tasks`
-   `conversations`
-   `messages`
-   `calls`
-   `call_transcripts` or protected transcript references
-   `ai_agents`
-   `agent_versions`
-   `agent_runs`
-   `workflow_definitions`
-   `workflow_versions`
-   `workflow_runs`
-   `workflow_steps`
-   `integrations`
-   `integration_events`
-   `approvals`
-   `notifications`
-   `audit_logs`
-   `usage_records`
-   Later: `campaigns`, `expenses`, `invoices`, `commissions`,
    `documents`, `custom_fields`, `custom_field_values`.

### 12.2 Data modeling notes

-   A `contact` represents a person or organization; a `lead` represents
    a sales opportunity or enquiry. Decide and document the relationship
    so repeat enquiries do not create fragmented identities.
-   Use normalized phone/email fields for matching while preserving
    user-entered display values where needed.
-   Store money as integer minor units or an exact numeric type, plus
    currency. Never use floating-point types for financial values.
-   Store timestamps in UTC and render them in the organization or user
    time zone.
-   Use explicit status enums or validated status values.
-   Store external provider IDs and idempotency keys with uniqueness
    constraints in the appropriate scope.
-   Store large recordings/documents in object storage, not directly in
    ordinary database rows.
-   Store integration secrets in an appropriate server-side secret store
    or encrypted mechanism, not in plaintext fields exposed through
    ordinary queries.
-   Add `created_at`, `updated_at`, and, where useful, `created_by` and
    `updated_by`.
-   Use soft deletion only where it serves a defined recovery/audit
    purpose; define retention and final deletion separately.
-   Index organization ID and common filter fields, plus foreign keys
    and timestamps used in list views.
-   Avoid generic JSON blobs for core entities. JSONB is appropriate for
    provider payloads, flexible configuration, and carefully scoped
    metadata.

### 12.3 Required RLS and access tests

-   A user in Organization A cannot select, insert, update, or delete
    Organization B records.
-   A user cannot change `organization_id` to move a record into another
    organization.
-   A non-finance user cannot access finance-restricted records.
-   A regular agent cannot edit organization-wide integration secrets or
    security settings.
-   A user cannot access a file by guessing its storage path.
-   Server-side service credentials are used only in trusted server
    contexts and paired with explicit authorization checks.
-   Realtime subscriptions enforce the same tenant and record access
    expectations.
-   Test policies with multiple users and organizations, not only the
    owner account.

------------------------------------------------------------------------

## 13. API and Event Design

The exact endpoints should follow implementation conventions, but the
application should expose consistent, versionable domain operations.

### 13.1 Example API areas

-   `/api/leads`
-   `/api/contacts`
-   `/api/properties`
-   `/api/deals`
-   `/api/appointments`
-   `/api/tasks`
-   `/api/conversations`
-   `/api/calls`
-   `/api/agents`
-   `/api/workflows`
-   `/api/integrations`
-   `/api/webhooks/leads/{provider}`
-   `/api/webhooks/voice/{provider}`
-   `/api/webhooks/messaging/{provider}`

These are illustrative route families, not final API contracts.

### 13.2 Domain events

Use versioned events such as:

-   `lead.created.v1`
-   `lead.updated.v1`
-   `lead.qualified.v1`
-   `conversation.message_received.v1`
-   `call.completed.v1`
-   `appointment.booked.v1`
-   `appointment.cancelled.v1`
-   `deal.stage_changed.v1`
-   `workflow.failed.v1`
-   `integration.health_changed.v1`

Event records should include an event ID, organization scope, event
type/version, occurrence time, source, and a validated payload reference
or safe payload.

### 13.3 Event processing rules

-   Verify source authenticity.
-   Validate payload shape.
-   Persist the event or durable job before acknowledging where
    required.
-   Use idempotency keys.
-   Avoid running long AI tasks inside a webhook request.
-   Retry transient failures with bounded backoff.
-   Record exhausted failures for review.
-   Avoid placing secrets or unnecessary personal information in event
    payloads and logs.

------------------------------------------------------------------------

## 14. AI Behavior, Tooling, and Guardrails

### 14.1 Appropriate AI tasks

-   Extract customer requirements from messages or call transcripts.
-   Summarize conversations.
-   Draft messages for a defined context.
-   Recommend properties from verified inventory.
-   Categorize enquiry intent.
-   Suggest next steps.
-   Explain why a workflow failed using sanitized execution data.

### 14.2 Tasks that should remain deterministic

-   Authorization.
-   Tenant isolation.
-   Financial arithmetic.
-   Appointment conflict checks.
-   Consent and opt-out enforcement.
-   Workflow retry limits.
-   Deal and commission state transitions.
-   Provider signature verification.
-   Whether a record is actually saved.
-   Whether a message or call was actually delivered.

### 14.3 Tool contracts

AI tools should be narrow, typed, and permission-checked. Examples:

-   `get_lead`
-   `update_lead_fields`
-   `search_properties`
-   `get_verified_property_details`
-   `create_task`
-   `check_appointment_availability`
-   `request_appointment_booking`
-   `draft_customer_message`
-   `send_approved_message`
-   `request_human_handoff`

Each tool must validate organization scope, user/agent capability, input
schema, and applicable business rules. Sensitive actions should return
an approval request rather than execute directly.

### 14.4 Prompt injection and untrusted content

-   Treat customer messages, uploaded documents, web content, and
    provider transcripts as untrusted data.
-   Do not follow instructions in that content that attempt to change
    system policy, reveal secrets, or expand tool access.
-   Keep system instructions and credentials separate from retrieved
    content.
-   Limit tool results to the minimum required information.
-   Validate all AI output before writing it to the database or sending
    it externally.
-   Use test cases for malicious or manipulative inputs.

### 14.5 Evaluation

Maintain a versioned evaluation set covering: - Accurate extraction. -
Missing or ambiguous information. - Correct property matching. - Correct
refusal to invent facts. - Proper opt-out handling. - Correct human
escalation. - Resistance to prompt injection. - Correct structured
output. - Language and accent variation where relevant. - Appropriate
behavior when provider data is missing.

Review real-world failures with privacy safeguards and update prompts,
tools, and tests deliberately.

------------------------------------------------------------------------

## 15. Security, Privacy, and Compliance Requirements

This platform processes contact details, conversations, call metadata,
and potentially sensitive property and financial information. Security
and compliance must be part of implementation, not a later polish phase.

### 15.1 Security

-   Enforce tenant isolation through database policies and server
    authorization.
-   Use least-privilege roles for users, agents, integrations, and
    background workers.
-   Keep secrets server-side and rotate them when needed.
-   Verify provider webhooks.
-   Validate inputs and encode outputs appropriately.
-   Apply rate limits to authentication, public forms, and costly
    actions.
-   Protect against CSRF, XSS, SSRF, injection, and insecure direct
    object references as relevant to the stack.
-   Use signed, short-lived links for protected files.
-   Log security-relevant actions without logging credentials or
    unnecessary payloads.
-   Maintain separate development, staging, and production environments.
-   Test backups and recovery.
-   Review dependency and deployment security.

### 15.2 Privacy and data lifecycle

-   Collect only information needed for defined business purposes.
-   Define retention periods for leads, messages, call recordings,
    transcripts, documents, and logs.
-   Provide workflows for access, correction, export, and deletion where
    applicable.
-   Restrict recordings and transcripts to authorized roles.
-   Avoid using customer conversations to train unrelated models unless
    explicitly authorized and legally appropriate.
-   Define how provider data is processed, stored, and deleted.
-   Document subprocessors and cross-border data transfers where
    relevant.
-   Establish incident response and breach notification procedures.

### 15.3 Calling and messaging compliance

Before enabling outreach in a market, confirm applicable laws, provider
policies, consent requirements, calling-hour rules,
do-not-call/suppression requirements, recording disclosure/consent
rules, message template rules, and opt-out handling.

The system must: - Maintain channel-specific permission and suppression
state. - Check eligibility immediately before sending or calling. -
Honor opt-outs promptly. - Avoid unlimited retries. - Support an
organization-wide outbound kill switch. - Record the policy decision
without unnecessarily storing sensitive information. - Clearly identify
AI involvement where required or appropriate. - Offer human handoff.

Legal requirements vary by jurisdiction and channel. The platform should
be configurable and reviewed by qualified counsel for each target
market. This PRD is not legal advice.

### 15.4 Responsible AI

-   Do not use protected characteristics to prioritize or exclude people
    from housing opportunities.
-   Avoid discriminatory lead scoring or property recommendations.
-   Keep human review for consequential, exceptional, or ambiguous
    decisions.
-   Do not fabricate property details, prices, availability, legal
    status, or commitments.
-   Show uncertainty when information is incomplete.
-   Allow users to correct AI-generated data.
-   Monitor error rates and outcomes across relevant workflows.

------------------------------------------------------------------------

## 16. Non-Functional Requirements

These targets are initial engineering goals and should be validated
through testing and pilot usage.

### 16.1 Performance

-   Typical authenticated page navigation should feel responsive, with a
    target server response below 500 ms for common cached/lightweight
    operations where practical.
-   Common list queries should return quickly under expected pilot loads
    and use server-side pagination.
-   Expensive AI tasks and provider calls must run asynchronously.
-   Dashboard aggregates should not require loading every underlying row
    into the browser.
-   Search should support practical use across thousands to tens of
    thousands of records per organization, subject to indexes and query
    design.

### 16.2 Availability and recovery

-   Target 99.5% monthly application availability during early
    production, excluding planned maintenance and third-party outages,
    with a clear measurement method.
-   Define recovery time and recovery point objectives before production
    expansion.
-   Back up database and critical configuration data.
-   Test restoration, not just backup creation.
-   Show third-party provider degradation separately from application
    health.

### 16.3 Scalability

-   Start with a modular monolith and managed database.
-   Use pagination, indexes, connection pooling, and background jobs.
-   Isolate long-running workloads from interactive web requests.
-   Introduce queues and workers according to measured volume.
-   Define per-organization usage limits to prevent noisy-neighbor
    problems.

### 16.4 Reliability

-   Critical operations are idempotent where feasible.
-   Failed workflows are observable and recoverable.
-   External API requests have timeouts and bounded retries.
-   The system never marks a provider action successful solely because a
    request was submitted.
-   Data changes that must succeed together use transactions.
-   State transitions are validated server-side.

### 16.5 Accessibility and compatibility

-   Aim for WCAG 2.2 AA.
-   Support current major desktop browsers.
-   Provide responsive layouts for essential mobile workflows.
-   Use semantic controls, keyboard navigation, readable contrast, and
    meaningful error messages.

------------------------------------------------------------------------

## 17. Analytics and Success Metrics

Metrics must be defined precisely and calculated consistently.

### 17.1 Product success metrics

-   Time from lead receipt to first permitted attempt.
-   Percentage of leads with a successful first contact.
-   Percentage of leads with required qualification fields captured.
-   Qualified leads per source.
-   Appointment booking rate.
-   Appointment attendance rate.
-   Lead-to-deal conversion rate.
-   Follow-up completion rate.
-   Percentage of workflows completed without human intervention.
-   Human handoff rate.
-   Workflow failure rate.
-   AI cost per processed lead.
-   AI cost per qualified lead.
-   Staff time saved, measured through a pilot baseline and follow-up.
-   Customer opt-out and complaint rate.
-   Property data freshness and match accuracy.

### 17.2 Suggested pilot targets

These are hypotheses to validate, not promises: - Reduce median time to
first permitted response. - Increase the proportion of new leads
receiving a consistent first response. - Reduce missed follow-ups. -
Improve completeness of CRM qualification fields. - Keep workflow
failures visible and recoverable. - Demonstrate acceptable AI cost per
qualified lead. - Maintain low complaint and opt-out rates. - Show
measurable time savings for the agency team.

Set numerical targets only after collecting a baseline from pilot
agencies.

### 17.3 Metric definitions

-   **Lead response time:** Time between lead creation and first
    qualifying contact attempt or successful contact. Report both
    separately.
-   **Qualification rate:** Qualified leads divided by eligible leads in
    the same cohort.
-   **Appointment booking rate:** Leads with a confirmed appointment
    divided by the defined eligible lead cohort.
-   **Show rate:** Completed attended appointments divided by confirmed
    appointments, excluding appropriately defined cancellations.
-   **Workflow success rate:** Successful workflow runs divided by runs
    that reached a terminal state, with cancellations and test runs
    reported separately.
-   **Automation rate:** Eligible workflow instances completed without
    human intervention divided by eligible workflow instances. Define
    the eligible set explicitly.
-   **AI cost per qualified lead:** Attributable AI/telephony/messaging
    cost divided by qualified leads for the same period and attribution
    model.

------------------------------------------------------------------------

## 18. Testing and Acceptance Strategy

### 18.1 Unit tests

-   Input validation and normalization.
-   Lead scoring rules.
-   Property matching filters.
-   Permission helpers.
-   Financial calculations.
-   Workflow transition rules.
-   Retry and backoff logic.
-   Idempotency-key generation.
-   Metric calculations.

### 18.2 Integration tests

-   Supabase queries and RLS.
-   Lead webhook ingestion.
-   Provider webhook verification.
-   Voice provider adapter.
-   Messaging provider adapter.
-   Calendar availability checks.
-   Workflow execution and retries.
-   File access controls.
-   Audit event creation.

### 18.3 End-to-end tests

-   New user onboarding and organization setup.
-   Create and qualify a lead.
-   Add and match a property.
-   Complete a simulated AI call.
-   Process a call completion webhook.
-   Book an appointment without a conflict.
-   Pause automation after human takeover.
-   Honor a lead opt-out.
-   Recover from a provider timeout.
-   Verify that a user from another organization cannot access records.

### 18.4 Release gates

Do not enable real outbound calling or messaging until: - Consent and
suppression logic is tested. - Provider webhook verification is
active. - Duplicate sends/calls are prevented. - Kill switches work. -
Human handoff works. - Cost and usage tracking is visible. - Failure
alerts are configured. - Retention and access policies are documented. -
Pilot scripts and customer-facing disclosures are reviewed.

------------------------------------------------------------------------

## 19. Risks and Mitigations

  -----------------------------------------------------------------------
  Risk                    Impact                  Mitigation
  ----------------------- ----------------------- -----------------------
  Cross-tenant data       Severe privacy/security RLS, server
  exposure                incident                authorization,
                                                  adversarial
                                                  tenant-isolation tests

  AI invents property     Customer trust and      Verified inventory,
  details                 legal risk              retrieval, schema
                                                  validation, explicit
                                                  uncertainty

  Duplicate messages or   Customer complaints and Idempotency, provider
  calls                   cost                    IDs, suppression
                                                  checks, bounded retries

  Provider API outage     Interrupted operations  Adapters, retries,
                                                  health monitoring,
                                                  human fallback

  Poor call quality or    Low conversion and      Pilot evaluation,
  accent handling         customer frustration    scripts, language
                                                  testing, escalation

  Incorrect lead matching Missed opportunities    Explainable filters,
                                                  staff correction,
                                                  measurement

  Excessive AI costs      Poor margins            Per-workflow budgets,
                                                  cost attribution, usage
                                                  limits

  Unauthorized outreach   Legal and reputational  Consent records,
                          risk                    suppression lists,
                                                  jurisdiction review,
                                                  kill switch

  Outdated property       Misleading              Verification status,
  information             recommendations         freshness warnings,
                                                  owner updates

  Overly broad initial    Slow delivery and       Narrow MVP, staged
  scope                   fragile system          releases, pilot
                                                  feedback

  Unclear workflow        Duplicate or            One execution owner per
  ownership               conflicting automation  workflow

  Data model churn from   Expensive rework        Migrations,
  AI coding                                       architecture docs,
                                                  tests, code review

  AI-generated insecure   Vulnerabilities         Security review, static
  code                                            analysis, RLS tests,
                                                  dependency checks

  Staff distrusts         Low adoption            Transparent logs,
  automation                                      editable AI output,
                                                  easy handoff and
                                                  override
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## 20. Claude Code Development Workflow

Claude Code should be used as a development assistant, not as an
unrestricted autonomous production operator.

### 20.1 Before implementation

Create and maintain: - `PRD.md` --- this product specification. -
`ARCHITECTURE.md` --- component boundaries and data flow. -
`DATABASE.md` --- entity relationships and migration conventions. -
`SECURITY.md` --- permissions, RLS, secrets, and privacy decisions. -
`INTEGRATIONS.md` --- providers, credentials, webhook contracts, and
supported capabilities. - `WORKFLOWS.md` --- triggers, actions, exit
rules, retries, and owners. - `TESTING.md` --- test strategy and release
gates. - `DECISIONS.md` --- important architecture decisions and
rationale.

### 20.2 Implementation rules for coding agents

-   Work in small, reviewable milestones.
-   Read existing project conventions before changing files.
-   Propose a plan before broad changes.
-   Use migrations for schema changes.
-   Never expose service-role keys or provider secrets.
-   Do not disable RLS to make a feature work.
-   Add tests for permissions and business rules.
-   Do not silently change domain models or API contracts.
-   Use typed schemas for AI outputs and provider payloads.
-   Keep provider-specific logic behind adapters.
-   Use mock/sandbox providers during development.
-   Review diffs before committing.
-   Run lint, type checks, tests, and build before a milestone is
    considered complete.
-   Do not run destructive production operations without explicit
    authorization and a tested rollback plan.
-   Do not enable real outbound communication until the relevant release
    gates pass.

### 20.3 Suggested implementation loop

1.  Select one small user story.
2.  Define acceptance criteria.
3.  Ask Claude Code to inspect relevant code and propose a plan.
4.  Implement schema/migration and server logic.
5.  Add permissions and validation.
6.  Build the UI.
7.  Add unit/integration tests.
8.  Run checks and inspect the diff.
9.  Test the user journey.
10. Update architecture and implementation documentation.

------------------------------------------------------------------------

## 21. Example MVP User Stories

### Story 1: Capture a lead

**As an agency user,** I want leads from a website form to enter the CRM
automatically so that I do not need to retype enquiries.

**Acceptance criteria** - Valid payloads are normalized and stored. -
Duplicate event deliveries do not create duplicate records. - Source and
received timestamp are recorded. - Invalid payloads produce a safe,
observable error. - The record belongs to the correct organization.

### Story 2: Qualify a lead through an AI call

**As a sales manager,** I want an approved AI workflow to qualify
eligible leads so that staff can prioritize meaningful conversations.

**Acceptance criteria** - Policy checks run before a call is queued. -
The call outcome is stored. - Extracted fields are schema-validated. -
Unknown details remain unknown. - A summary and next action are
recorded. - Failed or ambiguous cases are escalated.

### Story 3: Match properties

**As a salesperson,** I want to see properties matching a lead's budget
and preferences so that I can recommend relevant inventory.

**Acceptance criteria** - Hard constraints are applied before ranking. -
Unavailable properties are excluded unless explicitly requested for
historical context. - Match reasons are displayed. - Stale verification
is clearly indicated. - The system does not invent property facts.

### Story 4: Book a site visit

**As a lead,** I want to book a confirmed available appointment so that
I can visit a property without unnecessary back-and-forth.

**Acceptance criteria** - Availability is checked server-side. -
Conflicts are rejected or resolved. - Confirmation is sent only after
the booking is persisted. - The salesperson is notified. - Cancellation
and rescheduling update associated workflows.

### Story 5: Stop follow-ups after opt-out

**As a customer,** I want my communication preference to be respected so
that I do not continue receiving unwanted outreach.

**Acceptance criteria** - The opt-out is recorded. - Pending eligible
sends/calls are cancelled or re-evaluated. - All future workflows check
suppression status. - The action is auditable. - The behavior is covered
by automated tests.

### Story 6: Monitor an AI agent

**As an agency owner,** I want to see an agent's activity, results,
failures, and cost so that I can decide whether to keep it enabled.

**Acceptance criteria** - Runs have clear statuses and timestamps. -
Failures include safe diagnostic details. - Costs are shown when
available and labeled as estimates where necessary. - Authorized users
can pause the agent. - The global outbound kill switch works
independently of the UI.

------------------------------------------------------------------------

## 22. Open Decisions

Resolve these before the relevant implementation phase:

1.  Initial launch market and applicable jurisdictions.
2.  Primary agency type: residential sales, rentals, commercial, or
    mixed.
3.  Initial currency, locale, language, and time-zone defaults.
4.  Which lead sources are required for the first pilot.
5.  Which messaging channel should be integrated first.
6.  Voice provider and telephony availability for the launch market.
7.  Whether customers will bring their own provider accounts or use
    platform-managed accounts.
8.  Initial subscription tiers and usage allowances.
9.  Whether the first release includes finance/commission records or
    only AI usage costs.
10. Required call recording, transcript, and data retention policies.
11. Whether n8n is customer-managed, platform-managed, or hidden behind
    internal workflow services.
12. Hosting region and data residency requirements.
13. Pilot agencies and baseline metrics.
14. Support and incident-response expectations.

These decisions should be recorded in `DECISIONS.md` and reflected in
configuration rather than hard-coded where possible.

------------------------------------------------------------------------

## 23. Definition of Done

A feature is not complete merely because the UI looks finished.

A feature is done when: - The user story and acceptance criteria are
met. - Server-side validation and authorization are implemented. -
Tenant isolation is verified. - Loading, empty, error, and success
states are present. - Audit and execution history are added where
relevant. - Unit and integration tests pass. - Critical end-to-end tests
pass. - Secrets are not exposed. - Documentation is updated. -
Observability and recovery paths exist for external operations. -
Accessibility and responsive behavior have been checked. - The feature
has been tested in a staging environment with realistic data.

------------------------------------------------------------------------

## 24. Final Product Direction

The long-term product is a unified real estate operating system in which
people and AI workflows work together. The owner has a reliable overview
of the agency; staff have complete customer context; AI agents handle
bounded, repetitive tasks; and important decisions remain visible,
reviewable, and controllable.

The best first release is not the one with the most modules. It is the
one that reliably completes the lead-to-appointment workflow, proves
measurable value for a pilot agency, and establishes a secure
architecture that can support future modules.

**Recommended immediate next step:** Turn this PRD into an
implementation plan with a screen-by-screen UI specification, database
ERD, exact Supabase migrations and RLS policies, API contracts, and
detailed workflow definitions for the MVP.
