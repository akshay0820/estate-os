// Shared-secret check for the pg_cron-called workers (PRA-031). A wrong secret is 401; a check that could not run (the
// database or the RPC failed) is 503 with a log line, so a transient failure is no longer reported as an auth failure.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.118.0';

type RpcClient = Pick<SupabaseClient, 'rpc'>;

/** Returns null when the caller is authorized, otherwise the response to send. */
export async function authorizeWorker(sb: RpcClient, fn: string, rpcName: string, secret: string | null): Promise<Response | null> {
  const { data, error } = await sb.rpc(rpcName, { p_secret: secret ?? '' });
  if (error) {
    console.log(JSON.stringify({ fn, outcome: 'secret_check_unavailable', code: (error as { code?: string }).code ?? null }));
    return new Response(null, { status: 503 });
  }
  return data === true ? null : new Response(null, { status: 401 });
}
