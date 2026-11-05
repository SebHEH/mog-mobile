-- =====================================================================
-- MOG schema v16 — smoke test (run in the SQL Editor AFTER schema_v16.sql)
-- =====================================================================
-- Throwaway stores 'zztest16' and 'zztest16b', the HQ people 'zz smoke 16'
-- (hq and warehouse) and 'zz smoke 16 hq' (hq only), and warehouse rows
-- named 'zz smoke 16 ...', so no real store or stock is touched: an item's
-- link to a product rides in its row (HQ links it, Undo takes it off, a
-- page that read the row before the link gets CONFLICT), the phone's
-- Happy Supply read (cases available, another store's sent order held,
-- its own left out, no price anywhere), Send (replaced while sent, every
-- refusal changing nothing), Dan's Ship (CONFLICT on an old version, at
-- most what was ordered, never below 0 writing nothing, the price locked),
-- Mark received (no more than shipped, a second tap harmless), and
-- Cancel. Cleans up after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke16 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke16;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke16 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

create or replace function pg_temp.clean16()
returns void language sql as $$
  delete from mog.stores where slug in ('zztest16', 'zztest16b');
  delete from mog.wh_moves where product_id in (select id from mog.wh_products where name like 'zz smoke 16 %');
  delete from mog.wh_stock where product_id in (select id from mog.wh_products where name like 'zz smoke 16 %');
  delete from mog.wh_products where name like 'zz smoke 16 %';
  delete from mog.wh_locations where name like 'zz smoke 16 %';
  delete from mog.hq_users where name in ('zz smoke 16', 'zz smoke 16 hq');
$$;

-- A store on the app's editor and phones, counting today, whose Happy
-- Supply is "HS Co" (since v21: the vendor its items' routes to HEH's own
-- places use). Answers its sync key.
create or replace function pg_temp.store16(p_slug text)
returns text language plpgsql as $$
declare
  k text;
