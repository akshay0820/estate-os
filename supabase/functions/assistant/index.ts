// POST /functions/v1/assistant — the in-app workspace assistant (JWT verified by the platform and used for every query).
// Body: { org_id, messages: [{ role: 'user' | 'assistant', text }] } (plain text turns; the last is the user's question).
// Claude answers with read tools that call SECURITY INVOKER RPCs as the caller (row-level security applies), and may
// propose changes with write tools; proposals are validated and returned as `actions` for the user to confirm in the app,
// never executed here. ai_request_begin checks membership, leads.view and the request limits before the model is called.
// Without ANTHROPIC_API_KEY: 503 not_configured.
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { beginAiRequest } from '../_shared/ai-guard.ts';
import {
  ASSISTANT_PROMPT_VERSION, ASSISTANT_TOOLS, MAX_TOOL_STEPS, isReadTool, isWriteTool, proposeAction, readCall, sanitizeHistory, systemPrompt, toolResultText,
  type ProposedAction,
} from '../_shared/assistant.ts';

const MODEL = Deno.env.get('ASSISTANT_MODEL') ?? 'claude-opus-5-5';
const key = Deno.env.get('ANTHROPIC_API_KEY');
const claude = key ? new Anthropic({ apiKey: key, timeout: 60_000, maxRetries: 1 }) : null;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const DEADLINE_MS = 100_000;
const MAX_ACTIONS = 5;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = req.headers.get('Authorization');
  if (!auth) return json(401, { error: 'unauthorized' });
  if (!claude) return json(503, { status: 'not_configured' });
  let body: { org_id?: string; messages?: unknown };
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const orgId = body.org_id ?? '';
  if (!/^[0-9a-f-]{36}$/.test(orgId)) return json(400, { error: 'invalid org_id' });
  const history = sanitizeHistory(body.messages);
  if (!history.length || history[history.length - 1].role !== 'user') return json(400, { error: 'messages must end with a user turn' });

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const guard = await beginAiRequest(sb, orgId, 'workspace_assistant');
  if (!guard.ok) return json(guard.status, guard.body);

  const { data: userData } = await sb.auth.getUser(auth.replace(/^Bearer\s+/i, ''));
  const userId = userData?.user?.id;
  const [{ data: org }, { data: membership }, { data: profile }] = await Promise.all([
    sb.from('organizations').select('name, timezone, default_currency').eq('id', orgId).maybeSingle(),
    sb.from('organization_memberships').select('role').eq('organization_id', orgId).eq('user_id', userId ?? '').maybeSingle(),
    sb.from('profiles').select('full_name').eq('id', userId ?? '').maybeSingle(),
  ]);
  if (!org || !membership) { await guard.finish('error'); return json(404, { error: 'not_found' }); }

  const now = new Date();
  const system = systemPrompt({
    orgName: org.name, userName: profile?.full_name || 'the user', role: membership.role, timezone: org.timezone, currency: org.default_currency,
    nowIso: now.toISOString(),
    localNow: new Intl.DateTimeFormat('en-US', { timeZone: org.timezone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(now),
  });
  const messages: Anthropic.MessageParam[] = history.map((t) => ({ role: t.role, content: t.text }));
  const actions: (ProposedAction & { id: string })[] = [];
  const toolsUsed: string[] = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let reply = '';
  let stop: string | null = null;
  const started = Date.now();

  try {
    for (let step = 0; step < MAX_TOOL_STEPS && Date.now() - started < DEADLINE_MS; step++) {
      const res = await claude.messages.create({
        model: MODEL, max_tokens: 4096, thinking: { type: 'adaptive', display: 'omitted' }, system,
        tools: ASSISTANT_TOOLS as unknown as Anthropic.Tool[], messages,
      });
      usage.input_tokens += res.usage?.input_tokens ?? 0;
      usage.output_tokens += res.usage?.output_tokens ?? 0;
      stop = res.stop_reason;
      reply = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
      if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || uses.length === 0) break;

      messages.push({ role: 'assistant', content: res.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        toolsUsed.push(use.name);
        if (isReadTool(use.name)) {
          const call = readCall(use.name, input, orgId);
          if (!call) { results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Invalid input: ids must come from earlier tool results.' }); continue; }
          const { data, error } = await sb.rpc(call.rpc, call.args);
          results.push(error
            ? { type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Lookup failed: ${error.message}` }
            : { type: 'tool_result', tool_use_id: use.id, content: toolResultText(data) });
        } else if (isWriteTool(use.name)) {
          const p = proposeAction(use.name, input);
          if (!p.ok) results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Not proposed: ${p.reason}` });
          else if (actions.length >= MAX_ACTIONS) results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Not proposed: at most ${MAX_ACTIONS} changes per answer.` });
          else {
            actions.push({ ...p.action, id: use.id });
            results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Shown to the user as a confirmation card. It has NOT been carried out; it happens only if the user confirms.' });
          }
        } else {
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown tool ${use.name}.` });
        }
      }
      messages.push({ role: 'user', content: results });
      reply = '';
    }
  } catch (e) {
    const timeout = e instanceof Anthropic.APIConnectionTimeoutError;
    await guard.finish(timeout ? 'timeout' : 'model_error', MODEL, usage);
    return json(502, { status: timeout ? 'timeout' : 'model_error' });
  }

  if (stop === 'refusal') reply = 'I can’t help with that request.';
  if (!reply) reply = actions.length ? 'I’ve prepared the changes below. Nothing happens until you confirm.' : 'I couldn’t finish that one. Try asking a narrower question.';
  await guard.finish(actions.length || reply ? 'ok' : 'no_result', MODEL, usage);
  return json(200, { status: 'ok', reply, actions, tools_used: toolsUsed, prompt_version: ASSISTANT_PROMPT_VERSION });
});
