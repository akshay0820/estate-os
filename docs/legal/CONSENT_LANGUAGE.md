# Estate OS — Consent and Opt-Out Wording (for the Customer's lead forms)

> **DRAFT for attorney review. Not legal advice.** US communication law changes often and differs by state. The agency
> (Customer), not BlazeReach, is responsible for the consent it collects; this file gives starting wording and shows
> how it maps to the consent records in Estate OS. Text in `[BRACKETS]` must be filled in.

## 1. Why this matters

- **Calls and texts:** under the TCPA and FCC rules, marketing calls or texts that use an autodialer or an artificial or
  prerecorded voice generally need the person's **prior express written consent**. The FCC treats AI-generated voices as
  "artificial" voices (February 2024 declaratory ruling). Numbers on the National Do Not Call Registry, and state
  do-not-call lists, need separate care. Several states have their own "mini-TCPA" laws, for example Florida, Oklahoma and
  Maryland. **⚖ Counsel:** confirm the current federal rules, including the FCC's one-to-one consent rule, whose status
  has changed, and the rules of each state the agency markets in.
- **Email:** CAN-SPAM requires an accurate sender, a non-deceptive subject, a physical postal address, and a working
  unsubscribe that is honored within 10 business days.
- **Call recording:** some states require **all parties** to consent to a recording, for example California, Florida,
  Illinois, Maryland, Massachusetts, Montana, New Hampshire, Pennsylvania and Washington. **⚖ Counsel:** confirm the list.
- Consent must not be a condition of buying property or services.

## 2. Website / lead-form wording

Place the wording **next to the submit button**. Use **unticked** checkboxes, one per purpose, so each consent is recorded
separately. Do not hide it in the terms.

**Service contact (needed to answer the enquiry):**

> By submitting this form, you agree that **[AGENCY NAME]** may contact you at the phone number and email you provided
> about your enquiry. See our [Privacy Policy](URL).

**☐ Calls and texts, including automated and AI-voice (optional):**

> I agree to receive calls and text messages from **[AGENCY NAME]** about properties and real-estate services at the number
> I provided, including calls and texts made with automated technology or an artificial or AI-generated voice. Consent is
> not a condition of any purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or
> HELP for help.

**☐ Marketing email (optional):**

> I'd like to receive property updates and news from **[AGENCY NAME]** by email. I can unsubscribe at any time.

**☐ Appointment reminders by text (optional):**

> Send me text reminders about viewings and appointments I book. Reply STOP to opt out.

**Keep proof:** the form version, page URL, timestamp, IP address, and the exact wording shown. Estate OS stores the
consent status, channel, purpose, timestamp and "captured via" note. Keep the full form evidence in the website or form
tool as well. **⚖ Product:** consider storing the wording version and IP address with each consent record.

## 3. How the form maps to Estate OS consent records

Estate OS keeps consent records per **channel** (phone, SMS, WhatsApp, email) and **purpose** (`service`, `marketing`,
`ai_call`, `appointment_reminder`). Each record has a status: `unknown`, `granted`, `denied` or `revoked`.

**Recorded today:**
- A new lead, whether entered by staff, imported, or received by webhook, gets one record per channel for the `service` purpose.
- The record is `granted` for the channels marked as consented, and `unknown` for the rest.
- Staff can change a contact's consent later from the contact record.

**Not recorded automatically yet:** the separate purposes `marketing`, `ai_call` and `appointment_reminder` from
separate form checkboxes. **⚖ Product:** before marketing texts or AI calls go live, map each checkbox in Section 2 to
its own purpose record (lead webhook and import), so that ticking "service contact" can never be read as consent to
automated marketing.

| Checkbox in Section 2 | Should record (channel → purpose) |
|---|---|
| Service contact | phone, email → `service` |
| Calls and texts, incl. AI voice | phone, sms → `marketing` and `ai_call` |
| Marketing email | email → `marketing` |
| Appointment reminders | sms → `appointment_reminder` |

`unknown` must be treated as **no consent** for any marketing or automated contact.

## 4. Consent given by phone or in person

When staff record consent manually (the "Recorded by staff" option), they should read the same wording, note the date,
time and who gave it, and only tick the channels the person agreed to. Written consent is safer for automated calls and
texts. **⚖ Counsel:** confirm whether verbal consent is enough for any planned use.

## 5. Opt-out wording

The Follow-up Agent adds these lines to every drafted message:

- **Text and WhatsApp:** "Reply STOP to opt out."
- **Email:** "If you would rather not hear from us, reply 'unsubscribe'." Add the agency's **physical postal address**
  to email templates (CAN-SPAM). **⚖ Product:** add the postal address to the email footer automatically.

When an opt-out is recorded, Estate OS sets the consent to `revoked` or `denied` and stops pending messages to that
contact. Honor opt-outs made by any reasonable means, for example "stop calling me" on a call. Federal rules allow at
most 10 business days to honor a revocation; act on it as quickly as possible.

## 6. AI voice calls (when calling is enabled)

At the start of every AI call, say (example):

> "Hi, this is an automated assistant calling on behalf of **[AGENCY NAME]** about your property enquiry. This call may be
> recorded for quality and training. You can ask to speak to a person, or ask us not to call again, at any time."

- Identify the caller, the business, and that the voice is automated.
- Disclose the recording, and get consent where all-party consent is required.
- Call only between **8 a.m. and 9 p.m.** in the person's local time, or narrower if state law requires.
- Respect do-not-call lists, the per-day attempt limits in the calling settings, and opt-outs.
- Provide a way to reach a human.

## 7. Agency privacy notice

The agency needs its own privacy notice, linked from every form, saying:
- what it collects;
- why;
- who it shares data with, including Estate OS (BlazeReach) as its service provider;
- how people can opt out or request access or deletion.

BlazeReach's Privacy Policy does not replace the agency's own notice.
