-- Estate OS · 0011 · Keep pg_net out of the public schema (Supabase advisor 0014).
-- pg_net is not relocatable, so it is reinstalled into `extensions`. Its functions stay in schema `net`, so the
-- voice-worker cron job (net.http_post) is unaffected. pg_net holds only its own request/response queue.

do $$
begin
  if exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_net' and n.nspname = 'public') then
    drop extension pg_net;
    create extension pg_net with schema extensions;
  end if;
end;
$$;
