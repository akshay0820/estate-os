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
  s = { org: cfg.org, me: d.members[0], leads: d.leads.filter((l) => !l.archived), tasks: d.tasks, appointments: d.appointments, properties: d.properties, deals: d.deals, members: d.members } as unknown as Snapshot;
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

  it('will not send messages or place calls', () => {
    const r = demoReply('text her now that the price dropped', s, NOW);
    expect(r.actions).toEqual([]);
    expect(r.reply).toMatch(/can’t send messages/);
  });
});
