import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MATRIX } from '../src/lib/permissions';

// The UI hides actions using MATRIX; the database enforces role_permissions.
// They must describe the same capabilities or the UI will offer buttons that fail (or hide allowed ones).
describe('permission matrix', () => {
  it('matches the role_permissions seed in the foundation migration', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'supabase', 'migrations', '20261025000100_foundation.sql'), 'utf8');
    const db: Record<string, string[]> = {};
    for (const m of sql.matchAll(/\('(\w+)', array\[([^\]]+)\]\)/g)) db[m[1]] = [...m[2].matchAll(/'([\w.]+)'/g)].map((x) => x[1]).sort();
    const ui = Object.fromEntries(Object.entries(MATRIX).map(([r, caps]) => [r, [...caps].sort()]));
    expect(db).toEqual(ui);
  });
});