begin
  k := mog.provision_store(p_slug);
  perform public.mog_sync_set_pins(p_slug, k, '4321', null);
  perform mog.replace_catalog_tables(p_slug, '{
    "profile": {"timeZone": "America/New_York", "location": "Smoke v16 BOH", "abbr": "ZZ16", "concept": "zz-smoke16"},
    "vendors": [{"name": "HS Co", "mults": [0,0,1,0,1,0,0], "cutoff": null},
                {"name": "Sysco", "mults": [1,1,1,1,1,0,0], "cutoff": "10:00"}],
    "areas":   [{"name": "Freezer", "ord": 10}],
    "items":   [{"id": "ITEM-0001", "name": "Shrimp", "primaryVendor": "Sysco", "pack": "CASE", "par": 10, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Sysco"], "seq": 2},
                {"id": "ITEM-0002", "name": "Crab", "primaryVendor": "HS Co", "pack": "20 LB case", "par": 4, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["HS Co"], "seq": 3},
                {"id": "ITEM-0003", "name": "Rice", "primaryVendor": "HS Co", "pack": "BAG", "par": 2, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["HS Co"], "seq": 4},
                {"id": "ITEM-0004", "name": "Lobster", "primaryVendor": "HS Co", "pack": "CASE", "par": 1, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["HS Co"], "seq": 5}],
    "pickRows": [{"vendor": "Sysco", "id": "ITEM-0001", "area": "Freezer", "shelfOrder": 10, "seq": 2},
                 {"vendor": "HS Co", "id": "ITEM-0002", "area": "Freezer", "shelfOrder": 20, "seq": 3},
                 {"vendor": "HS Co", "id": "ITEM-0003", "area": "Freezer", "shelfOrder": 30, "seq": 4},
                 {"vendor": "HS Co", "id": "ITEM-0004", "area": "Freezer", "shelfOrder": 40, "seq": 5}]}'::jsonb);
  perform public.mog_sync_switch_editor(p_slug, k, false);
  perform public.mog_sync_set_phone_direct(p_slug, k, true);
  insert into mog.store_state (slug, cycle_date, day_of_week) values (p_slug, current_date, 'Mon')
  on conflict (slug) do update set cycle_date = excluded.cycle_date;
  return k;
end;
$$;

-- An item's row as the editor reads it.
create or replace function pg_temp.row16(p_slug text, p_id text)
returns jsonb language sql as $$
  select e from jsonb_array_elements(mog.tables_json(p_slug) -> 'items') e where e ->> 'id' = p_id;
$$;

do $$
declare
  me      text := 'zz smoke 16';
  pass    text := 'correct horse battery';
  code    text;
  tok     text;    -- HQ, hq and warehouse
  tokh    text;    -- HQ, hq only
  ptok    text;    -- zztest16's phone
  ptokb   text;    -- zztest16b's phone
  etok    text;    -- zztest16's editor
  locA    bigint;
  locB    bigint;
  shrimp  bigint;
  crab    bigint;
  lobster bigint;
  r       jsonb;
  d       jsonb;
  before1 jsonb;
  after1  jsonb;
  cid     bigint;
  ord1    bigint;
  ordb    bigint;
  ver     bigint;
  num1    text;
  n       integer;
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key can call Send, Received, Ship and Cancel',
    has_function_privilege('anon', 'public.mog_wh_send(text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_received(text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_ship(text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_order_cancel(text, bigint, bigint)', 'execute'), null);
  perform pg_temp.chk('privileges: the public key cannot reach the orders or their helpers',
    not has_table_privilege('anon', 'mog.wh_orders', 'select')
      and not has_table_privilege('anon', 'mog.wh_order_lines', 'select')
      and not has_function_privilege('anon', 'mog.wh_do_ship(text, jsonb)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_live_json(text)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_available(bigint, text, date)', 'execute'), null);

  perform pg_temp.clean16();

  -- ---- The warehouse: two locations, three products ----
  insert into mog.wh_locations (name, ord) values ('zz smoke 16 Berliner', 1) returning id into locA;
  insert into mog.wh_locations (name, ord) values ('zz smoke 16 Tysons', 2) returning id into locB;
  insert into mog.wh_products (name, pack, par, handling_fee) values ('zz smoke 16 shrimp', '10 LB case', 12, 6) returning id into shrimp;
  insert into mog.wh_products (name, pack, par, handling_fee) values ('zz smoke 16 crab', '20 LB case', 10, 10) returning id into crab;
  insert into mog.wh_products (name, pack, par, handling_fee) values ('zz smoke 16 lobster', 'CASE', 2, 5) returning id into lobster;
  -- v21: Happy Supply sells what sits at one of HEH's own places.
  insert into mog.wh_product_places (product_id, location_id) values (shrimp, locA), (crab, locA), (lobster, locA);
  perform mog.wh_move(me, shrimp, locA, 9, 'received', 'zz', 77.3095, null);
  perform mog.wh_move(me, crab, locA, 14, 'received', 'zz', 120, null);
  perform mog.wh_move(me, lobster, locA, 3, 'received', 'zz', 50, null);

  perform pg_temp.chk('price: (average + fee) x (1 + markup %), to the cent',
    mog.wh_store_price(77.3095, 6, 5) = 87.47 and mog.wh_store_price(120, 10, 0) = 130.00, null);

  -- ---- People and stores ----
  code := substring(mog.hq_invite(me, '{hq,warehouse}') from ': ([0-9A-F]+)');
  tok := public.mog_hq_claim(me, code, pass) -> 'data' ->> 'token';
  code := substring(mog.hq_invite(me || ' hq') from ': ([0-9A-F]+)');
  tokh := public.mog_hq_claim(me || ' hq', code, pass) -> 'data' ->> 'token';
  perform pg_temp.store16('zztest16');
  perform pg_temp.store16('zztest16b');
  ptok := public.mog_login('zztest16', '4321') -> 'data' ->> 'token';
  ptokb := public.mog_login('zztest16b', '4321') -> 'data' ->> 'token';
  etok := public.mog_editor_login('zztest16', '4321') -> 'data' ->> 'token';
  perform pg_temp.chk('setup: HQ, both phones and the editor sign in',
    tok is not null and tokh is not null and ptok is not null and ptokb is not null and etok is not null, null);

  perform pg_temp.chk('read: a store with no linked item reads exactly as before (no happySupply, no whProduct)',
    not (mog.live_json('zztest16', null) ? 'happySupply')
      and not exists (select 1 from jsonb_array_elements(mog.tables_json('zztest16') -> 'items') e where e ? 'whProduct'), null);

  -- ---- HQ links Shrimp to the product: Happy Supply becomes its main vendor ----
  before1 := pg_temp.row16('zztest16', 'ITEM-0001');
  after1 := before1 || jsonb_build_object('primaryVendor', 'HS Co', 'eligible', '["HS Co", "Sysco"]'::jsonb,
                                          'pack', '10 LB case', 'whProduct', shrimp, 'whVendor', 'HS Co');
  r := public.mog_hq_apply(tok, jsonb_build_array(jsonb_build_object('slug', 'zztest16', 'label', 'HQ: linked Shrimp to Happy Supply',
         'ops', jsonb_build_array(jsonb_build_object('t', 'items', 'before', before1, 'after', after1)))), '[]'::jsonb);
  cid := (r -> 'data' -> 'changes' -> 0 ->> 'changeId')::bigint;
  perform pg_temp.chk('link: HQ''s change writes the link in the item''s row',
    (r ->> 'ok')::boolean and (pg_temp.row16('zztest16', 'ITEM-0001') ->> 'whProduct')::bigint = shrimp
      and (select wh_product from mog.items where slug = 'zztest16' and item_id = 'ITEM-0001') = shrimp, r);
  r := public.mog_editor_apply(etok, 'Edited "Shrimp": par 10 → 11', 'Maria',
         jsonb_build_array(jsonb_build_object('t', 'items', 'before', before1, 'after', before1 || '{"par": 11}'::jsonb)));
  perform pg_temp.chk('link: a page that read the row before HQ''s change gets CONFLICT',
    r ->> 'error' = 'CONFLICT' and (pg_temp.row16('zztest16', 'ITEM-0001') ->> 'whProduct')::bigint = shrimp, r);
  r := public.mog_editor_undo(etok, cid, 'Maria');
  perform pg_temp.chk('link: the store''s Undo takes the link off with the rest of the change',
    (r ->> 'ok')::boolean and not (pg_temp.row16('zztest16', 'ITEM-0001') ? 'whProduct')
      and pg_temp.row16('zztest16', 'ITEM-0001') ->> 'primaryVendor' = 'Sysco', r);
  r := public.mog_editor_undo(etok, (r -> 'data' ->> 'changeId')::bigint, 'Maria');
  perform pg_temp.chk('link: undoing the Undo brings the link back',
    (r ->> 'ok')::boolean and (pg_temp.row16('zztest16', 'ITEM-0001') ->> 'whProduct')::bigint = shrimp, r);

  -- The rest straight in the tables (the editor path is checked above).
  before1 := pg_temp.row16('zztest16', 'ITEM-0002');
  update mog.items set wh_product = crab, wh_vendor = 'HS Co' where slug = 'zztest16' and item_id = 'ITEM-0002';
  r := public.mog_editor_apply(etok, 'Edited "Crab": par 4 → 5', 'Maria',
         jsonb_build_array(jsonb_build_object('t', 'items', 'before', before1, 'after', before1 || '{"par": 5}'::jsonb)));
  perform pg_temp.chk('link: a page whose row differs only by the link gets CONFLICT, not an unlinked item',
    r ->> 'error' = 'CONFLICT' and (pg_temp.row16('zztest16', 'ITEM-0002') ->> 'whProduct')::bigint = crab, r);
  -- v21: zztest16's Lobster is linked with no route (it stays off Happy Supply's list there).
  update mog.items set wh_product = lobster where slug = 'zztest16' and item_id = 'ITEM-0004';
  update mog.items set primary_vendor = 'HS Co', eligible_vendors = '{HS Co}', wh_product = shrimp, wh_vendor = 'HS Co' where slug = 'zztest16b' and item_id = 'ITEM-0001';
  update mog.items set wh_product = lobster, wh_vendor = 'HS Co' where slug = 'zztest16b' and item_id = 'ITEM-0004';

  -- ---- The phone's read ----
  d := mog.live_json('zztest16', null) -> 'happySupply';
  perform pg_temp.chk('read: the phone gets its Happy Supply vendor and each linked item''s cases available',
    d ->> 'vendor' = 'HS Co' and (d -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 9
      and (d -> 'items' -> 'ITEM-0002' ->> 'available')::numeric = 14 and (d -> 'items' -> 'ITEM-0001' ->> 'productId')::bigint = shrimp
      and not (d -> 'items' ? 'ITEM-0003') and jsonb_array_length(d -> 'orders') = 0, d);
  perform pg_temp.chk('read: an item linked with no route isn''t offered here; the store with a route gets it (v21)',
    not (d -> 'items' ? 'ITEM-0004') and (mog.live_json('zztest16b', null) -> 'happySupply' -> 'items') ? 'ITEM-0004', d);
  r := public.mog_snapshot2(ptok, null, null, null, null);
  perform pg_temp.chk('read: the phone''s 10-second snapshot carries it',
    (r ->> 'ok')::boolean and r -> 'data' -> 'happySupply' ->> 'vendor' = 'HS Co', r -> 'data' -> 'happySupply');

  -- ---- Send ----
  r := public.mog_wh_send(ptokb, '{"vendor": "HS Co", "neededBy": null, "note": "", "by": "Tony", "lines": [{"itemId": "ITEM-0001", "cases": 5}]}');
  ordb := (r -> 'data' -> 'order' ->> 'id')::bigint;
  perform pg_temp.chk('send: a store sends its Happy Supply order, numbered HS-',
    (r ->> 'ok')::boolean and r -> 'data' -> 'order' ->> 'number' ~ '^HS-[0-9]{4,}$' and r -> 'data' -> 'order' ->> 'status' = 'sent', r);
  perform pg_temp.chk('send: another store''s sent order holds its cases',
    (mog.live_json('zztest16', null) -> 'happySupply' -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 4, null);

  r := public.mog_wh_send(ptok, jsonb_build_object('vendor', 'HS Co', 'neededBy', (current_date + 2)::text, 'note', 'Running low',
         'by', 'Maria', 'lines', '[{"itemId": "ITEM-0001", "cases": 8}, {"itemId": "ITEM-0002", "cases": 2}]'::jsonb));
  ord1 := (r -> 'data' -> 'order' ->> 'id')::bigint;
  num1 := r -> 'data' -> 'order' ->> 'number';
  perform pg_temp.chk('send: more than is available goes as typed; no price, fee or cost reaches the phone',
    (r ->> 'ok')::boolean and jsonb_array_length(r -> 'data' -> 'order' -> 'lines') = 2
      and (r -> 'data' -> 'order' -> 'lines' -> 0 ->> 'cases')::numeric = 8 and r -> 'data' -> 'order' ->> 'neededBy' = (current_date + 2)::text
      and position('price' in lower(r::text)) = 0 and position('fee' in lower(r::text)) = 0 and position('cost' in lower(r::text)) = 0, r);
  perform pg_temp.chk('send: a store''s own order is left out of its available, and holds the others''',
    (r -> 'data' -> 'happySupply' -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 4
      and (mog.live_json('zztest16b', null) -> 'happySupply' -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 1, r -> 'data' -> 'happySupply');

  r := public.mog_wh_send(ptok, '{"vendor": "HS Co", "neededBy": null, "note": "", "by": "Luis", "lines": [{"itemId": "ITEM-0001", "cases": 6}, {"itemId": "ITEM-0002", "cases": 2}]}');
  perform pg_temp.chk('send: sending again this cycle replaces the order while it''s sent (same number, one open order)',
    (r ->> 'ok')::boolean and (r -> 'data' -> 'order' ->> 'id')::bigint = ord1 and r -> 'data' -> 'order' ->> 'number' = num1
      and (r -> 'data' -> 'order' ->> 'version')::bigint = 2 and r -> 'data' -> 'order' ->> 'sentBy' = 'Luis'
      and (r -> 'data' -> 'order' -> 'lines' -> 0 ->> 'cases')::numeric = 6
      and (select count(*) from mog.wh_orders where slug = 'zztest16') = 1, r -> 'data' -> 'order');

  n := (select count(*) from mog.wh_order_lines where order_id = ord1);
  r := public.mog_wh_send(ptok, '{"vendor": "HS Co", "lines": [{"itemId": "ITEM-0003", "cases": 1}]}');
  perform pg_temp.chk('send: an item not linked to a product is refused by name', r ->> 'error' like 'REJECTED: Rice isn''t linked%', r);
  r := public.mog_wh_send(ptok, '{"vendor": "Sysco", "lines": [{"itemId": "ITEM-0001", "cases": 1}]}');
  perform pg_temp.chk('send: another vendor isn''t Happy Supply', r ->> 'error' like 'REJECTED: Sysco isn''t this store''s Happy Supply%', r);
  r := public.mog_wh_send(ptok, '{"vendor": "HS Co", "lines": [{"itemId": "ITEM-0004", "cases": 1}]}');
  perform pg_temp.chk('send: an item with no route is refused (v21)', r ->> 'error' like 'REJECTED: Lobster isn''t on Happy Supply''s list here%', r);
  r := public.mog_wh_send(ptok, '{"vendor": "HS Co", "lines": [{"itemId": "ITEM-0001", "cases": 0}]}');
  perform pg_temp.chk('send: 0 cases is refused', r ->> 'error' like 'REJECTED: Shrimp needs more than 0 cases%', r);
  r := public.mog_wh_send(ptok, '{"vendor": "HS Co", "lines": [{"itemId": "ITEM-0001", "cases": 1}, {"itemId": "ITEM-0001", "cases": 2}]}');
  perform pg_temp.chk('send: the same item twice is refused', r ->> 'error' like 'REJECTED: Shrimp is in the order twice%', r);
  r := public.mog_wh_send(ptok, jsonb_build_object('vendor', 'HS Co', 'neededBy', (current_date - 1)::text, 'lines', '[{"itemId": "ITEM-0001", "cases": 1}]'::jsonb));
  perform pg_temp.chk('send: needed by before the order day is refused', r ->> 'error' like 'REJECTED: needed by is before%', r);
  r := public.mog_wh_send(ptok, '{"vendor": "HS Co", "neededBy": "Wednesday", "lines": [{"itemId": "ITEM-0001", "cases": 1}]}');
  perform pg_temp.chk('send: a needed-by that isn''t a date is refused', r ->> 'error' like 'REJECTED: needed by is a date%', r);
  r := public.mog_wh_send(ptok, '{"vendor": "HS Co", "lines": []}');
  perform pg_temp.chk('send: an empty order is refused', r ->> 'error' like 'REJECTED:%', r);
  perform pg_temp.chk('send: every refusal changed nothing',
    (select version from mog.wh_orders where id = ord1) = 2 and (select count(*) from mog.wh_order_lines where order_id = ord1) = n
      and (select cases from mog.wh_order_lines where order_id = ord1 and ord = 1) = 6, null);
  perform pg_temp.chk('send: a bogus phone token is refused',
    public.mog_wh_send('bogus', '{}') ->> 'error' = 'SESSION_EXPIRED' and public.mog_wh_received('bogus', '{}') ->> 'error' = 'SESSION_EXPIRED', null);

  -- ---- Dan ships ----
  perform pg_temp.chk('ship: an hq-only sign-in can''t ship or cancel; a bogus one is told to sign in',
    public.mog_wh_ship(tokh, '{}') ->> 'error' = 'NOT_ALLOWED' and public.mog_wh_order_cancel(tokh, ord1, 1) ->> 'error' = 'NOT_ALLOWED'
      and public.mog_wh_ship('bogus', '{}') ->> 'error' = 'SESSION_EXPIRED', null);
  r := public.mog_wh_data(tok);
  perform pg_temp.chk('ship: Dan''s page lists both orders, with the store, and no price before shipping',
    (r ->> 'ok')::boolean
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'orders') o where (o ->> 'id')::bigint = ord1
                    and o ->> 'slug' = 'zztest16' and o ->> 'store' = 'Smoke v16 BOH' and o -> 'lines' -> 0 -> 'price' = 'null'::jsonb)
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'orders') o where (o ->> 'id')::bigint = ordb), null);
  r := public.mog_wh_ship(tok, jsonb_build_object('id', ord1, 'version', 1, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 4, 'locationId', locA), jsonb_build_object('ord', 2, 'cases', 2, 'locationId', locA))));
  perform pg_temp.chk('ship: an old version is CONFLICT', r ->> 'error' = 'CONFLICT', r);
  r := public.mog_wh_ship(tok, jsonb_build_object('id', ord1, 'version', 2, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 7, 'locationId', locA), jsonb_build_object('ord', 2, 'cases', 2, 'locationId', locA))));
  perform pg_temp.chk('ship: more than was ordered is refused', r ->> 'error' like 'REJECTED: Shrimp ordered 6 cases%', r);
  r := public.mog_wh_ship(tok, jsonb_build_object('id', ord1, 'version', 2, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 4, 'locationId', locA), jsonb_build_object('ord', 2, 'cases', 2, 'locationId', locB))));
  perform pg_temp.chk('ship: a line that would take a location below 0 refuses the whole shipment, writing nothing',
    r ->> 'error' like 'REJECTED: zz smoke 16 Tysons has 0 cases of zz smoke 16 crab%'
      and (select cases from mog.wh_stock where product_id = shrimp and location_id = locA) = 9
      and (select status from mog.wh_orders where id = ord1) = 'sent'
      and not exists (select 1 from mog.wh_moves where ref = num1), r);
  r := public.mog_wh_ship(tok, jsonb_build_object('id', ord1, 'version', 2, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 4, 'locationId', locA))));
  perform pg_temp.chk('ship: every line needs a number, 0 for none', r ->> 'error' like 'REJECTED: say how many cases of Crab ship%', r);
  r := public.mog_wh_ship(tok, jsonb_build_object('id', ord1, 'version', 2, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 0), jsonb_build_object('ord', 2, 'cases', 0))));
  perform pg_temp.chk('ship: nothing shipping is refused (cancel instead)', r ->> 'error' like 'REJECTED: nothing ships%', r);
  r := public.mog_wh_ship(tok, jsonb_build_object('id', ord1, 'version', 2, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 4, 'locationId', locA), jsonb_build_object('ord', 2, 'cases', 2, 'locationId', locA))));
  perform pg_temp.chk('ship: shipped short; the stock drops with a shipped move under the order''s number',
    (r ->> 'ok')::boolean and (select status from mog.wh_orders where id = ord1) = 'shipped'
      and (select cases from mog.wh_stock where product_id = shrimp and location_id = locA) = 5
      and (select cases from mog.wh_stock where product_id = crab and location_id = locA) = 12
      and (select count(*) from mog.wh_moves where ref = num1 and kind = 'shipped') = 2
      and (select cases from mog.wh_moves where ref = num1 and product_id = shrimp) = -4, r -> 'data' -> 'done');
  perform pg_temp.chk('ship: each line''s price locks at (average + fee) x (1 + markup %), with the average kept',
    not exists (select 1 from mog.wh_order_lines l join mog.wh_products p on p.id = l.product_id, mog.wh_settings s
                 where l.order_id = ord1 and s.id
                   and (l.price is distinct from mog.wh_store_price(p.avg_cost, p.handling_fee, s.markup_pct)
                        or l.avg_cost is distinct from p.avg_cost))
      and (select avg_cost from mog.wh_order_lines where order_id = ord1 and ord = 1) = 77.3095
      and (select delivery_fee from mog.wh_orders where id = ord1) = (select delivery_fee from mog.wh_settings where id), null);
  r := public.mog_wh_ship(tok, jsonb_build_object('id', ord1, 'version', 3, 'lines', jsonb_build_array(
         jsonb_build_object('ord', 1, 'cases', 1, 'locationId', locA), jsonb_build_object('ord', 2, 'cases', 0))));
  perform pg_temp.chk('ship: a shipped order can''t ship again', r ->> 'error' = 'CONFLICT', r);
  d := public.mog_snapshot2(ptok, null, null, null, null) -> 'data' -> 'happySupply';
  perform pg_temp.chk('ship: the phone sees it shipped, how many and from where, still with no price',
    d -> 'orders' -> 0 ->> 'status' = 'shipped' and (d -> 'orders' -> 0 -> 'lines' -> 0 ->> 'casesShipped')::numeric = 4
      and d -> 'orders' -> 0 ->> 'from' = 'zz smoke 16 Berliner' and position('price' in lower(d::text)) = 0, d);
  perform pg_temp.chk('ship: what shipped no longer holds anything; the other store''s order still does',
    (d -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 0
      and (mog.live_json('zztest16b', null) -> 'happySupply' -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 5, d -> 'items');

  -- ---- Mark received ----
  r := public.mog_wh_received(ptokb, jsonb_build_object('id', ord1));
  perform pg_temp.chk('received: another store can''t mark it', r ->> 'error' like 'REJECTED: that order isn''t this store''s%', r);
  r := public.mog_wh_received(ptokb, jsonb_build_object('id', ordb));
  perform pg_temp.chk('received: an order that hasn''t shipped can''t be marked', r ->> 'error' like 'REJECTED: % is sent, not shipped%', r);
  r := public.mog_wh_received(ptok, jsonb_build_object('id', ord1, 'lines', '[{"ord": 1, "cases": 5}]'::jsonb));
  perform pg_temp.chk('received: more than shipped is refused, changing nothing',
    r ->> 'error' like 'REJECTED: Shrimp shipped 4 cases%' and (select status from mog.wh_orders where id = ord1) = 'shipped', r);
  r := public.mog_wh_received(ptok, jsonb_build_object('id', ord1, 'by', 'Maria', 'lines', '[{"ord": 1, "cases": 3}]'::jsonb));
  perform pg_temp.chk('received: a short line as typed, a line left out as shipped; stock untouched',
    (r ->> 'ok')::boolean and r -> 'data' -> 'order' ->> 'status' = 'received' and r -> 'data' -> 'order' ->> 'receivedBy' = 'Maria'
      and (select cases_received from mog.wh_order_lines where order_id = ord1 and ord = 1) = 3
      and (select cases_received from mog.wh_order_lines where order_id = ord1 and ord = 2) = 2
      and (select cases from mog.wh_stock where product_id = shrimp and location_id = locA) = 5, r -> 'data' -> 'order');
  ver := (select version from mog.wh_orders where id = ord1);
  r := public.mog_wh_received(ptok, jsonb_build_object('id', ord1, 'lines', '[{"ord": 1, "cases": 0}]'::jsonb));
  perform pg_temp.chk('received: a second tap (another phone) answers as it stands and changes nothing',
    (r ->> 'ok')::boolean and (select version from mog.wh_orders where id = ord1) = ver
      and (select cases_received from mog.wh_order_lines where order_id = ord1 and ord = 1) = 3, null);

  -- ---- Cancel ----
  r := public.mog_wh_order_cancel(tok, ordb, 99);
  perform pg_temp.chk('cancel: an old version is CONFLICT', r ->> 'error' = 'CONFLICT', r);
  r := public.mog_wh_order_cancel(tok, ordb, 1);
  perform pg_temp.chk('cancel: a sent order is cancelled, and stops holding its cases',
    (r ->> 'ok')::boolean and (select status from mog.wh_orders where id = ordb) = 'cancelled'
      and (mog.live_json('zztest16', null) -> 'happySupply' -> 'items' -> 'ITEM-0001' ->> 'available')::numeric = 5, r -> 'data' -> 'done');
  r := public.mog_wh_order_cancel(tok, ord1, ver);
  perform pg_temp.chk('cancel: an order that shipped can''t be cancelled', r ->> 'error' = 'CONFLICT', r);
  r := public.mog_wh_send(ptokb, '{"vendor": "HS Co", "lines": [{"itemId": "ITEM-0001", "cases": 1}]}');
  perform pg_temp.chk('send: after a cancel, the same cycle gets a new order',
    (r ->> 'ok')::boolean and (r -> 'data' -> 'order' ->> 'id')::bigint <> ordb, r -> 'data' -> 'order');

  perform pg_temp.clean16();
  perform pg_temp.chk('cleanup: nothing of the smoke is left',
    not exists (select 1 from mog.stores where slug in ('zztest16', 'zztest16b'))
      and not exists (select 1 from mog.wh_orders where slug in ('zztest16', 'zztest16b'))
      and not exists (select 1 from mog.wh_products where name like 'zz smoke 16 %'), null);
end;
$$;

select n, case when ok then 'PASS' else 'FAIL' end as result, check_name, detail from mog_smoke16 order by n;
