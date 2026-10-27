-- Estate OS · 0009 · Schedules the lead-intake worker (abandoned submissions and due retries) every minute.
-- Pure SQL job: no HTTP, no secrets. Skipped where pg_cron is unavailable (local PGlite tests).

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    if not exists (select 1 from cron.job where jobname = 'lead-intake-worker') then
      perform cron.schedule('lead-intake-worker', '* * * * *', 'select public.intake_process_due(25)');
    end if;
  end if;
end;
$$;
