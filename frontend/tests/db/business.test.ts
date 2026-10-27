import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, nextWeekdayAt, type TestDb } from './harness';

let t: TestDb;
let org: string, owner: string, manager: string, agentPowai: string, agentWorli: string, finance: string;

const ins = async (user: string, sql: string, params: unknown[]) => (await t.as<{ id: string }>(user, sql, params))[0].id;
const property = (user: string, status = 'active', ref = `R-${Math.random().toString(36).slice(2, 7)}`) =>
  ins(user, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, area_value, locality) values ($1, $2, '2 BHK at Hiranandani', 'apartment', 'sale', $3, 20000000, 850, 'Powai') returning id`, [org, ref, status]);
const appt = (user: string, assignee: string, start: Date, extra: Record<string, unknown> = {}) =>
  t.as<{ id: string }>(user, `insert into public.appointments (organization_id, title, appointment_type, lead_id, property_id, assigned_to, starts_at, ends_at) values ($1, 'Site visit', $2, $3, $4, $5, $6, $7) returning id`,
    [org, extra.type ?? 'viewing', extra.lead ?? null, extra.property ?? null, assignee, start, new Date(start.getTime() + 45 * 60e3)]);

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Aanya Kapoor');
  manager = await t.user('Priya Nair');
  agentPowai = await t.user('Meera Iyer');
  agentWorli = await t.user('Arjun Desai');
  finance = await t.user('Vikram Rao');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, manager, 'manager');
  await t.member(org, agentPowai, 'agent', ['Powai']);
  await t.member(org, agentWorli, 'agent', ['Worli']);
  await t.member(org, finance, 'finance');
  await t.db.query(`update public.organizations set settings = jsonb_set(settings, '{assignment}', '"by_locality"') where id = $1`, [org]);
}, 120000);

describe('organizations & invitations', () => {
  it('creator becomes owner with a unique slug', async () => {
    const u = await t.user('Second Founder');
    const id = await t.org(u, 'Skyline Realty');
    const [o] = await t.as<{ slug: string; role: string }>(u, `select o.slug, public.org_role(o.id) role from public.organizations o where o.id = $1`, [id]);
    expect(o.slug).toBe('skyline-realty-1');
    expect(o.role).toBe('owner');
  });

  it('invitation tokens are single-use and email-bound', async () => {
    const [{ r }] = await t.as<{ r: { token: string } }>(owner, `select public.invite_member($1, 'Neha@Example.com', 'agent') r`, [org]);
    expect(r.token).toHaveLength(64);
    const [{ n }] = await t.db.query<{ n: number }>(`select count(*)::int n from public.invitations where token_hash = $1`, [r.token]).then((x) => x.rows);
    expect(n).toBe(0); // raw token is never stored
    const stranger = await t.user('Stranger', 'stranger@example.com');
    expect((await t.fails(stranger, `select public.accept_invitation($1)`, [r.token])).detail).toBe('INVALID_INVITATION');
    const neha = await t.user('Neha Joshi', 'neha@example.com');
    expect((await t.as<{ my: unknown[] }>(neha, `select coalesce(jsonb_agg(i), '[]') my from public.my_invitations() i`))[0].my).toHaveLength(1);
    await t.as(neha, `select public.accept_invitation($1)`, [r.token]);
    const [m] = await t.as<{ role: string }>(neha, `select role from public.organization_memberships where organization_id = $1 and user_id = $2`, [org, neha]);
    expect(m.role).toBe('agent');
    expect((await t.fails(neha, `select public.accept_invitation($1)`, [r.token])).detail).toBe('INVALID_INVITATION');
    expect((await t.fails(owner, `select public.invite_member($1, 'neha@example.com', 'agent')`, [org])).detail).toBe('CONFLICT');
  });

  it('only owners can invite admins', async () => {
    const admin = await t.user('Ops Admin');
    await t.member(org, admin, 'admin');
    expect((await t.fails(admin, `select public.invite_member($1, 'boss@example.com', 'admin')`, [org])).detail).toBe('FORBIDDEN');
  });

  it('settings are validated', async () => {
    const e = await t.fails(owner, `update public.organizations set settings = jsonb_set(settings, '{business_hours,start}', '22') where id = $1`, [org]);
    expect(e.detail).toBe('VALIDATION_ERROR');
  });
});

describe('leads', () => {
  it('creates contact, consents, history, activity and assigns by locality', async () => {
    const r = await t.lead(manager, org, { name: 'Riya Malhotra', phone: '98200 12345', email: 'Riya@Example.com', source: 'Website form', locations: ['Powai'], budget_max: 25000000, bedrooms: 2, property_type: 'apartment', timeline: 'Immediate', consent_channels: ['whatsapp'] });
    expect(r.status).toBe('created');
    const [lead] = await t.as<{ assigned_to: string; lead_score: string; status: string; budget_min: string }>(manager, `select * from public.leads where id = $1`, [r.lead_id]);
    expect(lead.assigned_to).toBe(agentPowai);
    expect(Number(lead.lead_score)).toBe(84);
    expect(Number(lead.budget_min)).toBe(18750000);
    const [c] = await t.as<{ phone_e164: string; email_normalized: string }>(manager, `select * from public.contacts where id = $1`, [r.contact_id]);
    expect(c.phone_e164).toBe('+919820012345');
    expect(c.email_normalized).toBe('riya@example.com');
    const consents = await t.as<{ channel: string; status: string }>(manager, `select channel, status from public.communication_consents where contact_id = $1 order by channel`, [r.contact_id]);
    expect(Object.fromEntries(consents.map((x) => [x.channel, x.status]))).toEqual({ email: 'unknown', phone: 'unknown', sms: 'unknown', whatsapp: 'granted' });
    expect(await t.as(manager, `select * from public.lead_status_history where lead_id = $1`, [r.lead_id])).toHaveLength(1);
    const acts = await t.as<{ activity_type: string }>(manager, `select activity_type from public.activities where lead_id = $1`, [r.lead_id]);
    expect(acts.map((a) => a.activity_type).sort()).toEqual(['assigned', 'created']);
    const notes = await t.as(agentPowai, `select * from public.notifications where entity_id = $1`, [r.lead_id]);
    expect(notes).toHaveLength(1);
  });

  it('detects duplicates without writing, then links on request', async () => {
    const before = (await t.as(manager, `select id from public.leads`)).length;
    const ask = await t.lead(manager, org, { name: 'Riya M', phone: '+91 98200-12345' }, 'ask');
    expect(ask.status).toBe('duplicate');
    expect((await t.as(manager, `select id from public.leads`)).length).toBe(before);
    const link = await t.lead(manager, org, { name: 'Riya M', phone: '9820012345', source: 'Referral' }, 'link');
    const [first] = await t.as<{ contact_id: string }>(manager, `select contact_id from public.leads where title = 'Riya Malhotra'`);
    expect(link.contact_id).toBe(first.contact_id);
  });

  it('validates input', async () => {
    expect((await t.fails(manager, `select public.create_lead($1, '{"name":"X"}'::jsonb, 'create')`, [org])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(manager, `select public.create_lead($1, '{"name":"X","phone":"123"}'::jsonb, 'create')`, [org])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(manager, `select public.create_lead($1, '{"name":"X","phone":"9820000000","budget_max":"lots"}'::jsonb, 'create')`, [org])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(manager, `select public.create_lead($1, '{"name":"X","phone":"9820000000","budget_max":-5}'::jsonb, 'create')`, [org])).detail).toBe('VALIDATION_ERROR');
  });

  it('enforces status transitions', async () => {
    const r = await t.lead(manager, org, { name: 'Transition Test', phone: '9820099999' });
    expect((await t.fails(manager, `update public.leads set status = 'lost' where id = $1`, [r.lead_id])).message).toMatch(/leads_lost_needs_reason/);
    await t.as(manager, `update public.leads set status = 'lost', lost_reason = 'Budget mismatch' where id = $1`, [r.lead_id]);
    expect((await t.fails(manager, `update public.leads set status = 'qualified' where id = $1`, [r.lead_id])).detail).toBe('INVALID_TRANSITION');
    await t.as(manager, `update public.leads set status = 'contacted' where id = $1`, [r.lead_id]);
    await t.as(manager, `update public.leads set status = 'won' where id = $1`, [r.lead_id]);
    expect((await t.fails(manager, `update public.leads set status = 'negotiation' where id = $1`, [r.lead_id])).detail).toBe('INVALID_TRANSITION');
    const hist = await t.as<{ to_status: string }>(manager, `select to_status from public.lead_status_history where lead_id = $1 order by created_at, to_status`, [r.lead_id]);
    expect(hist.map((h) => h.to_status)).toEqual(expect.arrayContaining(['new', 'lost', 'contacted', 'won']));
    const [audit] = await t.as<{ details: { status: { from: string; to: string } } }>(owner, `select details from public.audit_logs where entity_id = $1 and details ? 'status' order by created_at desc limit 1`, [r.lead_id]);
    expect(audit.details.status).toEqual({ from: 'contacted', to: 'won' });
  });

  it('agents can claim an unassigned lead', async () => {
    const r = await t.lead(manager, org, { name: 'Unclaimed', phone: '9820077777', assigned_to: null });
    await t.as(agentWorli, `update public.leads set assigned_to = $1 where id = $2`, [agentWorli, r.lead_id]);
    const [l] = await t.as<{ assigned_to: string }>(manager, `select assigned_to from public.leads where id = $1`, [r.lead_id]);
    expect(l.assigned_to).toBe(agentWorli);
  });

  it('human edits clear AI provenance', async () => {
    const r = await t.lead(manager, org, { name: 'AI Fields', phone: '9820066666', budget_max: 100 });
    await t.db.query(`update public.leads set ai_extracted_fields = '{budget,timeline}' where id = $1`, [r.lead_id]);
    await t.as(manager, `update public.leads set budget_max = 200 where id = $1`, [r.lead_id]);
    const [l] = await t.as<{ ai_extracted_fields: string[] }>(manager, `select ai_extracted_fields from public.leads where id = $1`, [r.lead_id]);
    expect(l.ai_extracted_fields).toEqual(['timeline']);
  });

  it('merges duplicate enquiries and keeps history', async () => {
    const a = await t.lead(manager, org, { name: 'Merge Me', phone: '9820055555', locations: ['Powai'] });
    const b = await t.lead(manager, org, { name: 'Merge Me', phone: '9820055555', locations: ['Worli'], budget_max: 5000000 }, 'link');
    await t.as(manager, `select public.merge_leads($1, $2)`, [a.lead_id, b.lead_id]);
    const [k] = await t.as<{ desired_locations: string[]; budget_max: string }>(manager, `select * from public.leads where id = $1`, [a.lead_id]);
    expect(k.desired_locations.sort()).toEqual(['Powai', 'Worli']);
    expect(Number(k.budget_max)).toBe(5000000);
    const [d] = await t.as<{ archived_at: string | null }>(manager, `select archived_at from public.leads where id = $1`, [b.lead_id]);
    expect(d.archived_at).not.toBeNull();
    // History moved to the surviving lead; the merged-away lead only records that it was archived.
    const left = await t.as<{ title: string }>(manager, `select title from public.activities where lead_id = $1`, [b.lead_id]);
    expect(left.map((x) => x.title)).toEqual(['Archived']);
    expect((await t.as(manager, `select id from public.activities where lead_id = $1 and title = 'Merged duplicate enquiry'`, [a.lead_id]))).toHaveLength(1);
  });
});

describe('consent', () => {
  it('opt-out suppresses every channel and blocks re-granting', async () => {
    const r = await t.lead(manager, org, { name: 'Opt Out', phone: '9820044444', consent_channels: ['phone', 'whatsapp'] });
    await t.as(manager, `select public.opt_out_contact($1)`, [r.contact_id]);
    const rows = await t.as<{ status: string }>(manager, `select status from public.communication_consents where contact_id = $1`, [r.contact_id]);
    expect(rows.every((x) => x.status === 'revoked')).toBe(true);
    expect((await t.fails(manager, `select public.set_contact_consent($1, 'whatsapp', 'granted')`, [r.contact_id])).detail).toBe('FORBIDDEN');
    expect((await t.as<{ activity_type: string }>(manager, `select activity_type from public.activities where contact_id = $1 and activity_type = 'opt_out'`, [r.contact_id])).length).toBe(4);
  });
});

describe('appointments', () => {
  it('books, detects conflicts, and offers free slots', async () => {
    const r = await t.lead(manager, org, { name: 'Visit Lead', phone: '9820033333', locations: ['Powai'] });
    const prop = await property(manager);
    const start = nextWeekdayAt(11);
    await appt(manager, agentPowai, start, { lead: r.lead_id, property: prop });
    const [l] = await t.as<{ status: string }>(manager, `select status from public.leads where id = $1`, [r.lead_id]);
    expect(l.status).toBe('visit_scheduled');
    const overlap = new Date(start.getTime() + 15 * 60e3);
    const e = await t.fails(manager, `insert into public.appointments (organization_id, title, assigned_to, starts_at, ends_at) values ($1, 'Clash', $2, $3, $4)`, [org, agentPowai, overlap, new Date(overlap.getTime() + 30 * 60e3)]);
    expect(e.detail).toBe('APPOINTMENT_CONFLICT');
    // A different person at the same time is fine.
    await appt(manager, agentWorli, start, { type: 'consultation' });
    const slots = await t.as<{ s: string }>(manager, `select s from public.appointment_free_slots($1, $2, $3, 45, 3) s`, [org, agentPowai, new Date(start.getTime() - 60 * 60e3)]);
    expect(slots).toHaveLength(3);
    for (const s of slots) {
      const st = new Date(s.s).getTime();
      expect(st + 45 * 60e3 <= start.getTime() || st >= start.getTime() + 45 * 60e3).toBe(true);
    }
  });

  it('rejects past times, out-of-hours bookings and unavailable properties', async () => {
    const past = new Date(Date.now() - 2 * 3600e3);
    expect((await t.fails(manager, `insert into public.appointments (organization_id, title, assigned_to, starts_at, ends_at) values ($1, 'Past', $2, $3, $4)`, [org, agentWorli, past, new Date(past.getTime() + 1800e3)])).detail).toBe('VALIDATION_ERROR');
    const late = nextWeekdayAt(22, 3);
    expect((await t.fails(manager, `insert into public.appointments (organization_id, title, assigned_to, starts_at, ends_at) values ($1, 'Late', $2, $3, $4)`, [org, agentWorli, late, new Date(late.getTime() + 1800e3)])).detail).toBe('OUTSIDE_BUSINESS_HOURS');
    const sold = await property(manager, 'sold');
    const s = nextWeekdayAt(15, 4);
    const e = await t.fails(manager, `insert into public.appointments (organization_id, title, appointment_type, property_id, assigned_to, starts_at, ends_at) values ($1, 'Sold viewing', 'viewing', $2, $3, $4, $5)`, [org, sold, agentWorli, s, new Date(s.getTime() + 1800e3)]);
    expect(e.detail).toBe('PROPERTY_UNAVAILABLE');
  });

  it('cancellation needs a reason; completion advances the lead', async () => {
    const r = await t.lead(manager, org, { name: 'Complete Lead', phone: '9820022222' });
    const s = nextWeekdayAt(16, 5);
    const [{ id }] = await appt(manager, agentWorli, s, { lead: r.lead_id, type: 'viewing' });
    expect((await t.fails(manager, `update public.appointments set status = 'cancelled' where id = $1`, [id])).detail).toBe('VALIDATION_ERROR');
    await t.as(manager, `update public.appointments set status = 'completed', feedback = 'Liked it' where id = $1`, [id]);
    const [l] = await t.as<{ status: string }>(manager, `select status from public.leads where id = $1`, [r.lead_id]);
    expect(l.status).toBe('visit_completed');
  });
});

describe('deals & commissions', () => {
  it('won deal creates a commission, closes the lead and sells the property', async () => {
    const r = await t.lead(manager, org, { name: 'Deal Lead', phone: '9820011111' });
    const prop = await property(manager);
    const deal = await ins(manager, `insert into public.deals (organization_id, title, lead_id, primary_contact_id, property_id, expected_value, commission_pct, owner_user_id) values ($1, 'Deal', $2, $3, $4, 20000000, 1.5, $5) returning id`, [org, r.lead_id, r.contact_id, prop, agentPowai]);
    await t.as(manager, `update public.deals set stage = 'under_contract' where id = $1`, [deal]);
    expect((await t.as<{ status: string }>(manager, `select status from public.properties where id = $1`, [prop]))[0].status).toBe('under_offer');
    await t.as(manager, `update public.deals set stage = 'won' where id = $1`, [deal]);
    const [c] = await t.as<{ gross_commission: string; status: string }>(finance, `select * from public.commissions where deal_id = $1`, [deal]);
    expect(Number(c.gross_commission)).toBe(300000);
    expect(c.status).toBe('estimated');
    expect((await t.as<{ status: string }>(manager, `select status from public.leads where id = $1`, [r.lead_id]))[0].status).toBe('won');
    expect((await t.as<{ status: string }>(manager, `select status from public.properties where id = $1`, [prop]))[0].status).toBe('sold');
    expect((await t.fails(manager, `update public.deals set stage = 'offer' where id = $1`, [deal])).detail).toBe('INVALID_TRANSITION');
    // Commission lifecycle is ordered and finance-only.
    expect(await t.as(manager, `update public.commissions set status = 'approved' where deal_id = $1 returning id`, [deal])).toHaveLength(0);
    expect((await t.fails(finance, `update public.commissions set status = 'paid' where deal_id = $1`, [deal])).detail).toBe('INVALID_TRANSITION');
    for (const s of ['approved', 'payable', 'paid']) await t.as(finance, `update public.commissions set status = $2 where deal_id = $1`, [deal, s]);
    const [paid] = await t.as<{ paid_at: string; approved_by: string }>(finance, `select * from public.commissions where deal_id = $1`, [deal]);
    expect(paid.paid_at).not.toBeNull();
    expect(paid.approved_by).toBe(finance);
  });
});

describe('properties & tasks', () => {
  it('verification time is set by the server', async () => {
    const p = await property(manager);
    await t.as(manager, `update public.properties set verified_at = '2001-01-01' where id = $1`, [p]);
    const [row] = await t.as<{ verified_at: string; verified_by: string }>(manager, `select verified_at, verified_by from public.properties where id = $1`, [p]);
    expect(Date.now() - new Date(row.verified_at).getTime()).toBeLessThan(60_000);
    expect(row.verified_by).toBe(manager);
    expect((await t.fails(manager, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, price, area_value, locality) values ($1, 'NEG', 'Bad price listing', 'apartment', 'sale', -1, 10, 'Powai')`, [org])).message).toMatch(/check constraint/);
  });

  it('completing a task stamps it and logs to the lead', async () => {
    const r = await t.lead(manager, org, { name: 'Task Lead', phone: '9820010101' });
    const task = await ins(manager, `insert into public.tasks (organization_id, title, due_at, assigned_to, related_lead_id) values ($1, 'Send brochure', now() + interval '1 day', $2, $3) returning id`, [org, agentWorli, r.lead_id]);
    await t.as(manager, `update public.tasks set status = 'completed' where id = $1`, [task]);
    const [row] = await t.as<{ completed_at: string }>(manager, `select completed_at from public.tasks where id = $1`, [task]);
    expect(row.completed_at).not.toBeNull();
    expect((await t.as(manager, `select id from public.activities where lead_id = $1 and title like 'Task completed%'`, [r.lead_id]))).toHaveLength(1);
    expect((await t.as(agentWorli, `select id from public.notifications where entity_id = $1`, [task]))).toHaveLength(1);
  });
});

