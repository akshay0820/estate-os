// Demo-mode automations and AI call queue: the same behaviour as migration 0029 on the sample data. Automations prepare
// work only (briefing notifications, follow-up tasks, message drafts in Approvals, queued calls); a queued call is placed
// only when a person approves it, and the demo call policy (consent, hours, kill switch) runs again at that moment.
import { create } from 'zustand';
import { useStore } from '@/store/store';
import { OPEN_LEAD, outboundPolicy } from '@/lib/domain';
import { uid } from '@/lib/util';
import type { AutomationRow, CallQueueRow } from '@/backend/live';
import type { Lead } from '@/store/types';
import { nextRun, settingsFor } from './automationRules';

export { nextRun, settingsFor };

type Kind = AutomationRow['kind'];
const HOUR = 36e5;
const DAY = 864e5;
const isOpen = (l: Lead) => (OPEN_LEAD as readonly string[]).includes(l.status);
const st = () => useStore.getState();

const seed = (name: string, kind: Kind, runAt: string, days: number[], settings: Record<string, unknown> = {}): AutomationRow => ({
  id: uid('auto'), name, kind, enabled: true, run_at: runAt, days, settings: settingsFor(kind, settings), next_run_at: nextRun(runAt, days), last_run_at: null, last_result: null,
});

interface DemoState {
  automations: AutomationRow[];
  queue: CallQueueRow[];
  save: (input: { id?: string; name: string; kind: Kind; enabled?: boolean; run_at: string; days: number[]; settings?: Record<string, unknown> }) => AutomationRow;
  remove: (id: string) => void;
  runNow: (id: string) => Record<string, unknown>;
  decide: (item: CallQueueRow, decision: 'approved' | 'declined') => { ok: boolean; reason?: string };
}

export const useDemoAutomations = create<DemoState>((set, get) => ({
  automations: [
    seed('Morning briefing', 'daily_briefing', '08:30', [1, 2, 3, 4, 5]),
    seed('Overdue follow-up sweep', 'overdue_follow_ups', '09:00', [1, 2, 3, 4, 5, 6], { draft_messages: true, max: 10 }),
    seed('Call new leads', 'call_new_leads', '10:00', [1, 2, 3, 4, 5], { within_hours: 48, max: 10 }),
  ],
  queue: [],
  save: (input) => {
    const row: AutomationRow = {
      id: input.id ?? uid('auto'), name: input.name.trim().slice(0, 80) || 'Automation', kind: input.kind, enabled: input.enabled ?? true, run_at: input.run_at,
      days: [...new Set(input.days)].sort(), settings: settingsFor(input.kind, input.settings), next_run_at: nextRun(input.run_at, input.days), last_run_at: null, last_result: null,
    };
    set((s) => ({ automations: s.automations.some((a) => a.id === row.id) ? s.automations.map((a) => (a.id === row.id ? { ...a, ...row, last_run_at: a.last_run_at, last_result: a.last_result } : a)) : [...s.automations, row] }));
    return row;
  },
  remove: (id) => set((s) => ({ automations: s.automations.filter((a) => a.id !== id) })),
  runNow: (id) => {
    const a = get().automations.find((x) => x.id === id);
    if (!a) return { error: 'not found' };
    const result = run(a);
    set((s) => ({ automations: s.automations.map((x) => (x.id === id ? { ...x, last_run_at: new Date().toISOString(), last_result: { ...result, manual: true } } : x)) }));
    return result;
  },
  decide: (item, decision) => {
    if (decision === 'approved') {
      const policy = st().placeCall(item.lead_id, { byAi: true });
      if (!policy.allowed) return { ok: false, reason: policy.reason ?? 'The call policy did not allow this call right now.' };
    }
    set((s) => ({ queue: s.queue.map((q) => (q.id === item.id ? { ...q, status: decision } : q)) }));
    return { ok: true };
  },
}));

