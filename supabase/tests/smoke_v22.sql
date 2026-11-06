-- =====================================================================
-- MOG schema v22 — smoke test (run in the SQL Editor AFTER schema_v22.sql)
-- =====================================================================
-- An inactive HQ item or a closed place stops its routes, on throwaway
-- stores: 'zztest22t' holds a place (like RP Tysons BOH) and routes its
-- shrimp to HEH's own place under "HS Co", 'zztest22r' takes from it (like
-- Rosslyn BOH, under its "Transfer (Tysons)"). The HQ person 'zz smoke 22'
-- and warehouse rows named 'zz smoke 22 ...'. Checks: the item made
-- inactive stops the phone, Send and the close, and active again resumes
-- them; a delivery recorded before still checks in; a closed place stops
-- the phone and the close (and a re-run drops a delivery still open from
-- it), and reopened records again; HEH's own place closed leaves nothing
-- available and Send refused. Cleans up after itself. Every row should say
-- PASS.
-- =====================================================================

create temp table if not exists mog_smoke22 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke22;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke22 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

create or replace function pg_temp.clean22()
returns void language sql as $$
  delete from mog.stores where slug in ('zztest22t', 'zztest22r');
  delete from mog.wh_moves where product_id in (select id from mog.wh_products where name like 'zz smoke 22 %');
  delete from mog.wh_stock where product_id in (select id from mog.wh_products where name like 'zz smoke 22 %');
  delete from mog.wh_products where name like 'zz smoke 22 %';
  delete from mog.wh_locations where name like 'zz smoke 22 %';
  delete from mog.hq_users where name = 'zz smoke 22';
$$;

-- A store on the app's editor and phones, counting today. Answers its sync key.
create or replace function pg_temp.store22(p_slug text, p_location text, p_vendors jsonb, p_items jsonb, p_picks jsonb)
returns text language plpgsql as $$
declare
  k text;
begin
  k := mog.provision_store(p_slug);
  perform public.mog_sync_set_pins(p_slug, k, '4321', null);
  perform mog.replace_catalog_tables(p_slug, jsonb_build_object(
    'profile', jsonb_build_object('timeZone', 'America/New_York', 'location', p_location, 'abbr', 'ZZ22', 'concept', 'zz-smoke22'),
    'vendors', p_vendors, 'areas', '[{"name": "Freezer", "ord": 10}]'::jsonb, 'items', p_items, 'pickRows', p_picks));
  perform public.mog_sync_switch_editor(p_slug, k, false);
  perform public.mog_sync_set_phone_direct(p_slug, k, true);
  insert into mog.store_state (slug, cycle_date, day_of_week) values (p_slug, current_date, 'Mon')
  on conflict (slug) do update set cycle_date = excluded.cycle_date;
  return k;
end;
$$;

create or replace function pg_temp.item22(p_id text, p_name text, p_vendor text, p_par numeric)
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'name', p_name, 'primaryVendor', p_vendor, 'pack', 'CASE (10LBs)', 'par', p_par, 'active', true,
                            'useMult', true, 'notes', '', 'sku', '', 'category', '', 'eligible', jsonb_build_array(p_vendor), 'seq', 2);
$$;

-- What the close sends: { vendor, id, name, qty }.
create or replace function pg_temp.log22(p_vendor text, p_qty numeric)
returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('vendor', p_vendor, 'id', 'ITEM-0091', 'name', 'SHRIMP', 'pack', '', 'area', 'Freezer',
                                              'onHandPrev', 0, 'qty', p_qty));
$$;

-- HQ's item save, as the page sends it, with only Active changed.
create or replace function pg_temp.active22(p_tok text, p_id bigint, p_active boolean)
returns jsonb language sql as $$
  select public.mog_wh_save(p_tok, 'product', jsonb_build_object(
    'id', p.id, 'version', p.version, 'name', p.name, 'pack', p.pack, 'handlingFee', p.handling_fee, 'active', p_active,
    'concept', coalesce(p.concept, ''),
    'places', (select jsonb_agg(jsonb_build_object('locationId', pp.location_id, 'lowPoint', pp.low_point) order by pp.location_id)
                 from mog.wh_product_places pp where pp.product_id = p.id)))
    from mog.wh_products p where p.id = p_id;
