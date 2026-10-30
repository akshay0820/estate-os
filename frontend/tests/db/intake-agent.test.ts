// Agent 01 — Lead Intake Agent: normalization, dedupe, assignment, handoff, retries and tenant isolation.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, type TestDb } from './harness';

let t: TestDb;
let org: string, owner: string, manager: string, agentWorli: string, agentPowai: string, viewer: string;
let orgB: string, ownerB: string, agentB: string;
let seq = 0;

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Webhook path as the Edge Function drives it: receive → (extraction) → process. */
async function intake(payload: R, opts: { org?: string; event?: string; extraction?: R | null; meta?: R } = {}) {
  const event = opts.event ?? `evt_${++seq}`;
  const [{ r: rec }] = await t.asService<{ r: R }>(`select public.intake_receive($1, 'webhook', 'webhook', $2, $3::jsonb) r`, [opts.org ?? org, event, JSON.stringify(payload)]);
  if (rec.status === 'duplicate_event') return { ...rec, event };
  if (opts.extraction !== undefined || opts.meta) {
    await t.asService(`select public.intake_attach_extraction($1, $2::jsonb, $3::jsonb)`, [rec.run_id, opts.extraction == null ? null : JSON.stringify(opts.extraction), JSON.stringify(opts.meta ?? { outcome: 'ok', model: 'test' })]);
  }
  const [{ r }] = await t.asService<{ r: R }>(`select public.intake_process($1) r`, [rec.run_id]);
  return { ...r, event, needs_extraction: rec.needs_extraction };
}
const normalize = async (p: R, country = 'IN', currency = 'INR') =>
  (await t.db.query<{ n: R }>(`select private.intake_normalize($1::jsonb, $2, $3, 'Website') n`, [JSON.stringify(p), country, currency])).rows[0].n;
const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const rows = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows;
const setIntake = (o: string, intakeCfg: R) =>
  t.db.query(`update public.organizations set settings = settings || jsonb_build_object('intake', $2::jsonb) where id = $1`, [o, JSON.stringify(intakeCfg)]);

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Aanya Kapoor');
  manager = await t.user('Priya Nair');
  agentWorli = await t.user('Arjun Desai');
  agentPowai = await t.user('Meera Iyer');
  viewer = await t.user('Vee Viewer');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, manager, 'manager');
  await t.member(org, agentWorli, 'agent', ['Worli']);
  await t.member(org, agentPowai, 'agent', ['Powai']);
  await t.member(org, viewer, 'viewer');
  await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{assignment}', '"by_locality"') where id = $1`, [org]);
  ownerB = await t.user('Bina Bose');
  agentB = await t.user('Bob Agent');
  orgB = await t.org(ownerB, 'Other Agency');
  await t.member(orgB, agentB, 'agent', ['Worli']);
}, 120000);

