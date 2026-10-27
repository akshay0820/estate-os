// POST /functions/v1/sales-intelligence-recommend — signed-in managers only (JWT verified by the platform, used for every call).
// Body: { org_id }. Builds and stores the analytical snapshot (si_recommendation_context, as the caller), asks Claude for
// recommendations grounded in it, validates them (validateRecommendations) and saves the survivors (si_recommendations_save,
// which re-checks every cited value). Without ANTHROPIC_API_KEY: 503 not_configured; rule-based findings remain available.
// ai_request_begin runs first: same manager rule as the context RPC, plus the AI request limits (429 when exceeded).
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { beginAiRequest } from '../_shared/ai-guard.ts';
import { buildRecsContent, RECS_JSON_SCHEMA, RECS_PROMPT_VERSION, RECS_SYSTEM_PROMPT, validateRecommendations } from '../_shared/sales-intelligence.ts';

const MODEL = Deno.env.get('SALES_INTELLIGENCE_MODEL') ?? 'claude-opus-5-5';
const key = Deno.env.get('ANTHROPIC_API_KEY');
const claude = key ? new Anthropic({ apiKey: key, timeout: 60_000, maxRetries: 1 }) : null;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = req.headers.get('Authorization');
  if (!auth) return json(401, { error: 'unauthorized' });
  if (!claude) return json(503, { status: 'not_configured' });
  let body: { org_id?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  if (!body.org_id || !/^[0-9a-f-]{36}$/.test(body.org_id)) return json(400, { error: 'invalid org_id' });

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const guard = await beginAiRequest(sb, body.org_id, 'sales_recommendations');
  if (!guard.ok) return json(guard.status, guard.body);
  const { data: ctx, error: ctxErr } = await sb.rpc('si_recommendation_context', { p_org: body.org_id });
  if (ctxErr) {
    await guard.finish('refused');
    return json(ctxErr.details === 'FORBIDDEN' ? 403 : 404, { status: 'refused', code: ctxErr.details, message: ctxErr.message });
  }

  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  const started = Date.now();
  let raw: unknown = null;
  try {
    // deno-lint-ignore no-explicit-any
    const stream = claude.beta.messages.stream({
      model: MODEL, max_tokens: 8000, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: RECS_JSON_SCHEMA } },
      system: RECS_SYSTEM_PROMPT, messages: [{ role: 'user', content: buildRecsContent(ctx.data) }],
    } as any);
    const res = await stream.finalMessage();
    usage = res.usage;
    try { raw = JSON.parse(res.content.flatMap((b: { type: string; text?: string }) => (b.type === 'text' ? [b.text!] : [])).join('')); } catch { /* invalid */ }
  } catch (e) {
    const timeout = e instanceof Anthropic.APIConnectionTimeoutError;
    await guard.finish(timeout ? 'timeout' : 'model_error', MODEL, usage);
    return json(502, { status: timeout ? 'timeout' : 'model_error', ms: Date.now() - started });
  }
  const v = validateRecommendations(raw, ctx.data);
  if (!v.ok) { await guard.finish('invalid_output', MODEL, usage); return json(422, { status: 'invalid_output', reason: v.reason, prompt_version: RECS_PROMPT_VERSION }); }
  if (v.recommendations.length === 0) { await guard.finish('no_result', MODEL, usage); return json(200, { status: 'ok', saved: 0, rejected: v.rejected, snapshot_id: ctx.snapshot_id }); }
  const { data, error } = await sb.rpc('si_recommendations_save', { p_snapshot: ctx.snapshot_id, p_recs: v.recommendations, p_model: MODEL, p_prompt_version: RECS_PROMPT_VERSION });
  if (error) { await guard.finish('refused', MODEL, usage); return json(422, { status: 'rejected', code: error.details, message: error.message }); }
  await guard.finish('ok', MODEL, usage);
  return json(200, { status: 'ok', ...data, rejected: v.rejected, prompt_version: RECS_PROMPT_VERSION, ms: Date.now() - started });
});
