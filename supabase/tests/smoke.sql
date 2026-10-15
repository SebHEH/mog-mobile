-- =====================================================================
-- MOG schema v1 — smoke test
-- =====================================================================
-- Run in the Supabase SQL Editor AFTER schema.sql. It creates a throwaway
-- store 'zztest', exercises every function, then deletes the store again.
-- Read the result table: every row should say PASS.
--
-- This runs as `postgres`, so it tests the LOGIC, not the permissions. The
-- permission side (public key locked out of tables, bad credentials
-- rejected) is checked separately over the API.
-- =====================================================================

create temp table if not exists mog_smoke (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  k    text;
  r    jsonb;
  tok  text;
  tok2 text;
  i    integer;
  cat  jsonb := '{"schema":1,"timeZone":"America/New_York","location":"Smoke Test","vendors":[],"items":{},"pickRows":[]}';
begin
  -- Lockdown, checked from the catalog. (The editor's "no RLS" warning only
  -- reads the CREATE TABLE lines; schema.sql turns RLS on right after.)
  perform pg_temp.chk('rls: on for all 5 mog tables',
    (select count(*) = 5 and bool_and(c.relrowsecurity)
       from pg_class c where c.relnamespace = 'mog'::regnamespace and c.relkind = 'r'), null);
  perform pg_temp.chk('privileges: public key has no access to schema mog',
    not has_schema_privilege('anon', 'mog', 'usage'), null);
  perform pg_temp.chk('privileges: public key can call mog_login',
    has_function_privilege('anon', 'public.mog_login(text, text)', 'execute'), null);
  perform pg_temp.chk('privileges: public key cannot call internal helpers',
    not has_function_privilege('anon', 'mog.upsert_counts(text, date, text, jsonb)', 'execute')
      and not has_function_privilege('anon', 'mog.provision_store(text)', 'execute'), null);

  delete from mog.stores where slug = 'zztest';
  k := mog.provision_store('zztest');

  -- Sync key
  r := public.mog_sync_push_catalog('zztest', 'not-the-key', 1, cat);
  perform pg_temp.chk('sync: wrong key rejected', r ->> 'error' = 'BAD_SYNC_KEY', r);

  -- PINs
  r := public.mog_sync_set_pins('zztest', k, '4321', '9999');
  perform pg_temp.chk('pins: first push stores hashes', (r -> 'data' ->> 'changed')::boolean, r);
  r := public.mog_sync_set_pins('zztest', k, '4321', '9999');
  perform pg_temp.chk('pins: same PINs again = no change', not (r -> 'data' ->> 'changed')::boolean, r);

  -- Not synced yet: a correct PIN still gets no session
  r := public.mog_login('zztest', '4321');
  perform pg_temp.chk('login: before catalog = STORE_NOT_SYNCED', r ->> 'error' = 'STORE_NOT_SYNCED', r);

  -- Catalog versions
  r := public.mog_sync_push_catalog('zztest', k, 100, cat);
  perform pg_temp.chk('catalog: push v100 applied', (r -> 'data' ->> 'applied')::boolean, r);
  r := public.mog_sync_push_catalog('zztest', k, 50, cat || '{"location":"STALE"}');
  perform pg_temp.chk('catalog: older v50 ignored', not (r -> 'data' ->> 'applied')::boolean, r);
  perform pg_temp.chk('catalog: still v100 / not overwritten',
    (select version = 100 and payload ->> 'location' = 'Smoke Test' from mog.catalog where slug = 'zztest'), null);

  -- State
  r := public.mog_sync_set_state('zztest', k, '2026-10-15', 'Thu', false, '{}', '[]', true);
  perform pg_temp.chk('state: set cycle 2026-10-15', (r ->> 'ok')::boolean, r);
  r := public.mog_sync_set_state('zztest', k, '2026-10-15', 'Thursday', false, '{}', '[]', false);
  perform pg_temp.chk('state: bad day name rejected', not (r ->> 'ok')::boolean, r);

  -- Sign in
  r := public.mog_login('zztest', '0000');
  perform pg_temp.chk('login: wrong PIN rejected', r ->> 'error' = 'Invalid PIN', r);
  r := public.mog_login('zztest', '4321');
  tok := r -> 'data' ->> 'token';
  perform pg_temp.chk('login: store PIN ok, token + snapshot in one call',
    (r ->> 'ok')::boolean and tok is not null and r -> 'data' ->> 'authType' = 'store'
      and (r -> 'data' ->> 'catalogVersion')::bigint = 100
      and r -> 'data' -> 'state' ->> 'cycleDate' = '2026-10-15', r - 'data');
  perform pg_temp.chk('login: wrong-PIN counter cleared on success',
    (select fail_count = 0 from mog.stores where slug = 'zztest'), null);
  r := public.mog_login('ZZTEST ', '9999');
  tok2 := r -> 'data' ->> 'token';
  perform pg_temp.chk('login: master PIN = manager mode (slug case/space tolerant)',
    (r -> 'data' ->> 'isManagerMode')::boolean, r - 'data');

  -- Snapshot
  r := public.mog_snapshot('bogus-token');
  perform pg_temp.chk('snapshot: bad token = SESSION_EXPIRED', r ->> 'error' = 'SESSION_EXPIRED', r);
  r := public.mog_snapshot(tok, 100);
  perform pg_temp.chk('snapshot: current catalog version is skipped',
    (r ->> 'ok')::boolean and r -> 'data' -> 'catalog' = 'null'::jsonb, r -> 'data' -> 'state');
  r := public.mog_snapshot(tok, 99);
  perform pg_temp.chk('snapshot: older catalog version is resent',
    r -> 'data' -> 'catalog' ->> 'location' = 'Smoke Test', null);

  -- Saving counts
  r := public.mog_save_counts(tok, '2026-10-15', 'Vendor One', '[
        {"id":"A","onHand":2}, {"id":"B","onHand":"1.5"}, {"id":"A","onHand":3},
        {"id":"C","onHand":""}, {"id":"","onHand":1}, {"id":"D","onHand":"abc"}]');
  perform pg_temp.chk('save: 4 rows (dup id collapsed, blank id skipped)',
    (r -> 'data' ->> 'saved')::int = 4 and not (r -> 'data' ->> 'stale')::boolean, r);
  perform pg_temp.chk('save: last duplicate wins (A = 3)',
    (select on_hand = 3 from mog.counts where slug = 'zztest' and item_id = 'A'), null);
  perform pg_temp.chk('save: numeric string parsed (B = 1.5)',
    (select on_hand = 1.5 from mog.counts where slug = 'zztest' and item_id = 'B'), null);
  perform pg_temp.chk('save: blank and junk become a cleared count',
    (select count(*) = 2 from mog.counts where slug = 'zztest' and item_id in ('C', 'D') and on_hand is null), null);
  r := public.mog_save_counts(tok, '2026-10-14', 'Vendor One', '[{"id":"A","onHand":9}]');
  perform pg_temp.chk('save: old cycle date flagged stale', (r -> 'data' ->> 'stale')::boolean, r);
  r := public.mog_snapshot(tok, 100);
  perform pg_temp.chk('save: stale save did not touch this cycle (A still 3)',
    jsonb_array_length(r -> 'data' -> 'counts') = 4
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'counts') e
                   where e ->> 'id' = 'A' and (e ->> 'onHand')::numeric = 3), r -> 'data' -> 'counts');
  r := public.mog_save_counts(tok, '2026-10-15', '  ', '[]');
  perform pg_temp.chk('save: blank vendor rejected', r ->> 'error' = 'Vendor is required.', r);

  -- Emergency Override and day picks
  r := public.mog_set_override(tok, true, 100);
  perform pg_temp.chk('override: on, fresh snapshot returned',
    (r -> 'data' -> 'state' ->> 'emergencyOverride')::boolean, r -> 'data' -> 'state');
  r := public.mog_set_vendor_pick(tok, 'Vendor One', 3, 100);
  perform pg_temp.chk('pick: Vendor One = 3', (r -> 'data' -> 'state' -> 'vendorPicks' ->> 'Vendor One')::int = 3, r -> 'data' -> 'state');
  r := public.mog_set_vendor_pick(tok, 'Vendor One', 8, 100);
  perform pg_temp.chk('pick: 8 rejected', not (r ->> 'ok')::boolean, r);
  r := public.mog_set_vendor_pick(tok, 'Vendor One', 0, 100);
  perform pg_temp.chk('pick: 0 clears it', r -> 'data' -> 'state' -> 'vendorPicks' = '{}'::jsonb, r -> 'data' -> 'state');
  r := public.mog_set_vendor_pick(tok, 'Vendor One', 2, 100);
  r := public.mog_set_override(tok, false, 100);
  perform pg_temp.chk('override: off clears the picks too',
    not (r -> 'data' -> 'state' ->> 'emergencyOverride')::boolean
      and r -> 'data' -> 'state' -> 'vendorPicks' = '{}'::jsonb, r -> 'data' -> 'state');

  -- Apps Script side: copy-back, import, reset
  r := public.mog_sync_get_cycle('zztest', k);
  perform pg_temp.chk('sync: get_cycle returns this cycle''s 4 counts',
    jsonb_array_length(r -> 'data' -> 'counts') = 4, r -> 'data' -> 'state');
  r := public.mog_sync_put_counts('zztest', k, '2026-10-15', '[{"vendor":"Vendor Two","id":"Z","onHand":1}]');
  perform pg_temp.chk('sync: put_counts with per-row vendor', (r -> 'data' ->> 'saved')::int = 1, r);
  r := public.mog_sync_set_state('zztest', k, '2026-10-15', 'Thu', false, '{}', '[]', true);
  perform pg_temp.chk('reset: same-day re-reset clears this cycle''s counts',
    (select count(*) = 0 from mog.counts where slug = 'zztest' and cycle_date = '2026-10-15'), null);
  perform pg_temp.chk('reset: older cycle kept as evidence',
    (select count(*) = 1 from mog.counts where slug = 'zztest' and cycle_date = '2026-10-14'), null);

  -- A real PIN change signs every phone out
  r := public.mog_sync_set_pins('zztest', k, '5555', '9999');
  r := public.mog_snapshot(tok);
  perform pg_temp.chk('pins: change revokes existing sessions', r ->> 'error' = 'SESSION_EXPIRED', r);
  r := public.mog_login('zztest', '4321');
  perform pg_temp.chk('pins: old PIN no longer works', r ->> 'error' = 'Invalid PIN', r);

  -- Lockout: 5 wrong tries, then even the right PIN waits; expiry restores
  update mog.stores set fail_count = 0, locked_until = null where slug = 'zztest';
  for i in 1..4 loop
    r := public.mog_login('zztest', '0000');
  end loop;
  perform pg_temp.chk('lockout: 4th wrong PIN is still just invalid', r ->> 'error' = 'Invalid PIN', r);
  r := public.mog_login('zztest', '0000');
  perform pg_temp.chk('lockout: 5th wrong PIN locks', (r ->> 'lockout')::boolean, r);
  r := public.mog_login('zztest', '5555');
  perform pg_temp.chk('lockout: right PIN refused while locked', r ->> 'error' = 'Too many attempts', r);
  update mog.stores set locked_until = now() - interval '1 second' where slug = 'zztest';
  r := public.mog_login('zztest', '5555');
  perform pg_temp.chk('lockout: expired lock allows the right PIN', (r ->> 'ok')::boolean, r - 'data');

  -- Unknown store
  r := public.mog_login('nosuchstore', '1234');
  perform pg_temp.chk('login: unknown store rejected', r ->> 'error' = 'Unknown store', r);

  delete from mog.stores where slug = 'zztest';
  perform pg_temp.chk('cleanup: test store and its rows removed',
    not exists (select 1 from mog.counts where slug = 'zztest')
      and not exists (select 1 from mog.sessions where slug = 'zztest'), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke
 order by n;