describe('normalization (deterministic)', () => {
  it('normalizes names, email, phone and requirement fields without inventing values', async () => {
    const n = await normalize({ first_name: '  Riya ', last_name: 'Shah  ', email: ' Riya@Example.COM ', phone: '098200 12345', property_type: 'Flat', bedrooms: '2', locations: ['Worli', 'worli ', ' Bandra'], intent: 'buy' });
    expect(n).toMatchObject({ ok: true, name: 'Riya Shah', email: 'riya@example.com', phone: '+919820012345', property_type: 'apartment', bedrooms: 2, locations: ['Worli', 'Bandra'], intent: 'buy', lead_type: 'buyer' });
    expect(n.missing).toEqual(['budget', 'timeline']);
    expect(n.budget_max).toBeNull();
  });

  it('never assumes a phone country, and accepts explicit international numbers', async () => {
    expect((await normalize({ phone: '+44 20 7946 0958' })).phone).toBe('+442079460958');
    const ae = await normalize({ name: 'Omar', phone: '050 123 4567', email: 'o@x.ae' }, 'AE', 'AED');
    expect(ae.phone).toBeNull();
    expect(ae.warnings).toContain('phone_needs_country_code');
    expect((await normalize({ phone: '9820012345', phone_country: 'US', email: 'a@b.co' })).warnings).toContain('phone_needs_country_code');
  });

  it('drops bad contact data with a warning, but requires one usable contact method', async () => {
    const n = await normalize({ name: 'X', email: 'not-an-email', phone: '9820012345' });
    expect(n).toMatchObject({ ok: true, email: null, phone: '+919820012345' });
    expect(n.warnings).toContain('email_invalid');
    expect((await normalize({ name: 'X', email: 'nope' })).errors).toEqual(['contact_method_required']);
    expect((await normalize('not an object' as unknown as R)).errors).toEqual(['payload_not_object']);
  });

  it('validates budgets: no inverted ranges, no silent currency mixing', async () => {
    const inv = await normalize({ phone: '9820012345', budget_min: 9000000, budget_max: 7000000 });
    expect([inv.budget_min, inv.budget_max]).toEqual([null, null]);
    expect(inv.warnings).toContain('budget_range_inverted');
    const usd = await normalize({ phone: '9820012345', budget_max: '500000', currency: 'usd' });
    expect(usd).toMatchObject({ budget_max: 500000, currency: 'USD' });
    expect(usd.warnings).toContain('currency_differs_from_org');
    const bad = await normalize({ phone: '9820012345', budget_max: 500000, currency: 'dollars' });
    expect(bad.budget_max).toBeNull();
    expect((await normalize({ phone: '9820012345', budget_max: -5, bedrooms: 2.5 })).warnings).toEqual(expect.arrayContaining(['budget_invalid', 'bedrooms_invalid']));
  });

  it('keeps a missing name as missing information', async () => {
    const n = await normalize({ phone: '9820012345', organization_id: 'evil' });
    expect(n.name).toBeNull();
    expect(n.missing).toContain('name');
    expect(n.warnings).toContain('unknown_fields_ignored');
  });
});

