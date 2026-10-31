// Workspace assistant, client side. Live mode asks the `assistant` Edge Function; demo mode answers from the sample data
// (lib/assistantDemo.ts). Either way, changes come back as proposed actions that run only when the user confirms them,
// through the same actions (and permissions) as the rest of the app.
import { actions } from '@/data/actions';
import * as live from '@/backend/live';
import { LIVE, useStore } from '@/store/store';
import { fmtDateTime } from '@/lib/format';
import type { DealStage, LeadStatus, Priority } from '@/store/types';
import { demoReply } from './assistantDemo';
import { draftFollowUp, useDemoAutomations } from './automationsDemo';

export type AssistantAction = { id: string; summary: string } & (
  | { kind: 'create_task'; title: string; dueAt: string; leadId: string | null; assigneeId: string | null; priority: Priority }
  | { kind: 'complete_task'; taskId: string }
  | { kind: 'schedule_follow_up'; leadId: string; at: string }
  | { kind: 'update_lead_status'; leadId: string; status: LeadStatus; lostReason: string | null }
  | { kind: 'assign_lead'; leadId: string; memberId: string }
  | { kind: 'add_note'; leadId: string; body: string }
  | { kind: 'book_showing'; leadId: string; start: string; durationMinutes: number; propertyId: string | null; assigneeId: string | null }
  | { kind: 'move_deal'; dealId: string; stage: DealStage; lostReason: string | null }
  | { kind: 'call_lead'; leadId: string; reason: string | null }
  | { kind: 'request_follow_up'; leadId: string; purpose: FollowUpPurpose }
  | { kind: 'create_automation'; name: string; automationKind: live.AutomationRow['kind']; runAt: string; days: number[]; settings: Record<string, unknown> }
);

export type { FollowUpPurpose } from './automationRules';
import { PURPOSE_LABEL, AUTOMATION_LABEL, daysLabel, type FollowUpPurpose } from './automationRules';
export { AUTOMATION_LABEL, PURPOSE_LABEL, daysLabel } from './automationRules';

export interface ChatTurn { role: 'user' | 'assistant'; text: string }
export interface AssistantAnswer { reply: string; actions: AssistantAction[]; error?: 'not_configured' | 'rate_limited' | 'paused' | 'failed' }

const s = () => useStore.getState();
const orgId = () => s().session.orgId;

export async function ask(turns: ChatTurn[]): Promise<AssistantAnswer> {
  if (!LIVE) {
    // A short pause so the demo feels like the live assistant instead of answering before the question lands.
    await new Promise((r) => setTimeout(r, 450 + Math.random() * 450));
    return demoReply(turns[turns.length - 1]?.text ?? '', snapshot(), Date.now());
  }
  const r = await live.assistantAsk(turns);
  if (r.status === 'ok') return { reply: r.reply ?? '', actions: (r.actions ?? []) as AssistantAction[] };
  if (r.status === 'not_configured') return { reply: 'The AI assistant is not switched on for this workspace yet. An admin needs to add the Claude API key on the server.', actions: [], error: 'not_configured' };
  if (r.status === 'rate_limited') return { reply: r.message ?? 'Too many questions in a short time. Try again in a few minutes.', actions: [], error: 'rate_limited' };
  if (r.status === 'paused') return { reply: 'The assistant is paused for this agency (Pilot operations).', actions: [], error: 'paused' };
  return { reply: r.message ?? 'Something went wrong while answering. Please try again.', actions: [], error: 'failed' };
}

/** The current workspace's data for the demo assistant. */
export function snapshot() {
  const st = s();
  const mine = <T extends { orgId: string }>(list: T[]) => list.filter((x) => x.orgId === st.session.orgId);
  return {
    org: st.orgs.find((o) => o.id === st.session.orgId)!,
    me: st.me(),
    leads: mine(st.leads).filter((l) => !l.archived),
    tasks: mine(st.tasks),
    appointments: mine(st.appointments),
    properties: mine(st.properties),
    deals: mine(st.deals),
    members: mine(st.members),
    contacts: mine(st.contacts),
    // Demo automations; the live assistant reads them on the server.
    automations: useDemoAutomations.getState().automations,
    callsWaiting: useDemoAutomations.getState().queue.filter((q) => q.status === 'pending').length,
  };
}
export type Snapshot = ReturnType<typeof snapshot>;

