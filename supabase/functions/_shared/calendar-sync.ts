// Agent 06 — calendar provider seam. Pure module (tested under Node with mock adapters).
// No calendar provider (Google, Microsoft, …) is integrated in this product, so ADAPTERS is empty and every job returns
// 'unsupported' (the appointment shows "calendar sync failed" and a person gets a task). A future adapter implements
// upsert / cancel with the provider's official API; this module maps its results to the outcomes the database understands.

export interface CalendarJob {
  appointment_id: string; version: number; provider: string; action: 'create' | 'update' | 'cancel';
  external_event_id: string | null; starts_at: string; ends_at: string; timezone: string; title: string; location: string | null; assignee_email: string | null;
}
export type ProviderResult =
  | { kind: 'ok'; eventId: string }
  | { kind: 'rejected'; permanent: boolean; error: string }
  // The request may have reached the provider (timeout after sending): never re-created blindly.
  | { kind: 'unknown'; error: string };
export interface CalendarAdapter { name: string; apply(job: CalendarJob, signal: AbortSignal): Promise<ProviderResult> }
export type SyncOutcome = 'synced' | 'transient' | 'permanent' | 'ambiguous' | 'unsupported';

export const ADAPTERS: Record<string, CalendarAdapter> = {};

export async function syncJob(job: CalendarJob, adapter: CalendarAdapter | undefined, timeoutMs = 15_000):
  Promise<{ outcome: SyncOutcome; eventId?: string; error?: string }> {
  if (!adapter) return { outcome: 'unsupported', error: `no calendar adapter for ${job.provider}` };
  if (job.action !== 'create' && !job.external_event_id) return { outcome: 'permanent', error: 'missing external event id' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await adapter.apply(job, ctl.signal);
    if (r.kind === 'ok') return r.eventId ? { outcome: 'synced', eventId: r.eventId } : { outcome: 'ambiguous', error: 'provider returned no event id' };
    if (r.kind === 'unknown') return { outcome: 'ambiguous', error: r.error.slice(0, 300) };
    return { outcome: r.permanent ? 'permanent' : 'transient', error: r.error.slice(0, 300) };
  } catch (e) {
    return { outcome: 'ambiguous', error: (ctl.signal.aborted ? 'timeout' : String((e as Error)?.message ?? e)).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}
