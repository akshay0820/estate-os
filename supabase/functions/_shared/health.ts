// Shapes the `health` Edge Function response from public.ops_health(). Anyone may ask whether the platform is up and gets
// only { status, checked_at }; the aggregate signals are returned only to a caller presenting the HEALTH_TOKEN secret
// (an uptime monitor). HTTP 200 = ok, 503 = degraded or down, so monitors can alert on the status code alone.
import { safeEqual } from './crypto.ts';

export interface OpsHealth { status: 'ok' | 'degraded'; reasons: string[]; checked_at: string; signals: Record<string, unknown> }

/** The monitor token must be configured (≥ 32 characters) and match exactly; compared in constant time. */
export function sameSecret(expected: string | undefined, presented: string | null): boolean {
  return !!expected && expected.length >= 32 && !!presented && safeEqual(expected, presented);
}

export function healthResponse(o: { data: OpsHealth | null; error: unknown; dbMs: number; token: string | undefined; presented: string | null; now?: () => Date }): Response {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (o.error || !o.data?.status) {
    // The database (or the function's access to it) is unavailable. Never echo the error: it may name internals.
    return new Response(JSON.stringify({ status: 'down', checked_at: (o.now ?? (() => new Date()))().toISOString() }), { status: 503, headers });
  }
  const code = o.data.status === 'ok' ? 200 : 503;
  const body = sameSecret(o.token, o.presented)
    ? { ...o.data, db_ms: o.dbMs }
    : { status: o.data.status, checked_at: o.data.checked_at };
  return new Response(JSON.stringify(body), { status: code, headers });
}
