// Guard for Claude calls made on a user's request (PRA-029 / PRA-030). Called with the caller's client before the model:
// public.ai_request_begin checks the organization membership and the feature permission, applies the per-user and
// per-organization limits and records the request; finish() records the outcome. If the guard itself fails (for example
// the migration is not applied) the request is refused: the model is never called without a recorded, authorized request.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';

export type AiFeature = 'appointment_assistant' | 'crm_enrichment' | 'sales_recommendations' | 'sales_analyst' | 'workspace_assistant';
export type AiOutcome = 'ok' | 'no_result' | 'invalid_output' | 'model_error' | 'timeout' | 'refused' | 'error';

type RpcClient = Pick<SupabaseClient, 'rpc'>;

export type AiGuard =
  | { ok: true; requestId: string; finish: (status: AiOutcome, model?: string, usage?: { input_tokens?: number; output_tokens?: number }) => Promise<void> }
  | { ok: false; status: number; body: { status: string; code?: string; message?: string } };

const HTTP: Record<string, number> = { UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, RATE_LIMITED: 429, VALIDATION_ERROR: 400, AGENT_PAUSED: 423 };

export async function beginAiRequest(sb: RpcClient, orgId: string, feature: AiFeature, now: () => number = Date.now): Promise<AiGuard> {
  const started = now();
  const { data, error } = await sb.rpc('ai_request_begin', { p_org: orgId, p_feature: feature });
  if (error || !data?.request_id) {
    const code = (error?.details as string | undefined) ?? undefined;
    const status = (code && HTTP[code]) || 503;
    return { ok: false, status, body: { status: status === 429 ? 'rate_limited' : status === 423 ? 'paused' : status === 503 ? 'guard_unavailable' : 'refused', code, message: status === 503 ? undefined : error?.message } };
  }
  const requestId = data.request_id as string;
  let finished = false;
  return {
    ok: true,
    requestId,
    async finish(status: AiOutcome, model?: string, usage?: { input_tokens?: number; output_tokens?: number }) {
      if (finished) return;
      finished = true;
      // Recording the outcome must never turn a delivered answer into an error.
      try { await sb.rpc('ai_request_finish', { p_request: requestId, p_status: status, p_duration_ms: Math.max(0, Math.round(now() - started)), p_model: model ?? null,
        p_input_tokens: usage?.input_tokens ?? null, p_output_tokens: usage?.output_tokens ?? null }); } catch { /* best effort */ }
    },
  };
}
