-- =====================================================================
-- MOG schema v17 — smoke test (run in the SQL Editor AFTER schema_v17.sql)
-- =====================================================================
-- Throwaway stores 'zztest17' and 'zztest17b', the HQ people 'zz smoke 17'
-- (hq and warehouse) and 'zz smoke 17 hq' (hq only), and warehouse rows
-- named 'zz smoke 17 ...' (the held location's holder is the HQ name
-- 'zz smoke 17 Holder', so a real Elpis location is never touched): a
-- location held by a vendor and a product ordered through it (one holder
-- per location, a change refused while stock is there), cases available
-- from that location only, the close turning a store's linked lines into
-- one delivery (replaced or deleted by a same-day re-close, the close never
-- stopped by it), the store's Mark received (the stock drops), HQ's Mark
-- received (CONFLICT on an old version, a receipt beyond the records logged
-- as a count), Happy Supply never shipping from it, and no price on a
-- phone. Cleans up after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke17 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke17;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke17 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

create or replace function pg_temp.clean17()
returns void language sql as $$
  delete from mog.stores where slug in ('zztest17', 'zztest17b');
  delete from mog.wh_moves where product_id in (select id from mog.wh_products where name like 'zz smoke 17 %');
  delete from mog.wh_stock where product_id in (select id from mog.wh_products where name like 'zz smoke 17 %');
  delete from mog.wh_products where name like 'zz smoke 17 %';
  delete from mog.wh_locations where name like 'zz smoke 17 %';
  delete from mog.hq_users where name in ('zz smoke 17', 'zz smoke 17 hq');
$$;

-- A store on the app's editor and phones, counting today. Its Happy Supply
-- is "HS Co" and its Elpis is "Elpis" (HQ's names "Happy Supply" and
-- "zz smoke 17 Holder"). Answers its sync key.
create or replace function pg_temp.store17(p_slug text, p_location text)
returns text language plpgsql as $$
declare
  k text;
begin
  k := mog.provision_store(p_slug);
  perform public.mog_sync_set_pins(p_slug, k, '4321', null);
  perform mog.replace_catalog_tables(p_slug, jsonb_build_object(
    'profile', jsonb_build_object('timeZone', 'America/New_York', 'location', p_location, 'abbr', 'ZZ17', 'concept', 'zz-smoke17'),
    'vendors', '[{"name": "Elpis", "mults": [0,1,0,1,0,0,0], "cutoff": null},
                 {"name": "HS Co", "mults": [0,0,1,0,1,0,0], "cutoff": null},
                 {"name": "Sysco", "mults": [1,1,1,1,1,0,0], "cutoff": "10:00"}]'::jsonb,
    'areas',   '[{"name": "Dry", "ord": 10}]'::jsonb,
    'items',   '[{"id": "ITEM-0001", "name": "RP Large Bowls", "primaryVendor": "Elpis", "pack": "CASE (300)", "par": 3, "active": true,
                  "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Elpis", "Sysco"], "seq": 2},
                 {"id": "ITEM-0002", "name": "RP Large Bowl Lids", "primaryVendor": "Elpis", "pack": "CASE (300)", "par": 3, "active": true,
                  "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Elpis"], "seq": 3},
                 {"id": "ITEM-0003", "name": "KARAT Cups", "primaryVendor": "Elpis", "pack": "CASE", "par": 2, "active": true,
                  "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Elpis"], "seq": 4},
                 {"id": "ITEM-0004", "name": "Shrimp", "primaryVendor": "HS Co", "pack": "10 LB case", "par": 10, "active": true,
                  "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["HS Co"], "seq": 5}]'::jsonb,
    'pickRows', '[{"vendor": "Elpis", "id": "ITEM-0001", "area": "Dry", "shelfOrder": 10, "seq": 2},
                  {"vendor": "Sysco", "id": "ITEM-0001", "area": "Dry", "shelfOrder": 10, "seq": 3},
                  {"vendor": "Elpis", "id": "ITEM-0002", "area": "Dry", "shelfOrder": 20, "seq": 4},
                  {"vendor": "Elpis", "id": "ITEM-0003", "area": "Dry", "shelfOrder": 30, "seq": 5},
                  {"vendor": "HS Co", "id": "ITEM-0004", "area": "Dry", "shelfOrder": 40, "seq": 6}]'::jsonb));
  perform public.mog_sync_switch_editor(p_slug, k, false);
  perform public.mog_sync_set_phone_direct(p_slug, k, true);
  insert into mog.store_state (slug, cycle_date, day_of_week) values (p_slug, current_date, 'Mon')
  on conflict (slug) do update set cycle_date = excluded.cycle_date;
  insert into mog.hq_vendor_links (slug, hq_name, vendor) values (p_slug, 'Happy Supply', 'HS Co'), (p_slug, 'zz smoke 17 Holder', 'Elpis');
  return k;
