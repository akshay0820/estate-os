// Post-deployment smoke test. Safe for production: it signs in as two dedicated smoke users, each owning a dedicated
// smoke workspace, creates one tagged lead with an @example.com address and no phone, reads it back, waits for the cron
// chain, checks tenant denial, analytics, usage, health and kill-switch enforcement, and restores every control it changed.
// It never places a call, sends a message, books an appointment or triggers a payment.
//
// Usage (from frontend/, with .env.local or .env.production pointing at the target project):
//   SMOKE_PROJECT_REF=<ref> SMOKE_EMAIL_A=... SMOKE_EMAIL_B=... SMOKE_PASSWORD_A=... SMOKE_PASSWORD_B=... \
//   SMOKE_ORG_A=<slug> SMOKE_ORG_B=<slug> [SMOKE_SLUG_PREFIX=smoke-] node scripts/smoke.mjs [--env-file .env.production]
// Refuses to run unless the configured URL matches SMOKE_PROJECT_REF and both workspace slugs start with SMOKE_SLUG_PREFIX
// (default "smoke-"), so it can never act on a customer workspace.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envFile = process.argv.includes('--env-file') ? process.argv[process.argv.indexOf('--env-file') + 1] : '.env.local';
const env = Object.fromEntries(readFileSync(new URL(`../${envFile}`, import.meta.url), 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => l.split(/=(.*)/s).slice(0, 2).map((x) => x.trim())));
const E = process.env;
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const PREFIX = E.SMOKE_SLUG_PREFIX ?? 'smoke-';
for (const k of ['SMOKE_PROJECT_REF', 'SMOKE_EMAIL_A', 'SMOKE_EMAIL_B', 'SMOKE_PASSWORD_A', 'SMOKE_PASSWORD_B', 'SMOKE_ORG_A', 'SMOKE_ORG_B']) {
  if (!E[k]) { console.error(`Missing ${k}`); process.exit(2); }
}
if (new URL(URL_).hostname !== `${E.SMOKE_PROJECT_REF}.supabase.co`) { console.error('Refusing to run: the env file does not point at SMOKE_PROJECT_REF.'); process.exit(2); }
if (![E.SMOKE_ORG_A, E.SMOKE_ORG_B].every((s) => s.startsWith(PREFIX))) { console.error(`Refusing to run: smoke workspace slugs must start with "${PREFIX}".`); process.exit(2); }

