// Signed-in API for AI calls (JWT verification ON).
//   GET  /voice-calls/status                       → { retell_configured, analysis_configured } (booleans only)
//   POST /voice-calls/call   { lead_id, idempotency_key } → reserve (policy-checked in SQL, as the user) and dial
//   GET  /voice-calls/recording?call_id=…          → short-lived link for users with calls.recordings
// Authorization happens in SQL with the caller's JWT; the service-role client is used only after that succeeds.
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { RetellVoiceProvider } from '../_shared/retell.ts';
import { dispatchCall, log } from '../_shared/voice-runner.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const retellKey = Deno.env.get('RETELL_API_KEY');
const provider = retellKey ? new RetellVoiceProvider(retellKey) : null;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message, details: {} } });

/** Maps database errors raised by private.fail (code in DETAIL) to HTTP. */
function dbError(e: { message?: string; details?: string; code?: string }) {
  const code = e.details ?? '';
  const map: Record<string, number> = { NOT_FOUND: 404, FORBIDDEN: 403, VALIDATION_ERROR: 422, CONFLICT: 409 };
  if (map[code]) return err(map[code], code, e.message ?? code);
  return err(500, 'UNKNOWN', 'Temporary error, retry later');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return err(401, 'UNAUTHENTICATED', 'Sign in required');
  const user = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  const path = new URL(req.url).pathname.replace(/^.*\/voice-calls/, '') || '/';

  if (req.method === 'GET' && path === '/status') {
    const { data } = await user.auth.getUser();
    if (!data.user) return err(401, 'UNAUTHENTICATED', 'Sign in required');
    return json(200, { retell_configured: !!provider, analysis_configured: !!Deno.env.get('ANTHROPIC_API_KEY') });
  }

  if (req.method === 'POST' && path === '/call') {
    let body: { lead_id?: unknown; idempotency_key?: unknown };
    try { body = await req.json(); } catch { return err(400, 'VALIDATION_ERROR', 'Body must be JSON'); }
    if (typeof body.lead_id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.lead_id)) return err(422, 'VALIDATION_ERROR', 'lead_id is required');
    if (typeof body.idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.idempotency_key)) return err(422, 'VALIDATION_ERROR', 'idempotency_key is required');
    // Refuse before reserving anything if the platform has no Retell credentials: never pretend a call was placed.
    if (!provider) return err(503, 'NOT_CONFIGURED', 'AI calling is not configured on the server (Retell API key missing)');

    const { data, error } = await user.rpc('voice_call_request', { p_lead: body.lead_id, p_idempotency_key: body.idempotency_key });
    if (error) return dbError(error);
    const r = data as { status: string; call_id: string; dispatch?: boolean; checks?: unknown; reason?: string };
    if (r.status === 'blocked') return json(200, { status: 'blocked', call_id: r.call_id, reason: r.reason, checks: r.checks });
    if (!r.dispatch) return json(200, { status: r.status, call_id: r.call_id });
    const d = await dispatchCall(service, provider, r.call_id);
    log('voice-calls', { call: r.call_id, outcome: d.status });
    // 'pending_confirmation': Retell's answer was lost or 5xx; the worker re-sends the same idempotency key.
    return json(d.status === 'failed' ? 502 : 202, { status: d.status, call_id: r.call_id });
  }

  if (req.method === 'GET' && path === '/recording') {
    const callId = new URL(req.url).searchParams.get('call_id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(callId)) return err(422, 'VALIDATION_ERROR', 'call_id is required');
    if (!provider) return err(503, 'NOT_CONFIGURED', 'Retell is not configured');
    const { data: pcid, error } = await user.rpc('voice_call_recording_access', { p_call: callId });
    if (error) return dbError(error);
    const res = await provider.getCall(pcid as string);
    if (!res.ok) return err(502, 'PROVIDER_ERROR', 'Could not fetch the recording from the provider');
    const url = res.value.recording_url;
    if (typeof url !== 'string' || !url) return err(404, 'NOT_FOUND', 'Recording is no longer available at the provider');
    return json(200, { url, note: 'Link issued by Retell; it expires if signed URLs are enabled on the Retell agent.' });
  }

  return err(404, 'NOT_FOUND', 'Unknown route');
});
