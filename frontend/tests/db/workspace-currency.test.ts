// Migration 0023: new workspaces use US dollars, and new leads, listings and deals take their workspace's currency.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

let t: TestDb;
let owner: string, usd: string, inr: string;

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Dana Brooks');
  usd = await t.org(owner, 'Bay Area Homes');
  inr = await t.org(owner, 'Skyline Realty');
  await t.db.query(`update public.organizations set default_currency = 'INR' where id = $1`, [inr]);
}, 120000);

describe('workspace currency', () => {
  it('a new workspace defaults to USD', async () => {
    expect((await one<{ c: string }>(`select default_currency c from public.organizations where id = $1`, [usd])).c).toBe('USD');
  });

  it('new leads, listings and deals take the workspace currency', async () => {
    for (const [org, code, phone] of [[usd, 'USD', '9866600001'], [inr, 'INR', '9866600002']] as const) {
      const lead = (await t.lead(owner, org, { name: `Buyer ${code}`, phone, type: 'buyer', budget_max: 900000 })).lead_id;
      expect((await one<{ c: string }>(`select budget_currency c from public.leads where id = $1`, [lead])).c).toBe(code);
      const [{ id: prop }] = await t.as<{ id: string }>(owner, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, area_value, locality)
        values ($1, $2, 'Test home', 'apartment', 'sale', 'active', 900000, 1200, 'Mission') returning id`, [org, `CUR-${code}`]);
      expect((await one<{ c: string }>(`select currency c from public.properties where id = $1`, [prop])).c).toBe(code);
      const [{ id: deal }] = await t.as<{ id: string }>(owner, `insert into public.deals (organization_id, lead_id, primary_contact_id, title, stage, expected_value, owner_user_id)
        values ($1, $2, (select contact_id from public.leads where id = $2), 'Test deal', 'qualification', 900000, $3) returning id`, [org, lead, owner]);
      expect((await one<{ c: string }>(`select currency c from public.deals where id = $1`, [deal])).c).toBe(code);
    }
  });

  it('keeps a currency supplied by server code', async () => {
    const { rows: [{ id }] } = await t.db.query<{ id: string }>(`insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, currency, area_value, locality)
      values ($1, 'CUR-EUR', 'Euro listing', 'apartment', 'sale', 'active', 500000, 'EUR', 900, 'Mission') returning id`, [usd]);
    expect((await one<{ c: string }>(`select currency c from public.properties where id = $1`, [id])).c).toBe('EUR');
  });

  it('owners can change the workspace currency from the app', async () => {
    await t.as(owner, `update public.organizations set default_currency = 'CAD' where id = $1`, [usd]);
    expect((await one<{ c: string }>(`select default_currency c from public.organizations where id = $1`, [usd])).c).toBe('CAD');
  });
});
