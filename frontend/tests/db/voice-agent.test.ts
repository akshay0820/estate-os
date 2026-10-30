// Agent 02 — AI Voice Calling Agent: policy, idempotent requests, webhook state machine, opt-out, handoff,
// analysis application, Agent 3 handoff, worker reconciliation and tenant isolation. No real calls are placed.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let org: string, owner: string, manager: string, agent: string, viewer: string;
let orgB: string, ownerB: string;
let leadId: string, contactId: string;
let seq = 0;
const AGENT_ID = 'agent_outbound_A1';
const IN_AGENT = 'agent_inbound_A1';

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const rows = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows;
const key = () => `k_test_${++seq}_${Date.now()}`;
const pcid = () => `retell_call_${++seq}_abcdef`;
const preflight = async (user: string, lead: string) => (await t.as<{ p: R }>(user, `select public.voice_call_preflight($1) p`, [lead]))[0].p;
/** Earlier attempts on this lead move 10 minutes into the past, so the minimum-gap rule (5 min here) is not what a test hits. */
const ageAttempts = (lead: string) => t.db.query(`update public.voice_calls set requested_at = requested_at - interval '10 minutes' where lead_id = $1`, [lead]);
const request = async (user: string, lead: string, k = key()) => (await t.as<{ r: R }>(user, `select public.voice_call_request($1, $2) r`, [lead, k]))[0].r;
const svc = async (sql: string, params: unknown[] = []) => (await t.asService<{ r: R }>(sql, params))[0]?.r;
const hook = (event: string, call: R) => svc(`select public.voice_webhook_ingest($1, $2::jsonb) r`, [event, JSON.stringify(call)]);
const saveSettings = (user: string, o: string, s: R) => t.as(user, `select public.voice_settings_save($1, $2::jsonb)`, [o, JSON.stringify(s)]);
const callRow = (id: string) => one(`select * from public.voice_calls where id = $1`, [id]);

/** Reserve + dispatch + provider accept, as the Edge Function does. */
async function startCall(lead = leadId) {
  await ageAttempts(lead);
  const r = await request(agent, lead);
  expect(r.status).toBe('initiating');
  const d = await svc(`select public.voice_call_dispatch($1) r`, [r.call_id]);
  expect(d.dispatch).toBe(true);
  const id = pcid();
  await t.asService(`select public.voice_call_mark_initiated($1, $2, $3)`, [r.call_id, id, AGENT_ID]);
  return { callId: r.call_id as string, providerId: id, dispatch: d };
}
const ended = (providerId: string, extra: R = {}) => ({
  call_id: providerId, agent_id: AGENT_ID, direction: 'outbound', to_number: '+919811122233', call_status: 'ended',
  start_timestamp: 1_800_000_000_000, end_timestamp: 1_800_000_095_000, duration_ms: 95_000, disconnection_reason: 'user_hangup',
  transcript: 'Agent: Hello, this is the virtual assistant for Skyline Realty.\nUser: Hi. I want to buy a 3 BHK in Worli, budget around 4 crore, within 3 months.',
  recording_url: 'https://example.invalid/rec.wav', ...extra,
});

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Aanya Kapoor');
  manager = await t.user('Priya Nair');
  agent = await t.user('Arjun Desai');
  viewer = await t.user('Vee Viewer');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, manager, 'manager');
  await t.member(org, agent, 'agent', ['Worli']);
  await t.member(org, viewer, 'viewer');
  // Call at any hour, any day, so tests do not depend on when they run.
  await t.db.query(`update public.organizations set settings = jsonb_set(jsonb_set(settings, '{calling_hours}', '{"start":0,"end":24}'), '{business_hours,days}', '[1,2,3,4,5,6,7]') where id = $1`, [org]);
  const l = await t.lead(manager, org, { name: 'Ira Sen', phone: '9811122233', source: 'Website', locations: ['Worli'], budget_max: 50000000 });
  leadId = l.lead_id;
  contactId = l.contact_id;
  await t.db.query(`update public.leads set assigned_to = $2 where id = $1`, [leadId, agent]);
  ownerB = await t.user('Bina Bose');
  orgB = await t.org(ownerB, 'Other Agency');
}, 120000);

