-- =====================================================================
-- MOG on Supabase — schema v20   (run AFTER schema.sql and v2 to v19)
-- =====================================================================
-- W2c, HEH's stock at three places (docs/MOG_Warehouse_Spec.md §2, "W2c
-- design", approved by Sebastian 2026-11-04): Happy Supply (HEH's own),
-- RP Tysons (shrimp held at a store for itself, Rosslyn BOH and Founders
-- BOH) and Elpis (HEH's paper goods held at a vendor). A place is a
-- warehouse location with a kind; an item sits at one or more places, each
-- with a low point; the store's own vendor for an item decides which place
-- its order comes from. As in v13 to v19, the rules live HERE.
--
-- Adds:
--   * mog.wh_locations.held_store (the store a place sits at; it also needs
--     held_by, the name the other stores order it under) and count_how
--     ('hq', 'marginedge', 'report'; a label).
--   * mog.wh_product_places (product, place, low point): replaces a
--     product's single via, which stays (still saved, read as a fallback for
--     a product with no place yet). Filled once from via and the stock.
--   * mog.wh_order_lines.to_location: a Happy Supply line shipped to a store
--     that holds a place carrying the product is a move into that place, not
--     a sale (no price); its check-in puts the cases there.
--   * mog.wh_place_carries, mog.wh_item_place, mog.wh_available_at,
--     mog.wh_hs_receive, mog.wh_taken.
--   * mog_wh_taken(token, from, to): who took what (warehouse role), cases
--     only: deliveries and Happy Supply receipts per store and place, a
--     holder store's own use from its place's counts, moves between places.
--
-- Replaces (same signatures):
--   * mog.wh_held_from_log (from v17, the close's step): a held place's
--     deliveries by the place carrying the item, never from the store that
--     holds it. mog_sync_close_cycle itself is unchanged.
--   * mog.wh_available (from v17; a wrapper now), mog.wh_live_json (from
--     v17): each linked item's cases at its own source place.
--   * mog.wh_do_ship, mog_wh_received, mog_wh_send, mog.wh_order_json (from
--     v17), mog.wh_in_transit (from v13), mog.wh_do_save, mog.wh_state (from
--     v19), mog.wh_do_held_receive (from v17: HQ can also check in a Happy
--     Supply shipment into a place).
--
-- Rollback of the close's step: re-run mog.wh_held_from_log from
-- schema_v17.sql. Writes no store data; its one-time fill of
-- mog.wh_product_places runs only when the table is new, so re-running is
-- safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'mog' and table_name = 'wh_products' and column_name = 'concept') then
    raise exception 'Run schema_v19.sql first: mog.wh_products.concept is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

alter table mog.wh_locations add column if not exists held_store text references mog.stores (slug) on delete set null;
alter table mog.wh_locations add column if not exists count_how text
  check (count_how is null or count_how in ('hq', 'marginedge', 'report'));
alter table mog.wh_locations drop constraint if exists wh_locations_store_named;
alter table mog.wh_locations add constraint wh_locations_store_named check (held_store is null or held_by is not null);

alter table mog.wh_order_lines add column if not exists to_location bigint references mog.wh_locations (id);

-- Where each product sits, with the low point there. Filled once, when the
-- table is new: a product with a via at its holder's location, and every
-- product with no via wherever HEH's own locations hold a stock row; a par
-- becomes the low point when the product sits at one of HEH's own only.
do $$
begin
  if to_regclass('mog.wh_product_places') is null then
    create table mog.wh_product_places (
      product_id  bigint not null references mog.wh_products (id) on delete cascade,
      location_id bigint not null references mog.wh_locations (id) on delete cascade,
      low_point   numeric not null default 0 check (low_point >= 0),
      primary key (product_id, location_id)
    );
    insert into mog.wh_product_places (product_id, location_id)
    select p.id, l.id from mog.wh_products p join mog.wh_locations l on lower(l.held_by) = lower(p.via)
     where p.via is not null;
    insert into mog.wh_product_places (product_id, location_id)
    select distinct s.product_id, s.location_id
      from mog.wh_stock s join mog.wh_locations l on l.id = s.location_id join mog.wh_products p on p.id = s.product_id
     where l.held_by is null and p.via is null
    on conflict do nothing;
    update mog.wh_product_places pp set low_point = p.par
      from mog.wh_products p, mog.wh_locations l
     where p.id = pp.product_id and l.id = pp.location_id and l.held_by is null and p.par > 0
       and (select count(*) from mog.wh_product_places q join mog.wh_locations m on m.id = q.location_id
             where q.product_id = p.id and m.held_by is null) = 1;
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Internal: where an item comes from
-- ---------------------------------------------------------------------

-- A product sits at a place: a row in mog.wh_product_places, or (a product
-- with no place yet, from before v20) its via names the place's holder.
create or replace function mog.wh_place_carries(p_product bigint, p_location bigint)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from mog.wh_product_places pp where pp.product_id = p_product and pp.location_id = p_location)
      or exists (select 1 from mog.wh_products p join mog.wh_locations l on l.id = p_location
                  where p.id = p_product and l.held_by is not null and lower(p.via) = lower(l.held_by)
                    and not exists (select 1 from mog.wh_product_places q where q.product_id = p.id));
$$;

-- The held place a store's item is ordered from: one whose holder name the
-- store maps to that vendor (mog.hq_vendor_links) and that carries the
-- product, never one the store itself holds. Null = Happy Supply's own.
create or replace function mog.wh_item_place(p_slug text, p_vendor text, p_product bigint)
returns bigint
language sql stable
set search_path = ''
as $$
  select l.id from mog.wh_locations l
   where l.held_by is not null and l.held_store is distinct from p_slug
     and mog.wh_held_vendor(p_slug, l.held_by) = p_vendor and mog.wh_place_carries(p_product, l.id)
   order by l.id limit 1;
$$;

-- A product's cases a store can count on from one place. Null = Happy
-- Supply: HEH's own locations, minus what sent orders hold. A held place:
-- its cases, minus the deliveries from it no store has checked in. The
-- store's own order for p_cycle is left out. Never below 0.
create or replace function mog.wh_available_at(p_product bigint, p_place bigint, p_slug text, p_cycle date)
returns numeric
language sql stable
set search_path = ''
as $$
  select greatest(0, case when p_place is null then
      coalesce((select sum(s.cases) from mog.wh_stock s join mog.wh_locations l on l.id = s.location_id
                 where s.product_id = p_product and l.held_by is null), 0)
      - coalesce((select sum(x.cases) from mog.wh_order_lines x join mog.wh_orders o on o.id = x.order_id
                   where x.product_id = p_product and o.held_at is null and o.status = 'sent'
                     and not (o.slug = p_slug and o.cycle_date is not distinct from p_cycle)), 0)
    else
      coalesce((select s.cases from mog.wh_stock s where s.product_id = p_product and s.location_id = p_place), 0)
      - coalesce((select sum(x.cases) from mog.wh_order_lines x join mog.wh_orders o on o.id = x.order_id
                   where x.product_id = p_product and o.held_at = p_place and o.status = 'ordered'
                     and not (o.slug = p_slug and o.cycle_date is not distinct from p_cycle)), 0)
    end);
