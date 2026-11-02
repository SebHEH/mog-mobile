-- =====================================================================
-- MOG schema v15 — smoke test (run in the SQL Editor AFTER schema_v15.sql)
-- =====================================================================
-- Throwaway store 'zztest15', so no real store is touched: a vendor
-- renamed in the editor's changes takes its items' main vendor and vendor
-- lists, its pick rows, the store's counts (one already under the new name
-- keeps its place), its "just today" edits, the override's day picks,
-- presence and HQ's remembered name along, and phones see the new name;
-- Undo renames it all back; a change of capitals is a rename; a name
-- another vendor has, a vendor that isn't there and an unknown rename kind
-- are refused and change nothing; an area rename still works. Cleans up
-- after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke15 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke15;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke15 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

-- A count's on hand at zztest15 today (null = no such row).
create or replace function pg_temp.cnt(p_vendor text, p_id text)
returns numeric language sql as $$
  select on_hand from mog.counts where slug = 'zztest15' and cycle_date = current_date and vendor = p_vendor and item_id = p_id;
$$;

do $$
declare
  k    text;
  r    jsonb;
  tok  text;
  cid  bigint;
  tabs jsonb := '{
    "profile": {"timeZone": "America/New_York", "location": "Smoke v15 BOH", "abbr": "ZZ15", "concept": "zz-smoke15"},
    "vendors": [{"name": "B&T", "mults": [0,2,0,3,0,0,2], "cutoff": "16:00"},
                {"name": "ELPIS", "mults": [0,5,0,0,0,0,2], "cutoff": null},
                {"name": "Sysco", "mults": [1,1,1,1,1,0,0], "cutoff": "10:00"}],
    "areas":   [{"name": "Walk-in", "ord": 10}, {"name": "Dry Storage", "ord": 20}],
    "items":   [{"id": "ITEM-0001", "name": "Lime", "primaryVendor": "B&T", "pack": "CS", "par": 3, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["B&T", "Sysco"], "seq": 2},
                {"id": "ITEM-0002", "name": "Napkins", "primaryVendor": "ELPIS", "pack": "CS", "par": 1, "active": true,
                 "useMult": false, "notes": "", "sku": "", "category": "", "eligible": ["ELPIS"], "seq": 3},
                {"id": "ITEM-0003", "name": "Rice", "primaryVendor": "Sysco", "pack": "BAG", "par": 2, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Sysco", "B&T"], "seq": 4}],
    "pickRows": [{"vendor": "B&T",   "id": "ITEM-0001", "area": "Walk-in",     "shelfOrder": 10, "seq": 2},
                 {"vendor": "Sysco", "id": "ITEM-0001", "area": "Walk-in",     "shelfOrder": 10, "seq": 3},
                 {"vendor": "ELPIS", "id": "ITEM-0002", "area": "Dry Storage", "shelfOrder": 10, "seq": 4},
                 {"vendor": "Sysco", "id": "ITEM-0003", "area": "Dry Storage", "shelfOrder": 20, "seq": 5},
                 {"vendor": "B&T",   "id": "ITEM-0003", "area": "Dry Storage", "shelfOrder": 30, "seq": 6}]}';
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the rename step stays internal; the editor''s save is still open',
    not has_function_privilege('anon', 'mog.editor_apply_ops(text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_editor_apply(text, text, text, jsonb)', 'execute'), null);

  -- ---- A store on the app's editor, counting today ----
  delete from mog.stores where slug = 'zztest15';
  k := mog.provision_store('zztest15');
  perform public.mog_sync_set_pins('zztest15', k, '4321', null);
  perform mog.replace_catalog_tables('zztest15', tabs);
  perform public.mog_sync_switch_editor('zztest15', k, false);
  insert into mog.store_state (slug, cycle_date, day_of_week, emergency_override, vendor_picks)
  values ('zztest15', current_date, 'Mon', true, '{"B&T": 3, "Sysco": 2}')
  on conflict (slug) do update set cycle_date = excluded.cycle_date, emergency_override = true, vendor_picks = excluded.vendor_picks;
  insert into mog.counts (slug, cycle_date, vendor, item_id, on_hand) values
    ('zztest15', current_date, 'B&T', 'ITEM-0001', 2),
    ('zztest15', current_date, 'B&T', 'ITEM-0003', 1),
    ('zztest15', current_date, 'B&T Distribution', 'ITEM-0003', 5),
    ('zztest15', current_date, 'Sysco', 'ITEM-0001', 4);
  insert into mog.quick_edits (slug, cycle_date, by_name, kind, vendor, item_id) values ('zztest15', current_date, 'Maria', 'add_today', 'B&T', 'ITEM-0003');
  insert into mog.presence (slug, device_id, name, vendor) values ('zztest15', 'zzsmoke15device', 'Maria', 'B&T');
  insert into mog.hq_vendor_links (slug, hq_name, vendor) values ('zztest15', 'B&T Distribution', 'B&T');
  tok := public.mog_editor_login('zztest15', '4321') -> 'data' ->> 'token';
  perform pg_temp.chk('setup: the editor signs in', tok is not null, null);

  -- ---- Rename ----
  r := public.mog_editor_apply(tok, 'Renamed vendor "B&T" to "B&T Distribution"', 'Maria',
         '[{"rename": "vendors", "from": "B&T", "to": "B&T Distribution"}]'::jsonb);
  cid := (r -> 'data' ->> 'changeId')::bigint;
  perform pg_temp.chk('rename: the vendor takes the new name and keeps its days and cutoff',
    (r ->> 'ok')::boolean
      and not exists (select 1 from mog.vendors where slug = 'zztest15' and name = 'B&T')
      and (select mults = '{0,2,0,3,0,0,2}'::numeric[] and cutoff = '16:00' from mog.vendors where slug = 'zztest15' and name = 'B&T Distribution'), r);
  perform pg_temp.chk('rename: its items'' main vendor and vendor lists follow, in place',
    (select primary_vendor = 'B&T Distribution' and eligible_vendors = '{"B&T Distribution",Sysco}' from mog.items where slug = 'zztest15' and item_id = 'ITEM-0001')
      and (select primary_vendor = 'Sysco' and eligible_vendors = '{Sysco,"B&T Distribution"}' from mog.items where slug = 'zztest15' and item_id = 'ITEM-0003'),
    (select jsonb_agg(jsonb_build_array(item_id, primary_vendor, eligible_vendors) order by item_id) from mog.items where slug = 'zztest15'));
  perform pg_temp.chk('rename: its pick rows follow, with their areas and order',
    (select count(*) = 2 from mog.pick_rows where slug = 'zztest15' and vendor = 'B&T Distribution')
      and not exists (select 1 from mog.pick_rows where slug = 'zztest15' and vendor = 'B&T')
      and (select area = 'Dry Storage' and shelf_order = 30 from mog.pick_rows where slug = 'zztest15' and vendor = 'B&T Distribution' and item_id = 'ITEM-0003'), null);
  perform pg_temp.chk('rename: today''s counts move; one already under the new name keeps its place',
    pg_temp.cnt('B&T Distribution', 'ITEM-0001') = 2 and pg_temp.cnt('B&T Distribution', 'ITEM-0003') = 5
      and pg_temp.cnt('B&T', 'ITEM-0003') = 1 and pg_temp.cnt('B&T', 'ITEM-0001') is null and pg_temp.cnt('Sysco', 'ITEM-0001') = 4,
    (select jsonb_agg(jsonb_build_array(vendor, item_id, on_hand) order by vendor, item_id) from mog.counts where slug = 'zztest15'));
  perform pg_temp.chk('rename: the "just today" edit, the override''s day pick and presence follow',
    (select vendor = 'B&T Distribution' from mog.quick_edits where slug = 'zztest15')
      and (select vendor_picks = '{"B&T Distribution": 3, "Sysco": 2}'::jsonb from mog.store_state where slug = 'zztest15')
      and (select vendor = 'B&T Distribution' from mog.presence where slug = 'zztest15'),
    (select vendor_picks from mog.store_state where slug = 'zztest15'));
  perform pg_temp.chk('rename: HQ''s remembered name follows',
    (select vendor = 'B&T Distribution' from mog.hq_vendor_links where slug = 'zztest15' and hq_name = 'B&T Distribution'), null);
  perform pg_temp.chk('rename: phones see the new name',
    (select payload -> 'vendorList' ? 'B&T Distribution' and not payload -> 'vendorList' ? 'B&T' from mog.catalog where slug = 'zztest15'),
    (select payload -> 'vendorList' from mog.catalog where slug = 'zztest15'));
  perform pg_temp.chk('rename: one change in the store''s log',
    (select label = 'Renamed vendor "B&T" to "B&T Distribution"' and ops = '[{"rename": "vendors", "from": "B&T", "to": "B&T Distribution"}]'::jsonb
       from mog.change_log where id = cid), null);

  -- ---- Undo ----
  r := public.mog_editor_undo(tok, cid, 'Maria');
  perform pg_temp.chk('undo: the old name comes back everywhere it went',
    (r ->> 'ok')::boolean
      and exists (select 1 from mog.vendors where slug = 'zztest15' and name = 'B&T')
      and not exists (select 1 from mog.vendors where slug = 'zztest15' and name = 'B&T Distribution')
      and (select primary_vendor = 'B&T' and eligible_vendors = '{B&T,Sysco}' from mog.items where slug = 'zztest15' and item_id = 'ITEM-0001')
      and (select count(*) = 2 from mog.pick_rows where slug = 'zztest15' and vendor = 'B&T')
      and pg_temp.cnt('B&T', 'ITEM-0001') = 2 and pg_temp.cnt('B&T', 'ITEM-0003') = 1 and pg_temp.cnt('B&T Distribution', 'ITEM-0003') = 5
      and (select vendor = 'B&T' from mog.quick_edits where slug = 'zztest15')
      and (select vendor_picks = '{"B&T": 3, "Sysco": 2}'::jsonb from mog.store_state where slug = 'zztest15')
      and (select vendor = 'B&T' from mog.hq_vendor_links where slug = 'zztest15'), r);

  -- ---- A change of capitals ----
  r := public.mog_editor_apply(tok, 'Renamed vendor "ELPIS" to "Elpis"', null, '[{"rename": "vendors", "from": "ELPIS", "to": "Elpis"}]'::jsonb);
  perform pg_temp.chk('capitals only: "ELPIS" becomes "Elpis", its item and pick row with it',
    (r ->> 'ok')::boolean
      and (select primary_vendor = 'Elpis' and eligible_vendors = '{Elpis}' from mog.items where slug = 'zztest15' and item_id = 'ITEM-0002')
      and exists (select 1 from mog.pick_rows where slug = 'zztest15' and vendor = 'Elpis'), r);

  -- ---- Refused, nothing changed ----
  r := public.mog_editor_apply(tok, 'x', null, '[{"rename": "vendors", "from": "Sysco", "to": "elpis"}]'::jsonb);
  perform pg_temp.chk('refused: a name another vendor has (ignoring case) is a CONFLICT, and nothing changes',
    r ->> 'error' = 'CONFLICT' and exists (select 1 from mog.vendors where slug = 'zztest15' and name = 'Sysco')
      and (select primary_vendor = 'Sysco' from mog.items where slug = 'zztest15' and item_id = 'ITEM-0003'), r);
  r := public.mog_editor_apply(tok, 'x', null, '[{"rename": "vendors", "from": "B&T Distribution", "to": "BT"}]'::jsonb);
  perform pg_temp.chk('refused: a vendor that isn''t there by that name is a CONFLICT', r ->> 'error' = 'CONFLICT', r);
  r := public.mog_editor_apply(tok, 'x', null, '[{"rename": "vendors", "from": "B&T", "to": "Restaurant Depot"},
                                                  {"rename": "vendors", "from": "Sysco", "to": "restaurant depot"}]'::jsonb);
  perform pg_temp.chk('refused: all or none: a second step''s CONFLICT undoes the first',
    r ->> 'error' = 'CONFLICT' and exists (select 1 from mog.vendors where slug = 'zztest15' and name = 'B&T')
      and pg_temp.cnt('B&T', 'ITEM-0001') = 2, r);
  r := public.mog_editor_apply(tok, 'x', null, '[{"rename": "items", "from": "Lime", "to": "Limes"}]'::jsonb);
  perform pg_temp.chk('refused: only areas and vendors rename this way', r ->> 'error' like 'REJECTED: BAD_OP%', r);

  -- ---- Areas still rename ----
  r := public.mog_editor_apply(tok, 'Saved the storage areas: renamed Walk-in → Cooler', null, '[{"rename": "areas", "from": "Walk-in", "to": "Cooler"}]'::jsonb);
  perform pg_temp.chk('areas: a storage area still renames, its pick rows with it',
    (r ->> 'ok')::boolean and (select count(*) = 2 from mog.pick_rows where slug = 'zztest15' and area = 'Cooler'), r);

  -- ---- Clean up ----
  delete from mog.stores where slug = 'zztest15';
  perform pg_temp.chk('cleanup: the test store is gone',
    not exists (select 1 from mog.stores where slug = 'zztest15')
      and not exists (select 1 from mog.change_log where slug = 'zztest15')
      and not exists (select 1 from mog.counts where slug = 'zztest15')
      and not exists (select 1 from mog.hq_vendor_links where slug = 'zztest15'), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke15 order by n;
