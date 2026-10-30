// Agent 05 — Follow-Up: planning from persisted state, the policy engine (consent, suppression, windows, frequency,
// human ownership), approval bound to content versions, manual and provider delivery states, safety triggers,
// drafting attach rules, and tenant isolation. No provider is called; nothing is ever reported as delivered.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let org: string, owner: string, manager: string, agent: string, viewer: string;
let orgB: string, ownerB: string;
let seq = 0;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const rows = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows;
const ftick = async () => (await t.asService<{ r: R }>(`select public.follow_up_tick(50) r`))[0].r;
const settle = async () => {
  await t.asService(`select public.qualification_tick(50)`);
  await t.asService(`select public.property_matching_tick(50)`);
  return ftick();
};
const fus = (lead: string) => rows<R>(`select * from public.follow_ups where lead_id = $1 order by created_at`, [lead]);
const active = (lead: string, purpose = 'share_property_recommendations') =>
  one(`select * from public.follow_ups where lead_id = $1 and purpose = $2 order by created_at desc limit 1`, [lead, purpose]);
const decide = (user: string, id: string, d: string, v: number | null, note: string | null = null) =>
  t.as<{ r: R }>(user, `select public.follow_up_decide($1, $2, $3, $4) r`, [id, d, v, note]).then((x) => x[0].r);
const markSent = (user: string, id: string, v: number) => t.as<{ r: R }>(user, `select public.follow_up_mark_sent($1, $2) r`, [id, v]).then((x) => x[0].r);
const events = (id: string, type: string) => rows(`select * from public.outbox_events where record_id = $1 and event_type = $2`, [id, type]);
const prop = async (o: R) => {
  const [{ id }] = await t.as<{ id: string }>(manager, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, bedrooms, area_value, locality, city)
    values ($1, $2, $3, 'apartment', 'sale', 'active', $4, 2, 900, $5, 'Mumbai') returning id`, [org, `F-${++seq}`, o.title, o.price ?? 28000000, o.locality ?? 'Worli']);
  if (o.verified !== false) await t.as(owner, `update public.properties set verified_at = now() where id = $1`, [id]);
  return id;
};
const buyer = (name: string, phoneTail: string, extra: R = {}) =>
  t.lead(manager, org, { name, phone: `98333${phoneTail}`, type: 'buyer', locations: ['Worli'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2,
    timeline: '0-3 months', consent_channels: ['whatsapp'], ...extra }).then((l) => l.lead_id as string);
const rulesSave = (rules: R) => t.as(owner, `select public.follow_up_settings_save($1, $2::jsonb)`, [org, JSON.stringify(rules)]);
const ALWAYS = { window: { start: 0, end: 24 }, human_cooldown_hours: 0 };

let pVerified: string, pUnverified: string;

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Aanya Kapoor');
  manager = await t.user('Priya Nair');
  agent = await t.user('Arjun Desai');
  viewer = await t.user('Vik Viewer');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, manager, 'manager');
  await t.member(org, agent, 'agent', ['Powai']);
  await t.member(org, viewer, 'viewer');
  ownerB = await t.user('Bina Bose');
  orgB = await t.org(ownerB, 'Other Agency');
  // Every day, all hours: tests must not depend on the wall clock. The window logic has its own test below.
  await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{business_hours,days}', '[0,1,2,3,4,5,6]') where id = $1`, [org]);
  await rulesSave(ALWAYS);
  pVerified = await prop({ title: 'Sea view 2 BHK Worli' });
  pUnverified = await prop({ title: 'Unverified 2 BHK Worli', price: 29000000, verified: false });
}, 120000);

