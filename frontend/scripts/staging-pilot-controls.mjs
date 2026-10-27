// Staging check of the Phase 4 pilot controls through the real pg_cron chain: pausing Agent 03 for agency A holds A's new
// lead (event pending, no qualification) while agency B is processed; resuming qualifies A's lead once; a paused agent's
// AI feature is refused; the pilot overview is tenant-scoped. Same safety rules as staging-e2e.mjs.
// Usage (from frontend/): STAGING_PROJECT_REF=<ref> STAGING_TEST_PASSWORD=... node scripts/staging-pilot-controls.mjs
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const URL_ = env.VITE_SUPABASE_URL;
const REF = process.env.STAGING_PROJECT_REF;
const PW = process.env.STAGING_TEST_PASSWORD;
if (!REF || !PW || new URL(URL_).hostname !== `${REF}.supabase.co`) { console.error('Refusing to run: set STAGING_PROJECT_REF / STAGING_TEST_PASSWORD for the staging project.'); process.exit(2); }

let pass = 0, fail = 0;
const check = (id, name, ok, actual = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${actual ? ' — ' + String(actual).slice(0, 200) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs) { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeoutMs) return null; await sleep(5000); } }
async function login(email) {
  const sb = createClient(URL_, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await sb.auth.signInWithPassword({ email, password: PW });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return sb;
}
const tag = Date.now().toString(36);
const A = await login('e2e-a@estate-os.test');
const B = await login('e2e-b@estate-os.test');
const { data: orgA } = await A.from('organizations').select('id').eq('slug', 'e2e-realty-a').single();
const { data: orgB } = await B.from('organizations').select('id').eq('slug', 'e2e-realty-b').single();
const set = (sb, org, agent, paused, reason) => sb.rpc('agent_control_set', { p_org: org, p_agent: agent, p_paused: paused, p_reason: reason });
const qual = async (sb, lead) => (await sb.rpc('lead_qualification', { p_lead: lead })).data?.current ?? null;
const handoff = async (sb, lead) => (await sb.from('outbox_events').select('status').eq('record_id', lead).eq('event_type', 'lead.ready_for_qualification').maybeSingle()).data?.status;
const buyer = (n, email) => ({ name: n, email, type: 'buyer', intent: 'buy', locations: ['Worli'], budget_max: 30_000_000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months', source: 'Website' });

try {
  const { data: ov, error: ovErr } = await A.rpc('pilot_overview', { p_org: orgA.id, p_from: null, p_to: null });
  check('PC-01', 'pilot overview loads for the owner', !ovErr && ov?.controls?.length === 7, ovErr?.message ?? `${ov.intake.leads_created} leads in 7 days`);
  const { error: crossOv } = await B.rpc('pilot_overview', { p_org: orgA.id, p_from: null, p_to: null });
  check('PC-02', 'the other agency cannot read it', crossOv?.details === 'NOT_FOUND', crossOv?.details);
  const { error: crossSet } = await B.rpc('agent_control_set', { p_org: orgA.id, p_agent: 'sales_qualification_agent', p_paused: true, p_reason: 'cross tenant attempt' });
  check('PC-03', "the other agency cannot pause A's agents", crossSet?.details === 'NOT_FOUND', crossSet?.details);

  const { data: p1, error: p1Err } = await set(A, orgA.id, 'sales_qualification_agent', true, `Staging check ${tag}: hold qualification`);
  check('PC-04', 'owner pauses Agent 03 for agency A', !p1Err && p1?.paused === true, p1Err?.message ?? JSON.stringify(p1));
  const { data: secret } = await A.rpc('rotate_webhook_secret', { p_org: orgA.id });
  const { type: _type, ...webhookBuyer } = buyer(`STG Paused ${tag}`, `stg-${tag}-paused@example.com`); // `type` is a create_lead field, not a webhook field
  const body = JSON.stringify(webhookBuyer);
  const ts = String(Math.floor(Date.now() / 1000));
  const r = await fetch(`${URL_}/functions/v1/lead-intake?org=e2e-realty-a`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Estate-Event-Id': 'pc-' + randomUUID(),
    'X-Estate-Timestamp': ts, 'X-Estate-Signature': 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex') }, body });
  const leadA = (await r.json()).lead_id;
  check('PC-05', 'intake still captures the lead while qualification is paused', r.status === 201 && !!leadA, `HTTP ${r.status}`);
  const { data: lb } = await B.rpc('create_lead', { p_org: orgB.id, p_input: buyer(`STG Other ${tag}`, `stg-${tag}-other@example.com`), p_on_duplicate: 'create' });
  const qb = await waitFor(() => qual(B, lb.lead_id), 240_000);
  check('PC-06', 'agency B is qualified normally while A is paused', !!qb, qb ? qb.status : 'timeout');
  check('PC-07', "A's lead was held: no qualification, hand-off event still pending", (await qual(A, leadA)) === null && (await handoff(A, leadA)) === 'pending',
    `qualification ${(await qual(A, leadA))?.status ?? 'none'}, event ${await handoff(A, leadA)}`);

  await set(A, orgA.id, 'sales_intelligence_agent', true, `Staging check ${tag}: AI off`);
  const { error: aiErr } = await A.rpc('ai_request_begin', { p_org: orgA.id, p_feature: 'sales_analyst' });
  check('PC-08', "a paused agent's AI feature is refused", aiErr?.details === 'AGENT_PAUSED', aiErr?.details);
  await set(A, orgA.id, 'sales_intelligence_agent', false, `Staging check ${tag}: AI back on`);

  const { data: r1 } = await set(A, orgA.id, 'sales_qualification_agent', false, `Staging check ${tag}: resume`);
  check('PC-09', 'resume reports what it released', r1?.paused === false, JSON.stringify(r1));
  const qa = await waitFor(() => qual(A, leadA), 240_000);
  check('PC-10', "after resume A's held lead is qualified, once", !!qa && (await handoff(A, leadA)) === 'delivered', qa ? `${qa.status} ${qa.score}` : 'timeout');
  const { count: audits } = await A.from('audit_logs').select('id', { count: 'exact', head: true }).eq('organization_id', orgA.id).like('action', 'agent_controls.%');
  check('PC-11', 'pause and resume are in the audit log', (audits ?? 0) >= 4, String(audits));
} finally {
  for (const a of ['sales_qualification_agent', 'sales_intelligence_agent']) await set(A, orgA.id, a, false, `Staging check ${tag}: cleanup`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