describe('settings and consent', () => {
  it('validates settings and keeps Retell agents unique per workspace', async () => {
    expect((await t.fails(agent, `select public.voice_settings_save($1, '{}'::jsonb)`, [org])).detail).toBe('FORBIDDEN');
    expect((await t.fails(owner, `select public.voice_settings_save($1, '{"enabled":true}'::jsonb)`, [org])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(owner, `select public.voice_settings_save($1, '{"from_number":"12345"}'::jsonb)`, [org])).detail).toBe('VALIDATION_ERROR');
    await saveSettings(owner, org, { enabled: true, outbound_agent_id: AGENT_ID, inbound_agent_id: IN_AGENT, from_number: '+918000000001', agency_spoken_name: 'Skyline Realty',
      store_transcripts: true, analysis_enabled: true, recording_access: true, max_attempts_per_lead_per_day: 10, min_minutes_between_attempts: 5 });
    expect((await t.fails(ownerB, `select public.voice_settings_save($1, $2::jsonb)`, [orgB, JSON.stringify({ outbound_agent_id: AGENT_ID })])).detail).toBe('CONFLICT');
    expect((await t.fails(ownerB, `select public.voice_settings_save($1, '{}'::jsonb)`, [org])).detail).toBe('FORBIDDEN');
  });

  it('requires explicit AI-call consent; unknown is not permission', async () => {
    const p = await preflight(agent, leadId);
    expect(p.allowed).toBe(false);
    expect(p.checks.find((c: R) => c.key === 'consent').ok).toBe(false);
    expect((await t.fails(viewer, `select public.voice_call_preflight($1)`, [leadId])).detail).toBe('FORBIDDEN');
    expect((await t.fails(agent, `select public.set_ai_call_consent($1, 'granted', '')`, [contactId])).detail).toBe('VALIDATION_ERROR');
    await t.as(agent, `select public.set_ai_call_consent($1, 'granted', 'Verbal consent at walk-in')`, [contactId]);
    expect((await preflight(agent, leadId)).allowed).toBe(true);
  });
});

