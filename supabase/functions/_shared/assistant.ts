// Workspace assistant: tool catalogue, system prompt and validation, shared by the `assistant` Edge Function and tests.
// Read tools run as the caller through SECURITY INVOKER RPCs (migration 0028), so row-level security decides what the
// assistant sees. Write tools are never executed here: a valid call becomes a proposed action that the app shows as a
// card, and only the user's Confirm runs it through the app's existing permissioned actions.

export const ASSISTANT_PROMPT_VERSION = 'assistant-v1';
export const MAX_TOOL_STEPS = 6;
export const MAX_HISTORY_TURNS = 12;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_TOOL_RESULT_CHARS = 12000;

type Schema = Record<string, unknown>;
export interface ToolDef { name: string; description: string; input_schema: Schema }

const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const uuid = (description: string): Schema => ({ type: 'string', description });
const iso = (description: string): Schema => ({ type: 'string', description: `${description} ISO 8601 with time zone offset, e.g. 2026-11-03T15:00:00-06:00.` });
const summary: Schema = { type: 'string', description: 'One short sentence the user sees on the confirmation card, e.g. "Call Emma Carter about the Zilker condos on Tuesday at 3 pm".' };

export const LEAD_STATUSES = ['new', 'attempting', 'contacted', 'qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won', 'lost', 'nurture'] as const;
export const DEAL_STAGES = ['qualification', 'viewing', 'offer', 'negotiation', 'under_contract', 'won', 'lost'] as const;
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const FOLLOW_UP_PURPOSES = ['clarify_requirements', 'share_property_recommendations', 're_engagement'] as const;
export const AUTOMATION_KINDS = ['daily_briefing', 'overdue_follow_ups', 'call_new_leads', 'reengage_stale'] as const;

export const READ_TOOLS: ToolDef[] = [
  { name: 'workspace_overview', description: 'Numbers for the workspace over a period: open/new/qualified/won/lost leads, overdue follow-ups, uncontacted and unassigned leads, leads by status and by source (with qualified and won counts), open and overdue tasks (team and mine), appointments in the next 7 days, and deals (open value, won value, by stage). Use it for any "how are we doing", performance, pipeline or insight question.',
    input_schema: obj({ period_days: { type: 'integer', minimum: 1, maximum: 365, description: 'Look-back period in days (default 30).' } }) },
  { name: 'search_leads', description: 'Find leads. Filters combine; without a status, won and lost leads are excluded unless a text query is given. Returns id, name, status, score (0-100), source, budget, locations, owner, next follow-up and contact details. Use it to resolve a lead the user names before acting on it.',
    input_schema: obj({
      query: { type: 'string', description: 'Name, email, phone digits, locality or source.' },
      status: { type: 'string', enum: [...LEAD_STATUSES] },
      source: { type: 'string', description: 'Exact source name, e.g. Zillow.' },
      assigned_to_me: { type: 'boolean' },
      hot: { type: 'boolean', description: 'Score 70 or more.' },
      follow_up_overdue: { type: 'boolean' },
      uncontacted: { type: 'boolean', description: 'No first response yet.' },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
    }) },
  { name: 'get_lead', description: 'One lead in full: requirements, score reasons, owner, follow-up dates, contact, the 10 most recent activities, open tasks and upcoming appointments.',
    input_schema: obj({ lead_id: uuid('Lead id from search_leads.') }, ['lead_id']) },
  { name: 'list_tasks', description: 'Open tasks. scope "mine" (default) or "team"; when "open" (default), "overdue", "today" or "upcoming".',
    input_schema: obj({ scope: { type: 'string', enum: ['mine', 'team'] }, when: { type: 'string', enum: ['open', 'overdue', 'today', 'upcoming'] }, limit: { type: 'integer', minimum: 1, maximum: 30 } }) },
  { name: 'list_appointments', description: 'Appointments (showings, consultations, valuations) between from_days and to_days from now; negative numbers look back. Optionally only mine.',
    input_schema: obj({ from_days: { type: 'integer', minimum: -90, maximum: 90 }, to_days: { type: 'integer', minimum: -90, maximum: 90 }, mine: { type: 'boolean' } }) },
  { name: 'search_properties', description: 'Listings (active by default) by text, locality, sale or rent, maximum price and minimum bedrooms. Only verified listings may be presented to a customer as available.',
    input_schema: obj({
      query: { type: 'string' }, locality: { type: 'string' }, listing: { type: 'string', enum: ['sale', 'rent'] },
      max_price: { type: 'number' }, min_bedrooms: { type: 'integer', minimum: 0, maximum: 10 },
      status: { type: 'string', enum: ['active', 'under_offer', 'reserved', 'sold', 'let', 'draft', 'any'] }, limit: { type: 'integer', minimum: 1, maximum: 25 },
    }) },
  { name: 'list_deals', description: 'Deals by stage: "open" (default, every stage except won and lost), "all", or one stage.',
    input_schema: obj({ stage: { type: 'string', enum: ['open', 'all', ...DEAL_STAGES] } }) },
  { name: 'list_team', description: 'Active team members with id, name, role, title and the localities they cover; is_me marks the user. Use it to resolve a person before assigning work.',
    input_schema: obj({}) },
  { name: 'call_readiness', description: 'Whether an AI call to a lead would be allowed right now, with every policy check: AI calling configured, kill switch, lead open, valid phone, not on do-not-contact, AI-call consent, calling hours, attempt limits, daily cap. Check this before proposing call_lead and explain any failed check.',
    input_schema: obj({ lead_id: uuid('Lead id from search_leads.') }, ['lead_id']) },
  { name: 'list_automations', description: 'Scheduled automations (name, type, time, days, enabled, next and last run with results) and how many AI calls are waiting for approval.',
    input_schema: obj({}) },
];

