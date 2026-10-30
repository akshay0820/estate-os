// Agent 04 — Property Matching: eligibility, ranking, provenance (hard vs soft), persistence, lifecycle, events,
// failures, the model step (hand-written outputs) and tenant isolation, on real persisted inventory.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, nextWeekdayAt, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let org: string, owner: string, manager: string, agent: string, viewer: string;
let orgB: string, ownerB: string;
let seq = 0;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const rows = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows;
const qtick = () => t.asService(`select public.qualification_tick(50)`);
const mtick = async () => (await t.asService<{ r: R }>(`select public.property_matching_tick(50) r`))[0].r;
const settle = async () => { await qtick(); return mtick(); };
const request = (user: string, lead: string) => t.as<{ r: R }>(user, `select public.property_matching_request($1, $2) r`, [lead, `k_m_${++seq}_${Date.now()}`]).then((x) => x[0].r);
const view = (user: string, lead: string) => t.as<{ r: R }>(user, `select public.lead_property_matches($1) r`, [lead]).then((x) => x[0].r);
const act = (user: string, match: string, action: string, note: string | null = null) =>
  t.as<{ r: R }>(user, `select public.property_match_action($1, $2, $3) r`, [match, action, note]).then((x) => x[0].r);
const run = (lead: string) => one(`select * from public.property_match_runs where lead_id = $1 and is_current`, [lead]);
const events = (lead: string, type: string) => rows<R>(`select * from public.outbox_events where record_id = $1 and event_type = $2`, [lead, type]);

const prop = async (user: string, o: R, orgId = org) => {
  const [{ id }] = await t.as<{ id: string }>(user, `insert into public.properties (organization_id, reference_code, title, description, property_type, listing_type, status, price,
      bedrooms, area_value, locality, city, amenities, address_line_1)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 900, $10, $11, $12, '12 Private Lane') returning id`,
    [orgId, o.ref ?? `P-${++seq}`, o.title ?? 'Listing for matching', o.description ?? null, o.type ?? 'apartment', o.listing ?? 'sale', o.status ?? 'active',
      o.price ?? 28000000, o.beds ?? 2, o.locality ?? 'Worli', o.city ?? 'Mumbai', o.amenities ?? []]);
  // Currency is not client-writable (org default); set it as an import would.
  if (o.currency) await t.db.query(`update public.properties set currency = $2 where id = $1`, [id, o.currency]);
  if (o.verified !== false) await t.as(owner, `update public.properties set verified_at = now() where id = $1`, [id]);
  return id;
};

beforeAll(async () => {
  t = await createDb({ currency: 'INR' });
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
}, 120000);