/** Label/value rows for a confirmation card, with names instead of ids. */
export function describeAction(a: AssistantAction): [string, string][] {
  const st = s();
  const lead = (id: string | null) => (id ? st.leads.find((l) => l.id === id)?.name ?? 'Lead' : null);
  const member = (id: string | null) => (id ? st.members.find((m) => m.id === id && m.orgId === orgId())?.name ?? 'Team member' : null);
  const when = (iso: string) => fmtDateTime(Date.parse(iso));
  const rows: [string, string | null][] = (() => {
    switch (a.kind) {
      case 'create_task': return [['Task', a.title], ['Due', when(a.dueAt)], ['Lead', lead(a.leadId)], ['Assignee', member(a.assigneeId) ?? 'You'], ['Priority', a.priority === 'normal' ? null : a.priority]];
      case 'complete_task': return [['Task', st.tasks.find((t) => t.id === a.taskId)?.title ?? 'Task'], ['Change', 'Mark as done']];
      case 'schedule_follow_up': return [['Lead', lead(a.leadId)], ['Follow up', when(a.at)]];
      case 'update_lead_status': return [['Lead', lead(a.leadId)], ['New status', a.status.replace(/_/g, ' ')], ['Reason', a.lostReason]];
      case 'assign_lead': return [['Lead', lead(a.leadId)], ['Assign to', member(a.memberId)]];
      case 'add_note': return [['Lead', lead(a.leadId)], ['Note', a.body]];
      case 'book_showing': return [['Lead', lead(a.leadId)], ['When', `${when(a.start)} · ${a.durationMinutes} min`], ['Listing', a.propertyId ? st.properties.find((p) => p.id === a.propertyId)?.title ?? 'Listing' : null], ['With', member(a.assigneeId)]];
      case 'move_deal': return [['Deal', st.deals.find((d) => d.id === a.dealId)?.title ?? 'Deal'], ['New stage', a.stage.replace(/_/g, ' ')], ['Reason', a.lostReason]];
      case 'call_lead': return [['Lead', lead(a.leadId)], ['Why', a.reason], ['Safety', 'Consent, calling hours and limits are checked again before dialing']];
      case 'request_follow_up': return [['Lead', lead(a.leadId)], ['Message', PURPOSE_LABEL[a.purpose]], ['Then', 'The draft waits in Approvals; a person sends it']];
      case 'create_automation': return [['Name', a.name], ['Type', AUTOMATION_LABEL[a.automationKind]], ['Runs', `${daysLabel(a.days)} at ${a.runAt}`], ['Note', 'Prepares work only; calls and messages wait for approval']];
    }
  })();
  return rows.filter((r): r is [string, string] => !!r[1]);
}

/** Carries out a confirmed action through the app's own actions. Returns a short confirmation for the chat. */
export async function runAction(a: AssistantAction): Promise<string> {
  const st = s();
  switch (a.kind) {
    case 'create_task':
      await actions.saveTask({ title: a.title, dueAt: Date.parse(a.dueAt), assignedTo: a.assigneeId ?? st.me().id, priority: a.priority, related: a.leadId ? { type: 'lead', id: a.leadId } : null, source: 'ai', status: 'open' });
      return `Task created: “${a.title}”.`;
    case 'complete_task':
      await actions.setTaskStatus(a.taskId, 'completed');
      return 'Task marked as done.';
    case 'schedule_follow_up':
      await actions.updateLead(a.leadId, { nextFollowUpAt: Date.parse(a.at) });
      return `Follow-up set for ${fmtDateTime(Date.parse(a.at))}.`;
    case 'update_lead_status':
      await actions.setLeadStatus(a.leadId, a.status, a.lostReason ?? undefined);
      return `Lead moved to ${a.status.replace(/_/g, ' ')}.`;
    case 'assign_lead':
      await actions.assignLeads([a.leadId], a.memberId);
      return 'Lead reassigned.';
    case 'add_note':
      await actions.addNote(a.leadId, a.body);
      return 'Note added to the lead.';
    case 'book_showing': {
      const lead = st.leads.find((l) => l.id === a.leadId);
      const prop = a.propertyId ? st.properties.find((p) => p.id === a.propertyId) : null;
      const start = Date.parse(a.start);
      const res = await actions.bookAppointment({
        title: `Showing — ${prop?.title ?? lead?.name ?? 'property'}`, type: 'viewing', status: 'confirmed', leadId: a.leadId, contactId: lead?.contactId ?? null,
        propertyId: a.propertyId, assignedTo: a.assigneeId ?? lead?.assignedTo ?? st.me().id, start, end: start + a.durationMinutes * 60_000, location: prop?.locality ?? '',
      } as live.BookInput);
      if (!res.ok) throw new Error(`That time clashes with “${res.conflictTitle}”. Ask me for another time.`);
      return `Showing booked for ${fmtDateTime(start)}.`;
    }
    case 'move_deal':
      await actions.moveDeal(a.dealId, a.stage, a.lostReason ?? undefined);
      return `Deal moved to ${a.stage.replace(/_/g, ' ')}.`;
    case 'call_lead': {
      if (!LIVE) {
        const p = st.placeCall(a.leadId, { byAi: true });
        if (!p.allowed) throw new Error(`Not called: ${p.reason ?? 'the call policy did not allow it'}.`);
        return 'AI call placed. Follow it live on the Calls page.';
      }
      const r = await live.requestAiCall(a.leadId, `assistant_${a.id.replace(/[^A-Za-z0-9_-]/g, '').slice(-60)}`);
      if (r.status === 'blocked') throw new Error(`Not called: ${r.reason ?? 'the call policy did not allow it'}.`);
      return 'AI call requested. Follow it on the Calls page.';
    }
    case 'request_follow_up': {
      if (!LIVE) {
        const lead = st.leads.find((l) => l.id === a.leadId);
        if (!lead || !draftFollowUp(lead, a.purpose)) throw new Error('No draft: the lead has no texting consent, or a draft is already waiting.');
        return 'Draft ready in Approvals. Nothing is sent until someone approves it.';
      }
      await live.requestFollowUp(a.leadId, a.purpose);
      return 'The Follow-Up Agent is drafting it. Review it in Follow-ups before it is sent.';
    }
    case 'create_automation': {
      const input = { name: a.name, kind: a.automationKind, run_at: a.runAt, days: a.days, settings: a.settings };
      if (LIVE) await live.automationSave(input);
      else useDemoAutomations.getState().save(input);
      return `Automation “${a.name}” scheduled: ${daysLabel(a.days)} at ${a.runAt}.`;
    }
  }
}