export const WRITE_TOOLS: ToolDef[] = [
  { name: 'create_task', description: 'Propose a task. The user confirms it on a card before it is created.',
    input_schema: obj({
      summary, title: { type: 'string', description: 'Imperative, under 120 characters.' }, due_at: iso('When it is due.'),
      lead_id: uuid('Related lead id, if any.'), assignee_id: uuid('Team member id from list_team; omit for the user themselves.'),
      priority: { type: 'string', enum: [...TASK_PRIORITIES] },
    }, ['summary', 'title', 'due_at']) },
  { name: 'complete_task', description: 'Propose marking a task done.', input_schema: obj({ summary, task_id: uuid('Task id.') }, ['summary', 'task_id']) },
  { name: 'schedule_follow_up', description: "Propose setting a lead's next follow-up time (it appears on the lead and in overdue lists).",
    input_schema: obj({ summary, lead_id: uuid('Lead id.'), at: iso('Follow-up time.') }, ['summary', 'lead_id', 'at']) },
  { name: 'update_lead_status', description: "Propose moving a lead to a new status. Lost needs a reason.",
    input_schema: obj({ summary, lead_id: uuid('Lead id.'), status: { type: 'string', enum: [...LEAD_STATUSES] }, lost_reason: { type: 'string' } }, ['summary', 'lead_id', 'status']) },
  { name: 'assign_lead', description: 'Propose assigning a lead to a team member.',
    input_schema: obj({ summary, lead_id: uuid('Lead id.'), member_id: uuid('Team member id from list_team.') }, ['summary', 'lead_id', 'member_id']) },
  { name: 'add_note', description: "Propose adding an internal note to a lead's timeline.",
    input_schema: obj({ summary, lead_id: uuid('Lead id.'), body: { type: 'string', description: 'The note, under 2000 characters.' } }, ['summary', 'lead_id', 'body']) },
  { name: 'book_showing', description: 'Propose booking a showing (viewing) for a lead. Availability and conflicts are checked when the user confirms.',
    input_schema: obj({
      summary, lead_id: uuid('Lead id.'), start: iso('Start time.'), duration_minutes: { type: 'integer', minimum: 15, maximum: 240 },
      property_id: uuid('Listing id from search_properties, if known.'), assignee_id: uuid('Team member id; omit for the lead owner.'),
    }, ['summary', 'lead_id', 'start']) },
  { name: 'move_deal', description: 'Propose moving a deal to another stage. Lost needs a reason.',
    input_schema: obj({ summary, deal_id: uuid('Deal id.'), stage: { type: 'string', enum: [...DEAL_STAGES] }, lost_reason: { type: 'string' } }, ['summary', 'deal_id', 'stage']) },
  { name: 'call_lead', description: 'Propose an AI phone call to a lead (Retell voice agent). Placed only when the user confirms, and only if the call policy allows it at that moment (consent, calling hours, limits, kill switch).',
    input_schema: obj({ summary, lead_id: uuid('Lead id.'), reason: { type: 'string', description: 'Why call now, in a few words.' } }, ['summary', 'lead_id']) },
  { name: 'request_follow_up', description: 'Propose asking the Follow-Up Agent to draft the next message to a lead. The draft waits in the approval queue; a person reviews and sends it.',
    input_schema: obj({ summary, lead_id: uuid('Lead id.'), purpose: { type: 'string', enum: [...FOLLOW_UP_PURPOSES] } }, ['summary', 'lead_id', 'purpose']) },
  { name: 'create_automation', description: 'Propose a scheduled automation that runs on its own at a local time on chosen weekdays (0 = Sunday). Types: daily_briefing (summary notification; settings.audience "managers" or "everyone"), overdue_follow_ups (follow-up tasks for overdue leads; settings.draft_messages true also drafts messages for approval), call_new_leads (queues AI calls for new uncontacted leads with AI-call consent; settings.within_hours, settings.max), reengage_stale (re-engagement drafts for leads untouched settings.stale_days). Automations prepare work only; calls and messages always need approval. Only owners and admins can create them.',
    input_schema: obj({
      summary, name: { type: 'string', description: 'Short name, e.g. "Morning briefing".' }, kind: { type: 'string', enum: [...AUTOMATION_KINDS] },
      run_at: { type: 'string', description: 'Local time HH:MM, 24-hour.' }, days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: '0 = Sunday ... 6 = Saturday.' },
      settings: { type: 'object', description: 'Optional settings for the type.' },
    }, ['summary', 'name', 'kind', 'run_at', 'days']) },
];