$$;

-- v17's signature, now from the place the store's item for it is ordered from.
create or replace function mog.wh_available(p_product bigint, p_slug text, p_cycle date)
returns numeric
language sql stable
set search_path = ''
as $$
  select mog.wh_available_at(p_product,
    (select mog.wh_item_place(p_slug, i.primary_vendor, p_product) from mog.items i
      where i.slug = p_slug and i.wh_product = p_product order by i.active desc, i.item_id limit 1),
    p_slug, p_cycle);
$$;

-- What's in transit (v13's transfers), plus Happy Supply lines shipped into
-- a place and not checked in yet (v20).
create or replace function mog.wh_in_transit(p_product bigint)
returns numeric
language sql stable
set search_path = ''
as $$
  select coalesce((select sum(l.cases)
                     from mog.wh_transfer_lines l join mog.wh_transfers t on t.id = l.transfer_id
                    where l.product_id = p_product and t.status = 'in_transit'), 0)
       + coalesce((select sum(x.cases_shipped)
                     from mog.wh_order_lines x join mog.wh_orders o on o.id = x.order_id
                    where x.product_id = p_product and x.to_location is not null and o.status = 'shipped'), 0);
$$;

-- v17's phone read, each linked item's cases from its own source place (v20).
create or replace function mog.wh_live_json(p_slug text)
returns jsonb
language sql stable
set search_path = ''
as $$
  with st as (select s.cycle_date from mog.store_state s where s.slug = p_slug),
  linked as (
    select i.item_id, i.wh_product, i.primary_vendor from mog.items i join mog.wh_products p on p.id = i.wh_product
     where i.slug = p_slug and i.active and p.active and (cardinality(p.stores) = 0 or p_slug = any (p.stores))),
  ords as (
    select o.id, o.sent_at from mog.wh_orders o
     where o.slug = p_slug
       and (o.status in ('sent', 'shipped', 'ordered') or o.cycle_date = (select cycle_date from st)
            or (o.held_at is not null and o.received_at > now() - interval '18 hours'))
     order by o.sent_at desc, o.id desc limit 10),
  held as (
    select distinct mog.wh_held_vendor(p_slug, l.held_by) as vendor from mog.wh_locations l where l.held_by is not null)
  select case when not exists (select 1 from linked) and not exists (select 1 from ords) then '{}'::jsonb
    else jsonb_build_object('happySupply', jsonb_build_object(
      'vendor', mog.wh_store_vendor(p_slug),
      'items', coalesce((
        select jsonb_object_agg(l.item_id, jsonb_build_object(
                 'productId', l.wh_product,
                 'available', mog.wh_available_at(l.wh_product, mog.wh_item_place(p_slug, l.primary_vendor, l.wh_product),
                                                  p_slug, (select cycle_date from st))))
          from linked l), '{}'::jsonb),
      'orders', coalesce((select jsonb_agg(mog.wh_order_phone_json(x.id) order by x.sent_at desc, x.id desc) from ords x),
                         '[]'::jsonb))
      || coalesce((select jsonb_build_object('heldVendors', jsonb_agg(h.vendor order by h.vendor))
                     from held h where h.vendor is not null having count(*) > 0), '{}'::jsonb))
  end;
$$;

-- ---------------------------------------------------------------------
-- Internal: the close, shipping and checking in
-- ---------------------------------------------------------------------

-- v17's close step: a held place's deliveries for the items it carries (v20),
-- never from the store that holds it.
create or replace function mog.wh_held_from_log(p_slug text, p_cycle date)
returns integer
language plpgsql volatile
set search_path = ''
as $$
declare
  h      record;
  v_vend text;
  v_id   bigint;
  v_st   text;
  v_n    integer;
  v_all  integer := 0;
begin
  for h in select w.id, w.held_by from mog.wh_locations w
            where w.held_by is not null and w.held_store is distinct from p_slug order by w.id loop
    v_vend := mog.wh_held_vendor(p_slug, h.held_by);
    select o.id, o.status into v_id, v_st from mog.wh_orders o
     where o.slug = p_slug and o.cycle_date = p_cycle and o.held_at = h.id for update;
    if v_st = 'received' then
      continue;
    end if;
    select count(*) into v_n
      from mog.order_log g
      join mog.items i on i.slug = g.slug and i.item_id = g.item_id
      join mog.wh_products p on p.id = i.wh_product
     where g.slug = p_slug and g.cycle_date = p_cycle and g.vendor = v_vend and mog.wh_place_carries(p.id, h.id);
    if v_n = 0 then
      if v_id is not null then
        delete from mog.wh_orders where id = v_id;
      end if;
      continue;
    end if;
    if v_id is null then
      insert into mog.wh_orders (number, slug, vendor, cycle_date, status, held_at)
      values (mog.wh_next_number('EL'), p_slug, v_vend, p_cycle, 'ordered', h.id)
      returning id into v_id;
    else
      delete from mog.wh_order_lines where order_id = v_id;
      update mog.wh_orders set vendor = v_vend, sent_at = now(), version = version + 1 where id = v_id;
    end if;
    insert into mog.wh_order_lines (order_id, ord, item_id, item_name, product_id, cases, location_id)
    select v_id, row_number() over (order by g.seq, g.id), g.item_id, coalesce(nullif(g.item_name, ''), i.name), p.id,
           g.qty_ordered, h.id
      from mog.order_log g
      join mog.items i on i.slug = g.slug and i.item_id = g.item_id
      join mog.wh_products p on p.id = i.wh_product
     where g.slug = p_slug and g.cycle_date = p_cycle and g.vendor = v_vend and mog.wh_place_carries(p.id, h.id);
    v_all := v_all + v_n;
  end loop;
  return v_all;
end;
$$;

