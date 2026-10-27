# Pilot Scope Agreement — [Agency name] (template)

**This is an operational scope, not a contract.** Commercial terms, liability, data-processing terms and any legal commitments need the agency's and BlazeReach's legal approval. They are not defined here.

| Section | Proposed default for the first pilot | Agreed text |
|---|---|---|
| Included workflows | Lead capture from the agreed web/portal sources (signed webhook); lead qualification suggestions; property recommendations from the agency's verified listings; follow-up **drafts** (staff approve and send manually); internal appointment booking by staff; data-quality findings; deterministic sales reports | |
| Excluded workflows | AI voice calls; automated message delivery (no provider); calendar sync (no provider); automated CRM updates in the agency's existing CRM (no connector); all Claude-generated content until the AI key is configured and verified | |
| Enabled agents (Stage 1) | 1 Lead intake (always on); 3 Qualification (shadow); 4 Matching (shadow); 7 CRM & data (findings only); 8 Sales intelligence (metrics only) | |
| Disabled (paused) agents | 2 Voice; 5 Follow-up and 6 Appointment until Stage 2 is approved | |
| Required integrations | The agency's lead source(s) posting to the signed webhook | |
| Customer responsibilities | Provide accurate listings; review suggestions daily; record their own decisions for the shadow comparison; capture consent on their forms; report issues in the feedback log | |
| Agency staff responsibilities | Approve or edit drafts before anything is sent; book appointments; decide duplicates; keep the existing process as the fallback | |
| BlazeReach responsibilities | Daily runbook; incident handling; weekly review; no change to configuration without the agency's approval | |
| Support contacts | Roles only (handbook §13); names and channels to be filled in | |
| Pilot duration | To agree (propose 6–8 weeks: about 2 weeks shadow, then staged) | |
| Success metrics | `PILOT_SUCCESS_CRITERIA.md`, as agreed | |
| Known limitations | No message delivery, no calendar sync, no bulk import, no CRM connector, AI steps off, UI hosted at [URL to be provided], free-tier staging is **not** used for the pilot | |
| Data handling | Lead contact details and preferences stored in the pilot project (region: to confirm with the agency). No call recordings (voice off). Retention and deletion procedure per handbook §20. **Needs legal review** | |
| Exit and rollback | Handbook §15 and §20: pause the agents, return to the manual process, export the agency's data on request, delete per the agreed retention | |
