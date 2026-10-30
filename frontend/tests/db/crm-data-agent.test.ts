// Agent 07 — CRM & Data Intelligence: deterministic rules with fingerprinted findings and a lifecycle, proposed corrections,
// field provenance with verified-value protection, explainable duplicate candidates, human-approved / revertible merges,
// scans with checkpoints, anomaly baselines, the Agent 08 context, events, retries and tenant isolation.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, nextWeekdayAt, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let org: string, owner: string, manager: string, agent: string, viewer: string;
let orgB: string, ownerB: string;
let seq = 0;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const rows = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows;
const key = () => `k_dq_${++seq}_${Date.now()}`;
const tick = () => t.asService<{ r: R }>(`select public.crm_data_tick(1000) r`).then((x) => x[0].r);
const contact = async (user: string, o: R) => (await t.as<{ id: string }>(user, `insert into public.contacts (organization_id, display_name, phone, email, source)
  values ($1, $2, $3, $4, $5) returning id`, [o.org ?? org, o.name, o.phone ?? null, o.email ?? null, o.source === undefined ? 'Website' : o.source]))[0].id;
const issues = (eid: string) => rows(`select * from public.data_quality_issues where entity_id = $1 order by rule_id`, [eid]);
const issue = (eid: string, rule: string) => one(`select * from public.data_quality_issues where entity_id = $1 and rule_id = $2`, [eid, rule]);
const cand = (et: string, a: string, b: string) => one(`select * from public.duplicate_candidates where entity_type = $1 and record_a = least($2::uuid, $3::uuid) and record_b = greatest($2::uuid, $3::uuid)`, [et, a, b]);
const decide = (user: string, c: R, decision: string, canonical: string | null, k = key(), hash = c.state_hash) =>
  t.as<{ r: R }>(user, `select public.duplicate_decide($1, $2, $3, $4, $5, 'test') r`, [c.id, decision, canonical, hash, k]).then((x) => x[0].r);
