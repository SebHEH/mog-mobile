-- =====================================================================
-- MOG schema v21 — smoke test (run in the SQL Editor AFTER schema_v21.sql)
-- =====================================================================
-- Sebastian's shrimp, as routes, on throwaway stores: 'zztest21t' holds a
-- place (like RP Tysons BOH, ordering from Capital until it routes to
-- Happy Supply), 'zztest21r' takes from it (like Rosslyn BOH, under its
-- "Transfer (Tysons)"), 'zztest21e' takes HEH's bowls from Elpis. The HQ
-- person 'zz smoke 21' and warehouse rows named 'zz smoke 21 ...' (holder
-- name 'zz smoke 21 Holder', so the real Elpis and Tysons rows are never
-- touched). Checks: a route in the item's row (HQ's change, CONFLICT on any
-- route field, Undo), a new vendor in the same change, refusals, the
-- phone's read, Send, a move into the holder's place, the close by route
-- (with no remembered names at all), a rename and a removed vendor
-- followed, the warehouse read's routes, a place at a store held under its
-- own name with no low point, the retired product fields never written.
-- Cleans up after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke21 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke21;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke21 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

create or replace function pg_temp.clean21()
returns void language sql as $$
  delete from mog.stores where slug in ('zztest21t', 'zztest21r', 'zztest21e');
  delete from mog.wh_moves where product_id in (select id from mog.wh_products where name like 'zz smoke 21 %');
  delete from mog.wh_stock where product_id in (select id from mog.wh_products where name like 'zz smoke 21 %');
  delete from mog.wh_products where name like 'zz smoke 21 %';
  delete from mog.wh_locations where name like 'zz smoke 21 %';
  delete from mog.hq_users where name = 'zz smoke 21';
$$;

-- A store on the app's editor and phones, counting today. Answers its sync key.
create or replace function pg_temp.store21(p_slug text, p_location text, p_vendors jsonb, p_items jsonb, p_picks jsonb)
returns text language plpgsql as $$
declare
  k text;
begin
  k := mog.provision_store(p_slug);
  perform public.mog_sync_set_pins(p_slug, k, '4321', null);
  perform mog.replace_catalog_tables(p_slug, jsonb_build_object(
    'profile', jsonb_build_object('timeZone', 'America/New_York', 'location', p_location, 'abbr', 'ZZ21', 'concept', 'zz-smoke21'),
    'vendors', p_vendors, 'areas', '[{"name": "Freezer", "ord": 10}]'::jsonb, 'items', p_items, 'pickRows', p_picks));
  perform public.mog_sync_switch_editor(p_slug, k, false);
  perform public.mog_sync_set_phone_direct(p_slug, k, true);
  insert into mog.store_state (slug, cycle_date, day_of_week) values (p_slug, current_date, 'Mon')
  on conflict (slug) do update set cycle_date = excluded.cycle_date;
  return k;
end;
$$;

create or replace function pg_temp.item21(p_id text, p_name text, p_vendor text, p_eligible jsonb, p_par numeric, p_seq integer)
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'name', p_name, 'primaryVendor', p_vendor, 'pack', 'CASE (10LBs)', 'par', p_par, 'active', true,
                            'useMult', true, 'notes', '', 'sku', '', 'category', '', 'eligible', p_eligible, 'seq', p_seq);
$$;

-- An item's row as the editor reads it.
create or replace function pg_temp.row21(p_slug text, p_id text)
returns jsonb language sql as $$
  select e from jsonb_array_elements(mog.tables_json(p_slug) -> 'items') e where e ->> 'id' = p_id;
$$;

-- What the close sends: { vendor, id, name, qty }.
create or replace function pg_temp.log21(p_vendor text, p_id text, p_name text, p_qty numeric)
returns jsonb language sql as $$
  select jsonb_build_object('vendor', p_vendor, 'id', p_id, 'name', p_name, 'pack', '', 'area', 'Freezer', 'onHandPrev', 0, 'qty', p_qty);
$$;