-- v17's shipping, plus a line into the ordering store's own place (v20).
create or replace function mog.wh_do_ship(p_by text, p_s jsonb)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  o       mog.wh_orders%rowtype;
  x       mog.wh_order_lines%rowtype;
  v_set   mog.wh_settings%rowtype;
  v_lines jsonb;
  ln      jsonb;
  v_cases numeric;
  v_loc   bigint;
  v_to    bigint;
  v_sale  numeric := 0;
  v_total numeric := 0;
begin
  if p_s is null or jsonb_typeof(p_s) <> 'object' then
    raise exception 'REJECTED: a shipment is an object';
  end if;
  select * into o from mog.wh_orders where id = mog.wh_id(p_s -> 'id', 'The order') for update;
  if not found then
    raise exception 'REJECTED: that order isn''t there any more';
  end if;
  if o.version is distinct from (p_s ->> 'version')::bigint then
    raise exception 'CONFLICT: % changed since you opened it', o.number;
  end if;
  if o.status <> 'sent' then
    raise exception 'CONFLICT: % is % already', o.number, o.status;
  end if;
  v_lines := mog.wh_lines(p_s -> 'lines', 'The shipment', 200);
  perform mog.wh_lock_products(array(select distinct l.product_id from mog.wh_order_lines l where l.order_id = o.id));
  select * into v_set from mog.wh_settings where id;
  for x in select * from mog.wh_order_lines where order_id = o.id order by ord loop
    select e into ln from jsonb_array_elements(v_lines) e where e ->> 'ord' = x.ord::text;
    if ln is null then
      raise exception 'REJECTED: say how many cases of % ship (0 for none)', x.item_name;
    end if;
    v_cases := mog.wh_cases(ln -> 'cases', x.item_name, true);
    if v_cases > x.cases then
      raise exception 'REJECTED: % ordered %; ship at most that', x.item_name, mog.wh_cs(x.cases);
    end if;
    v_loc := null;
    -- v20: a store that holds a place carrying the product takes it into
    -- that place (RP Tysons' shrimp): a move between HEH's places, no price.
    v_to := (select l.id from mog.wh_locations l
              where l.held_store = o.slug and mog.wh_place_carries(x.product_id, l.id) order by l.id limit 1);
    if v_cases > 0 then
      v_loc := mog.wh_id(ln -> 'locationId', 'Where ' || x.item_name || ' ships from');
      if not exists (select 1 from mog.wh_locations l where l.id = v_loc and l.active) then
        raise exception 'REJECTED: that location isn''t open';
      end if;
      if exists (select 1 from mog.wh_locations l where l.id = v_loc and l.held_by is not null) then
        raise exception 'REJECTED: Happy Supply never ships from %: % holds it',
          (select l.name from mog.wh_locations l where l.id = v_loc), (select l.held_by from mog.wh_locations l where l.id = v_loc);
      end if;
      perform mog.wh_move(p_by, x.product_id, v_loc, -v_cases, case when v_to is null then 'shipped' else 'transfer_out' end,
                          o.number, null, null);
      v_total := v_total + v_cases;
      if v_to is null then
        v_sale := v_sale + v_cases;
      end if;
    end if;
    update mog.wh_order_lines l
       set cases_shipped = v_cases, location_id = v_loc, to_location = v_to, avg_cost = p.avg_cost,
           price = case when v_to is null then mog.wh_store_price(p.avg_cost, p.handling_fee, v_set.markup_pct) end
      from mog.wh_products p
     where p.id = l.product_id and l.order_id = o.id and l.ord = x.ord;
  end loop;
  if v_total = 0 then
    raise exception 'REJECTED: nothing ships; cancel the order instead';
  end if;
  update mog.wh_orders
     set status = 'shipped', shipped_at = now(), shipped_by = p_by,
         delivery_fee = case when v_sale > 0 then v_set.delivery_fee else 0 end, version = version + 1
   where id = o.id;
  return jsonb_build_object('orderId', o.id, 'number', o.number, 'cases', v_total);
end;
$$;

-- Check in a shipped Happy Supply order, its row locked by the caller: lines
-- [{ ord, cases }] (a line left out arrived as shipped; one can't be more).
-- A line shipped into a place (to_location, v20) puts what arrived there,
-- under the order's number.
create or replace function mog.wh_hs_receive(p_id bigint, p_by text, p_received_by text, p_lines jsonb)
returns void
language plpgsql volatile
set search_path = ''
as $$
declare
  o       mog.wh_orders%rowtype;
  x       mog.wh_order_lines%rowtype;
  ln      jsonb;
  v_lines jsonb := coalesce(p_lines, '[]'::jsonb);
  v_cases numeric;
begin
  select * into o from mog.wh_orders where id = p_id;
  if jsonb_typeof(v_lines) <> 'array' then
    raise exception 'REJECTED: the lines are a list';
  end if;
  if exists (select 1 from jsonb_array_elements(v_lines) e
              where not exists (select 1 from mog.wh_order_lines l where l.order_id = o.id and l.ord::text = e ->> 'ord')) then
    raise exception 'REJECTED: a line here isn''t in %', o.number;
  end if;
  perform mog.wh_lock_products(array(select distinct l.product_id from mog.wh_order_lines l
                                       where l.order_id = o.id and l.to_location is not null));
  for x in select * from mog.wh_order_lines where order_id = o.id order by ord loop
    select e into ln from jsonb_array_elements(v_lines) e where e ->> 'ord' = x.ord::text;
    v_cases := case when ln is null then coalesce(x.cases_shipped, 0)
                    else mog.wh_cases(ln -> 'cases', x.item_name, true) end;
    if v_cases > coalesce(x.cases_shipped, 0) then
      raise exception 'REJECTED: % shipped %; it can''t arrive more', x.item_name, mog.wh_cs(coalesce(x.cases_shipped, 0));
    end if;
    if x.to_location is not null and v_cases > 0 then
      perform mog.wh_move(p_by, x.product_id, x.to_location, v_cases, 'transfer_in', o.number, null, null);
    end if;
    update mog.wh_order_lines set cases_received = v_cases where order_id = o.id and ord = x.ord;
  end loop;
  update mog.wh_orders
     set status = 'received', received_at = now(), received_by = p_received_by, version = version + 1
   where id = o.id;
end;
$$;

-- HQ checks in for a store (one nobody checked in): { id, version, lines:
-- [{ ord, cases }] }. A delivery from a held place (v17), or a Happy Supply
-- order shipped into a place (v20: RP Tysons' shrimp). A plain Happy Supply
-- sale stays the store's to check in. The store's card then shows it
-- received by "HQ · <name>".
create or replace function mog.wh_do_held_receive(p_by text, p_r jsonb)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  o mog.wh_orders%rowtype;
begin
  if p_r is null or jsonb_typeof(p_r) <> 'object' then
    raise exception 'REJECTED: a receipt is an object';
  end if;
  select * into o from mog.wh_orders where id = mog.wh_id(p_r -> 'id', 'The delivery') for update;
  if not found or (o.held_at is null and not exists (select 1 from mog.wh_order_lines l
                                                      where l.order_id = o.id and l.to_location is not null)) then
    raise exception 'REJECTED: that delivery isn''t there any more';
  end if;
  if o.version is distinct from (p_r ->> 'version')::bigint then
    raise exception 'CONFLICT: % changed since you opened it', o.number;
  end if;
  if o.held_at is not null then
    if o.status <> 'ordered' then
      raise exception 'CONFLICT: % is % already', o.number, o.status;
    end if;
    perform mog.wh_held_receive(o.id, p_by, left('HQ · ' || p_by, 40), p_r -> 'lines');
  else
    if o.status <> 'shipped' then
      raise exception 'CONFLICT: % is % already', o.number, o.status;
    end if;
    perform mog.wh_hs_receive(o.id, p_by, left('HQ · ' || p_by, 40), p_r -> 'lines');
  end if;
  return jsonb_build_object('orderId', o.id, 'number', o.number);
end;
$$;

-- v17's order as HQ reads it, plus a line's place it moves into (v20).
create or replace function mog.wh_order_json(p_id bigint)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'slug', o.slug, 'store', s.location, 'concept', coalesce(s.concept, ''),
    'isTest', s.is_test, 'vendor', o.vendor, 'cycleDate', o.cycle_date, 'neededBy', o.needed_by, 'note', o.note,
    'status', o.status, 'sentAt', o.sent_at, 'sentBy', o.sent_by, 'shippedAt', o.shipped_at, 'shippedBy', o.shipped_by,
    'deliveryFee', o.delivery_fee, 'receivedAt', o.received_at, 'receivedBy', o.received_by,
    'cancelledAt', o.cancelled_at, 'cancelledBy', o.cancelled_by, 'version', o.version,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'ord', x.ord, 'itemId', x.item_id, 'name', x.item_name, 'productId', x.product_id, 'product', p.name,
               'pack', p.pack, 'cases', x.cases, 'casesShipped', x.cases_shipped, 'locationId', x.location_id,
               'location', l.name, 'price', x.price, 'avgCost', x.avg_cost, 'casesReceived', x.cases_received)
               || case when x.beyond is null then '{}'::jsonb else jsonb_build_object('beyond', x.beyond) end
               || case when x.to_location is null then '{}'::jsonb
                       else jsonb_build_object('toLocation', x.to_location, 'to', (select t.name from mog.wh_locations t where t.id = x.to_location)) end
             order by x.ord)
        from mog.wh_order_lines x
        join mog.wh_products p on p.id = x.product_id
        left join mog.wh_locations l on l.id = x.location_id
       where x.order_id = o.id), '[]'::jsonb))
    || case when o.held_at is null then '{}'::jsonb else jsonb_build_object('heldAt', o.held_at) end
    from mog.wh_orders o join mog.stores s on s.slug = o.slug
   where o.id = p_id;