describe('intake pipeline', () => {
  it('creates contact + lead, assigns by policy, records activity and emits the handoff', async () => {
    const r = await intake({ name: 'Ira Sen', phone: '9811122233', source: 'Meta Ads', locations: ['Worli'], budget_max: 30000000, consent_channels: ['whatsapp'] });
    expect(r).toMatchObject({ status: 'created', duplicate: 'none', assignment: 'policy_by_locality' });
    const lead = await one(`select * from public.leads where id = $1`, [r.lead_id]);
    expect(lead).toMatchObject({ assigned_to: agentWorli, intake_status: 'completed', duplicate_status: 'unique', source: 'Meta Ads', source_external_id: r.event, budget_currency: 'INR' });
    expect(await one(`select reason from public.lead_assignments where lead_id = $1`, [r.lead_id])).toEqual({ reason: 'Lead Intake Agent: policy_by_locality' });
    const acts = await rows(`select title, actor_name, source from public.activities where lead_id = $1 and activity_type = 'workflow'`, [r.lead_id]);
    expect(acts).toEqual([{ title: 'Intake completed', actor_name: 'Lead Intake Agent', source: 'workflow' }]);
    const consent = await one(`select status from public.communication_consents where contact_id = $1 and channel = 'whatsapp'`, [lead.contact_id]);
    expect(consent.status).toBe('granted');

    const ev = await one(`select * from public.outbox_events where record_id = $1 and event_type = 'lead.ready_for_qualification'`, [r.lead_id]);
    expect(ev).toMatchObject({ consumer: 'sales_qualification_agent', status: 'pending', schema_version: 1 });
    expect(ev.payload).toMatchObject({ event_type: 'lead.ready_for_qualification', schema_version: 1, organization_id: org, lead_id: r.lead_id, source: 'lead_intake_agent' });
    expect(Object.keys(ev.payload).sort()).toEqual(['correlation_id', 'event_type', 'lead_id', 'missing_information', 'organization_id', 'schema_version', 'source']);

    const run = await one(`select * from public.agent_runs where id = $1`, [r.run_id]);
    expect(run).toMatchObject({ status: 'succeeded', attempt_count: 1, lead_id: r.lead_id, agent_id: 'lead_intake_agent' });
    expect(run.input.redacted).toBe(true);
    expect(JSON.stringify(run.input)).not.toContain('9811122233');
    const steps = await rows<{ step: string }>(`select step from public.agent_run_steps where run_id = $1 order by created_at`, [r.run_id]);
    expect(steps.map((s) => s.step)).toEqual(['receive', 'validate', 'deduplicate', 'assign', 'persist', 'handoff']);
    expect((await one(`select processing_status, lead_id from public.webhook_events where provider_event_id = $1`, [r.event]))).toEqual({ processing_status: 'processed', lead_id: r.lead_id });
  });

  it('is idempotent per event: redelivery creates nothing new', async () => {
    const first = await intake({ name: 'Kabir Rao', email: 'kabir@example.com' }, { event: 'evt_retry' });
    const counts = async () => one(`select (select count(*) from public.leads)::int l, (select count(*) from public.contacts)::int c, (select count(*) from public.activities)::int a, (select count(*) from public.outbox_events)::int o`);
    const before = await counts();
    const again = await Promise.all([1, 2, 3].map(() => intake({ name: 'Kabir Rao', email: 'kabir@example.com' }, { event: 'evt_retry' })));
    expect(again.every((x) => x.status === 'duplicate_event' && x.lead_id === first.lead_id)).toBe(true);
    expect(await counts()).toEqual(before);
    expect((await one(`select attempt_count from public.webhook_events where provider_event_id = 'evt_retry'`)).attempt_count).toBe(4);
    // Re-processing a finished run is a no-op that replays its result.
    const [{ r: replay }] = await t.asService<{ r: R }>(`select public.intake_process($1) r`, [first.run_id]);
    expect(replay).toMatchObject({ status: 'created', replayed: true, lead_id: first.lead_id });
    expect(await counts()).toEqual(before);
  });

  it('links a high-confidence repeat enquiry to the open lead, filling only empty fields', async () => {
    const a = await intake({ name: 'Neha Joshi', phone: '9822200011', budget_max: 15000000, source: 'Website' });
    const b = await intake({ name: 'Neha J', phone: '+91 98222 00011', email: 'neha@example.com', budget_max: 99000000, timeline: '0-3 months', source: '99acres' });
    expect(b).toMatchObject({ status: 'repeat_enquiry', duplicate: 'match', lead_id: a.lead_id });
    const lead = await one(`select * from public.leads where id = $1`, [a.lead_id]);
    expect(Number(lead.budget_max)).toBe(15000000); // not overwritten
    expect(lead.timeline).toBe('0-3 months'); // filled
    expect(lead.source).toBe('Website'); // original attribution kept
    expect(lead.metadata.enquiry_count).toBe(2);
    expect((await one(`select email_normalized from public.contacts where id = $1`, [lead.contact_id])).email_normalized).toBe('neha@example.com');
    const act = await one(`select title from public.activities where lead_id = $1 and title like 'Repeat enquiry%'`, [a.lead_id]);
    expect(act.title).toBe('Repeat enquiry via 99acres');
    expect((await rows(`select 1 from public.outbox_events where record_id = $1 and event_type = 'lead.ready_for_qualification'`, [a.lead_id]))).toHaveLength(1);
  });

  it('matches by stable external id from the same source', async () => {
    const a = await intake({ name: 'Ext Person', email: 'ext1@example.com', source: 'MagicBricks', external_lead_id: 'MB-778' });
    const b = await intake({ name: 'Ext Person', email: 'different@example.com', source: 'MagicBricks', external_lead_id: 'MB-778' });
    expect(b).toMatchObject({ status: 'repeat_enquiry', duplicate: 'same_external_id', lead_id: a.lead_id });
  });

  it('creates a new lead on the existing contact when their earlier enquiry is closed', async () => {
    const a = await intake({ name: 'Closed Case', phone: '9833300022' });
    await t.db.query(`update public.leads set status = 'lost', lost_reason = 'Budget' where id = $1`, [a.lead_id]);
    const b = await intake({ name: 'Closed Case', phone: '9833300022', locations: ['Powai'] });
    expect(b).toMatchObject({ status: 'created', duplicate: 'match' });
    expect(b.lead_id).not.toBe(a.lead_id);
    const [la, lb] = [await one(`select contact_id from public.leads where id = $1`, [a.lead_id]), await one(`select contact_id, duplicate_status from public.leads where id = $1`, [b.lead_id])];
    expect(lb).toEqual({ contact_id: la.contact_id, duplicate_status: 'linked_contact' });
  });

  it('never merges ambiguous matches: separate lead, review item, no handoff until resolved', async () => {
    await intake({ name: 'Rohan Mehta', phone: '9844400033' });
    await intake({ name: 'Sara Khan', email: 'sara@example.com' });
    const r = await intake({ name: 'R Mehta', phone: '9844400033', email: 'sara@example.com' });
    expect(r).toMatchObject({ status: 'review_required', duplicate: 'ambiguous' });
    const lead = await one(`select * from public.leads where id = $1`, [r.lead_id]);
    expect(lead).toMatchObject({ intake_status: 'review_required', duplicate_status: 'possible_duplicate' });
    const rv = await one(`select * from public.review_items where lead_id = $1`, [r.lead_id]);
    expect(rv.candidate_contact_ids).toHaveLength(2);
    expect(rv.reasons).toEqual(['phone_and_email_match_different_contacts']);
    expect(await rows(`select 1 from public.outbox_events where record_id = $1 and event_type = 'lead.ready_for_qualification'`, [r.lead_id])).toHaveLength(0);
    expect(await t.as(manager, `select 1 from public.notifications where entity_id = $1 and title like 'Possible duplicate%'`, [r.lead_id])).toHaveLength(1);

    const summary = (await t.as<{ s: R }>(agentWorli, `select public.lead_intake_summary($1) s`, [r.lead_id]))[0].s;
    expect(summary.review.candidates.map((c: R) => c.name).sort()).toEqual(['Rohan Mehta', 'Sara Khan']);
    expect((await t.fails(agentWorli, `select public.resolve_intake_review($1, 'distinct')`, [rv.id])).detail).toBe('FORBIDDEN');
    await t.as(manager, `select public.resolve_intake_review($1, 'distinct')`, [rv.id]);
    expect(await one(`select intake_status, duplicate_status from public.leads where id = $1`, [r.lead_id])).toEqual({ intake_status: 'completed', duplicate_status: 'resolved_distinct' });
    expect(await rows(`select 1 from public.outbox_events where record_id = $1 and event_type = 'lead.ready_for_qualification'`, [r.lead_id])).toHaveLength(1);
    expect((await t.fails(manager, `select public.resolve_intake_review($1, 'distinct')`, [rv.id])).detail).toBe('CONFLICT');
  });

  it('flags same phone with an unrelated name, and merges after a reviewer confirms', async () => {
    const a = await intake({ name: 'Anil Kumar', phone: '9855500044', locations: ['Worli'] });
    const b = await intake({ name: 'Deepa Pillai', phone: '9855500044', timeline: 'Immediate' });
    expect(b).toMatchObject({ status: 'review_required' });
    const rv = await one(`select * from public.review_items where lead_id = $1`, [b.lead_id]);
    expect(rv.reasons).toEqual(['same_phone_different_name']);
    // The kept lead must belong to a candidate contact.
    const other = await intake({ name: 'Unrelated', email: 'unrelated@example.com' });
    expect((await t.fails(manager, `select public.resolve_intake_review($1, 'duplicate', $2)`, [rv.id, other.lead_id])).detail).toBe('INVALID_REFERENCE');
    await t.as(manager, `select public.resolve_intake_review($1, 'duplicate', $2)`, [rv.id, a.lead_id]);
    const merged = await one(`select archived_at, duplicate_status, metadata from public.leads where id = $1`, [b.lead_id]);
    expect(merged.archived_at).not.toBeNull();
    expect(merged.duplicate_status).toBe('merged');
    expect(merged.metadata.merged_into).toBe(a.lead_id);
    const kept = await one(`select timeline from public.leads where id = $1`, [a.lead_id]);
    expect(kept.timeline).toBe('Immediate');
    // History moved to the kept lead; only the archive marker stays on the merged one.
    expect(await rows(`select title from public.activities where lead_id = $1`, [b.lead_id])).toEqual([{ title: 'Archived' }]);
    expect(await rows(`select 1 from public.activities where lead_id = $1 and title = 'Possible duplicate — waiting for review'`, [a.lead_id])).toHaveLength(1);
  });
});

