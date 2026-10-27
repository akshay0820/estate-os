// POST /functions/v1/appointment-assistant — signed-in staff only (JWT verified by the platform and used for every query).
// Body: { lead_id?, org_id?, text, type?, property_id?, assignee_id? }. Claude turns the request into a date range and a
// time window; the slots then come only from appointment_availability, called as the user (RLS and permissions apply).
// Without ANTHROPIC_API_KEY it answers 503 { status: 'not_configured' } and the UI uses the date / time pickers.
// ai_request_begin runs before the model: appointments.edit in the organization, plus the AI request limits (429).
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { beginAiRequest } from '../_shared/ai-guard.ts';
import { buildSchedulingContent, localToday, SCHEDULING_JSON_SCHEMA, SCHEDULING_PROMPT_VERSION, SCHEDULING_SYSTEM_PROMPT, validateInterpretation } from '../_shared/scheduling-assistant.ts';

const MODEL = Deno.env.get('APPOINTMENT_MODEL') ?? 'claude-opus-5-5';
const key = Deno.env.get('ANTHROPIC_API_KEY');
const claude = key ? new Anthropic({ apiKey: key, timeout: 20_000, maxRetries: 1 }) : null;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const UUID = /^[0-9a-f-]{36}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = req.headers.get('Authorization');
  if (!auth) return json(401, { error: 'unauthorized' });
  if (!claude) return json(503, { status: 'not_configured' });
  let body: { lead_id?: string; org_id?: string; text?: string; type?: string; property_id?: string; assignee_id?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const text = String(body.text ?? '').trim();
  if (text.length < 3 || text.length > 1000) return json(400, { error: 'text must be 3–1000 characters' });
  for (const k of ['lead_id', 'org_id', 'property_id', 'assignee_id'] as const) if (body[k] && !UUID.test(body[k]!)) return json(400, { error: `invalid ${k}` });

  // Every read runs as the caller: the org and its time zone come from rows the caller may see.
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const orgId = body.lead_id ? (await sb.from('leads').select('organization_id').eq('id', body.lead_id).maybeSingle()).data?.organization_id : body.org_id;
  if (!orgId) return json(404, { error: 'not_found' });
  const guard = await beginAiRequest(sb, orgId, 'appointment_assistant');
  if (!guard.ok) return json(guard.status, guard.body);
  const { data: org } = await sb.from('organizations').select('timezone').eq('id', orgId).maybeSingle();
  if (!org) { await guard.finish('error'); return json(404, { error: 'not_found' }); }
  const { data: settings } = await sb.from('scheduling_settings').select('rules').eq('organization_id', orgId).maybeSingle();
  const horizon = Number((settings?.rules as Record<string, unknown> | undefined)?.horizon_days ?? 60);
  const ref = localToday(org.timezone);

  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  const started = Date.now();
  let interp;
  try {
    // deno-lint-ignore no-explicit-any
    const res = await claude.beta.messages.create({
      model: MODEL, max_tokens: 1024, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEDULING_JSON_SCHEMA } },
      system: SCHEDULING_SYSTEM_PROMPT, messages: [{ role: 'user', content: buildSchedulingContent(text, ref) }],
    } as any);
    usage = res.usage;
    let raw: unknown = null;
    try { raw = JSON.parse(res.content.flatMap((b: { type: string; text?: string }) => (b.type === 'text' ? [b.text!] : [])).join('')); } catch { /* invalid */ }
    const v = validateInterpretation(raw, ref.today, horizon);
    if (!v.ok) { await guard.finish('invalid_output', MODEL, usage); return json(422, { status: 'invalid_output', reason: v.reason, prompt_version: SCHEDULING_PROMPT_VERSION }); }
    interp = v.value;
  } catch (e) {
    const timeout = e instanceof Anthropic.APIConnectionTimeoutError;
    await guard.finish(timeout ? 'timeout' : 'model_error', MODEL, usage);
    return json(502, { status: timeout ? 'timeout' : 'model_error', ms: Date.now() - started });
  }
  if (interp.needs_clarification) { await guard.finish('no_result', MODEL, usage); return json(200, { status: 'needs_clarification', interpretation: interp, reference: ref }); }

  const type = body.type ?? interp.appointment_type;
  if (!type) {
    await guard.finish('no_result', MODEL, usage);
    return json(200, { status: 'needs_clarification', interpretation: { ...interp, clarification_question: 'Is this a property viewing, a consultation, a valuation or a call-back?' }, reference: ref });
  }
  const { data: availability, error } = await sb.rpc('appointment_availability', {
    p_lead: body.lead_id ?? null, p_org: body.lead_id ? null : orgId, p_type: type, p_property: body.property_id ?? null, p_assignee: body.assignee_id ?? null,
    p_date_from: interp.date_from, p_date_to: interp.date_to, p_pref_start: interp.window_start, p_pref_end: interp.window_end, p_duration: interp.duration_minutes,
  });
  if (error) { await guard.finish('error', MODEL, usage); return json(400, { status: 'availability_error', code: error.details, message: error.message }); }
  await guard.finish('ok', MODEL, usage);
  return json(200, { status: 'ok', interpretation: interp, reference: ref, availability, prompt_version: SCHEDULING_PROMPT_VERSION });
});