describe('planning from Agent 04 matches', () => {
  let lead: string;

  it('drafts one grounded message for approval (verified listings only, opt-out line), never sends it, and ignores duplicate events', async () => {
    lead = await buyer('Ravi Menon', '00001');
    const res = await settle();
    expect(res.consumed).toBeGreaterThanOrEqual(1);
    const f = await active(lead);
    expect(f).toMatchObject({ kind: 'message', channel: 'whatsapp', consent_purpose: 'service', status: 'pending_approval', generated_by: 'template',
      draft_status: 'pending', trigger: 'property_matching.completed', sent_at: null, delivered_at: null });
    expect(f.property_ids).toEqual([pVerified]);
    expect(f.body).toContain('Hi Ravi, this is Skyline Realty.');
    expect(f.body).toContain('Sea view 2 BHK Worli, Worli – INR 28,000,000, 2 bed');
    expect(f.body).not.toContain('Unverified');
    expect(f.body.endsWith('Reply STOP to opt out.')).toBe(true);
    expect(await events(f.id, 'follow_up.human_review_required')).toHaveLength(1);
    expect((await one(`select status from public.outbox_events where record_id = $1 and event_type = 'property_matching.completed'`, [lead])).status).toBe('delivered');

    // Redelivered event and a re-run of matching do not stack another draft.
    await t.db.query(`update public.outbox_events set status = 'pending', locked_until = null where record_id = $1 and event_type = 'property_matching.completed'`, [lead]);
    await ftick();
    await t.as(manager, `select public.property_matching_request($1, 'rerun_key_001')`, [lead]);
    await settle();
    expect((await fus(lead)).filter((x) => x.purpose === 'share_property_recommendations')).toHaveLength(1);
  });

  it('approval is bound to the exact version; edits need re-approval; viewers and other roles cannot act', async () => {
    let f = await active(lead);
    expect((await t.fails(viewer, `select public.follow_up_decide($1, 'approve', $2)`, [f.id, f.content_version])).detail).toBe('FORBIDDEN');
    expect((await t.fails(manager, `select public.follow_up_decide($1, 'approve', $2)`, [f.id, f.content_version + 5])).detail).toBe('CONFLICT');
    const ed = await t.as<{ r: R }>(manager, `select public.follow_up_update_draft($1, null, $2) r`, [f.id, 'Hi Ravi, Sea view 2 BHK Worli in Worli is available to view this week. Interested?']);
    expect(ed[0].r).toMatchObject({ status: 'pending_approval', content_version: f.content_version + 1 });
    f = await active(lead);
    expect(f).toMatchObject({ generated_by: 'human', draft_status: 'not_requested' });
    expect(f.body.endsWith('Reply STOP to opt out.')).toBe(true); // opt-out line is re-appended by code
    expect((await t.fails(manager, `select public.follow_up_decide($1, 'approve', $2)`, [f.id, f.content_version - 1])).detail).toBe('CONFLICT');
    expect(await decide(manager, f.id, 'approve', f.content_version)).toMatchObject({ status: 'approved' });
    f = await active(lead);
    expect(f).toMatchObject({ approved_by: manager, approved_version: f.content_version, status_reason: 'No provider connected; send manually and mark as sent' });
    // An edit after approval clears the approval.
    await t.as(manager, `select public.follow_up_update_draft($1, null, $2)`, [f.id, f.body.replace('this week', 'soon')]);
    f = await active(lead);
    expect(f).toMatchObject({ status: 'pending_approval', approved_by: null, approved_version: null });
    await decide(manager, f.id, 'approve', f.content_version);
  });

  it('mark sent (manual) re-checks policy, records the exact text, shares the listing in Agent 04, and is never "delivered"', async () => {
    const f = await active(lead);
    expect((await t.fails(manager, `select public.follow_up_mark_sent($1, $2)`, [f.id, f.content_version - 1])).detail).toBe('CONFLICT');
    expect(await markSent(manager, f.id, f.content_version)).toEqual({ status: 'sent' });
    const s = await one(`select * from public.follow_ups where id = $1`, [f.id]);
    expect(s).toMatchObject({ status: 'sent', sent_via: 'manual', sent_by: manager, delivered_at: null });
    const act = await one(`select * from public.activities where lead_id = $1 and activity_type = 'message'`, [lead]);
    expect(act.title).toBe('Follow-up sent via whatsapp (sent by a person)');
    expect(act.description).toBe(s.body);
    expect((await one(`select m.status from public.property_matches m join public.property_match_runs r on r.id = m.match_run_id and r.is_current where m.lead_id = $1 and m.property_id = $2`, [lead, pVerified])).status).toBe('shared');
    expect((await one(`select status from public.leads where id = $1`, [lead])).status).toBe('matching');
    expect(await events(f.id, 'follow_up.sent')).toHaveLength(1);
    expect(await rows(`select 1 from public.outbox_events where event_type = 'follow_up.delivered'`)).toHaveLength(0);
    expect((await t.fails(manager, `select public.follow_up_mark_sent($1, $2)`, [f.id, s.content_version])).detail).toBe('CONFLICT');
  });

  it('no channel with consent → a task for a person instead of a message (once)', async () => {
    const l = await buyer('Neha Rao', '00002', { consent_channels: [] });
    await settle();
    const f = await active(l);
    expect(f).toMatchObject({ kind: 'task', channel: 'task', status: 'handed_off', body: null });
    const tasks = await rows<R>(`select title, description from public.tasks where related_lead_id = $1 and title like 'Share matched listings%'`, [l]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toContain('Sea view 2 BHK Worli');
    expect(f.task_id).toBeTruthy();
  });
});

describe('policy enforcement at every step', () => {
  it('consent revoked after drafting suppresses it synchronously; do-not-contact suppresses approved messages', async () => {
    const l1 = await buyer('Opt Out', '00003');
    await settle();
    const f1 = await active(l1);
    const contact = (await one(`select contact_id from public.leads where id = $1`, [l1])).contact_id;
    await t.as(manager, `select public.set_contact_consent($1, 'whatsapp', 'revoked', 'Asked to stop')`, [contact]);
    expect(await one(`select status, status_reason from public.follow_ups where id = $1`, [f1.id])).toEqual({ status: 'suppressed', status_reason: 'Whatsapp consent revoked' });
    expect((await t.fails(manager, `select public.follow_up_mark_sent($1, $2)`, [f1.id, f1.content_version])).detail).toBe('CONFLICT');

    const l2 = await buyer('Dnc Person', '00004');
    await settle();
    const f2 = await active(l2);
    await decide(manager, f2.id, 'approve', f2.content_version);
    const c2 = (await one(`select contact_id from public.leads where id = $1`, [l2])).contact_id;
    await t.as(manager, `update public.contacts set lifecycle_status = 'do_not_contact' where id = $1`, [c2]);
    expect((await one(`select status from public.follow_ups where id = $1`, [f2.id])).status).toBe('suppressed');
  });

  it('kill switch and window are re-checked at send time; frequency and unanswered limits apply', async () => {
    const l = await buyer('Window Person', '00005');
    await settle();
    let f = await active(l);
    await decide(manager, f.id, 'approve', f.content_version);
    // Outside the messaging window → refused with the earliest time, nothing recorded as sent.
    const hourIst = (new Date().getUTCHours() + 5 + (new Date().getUTCMinutes() >= 30 ? 1 : 0)) % 24;
    const start = (hourIst + 2) % 22;
    await rulesSave({ ...ALWAYS, window: { start, end: start + 1 } });
    expect((await t.fails(manager, `select public.follow_up_mark_sent($1, $2)`, [f.id, f.content_version])).detail).toBe('POLICY_DEFERRED');
    await rulesSave(ALWAYS);
    // Kill switch → suppressed at send time.
    await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{outbound_paused}', 'true') where id = $1`, [org]);
    expect((await markSent(manager, f.id, f.content_version)).status).toBe('suppressed');
    await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{outbound_paused}', 'false') where id = $1`, [org]);

    // Minimum gap: after one sent message, the next one is deferred.
    const l2 = await buyer('Gap Person', '00006');
    await settle();
    f = await active(l2);
    await decide(manager, f.id, 'approve', f.content_version);
    await markSent(manager, f.id, f.content_version);
    // A new matching run (share follow-ups are idempotent per run), with the listing offered again.
    await t.as(manager, `select public.property_matching_request($1, 'rematch_key_01')`, [l2]);
    await settle();
    await t.db.query(`update public.property_matches set status = 'recommended' where lead_id = $1`, [l2]);
    await t.as(manager, `select public.follow_up_request($1, 'share_property_recommendations', 'again_key_01')`, [l2]);
    await ftick();
    f = await active(l2);
    expect(f.status).toBe('pending_approval');
    expect(new Date(f.scheduled_for).getTime()).toBeGreaterThan(Date.now() + 47 * 3600e3);
    // Approval is allowed (deferred, not blocked), but sending now is not.
    expect(await decide(manager, f.id, 'approve', f.content_version)).toMatchObject({ status: 'approved' });
    const ap = await one(`select status, content_version from public.follow_ups where id = $1`, [f.id]);
    expect((await t.fails(manager, `select public.follow_up_mark_sent($1, $2)`, [f.id, ap.content_version])).message).toMatch(/Minimum gap/);

    // Unanswered limit: with max 1 unanswered, the next draft is suppressed at planning.
    await rulesSave({ ...ALWAYS, max_unanswered: 1, min_hours_between: 1 });
    await decide(manager, f.id, 'cancel', null);
    await t.as(manager, `select public.property_matching_request($1, 'rematch_key_02')`, [l2]);
    await settle();
    await t.db.query(`update public.property_matches set status = 'recommended' where lead_id = $1`, [l2]);
    await t.as(manager, `select public.follow_up_request($1, 'share_property_recommendations', 'again_key_02')`, [l2]);
    await ftick();
    f = await active(l2);
    expect(f.status).toBe('suppressed');
    expect(f.status_reason).toContain('Unanswered follow-up limit');
    await rulesSave(ALWAYS);
  });

  it('a listing that stops being shareable cancels the unsent message', async () => {
    const pid = await prop({ title: 'Will be withdrawn', price: 27000000, locality: 'Prabhadevi' });
    const l = await t.lead(manager, org, { name: 'Withdrawn Case', phone: '9833300007', type: 'buyer', locations: ['Prabhadevi'], budget_max: 30000000,
      property_type: 'apartment', bedrooms: 2, timeline: '0-3 months', consent_channels: ['whatsapp'] }).then((x) => x.lead_id as string);
    await settle();
    const f = await active(l);
    expect(f.property_ids).toEqual([pid]);
    await decide(manager, f.id, 'approve', f.content_version);
    await t.as(manager, `update public.properties set status = 'withdrawn' where id = $1`, [pid]);
    expect(await one(`select status, status_reason from public.follow_ups where id = $1`, [f.id])).toEqual({ status: 'cancelled', status_reason: 'A listing in this message is no longer shareable (invalidated)' });
  });

  it('closing the lead cancels pending follow-ups; drafts expire', async () => {
    const l = await buyer('Closing Lead', '00008');
    await settle();
    const f = await active(l);
    await t.db.query(`update public.leads set status = 'lost', lost_reason = 'Bought elsewhere' where id = $1`, [l]);
    expect((await one(`select status from public.follow_ups where id = $1`, [f.id])).status).toBe('cancelled');

    const l2 = await buyer('Expiring Lead', '00009');
    await settle();
    const f2 = await active(l2);
    await t.db.query(`update public.follow_ups set updated_at = now() - interval '80 hours' where id = $1`, [f2.id]);
    await t.db.query(`alter table public.follow_ups disable trigger follow_ups_updated_at`);
    await t.db.query(`update public.follow_ups set updated_at = now() - interval '80 hours' where id = $1`, [f2.id]);
    await t.db.query(`alter table public.follow_ups enable trigger follow_ups_updated_at`);
    await ftick();
    expect((await one(`select status from public.follow_ups where id = $1`, [f2.id])).status).toBe('expired');
  });

  it('the messaging window rolls to the next allowed day in the org time zone, including DST', async () => {
    const nw = async (tz: string, days: unknown, at: string) =>
      (await one<{ t: Date }>(`select private.fu_next_window($1, $2::jsonb, '{"start": 9, "end": 20}'::jsonb, $3::timestamptz) t`, [tz, JSON.stringify(days), at])).t.toISOString();
    expect(await nw('Asia/Kolkata', [1, 2, 3, 4, 5, 6], '2026-11-01T04:30:00Z')).toBe('2026-11-02T03:30:00.000Z'); // Sun 10:00 IST → Mon 09:00 IST
    expect(await nw('Asia/Kolkata', [1, 2, 3, 4, 5, 6], '2026-11-02T15:30:00Z')).toBe('2026-11-03T03:30:00.000Z'); // Mon 21:00 → Tue 09:00
    expect(await nw('Asia/Kolkata', [1, 2, 3, 4, 5, 6], '2026-11-02T05:00:00Z')).toBe('2026-11-02T05:00:00.000Z'); // inside
    expect(await nw('Europe/London', [0, 1, 2, 3, 4, 5, 6], '2026-03-29T06:00:00Z')).toBe('2026-03-29T08:00:00.000Z'); // DST day: 09:00 BST
  });
});

describe('other triggers', () => {
  it('missing information → at most max_questions, only for fields still missing', async () => {
    const l = await t.lead(manager, org, { name: 'Bare Buyer', phone: '9833300010', type: 'buyer', timeline: '0-3 months', consent_channels: ['whatsapp'] }).then((x) => x.lead_id as string);
    await settle();
    expect((await one(`select consumer, status from public.outbox_events where record_id = $1 and event_type = 'lead.qualification.needs_information' and consumer = 'follow_up_agent'`, [l]))).toMatchObject({ status: 'delivered' });
    const f = await active(l, 'clarify_requirements');
    expect(f).toMatchObject({ status: 'pending_approval', channel: 'whatsapp' });
    expect(f.body).toContain('1. Which areas would you prefer?');
    expect(f.body).toContain('2. What approximate budget do you have in mind?');
    expect(f.body).not.toContain('3.');
    expect(f.body).not.toMatch(/When are you hoping to buy/);
  });

  it('call with unanswered questions → a task (no message); a call-back request pauses automation and links Agent 02 task', async () => {
    const l = await buyer('Caller Person', '00011');
    await settle();
    const pending = await active(l);
    expect(pending.status).toBe('pending_approval');
    const c = (await one(`select contact_id from public.leads where id = $1`, [l])).contact_id;
    const call = (await one(`insert into public.voice_calls (organization_id, lead_id, contact_id, direction, status, idempotency_key, initiated_by, ended_at, outcome, analysis)
      values ($1, $2, $3, 'outbound', 'completed', 'test_call_0011', 'user', now(), 'connected', '{"unanswered_questions": ["Is there covered parking?", "What is the maintenance fee?"]}') returning id`, [org, l, c])).id;
    await t.db.query(`select private.emit_event($1, 'voice_call.completed', 'voice_call', $2, null, $3, 'sales_qualification_agent', $4)`,
      [org, call, JSON.stringify({ lead_id: l, call_id: call }), `voice_call_completed:${call}`]);
    await ftick();
    const q = await active(l, 'answer_call_questions');
    expect(q).toMatchObject({ kind: 'task', status: 'handed_off', call_id: call });
    expect((await one(`select description from public.tasks where id = $1`, [q.task_id])).description).toContain('Is there covered parking?');

    // Agent 02 handoff: call-back task + published event → pending message cancelled, task linked, new drafts blocked.
    const task = (await one(`insert into public.tasks (organization_id, title, description, priority, due_at, related_lead_id, source) values ($1, 'Call back Caller Person (requested on AI call)', 'x', 'high', now() + interval '2 hours', $2, 'ai') returning id`, [org, l])).id;
    await t.db.query(`select private.emit_event($1, 'voice_call.human_handoff_requested', 'voice_call', $2, null, $3, null, $4)`,
      [org, call, JSON.stringify({ call_id: call, lead_id: l, kind: 'callback_requested' }), `voice_handoff:${call}`]);
    await ftick();
    expect((await one(`select status, status_reason from public.follow_ups where id = $1`, [pending.id]))).toEqual({ status: 'cancelled', status_reason: 'The prospect asked for a person; automated messages paused' });
    expect(await active(l, 'callback_request')).toMatchObject({ kind: 'task', status: 'handed_off', task_id: task });
    // While the call-back is open, every channel is blocked for automated messages.
    const [{ r: view }] = await t.as<{ r: R }>(manager, `select public.lead_follow_ups($1) r`, [l]);
    expect(view.channels.whatsapp.policy).toMatchObject({ allowed: false, blocked: true });
    expect(view.channels.whatsapp.policy.failed).toContain('No open call-back for a person');
  });

  it('an opt-out event stops pending messages for the contact', async () => {
    const l = await buyer('Event Optout', '00012');
    await settle();
    const f = await active(l);
    const c = (await one(`select contact_id from public.leads where id = $1`, [l])).contact_id;
    await t.db.query(`select private.emit_event($1, 'lead.communication_opted_out', 'contact', $2, null, $3, null, $4)`,
      [org, c, JSON.stringify({ contact_id: c, lead_id: l, channel: 'phone', source: 'test' }), `optout_test_${c}`]);
    await ftick();
    expect((await one(`select status from public.follow_ups where id = $1`, [f.id])).status).toBe('suppressed');
  });

  it('re-engagement is off by default and needs marketing consent when enabled', async () => {
    const l = await buyer('Quiet Lead', '00013', { budget_max: null, locations: [] });
    await t.db.query(`update public.leads set status = 'nurture' where id = $1`, [l]);
    await t.db.query(`alter table public.leads disable trigger user`);
    await t.db.query(`update public.leads set updated_at = now() - interval '90 days', created_at = now() - interval '90 days' where id = $1`, [l]);
    await t.db.query(`alter table public.leads enable trigger user`);
    await t.db.query(`delete from public.follow_ups where lead_id = $1`, [l]);
    await ftick();
    expect(await rows(`select 1 from public.follow_ups where lead_id = $1 and purpose = 're_engagement'`, [l])).toHaveLength(0);
    await rulesSave({ ...ALWAYS, use_cases: { re_engagement: true, share_property_recommendations: true, clarify_requirements: true, answer_call_questions: true } });
    await ftick();
    await ftick();
    expect(await rows(`select 1 from public.follow_ups where lead_id = $1 and purpose = 're_engagement'`, [l])).toHaveLength(0); // service consent ≠ marketing
    const c = (await one(`select contact_id from public.leads where id = $1`, [l])).contact_id;
    await t.db.query(`insert into public.communication_consents (organization_id, contact_id, channel, purpose, status, captured_via) values ($1, $2, 'whatsapp', 'marketing', 'granted', 'test')`, [org, c]);
    await t.db.query(`update public.agent_runs set status = 'succeeded' where lead_id = $1 and agent_id = 'follow_up_agent'`, [l]);
    await t.db.query(`delete from public.agent_runs where lead_id = $1 and trigger_event = 'follow_up.re_engagement'`, [l]);
    await ftick();
    await ftick();
    expect(await active(l, 're_engagement')).toMatchObject({ consent_purpose: 'marketing', status: 'pending_approval' });
    await rulesSave(ALWAYS);
  });
});

describe('drafting and provider delivery (service role)', () => {
  it('a rewrite attaches only to an unchanged pending draft; opt-out line re-appended; bad output rejected', async () => {
    const l = await buyer('Draft Person', '00014');
    await settle();
    const claimed = await t.asService<R>(`select * from public.follow_up_draft_claim(10)`);
    const c = claimed.find((x) => x.facts.first_name === 'Draft')!;
    expect(c.facts).toMatchObject({ agency: 'Skyline Realty', first_name: 'Draft' });
    expect(JSON.stringify(c.facts)).not.toMatch(/98333|@|Person/);
    const good = { subject: null, body: 'Hi Draft, Sea view 2 BHK Worli in Worli is listed at INR 28,000,000 with 2 bedrooms. Would you like details or a viewing?', referenced_property_ids: [pVerified] };
    await t.asService(`select public.follow_up_attach_draft($1, $2, $3::jsonb, '{"outcome": "ok", "prompt": "never stored"}'::jsonb)`, [c.follow_up_id, c.content_version, JSON.stringify(good)]);
    let f = await one(`select * from public.follow_ups where id = $1`, [c.follow_up_id]);
    expect(f).toMatchObject({ generated_by: 'ai', draft_status: 'succeeded', content_version: c.content_version + 1, model_meta: { outcome: 'ok' } });
    expect(f.body).toBe(good.body + '\nReply STOP to opt out.');

    // Stale version / pressure wording / foreign listing → not attached.
    await t.db.query(`update public.follow_ups set draft_status = 'pending' where id = $1`, [f.id]);
    await t.asService(`select public.follow_up_attach_draft($1, $2, $3::jsonb, '{"outcome": "ok"}'::jsonb)`, [f.id, f.content_version - 1, JSON.stringify(good)]);
    expect((await one(`select draft_status, content_version from public.follow_ups where id = $1`, [f.id]))).toEqual({ draft_status: 'failed', content_version: f.content_version });
    await t.db.query(`update public.follow_ups set draft_status = 'pending' where id = $1`, [f.id]);
    await t.asService(`select public.follow_up_attach_draft($1, $2, $3::jsonb, '{"outcome": "ok"}'::jsonb)`, [f.id, f.content_version, JSON.stringify({ ...good, body: good.body + ' It is selling fast!' })]);
    expect((await one(`select draft_status from public.follow_ups where id = $1`, [f.id])).draft_status).toBe('failed');
    await t.db.query(`update public.follow_ups set draft_status = 'pending' where id = $1`, [f.id]);
    await t.asService(`select public.follow_up_attach_draft($1, $2, $3::jsonb, '{"outcome": "ok"}'::jsonb)`, [f.id, f.content_version, JSON.stringify({ ...good, referenced_property_ids: [pUnverified] })]);
    expect((await one(`select draft_status from public.follow_ups where id = $1`, [f.id])).draft_status).toBe('failed');
    // No key: recorded as not_configured; the template draft stays.
    await t.db.query(`update public.follow_ups set draft_status = 'pending' where id = $1`, [f.id]);
    await t.asService(`select public.follow_up_attach_draft($1, $2, null, '{"outcome": "not_configured"}'::jsonb)`, [f.id, f.content_version]);
    f = await one(`select * from public.follow_ups where id = $1`, [f.id]);
    expect(f.draft_status).toBe('not_configured');
    expect(l).toBeTruthy();
  });

  it('with a connected provider: approve schedules; dispatch re-checks policy, resolves the recipient, and maps outcomes (ambiguous never retried)', async () => {
    await t.db.query(`insert into public.integrations (organization_id, provider, integration_type, display_name, status, configuration) values ($1, 'mockwa', 'messaging', 'Mock WA', 'connected', '{"channels": ["whatsapp"]}')`, [org]);
    const l = await buyer('Provider Person', '00015');
    await settle();
    let f = await active(l);
    expect(await decide(manager, f.id, 'approve', f.content_version)).toMatchObject({ status: 'scheduled' });
    expect(await events(f.id, 'follow_up.scheduled')).toHaveLength(1);
    let claimed = (await t.asService<R>(`select * from public.follow_up_dispatch_claim(10)`)).find((x) => x.follow_up_id === f.id)!;
    expect(claimed).toMatchObject({ provider: 'mockwa', channel: 'whatsapp', recipient: '+919833300015', idempotency_key: 'fu_' + f.id, attempt: 1 });
    expect((await one(`select status from public.follow_ups where id = $1`, [f.id])).status).toBe('processing');
    // A second claim does not hand out the same item.
    expect((await t.asService<R>(`select * from public.follow_up_dispatch_claim(10)`)).find((x) => x.follow_up_id === f.id)).toBeUndefined();
    expect((await t.asService<R>(`select public.follow_up_dispatch_result($1, 'transient', null, '429') r`, [f.id]))[0].r).toBe('scheduled');
    await t.db.query(`update public.follow_ups set scheduled_for = now() where id = $1`, [f.id]);
    claimed = (await t.asService<R>(`select * from public.follow_up_dispatch_claim(10)`)).find((x) => x.follow_up_id === f.id)!;
    expect(claimed.attempt).toBe(2);
    expect((await t.asService<R>(`select public.follow_up_dispatch_result($1, 'ambiguous', null, 'timeout') r`, [f.id]))[0].r).toBe('failed');
    f = await one(`select * from public.follow_ups where id = $1`, [f.id]);
    expect(f).toMatchObject({ last_error_category: 'ambiguous', sent_at: null });
    expect(await rows(`select 1 from public.tasks where related_lead_id = $1 and title = 'Check whether a follow-up was delivered'`, [l])).toHaveLength(1);
    expect((await t.fails(manager, `select public.follow_up_retry($1)`, [f.id])).detail).toBe('CONFLICT');

    // Accepted → sent (provider), never delivered without evidence. Unsupported adapter → back to approved.
    const l2 = await buyer('Provider Two', '00016');
    await settle();
    let g = await active(l2);
    await decide(manager, g.id, 'approve', g.content_version);
    await t.asService(`select * from public.follow_up_dispatch_claim(10)`);
    expect((await t.asService<R>(`select public.follow_up_dispatch_result($1, 'unsupported', null, 'no adapter') r`, [g.id]))[0].r).toBe('approved');
    await t.db.query(`update public.follow_ups set status = 'scheduled', scheduled_for = now() where id = $1`, [g.id]);
    await t.asService(`select * from public.follow_up_dispatch_claim(10)`);
    expect((await t.asService<R>(`select public.follow_up_dispatch_result($1, 'accepted', 'wamid.TEST', null) r`, [g.id]))[0].r).toBe('sent');
    g = await one(`select * from public.follow_ups where id = $1`, [g.id]);
    expect(g).toMatchObject({ sent_via: 'provider', provider_message_id: 'wamid.TEST', delivered_at: null });

    // Policy is re-checked at claim time (kill switch has no trigger) and a lease that expires is treated as ambiguous.
    const l3 = await buyer('Provider Three', '00017');
    await settle();
    const h = await active(l3);
    await decide(manager, h.id, 'approve', h.content_version);
    await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{outbound_paused}', 'true') where id = $1`, [org]);
    await t.asService(`select * from public.follow_up_dispatch_claim(10)`);
    expect((await one(`select status from public.follow_ups where id = $1`, [h.id])).status).toBe('suppressed');
    await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{outbound_paused}', 'false') where id = $1`, [org]);
    const l4 = await buyer('Provider Four', '00018');
    await settle();
    const k = await active(l4);
    await decide(manager, k.id, 'approve', k.content_version);
    await t.asService(`select * from public.follow_up_dispatch_claim(10)`);
    await t.db.query(`update public.follow_ups set lease_until = now() - interval '1 minute' where id = $1`, [k.id]);
    await ftick();
    expect(await one(`select status, last_error_category from public.follow_ups where id = $1`, [k.id])).toEqual({ status: 'failed', last_error_category: 'ambiguous' });
    await t.db.query(`delete from public.integrations where organization_id = $1 and provider = 'mockwa'`, [org]);
  });
});

describe('settings, tenant isolation and privileges', () => {
  it('settings are validated and owner-only', async () => {
    for (const bad of ['{"window": {"start": 20, "end": 9}}', '{"channels": ["fax"]}', '{"max_per_week": 99}', '{"hack": true}', '{"use_cases": {"spam": true}}']) {
      expect((await t.fails(owner, `select public.follow_up_settings_save($1, $2::jsonb)`, [org, bad])).detail).toBe('VALIDATION_ERROR');
    }
    expect((await t.fails(manager, `select public.follow_up_settings_save($1, '{}'::jsonb)`, [org])).detail).toBe('FORBIDDEN');
  });

  it('another org cannot read, plan, approve, edit, send or configure; forged events are ignored; users cannot call service functions or write rows', async () => {
    const l = await buyer('Private Person', '00019');
    await settle();
    const f = await active(l);
    expect(await t.as(ownerB, `select id from public.follow_ups where organization_id = $1`, [org])).toHaveLength(0);
    expect((await t.fails(ownerB, `select public.lead_follow_ups($1)`, [l])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.follow_up_request($1, 'share_property_recommendations', 'cross_tenant_1')`, [l])).detail).toBe('NOT_FOUND');
    for (const sql of [`select public.follow_up_decide($1, 'approve', 1)`, `select public.follow_up_mark_sent($1, 1)`, `select public.follow_up_update_draft($1, null, 'hello there world')`,
      `select public.follow_up_decide($1, 'cancel', null)`]) {
      expect((await t.fails(ownerB, sql, [f.id])).detail).toBe('NOT_FOUND');
    }
    expect((await t.fails(ownerB, `select public.follow_up_settings_save($1, '{}'::jsonb)`, [org])).detail).toBe('FORBIDDEN');
    // Read model for a viewer: visible, but cannot act.
    const [{ r: v }] = await t.as<{ r: R }>(viewer, `select public.lead_follow_ups($1) r`, [l]);
    expect(v.can_act).toBe(false);
    expect(v.items[0]).not.toHaveProperty('idempotency_key');

    const before = (await rows(`select 1 from public.agent_runs where agent_id = 'follow_up_agent' and lead_id = $1`, [l])).length;
    await t.db.query(`insert into public.outbox_events (organization_id, event_type, record_type, record_id, payload, consumer, status, dedupe_key)
      values ($1, 'property_matching.completed', 'lead', $2, $3, 'follow_up_agent', 'pending', $4)`, [orgB, l, JSON.stringify({ lead_id: l }), `forged_${l}`]);
    await ftick();
    expect((await rows(`select 1 from public.agent_runs where agent_id = 'follow_up_agent' and lead_id = $1`, [l])).length).toBe(before);

    expect((await t.fails(owner, `update public.follow_ups set status = 'sent' where id = $1`, [f.id])).message).toMatch(/permission denied/);
    for (const fn of [`public.follow_up_tick(1)`, `public.follow_up_draft_claim(1)`, `public.follow_up_dispatch_claim(1)`, `public.follow_up_worker_secret_ok('x')`,
      `public.follow_up_dispatch_result(gen_random_uuid(), 'accepted', 'x', null)`, `public.follow_up_attach_draft(gen_random_uuid(), 1, null, null)`, `public.follow_up_process(gen_random_uuid())`]) {
      expect((await t.fails(owner, `select ${fn}`)).message).toMatch(/permission denied/);
    }
    expect((await t.fails(owner, `select private.fu_policy(gen_random_uuid(), 'sms', 'service')`)).message).toMatch(/permission denied/);
  });
});
