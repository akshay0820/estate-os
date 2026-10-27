// Agent 05 — provider delivery seam. Pure module (tested under Node with mock adapters).
// No email / SMS / WhatsApp provider is integrated in this product, so ADAPTERS is empty and every dispatch returns
// 'unsupported' (the follow-up goes back to "approved, send manually"). A future adapter only implements `send` and
// classifies its own errors; this module maps them to the outcomes the database understands.

export interface OutboundMessage { followUpId: string; channel: 'whatsapp' | 'sms' | 'email'; to: string; subject: string | null; body: string; idempotencyKey: string }
export type SendResult =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'rejected'; permanent: boolean; error: string }
  // The request may have reached the provider (e.g. timeout after the body was sent): never retried blindly.
  | { kind: 'unknown'; error: string };
export interface ProviderAdapter { name: string; send(m: OutboundMessage, signal: AbortSignal): Promise<SendResult> }

export type DispatchOutcome = 'accepted' | 'transient' | 'permanent' | 'ambiguous' | 'unsupported';

export const ADAPTERS: Record<string, ProviderAdapter> = {};

/** Sends once with a timeout and maps the adapter result (or a thrown error) to a database outcome. */
export async function deliver(m: OutboundMessage, adapter: ProviderAdapter | undefined, timeoutMs = 15_000):
  Promise<{ outcome: DispatchOutcome; providerMessageId?: string; error?: string }> {
  if (!adapter) return { outcome: 'unsupported', error: 'no adapter for this provider' };
  if (!m.to || !m.body.trim()) return { outcome: 'permanent', error: 'missing recipient or body' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await adapter.send(m, ctl.signal);
    if (r.kind === 'accepted') return r.providerMessageId ? { outcome: 'accepted', providerMessageId: r.providerMessageId } : { outcome: 'ambiguous', error: 'accepted without an id' };
    if (r.kind === 'unknown') return { outcome: 'ambiguous', error: r.error.slice(0, 300) };
    return { outcome: r.permanent ? 'permanent' : 'transient', error: r.error.slice(0, 300) };
  } catch (e) {
    // A thrown error after the request started is not proof that nothing was sent.
    return { outcome: 'ambiguous', error: (ctl.signal.aborted ? 'timeout' : String((e as Error)?.message ?? e)).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
