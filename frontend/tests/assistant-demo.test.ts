// The demo assistant answers from the sample data and proposes (never applies) changes.
import { beforeAll, describe, expect, it } from 'vitest';
import { demoReply, findLead, parseWhen } from '@/lib/assistantDemo';
import { setMoneyCurrency } from '@/lib/format';
import { ORG_CONFIGS, generateOrg } from '@/store/seed';
import type { Snapshot } from '@/lib/assistant';

const NOW = new Date(2026, 10, 2, 9, 0).getTime(); // Mon Nov 2 2026, 09:00 local
let s: Snapshot;

beforeAll(() => {
  setMoneyCurrency('USD');
  const cfg = ORG_CONFIGS[0];
  const d = generateOrg(cfg, NOW);
  s = { org: cfg.org, me: d.members[0], leads: d.leads.filter((l) => !l.archived), tasks: d.tasks, appointments: d.appointments, properties: d.properties, deals: d.deals, members: d.members, contacts: d.contacts,
    automations: [{ id: 'a1', name: 'Morning briefing', kind: 'daily_briefing', enabled: true, run_at: '08:30', days: [1, 2, 3, 4, 5], settings: {}, next_run_at: null, last_run_at: null, last_result: null }], callsWaiting: 0 } as unknown as Snapshot;
});

describe('understanding time and names', () => {
  it('reads relative dates and times, never in the past', () => {
    expect(new Date(parseWhen('tomorrow at 3pm', NOW))).toEqual(new Date(2026, 10, 3, 15, 0));
    expect(new Date(parseWhen('on friday', NOW))).toEqual(new Date(2026, 10, 6, 10, 0));
    expect(new Date(parseWhen('today at 8am', NOW))).toEqual(new Date(2026, 10, 3, 8, 0));
    expect(new Date(parseWhen('in 3 days', NOW))).toEqual(new Date(2026, 10, 5, 10, 0));
    expect(parseWhen('soon', NOW)).toBe(new Date(2026, 10, 3, 10, 0).getTime());
  });

  it('finds a lead by full name', () => {
    const l = s.leads[5];
    expect(findLead(`what about ${l.name}?`, s.leads).lead?.name).toBe(l.name);
  });
});

describe('answers', () => {
  it('gives an overview with real numbers in dollars', () => {
    const r = demoReply('How are we doing this month?', s, NOW);
    expect(r.reply).toMatch(/new leads?/);
    expect(r.reply).toMatch(/\$/);
    expect(r.actions).toEqual([]);
  });

  it('lists hot leads by score, sources, tasks, showings, pipeline and listings', () => {
    const hot = demoReply('show my hot leads', s, NOW).reply;
    const scores = [...hot.matchAll(/score (\d+)/g)].map((m) => Number(m[1]));
    expect(scores.length).toBeGreaterThan(2);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(demoReply('Where do our best leads come from?', s, NOW).reply).toMatch(/Zillow|Realtor\.com|Meta Ads/);
    expect(demoReply('what are my tasks', s, NOW).reply).toMatch(/open task/);
    expect(demoReply('what showings do we have this week', s, NOW).reply).toMatch(/appointment|Nothing booked/);
    expect(demoReply('how is the pipeline looking', s, NOW).reply).toMatch(/open deals?/);
    const homes = demoReply('3-bed homes under $900K', s, NOW).reply;
    for (const m of homes.matchAll(/\$([\d.]+)([KM])/g)) expect(Number(m[1]) * (m[2] === 'M' ? 1e6 : 1e3)).toBeLessThanOrEqual(900_000);
  });

  it('describes a named lead', () => {
    const l = s.leads.find((x) => x.budgetMax && x.locations.length)!;
    const r = demoReply(`tell me about ${l.name}`, s, NOW);
    expect(r.reply).toContain(l.name);
    expect(r.reply).toMatch(/Next follow-up/);
  });
});