export const ASSISTANT_TOOLS: ToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS];
const READ_NAMES = new Set(READ_TOOLS.map((t) => t.name));
const WRITE_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));
export const isReadTool = (name: string) => READ_NAMES.has(name);
export const isWriteTool = (name: string) => WRITE_NAMES.has(name);

export interface AssistantContext { orgName: string; userName: string; role: string; timezone: string; currency: string; nowIso: string; localNow: string }

export function systemPrompt(c: AssistantContext): string {
  return `You are the Estate OS assistant for ${c.orgName}, a real-estate agency. You help ${c.userName} (role: ${c.role}) with their CRM: answering questions about leads, contacts, listings, showings, tasks, deals and performance, and preparing work for them.

Now: ${c.localNow} (${c.timezone}); UTC ${c.nowIso}. Money is in ${c.currency}. Resolve relative dates ("tomorrow at 3", "next Friday") in ${c.timezone} and pass times with that offset.

How to work:
- Answer only from tool results. Never invent leads, numbers, listings, prices or availability. If a tool returns nothing, say so plainly.
- Look things up before acting: resolve a lead with search_leads and a person with list_team, then use their ids. If several leads match, ask which one.
- Changes are never made directly. Every write tool (create_task, complete_task, schedule_follow_up, update_lead_status, assign_lead, add_note, book_showing, move_deal, call_lead, request_follow_up, create_automation) only proposes the change; the user confirms each one on a card. Say what you proposed and that it is waiting for their confirmation; never claim it is done.
- Calls: before proposing call_lead, run call_readiness. If a check fails (no AI-call consent, outside calling hours, limits, AI calling not set up), say which and do not propose the call; offer a follow-up task instead. Never suggest calling someone without consent.
- Messages: you cannot send emails or texts yourself. request_follow_up asks the Follow-Up Agent for a draft that a person approves and sends. You cannot change settings, permissions or billing.
- Automations run on a schedule and only prepare work (briefings, tasks, drafts, queued calls); calls and messages always wait for a person's approval. Say so when proposing one.
- Only verified listings may be described to a customer as available. Do not give legal, tax, lending or appraisal advice, and never suggest steering or treating anyone differently based on race, religion, sex, disability, familial status or national origin.
- The data you see is limited to what ${c.userName}'s role allows.

Style: concise and specific. Lead with the answer, then the few details that matter. Use short bullet lists for several items, names rather than ids, money in ${c.currency} with thousands separators, dates like "Tue Nov 3, 3:00 pm". No preamble.`;
}

