import { describe, expect, it } from 'vitest';
import { beginAiRequest } from '../../supabase/functions/_shared/ai-guard';

type Call = { fn: string; args: Record<string, unknown> };
function fakeClient(begin: { data?: unknown; error?: { details?: string; message: string } | null }, finishThrows = false) {
  const calls: Call[] = [];
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'ai_request_begin') return { data: begin.data ?? null, error: begin.error ?? null };
      if (finishThrows) throw new Error('network');
      return { data: true, error: null };
    },
  };
}

describe('beginAiRequest', () => {
  it('returns the request and records the outcome once with its duration', async () => {
    const sb = fakeClient({ data: { request_id: 'r-1' } });
    let clock = 1000;
    const g = await beginAiRequest(sb as never, 'org-1', 'sales_analyst', () => clock);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(sb.calls[0]).toEqual({ fn: 'ai_request_begin', args: { p_org: 'org-1', p_feature: 'sales_analyst' } });
    clock = 1750;
    await g.finish('ok', 'claude-opus-5-5', { input_tokens: 1200, output_tokens: 300 });
    await g.finish('error');
    expect(sb.calls.slice(1)).toEqual([{ fn: 'ai_request_finish', args: { p_request: 'r-1', p_status: 'ok', p_duration_ms: 750, p_model: 'claude-opus-5-5', p_input_tokens: 1200, p_output_tokens: 300 } }]);
  });

  it.each([
    ['FORBIDDEN', 403, 'refused'],
    ['NOT_FOUND', 404, 'refused'],
    ['RATE_LIMITED', 429, 'rate_limited'],
    ['UNAUTHENTICATED', 401, 'refused'],
    ['VALIDATION_ERROR', 400, 'refused'],
    ['AGENT_PAUSED', 423, 'paused'],
  ])('maps %s to HTTP %i without calling anything else', async (code, http, status) => {
    const sb = fakeClient({ error: { details: code, message: 'nope' } });
    const g = await beginAiRequest(sb as never, 'org-1', 'crm_enrichment');
    expect(g).toEqual({ ok: false, status: http, body: { status, code, message: 'nope' } });
    expect(sb.calls).toHaveLength(1);
  });

  it('fails closed when the guard is unavailable (unknown error or missing id)', async () => {
    for (const begin of [{ error: { message: 'function public.ai_request_begin does not exist' } }, { data: {} }]) {
      const g = await beginAiRequest(fakeClient(begin) as never, 'org-1', 'appointment_assistant');
      expect(g.ok).toBe(false);
      if (!g.ok) {
        expect(g.status).toBe(503);
        expect(g.body.status).toBe('guard_unavailable');
        expect(g.body.message).toBeUndefined(); // internal error text is not passed to the browser
      }
    }
  });

  it('a failure to record the outcome does not throw', async () => {
    const g = await beginAiRequest(fakeClient({ data: { request_id: 'r-2' } }, true) as never, 'org-1', 'sales_recommendations');
    if (!g.ok) throw new Error('expected ok');
    await expect(g.finish('model_error')).resolves.toBeUndefined();
  });
});
