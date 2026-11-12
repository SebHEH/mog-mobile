-- =====================================================================
-- MOG schema v24 — smoke test (run in the SQL Editor AFTER schema_v24.sql)
-- =====================================================================
-- The backup watchdog and the drop of mog.wh_products.via, par and stores.
-- Checks:
--   * the drop: the three columns are gone, their copy table exists, and
--     the warehouse save still makes and reads a product;
--   * mog.backup_heartbeat: refuses a blank run and counts that aren't from
--     a dump, writes one row otherwise;
--   * mog.backup_status: not stale before 30 hours, stale after; counted
--     from the later of the newest heartbeat and the watch's start; a
--     heartbeat ends it;
--   * the alert: due only with an address; claimed once; a failed send is
--     due again after an hour, a sent one after a day; mog.night_due names
--     { slug: null, step: 'backup' } exactly when it's due;
--   * the test email's data: refused without an address; its outcome kept;
--   * nothing new is open to anon; the heartbeat is open to mog_backup
--     (where that role exists) and nothing else of the watchdog is.
-- Runs at times ten years out, so live heartbeats never count, and puts the
-- watch row back exactly as it found it; its heartbeats are deleted at the
-- end. The whole run is one transaction: pg_cron's tick never sees it.
-- Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke24 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke24;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke24 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  w0   mog.backup_watch%rowtype;
  t    timestamptz := date_trunc('hour', now()) + interval '3650 days';
  r    jsonb;
  ok   boolean;
  pid  bigint;
  tok  text;
  has_backup_role boolean := exists (select 1 from pg_roles where rolname = 'mog_backup');
  due_has_backup boolean;