/** The read tool's RPC and arguments; inputs are clamped again in SQL. */
export function readCall(name: string, input: Record<string, unknown>, orgId: string): { rpc: string; args: Record<string, unknown> } | null {
  const filters = (keys: string[]) => Object.fromEntries(keys.filter((k) => input[k] !== undefined && input[k] !== null && input[k] !== '').map((k) => [k, input[k]]));
  switch (name) {
    case 'workspace_overview': return { rpc: 'assistant_overview', args: { p_org: orgId, p_days: clampInt(input.period_days, 1, 365, 30) } };
    case 'search_leads': return { rpc: 'assistant_search_leads', args: { p_org: orgId, p_filters: filters(['query', 'status', 'source', 'assigned_to_me', 'hot', 'follow_up_overdue', 'uncontacted', 'limit']) } };
    case 'get_lead': return isUuid(input.lead_id) ? { rpc: 'assistant_lead', args: { p_org: orgId, p_lead: input.lead_id } } : null;
    case 'list_tasks': return { rpc: 'assistant_tasks', args: { p_org: orgId, p_filters: filters(['scope', 'when', 'limit']) } };
    case 'list_appointments': return { rpc: 'assistant_appointments', args: { p_org: orgId, p_from_days: clampInt(input.from_days, -90, 90, 0), p_to_days: clampInt(input.to_days, -90, 90, 7), p_mine: input.mine === true } };
    case 'search_properties': return { rpc: 'assistant_properties', args: { p_org: orgId, p_filters: filters(['query', 'locality', 'listing', 'max_price', 'min_bedrooms', 'status', 'limit']) } };
    case 'list_deals': return { rpc: 'assistant_deals', args: { p_org: orgId, p_stage: typeof input.stage === 'string' ? input.stage : 'open' } };
    case 'list_team': return { rpc: 'assistant_team', args: { p_org: orgId } };
    case 'call_readiness': return isUuid(input.lead_id) ? { rpc: 'voice_call_preflight', args: { p_lead: input.lead_id } } : null;
    case 'list_automations': return { rpc: 'assistant_automations', args: { p_org: orgId } };
    default: return null;
  }
}

export type ProposedAction =
  | { kind: 'create_task'; summary: string; title: string; dueAt: string; leadId: string | null; assigneeId: string | null; priority: (typeof TASK_PRIORITIES)[number] }
  | { kind: 'complete_task'; summary: string; taskId: string }
  | { kind: 'schedule_follow_up'; summary: string; leadId: string; at: string }
  | { kind: 'update_lead_status'; summary: string; leadId: string; status: (typeof LEAD_STATUSES)[number]; lostReason: string | null }
  | { kind: 'assign_lead'; summary: string; leadId: string; memberId: string }
  | { kind: 'add_note'; summary: string; leadId: string; body: string }
  | { kind: 'book_showing'; summary: string; leadId: string; start: string; durationMinutes: number; propertyId: string | null; assigneeId: string | null }
  | { kind: 'move_deal'; summary: string; dealId: string; stage: (typeof DEAL_STAGES)[number]; lostReason: string | null }
  | { kind: 'call_lead'; summary: string; leadId: string; reason: string | null }
  | { kind: 'request_follow_up'; summary: string; leadId: string; purpose: (typeof FOLLOW_UP_PURPOSES)[number] }
  | { kind: 'create_automation'; summary: string; name: string; automationKind: (typeof AUTOMATION_KINDS)[number]; runAt: string; days: number[]; settings: Record<string, unknown> };

