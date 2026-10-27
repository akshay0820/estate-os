// GET /functions/v1/health — platform health for uptime monitoring (no JWT; see config.toml).
// Public callers get { status, checked_at } only; callers sending `x-health-token: <HEALTH_TOKEN>` (an Edge Function
// secret of at least 32 characters) also get the aggregate signals from public.ops_health(). No tenant data either way.
import { createClient } from 'jsr:@supabase/supabase-js@2.118.0';
import { healthResponse, type OpsHealth } from '../_shared/health.ts';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });

// One ops_health query per instance every 30 s at most: the endpoint is public, so repeated calls must not add database load.
const CACHE_MS = 30_000;
let cached: { at: number; data: OpsHealth | null; error: unknown; dbMs: number } | null = null;

Deno.serve(async (req) => {
  if (req.method !== 'GET') return new Response(null, { status: 405 });
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const started = Date.now();
    const { data, error } = await supabase.rpc('ops_health');
    cached = { at: Date.now(), data: data as OpsHealth | null, error, dbMs: Date.now() - started };
  }
  const { data, error, dbMs } = cached;
  const res = healthResponse({ data, error, dbMs, token: Deno.env.get('HEALTH_TOKEN'), presented: req.headers.get('x-health-token') });
  if (res.status !== 200) console.log(JSON.stringify({ fn: 'health', status: res.status, reasons: data?.reasons ?? ['database_unavailable'] }));
  return res;
});
