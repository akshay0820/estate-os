// Deno-side helpers shared by voice-webhook and voice-worker: post-call analysis and initiation dispatch.
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { ANALYSIS_JSON_SCHEMA, buildAnalysisContent, validateAnalysis, VOICE_PROMPT_VERSION, VOICE_SYSTEM_PROMPT } from './voice-analysis.ts';
import { RetellVoiceProvider } from './retell.ts';

const MODEL = Deno.env.get('VOICE_ANALYSIS_MODEL') ?? 'claude-opus-5-5';
const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
const claude = anthropicKey ? new Anthropic({ apiKey: anthropicKey, timeout: 30_000, maxRetries: 1 }) : null;

export function log(fn: string, fields: Record<string, unknown>) {
  // Ids, outcomes and timings only — never transcripts, numbers or secrets.
  console.log(JSON.stringify({ fn, ...fields }));
}

/** Claims pending analyses and completes each one (success, retry or permanent failure). */
export async function runPendingAnalyses(sb: SupabaseClient, limit = 5) {
  const { data, error } = await sb.rpc('voice_analysis_claim', { p_limit: limit });
  if (error) {
    log('voice-analysis', { outcome: 'error', stage: 'claim' });
    return 0;
  }
  const rows = (data ?? []) as { call_id: string; transcript: string; currency: string; country: string }[];
  for (const row of rows) {
    const started = Date.now();
    const meta: Record<string, string | number> = { model: MODEL, prompt_version: VOICE_PROMPT_VERSION };
    let ok = false;
    let result: unknown = null;
    if (!claude) {
      meta.outcome = 'not_configured';
    } else {
      try {
        const params = {
          model: MODEL,
          max_tokens: 4096,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'low', format: { type: 'json_schema', schema: ANALYSIS_JSON_SCHEMA } },
          system: VOICE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildAnalysisContent(row.transcript, { currency: row.currency, country: row.country }) }],
        };
        // deno-lint-ignore no-explicit-any
        const res = await claude.beta.messages.create(params as any);
        meta.model = res.model;
        meta.input_tokens = res.usage.input_tokens;
        meta.output_tokens = res.usage.output_tokens;
        if (res.stop_reason === 'refusal') meta.outcome = 'refused';
        else if (res.stop_reason === 'max_tokens') meta.outcome = 'truncated';
        else {
          const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
          let raw: unknown = null;
          try { raw = JSON.parse(text); } catch { /* invalid */ }
          const v = validateAnalysis(raw, row.transcript);
          if (v.ok) {
            ok = true;
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
    const { data: status, error: cErr } = await sb.rpc('voice_analysis_complete', { p_call: row.call_id, p_ok: ok, p_result: result, p_meta: meta });
    log('voice-analysis', { call: row.call_id, outcome: meta.outcome, result: cErr ? 'error' : status, ms: meta.latency_ms });
  }
  return rows.length;
}

/** Sends (or re-sends, with the same idempotency key) a reserved outbound call to Retell. */
export async function dispatchCall(sb: SupabaseClient, provider: RetellVoiceProvider, callId: string) {
  const { data, error } = await sb.rpc('voice_call_dispatch', { p_call: callId });
  if (error) return { status: 'error' as const };
  const d = data as { dispatch: boolean; status: string; idempotency_key?: string; from_number?: string; to_number?: string; agent_id?: string; dynamic_variables?: Record<string, string> };
  if (!d.dispatch) return { status: d.status };
  const res = await provider.createPhoneCall({
    fromNumber: d.from_number!, toNumber: d.to_number!, agentId: d.agent_id!, idempotencyKey: d.idempotency_key!,
    internalCallId: callId, dynamicVariables: d.dynamic_variables ?? {},
  });
  if (res.ok) {
    const { error: mErr } = await sb.rpc('voice_call_mark_initiated', { p_call: callId, p_provider_call_id: res.value.call_id, p_agent_id: res.value.agent_id ?? null });
    log('voice-dispatch', { call: callId, outcome: mErr ? 'accepted_unrecorded' : 'accepted' });
    return { status: 'dialing' as const };
  }
  await sb.rpc('voice_call_mark_failed', { p_call: callId, p_error: res.message, p_permanent: res.kind === 'permanent' });
  log('voice-dispatch', { call: callId, outcome: res.kind, http: res.status });
  return { status: res.kind === 'permanent' ? ('failed' as const) : ('pending_confirmation' as const), http: res.status };
}
