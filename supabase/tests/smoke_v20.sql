-- =====================================================================
-- MOG schema v20 — smoke test (run in the SQL Editor AFTER schema_v20.sql)
-- =====================================================================
-- Throwaway stores 'zztest20' (holds a place, like RP Tysons) and
-- 'zztest20b' (takes from it, like Rosslyn BOH), the HQ people
-- 'zz smoke 20' (hq and warehouse) and 'zz smoke 20 hq' (hq only), and
-- warehouse rows named 'zz smoke 20 ...' (holder names 'zz smoke 20
-- Transfer' and 'zz smoke 20 Holder', so the real Elpis and Tysons rows are
-- never touched): a place at a store and its rules, a product's places with
-- low points, each item's cases from its own source place, a Happy Supply
-- order from the holding store shipped as a move (no price) and checked in
-- into its place (on the phone and by HQ), a plain sale still the store's,
-- the close recording the taker's deliveries by place and never the
-- holder's own, and who took what (an opening count isn't use). Cleans up
-- after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke20 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke20;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke20 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

create or replace function pg_temp.clean20()
returns void language sql as $$
  delete from mog.stores where slug in ('zztest20', 'zztest20b');
  delete from mog.wh_moves where product_id in (select id from mog.wh_products where name like 'zz smoke 20 %');
  delete from mog.wh_stock where product_id in (select id from mog.wh_products where name like 'zz smoke 20 %');
  delete from mog.wh_products where name like 'zz smoke 20 %';
  delete from mog.wh_locations where name like 'zz smoke 20 %';
  delete from mog.hq_users where name in ('zz smoke 20', 'zz smoke 20 hq');
$$;

-- A store on the app's editor and phones, counting today, with its vendors,
-- items and HQ vendor names. Answers its sync key.
create or replace function pg_temp.store20(p_slug text, p_location text, p_vendors jsonb, p_items jsonb, p_picks jsonb, p_links jsonb)
returns text language plpgsql as $$
declare
  k text;
begin
  k := mog.provision_store(p_slug);
  perform public.mog_sync_set_pins(p_slug, k, '4321', null);
  perform mog.replace_catalog_tables(p_slug, jsonb_build_object(
    'profile', jsonb_build_object('timeZone', 'America/New_York', 'location', p_location, 'abbr', 'ZZ20', 'concept', 'zz-smoke20'),
    'vendors', p_vendors, 'areas', '[{"name": "Freezer", "ord": 10}]'::jsonb, 'items', p_items, 'pickRows', p_picks));
  perform public.mog_sync_switch_editor(p_slug, k, false);
  perform public.mog_sync_set_phone_direct(p_slug, k, true);
  insert into mog.store_state (slug, cycle_date, day_of_week) values (p_slug, current_date, 'Mon')
  on conflict (slug) do update set cycle_date = excluded.cycle_date;
  insert into mog.hq_vendor_links (slug, hq_name, vendor)
  select p_slug, e ->> 0, e ->> 1 from jsonb_array_elements(p_links) e;
  return k;
end;
$$;

-- What the close sends: { vendor, id, name, qty }.
create or replace function pg_temp.row20(p_vendor text, p_id text, p_name text, p_qty numeric)
returns jsonb language sql as $$
  select jsonb_build_object('vendor', p_vendor, 'id', p_id, 'name', p_name, 'pack', '', 'area', 'Freezer', 'onHandPrev', 0, 'qty', p_qty);
$$;

-- An item row for replace_catalog_tables.
create or replace function pg_temp.item20(p_id text, p_name text, p_vendor text, p_eligible jsonb, p_seq integer)
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'name', p_name, 'primaryVendor', p_vendor, 'pack', 'CASE (10LBs)', 'par', 6, 'active', true,
                            'useMult', true, 'notes', '', 'sku', '', 'category', '', 'eligible', p_eligible, 'seq', p_seq);
$$;

