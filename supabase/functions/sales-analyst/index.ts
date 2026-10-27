// POST /functions/v1/sales-analyst — signed-in users with report access (JWT verified by the platform, used for every call).
// Body: { org_id, question, previous_spec? }. Claude maps the question to a catalogue query (no SQL); the spec is validated
// (validateAnalystSpec) and executed by si_query as the caller, which re-validates it, enforces permissions and logs the spec
// (not the question). The answer text is built deterministically from the result. Without ANTHROPIC_API_KEY: 503 not_configured.
// Before the model is called, ai_request_begin checks reports.view and the AI request limits (429 when exceeded).
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { beginAiRequest } from '../_shared/ai-guard.ts';
import { localToday } from '../_shared/scheduling-assistant.ts';
import { ANALYST_PROMPT_VERSION, ANALYST_SYSTEM_PROMPT, analystJsonSchema, buildAnalystContent, formatAnswer, validateAnalystSpec } from '../_shared/sales-intelligence.ts';

const MODEL = Deno.env.get('SALES_ANALYST_MODEL') ?? 'claude-opus-5-5';
const key = Deno.env.get('ANTHROPIC_API_KEY');
const claude = key ? new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 1 }) : null;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = req.headers.get('Authorization');
  if (!auth) return json(401, { error: 'unauthorized' });
  if (!claude) return json(503, { status: 'not_configured' });
  let body: { org_id?: string; question?: string; previous_spec?: unknown };
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const question = String(body.question ?? '').trim();
  if (!body.org_id || !/^[0-9a-f-]{36}$/.test(body.org_id)) return json(400, { error: 'invalid org_id' });
  if (question.length < 3 || question.length > 500) return json(400, { error: 'question must be 3–500 characters' });

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const guard = await beginAiRequest(sb, body.org_id, 'sales_analyst');
  if (!guard.ok) return json(guard.status, guard.body);
  const { data: org } = await sb.from('organizations').select('timezone').eq('id', body.org_id).maybeSingle();
  if (!org) { await guard.finish('error'); return json(404, { error: 'not_found' }); }
  const { data: catalogue, error: catErr } = await sb.rpc('si_metric_catalogue');
  if (catErr || !catalogue) { await guard.finish('error'); return json(500, { error: 'catalogue_unavailable' }); }
  const { data: srcRows } = await sb.from('leads').select('source').eq('organization_id', body.org_id).limit(1000);
  const sources = [...new Set((srcRows ?? []).map((r) => r.source as string))];

  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  let raw: unknown = null;
  try {
    // deno-lint-ignore no-explicit-any
    const res = await claude.beta.messages.create({
      model: MODEL, max_tokens: 1024, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: analystJsonSchema(Object.keys(catalogue)) } },
      system: ANALYST_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildAnalystContent(question, { ...localToday(org.timezone), catalogue, sources, previous: body.previous_spec ?? null }) }],
    } as any);
    usage = res.usage;
    try { raw = JSON.parse(res.content.flatMap((b: { type: string; text?: string }) => (b.type === 'text' ? [b.text!] : [])).join('')); } catch { /* invalid */ }
  } catch (e) {
    const timeout = e instanceof Anthropic.APIConnectionTimeoutError;
    await guard.finish(timeout ? 'timeout' : 'model_error', MODEL, usage);
    return json(502, { status: timeout ? 'timeout' : 'model_error' });
  }
  const v = validateAnalystSpec(raw, catalogue);
  if (!v.ok) {
    await guard.finish(v.unsupported ? 'no_result' : 'invalid_output', MODEL, usage);
    return json(200, { status: v.unsupported ? 'unsupported' : 'invalid_output', message: v.reason, prompt_version: ANALYST_PROMPT_VERSION });
  }
  const { data: result, error } = await sb.rpc('si_query', { p_org: body.org_id, p_spec: v.spec, p_log: true });
  if (error) { await guard.finish('error', MODEL, usage); return json(400, { status: 'error', code: error.details, message: error.message }); }
  if (result.error) { await guard.finish('refused', MODEL, usage); return json(200, { status: 'refused', code: result.error, message: result.message, spec: v.spec }); }
  await guard.finish('ok', MODEL, usage);
  return json(200, { status: 'ok', spec: v.spec, answer: formatAnswer(result), result, prompt_version: ANALYST_PROMPT_VERSION });
});
