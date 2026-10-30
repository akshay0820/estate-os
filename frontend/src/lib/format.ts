export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

// Money follows the active workspace's currency (organizations.default_currency), set once by the app shell.
// INR keeps Indian grouping and lakh / crore; every other currency uses US-style grouping and K / M.
let activeCurrency = 'USD';

export function setMoneyCurrency(code: string | null | undefined) {
  activeCurrency = code || 'USD';
}

export function moneyCurrency(): string {
  return activeCurrency;
}

const locale = (code: string) => (code === 'INR' ? 'en-IN' : 'en-US');

// Building an Intl formatter is far slower than using one; tables format hundreds of amounts per render.
const symbols = new Map<string, string>();
const groupers = new Map<string, Intl.NumberFormat>();
const group = (n: number, code = activeCurrency) => {
  const loc = locale(code);
  let f = groupers.get(loc);
  if (!f) groupers.set(loc, (f = new Intl.NumberFormat(loc)));
  return f.format(n);
};

/** "$", "₹", "AED"… for labels such as "Price ($)". */
export function currencySymbol(code = activeCurrency): string {
  let sym = symbols.get(code);
  if (sym === undefined) {
    sym = new Intl.NumberFormat(locale(code), { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0).find((p) => p.type === 'currency')?.value ?? code;
    symbols.set(code, sym);
  }
  return sym;
}

/** $1.2M / $850K / $45,000 (or ₹1.2 Cr / ₹85 L for INR) — compact for large sums. */
export function money(value: number | null | undefined, opts: { compact?: boolean; currency?: string } = {}): string {
  if (value == null || Number.isNaN(value)) return '—';
  const code = opts.currency || activeCurrency;
  const compact = opts.compact ?? true;
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : '';
  const sym = currencySymbol(code);
  if (code === 'INR') {
    if (compact && abs >= 1e7) return `${sign}${sym}${trim(abs / 1e7)} Cr`;
    if (compact && abs >= 1e5) return `${sign}${sym}${trim(abs / 1e5)} L`;
  } else {
    if (compact && abs >= 1e6) return `${sign}${sym}${trim(abs / 1e6)}M`;
    if (compact && abs >= 1e5) return `${sign}${sym}${trim(abs / 1e3)}K`;
  }
  if (compact && abs >= 1e4) return `${sign}${sym}${trim(abs / 1e3)}${code === 'INR' ? 'k' : 'K'}`;
  return `${sign}${sym}${group(Math.round(abs), code)}`;
}

/** Small currency values such as AI cost per call. */
export function moneyPrecise(value: number, currency = activeCurrency): string {
  return `${currencySymbol(currency)}${value.toLocaleString(locale(currency), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** How budgets are typed in forms: INR in lakh (×100,000), other currencies in whole units. */
export function budgetInputUnit(code = activeCurrency): { label: string; multiplier: number } {
  return code === 'INR' ? { label: `${currencySymbol(code)} lakh`, multiplier: 1e5 } : { label: currencySymbol(code), multiplier: 1 };
}

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n.toFixed(n >= 10 ? 1 : 2).replace(/\.?0+$/, '');
}

export function num(value: number): string {
  return group(value);
}

export function compactNum(value: number): string {
  if (activeCurrency === 'INR' && Math.abs(value) >= 1e5) return `${trim(value / 1e5)}L`;
  if (activeCurrency !== 'INR' && Math.abs(value) >= 1e6) return `${trim(value / 1e6)}M`;
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