describe('assignment rules', () => {
  it('property listing agent first, then source rule, then fallback, else the unassigned queue', async () => {
    await t.as(owner, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, area_value, locality, listing_agent_id) values ($1, 'SKY-101', 'Sea view 3 BHK', 'apartment', 'sale', 'active', 50000000, 1400, 'Worli', $2)`, [org, agentPowai]);
    expect((await intake({ name: 'Prop Lead', email: 'p1@example.com', property_ref: 'sky-101', locations: ['Worli'] })).assignment).toBe('property_listing_agent');

    await setIntake(org, { source_rules: [{ source: 'Housing.com', user_id: agentPowai }] });
    const s = await intake({ name: 'Src Lead', email: 'p2@example.com', source: 'housing.com', locations: ['Worli'] });
    expect(s.assignment).toBe('source_rule');
    expect((await one(`select assigned_to from public.leads where id = $1`, [s.lead_id])).assigned_to).toBe(agentPowai);

    // Settings refuse assignees outside the organization.
    await expect(setIntake(org, { source_rules: [{ source: 'X', user_id: agentB }] })).rejects.toThrow(/intake rules are invalid/);
    await expect(setIntake(org, { fallback_user_id: ownerB })).rejects.toThrow(/intake rules are invalid/);

    // No active agents: fallback, then unassigned (with a notification to people who can assign).
    await t.db.query(`update public.organization_memberships set status = 'suspended' where organization_id = $1 and role = 'agent'`, [org]);
    await setIntake(org, { fallback_user_id: manager });
    expect((await intake({ name: 'Fallback Lead', email: 'p3@example.com' })).assignment).toBe('fallback');
    await setIntake(org, {});
    const u = await intake({ name: 'Queue Lead', email: 'p4@example.com' });
    expect(u.assignment).toBe('unassigned_queue');
    expect((await one(`select assigned_to from public.leads where id = $1`, [u.lead_id])).assigned_to).toBeNull();
    expect(await t.as(manager, `select 1 from public.notifications where entity_id = $1 and title like 'Unassigned lead%'`, [u.lead_id])).toHaveLength(1);
    await t.db.query(`update public.organization_memberships set status = 'active' where organization_id = $1 and role = 'agent'`, [org]);
  });

  it('round-robin rotates through active agents', async () => {
    await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{assignment}', '"round_robin"') where id = $1`, [org]);
    const picks = [];
    for (let i = 0; i < 4; i++) picks.push((await one(`select assigned_to from public.leads where id = $1`, [(await intake({ name: `RR ${i}`, email: `rr${i}@example.com` })).lead_id])).assigned_to);
    expect(new Set(picks)).toEqual(new Set([agentWorli, agentPowai]));
    expect(picks[0]).not.toBe(picks[1]);
    expect(picks[2]).toBe(picks[0]);
    await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{assignment}', '"by_locality"') where id = $1`, [org]);
  });
});

