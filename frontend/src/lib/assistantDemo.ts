// The demo assistant: answers from the sample data with simple language rules, so the assistant can be shown without a
// backend or an AI key. It covers the common questions and requests and proposes the same confirmable actions as the
// live assistant. Pure: everything comes from the snapshot and `now`.
import { money, fmtDateTime, relTime } from '@/lib/format';
import { OPEN_LEAD, outboundPolicy } from '@/lib/domain';
import type { Lead, LeadStatus, Member } from '@/store/types';
import type { AssistantAction, AssistantAnswer, Snapshot } from './assistant';
import { AUTOMATION_LABEL, daysLabel } from './automationRules';

const DAY = 864e5;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const STATUS_WORDS: [RegExp, LeadStatus][] = [
  [/\bqualified\b/, 'qualified'], [/\bcontacted\b/, 'contacted'], [/\bnurture\b/, 'nurture'], [/\bnegotiation\b/, 'negotiation'],
  [/\bwon\b/, 'won'], [/\blost\b/, 'lost'], [/\bmatching\b/, 'matching'], [/\battempting\b/, 'attempting'],
];

const isOpen = (l: Lead) => (OPEN_LEAD as readonly string[]).includes(l.status);
const bullet = (lines: string[]) => lines.map((l) => `- ${l}`).join('\n');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
let seq = 0;
const actionId = () => `demo-action-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Finds the lead the text names: a full name first, then a unique first name. */
export function findLead(text: string, leads: Lead[]): { lead?: Lead; ambiguous?: Lead[] } {
  const t = text.toLowerCase();
  const full = leads.filter((l) => l.name && t.includes(l.name.toLowerCase())).sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.createdAt - a.createdAt);
  if (full.length) return { lead: full[0] };
  const firsts = leads.filter((l) => isOpen(l) && new RegExp(`\\b${escape(l.name.split(' ')[0].toLowerCase())}\\b`).test(t));
  const names = new Set(firsts.map((l) => l.name));
  if (names.size === 1) return { lead: firsts[0] };
  return names.size > 1 ? { ambiguous: [...new Map(firsts.map((l) => [l.name, l])).values()].slice(0, 5) } : {};
}

export function findMember(text: string, members: Member[], exclude?: string): Member | undefined {
  const t = text.toLowerCase();
  const active = members.filter((m) => m.status === 'active' && m.name.toLowerCase() !== exclude?.toLowerCase());
  return active.find((m) => t.includes(m.name.toLowerCase())) ?? active.find((m) => new RegExp(`\\bto ${escape(m.name.split(' ')[0].toLowerCase())}\\b`).test(t));
}

/** "tomorrow at 3pm", "friday", "in 2 days", "next week"; defaults to tomorrow 10:00. Never in the past. */
export function parseWhen(text: string, now: number): number {
  const t = text.toLowerCase();
  const d = new Date(now);
  let dayOffset: number | null = null;
  const inDays = t.match(/\bin (\d{1,2}) days?\b/);
  const inHours = t.match(/\bin (\d{1,2}) hours?\b/);
  if (inHours) return now + Number(inHours[1]) * 36e5;
  if (/\bday after tomorrow\b/.test(t)) dayOffset = 2;
  else if (/\btomorrow\b/.test(t)) dayOffset = 1;
  else if (/\b(today|tonight|this (afternoon|evening|morning))\b/.test(t)) dayOffset = 0;
  else if (inDays) dayOffset = Number(inDays[1]);
  else if (/\bnext week\b/.test(t)) dayOffset = ((8 - d.getDay()) % 7) || 7;
  else {
    const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
    if (wd >= 0) dayOffset = ((wd - d.getDay() + 7) % 7) || 7;
  }
  const tm = t.match(/\b(?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? t.match(/\bat (\d{1,2})(?::(\d{2}))?\b/);
  let hour = /tonight|this evening/.test(t) ? 18 : /this afternoon/.test(t) ? 15 : 10;
  let minute = 0;
  if (tm) {
    hour = Number(tm[1]) % 12 + (tm[3] === 'pm' || (!tm[3] && Number(tm[1]) < 8) ? 12 : 0);
    if (tm[3] === 'am' && Number(tm[1]) === 12) hour = 0;
    minute = Number(tm[2] ?? 0);
  }
  const out = new Date(now);
  out.setDate(out.getDate() + (dayOffset ?? 1));
  out.setHours(hour, minute, 0, 0);
  return out.getTime() <= now ? out.getTime() + DAY : out.getTime();
}

/** The task title from "create a task to call Emma tomorrow at 3pm" → "Call Emma". */
function taskTitle(text: string) {
  const m = text.match(/\b(?:task|remind me|reminder)\b(?:\s+(?:for me|for \w+))?\s*(?:to|:)\s*(.+)$/i) ?? text.match(/\bto\s+(.+)$/i);
  const raw = (m?.[1] ?? text)
    .replace(/\b(today|tonight|tomorrow|day after tomorrow|next week|this (morning|afternoon|evening)|in \d+ (days?|hours?)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi, '')
    .replace(/\b(at )?\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, '')
    .replace(/\b(please|asap)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,.;]+$/, '')
    .trim();
  return raw ? raw[0].toUpperCase() + raw.slice(1, 120) : 'Follow up';
}

export function demoReply(question: string, s: Snapshot, now: number): AssistantAnswer {
  const q = question.trim();
  const t = q.toLowerCase();
  if (!q) return help();
  const open = s.leads.filter(isOpen);
  const found = findLead(q, s.leads);
  const lead = found.lead;
  const ambiguity = () => ({ reply: `Which lead do you mean?\n${bullet((found.ambiguous ?? []).map((l) => `**${l.name}** · ${l.status.replace(/_/g, ' ')} · ${l.source}`))}`, actions: [] });
  const needLead = (what: string) => (found.ambiguous ? ambiguity() : { reply: `Which lead should I ${what}? Give me their name, for example “${open[0]?.name ?? 'Emma Carter'}”.`, actions: [] });
  const propose = (a: AssistantAction, intro: string): AssistantAnswer => ({ reply: `${intro}\n\nConfirm below and I’ll do it. Nothing changes until you do.`, actions: [a] });

  // ── Requests that change something: proposed, never applied directly ──
  // Schedules: "every weekday at 8:30 send me a briefing", "set up a daily overdue sweep at 9".
  const autoKind = automationKind(t);
  if (autoKind && /\b(every|each|daily|weekdays?|weekends?|automation|automate|schedule|set up|recurring)\b/.test(t)) {
    const runAt = timeOf(t) ?? (autoKind === 'daily_briefing' ? '08:30' : '09:00');
    const days = daysOf(t);
    const name = AUTOMATION_LABEL[autoKind].replace(' (approval queue)', '');
    const settings = autoKind === 'overdue_follow_ups' && /\b(drafts?|messages?|texts?)\b/.test(t) ? { draft_messages: true } : {};
    return propose({ id: actionId(), kind: 'create_automation', summary: `${name}: ${daysLabel(days)} at ${runAt}`, name, automationKind: autoKind, runAt, days, settings },
      `I’ll schedule **${name}** for ${daysLabel(days).toLowerCase()} at ${runAt}. It prepares work on its own; calls and messages still wait for approval.`);
  }
  if (/\b(automations?|schedules?|what runs|scheduled)\b/.test(t) && !/\b(task|showing)\b/.test(t)) {
    const list = s.automations;
    const waiting = s.callsWaiting;
    return { reply: list.length ? `${plural(list.length, 'automation')}${waiting ? `, ${waiting} AI calls waiting for approval` : ''}:\n${bullet(list.map((a) => `**${a.name}** · ${daysLabel(a.days)} at ${a.run_at.slice(0, 5)}${a.enabled ? '' : ' · paused'}`))}\n\nManage them on the Automations page.` : 'No automations yet. Try “every weekday at 8:30 send me a briefing”.', actions: [] };
  }
  // Drafted messages: the Follow-Up Agent writes, a person approves and sends.
  if (/\b(draft|write|prepare|compose|send)\b.*\b(message|text|email|sms|follow[- ]?up|note to)\b/.test(t) && !/\badd\b.*\bnote\b/.test(t)) {
    if (!lead) return needLead('draft a message for');
    const purpose = /\b(re-?engage|check in|haven.?t heard|gone quiet|cold|stale)\b/.test(t) ? 're_engagement' : /\b(listings?|propert|homes?|match)/.test(t) ? 'share_property_recommendations' : 'clarify_requirements';
    return propose({ id: actionId(), kind: 'request_follow_up', summary: `Draft a follow-up to ${lead.name}`, leadId: lead.id, purpose },
      `I’ll have the Follow-Up Agent draft a message to **${lead.name}**. It lands in Approvals, and nothing is sent until someone approves it.`);
  }
  // AI calls: run the call policy first and only propose a call it would allow.
  if (/\b(call|ring|phone|dial)\b/.test(t) && !/\b(task|remind|follow[- ]?up|calls? (today|this week)|calendar)\b/.test(t)) {
    if (!lead) return needLead('call');
    const contact = s.contacts.find((c) => c.id === lead.contactId);
    const policy = outboundPolicy(s.org, contact, 'phone', { purpose: 'ai_call', byAi: true, at: now });
    const failed = policy.checks.filter((c) => !c.ok);
    if (failed.length) {
      return { reply: `I can’t call **${lead.name}** right now:\n${bullet(failed.map((c) => `${c.label}: ${c.detail ?? 'not met'}`))}\n\nI can create a follow-up task or draft a message for approval instead.`, actions: [] };
    }
    return propose({ id: actionId(), kind: 'call_lead', summary: `AI call to ${lead.name}`, leadId: lead.id, reason: lead.firstResponseAt ? 'Follow-up call' : 'First contact' },
      `**${lead.name}** passes the call checks (consent, calling hours, not suppressed). I’ll have the AI voice agent call them.`);
  }
  if (/\b(send|text|email|sms|whatsapp)\b.*\b(him|her|them|lead|client|customer|now)\b/.test(t) && !/\b(task|remind|follow)/.test(t)) {
    return { reply: 'I can’t send messages myself. Outreach always goes through a person. I can have the Follow-Up Agent draft one for approval, or create a follow-up task. Want me to?', actions: [] };
  }
  if (/\b(create|add|make|new|set up|schedule)\b.*\btask\b|\bremind me\b|\breminder\b/.test(t)) {
    const due = parseWhen(q, now);
    const title = taskTitle(q);
    return propose({ id: actionId(), kind: 'create_task', summary: `${title}${lead ? ` (${lead.name})` : ''}, ${fmtDateTime(due)}`, title, dueAt: new Date(due).toISOString(), leadId: lead?.id ?? null, assigneeId: findMember(q, s.members, s.me.name)?.id ?? null, priority: /\burgent|asap\b/.test(t) ? 'urgent' : /\bimportant|high\b/.test(t) ? 'high' : 'normal' },
      `I’ll create a task **${title}**, due ${fmtDateTime(due)}${lead ? ` for ${lead.name}` : ''}.`);
  }
  if (/\b(book|schedule|set up|arrange)\b.*\b(showing|viewing|visit|tour)\b/.test(t)) {
    if (!lead) return needLead('book a showing for');
    const start = parseWhen(q, now);
    const prop = s.properties.find((p) => t.includes(p.title.toLowerCase().replace(/^.* at /, ''))) ?? s.properties.find((p) => p.status === 'active' && p.verifiedAt && lead.locations.includes(p.locality));
    return propose({ id: actionId(), kind: 'book_showing', summary: `Showing for ${lead.name}, ${fmtDateTime(start)}`, leadId: lead.id, start: new Date(start).toISOString(), durationMinutes: 45, propertyId: prop?.id ?? null, assigneeId: lead.assignedTo },
      `I’ll book a 45-minute showing for **${lead.name}** on ${fmtDateTime(start)}${prop ? ` at ${prop.title}` : ''}. Availability is checked when you confirm.`);
  }
  if (/\b(assign|reassign|hand (it )?over|give)\b/.test(t) && /\bto\b/.test(t)) {
    if (!lead) return needLead('assign');
    const m = findMember(q.split(/\bto\b/i).slice(1).join(' to '), s.members);
    if (!m) return { reply: `Who should take ${lead.name}? The team is: ${s.members.filter((x) => x.status === 'active').map((x) => x.name).join(', ')}.`, actions: [] };
    return propose({ id: actionId(), kind: 'assign_lead', summary: `Assign ${lead.name} to ${m.name}`, leadId: lead.id, memberId: m.id }, `I’ll assign **${lead.name}** to **${m.name}**.`);
  }
  if (/\b(add|log|write|put)\b.*\bnote\b/.test(t)) {
    if (!lead) return needLead('add the note to');
    const body = (q.split(/:\s*/).slice(1).join(': ') || q.replace(/^.*?\b(note|saying|that)\b\s*/i, '')).trim();
    if (!body) return { reply: `What should the note on ${lead.name} say?`, actions: [] };
    return propose({ id: actionId(), kind: 'add_note', summary: `Note on ${lead.name}`, leadId: lead.id, body }, `I’ll add this note to **${lead.name}**: “${body}”.`);
  }
  const statusWord = STATUS_WORDS.find(([re]) => re.test(t));
  if (statusWord && /\b(mark|move|set|change|update)\b/.test(t)) {
    if (!lead) return needLead('update');
    const reason = statusWord[1] === 'lost' ? (q.match(/\b(?:because|reason:?)\s+(.+)$/i)?.[1] ?? null) : null;
    if (statusWord[1] === 'lost' && !reason) return { reply: `Why was ${lead.name} lost? For example: “mark ${lead.name} as lost because they bought elsewhere”.`, actions: [] };
    return propose({ id: actionId(), kind: 'update_lead_status', summary: `${lead.name} → ${statusWord[1].replace(/_/g, ' ')}`, leadId: lead.id, status: statusWord[1], lostReason: reason },
      `I’ll move **${lead.name}** from ${lead.status.replace(/_/g, ' ')} to **${statusWord[1].replace(/_/g, ' ')}**.`);
  }
  if (lead && /\b(follow[- ]?up|call back|check in|chase|ping)\b/.test(t)) {
    const at = parseWhen(q, now);
    return propose({ id: actionId(), kind: 'schedule_follow_up', summary: `Follow up with ${lead.name}, ${fmtDateTime(at)}`, leadId: lead.id, at: new Date(at).toISOString() },
      `I’ll set the next follow-up for **${lead.name}** to ${fmtDateTime(at)}.`);
  }

  // ── Questions ──
  if (/\b(sources?|channels?|portals?|where .*leads .*come|best (source|channel)|roi|spend)\b/.test(t)) return sources(s, now);
  if (/\b(hot|best|top|most likely|warmest|priorit)/.test(t) && /\bleads?\b/.test(t)) {
    const hot = [...open].sort((a, b) => b.score - a.score).slice(0, 6);
    return { reply: `Your hottest open leads right now:\n${bullet(hot.map((l) => `**${l.name}** · score ${l.score} · ${l.status.replace(/_/g, ' ')}${l.budgetMax ? ` · up to ${money(l.budgetMax)}${l.intent === 'rent' ? '/mo' : ''}` : ''}${l.locations[0] ? ` · ${l.locations[0]}` : ''}`))}\n\nWant me to set follow-ups for any of them?`, actions: [] };
  }
  if (/\b(overdue|who should i (call|contact)|call today|follow[- ]?ups?|uncontacted|not (been )?contacted|waiting)\b/.test(t)) {
    const overdue = open.filter((l) => l.nextFollowUpAt && l.nextFollowUpAt < now).sort((a, b) => b.score - a.score);
    const waiting = open.filter((l) => !l.firstResponseAt);
    const list = (/uncontacted|not (been )?contacted|waiting/.test(t) ? waiting : overdue).slice(0, 6);
    return { reply: `${plural(overdue.length, 'lead')} ${overdue.length === 1 ? 'has' : 'have'} an overdue follow-up and ${plural(waiting.length, 'lead')} still ${waiting.length === 1 ? 'needs' : 'need'} a first contact. Start with:\n${bullet(list.map((l) => `**${l.name}** · score ${l.score} · ${l.nextFollowUpAt ? `due ${relTime(l.nextFollowUpAt, now)}` : 'never contacted'}`))}`, actions: [] };
  }
  if (/\b(tasks?|to-?dos?)\b/.test(t)) {
    const mine = !/\bteam|everyone|all\b/.test(t);
    const list = s.tasks.filter((x) => (x.status === 'open' || x.status === 'in_progress') && (!mine || x.assignedTo === s.me.id)).sort((a, b) => a.dueAt - b.dueAt);
    const overdue = list.filter((x) => x.dueAt < now);
    const name = (id: string | null) => s.members.find((m) => m.id === id)?.name ?? 'Unassigned';
    return { reply: `${mine ? 'You have' : 'The team has'} ${plural(list.length, 'open task')}${overdue.length ? `, ${overdue.length} overdue` : ''}. Next up:\n${bullet(list.slice(0, 7).map((x) => `**${x.title}** · ${x.dueAt < now ? 'overdue, ' : ''}${fmtDateTime(x.dueAt)}${mine ? '' : ` · ${name(x.assignedTo)}`}`))}`, actions: [] };
  }
  if (/\b(showings?|viewings?|appointments?|visits?|calendar|meetings?)\b/.test(t)) {
    const days = /\btoday\b/.test(t) ? 1 : /\btomorrow\b/.test(t) ? 2 : 7;
    const from = /\btomorrow\b/.test(t) ? now + DAY * 0.5 : now;
    const list = s.appointments.filter((a) => a.start >= from && a.start < now + days * DAY && !['cancelled', 'no_show'].includes(a.status)).sort((a, b) => a.start - b.start);
    const leadName = (id: string | null) => s.leads.find((l) => l.id === id)?.name ?? '';
    return { reply: list.length ? `${plural(list.length, 'appointment')} ${days === 1 ? 'today' : days === 2 ? 'by tomorrow' : 'in the next 7 days'}:\n${bullet(list.slice(0, 8).map((a) => `**${fmtDateTime(a.start)}** · ${a.title}${leadName(a.leadId) ? ` · ${leadName(a.leadId)}` : ''}`))}` : 'Nothing booked in that window.', actions: [] };
  }
  if (/\b(pipeline|deals?|forecast|closing|commissions?)\b/.test(t)) {
    const openDeals = s.deals.filter((d) => !['won', 'lost'].includes(d.stage));
    const won = s.deals.filter((d) => d.stage === 'won' && d.stageChangedAt > now - 30 * DAY);
    const byStage = ['qualification', 'viewing', 'offer', 'negotiation', 'under_contract'].map((st) => [st, openDeals.filter((d) => d.stage === st)] as const);
    return { reply: `**${plural(openDeals.length, 'open deal')}** worth ${money(openDeals.reduce((a, d) => a + d.value, 0))}; ${plural(won.length, 'deal')} won in the last 30 days (${money(won.reduce((a, d) => a + d.value, 0))}).\n${bullet(byStage.filter(([, l]) => l.length).map(([st, l]) => `${st.replace(/_/g, ' ')}: ${l.length} · ${money(l.reduce((a, d) => a + d.value, 0))}`))}`, actions: [] };
  }
  if (/\b(listings?|propert(y|ies)|homes?|condos?|houses?|rentals?|for sale|for rent|inventory)\b/.test(t)) return properties(q, s);
  if (/\b(team|workload|busy|overloaded|agents?)\b/.test(t)) {
    const rows = s.members.filter((m) => m.status === 'active' && m.role === 'agent').map((m) => {
      const ls = open.filter((l) => l.assignedTo === m.id);
      return { m, open: ls.length, overdue: ls.filter((l) => l.nextFollowUpAt && l.nextFollowUpAt < now).length, hot: ls.filter((l) => l.score >= 70).length };
    }).sort((a, b) => b.open - a.open);
    return { reply: `Agent workload (open leads):\n${bullet(rows.map((r) => `**${r.m.name}** · ${r.open} open · ${r.hot} hot · ${r.overdue} overdue follow-ups`))}${rows[0] && rows[rows.length - 1] && rows[0].open > rows[rows.length - 1].open * 1.5 ? `\n\n${rows[0].m.name} carries the most; consider assigning new leads to ${rows[rows.length - 1].m.name}.` : ''}`, actions: [] };
  }
  // The general overview comes after the specific topics, so "showings this week" is about showings.
  if (/\b(how are we doing|overview|summary|summari[sz]e|performance|kpis?|numbers|report|this (week|month)|insights?)\b/.test(t)) return overview(s, now, /\bweek\b/.test(t) ? 7 : 30);
  if (lead) return leadCard(lead, s, now);
  if (found.ambiguous) return ambiguity();
  if (/\b(hi|hello|hey|help|what can you do)\b/.test(t)) return help();
  return { reply: `I didn’t catch that. In this demo I can answer things like:\n${bullet(EXAMPLES.slice(0, 5).map((e) => `“${e}”`))}`, actions: [] };
}

function automationKind(t: string): 'daily_briefing' | 'overdue_follow_ups' | 'call_new_leads' | 'reengage_stale' | null {
  if (/\b(briefing|brief me|summary|digest|morning report|daily report)\b/.test(t)) return 'daily_briefing';
  if (/\b(call new leads|call every new lead|queue (ai )?calls|calls? for new leads)\b/.test(t)) return 'call_new_leads';
  if (/\b(re-?engage|stale|gone cold|cold leads)\b/.test(t)) return 'reengage_stale';
  if (/\b(overdue|follow[- ]?up sweep|sweep)\b/.test(t)) return 'overdue_follow_ups';
  return null;
}

function timeOf(t: string): string | null {
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ?? t.match(/\bat (\d{1,2})(?::(\d{2}))?\b/);
  if (!m) return null;
  let h = Number(m[1]) % 12 + (m[3] === 'pm' || (!m[3] && Number(m[1]) < 7) ? 12 : 0);
  if (m[3] === 'am' && Number(m[1]) === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2] ?? '00'}`;
}

