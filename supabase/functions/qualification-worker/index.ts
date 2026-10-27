// POST /functions/v1/qualification-worker — called every minute by pg_cron (pg_net) with the Vault shared secret.
// Claims qualification runs waiting for the optional Claude step, sends only the minimal text, validates the answer,
// attaches it (or the failure), then processes the run. Without ANTHROPIC_API_KEY it attaches "not_configured" and
// the deterministic engine runs as usual — nothing waits on the model.
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { authorizeWorker } from '../_shared/worker-auth.ts';
import { buildQualContent, QUAL_JSON_SCHEMA, QUAL_PROMPT_VERSION, QUAL_SYSTEM_PROMPT, type Source, validateQualAnalysis } from '../_shared/qualification-analysis.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const MODEL = Deno.env.get('QUALIFICATION_MODEL') ?? 'claude-opus-5-5';
const key = Deno.env.get('ANTHROPIC_API_KEY');
const claude = key ? new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 1 }) : null;

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'qualification-worker', ...fields }));

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const denied = await authorizeWorker(supabase, 'qualification-worker', 'qualification_worker_secret_ok', req.headers.get('x-worker-secret'));
  if (denied) return denied;

  const { data, error } = await supabase.rpc('qualification_analysis_claim', { p_limit: 5 });
  if (error) {
    log({ outcome: 'error', stage: 'claim' });
    return new Response(null, { status: 500 });
  }
  const rows = (data ?? []) as { run_id: string; sources: Source[]; known: Record<string, unknown>; currency: string; country: string }[];
  for (const row of rows) {
    const started = Date.now();
    const meta: Record<string, string | number> = { model: MODEL, prompt_version: QUAL_PROMPT_VERSION };
    let result: unknown = null;
    if (!claude) meta.outcome = 'not_configured';
    else if (!row.sources.length) meta.outcome = 'no_text';
    else {
      try {
        const params = {
          model: MODEL,
          max_tokens: 4096,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'low', format: { type: 'json_schema', schema: QUAL_JSON_SCHEMA } },
          system: QUAL_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildQualContent(row.sources, row.known, { currency: row.currency, country: row.country }) }],
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
          const v = validateQualAnalysis(raw, row.sources);
          if (v.ok) {
            result = v.value;
            meta.outcome = v.dropped.length ? 'ok_partial' : 'ok';
          } else meta.outcome = 'invalid_output';
        }
      } catch (e) {
        meta.outcome = e instanceof Anthropic.APIConnectionTimeoutError ? 'timeout'
          : e instanceof Anthropic.RateLimitError ? 'rate_limited'
          : e instanceof Anthropic.APIError ? `api_error_${e.status ?? 'unknown'}` : 'error';
      }
    }
    meta.latency_ms = Date.now() - started;
    const { error: aErr } = await supabase.rpc('qualification_attach_analysis', { p_run: row.run_id, p_result: result, p_meta: meta });
    const { data: done } = aErr ? { data: null } : await supabase.rpc('qualification_process', { p_run: row.run_id });
    log({ run: row.run_id, outcome: meta.outcome, attach: aErr ? 'error' : 'ok', status: (done as { status?: string } | null)?.status, ms: meta.latency_ms });
  }
  return new Response(JSON.stringify({ analysed: rows.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