$$;

-- ---------------------------------------------------------------------
-- The save and the read, from v19
-- ---------------------------------------------------------------------

-- v19's save, plus (v20) a product's places with their low points and a
-- location's heldStore and countHow.
create or replace function mog.wh_do_save(p_by text, p_kind text, p_row jsonb)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v_id     bigint;
  v_name   text;
  v_pack   text;
  v_par    numeric;
  v_fee    numeric;
  v_pct    numeric;
  v_active boolean;
  v_stores text[];
  v_have   bigint;
  v_last   text;
  v_ord    integer;
  v_held   numeric;
  v_via    text;
  v_set    boolean;
  v_holder text;
  v_concept text;
  v_cset boolean;
  v_pset   boolean;
  v_places jsonb;
  pl       jsonb;
  v_loc    bigint;
  v_low    numeric;
  v_seen   bigint[] := '{}';
  v_sset   boolean;
  v_store  text;
  v_hset   boolean;
  v_how    text;
begin
  if jsonb_typeof(p_row) is distinct from 'object' then
    raise exception 'REJECTED: nothing to save';
  end if;
  v_id := case when p_row -> 'id' is null or jsonb_typeof(p_row -> 'id') = 'null' then null else mog.wh_id(p_row -> 'id', 'The id') end;

  if p_kind = 'product' then
    v_name := mog.wh_name(p_row -> 'name', 'The product', 120);
    v_pack := mog.wh_text(p_row -> 'pack', 'The pack', 60);
    v_par := mog.wh_cases(p_row -> 'par', 'The par', true);
    v_fee := mog.wh_money(p_row -> 'handlingFee', 'The handling fee');
    v_active := mog.wh_bool(p_row -> 'active', 'Active', true);
    if p_row -> 'stores' is not null and jsonb_typeof(p_row -> 'stores') <> 'array' then
      raise exception 'REJECTED: the stores are a list';
    end if;
    select coalesce(array_agg(distinct x order by x), '{}') into v_stores
      from jsonb_array_elements_text(coalesce(p_row -> 'stores', '[]'::jsonb)) x;
    if exists (select 1 from unnest(v_stores) x where not exists (select 1 from mog.stores s where s.slug = x)) then
      raise exception 'REJECTED: no store called %',
        (select x from unnest(v_stores) x where not exists (select 1 from mog.stores s where s.slug = x) limit 1);
    end if;
    v_set := p_row ? 'via';
    if v_set then
      v_via := nullif(btrim(coalesce(p_row ->> 'via', '')), '');
      if lower(v_via) = 'happy supply' then
        v_via := null;
      end if;
      if v_via is not null then
        select l.held_by into v_holder from mog.wh_locations l where lower(l.held_by) = lower(v_via);
        if v_holder is null then
          raise exception 'REJECTED: no location is held by %', v_via;
        end if;
        v_via := v_holder;
      end if;
    end if;
    -- v19: the concept whose stores carry it (null = every concept); left
    -- out = unchanged.
    v_cset := p_row ? 'concept';
    if v_cset then
      v_concept := nullif(btrim(coalesce(p_row ->> 'concept', '')), '');
      if v_concept is not null and not exists (select 1 from mog.stores s where s.concept = v_concept) then
        raise exception 'REJECTED: no store is in the concept %', v_concept;
      end if;
    end if;
    -- v20: the places it sits at, each with a low point: [{ locationId,
    -- lowPoint? }] (left out = unchanged, [] = none).
    v_pset := p_row ? 'places';
    if v_pset then
      v_places := p_row -> 'places';
      if jsonb_typeof(v_places) is distinct from 'array' then
        raise exception 'REJECTED: the places are a list';
      end if;
      if jsonb_array_length(v_places) > 50 then
        raise exception 'REJECTED: a product sits at 50 places at most';
      end if;
      if exists (select 1 from jsonb_array_elements(v_places) e where jsonb_typeof(e) <> 'object') then
        raise exception 'REJECTED: the places have one that isn''t a place';
      end if;
    end if;
    if exists (select 1 from mog.wh_products p where lower(p.name) = lower(v_name) and p.id is distinct from v_id) then
      raise exception 'REJECTED: there''s already a product called "%"', v_name;
    end if;
    if v_id is null then
      insert into mog.wh_products (name, pack, par, handling_fee, stores, active, via, concept, updated_by)
      values (v_name, v_pack, v_par, v_fee, v_stores, v_active, v_via, v_concept, p_by) returning id into v_id;
    else
      select p.version, p.updated_by into v_have, v_last from mog.wh_products p where p.id = v_id for update;
      if v_have is null then
        raise exception 'REJECTED: that product isn''t in the warehouse any more';
      end if;
      if v_have <> mog.wh_num(p_row -> 'version', 'The version') then
        raise exception 'CONFLICT: % was changed since you opened it (by %)', v_name, coalesce(v_last, 'someone');
      end if;
      if v_set and lower(coalesce(v_via, '')) <> lower(coalesce((select p.via from mog.wh_products p where p.id = v_id), '')) then
        if mog.wh_owned(v_id) > 0 or exists (select 1 from mog.wh_order_lines x join mog.wh_orders o on o.id = x.order_id
                                              where x.product_id = v_id and o.status in ('sent', 'ordered')) then
          raise exception 'REJECTED: % has stock or open orders: count it to 0 before changing where stores order it', v_name;
        end if;
      end if;
      update mog.wh_products
         set name = v_name, pack = v_pack, par = v_par, handling_fee = v_fee, stores = v_stores, active = v_active,
             via = case when v_set then v_via else via end,
             concept = case when v_cset then v_concept else concept end,
             version = version + 1, updated_at = now(), updated_by = p_by
       where id = v_id;
    end if;
    -- v20: a via also places the product at that holder's location.
    if v_set and v_via is not null then
      insert into mog.wh_product_places (product_id, location_id)
      select v_id, l.id from mog.wh_locations l where lower(l.held_by) = lower(v_via)
      on conflict do nothing;
    end if;
    if v_pset then
      for pl in select e from jsonb_array_elements(v_places) e loop
        v_loc := mog.wh_id(pl -> 'locationId', 'A place');
        if not exists (select 1 from mog.wh_locations l where l.id = v_loc) then
          raise exception 'REJECTED: pick a place from the list';
        end if;
        if v_loc = any (v_seen) then
          raise exception 'REJECTED: % is in the places twice', (select l.name from mog.wh_locations l where l.id = v_loc);
        end if;
        v_seen := v_seen || v_loc;
        v_low := case when pl ? 'lowPoint'
                      then mog.wh_cases(pl -> 'lowPoint', 'The low point at ' || (select l.name from mog.wh_locations l where l.id = v_loc), true)
                      else 0 end;
        insert into mog.wh_product_places (product_id, location_id, low_point) values (v_id, v_loc, v_low)
        on conflict (product_id, location_id) do update set low_point = excluded.low_point;
      end loop;
      select l.name into v_last
        from mog.wh_product_places pp join mog.wh_locations l on l.id = pp.location_id
       where pp.product_id = v_id and not (pp.location_id = any (v_seen))
         and (coalesce((select s.cases from mog.wh_stock s where s.product_id = v_id and s.location_id = pp.location_id), 0) > 0
              or exists (select 1 from mog.wh_order_lines x join mog.wh_orders o on o.id = x.order_id
                          where x.product_id = v_id and o.held_at = pp.location_id and o.status = 'ordered'))
       order by l.name limit 1;
      if v_last is not null then
        raise exception 'REJECTED: % has stock or open deliveries at %: count it to 0 there first', v_name, v_last;
      end if;
      delete from mog.wh_product_places pp where pp.product_id = v_id and not (pp.location_id = any (v_seen));
    end if;
    return jsonb_build_object('kind', 'product', 'id', v_id, 'name', v_name);
  end if;

  if p_kind = 'location' or p_kind = 'supplier' then
    v_name := mog.wh_name(p_row -> 'name', case when p_kind = 'location' then 'The location' else 'The supplier' end, 60);
    v_active := mog.wh_bool(p_row -> 'active', 'Active', true);
  end if;

  if p_kind = 'location' then
    -- v20: the store a place sits at (heldStore; it also needs heldBy, the
    -- name the other stores order it under) and how it's counted (countHow).
    -- Left out = unchanged.
    v_sset := p_row ? 'heldStore';
    if v_sset then
      v_store := nullif(btrim(coalesce(p_row ->> 'heldStore', '')), '');
      if v_store is not null and not exists (select 1 from mog.stores s where s.slug = v_store) then
        raise exception 'REJECTED: no store called %', v_store;
      end if;
    end if;
    v_hset := p_row ? 'countHow';
    if v_hset then
      v_how := nullif(btrim(coalesce(p_row ->> 'countHow', '')), '');
      if v_how is not null and v_how not in ('hq', 'marginedge', 'report') then
        raise exception 'REJECTED: a place is counted in HQ, from MarginEdge or from a report';
      end if;
    end if;
    if exists (select 1 from mog.wh_locations l where lower(l.name) = lower(v_name) and l.id is distinct from v_id) then
      raise exception 'REJECTED: there''s already a location called "%"', v_name;
    end if;
    if p_row -> 'ord' is not null and jsonb_typeof(p_row -> 'ord') <> 'null' then
      v_ord := mog.wh_num(p_row -> 'ord', 'The order')::integer;
    end if;
    v_set := p_row ? 'heldBy';
    if v_set then
      v_holder := nullif(btrim(coalesce(p_row ->> 'heldBy', '')), '');
      if length(v_holder) > 100 then
        raise exception 'REJECTED: who holds it is longer than 100 characters';
      end if;
      if lower(v_holder) = 'happy supply' then
        raise exception 'REJECTED: Happy Supply''s own locations aren''t held by a vendor';
      end if;
      if exists (select 1 from mog.wh_locations l where lower(l.held_by) = lower(v_holder) and l.id is distinct from v_id) then
        raise exception 'REJECTED: % is held by % already',
          (select l.name from mog.wh_locations l where lower(l.held_by) = lower(v_holder) and l.id is distinct from v_id), v_holder;
      end if;
    end if;
    if (case when v_sset then v_store else (select l.held_store from mog.wh_locations l where l.id = v_id) end) is not null
       and (case when v_set then v_holder else (select l.held_by from mog.wh_locations l where l.id = v_id) end) is null then
      raise exception 'REJECTED: a place at a store needs the name the other stores order it under';
    end if;
    if v_id is null then
      insert into mog.wh_locations (name, ord, active, held_by, held_store, count_how)
      values (v_name, coalesce(v_ord, (select coalesce(max(l.ord), 0) + 10 from mog.wh_locations l)), v_active, v_holder, v_store, v_how)
      returning id into v_id;
    else
      perform 1 from mog.wh_locations l where l.id = v_id for update;
      if not found then
        raise exception 'REJECTED: that location isn''t in the warehouse any more';
      end if;
      if not v_active then
        select coalesce(sum(s.cases), 0) into v_held from mog.wh_stock s where s.location_id = v_id;
        if v_held > 0 then
          raise exception 'REJECTED: % still holds %: move it or count it to 0 first', v_name, mog.wh_cs(v_held);
        end if;
      end if;
      if v_set and lower(coalesce(v_holder, '')) <> lower(coalesce((select l.held_by from mog.wh_locations l where l.id = v_id), '')) then
        if exists (select 1 from mog.wh_stock s where s.location_id = v_id and s.cases > 0)
           or exists (select 1 from mog.wh_products p join mog.wh_locations l on lower(l.held_by) = lower(p.via) where l.id = v_id)
           or exists (select 1 from mog.wh_product_places pp where pp.location_id = v_id) then
          raise exception 'REJECTED: % holds stock or has products ordered through it: who holds it can''t change', v_name;
        end if;
      end if;
      if v_sset and v_store is distinct from (select l.held_store from mog.wh_locations l where l.id = v_id)
         and exists (select 1 from mog.wh_stock s where s.location_id = v_id and s.cases > 0) then
        raise exception 'REJECTED: % holds stock: the store it sits at can''t change', v_name;
      end if;
      update mog.wh_locations set name = v_name, ord = coalesce(v_ord, ord), active = v_active,
             held_by = case when v_set then v_holder else held_by end,
             held_store = case when v_sset then v_store else held_store end,
             count_how = case when v_hset then v_how else count_how end where id = v_id;
    end if;
    return jsonb_build_object('kind', 'location', 'id', v_id, 'name', v_name);
  end if;

  if p_kind = 'supplier' then
    if exists (select 1 from mog.wh_suppliers s where lower(s.name) = lower(v_name) and s.id is distinct from v_id) then
      raise exception 'REJECTED: there''s already a supplier called "%"', v_name;
    end if;
    if v_id is null then
      insert into mog.wh_suppliers (name, active) values (v_name, v_active) returning id into v_id;
    else
      update mog.wh_suppliers set name = v_name, active = v_active where id = v_id;
      if not found then
        raise exception 'REJECTED: that supplier isn''t in the warehouse any more';
      end if;
    end if;
    return jsonb_build_object('kind', 'supplier', 'id', v_id, 'name', v_name);
  end if;

  if p_kind = 'settings' then
    v_pct := round(mog.wh_num(p_row -> 'markupPct', 'The markup'), 2);
    if v_pct < 0 or v_pct > 100 then
      raise exception 'REJECTED: the markup is from 0 to 100%%';
    end if;
    v_fee := mog.wh_money(p_row -> 'deliveryFee', 'The delivery fee');
    select w.version, w.updated_by into v_have, v_last from mog.wh_settings w where w.id for update;
    if v_have <> mog.wh_num(p_row -> 'version', 'The version') then
      raise exception 'CONFLICT: the settings were changed since you opened them (by %)', coalesce(v_last, 'someone');
    end if;
    update mog.wh_settings set markup_pct = v_pct, delivery_fee = v_fee, version = version + 1, updated_at = now(), updated_by = p_by
     where id;
    return jsonb_build_object('kind', 'settings');
  end if;

  raise exception 'REJECTED: nothing called % to save', coalesce(p_kind, '(none)');
