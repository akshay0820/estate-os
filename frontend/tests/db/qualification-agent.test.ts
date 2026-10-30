// Agent 03 — Sales & Qualification: deterministic engine, provenance, outbox consumption, model step, review,
// events, retries and tenant isolation. The model step is exercised with validated, hand-written outputs.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let org: string, owner: string, manager: string, agent: string;
let orgB: string, ownerB: string;
let seq = 0;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const rows = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows;
const tick = async () => (await t.asService<{ r: R }>(`select public.qualification_tick(50) r`))[0].r;
const current = (lead: string) => one(`select * from public.lead_qualifications where lead_id = $1 and is_current`, [lead]);
const request = (user: string, lead: string) => t.as<{ r: R }>(user, `select public.qualification_request($1, $2) r`, [lead, `k_q_${++seq}_${Date.now()}`]).then((x) => x[0].r);
const intake = async (payload: R) => {
  const [{ r }] = await t.asService<{ r: R }>(`select public.ingest_lead($1, 'webhook', $2, $3::jsonb, true) r`, [org, `evt_q_${++seq}`, JSON.stringify(payload)]);
  return r.lead_id as string;
};
const events = (lead: string, type: string) => rows<R>(`select * from public.outbox_events where record_id = $1 and event_type = $2 and consumer is distinct from 'follow_up_agent'`, [lead, type]);

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Aanya Kapoor');
  manager = await t.user('Priya Nair');
  agent = await t.user('Arjun Desai');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, manager, 'manager');
  await t.member(org, agent, 'agent', ['Worli']);
  ownerB = await t.user('Bina Bose');
  orgB = await t.org(ownerB, 'Other Agency');
}, 120000);