describe('call initiation', () => {
  it('records blocked attempts with the reason and never dials them', async () => {
    const other = await t.lead(manager, org, { name: 'No Consent', phone: '9822200011' });
    const r = await request(agent, other.lead_id);
    expect(r.status).toBe('blocked');
    expect(r.reason).toContain('AI-call consent');
    expect((await svc(`select public.voice_call_dispatch($1) r`, [r.call_id])).dispatch).toBe(false);
  });

  it('is idempotent per key and allows only one active call per lead', async () => {
    const k = key();
    const a = await request(agent, leadId, k);
    const b = await request(agent, leadId, k);
    expect(b).toMatchObject({ call_id: a.call_id, replayed: true });
    const c = await request(agent, leadId);
    expect(c.status).toBe('blocked');
    expect(c.reason).toContain('No call already in progress');
    const run = await one(`select agent_id, status from public.agent_runs where id = (select run_id from public.voice_calls where id = $1)`, [a.call_id]);
    expect(run).toEqual({ agent_id: 'voice_calling_agent', status: 'received' });
    // A definite provider refusal ends it; nothing was dialed.
    await svc(`select public.voice_call_dispatch($1) r`, [a.call_id]);
    await t.asService(`select public.voice_call_mark_failed($1, 'Retell HTTP 422', true)`, [a.call_id]);
    expect(await callRow(a.call_id)).toMatchObject({ status: 'failed', outcome: 'failed', analysis_status: 'skipped' });
    expect(await rows(`select 1 from public.outbox_events where consumer is distinct from 'follow_up_agent' and record_id = $1 and event_type = 'voice_call.completed'`, [a.call_id])).toHaveLength(1);
  });

  it('dispatch passes only minimal context and ambiguous failures stay retryable', async () => {
    const tooSoon = await request(agent, leadId);
    expect(tooSoon.reason).toContain('Attempt limits');
    await ageAttempts(leadId);
    const r = await request(agent, leadId);
    const d = await svc(`select public.voice_call_dispatch($1) r`, [r.call_id]);
    expect(d).toMatchObject({ dispatch: true, agent_id: AGENT_ID, from_number: '+918000000001', to_number: '+919811122233', idempotency_key: r.call_id });
    expect(Object.keys(d.dynamic_variables).sort()).toEqual(['agency_name', 'customer_first_name', 'known_bedrooms', 'known_budget', 'known_intent', 'known_locations', 'known_property_type', 'known_timeline']);
    expect(d.dynamic_variables.customer_first_name).toBe('Ira');
    await t.asService(`select public.voice_call_mark_failed($1, 'Retell request timed out', false)`, [r.call_id]);
    expect(await callRow(r.call_id)).toMatchObject({ status: 'initiating', provider_attempts: 1 });
    // The worker re-sends with the same key while inside Retell's 1-hour idempotency window...
    await t.db.query(`update public.voice_calls set requested_at = now() - interval '2 minutes' where id = $1`, [r.call_id]);
    expect((await svc(`select public.voice_worker_tick() r`)).redispatch).toContain(r.call_id);
    // ...and never after it: the outcome becomes 'unknown' instead of risking a second call.
    await t.db.query(`update public.voice_calls set requested_at = now() - interval '56 minutes' where id = $1`, [r.call_id]);
    expect((await svc(`select public.voice_call_dispatch($1) r`, [r.call_id])).status).toBe('unknown');
    expect((await callRow(r.call_id)).status).toBe('unknown');
  });

  it('reservations that were never sent are closed by the worker', async () => {
    const lead2 = await t.lead(manager, org, { name: 'Unsent Person', phone: '9833300022' });
    await t.as(agent, `select public.set_ai_call_consent($1, 'granted', 'Website form tick-box')`, [lead2.contact_id]);
    const r = await request(agent, lead2.lead_id);
    await t.db.query(`update public.voice_calls set requested_at = now() - interval '6 minutes' where id = $1`, [r.call_id]);
    await svc(`select public.voice_worker_tick() r`);
    expect(await callRow(r.call_id)).toMatchObject({ status: 'failed', last_provider_error: 'Not sent to the provider' });
  });
});

