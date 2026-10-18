-- =====================================================================
-- MOG schema v5 — smoke test (run in the SQL Editor AFTER schema_v5.sql)
-- =====================================================================
-- Throwaway store 'zztest5': presence (who's here, on which vendor, gone
-- after 90s), the self-building name list (case-insensitive, hidden after 30
-- days unused), who saved each count, the two new calls' session and
-- phone_direct rules, and that the old calls are unchanged. Cleans up after
-- itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke5 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke5;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke5 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  k    text;
  r    jsonb;
  ta   text;
  tb   text;
  cat  jsonb := '{"schema":1,"timeZone":"America/New_York","location":"Smoke v5","abbr":"ZZ5","vendorList":["Sysco","Amazon"],"items":{},"pickRows":[]}';
  devA text := 'deviceAAAA1111';
  devB text := 'deviceBBBB2222';
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: public key cannot read the new tables',
    not has_table_privilege('anon', 'mog.presence', 'select') and not has_table_privilege('anon', 'mog.store_people', 'select'), null);
  perform pg_temp.chk('privileges: row level security on both new tables',
    (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('mog.presence'::regclass, 'mog.store_people'::regclass)), null);
  perform pg_temp.chk('privileges: public key cannot call the new internals',
    not has_function_privilege('anon', 'mog.touch_presence(text, text, text, text)', 'execute')
      and not has_function_privilege('anon', 'mog.live_json(text, text)', 'execute'), null);
  perform pg_temp.chk('privileges: public key can call the two new entry points',
    has_function_privilege('anon', 'public.mog_snapshot2(text, bigint, text, text, text)', 'execute')
      and has_function_privilege('anon', 'public.mog_save_counts2(text, date, text, jsonb, text)', 'execute'), null);

  delete from mog.stores where slug = 'zztest5';
  k := mog.provision_store('zztest5');
  perform public.mog_sync_set_pins('zztest5', k, '4321', null);
  perform public.mog_sync_push_catalog('zztest5', k, 1, cat);
  perform public.mog_sync_set_state('zztest5', k, '2026-10-18', 'Sun', false, '{}', '[]', true);
  perform public.mog_sync_set_phone_direct('zztest5', k, true);
  ta := public.mog_login('zztest5', '4321') -> 'data' ->> 'token';
  tb := public.mog_login('zztest5', '4321') -> 'data' ->> 'token';

  -- ---- Presence ----
  r := public.mog_snapshot2(ta, 1, devA, ' Maria ', 'Sysco');
  perform pg_temp.chk('snapshot2: the usual snapshot plus presence, people and activity',
    (r ->> 'ok')::boolean and r -> 'data' -> 'state' ->> 'cycleDate' = '2026-10-18' and r -> 'data' -> 'catalog' = 'null'::jsonb
      and r -> 'data' -> 'presence' = '[]'::jsonb and r -> 'data' -> 'people' = '["Maria"]'::jsonb
      and r -> 'data' -> 'activity' = '[]'::jsonb, r -> 'data');
  perform pg_temp.chk('snapshot2: records the device with its trimmed name and vendor',
    (select name = 'Maria' and vendor = 'Sysco' from mog.presence where slug = 'zztest5' and device_id = devA), null);
  r := public.mog_snapshot2(tb, 1, devB, 'Luis', null);
  perform pg_temp.chk('presence: another device sees Maria on Sysco, just now',
    jsonb_array_length(r -> 'data' -> 'presence') = 1
      and r -> 'data' -> 'presence' -> 0 ->> 'name' = 'Maria' and r -> 'data' -> 'presence' -> 0 ->> 'vendor' = 'Sysco'
      and (r -> 'data' -> 'presence' -> 0 ->> 'secondsAgo')::int between 0 and 5, r -> 'data' -> 'presence');
  r := public.mog_snapshot2(ta, 1, devA, 'Maria', 'Amazon');
  perform pg_temp.chk('presence: a device never sees itself, and sees Luis on no vendor',
    jsonb_array_length(r -> 'data' -> 'presence') = 1 and r -> 'data' -> 'presence' -> 0 ->> 'name' = 'Luis'
      and r -> 'data' -> 'presence' -> 0 -> 'vendor' = 'null'::jsonb, r -> 'data' -> 'presence');
  update mog.presence set seen_at = now() - interval '2 minutes' where slug = 'zztest5' and device_id = devA;
  r := public.mog_snapshot2(tb, 1, devB, 'Luis', null);
  perform pg_temp.chk('presence: a device unseen for 90 seconds is gone',
    r -> 'data' -> 'presence' = '[]'::jsonb, r -> 'data' -> 'presence');
  r := public.mog_snapshot2(tb, 1, 'bad id!', 'Eve', 'Sysco');
  perform pg_temp.chk('presence: a bad device id is ignored, the read still answers',
    (r ->> 'ok')::boolean and not exists (select 1 from mog.presence where slug = 'zztest5' and name = 'Eve')
      and not exists (select 1 from mog.store_people where slug = 'zztest5' and name = 'Eve'), r - 'data');
  r := public.mog_snapshot2(tb, 1, null, null, null);
  perform pg_temp.chk('snapshot2 without a device: reads only, records nothing',
    (r ->> 'ok')::boolean and (select count(*) = 2 from mog.presence where slug = 'zztest5'), r - 'data');
  r := public.mog_snapshot2(tb, 1, devB, '', null);
  perform pg_temp.chk('presence: a skipped name is stored as none (shown as "Someone")',
    (select name is null from mog.presence where slug = 'zztest5' and device_id = devB), null);

  -- ---- The name list ----
  perform public.mog_snapshot2(tb, 1, 'deviceCCCC3333', 'maria', null);
  perform pg_temp.chk('names: one entry per name ignoring case, first spelling kept',
    (select count(*) = 1 from mog.store_people where slug = 'zztest5' and lower(name) = 'maria')
      and exists (select 1 from mog.store_people where slug = 'zztest5' and name = 'Maria'), null);
  perform public.mog_snapshot2(tb, 1, 'deviceDDDD4444', 'Ana', null);
  r := public.mog_snapshot2(tb, 1, devB, null, null);
  perform pg_temp.chk('names: the picker lists them A-Z', r -> 'data' -> 'people' = '["Ana","Luis","Maria"]'::jsonb, r -> 'data' -> 'people');
  update mog.store_people set last_used = now() - interval '31 days' where slug = 'zztest5' and name = 'Ana';
  r := public.mog_snapshot2(tb, 1, devB, null, null);
  perform pg_temp.chk('names: unused for 30 days drops out of the picker, but is not deleted',
    r -> 'data' -> 'people' = '["Luis","Maria"]'::jsonb and exists (select 1 from mog.store_people where slug = 'zztest5' and name = 'Ana'),
    r -> 'data' -> 'people');

  -- ---- Who saved ----
  r := public.mog_save_counts2(ta, '2026-10-18', 'Sysco', '[{"id":"A","onHand":2},{"id":"B","onHand":0}]', 'Maria');
  perform pg_temp.chk('save_counts2: saves like save_counts and records who',
    (r -> 'data' ->> 'saved')::int = 2 and not (r -> 'data' ->> 'stale')::boolean
      and (select count(*) = 2 from mog.counts where slug = 'zztest5' and counted_by = 'Maria'), r);
  r := public.mog_save_counts2(tb, '2026-10-18', 'Amazon', '[{"id":"C","onHand":1}]', null);
  perform pg_temp.chk('save_counts2: no name stores none', (select counted_by is null from mog.counts where slug = 'zztest5' and item_id = 'C'), r);
  r := public.mog_save_counts2(tb, '2026-10-18', 'Sysco', '[{"id":"B","onHand":5}]', 'Luis');
  perform pg_temp.chk('save_counts2: the latest saver of an item wins, others keep theirs',
    (select counted_by = 'Luis' from mog.counts where slug = 'zztest5' and item_id = 'B')
      and (select counted_by = 'Maria' from mog.counts where slug = 'zztest5' and item_id = 'A'), r);
  -- One DO block is one transaction, where now() never moves: age Maria's
  -- save so Luis's is the latest, as separate requests would be.
  update mog.counts set updated_at = now() - interval '1 minute' where slug = 'zztest5' and item_id = 'A';
  r := public.mog_snapshot2(ta, 1, devA, 'Maria', null);
  perform pg_temp.chk('activity: per vendor, who saved the latest count this cycle',
    r -> 'data' -> 'activity' -> 0 ->> 'vendor' = 'Sysco' and r -> 'data' -> 'activity' -> 0 ->> 'by' = 'Luis'
      and jsonb_array_length(r -> 'data' -> 'activity') = 1, r -> 'data' -> 'activity');
  perform public.mog_sync_set_state('zztest5', k, '2026-10-19', 'Mon', false, '{}', '[]', true);
  r := public.mog_snapshot2(ta, 1, devA, 'Maria', null);
  perform pg_temp.chk('activity: a new cycle starts empty', r -> 'data' -> 'activity' = '[]'::jsonb, r -> 'data' -> 'activity');

  -- ---- Old calls unchanged, same rules ----
  r := public.mog_snapshot(ta, 1);
  perform pg_temp.chk('old snapshot: same answer, no presence keys',
    (r ->> 'ok')::boolean and not (r -> 'data' ? 'presence') and not (r -> 'data' ? 'people'), r - 'data');
  r := public.mog_save_counts(ta, '2026-10-19', 'Sysco', '[{"id":"A","onHand":7}]');
  perform pg_temp.chk('old save: still works (no name recorded)',
    (r -> 'data' ->> 'saved')::int = 1
      and (select counted_by is null from mog.counts where slug = 'zztest5' and cycle_date = '2026-10-19' and item_id = 'A'), r);
  perform pg_temp.chk('bad token: both new calls answer SESSION_EXPIRED',
    public.mog_snapshot2('bogus') ->> 'error' = 'SESSION_EXPIRED'
      and public.mog_save_counts2('bogus', '2026-10-19', 'Sysco', '[]') ->> 'error' = 'SESSION_EXPIRED', null);
  perform public.mog_sync_set_phone_direct('zztest5', k, false);
  perform pg_temp.chk('phones off: both new calls answer USE_EXEC and record nothing',
    public.mog_snapshot2(ta, 1, 'deviceEEEE5555', 'Zed', 'Sysco') ->> 'error' = 'USE_EXEC'
      and public.mog_save_counts2(ta, '2026-10-19', 'Sysco', '[{"id":"Z","onHand":1}]', 'Zed') ->> 'error' = 'USE_EXEC'
      and not exists (select 1 from mog.presence where slug = 'zztest5' and device_id = 'deviceEEEE5555')
      and not exists (select 1 from mog.counts where slug = 'zztest5' and item_id = 'Z'), null);

  delete from mog.stores where slug = 'zztest5';
  perform pg_temp.chk('cleanup: presence, names and counts removed with the store',
    not exists (select 1 from mog.presence where slug = 'zztest5')
      and not exists (select 1 from mog.store_people where slug = 'zztest5')
      and not exists (select 1 from mog.counts where slug = 'zztest5'), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke5
 order by n;
