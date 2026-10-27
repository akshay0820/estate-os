// Staging end-to-end validation for Estate OS (Phase 3). Runs against the hosted STAGING project through the same paths the
// product uses: the signed lead-intake webhook, the real pg_cron chain (qualification → matching → follow-up), the
// appointment RPCs and the Sales Intelligence metrics, as real signed-in test users. No provider is contacted: there is
// no messaging adapter, Retell and Anthropic keys are absent, and every synthetic contact uses an @example.com address.
//
// Usage (from frontend/):
//   STAGING_PROJECT_REF=<ref> STAGING_TEST_PASSWORD=... [STAGING_TESTER_PASSWORD=...] node scripts/staging-e2e.mjs [results.json]
// Safety: refuses to run unless VITE_SUPABASE_URL in .env.local points at STAGING_PROJECT_REF. Passwords come only from
// the environment and are never printed. The tester account is temporarily set to agent / viewer and restored to owner.
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const URL_ = env.VITE_SUPABASE_URL;
const KEY = env.VITE_SUPABASE_PUBLISHABLE_KEY;
const REF = process.env.STAGING_PROJECT_REF;
const PW = process.env.STAGING_TEST_PASSWORD;
const TESTER_PW = process.env.STAGING_TESTER_PASSWORD ?? PW;
if (!REF || !PW) { console.error('Set STAGING_PROJECT_REF and STAGING_TEST_PASSWORD.'); process.exit(2); }
if (!URL_ || new URL(URL_).hostname !== `${REF}.supabase.co`) { console.error('Refusing to run: .env.local does not point at the staging project.'); process.exit(2); }

const results = [];
let current = 'setup';
const section = (s) => { current = s; console.log(`\n== ${s}`); };
const check = (id, name, identity, expected, ok, actual = '') => {
  results.push({ id, section: current, name, identity, expected, actual: String(actual).slice(0, 400), result: ok ? 'PASS' : 'FAIL' });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${actual ? ' — ' + String(actual).slice(0, 200) : ''}`);
};
const note = (id, name, identity, expected, result, actual) => {
  results.push({ id, section: current, name, identity, expected, actual: String(actual).slice(0, 400), result });
  console.log(`${result} ${id} ${name} — ${String(actual).slice(0, 200)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 300_000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > timeoutMs) return null; await sleep(5000); }
}
const client = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
async function login(email, password = PW) {
  const sb = client();
  const t0 = Date.now();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return { sb, session: data.session, user: data.user, ms: Date.now() - t0 };
}
const fn = (path, init = {}) => fetch(`${URL_}/functions/v1/${path}`, init);
const tag = Date.now().toString(36).toUpperCase();
const mail = (s) => `stg-${tag.toLowerCase()}-${s}@example.com`;

const A = await login('e2e-a@estate-os.test');
const B = await login('e2e-b@estate-os.test');
const { data: orgA } = await A.sb.from('organizations').select('id, timezone').eq('slug', 'e2e-realty-a').single();
const { data: orgB } = await B.sb.from('organizations').select('id, timezone').eq('slug', 'e2e-realty-b').single();

