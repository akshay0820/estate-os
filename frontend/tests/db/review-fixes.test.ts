// Migration 0025 (code-review fixes): a country change re-reads phones so duplicates still match, a workspace is
// created with its country in one call, and leads import in batches with one result per row.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let owner: string, agent: string, org: string;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const phoneOf = async (lead: string) => (await one<{ p: string }>(`select c.phone_e164 p from public.leads l join public.contacts c on c.id = l.contact_id where l.id = $1`, [lead])).p;

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Aanya Kapoor');
  agent = await t.user('Arjun Desai');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, agent, 'agent');
}, 120000);

describe('changing the workspace country', () => {
  it('re-reads phones saved without a country code, so a returning customer is still found', async () => {
    const local = (await t.lead(owner, org, { name: 'Ava Miller', phone: '415 555 0134', type: 'buyer' })).lead_id;
    const intl = (await t.lead(owner, org, { name: 'Chloe Martin', phone: '+44 20 7946 0958', type: 'buyer' })).lead_id;
    expect(await phoneOf(local)).toBe('+914155550134');
    await t.as(owner, `update public.organizations set country_code = 'US' where id = $1`, [org]);
    expect(await phoneOf(local)).toBe('+14155550134');
    expect(await phoneOf(intl)).toBe('+442079460958');
    const [{ r }] = await t.as<{ r: R }>(owner, `select public.create_lead($1, $2::jsonb, 'ask') r`, [org, JSON.stringify({ name: 'Ava M', phone: '(415) 555-0134', type: 'buyer' })]);
    expect(r.status).toBe('duplicate');
  });

  it("still works when a contact's owner has left the workspace", async () => {
    const lead = (await t.lead(owner, org, { name: 'Ben Ortiz', phone: '212 555 0188', type: 'buyer' })).lead_id;
    await t.db.query(`update public.contacts set assigned_to = $2 where id = (select contact_id from public.leads where id = $1)`, [lead, agent]);
    await t.db.query(`update public.organization_memberships set status = 'suspended' where organization_id = $1 and user_id = $2`, [org, agent]);
    await t.as(owner, `update public.organizations set country_code = 'CA' where id = $1`, [org]);
    expect((await one<{ c: string }>(`select country_code c from public.organizations where id = $1`, [org])).c).toBe('CA');
    // Assigning a new owner who is not an active member is still refused.
    const outsider = await t.user('Olly Outsider');
    expect((await t.fails(owner, `update public.contacts set assigned_to = $2 where id = (select contact_id from public.leads where id = $1)`, [lead, outsider])).detail).toBe('INVALID_REFERENCE');
  });
});

describe('creating a workspace', () => {
  it('sets the country in the same call, and rejects a malformed one', async () => {
    const [{ id }] = await t.as<{ id: string }>(owner, `select public.create_organization('Gulf Homes', 'Dubai', 'Asia/Dubai', 'AE') id`);
    expect(await one(`select country_code, timezone from public.organizations where id = $1`, [id])).toEqual({ country_code: 'AE', timezone: 'Asia/Dubai' });
    expect((await t.fails(owner, `select public.create_organization('Bad Homes', 'X', 'Asia/Dubai', 'uae')`)).detail).toBe('VALIDATION_ERROR');
  });
});

describe('batch lead import', () => {
  it('returns one result per row in order: created, duplicate within the batch, and a reason for bad rows', async () => {
    const rows = [
      { name: 'Import One', phone: '604 555 0201', type: 'buyer', source: 'Import' },
      { name: 'Import One again', phone: '(604) 555-0201', type: 'buyer', source: 'Import' },
      { name: 'Short Phone', phone: '12345', type: 'buyer', source: 'Import' },
      { name: 'Import Two', email: 'two@example.test', type: 'tenant', source: 'Import' },
    ];
    const [{ r }] = await t.as<{ r: R[] }>(owner, `select public.import_leads($1, $2::jsonb) r`, [org, JSON.stringify(rows)]);
    expect(r.map((x) => x.status)).toEqual(['created', 'duplicate', 'error', 'created']);
    expect(r[2]).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Enter a valid phone number' });
  });

  it('needs lead edit access and caps a batch at 200 rows', async () => {
    const viewer = await t.user('Vik Viewer');
    await t.member(org, viewer, 'viewer');
    expect((await t.fails(viewer, `select public.import_leads($1, '[{"name":"X","email":"x@example.test"}]'::jsonb)`, [org])).detail).toBe('FORBIDDEN');
    const big = JSON.stringify(Array.from({ length: 201 }, (_, i) => ({ name: `N${i}`, email: `n${i}@example.test` })));
    expect((await t.fails(owner, `select public.import_leads($1, $2::jsonb)`, [org, big])).detail).toBe('VALIDATION_ERROR');
  });
});

// Migration 0027: a phone that does not normalize (an invalid US number) is still matched against the same number.
describe('duplicate phones that do not normalize', () => {
  it('reports the same invalid US number as a duplicate, and keeps valid numbers apart from it', async () => {
    const us = await createDb({ region: 'US' });
    const o = await us.user('Uma Owner');
    const g = await us.org(o, 'Bay Homes');
    const first = await us.lead(o, g, { name: 'Ivy Invalid', phone: '055 123 4567', type: 'buyer' });
    expect((await us.db.query<{ p: string | null }>(`select phone_e164 p from public.contacts where id = $1`, [first.contact_id])).rows[0].p).toBeNull();
    const ask = async (phone: string) =>
      (await us.as<{ r: R }>(o, `select public.create_lead($1, $2::jsonb, 'ask') r`, [g, JSON.stringify({ name: 'Ivy again', phone, type: 'buyer' })]))[0].r;
    const dup = await ask('(055) 123-4567');
    expect(dup.status).toBe('duplicate');
    expect(dup.candidates).toEqual([expect.objectContaining({ contact_id: first.contact_id, reasons: ['Same phone'] })]);
    expect((await ask('415 555 0134')).status).toBe('created');
  }, 120000);
});
