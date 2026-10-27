export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** ₹1.2 Cr / ₹85 L / ₹45,000 — Indian grouping, compact for large sums. */
export function inr(value: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (value == null || Number.isNaN(value)) return '—';
  const compact = opts.compact ?? true;
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  if (compact && abs >= 1e7) return `${sign}₹${trim(abs / 1e7)} Cr`;
  if (compact && abs >= 1e5) return `${sign}₹${trim(abs / 1e5)} L`;
  if (compact && abs >= 1e4) return `${sign}₹${trim(abs / 1e3)}k`;
  return `${sign}₹${Math.round(abs).toLocaleString('en-IN')}`;
}

/** Small currency values such as AI cost per call. */
export function inrPrecise(value: number): string {
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n.toFixed(n >= 10 ? 1 : 2).replace(/\.?0+$/, '');
}

export function num(value: number): string {
  return value.toLocaleString('en-IN');
}

export function compactNum(value: number): string {
  if (Math.abs(value) >= 1e5) return `${trim(value / 1e5)}L`;
  if (Math.abs(value) >= 1e3) return `${trim(value / 1e3)}k`;
  return String(Math.round(value));
}

export function pct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits).replace(/\.0$/, '')}%`;
}

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });
const dateYearFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
const weekdayFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short' });

export function fmtDate(ts: number | null | undefined, withYear = false): string {
  if (!ts) return '—';
  return (withYear ? dateYearFmt : dateFmt).format(ts);
}

export function fmtTime(ts: number): string {
  return timeFmt.format(ts).replace(' ', '').toLowerCase();
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return `${fmtDate(ts)}, ${fmtTime(ts)}`;
}

export function weekday(ts: number): string {
  return weekdayFmt.format(ts);
}

export function relTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const diff = ts - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  let label: string;
  // Server timestamps can run a few seconds ahead of this browser's clock: a moment-old event must not read as future.
  if (abs < 45_000) return future && abs >= 30_000 ? 'in a moment' : 'just now';
  if (abs < HOUR) label = `${Math.round(abs / MIN)}m`;
  else if (abs < DAY) label = `${Math.round(abs / HOUR)}h`;
  else if (abs < 30 * DAY) label = `${Math.round(abs / DAY)}d`;
  else return fmtDate(ts, true);
  return future ? `in ${label}` : `${label} ago`;
}

export function duration(seconds: number): string {
  if (!seconds) return '0s';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

export function ms(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return duration(Math.round(value / 1000));
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts));
  const dow = (d.getDay() + 6) % 7; // Monday first
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function titleCase(s: string): string {
  return s
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${num(n)} ${n === 1 ? word : pluralWord}`;
}

export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): number {
  return new Date(value).getTime();
}
