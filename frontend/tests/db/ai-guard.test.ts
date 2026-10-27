import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

// Phase 2 (PRA-029 / PRA-030): user-triggered Claude calls are authorized and rate limited before the model is called.
let t: TestDb;
let A: string, B: string;
let ownerA: string, managerA: string, agentA: string, viewerA: string, financeA: string, ownerB: string, outsider: string;

const begin = (user: string, org: string, feature: string) =>
  t.as<{ r: { request_id: string; remaining_user_hour: number } }>(user, `select public.ai_request_begin($1, $2) r`, [org, feature]).then((x) => x[0].r);
const beginFails = async (user: string, org: string | null, feature: string) => (await t.fails(user, `select public.ai_request_begin($1, $2)`, [org, feature])).detail;

beforeAll(async () => {
  t = await createDb();
  ownerA = await t.user('Owner A');
  managerA = await t.user('Manager A');
  agentA = await t.user('Agent A');
  viewerA = await t.user('Viewer A');
  financeA = await t.user('Finance A');
  ownerB = await t.user('Owner B');
  outsider = await t.user('Outsider');
  A = await t.org(ownerA, 'Skyline Realty');
  B = await t.org(ownerB, 'Harbor Homes');
  await t.member(A, managerA, 'manager');
  await t.member(A, agentA, 'agent');
  await t.member(A, viewerA, 'viewer');
  await t.member(A, financeA, 'finance');
}, 120000);

describe('ai_request_begin', () => {
  it('records a started request for an authorized caller', async () => {
    const r = await begin(managerA, A, 'sales_analyst');
    expect(r.request_id).toMatch(/^[0-9a-f-]{36}$/);
    const [row] = await t.asService<{ organization_id: string; user_id: string; feature: string; status: string }>(
      `select organization_id, user_id, feature, status from public.ai_requests where id = $1`, [r.request_id]);
    expect(row).toEqual({ organization_id: A, user_id: managerA, feature: 'sales_analyst', status: 'started' });
  });

  it('checks the feature permission before anything is recorded', async () => {
    const before = (await t.asService<{ n: number }>(`select count(*)::int n from public.ai_requests`))[0].n;
    expect(await beginFails(viewerA, A, 'crm_enrichment')).toBe('FORBIDDEN'); // no leads.edit
    expect(await beginFails(viewerA, A, 'appointment_assistant')).toBe('FORBIDDEN'); // no appointments.edit
    expect(await beginFails(agentA, A, 'sales_recommendations')).toBe('FORBIDDEN'); // no reports.view
    expect(await beginFails(financeA, A, 'crm_enrichment')).toBe('FORBIDDEN');
    expect((await t.asService<{ n: number }>(`select count(*)::int n from public.ai_requests`))[0].n).toBe(before);
    await expect(begin(agentA, A, 'crm_enrichment')).resolves.toBeTruthy();
    await expect(begin(agentA, A, 'appointment_assistant')).resolves.toBeTruthy();
  });

  it('never trusts the organization id: other tenants and outsiders get NOT_FOUND', async () => {
    expect(await beginFails(ownerA, B, 'sales_analyst')).toBe('NOT_FOUND');
    expect(await beginFails(outsider, A, 'sales_analyst')).toBe('NOT_FOUND');
    expect(await beginFails(ownerA, null, 'sales_analyst')).toBe('NOT_FOUND');
    expect(await beginFails(ownerA, A, 'free_text_anything')).toBe('VALIDATION_ERROR');
  });

  it('suspended members lose access', async () => {
    const u = await t.user('Suspended Manager');
    await t.member(A, u, 'manager');
    await expect(begin(u, A, 'sales_analyst')).resolves.toBeTruthy();
    await t.db.query(`update public.organization_memberships set status = 'suspended' where user_id = $1`, [u]);
    expect(await beginFails(u, A, 'sales_analyst')).toBe('NOT_FOUND');
  });

  it('applies the per-user hourly limit per feature, counting failed calls too', async () => {
    const u = await t.user('Busy Manager');
    await t.member(A, u, 'manager');
    for (let i = 0; i < 10; i++) {
      const r = await begin(u, A, 'sales_recommendations');
      expect(r.remaining_user_hour).toBe(9 - i);
      if (i % 2) await t.as(u, `select public.ai_request_finish($1, 'model_error')`, [r.request_id]);
    }
    expect(await beginFails(u, A, 'sales_recommendations')).toBe('RATE_LIMITED');
    // Another feature and another user are unaffected.
    await expect(begin(u, A, 'sales_analyst')).resolves.toBeTruthy();
    await expect(begin(managerA, A, 'sales_recommendations')).resolves.toBeTruthy();
    // Requests older than an hour no longer count.
    await t.db.query(`update public.ai_requests set created_at = now() - interval '61 minutes' where user_id = $1 and feature = 'sales_recommendations'`, [u]);
    await expect(begin(u, A, 'sales_recommendations')).resolves.toBeTruthy();
  });

  it('applies the per-organization daily limit across users', async () => {
    const C = await t.org(ownerB, 'Daily Limit Agency');
    await t.db.query(
      `insert into public.ai_requests (organization_id, user_id, feature, created_at)
       select $1, $2, 'sales_analyst', now() - interval '2 hours' from generate_series(1, 1000)`, [C, ownerB]);
    expect(await beginFails(ownerB, C, 'appointment_assistant')).toBe('RATE_LIMITED');
    // Other organizations are unaffected.
    await expect(begin(ownerB, B, 'appointment_assistant')).resolves.toBeTruthy();
  });
});

