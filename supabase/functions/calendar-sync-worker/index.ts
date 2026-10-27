// POST /functions/v1/calendar-sync-worker — called every minute by pg_cron (pg_net) with the Vault shared secret.
// Claims appointments whose calendar copy must be created / updated / cancelled and applies them through a provider
// adapter. No adapter exists in this product: jobs are reported 'unsupported' (sync failed + a task), never 'synced'.
// Jobs only exist when an organization has a connected calendar integration.
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { authorizeWorker } from '../_shared/worker-auth.ts';
import { ADAPTERS, type CalendarJob, syncJob } from '../_shared/calendar-sync.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'calendar-sync-worker', ...fields }));

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const denied = await authorizeWorker(supabase, 'calendar-sync-worker', 'calendar_sync_worker_secret_ok', req.headers.get('x-worker-secret'));
  if (denied) return denied;
  const { data, error } = await supabase.rpc('calendar_sync_claim', { p_limit: 10 });
  if (error) {
    log({ outcome: 'error', stage: 'claim' });
    return new Response(null, { status: 500 });
  }
  const jobs = (data ?? []) as CalendarJob[];
  for (const job of jobs) {
    const r = await syncJob(job, ADAPTERS[job.provider]);
    const { data: status } = await supabase.rpc('calendar_sync_result', { p_appt: job.appointment_id, p_version: job.version, p_outcome: r.outcome,
      p_external_event_id: r.eventId ?? null, p_error: r.error ?? null });
    log({ appointment: job.appointment_id, action: job.action, outcome: r.outcome, status });
  }
  return new Response(JSON.stringify({ synced: jobs.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