let pass = 0, fail = 0, warn = 0;
const check = (id, name, ok, actual = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${actual ? ' — ' + String(actual).slice(0, 200) : ''}`); };
const note = (id, name, actual) => { warn++; console.log(`NOTE ${id} ${name} — ${actual}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(5000); } }
async function login(email, password) {
  const sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for the smoke user (${error.message})`);
  return { sb, token: data.session.access_token };
}
const tag = `SMOKE-${Date.now().toString(36).toUpperCase()}`;
const changed = [];

const h = await fetch(`${URL_}/functions/v1/health`);
const hb = await h.json().catch(() => ({}));
check('SM-01', 'platform health is ok', h.status === 200, `HTTP ${h.status} ${hb.status ?? ''}${h.status === 200 ? '' : ' — investigate with the HEALTH_TOKEN view before continuing the release'}`);

const A = await login(E.SMOKE_EMAIL_A, E.SMOKE_PASSWORD_A);
const B = await login(E.SMOKE_EMAIL_B, E.SMOKE_PASSWORD_B);
check('SM-02', 'smoke users sign in', !!A.token && !!B.token);
const { data: orgA } = await A.sb.from('organizations').select('id, name').eq('slug', E.SMOKE_ORG_A).maybeSingle();
const { data: orgB } = await B.sb.from('organizations').select('id').eq('slug', E.SMOKE_ORG_B).maybeSingle();
check('SM-03', 'each smoke user reads its own workspace', !!orgA && !!orgB);
if (!orgA || !orgB) {
  console.log(`
${pass} passed, ${fail} failed, ${warn} notes (${tag}) — stopped: a smoke workspace was not found (check SMOKE_ORG_A / SMOKE_ORG_B and ownership)`);
  process.exit(1);
}
const { data: crossOrg } = await B.sb.from('organizations').select('id').eq('id', orgA?.id ?? '00000000-0000-0000-0000-000000000000');
check('SM-04', "workspace B cannot read workspace A", (crossOrg ?? []).length === 0);

try {
  const { data: lead, error: leadErr } = await A.sb.rpc('create_lead', { p_org: orgA.id, p_input: { name: `${tag} Buyer`, email: `${tag.toLowerCase()}@example.com`, type: 'buyer',
    locations: ['Smoke Locality'], budget_max: 10_000_000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months', source: 'Smoke test' }, p_on_duplicate: 'create' });
  check('SM-05', 'lead creation', !leadErr && !!lead?.lead_id, leadErr?.message);
  const { data: back } = await A.sb.from('leads').select('id, organization_id').eq('id', lead?.lead_id).maybeSingle();
  check('SM-06', 'lead retrieval in the right workspace', back?.organization_id === orgA.id);
  const { data: crossLead } = await B.sb.from('leads').select('id').eq('id', lead?.lead_id);
  check('SM-07', 'workspace B cannot read the lead', (crossLead ?? []).length === 0);

  const q = await waitFor(async () => (await A.sb.rpc('lead_qualification', { p_lead: lead.lead_id })).data?.current ?? null, 240_000);
  check('SM-08', 'qualification ran through the cron chain', !!q, q ? `${q.status} ${q.score}` : 'timeout after 4 min');
  const m = q ? await waitFor(async () => (await A.sb.rpc('lead_property_matches', { p_lead: lead.lead_id })).data?.current ?? null, 180_000) : null;
  check('SM-09', 'property matching ran (no listings → an honest "no matches")', !!m, m ? `${m.status}, ${m.recommended_count} recommended` : 'timeout');

  const { data: ov, error: ovErr } = await A.sb.rpc('pilot_overview', { p_org: orgA.id, p_from: null, p_to: null });
  check('SM-10', 'operations overview (analytics) loads', !ovErr && ov?.intake?.leads_created >= 1, ovErr?.message);
  const { data: si, error: siErr } = await A.sb.rpc('si_query', { p_org: orgA.id, p_spec: { metric: 'leads_created', preset: 'today' }, p_log: false });
  check('SM-11', 'sales metrics compute', !siErr && si?.available !== false, siErr?.message);
  const { data: us, error: usErr } = await A.sb.rpc('ai_usage_summary', { p_org: orgA.id, p_from: null, p_to: null });
  check('SM-12', 'AI usage summary loads', !usErr && !!us?.by_agent, usErr?.message);
  const { error: crossOv } = await B.sb.rpc('pilot_overview', { p_org: orgA.id, p_from: null, p_to: null });
  check('SM-13', 'workspace B cannot read A analytics', crossOv?.details === 'NOT_FOUND', crossOv?.details);

  const vs = await fetch(`${URL_}/functions/v1/voice-calls/status`, { headers: { Authorization: `Bearer ${A.token}`, apikey: KEY } });
  const vj = await vs.json().catch(() => ({}));
  check('SM-14', 'integration status endpoint answers with booleans only', vs.status === 200 && Object.values(vj).every((v) => typeof v === 'boolean'), JSON.stringify(vj));

  const { data: before } = await A.sb.from('agent_controls').select('agent_id, paused').eq('organization_id', orgA.id).eq('agent_id', 'crm_data_agent').maybeSingle();
  if (!before?.paused) {
    const { error: pErr } = await A.sb.rpc('agent_control_set', { p_org: orgA.id, p_agent: 'crm_data_agent', p_paused: true, p_reason: `${tag} kill-switch check` });
    if (!pErr) changed.push('crm_data_agent');
    const { error: aiErr } = await A.sb.rpc('ai_request_begin', { p_org: orgA.id, p_feature: 'crm_enrichment' });
    check('SM-15', 'kill switch enforced by the server (paused agent refuses its AI feature)', aiErr?.details === 'AGENT_PAUSED', aiErr?.details ?? pErr?.message);
  } else note('SM-15', 'kill-switch check skipped', 'crm_data_agent is already paused in the smoke workspace');
} finally {
  for (const a of changed) {
    const { error } = await A.sb.rpc('agent_control_set', { p_org: orgA.id, p_agent: a, p_paused: false, p_reason: `${tag} restore after smoke test` });
    check('SM-16', `restored ${a}`, !error, error?.message);
  }
}
console.log(`\n${pass} passed, ${fail} failed, ${warn} notes (${tag})`);
process.exit(fail ? 1 : 0);
