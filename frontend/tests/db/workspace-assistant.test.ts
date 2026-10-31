// Migration 0028 (workspace assistant): the read tools run as the caller, answer for their own workspace only, and the
// assistant has its own AI request limit available to every member who can see leads.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let owner: string, agent: string, viewer: string, stranger: string, org: string, otherOrg: string;
let leadA: string, leadB: string;

const call = async (user: string, sql: string, params: unknown[]) => (await t.as<{ r: R }>(user, sql, params))[0].r;

beforeAll(async () => {
  t = await createDb({ region: 'US' });
  owner = await t.user('Jordan Ellis');
  agent = await t.user('David Chen');
  viewer = await t.user('Vic Viewer');
  stranger = await t.user('Sam Stranger');
  org = await t.org(owner, 'Skyline Realty');
  otherOrg = await t.org(stranger, 'Other Realty');
  await t.member(org, agent, 'agent');
  await t.member(org, viewer, 'viewer');
  leadA = (await t.lead(owner, org, { name: 'Emma Carter', phone: '512 555 0142', type: 'buyer', source: 'Zillow', budget_max: 650000, locations: ['Downtown'], assigned_to: agent })).lead_id;
  leadB = (await t.lead(owner, org, { name: 'Liam Nguyen', email: 'liam@example.test', type: 'tenant', source: 'Website form', assigned_to: owner })).lead_id;
  await t.lead(stranger, otherOrg, { name: 'Hidden Person', email: 'hidden@example.test', type: 'buyer' });
  await t.db.query(`update public.leads set next_follow_up_at = now() - interval '2 days' where id = $1`, [leadB]);
  await t.as(owner, `insert into public.tasks (organization_id, title, due_at, assigned_to, related_lead_id) values ($1, 'Call Emma about Downtown condos', now() - interval '1 hour', $2, $3)`, [org, agent, leadA]);
}, 120000);

describe('assistant read tools', () => {
  it('summarises the workspace for the period', async () => {
    const o = await call(owner, `select public.assistant_overview($1, 30) r`, [org]);
    expect(o.organization).toMatchObject({ name: 'Skyline Realty', currency: 'USD', country: 'US' });
    expect(o.leads).toMatchObject({ open: 2, created_in_period: 2, follow_up_overdue: 1 });
    expect(o.sources_in_period.map((s: R) => s.source).sort()).toEqual(['Website form', 'Zillow']);
    expect(o.tasks).toMatchObject({ open: 1, overdue: 1, mine_open: 0 });
    expect((await call(agent, `select public.assistant_overview($1, 30) r`, [org])).tasks).toMatchObject({ mine_open: 1, mine_overdue: 1 });
  });

  it('finds leads by name, phone digits and filters, never from another workspace', async () => {
    const byName = await call(owner, `select public.assistant_search_leads($1, '{"query": "emma"}') r`, [org]);
    expect(byName.map((l: R) => l.name)).toEqual(['Emma Carter']);
    expect(byName[0]).toMatchObject({ source: 'Zillow', budget_max: 650000, owner: 'David Chen' });
    expect((await call(owner, `select public.assistant_search_leads($1, '{"query": "555-0142"}') r`, [org])).map((l: R) => l.name)).toEqual(['Emma Carter']);
    expect((await call(owner, `select public.assistant_search_leads($1, '{"follow_up_overdue": true}') r`, [org])).map((l: R) => l.name)).toEqual(['Liam Nguyen']);
    expect((await call(agent, `select public.assistant_search_leads($1, '{"assigned_to_me": true}') r`, [org])).map((l: R) => l.name)).toEqual(['Emma Carter']);
    expect(await call(owner, `select public.assistant_search_leads($1, '{"query": "hidden"}') r`, [org])).toEqual([]);
  });

  it('returns one lead with its open tasks, and tasks and team lists', async () => {
    const lead = await call(owner, `select public.assistant_lead($1, $2) r`, [org, leadA]);
    expect(lead).toMatchObject({ name: 'Emma Carter', owner: 'David Chen' });
    expect(lead.open_tasks.map((x: R) => x.title)).toEqual(['Call Emma about Downtown condos']);
    expect((await call(agent, `select public.assistant_tasks($1, '{"scope": "mine", "when": "overdue"}') r`, [org])).map((x: R) => x.lead)).toEqual(['Emma Carter']);
    const team = await call(agent, `select public.assistant_team($1) r`, [org]);
    expect(team.map((m: R) => [m.name, m.role, m.is_me])).toContainEqual(['David Chen', 'agent', true]);
  });

  it('refuses another workspace and its leads', async () => {
    expect((await t.fails(stranger, `select public.assistant_overview($1, 30)`, [org])).detail).toBe('NOT_FOUND');
    expect((await t.fails(stranger, `select public.assistant_lead($1, $2)`, [org, leadA])).detail).toBe('NOT_FOUND');
    expect((await t.fails(owner, `select public.assistant_lead($1, $2)`, [otherOrg, leadA])).detail).toBe('NOT_FOUND');
  });

  it('gives the assistant its own AI request limit, open to every member who can see leads', async () => {
    const [{ r }] = await t.as<{ r: R }>(viewer, `select public.ai_request_begin($1, 'workspace_assistant') r`, [org]);
    expect(r.remaining_user_hour).toBe(119);
    expect((await t.fails(stranger, `select public.ai_request_begin($1, 'workspace_assistant')`, [org])).detail).toBe('NOT_FOUND');
  });
});
