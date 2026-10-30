# Legal documents (drafts) — gate G10

> **These are drafts for a licensed attorney to review. They are not legal advice, and none of them is ready to publish
> or sign as-is.** They were written on 2026-10-30 from what Estate OS actually does, so the attorney does not start
> from a generic template. They make no compliance claim (TCPA, CCPA, SOC 2 or other).

| Document | Who it is for | Where it goes |
|---|---|---|
| [TERMS_OF_SERVICE.md](TERMS_OF_SERVICE.md) | The agency (customer) signing up | Sign-up page link, order form |
| [PRIVACY_POLICY.md](PRIVACY_POLICY.md) | Users of the app; anyone asking about their data | Public URL, linked from sign-in and sign-up |
| [DATA_PROCESSING_AGREEMENT.md](DATA_PROCESSING_AGREEMENT.md) | The agency, as part of the terms; includes the subprocessor list and security measures | Attached to the terms |
| [CONSENT_LANGUAGE.md](CONSENT_LANGUAGE.md) | The agency's website and lead forms | The agency's forms; staff training |

## 1. Fill in before review (owner)

- [ ] BlazeReach legal entity name, entity type, state, address
- [ ] Legal, privacy and security contact emails
- [ ] Governing law and venue (state, county); arbitration yes or no
- [ ] Plans and fees, billing cycle, renewal and notice periods
- [ ] Production database region (Supabase project) and backup retention period
- [ ] Data retention periods after termination, and for account and audit records
- [ ] Which providers are actually enabled at launch (Anthropic yes or no; Retell, messaging and payments not yet)
- [ ] The client agency's name and the states it markets in (for the consent wording)

## 2. Questions for the attorney

All marked **⚖ Counsel** in the drafts. The main ones:

1. **TCPA and AI voice:** consent wording for automated texts and AI-voice calls; current status of the FCC one-to-one
   consent rule; state mini-TCPA laws for the client's states; DNC scrubbing duty.
2. **Call recording:** all-party consent states the client calls into.
3. **State privacy laws:** whether CCPA/CPRA or other state laws apply to BlazeReach, and the required disclosures.
4. **Fair housing:** obligations when AI scores and matches leads; whether any disclosure about AI use is needed.
5. **Liability:** the cap, any carve-out for data breaches, and the customer indemnity for communication-law claims.
6. **Breach notification:** the notice period in the DPA versus state laws.
7. **Auto-renewal and sales tax** on SaaS in the client's state.
8. **AI providers:** check each provider's data-use, retention and training terms match what the drafts say.

## 3. Product changes the drafts depend on (engineering)

These are true of the product today and the drafts say so honestly. Fix them before the related feature goes live:

- [ ] Record separate consent **purposes** (`marketing`, `ai_call`, `appointment_reminder`) from separate form checkboxes in
      the lead webhook and import. Today every new lead gets `service` consent records only. Needed before marketing
      texts or AI calls are enabled.
- [ ] Store the consent wording version and IP address with each consent record (proof of consent).
- [ ] Add the agency's physical postal address to the email opt-out footer (CAN-SPAM).
- [ ] Automated deletion of a workspace's data after termination. Today only call transcripts are deleted automatically.
- [ ] Links to Terms and Privacy Policy on the sign-in and sign-up pages, plus an "I agree" record at sign-up.
- [ ] Optional: self-host the web fonts so Google does not receive visitors' IP addresses.

## 4. After review

1. Replace the drafts with the attorney-approved text and remove the DRAFT banners.
2. Publish the Terms and Privacy Policy at stable public URLs.
3. Keep a dated copy of every published version (in this folder, under `versions/`).
4. Update Annex 2 (subprocessors) and notify customers before enabling any new provider.
