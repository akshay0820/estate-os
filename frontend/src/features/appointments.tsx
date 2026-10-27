import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, List, MapPin, Plus, Sparkles, XCircle, CheckCircle2, UserX, AlertTriangle } from 'lucide-react';
import { Badge, Button, Card, Drawer, Empty, Field, Input, KV, Modal, PageHeader, Segmented, Select } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { LIVE, actions, attempt, ok } from '@/data/actions';
import * as live from '@/backend/live';
import { useCan, useLookup, useMe, useOrg, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { setParam, navigate } from '@/lib/router';
import { APPT_STATUS } from '@/lib/domain';
import { DAY, HOUR, MIN, fmtDate, fmtDateTime, fmtTime, sameDay, startOfDay, startOfWeek, toLocalInput, fromLocalInput, weekday } from '@/lib/format';
import { cx } from '@/lib/util';
import type { Appointment } from '@/store/types';
import { MemberChip, StatusBadge } from './shared';

const START_H = 8;
const END_H = 21;
const SLOT = 48; // px per hour

export function AppointmentsPage({ params }: { params: URLSearchParams }) {
  const appts = useOrgList('appointments');
  const members = useOrgList('members');
  const me = useMe();
  const canEdit = useCan('appointments.edit');
  const [view, setView] = useState<'week' | 'list'>('week');
  const [anchor, setAnchor] = useState(() => startOfWeek(Date.now()));
  useEffect(() => {
    if (LIVE) void attempt(() => live.ensureAppointmentRange(anchor - 7 * DAY, anchor + 14 * DAY));
  }, [anchor]);
  const [who, setWho] = useState<string>('');
  const [booking, setBooking] = useState<{ start?: number } | null>(params.get('new') === '1' ? {} : null);
  const openId = params.get('id');

  useEffect(() => {
    if (params.get('new') === '1') setBooking({});
  }, [params]);

  const filtered = useMemo(() => appts.filter((a) => !who || (who === 'me' ? a.assignedTo === me.id : a.assignedTo === who)), [appts, who, me.id]);
  const weekAppts = filtered.filter((a) => a.start >= anchor && a.start < anchor + 7 * DAY);
  const upcoming = filtered.filter((a) => a.start >= startOfDay(Date.now()) && !['cancelled', 'completed', 'no_show'].includes(a.status)).sort((a, b) => a.start - b.start);
  const today = filtered.filter((a) => sameDay(a.start, Date.now()) && a.status !== 'cancelled');
  const pending = filtered.filter((a) => ['requested', 'pending', 'reschedule_requested'].includes(a.status) && a.start > Date.now());

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${today.length} today · ${pending.length} awaiting confirmation ]`}
        title="Appointments"
        sub="Site visits and consultations. Availability is checked on booking and conflicts are rejected with alternatives."
        actions={
          <>
            <Select selectSize="sm" value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 170 }} aria-label="Filter by person">
              <option value="">Whole team</option>
              <option value="me">My calendar</option>
              {members.filter((m) => m.role === 'agent' && m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
            <Segmented value={view} onChange={setView} options={[{ value: 'week', label: <><CalendarDays size={14} /> Week</> }, { value: 'list', label: <><List size={14} /> Agenda</> }]} />
            {canEdit && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setBooking({})}>Book</Button>}
          </>
        }
      />

      {view === 'week' ? (
        <div className="card">
          <div className="toolbar">
            <Button size="sm" iconOnly icon={<ChevronLeft size={15} />} onClick={() => setAnchor((a) => a - 7 * DAY)} aria-label="Previous week" />
            <Button size="sm" onClick={() => setAnchor(startOfWeek(Date.now()))}>Today</Button>
            <Button size="sm" iconOnly icon={<ChevronRight size={15} />} onClick={() => setAnchor((a) => a + 7 * DAY)} aria-label="Next week" />
            <b style={{ marginLeft: 6 }}>{fmtDate(anchor)} – {fmtDate(anchor + 6 * DAY, true)}</b>
            <div className="ml-auto legend">
              <span><i style={{ background: 'var(--ember)' }} /> Confirmed</span>
              <span><i style={{ background: 'var(--sky)' }} /> Pending</span>
              <span><i style={{ background: 'var(--success)' }} /> Completed</span>
              <span><i style={{ background: 'var(--text-3)' }} /> Cancelled</span>
            </div>
          </div>
          <WeekGrid anchor={anchor} appts={weekAppts} onSlot={(t) => canEdit && setBooking({ start: t })} onOpen={(id) => setParam('id', id)} />
        </div>
      ) : (
        <div className="grid g-main-side">
          <Card title="Upcoming" sub={`${upcoming.length} scheduled`} flush>
            {upcoming.length === 0 && <Empty icon={<CalendarDays size={20} />} title="Nothing scheduled" description="Book a visit from a lead or from here." />}
            {groupByDay(upcoming).map(([day, list]) => (
              <div key={day}>
                <div className="menu-label" style={{ padding: '14px 18px 6px' }}>{sameDay(day, Date.now()) ? 'Today' : sameDay(day, Date.now() + DAY) ? 'Tomorrow' : `${weekday(day)}, ${fmtDate(day)}`}</div>
                {list.map((a) => <ApptRow key={a.id} a={a} />)}
              </div>
            ))}
          </Card>
          <Card title="Needs attention" sub="Unconfirmed or reschedule requests">
            {pending.length === 0 ? <span className="faint">All visits are confirmed.</span> : (
              <div className="stack stack-sm">
                {pending.map((a) => (
                  <button key={a.id} className="list-row card" style={{ boxShadow: 'none', padding: 10 }} onClick={() => setParam('id', a.id)}>
                    <div className="grow">
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{a.title}</div>
                      <div className="faint" style={{ fontSize: 12 }}>{fmtDateTime(a.start)}</div>
                    </div>
                    <StatusBadge map={APPT_STATUS} value={a.status} />
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {booking && <BookAppointmentModal onClose={() => { setBooking(null); if (params.get('new')) setParam('new', null); }} preset={{ start: booking.start }} />}
      {openId && <AppointmentDrawer id={openId} onClose={() => setParam('id', null)} />}
    </div>
  );
}

function groupByDay(list: Appointment[]): [number, Appointment[]][] {
  const m = new Map<number, Appointment[]>();
  list.forEach((a) => {
    const d = startOfDay(a.start);
    m.set(d, [...(m.get(d) ?? []), a]);
  });
  return [...m.entries()];
}

function ApptRow({ a }: { a: Appointment }) {
  const leads = useLookup('leads');
  return (
    <button className="list-row" onClick={() => setParam('id', a.id)}>
      <div className="mono" style={{ width: 64, fontSize: 12 }}>{fmtTime(a.start)}</div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="truncate" style={{ fontWeight: 500 }}>{a.title}</div>
        <div className="faint truncate" style={{ fontSize: 12 }}>{a.leadId ? leads.get(a.leadId)?.name : '—'} · {a.location}</div>
      </div>
      {a.source === 'ai' && <span className="badge badge-ai"><Sparkles size={10} /> AI</span>}
      <MemberChip id={a.assignedTo} showName={false} />
      <StatusBadge map={APPT_STATUS} value={a.status} />
    </button>
  );
}

function WeekGrid({ anchor, appts, onSlot, onOpen }: { anchor: number; appts: Appointment[]; onSlot: (t: number) => void; onOpen: (id: string) => void }) {
  const leads = useLookup('leads');
  const days = Array.from({ length: 7 }, (_, i) => anchor + i * DAY);
  const hours = Array.from({ length: END_H - START_H }, (_, i) => START_H + i);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  // Lay out overlapping events side by side.
  const layout = (list: Appointment[]) => {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    const cols: Appointment[][] = [];
    const pos = new Map<string, { col: number; cols: number }>();
    sorted.forEach((a) => {
      let c = cols.findIndex((col) => col[col.length - 1].end <= a.start);
      if (c === -1) { cols.push([a]); c = cols.length - 1; } else cols[c].push(a);
      pos.set(a.id, { col: c, cols: 0 });
    });
    pos.forEach((p) => (p.cols = cols.length));
    return pos;
  };
  return (
    <div style={{ maxHeight: 'calc(100vh - 260px)', overflow: 'auto' }}>
      <div className="cal" style={{ minWidth: 900 }}>
        <div className="cal-head" />
        {days.map((d) => (
          <div key={d} className={cx('cal-head', sameDay(d, now) && 'today')}>
            {weekday(d)}
            <b>{new Date(d).getDate()}</b>
          </div>
        ))}
        <div>
          {hours.map((h) => (
            <div key={h} className="cal-time" style={{ height: SLOT }}>
              {h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`}
            </div>
          ))}
        </div>
        {days.map((d) => {
          const list = appts.filter((a) => sameDay(a.start, d));
          const pos = layout(list);
          return (
            <div key={d} className="cal-day">
              {hours.map((h) => (
                <div key={h} className="cal-slot" onClick={() => onSlot(d + h * HOUR)} title={`Book at ${h}:00`} />
              ))}
              {list.map((a) => {
                const top = ((a.start - d) / HOUR - START_H) * SLOT;
                const height = Math.max(22, ((a.end - a.start) / HOUR) * SLOT - 2);
                const p = pos.get(a.id)!;
                const w = 100 / p.cols;
                return (
                  <button
                    key={a.id}
                    className={cx('cal-event', a.status)}
                    style={{ top, height, left: `calc(${p.col * w}% + 3px)`, width: `calc(${w}% - 6px)`, right: 'auto' }}
                    onClick={() => onOpen(a.id)}
                    title={`${a.title} · ${fmtTime(a.start)}`}
                  >
                    <b>{a.leadId ? leads.get(a.leadId)?.name ?? a.title : a.title}</b>
                    {height > 36 && <span className="faint">{fmtTime(a.start)} · {a.type}</span>}
                  </button>
                );
              })}
              {sameDay(d, now) && new Date(now).getHours() >= START_H && new Date(now).getHours() < END_H && (
                <div className="cal-now" style={{ top: ((now - d) / HOUR - START_H) * SLOT }} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─────────── Booking ─────────── */

export function BookAppointmentModal({ onClose, preset }: { onClose: () => void; preset?: { leadId?: string; propertyId?: string; start?: number } }) {
  const leads = useOrgList('leads');
  const properties = useOrgList('properties');
  const members = useOrgList('members');
  const org = useOrg();
  const [busy, setBusy] = useState(false);
  const presetLead = leads.find((l) => l.id === preset?.leadId);
  const defaultStart = preset?.start ?? (() => {
    const d = new Date(Date.now() + DAY);
    d.setHours(11, 0, 0, 0);
    return d.getTime();
  })();
  const [f, setF] = useState({
    leadId: preset?.leadId ?? '',
    propertyId: preset?.propertyId ?? '',
    type: 'viewing' as Appointment['type'],
    start: toLocalInput(defaultStart),
    duration: '45',
    assignedTo: presetLead?.assignedTo ?? members.find((m) => m.role === 'agent' && m.status === 'active')?.id ?? '',
    location: '',
    status: 'confirmed' as Appointment['status'],
  });
  const [conflict, setConflict] = useState<{ title: string; alternatives: number[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const lead = leads.find((l) => l.id === f.leadId);
  const prop = properties.find((p) => p.id === f.propertyId);
  const candidates = useMemo(() => leads.filter((l) => !l.archived && !['won', 'lost'].includes(l.status)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 200), [leads]);
  const [avail, setAvail] = useState<live.Availability | null>(null);
  const [finding, setFinding] = useState(false);
  const findSlots = async () => {
    setErr(null);
    setFinding(true);
    const day = f.start.slice(0, 10);
    const r = await attempt(() => live.appointmentAvailability({ leadId: lead?.id ?? null, type: f.type, propertyId: f.type === 'viewing' ? prop?.id ?? null : null,
      assigneeId: f.assignedTo || null, dateFrom: day, duration: Number(f.duration) }), (m) => setErr(m));
    setFinding(false);
    if (r) setAvail(r);
  };

  const submit = async (startOverride?: number) => {
    setErr(null);
    const start = startOverride ?? fromLocalInput(f.start);
    if (!Number.isFinite(start)) return setErr('Pick a date and time');
    if (start < Date.now() - 5 * MIN) return setErr('That time is in the past');
    const h = new Date(start).getHours();
    if (!LIVE && (h < org.businessHours.start || h >= org.businessHours.end)) return setErr(`Outside business hours (${org.businessHours.start}:00–${org.businessHours.end}:00)`);
    if (f.type === 'viewing' && prop && prop.status !== 'active') return setErr(`${prop.title} is ${prop.status.replace('_', ' ')} — not available for viewings`);
    const end = start + Number(f.duration) * MIN;
    setBusy(true);
    const res = await attempt(() => actions.bookAppointment({
      title: f.type === 'viewing' ? `Site visit — ${prop?.title.replace(/ at .*/, '') ?? 'property'}` : f.type === 'valuation' ? 'Property valuation' : f.type === 'consultation' ? 'Requirement consultation' : 'Follow-up meeting',
      type: f.type, status: f.status as 'requested' | 'pending' | 'confirmed', leadId: lead?.id ?? null, contactId: lead?.contactId ?? null, propertyId: prop?.id ?? null,
      assignedTo: f.assignedTo || null, start, end, location: f.location || (prop ? `${prop.title.split(' at ')[1] ?? prop.locality}, ${prop.locality}` : 'Office'),
    }), (m) => setErr(m));
    setBusy(false);
    if (!res) return;
    if (!res.ok) {
      setConflict({ title: res.conflictTitle, alternatives: res.alternatives });
      return;
    }
    const apptId = res.appointmentId;
    toast({ kind: 'success', title: 'Visit booked', body: LIVE ? `${fmtDateTime(start)} · the assignee has been notified` : `${fmtDateTime(start)} · confirmation queued after save`, action: { label: 'View', run: () => navigate('appointments', { id: apptId }) } });
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Book appointment"
      description="Availability is validated on save. Confirmation and reminders go out only after the booking is stored."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>Book</Button></>}
    >
      <div className="stack">
        {conflict && (
          <div className="banner warning" style={{ alignItems: 'flex-start' }}>
            <AlertTriangle size={16} style={{ marginTop: 2 }} />
            <div className="grow">
              <b>Conflict:</b> {members.find((m) => m.id === f.assignedTo)?.name} already has “{conflict.title}” then.
              {conflict.alternatives.length > 0 && (
                <div className="row wrap mt-8" style={{ gap: 6 }}>
                  <span style={{ fontSize: 12.5 }}>Free slots:</span>
                  {conflict.alternatives.map((t) => (
                    <Button key={t} size="xs" onClick={() => { setF({ ...f, start: toLocalInput(t) }); setConflict(null); void submit(t); }}>
                      {weekday(t)} {fmtTime(t)}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
        {LIVE && avail && (
          <div className="banner" style={{ display: 'block', fontSize: 12.5 }}>
            {avail.status === 'ok' && (
              <>
                <b>Available (verified):</b>
                <div className="row wrap mt-8" style={{ gap: 6 }}>
                  {avail.slots!.map((s) => (
                    <Button key={s.starts_at + s.assignee_id} size="xs" variant={s.preferred ? 'primary' : undefined}
                      onClick={() => { setF({ ...f, start: toLocalInput(new Date(s.starts_at).getTime()), assignedTo: s.assignee_id }); setAvail(null); setConflict(null); }}>
                      {s.local_label} · {s.assignee_name}
                    </Button>
                  ))}
                </div>
              </>
            )}
            {avail.status === 'no_slots' && <span>No free time in this period for these requirements. Try another day or person.</span>}
            {avail.status === 'unverified' && <span><AlertTriangle size={12} /> The connected calendar could not be verified, so no times are offered. Try again after it syncs.</span>}
            {avail.status === 'invalid' && <span>{(avail.reasons ?? []).includes('property_not_active') ? 'This property is not available for viewings.' : 'Choose the property to view first.'}</span>}
            <div className="faint mt-8">Times in {avail.timezone}{avail.buffer_minutes ? ` · ${avail.buffer_minutes} min buffer between visits` : ''}.</div>
          </div>
        )}
        <div className="form-grid">
          <Field label="Type">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Appointment['type'] })}>
              <option value="viewing">Site visit</option>
              <option value="consultation">Consultation</option>
              <option value="valuation">Valuation</option>
              <option value="follow_up">Follow-up</option>
            </Select>
          </Field>
          <Field label="Lead">
            <Select value={f.leadId} onChange={(e) => { const l = leads.find((x) => x.id === e.target.value); setF({ ...f, leadId: e.target.value, assignedTo: l?.assignedTo ?? f.assignedTo }); }}>
              <option value="">No lead (internal)</option>
              {presetLead && !candidates.includes(presetLead) && <option value={presetLead.id}>{presetLead.name}</option>}
              {candidates.map((l) => <option key={l.id} value={l.id}>{l.name} — {l.locations[0] ?? l.source}</option>)}
            </Select>
          </Field>
          {f.type === 'viewing' && (
            <Field label="Property" className="full">
              <Select value={f.propertyId} onChange={(e) => setF({ ...f, propertyId: e.target.value })}>
                <option value="">Choose a property</option>
                {properties.filter((p) => p.status === 'active' || p.id === f.propertyId).map((p) => <option key={p.id} value={p.id}>{p.ref} · {p.title} · {p.locality}{!p.verified ? ' (unverified)' : ''}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Date & time"><Input type="datetime-local" value={f.start} onChange={(e) => { setF({ ...f, start: e.target.value }); setConflict(null); }} /></Field>
          <Field label="Duration">
            <Select value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })}>
              {['30', '45', '60', '90'].map((d) => <option key={d} value={d}>{d} min</option>)}
            </Select>
          </Field>
          <Field label="With">
            <Select value={f.assignedTo} onChange={(e) => { setF({ ...f, assignedTo: e.target.value }); setConflict(null); }}>
              {members.filter((m) => m.status === 'active' && ['agent', 'manager', 'owner'].includes(m.role)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          {!LIVE && (
            <Field label="Status">
              <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Appointment['status'] })}>
                <option value="confirmed">Confirmed with customer</option>
                <option value="pending">Pending confirmation</option>
                <option value="requested">Requested</option>
              </Select>
            </Field>
          )}
          <Field label="Location" className="full" hint="Defaults to the property address"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder={prop ? `${prop.locality}` : 'Office, video link or address'} /></Field>
        </div>
        {LIVE && <Button size="sm" icon={<CalendarClock size={14} />} loading={finding} onClick={() => void findSlots()}>Find available times on this day</Button>}
        <p className="faint" style={{ fontSize: 12 }}>Times shown in {org.timezone}.{LIVE ? ' The server re-checks the time when you book; a booking you make is confirmed with the customer.' : ''}</p>
      </div>
    </Modal>
  );
}

function AppointmentDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const a = useOrgList('appointments').find((x) => x.id === id);
  const leads = useLookup('leads');
  const props = useLookup('properties');
  const canEdit = useCan('appointments.edit');
  const setAppointmentStatus = (id: string, status: 'confirmed' | 'completed' | 'cancelled' | 'no_show', extra?: { reason?: string; feedback?: string }) => ok(() => actions.setAppointmentStatus(id, status, extra));
  const [resched, setResched] = useState(false);
  const [newStart, setNewStart] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!a) return null;
  const lead = a.leadId ? leads.get(a.leadId) : undefined;
  const prop = a.propertyId ? props.get(a.propertyId) : undefined;
  const open = ['requested', 'pending', 'confirmed', 'reschedule_requested'].includes(a.status);
  const past = a.start < Date.now();

  const doCancel = async () => {
    const r = await confirm({ title: 'Cancel this appointment?', body: 'Pending reminders are cancelled. The customer gets a cancellation message only if consent allows.', reasons: ['Customer cancelled', 'Property unavailable', 'Agent unavailable', 'Rescheduling', 'Other'], confirmLabel: 'Cancel appointment', danger: true });
    if (!r.ok) return;
    if (await setAppointmentStatus(a.id, 'cancelled', { reason: r.value })) toast({ kind: 'info', title: 'Appointment cancelled', body: r.value });
  };
  const complete = async () => {
    const r = await confirm({ title: 'Mark visit completed', input: { label: 'Feedback (optional)', placeholder: 'How did it go?', multiline: true }, confirmLabel: 'Complete' });
    if (!r.ok) return;
    if (await setAppointmentStatus(a.id, 'completed', { feedback: r.value || undefined }))
      toast({ kind: 'success', title: 'Visit completed', body: LIVE ? 'The lead moved to “Visit completed”.' : 'Post-visit feedback workflow started.' });
  };

  return (
    <Drawer
      open
      onClose={onClose}
      label="Appointment"
      header={
        <div>
          <div className="row" style={{ gap: 8 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600 }}>{a.title}</h2>
            {a.source === 'ai' && <span className="badge badge-ai"><Sparkles size={10} /> Booked by AI</span>}
          </div>
          <div className="row mt-8"><StatusBadge map={APPT_STATUS} value={a.status} /><span className="faint">{fmtDateTime(a.start)} – {fmtTime(a.end)}</span></div>
        </div>
      }
      footer={
        canEdit && open ? (
          <>
            {!resched && <Button icon={<CalendarClock size={15} />} onClick={() => { setResched(true); setNewStart(toLocalInput(a.start + DAY)); }}>Reschedule</Button>}
            <Button variant="danger" icon={<XCircle size={15} />} onClick={doCancel}>Cancel</Button>
            {past && <Button icon={<UserX size={15} />} onClick={async () => { if (await setAppointmentStatus(a.id, 'no_show')) toast({ kind: 'warning', title: 'Marked no-show' }); }}>No-show</Button>}
            {a.status !== 'confirmed' && !past && <Button variant="primary" onClick={async () => { if (await setAppointmentStatus(a.id, 'confirmed')) toast({ kind: 'success', title: 'Confirmed' }); }}>Confirm</Button>}
            {past && <Button variant="primary" icon={<CheckCircle2 size={15} />} onClick={complete}>Complete</Button>}
          </>
        ) : undefined
      }
    >
      <div className="stack stack-lg">
        {resched && (
          <Card title="Reschedule" style={{ boxShadow: 'none' }}>
            <div className="stack">
              {err && <div className="banner danger">{err}</div>}
              <Input type="datetime-local" value={newStart} onChange={(e) => { setNewStart(e.target.value); setErr(null); }} />
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <Button onClick={() => setResched(false)}>Back</Button>
                <Button variant="primary" onClick={async () => {
                  const s = fromLocalInput(newStart);
                  if (!Number.isFinite(s) || s < Date.now()) return setErr('Choose a future time');
                  const r = await attempt(() => actions.rescheduleAppointment(a.id, s, s + (a.end - a.start)), (m) => setErr(m));
                  if (!r) return;
                  if (!r.ok) return setErr(`Conflicts with “${r.conflictTitle ?? 'another appointment'}”`);
                  toast({ kind: 'success', title: 'Rescheduled', body: fmtDateTime(s) });
                  setResched(false);
                }}>Save</Button>
              </div>
            </div>
          </Card>
        )}
        <KV items={[
          ['Lead', lead ? <button className="link" onClick={() => navigate('leads', { id: lead.id })}>{lead.name}</button> : <span className="faint">Internal</span>],
          ['Property', prop ? <button className="link" onClick={() => navigate('properties', { id: prop.id })}>{prop.title}</button> : <span className="faint">—</span>],
          ['With', <MemberChip key="m" id={a.assignedTo} />],
          ['Where', <span key="w" className="row"><MapPin size={13} className="faint" />{a.location}</span>],
          ['Type', <span key="t" style={{ textTransform: 'capitalize' }}>{a.type.replace('_', ' ')}</span>],
          ['Booked', fmtDateTime(a.createdAt)],
        ]} />
        {prop && !prop.verified && <div className="banner warning">Availability for this property hasn't been verified recently — confirm with the owner before the visit.</div>}
        {a.cancelReason && <div className="banner">Cancelled: {a.cancelReason}</div>}
        {a.feedback && (
          <section>
            <h4 className="section-title">Visit feedback</h4>
            <div className="tl-body" style={{ marginTop: 0 }}>{a.feedback}</div>
          </section>
        )}
        {LIVE ? <LiveAppointmentState id={a.id} key={`${a.id}:${a.status}:${a.start}`} /> : (
          <section>
            <h4 className="section-title">Automations</h4>
            <div className="faint" style={{ fontSize: 13 }}>
              {open ? 'Confirmation sent on booking. Reminders at T-24h and T-2h via the reminder workflow — cancelled automatically if this is cancelled or rescheduled.' : 'No pending automations.'}
            </div>
          </section>
        )}
        {a.status === 'completed' && <Badge tone="success">Lead moved to “Visit completed”</Badge>}
      </div>
    </Drawer>
  );
}

const SYNC_LABEL: Record<string, string> = {
  not_required: 'No calendar connected — this record is the source of truth', pending: 'Waiting to sync to the calendar', processing: 'Syncing to the calendar…',
  synced: 'In the connected calendar', failed: 'Calendar sync failed — see Tasks',
};
const PENDING_LABEL: Record<string, string> = {
  needs_staff_confirmation: 'Requested by the AI — a person must confirm it', calendar_unverified: 'The calendar could not be verified — check it, then confirm',
  awaiting_calendar_sync: 'Will be confirmed once the calendar has the event',
};
const MSG_LABEL: Record<string, string> = { appointment_confirmation: 'Confirmation', appointment_reminder: 'Reminder', appointment_cancellation: 'Cancellation notice' };

/** Agent 06 — authoritative booking state from the server: reference, calendar sync, customer messages (Agent 05), history. */
function LiveAppointmentState({ id }: { id: string }) {
  const [d, setD] = useState<live.AppointmentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void attempt(() => live.appointmentDetail(id), (m) => setError(m)).then((r) => r && setD(r)); }, [id]);
  if (error) return <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load booking details. {error}</p>;
  if (!d) return <div className="skeleton" style={{ height: 80 }} />;
  const ap = d.appointment;
  return (
    <>
      <section>
        <h4 className="section-title">Booking</h4>
        <KV items={[
          ['Reference', <span key="r" className="mono">{ap.booking_reference}</span>],
          ['Time zone', ap.timezone],
          ['Calendar', <span key="c">{SYNC_LABEL[ap.calendar_sync_status] ?? ap.calendar_sync_status}{ap.calendar_sync_error ? ` (${ap.calendar_sync_error})` : ''}</span>],
          ['Version', String(ap.version)],
        ]} />
        {ap.pending_reason && <div className="banner warning mt-8" style={{ fontSize: 12.5 }}><AlertTriangle size={14} /> {PENDING_LABEL[ap.pending_reason] ?? ap.pending_reason}</div>}
      </section>
      <section>
        <h4 className="section-title">Customer messages</h4>
        {d.messages.length === 0 ? <p className="faint" style={{ fontSize: 12.5 }}>None yet. Confirmations and reminders are drafted by the Follow-Up Agent when consent allows; a person approves and sends them from the lead's Calls &amp; messages tab.</p> : (
          <div className="stack stack-sm">
            {d.messages.map((m) => (
              <div key={m.id} className="row" style={{ gap: 8, fontSize: 12.5 }}>
                <b style={{ width: 130 }}>{MSG_LABEL[m.purpose] ?? m.purpose}</b>
                <Badge tone={m.status === 'sent' ? 'success' : ['cancelled', 'suppressed', 'expired'].includes(m.status) ? 'neutral' : 'warning'}>{m.status.replace(/_/g, ' ')}</Badge>
                <span className="faint">v{m.appointment_version}{m.sent_via === 'manual' ? ' · sent by a person' : ''}{m.status_reason && m.status !== 'sent' ? ` · ${m.status_reason}` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section>
        <h4 className="section-title">History</h4>
        <div className="stack stack-sm">
          {d.history.map((h) => (
            <div key={`${h.version}-${h.created_at}`} className="faint" style={{ fontSize: 12.5 }}>
              v{h.version} · {h.action === 'rescheduled' && h.from_starts_at && h.to_starts_at
                ? `moved ${fmtDateTime(new Date(h.from_starts_at).getTime())} → ${fmtDateTime(new Date(h.to_starts_at).getTime())}`
                : h.action === 'created' ? `created as ${h.to_status}` : `${h.from_status?.replace('_', ' ') ?? ''} → ${h.to_status?.replace('_', ' ')}`}
              {h.reason ? ` · ${h.reason}` : ''} · {fmtDateTime(new Date(h.created_at).getTime())}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
