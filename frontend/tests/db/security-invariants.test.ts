import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

// Phase 2: database-wide invariants, checked from the catalog so that a new table or function cannot silently skip them.
let t: TestDb;
let B: string, ownerA: string, ownerB: string, leadB: string, propB: string;

beforeAll(async () => {
  t = await createDb();
  ownerA = await t.user('Owner A');
  ownerB = await t.user('Owner B');
  await t.org(ownerA, 'Skyline Realty');
  B = await t.org(ownerB, 'Harbor Homes');
  leadB = (await t.lead(ownerB, B, { name: 'Omkar Patil', phone: '9850000002', source: 'Referral', notes: 'Wants a 3 BHK' })).lead_id;
  [{ id: propB }] = await t.as<{ id: string }>(ownerB, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, area_value, locality) values ($1, 'HH-1', '3 BHK in Baner', 'apartment', 'sale', 'active', 15500000, 1200, 'Baner') returning id`, [B]);
  await t.as(ownerB, `insert into public.tasks (organization_id, lead_id, title, due_at) values ($1, $2, 'Call back', now() + interval '1 day')`, [B, leadB]).catch(() => undefined);
  await t.as(ownerB, `select public.ai_request_begin($1, 'sales_analyst')`, [B]);
}, 120000);

describe('catalog invariants', () => {
  it('every public table has row level security enabled', async () => {
    const rows = await t.db.query<{ t: string }>(
      `select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`);
    expect(rows.rows.map((r) => r.t)).toEqual([]);
  });

  it('every SECURITY DEFINER function in public and private pins its search_path', async () => {
    const rows = await t.db.query<{ f: string }>(
      `select n.nspname || '.' || p.proname f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prosecdef
          and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(rows.rows.map((r) => r.f)).toEqual([]);
  });

  it('anon holds no table privileges and can execute no public function', async () => {
    const tables = await t.db.query<{ t: string }>(
      `select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
          and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
               or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))`);
    expect(tables.rows.map((r) => r.t)).toEqual([]);
    const fns = await t.db.query<{ f: string }>(
      `select p.proname f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(fns.rows.map((r) => r.f)).toEqual([]);
  });
});

describe('cross-tenant sweep', () => {
  it('a member of A reads no row of B from any table that carries organization_id', async () => {
    const tables = (await t.db.query<{ t: string }>(
      `select c.table_name t from information_schema.columns c join information_schema.tables x using (table_schema, table_name)
        where c.table_schema = 'public' and c.column_name = 'organization_id' and x.table_type = 'BASE TABLE' order by 1`)).rows.map((r) => r.t);
    expect(tables.length).toBeGreaterThan(40);
    let withData = 0;
    for (const table of tables) {
      const [{ n: total }] = await t.asService<{ n: number }>(`select count(*)::int n from public.${table} where organization_id = $1`, [B]);
      if (total > 0) withData++;
      const seen = await t.as(ownerA, `select 1 from public.${table} where organization_id = $1`, [B]).catch(() => []);
      expect(seen, table).toHaveLength(0);
    }
    // The fixture really puts B data in a spread of tables (leads, contacts, consents, activities, history, properties, …).
    expect(withData).toBeGreaterThanOrEqual(6);
  });

  it('indirect paths: A cannot reach B records through RPCs keyed by B ids', async () => {
    const cases: Array<[string, unknown[]]> = [
      [`select public.appointment_book($1, 'consultation', now() + interval '2 days', $2, 'iso-sweep-0001')`, [leadB, ownerA]],
      [`select public.qualification_request($1, 'iso-sweep-0002')`, [leadB]],
      [`select public.dq_propose_enrichment($1, '[]'::jsonb, 'm')`, [leadB]],
      [`select public.si_overview($1, 'last_30_days', null, null, '{}'::jsonb)`, [B]],
      [`select public.si_recommendation_context($1)`, [B]],
    ];
    for (const [sql, params] of cases) {
      const e = await t.fails(ownerA, sql, params);
      expect(['NOT_FOUND', 'FORBIDDEN'], sql).toContain(e.detail);
    }
    // Updates and deletes by id silently affect nothing.
    expect(await t.as(ownerA, `update public.properties set price = 1 where id = $1 returning id`, [propB])).toHaveLength(0);
    expect(await t.as(ownerA, `update public.leads set summary = 'x' where id = $1 returning id`, [leadB])).toHaveLength(0);
    expect(await t.as(ownerA, `delete from public.properties where id = $1 returning id`, [propB]).catch(() => [])).toHaveLength(0);
  });
});
