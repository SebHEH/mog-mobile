-- =====================================================================
-- MOG — the nightly schedule (Sheet retirement step 2)   run AFTER schema_v23.sql
-- =====================================================================
-- docs/MOG_SheetRetirement_Spec.md, R2. Every 15 minutes pg_cron runs
-- mog.night_tick(): when mog.night_due() names anything (a store Supabase
-- closes whose cycle is behind after 3:30 AM its time, a recap a close
-- owes, a store Apps Script still closes to shadow between 3:00 and 3:20),
-- it posts once to the Edge Function `close` through pg_net, which does it.
--
-- Run once by a maintainer, on Sebastian's go (like backup_role.sql). Not in
-- the schema chain: PGlite has no pg_cron, pg_net or Vault. Re-running is
-- safe: the extensions and the secret are made only if missing, the
-- functions are replaced, and cron.schedule with the same name replaces the
-- job. Re-run it after schema_v24.sql: that adds mog.backup_watch_test()
-- (the backup watchdog's test email); the tick itself is unchanged, since
-- v24's mog.night_due names the watchdog's alert like any other night step.
--
-- The secret: 32 random bytes, made here inside Vault, never shown, never
-- typed, never in this repo. The tick reads it from Vault and sends it as
-- the x-mog-night header; the function checks it with mog.night_secret_ok.
-- Running this file starts the nightly runs, but they act only on what
-- night_due names: before any store's close_direct is on, that's the
-- shadows (which write only mog.night_log).
--
-- Stop it:  select cron.unschedule('mog-night');
-- See it:   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'mog-night')
--             order by start_time desc limit 20;
--           select id, created, status_code, left(content, 300) from net._http_response order by id desc limit 20;
--           select * from mog.night_log order by id desc limit 50;
-- =====================================================================

-- As Supabase's docs install them (guides/cron/install, database/extensions/pg_net).
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'mog_night_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'mog_night_secret',
                                'MOG nightly close: pg_cron''s tick to the Edge Function close (supabase/night_schedule.sql)');
  end if;
end;
$$;

-- The function's caller check: the header must be Vault's secret.
create or replace function mog.night_secret_ok(p_secret text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32
                  and p_secret = (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'mog_night_secret'),
                  false);
$$;

-- Every 15 minutes: trim the night log (90 days, shadows 30), then post to
-- the function only when something is due. Answers pg_net's request id, or
-- null when nothing was.
create or replace function mog.night_tick()
returns bigint
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  delete from mog.night_log
   where at < now() - interval '90 days'
      or (step = 'shadow' and at < now() - interval '30 days');
  if jsonb_array_length(mog.night_due()) = 0 then
    return null;
  end if;
  return net.http_post(
    url := 'https://mnfwqmrstdeuczveyykv.supabase.co/functions/v1/close',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-mog-night', (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'mog_night_secret')),
    timeout_milliseconds := 150000);
end;
$$;

-- A test email of one logged cycle's recap to one address, posted the same
-- way (the function's 'test' step). Run by a maintainer only, e.g.
--   select mog.night_test('rprfo', '2026-11-09', '<your address>');
-- The answer lands in net._http_response; the address isn't logged.
create or replace function mog.night_test(p_slug text, p_date date, p_to text)
returns bigint
language sql volatile security definer
set search_path = ''
as $$
  select net.http_post(
    url := 'https://mnfwqmrstdeuczveyykv.supabase.co/functions/v1/close',
    body := jsonb_build_object('step', 'test', 'slug', p_slug, 'date', to_char(p_date, 'YYYY-MM-DD'), 'to', p_to),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-mog-night', (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'mog_night_secret')),
    timeout_milliseconds := 60000);
$$;

-- A test of the backup watchdog's alert (schema_v24.sql), to the watch's own
-- address (mog.backup_watch.alert_to) only: the function's 'backup_test'
-- step. Run by a maintainer: select mog.backup_watch_test();
-- The outcome lands in mog.backup_watch.last_test_at / _ok / _detail.
create or replace function mog.backup_watch_test()
returns bigint
language sql volatile security definer
set search_path = ''
as $$
  select net.http_post(
    url := 'https://mnfwqmrstdeuczveyykv.supabase.co/functions/v1/close',
    body := jsonb_build_object('step', 'backup_test'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-mog-night', (select s.decrypted_secret from vault.decrypted_secrets s where s.name = 'mog_night_secret')),
    timeout_milliseconds := 60000);
$$;

revoke all on function mog.night_secret_ok(text) from public, anon, authenticated;
revoke all on function mog.night_tick() from public, anon, authenticated;
revoke all on function mog.night_test(text, date, text) from public, anon, authenticated;
revoke all on function mog.backup_watch_test() from public, anon, authenticated;

select cron.schedule('mog-night', '*/15 * * * *', 'select mog.night_tick()');

select jobname, schedule, command, active from cron.job where jobname = 'mog-night';
