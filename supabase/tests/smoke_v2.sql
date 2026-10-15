-- =====================================================================
-- MOG schema v2 — smoke test (run in the SQL Editor AFTER schema_v2.sql)
-- =====================================================================
-- Throwaway store 'zztest2': every v2 function, the v1 functions v2
-- replaced, and the lockdown of the new table. Cleans up after itself.
-- Read the result table: every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke2 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke2;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke2 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  k    text;
  r    jsonb;
  tok  text;
  cat  jsonb := '{"schema":1,"timeZone":"America/New_York","location":"Smoke v2","vendorList":[],"items":{},"pickRows":[]}';
  rows jsonb := '[
    {"vendor":"Sysco","id":"A","name":"Napkins","pack":"CS","area":"Dry","onHandPrev":1,"qty":2},
    {"vendor":"Sysco","id":"B","name":"Cups","pack":"CS","area":"Dry","onHandPrev":0,"qty":1},
    {"vendor":"Amazon","id":"C","name":"Tape","pack":"PK","area":"","onHandPrev":null,"qty":3},
    {"vendor":"Amazon","id":"D","name":"Zero","pack":"","area":"","onHandPrev":5,"qty":0},
    {"vendor":"","id":"E","name":"No vendor","qty":1}]';
begin
  -- Lockdown of the new pieces
  perform pg_temp.chk('rls: on for order_log',
    (select relrowsecurity from pg_class where oid = 'mog.order_log'::regclass), null);
  perform pg_temp.chk('privileges: public key cannot reach order_log or the new helpers',
    not has_table_privilege('anon', 'mog.order_log', 'select')
      and not has_function_privilege('anon', 'mog.apply_override(text, boolean)', 'execute')
      and not has_function_privilege('anon', 'mog.apply_vendor_pick(text, text, integer)', 'execute'), null);
  perform pg_temp.chk('privileges: public key can call the new entry points',
    has_function_privilege('anon', 'public.mog_sync_close_cycle(text, text, date, date, text, jsonb, jsonb, timestamptz)', 'execute')
      and has_function_privilege('anon', 'public.mog_sync_get_snapshot(text, text, bigint)', 'execute'), null);

  delete from mog.stores where slug = 'zztest2';
  k := mog.provision_store('zztest2');
  perform public.mog_sync_set_pins('zztest2', k, '4321', null);
  perform public.mog_sync_push_catalog('zztest2', k, 1, cat);
  perform public.mog_sync_set_state('zztest2', k, '2026-10-15', 'Thu', false, '{}', '[]', true);

  -- Snapshot by sync key
  r := public.mog_sync_get_snapshot('zztest2', 'wrong');
  perform pg_temp.chk('snapshot: wrong sync key rejected', r ->> 'error' = 'BAD_SYNC_KEY', r);
  r := public.mog_sync_get_snapshot('zztest2', k);
  perform pg_temp.chk('snapshot: sync key reads catalog + state',
    r -> 'data' -> 'catalog' ->> 'location' = 'Smoke v2' and r -> 'data' -> 'state' ->> 'cycleDate' = '2026-10-15', r - 'data');

  -- Counts: a null cycle date means the current cycle
  r := public.mog_sync_put_counts('zztest2', k, null, '[{"vendor":"Sysco","id":"A","onHand":1}]');
  perform pg_temp.chk('put_counts: null cycle = current cycle',
    r -> 'data' ->> 'cycleDate' = '2026-10-15' and (r -> 'data' ->> 'saved')::int = 1, r);

  -- Override rules are shared between the PWA and Apps Script versions
  r := public.mog_sync_set_override('zztest2', k, true);
  perform pg_temp.chk('sync override: on', (r -> 'data' -> 'state' ->> 'emergencyOverride')::boolean, r -> 'data' -> 'state');
  r := public.mog_sync_set_vendor_pick('zztest2', k, 'Sysco', 3);
  perform pg_temp.chk('sync pick: Sysco = 3', (r -> 'data' -> 'state' -> 'vendorPicks' ->> 'Sysco')::int = 3, r -> 'data' -> 'state');
  r := public.mog_sync_set_vendor_pick('zztest2', k, 'Sysco', 9);
  perform pg_temp.chk('sync pick: 9 rejected with the same message as the PWA version',
    r ->> 'error' = 'Invalid override multiplier (expected 0-7): 9', r);
  r := public.mog_login('zztest2', '4321');
  tok := r -> 'data' ->> 'token';
  r := public.mog_set_override(tok, false);
  perform pg_temp.chk('PWA override (replaced in v2): off still clears the picks',
    not (r -> 'data' -> 'state' ->> 'emergencyOverride')::boolean
      and r -> 'data' -> 'state' -> 'vendorPicks' = '{}'::jsonb, r -> 'data' -> 'state');
  r := public.mog_set_vendor_pick(tok, 'Amazon', 2);
  perform pg_temp.chk('PWA pick (replaced in v2): still works', (r -> 'data' -> 'state' -> 'vendorPicks' ->> 'Amazon')::int = 2, r -> 'data' -> 'state');
  perform public.mog_set_override(tok, true);

  -- Close the cycle
  r := public.mog_sync_close_cycle('zztest2', k, '2026-10-15', '2026-10-16', 'Fri', rows, '[]');
  perform pg_temp.chk('close: 3 rows logged (qty 0 and blank vendor skipped)',
    (r -> 'data' ->> 'closed')::boolean and (r -> 'data' ->> 'logged')::int = 3, r);
  r := public.mog_sync_get_snapshot('zztest2', k);
  perform pg_temp.chk('close: new cycle Fri 10-16, override off, picks cleared',
    r -> 'data' -> 'state' ->> 'cycleDate' = '2026-10-16' and r -> 'data' -> 'state' ->> 'dayOfWeek' = 'Fri'
      and not (r -> 'data' -> 'state' ->> 'emergencyOverride')::boolean
      and r -> 'data' -> 'state' -> 'vendorPicks' = '{}'::jsonb, r -> 'data' -> 'state');
  perform pg_temp.chk('close: old cycle''s counts kept as evidence, new cycle starts empty',
    jsonb_array_length(r -> 'data' -> 'counts') = 0
      and (select count(*) = 1 from mog.counts where slug = 'zztest2' and cycle_date = '2026-10-15'), null);
  r := public.mog_sync_close_cycle('zztest2', k, '2026-10-15', '2026-10-16', 'Fri', rows, '[]');
  perform pg_temp.chk('close: a second close of the same cycle is refused (nothing logged twice)',
    not (r -> 'data' ->> 'closed')::boolean and r -> 'data' ->> 'reason' = 'CYCLE_MOVED'
      and (select count(*) = 3 from mog.order_log where slug = 'zztest2' and cycle_date = '2026-10-15'), r);
  r := public.mog_sync_close_cycle('zztest2', k, '2026-10-16', '2026-10-15', 'Thu', rows, '[]');
  perform pg_temp.chk('close: going backwards is rejected', not (r ->> 'ok')::boolean, r);

  -- The log reads back in order
  r := public.mog_sync_get_log('zztest2', k, '2026-10-15');
  perform pg_temp.chk('log: 3 rows, in logged order, pack and area kept',
    jsonb_array_length(r -> 'data' -> 'rows') = 3
      and r -> 'data' -> 'rows' -> 0 ->> 'id' = 'A' and r -> 'data' -> 'rows' -> 2 ->> 'id' = 'C'
      and r -> 'data' -> 'rows' -> 0 ->> 'pack' = 'CS' and r -> 'data' -> 'rows' -> 1 ->> 'area' = 'Dry'
      and r -> 'data' -> 'rows' -> 2 -> 'onHandPrev' = 'null'::jsonb, r -> 'data' -> 'rows' -> 0);

  -- Same-day re-close: replaces that day's rows and clears that day's counts
  perform public.mog_sync_put_counts('zztest2', k, null, '[{"vendor":"Sysco","id":"B","onHand":4}]');
  r := public.mog_sync_close_cycle('zztest2', k, '2026-10-16', '2026-10-16', 'Fri',
         '[{"vendor":"Sysco","id":"B","name":"Cups","qty":1}]',
         '[{"vendor":"Sysco","sentAt":"03:30","itemCount":1,"reference":"ZZ-1016-SYS"}]');
  perform pg_temp.chk('same-day re-close: logs, clears that day''s counts, sets the sent summary',
    (r -> 'data' ->> 'closed')::boolean
      and (select count(*) = 0 from mog.counts where slug = 'zztest2' and cycle_date = '2026-10-16')
      and (select jsonb_array_length(todays_log) = 1 from mog.store_state where slug = 'zztest2'), r);
  perform public.mog_sync_close_cycle('zztest2', k, '2026-10-16', '2026-10-16', 'Fri',
         '[{"vendor":"Amazon","id":"C","name":"Tape","qty":2}]', '[]');
  perform pg_temp.chk('same-day re-close again: that day''s rows are replaced, not added',
    (select count(*) = 1 and min(item_id) = 'C' from mog.order_log where slug = 'zztest2' and cycle_date = '2026-10-16'), null);

  -- Wrong keys on the new functions
  perform pg_temp.chk('close / get_log / sync override refuse a wrong key',
    public.mog_sync_close_cycle('zztest2', 'wrong', '2026-10-16', '2026-10-17', 'Sat', '[]', '[]') ->> 'error' = 'BAD_SYNC_KEY'
      and public.mog_sync_get_log('zztest2', 'wrong', '2026-10-15') ->> 'error' = 'BAD_SYNC_KEY'
      and public.mog_sync_set_override('zztest2', 'wrong', true) ->> 'error' = 'BAD_SYNC_KEY', null);

  delete from mog.stores where slug = 'zztest2';
  perform pg_temp.chk('cleanup: test store, its log and counts removed',
    not exists (select 1 from mog.order_log where slug = 'zztest2')
      and not exists (select 1 from mog.counts where slug = 'zztest2'), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke2
 order by n;
