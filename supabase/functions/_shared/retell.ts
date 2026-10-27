// RetellVoiceProvider — the only place that knows Retell's HTTP API and webhook signature.
// Contract verified against docs.retellai.com (2026-10-25):
//   POST https://api.retellai.com/v2/create-phone-call  {from_number, to_number, override_agent_id?, metadata?,
//        retell_llm_dynamic_variables?, idempotency_key?}  → 201 call object. idempotency_key de-duplicates for 1 hour.
//   GET  https://api.retellai.com/v2/get-call/{call_id}  → call object
//   Webhook header X-Retell-Signature: "v=<unix ms>,d=<hex>", d = HMAC_SHA256(key = webhook API key, raw_body + v),
//   timestamp within 5 minutes. Events: call_started, call_ended, call_analyzed (+ transcript/transfer events).
// No Deno-only APIs here, so it is unit-tested under Node.
import { safeEqual } from './crypto.ts';

export const RETELL_BASE = 'https://api.retellai.com';
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

const enc = new TextEncoder();

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}


/** Builds a header exactly as Retell does (used by tests and local tooling). */
export async function retellSignature(apiKey: string, rawBody: string, timestampMs: number): Promise<string> {
  return `v=${timestampMs},d=${await hmacHex(apiKey, rawBody + String(timestampMs))}`;
}

export type RetellVerify = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

export async function verifyRetellSignature(apiKey: string, rawBody: string, header: string | null, nowMs = Date.now()): Promise<RetellVerify> {
  if (!header) return { ok: false, reason: 'missing' };
  const m = /^v=(\d{10,16}),d=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return { ok: false, reason: 'malformed' };
  const ts = Number(m[1]);
  if (Math.abs(nowMs - ts) > SIGNATURE_TOLERANCE_MS) return { ok: false, reason: 'stale' };
  const expected = await hmacHex(apiKey, rawBody + m[1]);
  return safeEqual(expected, m[2].toLowerCase()) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** How a failed create-call request must be treated. */
export type FailureKind = 'permanent' | 'ambiguous';

/**
 * 400/401/402/404/422 are definite refusals: no call was created. 429 is rate limiting before acceptance: safe to retry
 * later with the same idempotency key. 5xx, timeouts and network errors are ambiguous: Retell may have created the
 * call, so the only safe retry re-sends the same idempotency key (within its 1-hour window).
 */
export function classifyFailure(status: number | null): FailureKind {
  if (status != null && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) return 'permanent';
  return 'ambiguous';
}

export interface CreateCallInput {
  fromNumber: string;
  toNumber: string;
  agentId: string;
  idempotencyKey: string;
  internalCallId: string;
  dynamicVariables: Record<string, string>;
}

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; status: number | null; kind: FailureKind; message: string };

export interface RetellCall {
  call_id: string;
  agent_id?: string;
  call_status?: string;
  direction?: string;
  [k: string]: unknown;
}

/** Request body for create-phone-call (pure, so the mapping is testable). */
export function createCallBody(i: CreateCallInput) {
  return {
    from_number: i.fromNumber,
    to_number: i.toNumber,
    override_agent_id: i.agentId,
    idempotency_key: i.idempotencyKey,
    // Storage only; tenant ownership is resolved from our own call record, never from this.
    metadata: { voice_call_id: i.internalCallId },
    // Retell requires string values.
    retell_llm_dynamic_variables: Object.fromEntries(Object.entries(i.dynamicVariables).map(([k, v]) => [k, String(v ?? '')])),
  };
}

export class RetellVoiceProvider {
  constructor(private apiKey: string, private fetchImpl: typeof fetch = fetch, private timeoutMs = 8000) {}

  private async request<T>(path: string, init: RequestInit): Promise<ProviderResult<T>> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${RETELL_BASE}${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      });
      const text = await res.text();
      if (!res.ok) {
        // Provider messages can echo numbers; keep a short, generic message.
        return { ok: false, status: res.status, kind: classifyFailure(res.status), message: `Retell HTTP ${res.status}` };
      }
      return { ok: true, value: JSON.parse(text) as T };
    } catch (e) {
      const timeout = (e as Error)?.name === 'AbortError';
      return { ok: false, status: null, kind: 'ambiguous', message: timeout ? 'Retell request timed out' : 'Retell request failed (network)' };
    } finally {
      clearTimeout(timer);
    }
  }

  createPhoneCall(i: CreateCallInput) {
    return this.request<RetellCall>('/v2/create-phone-call', { method: 'POST', body: JSON.stringify(createCallBody(i)) });
  }

  getCall(callId: string) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(callId)) return Promise.resolve({ ok: false, status: 400, kind: 'permanent', message: 'Invalid call id' } as const);
    return this.request<RetellCall>(`/v2/get-call/${callId}`, { method: 'GET' });
  }
}

export const RETELL_EVENTS = ['call_started', 'call_ended', 'call_analyzed', 'transcript_updated', 'transfer_started', 'transfer_bridged', 'transfer_cancelled', 'transfer_ended'] as const;

/** Minimal structural check of a webhook body. Unknown events are acknowledged and ignored. */
export function parseRetellEvent(raw: string): { ok: true; event: string; call: Record<string, unknown> } | { ok: false; error: string } {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  const o = j as { event?: unknown; call?: unknown };
  if (typeof o?.event !== 'string' || !/^[a-z_]{3,40}$/.test(o.event)) return { ok: false, error: 'missing_event' };
  if (!o.call || typeof o.call !== 'object') return { ok: false, error: 'missing_call' };
  const call = o.call as Record<string, unknown>;
  if (typeof call.call_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(call.call_id)) return { ok: false, error: 'missing_call_id' };
  return { ok: true, event: o.event, call };
}

/** Fields we keep from Retell's call object. Recording URLs are reduced to "present"; they are never persisted. */
export function trimCallForStorage(call: Record<string, unknown>) {
  const pick = ['call_id', 'agent_id', 'direction', 'from_number', 'to_number', 'call_status', 'start_timestamp', 'end_timestamp', 'duration_ms',
    'disconnection_reason', 'transcript', 'metadata', 'call_analysis'] as const;
  const out: Record<string, unknown> = {};
  for (const k of pick) if (call[k] !== undefined) out[k] = call[k];
  if (typeof call.recording_url === 'string' && call.recording_url) out.recording_url = 'present';
  const ca = call.call_analysis as Record<string, unknown> | undefined;
  if (ca) out.call_analysis = { call_summary: ca.call_summary, in_voicemail: ca.in_voicemail, user_sentiment: ca.user_sentiment, call_successful: ca.call_successful };
  return out;
}