type Check = { ok: true; action: ProposedAction } | { ok: false; reason: string };

/** Validates a write tool call into a proposed action. `now` bounds dates: up to a day back, at most a year ahead. */
export function proposeAction(name: string, input: Record<string, unknown>, now = Date.now()): Check {
  const s = text(input.summary, 200);
  if (!s) return bad('summary is required (one short sentence)');
  const date = (v: unknown, field: string) => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return { err: `${field} must be an ISO date-time` };
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) return { err: `${field} is not a valid date` };
    if (ms < now - 864e5) return { err: `${field} is in the past` };
    if (ms > now + 366 * 864e5) return { err: `${field} is more than a year ahead` };
    return { iso: new Date(ms).toISOString() };
  };
  const optUuid = (v: unknown, field: string) => (v == null || v === '' ? { id: null } : isUuid(v) ? { id: v as string } : { err: `${field} must be an id from a tool result` });
  switch (name) {
    case 'create_task': {
      const title = text(input.title, 160);
      if (!title || title.length < 3) return bad('title is required');
      const d = date(input.due_at, 'due_at'); if ('err' in d) return bad(d.err!);
      const lead = optUuid(input.lead_id, 'lead_id'); if ('err' in lead) return bad(lead.err!);
      const who = optUuid(input.assignee_id, 'assignee_id'); if ('err' in who) return bad(who.err!);
      const priority = (TASK_PRIORITIES as readonly string[]).includes(String(input.priority)) ? (input.priority as (typeof TASK_PRIORITIES)[number]) : 'normal';
      return { ok: true, action: { kind: 'create_task', summary: s, title, dueAt: d.iso!, leadId: lead.id, assigneeId: who.id, priority } };
    }
    case 'complete_task':
      return isUuid(input.task_id) ? { ok: true, action: { kind: 'complete_task', summary: s, taskId: input.task_id as string } } : bad('task_id must be an id from a tool result');
    case 'schedule_follow_up': {
      if (!isUuid(input.lead_id)) return bad('lead_id must be an id from a tool result');
      const d = date(input.at, 'at'); if ('err' in d) return bad(d.err!);
      return { ok: true, action: { kind: 'schedule_follow_up', summary: s, leadId: input.lead_id as string, at: d.iso! } };
    }
    case 'update_lead_status': {
      if (!isUuid(input.lead_id)) return bad('lead_id must be an id from a tool result');
      if (!(LEAD_STATUSES as readonly string[]).includes(String(input.status))) return bad('status is not a lead status');
      const reason = text(input.lost_reason, 200);
      if (input.status === 'lost' && !reason) return bad('lost_reason is required when the status is lost');
      return { ok: true, action: { kind: 'update_lead_status', summary: s, leadId: input.lead_id as string, status: input.status as (typeof LEAD_STATUSES)[number], lostReason: reason || null } };
    }
    case 'assign_lead':
      if (!isUuid(input.lead_id) || !isUuid(input.member_id)) return bad('lead_id and member_id must be ids from tool results');
      return { ok: true, action: { kind: 'assign_lead', summary: s, leadId: input.lead_id as string, memberId: input.member_id as string } };
    case 'add_note': {
      if (!isUuid(input.lead_id)) return bad('lead_id must be an id from a tool result');
      const body = text(input.body, 2000);
      if (!body) return bad('body is required');
      return { ok: true, action: { kind: 'add_note', summary: s, leadId: input.lead_id as string, body } };
    }
    case 'book_showing': {
      if (!isUuid(input.lead_id)) return bad('lead_id must be an id from a tool result');
      const d = date(input.start, 'start'); if ('err' in d) return bad(d.err!);
      if (Date.parse(d.iso!) < now) return bad('start is in the past');
      const prop = optUuid(input.property_id, 'property_id'); if ('err' in prop) return bad(prop.err!);
      const who = optUuid(input.assignee_id, 'assignee_id'); if ('err' in who) return bad(who.err!);
      return { ok: true, action: { kind: 'book_showing', summary: s, leadId: input.lead_id as string, start: d.iso!, durationMinutes: clampInt(input.duration_minutes, 15, 240, 45), propertyId: prop.id, assigneeId: who.id } };
    }
    case 'move_deal': {
      if (!isUuid(input.deal_id)) return bad('deal_id must be an id from a tool result');
      if (!(DEAL_STAGES as readonly string[]).includes(String(input.stage))) return bad('stage is not a deal stage');
      const reason = text(input.lost_reason, 200);
      if (input.stage === 'lost' && !reason) return bad('lost_reason is required when the stage is lost');
      return { ok: true, action: { kind: 'move_deal', summary: s, dealId: input.deal_id as string, stage: input.stage as (typeof DEAL_STAGES)[number], lostReason: reason || null } };
    }
    case 'call_lead':
      if (!isUuid(input.lead_id)) return bad('lead_id must be an id from a tool result');
      return { ok: true, action: { kind: 'call_lead', summary: s, leadId: input.lead_id as string, reason: text(input.reason, 200) || null } };
    case 'request_follow_up':
      if (!isUuid(input.lead_id)) return bad('lead_id must be an id from a tool result');
      if (!(FOLLOW_UP_PURPOSES as readonly string[]).includes(String(input.purpose))) return bad('purpose is not a follow-up purpose');
      return { ok: true, action: { kind: 'request_follow_up', summary: s, leadId: input.lead_id as string, purpose: input.purpose as (typeof FOLLOW_UP_PURPOSES)[number] } };
    case 'create_automation': {
      const nm = text(input.name, 80);
      if (!nm) return bad('name is required');
      if (!(AUTOMATION_KINDS as readonly string[]).includes(String(input.kind))) return bad('kind is not an automation type');
      if (typeof input.run_at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.run_at)) return bad('run_at must be HH:MM (24-hour)');
      const days = Array.isArray(input.days) ? [...new Set(input.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
      if (!days.length) return bad('days must list at least one weekday (0 = Sunday)');
      const settings = input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings) ? (input.settings as Record<string, unknown>) : {};
      return { ok: true, action: { kind: 'create_automation', summary: s, name: nm, automationKind: input.kind as (typeof AUTOMATION_KINDS)[number], runAt: input.run_at, days, settings } };
    }
    default:
      return bad(`unknown tool ${name}`);
  }
}

