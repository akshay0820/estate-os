# Estate OS — Data Processing Agreement (DPA)

> **DRAFT for attorney review. Not legal advice.** Written for US customers. If a customer is in the EU, UK or India,
> counsel must add the relevant terms (for example EU Standard Contractual Clauses, or India's DPDP Act). Text in
> `[BRACKETS]` must be filled in; **⚖ Counsel** marks open questions.

This DPA forms part of the Estate OS Terms of Service (the "**Agreement**") between **[BLAZEREACH LEGAL ENTITY NAME]**
("**Processor**", "**BlazeReach**") and the Customer ("**Customer**"). Capitalized terms not defined here have the
meaning given in the Agreement.

## 1. Roles and scope

1.1 Customer is the business (controller) for Customer Data. BlazeReach is its service provider (processor) and
processes Customer Data only to provide the Service.

1.2 Annex 1 describes the processing.

1.3 Where the California Consumer Privacy Act (CCPA/CPRA) or a similar state law applies, BlazeReach is a "service
provider" or "processor". It will not:
- sell or share Customer Data, as those terms are defined in that law;
- retain, use or disclose Customer Data outside the direct business relationship, or for any purpose other than
  providing the Service;
- combine Customer Data with personal information it receives from others, except as that law permits.

BlazeReach will notify Customer if it can no longer meet these obligations.

## 2. Customer instructions

The Agreement, this DPA and Customer's use of the Service settings are Customer's instructions. Examples of those
settings are roles, consent records, and Agent and retention settings. BlazeReach will tell Customer if it believes an
instruction violates law.

## 3. Confidentiality and personnel

BlazeReach limits access to Customer Data to personnel who need it to provide or support the Service. Those personnel
are bound by confidentiality obligations. BlazeReach staff do not access a Customer's workspace data except:
- to provide support Customer requests;
- to keep the Service secure;
- as required by law.

## 4. Security measures

BlazeReach maintains at least the measures in Annex 3 and may update them if the overall level of protection does not
decrease.

## 5. Subprocessors

5.1 Customer authorizes the subprocessors in Annex 2.

5.2 BlazeReach will give at least [30] days' notice before adding or replacing a subprocessor, by updating Annex 2 and
emailing the Workspace owner. Customer may object on reasonable data-protection grounds. If the parties cannot resolve
the objection, Customer may terminate the affected Service and receive a refund of prepaid fees for the remaining term.

5.3 BlazeReach binds each subprocessor to data-protection obligations at least as protective as this DPA, and remains
responsible for its subprocessors' performance.

## 6. Requests from individuals

The Service lets Customer find, correct, export (CSV) and delete contact and lead records. If BlazeReach receives a
request from an individual about Customer Data, it will forward the request to Customer without responding to the
substance unless Customer authorizes it. BlazeReach will reasonably assist with requests Customer cannot handle
through the Service.

## 7. Security incidents

BlazeReach will notify Customer without undue delay, and within **[72] hours** after confirming a security incident that
has led to unauthorized access to, or loss or disclosure of, Customer Data. The notice will describe:
- what happened;
- the data and individuals likely affected;
- the steps taken;
- a contact person.

BlazeReach will reasonably cooperate with Customer's notification duties. Customer is responsible for notifying
individuals and regulators unless the parties agree otherwise. **⚖ Counsel:** state breach-notification timelines vary.
Confirm the notice period and who pays notification costs.

## 8. Return and deletion

During the term, Customer can export leads and contacts as CSV. Within [30] days after the Agreement ends, BlazeReach
will provide a final export on request. It will then delete Customer Data from the production database within [90]
days after termination. Backups are overwritten on their normal cycle within [BACKUP RETENTION PERIOD]. BlazeReach may
keep data longer only where law requires, and will keep protecting it under this DPA.

## 9. Audits and information

On written request no more than once a year, BlazeReach will answer a reasonable security questionnaire and provide
documentation of the measures in Annex 3. **BlazeReach does not currently hold a SOC 2, ISO 27001 or similar
certification**, and this DPA does not claim one.

## 10. Liability

Each party's liability under this DPA is subject to the limitations in the Agreement.

---

## Annex 1 — Description of processing

| Item | Description |
|---|---|
| **Purpose** | Providing the Estate OS CRM and its AI Agents to Customer's real-estate business |
| **Individuals** | Customer's leads, prospects and clients (buyers, sellers, tenants, landlords, investors); property owners; Customer's staff (Authorized Users) |
| **Data** | Names, phone numbers, email addresses, property preferences and budgets, notes, consent and opt-out records, activities, appointments, deals, commissions, listings, lead-form submissions, AI-generated scores, summaries and drafts; staff account and audit data. If calling is enabled: call records and transcripts |
| **Sensitive data** | Not intended. Customer must not upload SSNs, financial account numbers, government IDs or health data, and must not use protected fair-housing characteristics as criteria |
| **Frequency and duration** | Continuous, for the subscription term plus the deletion period in Section 8 |
| **Retention settings** | Call transcripts: Customer-set period (default 90 days, 1–730), deleted automatically. Other data: kept until Customer deletes it or the Agreement ends |

## Annex 2 — Subprocessors

**⚖ Counsel and owner:** confirm each provider's current terms, data region and training/retention settings before
publishing. List only providers that are actually enabled for the Customer.

| Subprocessor | Purpose | Data | Location | Status |
|---|---|---|---|---|
| Supabase, Inc. | Database, authentication, file storage, server functions | All Customer Data | [REGION OF PRODUCTION PROJECT] | In use |
| Vercel Inc. | Hosting of the web application; request logs | IP address, browser data, request metadata | United States / global edge network | In use |
| Google LLC (Google Fonts) | Web fonts | IP address and browser data when fonts load | Global | In use (unless fonts are self-hosted) |
| Anthropic, PBC | AI model for Agent drafts, summaries and extraction | Relevant lead, listing and conversation text | United States | When AI features are enabled |
| Retell AI | Voice calling, if enabled | Phone numbers, call audio, transcripts | [CONFIRM] | Not enabled |
| [Email / SMS / WhatsApp provider] | Messaging, if enabled | Contact details, message content | [CONFIRM] | Not enabled |
| [Payment processor] | Billing | Billing contact and payment details | [CONFIRM] | Not chosen |

## Annex 3 — Security measures (as implemented)

- **Tenant isolation:** every customer table enforces row-level security in the database, so a user can only read or
  change rows of workspaces they belong to. Automated tests check that one tenant cannot read another's data.
- **Access control:** role-based permissions (owner, admin, manager, agent, viewer and similar); sensitive functions check
  permissions on the server, not only in the browser; invitations expire after 7 days.
- **Encryption:** HTTPS for all traffic; a strict Content-Security-Policy and security headers on the web app; encryption
  at rest provided by the hosting provider. **⚖ Owner:** confirm with Supabase for the production plan.
- **Secrets:** API keys for providers are kept server-side (database vault or function secrets) and are not shipped to the
  browser; a pre-deploy check scans the browser bundle for secrets.
- **Integrity of inbound data:** lead webhooks must carry a valid signature; inputs are validated on the server.
- **Human control of AI:** outbound messages drafted by AI need human approval; AI output is checked against the source
  data before it is saved.
- **Auditability:** audit records for permission changes, imports, merges, approvals and other sensitive actions.
- **Change management:** code in version control with automated tests and checks on every change; database changes as
  versioned migrations.
- **Planned before launch (not yet in place):** production database with point-in-time recovery and a tested restore;
  uptime monitoring with alerts; leaked-password protection; dedicated email sending service.
