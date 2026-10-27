// Agent 06 — Appointments: deterministic availability (hours, buffers, closures, time off, property, notice, DST),
// idempotent booking with conflict prevention, state machine and versions, reschedule safety, cancellation, history,
// events, Agent 05 confirmations / reminders / cancellation notices with stale suppression, the calendar boundary,
// and tenant isolation. No calendar provider is called.
import { beforeAll, describe, expect, it } from 'vitest';
import { createDb, nextWeekdayAt, type TestDb } from './harness';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let t: TestDb;
let org: string, owner: string, manager: string, agent: string, agent2: string, viewer: string;
let orgB: string, ownerB: string;
let prop: string, prop2: string, lead: string, leadB: string;
let seq = 0;

const one = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows[0];
const rows = async <T = R>(sql: string, params: unknown[] = []) => (await t.db.query<T>(sql, params)).rows;
// Distinct test days two apart: Sunday skipping can never make two of them the same date.
const when = (n: number, hourIst: number) => nextWeekdayAt(hourIst, 2 * n);
const key = () => `k_ap_${++seq}_${Date.now()}`;
const localDate = (d: Date) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const avail = (user: string, o: R) => t.as<{ r: R }>(user, `select public.appointment_availability($1, $2, $3, $4, $5::date, $6::date, $7::time, $8::time, $9, $10) r`,
  [o.lead ?? null, o.type ?? 'viewing', o.property ?? null, o.assignee ?? null, o.from ?? null, o.to ?? null, o.prefStart ?? null, o.prefEnd ?? null, o.duration ?? null, o.org ?? null]).then((x) => x[0].r);
const book = (user: string | null, o: R) => {
  const sql = `select public.appointment_book($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) r`;
  const params = [o.lead ?? null, o.type ?? 'viewing', o.at, o.assignee ?? agent, o.key ?? key(), o.property === undefined ? prop : o.property, o.duration ?? null, o.location ?? null, null, o.org ?? null];
  return (user ? t.as<{ r: R }>(user, sql, params) : t.asService<{ r: R }>(sql, params)).then((x) => x[0].r);
};
const appt = (id: string) => one(`select * from public.appointments where id = $1`, [id]);
const ftick = () => t.asService(`select public.follow_up_tick(50)`);

