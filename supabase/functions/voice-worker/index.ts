// POST /functions/v1/voice-worker — called every minute by pg_cron (pg_net) with the Vault shared secret.
// 1. Housekeeping in SQL (unsent reservations, transcript retention).
// 2. Re-sends ambiguous initiations with the SAME idempotency key (Retell de-duplicates for 1 hour).
// 3. Reconciles calls missing their terminal webhook via get-call.
// 4. Runs pending / retryable post-call analyses.
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { authorizeWorker } from '../_shared/worker-auth.ts';
import { RetellVoiceProvider } from '../_shared/retell.ts';
import { dispatchCall, log, runPendingAnalyses } from '../_shared/voice-runner.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const retellKey = Deno.env.get('RETELL_API_KEY');
const provider = retellKey ? new RetellVoiceProvider(retellKey) : null;
const failures = new Map<string, number>();

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const denied = await authorizeWorker(supabase, 'voice-worker', 'voice_worker_secret_ok', req.headers.get('x-worker-secret'));
  if (denied) return denied;
  const started = Date.now();

  const { data: tick, error } = await supabase.rpc('voice_worker_tick');
  if (error) {
    log('voice-worker', { outcome: 'error', stage: 'tick' });
    return new Response(null, { status: 500 });
  }
  const t = tick as { redispatch: string[]; stale: { call_id: string; provider_call_id: string }[]; transcripts_purged: number };
  let redispatched = 0;
  let reconciled = 0;

  if (provider) {
    for (const id of t.redispatch) {
      await dispatchCall(supabase, provider, id);
      redispatched++;
    }
    for (const s of t.stale) {
      const res = await provider.getCall(s.provider_call_id);
      if (!res.ok) {
        const n = (failures.get(s.call_id) ?? 0) + 1;
        failures.set(s.call_id, n);
        if (n >= 3 || res.kind === 'permanent') await supabase.rpc('voice_call_close_unresolved', { p_call: s.call_id });
        continue;
      }
      const call = res.value as Record<string, unknown>;
      // Feed the provider's current state through the same ingestion path; event+call_id dedupe makes this safe.
      if (call.call_status === 'ended' || call.call_status === 'error' || call.call_status === 'not_connected') {
        await supabase.rpc('voice_webhook_ingest', { p_event: 'call_ended', p_call: call });
        if (call.call_analysis) await supabase.rpc('voice_webhook_ingest', { p_event: 'call_analyzed', p_call: call });
        else await supabase.rpc('voice_call_close_unresolved', { p_call: s.call_id });
      }
      reconciled++;
    }
  }
  const analysed = await runPendingAnalyses(supabase, 5);
  log('voice-worker', { outcome: 'ok', redispatched, reconciled, analysed, purged: t.transcripts_purged, retell: !!provider, ms: Date.now() - started });
  return new Response(JSON.stringify({ redispatched, reconciled, analysed }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