describe('model extraction (untrusted)', () => {
  it('fills only empty requirement fields and records provenance', async () => {
    const r = await intake(
      { name: 'Free Text', email: 'ft@example.com', message: 'Looking for a 2 BHK apartment in Pune around 75 to 85 lakh, buying in 3 months', bedrooms: 3 },
      { extraction: { intent: 'buy', preferred_locations: ['Pune'], property_type: 'apartment', bedrooms: 2, budget_min: 7500000, budget_max: 8500000, currency: 'INR', timeline: '0-3 months', organization_id: orgB, contradictions: ['Says 2 BHK but form says 3'] } },
    );
    expect(r.needs_extraction).toBe(true);
    const lead = await one(`select * from public.leads where id = $1`, [r.lead_id]);
    expect(lead).toMatchObject({ organization_id: org, bedrooms: 3, desired_property_type: 'apartment', desired_locations: ['Pune'], timeline: '0-3 months', desired_transaction: 'buy' });
    expect(Number(lead.budget_max)).toBe(8500000);
    expect(lead.ai_extracted_fields.sort()).toEqual(['budget', 'intent', 'locations', 'propertyType', 'timeline']);
    expect(lead.metadata.intake.ai_contradictions).toEqual(['Says 2 BHK but form says 3']);
    expect(r.warnings).toContain('ai_flagged_contradiction');
  });

  it('never applies a model currency to a structured budget, and drops invalid proposals', async () => {
    const r = await intake({ name: 'Cur', email: 'cur@example.com', budget_max: 9000000, message: 'budget is 90 lakh' }, { extraction: { currency: 'USD', budget_min: 100, bedrooms: 99, property_type: 'castle' } });
    const lead = await one(`select budget_currency, budget_min, bedrooms, desired_property_type, ai_extracted_fields from public.leads where id = $1`, [r.lead_id]);
    expect(lead).toMatchObject({ budget_currency: 'INR', budget_min: null, bedrooms: null, desired_property_type: null, ai_extracted_fields: [] });
    expect(r.warnings).toEqual(expect.arrayContaining(['bedrooms_invalid', 'property_type_invalid']));
  });

  it('works without the model (disabled, timeout, oversized output)', async () => {
    expect((await intake({ name: 'NoModel', email: 'nm@example.com', message: 'hi there please call me back' }, { extraction: null, meta: { outcome: 'timeout', model: 'x' } })).status).toBe('created');
    const big = { amenities: Array.from({ length: 2000 }, (_, i) => `amenity number ${i}`) };
    const r = await intake({ name: 'Big', email: 'big@example.com' }, { extraction: big });
    expect(r.status).toBe('created');
    expect((await one(`select model_meta from public.agent_runs where id = $1`, [r.run_id])).model_meta.outcome).toBe('invalid_output');
  });
});

