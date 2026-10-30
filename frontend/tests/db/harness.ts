import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const SHIM = join(__dirname, 'supabase-shim.sql');

export interface DbError {
  message: string;
  code?: string;
  detail?: string;
}

/**
 * A fresh database with the Supabase shim and every migration applied, plus helpers
 * to run statements as a specific signed-in user (role `authenticated`, RLS enforced).
 */
/** `currency` sets the default for new workspaces in this database (production default: USD, migration 0023). Suites
 *  that model Indian agencies (+91 phones, lakh budgets, Mumbai localities) ask for INR. */
export async function createDb(opts: { currency?: string } = {}) {
  const db = new PGlite();
  await db.exec(readFileSync(SHIM, 'utf8'));
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    } catch (e) {
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    }
  }
  if (opts.currency) await db.query(`alter table public.organizations alter column default_currency set default '${opts.currency.replace(/[^A-Z]/g, '')}'`);

  const asRole = async <T>(role: 'authenticated' | 'service_role' | 'anon', userId: string | null, fn: () => Promise<T>): Promise<T> => {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? '']);
    await db.exec(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await db.exec('reset role');
      await db.query(`select set_config('request.jwt.claim.sub', '', false)`);
    }
  };

  const api = {
    db,
    /** Create an auth user (as Supabase Auth would) and return its id. */
    async user(name: string, email = `${name.toLowerCase().replace(/\W+/g, '.')}@example.com`) {
      const id = randomUUID();
      await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, email, JSON.stringify({ full_name: name })]);
      return id;
    },
    /** Run SQL as a signed-in user. */
    as<T = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []) {
      return asRole('authenticated', userId, async () => (await db.query<T>(sql, params)).rows);
    },
    asService<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return asRole('service_role', null, async () => (await db.query<T>(sql, params)).rows);
    },
    asAnon<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return asRole('anon', null, async () => (await db.query<T>(sql, params)).rows);
    },
    /** Expect the statement to fail; returns the error for further assertions. */
    async fails(userId: string, sql: string, params: unknown[] = []): Promise<DbError> {
      try {
        await api.as(userId, sql, params);
      } catch (e) {
        return e as DbError;
      }
      throw new Error(`Expected failure but succeeded: ${sql}`);
    },
    /** Create an organization owned by `ownerId`. */
    async org(ownerId: string, name: string) {
      const [row] = await api.as<{ id: string }>(ownerId, `select public.create_organization($1, 'Mumbai') as id`, [name]);
      return row.id;
    },
    /** Add a member directly (test setup only — production uses invitations). */
    async member(orgId: string, userId: string, role: string, localities: string[] = []) {
      await db.query(`insert into public.organization_memberships (organization_id, user_id, role, localities) values ($1, $2, $3, $4)`, [orgId, userId, role, localities]);
    },
    async lead(userId: string, orgId: string, input: Record<string, unknown>, onDuplicate = 'create') {
      const [row] = await api.as<{ r: { status: string; lead_id: string; contact_id: string } }>(
        userId,
        `select public.create_lead($1, $2::jsonb, $3) as r`,
        [orgId, JSON.stringify(input), onDuplicate],
      );
      return row.r;
    },
  };
  return api;
}

export type TestDb = Awaited<ReturnType<typeof createDb>>;

/** A weekday at the given local hour (IST), at least `daysAhead` days from now. */
export function nextWeekdayAt(hourIst: number, daysAhead = 2) {
  const d = new Date(Date.now() + daysAhead * 864e5);
  while ([0].includes(new Date(d.getTime() + 5.5 * 3600e3).getUTCDay())) d.setTime(d.getTime() + 864e5);
  const ist = new Date(d.getTime() + 5.5 * 3600e3);
  const utc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hourIst, 0) - 5.5 * 3600e3;
  return new Date(utc);
}