end;
$$;

-- What the close sends: { vendor, id, name, qty }.
create or replace function pg_temp.row17(p_vendor text, p_id text, p_name text, p_qty numeric)
returns jsonb language sql as $$
  select jsonb_build_object('vendor', p_vendor, 'id', p_id, 'name', p_name, 'pack', '', 'area', 'Dry', 'onHandPrev', 0, 'qty', p_qty);
$$;

do $$
declare
  me      text := 'zz smoke 17';
  pass    text := 'correct horse battery';
  code    text;
  tok     text;    -- HQ, hq and warehouse
  tokh    text;    -- HQ, hq only
  ptok    text;    -- zztest17's phone
  ptokb   text;    -- zztest17b's phone
  k       text;    -- zztest17's sync key
  kb      text;    -- zztest17b's sync key
  locA    bigint;  -- HEH's own
  locE    bigint;  -- held by 'zz smoke 17 Holder'
  bowls   bigint;
  lids    bigint;
  shrimp  bigint;
  r       jsonb;
  d       jsonb;
  rows1   jsonb;
  del1    bigint;
  delb    bigint;
  num1    text;
  ver     bigint;
  hs1     bigint;
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key can call HQ''s Mark received and the close',
    has_function_privilege('anon', 'public.mog_wh_held_receive(text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_sync_close_cycle(text, text, date, date, text, jsonb, jsonb, timestamptz)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_received(text, jsonb)', 'execute'), null);
  perform pg_temp.chk('privileges: the public key cannot reach the held deliveries'' helpers',
    not has_function_privilege('anon', 'mog.wh_held_receive(bigint, text, text, jsonb)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_held_from_log(text, date)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_do_held_receive(text, jsonb)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_deliveries_json()', 'execute')
      and not has_function_privilege('anon', 'mog.wh_held_vendor(text, text)', 'execute'), null);

  perform pg_temp.clean17();

  -- ---- People and stores ----
  code := substring(mog.hq_invite(me, '{hq,warehouse}') from ': ([0-9A-F]+)');
  tok := public.mog_hq_claim(me, code, pass) -> 'data' ->> 'token';
  code := substring(mog.hq_invite(me || ' hq') from ': ([0-9A-F]+)');
  tokh := public.mog_hq_claim(me || ' hq', code, pass) -> 'data' ->> 'token';
  k := pg_temp.store17('zztest17', 'Smoke v17 FOH');
  kb := pg_temp.store17('zztest17b', 'Smoke v17b FOH');
  ptok := public.mog_login('zztest17', '4321') -> 'data' ->> 'token';
  ptokb := public.mog_login('zztest17b', '4321') -> 'data' ->> 'token';
  perform pg_temp.chk('setup: HQ and both phones sign in', tok is not null and tokh is not null and ptok is not null and ptokb is not null, null);

  -- ---- A location held by a vendor, products ordered through it ----
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 17 Berliner"}');
  locA := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 17 Elpis", "heldBy": "zz smoke 17 Holder"}');
  locE := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform pg_temp.chk('save: a location can be held by a vendor; HEH''s own carries no heldBy',
    (r ->> 'ok')::boolean
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'locations') l
                   where (l ->> 'id')::bigint = locE and l ->> 'heldBy' = 'zz smoke 17 Holder' and l -> 'lastCount' = 'null'::jsonb)
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'locations') l where (l ->> 'id')::bigint = locA and not (l ? 'heldBy')), r -> 'data' -> 'locations');
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 17 Elpis 2", "heldBy": "ZZ SMOKE 17 HOLDER"}');
  perform pg_temp.chk('save: one location per holder (ignoring capitals)',
    r ->> 'error' like 'REJECTED: zz smoke 17 Elpis is held by%' and not exists (select 1 from mog.wh_locations where name = 'zz smoke 17 Elpis 2'), r);
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 17 HS", "heldBy": "Happy Supply"}');
  perform pg_temp.chk('save: Happy Supply doesn''t hold a location', r ->> 'error' like 'REJECTED: Happy Supply''s own locations%', r);

  r := public.mog_wh_save(tok, 'product', '{"name": "zz smoke 17 bowls", "pack": "CASE (300)", "par": 30, "handlingFee": 0, "stores": [], "active": true, "via": "ZZ SMOKE 17 HOLDER"}');
  bowls := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform pg_temp.chk('save: a product ordered through the holder takes the location''s spelling',
    (r ->> 'ok')::boolean and (select via from mog.wh_products where id = bowls) = 'zz smoke 17 Holder'
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'products') p where (p ->> 'id')::bigint = bowls and p ->> 'via' = 'zz smoke 17 Holder'), r);
  r := public.mog_wh_save(tok, 'product', '{"name": "zz smoke 17 lids", "pack": "CASE (300)", "par": 30, "handlingFee": 0, "stores": [], "active": true, "via": "zz smoke 17 Holder"}');
  lids := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'product', '{"name": "zz smoke 17 shrimp", "pack": "10 LB case", "par": 12, "handlingFee": 6, "stores": [], "active": true}');
  shrimp := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform pg_temp.chk('save: a Happy Supply product carries no via',
    (select via from mog.wh_products where id = shrimp) is null
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'products') p where (p ->> 'id')::bigint = shrimp and not (p ? 'via')), null);
  r := public.mog_wh_save(tok, 'product', '{"name": "zz smoke 17 cups", "pack": "CASE", "par": 1, "handlingFee": 0, "stores": [], "active": true, "via": "Nobody Inc"}');
  perform pg_temp.chk('save: a via no location is held by is refused',
    r ->> 'error' like 'REJECTED: no location is held by Nobody Inc%' and not exists (select 1 from mog.wh_products where name = 'zz smoke 17 cups'), r);

  perform mog.wh_move(me, bowls, locE, 40, 'received', 'zz', 50, null);
  perform mog.wh_move(me, lids, locE, 3, 'received', 'zz', 40, null);
  perform mog.wh_move(me, shrimp, locA, 9, 'received', 'zz', 77, null);
  perform mog.wh_move(me, shrimp, locE, 2, 'received', 'zz', 77, null);    -- stray Happy Supply stock at Elpis

  r := public.mog_wh_save(tok, 'product', jsonb_build_object('id', bowls, 'version', 1, 'name', 'zz smoke 17 bowls', 'pack', 'CASE (300)',
         'par', 30, 'handlingFee', 0, 'stores', '[]'::jsonb, 'active', true, 'via', null));
  perform pg_temp.chk('save: where stores order a product can''t change while it has stock',
    r ->> 'error' like 'REJECTED: zz smoke 17 bowls has stock%' and (select via from mog.wh_products where id = bowls) = 'zz smoke 17 Holder', r);
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('id', bowls, 'version', 1, 'name', 'zz smoke 17 bowls', 'pack', 'CASE (300)',
         'par', 35, 'handlingFee', 0, 'stores', '[]'::jsonb, 'active', true));
  perform pg_temp.chk('save: a product saved without via keeps it',
    (r ->> 'ok')::boolean and (select via from mog.wh_products where id = bowls) = 'zz smoke 17 Holder'
      and (select par from mog.wh_products where id = bowls) = 35, r);
  r := public.mog_wh_save(tok, 'location', jsonb_build_object('id', locE, 'name', 'zz smoke 17 Elpis', 'active', true));
  perform pg_temp.chk('save: a location saved without heldBy keeps it',
    (r ->> 'ok')::boolean and (select held_by from mog.wh_locations where id = locE) = 'zz smoke 17 Holder', r);
  r := public.mog_wh_save(tok, 'location', jsonb_build_object('id', locE, 'name', 'zz smoke 17 Elpis', 'active', true, 'heldBy', null));
  perform pg_temp.chk('save: who holds a location can''t change while it has stock or products through it',
    r ->> 'error' like 'REJECTED: zz smoke 17 Elpis holds stock%' and (select held_by from mog.wh_locations where id = locE) = 'zz smoke 17 Holder', r);

  -- ---- Links (HQ's path is smoke_v16's; straight in the tables here) ----
  perform pg_temp.chk('read: a store with no linked item reads exactly as before',
    not (mog.live_json('zztest17', null) ? 'happySupply'), null);
  update mog.items set wh_product = bowls where slug in ('zztest17', 'zztest17b') and item_id = 'ITEM-0001';
  update mog.items set wh_product = lids where slug in ('zztest17', 'zztest17b') and item_id = 'ITEM-0002';
  update mog.items set wh_product = shrimp where slug in ('zztest17', 'zztest17b') and item_id = 'ITEM-0004';

  d := mog.live_json('zztest17', null) -> 'happySupply';
  perform pg_temp.chk('read: an Elpis item''s available is the held location''s cases; the holder''s vendor is named',
    (d -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 40 and (d -> 'items' -> 'ITEM-0002' ->> 'available')::numeric = 3
      and d -> 'heldVendors' = '["Elpis"]'::jsonb and d ->> 'vendor' = 'HS Co' and not (d -> 'items' ? 'ITEM-0003'), d);
  perform pg_temp.chk('read: a Happy Supply item''s available leaves out a held location''s cases',
    (d -> 'items' -> 'ITEM-0004' ->> 'available')::numeric = 9, d -> 'items');

  -- ---- Happy Supply keeps to its own ----
  update mog.items set eligible_vendors = '{Elpis,HS Co}' where slug = 'zztest17b' and item_id = 'ITEM-0001';
  r := public.mog_wh_send(ptokb, '{"vendor": "HS Co", "lines": [{"itemId": "ITEM-0001", "cases": 1}]}');
  perform pg_temp.chk('send: an item linked to a held product isn''t Happy Supply''s',
    r ->> 'error' like 'REJECTED: RP Large Bowls comes from zz smoke 17 Holder, not Happy Supply%', r);
  r := public.mog_wh_send(ptokb, '{"vendor": "HS Co", "lines": [{"itemId": "ITEM-0004", "cases": 3}]}');
  hs1 := (r -> 'data' -> 'order' ->> 'id')::bigint;
  r := public.mog_wh_ship(tok, jsonb_build_object('id', hs1, 'version', 1, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 2, 'locationId', locE))));
  perform pg_temp.chk('ship: Happy Supply never ships from a held location, writing nothing',
    r ->> 'error' like 'REJECTED: Happy Supply never ships from zz smoke 17 Elpis%'
      and (select cases from mog.wh_stock where product_id = shrimp and location_id = locE) = 2
      and (select status from mog.wh_orders where id = hs1) = 'sent', r);
  perform pg_temp.chk('read: a sent Happy Supply order still holds its cases',
    (mog.live_json('zztest17', null) -> 'happySupply' -> 'items' -> 'ITEM-0004' ->> 'available')::numeric = 6, null);

  -- ---- The close records the delivery ----
  rows1 := jsonb_build_array(pg_temp.row17('Elpis', 'ITEM-0001', 'RP Large Bowls', 2), pg_temp.row17('Elpis', 'ITEM-0002', 'RP Large Bowl Lids', 4),
                             pg_temp.row17('Elpis', 'ITEM-0003', 'KARAT Cups', 1), pg_temp.row17('Sysco', 'ITEM-0001', 'RP Large Bowls', 1),
                             pg_temp.row17('HS Co', 'ITEM-0004', 'Shrimp', 3));
  r := public.mog_sync_close_cycle('zztest17', k, current_date, current_date, to_char(current_date, 'Dy'), rows1, '[]'::jsonb, null);
  select id, number into del1, num1 from mog.wh_orders where slug = 'zztest17' and held_at = locE;
  perform pg_temp.chk('close: the log is written as before, with nothing else in the answer',
    (r ->> 'ok')::boolean and (r -> 'data' ->> 'logged')::integer = 5 and not (r -> 'data' ? 'heldError')
      and (select count(*) from mog.order_log where slug = 'zztest17' and cycle_date = current_date) = 5, r);
  perform pg_temp.chk('close: the linked Elpis lines become one open delivery, numbered EL-',
    num1 ~ '^EL-[0-9]{4,}$' and (select status from mog.wh_orders where id = del1) = 'ordered'
      and (select vendor from mog.wh_orders where id = del1) = 'Elpis'
      and (select count(*) from mog.wh_orders where slug = 'zztest17' and held_at is not null) = 1, null);
  perform pg_temp.chk('close: only the items linked to a held product, ordered from its holder''s vendor',
    (select jsonb_agg(jsonb_build_array(item_id, cases, location_id) order by ord) from mog.wh_order_lines where order_id = del1)
      = jsonb_build_array(jsonb_build_array('ITEM-0001', 2, locE), jsonb_build_array('ITEM-0002', 4, locE)),
    (select jsonb_agg(jsonb_build_array(item_id, cases)) from mog.wh_order_lines where order_id = del1));
  perform pg_temp.chk('close: a delivery doesn''t touch the stock',
    (select cases from mog.wh_stock where product_id = bowls and location_id = locE) = 40
      and not exists (select 1 from mog.wh_moves where ref = num1), null);

  r := public.mog_sync_close_cycle('zztest17', k, current_date, current_date, to_char(current_date, 'Dy'),
         jsonb_build_array(pg_temp.row17('Elpis', 'ITEM-0001', 'RP Large Bowls', 1)), '[]'::jsonb, null);
  perform pg_temp.chk('close: a same-day re-close replaces the open delivery (same one, new lines)',
    (r ->> 'ok')::boolean and (select count(*) from mog.wh_orders where slug = 'zztest17' and held_at is not null) = 1
      and (select version from mog.wh_orders where id = del1) = 2
      and (select jsonb_agg(jsonb_build_array(item_id, cases)) from mog.wh_order_lines where order_id = del1) = '[["ITEM-0001", 1]]'::jsonb, null);
  r := public.mog_sync_close_cycle('zztest17', k, current_date, current_date, to_char(current_date, 'Dy'),
         jsonb_build_array(pg_temp.row17('HS Co', 'ITEM-0004', 'Shrimp', 3)), '[]'::jsonb, null);
  perform pg_temp.chk('close: a re-close with no linked Elpis line deletes the open delivery',
    (r ->> 'ok')::boolean and not exists (select 1 from mog.wh_orders where slug = 'zztest17' and held_at is not null), null);
  r := public.mog_sync_close_cycle('zztest17', k, current_date, current_date + 1, to_char(current_date + 1, 'Dy'), rows1, '[]'::jsonb, null);
  select id, number into del1, num1 from mog.wh_orders where slug = 'zztest17' and held_at = locE;
  perform pg_temp.chk('close: the night''s close records it and starts the new cycle',
    (r ->> 'ok')::boolean and (r -> 'data' ->> 'cycleDate') = to_char(current_date + 1, 'YYYY-MM-DD') and del1 is not null
      and (select cycle_date from mog.wh_orders where id = del1) = current_date
      and (select count(*) from mog.wh_order_lines where order_id = del1) = 2, r);

  -- ---- What the phones and HQ see ----
  d := mog.live_json('zztest17b', null) -> 'happySupply';
  perform pg_temp.chk('read: an open delivery holds its cases from every store''s available',
    (d -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 38 and (d -> 'items' -> 'ITEM-0002' ->> 'available')::numeric = 0, d -> 'items');
  perform pg_temp.chk('read: including the store''s own (its cycle has moved on)',
    (mog.live_json('zztest17', null) -> 'happySupply' -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 38, null);
  r := public.mog_snapshot2(ptok, null, null, null, null);
  d := (select o from jsonb_array_elements(r -> 'data' -> 'happySupply' -> 'orders') o where (o ->> 'id')::bigint = del1);
  perform pg_temp.chk('read: the store''s phone gets the delivery for its Elpis card, ordered as logged, with no price or cost',
    d ->> 'status' = 'ordered' and (d ->> 'held')::boolean and d ->> 'heldVendor' = 'Elpis' and d ->> 'from' = 'zz smoke 17 Elpis'
      and (d -> 'lines' -> 1 ->> 'cases')::numeric = 4
      and position('price' in lower((r -> 'data' -> 'happySupply')::text)) = 0 and position('cost' in lower((r -> 'data' -> 'happySupply')::text)) = 0
      and position('beyond' in lower((r -> 'data' -> 'happySupply')::text)) = 0, d);
  r := public.mog_wh_data(tok);
  perform pg_temp.chk('read: HQ lists it under deliveries, not Happy Supply''s orders',
    exists (select 1 from jsonb_array_elements(r -> 'data' -> 'deliveries') o where (o ->> 'id')::bigint = del1 and (o ->> 'heldAt')::bigint = locE
              and o ->> 'store' = 'Smoke v17 FOH')
      and not exists (select 1 from jsonb_array_elements(r -> 'data' -> 'orders') o where (o ->> 'id')::bigint = del1)
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'orders') o where (o ->> 'id')::bigint = hs1), null);
  perform pg_temp.chk('read: HQ''s vendor names hold the stores'' vendors, one spelling each',
    r -> 'data' -> 'vendorNames' ? 'Elpis' and r -> 'data' -> 'vendorNames' ? 'zz smoke 17 Holder'
      and (select count(*) from jsonb_array_elements_text(r -> 'data' -> 'vendorNames') x where lower(x) = 'elpis') = 1, null);

  -- ---- The store marks it received ----
  r := public.mog_wh_received(ptokb, jsonb_build_object('id', del1));
  perform pg_temp.chk('received: another store can''t mark it', r ->> 'error' like 'REJECTED: that order isn''t this store''s%', r);
  r := public.mog_wh_received(ptok, jsonb_build_object('id', del1, 'lines', '[{"ord": 9, "cases": 1}]'::jsonb));
  perform pg_temp.chk('received: a line not in the delivery is refused, changing nothing',
    r ->> 'error' like 'REJECTED: a line here isn''t in EL-%' and (select status from mog.wh_orders where id = del1) = 'ordered', r);
  r := public.mog_wh_received(ptok, jsonb_build_object('id', del1, 'by', 'Maria', 'lines', '[{"ord": 2, "cases": 3}]'::jsonb));
  perform pg_temp.chk('received: a short line as typed, a line left out as ordered; the stock drops under the delivery''s number',
    (r ->> 'ok')::boolean and r -> 'data' -> 'order' ->> 'status' = 'received' and r -> 'data' -> 'order' ->> 'receivedBy' = 'Maria'
      and (select cases_received from mog.wh_order_lines where order_id = del1 and ord = 1) = 2
      and (select cases_received from mog.wh_order_lines where order_id = del1 and ord = 2) = 3
      and (select cases from mog.wh_stock where product_id = bowls and location_id = locE) = 38
      and (select cases from mog.wh_stock where product_id = lids and location_id = locE) = 0
      and (select count(*) from mog.wh_moves where ref = num1 and kind = 'shipped') = 2
      and (select by_name from mog.wh_moves where ref = num1 and product_id = bowls) = 'Smoke v17 FOH · Maria', r -> 'data' -> 'order');
  perform pg_temp.chk('received: the line keeps the average cost; nothing beyond the records',
    (select avg_cost from mog.wh_order_lines where order_id = del1 and ord = 1) = 50
      and not exists (select 1 from mog.wh_order_lines where order_id = del1 and beyond is not null), null);
  ver := (select version from mog.wh_orders where id = del1);
  r := public.mog_wh_received(ptok, jsonb_build_object('id', del1, 'lines', '[{"ord": 1, "cases": 0}]'::jsonb));
  perform pg_temp.chk('received: a second tap (another phone) answers as it stands and changes nothing',
    (r ->> 'ok')::boolean and (select version from mog.wh_orders where id = del1) = ver
      and (select cases from mog.wh_stock where product_id = bowls and location_id = locE) = 38, null);
  perform pg_temp.chk('read: the phone still shows it, received, the rest of the day',
    exists (select 1 from jsonb_array_elements(mog.live_json('zztest17', null) -> 'happySupply' -> 'orders') o
             where (o ->> 'id')::bigint = del1 and o ->> 'status' = 'received'), null);

  -- ---- HQ marks one nobody marked; a receipt beyond the records ----
  r := public.mog_sync_close_cycle('zztest17b', kb, current_date, current_date + 1, to_char(current_date + 1, 'Dy'),
         jsonb_build_array(pg_temp.row17('Elpis', 'ITEM-0001', 'RP Large Bowls', 1), pg_temp.row17('Elpis', 'ITEM-0002', 'RP Large Bowl Lids', 2)),
         '[]'::jsonb, null);
  delb := (select id from mog.wh_orders where slug = 'zztest17b' and held_at = locE);
  perform pg_temp.chk('read: available never goes below 0',
    (mog.live_json('zztest17', null) -> 'happySupply' -> 'items' -> 'ITEM-0002' ->> 'available')::numeric = 0, null);
  perform pg_temp.chk('keeper: an hq-only sign-in can''t mark it; a bogus one is told to sign in',
    public.mog_wh_held_receive(tokh, jsonb_build_object('id', delb, 'version', 1)) ->> 'error' = 'NOT_ALLOWED'
      and public.mog_wh_held_receive('bogus', '{}') ->> 'error' = 'SESSION_EXPIRED', null);
  r := public.mog_wh_held_receive(tok, jsonb_build_object('id', delb, 'version', 99));
  perform pg_temp.chk('keeper: an old version is CONFLICT', r ->> 'error' = 'CONFLICT' and (select status from mog.wh_orders where id = delb) = 'ordered', r);
  r := public.mog_wh_held_receive(tok, jsonb_build_object('id', hs1, 'version', 1));
  perform pg_temp.chk('keeper: a Happy Supply order isn''t a delivery', r ->> 'error' like 'REJECTED: that delivery isn''t there%', r);
  r := public.mog_wh_held_receive(tok, jsonb_build_object('id', delb, 'version', 1));
  perform pg_temp.chk('keeper: received as ordered; the lids beyond the records go through, logged as a count with a reason',
    (r ->> 'ok')::boolean and (select status from mog.wh_orders where id = delb) = 'received'
      and (select received_by from mog.wh_orders where id = delb) = 'HQ · zz smoke 17'
      and (select cases from mog.wh_stock where product_id = lids and location_id = locE) = 0
      and (select cases from mog.wh_stock where product_id = bowls and location_id = locE) = 37
      and (select beyond from mog.wh_order_lines where order_id = delb and ord = 2) = 2
      and (select beyond from mog.wh_order_lines where order_id = delb and ord = 1) is null
      and exists (select 1 from mog.wh_moves m join mog.wh_orders o on o.number = m.ref and o.id = delb
                   where m.product_id = lids and m.kind = 'count' and m.cases = 2 and m.reason = 'Received at Smoke v17b FOH beyond the records'),
    r -> 'data' -> 'done');
  perform pg_temp.chk('keeper: HQ sees the line beyond the records; the count it made isn''t a real count',
    exists (select 1 from jsonb_array_elements(r -> 'data' -> 'deliveries') o, jsonb_array_elements(o -> 'lines') l
             where (o ->> 'id')::bigint = delb and (l ->> 'beyond')::numeric = 2)
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'locations') l where (l ->> 'id')::bigint = locE and l -> 'lastCount' = 'null'::jsonb), null);
  r := public.mog_wh_held_receive(tok, jsonb_build_object('id', delb, 'version', 2));
  perform pg_temp.chk('keeper: a delivery received already is CONFLICT', r ->> 'error' = 'CONFLICT', r);
  r := public.mog_wh_count(tok, jsonb_build_object('locationId', locE, 'lines', jsonb_build_array(
         jsonb_build_object('productId', lids, 'cases', 5, 'reason', 'Elpis report'))));
  perform pg_temp.chk('count: a real count at the held location is its last count',
    (r ->> 'ok')::boolean and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'locations') l
                                       where (l ->> 'id')::bigint = locE and l -> 'lastCount' <> 'null'::jsonb), r -> 'data' -> 'locations');

  -- ---- A received delivery stays ----
  update mog.store_state set cycle_date = current_date where slug = 'zztest17b';
  r := public.mog_sync_close_cycle('zztest17b', kb, current_date, current_date, to_char(current_date, 'Dy'), '[]'::jsonb, '[]'::jsonb, null);
  perform pg_temp.chk('close: a re-close leaves a received delivery as it is',
    (r ->> 'ok')::boolean and (select status from mog.wh_orders where id = delb) = 'received'
      and (select count(*) from mog.wh_order_lines where order_id = delb) = 2, null);

  perform pg_temp.clean17();
  perform pg_temp.chk('cleanup: nothing of the smoke is left',
    not exists (select 1 from mog.stores where slug in ('zztest17', 'zztest17b'))
      and not exists (select 1 from mog.wh_orders where slug in ('zztest17', 'zztest17b'))
      and not exists (select 1 from mog.wh_products where name like 'zz smoke 17 %')
      and not exists (select 1 from mog.wh_locations where name like 'zz smoke 17 %'), null);
end;
$$;

select n, case when ok then 'PASS' else 'FAIL' end as result, check_name, detail from mog_smoke17 order by n;