const events = (type: string) => rows(`select * from public.outbox_events where event_type = $1`, [type]);
const prop = async (ref: string, o: R = {}) => (await t.as<{ id: string }>(manager, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price,
  bedrooms, area_value, locality, city, address_line_1) values ($1, $2, $3, $4, $5, 'active', $6, $7, $8, 'Worli', 'Mumbai', $9) returning id`,
  [org, ref, o.title ?? `Listing ${ref}`, o.type ?? 'apartment', o.listing ?? 'sale', o.price ?? 25000000, o.bedrooms ?? 2, o.area ?? 900, o.addr ?? `${ref} Unique Street`]))[0].id;

beforeAll(async () => {
  t = await createDb({ currency: 'INR' });
  owner = await t.user('Aanya Kapoor');
  manager = await t.user('Priya Nair');
  agent = await t.user('Arjun Desai');
  viewer = await t.user('Vik Viewer');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, manager, 'manager');
  await t.member(org, agent, 'agent');
  await t.member(org, viewer, 'viewer');
  ownerB = await t.user('Bina Bose');
  orgB = await t.org(ownerB, 'Other Agency');
  // Scans are requested explicitly in these tests.
  await t.as(owner, `select public.data_quality_settings_save($1, '{"daily_scan": false}'::jsonb)`, [org]);
  await t.as(ownerB, `select public.data_quality_settings_save($1, '{"daily_scan": false}'::jsonb)`, [orgB]);
  await tick();
}, 120000);

describe('rules and the finding lifecycle', () => {
  it('detects contact problems once per fingerprint; rescans update instead of duplicating', async () => {
    const c = await contact(manager, { name: 'Ravi   Kumar ', phone: '9876500001', email: 'ravi..k@example.com' });
    expect((await tick()).processed).toBeGreaterThanOrEqual(1);
    const found = (await issues(c)).map((x) => x.rule_id);
    expect(found).toEqual(expect.arrayContaining(['contact.email_malformed', 'contact.name_whitespace', 'contact.phone_country_assumed', 'contact.consent_unknown']));
    expect(await issue(c, 'contact.phone_country_assumed')).toMatchObject({ severity: 'info', dimension: 'validity', status: 'open', origin: 'rule' });
    expect((await issue(c, 'contact.email_malformed')).evidence).toEqual({ field: 'email' });
    // Re-evaluating the same record: same rows, more detections.
    await t.db.query(`select private.dq_process($1, 'contact', $2, null)`, [org, c]);
    await t.db.query(`select private.dq_process($1, 'contact', $2, null)`, [org, c]);
    expect((await issues(c)).length).toBe(found.length);
    expect((await issue(c, 'contact.email_malformed')).detection_count).toBe(3);
    const ev = await rows(`select * from public.outbox_events where event_type = 'crm.data_quality_issue_detected' and payload ->> 'entity_id' = $1`, [c]);
    expect(ev.length).toBe(found.length);
    // Events carry ids and codes only.
    expect(Object.keys(ev[0].payload).sort()).toEqual(['entity_id', 'entity_type', 'event_type', 'issue_id', 'occurred_at', 'organization_id', 'origin', 'rule_id', 'schema_version', 'severity', 'source']);
    expect(JSON.stringify(ev)).not.toContain('Ravi');
  });

  it('auto-resolves fixed problems, reopens them if they return, and keeps dismissals', async () => {
    const c = await contact(manager, { name: 'Sana Shah', phone: '+919876500002', email: 'sana.@example.com' });
    await tick();
    expect(await issue(c, 'contact.phone_country_assumed')).toBeUndefined();
    await t.as(manager, `update public.contacts set email = 'sana..s@example.com' where id = $1`, [c]);
    await tick();
    await t.as(manager, `update public.contacts set email = 'sana@example.com' where id = $1`, [c]);
    await tick();
    expect(await issue(c, 'contact.email_malformed')).toMatchObject({ status: 'resolved', resolution: 'no_longer_detected' });
    expect((await events('crm.data_quality_issue_resolved')).some((e) => e.payload.rule_id === 'contact.email_malformed' && e.payload.entity_id === c)).toBe(true);
    await t.as(manager, `update public.contacts set email = 'sana..s@example.com' where id = $1`, [c]);
    await tick();
    expect(await issue(c, 'contact.email_malformed')).toMatchObject({ status: 'reopened', occurrence: 2 });

    const consent = await issue(c, 'contact.consent_unknown');
    expect((await t.fails(manager, `select public.dq_issue_action($1, 'dismiss', '')`, [consent.id])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(viewer, `select public.dq_issue_action($1, 'dismiss', 'not needed')`, [consent.id])).detail).toBe('FORBIDDEN');
    await t.as(manager, `select public.dq_issue_action($1, 'dismiss', 'Consent is captured offline for walk-ins')`, [consent.id]);
    await t.db.query(`select private.dq_process($1, 'contact', $2, null)`, [org, c]);
    expect(await issue(c, 'contact.consent_unknown')).toMatchObject({ status: 'dismissed', resolution: 'dismissed' });
    // Manual "resolve" is refused while the rule still fires.
    const mal = await issue(c, 'contact.email_malformed');
    expect((await t.fails(manager, `select public.dq_issue_action($1, 'resolve', null)`, [mal.id])).detail).toBe('CONFLICT');
  });

  it('applies a proposed correction through an audited update with correction provenance', async () => {
    const c = await contact(manager, { name: '  Meera   Iyer', phone: '+919876500003' });
    await tick();
    const ws = await issue(c, 'contact.name_whitespace');
    expect(ws.proposed_fix).toEqual({ field: 'display_name', value: 'Meera Iyer' });
    expect((await t.fails(viewer, `select public.dq_issue_apply_fix($1)`, [ws.id])).detail).toBe('FORBIDDEN');
    await t.as(manager, `select public.dq_issue_apply_fix($1)`, [ws.id]);
    expect((await one(`select display_name from public.contacts where id = $1`, [c])).display_name).toBe('Meera Iyer');
    expect(await issue(c, 'contact.name_whitespace')).toMatchObject({ status: 'resolved', resolution: 'corrected' });
    expect(await one(`select * from public.field_provenance where entity_id = $1 and field = 'display_name'`, [c]))
      .toMatchObject({ source_type: 'correction', previous_source_type: 'user_entry', source_ref: ws.id });
    expect(await one(`select * from public.audit_logs where action = 'crm.correction_applied' and entity_id = $1`, [c])).toBeTruthy();
    expect(await one(`select * from public.activities where contact_id = $1 and title = 'Data correction applied: display name'`, [c])).toBeTruthy();
  });

  it('flags lead, property and appointment inconsistencies without changing them', async () => {
    const r = await t.lead(manager, org, { name: 'Tenant Big Budget', phone: '9844400101', type: 'tenant', intent: 'buy', budget_max: 30000000, assigned_to: '' });
    await tick();
    const rules = (await issues(r.lead_id)).map((x) => x.rule_id);
    expect(rules).toEqual(expect.arrayContaining(['lead.type_transaction_mismatch', 'lead.unassigned']));
    await t.as(manager, `update public.leads set desired_transaction = 'rent', assigned_to = $2 where id = $1`, [r.lead_id, agent]);
    await t.as(manager, `update public.leads set status = 'visit_scheduled' where id = $1`, [r.lead_id]);
    await tick();
    const after = (await issues(r.lead_id)).filter((x) => ['open', 'reopened'].includes(x.status)).map((x) => x.rule_id);
    expect(after).toEqual(expect.arrayContaining(['lead.rent_budget_implausible', 'lead.visit_without_appointment']));
    expect(after).not.toContain('lead.unassigned');
    expect((await one(`select status from public.leads where id = $1`, [r.lead_id])).status).toBe('visit_scheduled');

    const p = await prop('DQ-P1', { type: 'plot', bedrooms: 3, price: 40000, listing: 'sale' });
    await tick();
    expect((await issues(p)).map((x) => x.rule_id)).toEqual(expect.arrayContaining(['property.bedrooms_not_applicable', 'property.sale_price_implausible', 'property.unverified_active']));
  });
});

describe('provenance and source precedence', () => {
  it('records sources, protects verified values from automated writes, and lets people correct them', async () => {
    const c = await contact(manager, { name: 'Kabir Rao', phone: '+919876500010' });
    expect(await one(`select * from public.field_provenance where entity_id = $1 and field = 'phone'`, [c])).toMatchObject({ source_type: 'user_entry', verification_status: 'unverified' });
    expect((await t.fails(viewer, `select public.dq_verify_field('contact', $1, 'phone', true)`, [c])).detail).toBe('FORBIDDEN');
    await t.as(manager, `select public.dq_verify_field('contact', $1, 'phone', true)`, [c]);
    // An automated write (agent function, no signed-in user) tries to replace the verified phone: the value is kept and a review issue opens.
    await t.db.query(`update public.contacts set phone = '+919876500099' where id = $1`, [c]);
    expect(await one(`select phone, phone_e164 from public.contacts where id = $1`, [c])).toEqual({ phone: '+919876500010', phone_e164: '+919876500010' });
    expect(await one(`select rule_id, origin, status, evidence from public.data_quality_issues where entity_id = $1 and origin = 'provenance'`, [c]))
      .toMatchObject({ rule_id: 'provenance.verified_value_protected', status: 'open', evidence: { field: 'phone', attempted_source: 'system' } });
    // A person's edit wins and resets verification.
    await t.as(manager, `update public.contacts set phone = '+919876500011' where id = $1`, [c]);
    expect(await one(`select * from public.field_provenance where entity_id = $1 and field = 'phone'`, [c]))
      .toMatchObject({ source_type: 'user_entry', verification_status: 'unverified', previous_source_type: 'user_entry', change_count: 1 });
    // No copies of the values: hashes only.
    expect(JSON.stringify(await rows(`select * from public.field_provenance where entity_id = $1`, [c]))).not.toContain('9876500011');
  });
});

describe('duplicates and merges', () => {
  it('scores contact pairs with explainable signals', async () => {
    const a = await contact(manager, { name: 'Rohan Mehta', phone: '+919811100001', email: 'rohan@example.com' });
    const b = await contact(manager, { name: 'Rohan M', phone: '9811100001', email: 'rohan@example.com', source: null });
    const c = await contact(manager, { name: 'Different Person', phone: '+919811100001' });
    await tick();
    expect(await cand('contact', a, b)).toMatchObject({ strength: 'strong', score: 100, status: 'open' });
    expect((await cand('contact', a, b)).explanation).toBe('Same phone, same email, names share a word.');
    const weak = await cand('contact', a, c);
    expect(weak).toMatchObject({ strength: 'weak' });
    expect(weak.conflicts.map((x: R) => x.signal)).toEqual(expect.arrayContaining(['different_names']));
    const strongId = (await cand('contact', a, b)).id;
    expect((await events('crm.duplicate_review_required')).some((e) => e.record_id === strongId)).toBe(true);
    // Rescans keep a single candidate per pair.
    await t.db.query(`select private.dq_process($1, 'contact', $2, null)`, [org, a]);
    expect((await rows(`select * from public.duplicate_candidates where record_a = least($1::uuid, $2::uuid) and record_b = greatest($1::uuid, $2::uuid)`, [a, b])).length).toBe(1);
  });

  it('merges contacts after review: relationships move, consent stays conservative, nothing is deleted; replays and stale states are safe; revert restores', async () => {
    const keep = await t.lead(manager, org, { name: 'Neha Joshi', phone: '9822200001', type: 'buyer', consent_channels: ['whatsapp'] });
    const drop = await t.lead(manager, org, { name: 'Neha J', email: 'neha@example.com', type: 'buyer', consent_channels: ['email'] });
    await t.as(manager, `update public.contacts set phone = '+919822200001' where id = $1`, [drop.contact_id]);
    await t.as(manager, `select public.set_contact_consent($1, 'sms', 'revoked', 'Asked not to be texted')`, [drop.contact_id]);
    await tick();
    let c = await cand('contact', keep.contact_id, drop.contact_id);
    expect(c).toMatchObject({ status: 'open', strength: 'possible' });

    expect((await t.fails(agent, `select public.duplicate_decide($1, 'merge', $2, $3, $4, null)`, [c.id, keep.contact_id, c.state_hash, key()])).detail).toBe('FORBIDDEN');
    expect((await t.fails(ownerB, `select public.duplicate_decide($1, 'merge', $2, $3, $4, null)`, [c.id, keep.contact_id, c.state_hash, key()])).detail).toBe('NOT_FOUND');
    // A record changed after the comparison: refused until it is re-evaluated.
    await t.as(manager, `update public.contacts set tags = array['walk-in'] where id = $1`, [drop.contact_id]);
    expect((await t.fails(manager, `select public.duplicate_decide($1, 'merge', $2, $3, $4, null)`, [c.id, keep.contact_id, c.state_hash, key()])).detail).toBe('CONFLICT');
    await tick();
    c = await cand('contact', keep.contact_id, drop.contact_id);

    const k = key();
    const m = await decide(manager, c, 'merge', keep.contact_id, k);
    expect(m).toMatchObject({ status: 'merged', canonical_id: keep.contact_id, merged_id: drop.contact_id });
    expect(await decide(manager, c, 'merge', keep.contact_id, k)).toMatchObject({ replayed: true, merge_id: m.merge_id });
    expect((await t.fails(manager, `select public.duplicate_decide($1, 'merge', $2, $3, $4, null)`, [c.id, keep.contact_id, c.state_hash, key()])).detail).toBe('CONFLICT');

    expect((await one(`select contact_id, archived_at from public.leads where id = $1`, [drop.lead_id]))).toMatchObject({ contact_id: keep.contact_id, archived_at: null });
    const dropped = await one(`select * from public.contacts where id = $1`, [drop.contact_id]);
    expect(dropped).toMatchObject({ merged_into: keep.contact_id, lifecycle_status: 'inactive' });
    const kc = await one(`select * from public.contacts where id = $1`, [keep.contact_id]);
    expect(kc.email).toBe('neha@example.com'); // filled: the canonical contact had no email
    const consents = Object.fromEntries((await rows(`select channel, status from public.communication_consents where contact_id = $1 and purpose = 'service'`, [keep.contact_id])).map((x) => [x.channel, x.status]));
    expect(consents).toMatchObject({ whatsapp: 'granted', email: 'granted', sms: 'revoked' });
    const rec = await one(`select * from public.record_merges where id = $1`, [m.merge_id]);
    expect(rec.moved.leads).toEqual([drop.lead_id]);
    expect(rec.conflicts).toEqual(['display_name']);
    expect((await events('crm.duplicate_merge_completed')).some((e) => e.record_id === m.merge_id)).toBe(true);
    expect(await one(`select * from public.audit_logs where action = 'crm.records_merged' and entity_id = $1`, [keep.contact_id])).toBeTruthy();
    // A lead still cannot be moved between contacts outside a merge.
    expect((await t.fails(manager, `update public.leads set contact_id = $2 where id = $1`, [drop.lead_id, drop.contact_id])).code).toBe('42501');
    await expect(t.db.query(`update public.leads set contact_id = $2 where id = $1`, [drop.lead_id, drop.contact_id])).rejects.toMatchObject({ detail: 'FORBIDDEN' });

    expect((await t.fails(manager, `select public.record_merge_revert($1, '')`, [m.merge_id])).detail).toBe('VALIDATION_ERROR');
    const rv = await t.as<{ r: R }>(manager, `select public.record_merge_revert($1, 'Different family members') r`, [m.merge_id]);
    expect(rv[0].r).toMatchObject({ status: 'reverted' });
    expect((await one(`select contact_id from public.leads where id = $1`, [drop.lead_id])).contact_id).toBe(drop.contact_id);
    expect(await one(`select merged_into, lifecycle_status from public.contacts where id = $1`, [drop.contact_id])).toMatchObject({ merged_into: null, lifecycle_status: 'new' });
    expect((await one(`select email from public.contacts where id = $1`, [keep.contact_id])).email).toBeNull();
    const after = Object.fromEntries((await rows(`select channel, status from public.communication_consents where contact_id = $1 and purpose = 'service'`, [keep.contact_id])).map((x) => [x.channel, x.status]));
    expect(after).toMatchObject({ whatsapp: 'granted', email: 'unknown', sms: 'revoked' }); // revocations are kept
    expect((await cand('contact', keep.contact_id, drop.contact_id)).status).toBe('rejected');
  });

  it('proposes and merges duplicate enquiries of one contact through the existing lead merge', async () => {
    const first = await t.lead(manager, org, { name: 'Ishaan Gupta', phone: '9833300001', type: 'buyer', locations: ['Worli'] });
    const second = await t.lead(manager, org, { contact_id: first.contact_id, type: 'buyer', locations: ['Worli', 'Bandra'] });
    await tick();
    const c = await cand('lead', first.lead_id, second.lead_id);
    expect(c).toMatchObject({ strength: 'strong', score: 80, proposed_canonical: c.proposed_canonical });
    const m = await decide(manager, c, 'merge', first.lead_id);
    expect(m.status).toBe('merged');
    expect(await one(`select archived_at is not null archived, duplicate_status from public.leads where id = $1`, [second.lead_id])).toEqual({ archived: true, duplicate_status: 'merged' });
    expect((await one(`select revertible from public.record_merges where id = $1`, [m.merge_id])).revertible).toBe(false);
    expect((await t.fails(manager, `select public.record_merge_revert($1, 'try')`, [m.merge_id])).detail).toBe('CONFLICT');
  });

  it('finds duplicate listings only with corroborating evidence and refuses merges that would orphan bookings', async () => {
    const a = await prop('DQ-L1', { addr: 'Flat 12, Sea Breeze, Annie Besant Road', area: 900, bedrooms: 2 });
    const b = await prop('DQ-L2', { addr: 'flat 12 sea breeze annie besant road', area: 910, bedrooms: 2, price: 25500000 });
    const otherUnit = await prop('DQ-L3', { addr: 'Flat 12, Sea Breeze, Annie Besant Road', area: 1500, bedrooms: 3 });
    await tick();
    expect(await cand('property', a, b)).toMatchObject({ strength: 'strong', score: 90 });
    expect(await cand('property', a, otherUnit)).toBeUndefined();

    const lead = (await t.lead(manager, org, { name: 'Viewing Lead', phone: '9844400201', type: 'buyer' })).lead_id;
    const at = nextWeekdayAt(11, 3);
    const booked = await t.as<{ r: R }>(manager, `select public.appointment_book($1, 'viewing', $2, $3, $4, $5) r`, [lead, at.toISOString(), agent, key(), b]);
    await tick();
    let c = await cand('property', a, b);
    expect((await t.fails(manager, `select public.duplicate_decide($1, 'merge', $2, $3, $4, null)`, [c.id, a, c.state_hash, key()])).message).toContain('active appointments');
    await t.as(manager, `select public.appointment_cancel($1, 'Listing is a duplicate', null)`, [booked[0].r.appointment_id]);
    await tick();
    c = await cand('property', a, b);
    const m = await decide(manager, c, 'merge', a);
    expect(await one(`select status, merged_into from public.properties where id = $1`, [b])).toEqual({ status: 'archived', merged_into: a });
    const rv = await t.as<{ r: R }>(manager, `select public.record_merge_revert($1, 'Different flats') r`, [m.merge_id]);
    expect(rv[0].r.status).toBe('reverted');
    expect(await one(`select status, merged_into from public.properties where id = $1`, [b])).toEqual({ status: 'active', merged_into: null });
  });
});

describe('scans, anomalies, retries and Agent 08', () => {
  it('runs a requested scan in checkpointed batches to completion, idempotently', async () => {
    expect((await t.fails(agent, `select public.data_quality_scan_request($1, $2)`, [org, key()])).detail).toBe('FORBIDDEN');
    const k = key();
    const s = (await t.as<{ r: R }>(owner, `select public.data_quality_scan_request($1, $2) r`, [org, k]))[0].r;
    expect((await t.as<{ r: R }>(owner, `select public.data_quality_scan_request($1, $2) r`, [org, k]))[0].r).toMatchObject({ scan_id: s.scan_id, replayed: true });
    for (let i = 0; i < 6; i++) await tick();
    const done = await one(`select * from public.data_quality_scans where id = $1`, [s.scan_id]);
    const total = await one(`select (select count(*) from public.contacts where organization_id = $1) + (select count(*) from public.leads where organization_id = $1)
      + (select count(*) from public.properties where organization_id = $1) + (select count(*) from public.appointments where organization_id = $1
        and (status in ('requested', 'pending', 'confirmed', 'reschedule_requested') or calendar_sync_status = 'failed')) n`, [org]);
    expect(done).toMatchObject({ status: 'completed' });
    expect(done.counts.evaluated).toBe(Number(total.n));
    expect((await events('crm.data_scan_completed')).some((e) => e.record_id === s.scan_id)).toBe(true);
  });

  it('retries a failed evaluation with backoff without blocking others', async () => {
    const c = await contact(manager, { name: 'Retry Case', phone: '+919876500020' });
    await t.db.query(`alter table public.data_quality_issues add constraint tmp_block check (entity_id <> '${c}'::uuid) not valid`);
    const r1 = await tick();
    expect(r1.failed).toBe(1);
    expect(await one(`select attempts, enqueued_at > now() later, last_error is not null has_error from public.data_quality_queue where entity_id = $1`, [c]))
      .toEqual({ attempts: 1, later: true, has_error: true });
    await t.db.query(`alter table public.data_quality_issues drop constraint tmp_block`);
    await t.db.query(`update public.data_quality_queue set enqueued_at = now() where entity_id = $1`, [c]);
    await tick();
    expect(await one(`select * from public.data_quality_queue where entity_id = $1`, [c])).toBeUndefined();
    expect((await issues(c)).length).toBeGreaterThan(0);
  });

  it('only alerts on anomalies against a real baseline', async () => {
    await t.db.query(`delete from public.data_quality_daily where organization_id = $1`, [org]);
    await t.db.query(`insert into public.data_quality_daily (organization_id, day, metrics) values ($1, current_date, '{"invalid_phones_24h": 9, "duplicates_24h": 0, "webhook_rejected_24h": 0, "active_properties": 4, "leads_24h": 0}')`, [org]);
    expect((await one(`select private.dq_anomalies($1) r`, [org])).r).toMatchObject({ evaluated: false, reason: 'not_enough_history' });
    for (let d = 1; d <= 7; d++) {
      await t.db.query(`insert into public.data_quality_daily (organization_id, day, metrics) values ($1, current_date - $2::int, '{"invalid_phones_24h": 1, "duplicates_24h": 0, "webhook_rejected_24h": 0, "active_properties": 20, "leads_24h": 0}')`, [org, d]);
    }
    const r = (await one(`select private.dq_anomalies($1) r`, [org])).r;
    expect(r).toMatchObject({ evaluated: true, baseline_days: 7 });
    expect(r.detected).toEqual(expect.arrayContaining(['anomaly.invalid_phones_spike', 'anomaly.inventory_drop']));
    expect(await one(`select severity from public.data_quality_issues where entity_type = 'organization' and rule_id = 'anomaly.inventory_drop'`)).toEqual({ severity: 'high' });
    expect(await one(`select count(*)::int n from public.notifications where organization_id = $1 and title = 'Active listings dropped sharply'`, [org])).toEqual({ n: 1 });
  });

  it('treats a cross-tenant reference as a critical security finding', async () => {
    const foreign = await contact(ownerB, { org: orgB, name: 'Foreign Contact', phone: '+919899900001' });
    const bad = (await t.lead(manager, org, { name: 'Bad Link', phone: '9899900002', type: 'buyer' })).lead_id;
    await t.db.query(`set session_replication_role = replica`);
    await t.db.query(`update public.leads set contact_id = $2 where id = $1`, [bad, foreign]);
    await t.db.query(`set session_replication_role = origin`);
    await t.db.query(`select private.dq_process($1, 'lead', $2, null)`, [org, bad]);
    const x = await issue(bad, 'lead.cross_tenant_contact');
    expect(x).toMatchObject({ severity: 'critical', dimension: 'referential_integrity' });
    expect(await one(`select * from public.audit_logs where action = 'security.integrity_violation' and entity_id = $1`, [bad])).toBeTruthy();
    expect(await one(`select count(*)::int n from public.notifications where organization_id = $1 and title = 'Critical data integrity problem'`, [org])).toEqual({ n: 1 });
    expect((await t.fails(owner, `select public.dq_issue_action($1, 'dismiss', 'ignore it')`, [x.id])).detail).toBe('FORBIDDEN');
  });

  it('gives Agent 08 a data quality context with definitions and limitations', async () => {
    const ctx = (await t.as<{ r: R }>(viewer, `select public.crm_data_quality_context($1) r`, [org]))[0].r;
    expect(ctx).toMatchObject({ schema: 'crm-context/1', unresolved_high_severity: true });
    expect(ctx.open_issues.critical).toBeGreaterThanOrEqual(1);
    expect(ctx.merged.leads).toBeGreaterThanOrEqual(1);
    expect(ctx.definitions.canonical_contacts).toBe('contacts where merged_into is null');
    expect(ctx.limitations.length).toBeGreaterThan(0);
    const ov = (await t.as<{ r: R }>(viewer, `select public.crm_data_quality_overview($1, null) r`, [org]))[0].r;
    expect(ov.score.version).toBe('dq-score/1');
    expect(ov.issues.critical).toBeGreaterThanOrEqual(1);
    expect(ov.can).toEqual({ merge: false, scan: false, settings: false });
  });
});

describe('model proposals', () => {
  it('stores validated enrichment proposals that only a person can apply', async () => {
    const l = (await t.lead(manager, org, { name: 'Notes Lead', phone: '9844400301', type: 'buyer' })).lead_id;
    const res = (await t.as<{ r: R }>(manager, `select public.dq_propose_enrichment($1, $2::jsonb, 'claude-opus-5-5') r`, [l, JSON.stringify([
      { field: 'bedrooms', value: 3, evidence: 'looking for a 3 BHK' },
      { field: 'bedrooms', value: 99, evidence: 'ninety nine rooms' },
      { field: 'phone', value: '123', evidence: 'call me on 123' },
      { field: 'desired_property_type', value: 'castle', evidence: 'wants a castle' },
    ])]))[0].r;
    expect(res).toEqual({ proposed: 1, skipped: 3 });
    const x = await one(`select * from public.data_quality_issues where entity_id = $1 and origin = 'ai_extraction'`, [l]);
    expect(x).toMatchObject({ status: 'proposed', proposed_fix: { field: 'bedrooms', value: 3 } });
    expect((await one(`select bedrooms from public.leads where id = $1`, [l])).bedrooms).toBeNull();
    expect((await t.fails(viewer, `select public.dq_propose_enrichment($1, '[]'::jsonb, 'm')`, [l])).detail).toBe('FORBIDDEN');
    await t.as(manager, `select public.dq_issue_apply_fix($1)`, [x.id]);
    expect((await one(`select bedrooms from public.leads where id = $1`, [l])).bedrooms).toBe(3);
    expect(await one(`select status, resolution from public.data_quality_issues where id = $1`, [x.id])).toEqual({ status: 'resolved', resolution: 'corrected' });
    expect((await events('crm.record_enriched')).some((e) => e.payload.issue_id === x.id)).toBe(true);
    expect((await one(`select source_type from public.field_provenance where entity_id = $1 and field = 'bedrooms'`, [l])).source_type).toBe('correction');
  });
});

describe('tenant isolation and permissions', () => {
  it('keeps findings, candidates, provenance and actions inside the workspace', async () => {
    const anyIssue = await one(`select id, entity_type, entity_id from public.data_quality_issues where organization_id = $1 and entity_type = 'contact' limit 1`, [org]);
    expect(await t.as(ownerB, `select * from public.data_quality_issues where organization_id = $1`, [org])).toEqual([]);
    expect(await t.as(ownerB, `select * from public.duplicate_candidates where organization_id = $1`, [org])).toEqual([]);
    expect(await t.as(ownerB, `select * from public.field_provenance where organization_id = $1`, [org])).toEqual([]);
    expect(await t.as(ownerB, `select * from public.record_merges where organization_id = $1`, [org])).toEqual([]);
    for (const sql of [`select public.dq_issues($1)`, `select public.crm_data_quality_overview($1, null)`, `select public.crm_data_quality_context($1)`, `select public.dq_duplicates($1)`]) {
      expect((await t.fails(ownerB, sql, [org])).detail).toBe('NOT_FOUND');
    }
    expect((await t.fails(ownerB, `select public.crm_record_quality($1, $2)`, [anyIssue.entity_type, anyIssue.entity_id])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.dq_issue_action($1, 'dismiss', 'cross tenant')`, [anyIssue.id])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.dq_verify_field($1, $2, 'phone', true)`, [anyIssue.entity_type, anyIssue.entity_id])).detail).toBe('NOT_FOUND');
    // No direct writes, no worker access for users.
    expect((await t.fails(manager, `insert into public.data_quality_issues (organization_id, entity_type, entity_id, rule_id, dimension, severity, message, fingerprint)
      values ($1, 'contact', gen_random_uuid(), 'x.y', 'validity', 'info', 'm', 'f')`, [org])).code).toBe('42501');
    expect((await t.fails(manager, `select public.crm_data_tick(10)`)).code).toBe('42501');
    expect((await t.fails(manager, `select * from public.data_quality_queue`)).code).toBe('42501');
  });
});