end;
$$;

-- v19's read, plus (v20) a location's heldStore, store, countHow and
-- lastCount (HEH's own too), and a product's places, each only when set.
create or replace function mog.wh_state(p_name text)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'name', p_name,
    'roles', (select to_jsonb(u.roles) from mog.hq_users u where u.name = p_name),
    'settings', (select jsonb_build_object('markupPct', w.markup_pct, 'deliveryFee', w.delivery_fee, 'version', w.version,
                                           'updatedAt', w.updated_at, 'updatedBy', w.updated_by)
                   from mog.wh_settings w where w.id),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'ord', l.ord, 'active', l.active)
                                            || case when l.held_by is null then '{}'::jsonb
                                                    else jsonb_build_object('heldBy', l.held_by, 'lastCount',
                                                           (select max(m.at) from mog.wh_moves m
                                                             where m.location_id = l.id and m.kind = 'count' and m.ref is null)) end
                                            || case when l.held_store is null then '{}'::jsonb
                                                    else jsonb_build_object('heldStore', l.held_store, 'store',
                                                           (select coalesce(s.location, s.slug) from mog.stores s where s.slug = l.held_store)) end
                                            || case when l.count_how is null then '{}'::jsonb else jsonb_build_object('countHow', l.count_how) end
                                            || case when l.held_by is not null then '{}'::jsonb
                                                    else coalesce((select jsonb_build_object('lastCount', max(m.at)) from mog.wh_moves m
                                                                    where m.location_id = l.id and m.kind = 'count' and m.ref is null
                                                                   having max(m.at) is not null), '{}'::jsonb) end
                                            order by l.ord, lower(l.name))
                             from mog.wh_locations l), '[]'::jsonb),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'active', s.active) order by lower(s.name))
                             from mog.wh_suppliers s), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'pack', p.pack, 'par', p.par, 'avgCost', p.avg_cost,
               'handlingFee', p.handling_fee, 'stores', to_jsonb(p.stores), 'active', p.active, 'version', p.version,
               'updatedAt', p.updated_at, 'updatedBy', p.updated_by,
               'stock', coalesce((select jsonb_object_agg(s.location_id::text, s.cases)
                                    from mog.wh_stock s where s.product_id = p.id and s.cases <> 0), '{}'::jsonb),
               'inTransit', mog.wh_in_transit(p.id),
               'lastReceipt', (select jsonb_build_object('ref', m.ref, 'at', m.at) from mog.wh_moves m
                                where m.product_id = p.id and m.kind = 'received' order by m.id desc limit 1))
             || case when p.via is null then '{}'::jsonb else jsonb_build_object('via', p.via) end
             || case when p.concept is null then '{}'::jsonb else jsonb_build_object('concept', p.concept) end
             || coalesce((select jsonb_build_object('places', jsonb_agg(jsonb_build_object('locationId', pp.location_id, 'lowPoint', pp.low_point)
                                                                   order by pp.location_id))
                            from mog.wh_product_places pp where pp.product_id = p.id having count(*) > 0), '{}'::jsonb)
             order by lower(p.name))
        from mog.wh_products p), '[]'::jsonb),
    'pos', coalesce((
      select jsonb_agg(mog.wh_po_json(x.id) order by x.id desc)
        from (select id from mog.wh_pos where status = 'ordered'
              union all
              (select id from mog.wh_pos where status <> 'ordered' order by id desc limit 30)) x), '[]'::jsonb),
    'transfers', coalesce((
      select jsonb_agg(mog.wh_transfer_json(x.id) order by x.id desc)
        from (select id from mog.wh_transfers where status = 'in_transit'
              union all
              (select id from mog.wh_transfers where status <> 'in_transit' order by id desc limit 30)) x), '[]'::jsonb),
    'orders', mog.wh_orders_json(),
    'deliveries', mog.wh_deliveries_json(),
    'vendorNames', coalesce((
      select jsonb_agg(x.name order by lower(x.name), x.name)
        from (select distinct on (lower(y.name)) y.name
                from (select k.hq_name as name from mog.hq_vendor_links k
                      union all
                      select v.name from mog.vendors v join mog.stores s on s.slug = v.slug where not s.is_test) y
               order by lower(y.name), y.name) x), '[]'::jsonb),
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object('slug', s.slug, 'location', s.location, 'concept', coalesce(s.concept, ''),
                                          'side', s.side, 'isTest', s.is_test)
                       order by coalesce(s.concept, ''), s.is_test, s.location, s.slug)
        from mog.stores s), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------