begin
  select * into w0 from mog.backup_watch where id;
  perform pg_temp.chk('watch: one row, made by the schema file, stale after 30 hours by default',
    found and (select count(*) = 1 from mog.backup_watch) and (select column_default like '30%' from information_schema.columns
      where table_schema = 'mog' and table_name = 'backup_watch' and column_name = 'stale_hours'), null);

  -- ---- The drop ----
  perform pg_temp.chk('drop: mog.wh_products has no via, par or stores',
    not exists (select 1 from information_schema.columns
                 where table_schema = 'mog' and table_name = 'wh_products' and column_name in ('via', 'par', 'stores')), null);
  perform pg_temp.chk('drop: the copy table keeps product id, name, via, par and stores',
    (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
      where table_schema = 'mog' and table_name = 'wh_products_retired')
      = array['product_id', 'name', 'via', 'par', 'stores', 'saved_at'], null);
  insert into mog.wh_products (name, pack, handling_fee) values ('zz smoke 24 product', 'CASE', 1) returning id into pid;
  perform pg_temp.chk('drop: a product is still made and read whole',
    (select to_jsonb(p) ->> 'name' = 'zz smoke 24 product' and not (to_jsonb(p) ? 'via') and not (to_jsonb(p) ? 'par')
                                                    and not (to_jsonb(p) ? 'stores') from mog.wh_products p where p.id = pid), null);
  delete from mog.wh_products where id = pid;

  -- ---- The heartbeat ----
  ok := false;
  begin perform mog.backup_heartbeat(' ', 30, 100, 1000); exception when others then ok := true; end;
  perform pg_temp.chk('heartbeat: a blank run id is refused', ok, null);
  ok := false;
  begin perform mog.backup_heartbeat('zz smoke 24 run', 0, 100, 1000); exception when others then ok := true; end;
  perform pg_temp.chk('heartbeat: no tables is refused', ok, null);
  ok := false;
  begin perform mog.backup_heartbeat('zz smoke 24 run', 30, 100, 0); exception when others then ok := true; end;
  perform pg_temp.chk('heartbeat: an empty dump is refused', ok, null);
  r := mog.backup_heartbeat('zz smoke 24 run', 37, 17766, 727000);
  perform pg_temp.chk('heartbeat: a good backup writes one row',
    (r ->> 'ok')::boolean and (select count(*) = 1 from mog.backup_heartbeats
                                where run_id = 'zz smoke 24 run' and tables = 37 and row_total = 17766 and dump_bytes = 727000), r);

  -- ---- The status, from a watch started at t ----
  update mog.backup_watch set watch_from = t, alert_to = 'zz-smoke24@example.com', stale_hours = 30,
         last_alert_at = null, last_alert_ok = null, last_alert_detail = null where id;
  r := mog.backup_status(t + interval '29 hours');
  perform pg_temp.chk('status: 29 hours after the watch starts, not stale, nothing due',
    not (r ->> 'stale')::boolean and not (r ->> 'due')::boolean and (r ->> 'hours')::numeric = 29.0
      and (r ->> 'hasAddress')::boolean, r);
  r := mog.backup_status(t + interval '31 hours');
  perform pg_temp.chk('status: 31 hours with no newer heartbeat, stale and due (an older live heartbeat doesn''t count)',
    (r ->> 'stale')::boolean and (r ->> 'due')::boolean and (r ->> 'hours')::numeric = 31.0, r);
  update mog.backup_watch set alert_to = null where id;
  r := mog.backup_status(t + interval '31 hours');
  due_has_backup := exists (select 1 from jsonb_array_elements(mog.night_due(t + interval '31 hours')) e where e ->> 'step' = 'backup');
  perform pg_temp.chk('status: no address, nothing due, and night_due names no backup',
    (r ->> 'stale')::boolean and not (r ->> 'due')::boolean and not (r ->> 'hasAddress')::boolean and not due_has_backup, r);
  r := mog.backup_alert_claim(t + interval '31 hours');
  perform pg_temp.chk('claim: no address, no claim', not (r ->> 'due')::boolean
    and (select last_alert_at is null from mog.backup_watch where id), r);
  update mog.backup_watch set alert_to = 'zz-smoke24@example.com' where id;
  perform pg_temp.chk('night_due: names { slug: null, step: backup } once when it''s due',
    (select count(*) = 1 from jsonb_array_elements(mog.night_due(t + interval '31 hours')) e
      where e = '{"slug": null, "step": "backup"}'::jsonb), mog.night_due(t + interval '31 hours'));

  -- ---- The alert ----
  r := mog.backup_alert_claim(t + interval '31 hours');
  perform pg_temp.chk('claim: due, with the address, the hours and the claim''s time',
    (r ->> 'due')::boolean and r ->> 'to' = 'zz-smoke24@example.com' and (r ->> 'hours')::numeric = 31.0
      and (r ->> 'claimedAt')::timestamptz = t + interval '31 hours'
      and (select last_alert_at = t + interval '31 hours' and last_alert_ok is null from mog.backup_watch where id), r);
  r := mog.backup_alert_claim(t + interval '31 hours 15 minutes');
  perform pg_temp.chk('claim: not again 15 minutes later while the first is under way',
    not (r ->> 'due')::boolean and not exists (select 1 from jsonb_array_elements(mog.night_due(t + interval '31 hours 15 minutes')) e
                                                where e ->> 'step' = 'backup'), r);
  r := mog.backup_alert_done('alert', false, '{"error": "relay: down"}'::jsonb);
  perform pg_temp.chk('done: a failed send is kept with its error',
    (select last_alert_ok is false and last_alert_detail ->> 'error' = 'relay: down' from mog.backup_watch where id), r);
  perform pg_temp.chk('alert: a failed one is due again after an hour, not before',
    not (mog.backup_status(t + interval '31 hours 59 minutes') ->> 'due')::boolean
      and (mog.backup_status(t + interval '32 hours') ->> 'due')::boolean, null);
  r := mog.backup_alert_claim(t + interval '32 hours');
  perform mog.backup_alert_done('alert', true, '{"sent": 1}'::jsonb);
  perform pg_temp.chk('alert: a sent one is due again a day later, not before',
    (r ->> 'due')::boolean
      and not (mog.backup_status(t + interval '55 hours 59 minutes') ->> 'due')::boolean
      and (mog.backup_status(t + interval '56 hours') ->> 'due')::boolean, r);
  ok := false;
  begin perform mog.backup_alert_done('nope', true, '{}'::jsonb); exception when others then ok := true; end;
  perform pg_temp.chk('done: a kind other than alert or test is refused', ok, null);

  -- ---- A heartbeat ends it ----
  insert into mog.backup_heartbeats (at, run_id, tables, row_total, dump_bytes)
  values (t + interval '57 hours', 'zz smoke 24 later', 37, 17800, 728000);
  r := mog.backup_status(t + interval '58 hours');
  perform pg_temp.chk('status: a heartbeat an hour ago, not stale, nothing due, its run named',
    not (r ->> 'stale')::boolean and not (r ->> 'due')::boolean and r ->> 'run' = 'zz smoke 24 later'
      and (r ->> 'hours')::numeric = 1.0 and (r ->> 'newest')::timestamptz = t + interval '57 hours', r);
  perform pg_temp.chk('status: stale again 30 hours after that heartbeat',
    not (mog.backup_status(t + interval '87 hours') ->> 'stale')::boolean
      and (mog.backup_status(t + interval '87 hours 1 minute') ->> 'due')::boolean, null);

  -- ---- The test email's data ----
  update mog.backup_watch set alert_to = null where id;
  r := mog.backup_test_data(t + interval '58 hours');
  perform pg_temp.chk('test: refused without an address', not (r ->> 'ok')::boolean and r ->> 'error' = 'NO_ADDRESS', r);
  update mog.backup_watch set alert_to = 'zz-smoke24@example.com' where id;
  r := mog.backup_test_data(t + interval '58 hours');
  perform pg_temp.chk('test: the watch''s own address and the status',
    (r ->> 'ok')::boolean and r ->> 'to' = 'zz-smoke24@example.com' and r ->> 'run' = 'zz smoke 24 later', r);
  perform mog.backup_alert_done('test', true, '{"sent": 1}'::jsonb, t + interval '58 hours');
  perform pg_temp.chk('test: its outcome is kept apart from the alert''s',
    (select last_test_at = t + interval '58 hours' and last_test_ok and last_alert_ok from mog.backup_watch where id), null);

  -- ---- Privileges ----
  perform pg_temp.chk('anon: none of the watchdog''s functions',
    not has_function_privilege('anon', 'mog.backup_heartbeat(text, integer, bigint, bigint)', 'execute')
      and not has_function_privilege('anon', 'mog.backup_status(timestamptz)', 'execute')
      and not has_function_privilege('anon', 'mog.backup_alert_claim(timestamptz)', 'execute')
      and not has_function_privilege('anon', 'mog.backup_alert_done(text, boolean, jsonb, timestamptz)', 'execute')
      and not has_function_privilege('anon', 'mog.backup_test_data(timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'mog.backup_heartbeat(text, integer, bigint, bigint)', 'execute'), null);
  perform pg_temp.chk('anon: the new tables are closed',
    not has_table_privilege('anon', 'mog.backup_watch', 'select')
      and not has_table_privilege('anon', 'mog.backup_heartbeats', 'select')
      and not has_table_privilege('anon', 'mog.wh_products_retired', 'select'), null);
  perform pg_temp.chk('mog_backup: may write the heartbeat and nothing else of the watchdog (where the role exists)',
    not has_backup_role
      or (has_function_privilege('mog_backup', 'mog.backup_heartbeat(text, integer, bigint, bigint)', 'execute')
          and not has_function_privilege('mog_backup', 'mog.backup_alert_claim(timestamptz)', 'execute')
          and not has_function_privilege('mog_backup', 'mog.backup_alert_done(text, boolean, jsonb, timestamptz)', 'execute')
          and not has_table_privilege('mog_backup', 'mog.backup_heartbeats', 'insert')), null);

  -- ---- Put it back ----
  update mog.backup_watch
     set watch_from = w0.watch_from, alert_to = w0.alert_to, stale_hours = w0.stale_hours,
         last_alert_at = w0.last_alert_at, last_alert_ok = w0.last_alert_ok, last_alert_detail = w0.last_alert_detail,
         last_test_at = w0.last_test_at, last_test_ok = w0.last_test_ok, last_test_detail = w0.last_test_detail
   where id;
  delete from mog.backup_heartbeats where run_id like 'zz smoke 24%';
  perform pg_temp.chk('cleanup: the watch row as it was, no smoke heartbeat or product left',
    (select to_jsonb(w) = to_jsonb(w0) from mog.backup_watch w where w.id)
      and not exists (select 1 from mog.backup_heartbeats where run_id like 'zz smoke 24%')
      and not exists (select 1 from mog.wh_products where name = 'zz smoke 24 product'), null);
end;
$$;

select n, case when ok then 'PASS' else 'FAIL' end as result, check_name, detail from mog_smoke24 order by n;
