// POST /functions/v1/lead-intake?org=<slug>
// Headers: X-Estate-Event-Id, X-Estate-Timestamp, X-Estate-Signature (see _shared/intake.ts).
// Deploy with JWT verification OFF — this endpoint authenticates callers by HMAC signature.
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { EVENT_ID, MAX_BODY_BYTES, ORG_SLUG, parsePayload, verifySignature } from '../_shared/intake.ts';
import { extractRequirements } from './extract.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const err = (status: number, code: string, message: string) => json(status, { error: { code, message, details: {} } });

function log(fields: Record<string, unknown>) {
  // Structured, no payload contents or secrets.
  console.log(JSON.stringify({ fn: 'lead-intake', ...fields }));
}

/** Reads the body, stopping as soon as it exceeds `max` bytes (chunked bodies have no Content-Length). */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

Deno.serve(async (req) => {
  const started = Date.now();
  const requestId = crypto.randomUUID();
  if (req.method !== 'POST') return err(405, 'METHOD_NOT_ALLOWED', 'Use POST');
  const url = new URL(req.url);
  const slug = url.searchParams.get('org') ?? '';
  const eventId = req.headers.get('x-estate-event-id') ?? '';
  if (!ORG_SLUG.test(slug)) return err(400, 'VALIDATION_ERROR', 'Missing or invalid org parameter');
  if (!EVENT_ID.test(eventId)) return err(400, 'VALIDATION_ERROR', 'Missing or invalid X-Estate-Event-Id header');

  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return err(413, 'PAYLOAD_TOO_LARGE', 'Body exceeds 64 KB');
  const body = await readCapped(req, MAX_BODY_BYTES);
  if (!body) return err(413, 'PAYLOAD_TOO_LARGE', 'Body exceeds 64 KB');
  let raw: string;
  try {
    // Fatal: the signature covers the bytes sent, so never verify a lossy decoding of them.
    raw = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return err(400, 'VALIDATION_ERROR', 'Body must be UTF-8');
  }

  const { data: rows, error: secretError } = await supabase.rpc('webhook_secret_for', { p_slug: slug });
  if (secretError) {
    log({ requestId, outcome: 'error', stage: 'secret_lookup' });
    return err(500, 'UNKNOWN', 'Temporary error, retry later');
  }
  const target = (rows ?? [])[0] as { organization_id: string; secret: string | null } | undefined;
  // Same response for unknown org and disabled intake: don't reveal which workspaces exist.
  if (!target?.secret) return err(404, 'NOT_FOUND', 'Intake is not enabled for this organization');

  const verdict = await verifySignature(target.secret, req.headers.get('x-estate-signature'), req.headers.get('x-estate-timestamp'), raw);
  if (!verdict.ok) {
    // Bounded record (one row per org per minute) so admins see failures without letting callers grow the table.
    await supabase.rpc('record_rejected_webhook', { p_org: target.organization_id, p_provider: 'webhook' });
    log({ requestId, org: target.organization_id, outcome: 'rejected', reason: verdict.reason, ms: Date.now() - started });
    return err(401, 'INVALID_SIGNATURE', 'Signature verification failed');
  }

  const parsed = parsePayload(raw);
  if (!parsed.ok) {
    log({ requestId, org: target.organization_id, outcome: 'invalid', ms: Date.now() - started });
    return err(422, 'VALIDATION_ERROR', parsed.error);
  }

  // 1. Durable run (idempotent per event id). From here on, a crash is recovered by the worker.
  const org = target.organization_id;
  const { data: rec, error: recError } = await supabase.rpc('intake_receive', {
    p_org: org,
    p_source_kind: 'webhook',
    p_provider: 'webhook',
    p_event_id: eventId,
    p_payload: parsed.value,
  });
  if (recError) {
    log({ requestId, org, outcome: 'error', stage: 'receive', ms: Date.now() - started });
    return err(500, 'UNKNOWN', 'Temporary error, retry later');
  }
  const received = rec as { status: string; run_id: string; run_status?: string; lead_id?: string | null; needs_extraction: boolean; currency?: string; country?: string; correlation_id?: string };
  if (received.status === 'duplicate_event') {
    log({ requestId, org, run: received.run_id, outcome: 'duplicate_event', runStatus: received.run_status, ms: Date.now() - started });
    return json(200, { status: 'duplicate_event', lead_id: received.lead_id ?? null });
  }

  // 2. Optional language step, before any write to CRM records. Stored on the run so retries never call the model again.
  let modelOutcome: string | undefined;
  if (received.needs_extraction && parsed.value.message) {
    const { extraction, meta } = await extractRequirements(parsed.value.message, { currency: received.currency ?? 'INR', country: received.country ?? 'IN' });
    modelOutcome = String(meta.outcome);
    const { error: attachError } = await supabase.rpc('intake_attach_extraction', { p_run: received.run_id, p_extraction: extraction, p_meta: meta });
    if (attachError) log({ requestId, org, run: received.run_id, outcome: 'warning', stage: 'attach_extraction' });
  }

  // 3. Deterministic pipeline in one transaction.
  const { data, error } = await supabase.rpc('intake_process', { p_run: received.run_id });
  if (error) {
    // The run stays 'received'; the worker picks it up within ~2 minutes.
    log({ requestId, org, run: received.run_id, outcome: 'error', stage: 'process', ms: Date.now() - started });
    return json(202, { status: 'accepted', lead_id: null });
  }
  const result = data as { status: string; lead_id?: string | null; duplicate?: string; assignment?: string };
  log({
    requestId, org, run: received.run_id, correlation: received.correlation_id, outcome: result.status,
    duplicate: result.duplicate, assignment: result.assignment, model: modelOutcome, ms: Date.now() - started,
  });
  switch (result.status) {
    case 'invalid':
      return err(422, 'VALIDATION_ERROR', 'Payload failed server validation');
    case 'created':
    case 'review_required':
      return json(201, { status: result.status, lead_id: result.lead_id ?? null });
    case 'retry_scheduled':
      return json(202, { status: 'accepted', lead_id: null });
    case 'dead_letter':
      return err(500, 'UNKNOWN', 'Processing failed');
    default:
      return json(200, { status: result.status, lead_id: result.lead_id ?? null });
  }
});