-- Public: the store's phone (its PIN session)
-- ---------------------------------------------------------------------

-- v17's send, plus a product kept only at places other than HEH's own (v20).
create or replace function public.mog_wh_send(p_token text, p_order jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v       jsonb := mog.phone_session(p_token);
  v_slug  text;
  v_vend  text;
  v_cycle date;
  v_need  date;
  v_note  text;
  v_by    text;
  v_lines jsonb;
  v_id    bigint;
  v_n     integer := 0;
  ln      jsonb;
  it      mog.items%rowtype;
  pr      mog.wh_products%rowtype;
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  v_slug := v ->> 'slug';
  begin
    if p_order is null or jsonb_typeof(p_order) <> 'object' then
      raise exception 'REJECTED: an order is an object';
    end if;
    perform 1 from mog.stores s where s.slug = v_slug for update;      -- one send at a time per store
    v_vend := mog.wh_store_vendor(v_slug);
    if v_vend is null or v_vend is distinct from p_order ->> 'vendor' then
      raise exception 'REJECTED: % isn''t this store''s Happy Supply', coalesce(p_order ->> 'vendor', 'That vendor');
    end if;
    select s.cycle_date into v_cycle from mog.store_state s where s.slug = v_slug;
    if v_cycle is null then
      raise exception 'REJECTED: this store has no order day open';
    end if;
    if coalesce(p_order ->> 'neededBy', '') !~ '^(\d{4}-\d{2}-\d{2})?$' then
      raise exception 'REJECTED: needed by is a date';
    end if;
    v_need := nullif(p_order ->> 'neededBy', '')::date;
    if v_need < v_cycle then
      raise exception 'REJECTED: needed by is before the order day';
    end if;
    v_note := mog.wh_text(p_order -> 'note', 'The note', 300);
    v_by := nullif(left(mog.wh_text(p_order -> 'by', 'The name', 200), 40), '');
    v_lines := mog.wh_lines(p_order -> 'lines', 'The order', 200);

    select o.id into v_id from mog.wh_orders o
     where o.slug = v_slug and o.cycle_date = v_cycle and o.status = 'sent' for update;
    if v_id is null then
      insert into mog.wh_orders (number, slug, vendor, cycle_date, needed_by, note, sent_by)
      values (mog.wh_next_number('HS'), v_slug, v_vend, v_cycle, v_need, v_note, v_by)
      returning id into v_id;
    else
      delete from mog.wh_order_lines where order_id = v_id;
      update mog.wh_orders
         set vendor = v_vend, needed_by = v_need, note = v_note, sent_by = v_by, sent_at = now(), version = version + 1
       where id = v_id;
    end if;

    for ln in select e from jsonb_array_elements(v_lines) e loop
      select * into it from mog.items i where i.slug = v_slug and i.item_id = ln ->> 'itemId';
      if not found then
        raise exception 'REJECTED: an item in this order isn''t at the store any more';
      end if;
      if it.wh_product is null then
        raise exception 'REJECTED: % isn''t linked to a Happy Supply product', it.name;
      end if;
      if not it.active or not (it.primary_vendor = v_vend or v_vend = any (it.eligible_vendors)) then
        raise exception 'REJECTED: % isn''t on Happy Supply''s list here', it.name;
      end if;
      select * into pr from mog.wh_products p where p.id = it.wh_product;
      if pr.via is not null then
        raise exception 'REJECTED: % comes from %, not Happy Supply', it.name, pr.via;
      end if;
      -- v20: a product kept only at places other than HEH's own isn't Happy Supply's.
      if exists (select 1 from mog.wh_product_places pp where pp.product_id = pr.id)
         and not exists (select 1 from mog.wh_product_places pp join mog.wh_locations l on l.id = pp.location_id
                          where pp.product_id = pr.id and l.held_by is null) then
        raise exception 'REJECTED: % isn''t kept at Happy Supply', it.name;
      end if;
      if not pr.active or not (cardinality(pr.stores) = 0 or v_slug = any (pr.stores)) then
        raise exception 'REJECTED: Happy Supply doesn''t sell % to this store', it.name;
      end if;
      if exists (select 1 from mog.wh_order_lines l where l.order_id = v_id and l.item_id = it.item_id) then
        raise exception 'REJECTED: % is in the order twice', it.name;
      end if;
      v_n := v_n + 1;
      insert into mog.wh_order_lines (order_id, ord, item_id, item_name, product_id, cases)
      values (v_id, v_n, it.item_id, it.name, it.wh_product, mog.wh_cases(ln -> 'cases', it.name, false));
    end loop;
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'data',
    jsonb_build_object('order', mog.wh_order_phone_json(v_id)) || mog.wh_live_json(v_slug));