function daysOf(t: string): number[] {
  if (/\b(every ?day|daily|each day|7 days)\b/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
  if (/\bweekends?\b/.test(t)) return [0, 6];
  const named = WEEKDAYS.map((w, i) => (new RegExp(`\\b${w}s?\\b`).test(t) ? i : -1)).filter((i) => i >= 0);
  return named.length ? named : [1, 2, 3, 4, 5];
}

export const EXAMPLES = [
  'How are we doing this month?',
  'Which leads should I call today?',
  'Show my hot leads',
  'Where do our best leads come from?',
  'What showings do we have this week?',
  'Remind me to send the Zilker listings tomorrow at 3pm',
  '3-bed homes under $900K in Mueller',
  'How is the pipeline looking?',
  'Every weekday at 8:30 send me a briefing',
];

function help(): AssistantAnswer {
  return { reply: `I’m your Estate OS assistant. Ask me about your leads, listings, showings, tasks, deals and performance, or ask me to set up work. I propose every change and you confirm it.\n\nTry:\n${bullet([...EXAMPLES.slice(0, 5), EXAMPLES[EXAMPLES.length - 1]].map((e) => `“${e}”`))}`, actions: [] };
}

function overview(s: Snapshot, now: number, days: number): AssistantAnswer {
  const since = now - days * DAY;
  const created = s.leads.filter((l) => l.createdAt >= since);
  const qualified = created.filter((l) => !['new', 'attempting', 'contacted', 'lost'].includes(l.status));
  const won = s.deals.filter((d) => d.stage === 'won' && d.stageChangedAt >= since);
  const open = s.leads.filter(isOpen);
  const overdue = open.filter((l) => l.nextFollowUpAt && l.nextFollowUpAt < now).length;
  const showings = s.appointments.filter((a) => a.start >= now && a.start < now + 7 * DAY && !['cancelled', 'no_show'].includes(a.status)).length;
  const bySource = topSources(created);
  const label = days === 7 ? 'this week' : 'the last 30 days';
  return {
    reply: `Here’s ${label}:\n${bullet([
      `**${plural(created.length, 'new lead')}**, ${qualified.length} qualified (${created.length ? Math.round((qualified.length / created.length) * 100) : 0}%)`,
      `**${plural(won.length, 'deal')} won** · ${money(won.reduce((a, d) => a + d.value, 0))}`,
      `**${showings}** showings booked for the next 7 days`,
      `**${overdue}** open leads with an overdue follow-up`,
      bySource[0] ? `Top source: **${bySource[0].source}** (${bySource[0].n} leads, ${bySource[0].rate}% qualified)` : 'No new leads in this period',
    ])}${overdue ? `\n\nThe quickest win is clearing those ${overdue} overdue follow-ups. Ask me “which leads should I call today?”.` : ''}`,
    actions: [],
  };
}

function topSources(leads: Lead[]) {
  const m = new Map<string, { n: number; q: number }>();
  for (const l of leads) {
    const e = m.get(l.source) ?? { n: 0, q: 0 };
    e.n++;
    if (!['new', 'attempting', 'contacted', 'lost'].includes(l.status)) e.q++;
    m.set(l.source, e);
  }
  return [...m].map(([source, e]) => ({ source, n: e.n, rate: Math.round((e.q / e.n) * 100) })).sort((a, b) => b.n - a.n);
}

function sources(s: Snapshot, now: number): AssistantAnswer {
  const rows = topSources(s.leads.filter((l) => l.createdAt >= now - 90 * DAY));
  const best = [...rows].filter((r) => r.n >= 5).sort((a, b) => b.rate - a.rate)[0];
  return {
    reply: `Leads by source, last 90 days:\n${bullet(rows.slice(0, 8).map((r) => `**${r.source}** · ${r.n} leads · ${r.rate}% qualified`))}${best ? `\n\n**${best.source}** converts best (${best.rate}% qualified). Volume alone isn’t quality, so compare this with spend on the Sources page.` : ''}`,
    actions: [],
  };
}

function properties(q: string, s: Snapshot): AssistantAnswer {
  const t = q.toLowerCase();
  const beds = Number(t.match(/(\d)\s*-?\s*(bed|br|bedroom)/)?.[1] ?? 0);
  const priceM = t.replace(/[$,]/g, '').match(/\b(?:under|below|less than|max|up to)\s*(\d+(?:\.\d+)?)\s*(k|m|million)?\b/);
  const max = priceM ? Number(priceM[1]) * (priceM[2] === 'k' ? 1e3 : priceM[2] ? 1e6 : 1) : null;
  const locality = [...new Set(s.properties.map((p) => p.locality))].find((l) => t.includes(l.toLowerCase()));
  const rent = /\b(rent|rental|lease)\b/.test(t);
  const list = s.properties
    .filter((p) => p.status === 'active' && (!rent || p.listing === 'rent') && (rent || !/\bsale\b/.test(t) || p.listing === 'sale') && (!beds || p.bedrooms >= beds) && (!max || p.price <= max) && (!locality || p.locality === locality))
    .sort((a, b) => Number(!!b.verifiedAt) - Number(!!a.verifiedAt) || a.price - b.price);
  if (!list.length) return { reply: 'No active listings match that. Try a higher price, fewer bedrooms or another neighborhood.', actions: [] };
  return {
    reply: `${plural(list.length, 'active listing')} match${list.length === 1 ? 'es' : ''}:\n${bullet(list.slice(0, 6).map((p) => `**${p.title}** · ${money(p.price)}${p.listing === 'rent' ? '/mo' : ''} · ${p.locality}${p.verifiedAt ? '' : ' · *not verified, so don’t quote it to a client*'}`))}`,
    actions: [],
  };
}

function leadCard(l: Lead, s: Snapshot, now: number): AssistantAnswer {
  const owner = s.members.find((m) => m.id === l.assignedTo)?.name ?? 'unassigned';
  const tasks = s.tasks.filter((x) => x.related?.id === l.id && (x.status === 'open' || x.status === 'in_progress'));
  const next = s.appointments.filter((a) => a.leadId === l.id && a.start >= now).sort((a, b) => a.start - b.start)[0];
  return {
    reply: `**${l.name}** · ${l.type} · ${l.status.replace(/_/g, ' ')} · score ${l.score}\n${bullet([
      `Looking for ${l.bedrooms ? `${l.bedrooms}-bed ` : ''}${l.propertyType ?? 'home'}${l.locations.length ? ` in ${l.locations.join(' or ')}` : ''}${l.budgetMax ? `, up to ${money(l.budgetMax)}${l.intent === 'rent' ? '/mo' : ''}` : ''}${l.timeline ? ` · ${l.timeline}` : ''}`,
      `Source: ${l.source}${l.campaign ? ` (${l.campaign})` : ''} · owner: ${owner}`,
      `Next follow-up: ${l.nextFollowUpAt ? `${fmtDateTime(l.nextFollowUpAt)}${l.nextFollowUpAt < now ? ' (overdue)' : ''}` : 'not set'}`,
      next ? `Next appointment: ${next.title}, ${fmtDateTime(next.start)}` : 'No upcoming appointment',
      `${plural(tasks.length, 'open task')}${l.missing.length ? ` · still missing: ${l.missing.join(', ')}` : ''}`,
    ])}`,
    actions: [],
  };
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
