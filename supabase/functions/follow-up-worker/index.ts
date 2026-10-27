// POST /functions/v1/follow-up-worker — called every minute by pg_cron (pg_net) with the Vault shared secret.
// 1. Drafting: claims pending drafts, asks Claude for a rewrite of the template from minimal facts, validates it and
//    attaches it (or the failure). Without ANTHROPIC_API_KEY it records "not_configured"; the template draft stays.
// 2. Dispatch: claims due scheduled messages (policy re-checked in SQL) and sends through a provider adapter. No adapter
//    exists in this product, so items return to "approved, send manually". Nothing is reported as sent without evidence.
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { authorizeWorker } from '../_shared/worker-auth.ts';
import { buildDraftContent, DRAFT_JSON_SCHEMA, DRAFT_PROMPT_VERSION, DRAFT_SYSTEM_PROMPT, type DraftClaim, validateDraft } from '../_shared/follow-up-drafting.ts';
import { ADAPTERS, deliver } from '../_shared/follow-up-delivery.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const MODEL = Deno.env.get('FOLLOW_UP_MODEL') ?? 'claude-opus-5-5';
const key = Deno.env.get('ANTHROPIC_API_KEY');
const claude = key ? new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 1 }) : null;

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'follow-up-worker', ...fields }));

async function draft(c: DraftClaim) {
  const started = Date.now();
  const meta: Record<string, string | number> = { model: MODEL, prompt_version: DRAFT_PROMPT_VERSION };
  let result: unknown = null;
  if (!claude) meta.outcome = 'not_configured';
  else {
    try {
      const params = {
        model: MODEL,
        max_tokens: 2048,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: DRAFT_JSON_SCHEMA } },
        system: DRAFT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildDraftContent(c) }],
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
        const v = validateDraft(raw, c);
        if (v.ok) { result = v.value; meta.outcome = 'ok'; } else { meta.outcome = 'invalid_output'; meta.dropped = v.reason; }
      }
    } catch (e) {
      meta.outcome = e instanceof Anthropic.APIConnectionTimeoutError ? 'timeout'
        : e instanceof Anthropic.RateLimitError ? 'rate_limited'
        : e instanceof Anthropic.APIError ? `api_error_${e.status ?? 'unknown'}` : 'error';
    }
  }
  meta.latency_ms = Date.now() - started;
  const { error } = await supabase.rpc('follow_up_attach_draft', { p_follow_up: c.follow_up_id, p_version: c.content_version, p_result: result, p_meta: meta });
  log({ step: 'draft', follow_up: c.follow_up_id, outcome: meta.outcome, attach: error ? 'error' : 'ok', ms: meta.latency_ms });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const denied = await authorizeWorker(supabase, 'follow-up-worker', 'follow_up_worker_secret_ok', req.headers.get('x-worker-secret'));
  if (denied) return denied;

  const { data: drafts, error: dErr } = await supabase.rpc('follow_up_draft_claim', { p_limit: 5 });
  if (dErr) log({ step: 'draft_claim', outcome: 'error' });
  for (const c of (drafts ?? []) as DraftClaim[]) await draft(c);

  const { data: due, error: sErr } = await supabase.rpc('follow_up_dispatch_claim', { p_limit: 10 });
  if (sErr) log({ step: 'dispatch_claim', outcome: 'error' });
  const items = (due ?? []) as { follow_up_id: string; provider: string; channel: 'whatsapp' | 'sms' | 'email'; recipient: string; subject: string | null; body: string; idempotency_key: string }[];
  for (const it of items) {
    const r = await deliver({ followUpId: it.follow_up_id, channel: it.channel, to: it.recipient, subject: it.subject, body: it.body, idempotencyKey: it.idempotency_key }, ADAPTERS[it.provider]);
    const { data: status } = await supabase.rpc('follow_up_dispatch_result', { p_follow_up: it.follow_up_id, p_outcome: r.outcome, p_provider_message_id: r.providerMessageId ?? null, p_error: r.error ?? null });
    log({ step: 'dispatch', follow_up: it.follow_up_id, provider: it.provider, outcome: r.outcome, status });
  }
  return new Response(JSON.stringify({ drafted: (drafts ?? []).length, dispatched: items.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