describe('proposed changes', () => {
  it('turns a request into a confirmable task, not a done deed', () => {
    const l = s.leads.find((x) => ['qualified', 'contacted'].includes(x.status))!;
    const r = demoReply(`Create a task to call ${l.name} tomorrow at 3pm`, s, NOW);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ kind: 'create_task', leadId: l.id, dueAt: new Date(2026, 10, 3, 15, 0).toISOString() });
    expect(r.actions[0].kind === 'create_task' && r.actions[0].title).toMatch(/^Call /);
    expect(r.reply).toMatch(/Nothing changes until you do/);
  });

  it('proposes follow-ups, assignments, status changes and notes for a named lead', () => {
    const l = s.leads.find((x) => x.status === 'contacted')!;
    const agent = s.members.find((m) => m.role === 'agent' && m.status === 'active' && m.id !== l.assignedTo)!;
    expect(demoReply(`follow up with ${l.name} on friday`, s, NOW).actions[0]).toMatchObject({ kind: 'schedule_follow_up', leadId: l.id });
    expect(demoReply(`assign ${l.name} to ${agent.name}`, s, NOW).actions[0]).toMatchObject({ kind: 'assign_lead', memberId: agent.id });
    expect(demoReply(`mark ${l.name} as qualified`, s, NOW).actions[0]).toMatchObject({ kind: 'update_lead_status', status: 'qualified' });
    expect(demoReply(`mark ${l.name} as lost`, s, NOW).actions).toEqual([]);
    expect(demoReply(`add a note to ${l.name}: prefers weekend showings`, s, NOW).actions[0]).toMatchObject({ kind: 'add_note', body: 'prefers weekend showings' });
  });

  it('will not send messages itself', () => {
    const r = demoReply('text her now that the price dropped', s, NOW);
    expect(r.actions).toEqual([]);
    expect(r.reply).toMatch(/can’t send messages/);
  });

  it('proposes an AI call only when the call policy allows it, and explains why not otherwise', () => {
    const consented = s.leads.find((l) => s.contacts.find((c) => c.id === l.contactId)?.consents.phone === 'granted' && ['new', 'contacted', 'qualified'].includes(l.status))!;
    const noConsent = s.leads.find((l) => s.contacts.find((c) => c.id === l.contactId)?.consents.phone !== 'granted' && ['new', 'contacted', 'qualified'].includes(l.status))!;
    const daytime = new Date(2026, 10, 2, 11, 0).getTime();
    const yes = demoReply(`call ${consented.name}`, s, daytime);
    expect(yes.actions[0]).toMatchObject({ kind: 'call_lead', leadId: consented.id });
    const no = demoReply(`call ${noConsent.name}`, s, daytime);
    expect(no.actions).toEqual([]);
    expect(no.reply).toMatch(/can’t call/);
    expect(no.reply).toMatch(/consent/i);
  });

  it('drafts follow-ups for approval and schedules automations', () => {
    const l = s.leads.find((x) => x.status === 'contacted')!;
    expect(demoReply(`draft a follow-up to ${l.name} with matching listings`, s, NOW).actions[0]).toMatchObject({ kind: 'request_follow_up', purpose: 'share_property_recommendations' });
    expect(demoReply(`write a message to re-engage ${l.name}`, s, NOW).actions[0]).toMatchObject({ kind: 'request_follow_up', purpose: 're_engagement' });
    expect(demoReply('Every weekday at 8:30 send me a briefing', s, NOW).actions[0]).toMatchObject({ kind: 'create_automation', automationKind: 'daily_briefing', runAt: '08:30', days: [1, 2, 3, 4, 5] });
    expect(demoReply('set up a daily overdue sweep at 9am that drafts messages', s, NOW).actions[0]).toMatchObject({ automationKind: 'overdue_follow_ups', runAt: '09:00', days: [0, 1, 2, 3, 4, 5, 6], settings: { draft_messages: true } });
    expect(demoReply('every monday and friday at 10 queue calls for new leads', s, NOW).actions[0]).toMatchObject({ automationKind: 'call_new_leads', runAt: '10:00', days: [1, 5] });
    expect(demoReply('what automations do we have?', s, NOW).reply).toMatch(/Morning briefing/);
  });
});
