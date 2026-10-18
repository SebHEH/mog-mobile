-- =====================================================================
-- MOG schema v6 — smoke test (run in the SQL Editor AFTER schema_v6.sql)
-- =====================================================================
-- Throwaway stores 'zztest6' and 'zztest6b' (the same item IDs in both):
-- the editor's sign-in (editor_direct first, same PIN rules), a change
-- applied only when its rows are as the editor read them, the change log and
-- the catalog phones read, a bad change writing nothing, one store's sign-in
-- never touching the other store, Undo (and its refusals), and D23 (removing
-- a vendor keeps its items). Cleans up after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke6 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke6;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke6 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  k     text;
  kb    text;
  r     jsonb;
  tok   text;
  ver   bigint;
  cid   bigint;
  cid2  bigint;
  cur   jsonb;
  nlog  integer;
  tabs  jsonb := '{
    "profile": {"timeZone": "America/New_York", "location": "Smoke v6", "abbr": "ZZ6", "concept": "roll-play"},
    "vendors": [{"name": "Amazon", "mults": [1,0,0,0,0,0,0], "cutoff": null},
                {"name": "Sysco",  "mults": [1,1,1,1,1,0,0], "cutoff": "10:00"}],
    "areas":   [{"name": "Walk-in", "ord": 10}, {"name": "Dry Storage", "ord": 20}],
    "items":   [{"id": "ITEM-0001", "name": "Lime", "primaryVendor": "Sysco", "pack": "CS", "par": 3, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Sysco", "Amazon"], "seq": 2},
                {"id": "ITEM-0002", "name": "Tape", "primaryVendor": "Amazon", "pack": "EA", "par": 1, "active": true,
                 "useMult": false, "notes": "", "sku": "", "category": "", "eligible": ["Amazon"], "seq": 3}],
    "pickRows": [{"vendor": "Sysco",  "id": "ITEM-0001", "area": "Walk-in",     "shelfOrder": 10, "seq": 2},
                 {"vendor": "Amazon", "id": "ITEM-0002", "area": "Dry Storage", "shelfOrder": 10, "seq": 3}]}';
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: public key cannot read the change log',
    not has_table_privilege('anon', 'mog.change_log', 'select'), null);
  perform pg_temp.chk('privileges: row level security on the change log',
    (select c.relrowsecurity from pg_class c where c.oid = 'mog.change_log'::regclass), null);
  perform pg_temp.chk('privileges: public key cannot call the new internals',
    not has_function_privilege('anon', 'mog.editor_apply_ops(text, jsonb)', 'execute')
      and not has_function_privilege('anon', 'mog.tables_json(text)', 'execute')
      and not has_function_privilege('anon', 'mog.editor_publish(text)', 'execute'), null);
  perform pg_temp.chk('privileges: public key can call the four editor entry points',
    has_function_privilege('anon', 'public.mog_editor_login(text, text)', 'execute')
      and has_function_privilege('anon', 'public.mog_editor_get(text)', 'execute')
      and has_function_privilege('anon', 'public.mog_editor_apply(text, text, text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_editor_undo(text, bigint, text)', 'execute'), null);

  delete from mog.stores where slug in ('zztest6', 'zztest6b');
  k  := mog.provision_store('zztest6');
  kb := mog.provision_store('zztest6b');
  perform public.mog_sync_set_pins('zztest6', k, '4321', null);
  perform public.mog_sync_set_pins('zztest6b', kb, '4321', null);
  perform mog.replace_catalog_tables('zztest6', tabs);
  perform mog.replace_catalog_tables('zztest6b', tabs);

  -- ---- Sign-in ----
  r := public.mog_editor_login('zztest6', '0000');
  perform pg_temp.chk('login: refused while the store''s editor is still in the Sheet, before the PIN',
    r ->> 'error' = 'EDITOR_NOT_DIRECT' and (select fail_count = 0 from mog.stores where slug = 'zztest6'), r);
  update mog.stores set editor_direct = true where slug in ('zztest6', 'zztest6b');
  r := public.mog_editor_login('zztest6', '0000');
  perform pg_temp.chk('login: a wrong PIN counts toward the lockout',
    r ->> 'error' = 'Invalid PIN' and (select fail_count = 1 from mog.stores where slug = 'zztest6'), r);
  r := public.mog_editor_login('ZZTEST6 ', '4321');
  tok := r -> 'data' ->> 'token';
  perform pg_temp.chk('login: the right PIN gives a token, the tables and no changes yet, and clears the counter',
    (r ->> 'ok')::boolean and length(tok) = 64 and r -> 'data' -> 'changes' = '[]'::jsonb
      and r -> 'data' -> 'tables' -> 'vendors' -> 0 ->> 'name' = 'Amazon'
      and r -> 'data' -> 'tables' -> 'items' -> 0 ->> 'id' = 'ITEM-0001'
      and r -> 'data' -> 'tables' -> 'items' -> 0 -> 'eligible' = '["Sysco", "Amazon"]'::jsonb
      and r -> 'data' -> 'store' ->> 'location' = 'Smoke v6'
      and (select fail_count = 0 from mog.stores where slug = 'zztest6'), (r -> 'data') - 'tables');   -- "-" binds tighter than "->"
  r := public.mog_editor_get('bogus');
  perform pg_temp.chk('get: a bad token is refused', r ->> 'error' = 'SESSION_EXPIRED', r);
  insert into mog.sessions (token_hash, slug, auth_type, expires_at)
  values (mog.sha256_hex('phone-token-zz6'), 'zztest6', 'store', now() + interval '1 hour');
  r := public.mog_editor_get('phone-token-zz6');
  perform pg_temp.chk('get: the phones'' sign-in for the store works too (one sign-in for the app)',
    (r ->> 'ok')::boolean and jsonb_array_length(r -> 'data' -> 'tables' -> 'pickRows') = 2, r - 'data');

  -- ---- Apply ----
  cur := mog.editor_current('zztest6', 'items', '{"id": "ITEM-0001"}');
  ver := (select version from mog.catalog where slug = 'zztest6');
  r := public.mog_editor_apply(tok, 'Edited "Lime": par 3 → 5', ' Maria ',
         jsonb_build_array(jsonb_build_object('t', 'items', 'before', cur, 'after', cur || '{"par": 5}')));
  cid := (r -> 'data' ->> 'changeId')::bigint;
  perform pg_temp.chk('apply: a change writes the row, logs who and what, and rebuilds the phones'' catalog',
    (r ->> 'ok')::boolean and (select par = 5 from mog.items where slug = 'zztest6' and item_id = 'ITEM-0001')
      and (select by_name = 'Maria' and label like 'Edited "Lime"%' from mog.change_log where id = cid)
      and (select (payload -> 'items' -> 'ITEM-0001' ->> 'par')::numeric = 5 from mog.catalog where slug = 'zztest6')
      and (r -> 'data' ->> 'catalogVersion')::bigint > coalesce(ver, 0), r);
  select count(*) into nlog from mog.change_log where slug = 'zztest6';
  r := public.mog_editor_apply(tok, 'stale', null,
         jsonb_build_array(jsonb_build_object('t', 'items', 'before', cur, 'after', cur || '{"par": 9}')));
  perform pg_temp.chk('apply: a row changed since the editor read it is refused, and nothing is written',
    r ->> 'error' = 'CONFLICT' and r ->> 'detail' like 'items ITEM-0001%'
      and (select par = 5 from mog.items where slug = 'zztest6' and item_id = 'ITEM-0001')
      and (select count(*) = nlog from mog.change_log where slug = 'zztest6'), r);
  r := public.mog_editor_apply(tok, 'dup', null, jsonb_build_array(jsonb_build_object('t', 'items', 'before', null,
         'after', jsonb_build_object('id', 'ITEM-0002', 'name', 'Copy', 'eligible', '[]'::jsonb, 'seq', 9))));
  perform pg_temp.chk('apply: adding a row that is already there is refused',
    r ->> 'error' = 'CONFLICT' and (select name = 'Tape' from mog.items where slug = 'zztest6' and item_id = 'ITEM-0002'), r);

  -- An add above another item: the item below moves down one.
  r := public.mog_editor_apply(tok, 'Added "Nori"', 'Luis', jsonb_build_array(
         jsonb_build_object('shift', 'items', 'from', 3),
         jsonb_build_object('t', 'items', 'before', null, 'after', jsonb_build_object('id', 'ITEM-0003', 'name', 'Nori',
           'primaryVendor', 'Sysco', 'pack', 'CS', 'par', 2, 'active', true, 'useMult', true, 'notes', '', 'sku', '',
           'category', '', 'eligible', '["Sysco"]'::jsonb, 'seq', 3)),
         jsonb_build_object('t', 'pickRows', 'before', null, 'after', jsonb_build_object('vendor', 'Sysco', 'id', 'ITEM-0003',
           'area', 'Walk-in', 'shelfOrder', 20, 'seq', 4))));
  perform pg_temp.chk('apply: an inserted item goes where the editor put it, the rows below move down',
    (r ->> 'ok')::boolean
      and (select array_agg(item_id order by seq) = array['ITEM-0001', 'ITEM-0003', 'ITEM-0002']
             from mog.items where slug = 'zztest6')
      and (select payload -> 'pickRows' -> 2 = '["Sysco", "ITEM-0003", "Nori", "Walk-in", 10, 20]'::jsonb
             from mog.catalog where slug = 'zztest6'), r);

  -- Bad data rejects the whole change.
  select count(*) into nlog from mog.change_log where slug = 'zztest6';
  r := public.mog_editor_apply(tok, 'bad', null, jsonb_build_array(
         jsonb_build_object('t', 'items', 'before', null, 'after', jsonb_build_object('id', 'ITEM-0009', 'name', 'Ghost item',
           'eligible', '[]'::jsonb, 'seq', 20)),
         jsonb_build_object('t', 'pickRows', 'before', null, 'after', jsonb_build_object('vendor', 'Ghost', 'id', 'ITEM-0009',
           'area', 'Walk-in', 'shelfOrder', 10, 'seq', 20))));
  perform pg_temp.chk('apply: a pick row for a vendor that isn''t listed rejects the whole change',
    r ->> 'error' like 'REJECTED:%'
      and not exists (select 1 from mog.items where slug = 'zztest6' and item_id = 'ITEM-0009')
      and (select count(*) = nlog from mog.change_log where slug = 'zztest6'), r);
  cur := mog.editor_current('zztest6', 'items', '{"id": "ITEM-0002"}');
  r := public.mog_editor_apply(tok, 'bad', null,
         jsonb_build_array(jsonb_build_object('t', 'items', 'before', cur, 'after', cur || '{"eligible": ["Amazon", "Ghost"]}')));
  perform pg_temp.chk('apply: an eligible vendor that isn''t listed is rejected',
    r ->> 'error' like 'REJECTED:%Ghost%', r);
  r := public.mog_editor_apply(tok, 'nothing', null, '[]'::jsonb);
  perform pg_temp.chk('apply: no changes logs nothing',
    (r ->> 'ok')::boolean and r -> 'data' -> 'changeId' = 'null'::jsonb
      and (select count(*) = nlog from mog.change_log where slug = 'zztest6'), r);
  r := public.mog_editor_apply(tok, 'bad', null, '[{"t": "stores", "before": null, "after": {"slug": "x"}}]');
  perform pg_temp.chk('apply: a table outside the catalog is refused', r ->> 'error' like 'REJECTED: BAD_OP%', r);

  -- One store's sign-in never reaches another store, even with the same IDs.
  cur := mog.editor_current('zztest6', 'items', '{"id": "ITEM-0002"}');
  r := public.mog_editor_apply(tok, 'Edited "Tape"', null,
         jsonb_build_array(jsonb_build_object('t', 'items', 'before', cur, 'after', cur || '{"par": 7}')));
  perform pg_temp.chk('stores: a change made with zztest6''s sign-in changes only zztest6',
    (r ->> 'ok')::boolean
      and (select par = 7 from mog.items where slug = 'zztest6' and item_id = 'ITEM-0002')
      and (select par = 1 from mog.items where slug = 'zztest6b' and item_id = 'ITEM-0002')
      and not exists (select 1 from mog.change_log where slug = 'zztest6b'), r);
  r := public.mog_editor_get(tok);
  perform pg_temp.chk('stores: the editor reads only its own store',
    r -> 'data' -> 'store' ->> 'slug' = 'zztest6' and jsonb_array_length(r -> 'data' -> 'tables' -> 'items') = 3, r -> 'data' -> 'store');

  -- ---- Undo ----
  r := public.mog_editor_undo(tok, cid, 'Maria');
  cid2 := (r -> 'data' ->> 'changeId')::bigint;
  perform pg_temp.chk('undo: puts the row back, as a new change, and marks the old one undone',
    (r ->> 'ok')::boolean and (select par = 3 from mog.items where slug = 'zztest6' and item_id = 'ITEM-0001')
      and (select label like 'Undo: Edited "Lime"%' and undoes = cid from mog.change_log where id = cid2)
      and (select undone_by = cid2 from mog.change_log where id = cid)
      and (select (payload -> 'items' -> 'ITEM-0001' ->> 'par')::numeric = 3 from mog.catalog where slug = 'zztest6'), r);
  r := public.mog_editor_undo(tok, cid, null);
  perform pg_temp.chk('undo: a change already undone is refused', r ->> 'error' = 'ALREADY_UNDONE', r);
  r := public.mog_editor_undo(tok, cid2, null);
  perform pg_temp.chk('undo: undoing the undo puts the change back',
    (r ->> 'ok')::boolean and (select par = 5 from mog.items where slug = 'zztest6' and item_id = 'ITEM-0001')
      and (select undone_by is null from mog.change_log where id = cid), r);
  cur := mog.editor_current('zztest6', 'items', '{"id": "ITEM-0001"}');
  r := public.mog_editor_apply(tok, 'Edited "Lime": par 5 → 6', null,
         jsonb_build_array(jsonb_build_object('t', 'items', 'before', cur, 'after', cur || '{"par": 6}')));
  cid := (r -> 'data' ->> 'changeId')::bigint;
  cur := mog.editor_current('zztest6', 'items', '{"id": "ITEM-0001"}');
  r := public.mog_editor_apply(tok, 'Edited "Lime": par 6 → 7', 'Luis',
         jsonb_build_array(jsonb_build_object('t', 'items', 'before', cur, 'after', cur || '{"par": 7}')));
  cid2 := (r -> 'data' ->> 'changeId')::bigint;
  r := public.mog_editor_undo(tok, cid, null);
  perform pg_temp.chk('undo: refused when the row changed since, naming the later change',
    r ->> 'error' = 'CONFLICT' and (r -> 'laterChange' ->> 'id')::bigint = cid2
      and (select par = 7 from mog.items where slug = 'zztest6' and item_id = 'ITEM-0001'), r);
  r := public.mog_editor_undo(tok, 999999999, null);
  perform pg_temp.chk('undo: an unknown change is refused', r ->> 'error' = 'Unknown change', r);
  r := public.mog_editor_undo(tok, cid2, null);
  perform pg_temp.chk('undo: the latest change undoes', (r ->> 'ok')::boolean
    and (select par = 6 from mog.items where slug = 'zztest6' and item_id = 'ITEM-0001'), r);

  -- ---- D23 ----
  delete from mog.vendors where slug = 'zztest6' and name = 'Amazon';
  perform pg_temp.chk('D23: removing a vendor keeps its items, with no primary vendor',
    (select primary_vendor is null from mog.items where slug = 'zztest6' and item_id = 'ITEM-0002')
      and not exists (select 1 from mog.pick_rows where slug = 'zztest6' and vendor = 'Amazon'), null);

  -- ---- Clean up ----
  delete from mog.stores where slug in ('zztest6', 'zztest6b');
  perform pg_temp.chk('cleanup: both test stores and their change log are gone',
    not exists (select 1 from mog.stores where slug like 'zztest6%')
      and not exists (select 1 from mog.change_log where slug like 'zztest6%'), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke6 order by n;
