// POST /functions/v1/email-inbound — Postmark inbound email webhook (JWT verification OFF; authenticated by
// Basic Auth against POSTMARK_INBOUND_SECRET, embedded in the webhook URL Postmark is configured to call).
// Org is resolved by matching the recipient address against email_settings.inbound_address — never trusted from
// the payload itself. Verify → parse → one RPC (dedupe, find-or-create contact/conversation, opt-out) → 200.
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { parseInboundEmail, verifyBasicAuth } from '../_shared/postmark.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const inboundSecret = Deno.env.get('POSTMARK_INBOUND_SECRET');
const MAX_BYTES = 5 * 1024 * 1024; // inbound emails can carry attachments metadata and quoted threads

function log(fields: Record<string, unknown>) {
  // Ids and outcomes only — never message bodies, addresses or secrets.
  console.log(JSON.stringify({ fn: 'email-inbound', ...fields }));
}

const reply = (status: number) => new Response(null, { status });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405);
  if (!inboundSecret) return reply(503);
  if (!verifyBasicAuth(req.headers.get('authorization'), inboundSecret)) {
    log({ outcome: 'rejected', reason: 'bad_auth' });
    return reply(401);
  }
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BYTES) return reply(413);
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return reply(413);

  const parsed = parseInboundEmail(raw);
  if (!parsed.ok) {
    log({ outcome: 'invalid', reason: parsed.error });
    return reply(400);
  }

  const { data: orgId, error: orgErr } = await supabase.rpc('email_settings_org_for_inbound', { p_inbound_address: parsed.email.toAddress });
  if (orgErr) {
    log({ outcome: 'error', stage: 'resolve_org' });
    return reply(500);
  }
  if (!orgId) {
    // No workspace owns this address (or email isn't enabled there). Acknowledge so Postmark doesn't retry.
    log({ outcome: 'unrouted' });
    return reply(200);
  }

  const { data, error } = await supabase.rpc('email_inbound_ingest', {
    p_org: orgId, p_from_email: parsed.email.fromEmail, p_from_name: parsed.email.fromName,
    p_subject: parsed.email.subject, p_body: parsed.email.textBody, p_provider_message_id: parsed.email.messageId,
  });
  if (error) {
    log({ outcome: 'error', stage: 'ingest' });
    return reply(500); // non-2xx so Postmark retries
  }
  const r = data as { result: string; conversation_id?: string };
  log({ outcome: r.result, conversation: r.conversation_id });
  return reply(200);
});
