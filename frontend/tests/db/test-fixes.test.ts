// Fixes from the 2026-10-27 full test (migration 0022): a cancelled viewing puts the lead back, dashboard viewings exclude
// cancellations, contacts follow their leads' owner and lifecycle, and the pilot overview's AI-cost note is current.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, nextWeekdayAt, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let org: string, owner: string, manager: string, agent: string, prop: string;
let seq = 0;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const key = () => `k_fix_${++seq}_${Date.now()}`;
const book = async (lead: string, n: number) =>
  (await t.as<{ r: R }>(manager, `select public.appointment_book($1, 'viewing', $2, $3, $4, $5) r`, [lead, nextWeekdayAt(11, 2 * n), agent, key(), prop]))[0].r;
const cancel = (id: string) => t.as(manager, `select public.appointment_cancel($1, 'Customer cancelled')`, [id]);
const status = async (lead: string) => (await one<{ status: string }>(`select status from public.leads where id = $1`, [lead])).status;
const setStatus = (lead: string, s: string) => t.as(manager, `update public.leads set status = $2 where id = $1`, [lead, s]);
const newLead = async (name: string, phone: string) => (await t.lead(manager, org, { name, phone, type: 'buyer', locations: ['Worli'] })).lead_id as string;

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Aanya Kapoor');
  manager = await t.user('Priya Nair');
  agent = await t.user('Arjun Desai');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, manager, 'manager');
  await t.member(org, agent, 'agent');
  prop = (await t.as<{ id: string }>(manager, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, area_value, locality)
    values ($1, 'FX-1', 'Sea view 2 BHK Worli', 'apartment', 'sale', 'active', 20000000, 850, 'Worli') returning id`, [org]))[0].id;
}, 120000);

describe('cancelling a viewing', () => {
  it("puts the lead back to its status before the booking when it was the lead's only open viewing", async () => {
    const lead = await newLead('Ravi Menon', '9855500001');
    await setStatus(lead, 'contacted');
    const a = await book(lead, 1);
    expect(await status(lead)).toBe('visit_scheduled');
    await cancel(a.appointment_id);
    expect(await status(lead)).toBe('contacted');
  });

  it('keeps "visit scheduled" while another viewing is still open, and reverts after the last one', async () => {
    const lead = await newLead('Neha Shah', '9855500002');
    await setStatus(lead, 'qualified');
    const a = await book(lead, 2);
    const b = await book(lead, 3);
    await cancel(a.appointment_id);
    expect(await status(lead)).toBe('visit_scheduled');
    await cancel(b.appointment_id);
    expect(await status(lead)).toBe('qualified');
  });

  it('never moves a lead that has progressed past the visit', async () => {
    const lead = await newLead('Amit Rao', '9855500003');
    const a = await book(lead, 4);
    await setStatus(lead, 'negotiation');
    await cancel(a.appointment_id);
    expect(await status(lead)).toBe('negotiation');
  });
});

describe('dashboard viewings', () => {
  it('"Viewings booked" excludes cancelled viewings', async () => {
    const metric = async () => (await t.as<{ m: R }>(manager, `select public.dashboard_metrics($1, now() - interval '1 day', now() + interval '1 hour') m`, [org]))[0].m;
    const before = (await metric()).kpis.viewings_booked.current;
    const lead = await newLead('Kiran Iyer', '9855500004');
    const a = await book(lead, 5);
    expect((await metric()).kpis.viewings_booked.current).toBe(before + 1);
    await cancel(a.appointment_id);
    const after = await metric();
    expect(after.kpis.viewings_booked.current).toBe(before);
    expect(after.series.reduce((s: number, x: R) => s + Number(x.viewings), 0)).toBe(before);
  });
});

describe('contacts follow their leads', () => {
  const contactOf = async (lead: string) => one(`select c.assigned_to, c.lifecycle_status from public.contacts c join public.leads l on l.contact_id = c.id where l.id = $1`, [lead]);

  it('take the lead owner, become active when worked and client when won', async () => {
    const lead = await newLead('Sara Dutta', '9855500005');
    await t.as(manager, `update public.leads set assigned_to = null where id = $1`, [lead]);
    await t.db.query(`update public.contacts set assigned_to = null where id = (select contact_id from public.leads where id = $1)`, [lead]);
    expect(await contactOf(lead)).toMatchObject({ assigned_to: null, lifecycle_status: 'new' });
    await t.as(manager, `update public.leads set assigned_to = $2 where id = $1`, [lead, agent]);
    await setStatus(lead, 'contacted');
    expect(await contactOf(lead)).toMatchObject({ assigned_to: agent, lifecycle_status: 'active' });
    await setStatus(lead, 'won');
    expect((await contactOf(lead)).lifecycle_status).toBe('client');
  });

  it('never override an existing owner or a do-not-contact state', async () => {
    const lead = await newLead('Tara Bose', '9855500006');
    await t.db.query(`update public.contacts set assigned_to = $2, lifecycle_status = 'do_not_contact' where id = (select contact_id from public.leads where id = $1)`, [lead, manager]);
    await t.as(manager, `update public.leads set assigned_to = $2 where id = $1`, [lead, agent]);
    await setStatus(lead, 'won');
    expect(await contactOf(lead)).toMatchObject({ assigned_to: manager, lifecycle_status: 'do_not_contact' });
  });
});

describe('pilot overview', () => {
  it('no longer says AI token usage is unrecorded', async () => {
    const [{ r }] = await t.as<{ r: R }>(owner, `select public.pilot_overview($1) r`, [org]);
    const ai = r.unavailable.find((u: R) => u.metric === 'ai_cost');
    expect(ai.reason).toMatch(/Tokens per agent are recorded/);
    expect(ai.reason).not.toMatch(/not recorded/);
  });
});