describe('failures, retries and quarantine', () => {
  it('quarantines invalid submissions with their input preserved for troubleshooting', async () => {
    const r = await intake({ name: 'No contact' });
    expect(r).toMatchObject({ status: 'invalid', errors: ['contact_method_required'] });
    const run = await one(`select status, input, error_category from public.agent_runs where id = $1`, [r.run_id]);
    expect(run).toEqual({ status: 'invalid', input: { name: 'No contact' }, error_category: 'validation' });
    expect(await rows(`select 1 from public.outbox_events where record_id = $1 and event_type = 'lead.intake_failed'`, [r.run_id])).toHaveLength(1);
    expect((await one(`select processing_status from public.webhook_events where provider_event_id = $1`, [r.event])).processing_status).toBe('failed');
  });

  it('rolls back a failed attempt completely, then recovers on retry', async () => {
    await t.db.exec(`create function public.boom() returns trigger language plpgsql as $$ begin if new.display_name = 'Flaky Person' then raise exception 'simulated outage'; end if; return new; end $$;
      create trigger boom before insert on public.contacts for each row execute function public.boom();`);
    const r = await intake({ name: 'Flaky Person', email: 'flaky@example.com' });
    expect(r.status).toBe('retry_scheduled');
    expect(await rows(`select 1 from public.contacts where display_name = 'Flaky Person'`)).toHaveLength(0);
    let run = await one(`select status, attempt_count, error_category, next_attempt_at from public.agent_runs where id = $1`, [r.run_id]);
    expect(run).toMatchObject({ status: 'retry_scheduled', attempt_count: 1, error_category: 'unknown' });
    expect(run.next_attempt_at).not.toBeNull();
    // Not due yet → the worker leaves it alone.
    expect((await t.asService<{ n: number }>(`select public.intake_process_due(10) n`))[0].n).toBe(0);
    await t.db.exec(`drop trigger boom on public.contacts; drop function public.boom();`);
    await t.db.query(`update public.agent_runs set next_attempt_at = now() - interval '1 second' where id = $1`, [r.run_id]);
    expect((await t.asService<{ n: number }>(`select public.intake_process_due(10) n`))[0].n).toBe(1);
    run = await one(`select status, attempt_count, lead_id from public.agent_runs where id = $1`, [r.run_id]);
    expect(run).toMatchObject({ status: 'succeeded', attempt_count: 2 });
    expect(await rows(`select 1 from public.leads where id = $1`, [run.lead_id])).toHaveLength(1);
    const steps = await rows<{ step: string; status: string }>(`select step, status from public.agent_run_steps where run_id = $1 order by created_at`, [r.run_id]);
    expect(steps.filter((s) => s.step === 'attempt')).toEqual([{ step: 'attempt', status: 'failed' }]);
  });

  it('dead-letters after the retry budget and resumes abandoned submissions', async () => {
    await t.db.exec(`create function public.boom2() returns trigger language plpgsql as $$ begin raise exception 'down'; end $$;
      create trigger boom2 before insert on public.contacts for each row execute function public.boom2();`);
    const [{ r: rec }] = await t.asService<{ r: R }>(`select public.intake_receive($1, 'webhook', 'webhook', 'evt_dead', '{"name":"Dead","email":"dead@example.com"}'::jsonb) r`, [org]);
    await t.db.query(`update public.agent_runs set max_attempts = 1 where id = $1`, [rec.run_id]);
    const [{ r }] = await t.asService<{ r: R }>(`select public.intake_process($1) r`, [rec.run_id]);
    expect(r.status).toBe('dead_letter');
    expect((await one(`select processing_status from public.webhook_events where provider_event_id = 'evt_dead'`)).processing_status).toBe('dead_letter');
    expect(await rows(`select 1 from public.outbox_events where record_id = $1 and event_type = 'lead.intake_failed'`, [rec.run_id])).toHaveLength(1);
    await t.db.exec(`drop trigger boom2 on public.contacts; drop function public.boom2();`);

    // A run received but never processed (function crashed) is picked up after 2 minutes.
    const [{ r: lost }] = await t.asService<{ r: R }>(`select public.intake_receive($1, 'webhook', 'webhook', 'evt_lost', '{"name":"Lost","email":"lost@example.com"}'::jsonb) r`, [org]);
    await t.asService(`select public.intake_process_due(10)`);
    expect((await one(`select status from public.agent_runs where id = $1`, [lost.run_id])).status).toBe('received');
    await t.db.query(`update public.agent_runs set received_at = now() - interval '3 minutes' where id = $1`, [lost.run_id]);
    await t.asService(`select public.intake_process_due(10)`);
    expect((await one(`select status from public.agent_runs where id = $1`, [lost.run_id])).status).toBe('succeeded');
  });
});

