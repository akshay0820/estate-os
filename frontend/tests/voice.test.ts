import { describe, expect, it, vi } from 'vitest';
import { classifyFailure, createCallBody, parseRetellEvent, RetellVoiceProvider, retellSignature, trimCallForStorage, verifyRetellSignature } from '../../supabase/functions/_shared/retell';
import { validateAnalysis } from '../../supabase/functions/_shared/voice-analysis';

const KEY = 'key_webhook_badge_test';
const body = JSON.stringify({ event: 'call_ended', call: { call_id: 'Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6' } });
const now = 1_800_000_000_000;

describe('Retell webhook signature (documented algorithm)', () => {
  it('accepts HMAC_SHA256(key, raw_body + timestamp) in "v=<ms>,d=<hex>"', async () => {
    const sig = await retellSignature(KEY, body, now);
    expect(sig).toMatch(/^v=1800000000000,d=[0-9a-f]{64}$/);
    expect(await verifyRetellSignature(KEY, body, sig, now)).toEqual({ ok: true });
  });

  it('rejects tampering, wrong key, stale or malformed headers', async () => {
    const sig = await retellSignature(KEY, body, now);
    expect(await verifyRetellSignature(KEY, body.replace('ended', 'started'), sig, now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyRetellSignature('other', body, sig, now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyRetellSignature(KEY, body, sig, now + 5 * 60_000 + 1)).toEqual({ ok: false, reason: 'stale' });
    expect(await verifyRetellSignature(KEY, body, 'sha256=abc', now)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyRetellSignature(KEY, body, null, now)).toEqual({ ok: false, reason: 'missing' });
  });

  // Golden vector produced by Retell's official SDK (retell-sdk 6.2.12, lib/webhook_auth `symmetric.sign`) on 2026-10-26.
  // It pins compatibility with the provider's own implementation without adding the SDK as a dependency.
  it('matches a signature produced by the official Retell SDK', async () => {
    const sdkKey = 'key_test_fixture_not_a_real_secret';
    const sdkBody = '{"event":"call_ended","call":{"call_id":"call_fixture_001","call_status":"ended"}}';
    const sdkSig = 'v=1792990000000,d=6e3a13d1087a5600bb9e2bf663b3adf8de95c428ab6a7b5df3524da6491ab764';
    expect(await retellSignature(sdkKey, sdkBody, 1792990000000)).toBe(sdkSig);
    expect(await verifyRetellSignature(sdkKey, sdkBody, sdkSig, 1792990000000 + 60_000)).toEqual({ ok: true });
    expect(await verifyRetellSignature(sdkKey, sdkBody, sdkSig.toUpperCase().replace('V=', 'v=').replace(',D=', ',d='), 1792990000000)).toEqual({ ok: true });
    expect(await verifyRetellSignature(sdkKey, sdkBody + ' ', sdkSig, 1792990000000)).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('provider adapter', () => {
  it('classifies failures: refusals are permanent, everything that may have created a call is ambiguous', () => {
    expect(classifyFailure(400)).toBe('permanent');
    expect(classifyFailure(402)).toBe('permanent');
    expect(classifyFailure(422)).toBe('permanent');
    expect(classifyFailure(429)).toBe('ambiguous');
    expect(classifyFailure(500)).toBe('ambiguous');
    expect(classifyFailure(null)).toBe('ambiguous');
  });

  it('maps the request body to the documented fields, with string dynamic variables', () => {
    expect(createCallBody({ fromNumber: '+1415', toNumber: '+9198', agentId: 'agent_x', idempotencyKey: 'abc-123', internalCallId: 'c1', dynamicVariables: { agency_name: 'Sky', known_bedrooms: 3 as unknown as string } })).toEqual({
      from_number: '+1415', to_number: '+9198', override_agent_id: 'agent_x', idempotency_key: 'abc-123',
      metadata: { voice_call_id: 'c1' }, retell_llm_dynamic_variables: { agency_name: 'Sky', known_bedrooms: '3' },
    });
  });

  it('calls the documented endpoint and reports timeouts as ambiguous', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ call_id: 'call_abcdefgh', agent_id: 'a' }), { status: 201 }));
    const p = new RetellVoiceProvider('k', ok as unknown as typeof fetch);
    const r = await p.createPhoneCall({ fromNumber: '+1', toNumber: '+2', agentId: 'a', idempotencyKey: 'abcde', internalCallId: 'c', dynamicVariables: {} });
    expect(r).toEqual({ ok: true, value: { call_id: 'call_abcdefgh', agent_id: 'a' } });
    expect((ok.mock.calls[0] as unknown[])[0]).toBe('https://api.retellai.com/v2/create-phone-call');
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))));
    const slow = new RetellVoiceProvider('k', hang as unknown as typeof fetch, 20);
    expect(await slow.createPhoneCall({ fromNumber: '+1', toNumber: '+2', agentId: 'a', idempotencyKey: 'abcde', internalCallId: 'c', dynamicVariables: {} }))
      .toEqual({ ok: false, status: null, kind: 'ambiguous', message: 'Retell request timed out' });
    const refused = new RetellVoiceProvider('k', (async () => new Response('{"error":"bad number +9198..."}', { status: 422 })) as unknown as typeof fetch);
    const rr = await refused.createPhoneCall({ fromNumber: '+1', toNumber: '+2', agentId: 'a', idempotencyKey: 'abcde', internalCallId: 'c', dynamicVariables: {} });
    expect(rr).toEqual({ ok: false, status: 422, kind: 'permanent', message: 'Retell HTTP 422' });
  });

  it('validates event structure and never keeps recording URLs', () => {
    expect(parseRetellEvent('{nope').ok).toBe(false);
    expect(parseRetellEvent(JSON.stringify({ event: 'call_ended', call: {} }))).toEqual({ ok: false, error: 'missing_call_id' });
    expect(parseRetellEvent(body)).toMatchObject({ ok: true, event: 'call_ended' });
    expect(trimCallForStorage({ call_id: 'x', recording_url: 'https://s3/rec.wav', public_log_url: 'https://s3/log' })).toEqual({ call_id: 'x', recording_url: 'present' });
  });
});

