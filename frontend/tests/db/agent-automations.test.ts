// Migration 0029 (agent automations): schedules in the agency's time zone, work prepared but never sent, and a call
// queue that only holds leads with AI-call consent and is approved by placing the call.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let owner: string, agent: string, org: string;
let consented: string, noConsent: string, overdue: string;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const save = async (user: string, input: R) => (await t.as<{ r: R }>(user, `select public.automation_save($1, $2::jsonb) r`, [org, JSON.stringify(input)]))[0].r;
const runNow = async (id: string) => (await t.as<{ r: R }>(owner, `select public.automation_run_now($1) r`, [id]))[0].r;

beforeAll(async () => {
  t = await createDb({ region: 'US' });
  owner = await t.user('Jordan Ellis');
  agent = await t.user('David Chen');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, agent, 'agent');
  consented = (await t.lead(owner, org, { name: 'Emma Carter', phone: '512 555 0142', type: 'buyer', source: 'Zillow', assigned_to: agent })).lead_id;
  noConsent = (await t.lead(owner, org, { name: 'Liam Nguyen', phone: '512 555 0143', type: 'buyer', source: 'Website form', assigned_to: agent })).lead_id;
  overdue = (await t.lead(owner, org, { name: 'Ava Brooks', email: 'ava@example.test', type: 'tenant', assigned_to: agent })).lead_id;
  const contact = (await one<{ c: string }>(`select contact_id c from public.leads where id = $1`, [consented])).c;
  await t.as(owner, `select public.set_ai_call_consent($1, 'granted', 'Website form checkbox')`, [contact]);
  await t.db.query(`update public.leads set next_follow_up_at = now() - interval '1 day' where id = $1`, [overdue]);
}, 120000);

describe('saving automations', () => {
  it('lets owners schedule in the agency time zone, and refuses agents', async () => {
    const a = await save(owner, { name: 'Morning briefing', kind: 'daily_briefing', run_at: '08:30', days: [1, 2, 3, 4, 5] });
    expect(a).toMatchObject({ kind: 'daily_briefing', enabled: true, days: [1, 2, 3, 4, 5], settings: { audience: 'managers' } });
    const next = await one<{ local: string; dow: number }>(`select to_char(next_run_at at time zone 'America/New_York', 'HH24:MI') local, extract(dow from next_run_at at time zone 'America/New_York')::int dow from public.agent_automations where id = $1`, [a.id]);
    expect(next.local).toBe('08:30');
    expect([1, 2, 3, 4, 5]).toContain(next.dow);
    expect((await t.fails(agent, `select public.automation_save($1, '{"name":"x","kind":"daily_briefing","run_at":"09:00","days":[1]}'::jsonb)`, [org])).detail).toBe('FORBIDDEN');
    expect((await t.fails(owner, `select public.automation_save($1, '{"name":"x","kind":"send_texts","run_at":"09:00","days":[1]}'::jsonb)`, [org])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(owner, `select public.automation_save($1, '{"name":"x","kind":"daily_briefing","run_at":"9am","days":[1]}'::jsonb)`, [org])).detail).toBe('VALIDATION_ERROR');
  });

  it('clamps settings to safe bounds', async () => {
    const a = await save(owner, { name: 'Calls', kind: 'call_new_leads', run_at: '10:00', days: [1], settings: { within_hours: 9999, max: 500, extra: 'x' } });
    expect(a.settings).toEqual({ within_hours: 168, max: 50 });
  });
});

describe('running automations', () => {
  it('briefs managers with real numbers', async () => {
    const a = await save(owner, { name: 'Briefing', kind: 'daily_briefing', run_at: '08:00', days: [0, 1, 2, 3, 4, 5, 6] });
    const r = await runNow(a.id);
    expect(r).toMatchObject({ kind: 'daily_briefing', notified: 1 });
    expect(r.summary).toMatch(/3 new leads in the last 24 h/);
    expect((await one<{ n: number }>(`select count(*)::int n from public.notifications where organization_id = $1 and title = 'Daily briefing'`, [org])).n).toBe(1);
  });

  it('creates one follow-up task per overdue lead, not duplicates', async () => {
    const a = await save(owner, { name: 'Overdue sweep', kind: 'overdue_follow_ups', run_at: '09:00', days: [1, 2, 3, 4, 5] });
    expect(await runNow(a.id)).toMatchObject({ tasks_created: 1, drafts_requested: 0 });
    expect(await runNow(a.id)).toMatchObject({ tasks_created: 0 });
    expect(await one(`select title, source, assigned_to from public.tasks where related_lead_id = $1`, [overdue])).toEqual({ title: 'Follow up with Ava Brooks', source: 'workflow', assigned_to: agent });
  });

  it('queues only leads with AI-call consent, and never dials', async () => {
    const a = await save(owner, { name: 'Call new leads', kind: 'call_new_leads', run_at: '10:00', days: [1, 2, 3, 4, 5] });
    expect(await runNow(a.id)).toMatchObject({ queued: 1 });
    const q = await t.as<R>(owner, `select lead_id, status from public.agent_call_queue where organization_id = $1`, [org]);
    expect(q).toEqual([{ lead_id: consented, status: 'pending' }]);
    expect((await one<{ n: number }>(`select count(*)::int n from public.voice_calls where organization_id = $1`, [org])).n).toBe(0);
    expect((await runNow(a.id)).queued).toBe(0);
    expect(noConsent).toBeTruthy();
  });

  it('runs due automations from the scheduler and moves them to the next run', async () => {
    const a = await save(owner, { name: 'Tick test', kind: 'daily_briefing', run_at: '07:00', days: [0, 1, 2, 3, 4, 5, 6] });
    await t.db.query(`update public.agent_automations set next_run_at = now() - interval '1 minute' where id = $1`, [a.id]);
    const r = (await t.db.query<{ r: R }>(`select public.automations_tick(20) r`)).rows[0].r;
    expect(r.ran).toBeGreaterThanOrEqual(1);
    const after = await one<{ future: boolean; ran: boolean }>(`select next_run_at > now() future, last_run_at is not null ran from public.agent_automations where id = $1`, [a.id]);
    expect(after).toEqual({ future: true, ran: true });
  });
});

describe('the call queue', () => {
  it('can be declined, but approved only by placing the call', async () => {
    const item = (await one<{ id: string }>(`select id from public.agent_call_queue where lead_id = $1 and status = 'pending'`, [consented])).id;
    expect((await t.fails(owner, `select public.call_queue_decide($1, 'approved', null)`, [item])).detail).toBe('VALIDATION_ERROR');
    const [{ r }] = await t.as<{ r: R }>(agent, `select public.call_queue_decide($1, 'declined') r`, [item]);
    expect(r.status).toBe('declined');
    expect((await t.fails(owner, `select public.call_queue_decide($1, 'declined')`, [item])).detail).toBe('CONFLICT');
  });

  it('is not writable directly by users', async () => {
    await expect(t.as(owner, `insert into public.agent_call_queue (organization_id, lead_id, reason) values ($1, $2, 'x')`, [org, noConsent])).rejects.toThrow();
  });
});