end;
$$;

-- v17's receipt; a Happy Supply order through mog.wh_hs_receive (v20).
create or replace function public.mog_wh_received(p_token text, p_receipt jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v       jsonb := mog.phone_session(p_token);
  v_slug  text;
  o       mog.wh_orders%rowtype;
  v_by    text;
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  v_slug := v ->> 'slug';
  begin
    if p_receipt is null or jsonb_typeof(p_receipt) <> 'object' then
      raise exception 'REJECTED: a receipt is an object';
    end if;
    select * into o from mog.wh_orders
     where id = mog.wh_id(p_receipt -> 'id', 'The order') and slug = v_slug for update;
    if not found then
      raise exception 'REJECTED: that order isn''t this store''s';
    end if;
    v_by := nullif(left(mog.wh_text(p_receipt -> 'by', 'The name', 200), 40), '');
    if o.held_at is not null then
      if o.status = 'ordered' then
        perform mog.wh_held_receive(o.id,
          coalesce((select s.location from mog.stores s where s.slug = v_slug), v_slug) || coalesce(' · ' || v_by, ''),
          v_by, p_receipt -> 'lines');
      end if;
    elsif o.status <> 'received' then
      if o.status <> 'shipped' then
        raise exception 'REJECTED: % is %, not shipped', o.number, o.status;
      end if;
      perform mog.wh_hs_receive(o.id,
        coalesce((select s.location from mog.stores s where s.slug = v_slug), v_slug) || coalesce(' · ' || v_by, ''),
        v_by, p_receipt -> 'lines');
    end if;
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'data',
    jsonb_build_object('order', mog.wh_order_phone_json(o.id)) || mog.wh_live_json(v_slug));
