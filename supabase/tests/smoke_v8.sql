-- =====================================================================
-- MOG schema v8 — smoke test (run in the SQL Editor AFTER schema_v8.sql)
-- =====================================================================
-- Throwaway stores 'zztest8' and 'zztest8b': moving a store's editor to the
-- app (its sync key, keeping the seeded tables or starting empty, refusing a
-- store with nothing seeded, doing nothing the second time), an area renamed
-- with its pick rows following (and the renames refused: a missing area, a
-- name already in use, a bad step), a swap through a temporary name, Undo
-- renaming back, and a vendor removed in the editor's order. Cleans up after
-- itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke8 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke8;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke8 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  k     text;
  kb    text;
  r     jsonb;
  tok   text;
  cid   bigint;
  cur   jsonb;
  item2 jsonb;
  tabs  jsonb := '{
    "profile": {"timeZone": "America/New_York", "location": "Smoke v8", "abbr": "ZZ8", "concept": "teasnyou"},
    "vendors": [{"name": "Amazon", "mults": [1,0,0,0,0,0,0], "cutoff": null},
                {"name": "Sysco",  "mults": [1,1,1,1,1,0,0], "cutoff": "10:00"}],
    "areas":   [{"name": "Walk-in", "ord": 10}, {"name": "Dry Storage", "ord": 20}],
    "items":   [{"id": "ITEM-0001", "name": "Lime", "primaryVendor": "Sysco", "pack": "CS", "par": 3, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Sysco", "Amazon"], "seq": 2},
                {"id": "ITEM-0002", "name": "Tape", "primaryVendor": "Amazon", "pack": "EA", "par": 1, "active": true,
                 "useMult": false, "notes": "", "sku": "", "category": "", "eligible": ["Amazon"], "seq": 3}],
    "pickRows": [{"vendor": "Sysco",  "id": "ITEM-0001", "area": "Walk-in",     "shelfOrder": 10, "seq": 2},
                 {"vendor": "Amazon", "id": "ITEM-0001", "area": "Walk-in",     "shelfOrder": 20, "seq": 3},
                 {"vendor": "Amazon", "id": "ITEM-0002", "area": "Dry Storage", "shelfOrder": 10, "seq": 4}]}';
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key can call the switch (it needs the sync key)',
    has_function_privilege('anon', 'public.mog_sync_switch_editor(text, text, boolean)', 'execute'), null);
  perform pg_temp.chk('privileges: the public key still cannot call the internals',
    not has_function_privilege('anon', 'mog.editor_apply_ops(text, jsonb)', 'execute'), null);

  delete from mog.stores where slug in ('zztest8', 'zztest8b');
  k  := mog.provision_store('zztest8');
  kb := mog.provision_store('zztest8b');
  perform public.mog_sync_set_pins('zztest8', k, '4321', null);
  perform public.mog_sync_set_pins('zztest8b', kb, '4321', null);
  perform mog.replace_catalog_tables('zztest8', tabs);
  perform mog.replace_catalog_tables('zztest8b', tabs);

  -- ---- The switch ----
  r := public.mog_sync_switch_editor('zztest8', 'not-the-key', false);
  perform pg_temp.chk('switch: a wrong sync key is refused, and nothing changes',
    r ->> 'error' = 'BAD_SYNC_KEY' and (select not editor_direct from mog.stores where slug = 'zztest8'), r);
  delete from mog.pick_rows where slug = 'zztest8b';
  delete from mog.items     where slug = 'zztest8b';
  delete from mog.vendors   where slug = 'zztest8b';
  r := public.mog_sync_switch_editor('zztest8b', kb, false);
  perform pg_temp.chk('switch: keeping the Sheet''s catalog needs it seeded first',
    r ->> 'error' = 'NOT_SEEDED' and (select not editor_direct from mog.stores where slug = 'zztest8b'), r);
  perform mog.replace_catalog_tables('zztest8b', tabs);
  insert into mog.quick_edits (slug, cycle_date, by_name, kind, vendor, item_id, par_before, par_after)
  values ('zztest8b', current_date, 'Maria', 'par_today', 'Sysco', 'ITEM-0001', 3, 5);
  r := public.mog_sync_switch_editor('zztest8b', kb, true);
  perform pg_temp.chk('switch: starting empty clears the catalog, switches, and phones get an empty catalog',
    (r ->> 'ok')::boolean and (r -> 'data' ->> 'startedEmpty')::boolean
      and (select editor_direct from mog.stores where slug = 'zztest8b')
      and not exists (select 1 from mog.vendors where slug = 'zztest8b')
      and not exists (select 1 from mog.items where slug = 'zztest8b')
      and not exists (select 1 from mog.areas where slug = 'zztest8b')
      and (select payload -> 'vendorList' = '[]'::jsonb and payload -> 'items' = '{}'::jsonb from mog.catalog where slug = 'zztest8b'), r);
  perform pg_temp.chk('switch: starting empty takes back the phones'' one-day edits',
    (select bool_and(not active and review = 'dismissed') from mog.quick_edits where slug = 'zztest8b'), null);
  r := public.mog_sync_switch_editor('zztest8', k, false);
  perform pg_temp.chk('switch: keeping the seeded catalog switches with the tables as they are',
    (r ->> 'ok')::boolean and not (r -> 'data' ->> 'startedEmpty')::boolean
      and (select editor_direct from mog.stores where slug = 'zztest8')
      and (select count(*) = 3 from mog.pick_rows where slug = 'zztest8')
      and (select payload -> 'vendorList' = '["Amazon", "Sysco"]'::jsonb from mog.catalog where slug = 'zztest8'), r);
  r := public.mog_sync_switch_editor('zztest8', k, true);
  perform pg_temp.chk('switch: a second switch changes nothing (it never clears a switched store)',
    (r -> 'data' ->> 'alreadySwitched')::boolean and (select count(*) = 3 from mog.pick_rows where slug = 'zztest8'), r);
  r := public.mog_sync_push_catalog('zztest8', k, 1, '{}'::jsonb);
  perform pg_temp.chk('switch: the Sheet''s catalog push is refused from then on', r ->> 'error' = 'EDITOR_DIRECT', r);

  -- ---- Renaming an area ----
  tok := public.mog_editor_login('zztest8', '4321') -> 'data' ->> 'token';
  r := public.mog_editor_apply(tok, 'Saved the storage areas: renamed Walk-in → Cooler', 'Maria',
         '[{"rename": "areas", "from": "Walk-in", "to": "Cooler"}]'::jsonb);
  cid := (r -> 'data' ->> 'changeId')::bigint;
  perform pg_temp.chk('rename: the area and its pick rows take the new name, and phones see it',
    (r ->> 'ok')::boolean
      and exists (select 1 from mog.areas where slug = 'zztest8' and name = 'Cooler')
      and not exists (select 1 from mog.areas where slug = 'zztest8' and name = 'Walk-in')
      and (select count(*) = 2 from mog.pick_rows where slug = 'zztest8' and area = 'Cooler')
      and (select payload -> 'pickRows' -> 0 ->> 3 = 'Cooler' from mog.catalog where slug = 'zztest8'), r);
  r := public.mog_editor_apply(tok, 'x', null, '[{"rename": "areas", "from": "Walk-in", "to": "Prep"}]'::jsonb);
  perform pg_temp.chk('rename: an area that is not there any more is a CONFLICT', r ->> 'error' = 'CONFLICT', r);
  r := public.mog_editor_apply(tok, 'x', null, '[{"rename": "areas", "from": "Cooler", "to": "dry storage"}]'::jsonb);
  perform pg_temp.chk('rename: a name another area has (ignoring case) is a CONFLICT, and nothing changes',
    r ->> 'error' = 'CONFLICT' and exists (select 1 from mog.areas where slug = 'zztest8' and name = 'Cooler'), r);
  r := public.mog_editor_apply(tok, 'x', null, '[{"rename": "vendors", "from": "Sysco", "to": "Sysco Foods"}]'::jsonb);
  perform pg_temp.chk('rename: only areas rename this way', r ->> 'error' like 'REJECTED: BAD_OP%', r);
  r := public.mog_editor_apply(tok, 'Saved the storage areas: renamed Cooler → Dry Storage, Dry Storage → Cooler', null,
         '[{"rename": "areas", "from": "Cooler", "to": "(renaming 1)"},
           {"rename": "areas", "from": "Dry Storage", "to": "Cooler"},
           {"rename": "areas", "from": "(renaming 1)", "to": "Dry Storage"}]'::jsonb);
  perform pg_temp.chk('rename: a swap through a temporary name',
    (r ->> 'ok')::boolean
      and (select count(*) = 2 from mog.pick_rows where slug = 'zztest8' and area = 'Dry Storage')
      and (select count(*) = 1 from mog.pick_rows where slug = 'zztest8' and area = 'Cooler'), r);
  r := public.mog_editor_undo(tok, (r -> 'data' ->> 'changeId')::bigint, null);
  r := public.mog_editor_undo(tok, cid, 'Maria');
  perform pg_temp.chk('undo: undoing the swap, then the rename, gives back Walk-in with its pick rows',
    (r ->> 'ok')::boolean
      and (select count(*) = 2 from mog.pick_rows where slug = 'zztest8' and area = 'Walk-in')
      and (select count(*) = 1 from mog.pick_rows where slug = 'zztest8' and area = 'Dry Storage')
      and not exists (select 1 from mog.areas where slug = 'zztest8' and name = 'Cooler'), r);

  -- ---- Removing a vendor, in the editor's order ----
  cur   := mog.editor_current('zztest8', 'items', '{"id": "ITEM-0001"}');
  item2 := mog.editor_current('zztest8', 'items', '{"id": "ITEM-0002"}');
  r := public.mog_editor_apply(tok, 'Removed vendor "Amazon"', 'Luis', jsonb_build_array(
         jsonb_build_object('t', 'pickRows', 'before', mog.editor_current('zztest8', 'pickRows', '{"vendor": "Amazon", "id": "ITEM-0001"}'), 'after', null),
         jsonb_build_object('t', 'pickRows', 'before', mog.editor_current('zztest8', 'pickRows', '{"vendor": "Amazon", "id": "ITEM-0002"}'), 'after', null),
         jsonb_build_object('t', 'items', 'before', cur, 'after', cur || '{"eligible": ["Sysco"]}'),
         jsonb_build_object('t', 'items', 'before', item2, 'after', item2 || '{"primaryVendor": null, "eligible": []}'),
         jsonb_build_object('t', 'vendors', 'before', '{"name": "Amazon", "mults": [1,0,0,0,0,0,0], "cutoff": null}'::jsonb, 'after', null)));
  cid := (r -> 'data' ->> 'changeId')::bigint;
  perform pg_temp.chk('vendor removal: its items let go first, then it goes; the items stay active',
    (r ->> 'ok')::boolean
      and not exists (select 1 from mog.vendors where slug = 'zztest8' and name = 'Amazon')
      and (select primary_vendor is null and active from mog.items where slug = 'zztest8' and item_id = 'ITEM-0002'), r);
  r := public.mog_editor_undo(tok, cid, null);
  perform pg_temp.chk('vendor removal: undo brings the vendor, its items'' links and its pick rows back',
    (r ->> 'ok')::boolean
      and exists (select 1 from mog.vendors where slug = 'zztest8' and name = 'Amazon')
      and (select primary_vendor = 'Amazon' from mog.items where slug = 'zztest8' and item_id = 'ITEM-0002')
      and (select count(*) = 2 from mog.pick_rows where slug = 'zztest8' and vendor = 'Amazon'), r);

  -- ---- Clean up ----
  delete from mog.stores where slug in ('zztest8', 'zztest8b');
  perform pg_temp.chk('cleanup: both test stores are gone',
    not exists (select 1 from mog.stores where slug like 'zztest8%')
      and not exists (select 1 from mog.change_log where slug like 'zztest8%')
      and not exists (select 1 from mog.quick_edits where slug like 'zztest8%'), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke8 order by n;
