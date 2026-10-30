let counter = 0;

export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function correlationId(): string {
  return `cor_${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 6)}`;
}

/** Deterministic PRNG so the seed data is stable across reloads. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = ReturnType<typeof mulberry32>;

export function pick<T>(rand: Rand, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)];
}

export function pickWeighted<T>(rand: Rand, entries: readonly [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) {
    r -= w;
    if (r <= 0) return v;
  }
  return entries[entries.length - 1][0];
}

export function between(rand: Rand, min: number, max: number): number {
  return min + rand() * (max - min);
}

export function intBetween(rand: Rand, min: number, max: number): number {
  return Math.floor(between(rand, min, max + 1));
}

export function sample<T>(rand: Rand, list: readonly T[], n: number): T[] {
  const copy = [...list];
  const out: T[] = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return out;
}

export function sum(list: number[]): number {
  return list.reduce((a, b) => a + b, 0);
}

export function groupBy<T, K extends string | number>(list: T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of list) (out[key(item)] ??= []).push(item);
  return out;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// The active workspace's country, set by the app shell; mirrors private.normalize_phone in the database.
let phoneCountry = 'US';

export function setPhoneCountry(code: string | null | undefined) {
  phoneCountry = code || 'US';
}

export function getPhoneCountry(): string {
  return phoneCountry;
}

/** E.164 for comparisons: a number without a country code takes the workspace country's code. */
export function normalizePhone(raw: string, country = phoneCountry): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (/^\s*(\+|00)/.test(raw)) return `+${/^\s*00/.test(raw) ? digits.slice(2) : digits}`;
  if (country === 'US' || country === 'CA') {
    // North American numbers: area code and exchange start with 2-9; anything else is not a valid +1 number.
    if (digits.length === 10) return /^[2-9]\d{2}[2-9]/.test(digits) ? `+1${digits}` : '';
    if (digits.length === 11 && digits.startsWith('1')) return /^1[2-9]\d{2}[2-9]/.test(digits) ? `+${digits}` : '';
  }
  if (country === 'IN') {
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  }
  return `+${digits}`;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const csv = rows
    .map((r) =>
      r
        .map((cell) => {
          const v = cell == null ? '' : String(cell);
          return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        })
        .join(','),
    )
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * CSV / TSV from Google Sheets, Excel or another CRM: strips the UTF-8 BOM Excel adds, keeps line breaks inside quoted
 * cells, and detects a comma, semicolon (European Excel) or tab delimiter from the header row. Headers are lower-cased;
 * fully blank rows are dropped.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delim = [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += ch;
  }
  row.push(cur);
  rows.push(row);
  const filled = rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
  if (!filled.length) return [];
  const header = filled[0].map((h) => h.toLowerCase());
  return filled.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function maskSecret(s: string): string {
  return `${s.slice(0, 7)}${'•'.repeat(18)}${s.slice(-4)}`;
}