do $$
declare
  me      text := 'zz smoke 20';
  pass    text := 'correct horse battery';
  code    text;
  tok     text;    -- HQ, hq and warehouse
  tokh    text;    -- HQ, hq only
  ptok    text;    -- zztest20's phone (holds the place)
  ptokb   text;    -- zztest20b's phone (takes from it)
  k       text;
  kb      text;
  locB    bigint;  -- HEH's own
  locT    bigint;  -- at the store zztest20
  locE    bigint;  -- held by a vendor
  shrimp  bigint;
  bowls   bigint;
  lids    bigint;
  cups    bigint;
  r       jsonb;
  d       jsonb;
  hsT     bigint;
  hsT2    bigint;
  hsS     bigint;
  delT    bigint;
  delE    bigint;
  numT    text;
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key can call who took what, the send and the receipt',
    has_function_privilege('anon', 'public.mog_wh_taken(text, date, date)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_send(text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_received(text, jsonb)', 'execute'), null);
  perform pg_temp.chk('privileges: the public key cannot reach the places table or the new helpers',
    not has_table_privilege('anon', 'mog.wh_product_places', 'select')
      and not has_function_privilege('anon', 'mog.wh_place_carries(bigint, bigint)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_item_place(text, text, bigint)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_available_at(bigint, bigint, text, date)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_hs_receive(bigint, text, text, jsonb)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_taken(date, date)', 'execute'), null);

  perform pg_temp.clean20();

  -- ---- People and stores ----
  code := substring(mog.hq_invite(me, '{hq,warehouse}') from ': ([0-9A-F]+)');
  tok := public.mog_hq_claim(me, code, pass) -> 'data' ->> 'token';
  code := substring(mog.hq_invite(me || ' hq', '{hq}') from ': ([0-9A-F]+)');
  tokh := public.mog_hq_claim(me || ' hq', code, pass) -> 'data' ->> 'token';
  k := pg_temp.store20('zztest20', 'Smoke v20 Tysons BOH',
    '[{"name": "HS Co", "mults": [0,1,0,1,0,0,0], "cutoff": null}, {"name": "Sysco", "mults": [1,1,1,1,1,0,0], "cutoff": null}]'::jsonb,
    jsonb_build_array(pg_temp.item20('ITEM-0001', 'Shrimp', 'HS Co', '["HS Co", "Sysco"]', 2)),
    '[{"vendor": "HS Co", "id": "ITEM-0001", "area": "Freezer", "shelfOrder": 10, "seq": 2},
      {"vendor": "Sysco", "id": "ITEM-0001", "area": "Freezer", "shelfOrder": 10, "seq": 3}]'::jsonb,
    '[["Happy Supply", "HS Co"], ["zz smoke 20 Transfer", "Sysco"]]'::jsonb);
  kb := pg_temp.store20('zztest20b', 'Smoke v20 Rosslyn BOH',
    '[{"name": "Transfer (Tysons)", "mults": [1,0,1,0,1,0,0], "cutoff": null}, {"name": "HS Co", "mults": [0,1,0,1,0,0,0], "cutoff": null},
      {"name": "Elpis", "mults": [0,1,0,1,0,0,0], "cutoff": null}]'::jsonb,
    jsonb_build_array(pg_temp.item20('ITEM-0001', 'Shrimp', 'Transfer (Tysons)', '["Transfer (Tysons)", "HS Co"]', 2),
                      pg_temp.item20('ITEM-0002', 'RP Large Bowls', 'Elpis', '["Elpis"]', 3),
                      pg_temp.item20('ITEM-0003', 'RP Large Bowl Lids', 'HS Co', '["HS Co"]', 4)),
    '[{"vendor": "Transfer (Tysons)", "id": "ITEM-0001", "area": "Freezer", "shelfOrder": 10, "seq": 2},
      {"vendor": "HS Co", "id": "ITEM-0001", "area": "Freezer", "shelfOrder": 10, "seq": 3},
      {"vendor": "Elpis", "id": "ITEM-0002", "area": "Freezer", "shelfOrder": 20, "seq": 4},
      {"vendor": "HS Co", "id": "ITEM-0003", "area": "Freezer", "shelfOrder": 30, "seq": 5}]'::jsonb,
    '[["Happy Supply", "HS Co"], ["zz smoke 20 Transfer", "Transfer (Tysons)"], ["zz smoke 20 Holder", "Elpis"]]'::jsonb);
  ptok := public.mog_login('zztest20', '4321') -> 'data' ->> 'token';
  ptokb := public.mog_login('zztest20b', '4321') -> 'data' ->> 'token';
  perform pg_temp.chk('setup: HQ and both phones sign in', tok is not null and tokh is not null and ptok is not null and ptokb is not null, null);

  -- ---- Places ----
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 20 Berliner"}');
  locB := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 20 Elpis", "heldBy": "zz smoke 20 Holder", "countHow": "report"}');
  locE := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 20 Tysons", "heldStore": "zztest20"}');
  perform pg_temp.chk('place: one at a store needs the name the other stores order it under',
    r ->> 'error' like 'REJECTED: a place at a store needs the name%' and not exists (select 1 from mog.wh_locations where name = 'zz smoke 20 Tysons'), r);
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 20 Tysons", "heldBy": "zz smoke 20 Transfer", "heldStore": "nosuchstore"}');
  perform pg_temp.chk('place: a store that isn''t there is refused', r ->> 'error' like 'REJECTED: no store called nosuchstore%', r);
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 20 Tysons", "heldBy": "zz smoke 20 Transfer", "heldStore": "zztest20", "countHow": "by eye"}');
  perform pg_temp.chk('place: how it''s counted is one of three', r ->> 'error' like 'REJECTED: a place is counted in HQ, from MarginEdge or from a report%', r);
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 20 Tysons", "heldBy": "zz smoke 20 Transfer", "heldStore": "zztest20", "countHow": "marginedge"}');
  locT := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform pg_temp.chk('place: at a store, with its store''s name and how it''s counted; HEH''s own carries none of it',
    (r ->> 'ok')::boolean
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'locations') l
                   where (l ->> 'id')::bigint = locT and l ->> 'heldStore' = 'zztest20' and l ->> 'store' = 'Smoke v20 Tysons BOH'
                     and l ->> 'countHow' = 'marginedge' and l ->> 'heldBy' = 'zz smoke 20 Transfer')
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'locations') l
                   where (l ->> 'id')::bigint = locB and not (l ? 'heldStore') and not (l ? 'countHow') and not (l ? 'lastCount')),
    r -> 'data' -> 'locations');

  -- ---- A product's places ----
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('name', 'zz smoke 20 shrimp', 'pack', 'CASE (10LBs)', 'par', 0, 'handlingFee', 2.5,
         'stores', '[]'::jsonb, 'active', true, 'places', jsonb_build_array(jsonb_build_object('locationId', locB, 'lowPoint', 20),
                                                                              jsonb_build_object('locationId', locB))));
  perform pg_temp.chk('product: a place twice is refused, writing nothing',
    r ->> 'error' like 'REJECTED: zz smoke 20 Berliner is in the places twice%' and not exists (select 1 from mog.wh_products where name = 'zz smoke 20 shrimp'), r);
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('name', 'zz smoke 20 shrimp', 'pack', 'CASE (10LBs)', 'par', 0, 'handlingFee', 2.5,
         'stores', '[]'::jsonb, 'active', true, 'places', jsonb_build_array(jsonb_build_object('locationId', locB, 'lowPoint', 20),
                                                                              jsonb_build_object('locationId', locT, 'lowPoint', 12))));
  shrimp := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform pg_temp.chk('product: its places come back with their low points',
    (r ->> 'ok')::boolean and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'products') p
      where (p ->> 'id')::bigint = shrimp
        and p -> 'places' = jsonb_build_array(jsonb_build_object('locationId', least(locB, locT), 'lowPoint', case when locB < locT then 20 else 12 end),
                                              jsonb_build_object('locationId', greatest(locB, locT), 'lowPoint', case when locB < locT then 12 else 20 end))),
    r -> 'data' -> 'products');
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('name', 'zz smoke 20 bowls', 'pack', 'CASE (300)', 'par', 0, 'handlingFee', 0,
         'stores', '[]'::jsonb, 'active', true, 'places', jsonb_build_array(jsonb_build_object('locationId', locE))));
  bowls := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('name', 'zz smoke 20 lids', 'pack', 'CASE (300)', 'par', 0, 'handlingFee', 0,
         'stores', '[]'::jsonb, 'active', true, 'places', jsonb_build_array(jsonb_build_object('locationId', locE))));
  lids := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'product', '{"name": "zz smoke 20 cups", "pack": "CASE", "par": 0, "handlingFee": 0, "stores": [], "active": true, "via": "zz smoke 20 Holder"}');
  cups := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform pg_temp.chk('product: a v17 via also places it at its holder''s location, low point 0',
    (select jsonb_agg(jsonb_build_array(location_id, low_point)) from mog.wh_product_places where product_id = cups) = jsonb_build_array(jsonb_build_array(locE, 0)), null);

  perform mog.wh_move(me, shrimp, locB, 40, 'received', 'zz', 65, null);
  perform mog.wh_move(me, bowls, locE, 10, 'received', 'zz', 41, null);
  r := public.mog_wh_count(tok, jsonb_build_object('locationId', locT, 'lines', jsonb_build_array(
         jsonb_build_object('productId', shrimp, 'cases', 6, 'reason', 'Opening count from MarginEdge'))));
  perform pg_temp.chk('count: the opening count at the store''s place', (r ->> 'ok')::boolean
    and (select cases from mog.wh_stock where product_id = shrimp and location_id = locT) = 6, r);
  update mog.items set wh_product = shrimp where slug in ('zztest20', 'zztest20b') and item_id = 'ITEM-0001';
  update mog.items set wh_product = bowls where slug = 'zztest20b' and item_id = 'ITEM-0002';
  update mog.items set wh_product = lids where slug = 'zztest20b' and item_id = 'ITEM-0003';

  -- ---- Each item's cases from its own source place ----
  perform pg_temp.chk('read: the taker''s shrimp counts on the place it orders from (Tysons, 6), its bowls on Elpis (10)',
    (mog.live_json('zztest20b', null) -> 'happySupply' -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 6
      and (mog.live_json('zztest20b', null) -> 'happySupply' -> 'items' -> 'ITEM-0002' ->> 'available')::numeric = 10,
    mog.live_json('zztest20b', null) -> 'happySupply' -> 'items');
  perform pg_temp.chk('read: the holder''s shrimp counts on Happy Supply''s own (Berliner, 40), never its own place',
    (mog.live_json('zztest20', null) -> 'happySupply' -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 40,
    mog.live_json('zztest20', null) -> 'happySupply' -> 'items');
  update mog.items set primary_vendor = 'Sysco' where slug = 'zztest20' and item_id = 'ITEM-0001';
  perform pg_temp.chk('read: even under a vendor mapped to its own place''s name, the holder never counts on that place',
    (mog.live_json('zztest20', null) -> 'happySupply' -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 40,
    mog.live_json('zztest20', null) -> 'happySupply' -> 'items');
  update mog.items set primary_vendor = 'HS Co' where slug = 'zztest20' and item_id = 'ITEM-0001';

  -- ---- Happy Supply to the holding store: a move, not a sale ----
  r := public.mog_wh_send(ptokb, '{"vendor": "HS Co", "lines": [{"itemId": "ITEM-0003", "cases": 1}]}');
  perform pg_temp.chk('send: a product kept only at places other than HEH''s own isn''t Happy Supply''s',
    r ->> 'error' like 'REJECTED: RP Large Bowl Lids isn''t kept at Happy Supply%', r);
  r := public.mog_wh_send(ptok, '{"vendor": "HS Co", "by": "Kim", "lines": [{"itemId": "ITEM-0001", "cases": 16}]}');
  hsT := (r -> 'data' -> 'order' ->> 'id')::bigint;
  r := public.mog_wh_ship(tok, jsonb_build_object('id', hsT, 'version', 1, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 16, 'locationId', locB))));
  perform pg_temp.chk('ship: into the holding store''s place, with no price and no delivery fee',
    (r ->> 'ok')::boolean
      and (select to_location = locT and price is null and cases_shipped = 16 from mog.wh_order_lines where order_id = hsT)
      and (select delivery_fee = 0 and status = 'shipped' from mog.wh_orders where id = hsT)
      and (select cases from mog.wh_stock where product_id = shrimp and location_id = locB) = 24
      and exists (select 1 from mog.wh_moves where ref = (select number from mog.wh_orders where id = hsT) and kind = 'transfer_out' and cases = -16), r);
  perform pg_temp.chk('ship: it''s in transit until checked in, and HQ''s read says where it goes',
    mog.wh_in_transit(shrimp) = 16
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'orders') o, jsonb_array_elements(o -> 'lines') x
                   where (o ->> 'id')::bigint = hsT and (x ->> 'toLocation')::bigint = locT and x ->> 'to' = 'zz smoke 20 Tysons'), null);
  r := public.mog_wh_received(ptok, jsonb_build_object('id', hsT, 'by', 'Kim', 'lines', '[{"ord": 1, "cases": 15}]'::jsonb));
  perform pg_temp.chk('check in: what arrived goes into the place (6 + 15), under the order''s number',
    (r ->> 'ok')::boolean and (select status from mog.wh_orders where id = hsT) = 'received'
      and (select cases from mog.wh_stock where product_id = shrimp and location_id = locT) = 21
      and exists (select 1 from mog.wh_moves where ref = (select number from mog.wh_orders where id = hsT) and kind = 'transfer_in'
                                             and location_id = locT and cases = 15)
      and mog.wh_in_transit(shrimp) = 0, r);

  r := public.mog_wh_send(ptok, '{"vendor": "HS Co", "lines": [{"itemId": "ITEM-0001", "cases": 4}]}');
  hsT2 := (r -> 'data' -> 'order' ->> 'id')::bigint;
  r := public.mog_wh_ship(tok, jsonb_build_object('id', hsT2, 'version', 1, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 4, 'locationId', locB))));
  r := public.mog_wh_held_receive(tok, jsonb_build_object('id', hsT2, 'version', 1));
  perform pg_temp.chk('HQ check in: an old version is CONFLICT', r ->> 'error' = 'CONFLICT' and (select status from mog.wh_orders where id = hsT2) = 'shipped', r);
  r := public.mog_wh_held_receive(tokh, jsonb_build_object('id', hsT2, 'version', 2));
  perform pg_temp.chk('HQ check in: an hq-only sign-in can''t', r ->> 'error' = 'NOT_ALLOWED', r);
  r := public.mog_wh_held_receive(tok, jsonb_build_object('id', hsT2, 'version', 2));
  perform pg_temp.chk('HQ check in: a shipment into a place, for the store (21 + 4)',
    (r ->> 'ok')::boolean and (select status = 'received' and received_by = 'HQ · zz smoke 20' from mog.wh_orders where id = hsT2)
      and (select cases from mog.wh_stock where product_id = shrimp and location_id = locT) = 25, r);

  -- ---- A plain sale is still the store's ----
  r := public.mog_wh_send(ptokb, '{"vendor": "HS Co", "lines": [{"itemId": "ITEM-0001", "cases": 3}]}');
  hsS := (r -> 'data' -> 'order' ->> 'id')::bigint;
  r := public.mog_wh_ship(tok, jsonb_build_object('id', hsS, 'version', 1, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 3, 'locationId', locB))));
  perform pg_temp.chk('ship: a store that holds no place buys it: a price locks, no place to move into',
    (r ->> 'ok')::boolean and (select to_location is null and price is not null from mog.wh_order_lines where order_id = hsS)
      and (select cases from mog.wh_stock where product_id = shrimp and location_id = locB) = 17, r);
  r := public.mog_wh_held_receive(tok, jsonb_build_object('id', hsS, 'version', 2));
  perform pg_temp.chk('HQ check in: a plain sale isn''t HQ''s to check in', r ->> 'error' like 'REJECTED: that delivery isn''t there%', r);
  r := public.mog_wh_received(ptokb, jsonb_build_object('id', hsS, 'by', 'Lee'));
  perform pg_temp.chk('check in: the store checks in its sale, no stock moves',
    (r ->> 'ok')::boolean and (select status from mog.wh_orders where id = hsS) = 'received'
      and (select cases from mog.wh_stock where product_id = shrimp and location_id = locB) = 17, r);

  -- ---- The close, by place ----
  r := public.mog_sync_close_cycle('zztest20b', kb, current_date, current_date + 1, to_char(current_date + 1, 'Dy'),
         jsonb_build_array(pg_temp.row20('Transfer (Tysons)', 'ITEM-0001', 'Shrimp', 5), pg_temp.row20('Elpis', 'ITEM-0002', 'RP Large Bowls', 2),
                           pg_temp.row20('HS Co', 'ITEM-0003', 'RP Large Bowl Lids', 1)), '[]'::jsonb, null);
  select id, number into delT, numT from mog.wh_orders where slug = 'zztest20b' and held_at = locT;
  delE := (select id from mog.wh_orders where slug = 'zztest20b' and held_at = locE);
  perform pg_temp.chk('close: the taker''s lines become one delivery per place it ordered from',
    (r ->> 'ok')::boolean and not (r -> 'data' ? 'heldError') and numT ~ '^EL-[0-9]{4,}$'
      and (select jsonb_agg(jsonb_build_array(item_id, cases)) from mog.wh_order_lines where order_id = delT) = '[["ITEM-0001", 5]]'::jsonb
      and (select jsonb_agg(jsonb_build_array(item_id, cases)) from mog.wh_order_lines where order_id = delE) = '[["ITEM-0002", 2]]'::jsonb
      and (select vendor from mog.wh_orders where id = delT) = 'Transfer (Tysons)', r);
  r := public.mog_sync_close_cycle('zztest20', k, current_date, current_date + 1, to_char(current_date + 1, 'Dy'),
         jsonb_build_array(pg_temp.row20('Sysco', 'ITEM-0001', 'Shrimp', 2)), '[]'::jsonb, null);
  perform pg_temp.chk('close: never a delivery from the store''s own place, even under a vendor mapped to it',
    (r ->> 'ok')::boolean and not (r -> 'data' ? 'heldError')
      and not exists (select 1 from mog.wh_orders where slug = 'zztest20' and held_at is not null), r);
  perform pg_temp.chk('read: the taker counts on the place minus its open delivery (25 - 5), Elpis the same (10 - 2)',
    (mog.live_json('zztest20b', null) -> 'happySupply' -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 20
      and (mog.live_json('zztest20b', null) -> 'happySupply' -> 'items' -> 'ITEM-0002' ->> 'available')::numeric = 8,
    mog.live_json('zztest20b', null) -> 'happySupply' -> 'items');
  r := public.mog_wh_received(ptokb, jsonb_build_object('id', delT, 'by', 'Lee'));
  perform pg_temp.chk('check in: the taker''s delivery leaves the place (25 - 5)',
    (r ->> 'ok')::boolean and (select status from mog.wh_orders where id = delT) = 'received'
      and (select cases from mog.wh_stock where product_id = shrimp and location_id = locT) = 20, r);

  -- ---- The holder's own use, and who took what ----
  r := public.mog_wh_count(tok, jsonb_build_object('locationId', locT, 'lines', jsonb_build_array(
         jsonb_build_object('productId', shrimp, 'cases', 12, 'reason', 'Sunday count from MarginEdge'))));
  r := public.mog_wh_taken(tok, current_date - 2, current_date + 1);
  d := r -> 'data';
  perform pg_temp.chk('taken: the taker''s delivery from the place and its plain sale from Happy Supply, never the holder''s moves',
    (r ->> 'ok')::boolean
      and exists (select 1 from jsonb_array_elements(d -> 'taken') t where t ->> 'slug' = 'zztest20b' and (t ->> 'placeId')::bigint = locT
                    and (t ->> 'productId')::bigint = shrimp and (t ->> 'cases')::numeric = 5 and (t ->> 'deliveries')::integer = 1)
      and exists (select 1 from jsonb_array_elements(d -> 'taken') t where t ->> 'slug' = 'zztest20b' and (t ->> 'placeId')::bigint = locB
                    and (t ->> 'cases')::numeric = 3)
      and not exists (select 1 from jsonb_array_elements(d -> 'taken') t where t ->> 'slug' = 'zztest20'), d -> 'taken');
  perform pg_temp.chk('taken: the holder''s own use from its counts (20 on record, 12 counted), the opening count left out',
    (select jsonb_agg(jsonb_build_array(u ->> 'slug', (u ->> 'placeId')::bigint, (u ->> 'cases')::numeric, (u ->> 'counts')::integer))
       from jsonb_array_elements(d -> 'used') u where (u ->> 'productId')::bigint = shrimp)
      = jsonb_build_array(jsonb_build_array('zztest20', locT, 8, 1)), d -> 'used');
  perform pg_temp.chk('taken: the shipments into the place are moves between HEH''s places (15 + 4)',
    exists (select 1 from jsonb_array_elements(d -> 'moved') v where (v ->> 'fromId')::bigint = locB and (v ->> 'placeId')::bigint = locT
              and (v ->> 'productId')::bigint = shrimp and (v ->> 'cases')::numeric = 19 and (v ->> 'shipments')::integer = 2), d -> 'moved');
  perform pg_temp.chk('taken: a span the wrong way round, an hq-only sign-in and a bogus one are refused',
    public.mog_wh_taken(tok, current_date, current_date - 1) ->> 'error' like 'REJECTED: pick a span%'
      and public.mog_wh_taken(tokh, current_date - 1, current_date) ->> 'error' = 'NOT_ALLOWED'
      and public.mog_wh_taken('bogus', current_date - 1, current_date) ->> 'error' = 'SESSION_EXPIRED', null);

  -- ---- What a place's stock protects ----
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('id', shrimp, 'version', 1, 'name', 'zz smoke 20 shrimp', 'pack', 'CASE (10LBs)',
         'par', 0, 'handlingFee', 2.5, 'stores', '[]'::jsonb, 'active', true, 'places', jsonb_build_array(jsonb_build_object('locationId', locB, 'lowPoint', 20))));
  perform pg_temp.chk('product: a place still holding it can''t be taken off it',
    r ->> 'error' like 'REJECTED: zz smoke 20 shrimp has stock or open deliveries at zz smoke 20 Tysons%'
      and (select count(*) from mog.wh_product_places where product_id = shrimp) = 2, r);
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('id', shrimp, 'version', 1, 'name', 'zz smoke 20 shrimp', 'pack', 'CASE (10LBs)',
         'par', 0, 'handlingFee', 2.5, 'stores', '[]'::jsonb, 'active', true));
  perform pg_temp.chk('product: a save that leaves the places out keeps them',
    (r ->> 'ok')::boolean and (select count(*) from mog.wh_product_places where product_id = shrimp) = 2, r);
  r := public.mog_wh_save(tok, 'location', jsonb_build_object('id', locT, 'name', 'zz smoke 20 Tysons', 'active', true, 'heldStore', null));
  perform pg_temp.chk('place: holding stock, the store it sits at can''t change',
    r ->> 'error' like 'REJECTED: zz smoke 20 Tysons holds stock%' and (select held_store from mog.wh_locations where id = locT) = 'zztest20', r);
  r := public.mog_wh_save(tok, 'location', jsonb_build_object('id', locT, 'name', 'zz smoke 20 Tysons', 'active', true));
  perform pg_temp.chk('place: a save that leaves them out keeps the store, the holder name and how it''s counted',
    (r ->> 'ok')::boolean and (select held_store = 'zztest20' and held_by = 'zz smoke 20 Transfer' and count_how = 'marginedge'
                                from mog.wh_locations where id = locT), r);

  perform pg_temp.clean20();
  perform pg_temp.chk('cleanup: nothing of the smoke is left',
    not exists (select 1 from mog.stores where slug in ('zztest20', 'zztest20b'))
      and not exists (select 1 from mog.wh_orders where slug in ('zztest20', 'zztest20b'))
      and not exists (select 1 from mog.wh_products where name like 'zz smoke 20 %')
      and not exists (select 1 from mog.wh_locations where name like 'zz smoke 20 %')
      and not exists (select 1 from mog.hq_users where name like 'zz smoke 20%'), null);
end;
$$;

select n, case when ok then 'PASS' else 'FAIL' end as result, check_name, detail from mog_smoke20 order by n;
