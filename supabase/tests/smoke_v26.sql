-- =====================================================================
-- MOG schema v26 — smoke test (run AFTER schema_v26.sql)
-- =====================================================================
-- HQ → Stores: a new store in one transaction, a store PIN set in HQ, the
-- one manager PIN, and a Sheet's PIN push refused. On throwaway stores
-- 'zztest26' (made the HQ way), 'zztest26t' (a test store) and 'zztest26s'
-- (made the Sheet way, for the PIN push), and two throwaway HQ people.
-- Checks:
--   * mog_hq_stores answers SESSION_EXPIRED without an hq sign-in, and to a
--     warehouse-only person;
--   * create refuses each bad field with what to fix, and a taken or
--     reserved web address, a name already used, the manager PIN;
--   * create makes the whole store: flags, name, cycle (today, its time
--     zone), the empty catalog the phones read, the GM recipient, no Sheet
--     key anyone holds; its PIN signs in; its close is due after midnight;
--   * a store PIN set in HQ: the old PIN fails, the new one works, the
--     store's sign-ins end, who and when are kept;
--   * the manager PIN: every store gets it, it signs in as manager mode, a
--     store made later gets it too, nothing can give one store another one,
--     it can't be a store's PIN and a store PIN can't be it;
--   * mog_sync_set_pins: PINS_IN_HQ once close_direct is on, as before when off;
--   * mog_hq_data shows the new fields;
--   * nothing internal is open to anon.
--
-- Rolls itself back, as smoke_v25 does: every write happens inside one inner
-- block that ends by raising 'mog_smoke26_rollback', which undoes all of it,
-- the manager PIN of every real store included. The results ride out in
-- that error's detail and live in the setting mog.smoke26 for this session
-- only. Every row should say PASS; the last row proves nothing was kept.
-- The PINs here are made up for these throwaway stores; no real store is
-- ever signed in to.
-- =====================================================================

select set_config('mog.smoke26', '[]', false);

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  select set_config('mog.smoke26',
    (current_setting('mog.smoke26')::jsonb || jsonb_build_array(jsonb_build_object(
      'check_name', p_name, 'ok', coalesce(p_ok, false), 'detail', left(coalesce(p_detail::text, ''), 300))))::text,
    false);
$$;

-- The error a create with one field changed answers.
create or replace function pg_temp.bad26(p_tok text, p_row jsonb)
returns text language sql as $$
  select public.mog_hq_stores(p_tok, 'create', p_row) ->> 'error';
$$;

do $$
declare
  tok    text;
  wtok   text;
  good   jsonb := jsonb_build_object('concept', 'roll-play', 'side', 'FOH', 'site', 'ZZ Smoke 26', 'slug', 'zztest26',
                                     'abbr', 'ZZ26F', 'timeZone', 'America/Chicago', 'address', '1 Smoke St',
                                     'pin', '73914', 'gmEmail', 'ZZ.Smoke26@Example.com', 'isTest', false);
  r      jsonb;
  e      text;
  k      text;
  v_tok  text;
  v_mtok text;
  v_n    integer;
  v_mp0  text := (select m.pin_hash from mog.manager_pin m);   -- the live one, if set: it must come back
  v_mp   text;
  v_out  text;