describe('dashboard metrics', () => {
  it('returns truthful zeros for an empty organization', async () => {
    const u = await t.user('Empty Owner');
    const empty = await t.org(u, 'Empty Agency');
    const [{ m }] = await t.as<{ m: { kpis: Record<string, { current: number }>; series: unknown[]; sources: unknown[] } }>(u, `select public.dashboard_metrics($1, now() - interval '30 days', now()) m`, [empty]);
    expect(m.kpis.new_leads.current).toBe(0);
    expect(m.kpis.won_value.current).toBe(0);
    expect(m.sources).toEqual([]);
    expect(m.series.length).toBeGreaterThanOrEqual(30);
  });

  it('aggregates real rows', async () => {
    const [{ m }] = await t.as<{ m: { kpis: { new_leads: { current: number }; won_value: { current: number } }; sources: { source: string; leads: number }[]; funnel: { n: number }[] } }>(manager, `select public.dashboard_metrics($1, now() - interval '7 days', now() + interval '1 hour', 'day') m`, [org]);
    const [{ n }] = await t.as<{ n: number }>(manager, `select count(*)::int n from public.leads where organization_id = $1 and archived_at is null`, [org]);
    expect(m.kpis.new_leads.current).toBe(n);
    expect(m.funnel[0].n).toBe(n);
    expect(m.kpis.won_value.current).toBe(20000000);
    expect(m.sources.reduce((s, x) => s + x.leads, 0)).toBe(n);
  });

  it('rejects silly ranges', async () => {
    expect((await t.fails(manager, `select public.dashboard_metrics($1, now(), now() - interval '1 day')`, [org])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(manager, `select public.dashboard_metrics($1, now() - interval '2 years', now())`, [org])).detail).toBe('VALIDATION_ERROR');
  });
});

