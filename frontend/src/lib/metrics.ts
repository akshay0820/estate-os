import { DAY, startOfDay } from './format';

export type RangeKey = '7d' | '30d' | '90d' | '12m';

export interface Bucket {
  start: number;
  end: number;
  label: string;
}

export const RANGE_DAYS: Record<RangeKey, number> = { '7d': 7, '30d': 30, '90d': 90, '12m': 365 };

const dayLabel = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const monLabel = new Intl.DateTimeFormat('en-IN', { month: 'short' });
const wdLabel = new Intl.DateTimeFormat('en-IN', { weekday: 'short' });

/** Buckets for a range ending today (inclusive). Daily up to 30d, weekly for 90d, monthly for 12m. */
export function buckets(range: RangeKey, now = Date.now(), offsetPeriods = 0): Bucket[] {
  const today = startOfDay(now);
  const days = RANGE_DAYS[range];
  const shift = offsetPeriods * days * DAY;
  if (range === '7d' || range === '30d') {
    return Array.from({ length: days }, (_, i) => {
      const start = today - (days - 1 - i) * DAY - shift;
      return { start, end: start + DAY, label: range === '7d' ? wdLabel.format(start) : dayLabel.format(start) };
    });
  }
  if (range === '90d') {
    const weeks = 13;
    return Array.from({ length: weeks }, (_, i) => {
      const end = today + DAY - (weeks - 1 - i) * 7 * DAY - shift;
      return { start: end - 7 * DAY, end, label: dayLabel.format(end - 7 * DAY) };
    });
  }
  const d = new Date(today);
  return Array.from({ length: 12 }, (_, i) => {
    const s = new Date(d.getFullYear(), d.getMonth() - 11 + i - offsetPeriods * 12, 1).getTime();
    const e = new Date(d.getFullYear(), d.getMonth() - 10 + i - offsetPeriods * 12, 1).getTime();
    return { start: s, end: e, label: monLabel.format(s) };
  });
}

export function countIn<T>(items: T[], bs: Bucket[], at: (x: T) => number | null | undefined, value: (x: T) => number = () => 1): number[] {
  const out = bs.map(() => 0);
  if (!bs.length) return out;
  const lo = bs[0].start;
  const hi = bs[bs.length - 1].end;
  for (const it of items) {
    const t = at(it);
    if (t == null || t < lo || t >= hi) continue;
    for (let i = 0; i < bs.length; i++) {
      if (t >= bs[i].start && t < bs[i].end) {
        out[i] += value(it);
        break;
      }
    }
  }
  return out;
}

export function windowOf(range: RangeKey, now = Date.now(), previous = false): [number, number] {
  const end = startOfDay(now) + DAY - (previous ? RANGE_DAYS[range] * DAY : 0);
  return [end - RANGE_DAYS[range] * DAY, end];
}

export function inWindow(t: number | null | undefined, w: [number, number]): boolean {
  return t != null && t >= w[0] && t < w[1];
}

export function change(cur: number, prev: number): number {
  if (!prev) return cur ? 1 : 0;
  return (cur - prev) / prev;
}

export function median(list: number[]): number {
  if (!list.length) return NaN;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
