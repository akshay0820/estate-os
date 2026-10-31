// Demo automations (lib/automationsDemo.ts): the same schedule and settings rules as migration 0029.
import { describe, expect, it } from 'vitest';
import { nextRun, settingsFor } from '@/lib/automationRules';

describe('demo automation schedule', () => {
  const mon9 = new Date(2026, 10, 2, 9, 0).getTime(); // Monday 09:00 local

  it('runs later today when the time has not passed, otherwise on the next chosen day', () => {
    expect(new Date(nextRun('10:00', [1, 2, 3, 4, 5], mon9)!)).toEqual(new Date(2026, 10, 2, 10, 0));
    expect(new Date(nextRun('08:30', [1, 2, 3, 4, 5], mon9)!)).toEqual(new Date(2026, 10, 3, 8, 30));
    expect(new Date(nextRun('08:30', [6], mon9)!)).toEqual(new Date(2026, 10, 7, 8, 30));
  });

  it('keeps settings within the same bounds as the server', () => {
    expect(settingsFor('call_new_leads', { within_hours: 999, max: 0 })).toEqual({ within_hours: 168, max: 1 });
    expect(settingsFor('reengage_stale', {})).toEqual({ stale_days: 14, max: 15 });
    expect(settingsFor('daily_briefing', { audience: 'all' })).toEqual({ audience: 'managers' });
    expect(settingsFor('overdue_follow_ups', { draft_messages: 'yes' })).toEqual({ draft_messages: false, max: 25 });
  });
});