function run(a: AutomationRow): Record<string, unknown> {
  const s = st();
  const orgId = s.session.orgId;
  const now = Date.now();
  const leads = s.leads.filter((l) => l.orgId === orgId && !l.archived);
  const open = leads.filter(isOpen);
  const settings = a.settings as Record<string, number & boolean & string>;

  if (a.kind === 'daily_briefing') {
    const counts = {
      new_24h: leads.filter((l) => l.createdAt >= now - DAY).length,
      hot: open.filter((l) => l.score >= 70).length,
      overdue: open.filter((l) => l.nextFollowUpAt && l.nextFollowUpAt < now).length,
      uncontacted: open.filter((l) => !l.firstResponseAt).length,
      tasks_overdue: s.tasks.filter((t) => t.orgId === orgId && (t.status === 'open' || t.status === 'in_progress') && t.dueAt < now).length,
      showings_today: s.appointments.filter((x) => x.orgId === orgId && new Date(x.start).toDateString() === new Date(now).toDateString() && !['cancelled', 'no_show'].includes(x.status)).length,
      calls_waiting: useDemoAutomations.getState().queue.filter((q) => q.status === 'pending').length,
    };
    const summary = `${counts.new_24h} new leads in the last 24 h · ${counts.hot} hot · ${counts.overdue} overdue follow-ups · ${counts.uncontacted} never contacted · ${counts.tasks_overdue} overdue tasks · ${counts.showings_today} showings today${counts.calls_waiting ? ` · ${counts.calls_waiting} AI calls waiting for approval` : ''}`;
    s.notify({ kind: 'system', title: 'Daily briefing', body: summary, link: 'dashboard' });
    return { kind: a.kind, notified: 1, summary, ...counts };
  }

  if (a.kind === 'overdue_follow_ups') {
    let tasks = 0;
    let drafts = 0;
    const due = open.filter((l) => l.nextFollowUpAt && l.nextFollowUpAt < now).sort((x, y) => y.score - x.score).slice(0, settings.max);
    for (const l of due) {
      const has = s.tasks.some((t) => t.related?.id === l.id && (t.status === 'open' || t.status === 'in_progress') && t.source === 'workflow' && t.title.startsWith('Follow up with'));
      if (!has) {
        void st().saveTask({ title: `Follow up with ${l.name}`, dueAt: now + 2 * HOUR, assignedTo: l.assignedTo, priority: 'high', related: { type: 'lead', id: l.id }, source: 'workflow', status: 'open' });
        tasks++;
      }
      if (settings.draft_messages && draftFollowUp(l, 'clarify_requirements')) drafts++;
    }
    return { kind: a.kind, tasks_created: tasks, drafts_requested: drafts };
  }

  if (a.kind === 'call_new_leads') {
    let queued = 0;
    let skipped = 0;
    const demo = useDemoAutomations.getState();
    const candidates = open
      .filter((l) => !l.firstResponseAt && l.createdAt >= now - settings.within_hours * HOUR)
      .filter((l) => !demo.queue.some((q) => q.lead_id === l.id && (q.status === 'pending' || Date.parse(q.created_at) > now - DAY)))
      .slice(0, settings.max);
    const added: CallQueueRow[] = [];
    for (const l of candidates) {
      const contact = s.contacts.find((c) => c.id === l.contactId);
      // Consent and number are checked now; time-of-day and the kill switch are checked again when someone approves.
      const ok = !!contact?.phone && contact.consents.phone === 'granted' && contact.lifecycle !== 'do_not_contact';
      if (!ok) { skipped++; continue; }
      added.push({ id: uid('callq'), lead_id: l.id, reason: `New lead from ${l.source}, not contacted yet`, status: 'pending', created_at: new Date().toISOString(), call_id: null, lead: { title: l.name, contact: { display_name: l.name } } });
      queued++;
    }
    if (added.length) {
      useDemoAutomations.setState((x) => ({ queue: [...added, ...x.queue] }));
      s.notify({ kind: 'approval', title: `${added.length} AI calls ready to approve`, body: 'New leads with call consent are queued. Nothing is dialed until someone approves.', link: 'automations' });
    }
    return { kind: a.kind, queued, skipped_no_consent: skipped };
  }

  // reengage_stale
  let drafts = 0;
  const stale = open.filter((l) => (l.lastContactAt ?? l.createdAt) < now - settings.stale_days * DAY).sort((x, y) => y.score - x.score).slice(0, settings.max);
  for (const l of stale) if (draftFollowUp(l, 're_engagement')) drafts++;
  return { kind: a.kind, drafts_requested: drafts };
}

/** A follow-up message draft in Approvals (never sent automatically). Returns false when the lead has no text consent. */
export function draftFollowUp(l: Lead, purpose: 'clarify_requirements' | 'share_property_recommendations' | 're_engagement'): boolean {
  const s = st();
  const contact = s.contacts.find((c) => c.id === l.contactId);
  if (!contact || !outboundPolicy(s.org(), contact, 'sms', { at: Date.now() + DAY / 2 }).checks.find((c) => c.label.includes('consent'))?.ok) return false;
  if (s.approvals.some((x) => x.status === 'pending' && x.payload.kind === 'send_message' && x.summary.endsWith(l.name))) return false;
  const first = l.name.split(' ')[0];
  const body = purpose === 're_engagement'
    ? `Hi ${first}, it’s been a little while. Are you still looking${l.locations[0] ? ` around ${l.locations[0]}` : ''}? A few new listings came in that might fit. Reply STOP to opt out.`
    : purpose === 'share_property_recommendations'
      ? `Hi ${first}, I pulled together a few verified listings that match what you described. Want me to send them over? Reply STOP to opt out.`
      : `Hi ${first}, quick check so we only send you homes that fit: what budget and move-in timing should we plan around? Reply STOP to opt out.`;
  const conversationId = s.startConversation(l.contactId, 'sms');
  useStore.setState((x) => ({
    approvals: [{
      id: uid('apr'), orgId: s.session.orgId, action: 'send_approved_message', summary: `Send follow-up to ${l.name}`, risk: 'low', requestedBy: { type: 'ai_agent', name: 'AI Follow-Up Agent' },
      status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 2 * DAY, decidedBy: null, decidedAt: null, note: null, payload: { kind: 'send_message', conversationId, body },
    }, ...x.approvals],
  }));
  return true;
}
