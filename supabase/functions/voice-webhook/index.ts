// POST /functions/v1/voice-webhook — Retell call events (JWT verification OFF; authenticated by X-Retell-Signature).
// Verify → validate → one SQL transaction (dedupe, state transition, CRM effects, outbox) → 204.
// Post-call analysis runs after the response (EdgeRuntime.waitUntil); the worker retries anything that fails.
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { parseRetellEvent, verifyRetellSignature } from '../_shared/retell.ts';
import { log, runPendingAnalyses } from '../_shared/voice-runner.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const webhookKey = Deno.env.get('RETELL_API_KEY');
const MAX_BYTES = 2 * 1024 * 1024; // transcripts can be large

const reply = (status: number) => new Response(null, { status });

Deno.serve(async (req) => {
  const started = Date.now();
  if (req.method !== 'POST') return reply(405);
  // Without the key no signature can be checked, so nothing is accepted.
  if (!webhookKey) return reply(503);
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BYTES) return reply(413);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) return reply(413);
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return reply(400);
  }

  const v = await verifyRetellSignature(webhookKey, raw, req.headers.get('x-retell-signature'));
  if (!v.ok) {
    log('voice-webhook', { outcome: 'rejected', reason: v.reason });
    return reply(401);
  }
  const parsed = parseRetellEvent(raw);
  if (!parsed.ok) {
    log('voice-webhook', { outcome: 'invalid', reason: parsed.error });
    return reply(400);
  }

  const { data, error } = await supabase.rpc('voice_webhook_ingest', { p_event: parsed.event, p_call: parsed.call });
  if (error) {
    // Not durably accepted → non-2xx so Retell retries (up to 3 times).
    log('voice-webhook', { outcome: 'error', event: parsed.event, ms: Date.now() - started });
    return reply(500);
  }
  const r = data as { result: string; call_id?: string; needs_analysis?: boolean };
  log('voice-webhook', { outcome: r.result, event: parsed.event, call: r.call_id, ms: Date.now() - started });
  if (r.needs_analysis) {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(runPendingAnalyses(supabase, 1));
  }
  return reply(204);
});
