// POST /functions/v1/crm-enrichment — signed-in staff only (JWT verified by the platform and used for every query).
// Body: { lead_id }. Reads the lead's summary and notes as the caller, asks Claude for explicitly stated facts with exact
// evidence quotes, validates them (validateFacts) and stores survivors as proposals via dq_propose_enrichment, again as the
// caller (permissions and tenancy apply). Nothing is applied to the lead. Without ANTHROPIC_API_KEY: 503 not_configured.
// ai_request_begin runs before the model: leads.edit in the lead's organization, plus the AI request limits (429).
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { beginAiRequest } from '../_shared/ai-guard.ts';
import { buildEnrichmentContent, ENRICH_JSON_SCHEMA, ENRICHMENT_PROMPT_VERSION, ENRICHMENT_SYSTEM_PROMPT, validateFacts } from '../_shared/crm-enrichment.ts';

const MODEL = Deno.env.get('ENRICHMENT_MODEL') ?? 'claude-opus-5-5';
const key = Deno.env.get('ANTHROPIC_API_KEY');
const claude = key ? new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 1 }) : null;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const UUID = /^[0-9a-f-]{36}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = req.headers.get('Authorization');
  if (!auth) return json(401, { error: 'unauthorized' });
  if (!claude) return json(503, { status: 'not_configured' });
  let body: { lead_id?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  if (!body.lead_id || !UUID.test(body.lead_id)) return json(400, { error: 'invalid lead_id' });

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: lead } = await sb.from('leads').select('id, organization_id, summary, budget_currency').eq('id', body.lead_id).maybeSingle();
  if (!lead) return json(404, { error: 'not_found' });
  const { data: notes } = await sb.from('activities').select('description').eq('lead_id', lead.id).eq('activity_type', 'note').order('occurred_at', { ascending: false }).limit(20);
  const text = [lead.summary, ...(notes ?? []).map((n) => n.description)].filter((x): x is string => !!x && x.trim().length > 0).join('\n---\n');
  if (text.trim().length < 10) return json(200, { status: 'no_source_text' });
  const guard = await beginAiRequest(sb, lead.organization_id, 'crm_enrichment');
  if (!guard.ok) return json(guard.status, guard.body);

  let usage: { input_tokens?: number; output_tokens?: number } | undefined;
  const started = Date.now();
  let facts: unknown = null;
  try {
    // deno-lint-ignore no-explicit-any
    const res = await claude.beta.messages.create({
      model: MODEL, max_tokens: 2048, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ENRICH_JSON_SCHEMA } },
      system: ENRICHMENT_SYSTEM_PROMPT, messages: [{ role: 'user', content: buildEnrichmentContent(text, lead.budget_currency) }],
    } as any);
    usage = res.usage;
    try { facts = JSON.parse(res.content.flatMap((b: { type: string; text?: string }) => (b.type === 'text' ? [b.text!] : [])).join('')); } catch { /* invalid */ }
  } catch (e) {
    const timeout = e instanceof Anthropic.APIConnectionTimeoutError;
    await guard.finish(timeout ? 'timeout' : 'model_error', MODEL, usage);
    return json(502, { status: timeout ? 'timeout' : 'model_error', ms: Date.now() - started });
  }
  const v = validateFacts(facts, text);
  if (!v.ok) { await guard.finish('invalid_output', MODEL, usage); return json(422, { status: 'invalid_output', reason: v.reason, prompt_version: ENRICHMENT_PROMPT_VERSION }); }
  if (v.proposals.length === 0) { await guard.finish('no_result', MODEL, usage); return json(200, { status: 'ok', proposed: 0, rejected: v.rejected, prompt_version: ENRICHMENT_PROMPT_VERSION }); }
  const { data, error } = await sb.rpc('dq_propose_enrichment', { p_lead: lead.id, p_proposals: v.proposals, p_model: MODEL });
  if (error) { await guard.finish('refused', MODEL, usage); return json(400, { status: 'rejected', code: error.details, message: error.message }); }
  await guard.finish('ok', MODEL, usage);
  return json(200, { status: 'ok', ...data, rejected: v.rejected, prompt_version: ENRICHMENT_PROMPT_VERSION, ms: Date.now() - started });
});