describe('webhook intake', () => {
  it('is idempotent, validates payloads, and rejects bad signatures', async () => {
    const payload = { name: 'Ira Sen', phone: '9811122233', source: 'Meta Ads', locations: ['Worli'] };
    const [{ r: first }] = await t.asService<{ r: { status: string; lead_id: string } }>(`select public.ingest_lead($1, 'webhook', 'evt_1', $2::jsonb, true) r`, [org, JSON.stringify(payload)]);
    expect(first.status).toBe('created');
    const [{ r: again }] = await t.asService<{ r: { status: string; lead_id: string } }>(`select public.ingest_lead($1, 'webhook', 'evt_1', $2::jsonb, true) r`, [org, JSON.stringify(payload)]);
    expect(again).toEqual({ status: 'duplicate_event', lead_id: first.lead_id });
    const [l] = await t.as<{ assigned_to: string; source: string }>(manager, `select * from public.leads where id = $1`, [first.lead_id]);
    expect(l.assigned_to).toBe(agentWorli);
    expect(l.source).toBe('Meta Ads');
    const [{ r: bad }] = await t.asService<{ r: { status: string } }>(`select public.ingest_lead($1, 'webhook', 'evt_2', '{"name":"No contact"}'::jsonb, true) r`, [org]);
    expect(bad.status).toBe('invalid');
    const [{ r: forged }] = await t.asService<{ r: { status: string } }>(`select public.ingest_lead($1, 'webhook', 'evt_3', $2::jsonb, false) r`, [org, JSON.stringify(payload)]);
    expect(forged.status).toBe('rejected');
    await t.asService(`select public.ingest_lead($1, 'webhook', 'evt_4', '{}'::jsonb, false)`, [org]);
    const events = await t.as<{ processing_status: string }>(owner, `select processing_status from public.webhook_events where organization_id = $1 order by received_at`, [org]);
    expect(events.map((e) => e.processing_status).sort()).toEqual(['failed', 'processed', 'rejected']);
  });

  it('records repeated signature failures as one bounded row per minute', async () => {
    for (let i = 0; i < 3; i++) await t.asService(`select public.record_rejected_webhook($1, 'forged-test')`, [org]);
    const rows = await t.as<{ attempt_count: number; signature_verified: boolean }>(owner, `select attempt_count, signature_verified from public.webhook_events where organization_id = $1 and provider = 'forged-test'`, [org]);
    expect(rows).toEqual([{ attempt_count: 3, signature_verified: false }]);
    expect((await t.fails(owner, `select public.record_rejected_webhook($1, 'x')`, [org])).message).toMatch(/permission denied/);
  });

  it('secrets are rotated into the vault and readable only by the service role', async () => {
    const [{ s }] = await t.as<{ s: string }>(owner, `select public.rotate_webhook_secret($1) s`, [org]);
    expect(s).toMatch(/^whsec_[0-9a-f]{64}$/);
    const [{ slug }] = await t.as<{ slug: string }>(owner, `select slug from public.organizations where id = $1`, [org]);
    const rows = await t.asService<{ secret: string; organization_id: string }>(`select * from public.webhook_secret_for($1)`, [slug]);
    expect(rows[0]).toEqual({ organization_id: org, secret: s });
    const [i] = await t.as<Record<string, unknown>>(owner, `select * from public.integrations where organization_id = $1`, [org]);
    expect(JSON.stringify(i)).not.toContain(s);
    expect((await t.fails(owner, `select * from public.webhook_secret_for($1)`, [slug])).message).toMatch(/permission denied/);
    expect((await t.fails(manager, `select public.rotate_webhook_secret($1)`, [org])).detail).toBe('FORBIDDEN');
  });
});