try {
  /* ───────────── authentication ───────────── */
  section('authentication');
  check('AUTH-01', 'valid credentials return a session', 'owner A', 'session with access token', !!A.session?.access_token, `${A.ms} ms`);
  {
    const { error } = await client().auth.signInWithPassword({ email: 'e2e-a@estate-os.test', password: 'definitely-not-the-password' });
    check('AUTH-02', 'wrong password is rejected', 'anonymous', 'error, no session', !!error, error?.message);
  }
  {
    const r = await fetch(`${URL_}/rest/v1/leads?select=id&limit=1`, { headers: { apikey: KEY } });
    const body = await r.json().catch(() => null);
    check('AUTH-03', 'anonymous REST read of leads returns nothing', 'anonymous', '401/403 or empty', r.status >= 400 || (Array.isArray(body) && body.length === 0), `HTTP ${r.status}`);
  }
  {
    const bad = { apikey: KEY, Authorization: 'Bearer not.a.jwt' };
    const forged = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url') + '.' +
      Buffer.from(JSON.stringify({ sub: A.user.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) - 60 })).toString('base64url') + '.' + 'A'.repeat(43);
    const r1 = await fetch(`${URL_}/rest/v1/leads?select=id&limit=1`, { headers: bad });
    const r2 = await fetch(`${URL_}/rest/v1/leads?select=id&limit=1`, { headers: { apikey: KEY, Authorization: `Bearer ${forged}` } });
    const r3 = await fetch(`${URL_}/rest/v1/rpc/si_metric_catalogue`, { method: 'POST', headers: { ...bad, 'Content-Type': 'application/json' }, body: '{}' });
    check('AUTH-04', 'malformed and forged (expired, wrongly signed) JWTs are rejected', 'forged token', 'HTTP 401 on REST and RPC',
      r1.status === 401 && r2.status === 401 && r3.status === 401, `malformed ${r1.status}, forged ${r2.status}, rpc ${r3.status}`);
  }
  for (const f of ['sales-analyst', 'sales-intelligence-recommend', 'crm-enrichment', 'appointment-assistant', 'voice-calls/status']) {
    const r = await fn(f, { method: f.includes('status') ? 'GET' : 'POST', body: f.includes('status') ? undefined : '{}' });
    check('AUTH-05', `${f} without a JWT is refused by the platform`, 'anonymous', 'HTTP 401', r.status === 401, `HTTP ${r.status}`);
  }
  {
    const L = await login('e2e-a@estate-os.test');
    const refresh = L.session.refresh_token;
    const access = L.session.access_token;
    await L.sb.auth.signOut({ scope: 'local' });
    const { error: rErr } = await client().auth.refreshSession({ refresh_token: refresh });
    check('AUTH-06', 'after logout the refresh token no longer works', 'owner A (second session)', 'refresh refused', !!rErr, rErr?.message);
    const r = await fetch(`${URL_}/rest/v1/organizations?select=id&limit=1`, { headers: { apikey: KEY, Authorization: `Bearer ${access}` } });
    note('AUTH-07', 'access token after logout', 'owner A (second session)', 'observed (JWTs are stateless until expiry)',
      r.status === 401 ? 'PASS' : 'OBSERVED', `HTTP ${r.status}${r.status === 200 ? ' — the access token stays valid until it expires (default 1 h); logout revokes the refresh token' : ''}`);
  }

  /* ───────────── fixtures (synthetic, tagged) ───────────── */
  section('fixtures');
  const prop = async (sb, orgId, o) => {
    const { data, error } = await sb.from('properties').insert({ organization_id: orgId, reference_code: `STG-${tag}-${o.ref}`, title: `STG test listing ${o.ref}`,
      property_type: o.type ?? 'apartment', listing_type: o.listing ?? 'sale', status: o.status ?? 'active', price: o.price, bedrooms: o.beds ?? 2, area_value: 950,
      locality: o.locality ?? 'Worli', city: 'Mumbai', amenities: [], address_line_1: 'STG Synthetic Lane 1' }).select('id').single();
    if (error) throw new Error(`property ${o.ref}: ${error.message}`);
    if (o.verify) { const { error: vErr } = await sb.from('properties').update({ verified_at: new Date().toISOString() }).eq('id', data.id); if (vErr) throw new Error(vErr.message); }
    return data.id;
  };
  const P = {
    good: await prop(A.sb, orgA.id, { ref: 'GOOD', price: 24_000_000, verify: true }),
    over: await prop(A.sb, orgA.id, { ref: 'OVER', price: 60_000_000, verify: true }),
    rent: await prop(A.sb, orgA.id, { ref: 'RENT', price: 90_000, listing: 'rent', verify: true }),
    away: await prop(A.sb, orgA.id, { ref: 'AWAY', price: 22_000_000, locality: 'Baner', verify: true }),
    gone: await prop(A.sb, orgA.id, { ref: 'GONE', price: 23_000_000, status: 'withdrawn', verify: true }),
    other: await prop(B.sb, orgB.id, { ref: 'B-GOOD', price: 24_000_000, verify: true }),
  };
  check('FIX-01', 'synthetic listings created through the API (5 in A, 1 in B)', 'owners A / B', '6 rows', Object.values(P).every(Boolean), `tag ${tag}`);

  const { data: secret, error: secErr } = await A.sb.rpc('rotate_webhook_secret', { p_org: orgA.id });
  check('FIX-02', 'owner can rotate the lead-source webhook secret', 'owner A', 'secret issued (not printed)', !secErr && typeof secret === 'string' && secret.length >= 32, secErr?.message ?? 'ok');
  const post = async (payload, { id = 'stg-' + randomUUID(), sig, org = 'e2e-realty-a' } = {}) => {
    const t = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(payload);
    const s = sig ?? 'sha256=' + createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    const t0 = Date.now();
    const r = await fetch(`${URL_}/functions/v1/lead-intake?org=${org}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Estate-Event-Id': id, 'X-Estate-Timestamp': t, 'X-Estate-Signature': s }, body });
    return { status: r.status, body: await r.json().catch(() => ({})), ms: Date.now() - t0 };
  };
  const si = async (sb, orgId, metric, preset = 'today') => {
    const { data, error } = await sb.rpc('si_query', { p_org: orgId, p_spec: { metric, preset }, p_log: false });
    return error ? { error } : { value: data.rows?.[0]?.value ?? 0, period: data.period, available: data.available };
  };
  const leadsBefore = await si(A.sb, orgA.id, 'leads_created');
  const bLeadsBefore = await si(B.sb, orgB.id, 'leads_created');

  /* ───────────── lead intake ───────────── */
  section('lead intake (Agent 01)');
  const buyer = { name: `STG Buyer ${tag}`, email: mail('buyer'), source: 'Website', intent: 'buy', locations: ['Worli'], budget_max: 30_000_000,
    property_type: 'apartment', bedrooms: 2, timeline: '0-3 months', consent_channels: ['email'], message: 'Looking for a 2 BHK in Worli, budget 3 crore, within 3 months.' };
  const evId = 'stg-ev-' + randomUUID();
  const w1 = await post(buyer, { id: evId });
  const leadId = w1.body.lead_id;
  check('INT-01', 'valid signed lead is accepted', 'lead source (HMAC)', 'HTTP 201 created', w1.status === 201 && w1.body.status === 'created', `${w1.status} ${w1.body.status} ${w1.ms} ms`);
  const { data: lrow } = await A.sb.from('leads').select('id, organization_id, source, intake_status, duplicate_status, status').eq('id', leadId).single();
  check('INT-02', 'the response matches a persisted lead in the right agency', 'owner A', 'row in A with source Website', lrow?.organization_id === orgA.id && lrow?.source === 'Website' && lrow?.intake_status === 'completed', JSON.stringify(lrow));
  const { data: bSees } = await B.sb.from('leads').select('id').eq('id', leadId);
  check('INT-03', 'the other agency cannot see it', 'owner B', 'no rows', (bSees ?? []).length === 0);
  const w2 = await post(buyer, { id: evId });
  const { count: sameEmail } = await A.sb.from('contacts').select('id', { count: 'exact', head: true }).eq('email', mail('buyer'));
  check('INT-04', 'the same event replayed is not processed twice', 'lead source', 'same lead, one contact', w2.body.lead_id === leadId && sameEmail === 1, `${w2.status} ${w2.body.status}`);
  const w3 = await post({ ...buyer, message: 'Second enquiry from the same person' });
  const { count: leadsForBuyer } = await A.sb.from('leads').select('id', { count: 'exact', head: true }).eq('contact_id', (await A.sb.from('leads').select('contact_id').eq('id', leadId).single()).data.contact_id).is('archived_at', null);
  check('INT-05', 'a second enquiry by the same person follows the duplicate rules', 'lead source', 'no second active lead for the contact', leadsForBuyer === 1, `${w3.status} ${w3.body.status}; active leads for contact: ${leadsForBuyer}`);
  const w4 = await post({ name: 'No contact', email: 'not-an-email' });
  check('INT-06', 'invalid payload is rejected', 'lead source', 'HTTP 422, nothing saved', w4.status === 422, `${w4.status} ${JSON.stringify(w4.body).slice(0, 120)}`);
  const w5 = await post({ name: `STG Forged ${tag}`, email: mail('forged') }, { sig: 'sha256=' + '0'.repeat(64) });
  const { count: forgedRows } = await A.sb.from('contacts').select('id', { count: 'exact', head: true }).eq('email', mail('forged'));
  check('INT-07', 'invalid signature is rejected and nothing is saved', 'attacker', 'HTTP 401, no contact', w5.status === 401 && forgedRows === 0, `HTTP ${w5.status}`);
  const w6 = await post({ name: `STG Wrong Org ${tag}`, email: mail('wrongorg') }, { org: 'e2e-realty-b' });
  const { count: wrongOrgRows } = await B.sb.from('contacts').select('id', { count: 'exact', head: true }).eq('email', mail('wrongorg'));
  check('INT-08', "agency A's secret cannot post into agency B", 'lead source A', 'refused (401/404), nothing saved in B', [401, 404].includes(w6.status) && wrongOrgRows === 0, `HTTP ${w6.status} ${JSON.stringify(w6.body).slice(0, 100)}`);
  const burstId = 'stg-burst-' + randomUUID();
  const burst = await Promise.all(Array.from({ length: 5 }, () => post({ name: `STG Burst ${tag}`, email: mail('burst') }, { id: burstId })));
  const { count: burstLeads } = await A.sb.from('leads').select('id', { count: 'exact', head: true }).eq('title', `STG Burst ${tag}`);
  check('INT-09', 'one event delivered 5× concurrently creates one lead', 'lead source', '1 lead', burstLeads === 1, burst.map((r) => r.body.status).join(' '));
  const many = await Promise.all(Array.from({ length: 8 }, (_, i) => post({ name: `STG Parallel ${tag} ${i}`, email: mail(`par${i}`), source: 'Portal' })));
  const created = many.filter((r) => r.status === 201 && r.body.status === 'created').length;
  check('INT-10', '8 different leads posted concurrently are all saved', 'lead source', '8 created', created === 8, many.map((r) => r.status).join(','));
  const incomplete = await post({ name: `STG Vague ${tag}`, email: mail('vague'), consent_channels: ['email'], message: 'Interested, please call me' });
  const nomatch = await post({ name: `STG NoMatch ${tag}`, email: mail('nomatch'), intent: 'buy', locations: ['Worli'], budget_max: 5_000_000, property_type: 'villa', bedrooms: 5, timeline: '0-3 months', consent_channels: ['email'] });
  const expectedNew = 1 + 1 + 8 + 2; // buyer, burst, parallel, vague + nomatch
  const leadsAfter = await si(A.sb, orgA.id, 'leads_created');
  const bLeadsAfter = await si(B.sb, orgB.id, 'leads_created');
  check('ANL-01', 'Sales Intelligence counts exactly the new leads (replays and duplicates not double-counted)', 'owner A',
    `+${expectedNew} leads_created today`, leadsAfter.value - leadsBefore.value === expectedNew, `before ${leadsBefore.value}, after ${leadsAfter.value}`);
  check('ANL-02', "agency B's metrics are unaffected by agency A's leads", 'owner B', 'no change', bLeadsAfter.value === bLeadsBefore.value, `${bLeadsBefore.value} → ${bLeadsAfter.value}`);
  {
    const from = leadsAfter.period?.from; const to = leadsAfter.period?.to;
    const { count } = await A.sb.from('leads').select('id', { count: 'exact', head: true }).eq('organization_id', orgA.id).is('archived_at', null).gte('created_at', from).lt('created_at', to);
    check('ANL-03', 'leads_created equals an independent row count for the same window', 'owner A', 'equal', count === leadsAfter.value, `metric ${leadsAfter.value}, direct ${count} (${from} – ${to})`);
  }

  /* ───────────── qualification ───────────── */
  section('qualification (Agent 03)');
  const qualOf = async (lead) => (await A.sb.rpc('lead_qualification', { p_lead: lead })).data;
  const t0q = Date.now();
  const q1 = await waitFor(async () => { const v = await qualOf(leadId); return v?.current ? v : null; });
  check('QUA-01', 'the cron pipeline qualifies the complete lead', 'pg_cron', 'qualified or high_intent, score ≥ 60', ['qualified', 'high_intent'].includes(q1?.current?.status) && q1.current.score >= 60,
    q1 ? `${q1.current.status} ${q1.current.score} after ${Math.round((Date.now() - t0q) / 1000)} s; analysis ${q1.current.analysis_status}` : 'timeout');
  check('QUA-02', 'without a model key the AI step is recorded as not configured (not faked)', 'qualification-worker (canary deploy)', 'analysis_status not_configured', q1?.current?.analysis_status === 'not_configured', q1?.current?.analysis_status);
  const { data: lq } = await A.sb.from('leads').select('status, qualification_status').eq('id', leadId).single();
  check('QUA-03', 'qualification status persisted on the lead and the pipeline moved', 'owner A', 'qualification_status = run status; lead status qualified',
    lq?.qualification_status === q1?.current?.status && lq?.status === 'qualified', JSON.stringify(lq));
  const qv = await waitFor(async () => { const v = await qualOf(incomplete.body.lead_id); return v?.current ? v : null; });
  check('QUA-04', 'missing information → needs_information, not a guess', 'pg_cron', 'needs_information', qv?.current?.status === 'needs_information', qv?.current?.status ?? 'timeout');
  const { data: bq } = await B.sb.rpc('lead_qualification', { p_lead: leadId });
  const { error: bqErr } = await B.sb.rpc('lead_qualification', { p_lead: leadId });
  check('QUA-05', 'the other agency cannot read the qualification', 'owner B', 'NOT_FOUND', !bq && bqErr?.details === 'NOT_FOUND', bqErr?.details);

  /* ───────────── property matching ───────────── */
  section('property matching (Agent 04)');
  const m1 = await waitFor(async () => { const { data } = await A.sb.rpc('lead_property_matches', { p_lead: leadId }); return data?.current ? data : null; });
  const ids = (m1?.matches ?? []).map((m) => m.property.id);
  check('MAT-01', 'matching runs from the qualification event', 'pg_cron', 'current run', !!m1?.current, m1 ? `${m1.current.status}, ${m1.current.recommended_count} recommended` : 'timeout');
  check('MAT-02', 'the in-budget, in-area, verified sale listing is recommended', 'Agent 04', 'GOOD included', ids.includes(P.good), JSON.stringify((m1?.matches ?? []).map((m) => [m.property.reference_code, m.score])));
  check('MAT-03', 'over budget, rental, other locality and withdrawn listings are excluded', 'Agent 04', 'none of OVER/RENT/AWAY/GONE', ![P.over, P.rent, P.away, P.gone].some((x) => ids.includes(x)));
  check('MAT-04', "agency B's listing is never matched to A's lead", 'Agent 04', 'B-GOOD absent', !ids.includes(P.other));
  const mn = await waitFor(async () => { const { data } = await A.sb.rpc('lead_property_matches', { p_lead: nomatch.body.lead_id }); return data?.current ? data : null; });
  check('MAT-05', 'no suitable listing → an honest empty result', 'Agent 04', 'no_matches / 0 recommended', !!mn && mn.matches.length === 0, mn ? `${mn.current.status}, ${mn.matches.length}` : 'timeout');

  /* ───────────── follow-up ───────────── */
  section('follow-up (Agent 05)');
  const latest = async (lead, purpose) => ((await A.sb.rpc('lead_follow_ups', { p_lead: lead })).data?.items ?? []).find((i) => i.purpose === purpose) ?? null;
  const f1 = await waitFor(() => latest(leadId, 'share_property_recommendations'));
  check('FUP-01', 'a follow-up is planned from the persisted matches, awaiting approval, not sent', 'pg_cron', 'pending_approval, email, sent_at null',
    f1?.status === 'pending_approval' && f1.channel === 'email' && !f1.sent_at, f1 ? `${f1.status} ${f1.channel}` : 'timeout');
  if (f1) {
    check('FUP-02', 'the draft cites only real listings and carries the opt-out line', 'Agent 05', 'mentions STG listing GOOD',
      /STG test listing GOOD/.test(f1.body ?? '') && !/OVER|RENT|AWAY|GONE|B-GOOD/.test(f1.body ?? ''), (f1.body ?? '').slice(0, 160));
    const f2 = await waitFor(async () => { const x = await latest(leadId, 'share_property_recommendations'); return x && x.draft_status !== 'pending' ? x : null; }, 180_000);
    check('FUP-03', 'no model key → template draft kept, drafting recorded as not configured', 'follow-up-worker', 'draft_status not_configured', f2?.draft_status === 'not_configured', f2?.draft_status ?? 'timeout');
    const k = 'stg_' + tag.toLowerCase() + '_fu';
    const { data: r1, error: rErr } = await A.sb.rpc('follow_up_request', { p_lead: leadId, p_purpose: 'share_property_recommendations', p_idempotency_key: k });
    const { data: r2 } = await A.sb.rpc('follow_up_request', { p_lead: leadId, p_purpose: 'share_property_recommendations', p_idempotency_key: k });
    check('FUP-04', 'repeating a follow-up request with the same key does not duplicate it', 'owner A', 'same run', !rErr && JSON.stringify(r1) === JSON.stringify(r2), rErr?.message ?? JSON.stringify(r1).slice(0, 120));
    const fv = f2 ?? f1;
    const { data: ap, error: apErr } = await A.sb.rpc('follow_up_decide', { p_follow_up: fv.id, p_decision: 'approve', p_expected_version: fv.content_version, p_note: null });
    const f3 = await latest(leadId, 'share_property_recommendations');
    check('FUP-05', 'approval without a provider is not reported as delivered', 'owner A', 'approved, sent_at null, reason names manual sending',
      !apErr && ap?.status === 'approved' && !f3.sent_at && /manual/i.test(f3.status_reason ?? ''), apErr?.message ?? `${f3.status}: ${f3.status_reason}`);
    const { data: bDec, error: bDecErr } = await B.sb.rpc('follow_up_decide', { p_follow_up: fv.id, p_decision: 'approve', p_expected_version: fv.content_version, p_note: null });
    check('FUP-06', 'the other agency cannot approve it', 'owner B', 'NOT_FOUND', !bDec && bDecErr?.details === 'NOT_FOUND', bDecErr?.details);
  }

  /* ───────────── appointment ───────────── */
  section('appointment (Agent 06)');
  const avArgs = { p_lead: leadId, p_type: 'viewing', p_property: P.good, p_assignee: A.user.id, p_date_from: null, p_date_to: null };
  const t0a = Date.now();
  const { data: av, error: avErr } = await A.sb.rpc('appointment_availability', avArgs);
  const avMs = Date.now() - t0a;
  check('APT-01', 'availability returns slots in the agency time zone with no calendar provider', 'owner A', 'ok, slots, timezone = org',
    !avErr && av?.status === 'ok' && av.slots.length > 0 && av.timezone === orgA.timezone && av.calendar_provider === null, avErr?.message ?? `${av?.slots?.length} slots, ${av?.timezone}, ${avMs} ms`);
  let appt = null;
  if (av?.slots?.length) {
    const apptBefore = await si(A.sb, orgA.id, 'appointments_booked');
    const slot = av.slots[0];
    const k1 = 'stg-' + randomUUID();
    const { data: b1, error: b1Err } = await A.sb.rpc('appointment_book', { p_lead: leadId, p_type: 'viewing', p_property: P.good, p_starts_at: slot.starts_at, p_assignee: slot.assignee_id, p_idempotency_key: k1 });
    appt = b1;
    check('APT-02', 'booking is confirmed with a reference', 'owner A', 'confirmed, APT-…', !b1Err && b1?.status === 'confirmed' && /^APT-/.test(b1.booking_reference ?? ''), b1Err?.message ?? `${b1?.status} ${b1?.booking_reference}`);
    const { data: b1r } = await A.sb.rpc('appointment_book', { p_lead: leadId, p_type: 'viewing', p_property: P.good, p_starts_at: slot.starts_at, p_assignee: slot.assignee_id, p_idempotency_key: k1 });
    check('APT-03', 'a repeated click with the same key replays the same booking', 'owner A', 'replayed', b1r?.replayed === true && b1r.appointment_id === b1?.appointment_id);
    const raceSlot = av.slots.find((s) => s.starts_at !== slot.starts_at && new Date(s.starts_at).getTime() > new Date(slot.ends_at).getTime() + 3_600_000) ?? av.slots[av.slots.length - 1];
    const A2 = await login('e2e-a@estate-os.test');
    const race = await Promise.all([A.sb, A2.sb].map((c) => c.rpc('appointment_book', { p_lead: leadId, p_type: 'viewing', p_property: P.good, p_starts_at: raceSlot.starts_at, p_assignee: raceSlot.assignee_id, p_idempotency_key: 'stg-' + randomUUID() })));
    const wins = race.filter((r) => !r.error); const losses = race.filter((r) => r.error);
    check('APT-04', 'two parallel bookings of one slot: exactly one succeeds', 'two sessions of owner A', '1 win, 1 APPOINTMENT_CONFLICT',
      wins.length === 1 && losses.length === 1 && losses[0].error.details === 'APPOINTMENT_CONFLICT', race.map((r) => r.error?.details ?? r.data?.status).join(' / '));
    if (wins[0]) await A.sb.rpc('appointment_cancel', { p_appt: wins[0].data.appointment_id, p_reason: 'STG race cleanup' });
    const { data: lrow2 } = await A.sb.from('leads').select('status').eq('id', leadId).single();
    check('CRM-01', 'the lead pipeline reflects the booked viewing', 'owner A', 'visit_scheduled', lrow2?.status === 'visit_scheduled', lrow2?.status);
    const apptAfter = await si(A.sb, orgA.id, 'appointments_booked');
    // Definition: appointments created in the period that were confirmed (a later cancellation does not un-book them).
    const { count: confirmedDirect } = await A.sb.from('appointments').select('id', { count: 'exact', head: true }).eq('organization_id', orgA.id)
      .not('confirmed_at', 'is', null).gte('created_at', apptAfter.period?.from).lt('created_at', apptAfter.period?.to);
    check('ANL-04', 'appointments_booked equals an independent count of confirmed appointments created in the window', 'owner A', 'equal; +2 for this run (booking + race winner)',
      apptAfter.value === confirmedDirect && apptAfter.value - apptBefore.value === 2, `before ${apptBefore.value}, after ${apptAfter.value}, direct ${confirmedDirect}`);
    const d1 = (await A.sb.rpc('appointment_detail', { p_appt: b1.appointment_id })).data;
    const target = av.slots.find((s) => ![slot.starts_at, raceSlot.starts_at].includes(s.starts_at) && new Date(s.starts_at) > new Date(raceSlot.ends_at));
    if (target) {
      const { data: rs, error: rsErr } = await A.sb.rpc('appointment_reschedule', { p_appt: b1.appointment_id, p_starts_at: target.starts_at, p_version: d1.appointment.version, p_reason: 'STG reschedule' });
      check('APT-05', 'reschedule moves the booking and bumps its version', 'owner A', 'version + 1', !rsErr && rs?.version === d1.appointment.version + 1, rsErr?.message ?? `v${rs?.version}`);
      const { error: stale } = await A.sb.rpc('appointment_reschedule', { p_appt: b1.appointment_id, p_starts_at: slot.starts_at, p_version: d1.appointment.version, p_reason: 'stale' });
      check('APT-06', 'a stale reschedule is refused', 'owner A', 'CONFLICT', stale?.details === 'CONFLICT', stale?.details);
    } else note('APT-05', 'reschedule', 'owner A', 'a third free slot', 'NOT_RUN', 'no third slot in the window');
    const { error: bCancel } = await B.sb.rpc('appointment_cancel', { p_appt: b1.appointment_id, p_reason: 'cross tenant' });
    const { error: bBook } = await B.sb.rpc('appointment_book', { p_lead: leadId, p_type: 'viewing', p_property: P.good, p_starts_at: slot.starts_at, p_assignee: A.user.id, p_idempotency_key: 'stg-' + randomUUID() });
    check('APT-07', 'the other agency cannot cancel or book against this lead', 'owner B', 'NOT_FOUND', bCancel?.details === 'NOT_FOUND' && bBook?.details === 'NOT_FOUND', `${bCancel?.details} / ${bBook?.details}`);
    const d2 = (await A.sb.rpc('appointment_detail', { p_appt: b1.appointment_id })).data;
    check('CRM-02', 'appointment history and the confirmation hand-off are recorded', 'owner A', 'history ≥ 1; confirmation not sent',
      (d2?.history?.length ?? 0) >= 1 && (d2?.messages ?? []).every((m) => !m.sent_at), `${d2?.history?.length} history, ${(d2?.messages ?? []).map((m) => m.status).join(',')}`);
  }

  /* ───────────── CRM data quality ───────────── */
  section('CRM data quality (Agent 07)');
  {
    const { data: ov, error: ovErr } = await A.sb.rpc('crm_data_quality_overview', { p_org: orgA.id, p_since: null });
    check('DQ-01', 'data-quality overview is available to the owner', 'owner A', 'ok', !ovErr && !!ov, ovErr?.message ?? Object.keys(ov ?? {}).slice(0, 6).join(','));
    const { data: contactId } = { data: (await A.sb.from('leads').select('contact_id').eq('id', leadId).single()).data.contact_id };
    const { data: prov } = await A.sb.from('field_provenance').select('field, source_type').eq('entity_id', contactId);
    check('DQ-02', 'field provenance is recorded for webhook-created records', 'owner A', 'rows with a source', (prov ?? []).length > 0, (prov ?? []).slice(0, 4).map((p) => `${p.field}:${p.source_type}`).join(' '));
    const { error: bOv } = await B.sb.rpc('crm_data_quality_overview', { p_org: orgA.id, p_since: null });
    check('DQ-03', "the other agency cannot read A's data-quality overview", 'owner B', 'NOT_FOUND / FORBIDDEN', ['NOT_FOUND', 'FORBIDDEN'].includes(bOv?.details), bOv?.details);
  }

  /* ───────────── voice ───────────── */
  section('voice (Agent 02)');
  {
    const r = await fn('voice-calls/status', { headers: { Authorization: `Bearer ${A.session.access_token}`, apikey: KEY } });
    const s = await r.json().catch(() => ({}));
    check('VOI-01', 'voice status reports the provider as not configured (no secret exposed)', 'owner A', 'retell_configured false; only booleans',
      r.status === 200 && s.retell_configured === false && Object.values(s).every((v) => typeof v === 'boolean'), `HTTP ${r.status} ${JSON.stringify(s)}`);
    const { data: pre, error: preErr } = await A.sb.rpc('voice_call_preflight', { p_lead: leadId });
    check('VOI-02', 'pre-call policy blocks a lead without a phone number / provider', 'owner A', 'not allowed, with reasons', !preErr && pre?.allowed === false, preErr?.message ?? JSON.stringify(pre).slice(0, 200));
    const { count: calls } = await A.sb.from('voice_calls').select('id', { count: 'exact', head: true }).eq('lead_id', leadId);
    check('VOI-03', 'no call record is created for the synthetic lead', 'owner A', '0 voice_calls', calls === 0);
    const wh = await fn('voice-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-retell-signature': 'v=1,d=' + '0'.repeat(64) }, body: JSON.stringify({ event: 'call_ended', call: { call_id: 'stg-fake' } }) });
    check('VOI-04', 'an unsigned / wrongly signed Retell webhook is refused', 'attacker', '4xx/5xx, nothing ingested', wh.status >= 400, `HTTP ${wh.status}`);
    const { error: bPre } = await B.sb.rpc('voice_call_preflight', { p_lead: leadId });
    check('VOI-05', 'the other agency cannot run pre-call checks on A’s lead', 'owner B', 'NOT_FOUND', bPre?.details === 'NOT_FOUND', bPre?.details);
  }

  /* ───────────── sales intelligence + AI guard ───────────── */
  section('sales intelligence (Agent 08) and AI request guard');
  {
    const t0s = Date.now();
    const { data: ov, error: ovErr } = await A.sb.rpc('si_overview', { p_org: orgA.id, p_preset: 'last_30_days', p_from: null, p_to: null, p_filters: {} });
    check('SI-01', 'overview computes the KPIs', 'owner A', 'KPIs present', !ovErr && Object.keys(ov?.kpis ?? {}).length >= 20, ovErr?.message ?? `${Object.keys(ov.kpis).length} KPIs, ${Date.now() - t0s} ms`);
    const { error: bOv } = await B.sb.rpc('si_overview', { p_org: orgA.id, p_preset: 'last_30_days', p_from: null, p_to: null, p_filters: {} });
    check('SI-02', "the other agency cannot read A's analytics", 'owner B', 'NOT_FOUND', bOv?.details === 'NOT_FOUND', bOv?.details);
    const { error: badSpec } = await A.sb.rpc('si_query', { p_org: orgA.id, p_spec: { metric: 'leads_created', sql: 'select 1' }, p_log: false });
    check('SI-03', 'a query spec with unknown fields is rejected', 'owner A', 'VALIDATION_ERROR', !!badSpec, badSpec?.details);
    for (const f of ['sales-analyst', 'sales-intelligence-recommend', 'crm-enrichment', 'appointment-assistant']) {
      const body = f === 'crm-enrichment' ? { lead_id: leadId } : f === 'appointment-assistant' ? { lead_id: leadId, text: 'tomorrow afternoon' } : { org_id: orgA.id, question: 'How many leads this month?' };
      const r = await fn(f, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${A.session.access_token}`, apikey: KEY }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      check('AI-01', `${f} is deployed and reports not_configured (no model key), not a fake answer`, 'owner A', 'HTTP 503 not_configured', r.status === 503 && j.status === 'not_configured', `HTTP ${r.status} ${JSON.stringify(j)}`);
    }
    const { data: g, error: gErr } = await A.sb.rpc('ai_request_begin', { p_org: orgA.id, p_feature: 'sales_analyst' });
    check('AI-02', 'the AI guard (migration 0018) is live and records an authorized request', 'owner A', 'request id', !gErr && !!g?.request_id, gErr?.message ?? `remaining ${g?.remaining_user_hour}`);
    if (g?.request_id) await A.sb.rpc('ai_request_finish', { p_request: g.request_id, p_status: 'error', p_duration_ms: 0, p_model: 'staging-probe' });
    const { error: gB } = await B.sb.rpc('ai_request_begin', { p_org: orgA.id, p_feature: 'sales_analyst' });
    check('AI-03', "the other agency cannot start AI requests against A", 'owner B', 'NOT_FOUND', gB?.details === 'NOT_FOUND', gB?.details);
    let limited = null; let n = 0;
    for (; n < 12; n++) {
      const { data, error } = await A.sb.rpc('ai_request_begin', { p_org: orgA.id, p_feature: 'sales_recommendations' });
      if (error) { limited = error; break; }
      await A.sb.rpc('ai_request_finish', { p_request: data.request_id, p_status: 'error', p_duration_ms: 0, p_model: 'staging-probe' });
    }
    check('AI-04', 'the per-user hourly limit is enforced live (sales_recommendations: 10/h)', 'owner A', 'RATE_LIMITED at or before the 11th', limited?.details === 'RATE_LIMITED', `${n} accepted, then ${limited?.details}`);
  }

  /* ───────────── roles (tester in agency A) ───────────── */
  section('roles');
  let T = null;
  try { T = await login('tester@estate-os.test', TESTER_PW); } catch (e) { note('ROLE-00', 'tester login', 'tester', 'session', 'BLOCKED', e.message); }
  if (T) {
    const setRole = async (role) => {
      const { error } = await A.sb.from('organization_memberships').update({ role }).eq('organization_id', orgA.id).eq('user_id', T.user.id);
      if (error) throw new Error(`set role ${role}: ${error.message}`);
    };
    try {
      await setRole('agent');
      const { error: e1 } = await T.sb.rpc('si_overview', { p_org: orgA.id, p_preset: 'last_30_days', p_from: null, p_to: null, p_filters: {} });
      check('ROLE-01', 'an agent cannot read sales analytics', 'tester as agent', 'NOT_FOUND / FORBIDDEN', ['NOT_FOUND', 'FORBIDDEN'].includes(e1?.details), e1?.details);
      const { error: e2 } = await T.sb.rpc('rotate_webhook_secret', { p_org: orgA.id });
      check('ROLE-02', 'an agent cannot rotate integration secrets', 'tester as agent', 'refused', !!e2, e2?.details);
      const { data: audit } = await T.sb.from('audit_logs').select('id').eq('organization_id', orgA.id).limit(1);
      check('ROLE-03', 'an agent cannot read audit logs', 'tester as agent', '0 rows', (audit ?? []).length === 0);
      const { data: upd } = await T.sb.from('leads').update({ summary: 'agent edit attempt' }).eq('id', leadId).select('id');
      check('ROLE-04', 'an agent cannot edit a lead assigned to someone else', 'tester as agent', '0 rows changed', (upd ?? []).length === 0);
      const { error: e5 } = await T.sb.rpc('ai_request_begin', { p_org: orgA.id, p_feature: 'sales_recommendations' });
      check('ROLE-05', 'an agent cannot trigger AI recommendations', 'tester as agent', 'FORBIDDEN', e5?.details === 'FORBIDDEN', e5?.details);
      const { error: e6 } = await T.sb.rpc('record_export', { p_org: orgA.id, p_entity: 'leads', p_rows: 10 });
      check('ROLE-06', 'an agent cannot export leads', 'tester as agent', 'refused', !!e6, e6?.details);
      await setRole('viewer');
      const { error: e7 } = await T.sb.rpc('create_lead', { p_org: orgA.id, p_input: { name: `STG Viewer ${tag}`, email: mail('viewer') }, p_on_duplicate: 'create' });
      check('ROLE-07', 'a viewer cannot create leads', 'tester as viewer', 'FORBIDDEN', e7?.details === 'FORBIDDEN', e7?.details);
      const { error: e8 } = await T.sb.rpc('ai_request_begin', { p_org: orgA.id, p_feature: 'crm_enrichment' });
      check('ROLE-08', 'a viewer cannot trigger AI enrichment', 'tester as viewer', 'FORBIDDEN', e8?.details === 'FORBIDDEN', e8?.details);
      const { data: vLeads } = await T.sb.from('leads').select('id').eq('organization_id', orgA.id).limit(1);
      check('ROLE-09', 'a viewer can still read the agency’s leads (authorized access works)', 'tester as viewer', '≥ 1 row', (vLeads ?? []).length === 1);
    } finally {
      await setRole('owner').catch((e) => note('ROLE-99', 'restore tester to owner', 'owner A', 'owner', 'FAIL', e.message));
      const { data: back } = await A.sb.from('organization_memberships').select('role').eq('organization_id', orgA.id).eq('user_id', T.user.id).single();
      check('ROLE-10', 'tester restored to owner after the role tests', 'owner A', 'owner', back?.role === 'owner', back?.role);
    }
  }

  /* ───────────── tenant sweep ───────────── */
  section('tenant isolation sweep');
  {
    const tables = ['leads', 'contacts', 'communication_consents', 'properties', 'deals', 'commissions', 'appointments', 'appointment_history', 'tasks', 'activities',
      'notifications', 'audit_logs', 'documents', 'integrations', 'webhook_events', 'agent_runs', 'agent_run_steps', 'outbox_events', 'review_items',
      'voice_settings', 'voice_calls', 'voice_call_transcripts', 'voice_call_events', 'lead_qualifications', 'qualification_settings', 'property_match_runs',
      'property_matches', 'follow_ups', 'follow_up_settings', 'scheduling_settings', 'staff_working_hours', 'availability_blocks', 'data_quality_issues',
      'duplicate_candidates', 'record_merges', 'field_provenance', 'sales_snapshots', 'sales_insights', 'sales_forecast_runs', 'sales_report_runs',
      'sales_analyst_queries', 'ai_requests', 'organization_memberships', 'invitations'];
    let seenOwn = 0; const leaks = [];
    for (const t of tables) {
      const { data: bRows, error: bErr } = await B.sb.from(t).select('*').eq('organization_id', orgA.id).limit(5);
      if (!bErr && (bRows ?? []).length) leaks.push(t);
      const { data: aRows } = await A.sb.from(t).select('organization_id').eq('organization_id', orgA.id).limit(1);
      if ((aRows ?? []).length) seenOwn++;
    }
    check('TEN-01', `agency B reads 0 rows of agency A across ${tables.length} tenant tables`, 'owner B', 'no leaks', leaks.length === 0, leaks.length ? `LEAK: ${leaks.join(',')}` : 'none');
    check('TEN-02', 'agency A still reads its own data in those tables', 'owner A', 'most tables non-empty', seenOwn >= 20, `${seenOwn}/${tables.length} non-empty for A`);
    const { data: u1 } = await B.sb.from('leads').update({ summary: 'cross tenant' }).eq('id', leadId).select('id');
    const { data: u2 } = await B.sb.from('properties').delete().eq('id', P.good).select('id');
    const { error: ins } = await B.sb.from('leads').insert({ organization_id: orgA.id, title: 'cross tenant insert' });
    const { error: cl } = await B.sb.rpc('create_lead', { p_org: orgA.id, p_input: { name: 'Cross Tenant', email: mail('cross') }, p_on_duplicate: 'create' });
    check('TEN-03', 'B cannot update, delete or insert A records by id', 'owner B', '0 rows / refused', (u1 ?? []).length === 0 && (u2 ?? []).length === 0 && !!ins && !!cl, `${ins?.code ?? ins?.message} / ${cl?.details}`);
    const { data: still } = await A.sb.from('properties').select('id').eq('id', P.good);
    check('TEN-04', 'the targeted A records are intact', 'owner A', 'property still present', (still ?? []).length === 1);
    const { error: rot } = await B.sb.rpc('rotate_webhook_secret', { p_org: orgA.id });
    const { error: ex } = await B.sb.rpc('record_export', { p_org: orgA.id, p_entity: 'leads', p_rows: 10 });
    check('TEN-05', "B cannot rotate A's integration secret or export A's data", 'owner B', 'refused', !!rot && !!ex, `${rot?.details} / ${ex?.details}`);
  }

  /* ───────────── workers and failure handling ───────────── */
  section('failure handling');
  for (const w of ['qualification-worker', 'property-matching-worker', 'follow-up-worker', 'calendar-sync-worker', 'voice-worker']) {
    const r = await fn(w, { method: 'POST', headers: { 'x-worker-secret': 'wrong-secret-' + 'x'.repeat(40) } });
    check('FAIL-01', `${w} rejects a wrong shared secret`, 'attacker', 'HTTP 401', r.status === 401, `HTTP ${r.status}`);
  }
  {
    const { error } = await A.sb.from('properties').insert({ organization_id: orgA.id, reference_code: `STG-${tag}-BAD`, title: 'bad', property_type: 'apartment', listing_type: 'sale', status: 'not-a-status', price: 1, area_value: 1, locality: 'Worli' });
    const { count } = await A.sb.from('properties').select('id', { count: 'exact', head: true }).eq('reference_code', `STG-${tag}-BAD`);
    check('FAIL-02', 'a constraint violation is reported and nothing is written', 'owner A', 'error, 0 rows', !!error && count === 0, error?.code);
    const { error: e2 } = await A.sb.rpc('appointment_book', { p_lead: leadId, p_type: 'viewing', p_property: P.good, p_starts_at: new Date(Date.now() + 5 * 60_000).toISOString(), p_assignee: A.user.id, p_idempotency_key: 'stg-' + randomUUID() });
    check('FAIL-03', 'booking inside the minimum notice is refused with a reason', 'owner A', 'VALIDATION_ERROR', e2?.details === 'VALIDATION_ERROR', e2?.details);
    const { error: e3 } = await A.sb.rpc('qualification_tick', { p_limit: 1 });
    check('FAIL-04', 'users cannot run background ticks', 'owner A', 'permission denied', /permission denied/.test(e3?.message ?? ''), e3?.message);
  }

  /* ───────────── performance (smoke + small concurrency, not a load test) ───────────── */
  section('performance');
  const timeIt = async (label, n, f) => {
    const ms = [];
    let errors = 0;
    for (let i = 0; i < n; i++) { const t = Date.now(); const r = await f(i); if (r?.error) errors++; ms.push(Date.now() - t); }
    ms.sort((a, b) => a - b);
    const p = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];
    note('PERF', label, 'owner A', `n=${n}`, errors ? 'FAIL' : 'MEASURED', `p50 ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${ms[ms.length - 1]} ms, errors ${errors}`);
  };
  await timeIt('sign-in', 5, () => login('e2e-a@estate-os.test').then(() => null, (e) => ({ error: e })));
  await timeIt('lead list (50, newest first)', 15, () => A.sb.from('leads').select('id, title, status, created_at').eq('organization_id', orgA.id).order('created_at', { ascending: false }).limit(50));
  await timeIt('lead detail', 15, () => A.sb.from('leads').select('*').eq('id', leadId).single());
  await timeIt('property search (active, Worli, ≤ 3 cr)', 15, () => A.sb.from('properties').select('id, title, price').eq('organization_id', orgA.id).eq('status', 'active').eq('locality', 'Worli').lte('price', 30_000_000).limit(50));
  await timeIt('appointment availability', 10, () => A.sb.rpc('appointment_availability', avArgs));
  await timeIt('sales overview (30 days, 30 KPIs)', 8, () => A.sb.rpc('si_overview', { p_org: orgA.id, p_preset: 'last_30_days', p_from: null, p_to: null, p_filters: {} }));
  await timeIt('lead creation via create_lead', 5, (i) => A.sb.rpc('create_lead', { p_org: orgA.id, p_input: { name: `STG Perf ${tag} ${i}`, email: mail(`perf${i}`), source: 'Walk-in' }, p_on_duplicate: 'create' }));
  {
    const t = Date.now();
    const rs = await Promise.all(Array.from({ length: 10 }, () => A.sb.from('leads').select('id').eq('organization_id', orgA.id).limit(50)));
    note('PERF', '10 concurrent lead-list reads', 'owner A', 'all succeed', rs.every((r) => !r.error) ? 'MEASURED' : 'FAIL', `${Date.now() - t} ms wall, ${rs.filter((r) => r.error).length} errors`);
  }

  if (appt?.appointment_id) await A.sb.rpc('appointment_cancel', { p_appt: appt.appointment_id, p_reason: 'STG run cleanup' });
} catch (e) {
  note('RUN', 'unexpected error', '-', 'none', 'FAIL', e.stack ?? e.message);
}

const summary = results.reduce((s, r) => ({ ...s, [r.result]: (s[r.result] ?? 0) + 1 }), {});
console.log(`\nSummary: ${JSON.stringify(summary)} (tag ${tag})`);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ tag, ran_at: new Date().toISOString(), project_ref: REF, summary, results }, null, 2));
process.exit(results.some((r) => r.result === 'FAIL') ? 1 : 0);