begin
  if exists (select 1 from mog.stores where slug in ('zztest26', 'zztest26t', 'zztest26s'))
     or exists (select 1 from mog.hq_users where name in ('zz smoke 26', 'zz smoke 26w')) then
    raise exception 'smoke_v26: a zztest26 store or a zz smoke 26 HQ person already exists; this file never keeps one, so look before running';
  end if;

  begin
    insert into mog.hq_users (name, roles) values ('zz smoke 26', '{hq}'), ('zz smoke 26w', '{warehouse}');
    tok  := mog.hq_new_session('zz smoke 26')  -> 'data' ->> 'token';
    wtok := mog.hq_new_session('zz smoke 26w') -> 'data' ->> 'token';

    -- ---- Who may ----
    perform pg_temp.chk('hq_stores: no sign-in and a warehouse-only person get SESSION_EXPIRED',
      public.mog_hq_stores('nope', 'create', good) ->> 'error' = 'SESSION_EXPIRED'
        and public.mog_hq_stores(wtok, 'create', good) ->> 'error' = 'SESSION_EXPIRED'
        and not exists (select 1 from mog.stores where slug = 'zztest26'), null);
    perform pg_temp.chk('hq_stores: an unknown action, or no row, is refused',
      public.mog_hq_stores(tok, 'rename', good) ->> 'error' like 'REJECTED: %'
        and public.mog_hq_stores(tok, 'create', null) ->> 'error' = 'REJECTED: nothing to save', null);

    -- ---- Create refuses each bad field ----
    perform pg_temp.chk('create: concept, side, site (length, BOH in it, the concept in it) refused',
      pg_temp.bad26(tok, good || '{"concept": "nue"}') = 'REJECTED: pick the concept'
        and pg_temp.bad26(tok, good || '{"side": "MID"}') = 'REJECTED: pick BOH or FOH'
        and pg_temp.bad26(tok, good || '{"site": "Z"}') like 'REJECTED: the site is 2 to 40%'
        and pg_temp.bad26(tok, good || '{"site": "Smoke BOH"}') like 'REJECTED: leave BOH or FOH out%'
        and pg_temp.bad26(tok, good || '{"site": "roll play Smoke"}') like 'REJECTED: the site is the place only%',
      jsonb_build_object('concept', pg_temp.bad26(tok, good || '{"concept": "nue"}')));
    perform pg_temp.chk('create: web address (dash, capital-free length, reserved), code, time zone refused',
      pg_temp.bad26(tok, good || '{"slug": "zz-26"}') like 'REJECTED: the web address is 2 to 20%'
        and pg_temp.bad26(tok, good || '{"slug": "z"}') like 'REJECTED: the web address is 2 to 20%'
        and pg_temp.bad26(tok, good || '{"slug": "hq"}') = 'REJECTED: the web address hq is taken by the site itself'
        and pg_temp.bad26(tok, good || '{"abbr": "Z"}') like 'REJECTED: the store code%'
        and pg_temp.bad26(tok, good || '{"timeZone": "Mars/Olympus"}') = 'REJECTED: Mars/Olympus isn''t a time zone',
      jsonb_build_object('tz', pg_temp.bad26(tok, good || '{"timeZone": "Mars/Olympus"}')));
    perform pg_temp.chk('create: PIN (short, letters), GM email, long address refused',
      pg_temp.bad26(tok, good || '{"pin": "123"}') = 'REJECTED: the store PIN is 4 to 8 digits'
        and pg_temp.bad26(tok, good || '{"pin": "12ab"}') = 'REJECTED: the store PIN is 4 to 8 digits'
        and pg_temp.bad26(tok, good || '{"gmEmail": "gm at store"}') like 'REJECTED: the GM email%'
        and pg_temp.bad26(tok, good || jsonb_build_object('address', repeat('x', 201))) like 'REJECTED: the address%'
        and not exists (select 1 from mog.stores where slug = 'zztest26'), null);

    -- ---- Create makes the whole store ----
    r := public.mog_hq_stores(tok, 'create', good);
    perform pg_temp.chk('create: ok, named "Roll Play ZZ Smoke 26 FOH", cycle today in Chicago',
      (r ->> 'ok')::boolean and r -> 'data' ->> 'location' = 'Roll Play ZZ Smoke 26 FOH'
        and r -> 'data' ->> 'cycleDate' = to_char((now() at time zone 'America/Chicago')::date, 'YYYY-MM-DD'), r);
    perform pg_temp.chk('create: phones, Manage and the nightly close on; recipients seeded; who made it; no test flag',
      exists (select 1 from mog.stores s where s.slug = 'zztest26' and s.phone_direct and s.editor_direct and s.close_direct
                 and s.recipients_seeded and not s.is_test and s.created_by = 'zz smoke 26' and s.pin_set_by = 'zz smoke 26'
                 and s.pin_set_at is not null and s.concept = 'roll-play' and s.side = 'FOH' and s.abbr = 'ZZ26F'
                 and s.time_zone = 'America/Chicago' and s.address = '1 Smoke St' and s.sheet_trigger_off_at is null
                 and s.sync_key_hash ~ '^[0-9a-f]{64}$'), null);
    perform pg_temp.chk('create: the empty catalog the phones read, with its name and time zone',
      exists (select 1 from mog.catalog c where c.slug = 'zztest26'
                 and c.payload ->> 'location' = 'Roll Play ZZ Smoke 26 FOH' and c.payload ->> 'timeZone' = 'America/Chicago'
                 and c.payload -> 'items' = '{}'::jsonb)
        and not exists (select 1 from mog.items i where i.slug = 'zztest26'), null);
    perform pg_temp.chk('create: the GM is the one recipient, active, email in lower case',
      (select count(*) from mog.recipients x where x.slug = 'zztest26') = 1
        and exists (select 1 from mog.recipients x where x.slug = 'zztest26' and x.gm and x.active and x.name = 'GM'
                       and x.email = 'zz.smoke26@example.com'), null);
    perform pg_temp.chk('create: the same web address again, or the same name, is refused',
      pg_temp.bad26(tok, good || '{"site": "ZZ Smoke 26b"}') = 'REJECTED: the web address zztest26 is taken'
        and pg_temp.bad26(tok, good || '{"slug": "zztest26b"}') = 'REJECTED: there''s already a store called Roll Play ZZ Smoke 26 FOH', null);

    r := public.mog_login('zztest26', '73914');
    v_tok := r -> 'data' ->> 'token';
    perform pg_temp.chk('create: its PIN signs in as the store, on its cycle',
      (r ->> 'ok')::boolean and r -> 'data' ->> 'authType' = 'store'
        and r -> 'data' -> 'state' ->> 'cycleDate' = to_char((now() at time zone 'America/Chicago')::date, 'YYYY-MM-DD'), r - 'data');
    perform pg_temp.chk('create: its close is due after midnight (Chicago), not now',
      exists (select 1 from jsonb_array_elements(mog.night_due(now() + interval '1 day')) x
               where x ->> 'slug' = 'zztest26' and x ->> 'step' = 'close')
        and not exists (select 1 from jsonb_array_elements(mog.night_due(now())) x where x ->> 'slug' = 'zztest26'), null);

    r := public.mog_hq_stores(tok, 'create', good || '{"slug": "zztest26t", "abbr": "ZZ26T", "isTest": true, "gmEmail": "", "address": " "}');
    perform pg_temp.chk('create: a test store gets "(TEST)", no recipient, no address',
      (r ->> 'ok')::boolean and r -> 'data' ->> 'location' = 'Roll Play ZZ Smoke 26 FOH (TEST)'
        and exists (select 1 from mog.stores s where s.slug = 'zztest26t' and s.is_test and s.address is null)
        and not exists (select 1 from mog.recipients x where x.slug = 'zztest26t'), r);

    -- ---- A store PIN set in HQ ----
    r := public.mog_hq_stores(tok, 'pin', '{"slug": "zztest26", "pin": "1234567"}');
    perform pg_temp.chk('pin: set, and the store''s sign-ins end',
      (r ->> 'ok')::boolean and (r -> 'data' ->> 'signedOut')::int >= 1
        and not exists (select 1 from mog.sessions x where x.slug = 'zztest26'), r);
    perform pg_temp.chk('pin: the old PIN fails, the new one signs in',
      public.mog_login('zztest26', '73914') ->> 'error' = 'Invalid PIN'
        and public.mog_login('zztest26', '1234567') -> 'data' ->> 'authType' = 'store', null);
    perform pg_temp.chk('pin: refused for a short PIN and for no such store',
      public.mog_hq_stores(tok, 'pin', '{"slug": "zztest26", "pin": "12"}') ->> 'error' = 'REJECTED: the store PIN is 4 to 8 digits'
        and public.mog_hq_stores(tok, 'pin', '{"slug": "zznostore26", "pin": "1234"}') ->> 'error' like 'REJECTED: there''s no store%', null);

    -- ---- The one manager PIN ----
    r := public.mog_hq_stores(tok, 'managerPin', '{"pin": "1234567"}');
    perform pg_temp.chk('manager PIN: refused when it''s a store''s PIN, naming the store',
      r ->> 'error' = 'REJECTED: that''s the store PIN at Roll Play ZZ Smoke 26 FOH: the manager PIN must differ from every store''s PIN', r);
    r := public.mog_login('zztest26', '1234567');
    r := public.mog_hq_stores(tok, 'managerPin', '{"pin": "86420975"}');
    v_mp := (select m.pin_hash from mog.manager_pin m);
    perform pg_temp.chk('manager PIN: set at every store, one hash, who and when kept',
      (r ->> 'ok')::boolean and (r -> 'data' ->> 'stores')::int = (select count(*) from mog.stores)
        and not exists (select 1 from mog.stores s where s.master_pin_hash is distinct from v_mp)
        and exists (select 1 from mog.manager_pin m where m.set_by = 'zz smoke 26'), r);
    v_mtok := public.mog_login('zztest26', '86420975') -> 'data' ->> 'token';
    perform pg_temp.chk('manager PIN: it signs in as manager mode, and the store PIN still as the store',
      exists (select 1 from mog.sessions x where x.slug = 'zztest26' and x.auth_type = 'master' and x.token_hash = mog.sha256_hex(v_mtok))
        and public.mog_login('zztest26', '1234567') -> 'data' ->> 'authType' = 'store', null);
    perform pg_temp.chk('manager PIN: a store PIN can''t be it (pin and create)',
      public.mog_hq_stores(tok, 'pin', '{"slug": "zztest26", "pin": "86420975"}') ->> 'error' = 'REJECTED: that''s the manager PIN: a store PIN must be different'
        and pg_temp.bad26(tok, good || '{"slug": "zztest26b", "site": "ZZ Smoke 26b", "pin": "86420975"}') = 'REJECTED: that''s the manager PIN: a store PIN must be different', null);
    update mog.stores set master_pin_hash = extensions.crypt('5555', extensions.gen_salt('bf', 4)) where slug = 'zztest26';
    k := mog.provision_store('zztest26s');
    perform pg_temp.chk('manager PIN: locked: a direct write, and a store the Sheet way, get the one PIN',
      (select s.master_pin_hash from mog.stores s where s.slug = 'zztest26') = v_mp
        and (select s.master_pin_hash from mog.stores s where s.slug = 'zztest26s') = v_mp, null);
    r := public.mog_hq_stores(tok, 'managerPin', '{"pin": "97531864"}');
    perform pg_temp.chk('manager PIN: changing it ends manager-mode sign-ins, not the store''s',
      (r ->> 'ok')::boolean and (r -> 'data' ->> 'signedOut')::int >= 1
        and not exists (select 1 from mog.sessions x where x.auth_type = 'master')
        and exists (select 1 from mog.sessions x where x.slug = 'zztest26' and x.auth_type = 'store')
        and public.mog_login('zztest26', '86420975') ->> 'error' = 'Invalid PIN'
        and public.mog_login('zztest26', '97531864') -> 'data' ->> 'authType' = 'master', r);

    -- ---- A Sheet's PIN push ----
    r := public.mog_sync_set_pins('zztest26s', k, '2468', null);
    perform pg_temp.chk('sheet pins: still set while close_direct is off (the manager PIN stays the one)',
      (r ->> 'ok')::boolean and (select s.master_pin_hash from mog.stores s where s.slug = 'zztest26s') = (select m.pin_hash from mog.manager_pin m), r);
    update mog.stores set close_direct = true where slug = 'zztest26s';
    e := public.mog_sync_set_pins('zztest26s', k, '1357', null) ->> 'error';
    perform pg_temp.chk('sheet pins: PINS_IN_HQ once close_direct is on, the PIN unchanged',
      e = 'PINS_IN_HQ' and (select extensions.crypt('2468', s.pin_hash) = s.pin_hash from mog.stores s where s.slug = 'zztest26s'),
      jsonb_build_object('error', e));
    perform pg_temp.chk('sheet pins: a bogus key is still BAD_SYNC_KEY first',
      public.mog_sync_set_pins('zztest26s', 'bogus', '1357', null) ->> 'error' = 'BAD_SYNC_KEY', null);

    -- ---- HQ's data ----
    r := public.mog_hq_data(tok) -> 'data';
    perform pg_temp.chk('hq_data: the manager PIN''s state, at every store',
      r -> 'managerPin' ->> 'setBy' = 'zz smoke 26' and (r -> 'managerPin' ->> 'everyStore')::boolean, r -> 'managerPin');
    perform pg_temp.chk('hq_data: a store made in HQ, with its PIN record, flags, time zone, address and recap count',
      exists (select 1 from jsonb_array_elements(r -> 'stores') x
               where x ->> 'slug' = 'zztest26' and x ->> 'createdBy' = 'zz smoke 26' and x ->> 'pinSetBy' = 'zz smoke 26'
                 and (x ->> 'hasPin')::boolean and (x ->> 'closeDirect')::boolean and (x ->> 'phoneDirect')::boolean
                 and x ->> 'timeZone' = 'America/Chicago' and x ->> 'address' = '1 Smoke St'
                 and (x ->> 'recipients')::int = 1 and (x ->> 'managerPin')::boolean and x -> 'tables' is not null),
      (select x from jsonb_array_elements(r -> 'stores') x where x ->> 'slug' = 'zztest26'));
    perform pg_temp.chk('hq_data: a warehouse-only person is still refused',
      public.mog_hq_data(wtok) ->> 'error' = 'SESSION_EXPIRED', null);

    -- ---- Privileges ----
    perform pg_temp.chk('anon: mog_hq_stores open; the rules, the manager PIN table and the trigger closed',
      has_function_privilege('anon', 'public.mog_hq_stores(text, text, jsonb)', 'execute')
        and has_function_privilege('anon', 'public.mog_hq_data(text)', 'execute')
        and has_function_privilege('anon', 'public.mog_sync_set_pins(text, text, text, text)', 'execute')
        and not has_function_privilege('anon', 'mog.store_create(text, jsonb)', 'execute')
        and not has_function_privilege('anon', 'mog.store_set_pin(text, text, text)', 'execute')
        and not has_function_privilege('anon', 'mog.manager_pin_set(text, text)', 'execute')
        and not has_function_privilege('anon', 'mog.is_manager_pin(text)', 'execute')
        and not has_function_privilege('anon', 'mog.stores_manager_pin()', 'execute')
        and not has_table_privilege('anon', 'mog.manager_pin', 'select'), null);

    -- Undo every write above; the results leave in the error's detail.
    raise exception 'mog_smoke26_rollback' using detail = current_setting('mog.smoke26');
  exception when raise_exception then
    if sqlerrm <> 'mog_smoke26_rollback' then raise; end if;
    get stacked diagnostics v_out = pg_exception_detail;
    perform set_config('mog.smoke26', v_out, false);
  end;

  perform pg_temp.chk('rollback: nothing kept (stores, state, catalog, recipients, HQ people, the manager PIN as it was)',
    not exists (select 1 from mog.stores where slug like 'zztest26%')
      and not exists (select 1 from mog.store_state where slug like 'zztest26%')
      and not exists (select 1 from mog.catalog where slug like 'zztest26%')
      and not exists (select 1 from mog.recipients where slug like 'zztest26%')
      and not exists (select 1 from mog.hq_users where name like 'zz smoke 26%')
      and (select m.pin_hash from mog.manager_pin m) is not distinct from v_mp0, null);
end;
$$;

select e.n::int as n, case when (e.c ->> 'ok')::boolean then 'PASS' else 'FAIL' end as result,
       e.c ->> 'check_name' as check_name, e.c ->> 'detail' as detail
  from jsonb_array_elements(current_setting('mog.smoke26')::jsonb) with ordinality as e(c, n)
 order by e.n;