describe('matching a qualified buyer against real inventory', () => {
  let lead: string;
  const p: Record<string, string> = {};

  it('applies hard constraints, ranks deterministically, explains, persists and hands off to Agent 05 once', async () => {
    p.best = await prop(manager, { title: 'Sea view 2 BHK Worli', price: 28000000, amenities: ['Parking', 'Gym'] });
    p.over = await prop(manager, { title: 'Slightly over budget 2 BHK', price: 32000000, amenities: ['parking'] });
    p.unverified = await prop(manager, { title: 'Unverified 2 BHK Worli', price: 29000000, verified: false });
    p.tooExpensive = await prop(manager, { price: 40000000 });
    p.bandra = await prop(manager, { locality: 'Bandra', price: 25000000 });
    p.rental = await prop(manager, { listing: 'rent', price: 90000 });
    p.sold = await prop(manager, { status: 'sold' });
    p.underOffer = await prop(manager, { status: 'under_offer' });
    p.office = await prop(manager, { type: 'office', beds: 0 });
    p.oneBed = await prop(manager, { beds: 1, price: 20000000 });
    p.otherOrg = await prop(ownerB, { title: 'Other agency 2 BHK Worli' }, orgB);

    const l = await t.lead(manager, org, { name: 'Ready Buyer', phone: '9822200001', type: 'buyer', locations: ['Worli'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months' });
    lead = l.lead_id;
    await t.db.query(`update public.leads set required_amenities = '{parking}' where id = $1`, [lead]);
    const res = await settle();
    expect(res.consumed).toBe(1);
    expect((await one(`select status from public.outbox_events where record_id = $1 and event_type = 'lead.qualification.completed'`, [lead])).status).toBe('delivered');

    const r = await run(lead);
    expect(r).toMatchObject({ status: 'completed_with_warnings', inventory_scope: 'organization', candidate_count: 8, eligible_count: 3, recommended_count: 3, ruleset_version: 0, explanation_status: 'pending' });
    expect(r.rejections).toEqual({ EXCEEDS_HARD_BUDGET: 1, OUTSIDE_MANDATORY_LOCATION: 1, LISTING_UNAVAILABLE: 1, PROPERTY_TYPE_MISMATCH: 1, BEDROOM_REQUIREMENT_NOT_MET: 1 });
    expect(r.warnings).toEqual(['unverified_listings']);
    expect(r.missing).toEqual([]);
    expect(r.criteria.prepared).toMatchObject({ listing_type: 'sale', locs: ['worli'], loc_hard: true, bmax: 30000000, budget_hard: true, ptype_hard: true, beds: 2 });

    const m = await rows<R>(`select * from public.property_matches where match_run_id = $1 order by rank`, [r.id]);
    expect(m.map((x) => [x.property_id, x.score, x.band])).toEqual([[p.best, 100, 'strong'], [p.over, 92, 'strong'], [p.unverified, 80, 'good']]);
    expect(m[0].breakdown.map((d: R) => d.key)).toEqual(['location', 'budget', 'property_type', 'bedrooms', 'amenities', 'availability']);
    expect(m[0].strengths.map((s: R) => s.code)).toEqual(['IN_PREFERRED_LOCALITY', 'WITHIN_BUDGET', 'TYPE_MATCH', 'BEDROOMS_MATCH', 'HAS_AMENITIES', 'AVAILABILITY_VERIFIED']);
    expect(m[0].explanation).toContain('Within budget (INR 28,000,000 of INR 30,000,000)');
    expect(m[1]).toMatchObject({ budget_fit: 'over_budget' });
    expect(m[1].tradeoffs[0]).toMatchObject({ code: 'OVER_BUDGET', text: '6.7% over the budget (INR 32,000,000 of INR 30,000,000)' });
    expect(m[2]).toMatchObject({ availability: 'unverified' });
    expect(m[2].caveats.map((c: R) => c.code)).toEqual(['AVAILABILITY_UNVERIFIED']);
    expect(m[2].breakdown.find((d: R) => d.key === 'availability')).toMatchObject({ value: 0, points: 0, status: 'unknown' });
    expect(m[2].tradeoffs.map((c: R) => c.code)).toEqual(['AMENITIES_NOT_LISTED']);
    expect(m.map((x) => x.property_id)).not.toContain(p.otherOrg);

    const ev = await events(lead, 'property_matching.completed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ consumer: 'follow_up_agent', status: 'pending' });
    expect(Object.keys(ev[0].payload).sort()).toEqual(['agent_run_id', 'correlation_id', 'event_type', 'lead_id', 'matching_run_id', 'occurred_at', 'organization_id', 'qualification_id', 'recommended_count', 'schema_version']);
    expect(ev[0].payload).toMatchObject({ matching_run_id: r.id, recommended_count: 3 });
    // Correlation id flows from Agent 03's event into Agent 04's run and event.
    const qev = await one(`select correlation_id from public.outbox_events where record_id = $1 and event_type = 'lead.qualification.completed'`, [lead]);
    expect(ev[0].correlation_id).toBe(qev.correlation_id);
    const act0 = await one(`select title, actor_name, description from public.activities where lead_id = $1 and title like 'Property matching:%'`, [lead]);
    expect(act0).toMatchObject({ title: 'Property matching: 3 recommended', actor_name: 'Property Matching Agent' });
    expect((await one(`select status from public.agent_runs where id = $1`, [r.run_id])).status).toBe('succeeded');
  });

  it('read model returns display-safe fields only; a re-run with unchanged results keeps history but does not re-trigger Agent 05', async () => {
    const v = await view(agent, lead);
    expect(v.matches).toHaveLength(3);
    expect(Object.keys(v.matches[0].property)).not.toContain('address_line_1');
    expect(JSON.stringify(v)).not.toContain('Private Lane');
    // Same rule as editing the lead: agents may act on unassigned leads or their own; viewers never.
    const assigned = (await one(`select assigned_to from public.leads where id = $1`, [lead])).assigned_to;
    expect(v.can_act).toBe(assigned === null || assigned === agent);
    expect((await view(viewer, lead)).can_act).toBe(false);
    await request(manager, lead);
    await mtick();
    expect(await rows(`select 1 from public.property_match_runs where lead_id = $1`, [lead])).toHaveLength(2);
    expect(await events(lead, 'property_matching.completed')).toHaveLength(1);
    expect((await view(manager, lead)).history).toHaveLength(2);
  });

  it('people shortlist / reject / share; decisions carry over; listing changes invalidate or flag; viewing booking is tracked', async () => {
    let v = await view(manager, lead);
    const byProp = (x: R, id: string) => x.matches.find((mm: R) => mm.property.id === id);
    expect((await act(manager, byProp(v, p.best).id, 'shortlist')).status).toBe('shortlisted');
    const rej = await t.fails(manager, `select public.property_match_action($1, 'reject', $2)`, [byProp(v, p.over).id, 'x'.repeat(301)]);
    expect(rej.detail).toBe('VALIDATION_ERROR');
    expect((await act(manager, byProp(v, p.over).id, 'reject', 'Client will not stretch the budget')).status).toBe('rejected');
    expect((await act(viewer, byProp(v, p.unverified).id, 'view')).status).toBe('viewed');
    expect((await t.fails(viewer, `select public.property_match_action($1, 'shortlist')`, [byProp(v, p.unverified).id])).detail).toBe('FORBIDDEN');

    await request(manager, lead);
    await mtick();
    v = await view(manager, lead);
    expect(v.current.status).toBe('completed_with_warnings');
    expect(byProp(v, p.best).status).toBe('shortlisted');
    expect(byProp(v, p.over)).toMatchObject({ status: 'rejected', status_reason: 'Client will not stretch the budget' });
    expect(byProp(v, p.unverified).status).toBe('viewed');

    // Price change flags; withdrawal invalidates; shortlisting an invalidated listing is refused.
    await t.as(manager, `update public.properties set price = 29500000 where id = $1`, [p.best]);
    await t.as(manager, `update public.properties set status = 'withdrawn' where id = $1`, [p.unverified]);
    v = await view(manager, lead);
    expect(byProp(v, p.best).price_changed).toBe(true);
    expect(byProp(v, p.unverified)).toMatchObject({ status: 'invalidated', status_reason: 'LISTING_UNAVAILABLE' });
    expect((await t.fails(manager, `select public.property_match_action($1, 'shortlist')`, [byProp(v, p.unverified).id])).detail).toBe('STALE_MATCH');

    // Share revalidates against the current listing first, refreshes the snapshot, records it, and moves the pipeline.
    expect((await act(manager, byProp(v, p.best).id, 'share', 'Sent on WhatsApp')).status).toBe('shared');
    v = await view(manager, lead);
    expect(byProp(v, p.best)).toMatchObject({ price_changed: false, snapshot: { price: 29500000 } });
    expect((await one(`select title from public.activities where lead_id = $1 and activity_type = 'property_sent'`, [lead])).title).toMatch(/^Shared Sea view 2 BHK Worli/);
    expect((await one(`select status from public.leads where id = $1`, [lead])).status).toBe('matching');

    // A listing that moved above the hard budget is invalidated on revalidation instead of being shared.
    await t.as(manager, `update public.properties set price = 45000000 where id = $1`, [p.best]);
    const again = await act(manager, byProp(v, p.best).id, 'shortlist');
    expect(again).toEqual({ status: 'invalidated', reason: 'EXCEEDS_HARD_BUDGET' });
    await t.as(manager, `update public.properties set price = 28000000 where id = $1`, [p.best]);

    // Booking a viewing marks the recommendation.
    const extra = await prop(manager, { title: 'Second Worli option', price: 27000000 });
    await request(manager, lead);
    await mtick();
    v = await view(manager, lead);
    const start = nextWeekdayAt(11);
    await t.as(manager, `insert into public.appointments (organization_id, title, appointment_type, lead_id, property_id, assigned_to, starts_at, ends_at) values ($1, 'Visit', 'viewing', $2, $3, $4, $5, $6)`,
      [org, lead, extra, manager, start, new Date(start.getTime() + 45 * 60e3)]);
    expect(byProp(await view(manager, lead), extra).status).toBe('appointment_requested');
    // Results changed (a new listing) → a new Agent 05 event.
    expect(await events(lead, 'property_matching.completed')).toHaveLength(2);
  });

  it('request_review creates one task for people', async () => {
    const v = await view(manager, lead);
    await act(manager, v.matches[0].id, 'request_review', 'Please double-check these');
    await act(manager, v.matches[0].id, 'request_review');
    expect(await rows(`select 1 from public.tasks where related_lead_id = $1 and title like 'Review property matches%'`, [lead])).toHaveLength(1);
  });
});

describe('requirements, provenance and edge cases', () => {
  it('matches a rental prospect only against rental listings', async () => {
    const r1 = await prop(manager, { listing: 'rent', price: 85000, locality: 'Powai', title: 'Powai rental 2 BHK' });
    await prop(manager, { listing: 'sale', price: 85000, locality: 'Powai' });
    const l = await t.lead(manager, org, { name: 'Renter', phone: '9822200002', type: 'tenant', locations: ['Powai'], budget_max: 90000, property_type: 'apartment', bedrooms: 2, timeline: 'Immediate' });
    await settle();
    const r = await run(l.lead_id);
    expect(r.criteria.prepared.listing_type).toBe('rent');
    const m = await rows<R>(`select property_id from public.property_matches where match_run_id = $1`, [r.id]);
    expect(m.map((x) => x.property_id)).toEqual([r1]);
  });

  it('AI-extracted values are soft: an outside-area listing is kept as a trade-off, not excluded; aliases normalize localities', async () => {
    const bkc = await prop(manager, { locality: 'Bandra Kurla Complex', city: 'Mumbai', price: 26000000, title: 'BKC 2 BHK' });
    const l = await t.lead(manager, org, { name: 'Soft Buyer', phone: '9822200003', type: 'buyer', locations: ['Lower Parel'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2, timeline: '3-6 months' });
    await t.db.query(`update public.leads set ai_extracted_fields = '{locations}' where id = $1`, [l.lead_id]);
    await qtick();
    await request(manager, l.lead_id);
    await mtick();
    let r = await run(l.lead_id);
    expect(r.criteria.prepared.loc_hard).toBe(false);
    let m = await rows<R>(`select property_id, tradeoffs from public.property_matches where match_run_id = $1`, [r.id]);
    expect(m.length).toBeGreaterThan(0);
    expect(m.find((x) => x.property_id === bkc).tradeoffs[0].code).toBe('OUTSIDE_PREFERRED_AREAS');

    // A confirmed location + an alias: "BKC" in the CRM matches "Bandra Kurla Complex" listings only.
    await t.as(owner, `select public.property_matching_settings_save($1, '{"location_aliases": {"BKC": "bandra kurla complex"}}'::jsonb)`, [org]);
    await t.db.query(`update public.leads set desired_locations = '{BKC}', ai_extracted_fields = '{}' where id = $1`, [l.lead_id]);
    await request(manager, l.lead_id);
    await mtick();
    r = await run(l.lead_id);
    m = await rows<R>(`select property_id, strengths from public.property_matches where match_run_id = $1`, [r.id]);
    expect(m.map((x) => x.property_id)).toEqual([bkc]);
    expect(r.ruleset_version).toBe(1);
    await t.as(owner, `select public.property_matching_settings_save($1, '{}'::jsonb)`, [org]);
  });

  it('never compares across currencies: the budget is unknown, earns no points, and is flagged', async () => {
    const usd = await prop(manager, { locality: 'Juhu', currency: 'USD', price: 400000, title: 'Juhu listing priced in USD' });
    const l = await t.lead(manager, org, { name: 'Juhu Buyer', phone: '9822200004', type: 'buyer', locations: ['Juhu'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months' });
    await settle();
    const r = await run(l.lead_id);
    const m = await one(`select * from public.property_matches where match_run_id = $1 and property_id = $2`, [r.id, usd]);
    expect(m).toMatchObject({ budget_fit: 'unknown' });
    expect(m.caveats[0].code).toBe('CURRENCY_MISMATCH');
    expect(m.breakdown.find((d: R) => d.key === 'budget')).toMatchObject({ value: 0, status: 'unknown' });
    expect(r.warnings).toContain('currency_mismatch');
  });

  it('incomplete requirements → needs_more_information (no shortlist); sellers are not matched to inventory', async () => {
    const bare = await t.lead(manager, org, { name: 'Bare Buyer', phone: '9822200005', type: 'buyer', timeline: '0-3 months' });
    await qtick();
    await request(manager, bare.lead_id);
    await mtick();
    const r = await run(bare.lead_id);
    expect(r).toMatchObject({ status: 'needs_more_information', recommended_count: 0, candidate_count: 0 });
    expect(r.missing).toEqual(['locations', 'budget', 'property_type', 'bedrooms']);
    expect(await events(bare.lead_id, 'property_matching.needs_information')).toHaveLength(1);
    expect(await events(bare.lead_id, 'property_matching.completed')).toHaveLength(0);

    const seller = await t.lead(manager, org, { name: 'Seller', phone: '9822200006', type: 'seller', locations: ['Worli'], property_type: 'apartment', timeline: '3-6 months' });
    await request(manager, seller.lead_id);
    await mtick();
    expect((await run(seller.lead_id)).status).toBe('not_applicable');
  });

  it('distinguishes an empty inventory from no eligible listing, and creates one task for people', async () => {
    const o3owner = await t.user('Empty Owner');
    const o3 = await t.org(o3owner, 'Empty Agency');
    const l = await t.lead(o3owner, o3, { name: 'Empty Buyer', phone: '9822200007', type: 'buyer', locations: ['Worli'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months' });
    await settle();
    const r = await run(l.lead_id);
    expect(r).toMatchObject({ status: 'no_matches', inventory_count: 0, candidate_count: 0 });
    expect(r.warnings).toContain('inventory_empty');
    expect(await events(l.lead_id, 'property_matching.no_matches')).toHaveLength(1);
    expect(await events(l.lead_id, 'property_matching.completed')).toHaveLength(0);
    await request(o3owner, l.lead_id);
    await mtick();
    expect(await rows(`select 1 from public.tasks where related_lead_id = $1 and title like 'No property matches%'`, [l.lead_id])).toHaveLength(1);
  });

  it('unverified_policy=exclude drops unverified listings; settings are validated and owner-only', async () => {
    const l = await t.lead(manager, org, { name: 'Strict Buyer', phone: '9822200008', type: 'buyer', locations: ['Worli'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months' });
    await prop(manager, { title: 'Another unverified Worli', price: 29900000, verified: false });
    await t.as(owner, `select public.property_matching_settings_save($1, '{"unverified_policy": "exclude"}'::jsonb)`, [org]);
    await settle();
    const r = await run(l.lead_id);
    expect(r.rejections.REQUIRED_DATA_UNVERIFIED).toBeGreaterThan(0);
    expect((await rows<R>(`select availability from public.property_matches where match_run_id = $1`, [r.id])).every((x) => x.availability === 'verified')).toBe(true);
    for (const bad of ['{"weights": {"location": "x"}}', '{"min_score": 90, "good_min": 70}', '{"unverified_policy": "sometimes"}', '{"hack": 1}', '{"result_limit": 500}']) {
      expect((await t.fails(owner, `select public.property_matching_settings_save($1, $2::jsonb)`, [org, bad])).detail).toBe('VALIDATION_ERROR');
    }
    expect((await t.fails(manager, `select public.property_matching_settings_save($1, '{}'::jsonb)`, [org])).detail).toBe('FORBIDDEN');
    await t.as(owner, `select public.property_matching_settings_save($1, '{}'::jsonb)`, [org]);
  });
});

describe('orchestration and failure handling', () => {
  it('a duplicate event creates one run; a failed attempt keeps the previous result and retries; superseded runs are skipped', async () => {
    const l = await t.lead(manager, org, { name: 'Retry Buyer', phone: '9822200009', type: 'buyer', locations: ['Worli'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months' });
    await settle();
    const first = await run(l.lead_id);
    expect(first.status).toMatch(/^completed/);
    const ev = await one(`select * from public.outbox_events where record_id = $1 and event_type = 'lead.qualification.completed'`, [l.lead_id]);
    // Redelivery of the same event (e.g. lease expiry) maps to the same idempotency key.
    await t.db.query(`update public.outbox_events set status = 'pending', locked_until = null where id = $1`, [ev.id]);
    await mtick();
    expect(await rows(`select 1 from public.agent_runs where agent_id = 'property_matching_agent' and idempotency_key = $1`, ['evt:' + ev.id])).toHaveLength(1);

    // Break the rules so evaluation fails, then fix them: the previous run stays current until a success.
    await t.db.query(`insert into public.property_matching_settings (organization_id, rules) values ($1, '{"weights": {"location": "oops"}}') on conflict (organization_id) do update set rules = excluded.rules`, [org]);
    const req1 = await request(manager, l.lead_id);
    await mtick();
    const ar = await one(`select status, attempt_count, error_category from public.agent_runs where id = $1`, [req1.run_id]);
    expect(ar).toMatchObject({ status: 'retry_scheduled', attempt_count: 1 });
    expect((await run(l.lead_id)).id).toBe(first.id);
    expect((await view(manager, l.lead_id)).run.status).toBe('retry_scheduled');
    await t.db.query(`update public.property_matching_settings set rules = '{}' where organization_id = $1`, [org]);
    await t.db.query(`update public.agent_runs set next_attempt_at = now() where id = $1`, [req1.run_id]);
    await mtick();
    expect((await one(`select status from public.agent_runs where id = $1`, [req1.run_id])).status).toBe('succeeded');
    expect((await run(l.lead_id)).id).not.toBe(first.id);

    // Two pending runs: the older one is superseded.
    const a = await request(manager, l.lead_id);
    const b = await request(manager, l.lead_id);
    await mtick();
    expect((await one(`select outcome from public.agent_runs where id = $1`, [a.run_id])).outcome).toEqual({ action: 'superseded' });
    expect((await one(`select status from public.agent_runs where id = $1`, [b.run_id])).status).toBe('succeeded');
  });

  it('manual requests are idempotent and rate-limited; closed leads are refused', async () => {
    const l = await t.lead(manager, org, { name: 'Rate Buyer', phone: '9822200010', type: 'buyer', locations: ['Worli'], budget_max: 30000000, property_type: 'apartment', timeline: '0-3 months' });
    const [{ r: x }] = await t.as<{ r: R }>(manager, `select public.property_matching_request($1, 'same_key_123') r`, [l.lead_id]);
    const [{ r: y }] = await t.as<{ r: R }>(manager, `select public.property_matching_request($1, 'same_key_123') r`, [l.lead_id]);
    expect(x.run_id).toBe(y.run_id);
    for (let i = 0; i < 9; i++) await request(manager, l.lead_id);
    expect((await t.fails(manager, `select public.property_matching_request($1, 'one_more_key')`, [l.lead_id])).detail).toBe('RATE_LIMITED');
    await t.db.query(`update public.leads set status = 'lost', lost_reason = 'Bought elsewhere' where id = $1`, [l.lead_id]);
    expect((await t.fails(owner, `select public.property_matching_request($1, 'closed_key_1')`, [l.lead_id])).detail).toBe('VALIDATION_ERROR');
  });
});

describe('Claude explanation step (hand-written outputs)', () => {
  it('claims display facts only (no address, owner, phone or email), accepts valid summaries, rejects foreign ids and banned wording', async () => {
    const pid = await prop(manager, { title: 'Described Worli flat', price: 27500000, locality: 'Prabhadevi', description: 'Corner flat with sea view. Call owner on 98765 43210 or owner@example.com.' });
    const l = await t.lead(manager, org, { name: 'Explained Buyer', phone: '9822200011', type: 'buyer', locations: ['Prabhadevi'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months' });
    await settle();
    const r = await run(l.lead_id);
    expect(r.explanation_status).toBe('pending');
    const claimed = await t.asService<R>(`select * from public.property_matching_explain_claim(10)`);
    const mine = claimed.find((c) => c.match_run_id === r.id)!;
    const facts = mine.matches.find((x: R) => x.title === 'Described Worli flat');
    expect(facts.description).toBe('Corner flat with sea view. Call owner on [number removed] or [email removed]');
    expect(JSON.stringify(mine)).not.toMatch(/Private Lane|Explained Buyer|9822200011|owner_contact/);
    // Leased: a second claim does not hand out the same run.
    expect((await t.asService<R>(`select * from public.property_matching_explain_claim(10)`)).find((c) => c.match_run_id === r.id)).toBeUndefined();

    const other = await one(`select id from public.property_matches where match_run_id <> $1 limit 1`, [r.id]);
    await t.asService(`select public.property_matching_attach_explanations($1, $2::jsonb, $3::jsonb)`, [r.id, JSON.stringify({ explanations: [
      { match_id: facts.match_id, summary: 'Prabhadevi 2 BHK within budget; availability verified.', quotes: [] },
      { match_id: other.id, summary: 'Belongs to a different run entirely.', quotes: [] },
    ] }), JSON.stringify({ model: 'claude-opus-5-5', outcome: 'ok', prompt: 'must not be stored' })]);
    const after = await run(l.lead_id);
    expect(after.explanation_status).toBe('succeeded');
    expect(after.model_meta).toEqual({ model: 'claude-opus-5-5', outcome: 'ok' });
    expect((await one(`select ai_summary from public.property_matches where id = $1`, [facts.match_id])).ai_summary).toBe('Prabhadevi 2 BHK within budget; availability verified.');
    expect((await one(`select ai_summary from public.property_matches where id = $1`, [other.id])).ai_summary).toBeNull();
    expect(pid).toBeTruthy();
  });

  it('records not_configured without a key, rejects banned wording, and times out stuck steps', async () => {
    const l = await t.lead(manager, org, { name: 'NoKey Buyer', phone: '9822200012', type: 'buyer', locations: ['Worli'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months' });
    await settle();
    const r = await run(l.lead_id);
    await t.asService(`select public.property_matching_attach_explanations($1, null, '{"outcome": "not_configured"}'::jsonb)`, [r.id]);
    expect((await run(l.lead_id)).explanation_status).toBe('not_configured');

    const l2 = await t.lead(manager, org, { name: 'Banned Buyer', phone: '9822200013', type: 'buyer', locations: ['Worli'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months' });
    await settle();
    const r2 = await run(l2.lead_id);
    const mid = (await one(`select id from public.property_matches where match_run_id = $1 limit 1`, [r2.id])).id;
    await t.asService(`select public.property_matching_attach_explanations($1, $2::jsonb, '{"outcome": "ok"}'::jsonb)`, [r2.id, JSON.stringify({ explanations: [{ match_id: mid, summary: 'A perfect home for a growing family.', quotes: [] }] })]);
    expect((await run(l2.lead_id)).explanation_status).toBe('failed');
    expect((await one(`select ai_summary from public.property_matches where id = $1`, [mid])).ai_summary).toBeNull();

    const l3 = await t.lead(manager, org, { name: 'Stuck Buyer', phone: '9822200014', type: 'buyer', locations: ['Worli'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months' });
    await settle();
    await t.db.query(`update public.property_match_runs set created_at = now() - interval '20 minutes' where lead_id = $1 and is_current`, [l3.lead_id]);
    await mtick();
    expect((await run(l3.lead_id))).toMatchObject({ explanation_status: 'failed', model_meta: { outcome: 'timeout' } });
  });
});

describe('tenant isolation and privileges', () => {
  it('another organization cannot read, run, act on or reconfigure matching; outbox events from another org are ignored', async () => {
    const l = await t.lead(manager, org, { name: 'Private Buyer', phone: '9822200015', type: 'buyer', locations: ['Worli'], budget_max: 30000000, property_type: 'apartment', bedrooms: 2, timeline: '0-3 months' });
    await settle();
    const r = await run(l.lead_id);
    const mid = (await one(`select id from public.property_matches where match_run_id = $1 limit 1`, [r.id])).id;
    expect(await t.as(ownerB, `select id from public.property_match_runs where organization_id = $1`, [org])).toHaveLength(0);
    expect(await t.as(ownerB, `select id from public.property_matches where organization_id = $1`, [org])).toHaveLength(0);
    expect((await t.fails(ownerB, `select public.lead_property_matches($1)`, [l.lead_id])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.property_matching_request($1, 'cross_tenant_1')`, [l.lead_id])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.property_match_action($1, 'shortlist')`, [mid])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.property_matching_settings_save($1, '{}'::jsonb)`, [org])).detail).toBe('FORBIDDEN');

    // An event in org B pointing at org A's lead does nothing.
    await t.db.query(`insert into public.outbox_events (organization_id, event_type, record_type, record_id, payload, consumer, status, dedupe_key)
      values ($1, 'lead.qualification.completed', 'lead', $2, $3, 'property_matching_agent', 'pending', $4)`, [orgB, l.lead_id, JSON.stringify({ lead_id: l.lead_id }), `forged_${l.lead_id}`]);
    const before = (await rows(`select 1 from public.agent_runs where agent_id = 'property_matching_agent' and lead_id = $1`, [l.lead_id])).length;
    await mtick();
    expect((await rows(`select 1 from public.agent_runs where agent_id = 'property_matching_agent' and lead_id = $1`, [l.lead_id])).length).toBe(before);
    expect(await rows(`select 1 from public.agent_runs where agent_id = 'property_matching_agent' and organization_id = $1`, [orgB])).toHaveLength(0);
  });

  it('users cannot write runs or matches, run the worker functions, or submit scores', async () => {
    const mid = (await one(`select id from public.property_matches limit 1`)).id;
    expect((await t.fails(owner, `update public.property_matches set score = 100 where id = $1`, [mid])).message).toMatch(/permission denied/);
    expect((await t.fails(owner, `insert into public.property_match_runs (organization_id, lead_id, trigger, status, ruleset_version) values ($1, $2, 'x', 'completed', 0)`, [org, (await one(`select lead_id from public.property_matches limit 1`)).lead_id])).message).toMatch(/permission denied/);
    for (const fn of [`public.property_matching_tick(1)`, `public.property_matching_explain_claim(1)`, `public.property_matching_worker_secret_ok('x')`,
      `public.property_matching_attach_explanations(gen_random_uuid(), null, null)`, `public.property_matching_process(gen_random_uuid())`]) {
      expect((await t.fails(owner, `select ${fn}`)).message).toMatch(/permission denied/);
    }
    expect((await t.fails(owner, `select private.pm_evaluate('{}'::jsonb, '{}'::jsonb, '{}'::jsonb, now())`)).message).toMatch(/permission denied/);
  });
});