end;
$$;

-- ---------------------------------------------------------------------
-- Who took what (v20): cases only
-- ---------------------------------------------------------------------

-- The days after p_from through p_to (America/New_York): what each store
-- took from each place (deliveries and Happy Supply orders checked in), a
-- holder store's own use at its place (minus the real counts' adjustments
-- there: the count says what's left after it used some; an opening count,
-- with nothing on record before it, isn't use), and what moved
-- between HEH's places (Happy Supply shipments checked in at a place).
create or replace function mog.wh_taken(p_from date, p_to date)
returns jsonb
language sql stable
set search_path = ''
as $$
  with win as (select ((p_from + 1)::timestamp at time zone 'America/New_York') as a,
                      ((p_to + 1)::timestamp at time zone 'America/New_York') as b),
  got as (
    select o.slug, coalesce(o.held_at, x.location_id) as place, x.product_id,
           sum(x.cases_received) as cases, count(distinct o.id) as n
      from mog.wh_orders o join mog.wh_order_lines x on x.order_id = o.id cross join win
     where o.status = 'received' and o.received_at >= win.a and o.received_at < win.b
       and x.to_location is null and coalesce(x.cases_received, 0) > 0
     group by 1, 2, 3),
  used as (
    select l.held_store as slug, m.location_id as place, m.product_id, -sum(m.cases) as cases, count(*) as n
      from mog.wh_moves m join mog.wh_locations l on l.id = m.location_id cross join win
     where l.held_store is not null and m.kind = 'count' and m.ref is null and m.at >= win.a and m.at < win.b
       and exists (select 1 from mog.wh_moves q            -- an opening count (nothing on record before) isn't use
                    where q.product_id = m.product_id and q.location_id = m.location_id and q.id < m.id)
     group by 1, 2, 3),
  moved as (
    select x.location_id as from_place, x.to_location as place, x.product_id,
           sum(x.cases_received) as cases, count(distinct o.id) as n
      from mog.wh_orders o join mog.wh_order_lines x on x.order_id = o.id cross join win
     where o.status = 'received' and o.received_at >= win.a and o.received_at < win.b
       and x.to_location is not null and coalesce(x.cases_received, 0) > 0
     group by 1, 2, 3)
  select jsonb_build_object('from', p_from, 'to', p_to,
    'taken', coalesce((
      select jsonb_agg(jsonb_build_object('slug', g.slug, 'store', coalesce(s.location, g.slug), 'isTest', s.is_test,
                                          'placeId', g.place, 'place', l.name, 'productId', g.product_id, 'product', p.name,
                                          'pack', p.pack, 'cases', g.cases, 'deliveries', g.n)
                       order by s.is_test, s.location, l.name, p.name)
        from got g join mog.stores s on s.slug = g.slug join mog.wh_products p on p.id = g.product_id
        left join mog.wh_locations l on l.id = g.place), '[]'::jsonb),
    'used', coalesce((
      select jsonb_agg(jsonb_build_object('slug', u.slug, 'store', coalesce(s.location, u.slug), 'isTest', s.is_test,
                                          'placeId', u.place, 'place', l.name, 'productId', u.product_id, 'product', p.name,
                                          'pack', p.pack, 'cases', u.cases, 'counts', u.n)
                       order by s.is_test, s.location, l.name, p.name)
        from used u join mog.stores s on s.slug = u.slug join mog.wh_products p on p.id = u.product_id
        join mog.wh_locations l on l.id = u.place), '[]'::jsonb),
    'moved', coalesce((
      select jsonb_agg(jsonb_build_object('fromId', v.from_place, 'from', f.name, 'placeId', v.place, 'place', l.name,
                                          'productId', v.product_id, 'product', p.name, 'pack', p.pack,
                                          'cases', v.cases, 'shipments', v.n)
                       order by l.name, p.name)
        from moved v join mog.wh_products p on p.id = v.product_id join mog.wh_locations l on l.id = v.place
        left join mog.wh_locations f on f.id = v.from_place), '[]'::jsonb));
$$;

-- Who took what, for the warehouse role: p_from (not included) to p_to,
-- at most 93 days.
create or replace function public.mog_wh_taken(p_token text, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_name text := mog.wh_session(p_token);
begin
  if v_name is null then
    return mog.wh_refusal(p_token);
  end if;
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > 93 then
    return mog.wh_error('REJECTED: pick a span of 1 to 93 days');
  end if;
  return jsonb_build_object('ok', true, 'data', mog.wh_taken(p_from, p_to));
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: lock the new table and internals, open exactly the entry
-- points.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_wh_taken(text, date, date)',
    'public.mog_wh_received(text, jsonb)',
    'public.mog_wh_send(text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
