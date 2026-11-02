-- =====================================================================
-- MOG schema v14 — smoke test (run in the SQL Editor AFTER schema_v14.sql)
-- =====================================================================
-- Throwaway stores 'zztest14a', 'zztest14b', 'zztest14d' (concept
-- 'zz-smoke14') and 'zztest14x' (another concept), the HQ user
-- 'zz smoke 14', LTOs 'lto_zzsmoke14...' and the library 'zz-smoke14' BOH,
-- so no real store, LTO or library is touched: a store reads as before
-- until its first LTO; an LTO sent, its items linked and logged per store;
-- an item's link kept by an edit and brought back by a store's Undo; send
-- to more stores, end, roll back and make standard; refusals and all or
-- none writing nothing; the older calls still answering; the link never in
-- a phone's catalog. Cleans up after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke14 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke14;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke14 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

-- One op that changes an item's row as it is stored now (null = delete it).
create or replace function pg_temp.item_op(p_slug text, p_name text, p_after jsonb)
returns jsonb language sql as $$
  select jsonb_build_object('t', 'items', 'key', i.item_id, 'before', mog.item_row_json(i), 'after', p_after)
    from mog.items i where i.slug = p_slug and i.name = p_name;
$$;

do $$
declare
  ka   text;
  kb   text;
  kd   text;
  kx   text;
  code text;
  r    jsonb;
  tok  text;
  n    integer;
  op   jsonb;
  row0 jsonb;
  me   text := 'zz smoke 14';
  pass text := 'correct horse battery';
  c    text := 'zz-smoke14';
  l1   text := 'lto_zzsmoke14one';
  l2   text := 'lto_zzsmoke14two';
  l3   text := 'lto_zzsmoke14three';
  tabs jsonb := '{
    "profile": {"timeZone": "America/New_York", "location": "Smoke v14 BOH", "abbr": "ZZ14", "concept": "zz-smoke14"},
    "vendors": [{"name": "Sysco", "mults": [1,1,1,1,1,0,0], "cutoff": "10:00"}],
    "areas":   [{"name": "Walk-in", "ord": 10}],
    "items":   [{"id": "ITEM-0001", "name": "Lime", "primaryVendor": "Sysco", "pack": "CS", "par": 3, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Sysco"], "seq": 2}],
    "pickRows": [{"vendor": "Sysco", "id": "ITEM-0001", "area": "Walk-in", "shelfOrder": 10, "seq": 2}]}';
  before0 text;
  lto_items jsonb := '[{"name": "Mango puree", "pack": "CS", "vendor": "Sysco", "backups": [], "notes": ""}]';
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key can call the new save and the older ones',
    has_function_privilege('anon', 'public.mog_hq_apply(text, jsonb, jsonb, jsonb, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_hq_apply(text, jsonb, jsonb, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_hq_apply(text, jsonb, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_hq_data(text)', 'execute'), null);
  perform pg_temp.chk('privileges: the public key cannot reach the LTO helpers or tables',
    not has_function_privilege('anon', 'mog.lto_before(text, jsonb, jsonb)', 'execute')
      and not has_function_privilege('anon', 'mog.lto_after(text, jsonb, jsonb)', 'execute')
      and not has_table_privilege('anon', 'mog.ltos', 'select')
      and not has_table_privilege('anon', 'mog.lto_stores', 'select'), null);

  delete from mog.stores where slug in ('zztest14a', 'zztest14b', 'zztest14d', 'zztest14x');
  delete from mog.hq_users where name = me;
  delete from mog.ltos where id like 'lto_zzsmoke14%';
  delete from mog.libraries where concept = c;
  delete from mog.library_log where concept = c;
  ka := mog.provision_store('zztest14a');
  kb := mog.provision_store('zztest14b');
  kd := mog.provision_store('zztest14d');
  kx := mog.provision_store('zztest14x');
  perform mog.replace_catalog_tables('zztest14a', tabs);
  perform mog.replace_catalog_tables('zztest14b', tabs);
  perform mog.replace_catalog_tables('zztest14d', tabs);
  perform mog.replace_catalog_tables('zztest14x', jsonb_set(tabs, '{profile,concept}', '"zz-other14"'));
  perform public.mog_sync_switch_editor('zztest14a', ka, false);
  perform public.mog_sync_switch_editor('zztest14b', kb, false);
  perform public.mog_sync_switch_editor('zztest14d', kd, false);
  perform public.mog_sync_switch_editor('zztest14x', kx, false);
  code := substring(mog.hq_invite(me) from ': ([0-9A-F]+)');
  tok := public.mog_hq_claim(me, code, pass) -> 'data' ->> 'token';

  -- ---- A store reads as before until its first LTO ----
  before0 := mog.tables_json('zztest14a')::text;
  perform pg_temp.chk('read: no ltos and no item lto before any LTO',
    not (mog.tables_json('zztest14a') ? 'ltos')
      and not exists (select 1 from jsonb_array_elements(mog.tables_json('zztest14a') -> 'items') i where i ? 'lto'), null);

  -- ---- Send ----
  op := jsonb_build_object('t', 'items', 'key', 'ITEM-0002', 'before', null, 'after', jsonb_build_object(
          'id', 'ITEM-0002', 'name', 'Mango puree', 'primaryVendor', 'Sysco', 'pack', 'CS', 'par', null, 'active', true,
          'useMult', true, 'notes', '', 'sku', '', 'category', '', 'eligible', jsonb_build_array('Sysco'), 'seq', 3, 'lto', l1));
  r := public.mog_hq_apply(tok,
         jsonb_build_array(jsonb_build_object('slug', 'zztest14a', 'label', 'HQ LTO "Smoke": added 1 item', 'ops', jsonb_build_array(op)),
                           jsonb_build_object('slug', 'zztest14b', 'label', 'HQ LTO "Smoke": added 1 item', 'ops', jsonb_build_array(op))),
         '[]'::jsonb, null,
         jsonb_build_object('action', 'send', 'id', l1, 'concept', c, 'name', ' Smoke LTO ', 'items', lto_items,
           'stores', jsonb_build_array(
             jsonb_build_object('slug', 'zztest14a', 'vendorsAdded', '[]'::jsonb, 'backupsAdded', '[]'::jsonb),
             jsonb_build_object('slug', 'zztest14b', 'vendorsAdded', '["Sysco"]'::jsonb,
                                'backupsAdded', '[{"id": "ITEM-0001", "vendors": ["Sysco"]}]'::jsonb))));
  perform pg_temp.chk('send: running, version 1, named (trimmed), by "HQ · <name>", with its items as sent',
    (r ->> 'ok')::boolean and r -> 'data' -> 'lto' = jsonb_build_object('id', l1, 'status', 'running', 'version', 1)
      and (select status = 'running' and version = 1 and name = 'Smoke LTO' and concept = c and created_by = 'HQ · ' || me
                  and items = lto_items from mog.ltos where id = l1), r);
  perform pg_temp.chk('send: one row per store, with its logged change, vendors and backups added',
    (select count(*) = 2 from mog.lto_stores where lto_id = l1)
      and (select change_id = (select max(id) from mog.change_log where slug = 'zztest14b') and vendors_added = '{Sysco}'
                  and backups_added = '[{"id": "ITEM-0001", "vendors": ["Sysco"]}]'::jsonb
             from mog.lto_stores where lto_id = l1 and slug = 'zztest14b'), null);
  perform pg_temp.chk('send: the items carry the LTO, no par, and the store reads its LTO',
    (select count(*) = 2 from mog.items where lto = l1 and name = 'Mango puree' and par is null)
      and exists (select 1 from jsonb_array_elements(mog.tables_json('zztest14a') -> 'items') i
                   where i ->> 'name' = 'Mango puree' and i ->> 'lto' = l1)
      and (mog.tables_json('zztest14a') -> 'ltos' -> 0) - 'sentAt' = jsonb_build_object('id', l1, 'name', 'Smoke LTO', 'status', 'running')
      and not (mog.tables_json('zztest14d') ? 'ltos'), mog.tables_json('zztest14a') -> 'ltos');
  r := public.mog_hq_data(tok);
  perform pg_temp.chk('data: the LTO with its stores',
    exists (select 1 from jsonb_array_elements(r -> 'data' -> 'ltos') l
             where l ->> 'id' = l1 and l ->> 'status' = 'running' and jsonb_array_length(l -> 'stores') = 2
               and l -> 'items' = lto_items), null);
  perform pg_temp.chk('phones: an item''s LTO never reaches the catalog',
    (select bool_and(payload::text not like '%lto_zzsmoke14%') from mog.catalog where slug in ('zztest14a', 'zztest14b')), null);

  -- ---- A store's own edits keep the link; its Undo brings it back ----
  op := pg_temp.item_op('zztest14a', 'Mango puree', null);
  op := jsonb_set(op, '{after}', jsonb_set(op -> 'before', '{par}', '4'));
  perform mog.editor_apply_ops('zztest14a', jsonb_build_array(op));
  perform pg_temp.chk('edit: a par saved with the row keeps its LTO',
    (select par = 4 and lto = l1 from mog.items where slug = 'zztest14a' and name = 'Mango puree'), null);
  row0 := (pg_temp.item_op('zztest14a', 'Mango puree', null)) -> 'before';
  begin
    perform mog.editor_apply_ops('zztest14a', jsonb_build_array(jsonb_build_object('t', 'items', 'key', 'ITEM-0002',
      'before', row0 - 'lto', 'after', jsonb_set(row0 - 'lto', '{par}', '5'))));
    perform pg_temp.chk('edit: a row read without its LTO is refused (the link is compared)', false, null);
  exception when others then
    perform pg_temp.chk('edit: a row read without its LTO is refused (the link is compared)', sqlerrm like 'CONFLICT: %', to_jsonb(sqlerrm));
  end;
  perform mog.editor_apply_ops('zztest14a', jsonb_build_array(pg_temp.item_op('zztest14a', 'Mango puree', null)));
  perform mog.editor_apply_ops('zztest14a', jsonb_build_array(jsonb_build_object('t', 'items', 'key', 'ITEM-0002', 'before', null, 'after', row0)));
  perform pg_temp.chk('undo: a deleted item put back carries its LTO again',
    (select lto = l1 and par = 4 from mog.items where slug = 'zztest14a' and name = 'Mango puree'), null);

  -- ---- Refused, nothing written ----
  n := 0;
  foreach r in array array[
    jsonb_build_object('action', 'send', 'id', l1, 'concept', c, 'name', 'Again', 'items', '[]'::jsonb,
                       'stores', '[{"slug": "zztest14d"}]'::jsonb),
    jsonb_build_object('action', 'send', 'id', l2, 'concept', c, 'name', 'Other concept', 'items', '[]'::jsonb,
                       'stores', '[{"slug": "zztest14x"}]'::jsonb),
    jsonb_build_object('action', 'send', 'id', l2, 'concept', c, 'name', '  ', 'items', '[]'::jsonb,
                       'stores', '[{"slug": "zztest14d"}]'::jsonb),
    jsonb_build_object('action', 'send', 'id', 'LTO 2', 'concept', c, 'name', 'Bad id', 'items', '[]'::jsonb,
                       'stores', '[{"slug": "zztest14d"}]'::jsonb),
    jsonb_build_object('action', 'send', 'id', l2, 'concept', c, 'name', 'No stores', 'items', '[]'::jsonb, 'stores', '[]'::jsonb),
    jsonb_build_object('action', 'pause', 'id', l1, 'version', 1),
    jsonb_build_object('action', 'end', 'id', 'lto_zzsmoke14none', 'version', 1),
    jsonb_build_object('action', 'more', 'id', l1, 'version', 1, 'stores', '[{"slug": "zztest14a"}]'::jsonb)
  ] loop
    if (public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, null, r)) ->> 'error' like 'REJECTED: %' then n := n + 1; end if;
  end loop;
  perform pg_temp.chk('refused: a sent id again, another concept, no name, a bad id, no stores, a bad action, no such LTO, a store it went to',
    n = 8 and (select count(*) = 1 from mog.ltos where id like 'lto_zzsmoke14%')
      and (select version = 1 from mog.ltos where id = l1) and (select count(*) = 2 from mog.lto_stores where lto_id = l1), to_jsonb(n));
  r := public.mog_hq_apply(tok,
         jsonb_build_array(jsonb_build_object('slug', 'zztest14d', 'label', 'HQ: stray', 'ops',
           jsonb_build_array(jsonb_set(pg_temp.item_op('zztest14d', 'Lime', null), '{after}',
             jsonb_set((pg_temp.item_op('zztest14d', 'Lime', null)) -> 'before', '{notes}', '"x"'))))),
         '[]'::jsonb, null, jsonb_build_object('action', 'end', 'id', l1, 'version', 1));
  perform pg_temp.chk('refused: an end with a change at a store the LTO never went to writes nothing',
    r ->> 'error' like 'REJECTED: %never went to zztest14d%'
      and (select notes = '' from mog.items where slug = 'zztest14d' and name = 'Lime')
      and (select status = 'running' from mog.ltos where id = l1), r);
  r := public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, null, jsonb_build_object('action', 'end', 'id', l1, 'version', 0));
  perform pg_temp.chk('conflict: an action from an older version is refused, the LTO as it was',
    r ->> 'error' = 'CONFLICT' and r ->> 'detail' like '%LTO "Smoke LTO" was changed since%'
      and (select status = 'running' and version = 1 from mog.ltos where id = l1), r);
  r := public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, null, '[]'::jsonb);
  perform pg_temp.chk('refused: lto must be an object', r ->> 'error' = 'lto must be an object', r);

  -- ---- Send to more stores ----
  op := jsonb_build_object('t', 'items', 'key', 'ITEM-0002', 'before', null, 'after', jsonb_build_object(
          'id', 'ITEM-0002', 'name', 'Mango puree', 'primaryVendor', 'Sysco', 'pack', 'CS', 'par', null, 'active', true,
          'useMult', true, 'notes', '', 'sku', '', 'category', '', 'eligible', jsonb_build_array('Sysco'), 'seq', 3, 'lto', l1));
  r := public.mog_hq_apply(tok,
         jsonb_build_array(jsonb_build_object('slug', 'zztest14d', 'label', 'HQ LTO "Smoke": added 1 item', 'ops', jsonb_build_array(op))),
         '[]'::jsonb, null,
         jsonb_build_object('action', 'more', 'id', l1, 'version', 1, 'stores', '[{"slug": "zztest14d"}]'::jsonb));
  perform pg_temp.chk('more: a third store, version 2, still running',
    (r ->> 'ok')::boolean and (select version = 2 and status = 'running' from mog.ltos where id = l1)
      and (select count(*) = 3 from mog.lto_stores where lto_id = l1)
      and exists (select 1 from mog.items where slug = 'zztest14d' and lto = l1), r);

  -- ---- All or none: a store's CONFLICT leaves the LTO running ----
  op := pg_temp.item_op('zztest14b', 'Mango puree', null);
  r := public.mog_hq_apply(tok,
         jsonb_build_array(
           jsonb_build_object('slug', 'zztest14a', 'label', 'HQ ended', 'ops', jsonb_build_array(jsonb_set(
             pg_temp.item_op('zztest14a', 'Mango puree', null), '{after}',
             jsonb_set((pg_temp.item_op('zztest14a', 'Mango puree', null)) -> 'before', '{active}', 'false')))),
           jsonb_build_object('slug', 'zztest14b', 'label', 'HQ ended', 'ops', jsonb_build_array(jsonb_set(
             jsonb_set(op, '{before,par}', '9'), '{after}', jsonb_set(op -> 'before', '{active}', 'false'))))),
         '[]'::jsonb, null, jsonb_build_object('action', 'end', 'id', l1, 'version', 2));
  perform pg_temp.chk('all or none: one store''s CONFLICT ends nothing anywhere',
    r ->> 'error' = 'CONFLICT' and (select status = 'running' and version = 2 from mog.ltos where id = l1)
      and (select bool_and(active) from mog.items where lto = l1), r);

  -- ---- End ----
  r := public.mog_hq_apply(tok,
         (select jsonb_agg(jsonb_build_object('slug', s, 'label', 'HQ ended LTO "Smoke LTO": 1 item made inactive', 'ops',
                   jsonb_build_array(jsonb_set(pg_temp.item_op(s, 'Mango puree', null), '{after}',
                     jsonb_set((pg_temp.item_op(s, 'Mango puree', null)) -> 'before', '{active}', 'false')))))
            from unnest(array['zztest14a', 'zztest14b', 'zztest14d']) s),
         '[]'::jsonb, null, jsonb_build_object('action', 'end', 'id', l1, 'version', 2));
  perform pg_temp.chk('end: ended, version 3, by whom; its items inactive, still linked, par kept',
    (r ->> 'ok')::boolean and r -> 'data' -> 'lto' ->> 'status' = 'ended'
      and (select status = 'ended' and version = 3 and status_by = 'HQ · ' || me and status_at is not null from mog.ltos where id = l1)
      and (select count(*) = 3 and not bool_or(active) from mog.items where lto = l1)
      and (select par = 4 from mog.items where slug = 'zztest14a' and lto = l1)
      and (mog.tables_json('zztest14a') -> 'ltos' -> 0 ->> 'status') = 'ended', r);
  r := public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, null, jsonb_build_object('action', 'rollback', 'id', l1, 'version', 3));
  perform pg_temp.chk('refused: an ended LTO can''t be rolled back, sent further or ended again',
    r ->> 'error' like 'REJECTED: LTO "Smoke LTO" is ended already%'
      and (public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, null, jsonb_build_object('action', 'more', 'id', l1, 'version', 3,
             'stores', '[{"slug": "zztest14x"}]'::jsonb))) ->> 'error' like 'REJECTED: %is ended already%'
      and (select version = 3 from mog.ltos where id = l1), r);

  -- ---- Roll back ----
  op := jsonb_build_object('t', 'items', 'key', 'ITEM-0003', 'before', null, 'after', jsonb_build_object(
          'id', 'ITEM-0003', 'name', 'Yuzu mayo', 'primaryVendor', 'Sysco', 'pack', 'CS', 'par', null, 'active', true,
          'useMult', true, 'notes', '', 'sku', '', 'category', '', 'eligible', jsonb_build_array('Sysco'), 'seq', 4, 'lto', l2));
  r := public.mog_hq_apply(tok,
         jsonb_build_array(jsonb_build_object('slug', 'zztest14a', 'label', 'HQ LTO "Yuzu": added 1 item', 'ops', jsonb_build_array(op))),
         '[]'::jsonb, null,
         jsonb_build_object('action', 'send', 'id', l2, 'concept', c, 'name', 'Yuzu', 'items', '[]'::jsonb,
           'stores', '[{"slug": "zztest14a"}]'::jsonb));
  r := public.mog_hq_apply(tok,
         jsonb_build_array(jsonb_build_object('slug', 'zztest14a', 'label', 'HQ rolled back LTO "Yuzu": deleted 1 item',
           'ops', jsonb_build_array(pg_temp.item_op('zztest14a', 'Yuzu mayo', null)))),
         '[]'::jsonb, null, jsonb_build_object('action', 'rollback', 'id', l2, 'version', 1));
  perform pg_temp.chk('rollback: rolled back, the item gone, logged at the store, the store still listed',
    (r ->> 'ok')::boolean and (select status = 'rolledback' and version = 2 from mog.ltos where id = l2)
      and not exists (select 1 from mog.items where lto = l2)
      and exists (select 1 from mog.change_log where slug = 'zztest14a' and label like 'HQ rolled back LTO "Yuzu"%')
      and exists (select 1 from mog.lto_stores where lto_id = l2 and slug = 'zztest14a'), r);

  -- ---- Make standard, with its library in the same save ----
  op := jsonb_set(op, '{after,lto}', to_jsonb(l3));
  r := public.mog_hq_apply(tok,
         jsonb_build_array(jsonb_build_object('slug', 'zztest14b', 'label', 'HQ LTO "Yuzu 2": added 1 item', 'ops', jsonb_build_array(op))),
         '[]'::jsonb, null,
         jsonb_build_object('action', 'send', 'id', l3, 'concept', c, 'name', 'Yuzu 2', 'items', '[]'::jsonb,
           'stores', '[{"slug": "zztest14b"}]'::jsonb));
  op := pg_temp.item_op('zztest14b', 'Yuzu mayo', null);
  r := public.mog_hq_apply(tok,
         jsonb_build_array(jsonb_build_object('slug', 'zztest14b', 'label', 'HQ made LTO "Yuzu 2" standard',
           'ops', jsonb_build_array(jsonb_set(op, '{after}', (op -> 'before') - 'lto')))),
         '[]'::jsonb,
         jsonb_build_array(jsonb_build_object('concept', c, 'side', 'BOH', 'version', 0, 'label', 'LTO "Yuzu 2" made standard',
           'items', '[{"name": "Yuzu mayo", "pack": "CS", "vendor": "Sysco"}]'::jsonb)),
         jsonb_build_object('action', 'standard', 'id', l3, 'version', 1));
  perform pg_temp.chk('standard: standard, the item now the store''s own, the library saved in the same call',
    (r ->> 'ok')::boolean and (select status = 'standard' from mog.ltos where id = l3)
      and (select lto is null from mog.items where slug = 'zztest14b' and name = 'Yuzu mayo')
      and exists (select 1 from mog.library_items where concept = c and name = 'Yuzu mayo'), r);

  -- ---- The older calls ----
  r := public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
  perform pg_temp.chk('v12 call: still saves, with no LTO', (r ->> 'ok')::boolean and r -> 'data' -> 'lto' = 'null'::jsonb, r);
  r := public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb);
  perform pg_temp.chk('v11 call: still saves', (r ->> 'ok')::boolean, r);
  r := public.mog_hq_apply('nope', '[]'::jsonb, '[]'::jsonb, null, jsonb_build_object('action', 'end', 'id', l1, 'version', 3));
  perform pg_temp.chk('session: a bad token is refused', r ->> 'error' = 'SESSION_EXPIRED', r);
  perform pg_temp.chk('read: a store no LTO reached reads byte for byte as its twin did before any LTO',
    mog.tables_json('zztest14x')::text = before0, null);

  -- ---- Clean up ----
  delete from mog.stores where slug in ('zztest14a', 'zztest14b', 'zztest14d', 'zztest14x');
  delete from mog.ltos where id like 'lto_zzsmoke14%';
  delete from mog.hq_users where name = me;
  delete from mog.libraries where concept = c;
  delete from mog.library_log where concept = c;
  perform pg_temp.chk('cleanup: the test stores, LTOs, person and library are gone',
    not exists (select 1 from mog.stores where slug like 'zztest14%')
      and not exists (select 1 from mog.ltos where id like 'lto_zzsmoke14%')
      and not exists (select 1 from mog.lto_stores where slug like 'zztest14%')
      and not exists (select 1 from mog.hq_users where name = me)
      and not exists (select 1 from mog.library_items where concept = c), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke14 order by n;
