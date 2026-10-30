// Schema drift check. Builds a fresh database from supabase/migrations (the same way the tests do) and prints an md5
// fingerprint of every function in the public and private schemas. Run the SQL below on a real project (staging or
// production SQL editor), save its JSON output, and compare: any difference means the project and the repository
// disagree about a function — for example an edit made to an old copy of a function instead of a new migration.
//
// Carriage returns are ignored on both sides: a Windows checkout has CRLF line endings, git and the projects have LF.
//
// Usage (from frontend/):
//   npm run schema:fingerprint                         prints the repository's fingerprints as JSON
//   npm run schema:fingerprint -- --compare remote.json   compares with a project's fingerprints; exit 1 on drift
//
// SQL to run on the project (copy the single JSON value it returns into remote.json):
//   select jsonb_object_agg(p.oid::regprocedure::text, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) order by p.oid::regprocedure::text)
//   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
//   where n.nspname in ('public', 'private') and p.prokind = 'f';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', '..', 'supabase', 'migrations');
const SHIM = join(here, '..', 'tests', 'db', 'supabase-shim.sql');

const db = new PGlite();
await db.exec(readFileSync(SHIM, 'utf8'));
for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8').replace(/\r\n/g, '\n'));
}
const { rows } = await db.query(`select p.oid::regprocedure::text fn, md5(replace(pg_get_functiondef(p.oid), chr(13), '')) h
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private') and p.prokind = 'f' order by 1`);
const local = Object.fromEntries(rows.map((r) => [r.fn, r.h]));

const at = process.argv.indexOf('--compare');
if (at === -1) {
  console.log(JSON.stringify(local, null, 2));
  process.exit(0);
}
const remote = JSON.parse(readFileSync(process.argv[at + 1], 'utf8'));
const changed = Object.keys(local).filter((k) => k in remote && remote[k] !== local[k]);
const missing = Object.keys(local).filter((k) => !(k in remote));
const extra = Object.keys(remote).filter((k) => !(k in local));
for (const k of changed) console.log(`DIFFERENT  ${k}`);
for (const k of missing) console.log(`MISSING on the project  ${k}`);
for (const k of extra) console.log(`ONLY on the project  ${k}`);
console.log(`\n${Object.keys(local).length} functions in the repository: ${changed.length} different, ${missing.length} missing, ${extra.length} only on the project`);
process.exit(changed.length || missing.length || extra.length ? 1 : 0);