export interface ChatTurn { role: 'user' | 'assistant'; text: string }

/** Keeps the last turns as plain text, alternating and starting with the user, within size limits. */
export function sanitizeHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns = raw
    .filter((m): m is { role: string; text: string } => !!m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .map((m) => ({ role: m.role as ChatTurn['role'], text: m.text.trim().slice(0, MAX_MESSAGE_CHARS) }))
    .filter((m) => m.text);
  const merged: ChatTurn[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.text = `${last.text}\n\n${t.text}`.slice(0, MAX_MESSAGE_CHARS);
    else merged.push({ ...t });
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged.slice(-MAX_HISTORY_TURNS).filter((_, i, a) => i > 0 || a[0].role === 'user');
}

/** Tool output for the model: compact JSON, truncated so one large result cannot crowd out the conversation. */
export function toolResultText(data: unknown): string {
  const s = JSON.stringify(data ?? null);
  return s.length > MAX_TOOL_RESULT_CHARS ? `${s.slice(0, MAX_TOOL_RESULT_CHARS)}… [truncated: ask for fewer results or narrower filters]` : s;
}

const bad = (reason: string): Check => ({ ok: false, reason });
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const isUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function clampInt(v: unknown, min: number, max: number, dflt: number) {
  const n = typeof v === 'number' ? Math.round(v) : typeof v === 'string' && v.trim() ? Math.round(Number(v)) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