describe('outbox delivery', () => {
  it('leases events to one consumer at a time and retries failed deliveries', async () => {
    const claimed = await t.asService<R>(`select * from public.outbox_claim('sales_qualification_agent', array['lead.ready_for_qualification'], 3)`);
    expect(claimed).toHaveLength(3);
    expect(claimed.every((e) => e.status === 'processing' && e.attempts === 1)).toBe(true);
    const ids = claimed.map((e) => e.id);
    const second = await t.asService<R>(`select id from public.outbox_claim('sales_qualification_agent', array['lead.ready_for_qualification'], 100)`);
    expect(second.some((e) => ids.includes(e.id))).toBe(false);
    expect((await t.asService<{ s: string }>(`select public.outbox_ack($1, 'sales_qualification_agent', true) s`, [ids[0]]))[0].s).toBe('delivered');
    expect((await t.asService<{ s: string }>(`select public.outbox_ack($1, 'sales_qualification_agent', false, 'qualification unavailable') s`, [ids[1]]))[0].s).toBe('pending');
    const e = await one(`select status, available_at > now() later, last_error from public.outbox_events where id = $1`, [ids[1]]);
    expect(e).toEqual({ status: 'pending', later: true, last_error: 'qualification unavailable' });
    await expect(t.asService(`select public.outbox_ack($1, 'someone_else', true)`, [ids[2]])).rejects.toThrow(/not leased/);
  });
});

describe('manual and import path', () => {
  it('records an intake run and hands off leads created by people', async () => {
    const r = await t.lead(agentWorli, org, { name: 'Walk In', phone: '9866600055', source: 'Walk-in', locations: ['Worli'] });
    const lead = await one(`select intake_status, duplicate_status, metadata from public.leads where id = $1`, [r.lead_id]);
    expect(lead.intake_status).toBe('completed');
    const run = await one(`select status, source_kind, provider from public.agent_runs where lead_id = $1`, [r.lead_id]);
    expect(run).toEqual({ status: 'succeeded', source_kind: 'manual', provider: 'os' });
    expect(await rows(`select 1 from public.outbox_events where record_id = $1 and event_type = 'lead.ready_for_qualification'`, [r.lead_id])).toHaveLength(1);
  });
});

