-- =====================================================================
-- MOG schema v7 — smoke test (run in the SQL Editor AFTER schema_v7.sql)
-- =====================================================================
-- Throwaway store 'zztest7' (+ a test-store copy 'zztest7t'): "just today"
-- pars and adds riding in the snapshot, every refusal (wrong cycle, unknown
-- or inactive item, unlisted vendor, already on the list, bad par, phones not
-- on Supabase), "from now on" with its change log and Undo, the review list
-- and its Apply / Dismiss, a test store's phones, and one store's edits never
-- reaching another. Cleans up after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke7 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke7;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke7 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  k     text;
  r     jsonb;
  tok   text;
  etok  text;
  cid   bigint;
  rid   bigint;
  n     integer;
  cat   jsonb := '{"schema":1,"timeZone":"America/New_York","location":"Smoke v7","abbr":"ZZ7",
    "vendorList":["Amazon","Sysco"],
    "vendorMults":{"Amazon":{"Mon":1,"Tue":1,"Wed":1,"Thu":1,"Fri":1,"Sat":1,"Sun":1},"Sysco":{"Mon":1,"Tue":1,"Wed":1,"Thu":1,"Fri":1,"Sat":1,"Sun":1}},
    "cutoffs":{"Amazon":null,"Sysco":null},
    "items":{"ITEM-0001":{"useMult":true,"par":3,"name":"Lime","pack":"CS","primaryVendor":"Sysco","active":true},
             "ITEM-0002":{"useMult":true,"par":1,"name":"Tape","pack":"EA","primaryVendor":"Amazon","active":true},
             "ITEM-0003":{"useMult":true,"par":2,"name":"Old Tofu","pack":"CS","primaryVendor":"Sysco","active":false}},
    "pickRows":[["Sysco","ITEM-0001","Lime","Walk-in",10,10],["Amazon","ITEM-0002","Tape","Dry Storage",20,10]],
    "itemCounts":{"Sysco":1,"Amazon":1},"backupCounts":{}}';
  tabs  jsonb := '{
    "vendors": [{"name": "Amazon", "mults": [1,1,1,1,1,1,1], "cutoff": null}, {"name": "Sysco", "mults": [1,1,1,1,1,1,1], "cutoff": null}],
    "areas":   [{"name": "Walk-in", "ord": 10}, {"name": "Dry Storage", "ord": 20}],
    "items":   [{"id": "ITEM-0001", "name": "Lime", "primaryVendor": "Sysco", "pack": "CS", "par": 3, "active": true, "useMult": true, "eligible": ["Sysco"], "seq": 2},
                {"id": "ITEM-0002", "name": "Tape", "primaryVendor": "Amazon", "pack": "EA", "par": 1, "active": true, "useMult": true, "eligible": ["Amazon"], "seq": 3},
                {"id": "ITEM-0003", "name": "Old Tofu", "primaryVendor": "Sysco", "pack": "CS", "par": 2, "active": false, "useMult": true, "eligible": ["Sysco"], "seq": 4}],
    "pickRows": [{"vendor": "Sysco", "id": "ITEM-0001", "area": "Walk-in", "shelfOrder": 10, "seq": 2},
                 {"vendor": "Amazon", "id": "ITEM-0002", "area": "Dry Storage", "shelfOrder": 10, "seq": 3}]}';
  edits jsonb;
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: public key cannot read the quick edits',
    not has_table_privilege('anon', 'mog.quick_edits', 'select'), null);
  perform pg_temp.chk('privileges: row level security on the quick edits',
    (select c.relrowsecurity from pg_class c where c.oid = 'mog.quick_edits'::regclass), null);
  perform pg_temp.chk('privileges: public key cannot call the new internals',
    not has_function_privilege('anon', 'mog.today_edits_json(text, date)', 'execute')
      and not has_function_privilege('anon', 'mog.prepare_test_store(text)', 'execute'), null);
  perform pg_temp.chk('privileges: public key can call the three new entry points',
    has_function_privilege('anon', 'public.mog_quick_edit(text, date, text, text, text, numeric, text, bigint)', 'execute')
      and has_function_privilege('anon', 'public.mog_set_par(text, text, numeric, numeric, text, bigint)', 'execute')
      and has_function_privilege('anon', 'public.mog_editor_review(text, bigint, text)', 'execute'), null);

  delete from mog.stores where slug in ('zztest7', 'zztest7t');
  k := mog.provision_store('zztest7');
  perform public.mog_sync_set_pins('zztest7', k, '4321', null);
  perform public.mog_sync_push_catalog('zztest7', k, 1, cat);
  perform public.mog_sync_set_state('zztest7', k, '2026-10-18', 'Sun', false, '{}', '[]', true);
  perform public.mog_sync_set_phone_direct('zztest7', k, true);
  tok := public.mog_login('zztest7', '4321') -> 'data' ->> 'token';

  r := public.mog_snapshot(tok, 1);
  perform pg_temp.chk('snapshot: no today edits yet, and the catalog is still the Sheet''s',
    r -> 'data' -> 'state' -> 'todayEdits' = '{"pars": {}, "adds": []}'::jsonb
      and r -> 'data' -> 'editorDirect' = 'false'::jsonb, r -> 'data' -> 'state');

  -- ---- Today par ----
  r := public.mog_quick_edit(tok, '2026-10-18', 'par_today', 'Sysco', 'ITEM-0001', 5, ' Maria ', 1);
  perform pg_temp.chk('par today: rides in the snapshot, logged with who and the catalog par',
    (r ->> 'ok')::boolean and r -> 'data' -> 'state' -> 'todayEdits' -> 'pars' = '{"ITEM-0001": 5}'::jsonb
      and (select by_name = 'Maria' and par_before = 3 and par_after = 5 and vendor = 'Sysco' and review = 'open'
             from mog.quick_edits where slug = 'zztest7' and active), r -> 'data' -> 'state' -> 'todayEdits');
  r := public.mog_quick_edit(tok, '2026-10-18', 'par_today', 'Sysco', 'ITEM-0001', 6, 'Luis', 1);
  perform pg_temp.chk('par today: a second change replaces the first (which leaves the review list)',
    r -> 'data' -> 'state' -> 'todayEdits' -> 'pars' = '{"ITEM-0001": 6}'::jsonb
      and (select count(*) = 1 from mog.quick_edits where slug = 'zztest7' and active)
      and (select count(*) = 1 from mog.quick_edits where slug = 'zztest7' and review = 'reverted'), r -> 'data' -> 'state' -> 'todayEdits');
  r := public.mog_quick_edit(tok, '2026-10-18', 'par_today', 'Sysco', 'ITEM-0001', 3, null, 1);
  perform pg_temp.chk('par today: setting it back to the catalog par just clears it',
    r -> 'data' -> 'state' -> 'todayEdits' -> 'pars' = '{}'::jsonb
      and not exists (select 1 from mog.quick_edits where slug = 'zztest7' and active), r -> 'data' -> 'state' -> 'todayEdits');
  perform public.mog_quick_edit(tok, '2026-10-18', 'par_today', 'Sysco', 'ITEM-0001', 4.5, 'Maria', 1);
  r := public.mog_quick_edit(tok, '2026-10-18', 'par_today_clear', 'Sysco', 'ITEM-0001', null, null, 1);
  perform pg_temp.chk('par today: "back to normal par" clears it',
    r -> 'data' -> 'state' -> 'todayEdits' -> 'pars' = '{}'::jsonb, r -> 'data' -> 'state' -> 'todayEdits');
  select count(*) into n from mog.quick_edits where slug = 'zztest7';
  r := public.mog_quick_edit(tok, '2026-10-18', 'par_today', 'Sysco', 'ITEM-0001', -1, null, 1);
  perform pg_temp.chk('par today: a negative par is refused', r ->> 'error' like 'Par must be%', r);
  r := public.mog_quick_edit(tok, '2026-10-17', 'par_today', 'Sysco', 'ITEM-0001', 5, null, 1);
  perform pg_temp.chk('par today: an edit for a closed cycle is refused', r ->> 'error' = 'STALE_CYCLE', r);
  r := public.mog_quick_edit(tok, '2026-10-18', 'par_today', 'Sysco', 'ITEM-9999', 5, null, 1);
  perform pg_temp.chk('par today: an unknown item is refused', r ->> 'error' = 'Unknown item', r);
  r := public.mog_quick_edit(tok, '2026-10-18', 'something', 'Sysco', 'ITEM-0001', 5, null, 1);
  perform pg_temp.chk('quick edit: an unknown kind is refused, and no refusal wrote anything',
    r ->> 'error' = 'Unknown kind' and (select count(*) = n from mog.quick_edits where slug = 'zztest7'), r);

  -- ---- Today add ----
  r := public.mog_quick_edit(tok, '2026-10-18', 'add_today', 'Sysco', 'ITEM-0002', null, 'Maria', 1);
  perform pg_temp.chk('add today: rides in the snapshot',
    (r ->> 'ok')::boolean and r -> 'data' -> 'state' -> 'todayEdits' -> 'adds' = '[["Sysco", "ITEM-0002"]]'::jsonb, r -> 'data' -> 'state' -> 'todayEdits');
  r := public.mog_quick_edit(tok, '2026-10-18', 'add_today', 'Sysco', 'ITEM-0002', null, null, 1);
  perform pg_temp.chk('add today: adding it twice is refused', r ->> 'error' = 'Already on this list', r);
  r := public.mog_quick_edit(tok, '2026-10-18', 'add_today', 'Sysco', 'ITEM-0001', null, null, 1);
  perform pg_temp.chk('add today: an item already on the list is refused', r ->> 'error' = 'Already on this list', r);
  r := public.mog_quick_edit(tok, '2026-10-18', 'add_today', 'Amazon', 'ITEM-0003', null, null, 1);
  perform pg_temp.chk('add today: an inactive item is refused', r ->> 'error' = 'That item is inactive.', r);
  r := public.mog_quick_edit(tok, '2026-10-18', 'add_today', 'Ghost', 'ITEM-0001', null, null, 1);
  perform pg_temp.chk('add today: a vendor that isn''t listed is refused', r ->> 'error' = 'Vendor is not listed', r);
  r := public.mog_quick_edit(tok, '2026-10-18', 'add_today_remove', 'Sysco', 'ITEM-0002', null, null, 1);
  perform pg_temp.chk('add today: taking it off again',
    r -> 'data' -> 'state' -> 'todayEdits' -> 'adds' = '[]'::jsonb
      and (select review = 'reverted' and not active from mog.quick_edits where slug = 'zztest7' and kind = 'add_today'), r -> 'data' -> 'state' -> 'todayEdits');
  perform public.mog_quick_edit(tok, '2026-10-18', 'add_today', 'Sysco', 'ITEM-0002', null, 'Maria', 1);
  perform public.mog_quick_edit(tok, '2026-10-18', 'par_today', 'Amazon', 'ITEM-0002', 2, 'Maria', 1);

  -- ---- The nightly close reads the same snapshot ----
  r := public.mog_sync_get_snapshot('zztest7', k);
  perform pg_temp.chk('sync snapshot (the nightly close): carries the same today edits',
    r -> 'data' -> 'state' -> 'todayEdits' = '{"pars": {"ITEM-0002": 2}, "adds": [["Sysco", "ITEM-0002"]]}'::jsonb, r -> 'data' -> 'state' -> 'todayEdits');
  perform public.mog_sync_set_state('zztest7', k, '2026-10-19', 'Mon', false, '{}', '[]', true);
  r := public.mog_snapshot(tok, 1);
  perform pg_temp.chk('a new cycle starts with no today edits',
    r -> 'data' -> 'state' -> 'todayEdits' = '{"pars": {}, "adds": []}'::jsonb, r -> 'data' -> 'state');
  perform public.mog_sync_set_state('zztest7', k, '2026-10-18', 'Sun', false, '{}', '[]', true);

  -- ---- From now on ----
  r := public.mog_set_par(tok, 'ITEM-0001', 3, 4, 'Maria', 1);
  perform pg_temp.chk('from now on: refused while the Sheet owns the catalog', r ->> 'error' = 'EDITOR_NOT_DIRECT', r);
  perform mog.replace_catalog_tables('zztest7', tabs);
  update mog.stores set editor_direct = true where slug = 'zztest7';
  perform mog.editor_publish('zztest7');
  perform public.mog_quick_edit(tok, '2026-10-18', 'par_today', 'Sysco', 'ITEM-0001', 8, 'Maria', 1);
  r := public.mog_set_par(tok, 'ITEM-0001', 2, 4, 'Maria', 1);
  perform pg_temp.chk('from now on: refused when the par changed since the phone read it',
    r ->> 'error' = 'CONFLICT' and (select par = 3 from mog.items where slug = 'zztest7' and item_id = 'ITEM-0001'), r);
  r := public.mog_set_par(tok, 'ITEM-0001', 3, 4, ' Maria ', 1);
  cid := (select max(id) from mog.change_log where slug = 'zztest7');
  perform pg_temp.chk('from now on: the catalog par changes, logged, and the today par ends',
    (r ->> 'ok')::boolean and (select par = 4 from mog.items where slug = 'zztest7' and item_id = 'ITEM-0001')
      and (r -> 'data' -> 'catalog' -> 'items' -> 'ITEM-0001' ->> 'par')::numeric = 4
      and r -> 'data' -> 'state' -> 'todayEdits' -> 'pars' = '{"ITEM-0002": 2}'::jsonb
      and r -> 'data' -> 'editorDirect' = 'true'::jsonb
      and (select by_name = 'Maria' and label = 'Changed the par of "Lime" on a phone: 3 → 4' from mog.change_log where id = cid), r - 'data');
  etok := public.mog_editor_login('zztest7', '4321') -> 'data' ->> 'token';
  r := public.mog_editor_undo(etok, cid, null);
  perform pg_temp.chk('from now on: Manage Items can undo it',
    (r ->> 'ok')::boolean and (select par = 3 from mog.items where slug = 'zztest7' and item_id = 'ITEM-0001'), r);

  -- ---- Review list ----
  r := public.mog_editor_get(etok);
  rid := (select (x ->> 'id')::bigint from jsonb_array_elements(r -> 'data' -> 'reviews') x where x ->> 'kind' = 'add_today');
  perform pg_temp.chk('review: open today edits are listed (taken-back ones are not)',
    jsonb_array_length(r -> 'data' -> 'reviews') = 2 and rid is not null
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'reviews') x
                   where x ->> 'kind' = 'par_today' and x ->> 'itemId' = 'ITEM-0002' and (x ->> 'parAfter')::numeric = 2
                     and (x ->> 'parBefore')::numeric = 1 and x ->> 'by' = 'Maria'), r -> 'data' -> 'reviews');
  r := public.mog_editor_review(etok, rid, 'applied');
  perform pg_temp.chk('review: marking one applied takes it off the list',
    (r ->> 'ok')::boolean and jsonb_array_length(public.mog_editor_get(etok) -> 'data' -> 'reviews') = 1, r);
  r := public.mog_editor_review(etok, rid, 'dismissed');
  perform pg_temp.chk('review: one already reviewed is refused', r ->> 'error' = 'Not waiting for review', r);
  r := public.mog_editor_review(etok, rid, 'open');
  perform pg_temp.chk('review: only applied or dismissed', r ->> 'error' like 'Status must be%', r);
  r := public.mog_editor_review('bogus', rid, 'dismissed');
  perform pg_temp.chk('review: a bad token is refused', r ->> 'error' = 'SESSION_EXPIRED', r);

  -- ---- A test store's phones, and stores kept apart ----
  begin
    perform mog.prepare_test_store('zztest7');
    perform pg_temp.chk('test store: a real store is refused', false, null);
  exception when others then
    perform pg_temp.chk('test store: a real store is refused', sqlerrm like '%real store%', to_jsonb(sqlerrm));
  end;
  perform mog.copy_store_catalog('zztest7', 'zztest7t');
  perform pg_temp.chk('test store: prepare gives it a cycle and turns its phones on',
    mog.prepare_test_store('zztest7t') like 'Test store zztest7t: phones on, cycle %'
      and (select phone_direct from mog.stores where slug = 'zztest7t')
      and exists (select 1 from mog.store_state where slug = 'zztest7t'), null);
  r := public.mog_snapshot(public.mog_login('zztest7t', '4321') -> 'data' ->> 'token', null);
  perform pg_temp.chk('stores: zztest7''s today edits never reach another store',
    (r ->> 'ok')::boolean and r -> 'data' -> 'state' -> 'todayEdits' = '{"pars": {}, "adds": []}'::jsonb, r -> 'data' -> 'state');

  perform public.mog_sync_set_phone_direct('zztest7', k, false);
  r := public.mog_quick_edit(tok, '2026-10-18', 'par_today', 'Sysco', 'ITEM-0001', 5, null, 1);
  perform pg_temp.chk('phones on the Sheet: quick edits answer USE_EXEC', r ->> 'error' = 'USE_EXEC', r);

  -- ---- Clean up ----
  delete from mog.stores where slug in ('zztest7', 'zztest7t');
  perform pg_temp.chk('cleanup: both stores and their quick edits are gone',
    not exists (select 1 from mog.stores where slug like 'zztest7%')
      and not exists (select 1 from mog.quick_edits where slug like 'zztest7%'), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke7 order by n;
