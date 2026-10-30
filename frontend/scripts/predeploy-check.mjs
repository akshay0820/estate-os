// Pre-deployment checks. Run from frontend/ after `npm run build`:
//   npm run predeploy                      repository and bundle checks (also run in CI)
//   npm run predeploy -- --env production  plus: the build must be labelled production and must not point at a
//                                          known non-production project (staging refs below or PREDEPLOY_NONPROD_REFS)
// Exits 1 on any failure. Prints no secret values.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FRONT = join(ROOT, 'frontend');
const MIG = join(ROOT, 'supabase', 'migrations');
const FN = join(ROOT, 'supabase', 'functions');
const KNOWN_NONPROD_REFS = ['jvdnapofyoarhfctbpyi', ...(process.env.PREDEPLOY_NONPROD_REFS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
const production = process.argv.includes('--env') && process.argv[process.argv.indexOf('--env') + 1] === 'production';

const failures = [];
const ok = (msg) => console.log(`ok    ${msg}`);
const fail = (msg) => { failures.push(msg); console.log(`FAIL  ${msg}`); };

// 1. Migrations: versioned names, strictly increasing, no destructive statements on data.
const files = readdirSync(MIG).filter((f) => f.endsWith('.sql'));
const bad = files.filter((f) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(f));
bad.length ? fail(`migration names not versioned: ${bad.join(', ')}`) : ok(`${files.length} migrations with versioned names`);
const versions = files.map((f) => f.slice(0, 14));
new Set(versions).size === versions.length && versions.every((v, i) => i === 0 || v > versions[i - 1])
  ? ok('migration versions unique and in order') : fail('migration versions duplicated or out of order');
let destructive = 0;
for (const f of files) {
  const sql = readFileSync(join(MIG, f), 'utf8').replace(/--.*$/gm, '');
  // Statement-level only: `revoke ... truncate on ...` grants are not truncates.
  const hits = [/^\s*drop\s+table\b/im, /\balter\s+table\b[^;]*\bdrop\s+column\b/i, /^\s*truncate\b/im, /\bdelete\s+from\s+public\.\w+\s*;/i].filter((re) => re.test(sql));
  if (hits.length) { destructive++; fail(`${f}: destructive statement (${hits.map(String).join(' ')}) — needs an explicit review`); }
}
if (!destructive) ok('no table drops, column drops, truncates or unfiltered deletes in migrations');

// 2. Edge Functions: every function declared in config.toml; one pinned supabase-js version everywhere.
const config = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
const fns = readdirSync(FN).filter((d) => d !== '_shared' && statSync(join(FN, d)).isDirectory());
const undeclared = fns.filter((d) => !config.includes(`[functions.${d}]`) || !existsSync(join(FN, d, 'index.ts')));
undeclared.length ? fail(`functions missing from config.toml or without index.ts: ${undeclared.join(', ')}`) : ok(`${fns.length} functions declared in config.toml`);
const pins = new Set();
const walk = (dir) => readdirSync(dir).flatMap((e) => (statSync(join(dir, e)).isDirectory() ? walk(join(dir, e)) : [join(dir, e)]));
for (const f of walk(FN).filter((p) => p.endsWith('.ts'))) for (const m of readFileSync(f, 'utf8').matchAll(/jsr:@supabase\/supabase-js@([^'"]+)/g)) pins.add(m[1]);
pins.size === 1 && /^\d+\.\d+\.\d+$/.test([...pins][0]) ? ok(`supabase-js pinned to ${[...pins][0]} in every function`) : fail(`supabase-js imports not pinned to one exact version: ${[...pins].join(', ')}`);

// 3. Built bundle: no server-side secrets or their names.
const dist = join(FRONT, 'dist');
if (!existsSync(dist)) fail('no dist/ — run `npm run build` first');
else {
  const leaks = [];
  for (const f of walk(dist).filter((p) => /\.(js|html|map)$/.test(p))) {
    const s = readFileSync(f, 'utf8');
    for (const [name, re] of [['service role key name', /SUPABASE_SERVICE_ROLE_KEY/], ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{10,}/], ['Anthropic key name', /ANTHROPIC_API_KEY/],
      ['Retell key name', /RETELL_API_KEY/], ['secret key', /sb_secret_[A-Za-z0-9_-]{10,}/], ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY/]]) {
      if (re.test(s)) leaks.push(`${name} in ${f.slice(dist.length + 1)}`);
    }
    for (const m of s.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
      try { if (JSON.parse(Buffer.from(m[1], 'base64url').toString()).role === 'service_role') leaks.push(`service-role JWT in ${f.slice(dist.length + 1)}`); } catch { /* not a JWT */ }
    }
  }
  leaks.length ? fail(`bundle contains server secrets: ${leaks.join('; ')}`) : ok('bundle contains no server-side secrets');

  // The Content-Security-Policy allows scripts from 'self' only: any inline <script> (with or without attributes) is blocked.
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1]) && m[2].trim());
  inline.length ? fail(`index.html has ${inline.length} inline script(s); the Content-Security-Policy blocks them — move them to a file in public/`) : ok('no inline scripts (the Content-Security-Policy allows scripts from the site only)');
}

/** The Content-Security-Policy's sources for one directive, from vercel.json. */
function cspSources(directive) {
  const headers = (JSON.parse(readFileSync(join(FRONT, 'vercel.json'), 'utf8')).headers ?? []).flatMap((h) => h.headers ?? []);
  const csp = headers.find((h) => h.key.toLowerCase() === 'content-security-policy')?.value ?? '';
  const part = csp.split(';').map((x) => x.trim().split(/\s+/)).find(([name]) => name === directive);
  return part ? part.slice(1) : [];
}
/** Whether a CSP source list allows a URL: exact origin, or a scheme://*.domain wildcard. */
function cspAllows(sources, url) {
  return sources.some((src) => {
    const m = src.match(/^(\w+):\/\/(\*\.)?([^/]+)$/);
    if (!m || `${m[1]}:` !== url.protocol) return false;
    return m[2] ? url.hostname.endsWith(`.${m[3]}`) : url.host === m[3];
  });
}

// 4. Production build target.
if (production) {
  const fileEnv = existsSync(join(FRONT, '.env.production'))
    ? Object.fromEntries(readFileSync(join(FRONT, '.env.production'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => l.split(/=(.*)/s).slice(0, 2).map((x) => x.trim().replace(/^(['"])(.*)$/, '$2'))))
    : {};
  const env = { ...fileEnv, ...process.env };
  (env.VITE_APP_ENV ?? '').toLowerCase() === 'production' ? ok('VITE_APP_ENV=production') : fail('VITE_APP_ENV is not "production" for a production build');
  let ref = null;
  try { ref = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0]; } catch { /* invalid */ }
  if (!ref) fail('VITE_SUPABASE_URL missing or invalid for the production build');
  else if (KNOWN_NONPROD_REFS.includes(ref)) fail(`VITE_SUPABASE_URL points at a non-production project (${ref})`);
  else ok(`production build targets project ${ref}`);
  // A custom Supabase domain (api.example.com) is not covered by https://*.supabase.co: the browser would block every request.
  if (ref) {
    const api = new URL(env.VITE_SUPABASE_URL);
    const realtime = new URL(api.href.replace(/^http/, 'ws'));
    const sources = cspSources('connect-src');
    cspAllows(sources, api) && cspAllows(sources, realtime)
      ? ok(`Content-Security-Policy connect-src allows ${api.host}`)
      : fail(`Content-Security-Policy connect-src in vercel.json does not allow ${api.protocol}//${api.host} and ${realtime.protocol}//${api.host}; add both`);
  }
  // The bundle is what ships: it must contain the production project and no non-production one (a stale dist/ fails here).
  if (ref && existsSync(dist)) {
    const js = walk(dist).filter((p) => p.endsWith('.js')).map((p) => readFileSync(p, 'utf8')).join('\n');
    const stale = KNOWN_NONPROD_REFS.filter((r) => js.includes(r));
    if (stale.length) fail(`dist/ was built against a non-production project (${stale.join(', ')}); rebuild for production`);
    else if (!js.includes(ref)) fail(`dist/ does not contain the production project ${ref}; rebuild with the production env`);
    else ok('dist/ was built for the production project');
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