describe('webhook lifecycle', () => {
  it('applies events in order, ignores duplicates and stale events, and persists the outcome', async () => {
    const { callId, providerId } = await startCall();
    expect((await callRow(callId)).status).toBe('dialing');
    expect((await hook('call_started', { call_id: providerId, start_timestamp: 1_800_000_000_000 })).result).toBe('applied');
    expect((await hook('call_started', { call_id: providerId })).result).toBe('duplicate');
    expect((await callRow(callId)).status).toBe('in_progress');

    expect((await hook('call_ended', ended(providerId))).result).toBe('applied');
    const c = await callRow(callId);
    expect(c).toMatchObject({ status: 'completed', outcome: 'connected', duration_seconds: 95, recording_available: true, transcript_stored: true });
    expect(await one(`select status from public.leads where id = $1`, [leadId])).toEqual({ status: 'contacted' });
    expect((await rows(`select title from public.activities where lead_id = $1 and title like 'AI call completed%'`, [leadId]))).toHaveLength(1);
    expect((await hook('call_ended', ended(providerId))).result).toBe('duplicate');
    expect((await rows(`select title from public.activities where lead_id = $1 and title like 'AI call completed%'`, [leadId]))).toHaveLength(1);
    // Recording URLs are never stored.
    expect(JSON.stringify(c)).not.toContain('example.invalid');

    const an = await hook('call_analyzed', { ...ended(providerId), call_analysis: { call_summary: 'Wants a 3 BHK in Worli.', call_successful: true, in_voicemail: false, user_sentiment: 'Positive' } });
    expect(an).toMatchObject({ result: 'applied', needs_analysis: true });
    expect(await callRow(callId)).toMatchObject({ summary: 'Wants a 3 BHK in Worli.', analysis_status: 'pending' });
    // Not finalized until analysis is done: no handoff yet.
    expect(await rows(`select 1 from public.outbox_events where consumer is distinct from 'follow_up_agent' and record_id = $1 and event_type = 'voice_call.completed'`, [callId])).toHaveLength(0);

    const claimed = await t.asService<R>(`select * from public.voice_analysis_claim(5)`);
    expect(claimed.map((x) => x.call_id)).toContain(callId);
    expect(claimed.find((x) => x.call_id === callId)).toMatchObject({ currency: 'INR', country: 'IN' });
    const res = await svc(`select public.voice_analysis_complete($1, true, $2::jsonb, '{"model":"test","outcome":"ok"}'::jsonb) r`, [callId, JSON.stringify({
      call_outcome: 'qualified_conversation', conversation_summary: 'Buyer wants a 3 BHK in Worli.', intent: 'buy', preferred_locations: ['Worli'],
      property_type: 'apartment', bedrooms: 3, budget_min: null, budget_max: 40000000, currency: 'INR', timeline: '0-3 months',
      human_requested: false, callback_requested: false, opt_out_detected: false, unanswered_questions: ['Parking needs'], next_recommended_action: 'send_property_matches',
      organization_id: orgB, sql: 'drop table leads',
    })]);
    expect(res).toBe('succeeded');
    const lead = await one(`select budget_max, bedrooms, desired_property_type, timeline, ai_extracted_fields from public.leads where id = $1`, [leadId]);
    expect(Number(lead.budget_max)).toBe(50000000); // existing value kept
    expect(lead).toMatchObject({ bedrooms: 3, desired_property_type: 'apartment', timeline: '0-3 months' });
    expect(lead.ai_extracted_fields).toEqual(expect.arrayContaining(['bedrooms', 'propertyType', 'timeline']));
    const after = await callRow(callId);
    expect(after.analysis.conflicts).toEqual(['budget']);
    expect(JSON.stringify(after.analysis)).not.toMatch(/drop table|organization_id/);
    const ev = await rows<R>(`select * from public.outbox_events where consumer is distinct from 'follow_up_agent' and record_id = $1 and event_type = 'voice_call.completed'`, [callId]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ consumer: 'sales_qualification_agent', status: 'pending' });
    expect(ev[0].payload).toMatchObject({ lead_id: leadId, call_id: callId, provider_call_id: providerId, outcome: 'connected', schema_version: 1, requires: ['review_conflicts'] });
    expect(JSON.stringify(ev[0].payload)).not.toMatch(/Worli|transcript|\+91/);
    expect((await one(`select status from public.agent_runs where id = $1`, [after.run_id])).status).toBe('succeeded');
  });

  it('handles call_analyzed arriving before call_ended, and no-answer calls', async () => {
    await t.db.query(`update public.voice_calls set status = 'completed' where lead_id = $1 and status in ('dialing','in_progress','initiating')`, [leadId]);
    const { callId, providerId } = await startCall();
    await hook('call_analyzed', { call_id: providerId, call_status: 'not_connected', disconnection_reason: 'dial_no_answer', call_analysis: { in_voicemail: false } });
    expect(await callRow(callId)).toMatchObject({ status: 'no_answer', outcome: 'no_answer', analysis_status: 'skipped' });
    expect((await hook('call_ended', { call_id: providerId, disconnection_reason: 'user_hangup' })).result).toBe('applied');
    expect((await callRow(callId)).status).toBe('no_answer');
    expect((await one(`select result from public.voice_call_events where event_key = $1`, [`call_ended:${providerId}`])).result).toBe('stale');
    const ev = await one(`select payload from public.outbox_events where consumer is distinct from 'follow_up_agent' and record_id = $1`, [callId]);
    expect(ev.payload.outcome).toBe('no_answer');
  });

  it('opt-out from the provider is enforced by the backend for every later call', async () => {
    const { callId, providerId } = await startCall();
    await hook('call_ended', ended(providerId, { disconnection_reason: 'user_requested_dnc' }));
    expect(await callRow(callId)).toMatchObject({ outcome: 'opted_out', opt_out_detected: true });
    const consents = await rows<R>(`select purpose, status from public.communication_consents where contact_id = $1 and channel = 'phone' order by purpose`, [contactId]);
    expect(consents.every((c) => c.status === 'revoked')).toBe(true);
    expect(await rows(`select 1 from public.outbox_events where consumer is distinct from 'follow_up_agent' and event_type = 'lead.communication_opted_out' and record_id = $1`, [contactId])).toHaveLength(1);
    const p = await preflight(agent, leadId);
    expect(p.allowed).toBe(false);
    expect(p.checks.find((c: R) => c.key === 'not_suppressed').ok).toBe(false);
    expect((await request(agent, leadId)).status).toBe('blocked');
    // Staff cannot quietly re-grant AI calls over a phone opt-out.
    expect((await t.fails(agent, `select public.set_ai_call_consent($1, 'granted', 'Changed mind')`, [contactId])).detail).toBe('FORBIDDEN');
  });

  it('a callback request creates a task for the owner and a handoff event', async () => {
    const lead3 = await t.lead(manager, org, { name: 'Callback Person', phone: '9844400033' });
    await t.db.query(`update public.leads set assigned_to = $2 where id = $1`, [lead3.lead_id, agent]);
    await t.as(agent, `select public.set_ai_call_consent($1, 'granted', 'Online form')`, [lead3.contact_id]);
    const { callId, providerId } = await startCall(lead3.lead_id);
    await hook('call_ended', ended(providerId, { disconnection_reason: 'user_requested_callback' }));
    expect(await callRow(callId)).toMatchObject({ outcome: 'callback_requested', human_handoff_status: 'task_created' });
    const task = await one(`select assigned_to, priority, source from public.tasks where related_lead_id = $1`, [lead3.lead_id]);
    expect(task).toEqual({ assigned_to: agent, priority: 'high', source: 'ai' });
    expect(await rows(`select 1 from public.outbox_events where consumer is distinct from 'follow_up_agent' and event_type = 'voice_call.human_handoff_requested' and record_id = $1`, [callId])).toHaveLength(1);
    expect(await t.as(agent, `select 1 from public.notifications where title like 'New task: Call back%'`)).toHaveLength(1);
  });

  it('analysis failures keep the call and finalize after bounded retries', async () => {
    const lead4 = await t.lead(manager, org, { name: 'Flaky Analysis', phone: '9855500044' });
    await t.as(agent, `select public.set_ai_call_consent($1, 'granted', 'Online form')`, [lead4.contact_id]);
    const { callId, providerId } = await startCall(lead4.lead_id);
    await hook('call_ended', ended(providerId));
    await hook('call_analyzed', { ...ended(providerId), call_analysis: { call_summary: 'x' } });
    for (let i = 0; i < 3; i++) {
      await t.db.query(`update public.voice_calls set analysis_next_at = now() - interval '1 second' where id = $1`, [callId]);
      await t.asService(`select * from public.voice_analysis_claim(5)`);
      await t.asService(`select public.voice_analysis_complete($1, false, null, '{"outcome":"timeout"}'::jsonb)`, [callId]);
    }
    expect(await callRow(callId)).toMatchObject({ analysis_status: 'failed', status: 'completed' });
    expect(await rows(`select 1 from public.outbox_events where consumer is distinct from 'follow_up_agent' and record_id = $1 and event_type = 'voice_call.completed'`, [callId])).toHaveLength(1);
  });

  it('metadata is only a hint: it links the reserved call only when number and agent match', async () => {
    const lead5 = await t.lead(manager, org, { name: 'Race Case', phone: '9866600055' });
    await t.as(agent, `select public.set_ai_call_consent($1, 'granted', 'Online form')`, [lead5.contact_id]);
    const r = await request(agent, lead5.lead_id);
    await svc(`select public.voice_call_dispatch($1) r`, [r.call_id]);
    const bad = await hook('call_started', { call_id: pcid(), agent_id: AGENT_ID, direction: 'outbound', to_number: '+919999999999', metadata: { voice_call_id: r.call_id } });
    expect(bad.result).toBe('unmatched');
    const id = pcid();
    const good = await hook('call_started', { call_id: id, agent_id: AGENT_ID, direction: 'outbound', to_number: '+919866600055', metadata: { voice_call_id: r.call_id } });
    expect(good).toMatchObject({ result: 'applied', call_id: r.call_id });
    expect(await callRow(r.call_id)).toMatchObject({ provider_call_id: id, status: 'in_progress' });
  });

  it('inbound calls belong to the org owning the inbound agent; unknown callers become leads through intake', async () => {
    const id = pcid();
    const caller = '+919877700066';
    await hook('call_started', { call_id: id, agent_id: IN_AGENT, direction: 'inbound', from_number: caller, to_number: '+918000000001', metadata: { organization_id: orgB } });
    const c = await one(`select * from public.voice_calls where provider_call_id = $1`, [id]);
    expect(c).toMatchObject({ organization_id: org, direction: 'inbound', lead_id: null, status: 'in_progress' });
    await hook('call_ended', { call_id: id, agent_id: IN_AGENT, direction: 'inbound', from_number: caller, disconnection_reason: 'user_hangup', start_timestamp: 1_800_000_000_000, duration_ms: 30000, transcript: 'User: I want to rent in Bandra' });
    await hook('call_analyzed', { call_id: id, call_analysis: { call_summary: 'Wants to rent in Bandra.' } });
    // Claude analysis is pending because transcripts + analysis are on; complete it.
    await t.asService(`select * from public.voice_analysis_claim(5)`);
    await t.asService(`select public.voice_analysis_complete($1, true, $2::jsonb, '{}'::jsonb)`, [c.id, JSON.stringify({ call_outcome: 'partial_information', conversation_summary: 'Wants to rent in Bandra.', intent: 'rent', preferred_locations: ['Bandra'], property_type: null, bedrooms: null, budget_min: null, budget_max: null, currency: null, timeline: null, human_requested: false, callback_requested: false, opt_out_detected: false, unanswered_questions: [], next_recommended_action: 'nurture' })]);
    const after = await one(`select lead_id, contact_id from public.voice_calls where id = $1`, [c.id]);
    expect(after.lead_id).not.toBeNull();
    const lead = await one(`select organization_id, source, desired_transaction, desired_locations from public.leads where id = $1`, [after.lead_id]);
    expect(lead).toEqual({ organization_id: org, source: 'Inbound call', desired_transaction: 'rent', desired_locations: ['Bandra'] });
    expect(await one(`select phone_e164 from public.contacts where id = $1`, [after.contact_id])).toEqual({ phone_e164: caller });
    // An inbound event for an agent no org owns is not attached to anyone.
    expect((await hook('call_started', { call_id: pcid(), agent_id: 'agent_nobody_000', direction: 'inbound', from_number: caller })).result).toBe('unmatched');
  });

  it('reconciles calls that never got a terminal event', async () => {
    const lead6 = await t.lead(manager, org, { name: 'Stale Call', phone: '9888800077' });
    await t.as(agent, `select public.set_ai_call_consent($1, 'granted', 'Online form')`, [lead6.contact_id]);
    const { callId, providerId } = await startCall(lead6.lead_id);
    await t.db.query(`update public.voice_calls set initiated_at = now() - interval '3 hours', last_event_at = null where id = $1`, [callId]);
    const tick = await svc(`select public.voice_worker_tick() r`);
    expect(tick.stale.map((s: R) => s.provider_call_id)).toContain(providerId);
    await t.asService(`select public.voice_call_close_unresolved($1)`, [callId]);
    expect(await callRow(callId)).toMatchObject({ status: 'unknown', outcome: 'unknown' });
  });

  it('expired transcripts are purged by the worker', async () => {
    await t.db.query(`update public.voice_call_transcripts set retain_until = now() - interval '1 day'`);
    const tick = await svc(`select public.voice_worker_tick() r`);
    expect(tick.transcripts_purged).toBeGreaterThan(0);
    expect(await rows(`select 1 from public.voice_call_transcripts`)).toHaveLength(0);
  });
});