describe('security', () => {
  it('signed-in users cannot run privileged intake operations', async () => {
    for (const sql of [
      `select public.intake_receive('${org}', 'webhook', 'webhook', 'x1', '{"name":"a","email":"a@b.co"}'::jsonb)`,
      `select public.intake_process(gen_random_uuid())`,
      `select public.intake_attach_extraction(gen_random_uuid(), '{}'::jsonb, '{}'::jsonb)`,
      `select public.intake_process_due(1)`,
      `select * from public.outbox_claim('sales_qualification_agent', array['lead.ready_for_qualification'], 1)`,
      `select public.outbox_ack(gen_random_uuid(), 'x', true)`,
    ]) {
      expect((await t.fails(owner, sql)).message).toMatch(/permission denied/);
    }
    await expect(t.asAnon(`select public.lead_intake_summary(gen_random_uuid())`)).rejects.toThrow(/permission denied/);
  });

  it('clients cannot write runs, events or reviews, or forge intake state', async () => {
    expect((await t.fails(owner, `insert into public.outbox_events (organization_id, event_type, record_type, record_id, dedupe_key) values ($1, 'lead.ready_for_qualification', 'lead', gen_random_uuid(), 'x')`, [org])).message).toMatch(/permission denied/);
    expect((await t.fails(owner, `insert into public.agent_runs (organization_id, agent_id, agent_version, trigger_event, source_kind, provider, idempotency_key) values ($1, 'lead_intake_agent', '1', 'a.b', 'manual', 'os', 'k')`, [org])).message).toMatch(/permission denied/);
    expect((await t.fails(owner, `update public.review_items set status = 'resolved'`)).message).toMatch(/permission denied/);
    // Intake columns are not client-writable at all (column grants), and the guard trigger backs that up.
    const [{ id }] = await t.as<{ id: string }>(manager, `select id from public.leads where intake_status = 'completed' limit 1`);
    expect((await t.fails(manager, `update public.leads set intake_status = 'review_required', duplicate_status = 'merged' where id = $1`, [id])).message).toMatch(/permission denied/);
    expect((await t.fails(manager, `insert into public.leads (organization_id, contact_id, title, source, intake_status) select organization_id, contact_id, 'x', 'x', 'review_required' from public.leads where id = $1`, [id])).message).toMatch(/permission denied/);
    await t.db.exec(`grant update (intake_status) on public.leads to authenticated`);
    await t.as(manager, `update public.leads set intake_status = 'review_required' where id = $1`, [id]);
    expect((await one(`select intake_status from public.leads where id = $1`, [id])).intake_status).toBe('completed');
    await t.db.exec(`revoke update (intake_status) on public.leads from authenticated`);
  });

  it('tenant isolation: runs, events, reviews and summaries never cross organizations', async () => {
    const b = await intake({ name: 'Bee Lead', phone: '9811122233', locations: ['Worli'] }, { org: orgB });
    // Same phone as an org-A contact, but dedupe is tenant-scoped: a fresh contact in B, assigned inside B.
    expect(b).toMatchObject({ status: 'created', duplicate: 'none' });
    expect((await one(`select assigned_to from public.leads where id = $1`, [b.lead_id])).assigned_to).toBe(agentB);
    expect(await t.as(ownerB, `select 1 from public.agent_runs where organization_id = $1`, [org])).toHaveLength(0);
    expect(await t.as(ownerB, `select 1 from public.outbox_events where organization_id = $1`, [org])).toHaveLength(0);
    expect(await t.as(ownerB, `select 1 from public.review_items where organization_id = $1`, [org])).toHaveLength(0);
    const aLead = (await t.as<{ id: string }>(owner, `select id from public.leads limit 1`))[0].id;
    expect((await t.fails(ownerB, `select public.lead_intake_summary($1)`, [aLead])).detail).toBe('NOT_FOUND');
    const aReview = (await one(`select id from public.review_items where organization_id = $1 limit 1`, [org])).id;
    expect((await t.fails(ownerB, `select public.resolve_intake_review($1, 'distinct')`, [aReview])).detail).toBe('NOT_FOUND');
    // A property reference from another organization never routes the lead there.
    await t.as(ownerB, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, area_value, locality, listing_agent_id) values ($1, 'B-1', 'Other agency flat', 'apartment', 'sale', 'active', 1000000, 500, 'Worli', $2)`, [orgB, agentB]);
    const x = await intake({ name: 'Cross Ref', email: 'xref@example.com', property_ref: 'B-1', locations: ['Worli'] });
    expect(x.assignment).toBe('policy_by_locality');
    expect((await one(`select assigned_to from public.leads where id = $1`, [x.lead_id])).assigned_to).toBe(agentWorli);
    // Agents and viewers can read lead intake state but not execution logs.
    expect(await t.as(agentWorli, `select 1 from public.agent_runs`)).toHaveLength(0);
    expect(await t.as(viewer, `select 1 from public.outbox_events`)).toHaveLength(0);
    expect((await t.as(manager, `select 1 from public.agent_runs`)).length).toBeGreaterThan(0);
  });
});
