-- =====================================================================
-- MOG schema v3 — smoke test (run in the SQL Editor AFTER schema_v3.sql)
-- =====================================================================
-- Throwaway store 'zztest3': the phone_direct switch on all five PWA
-- functions, the sync setter, and the lockdown of the new helper. Cleans up
-- after itself. Read the result table: every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke3 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke3;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke3 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  k   text;
  r   jsonb;
  tok text;
  cat jsonb := '{"schema":1,"timeZone":"America/New_York","location":"Smoke v3","abbr":"ZZ3","vendorList":["Sysco"],"items":{},"pickRows":[]}';
begin
  -- Lockdown
  perform pg_temp.chk('privileges: public key cannot call the new helper',
    not has_function_privilege('anon', 'mog.phone_direct_on(text)', 'execute'), null);
  perform pg_temp.chk('privileges: public key can call the new entry point',
    has_function_privilege('anon', 'public.mog_sync_set_phone_direct(text, text, boolean)', 'execute'), null);

  delete from mog.stores where slug = 'zztest3';
  k := mog.provision_store('zztest3');
  perform public.mog_sync_set_pins('zztest3', k, '4321', '9999');
  perform public.mog_sync_push_catalog('zztest3', k, 1, cat);
  perform public.mog_sync_set_state('zztest3', k, '2026-10-16', 'Fri', false, '{}', '[]', true);

  -- Off by default: USE_EXEC, and a wrong PIN doesn't count
  perform pg_temp.chk('phone_direct: off for a new store',
    not (select phone_direct from mog.stores where slug = 'zztest3'), null);
  r := public.mog_login('zztest3', '0000');
  perform pg_temp.chk('off: login answers USE_EXEC before checking the PIN',
    r ->> 'error' = 'USE_EXEC' and (select fail_count = 0 from mog.stores where slug = 'zztest3'), r);
  r := public.mog_login('zztest3', '4321');
  perform pg_temp.chk('off: even the right PIN gets no session', r ->> 'error' = 'USE_EXEC'
    and not exists (select 1 from mog.sessions where slug = 'zztest3'), r);
  r := public.mog_login('nosuchstore', '4321');
  perform pg_temp.chk('unknown store still answers Unknown store', r ->> 'error' = 'Unknown store', r);

  -- The sync setter
  r := public.mog_sync_set_phone_direct('zztest3', 'wrong', true);
  perform pg_temp.chk('set_phone_direct: wrong key refused, nothing changed',
    r ->> 'error' = 'BAD_SYNC_KEY' and not (select phone_direct from mog.stores where slug = 'zztest3'), r);
  r := public.mog_sync_set_phone_direct('zztest3', k, true);
  perform pg_temp.chk('set_phone_direct: on', (r -> 'data' ->> 'phoneDirect')::boolean
    and (select phone_direct from mog.stores where slug = 'zztest3'), r);

  -- On: v1 behavior, unchanged
  r := public.mog_login('zztest3', '0000');
  perform pg_temp.chk('on: a wrong PIN counts', r ->> 'error' = 'Invalid PIN'
    and (select fail_count = 1 from mog.stores where slug = 'zztest3'), r);
  r := public.mog_login('zztest3', '4321');
  tok := r -> 'data' ->> 'token';
  perform pg_temp.chk('on: the store PIN signs in with the snapshot, and clears the counter',
    tok is not null and r -> 'data' ->> 'authType' = 'store'
      and r -> 'data' -> 'catalog' ->> 'abbr' = 'ZZ3' and r -> 'data' -> 'state' ->> 'cycleDate' = '2026-10-16'
      and (select fail_count = 0 from mog.stores where slug = 'zztest3'), r - 'data');
  r := public.mog_login('zztest3', '9999');
  perform pg_temp.chk('on: the master PIN signs in as manager',
    (r -> 'data' ->> 'isManagerMode')::boolean, r - 'data');
  r := public.mog_snapshot(tok, 1);
  perform pg_temp.chk('on: snapshot skips a catalog the phone already has',
    (r ->> 'ok')::boolean and r -> 'data' -> 'catalog' = 'null'::jsonb, r - 'data');
  r := public.mog_save_counts(tok, '2026-10-16', 'Sysco', '[{"id":"A","onHand":2}]');
  perform pg_temp.chk('on: save', (r -> 'data' ->> 'saved')::int = 1 and not (r -> 'data' ->> 'stale')::boolean, r);
  r := public.mog_save_counts(tok, '2026-10-15', 'Sysco', '[{"id":"A","onHand":9}]');
  perform pg_temp.chk('on: a save for an old cycle comes back stale and leaves the current cycle alone',
    (r -> 'data' ->> 'stale')::boolean
      and (select on_hand = 2 from mog.counts where slug = 'zztest3' and cycle_date = '2026-10-16' and item_id = 'A'), r);
  r := public.mog_set_override(tok, true);
  perform pg_temp.chk('on: override', (r -> 'data' -> 'state' ->> 'emergencyOverride')::boolean, r -> 'data' -> 'state');
  r := public.mog_set_vendor_pick(tok, 'Sysco', 3);
  perform pg_temp.chk('on: day pick', (r -> 'data' -> 'state' -> 'vendorPicks' ->> 'Sysco')::int = 3, r -> 'data' -> 'state');

  -- Off again: an existing session's every call answers USE_EXEC, and nothing is written
  perform public.mog_sync_set_phone_direct('zztest3', k, false);
  perform pg_temp.chk('off again: snapshot / save / override / pick all answer USE_EXEC',
    public.mog_snapshot(tok) ->> 'error' = 'USE_EXEC'
      and public.mog_save_counts(tok, '2026-10-16', 'Sysco', '[{"id":"A","onHand":7}]') ->> 'error' = 'USE_EXEC'
      and public.mog_set_override(tok, false) ->> 'error' = 'USE_EXEC'
      and public.mog_set_vendor_pick(tok, 'Sysco', 0) ->> 'error' = 'USE_EXEC', null);
  perform pg_temp.chk('off again: nothing was written',
    (select on_hand = 2 from mog.counts where slug = 'zztest3' and cycle_date = '2026-10-16' and item_id = 'A')
      and (select emergency_override and vendor_picks ->> 'Sysco' = '3' from mog.store_state where slug = 'zztest3'), null);
  perform pg_temp.chk('a bad token still answers SESSION_EXPIRED', public.mog_snapshot('bogus') ->> 'error' = 'SESSION_EXPIRED', null);

  delete from mog.stores where slug = 'zztest3';
  perform pg_temp.chk('cleanup: test store, its sessions and counts removed',
    not exists (select 1 from mog.sessions where slug = 'zztest3')
      and not exists (select 1 from mog.counts where slug = 'zztest3'), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke3
 order by n;