beforeAll(async () => {
  t = await createDb();
  owner = await t.user('Aanya Kapoor');
  manager = await t.user('Priya Nair');
  agent = await t.user('Arjun Desai');
  agent2 = await t.user('Meera Iyer');
  viewer = await t.user('Vik Viewer');
  org = await t.org(owner, 'Skyline Realty');
  await t.member(org, manager, 'manager');
  await t.member(org, agent, 'agent');
  await t.member(org, agent2, 'agent');
  await t.member(org, viewer, 'viewer');
  ownerB = await t.user('Bina Bose');
  orgB = await t.org(ownerB, 'Other Agency');
  const mk = async (ref: string, title: string) => (await t.as<{ id: string }>(manager, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, area_value, locality)
    values ($1, $2, $3, 'apartment', 'sale', 'active', 20000000, 850, 'Worli') returning id`, [org, ref, title]))[0].id;
  prop = await mk('AP-1', 'Sea view 2 BHK Worli');
  prop2 = await mk('AP-2', 'Garden 3 BHK Worli');
  lead = (await t.lead(manager, org, { name: 'Ravi Menon', phone: '9844400001', type: 'buyer', locations: ['Worli'], consent_channels: ['whatsapp'] })).lead_id;
  leadB = (await t.lead(ownerB, orgB, { name: 'Other Lead', phone: '9844400002', type: 'buyer' })).lead_id;
  // Follow-up messages in tests may be sent at any hour; the window logic has its own tests.
  await t.as(owner, `select public.follow_up_settings_save($1, '{"window": {"start": 0, "end": 24}, "human_cooldown_hours": 0}'::jsonb)`, [org]);
}, 120000);

describe('availability', () => {
  it('offers real slots inside hours, respecting notice, buffers and duration; ranks the preferred window first', async () => {
    const day = when(2, 9);
    const a = await avail(manager, { lead, property: prop, assignee: agent, from: localDate(day), to: localDate(day) });
    expect(a).toMatchObject({ status: 'ok', timezone: 'Asia/Kolkata', duration: 45, buffer_minutes: 15 });
    const starts = a.slots.map((s: R) => new Date(s.starts_at).getTime());
    expect(starts[0]).toBe(day.getTime()); // 09:00 IST
    expect(a.slots[0].local_label).toMatch(/09:00 AM$/);
    expect(starts.every((s: number) => (s - day.getTime()) % (30 * 60e3) === 0)).toBe(true);

    // A booking at 11:00 removes 10:30, 11:00 and 11:30 (45 min + 15 min buffer either side) for that person only.
    const at11 = when(2, 11);
    await book(manager, { lead, at: at11 });
    const b = await avail(manager, { lead, type: 'consultation', property: null, assignee: agent, from: localDate(day), to: localDate(day), duration: 45 });
    const bs = b.slots.map((s: R) => new Date(s.starts_at).getTime() - day.getTime());
    for (const off of [1.5, 2, 2.5].map((h) => h * 3600e3)) expect(bs).not.toContain(off);
    expect(bs).toContain(3 * 3600e3); // 12:00

    const pref = await avail(manager, { lead, property: prop2, assignee: agent, from: localDate(day), to: localDate(day), prefStart: '14:00', prefEnd: '16:00' });
    expect(new Date(pref.slots[0].starts_at).getTime()).toBe(when(2, 14).getTime());
    expect(pref.slots[0].preferred).toBe(true);
  });

  it('the same property cannot be viewed twice at once; closures, time off, property restrictions and working hours are honoured', async () => {
    const day = when(3, 9);
    await book(manager, { lead, at: when(3, 15), assignee: agent2 });
    const v = await avail(manager, { lead, property: prop, assignee: agent, from: localDate(day), to: localDate(day) });
    expect(v.slots.map((s: R) => new Date(s.starts_at).getTime())).not.toContain(when(3, 15).getTime());
    const c = await avail(manager, { lead, type: 'consultation', property: null, assignee: agent, from: localDate(day), to: localDate(day), prefStart: '15:00', prefEnd: '16:00' });
    expect(new Date(c.slots[0].starts_at).getTime()).toBe(when(3, 15).getTime());

    await t.as(agent, `select public.availability_block_add($1, 'time_off', $2, $3, $4, null, 'Dentist')`, [org, when(3, 9), when(3, 13), agent]);
    const off = await avail(manager, { lead, type: 'consultation', property: null, assignee: agent, from: localDate(day), to: localDate(day) });
    expect(Math.min(...off.slots.map((s: R) => new Date(s.starts_at).getTime()))).toBeGreaterThanOrEqual(when(3, 13).getTime());

    await t.as(manager, `select public.availability_block_add($1, 'property_unavailable', $2, $3, null, $4, 'Tenant moving out')`, [org, when(3, 9), when(3, 20), prop2]);
    expect((await avail(manager, { lead, property: prop2, assignee: agent, from: localDate(day), to: localDate(day) })).status).toBe('no_slots');

    await t.as(owner, `select public.availability_block_add($1, 'closure', $2, $3, null, null, 'Diwali')`, [org, when(4, 0), when(4, 23)]);
    expect((await avail(manager, { lead, type: 'consultation', property: null, assignee: agent2, from: localDate(when(4, 9)), to: localDate(when(4, 9)) })).status).toBe('no_slots');

    // Personal hours narrow the window; a person may set their own.
    const dow = new Date(when(5, 9).getTime() + 5.5 * 3600e3).getUTCDay();
    await t.as(agent2, `select public.staff_working_hours_save($1, $2, $3::jsonb)`, [org, agent2, JSON.stringify([{ weekday: dow, start: '14:00', end: '16:00' }])]);
    const wh = await avail(manager, { lead, type: 'consultation', property: null, assignee: agent2, from: localDate(when(5, 9)), to: localDate(when(5, 9)), duration: 60 });
    expect(wh.slots.map((s: R) => s.local_label.slice(-8))).toEqual(['02:00 PM', '02:30 PM', '03:00 PM']);
    expect((await t.fails(manager, `select public.appointment_book($1, 'consultation', $2, $3, $4)`, [lead, when(5, 11), agent2, key()])).detail).toBe('OUTSIDE_WORKING_HOURS');
    await t.as(agent2, `select public.staff_working_hours_save($1, $2, '[]'::jsonb)`, [org, agent2]);
  });

  it('validates inputs: inactive property, missing property, bad window, unknown member', async () => {
    const sold = (await t.as<{ id: string }>(manager, `insert into public.properties (organization_id, reference_code, title, property_type, listing_type, status, price, area_value, locality)
      values ($1, 'AP-SOLD', 'Sold flat Worli', 'apartment', 'sale', 'sold', 1000000, 500, 'Worli') returning id`, [org]))[0].id;
    expect(await avail(manager, { lead, property: sold, assignee: agent })).toMatchObject({ status: 'invalid', reasons: ['property_not_active'] });
    expect(await avail(manager, { lead, property: null, assignee: agent })).toMatchObject({ status: 'invalid', reasons: ['property_required'] });
    expect((await t.fails(manager, `select public.appointment_availability($1, 'viewing', $2, $3, null, null, '15:00'::time, '14:00'::time)`, [lead, prop, agent])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(manager, `select public.appointment_availability($1, 'viewing', $2, $3)`, [lead, prop, ownerB])).detail).toBe('NOT_FOUND');
  });

  it('working windows follow the org time zone across DST (Europe/London)', async () => {
    const uk = await t.user('London Owner');
    const ukOrg = (await t.as<{ id: string }>(uk, `select public.create_organization('London Lettings', 'London', 'Europe/London') as id`))[0].id;
    const w = (d: string) => one<{ ws: Date }>(`select ws from private.ap_windows($1, null, $2::date)`, [ukOrg, d]).then((x) => x.ws.toISOString());
    expect(await w('2026-03-27')).toBe('2026-03-27T09:00:00.000Z'); // Fri 09:00 GMT
    expect(await w('2026-03-30')).toBe('2026-03-30T08:00:00.000Z'); // Mon 09:00 BST
  });
});

describe('booking, conflicts and lifecycle', () => {
  it('books once per key, rejects conflicts (staff, buffer, property), enforces notice, and allows legitimate parallel bookings', async () => {
    const at = when(6, 16);
    const k = key();
    const r = await book(manager, { lead, at, key: k });
    expect(r).toMatchObject({ status: 'confirmed', version: 1, calendar_sync_status: 'not_required' });
    expect(r.booking_reference).toMatch(/^APT-[0-9A-F]{8}$/);
    expect(await book(manager, { lead, at, key: k })).toMatchObject({ appointment_id: r.appointment_id, replayed: true });
    expect(await rows(`select 1 from public.appointments where idempotency_key = $1`, [k])).toHaveLength(1);
    expect((await t.fails(manager, `select public.appointment_book($1, 'consultation', $2, $3, $4)`, [lead, new Date(at.getTime() + 50 * 60e3), agent, key()])).detail).toBe('APPOINTMENT_CONFLICT'); // buffer
    expect((await t.fails(manager, `select public.appointment_book($1, 'viewing', $2, $3, $4, $5)`, [lead, at, agent2, key(), prop])).detail).toBe('PROPERTY_BOOKED');
    expect((await book(manager, { lead, at, assignee: agent2, property: prop2 })).status).toBe('confirmed'); // other person, other property
    expect((await t.fails(manager, `select public.appointment_book($1, 'viewing', $2, $3, $4, $5)`, [lead, new Date(Date.now() + 10 * 60e3), agent, key(), prop])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(manager, `select public.appointment_book($1, 'viewing', $2, $3, $4, null)`, [lead, when(6, 17), agent, key()])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(viewer, `select public.appointment_book($1, 'consultation', $2, $3, $4)`, [lead, when(6, 18), agent, key()])).detail).toBe('FORBIDDEN');

    const h = await rows<R>(`select action, version, to_status from public.appointment_history where appointment_id = $1`, [r.appointment_id]);
    expect(h).toEqual([{ action: 'created', version: 1, to_status: 'confirmed' }]);
    const ev = await rows<R>(`select payload from public.outbox_events where record_id = $1 and event_type = 'appointment.confirmed'`, [r.appointment_id]);
    expect(ev).toHaveLength(1);
    expect(Object.keys(ev[0].payload).sort()).toEqual(['appointment_id', 'correlation_id', 'event_type', 'lead_id', 'occurred_at', 'organization_id', 'property_id', 'schema_version', 'status', 'version']);
  });

  it('AI / service bookings stay pending until a person confirms the current version', async () => {
    const r = await book(null, { lead, at: when(7, 10), type: 'consultation', property: null });
    expect(r).toMatchObject({ status: 'pending', pending_reason: 'needs_staff_confirmation' });
    expect((await appt(r.appointment_id)).source).toBe('ai');
    expect(await rows(`select 1 from public.outbox_events where record_id = $1 and event_type = 'appointment.confirmed'`, [r.appointment_id])).toHaveLength(0);
    expect((await t.fails(manager, `select public.appointment_confirm($1, 9)`, [r.appointment_id])).detail).toBe('CONFLICT');
    const c = await t.as<{ r: R }>(manager, `select public.appointment_confirm($1, 1) r`, [r.appointment_id]);
    expect(c[0].r).toMatchObject({ status: 'confirmed', version: 2 });
    expect(await appt(r.appointment_id)).toMatchObject({ confirmed_by: manager, pending_reason: null });
  });

  it('state machine: closed appointments cannot reopen; cancel is idempotent and needs a reason', async () => {
    const r = await book(manager, { lead, at: when(8, 12), type: 'consultation', property: null });
    expect((await t.fails(manager, `select public.appointment_cancel($1, 'x')`, [r.appointment_id])).detail).toBe('VALIDATION_ERROR');
    expect((await t.as<{ r: R }>(manager, `select public.appointment_cancel($1, 'Customer cancelled') r`, [r.appointment_id]))[0].r).toMatchObject({ status: 'cancelled', version: 2 });
    expect((await t.as<{ r: R }>(manager, `select public.appointment_cancel($1, 'Customer cancelled') r`, [r.appointment_id]))[0].r).toMatchObject({ status: 'cancelled', replayed: true });
    expect((await t.fails(manager, `update public.appointments set status = 'confirmed' where id = $1`, [r.appointment_id])).detail).toBe('INVALID_TRANSITION');
    expect((await t.fails(manager, `select public.appointment_reschedule($1, $2, 2)`, [r.appointment_id, when(8, 13)])).detail).toBe('INVALID_TRANSITION');
    expect(await rows(`select 1 from public.outbox_events where record_id = $1 and event_type = 'appointment.cancelled'`, [r.appointment_id])).toHaveLength(1);
    // The cancelled slot is free again.
    expect((await book(manager, { lead, at: when(8, 12), type: 'consultation', property: null })).status).toBe('confirmed');
  });

  it('reschedule moves atomically: a conflicting target keeps the original; stale versions are refused; history keeps both times', async () => {
    const r = await book(manager, { lead, at: when(9, 10), type: 'consultation', property: null });
    const blocker = await book(manager, { lead, at: when(9, 14), type: 'consultation', property: null });
    expect((await t.fails(manager, `select public.appointment_reschedule($1, $2, 1)`, [r.appointment_id, when(9, 14)])).detail).toBe('APPOINTMENT_CONFLICT');
    expect(new Date((await appt(r.appointment_id)).starts_at).getTime()).toBe(when(9, 10).getTime());
    expect((await t.fails(manager, `select public.appointment_reschedule($1, $2, 7)`, [r.appointment_id, when(9, 16)])).detail).toBe('CONFLICT');
    const m = await t.as<{ r: R }>(manager, `select public.appointment_reschedule($1, $2, 1, 'Customer asked for later') r`, [r.appointment_id, when(9, 16)]);
    expect(m[0].r).toMatchObject({ status: 'confirmed', version: 2 });
    const h = await rows<R>(`select action, from_starts_at, to_starts_at, reason from public.appointment_history where appointment_id = $1 order by version`, [r.appointment_id]);
    expect(h[1]).toMatchObject({ action: 'rescheduled', reason: 'Customer asked for later' });
    expect(new Date(h[1].from_starts_at).getTime()).toBe(when(9, 10).getTime());
    expect(await rows(`select 1 from public.outbox_events where record_id = $1 and event_type = 'appointment.rescheduled'`, [r.appointment_id])).toHaveLength(1);
    expect(blocker.status).toBe('confirmed');
  });
});

describe('Agent 05: confirmations, reminders and cancellations', () => {
  it('confirmation message references the booking; a reschedule cancels the stale one; a reminder is due-gated; cancellation notifies only the informed', async () => {
    const r = await book(manager, { lead, at: when(1, 11), type: 'viewing' });
    await ftick();
    const conf = await one(`select * from public.follow_ups where appointment_id = $1 and purpose = 'appointment_confirmation'`, [r.appointment_id]);
    expect(conf).toMatchObject({ status: 'pending_approval', channel: 'whatsapp', appointment_version: 1, draft_status: 'not_requested' });
    expect(conf.body).toContain(`Your property viewing of Sea view 2 BHK Worli is booked for`);
    expect(conf.body).toContain(`(Asia/Kolkata)`);
    expect(conf.body).toContain(`Reference: ${r.booking_reference}`);

    await t.as(manager, `select public.appointment_reschedule($1, $2, 1)`, [r.appointment_id, when(1, 15)]);
    expect((await one(`select status, status_reason from public.follow_ups where id = $1`, [conf.id]))).toEqual({ status: 'cancelled', status_reason: 'Appointment changed (now version 2)' });
    await ftick();
    const conf2 = await one(`select * from public.follow_ups where appointment_id = $1 and purpose = 'appointment_confirmation' and appointment_version = 2`, [r.appointment_id]);
    expect(conf2.body).toContain('has been moved to');
    await t.as(manager, `select public.follow_up_decide($1, 'approve', $2)`, [conf2.id, conf2.content_version]);
    expect((await t.as<{ r: R }>(manager, `select public.follow_up_mark_sent($1, $2) r`, [conf2.id, conf2.content_version]))[0].r).toEqual({ status: 'sent' });

    // Reminder: created by the appointment tick, sendable only when due, and transactional (not blocked by the min gap).
    await t.as(owner, `select public.scheduling_settings_save($1, '{"reminder_hours_before": 168}'::jsonb)`, [org]);
    await t.asService(`select public.appointment_tick(50)`);
    await ftick();
    const rem = await one(`select * from public.follow_ups where appointment_id = $1 and purpose = 'appointment_reminder'`, [r.appointment_id]);
    expect(rem).toMatchObject({ status: 'pending_approval', appointment_version: 2 });
    await t.as(manager, `select public.follow_up_decide($1, 'approve', $2)`, [rem.id, rem.content_version]);
    await t.db.query(`update public.follow_ups set scheduled_for = now() + interval '3 hours' where id = $1`, [rem.id]);
    expect((await t.fails(manager, `select public.follow_up_mark_sent($1, $2)`, [rem.id, rem.content_version])).message).toMatch(/Reminder not due yet/);
    await t.db.query(`update public.follow_ups set scheduled_for = now() - interval '1 minute' where id = $1`, [rem.id]);

    // Cancel: the unsent reminder is cancelled at once; a cancellation notice is drafted because a confirmation was sent.
    await t.as(manager, `select public.appointment_cancel($1, 'Customer cancelled')`, [r.appointment_id]);
    expect((await one(`select status from public.follow_ups where id = $1`, [rem.id])).status).toBe('cancelled');
    expect((await t.fails(manager, `select public.follow_up_mark_sent($1, $2)`, [rem.id, rem.content_version])).detail).toBe('CONFLICT');
    await ftick();
    const canc = await one(`select * from public.follow_ups where appointment_id = $1 and purpose = 'appointment_cancellation'`, [r.appointment_id]);
    expect(canc.body).toContain('has been cancelled');
    await t.as(owner, `select public.scheduling_settings_save($1, '{}'::jsonb)`, [org]);

    // Never confirmed to the customer → no cancellation notice.
    const r2 = await book(manager, { lead, at: when(10, 17), type: 'consultation', property: null });
    await ftick();
    await t.as(manager, `select public.appointment_cancel($1, 'Agent unavailable')`, [r2.appointment_id]);
    await ftick();
    expect(await rows(`select 1 from public.follow_ups where appointment_id = $1 and purpose = 'appointment_cancellation'`, [r2.appointment_id])).toHaveLength(0);
  });
});

describe('calendar boundary (mock provider row, no adapter)', () => {
  it('unverified calendars hide slots; busy import blocks time; sync outcomes, stale results, required sync and lease expiry', async () => {
    await t.db.query(`insert into public.integrations (organization_id, provider, integration_type, display_name, status) values ($1, 'mockcal', 'calendar', 'Mock calendar', 'connected')`, [org]);
    const day = when(11, 9);
    expect(await avail(manager, { lead, type: 'consultation', property: null, assignee: agent, from: localDate(day), to: localDate(day) }))
      .toMatchObject({ status: 'unverified', slots: [], unverified_staff: 1, calendar_provider: 'mockcal' });
    // Unverified booking → requested + review task; confirming is refused until the calendar syncs.
    const u = await book(manager, { lead, at: when(11, 10), type: 'consultation', property: null });
    expect(u).toMatchObject({ status: 'requested', pending_reason: 'calendar_unverified', calendar_sync_status: 'pending' });
    expect(await rows(`select 1 from public.tasks where title like 'Confirm availability:%' and assigned_to = $1`, [agent])).toHaveLength(1);
    expect((await t.fails(manager, `select public.appointment_confirm($1, 1)`, [u.appointment_id])).detail).toBe('CALENDAR_UNVERIFIED');

    await t.asService(`select public.calendar_busy_replace($1, $2, 'mockcal', true, $3::jsonb)`, [org, agent, JSON.stringify([{ starts_at: when(11, 14), ends_at: when(11, 15) }])]);
    const v = await avail(manager, { lead, type: 'consultation', property: null, assignee: agent, from: localDate(day), to: localDate(day) });
    expect(v.status).toBe('ok');
    expect(v.slots.map((s: R) => new Date(s.starts_at).getTime())).not.toContain(when(11, 14).getTime());

    // Sync: claim → synced.
    const b = await book(manager, { lead, at: when(11, 16), type: 'consultation', property: null });
    expect(b).toMatchObject({ status: 'confirmed', calendar_sync_status: 'pending' });
    let jobs = await t.asService<R>(`select * from public.calendar_sync_claim(20)`);
    const job = jobs.find((j) => j.appointment_id === b.appointment_id)!;
    expect(job).toMatchObject({ action: 'create', provider: 'mockcal', version: 1 });
    expect((await t.asService<R>(`select public.calendar_sync_result($1, 1, 'synced', 'evt_123', null) r`, [b.appointment_id]))[0].r).toBe('synced');
    expect(await appt(b.appointment_id)).toMatchObject({ calendar_sync_status: 'synced', external_event_id: 'evt_123', calendar_synced_version: 1 });

    // Stale result: the appointment changed while the job was in flight.
    await t.as(manager, `select public.appointment_reschedule($1, $2, 1)`, [b.appointment_id, when(11, 17)]);
    jobs = await t.asService<R>(`select * from public.calendar_sync_claim(20)`);
    expect(jobs.find((j) => j.appointment_id === b.appointment_id)).toMatchObject({ action: 'update', external_event_id: 'evt_123', version: 2 });
    await t.as(manager, `select public.appointment_reschedule($1, $2, 2)`, [b.appointment_id, when(11, 18)]);
    expect(await appt(b.appointment_id)).toMatchObject({ calendar_sync_status: 'pending', version: 3 });

    // Ambiguous → failed + task (never re-created blindly); lease expiry → failed.
    jobs = await t.asService<R>(`select * from public.calendar_sync_claim(20)`);
    expect((await t.asService<R>(`select public.calendar_sync_result($1, 3, 'ambiguous', null, 'timeout') r`, [b.appointment_id]))[0].r).toBe('failed');
    expect(await rows(`select 1 from public.tasks where title like 'Calendar sync failed:%'`)).toHaveLength(1);
    expect(await rows(`select 1 from public.outbox_events where record_id = $1 and event_type = 'appointment.calendar_sync_failed'`, [b.appointment_id])).toHaveLength(1);

    // Required sync: confirmation waits for the calendar, then the sync confirms it.
    await t.as(owner, `select public.scheduling_settings_save($1, '{"require_calendar_sync": true}'::jsonb)`, [org]);
    const q = await book(manager, { lead, at: when(13, 15), type: 'consultation', property: null });
    expect(q).toMatchObject({ status: 'pending', pending_reason: 'awaiting_calendar_sync' });
    await t.asService(`select * from public.calendar_sync_claim(20)`);
    await t.asService(`select public.calendar_sync_result($1, 1, 'synced', 'evt_q', null)`, [q.appointment_id]);
    expect(await appt(q.appointment_id)).toMatchObject({ status: 'confirmed', pending_reason: null, calendar_sync_status: 'synced' });
    expect(await rows(`select 1 from public.outbox_events where record_id = $1 and event_type = 'appointment.confirmed'`, [q.appointment_id])).toHaveLength(1);

    const s = await book(manager, { lead, at: when(12, 12), type: 'consultation', property: null, assignee: agent });
    await t.as(owner, `select public.scheduling_settings_save($1, '{}'::jsonb)`, [org]);
    await t.asService(`select * from public.calendar_sync_claim(20)`);
    await t.db.query(`update public.appointments set calendar_lease_until = now() - interval '1 minute' where id = $1`, [s.appointment_id]);
    await t.asService(`select public.appointment_tick(50)`);
    expect((await appt(s.appointment_id)).calendar_sync_status).toBe('failed');
    await t.db.query(`delete from public.integrations where organization_id = $1 and provider = 'mockcal'`, [org]);
  });
});

describe('settings, tenant isolation and privileges', () => {
  it('settings and availability rules are validated and permissioned', async () => {
    for (const bad of ['{"buffer_minutes": -5}', '{"slot_step_minutes": 7}', '{"durations": {"viewing": 999}}', '{"hack": 1}']) {
      expect((await t.fails(owner, `select public.scheduling_settings_save($1, $2::jsonb)`, [org, bad])).detail).toBe('VALIDATION_ERROR');
    }
    expect((await t.fails(agent, `select public.scheduling_settings_save($1, '{}'::jsonb)`, [org])).detail).toBe('FORBIDDEN');
    expect((await t.fails(agent, `select public.staff_working_hours_save($1, $2, '[]'::jsonb)`, [org, agent2])).detail).toBe('FORBIDDEN');
    expect((await t.fails(agent, `select public.availability_block_add($1, 'closure', now() + interval '1 day', now() + interval '2 days')`, [org])).detail).toBe('FORBIDDEN');
    expect((await t.fails(agent, `select public.availability_block_add($1, 'time_off', now() + interval '1 day', now() + interval '2 days', $2)`, [org, agent2])).detail).toBe('FORBIDDEN');
    expect((await t.fails(owner, `select public.staff_working_hours_save($1, $2, '[{"weekday": 1, "start": "18:00", "end": "09:00"}]'::jsonb)`, [org, agent])).detail).toBe('VALIDATION_ERROR');
    await t.asService(`select public.calendar_busy_replace($1, $2, 'mockcal', true, $3::jsonb)`, [org, agent2, JSON.stringify([{ starts_at: when(13, 9), ends_at: when(13, 10) }])]);
    const busy = (await one(`select id from public.availability_blocks where kind = 'external_busy' and user_id = $1`, [agent2])).id;
    expect((await t.fails(owner, `select public.availability_block_remove($1)`, [busy])).detail).toBe('FORBIDDEN');
  });

  it('another org cannot see, book, change or configure; users cannot write rows or call service functions', async () => {
    const r = await book(manager, { lead, at: when(14, 11), type: 'consultation', property: null });
    expect((await t.fails(ownerB, `select public.appointment_availability($1, 'consultation')`, [lead])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.appointment_book($1, 'consultation', $2, $3, $4)`, [lead, when(14, 12), ownerB, key()])).detail).toBe('NOT_FOUND');
    expect((await t.fails(ownerB, `select public.appointment_book($1, 'consultation', $2, $3, $4)`, [leadB, when(14, 12), agent, key()])).detail).toBe('VALIDATION_ERROR');
    expect((await t.fails(ownerB, `select public.appointment_book($1, 'viewing', $2, $3, $4, $5)`, [leadB, when(14, 12), ownerB, key(), prop])).detail).toBe('NOT_FOUND');
    for (const sql of [`select public.appointment_cancel($1, 'cross tenant')`, `select public.appointment_detail($1)`, `select public.appointment_confirm($1, 1)`,
      `select public.appointment_reschedule($1, now() + interval '3 days', 1)`]) {
      expect((await t.fails(ownerB, sql, [r.appointment_id])).detail).toBe('NOT_FOUND');
    }
    expect(await t.as(ownerB, `select id from public.appointment_history where organization_id = $1`, [org])).toHaveLength(0);
    expect(await t.as(ownerB, `select 1 from public.availability_blocks where organization_id = $1`, [org])).toHaveLength(0);
    expect((await t.fails(ownerB, `select public.scheduling_settings_save($1, '{}'::jsonb)`, [org])).detail).toBe('FORBIDDEN');
    expect((await t.fails(ownerB, `select public.staff_working_hours_save($1, $2, '[]'::jsonb)`, [org, agent])).detail).toBe('FORBIDDEN');

    expect((await t.fails(owner, `insert into public.appointment_history (organization_id, appointment_id, version, action) values ($1, $2, 9, 'created')`, [org, r.appointment_id])).message).toMatch(/permission denied/);
    expect((await t.fails(owner, `insert into public.availability_blocks (organization_id, kind, starts_at, ends_at) values ($1, 'closure', now(), now() + interval '1 hour')`, [org])).message).toMatch(/permission denied/);
    for (const fn of [`public.appointment_tick(1)`, `public.calendar_sync_claim(1)`, `public.calendar_sync_result(gen_random_uuid(), 1, 'synced', 'x', null)`,
      `public.calendar_busy_replace(gen_random_uuid(), gen_random_uuid(), 'x', true, '[]'::jsonb)`, `public.calendar_sync_worker_secret_ok('x')`]) {
      expect((await t.fails(owner, `select ${fn}`)).message).toMatch(/permission denied/);
    }
    const d = await t.as<{ r: R }>(viewer, `select public.appointment_detail($1) r`, [r.appointment_id]);
    expect(d[0].r.can_edit).toBe(false);
    expect(d[0].r.appointment).not.toHaveProperty('idempotency_key');
  });
});
