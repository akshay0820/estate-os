// Signed-in API for the unified inbox's email channel (JWT verification ON).
//   GET  /inbox-email/status                            → { postmark_configured: boolean }
//   POST /inbox-email/send  { conversation_id, body, internal? } → reserve (policy-checked in SQL, as the user) and send
// Authorization happens in SQL with the caller's JWT; the service-role client is used only after that succeeds,
// exactly as voice-calls does for Retell.
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { PostmarkEmailProvider } from '../_shared/postmark.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const postmarkToken = Deno.env.get('POSTMARK_SERVER_TOKEN');
const provider = postmarkToken ? new PostmarkEmailProvider(postmarkToken) : null;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const err = (status: number, code: string, message: string) => json(status, { error: { code, message, details: {} } });

function dbError(e: { message?: string; details?: string }) {
  const code = e.details ?? '';
  const map: Record<string, number> = { NOT_FOUND: 404, FORBIDDEN: 403, VALIDATION_ERROR: 422, CONFLICT: 409 };
  if (map[code]) return err(map[code], code, e.message ?? code);
  return err(500, 'UNKNOWN', 'Temporary error, retry later');
}

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ fn: 'inbox-email', ...fields }));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return err(401, 'UNAUTHENTICATED', 'Sign in required');
  const user = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  const path = new URL(req.url).pathname.replace(/^.*\/inbox-email/, '') || '/';

  if (req.method === 'GET' && path === '/status') {
    const { data } = await user.auth.getUser();
    if (!data.user) return err(401, 'UNAUTHENTICATED', 'Sign in required');
    return json(200, { postmark_configured: !!provider });
  }

  if (req.method === 'POST' && path === '/send') {
    let body: { conversation_id?: unknown; body?: unknown; internal?: unknown };
    try { body = await req.json(); } catch { return err(400, 'VALIDATION_ERROR', 'Body must be JSON'); }
    if (typeof body.conversation_id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.conversation_id)) return err(422, 'VALIDATION_ERROR', 'conversation_id is required');
    if (typeof body.body !== 'string' || body.body.trim().length === 0) return err(422, 'VALIDATION_ERROR', 'body is required');
    const internal = body.internal === true;

    const { data, error } = await user.rpc('conversation_send_request', { p_conv: body.conversation_id, p_body: body.body, p_internal: internal });
    if (error) return dbError(error);
    const r = data as { dispatch: boolean; blocked?: boolean; reason?: string; message_id?: string; to_address?: string; from_address?: string; from_name?: string; subject?: string; body?: string };
    if (r.blocked) return json(200, { status: 'blocked', reason: r.reason });
    if (!r.dispatch) return json(200, { status: 'sent', message_id: r.message_id });
    if (!provider) {
      await service.rpc('conversation_message_mark_failed', { p_message: r.message_id, p_error: 'Email is not configured on the server (Postmark token missing)' });
      return err(503, 'NOT_CONFIGURED', 'Email is not configured on the server (Postmark token missing)');
    }
    const res = await provider.sendEmail({ fromAddress: r.from_address!, fromName: r.from_name ?? null, toAddress: r.to_address!, subject: r.subject ?? 'Re: your enquiry', textBody: r.body! });
    if (res.ok) {
      await service.rpc('conversation_message_mark_sent', { p_message: r.message_id, p_provider_message_id: res.value.MessageID });
      log({ outcome: 'sent', message: r.message_id });
      return json(200, { status: 'sent', message_id: r.message_id });
    }
    await service.rpc('conversation_message_mark_failed', { p_message: r.message_id, p_error: res.message });
    log({ outcome: res.kind, message: r.message_id, http: res.status });
    return err(502, 'PROVIDER_ERROR', 'Could not send the email through the provider');
  }

  return err(404, 'NOT_FOUND', 'Unknown route');
});
