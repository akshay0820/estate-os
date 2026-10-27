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

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
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

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (line: string) => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const header = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
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
