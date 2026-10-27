import { describe, expect, it } from 'vitest';
import { healthResponse, sameSecret, type OpsHealth } from '../../supabase/functions/_shared/health';
import { authorizeWorker } from '../../supabase/functions/_shared/worker-auth';

const TOKEN = 'h'.repeat(40);
const ok: OpsHealth = { status: 'ok', reasons: [], checked_at: '2026-10-27T00:00:00Z', signals: { dead_letter_runs_24h: 0 } };
const body = async (r: Response) => JSON.parse(await r.text());

describe('health response', () => {
  it('public callers get only status and time; 200 when ok', async () => {
    const r = healthResponse({ data: ok, error: null, dbMs: 12, token: TOKEN, presented: null });
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(await body(r)).toEqual({ status: 'ok', checked_at: ok.checked_at });
  });
  it('the monitor token unlocks the signals; a wrong or short token does not', async () => {
    expect(await body(healthResponse({ data: ok, error: null, dbMs: 12, token: TOKEN, presented: TOKEN }))).toMatchObject({ signals: ok.signals, db_ms: 12 });
    expect(await body(healthResponse({ data: ok, error: null, dbMs: 12, token: TOKEN, presented: TOKEN.slice(0, -1) + 'x' }))).not.toHaveProperty('signals');
    expect(sameSecret('short', 'short')).toBe(false);
    expect(sameSecret(undefined, TOKEN)).toBe(false);
  });
  it('degraded is 503 so monitors alert on the status code', async () => {
    const r = healthResponse({ data: { ...ok, status: 'degraded', reasons: ['dead_letters'] }, error: null, dbMs: 5, token: TOKEN, presented: null });
    expect(r.status).toBe(503);
    expect(await body(r)).toEqual({ status: 'degraded', checked_at: ok.checked_at });
  });
  it('a database failure is "down" (503) and never echoes the error', async () => {
    const r = healthResponse({ data: null, error: { message: 'connection to 10.0.0.5 refused' }, dbMs: 5000, token: TOKEN, presented: TOKEN, now: () => new Date('2026-10-27T01:00:00Z') });
    expect(r.status).toBe(503);
    expect(await body(r)).toEqual({ status: 'down', checked_at: '2026-10-27T01:00:00.000Z' });
  });
});

describe('authorizeWorker (PRA-031)', () => {
  const client = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data, error }) });
  it('right secret → authorized; wrong secret → 401; check unavailable → 503, not 401', async () => {
    expect(await authorizeWorker(client(true) as never, 'w', 'x_secret_ok', 's')).toBeNull();
    expect((await authorizeWorker(client(false) as never, 'w', 'x_secret_ok', 's'))!.status).toBe(401);
    expect((await authorizeWorker(client(null) as never, 'w', 'x_secret_ok', null))!.status).toBe(401);
    expect((await authorizeWorker(client(null, { message: 'fetch failed', code: 'ECONNRESET' }) as never, 'w', 'x_secret_ok', 's'))!.status).toBe(503);
  });
});
