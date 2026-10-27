import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Only the public URL and the publishable (anon) key reach the browser.
// Every request is authorized in Postgres by RLS against the signed-in user's JWT.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const backendConfigured = Boolean(url && key);

/** Deployment label set at build time (`VITE_APP_ENV`): production builds must set `production` (checked by scripts/predeploy-check.mjs). */
export const APP_ENV = ((import.meta.env.VITE_APP_ENV as string | undefined) ?? 'development').toLowerCase();

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!backendConfigured) throw new Error('Supabase is not configured');
  client ??= createClient(url!, key!, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Lets password-recovery and email-confirmation links finish signing in.
      detectSessionInUrl: true,
      flowType: 'pkce',
      storageKey: 'estate-os:auth',
    },
  });
  return client;
}

export function functionsUrl(name: string): string {
  return `${url}/functions/v1/${name}`;
}
