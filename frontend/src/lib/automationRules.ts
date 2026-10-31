// Scheduling and settings rules for automations, matching private.automation_next_run / private.automation_settings
// (migration 0029). Pure, so the demo and its tests share them without the app store.
import type { AutomationRow } from '@/backend/live';

type Kind = AutomationRow['kind'];
export type FollowUpPurpose = 'clarify_requirements' | 'share_property_recommendations' | 're_engagement';

export const AUTOMATION_LABEL: Record<Kind, string> = {
  daily_briefing: 'Daily briefing', overdue_follow_ups: 'Overdue follow-up sweep', call_new_leads: 'Call new leads (approval queue)', reengage_stale: 'Re-engage stale leads',
};
export const PURPOSE_LABEL: Record<FollowUpPurpose, string> = {
  clarify_requirements: 'Ask about their requirements', share_property_recommendations: 'Share matching listings', re_engagement: 'Re-engage',
};
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const daysLabel = (days: number[]) => (days.length === 7 ? 'Every day' : days.join() === '1,2,3,4,5' ? 'Weekdays' : days.map((d) => DAY_NAMES[d]).join(', '));
const DAY = 864e5;

/** Next local run of HH:MM on one of `days` (0 = Sunday) after `after`. */
export function nextRun(runAt: string, days: number[], after = Date.now()): string | null {
  const [h, m] = runAt.split(':').map(Number);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(after + i * DAY);
    d.setHours(h, m, 0, 0);
    if (days.includes(d.getDay()) && d.getTime() > after) return d.toISOString();
  }
  return null;
}

export function settingsFor(kind: Kind, s: Record<string, unknown> = {}): Record<string, unknown> {
  const clamp = (v: unknown, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.round(Number(v)) : d));
  switch (kind) {
    case 'daily_briefing': return { audience: s.audience === 'everyone' ? 'everyone' : 'managers' };
    case 'overdue_follow_ups': return { draft_messages: s.draft_messages === true, max: clamp(s.max, 1, 50, 25) };
    case 'call_new_leads': return { within_hours: clamp(s.within_hours, 1, 168, 24), max: clamp(s.max, 1, 50, 20) };
    case 'reengage_stale': return { stale_days: clamp(s.stale_days, 7, 180, 14), max: clamp(s.max, 1, 50, 15) };
  }
}
