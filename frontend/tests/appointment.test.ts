import { describe, expect, it } from 'vitest';
import { buildSchedulingContent, localToday, validateInterpretation } from '../../supabase/functions/_shared/scheduling-assistant';
import { type CalendarAdapter, type CalendarJob, syncJob } from '../../supabase/functions/_shared/calendar-sync';

const base = { appointment_type: 'viewing', date_from: '2026-11-02', date_to: '2026-11-02', window_start: '13:00', window_end: '17:00',
  duration_minutes: 45, needs_clarification: false, clarification_question: null, summary: 'Afternoon viewing on Monday.' };

describe('scheduling assistant output validation', () => {
  it('accepts a grounded interpretation inside the horizon', () => {
    expect(validateInterpretation(base, '2026-10-26', 60)).toEqual({ ok: true, value: base });
  });

  it('rejects past, impossible or out-of-horizon dates, bad windows, bad ranges and unknown fields', () => {
    const bad = (o: Record<string, unknown>, today = '2026-10-26') => (validateInterpretation({ ...base, ...o }, today, 60) as { reason: string }).reason;
    expect(bad({ date_from: '2026-10-20', date_to: '2026-10-20' })).toBe('date_in_past');
    expect(bad({ date_from: '2026-02-30', date_to: '2026-02-30' }, '2026-01-01')).toBe('invalid_date');
    expect(bad({ date_from: '2027-03-01', date_to: '2027-03-01' })).toBe('beyond_horizon');
    expect(bad({ date_to: '2026-11-30' })).toBe('invalid_range');
    expect(bad({ window_start: '17:00', window_end: '13:00' })).toBe('invalid_window');
    expect(bad({ window_end: null })).toBe('invalid_window');
    expect(bad({ needs_clarification: true })).toBe('missing_question');
    expect(bad({ duration_minutes: 600 })).toBe('schema');
    expect(validateInterpretation({ ...base, free_slots: ['2026-11-02T10:00'] }, '2026-10-26', 60).ok).toBe(false);
  });

  it('resolves "today" in the org time zone with Intl (not the server clock), across the date line', () => {
    const at = new Date('2026-10-25T20:00:00Z'); // 01:30 on the 26th in India, still the 25th in New York
    expect(localToday('Asia/Kolkata', at)).toEqual({ today: '2026-10-26', weekday: 'Monday', timezone: 'Asia/Kolkata' });
    expect(localToday('America/New_York', at).today).toBe('2026-10-25');
    expect(() => localToday('Mars/Olympus')).toThrow();
    expect(buildSchedulingContent('tomorrow 4pm', { today: '2026-10-26', weekday: 'Monday', timezone: 'Asia/Kolkata' })).toContain('<request>');
  });
});

describe('calendar sync classification (mock adapters)', () => {
  const job: CalendarJob = { appointment_id: 'a1', version: 2, provider: 'mockcal', action: 'create', external_event_id: null, starts_at: '2026-11-02T05:30:00Z',
    ends_at: '2026-11-02T06:15:00Z', timezone: 'Asia/Kolkata', title: 'Site visit', location: 'Worli', assignee_email: 'a@example.com' };
  const adapter = (apply: CalendarAdapter['apply']): CalendarAdapter => ({ name: 'mock', apply });

  it('no adapter → unsupported, never synced', async () => {
    expect((await syncJob(job, undefined)).outcome).toBe('unsupported');
  });

  it('maps ok / transient / permanent / unknown; update without an event id is permanent', async () => {
    expect(await syncJob(job, adapter(async () => ({ kind: 'ok', eventId: 'evt_1' })))).toEqual({ outcome: 'synced', eventId: 'evt_1' });
    expect((await syncJob(job, adapter(async () => ({ kind: 'rejected', permanent: false, error: '503' })))).outcome).toBe('transient');
    expect((await syncJob(job, adapter(async () => ({ kind: 'rejected', permanent: true, error: '403 revoked' })))).outcome).toBe('permanent');
    expect((await syncJob(job, adapter(async () => ({ kind: 'unknown', error: 'reset after send' })))).outcome).toBe('ambiguous');
    expect((await syncJob(job, adapter(async () => ({ kind: 'ok', eventId: '' })))).outcome).toBe('ambiguous');
    expect((await syncJob({ ...job, action: 'update' }, adapter(async () => ({ kind: 'ok', eventId: 'x' })))).outcome).toBe('permanent');
  });

  it('a timeout or thrown error is ambiguous', async () => {
    const hang = adapter((_j, signal) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))));
    expect(await syncJob(job, hang, 20)).toEqual({ outcome: 'ambiguous', error: 'timeout' });
    expect((await syncJob(job, adapter(async () => { throw new Error('ECONNRESET'); }))).outcome).toBe('ambiguous');
  });
});
