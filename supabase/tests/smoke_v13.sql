-- =====================================================================
-- MOG schema v13 — smoke test (run in the SQL Editor AFTER schema_v13.sql)
-- =====================================================================
-- The HQ people 'zz smoke 13' (warehouse only) and 'zz smoke 13 hq', the
-- throwaway store 'zztest13', and warehouse rows named 'zz smoke 13 ...'
-- (two locations, a supplier, two products), so no real stock is touched:
-- roles (a warehouse sign-in can't reach a store's catalog, an hq one
-- can't reach the warehouse, roles change without a new sign-in), saving
-- products, locations and suppliers (refusals, CONFLICT), vendor orders in
-- (numbered, received, the average cost over every location and what's in
-- transit), transfers (in transit, refused below 0 writing nothing),
-- counts (a difference needs a reason, a match changes nothing), the
-- history, and the settings. Cleans up after itself, the settings' version
-- aside. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke13 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke13;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke13 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

create or replace function pg_temp.wh_clean13()
returns void language sql as $$
  delete from mog.wh_moves where product_id in (select id from mog.wh_products where name like 'zz smoke 13 %');
  delete from mog.wh_pos where supplier_id in (select id from mog.wh_suppliers where name like 'zz smoke 13 %');
  delete from mog.wh_transfers where from_location_id in (select id from mog.wh_locations where name like 'zz smoke 13 %')
                                 or to_location_id in (select id from mog.wh_locations where name like 'zz smoke 13 %');
  delete from mog.wh_stock where product_id in (select id from mog.wh_products where name like 'zz smoke 13 %');
  delete from mog.wh_products where name like 'zz smoke 13 %';
  delete from mog.wh_locations where name like 'zz smoke 13 %';
  delete from mog.wh_suppliers where name like 'zz smoke 13 %';
  delete from mog.hq_users where name in ('zz smoke 13', 'zz smoke 13 hq');
  delete from mog.stores where slug = 'zztest13';
$$;

do $$
declare
  me     text := 'zz smoke 13';
  me2    text := 'zz smoke 13 hq';
  pass   text := 'correct horse battery';
  pre    text := 'zz smoke 13 ';
  code   text;
  tok    text;
  tokh   text;
  r      jsonb;
  d      jsonb;
  n      integer;
  locA   bigint;
  locB   bigint;
  sup    bigint;
  shrimp bigint;
  crab   bigint;
  po1    bigint;
  po2    bigint;
  po3    bigint;
  num1   text;
  num2   text;
  tr     bigint;
  ver    bigint;
  s_by   text;
  s_at   timestamptz;
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key can call the warehouse''s nine calls',
    has_function_privilege('anon', 'public.mog_wh_data(text)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_history(text, bigint, bigint, bigint)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_save(text, text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_po_save(text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_po_cancel(text, bigint, bigint)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_po_receive(text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_transfer_send(text, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_transfer_receive(text, bigint)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_count(text, jsonb)', 'execute'), null);
  perform pg_temp.chk('privileges: the public key cannot reach the warehouse tables, its helpers or the role tools',
    not has_table_privilege('anon', 'mog.wh_products', 'select')
      and not has_table_privilege('anon', 'mog.wh_stock', 'select')
      and not has_table_privilege('anon', 'mog.wh_moves', 'select')
      and not has_table_privilege('anon', 'mog.wh_settings', 'select')
      and not has_function_privilege('anon', 'mog.wh_move(text, bigint, bigint, numeric, text, text, numeric, text)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_state(text)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_session(text)', 'execute')
      and not has_function_privilege('anon', 'mog.hq_set_roles(text, text[])', 'execute')
      and not has_function_privilege('anon', 'mog.hq_invite(text, text[])', 'execute'), null);

  perform pg_temp.wh_clean13();

  -- ---- Roles ----
  perform pg_temp.chk('roles: everyone has one or two known roles',
    not exists (select 1 from mog.hq_users where not (roles <@ array['hq', 'warehouse']::text[] and cardinality(roles) between 1 and 2)), null);
  code := substring(mog.hq_invite(me, '{warehouse}') from ': ([0-9A-F]+)');
  r := public.mog_hq_claim(me, code, pass);
  tok := r -> 'data' ->> 'token';
  perform pg_temp.chk('roles: an invite with a role; signing in returns it',
    (r ->> 'ok')::boolean and r -> 'data' -> 'roles' = '["warehouse"]'::jsonb, r - 'data');
  perform pg_temp.chk('roles: a warehouse sign-in can''t read or change any store''s catalog',
    public.mog_hq_data(tok) ->> 'error' = 'SESSION_EXPIRED'
      and public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb) ->> 'error' = 'SESSION_EXPIRED'
      and public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb) ->> 'error' = 'SESSION_EXPIRED', null);
  r := public.mog_wh_data(tok);
  perform pg_temp.chk('data: a warehouse sign-in reads the warehouse, with its name and role',
    (r ->> 'ok')::boolean and r -> 'data' ->> 'name' = me and r -> 'data' -> 'roles' = '["warehouse"]'::jsonb
      and jsonb_typeof(r -> 'data' -> 'products') = 'array' and r -> 'data' -> 'settings' ? 'markupPct'
      and jsonb_typeof(r -> 'data' -> 'stores') = 'array', r -> 'data' -> 'settings');
  code := substring(mog.hq_invite(me2) from ': ([0-9A-F]+)');
  tokh := public.mog_hq_claim(me2, code, pass) -> 'data' ->> 'token';
  perform pg_temp.chk('roles: someone invited the old way is hq only, and can''t reach the warehouse',
    (select roles = '{hq}' from mog.hq_users where name = me2)
      and public.mog_wh_data(tokh) ->> 'error' = 'NOT_ALLOWED'
      and public.mog_wh_count(tokh, '{}'::jsonb) ->> 'error' = 'NOT_ALLOWED'
      and (public.mog_hq_data(tokh) ->> 'ok')::boolean, null);
  perform pg_temp.chk('roles: a bogus token is SESSION_EXPIRED on every call',
    public.mog_wh_data('bogus') ->> 'error' = 'SESSION_EXPIRED' and public.mog_wh_save('bogus', 'location', '{}'::jsonb) ->> 'error' = 'SESSION_EXPIRED'
      and public.mog_wh_history('bogus', null, null, null) ->> 'error' = 'SESSION_EXPIRED', null);
  perform mog.hq_set_roles(me2, '{warehouse, hq}');
  perform pg_temp.chk('roles: set_roles gives both on the next call, without signing in again',
    (select roles = '{hq,warehouse}' from mog.hq_users where name = me2)
      and (public.mog_wh_data(tokh) ->> 'ok')::boolean and (public.mog_hq_data(tokh) ->> 'ok')::boolean, null);
  perform mog.hq_invite(me2);
  n := 0;
  begin perform mog.hq_set_roles(me2, '{admin}'); exception when others then n := n + 1; end;
  begin perform mog.hq_invite(me2, '{}'); exception when others then n := n + 1; end;
  perform pg_temp.chk('roles: a new invite keeps them; anything but hq and warehouse is refused',
    n = 2 and (select roles = '{hq,warehouse}' from mog.hq_users where name = me2), to_jsonb(n));

  -- ---- Locations, a supplier, products ----
  perform mog.provision_store('zztest13');
  r := public.mog_wh_save(tok, 'location', jsonb_build_object('name', ' ' || pre || 'Berliner '));
  locA := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'location', jsonb_build_object('name', pre || 'Tysons freezer'));
  locB := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'supplier', jsonb_build_object('name', pre || 'Ruby Seas'));
  sup := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('name', pre || 'Shrimp 16/20', 'pack', '10 LB case', 'par', 12,
                                                             'handlingFee', 6, 'stores', '[]'::jsonb));
  shrimp := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('name', pre || 'King crab 9/12', 'pack', '20 LB case', 'par', 10,
                                                             'handlingFee', 25.004, 'stores', '["zztest13", "zztest13"]'::jsonb));
  crab := (r -> 'data' -> 'done' ->> 'id')::bigint;
  -- v21 retired a product's par and stores (unread until v22): not checked here.
  perform pg_temp.chk('save: locations (trimmed, in order), a supplier, products (no cost until a delivery, fee to the cent)',
    (select name = pre || 'Berliner' from mog.wh_locations where id = locA)
      and (select ord from mog.wh_locations where id = locB) > (select ord from mog.wh_locations where id = locA)
      and exists (select 1 from mog.wh_suppliers where id = sup and active)
      and (select avg_cost = 0 and handling_fee = 6 and version = 1 and updated_by = me
             from mog.wh_products where id = shrimp)
      and (select handling_fee = 25.00 from mog.wh_products where id = crab), r - 'data');
  n := 0;
  foreach d in array array[
    jsonb_build_object('name', upper(pre) || 'SHRIMP 16/20', 'par', 1, 'handlingFee', 0),
    jsonb_build_object('name', pre || 'Lobster', 'par', 1, 'handlingFee', -1),
    jsonb_build_object('name', '  ', 'par', 1, 'handlingFee', 0),
    jsonb_build_object('name', pre || 'Lobster', 'par', 1, 'handlingFee', 0, 'active', 'yes')
  ] loop
    r := public.mog_wh_save(tok, 'product', d);
    if r ->> 'error' like 'REJECTED: %' then n := n + 1; end if;
  end loop;
  perform pg_temp.chk('save: refused: a name twice (any case), a fee below 0, no name, a bad flag (v21: par and stores retired)',
    n = 4 and not exists (select 1 from mog.wh_products where name = pre || 'Lobster'), to_jsonb(n));
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('id', shrimp, 'version', 0, 'name', pre || 'Shrimp 16/20', 'par', 12, 'handlingFee', 7));
  perform pg_temp.chk('save: an edit from an older version is a CONFLICT, the product as it was',
    r ->> 'error' = 'CONFLICT' and (select handling_fee = 6 and version = 1 from mog.wh_products where id = shrimp), r);
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('id', shrimp, 'version', 1, 'name', pre || 'Shrimp 16/20', 'pack', '10 LB case',
                                                             'par', 12, 'handlingFee', 6, 'stores', '[]'::jsonb));
  perform pg_temp.chk('save: an edit at the version read is saved, version 2',
    (r ->> 'ok')::boolean and (select version = 2 from mog.wh_products where id = shrimp), r - 'data');
  r := public.mog_wh_save(tok, 'shelf', '{}'::jsonb);
  perform pg_temp.chk('save: only a product, location, supplier or the settings', r ->> 'error' like 'REJECTED: nothing called shelf%', r);

  -- ---- A vendor order in ----
  r := public.mog_wh_po_save(tok, jsonb_build_object('supplierId', sup, 'locationId', locA, 'note', 'first',
         'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', 11, 'cost', 78.5))));
  po1 := (r -> 'data' -> 'done' ->> 'id')::bigint;
  num1 := r -> 'data' -> 'done' ->> 'number';
  perform pg_temp.chk('po: a new order is numbered PO-NNNN, ordered, version 1, with its line',
    num1 ~ '^PO-[0-9]{4,}$' and (select status = 'ordered' and version = 1 and created_by = me from mog.wh_pos where id = po1)
      and (select count(*) = 1 from mog.wh_po_lines where po_id = po1)
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'pos') p where (p ->> 'id')::bigint = po1 and p -> 'lines' -> 0 ->> 'product' = pre || 'Shrimp 16/20'),
    r - 'data');
  r := public.mog_wh_po_receive(tok, jsonb_build_object('id', po1, 'version', 1,
         'lines', jsonb_build_array(jsonb_build_object('ord', 1, 'cases', 11, 'cost', 78.5))));
  perform pg_temp.chk('receive: the first delivery sets the average cost and the stock where it went',
    (r ->> 'ok')::boolean and (select avg_cost = 78.5 from mog.wh_products where id = shrimp)
      and (select cases = 11 from mog.wh_stock where product_id = shrimp and location_id = locA)
      and (select status = 'received' and closed_by = me and version = 2 from mog.wh_pos where id = po1)
      and (select cases_received = 11 and cost_received = 78.5 from mog.wh_po_lines where po_id = po1), r - 'data');

  -- ---- A transfer: in transit, and refused below 0 ----
  r := public.mog_wh_transfer_send(tok, jsonb_build_object('fromId', locB, 'toId', locA,
         'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', 3))));
  perform pg_temp.chk('transfer: refused when the location hasn''t got it, writing nothing',
    r ->> 'error' = 'REJECTED: ' || pre || 'Tysons freezer has 0 cases of ' || pre || 'Shrimp 16/20'
      and not exists (select 1 from mog.wh_transfers where from_location_id = locB)
      and (select count(*) = 1 from mog.wh_moves where product_id = shrimp), r);
  r := public.mog_wh_transfer_send(tok, jsonb_build_object('fromId', locA, 'toId', locB, 'note', 'for Tysons',
         'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', 2))));
  tr := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform pg_temp.chk('transfer: sent, numbered TR-NNNN; the cases leave and show in transit, owned the same',
    r -> 'data' -> 'done' ->> 'number' ~ '^TR-[0-9]{4,}$'
      and (select cases = 9 from mog.wh_stock where product_id = shrimp and location_id = locA)
      and mog.wh_in_transit(shrimp) = 2 and mog.wh_owned(shrimp) = 11
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'products') p where (p ->> 'id')::bigint = shrimp and (p ->> 'inTransit')::numeric = 2),
    r - 'data');
  r := public.mog_wh_transfer_send(tok, jsonb_build_object('fromId', locA, 'toId', locA,
         'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', 1))));
  perform pg_temp.chk('transfer: refused to the same location', r ->> 'error' like 'REJECTED: a transfer goes to another location%', r);

  -- ---- A second order: the average over what's owned, a short line ----
  r := public.mog_wh_po_save(tok, jsonb_build_object('supplierId', sup, 'locationId', locA,
         'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', 10, 'cost', 76),
                                    jsonb_build_object('productId', crab, 'cases', 4))));
  po2 := (r -> 'data' -> 'done' ->> 'id')::bigint;
  num2 := r -> 'data' -> 'done' ->> 'number';
  perform pg_temp.chk('po: numbers follow on', substr(num2, 4)::integer = substr(num1, 4)::integer + 1, to_jsonb(num2));
  n := 0;
  foreach d in array array[
    jsonb_build_object('supplierId', sup, 'locationId', locA, 'lines', '[]'::jsonb),
    jsonb_build_object('supplierId', sup, 'locationId', locA, 'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', 0))),
    jsonb_build_object('supplierId', sup, 'locationId', locA, 'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', 1),
                                                                                        jsonb_build_object('productId', shrimp, 'cases', 2))),
    jsonb_build_object('supplierId', sup, 'locationId', locA, 'lines', jsonb_build_array(jsonb_build_object('productId', -1, 'cases', 1))),
    jsonb_build_object('supplierId', -1, 'locationId', locA, 'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', 1))),
    jsonb_build_object('supplierId', sup, 'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', 1)))
  ] loop
    r := public.mog_wh_po_save(tok, d);
    if r ->> 'error' like 'REJECTED: %' then n := n + 1; end if;
  end loop;
  perform pg_temp.chk('po: refused: no lines, 0 cases, a product twice, an unknown product, supplier or location',
    n = 6 and (select count(*) = 2 from mog.wh_pos where supplier_id = sup), to_jsonb(n));
  r := public.mog_wh_po_receive(tok, jsonb_build_object('id', po2, 'version', 0,
         'lines', '[{"ord": 1, "cases": 10, "cost": 76}, {"ord": 2, "cases": 0}]'::jsonb));
  perform pg_temp.chk('receive: from an older version is a CONFLICT', r ->> 'error' = 'CONFLICT', r);
  r := public.mog_wh_po_receive(tok, jsonb_build_object('id', po2, 'version', 1, 'lines', '[{"ord": 1, "cases": 10}, {"ord": 2, "cases": 0}]'::jsonb));
  perform pg_temp.chk('receive: cases that came in need their cost', r ->> 'error' like 'REJECTED: The cost of %needs a number', r);
  r := public.mog_wh_po_receive(tok, jsonb_build_object('id', po2, 'version', 1, 'lines', '[{"ord": 1, "cases": 10, "cost": 76}]'::jsonb));
  perform pg_temp.chk('receive: every line of the order is answered', r ->> 'error' like 'REJECTED: say what came in of %King crab%', r);
  r := public.mog_wh_po_receive(tok, jsonb_build_object('id', po2, 'version', 1,
         'lines', '[{"ord": 1, "cases": 10, "cost": 76}, {"ord": 2, "cases": 0}]'::jsonb));
  perform pg_temp.chk('receive: the average covers every location and what''s in transit: (11 x 78.50 + 10 x 76) / 21 = 77.3095',
    (r ->> 'ok')::boolean and (select avg_cost = 77.3095 from mog.wh_products where id = shrimp)
      and mog.wh_avg_after(11, 78.5, 10, 76) = 77.3095 and mog.wh_avg_after(0, 0, 4, 148) = 148 and mog.wh_avg_after(6, 145, 0, 999) = 145
      and mog.wh_avg_after(6, 145, 3, 148) = 146,
    (select jsonb_build_object('avg', avg_cost) from mog.wh_products where id = shrimp));
  perform pg_temp.chk('receive: a line with 0 came in changes nothing; it''s kept as 0',
    (select avg_cost = 0 from mog.wh_products where id = crab) and not exists (select 1 from mog.wh_stock where product_id = crab and cases > 0)
      and (select cases_received = 0 and cost_received is null from mog.wh_po_lines where po_id = po2 and ord = 2), null);
  r := public.mog_wh_po_receive(tok, jsonb_build_object('id', po2, 'version', 2, 'lines', '[{"ord": 1, "cases": 1, "cost": 1}, {"ord": 2, "cases": 0}]'::jsonb));
  perform pg_temp.chk('receive: an order is received once', r ->> 'error' like 'REJECTED: PO-% was already received', r);
  r := public.mog_wh_po_save(tok, jsonb_build_object('supplierId', sup, 'locationId', locB,
         'lines', jsonb_build_array(jsonb_build_object('productId', crab, 'cases', 2))));
  po3 := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_po_receive(tok, jsonb_build_object('id', po3, 'version', 1, 'lines', '[{"ord": 1, "cases": 0}]'::jsonb));
  perform pg_temp.chk('receive: nothing came in is refused (cancel instead)', r ->> 'error' like 'REJECTED: nothing came in on %', r);
  r := public.mog_wh_po_cancel(tok, po3, 0);
  perform pg_temp.chk('cancel: from an older version is a CONFLICT', r ->> 'error' = 'CONFLICT', r);
  r := public.mog_wh_po_cancel(tok, po3, 1);
  perform pg_temp.chk('cancel: closed as cancelled, no stock moved',
    (r ->> 'ok')::boolean and (select status = 'cancelled' and closed_by = me from mog.wh_pos where id = po3)
      and not exists (select 1 from mog.wh_moves where product_id = crab), r - 'data');

  -- ---- The transfer arrives ----
  r := public.mog_wh_transfer_receive(tok, tr);
  perform pg_temp.chk('transfer: received at the other location; nothing in transit; the average unchanged',
    (r ->> 'ok')::boolean and (select cases = 2 from mog.wh_stock where product_id = shrimp and location_id = locB)
      and mog.wh_in_transit(shrimp) = 0 and mog.wh_owned(shrimp) = 21
      and (select avg_cost = 77.3095 from mog.wh_products where id = shrimp)
      and (select status = 'received' and closed_by = me from mog.wh_transfers where id = tr), r - 'data');
  r := public.mog_wh_transfer_receive(tok, tr);
  perform pg_temp.chk('transfer: received once', r ->> 'error' like 'REJECTED: TR-% was already received', r);

  -- ---- A count ----
  r := public.mog_wh_count(tok, jsonb_build_object('locationId', locA,
         'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', 17))));
  perform pg_temp.chk('count: a difference with no reason is refused, writing nothing',
    r ->> 'error' like 'REJECTED: % differs from the record (17 counted, 19 on record): say why'
      and (select cases = 19 from mog.wh_stock where product_id = shrimp and location_id = locA), r);
  r := public.mog_wh_count(tok, jsonb_build_object('locationId', locA,
         'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', 17, 'reason', ' 2 cases thawed '),
                                    jsonb_build_object('productId', crab, 'cases', 0))));
  perform pg_temp.chk('count: the difference is kept with its reason; a product that matches changes nothing',
    (r ->> 'ok')::boolean and r -> 'data' -> 'done' ->> 'changed' = '1'
      and (select cases = 17 from mog.wh_stock where product_id = shrimp and location_id = locA)
      and exists (select 1 from mog.wh_moves where product_id = shrimp and kind = 'count' and cases = -2 and reason = '2 cases thawed'
                    and cases_after = 17 and avg_after = 77.3095 and by_name = me)
      and not exists (select 1 from mog.wh_moves where product_id = crab), r - 'data');
  r := public.mog_wh_count(tok, jsonb_build_object('locationId', locB,
         'lines', jsonb_build_array(jsonb_build_object('productId', shrimp, 'cases', -1, 'reason', 'x'))));
  perform pg_temp.chk('count: below 0 is refused', r ->> 'error' like 'REJECTED: % needs 0 or more cases', r);

  -- ---- History, the read, a location that still holds stock ----
  r := public.mog_wh_history(tok, shrimp, null, null);
  perform pg_temp.chk('history: every change to the product, newest first, with who and why',
    (select jsonb_agg(m ->> 'kind') from jsonb_array_elements(r -> 'data' -> 'moves') m)
        = '["count", "transfer_in", "received", "transfer_out", "received"]'::jsonb
      and r -> 'data' -> 'moves' -> 0 ->> 'reason' = '2 cases thawed' and r -> 'data' -> 'moves' -> 0 ->> 'by' = me
      and r -> 'data' -> 'moves' -> 2 ->> 'ref' = num2, r);
  r := public.mog_wh_history(tok, null, locB, null);
  perform pg_temp.chk('history: by location, and paging back', jsonb_array_length(r -> 'data' -> 'moves') = 1
      and jsonb_array_length(public.mog_wh_history(tok, shrimp, null, (r -> 'data' -> 'moves' -> 0 ->> 'id')::bigint) -> 'data' -> 'moves') = 3, r);
  r := public.mog_wh_data(tok);
  perform pg_temp.chk('data: a product''s stock per location, its average and last delivery; the stores to limit it to',
    exists (select 1 from jsonb_array_elements(r -> 'data' -> 'products') p
             where (p ->> 'id')::bigint = shrimp and p -> 'stock' = jsonb_build_object(locA::text, 17, locB::text, 2)
               and (p ->> 'avgCost')::numeric = 77.3095 and (p ->> 'inTransit')::numeric = 0
               and p -> 'lastReceipt' ->> 'ref' = num2)
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'stores') s where s ->> 'slug' = 'zztest13'), null);
  r := public.mog_wh_save(tok, 'location', jsonb_build_object('id', locB, 'name', pre || 'Tysons freezer', 'active', false));
  perform pg_temp.chk('location: one that still holds stock can''t be closed',
    r ->> 'error' like 'REJECTED: % still holds 2 cases%' and (select active from mog.wh_locations where id = locB), r);

  -- ---- Settings ----
  select version, updated_by, updated_at into ver, s_by, s_at from mog.wh_settings where id;
  r := public.mog_wh_save(tok, 'settings', jsonb_build_object('version', ver - 1, 'markupPct', 0, 'deliveryFee', 0));
  perform pg_temp.chk('settings: an older version is a CONFLICT', r ->> 'error' = 'CONFLICT', r);
  r := public.mog_wh_save(tok, 'settings', jsonb_build_object('version', ver, 'markupPct', 150, 'deliveryFee', 0));
  perform pg_temp.chk('settings: a markup over 100% is refused', r ->> 'error' like 'REJECTED: the markup is from 0 to 100%', r);
  r := public.mog_wh_save(tok, 'settings', (select jsonb_build_object('version', ver, 'markupPct', markup_pct, 'deliveryFee', delivery_fee)
                                              from mog.wh_settings where id));
  perform pg_temp.chk('settings: saved at the version read (the same values back)',
    (r ->> 'ok')::boolean and (select version = ver + 1 from mog.wh_settings where id), r - 'data');
  update mog.wh_settings set updated_by = s_by, updated_at = s_at where id;

  -- ---- Clean up ----
  perform pg_temp.wh_clean13();
  perform pg_temp.chk('cleanup: the test people, store and warehouse rows are gone',
    not exists (select 1 from mog.hq_users where name in (me, me2))
      and not exists (select 1 from mog.stores where slug = 'zztest13')
      and not exists (select 1 from mog.wh_products where name like 'zz smoke 13 %')
      and not exists (select 1 from mog.wh_locations where name like 'zz smoke 13 %')
      and not exists (select 1 from mog.wh_pos where number in (num1, num2)), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke13 order by n;
