import { describe, expect, it } from 'vitest';
import { parsePayload, signatureFor, verifySignature } from '../../supabase/functions/_shared/intake';

const secret = 'whsec_test_secret';
const body = JSON.stringify({ name: 'Riya Shah', phone: '9820012345', source: 'Website form' });
const now = 1_800_000_000;

describe('webhook signature', () => {
  it('accepts a correct, fresh signature', async () => {
    const sig = await signatureFor(secret, String(now), body);
    expect(await verifySignature(secret, sig, String(now), body, now)).toEqual({ ok: true });
  });

  it('rejects a tampered body, wrong secret, missing headers and stale timestamps', async () => {
    const sig = await signatureFor(secret, String(now), body);
    expect(await verifySignature(secret, sig, String(now), body.replace('Riya', 'Eve'), now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySignature('other', sig, String(now), body, now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifySignature(secret, null, String(now), body, now)).toEqual({ ok: false, reason: 'missing_headers' });
    expect(await verifySignature(secret, sig, String(now), body, now + 301)).toEqual({ ok: false, reason: 'stale_timestamp' });
  });
});

describe('payload validation', () => {
  it('accepts a minimal lead', () => {
    expect(parsePayload(body).ok).toBe(true);
  });

  it('requires a phone or email, rejects unknown fields and bad JSON', () => {
    expect(parsePayload(JSON.stringify({ name: 'X' }))).toMatchObject({ ok: false });
    expect(parsePayload(JSON.stringify({ name: 'X', phone: '123' }))).toMatchObject({ ok: false });
    expect(parsePayload(JSON.stringify({ name: 'X', email: 'x@example.com', organization_id: 'evil' }))).toMatchObject({ ok: false });
    expect(parsePayload('{not json')).toEqual({ ok: false, error: 'Body must be valid JSON' });
  });
});
