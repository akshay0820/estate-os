import { describe, expect, it } from 'vitest';
import { createDb } from './harness';

describe('migrations', () => {
  it('apply cleanly', async () => {
    const t = await createDb();
    const rows = await t.db.query<{ n: number }>(`select count(*)::int n from pg_tables where schemaname = 'public'`);
    expect(rows.rows[0].n).toBeGreaterThan(10);
  }, 60000);
});
