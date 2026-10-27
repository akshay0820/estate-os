// Claude call for free-text enquiries. Optional: without ANTHROPIC_API_KEY, or on any failure, intake
// continues with the structured fields only. Only the message text and org defaults are sent.
import Anthropic from '@anthropic-ai/sdk';
import { buildUserContent, EXTRACTION_JSON_SCHEMA, PROMPT_VERSION, SYSTEM_PROMPT, validateExtraction } from '../_shared/extraction.ts';

const MODEL = Deno.env.get('INTAKE_MODEL') ?? 'claude-opus-5-5';
const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
// 10 s per attempt, one retry (SDK retries 408/409/429/5xx and connection errors).
const client = apiKey ? new Anthropic({ apiKey, timeout: 10_000, maxRetries: 1 }) : null;

export type ExtractResult = {
  extraction: Record<string, unknown> | null;
  meta: Record<string, string | number>;
};

export async function extractRequirements(message: string, ctx: { currency: string; country: string }): Promise<ExtractResult> {
  const base = { model: MODEL, prompt_version: PROMPT_VERSION };
  if (!client) return { extraction: null, meta: { ...base, outcome: 'disabled' } };
  const started = Date.now();
  try {
    // Server-side fallback: if the model declines, the API re-runs the request on a fallback model in the same call.
    const params = {
      model: MODEL,
      max_tokens: 2048,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: EXTRACTION_JSON_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserContent(message, ctx) }],
    };
    // deno-lint-ignore no-explicit-any
    const response = await client.beta.messages.create(params as any);
    const meta = {
      ...base,
      model: response.model,
      latency_ms: Date.now() - started,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    };
    if (response.stop_reason === 'refusal') return { extraction: null, meta: { ...meta, outcome: 'refused' } };
    if (response.stop_reason === 'max_tokens') return { extraction: null, meta: { ...meta, outcome: 'truncated' } };
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { extraction: null, meta: { ...meta, outcome: 'invalid_output' } };
    }
    const v = validateExtraction(raw, message);
    if (!v.ok) return { extraction: null, meta: { ...meta, outcome: 'invalid_output' } };
    return { extraction: v.value, meta: { ...meta, outcome: v.dropped.length ? 'ok_partial' : 'ok' } };
  } catch (e) {
    const outcome = e instanceof Anthropic.APIConnectionTimeoutError ? 'timeout'
      : e instanceof Anthropic.RateLimitError ? 'rate_limited'
      : e instanceof Anthropic.APIError ? `api_error_${e.status ?? 'unknown'}`
      : 'error';
    return { extraction: null, meta: { ...base, latency_ms: Date.now() - started, outcome } };
  }
}