describe('ai_request_finish', () => {
  it('only the requesting user can finish a request, once, with a known status', async () => {
    const r = await begin(managerA, A, 'sales_analyst');
    expect((await t.fails(managerA, `select public.ai_request_finish($1, 'success!')`, [r.request_id])).detail).toBe('VALIDATION_ERROR');
    expect((await t.as<{ ok: boolean }>(ownerA, `select public.ai_request_finish($1, 'ok') ok`, [r.request_id]))[0].ok).toBe(false);
    expect((await t.as<{ ok: boolean }>(ownerB, `select public.ai_request_finish($1, 'ok') ok`, [r.request_id]))[0].ok).toBe(false);
    expect((await t.as<{ ok: boolean }>(managerA, `select public.ai_request_finish($1, 'ok', 1234, 'claude-opus-5-5') ok`, [r.request_id]))[0].ok).toBe(true);
    expect((await t.as<{ ok: boolean }>(managerA, `select public.ai_request_finish($1, 'error') ok`, [r.request_id]))[0].ok).toBe(false);
    const [row] = await t.asService<{ status: string; duration_ms: number; model: string }>(`select status, duration_ms, model from public.ai_requests where id = $1`, [r.request_id]);
    expect(row).toEqual({ status: 'ok', duration_ms: 1234, model: 'claude-opus-5-5' });
  });
});

describe('ai_requests table', () => {
  it('is readable only with usage.view inside the organization and never writable by clients', async () => {
    expect((await t.as(ownerA, `select id from public.ai_requests where organization_id = $1`, [A])).length).toBeGreaterThan(0);
    expect(await t.as(agentA, `select id from public.ai_requests`)).toHaveLength(0);
    expect(await t.as(ownerA, `select id from public.ai_requests where organization_id = $1`, [B])).toHaveLength(0);
    expect(await t.asAnon(`select 1 from public.ai_requests`).catch((e) => e.message)).toMatch(/permission denied/);
    for (const sql of [
      `insert into public.ai_requests (organization_id, user_id, feature) values ('${A}', '${ownerA}', 'sales_analyst')`,
      `update public.ai_requests set status = 'ok'`,
      `delete from public.ai_requests`,
    ]) expect((await t.fails(ownerA, sql)).message).toMatch(/permission denied/);
  });

  it('the RPCs are not callable anonymously', async () => {
    expect(await t.asAnon(`select public.ai_request_begin($1, 'sales_analyst')`, [A]).catch((e) => e.message)).toMatch(/permission denied/);
  });
});
