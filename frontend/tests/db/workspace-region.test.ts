// Migration 0024: phones and time zones follow the workspace's country. A US workspace reads 10-digit numbers as +1,
// finds duplicates across formats, books appointments in its own time zone; an Indian workspace keeps +91.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let owner: string, us: string, inr: string;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const phoneOf = async (lead: string) => (await one<{ p: string }>(`select c.phone_e164 p from public.leads l join public.contacts c on c.id = l.contact_id where l.id = $1`, [lead])).p;

beforeAll(async () => {
  t = await createDb({ region: 'US' });
  owner = await t.user('Dana Brooks');
  us = await t.org(owner, 'Bay Area Homes');
  inr = await t.org(owner, 'Skyline Realty');
  await t.db.query(`update public.organizations set country_code = 'IN', timezone = 'Asia/Kolkata', default_currency = 'INR' where id = $1`, [inr]);
}, 120000);

describe('workspace defaults', () => {
  it('a new workspace is in the US and on New York time unless the creator sends a zone', async () => {
    expect(await one(`select country_code, timezone from public.organizations where id = $1`, [us])).toEqual({ country_code: 'US', timezone: 'America/New_York' });
    const [{ id }] = await t.as<{ id: string }>(owner, `select public.create_organization('Pacific Realty', 'San Diego', 'America/Los_Angeles') id`);
    expect((await one<{ tz: string }>(`select timezone tz from public.organizations where id = $1`, [id])).tz).toBe('America/Los_Angeles');
  });

  it('owners can change the workspace country from the app', async () => {
    const [{ id }] = await t.as<{ id: string }>(owner, `select public.create_organization('Maple Homes', 'Toronto', 'America/Toronto') id`);
    await t.as(owner, `update public.organizations set country_code = 'CA' where id = $1`, [id]);
    expect((await one<{ c: string }>(`select country_code c from public.organizations where id = $1`, [id])).c).toBe('CA');
  });
});

describe('phone numbers', () => {
  it('a US workspace stores a 10-digit number as +1, and an 11-digit one starting with 1 too', async () => {
    const a = (await t.lead(owner, us, { name: 'Ava Miller', phone: '(415) 555-0134', type: 'buyer' })).lead_id;
    expect(await phoneOf(a)).toBe('+14155550134');
    const b = (await t.lead(owner, us, { name: 'Ben Ortiz', phone: '1-212-555-0188', type: 'buyer' })).lead_id;
    expect(await phoneOf(b)).toBe('+12125550188');
  });

  it('a 10-digit number that is not a valid North American number is not stored as +1', async () => {
    expect((await one<{ p: string | null }>(`select private.normalize_phone('(015) 555-0134', 'US') p`)).p).toBeNull();
    expect((await one<{ p: string | null }>(`select private.normalize_phone('415 155 0134', 'US') p`)).p).toBeNull();
    expect((await one<{ p: string }>(`select private.normalize_phone('98444 00001', 'IN') p`)).p).toBe('+919844400001');
  });

  it('a number with a country code is kept as given', async () => {
    const c = (await t.lead(owner, us, { name: 'Chloe Martin', phone: '+44 20 7946 0958', type: 'buyer' })).lead_id;
    expect(await phoneOf(c)).toBe('+442079460958');
  });

  it('finds a duplicate typed in a different format', async () => {
    const [{ r }] = await t.as<{ r: R }>(owner, `select public.create_lead($1, $2::jsonb, 'ask') r`,
      [us, JSON.stringify({ name: 'Ava M', phone: '415.555.0134', type: 'buyer' })]);
    expect(r.status).toBe('duplicate');
  });

  it('an Indian workspace keeps +91', async () => {
    const d = (await t.lead(owner, inr, { name: 'Ravi Menon', phone: '98444 00001', type: 'buyer' })).lead_id;
    expect(await phoneOf(d)).toBe('+919844400001');
  });

  it('webhook intake reads US numbers', async () => {
    expect((await one<{ p: string }>(`select private.intake_phone('(415) 555-0134', 'US') p`)).p).toBe('+14155550134');
    expect((await one<{ p: string | null }>(`select private.intake_phone('(015) 555-0134', 'US') p`)).p).toBeNull();
    expect((await one<{ p: string }>(`select private.intake_phone('98444 00001', 'IN') p`)).p).toBe('+919844400001');
  });

  it('data-quality checks validate +1 numbers', async () => {
    expect((await one<{ c: string | null }>(`select private.dq_phone_check('+1 415 555 0134', '+14155550134') c`)).c).toBeNull();
    expect((await one<{ c: string }>(`select private.dq_phone_check('+1 015 555 0134', '+10155550134') c`)).c).toBe('invalid');
  });
});

describe('appointments', () => {
  it("are stored and checked in the workspace's time zone", async () => {
    const lead = (await t.lead(owner, us, { name: 'Dev Patel', phone: '(646) 555-0101', type: 'buyer' })).lead_id;
    const [{ id }] = await t.as<{ id: string }>(owner, `insert into public.appointments (organization_id, title, appointment_type, lead_id, assigned_to, starts_at, ends_at)
      select $1, 'Consultation', 'consultation', $2, $3, s, s + interval '45 minutes'
      from (select ((d::date + time '11:00') at time zone 'America/New_York') s
            from generate_series((now() at time zone 'America/New_York')::date + 2, (now() at time zone 'America/New_York')::date + 6, interval '1 day') d
            where extract(isodow from d) between 1 and 5 order by d limit 1) x
      returning id`, [us, lead, owner]);
    expect((await one<{ tz: string }>(`select timezone tz from public.appointments where id = $1`, [id])).tz).toBe('America/New_York');
  });
});