describe('post-call analysis validation', () => {
  const transcript = 'Agent: Hi.\nUser: I am looking to buy a 2 BHK in Pune around 80 lakh. Please do not call me again.';
  const base = {
    call_outcome: 'opted_out', conversation_summary: 'Buyer, then asked not to be called.', intent: 'buy', preferred_locations: ['Pune'], property_type: null, bedrooms: 2,
    budget_min: null, budget_max: 8000000, currency: 'INR', timeline: null, human_requested: false, callback_requested: false, opt_out_detected: true,
    unanswered_questions: [], next_recommended_action: 'no_action',
    evidence: [
      { field: 'intent', quote: 'looking to buy' }, { field: 'preferred_locations', quote: 'in Pune' }, { field: 'bedrooms', quote: '2 BHK' },
      { field: 'budget_max', quote: 'around 80 lakh' }, { field: 'opt_out_detected', quote: 'do not call me again' },
    ],
  };

  it('keeps evidenced fields', () => {
    const r = validateAnalysis(base, transcript);
    expect(r.ok && r.value).toMatchObject({ intent: 'buy', bedrooms: 2, budget_max: 8000000, currency: 'INR', opt_out_detected: true });
    expect(r.ok && r.dropped).toEqual([]);
  });

  it('drops claims the customer never made, including flags', () => {
    const r = validateAnalysis({ ...base, human_requested: true, timeline: 'Immediate', evidence: [...base.evidence, { field: 'timeline', quote: 'right now please' }] }, transcript);
    expect(r.ok && r.value.human_requested).toBe(false);
    expect(r.ok && r.value.timeline).toBeNull();
    expect(r.ok && r.dropped.sort()).toEqual(['human_requested', 'timeline']);
  });

  it('rejects malformed output, extra keys and impossible values', () => {
    expect(validateAnalysis({ ...base, tenant_id: 'x' }, transcript).ok).toBe(false);
    expect(validateAnalysis({ ...base, bedrooms: 99 }, transcript).ok).toBe(false);
    expect(validateAnalysis({ ...base, budget_min: 9e6, budget_max: 1e6 }, transcript).ok).toBe(false);
    expect(validateAnalysis('DROP TABLE leads', transcript).ok).toBe(false);
  });
});