$$;

-- HQ's place save, with only Open changed.
create or replace function pg_temp.open22(p_tok text, p_id bigint, p_open boolean)
returns jsonb language sql as $$
  select public.mog_wh_save(p_tok, 'location', jsonb_build_object('id', l.id, 'name', l.name, 'active', p_open))
    from mog.wh_locations l where l.id = p_id;
$$;

-- Rosslyn's phone: what it counts on for the shrimp (null = no route there).
create or replace function pg_temp.avail22(p_slug text)
returns numeric language sql as $$
  select (mog.live_json(p_slug, null) -> 'happySupply' -> 'items' -> 'ITEM-0091' ->> 'available')::numeric;
$$;

do $$
declare
  me      text := 'zz smoke 22';
  pass    text := 'correct horse battery';
  code    text;
  tok     text;
  ptokt   text;
  kt      text;
  kr      text;
  locH    bigint;  -- HEH's own
  locT    bigint;  -- at the store zztest22t
  shrimp  bigint;
  r       jsonb;
  d       jsonb;
  del1    bigint;
  del2    bigint;
  d0     date := current_date;
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the close''s step and the available count stay internal; Send stays open',
    not has_function_privilege('anon', 'mog.wh_held_from_log(text, date)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_available_at(bigint, bigint, text, date)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_live_json(text)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_send(text, jsonb)', 'execute'), null);

  perform pg_temp.clean22();

  -- ---- People, stores, places, the shrimp and its routes ----
  code := substring(mog.hq_invite(me, '{hq,warehouse}') from ': ([0-9A-F]+)');
  tok := public.mog_hq_claim(me, code, pass) -> 'data' ->> 'token';
  kt := pg_temp.store22('zztest22t', 'Smoke v22 Tysons BOH',
    '[{"name": "HS Co", "mults": [1,1,1,1,1,1,1], "cutoff": null}]'::jsonb,
    jsonb_build_array(pg_temp.item22('ITEM-0091', 'SHRIMP', 'HS Co', 19)),
    '[{"vendor": "HS Co", "id": "ITEM-0091", "area": "Freezer", "shelfOrder": 10, "seq": 2}]'::jsonb);
  kr := pg_temp.store22('zztest22r', 'Smoke v22 Rosslyn BOH',
    '[{"name": "Transfer (Tysons)", "mults": [1,1,1,1,1,1,1], "cutoff": null}]'::jsonb,
    jsonb_build_array(pg_temp.item22('ITEM-0091', 'SHRIMP', 'Transfer (Tysons)', 7.15)),
    '[{"vendor": "Transfer (Tysons)", "id": "ITEM-0091", "area": "Freezer", "shelfOrder": 10, "seq": 2}]'::jsonb);
  ptokt := public.mog_login('zztest22t', '4321') -> 'data' ->> 'token';
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 22 Happy Supply", "countHow": "hq"}');
  locH := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 22 Tysons", "heldStore": "zztest22t", "countHow": "marginedge"}');
  locT := (r -> 'data' -> 'done' ->> 'id')::bigint;
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('name', 'zz smoke 22 shrimp', 'pack', 'CASE (10LBs)', 'handlingFee', 0, 'active', true,
         'concept', 'zz-smoke22', 'places', jsonb_build_array(jsonb_build_object('locationId', locH, 'lowPoint', 10), jsonb_build_object('locationId', locT))));
  shrimp := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform mog.wh_move(me, shrimp, locH, 30, 'received', 'zz', 65, null);
  perform public.mog_wh_count(tok, jsonb_build_object('locationId', locT, 'lines', jsonb_build_array(
    jsonb_build_object('productId', shrimp, 'cases', 104, 'reason', 'Starting inventory'))));
  update mog.items set wh_product = shrimp, wh_place = null, wh_vendor = 'HS Co' where slug = 'zztest22t' and item_id = 'ITEM-0091';
  update mog.items set wh_product = shrimp, wh_place = locT, wh_vendor = 'Transfer (Tysons)' where slug = 'zztest22r' and item_id = 'ITEM-0091';
  perform pg_temp.chk('setup: both phones count on their route (Rosslyn 104 at Tysons, Tysons 30 at HEH''s own)',
    tok is not null and ptokt is not null and pg_temp.avail22('zztest22r') = 104 and pg_temp.avail22('zztest22t') = 30
      and mog.live_json('zztest22r', null) -> 'happySupply' -> 'heldVendors' = '["Transfer (Tysons)"]'::jsonb, null);

  -- ---- The item made inactive: the phone, Send and the close stop ----
  r := pg_temp.active22(tok, shrimp, false);
  perform pg_temp.chk('inactive: HQ''s save goes through with stores routed to it, and every route stays on its store''s item',
    (r ->> 'ok')::boolean and not (select active from mog.wh_products where id = shrimp)
      and (select count(*) from mog.items where wh_product = shrimp and wh_vendor is not null) = 2, r -> 'error');
  perform pg_temp.chk('inactive: neither phone counts on it, and Rosslyn''s vendor isn''t a held place''s',
    pg_temp.avail22('zztest22r') is null and pg_temp.avail22('zztest22t') is null
      and not coalesce(mog.live_json('zztest22r', null) -> 'happySupply' ? 'heldVendors', false), mog.live_json('zztest22r', null));
  r := public.mog_wh_send(ptokt, '{"vendor": "HS Co", "by": "Kim", "lines": [{"itemId": "ITEM-0091", "cases": 6}]}');
  perform pg_temp.chk('inactive: Send to Happy Supply is refused, writing nothing',
    r ->> 'error' like 'REJECTED: Happy Supply doesn''t sell SHRIMP now%'
      and not exists (select 1 from mog.wh_orders where slug = 'zztest22t'), r);
  r := public.mog_sync_close_cycle('zztest22r', kr, d0, d0 + 1, to_char(d0 + 1, 'Dy'), pg_temp.log22('Transfer (Tysons)', 4), '[]'::jsonb, null);
  perform pg_temp.chk('inactive: the close records no delivery from Tysons, and answers without heldError',
    (r ->> 'ok')::boolean and not (r -> 'data' ? 'heldError')
      and not exists (select 1 from mog.wh_orders where slug = 'zztest22r' and held_at = locT), r);

  -- ---- Active again: it records again; a delivery from before still checks in ----
  r := pg_temp.active22(tok, shrimp, true);
  r := public.mog_sync_close_cycle('zztest22r', kr, d0 + 1, d0 + 2, to_char(d0 + 2, 'Dy'), pg_temp.log22('Transfer (Tysons)', 4), '[]'::jsonb, null);
  select id into del1 from mog.wh_orders where slug = 'zztest22r' and held_at = locT and cycle_date = d0 + 1;
  perform pg_temp.chk('active again: the phone counts on Tysons and the close records the delivery, with no store change',
    (r ->> 'ok')::boolean and del1 is not null and pg_temp.avail22('zztest22t') = 30
      and (select jsonb_agg(jsonb_build_array(item_id, cases)) from mog.wh_order_lines where order_id = del1) = '[["ITEM-0091", 4]]'::jsonb, r);
  perform pg_temp.active22(tok, shrimp, false);
  r := public.mog_wh_received(public.mog_login('zztest22r', '4321') -> 'data' ->> 'token', jsonb_build_object('id', del1, 'by', 'Lee'));
  perform pg_temp.chk('inactive: a delivery recorded before still checks in and comes off Tysons (104 - 4)',
    (r ->> 'ok')::boolean and (select status from mog.wh_orders where id = del1) = 'received'
      and (select cases from mog.wh_stock where product_id = shrimp and location_id = locT) = 100, r);
  perform pg_temp.active22(tok, shrimp, true);

  -- ---- Tysons closed (counted to 0 first): the phone and the close stop ----
  r := public.mog_sync_close_cycle('zztest22r', kr, d0 + 2, d0 + 3, to_char(d0 + 3, 'Dy'), pg_temp.log22('Transfer (Tysons)', 3), '[]'::jsonb, null);
  select id into del2 from mog.wh_orders where slug = 'zztest22r' and held_at = locT and cycle_date = d0 + 2;
  perform public.mog_wh_count(tok, jsonb_build_object('locationId', locT, 'lines', jsonb_build_array(
    jsonb_build_object('productId', shrimp, 'cases', 0, 'reason', 'Moved out'))));
  r := pg_temp.open22(tok, locT, false);
  perform pg_temp.chk('closed: the place closes with a store routed to it; Rosslyn''s phone stops counting on it',
    (r ->> 'ok')::boolean and del2 is not null and not (select active from mog.wh_locations where id = locT)
      and pg_temp.avail22('zztest22r') is null and pg_temp.avail22('zztest22t') = 30, r -> 'error');
  perform mog.wh_held_from_log('zztest22r', d0 + 2);
  perform pg_temp.chk('closed: re-running the close''s step drops the delivery still open from it',
    not exists (select 1 from mog.wh_orders where id = del2), null);
  r := public.mog_sync_close_cycle('zztest22r', kr, d0 + 3, d0 + 4, to_char(d0 + 4, 'Dy'), pg_temp.log22('Transfer (Tysons)', 3), '[]'::jsonb, null);
  perform pg_temp.chk('closed: the close records nothing from it',
    (r ->> 'ok')::boolean and not (r -> 'data' ? 'heldError')
      and not exists (select 1 from mog.wh_orders where slug = 'zztest22r' and held_at = locT and cycle_date = d0 + 3), r);

  -- ---- Reopened: it records again ----
  perform pg_temp.open22(tok, locT, true);
  r := public.mog_sync_close_cycle('zztest22r', kr, d0 + 4, d0 + 5, to_char(d0 + 5, 'Dy'), pg_temp.log22('Transfer (Tysons)', 2), '[]'::jsonb, null);
  perform pg_temp.chk('reopened: the close records the delivery again, and the phone counts on Tysons (0)',
    (r ->> 'ok')::boolean and exists (select 1 from mog.wh_orders where slug = 'zztest22r' and held_at = locT and cycle_date = d0 + 4)
      and pg_temp.avail22('zztest22r') = 0, r);

  -- ---- HEH's own place closed: nothing available, Send refused ----
  perform public.mog_wh_count(tok, jsonb_build_object('locationId', locH, 'lines', jsonb_build_array(
    jsonb_build_object('productId', shrimp, 'cases', 0, 'reason', 'Moved out'))));
  perform pg_temp.open22(tok, locH, false);
  perform mog.wh_move(me, shrimp, locH, 12, 'count', null, null, 'found after closing');
  r := public.mog_wh_send(ptokt, '{"vendor": "HS Co", "by": "Kim", "lines": [{"itemId": "ITEM-0091", "cases": 6}]}');
  perform pg_temp.chk('own place closed: stock left there isn''t available, and Send is refused, writing nothing',
    pg_temp.avail22('zztest22t') = 0 and r ->> 'error' like 'REJECTED: SHRIMP isn''t kept at Happy Supply%'
      and not exists (select 1 from mog.wh_orders where slug = 'zztest22t'), r);
  perform pg_temp.open22(tok, locH, true);
  perform pg_temp.chk('own place reopened: its stock is available again (12)', pg_temp.avail22('zztest22t') = 12, null);

  perform pg_temp.clean22();
  perform pg_temp.chk('cleanup: nothing of the smoke is left',
    not exists (select 1 from mog.stores where slug in ('zztest22t', 'zztest22r'))
      and not exists (select 1 from mog.wh_orders where slug in ('zztest22t', 'zztest22r'))
      and not exists (select 1 from mog.wh_products where name like 'zz smoke 22 %')
      and not exists (select 1 from mog.wh_locations where name like 'zz smoke 22 %')
      and not exists (select 1 from mog.hq_users where name = 'zz smoke 22'), null);
end;
$$;

select n, case when ok then 'PASS' else 'FAIL' end as result, check_name, detail from mog_smoke22 order by n;
