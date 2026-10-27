// POST /functions/v1/property-matching-worker — called every minute by pg_cron (pg_net) with the Vault shared secret.
// Claims matching runs whose recommendations wait for a summary, sends only display facts, validates the answer against
// those facts, and attaches it (or the failure). Matching itself never waits on this: the ranked results and template
// explanations already exist. Without ANTHROPIC_API_KEY it records "not_configured".
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { authorizeWorker } from '../_shared/worker-auth.ts';
import { buildMatchContent, MATCH_JSON_SCHEMA, MATCH_PROMPT_VERSION, MATCH_SYSTEM_PROMPT, type MatchFacts, validateMatchExplanations } from '../_shared/match-explanations.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const MODEL = Deno.env.get('PROPERTY_MATCHING_MODEL') ?? 'claude-opus-5-5';
const key = Deno.env.get('ANTHROPIC_API_KEY');
const claude = key ? new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 1 }) : null;

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'property-matching-worker', ...fields }));

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const denied = await authorizeWorker(supabase, 'property-matching-worker', 'property_matching_worker_secret_ok', req.headers.get('x-worker-secret'));
  if (denied) return denied;

  const { data, error } = await supabase.rpc('property_matching_explain_claim', { p_limit: 3 });
  if (error) {
    log({ outcome: 'error', stage: 'claim' });
    return new Response(null, { status: 500 });
  }
  const rows = (data ?? []) as { match_run_id: string; criteria: Record<string, unknown>; matches: MatchFacts[] }[];
  for (const row of rows) {
    const started = Date.now();
    const meta: Record<string, string | number> = { model: MODEL, prompt_version: MATCH_PROMPT_VERSION };
    let result: unknown = null;
    if (!claude) meta.outcome = 'not_configured';
    else if (!row.matches.length) meta.outcome = 'nothing_to_explain';
    else {
      try {
        const params = {
          model: MODEL,
          max_tokens: 4096,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'low', format: { type: 'json_schema', schema: MATCH_JSON_SCHEMA } },
          system: MATCH_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildMatchContent(row.criteria, row.matches) }],
        };
        // deno-lint-ignore no-explicit-any
        const res = await claude.beta.messages.create(params as any);
        meta.model = res.model;
        meta.input_tokens = res.usage.input_tokens;
        meta.output_tokens = res.usage.output_tokens;
        if (res.stop_reason === 'refusal') meta.outcome = 'refused';
        else if (res.stop_reason === 'max_tokens') meta.outcome = 'truncated';
        else {
          let raw: unknown = null;
          try { raw = JSON.parse(res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')); } catch { /* invalid */ }
          const v = validateMatchExplanations(raw, row.matches, row.criteria);
          if (v.ok) {
            result = v.value;
            meta.outcome = v.dropped.length ? 'ok_partial' : 'ok';
            if (v.dropped.length) meta.dropped = v.dropped.join(',').slice(0, 300);
          } else meta.outcome = 'invalid_output';
        }
      } catch (e) {
        meta.outcome = e instanceof Anthropic.APIConnectionTimeoutError ? 'timeout'
          : e instanceof Anthropic.RateLimitError ? 'rate_limited'
          : e instanceof Anthropic.APIError ? `api_error_${e.status ?? 'unknown'}` : 'error';
      }
    }
    meta.latency_ms = Date.now() - started;
    const { error: aErr } = await supabase.rpc('property_matching_attach_explanations', { p_match_run: row.match_run_id, p_result: result, p_meta: meta });
    log({ match_run: row.match_run_id, outcome: meta.outcome, attach: aErr ? 'error' : 'ok', ms: meta.latency_ms });
  }
  return new Response(JSON.stringify({ explained: rows.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