describe('security', () => {
  it('privileged voice functions are service-role only', async () => {
    for (const sql of [
      `select public.voice_call_dispatch(gen_random_uuid())`,
      `select public.voice_call_mark_initiated(gen_random_uuid(), 'abcdefgh', 'x')`,
      `select public.voice_call_mark_failed(gen_random_uuid(), 'x', true)`,
      `select public.voice_webhook_ingest('call_ended', '{"call_id":"abcdefghij"}'::jsonb)`,
      `select * from public.voice_analysis_claim(1)`,
      `select public.voice_analysis_complete(gen_random_uuid(), true, '{}'::jsonb, '{}'::jsonb)`,
      `select public.voice_worker_tick()`,
      `select public.voice_worker_secret_ok('x')`,
    ]) {
      expect((await t.fails(owner, sql)).message).toMatch(/permission denied/);
    }
    expect((await t.fails(owner, `insert into public.voice_calls (organization_id, direction, status, idempotency_key, initiated_by) values ($1, 'outbound', 'completed', 'forged_key_1', 'user')`, [org])).message).toMatch(/permission denied/);
    expect((await t.fails(owner, `update public.voice_calls set status = 'completed'`)).message).toMatch(/permission denied/);
    expect((await t.fails(owner, `update public.voice_settings set enabled = false`)).message).toMatch(/permission denied/);
  });

  it('tenant isolation: another org cannot call, read calls, transcripts, recordings or settings', async () => {
    const aCall = (await one(`select id from public.voice_calls where organization_id = $1 and transcript_stored limit 1`, [org]))?.id
      ?? (await one(`select id from public.voice_calls where organization_id = $1 limit 1`, [org])).id;
    expect((await t.fails(ownerB, `select public.voice_call_request($1, 'k_cross_tenant_1')`, [leadId])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.voice_call_preflight($1)`, [leadId])).detail).toBe('NOT_FOUND');
    expect(await t.as(ownerB, `select 1 from public.voice_calls where organization_id = $1`, [org])).toHaveLength(0);
    expect(await t.as(ownerB, `select 1 from public.voice_call_transcripts where organization_id = $1`, [org])).toHaveLength(0);
    expect(await t.as(ownerB, `select 1 from public.voice_settings where organization_id = $1`, [org])).toHaveLength(0);
    expect((await t.fails(ownerB, `select public.voice_call_detail($1)`, [aCall])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.voice_call_recording_access($1)`, [aCall])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.set_ai_call_consent($1, 'granted', 'cross tenant')`, [contactId])).detail).toBe('NOT_FOUND');
  });

  it('agents see their calls but not transcripts or recordings; viewers see nothing', async () => {
    const any = (await one(`select id from public.voice_calls where organization_id = $1 and status = 'completed' limit 1`, [org])).id;
    const d = (await t.as<{ d: R }>(agent, `select public.voice_call_detail($1) d`, [any]))[0].d;
    expect(d).toMatchObject({ transcript: null, can_view_transcript: false });
    expect(await t.as(agent, `select 1 from public.voice_call_transcripts`)).toHaveLength(0);
    expect((await t.fails(agent, `select public.voice_call_recording_access($1)`, [any])).detail).toBe('FORBIDDEN');
    expect(await t.as(viewer, `select 1 from public.voice_calls`)).toHaveLength(0);
    expect((await t.fails(viewer, `select public.voice_call_detail($1)`, [any])).detail).toBe('NOT_FOUND');
  });

  it('the kill switch and calling hours block calls', async () => {
    const lead7 = await t.lead(manager, org, { name: 'Hours Test', phone: '9899900088' });
    await t.as(agent, `select public.set_ai_call_consent($1, 'granted', 'Online form')`, [lead7.contact_id]);
    await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{outbound_paused}', 'true') where id = $1`, [org]);
    expect((await preflight(agent, lead7.lead_id)).checks.find((c: R) => c.key === 'kill_switch').ok).toBe(false);
    await t.db.query(`update public.organizations set settings = jsonb_set(jsonb_set(settings, '{outbound_paused}', 'false'), '{business_hours,days}', '[]') where id = $1`, [org]);
    const p = await preflight(agent, lead7.lead_id);
    expect(p.checks.find((c: R) => c.key === 'calling_hours').ok).toBe(false);
    expect(p.allowed).toBe(false);
  });
});
