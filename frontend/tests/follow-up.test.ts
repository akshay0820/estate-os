import { describe, expect, it } from 'vitest';
import { buildDraftContent, type DraftClaim, validateDraft } from '../../supabase/functions/_shared/follow-up-drafting';
import { deliver, type OutboundMessage, type ProviderAdapter } from '../../supabase/functions/_shared/follow-up-delivery';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const claim: DraftClaim = {
  follow_up_id: '99999999-9999-4999-8999-999999999999', content_version: 1, purpose: 'share_property_recommendations', channel: 'whatsapp',
  facts: { agency: 'Skyline Realty', first_name: 'Ravi', max_length: 940, properties: [
    { property_id: P1, title: 'Sea view 2 BHK', locality: 'Worli', price: 28000000, currency: 'INR', bedrooms: 2, property_type: 'apartment', availability_confirmed: true },
    { property_id: P2, title: 'Corner 2 BHK', locality: 'Worli', price: 29000000, currency: 'INR', bedrooms: 2, property_type: 'apartment', availability_confirmed: false }] },
  template: { subject: null, body: 'Hi Ravi, this is Skyline Realty. ...\nReply STOP to opt out.' },
};
const ok = { subject: null, body: 'Hi Ravi, two Worli options for you: Sea view 2 BHK at INR 28,000,000 and Corner 2 BHK at INR 29,000,000 (availability to be confirmed). Want details or a viewing?', referenced_property_ids: [P1, P2] };

describe('follow-up draft validation', () => {
  it('accepts a grounded rewrite that keeps every listing', () => {
    expect(validateDraft(ok, claim)).toEqual({ ok: true, value: ok });
  });

  it('rejects invented numbers, unknown or dropped listings, pressure and household wording, opt-out text and bad subjects', () => {
    const bad = (o: Record<string, unknown>) => (validateDraft({ ...ok, ...o }, claim) as { reason: string }).reason;
    expect(bad({ body: ok.body + ' Only 15 minutes from the sea link!' })).toBe('ungrounded_number');
    expect(bad({ referenced_property_ids: [P1, '33333333-3333-4333-8333-333333333333'] })).toBe('unknown_property');
    expect(bad({ referenced_property_ids: [P1] })).toBe('listing_dropped');
    expect(bad({ body: ok.body + ' These are selling fast.' })).toBe('banned_wording');
    expect(bad({ body: ok.body + ' Great for families.' })).toBe('banned_wording');
    expect(bad({ body: ok.body + ' Reply STOP to opt out.' })).toBe('opt_out_in_body');
    expect(bad({ subject: 'Hello' })).toBe('subject');
    expect(validateDraft({ ...ok, extra: 1 }, claim).ok).toBe(false);
  });

  it('keeps facts and template inside data blocks', () => {
    const s = buildDraftContent(claim);
    expect(s.startsWith('<facts>')).toBe(true);
    expect(s).toContain('<template>');
    expect(s).not.toMatch(/organization_id|lead_id|phone|email/);
  });
});

describe('provider delivery classification (mock adapters)', () => {
  const msg: OutboundMessage = { followUpId: 'f1', channel: 'whatsapp', to: '+919800000000', subject: null, body: 'Hello there, test.', idempotencyKey: 'fu_f1' };
  const adapter = (send: ProviderAdapter['send']): ProviderAdapter => ({ name: 'mock', send });

  it('no adapter → unsupported (never reported as sent)', async () => {
    expect(await deliver(msg, undefined)).toEqual({ outcome: 'unsupported', error: 'no adapter for this provider' });
  });

  it('maps accepted, transient, permanent and unknown results; passes the idempotency key', async () => {
    let seen = '';
    expect(await deliver(msg, adapter(async (m) => { seen = m.idempotencyKey; return { kind: 'accepted', providerMessageId: 'wamid.1' }; }))).toEqual({ outcome: 'accepted', providerMessageId: 'wamid.1' });
    expect(seen).toBe('fu_f1');
    expect((await deliver(msg, adapter(async () => ({ kind: 'rejected', permanent: false, error: '429' })))).outcome).toBe('transient');
    expect((await deliver(msg, adapter(async () => ({ kind: 'rejected', permanent: true, error: 'invalid number' })))).outcome).toBe('permanent');
    expect((await deliver(msg, adapter(async () => ({ kind: 'unknown', error: '502 after send' })))).outcome).toBe('ambiguous');
    expect((await deliver(msg, adapter(async () => ({ kind: 'accepted', providerMessageId: '' })))).outcome).toBe('ambiguous');
  });

  it('a timeout or thrown error is ambiguous, not "not sent"', async () => {
    const hang = adapter((_m, signal) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))));
    expect(await deliver(msg, hang, 20)).toEqual({ outcome: 'ambiguous', error: 'timeout' });
    expect((await deliver(msg, adapter(async () => { throw new Error('socket hang up'); }))).outcome).toBe('ambiguous');
    expect((await deliver({ ...msg, to: '' }, adapter(async () => ({ kind: 'accepted', providerMessageId: 'x' })))).outcome).toBe('permanent');
  });
});