describe('deterministic qualification', () => {
  it('qualifies a complete manual lead without any call, explains the score, and hands off to Agent 04 once', async () => {
    const l = await t.lead(manager, org, { name: 'Complete Buyer', phone: '9811100001', type: 'buyer', locations: ['Worli'], budget_max: 40000000, property_type: 'apartment', bedrooms: 3, timeline: '0-3 months' });
    expect((await one(`select qualification_status from public.leads where id = $1`, [l.lead_id])).qualification_status).toBeNull();
    const first = await tick();
    expect(first.consumed).toBeGreaterThan(0);
    const q = await current(l.lead_id);
    expect(q).toMatchObject({ status: 'qualified', score: 85, recommended_action: 'recommend_property_matching', analysis_status: 'not_requested', human_review_required: false });
    expect(q.score_breakdown.map((d: R) => d.key)).toEqual(['intent', 'requirements', 'budget', 'timeline', 'engagement', 'fit']);
    expect(q.score_breakdown.find((d: R) => d.key === 'engagement')).toMatchObject({ value: 0, points: 0 });
    expect(q.requirements.budget).toMatchObject({ certainty: 'confirmed', source: 'crm', value: { max: 40000000, currency: 'INR' } });
    expect(await one(`select status, qualification_status, qualification_id from public.leads where id = $1`, [l.lead_id])).toEqual({ status: 'qualified', qualification_status: 'qualified', qualification_id: q.id });
    const ev = await events(l.lead_id, 'lead.qualification.completed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ consumer: 'property_matching_agent', status: 'pending' });
    expect(Object.keys(ev[0].payload).sort()).toEqual(['agent_run_id', 'correlation_id', 'event_type', 'lead_id', 'occurred_at', 'organization_id', 'qualification_id', 'recommended_action', 'schema_version', 'status']);
    // The intake handoff event was consumed and acknowledged.
    expect((await one(`select status from public.outbox_events where record_id = $1 and event_type = 'lead.ready_for_qualification'`, [l.lead_id])).status).toBe('delivered');

    // Re-running with unchanged requirements keeps history but does not re-trigger matching.
    await request(agent, l.lead_id);
    await tick();
    expect(await rows(`select 1 from public.lead_qualifications where lead_id = $1`, [l.lead_id])).toHaveLength(2);
    expect(await events(l.lead_id, 'lead.qualification.completed')).toHaveLength(1);
    const act = await rows<R>(`select actor_name from public.activities where lead_id = $1 and title like 'Qualification:%'`, [l.lead_id]);
    expect(act).toHaveLength(2);
    expect(act[0].actor_name).toBe('Sales & Qualification Agent');
  });

  it('keeps unknowns unknown: missing info → needs_information, a clarification task (not a message) and no score', async () => {
    const lead = await intake({ name: 'Bare Enquiry', phone: '9811100002' });
    await tick();
    const q = await current(lead);
    expect(q).toMatchObject({ status: 'needs_information', score: null, recommended_action: 'request_clarification' });
    expect(q.missing).toEqual(['intent', 'locations', 'budget', 'property_type', 'timeline']);
    expect(q.questions).toHaveLength(3);
    expect(q.questions[0]).toEqual({ field: 'intent', question: 'Are you looking to buy, rent, sell or invest?' });
    const task = await one(`select title, description, source from public.tasks where related_lead_id = $1`, [lead]);
    expect(task.title).toBe('Clarify requirements: Bare Enquiry');
    expect(task.description).toContain('do not send automatically');
    expect(await events(lead, 'lead.qualification.needs_information')).toHaveLength(1);
    expect(await events(lead, 'lead.qualification.completed')).toHaveLength(0);
    // A second run does not pile up clarification tasks.
    await request(manager, lead);
    await tick();
    expect(await rows(`select 1 from public.tasks where related_lead_id = $1 and title like 'Clarify requirements%'`, [lead])).toHaveLength(1);
  });

  it('far timelines become nurture; requirements differ per intent (sellers have no budget requirement)', async () => {
    const slow = await t.lead(manager, org, { name: 'Slow Buyer', phone: '9811100003', type: 'buyer', locations: ['Worli'], budget_max: 30000000, property_type: 'apartment', timeline: '12+ months' });
    const seller = await t.lead(manager, org, { name: 'Seller Person', phone: '9811100004', type: 'seller', locations: ['Bandra'], property_type: 'apartment', timeline: '3-6 months' });
    await t.db.query(`update public.qualification_settings set rules = rules where false`);
    await t.as(owner, `select public.qualification_settings_save($1, '{"qualified_min_score": 90, "high_intent_min_score": 95}'::jsonb)`, [org]);
    await tick();
    const s = await current(slow.lead_id);
    expect(s).toMatchObject({ status: 'nurture', recommended_action: 'continue_nurture', ruleset_version: 1 });
    const sel = await current(seller.lead_id);
    expect(sel.missing).toEqual([]);
    expect(sel.score_breakdown.map((d: R) => d.key)).not.toContain('budget');
    await t.as(owner, `select public.qualification_settings_save($1, '{}'::jsonb)`, [org]);
  });

  it('does-not-contact leads get no contact recommendation', async () => {
    const l = await t.lead(manager, org, { name: 'Do Not Contact', phone: '9811100005' });
    await t.db.query(`update public.contacts set lifecycle_status = 'do_not_contact' where id = $1`, [l.contact_id]);
    await tick();
    expect(await current(l.lead_id)).toMatchObject({ status: 'needs_information', recommended_action: 'no_action' });
    expect(await rows(`select 1 from public.tasks where related_lead_id = $1 and title like 'Clarify%'`, [l.lead_id])).toHaveLength(0);
  });

  it('outside the configured service scope goes to human review, not disqualification', async () => {
    await t.as(owner, `select public.qualification_settings_save($1, '{"scope": {"transactions": ["buy","rent","sell","let","invest"], "locations": ["Mumbai", "Worli"], "property_types": []}}'::jsonb)`, [org]);
    const l = await t.lead(manager, org, { name: 'Pune Buyer', phone: '9811100006', type: 'buyer', locations: ['Pune'], budget_max: 9000000, property_type: 'apartment', timeline: '1 month' });
    await tick();
    const q = await current(l.lead_id);
    expect(q).toMatchObject({ status: 'human_review_required', review_status: 'pending', recommended_action: 'request_human_review' });
    expect(q.review_reasons).toEqual(['outside_service_scope']);
    expect(await rows(`select 1 from public.tasks where related_lead_id = $1 and title like 'Review qualification%'`, [l.lead_id])).toHaveLength(1);
    await t.as(owner, `select public.qualification_settings_save($1, '{}'::jsonb)`, [org]);
  });

  it('validates qualification rules', async () => {
    for (const bad of ['{"weights": {"intent": -5}}', '{"required": {"buy": ["salary"]}}', '{"qualified_min_score": 90, "high_intent_min_score": 50}', '{"llm_enabled": "yes"}', '{"anything": 1}']) {
      expect((await t.fails(owner, `select public.qualification_settings_save($1, $2::jsonb)`, [org, bad])).detail).toBe('VALIDATION_ERROR');
    }
    expect((await t.fails(agent, `select public.qualification_settings_save($1, '{}'::jsonb)`, [org])).detail).toBe('FORBIDDEN');
  });
});

describe('evidence from calls and free text', () => {
  it('uses call evidence: fills gaps as "stated", raises conflicts with CRM values, and asks for review', async () => {
    const l = await t.lead(manager, org, { name: 'Caller Lead', phone: '9811100007', type: 'buyer', locations: ['Worli'], budget_max: 50000000 });
    await tick();
    const call = await one(`insert into public.voice_calls (organization_id, lead_id, contact_id, direction, status, idempotency_key, initiated_by, ended_at, finalized_at, outcome, summary, analysis_status, analysis)
      values ($1, $2, $3, 'outbound', 'completed', $4, 'user', now(), now(), 'connected', 'Buyer wants a 3 BHK in Worli, budget 4 crore, within 3 months.', 'succeeded', $5::jsonb) returning id`,
      [org, l.lead_id, l.contact_id, `k_call_${++seq}`, JSON.stringify({ property_type: 'apartment', bedrooms: 3, timeline: '0-3 months', budget_max: 40000000, currency: 'INR', conflicts: ['budget'], call_outcome: 'qualified_conversation' })]);
    await t.db.query(`select private.emit_event($1, 'voice_call.completed', 'voice_call', $2, null, jsonb_build_object('lead_id', $3::text, 'call_id', $4::text), 'sales_qualification_agent', 'voice_call_completed:' || $4::text)`, [org, call.id, l.lead_id, call.id]);
    await tick();
    // The call has a summary, so the run waits for the model step; the worker reports it unavailable.
    const claims = await t.asService<R>(`select * from public.qualification_analysis_claim(5)`);
    expect(claims[0].sources[0].id).toBe(`call:${call.id}`);
    for (const c of claims) await t.asService(`select public.qualification_attach_analysis($1, null, '{"outcome":"not_configured"}'::jsonb)`, [c.run_id]);
    await tick();
    const q = await current(l.lead_id);
    expect(q.trigger).toBe('voice_call.completed');
    expect(q.requirements.property_type).toEqual({ value: 'apartment', certainty: 'stated', source: `call:${call.id}` });
    expect(q.requirements.budget.certainty).toBe('confirmed'); // CRM value kept
    expect(q.conflicts.map((c: R) => c.field)).toContain('budget');
    expect(q.status).toBe('human_review_required');
    expect(q.review_reasons).toContain('conflicting_information');
    expect(Number((await one(`select budget_max from public.leads where id = $1`, [l.lead_id])).budget_max)).toBe(50000000);
    expect(q.score_breakdown.find((d: R) => d.key === 'engagement').value).toBeGreaterThan(0);
  });

  it('waits for the model step when there is free text; attaches validated proposals without touching the lead', async () => {
    const lead = await intake({ name: 'Free Text Lead', phone: '9811100008', message: 'Hi, maybe looking at a villa in Lonavala for weekends, around 2 crore, sometime next year.' });
    expect((await tick()).processed).toBe(0); // waiting for the model
    const [claim] = await t.asService<R>(`select * from public.qualification_analysis_claim(5)`);
    expect(claim.sources).toEqual([{ id: 'inquiry', text: 'Hi, maybe looking at a villa in Lonavala for weekends, around 2 crore, sometime next year.' }]);
    expect(JSON.stringify(claim)).not.toMatch(/9811100008|Free Text Lead/);
    await t.asService(`select public.qualification_attach_analysis($1, $2::jsonb, '{"model":"test","outcome":"ok"}'::jsonb)`, [claim.run_id, JSON.stringify({
      intent: { value: 'buy', certainty: 'inferred', source: 'inquiry', quote: 'maybe looking at a villa' },
      locations: { values: ['Lonavala'], certainty: 'stated', source: 'inquiry', quote: 'in Lonavala' },
      budget: { min: null, max: 20000000, currency: 'INR', certainty: 'stated', source: 'inquiry', quote: 'around 2 crore' },
      property_type: { value: 'villa', certainty: 'stated', source: 'note:00000000-0000-0000-0000-000000000000', quote: 'a villa' },
      bedrooms: null, timeline: { value: '12+ months', certainty: 'inferred', source: 'inquiry', quote: 'sometime next year' },
      purpose: 'other', constraints: ['weekends'], contradictions: [], summary: 'Possible weekend villa buyer.',
      questions: [{ field: 'property_type', question: 'Is it a villa you have in mind?' }, { field: 'salary', question: 'What is your salary?' }],
      organization_id: orgB,
    })]);
    await tick();
    const q = await current(lead);
    expect(q.analysis_status).toBe('succeeded');
    expect(q.requirements.intent).toEqual({ value: 'buy', certainty: 'inferred', source: 'inquiry' });
    expect(q.requirements.budget.value).toEqual({ min: null, max: 20000000, currency: 'INR' });
    expect(q.requirements.property_type).toBeUndefined(); // cited a source that is not this lead's
    expect(q.status).toBe('human_review_required');
    expect(q.review_reasons).toContain('low_confidence_intent');
    expect(q.summary).toBe('Possible weekend villa buyer.');
    const ld = await one(`select desired_locations, budget_max, desired_property_type from public.leads where id = $1`, [lead]);
    expect(ld).toEqual({ desired_locations: [], budget_max: null, desired_property_type: null });
  });

  it('a failed or unavailable model step never blocks or erases: the deterministic result still lands', async () => {
    const lead = await intake({ name: 'Model Down', phone: '9811100009', message: 'Looking to rent a 2 BHK in Andheri from next month.' });
    await tick(); // consumes the intake event; the run then waits for the model step
    const [claim] = await t.asService<R>(`select * from public.qualification_analysis_claim(5)`);
    await t.asService(`select public.qualification_attach_analysis($1, null, '{"outcome":"not_configured"}'::jsonb)`, [claim.run_id]);
    await tick();
    expect(await current(lead)).toMatchObject({ analysis_status: 'not_configured', status: 'needs_information' });
    // A model step that never returns is skipped after 10 minutes.
    await request(manager, lead);
    await t.db.query(`update public.agent_runs set received_at = now() - interval '11 minutes' where lead_id = $1 and agent_id = 'sales_qualification_agent' and status = 'received'`, [lead]);
    await tick();
    expect((await current(lead)).analysis_status).toBe('skipped');
    expect(await rows(`select 1 from public.lead_qualifications where lead_id = $1`, [lead])).toHaveLength(2);
  });
});

describe('orchestration', () => {
  it('duplicate events and repeated requests do not create duplicate runs; older pending runs are superseded', async () => {
    const l = await t.lead(manager, org, { name: 'Dup Events', phone: '9811100010', type: 'buyer' });
    const [{ r: a }] = await t.db.query<R>(`select private.qual_enqueue($1, $2, 'lead.ready_for_qualification', 'evt:dup-1', 'integration') r`, [org, l.lead_id]).then((x) => x.rows);
    const [{ r: b }] = await t.db.query<R>(`select private.qual_enqueue($1, $2, 'lead.ready_for_qualification', 'evt:dup-1', 'integration') r`, [org, l.lead_id]).then((x) => x.rows);
    expect(a).toBe(b);
    await tick();
    const runs = await rows<R>(`select status, outcome from public.agent_runs where lead_id = $1 and agent_id = 'sales_qualification_agent' order by received_at`, [l.lead_id]);
    expect(runs.some((r) => r.outcome?.action === 'superseded')).toBe(true);
    expect(await rows(`select 1 from public.lead_qualifications where lead_id = $1`, [l.lead_id])).toHaveLength(1);
  });

  it('a failed attempt rolls back, keeps the last valid result current, and succeeds on retry', async () => {
    const l = await t.lead(manager, org, { name: 'Flaky Qual', phone: '9811100011', type: 'buyer', locations: ['Worli'], budget_max: 10000000, property_type: 'apartment', timeline: '1 month' });
    await tick();
    const before = await current(l.lead_id);
    await t.db.exec(`create function public.qboom() returns trigger language plpgsql as $$ begin raise exception 'simulated'; end $$;
      create trigger qboom before insert on public.lead_qualifications for each row execute function public.qboom();`);
    const req = await request(manager, l.lead_id);
    await tick();
    expect((await one(`select status, attempt_count from public.agent_runs where id = $1`, [req.run_id]))).toMatchObject({ status: 'retry_scheduled', attempt_count: 1 });
    expect((await current(l.lead_id)).id).toBe(before.id);
    await t.db.exec(`drop trigger qboom on public.lead_qualifications; drop function public.qboom();`);
    await t.db.query(`update public.agent_runs set next_attempt_at = now() - interval '1 second' where id = $1`, [req.run_id]);
    await tick();
    expect((await one(`select status from public.agent_runs where id = $1`, [req.run_id])).status).toBe('succeeded');
    expect((await current(l.lead_id)).id).not.toBe(before.id);
  });

  it('closed leads are not qualified', async () => {
    const l = await t.lead(manager, org, { name: 'Closed Lead', phone: '9811100012' });
    await t.db.query(`update public.leads set status = 'lost', lost_reason = 'Budget' where id = $1`, [l.lead_id]);
    await tick();
    expect(await current(l.lead_id)).toBeUndefined();
    expect((await t.fails(manager, `select public.qualification_request($1, 'k_closed_lead_1')`, [l.lead_id])).detail).toBe('VALIDATION_ERROR');
  });
});

describe('human review', () => {
  it('only reviewers decide; overrides need a note, emit the handoff and are audited', async () => {
    const l = await t.lead(manager, org, { name: 'Review Me', phone: '9811100013', type: 'buyer', locations: ['Pune'], budget_max: 9000000, property_type: 'apartment', timeline: '1 month' });
    await t.as(owner, `select public.qualification_settings_save($1, '{"scope": {"locations": ["Mumbai"]}}'::jsonb)`, [org]);
    await tick();
    await t.as(owner, `select public.qualification_settings_save($1, '{}'::jsonb)`, [org]);
    const q = await current(l.lead_id);
    expect(q.status).toBe('human_review_required');
    expect((await t.fails(agent, `select public.qualification_review($1, 'override', 'qualified', null, 'ok')`, [q.id])).detail).toBe('FORBIDDEN');
    expect((await t.fails(manager, `select public.qualification_review($1, 'approve')`, [q.id])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(manager, `select public.qualification_review($1, 'override', 'qualified')`, [q.id])).detail).toBe('VALIDATION_ERROR');
    await t.as(manager, `select public.qualification_review($1, 'override', 'qualified', null, 'Pune office covers this')`, [q.id]);
    expect(await current(l.lead_id)).toMatchObject({ status: 'qualified', review_status: 'overridden', reviewed_by: manager });
    expect(await events(l.lead_id, 'lead.qualification.completed')).toHaveLength(1);
    expect(await rows(`select 1 from public.tasks where related_lead_id = $1 and title like 'Review qualification%' and status = 'open'`, [l.lead_id])).toHaveLength(0);
    expect(await rows(`select 1 from public.audit_logs where action = 'qualification.reviewed' and entity_id = $1`, [q.id])).toHaveLength(1);
  });

  it('confirmed edits are written to the CRM by the reviewer and trigger re-qualification', async () => {
    const lead = await intake({ name: 'Needs Edits', phone: '9811100014' });
    await tick();
    const q = await current(lead);
    const [{ r }] = await t.as<R>(owner, `select public.qualification_review($1, 'reject', null, $2::jsonb, 'Confirmed on phone') r`, [q.id,
      JSON.stringify({ intent: 'rent', locations: ['Bandra'], budget_max: 150000, property_type: 'apartment', timeline: 'Immediate' })]);
    expect(r.requalify_run).toBeTruthy();
    const ld = await one(`select desired_transaction, desired_locations, budget_max, timeline, metadata from public.leads where id = $1`, [lead]);
    expect(ld).toMatchObject({ desired_transaction: 'rent', desired_locations: ['Bandra'], timeline: 'Immediate' });
    expect(Number(ld.budget_max)).toBe(150000);
    expect(ld.metadata.intake.missing).not.toContain('intent');
    await tick();
    expect(await current(lead)).toMatchObject({ status: 'qualified', trigger: 'qualification.edited' });
    expect((await t.fails(owner, `select public.qualification_review($1, 'reject', null, null, 'old one')`, [q.id])).detail).toBe('CONFLICT');
    expect((await t.fails(owner, `select public.qualification_review($1, 'reject', null, '{"bedrooms": 99}'::jsonb, 'bad edit')`, [(await current(lead)).id])).detail).toBe('VALIDATION_ERROR');
    // "edit" only confirms values: no note needed, review status untouched, re-qualifies.
    const cur = await current(lead);
    expect((await t.fails(owner, `select public.qualification_review($1, 'edit')`, [cur.id])).detail).toBe('VALIDATION_ERROR');
    await t.as(owner, `select public.qualification_review($1, 'edit', null, '{"bedrooms": 2}'::jsonb)`, [cur.id]);
    expect((await one(`select review_status from public.lead_qualifications where id = $1`, [cur.id])).review_status).toBe(cur.review_status);
    expect((await one(`select bedrooms from public.leads where id = $1`, [lead])).bedrooms).toBe(2);
  });
});

describe('security', () => {
  it('privileged functions are service-role only and clients cannot write qualification data', async () => {
    for (const sql of [`select public.qualification_tick(1)`, `select public.qualification_process(gen_random_uuid())`, `select * from public.qualification_analysis_claim(1)`,
      `select public.qualification_attach_analysis(gen_random_uuid(), '{}'::jsonb, '{}'::jsonb)`, `select public.qualification_worker_secret_ok('x')`]) {
      expect((await t.fails(owner, sql)).message).toMatch(/permission denied/);
    }
    const [{ id }] = await t.as<{ id: string }>(owner, `select id from public.leads where qualification_status is not null limit 1`);
    expect((await t.fails(owner, `update public.leads set qualification_status = 'high_intent' where id = $1`, [id])).message).toMatch(/permission denied/);
    expect((await t.fails(owner, `update public.lead_qualifications set score = 100`)).message).toMatch(/permission denied/);
    expect((await t.fails(owner, `insert into public.qualification_settings (organization_id, rules) values ($1, '{}')`, [org])).message).toMatch(/permission denied/);
  });

  it('tenant isolation: another org cannot qualify, read, review, or reconfigure', async () => {
    const [{ id: leadA }] = await t.as<{ id: string }>(owner, `select id from public.leads where qualification_id is not null limit 1`);
    const qA = await current(leadA);
    expect((await t.fails(ownerB, `select public.qualification_request($1, 'k_cross_tenant_q')`, [leadA])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.lead_qualification($1)`, [leadA])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.qualification_review($1, 'reject', null, null, 'cross')`, [qA.id])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.qualification_settings_save($1, '{}'::jsonb)`, [org])).detail).toBe('FORBIDDEN');
    expect(await t.as(ownerB, `select 1 from public.lead_qualifications where organization_id = $1`, [org])).toHaveLength(0);
    expect(await t.as(ownerB, `select 1 from public.agent_runs where organization_id = $1`, [org])).toHaveLength(0);
    expect(await t.as(ownerB, `select 1 from public.outbox_events where organization_id = $1`, [org])).toHaveLength(0);
    // An outbox event naming a lead from another org is acknowledged and ignored.
    await t.db.query(`select private.emit_event($1, 'lead.ready_for_qualification', 'lead', $2, null, jsonb_build_object('lead_id', $3::text), 'sales_qualification_agent', 'cross:' || $3::text)`, [orgB, leadA, leadA]);
    const before = await rows(`select 1 from public.lead_qualifications where lead_id = $1`, [leadA]);
    await tick();
    expect(await rows(`select 1 from public.lead_qualifications where lead_id = $1`, [leadA])).toHaveLength(before.length);
    expect(await rows(`select 1 from public.agent_runs where organization_id = $1 and lead_id = $2`, [orgB, leadA])).toHaveLength(0);
  });

  it('the lead read model shows the current result, history and run status to people who can see the lead', async () => {
    const [{ id }] = await t.as<{ id: string }>(agent, `select id from public.leads where qualification_id is not null limit 1`);
    const [{ r }] = await t.as<R>(agent, `select public.lead_qualification($1) r`, [id]);
    expect(r.current).toBeTruthy();
    expect(r.current.organization_id).toBeUndefined();
    expect(r.history.length).toBeGreaterThan(0);
    expect(r).toMatchObject({ can_review: false, can_run: true });
  });
});