-- One HQ change at one store.
create or replace function pg_temp.hq21(p_tok text, p_slug text, p_ops jsonb)
returns jsonb language sql as $$
  select public.mog_hq_apply(p_tok, jsonb_build_array(jsonb_build_object('slug', p_slug, 'label', 'HQ: routes', 'ops', p_ops)), '[]'::jsonb);
$$;

do $$
declare
  me      text := 'zz smoke 21';
  pass    text := 'correct horse battery';
  code    text;
  tok     text;    -- HQ, hq and warehouse
  ptokt   text;    -- zztest21t's phone (holds the place)
  ptokr   text;    -- zztest21r's phone (takes from it)
  etokr   text;    -- zztest21r's editor
  kt      text;
  kr      text;
  locH    bigint;  -- HEH's own
  locT    bigint;  -- at the store zztest21t
  locE    bigint;  -- held by a vendor
  shrimp  bigint;
  bowls   bigint;
  r       jsonb;
  d       jsonb;
  before1 jsonb;
  row1    jsonb;
  cid     bigint;
  hs1     bigint;
  del1    bigint;
  num1    text;
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key cannot reach the routes read or the places table; the old routing is gone',
    not has_function_privilege('anon', 'mog.wh_routes_json()', 'execute')
      and not has_function_privilege('anon', 'mog.wh_place_carries(bigint, bigint)', 'execute')
      and not has_table_privilege('anon', 'mog.wh_product_places', 'select')
      and (select relrowsecurity from pg_class where oid = 'mog.wh_product_places'::regclass)
      and to_regprocedure('mog.wh_item_place(text, text, bigint)') is null
      and to_regprocedure('mog.wh_store_vendor(text)') is null
      and to_regprocedure('mog.wh_held_vendor(text, text)') is null, null);

  perform pg_temp.clean21();

  -- ---- People and stores ----
  code := substring(mog.hq_invite(me, '{hq,warehouse}') from ': ([0-9A-F]+)');
  tok := public.mog_hq_claim(me, code, pass) -> 'data' ->> 'token';
  kt := pg_temp.store21('zztest21t', 'Smoke v21 Tysons BOH',
    '[{"name": "Capital", "mults": [1,1,1,1,1.5,0,1], "cutoff": "22:00"}, {"name": "Transfer (Rosslyn)", "mults": [0,0,1,0,1,0,1], "cutoff": null}]'::jsonb,
    jsonb_build_array(pg_temp.item21('ITEM-0091', 'SHRIMP', 'Capital', '["Capital"]', 6, 2)),
    '[{"vendor": "Capital", "id": "ITEM-0091", "area": "Freezer", "shelfOrder": 10, "seq": 2}]'::jsonb);
  kr := pg_temp.store21('zztest21r', 'Smoke v21 Rosslyn BOH',
    '[{"name": "Transfer (Tysons)", "mults": [0,0,1.2,0,1.2,0,1], "cutoff": "19:30"}, {"name": "SamuelSon", "mults": [0,0,2,0,2,0,3], "cutoff": "22:30"}]'::jsonb,
    jsonb_build_array(pg_temp.item21('ITEM-0091', 'SHRIMP', 'Transfer (Tysons)', '["Transfer (Tysons)", "SamuelSon"]', 7.15, 2),
                      pg_temp.item21('ITEM-0185', '12QT CONTAINERS', 'Transfer (Tysons)', '["Transfer (Tysons)"]', 15, 3)),
    '[{"vendor": "Transfer (Tysons)", "id": "ITEM-0091", "area": "Freezer", "shelfOrder": 10, "seq": 2},
      {"vendor": "SamuelSon", "id": "ITEM-0091", "area": "Freezer", "shelfOrder": 10, "seq": 3},
      {"vendor": "Transfer (Tysons)", "id": "ITEM-0185", "area": "Freezer", "shelfOrder": 20, "seq": 4}]'::jsonb);
  perform pg_temp.store21('zztest21e', 'Smoke v21 Rosslyn FOH',
    '[{"name": "Elpis", "mults": [0,1,0,1,0,0,0], "cutoff": "10:00"}, {"name": "Transfer", "mults": [0,0,1,0,1,0,1], "cutoff": null}]'::jsonb,
    jsonb_build_array(pg_temp.item21('ITEM-0003', 'RP Large Bowls', 'Elpis', '["Elpis"]', 3, 2)),
    '[{"vendor": "Elpis", "id": "ITEM-0003", "area": "Freezer", "shelfOrder": 10, "seq": 2}]'::jsonb);
  ptokt := public.mog_login('zztest21t', '4321') -> 'data' ->> 'token';
  ptokr := public.mog_login('zztest21r', '4321') -> 'data' ->> 'token';
  etokr := public.mog_editor_login('zztest21r', '4321') -> 'data' ->> 'token';
  perform pg_temp.chk('setup: HQ, both phones and the editor sign in',
    tok is not null and ptokt is not null and ptokr is not null and etokr is not null, null);

  -- ---- Places and items ----
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 21 Happy Supply", "countHow": "hq"}');
  locH := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 21 Tysons", "heldStore": "zztest21t", "countHow": "marginedge"}');
  locT := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform pg_temp.chk('place: one at a store is held under its own name',
    (r ->> 'ok')::boolean and (select held_by = 'zz smoke 21 Tysons' and held_store = 'zztest21t' from mog.wh_locations where id = locT), r);
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 21 Elpis", "heldBy": "zz smoke 21 Holder", "countHow": "report"}');
  locE := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('name', 'zz smoke 21 shrimp', 'pack', 'CASE (10LBs)', 'handlingFee', 0, 'active', true,
         'concept', 'zz-smoke21', 'par', 19, 'stores', '["zztest21t"]'::jsonb, 'via', 'zz smoke 21 Holder',
         'places', jsonb_build_array(jsonb_build_object('locationId', locH, 'lowPoint', 10), jsonb_build_object('locationId', locT, 'lowPoint', 20))));
  shrimp := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform pg_temp.chk('item: the retired par, stores and via are never written; a place at a store has no low point of its own',
    (r ->> 'ok')::boolean
      -- v24 dropped the columns: read through the row, so this holds before and after
      and (select coalesce((to_jsonb(p) ->> 'par')::numeric, 0) = 0 and coalesce(to_jsonb(p) -> 'stores', '[]'::jsonb) = '[]'::jsonb
                  and to_jsonb(p) ->> 'via' is null from mog.wh_products p where p.id = shrimp)
      and (select low_point from mog.wh_product_places where product_id = shrimp and location_id = locH) = 10
      and (select low_point from mog.wh_product_places where product_id = shrimp and location_id = locT) = 0
      and not exists (select 1 from jsonb_array_elements(r -> 'data' -> 'products') p
                       where (p ->> 'id')::bigint = shrimp and (p ? 'par' or p ? 'stores' or p ? 'via')), r -> 'error');
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('name', 'zz smoke 21 bowls', 'pack', 'CASE (300)', 'handlingFee', 0, 'active', true,
         'places', jsonb_build_array(jsonb_build_object('locationId', locE))));
  bowls := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform mog.wh_move(me, shrimp, locH, 30, 'received', 'zz', 65, null);
  perform mog.wh_move(me, bowls, locE, 9, 'received', 'zz', 41, null);
  r := public.mog_wh_count(tok, jsonb_build_object('locationId', locT, 'lines', jsonb_build_array(
         jsonb_build_object('productId', shrimp, 'cases', 104, 'reason', 'Starting inventory'))));
  perform pg_temp.chk('setup: stock at each place (30 at HEH''s own, 104 at Tysons, 9 at Elpis)',
    (select cases from mog.wh_stock where product_id = shrimp and location_id = locT) = 104
      and (select cases from mog.wh_stock where product_id = bowls and location_id = locE) = 9, r -> 'error');
  perform pg_temp.chk('read: a store with no route reads exactly as before',
    not (mog.live_json('zztest21r', null) ? 'happySupply')
      and not exists (select 1 from jsonb_array_elements(mog.tables_json('zztest21r') -> 'items') e where e ? 'whVendor' or e ? 'whPlace'), null);

  -- ---- HQ routes Rosslyn's SHRIMP from Tysons, under its Transfer (Tysons) ----
  before1 := pg_temp.row21('zztest21r', 'ITEM-0091');
  r := pg_temp.hq21(tok, 'zztest21r', jsonb_build_array(jsonb_build_object('t', 'items', 'before', before1,
         'after', before1 || jsonb_build_object('whProduct', shrimp, 'whPlace', locT, 'whVendor', 'Transfer (Tysons)'))));
  cid := (r -> 'data' -> 'changes' -> 0 ->> 'changeId')::bigint;
  row1 := pg_temp.row21('zztest21r', 'ITEM-0091');
  perform pg_temp.chk('route: HQ''s change writes it in the item''s row, read back in the editor''s tables',
    (r ->> 'ok')::boolean and (row1 ->> 'whProduct')::bigint = shrimp and (row1 ->> 'whPlace')::bigint = locT
      and row1 ->> 'whVendor' = 'Transfer (Tysons)' and row1 ->> 'primaryVendor' = 'Transfer (Tysons)'
      and (select wh_place = locT and wh_vendor = 'Transfer (Tysons)' from mog.items where slug = 'zztest21r' and item_id = 'ITEM-0091'), r);
  r := public.mog_editor_apply(etokr, 'Edited "SHRIMP": par 7.15 → 8', 'Maria',
         jsonb_build_array(jsonb_build_object('t', 'items', 'before', before1, 'after', before1 || '{"par": 8}'::jsonb)));
  perform pg_temp.chk('route: a page that read the row before HQ''s change gets CONFLICT',
    r ->> 'error' = 'CONFLICT' and pg_temp.row21('zztest21r', 'ITEM-0091') = row1, r);
  update mog.items set wh_vendor = 'SamuelSon' where slug = 'zztest21r' and item_id = 'ITEM-0091';
  r := public.mog_editor_apply(etokr, 'Edited "SHRIMP": par 7.15 → 8', 'Maria',
         jsonb_build_array(jsonb_build_object('t', 'items', 'before', row1, 'after', row1 || '{"par": 8}'::jsonb)));
  perform pg_temp.chk('route: a row that differs only by its route''s vendor gets CONFLICT',
    r ->> 'error' = 'CONFLICT' and (select par from mog.items where slug = 'zztest21r' and item_id = 'ITEM-0091') = 7.15, r);
  update mog.items set wh_vendor = 'Transfer (Tysons)', wh_place = locH where slug = 'zztest21r' and item_id = 'ITEM-0091';
  r := public.mog_editor_apply(etokr, 'Edited "SHRIMP": par 7.15 → 8', 'Maria',
         jsonb_build_array(jsonb_build_object('t', 'items', 'before', row1, 'after', row1 || '{"par": 8}'::jsonb)));
  perform pg_temp.chk('route: a row that differs only by its route''s place gets CONFLICT',
    r ->> 'error' = 'CONFLICT' and (select par from mog.items where slug = 'zztest21r' and item_id = 'ITEM-0091') = 7.15, r);
  update mog.items set wh_place = locT where slug = 'zztest21r' and item_id = 'ITEM-0091';
  r := public.mog_editor_undo(etokr, cid, 'Maria');
  perform pg_temp.chk('route: the store''s Undo takes the route off with the rest of the change',
    (r ->> 'ok')::boolean and not (pg_temp.row21('zztest21r', 'ITEM-0091') ? 'whVendor') and not (pg_temp.row21('zztest21r', 'ITEM-0091') ? 'whPlace')
      and not (pg_temp.row21('zztest21r', 'ITEM-0091') ? 'whProduct'), r);
  r := public.mog_editor_undo(etokr, (r -> 'data' ->> 'changeId')::bigint, 'Maria');
  perform pg_temp.chk('route: undoing the Undo puts the whole route back',
    (r ->> 'ok')::boolean and pg_temp.row21('zztest21r', 'ITEM-0091') = row1, r);

  -- ---- Refusals ----
  before1 := pg_temp.row21('zztest21r', 'ITEM-0185');
  r := pg_temp.hq21(tok, 'zztest21r', jsonb_build_array(jsonb_build_object('t', 'items', 'before', before1,
         'after', before1 || jsonb_build_object('whProduct', shrimp, 'whPlace', locT, 'whVendor', 'Nobody Inc'))));
  perform pg_temp.chk('route: a vendor the store doesn''t have is refused, writing nothing',
    r ->> 'error' like 'REJECTED: zztest21r Vendor "Nobody Inc" is not listed%' and not (pg_temp.row21('zztest21r', 'ITEM-0185') ? 'whProduct'), r);
  r := pg_temp.hq21(tok, 'zztest21r', jsonb_build_array(jsonb_build_object('t', 'items', 'before', before1,
         'after', before1 || jsonb_build_object('whProduct', shrimp, 'whPlace', 999999999, 'whVendor', 'Transfer (Tysons)'))));
  perform pg_temp.chk('route: a place that isn''t there is refused, writing nothing',
    r ->> 'error' like 'REJECTED: %that place isn''t in the warehouse%' and not (pg_temp.row21('zztest21r', 'ITEM-0185') ? 'whProduct'), r);

  -- ---- RP Tysons routes from Happy Supply, adding the vendor in the same change ----
  before1 := pg_temp.row21('zztest21t', 'ITEM-0091');
  r := pg_temp.hq21(tok, 'zztest21t', jsonb_build_array(
         jsonb_build_object('t', 'vendors', 'before', null, 'after', '{"name": "HS Co", "mults": [0,0,2,0,2,0,3], "cutoff": null}'::jsonb),
         jsonb_build_object('t', 'pickRows', 'before', null, 'after', '{"vendor": "HS Co", "id": "ITEM-0091", "area": "Freezer", "shelfOrder": 10}'::jsonb),
         jsonb_build_object('t', 'items', 'before', before1, 'after', before1 || jsonb_build_object('primaryVendor', 'HS Co',
           'eligible', '["HS Co", "Capital"]'::jsonb, 'whProduct', shrimp, 'whVendor', 'HS Co'))));
  perform pg_temp.chk('route: a new vendor and the route in one change (HEH''s own: no place)',
    (r ->> 'ok')::boolean and exists (select 1 from mog.vendors where slug = 'zztest21t' and name = 'HS Co')
      and (select wh_vendor = 'HS Co' and wh_place is null and primary_vendor = 'HS Co' from mog.items where slug = 'zztest21t' and item_id = 'ITEM-0091'), r);
  update mog.items set wh_product = bowls, wh_place = locE, wh_vendor = 'Elpis' where slug = 'zztest21e' and item_id = 'ITEM-0003';

  -- ---- The phone's read, from routes ----
  d := mog.live_json('zztest21r', null) -> 'happySupply';
  perform pg_temp.chk('read: the taker counts on Tysons (104) under its Transfer (Tysons); no Happy Supply vendor there',
    (d -> 'items' -> 'ITEM-0091' ->> 'available')::numeric = 104 and d -> 'heldVendors' = '["Transfer (Tysons)"]'::jsonb
      and d -> 'vendor' = 'null'::jsonb and not (d -> 'items' ? 'ITEM-0185'), d);
  d := mog.live_json('zztest21t', null) -> 'happySupply';
  perform pg_temp.chk('read: the holder counts on HEH''s own (30), never its own place, and its Happy Supply is HS Co',
    (d -> 'items' -> 'ITEM-0091' ->> 'available')::numeric = 30 and d ->> 'vendor' = 'HS Co' and not (d ? 'heldVendors'), d);
  d := mog.live_json('zztest21e', null) -> 'happySupply';
  perform pg_temp.chk('read: the bowls count on Elpis (9)',
    (d -> 'items' -> 'ITEM-0003' ->> 'available')::numeric = 9 and d -> 'heldVendors' = '["Elpis"]'::jsonb, d);

  -- ---- Send and the move into Tysons ----
  r := public.mog_wh_send(ptokr, '{"vendor": "Transfer (Tysons)", "lines": [{"itemId": "ITEM-0091", "cases": 1}]}');
  perform pg_temp.chk('send: a vendor that routes to a held place isn''t Happy Supply', r ->> 'error' like 'REJECTED: Transfer (Tysons) isn''t this store''s Happy Supply%', r);
  r := public.mog_wh_send(ptokt, '{"vendor": "HS Co", "by": "Kim", "lines": [{"itemId": "ITEM-0091", "cases": 6}]}');
  hs1 := (r -> 'data' -> 'order' ->> 'id')::bigint;
  perform pg_temp.chk('send: the holder sends its Happy Supply order by its route', (r ->> 'ok')::boolean and hs1 is not null, r);
  r := public.mog_wh_ship(tok, jsonb_build_object('id', hs1, 'version', 1, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 6, 'locationId', locH))));
  perform pg_temp.chk('ship: into the holder''s place, a move with no price',
    (r ->> 'ok')::boolean and (select to_location = locT and price is null from mog.wh_order_lines where order_id = hs1), r);
  r := public.mog_wh_received(ptokt, jsonb_build_object('id', hs1, 'by', 'Kim'));
  perform pg_temp.chk('check in: the cases land in Tysons (104 + 6)',
    (r ->> 'ok')::boolean and (select cases from mog.wh_stock where product_id = shrimp and location_id = locT) = 110, r);

  -- ---- The close, by route, with no remembered names at all ----
  r := public.mog_sync_close_cycle('zztest21r', kr, current_date, current_date + 1, to_char(current_date + 1, 'Dy'),
         jsonb_build_array(pg_temp.log21('Transfer (Tysons)', 'ITEM-0091', 'SHRIMP', 4), pg_temp.log21('SamuelSon', 'ITEM-0091', 'SHRIMP', 1),
                           pg_temp.log21('Transfer (Tysons)', 'ITEM-0185', '12QT CONTAINERS', 2)), '[]'::jsonb, null);
  select id, number into del1, num1 from mog.wh_orders where slug = 'zztest21r' and held_at = locT;
  perform pg_temp.chk('close: only the routed item''s lines under the route''s vendor become a delivery from Tysons',
    (r ->> 'ok')::boolean and not (r -> 'data' ? 'heldError') and num1 ~ '^EL-[0-9]{4,}$'
      and (select vendor from mog.wh_orders where id = del1) = 'Transfer (Tysons)'
      and (select jsonb_agg(jsonb_build_array(item_id, cases)) from mog.wh_order_lines where order_id = del1) = '[["ITEM-0091", 4]]'::jsonb
      and not exists (select 1 from mog.hq_vendor_links where slug in ('zztest21t', 'zztest21r', 'zztest21e')), r);
  r := public.mog_sync_close_cycle('zztest21t', kt, current_date, current_date + 1, to_char(current_date + 1, 'Dy'),
         jsonb_build_array(pg_temp.log21('HS Co', 'ITEM-0091', 'SHRIMP', 2), pg_temp.log21('Capital', 'ITEM-0091', 'SHRIMP', 1)), '[]'::jsonb, null);
  perform pg_temp.chk('close: never a delivery for the holder from its own place',
    (r ->> 'ok')::boolean and not exists (select 1 from mog.wh_orders where slug = 'zztest21t' and held_at is not null), r);
  r := public.mog_snapshot2(ptokr, null, null, null, null);
  d := (select o from jsonb_array_elements(r -> 'data' -> 'happySupply' -> 'orders') o where (o ->> 'id')::bigint = del1);
  perform pg_temp.chk('read: the taker''s phone gets the delivery under its route''s vendor, and Tysons holds it (110 - 4)',
    d ->> 'heldVendor' = 'Transfer (Tysons)' and (d ->> 'held')::boolean
      and (r -> 'data' -> 'happySupply' -> 'items' -> 'ITEM-0091' ->> 'available')::numeric = 106, r -> 'data' -> 'happySupply');
  r := public.mog_wh_received(ptokr, jsonb_build_object('id', del1, 'by', 'Lee'));
  perform pg_temp.chk('check in: the delivery comes off Tysons (110 - 4)',
    (r ->> 'ok')::boolean and (select cases from mog.wh_stock where product_id = shrimp and location_id = locT) = 106, r);

  -- ---- A rename at the store follows; HQ's read has every route ----
  r := public.mog_editor_apply(etokr, 'Renamed vendor "Transfer (Tysons)" to "Transfer TY"', 'Maria',
         '[{"rename": "vendors", "from": "Transfer (Tysons)", "to": "Transfer TY"}]'::jsonb);
  perform pg_temp.chk('rename: the route''s vendor follows a store''s rename, and so does the phone',
    (r ->> 'ok')::boolean and (select wh_vendor from mog.items where slug = 'zztest21r' and item_id = 'ITEM-0091') = 'Transfer TY'
      and mog.live_json('zztest21r', null) -> 'happySupply' -> 'heldVendors' = '["Transfer TY"]'::jsonb
      and mog.wh_order_phone_json(del1) ->> 'heldVendor' = 'Transfer TY', r);
  r := public.mog_wh_data(tok);
  perform pg_temp.chk('read: HQ''s warehouse read lists each store''s route beside what the store has now',
    (r ->> 'ok')::boolean
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'routes') x
                   where x ->> 'slug' = 'zztest21r' and x ->> 'itemId' = 'ITEM-0091' and (x ->> 'productId')::bigint = shrimp
                     and (x ->> 'placeId')::bigint = locT and x ->> 'vendor' = 'Transfer TY' and x ->> 'mainVendor' = 'Transfer TY'
                     and (x ->> 'active')::boolean and x ->> 'store' = 'Smoke v21 Rosslyn BOH')
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'routes') x
                   where x ->> 'slug' = 'zztest21t' and x -> 'placeId' = 'null'::jsonb and x ->> 'vendor' = 'HS Co' and (x ->> 'par')::numeric = 6), r -> 'data' -> 'routes');

  -- ---- A broken route: the store moves its main vendor, then removes the route's vendor ----
  update mog.items set primary_vendor = 'SamuelSon' where slug = 'zztest21r' and item_id = 'ITEM-0091';
  r := public.mog_sync_close_cycle('zztest21r', kr, current_date + 1, current_date + 2, to_char(current_date + 2, 'Dy'),
         jsonb_build_array(pg_temp.log21('SamuelSon', 'ITEM-0091', 'SHRIMP', 3)), '[]'::jsonb, null);
  perform pg_temp.chk('broken: orders under another vendor never come off Tysons; HQ sees the main vendor moved',
    (r ->> 'ok')::boolean and not exists (select 1 from mog.wh_orders where slug = 'zztest21r' and held_at = locT and cycle_date = current_date + 1)
      and exists (select 1 from jsonb_array_elements(mog.wh_routes_json()) x
                   where x ->> 'slug' = 'zztest21r' and x ->> 'vendor' = 'Transfer TY' and x ->> 'mainVendor' = 'SamuelSon'), r);
  delete from mog.pick_rows where slug = 'zztest21r' and vendor = 'Transfer TY';
  update mog.items set eligible_vendors = '{SamuelSon}', primary_vendor = 'SamuelSon' where slug = 'zztest21r';
  delete from mog.vendors where slug = 'zztest21r' and name = 'Transfer TY';
  perform pg_temp.chk('broken: a removed vendor empties the route''s vendor, keeps the link and the place; the phone stops counting on it',
    (select wh_vendor is null and wh_place = locT and wh_product = shrimp from mog.items where slug = 'zztest21r' and item_id = 'ITEM-0091')
      and not coalesce(mog.live_json('zztest21r', null) -> 'happySupply' -> 'items' ? 'ITEM-0091', false), null);

  perform pg_temp.clean21();
  perform pg_temp.chk('cleanup: nothing of the smoke is left',
    not exists (select 1 from mog.stores where slug in ('zztest21t', 'zztest21r', 'zztest21e'))
      and not exists (select 1 from mog.wh_orders where slug in ('zztest21t', 'zztest21r', 'zztest21e'))
      and not exists (select 1 from mog.wh_products where name like 'zz smoke 21 %')
      and not exists (select 1 from mog.wh_locations where name like 'zz smoke 21 %')
      and not exists (select 1 from mog.hq_users where name = 'zz smoke 21'), null);
end;
$$;

select n, case when ok then 'PASS' else 'FAIL' end as result, check_name, detail from mog_smoke21 order by n;
