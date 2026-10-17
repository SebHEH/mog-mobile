-- =====================================================================
-- MOG schema v4 — smoke test (run in the SQL Editor AFTER schema_v4.sql)
-- =====================================================================
-- Throwaway stores 'zztest4', 'zztest4b' and test copy 'zztest4copy': the
-- catalog tables and their rules, the catalog JSON built from them, the
-- seed, the push refusal once editor_direct is on, the status call, and the
-- test-store copy. Cleans up after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke4 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke4;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke4 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  k     text;
  kb    text;
  r     jsonb;
  ok    boolean;
  tbl   jsonb := $j${
    "profile": {"timeZone": "America/New_York", "location": "Smoke v4", "abbr": "ZZ4", "concept": "roll-play"},
    "vendors": [
      {"name": "Sysco",  "mults": [1, 0, 1, 0, 2, 0, 0], "cutoff": "14:00"},
      {"name": "Amazon", "mults": [1.5, 0, 0, 0, 0, 0, 0], "cutoff": null},
      {"name": "B&T"}
    ],
    "areas": [ {"name": "Walk-in", "ord": 10}, {"name": "Dry Storage", "ord": 20} ],
    "items": [
      {"id": "ITEM-0001", "name": "Chicken Thigh", "primaryVendor": "Sysco", "pack": "CS", "par": 3,
       "active": true, "useMult": true, "notes": "keep cold", "sku": "SY-1", "category": "Protein",
       "eligible": ["Sysco", "B&T"], "seq": 1},
      {"id": "ITEM-0002", "name": "Tape", "primaryVendor": "Amazon", "pack": "PACK (3)", "par": 0.33,
       "active": true, "useMult": false, "eligible": ["Amazon"], "seq": 2},
      {"id": "ITEM-0003", "name": "Old Thing", "primaryVendor": "Sysco", "par": null,
       "active": false, "useMult": true, "seq": 3},
      {"id": "ITEM-0004", "name": "No Vendor", "primaryVendor": null, "par": 2, "active": true, "seq": 4}
    ],
    "pickRows": [
      {"vendor": "Sysco",  "id": "ITEM-0001", "area": "Walk-in",     "shelfOrder": 10,   "seq": 1},
      {"vendor": "B&T",    "id": "ITEM-0001", "area": "Walk-in",     "shelfOrder": 20,   "seq": 2},
      {"vendor": "Amazon", "id": "ITEM-0002", "area": "Dry Storage", "shelfOrder": null, "seq": 3},
      {"vendor": "Sysco",  "id": "ITEM-0003", "area": "Walk-in",     "shelfOrder": 30,   "seq": 4},
      {"vendor": "Amazon", "id": "ITEM-0004", "area": null,          "shelfOrder": 5,    "seq": 5}
    ]
  }$j$;
  expected jsonb := $j${
    "schema": 1, "timeZone": "America/New_York", "location": "Smoke v4", "abbr": "ZZ4", "concept": "roll-play",
    "vendorList": ["Amazon", "B&T", "Sysco"],
    "vendorMults": {
      "Sysco":  {"Mon": 1,   "Tue": 0, "Wed": 1, "Thu": 0, "Fri": 2, "Sat": 0, "Sun": 0},
      "Amazon": {"Mon": 1.5, "Tue": 0, "Wed": 0, "Thu": 0, "Fri": 0, "Sat": 0, "Sun": 0},
      "B&T":    {"Mon": 0,   "Tue": 0, "Wed": 0, "Thu": 0, "Fri": 0, "Sat": 0, "Sun": 0}
    },
    "cutoffs": {"Sysco": "14:00", "Amazon": null, "B&T": null},
    "items": {
      "ITEM-0001": {"useMult": true,  "par": 3,    "name": "Chicken Thigh", "pack": "CS",       "primaryVendor": "Sysco",  "active": true},
      "ITEM-0002": {"useMult": false, "par": 0.33, "name": "Tape",          "pack": "PACK (3)", "primaryVendor": "Amazon", "active": true},
      "ITEM-0003": {"useMult": true,  "par": null, "name": "Old Thing",     "pack": "",         "primaryVendor": "Sysco",  "active": false},
      "ITEM-0004": {"useMult": true,  "par": 2,    "name": "No Vendor",     "pack": "",         "primaryVendor": "",       "active": true}
    },
    "pickRows": [
      ["Sysco",  "ITEM-0001", "Chicken Thigh", "Walk-in",     10,   10],
      ["B&T",    "ITEM-0001", "Chicken Thigh", "Walk-in",     10,   20],
      ["Amazon", "ITEM-0002", "Tape",          "Dry Storage", 20,   null],
      ["Sysco",  "ITEM-0003", "Old Thing",     "Walk-in",     10,   30],
      ["Amazon", "ITEM-0004", "No Vendor",     "",            null, 5]
    ],
    "itemCounts":   {"Sysco": 1, "Amazon": 1},
    "backupCounts": {"B&T": 1, "Amazon": 1}
  }$j$;
  -- Computed in Node with a.localeCompare(b) (en-US ICU), the sort the app uses.
  tricky   jsonb := '["Restaurant Depot","Zeta","amazon","B&T","_misc","Chef Center 2","Murray''s Chicken","Bt Foods","Ăn Supply","1st Choice","TNY Warehouse","chef center","tny-warehouse2","Amazon Fresh","Murray Farms"]';
  js_order jsonb := '["_misc","1st Choice","amazon","Amazon Fresh","Ăn Supply","B&T","Bt Foods","chef center","Chef Center 2","Murray Farms","Murray''s Chicken","Restaurant Depot","TNY Warehouse","tny-warehouse2","Zeta"]';
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: public key cannot read or write the catalog tables',
    not has_table_privilege('anon', 'mog.vendors', 'select') and not has_table_privilege('anon', 'mog.areas', 'select')
      and not has_table_privilege('anon', 'mog.items', 'select') and not has_table_privilege('anon', 'mog.pick_rows', 'select')
      and not has_table_privilege('anon', 'mog.items', 'insert'), null);
  perform pg_temp.chk('privileges: row level security on all four tables',
    (select bool_and(c.relrowsecurity) from pg_class c
      where c.oid in ('mog.vendors'::regclass, 'mog.areas'::regclass, 'mog.items'::regclass, 'mog.pick_rows'::regclass)), null);
  perform pg_temp.chk('privileges: public key cannot call the internals',
    not has_function_privilege('anon', 'mog.catalog_from_tables(text)', 'execute')
      and not has_function_privilege('anon', 'mog.replace_catalog_tables(text, jsonb)', 'execute')
      and not has_function_privilege('anon', 'mog.copy_store_catalog(text, text)', 'execute'), null);
  perform pg_temp.chk('privileges: public key can call the three entry points',
    has_function_privilege('anon', 'public.mog_sync_seed_catalog(text, text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_sync_get_status(text, text)', 'execute')
      and has_function_privilege('anon', 'public.mog_sync_push_catalog(text, text, bigint, jsonb)', 'execute'), null);

  delete from mog.stores where slug in ('zztest4', 'zztest4b', 'zztest4copy');
  k  := mog.provision_store('zztest4');
  kb := mog.provision_store('zztest4b');
  perform public.mog_sync_set_pins('zztest4', k, '4321', null);
  perform pg_temp.chk('switches: editor_direct and is_test off for a new store',
    (select not editor_direct and not is_test from mog.stores where slug = 'zztest4'), null);

  -- ---- Seed ----
  r := public.mog_sync_seed_catalog('zztest4', 'wrong', tbl);
  perform pg_temp.chk('seed: wrong key refused, nothing written',
    r ->> 'error' = 'BAD_SYNC_KEY' and not exists (select 1 from mog.vendors where slug = 'zztest4'), r);

  r := public.mog_sync_seed_catalog('zztest4', k, tbl);
  perform pg_temp.chk('seed: accepted, with row counts',
    (r ->> 'ok')::boolean and r -> 'data' -> 'seeded' = '{"vendors":3,"areas":2,"items":4,"pickRows":5}'::jsonb, r - 'data');
  perform pg_temp.chk('seed: the catalog JSON it returns is exactly the expected payload',
    r -> 'data' -> 'catalog' = expected, r -> 'data' -> 'catalog');
  perform pg_temp.chk('catalog_from_tables gives the same JSON on its own',
    mog.catalog_from_tables('zztest4') = expected, null);
  perform pg_temp.chk('catalog_from_tables: unknown store gives null', mog.catalog_from_tables('nosuchstore') is null, null);
  perform pg_temp.chk('seed: fields the JSON leaves out are stored (eligible, notes, sku, category, seq)',
    (select eligible_vendors = '{Sysco,B&T}' and notes = 'keep cold' and sku = 'SY-1' and category = 'Protein' and seq = 1
       from mog.items where slug = 'zztest4' and item_id = 'ITEM-0001')
      and (select eligible_vendors = '{}' and notes = '' from mog.items where slug = 'zztest4' and item_id = 'ITEM-0004'), null);
  perform pg_temp.chk('seed: profile stored on the store',
    (select time_zone = 'America/New_York' and location = 'Smoke v4' and abbr = 'ZZ4' and concept = 'roll-play'
       from mog.stores where slug = 'zztest4'), null);

  r := public.mog_sync_seed_catalog('zztest4b', kb, jsonb_build_object('vendors',
         (select jsonb_agg(jsonb_build_object('name', t.x)) from jsonb_array_elements_text(tricky) t(x)),
         'areas', '[]'::jsonb, 'items', '[]'::jsonb, 'pickRows', '[]'::jsonb));
  perform pg_temp.chk('vendorList sorts exactly like JS localeCompare',
    r -> 'data' -> 'catalog' -> 'vendorList' = js_order, r -> 'data' -> 'catalog' -> 'vendorList');
  perform pg_temp.chk('an empty catalog builds with empty lists and the default profile',
    r -> 'data' -> 'catalog' -> 'items' = '{}'::jsonb and r -> 'data' -> 'catalog' -> 'pickRows' = '[]'::jsonb
      and r -> 'data' -> 'catalog' -> 'itemCounts' = '{}'::jsonb and r -> 'data' -> 'catalog' ->> 'location' = 'Unknown'
      and r -> 'data' -> 'catalog' ->> 'timeZone' = 'America/New_York', r -> 'data' -> 'catalog');

  -- ---- Bad data rejects the whole seed and keeps the previous tables ----
  r := public.mog_sync_seed_catalog('zztest4', k, jsonb_set(tbl, '{pickRows,0,vendor}', '"Ghost"'));
  perform pg_temp.chk('rule: a pick row for a vendor that isn''t listed rejects the seed',
    r ->> 'error' like 'SEED_REJECTED:%', r);
  perform pg_temp.chk('rule: ... and the previous tables are untouched',
    (select count(*) = 3 from mog.vendors where slug = 'zztest4') and (select count(*) = 5 from mog.pick_rows where slug = 'zztest4')
      and mog.catalog_from_tables('zztest4') = expected, null);
  r := public.mog_sync_seed_catalog('zztest4', k, jsonb_set(tbl, '{vendors,1,name}', '"SYSCO"'));
  perform pg_temp.chk('rule: two vendors differing only in case are refused', r ->> 'error' like 'SEED_REJECTED:%', r);
  r := public.mog_sync_seed_catalog('zztest4', k, jsonb_set(tbl, '{items,0,primaryVendor}', '"Ghost"'));
  perform pg_temp.chk('rule: an item whose primary vendor isn''t listed is refused', r ->> 'error' like 'SEED_REJECTED:%', r);
  r := public.mog_sync_seed_catalog('zztest4', k, jsonb_set(tbl, '{pickRows,0,area}', '"Freezer"'));
  perform pg_temp.chk('rule: a pick row in a storage area that doesn''t exist is refused', r ->> 'error' like 'SEED_REJECTED:%', r);
  r := public.mog_sync_seed_catalog('zztest4', k, jsonb_set(tbl, '{pickRows,1,vendor}', '"Sysco"'));
  perform pg_temp.chk('rule: the same item twice on one vendor''s list is refused', r ->> 'error' like 'SEED_REJECTED:%', r);
  r := public.mog_sync_seed_catalog('zztest4', k, jsonb_set(tbl, '{vendors,0,name}', '" Sysco"'));
  perform pg_temp.chk('rule: untrimmed names are refused', r ->> 'error' like 'SEED_REJECTED:%', r);
  r := public.mog_sync_seed_catalog('zztest4', k, jsonb_set(tbl, '{vendors,0,cutoff}', '"9:05"'));
  perform pg_temp.chk('rule: a cutoff must be stored as HH:MM', r ->> 'error' like 'SEED_REJECTED:%', r);
  r := public.mog_sync_seed_catalog('zztest4', k, jsonb_set(tbl, '{vendors,0,mults}', '[1,1,1,1,1,1]'));
  perform pg_temp.chk('rule: a vendor needs exactly 7 day multipliers', r ->> 'error' like 'SEED_REJECTED:%', r);
  r := public.mog_sync_seed_catalog('zztest4', k, tbl - 'areas');
  perform pg_temp.chk('rule: a seed missing a list is refused', r ->> 'error' like 'SEED_REJECTED:%', r);
  perform pg_temp.chk('rule: after every refusal the catalog is still the expected one',
    mog.catalog_from_tables('zztest4') = expected, null);

  -- ---- What the editor (v5) will rely on ----
  update mog.areas set name = 'Walk-In Cooler' where slug = 'zztest4' and name = 'Walk-in';
  perform pg_temp.chk('rename a storage area: its pick rows follow it',
    (select count(*) = 3 from mog.pick_rows where slug = 'zztest4' and area = 'Walk-In Cooler')
      and mog.catalog_from_tables('zztest4') -> 'pickRows' -> 0 ->> 3 = 'Walk-In Cooler', null);
  update mog.items set name = 'Chicken Thighs' where slug = 'zztest4' and item_id = 'ITEM-0001';
  perform pg_temp.chk('rename an item: every pick row shows the new name, nothing to keep in sync',
    mog.catalog_from_tables('zztest4') -> 'pickRows' -> 0 ->> 2 = 'Chicken Thighs'
      and mog.catalog_from_tables('zztest4') -> 'pickRows' -> 1 ->> 2 = 'Chicken Thighs', null);
  update mog.areas set ord = 5 where slug = 'zztest4' and name = 'Dry Storage';
  perform pg_temp.chk('reorder a storage area: every pick row in it gets the new order',
    (mog.catalog_from_tables('zztest4') -> 'pickRows' -> 2 ->> 4)::numeric = 5, null);
  delete from mog.areas where slug = 'zztest4' and name = 'Dry Storage';
  perform pg_temp.chk('delete a storage area: its pick rows go with it (as the Sheet''s area editor does)',
    not exists (select 1 from mog.pick_rows where slug = 'zztest4' and item_id = 'ITEM-0002'), null);
  delete from mog.vendors where slug = 'zztest4' and name = 'B&T';
  perform pg_temp.chk('delete a vendor: its pick rows go with it',
    not exists (select 1 from mog.pick_rows where slug = 'zztest4' and vendor = 'B&T')
      and mog.catalog_from_tables('zztest4') -> 'backupCounts' = '{"Amazon":1}'::jsonb, null);
  update mog.vendors set name = 'Sysco Foods' where slug = 'zztest4' and name = 'Sysco';
  perform pg_temp.chk('rename a vendor: its items and pick rows follow it',
    (select primary_vendor = 'Sysco Foods' from mog.items where slug = 'zztest4' and item_id = 'ITEM-0001')
      and (select count(*) = 2 from mog.pick_rows where slug = 'zztest4' and vendor = 'Sysco Foods'), null);

  -- ---- Test-store copy ----
  r := public.mog_sync_seed_catalog('zztest4', k, tbl);   -- back to the fixture
  perform pg_temp.chk('re-seed replaces everything', mog.catalog_from_tables('zztest4') = expected, r - 'data');
  perform pg_temp.chk('copy: returns a summary',
    mog.copy_store_catalog('zztest4', 'zztest4copy') like 'Copied zztest4''s catalog to test store zztest4copy: 3 vendors, 2 areas, 4 items, 5 pick rows.', null);
  perform pg_temp.chk('copy: a test store, editor_direct on, phones off, the source''s PIN',
    (select is_test and editor_direct and not phone_direct and pin_hash = (select pin_hash from mog.stores where slug = 'zztest4')
       from mog.stores where slug = 'zztest4copy'), null);
  perform pg_temp.chk('copy: its catalog row is built from its tables, marked TEST',
    (select payload = mog.catalog_from_tables('zztest4copy') from mog.catalog where slug = 'zztest4copy')
      and (select payload - 'location' = expected - 'location' and payload ->> 'location' = 'Smoke v4 (TEST)'
             from mog.catalog where slug = 'zztest4copy'), null);
  perform pg_temp.chk('copy: no phone can sign in to it',
    public.mog_login('zztest4copy', '4321') ->> 'error' = 'USE_EXEC', null);
  perform pg_temp.chk('copy: running it again replaces the test store''s catalog',
    mog.copy_store_catalog('zztest4', 'zztest4copy') like 'Copied%', null);
  begin
    perform mog.copy_store_catalog('zztest4copy', 'zztest4');
    ok := false;
  exception when others then
    ok := sqlerrm like '%real store%';
  end;
  perform pg_temp.chk('copy: refuses to overwrite a real store', ok, null);
  begin
    perform mog.copy_store_catalog('zztest4', 'Bad Slug!');
    ok := false;
  exception when others then
    ok := sqlerrm like 'Bad test store slug%';
  end;
  perform pg_temp.chk('copy: refuses a bad slug', ok, null);

  -- ---- editor_direct: the Sheet can no longer write the catalog ----
  r := public.mog_sync_push_catalog('zztest4', k, 100, '{"schema":1,"vendorList":[]}');
  perform pg_temp.chk('push: still works while editor_direct is off', (r -> 'data' ->> 'applied')::boolean, r);
  update mog.stores set editor_direct = true where slug = 'zztest4';
  r := public.mog_sync_push_catalog('zztest4', k, 200, '{"schema":1,"vendorList":["X"]}');
  perform pg_temp.chk('push: refused once editor_direct is on, catalog unchanged',
    r ->> 'error' = 'EDITOR_DIRECT' and (select version = 100 from mog.catalog where slug = 'zztest4'), r);
  r := public.mog_sync_seed_catalog('zztest4', k, tbl);
  perform pg_temp.chk('seed: refused once editor_direct is on', r ->> 'error' = 'EDITOR_DIRECT', r);

  -- ---- Status ----
  r := public.mog_sync_get_status('zztest4', 'wrong');
  perform pg_temp.chk('status: wrong key refused', r ->> 'error' = 'BAD_SYNC_KEY', r);
  r := public.mog_sync_get_status('zztest4', k);
  perform pg_temp.chk('status: switches, seeded flag and the stored catalog',
    not (r -> 'data' ->> 'phoneDirect')::boolean and (r -> 'data' ->> 'editorDirect')::boolean
      and (r -> 'data' ->> 'tablesSeeded')::boolean and not (r -> 'data' ->> 'hasCycle')::boolean
      and (r -> 'data' ->> 'catalogVersion')::bigint = 100
      and r -> 'data' -> 'catalog' = '{"schema":1,"vendorList":[]}'::jsonb, r);

  -- ---- Cleanup ----
  delete from mog.stores where slug in ('zztest4', 'zztest4b', 'zztest4copy');
  perform pg_temp.chk('cleanup: test stores and all their catalog rows removed',
    not exists (select 1 from mog.vendors where slug like 'zztest4%')
      and not exists (select 1 from mog.items where slug like 'zztest4%')
      and not exists (select 1 from mog.pick_rows where slug like 'zztest4%')
      and not exists (select 1 from mog.catalog where slug like 'zztest4%'), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke4
 order by n;
