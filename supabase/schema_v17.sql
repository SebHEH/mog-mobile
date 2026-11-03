-- =====================================================================
-- MOG on Supabase — schema v17   (run AFTER schema.sql and v2 to v16)
-- =====================================================================
-- Happy Supply W2b, HEH's stock held at Elpis (docs/MOG_Warehouse_Spec.md
-- §2, "W2b design", approved by Sebastian 2026-11-03). KMs keep ordering
-- HEH's own packaging from their Elpis vendor, as today. Elpis is a location
-- in Happy Supply's records, held by a vendor; the 3:30 AM close turns a
-- store's Elpis lines for items linked to a product held there into an open
-- delivery (EL-0001); the store marks it received (or HQ does it for them)
-- and only then does the stock there drop. As in v13 and v16, the rules live
-- HERE: no price, fee or cost on a phone, stock never below 0.
--
-- Adds:
--   * mog.wh_locations.held_by: the HQ vendor name holding a location
--     ("Elpis Wholesale"), null for HEH's own (Berliner, Tysons freezer).
--     One location per holder. Happy Supply never ships from one.
--   * mog.wh_products.via: where stores order a product, null for Happy
--     Supply or a location's holder. Its stock is that location's.
--   * mog.wh_orders.held_at: a delivery from a held location (status
--     ordered, then received; numbered EL-0001), one per store, cycle and
--     location. mog.wh_order_lines.beyond: cases a receipt took beyond the
--     records, logged as a count so the receipt never fails.
--   * mog.wh_held_vendor, mog.wh_held_from_log (the close's step),
--     mog.wh_held_receive (the stock drop), mog.wh_deliveries_json.
--   * mog_wh_held_receive(token, receipt): HQ marks a store's delivery
--     received (warehouse role), for one nobody marked.
--
-- Replaces (same signatures):
--   * mog_sync_close_cycle (from v2): the held deliveries after the log, in
--     a block of their own so nothing in it can stop the close.
--   * mog_wh_received (from v16): a held delivery is marked too.
--   * mog_wh_send (from v16): a held product isn't Happy Supply's.
--   * mog.wh_do_ship (from v16): never from a held location.
--   * mog.wh_do_save (from v13): a product's via, a location's heldBy.
--   * mog.wh_available, wh_order_phone_json, wh_live_json, wh_order_json,
--     wh_orders_json, wh_state, wh_next_number (from v16).
--
-- Writes no store data, and nothing changes until a location has a holder
-- and a store item is linked to a product held there: every read and the
-- close answer exactly as before.
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================

do $$
begin
  if to_regclass('mog.wh_orders') is null then
    raise exception 'Run schema_v16.sql first: the store orders are missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

alter table mog.wh_locations add column if not exists held_by text
  check (held_by is null or (held_by = btrim(held_by) and length(held_by) between 1 and 100));
create unique index if not exists wh_locations_held_by on mog.wh_locations (lower(held_by)) where held_by is not null;

alter table mog.wh_products add column if not exists via text
  check (via is null or (via = btrim(via) and length(via) between 1 and 100));

alter table mog.wh_orders add column if not exists held_at bigint references mog.wh_locations (id);
alter table mog.wh_order_lines add column if not exists beyond numeric check (beyond > 0);

-- A Happy Supply order: sent, shipped, received or cancelled. A delivery
-- from a held location: ordered, then received.
alter table mog.wh_orders drop constraint if exists wh_orders_status_check;
alter table mog.wh_orders add constraint wh_orders_status_check
  check (status in ('sent', 'shipped', 'received', 'cancelled', 'ordered'));
alter table mog.wh_orders drop constraint if exists wh_orders_held_status;
alter table mog.wh_orders add constraint wh_orders_held_status
  check (case when held_at is null then status <> 'ordered' else status in ('ordered', 'received') end);
create unique index if not exists wh_orders_one_held on mog.wh_orders (slug, cycle_date, held_at) where held_at is not null;


-- ---------------------------------------------------------------------
-- Internal: reads
-- ---------------------------------------------------------------------

-- The store's vendor an HQ vendor name maps to ("Elpis Wholesale" -> "Elpis"), or null.
create or replace function mog.wh_held_vendor(p_slug text, p_hq_name text)
returns text
language sql stable
set search_path = ''
as $$
  select k.vendor from mog.hq_vendor_links k where k.slug = p_slug and lower(k.hq_name) = lower(p_hq_name);
$$;

-- A product's cases a store can count on. A Happy Supply product: HEH's own
-- locations, minus what sent orders hold. A product held at Elpis: its cases
-- there, minus the deliveries no store has marked received. The store's own
-- order for p_cycle is left out (the one its phone may be replacing). Never
-- below 0.
create or replace function mog.wh_available(p_product bigint, p_slug text, p_cycle date)
returns numeric
language sql stable
set search_path = ''
as $$
  select greatest(0,
    coalesce((select sum(s.cases) from mog.wh_stock s join mog.wh_locations l on l.id = s.location_id
               where s.product_id = p_product and lower(coalesce(l.held_by, '')) = lower(coalesce(pr.via, ''))), 0)
    - coalesce((select sum(x.cases) from mog.wh_order_lines x join mog.wh_orders o on o.id = x.order_id
                 where x.product_id = p_product and o.status in ('sent', 'ordered')
                   and not (o.slug = p_slug and o.cycle_date is not distinct from p_cycle)), 0))
    from mog.wh_products pr where pr.id = p_product;
$$;

-- An order as its store's phone sees it: no price, no fee, no cost. A
-- delivery from a held location also says so, with the store's vendor for
-- it now ("Elpis"), whose card shows it.
create or replace function mog.wh_order_phone_json(p_id bigint)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'status', o.status, 'cycleDate', o.cycle_date, 'neededBy', o.needed_by,
    'note', o.note, 'sentAt', o.sent_at, 'sentBy', o.sent_by, 'shippedAt', o.shipped_at,
    'receivedAt', o.received_at, 'receivedBy', o.received_by, 'version', o.version,
    'from', (select string_agg(distinct l.name, ', ') from mog.wh_order_lines x join mog.wh_locations l on l.id = x.location_id
              where x.order_id = o.id),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('ord', x.ord, 'itemId', x.item_id, 'name', x.item_name, 'pack', p.pack,
                                          'cases', x.cases, 'casesShipped', x.cases_shipped, 'casesReceived', x.cases_received)
                       order by x.ord)
        from mog.wh_order_lines x join mog.wh_products p on p.id = x.product_id where x.order_id = o.id), '[]'::jsonb))
    || case when o.held_at is null then '{}'::jsonb
            else jsonb_build_object('held', true, 'heldVendor',
                   mog.wh_held_vendor(o.slug, (select l.held_by from mog.wh_locations l where l.id = o.held_at))) end
    from mog.wh_orders o where o.id = p_id;
$$;

-- The phone's Happy Supply part of its 10-second read, or {} for a store
-- with no linked item and no order: its Happy Supply vendor, each linked
-- item's product and cases available (Happy Supply's or Elpis's), its orders
-- and deliveries still open plus this cycle's (and a delivery marked
-- received in the last 18 hours), newest first, and the store's vendors
-- that hold HEH's stock (heldVendors, only when it has one).
create or replace function mog.wh_live_json(p_slug text)
returns jsonb
language sql stable
set search_path = ''
as $$
  with st as (select s.cycle_date from mog.store_state s where s.slug = p_slug),
  linked as (
    select i.item_id, i.wh_product from mog.items i join mog.wh_products p on p.id = i.wh_product
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
                 'available', mog.wh_available(l.wh_product, p_slug, (select cycle_date from st))))
          from linked l), '{}'::jsonb),
      'orders', coalesce((select jsonb_agg(mog.wh_order_phone_json(x.id) order by x.sent_at desc, x.id desc) from ords x),
                         '[]'::jsonb))
      || coalesce((select jsonb_build_object('heldVendors', jsonb_agg(h.vendor order by h.vendor))
                     from held h where h.vendor is not null having count(*) > 0), '{}'::jsonb))
  end;
$$;

-- The next PO-0001, TR-0001, HS-0001 or EL-0001, one at a time (v13). Numbers
-- come from what's there, so nothing is used up by a save that's refused.
create or replace function mog.wh_next_number(p_prefix text)
returns text
language plpgsql volatile
set search_path = ''
as $$
declare
  v integer;
begin
  perform 1 from mog.wh_settings where id for update;
  if p_prefix = 'PO' then
    select coalesce(max(substr(number, 4)::integer), 0) + 1 into v from mog.wh_pos;
  elsif p_prefix in ('HS', 'EL') then
    select coalesce(max(substr(number, 4)::integer), 0) + 1 into v from mog.wh_orders where number like p_prefix || '-%';
  else
    select coalesce(max(substr(number, 4)::integer), 0) + 1 into v from mog.wh_transfers;
  end if;
  return p_prefix || '-' || lpad(v::text, greatest(4, length(v::text)), '0');
end;
$$;

-- An order or a delivery as HQ's pages read it. A delivery from a held
-- location carries heldAt; a line received beyond the records, beyond.
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
             order by x.ord)
        from mog.wh_order_lines x
        join mog.wh_products p on p.id = x.product_id
        left join mog.wh_locations l on l.id = x.location_id
       where x.order_id = o.id), '[]'::jsonb))
    || case when o.held_at is null then '{}'::jsonb else jsonb_build_object('heldAt', o.held_at) end
    from mog.wh_orders o join mog.stores s on s.slug = o.slug
   where o.id = p_id;
$$;

-- Happy Supply's orders: the open ones and the last 30 closed, newest first.
create or replace function mog.wh_orders_json()
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(mog.wh_order_json(x.id) order by x.id desc), '[]'::jsonb)
    from (select id from mog.wh_orders where held_at is null and status in ('sent', 'shipped')
          union all
          (select id from mog.wh_orders where held_at is null and status in ('received', 'cancelled') order by id desc limit 30)) x;
$$;

-- The deliveries from held locations: the open ones and the last 30
-- received, newest first.
create or replace function mog.wh_deliveries_json()
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(mog.wh_order_json(x.id) order by x.id desc), '[]'::jsonb)
    from (select id from mog.wh_orders where held_at is not null and status = 'ordered'
          union all
          (select id from mog.wh_orders where held_at is not null and status = 'received' order by id desc limit 30)) x;
$$;


-- ---------------------------------------------------------------------
-- Internal: the writes (raise REJECTED: / CONFLICT:)
-- ---------------------------------------------------------------------

-- A product, a location, a supplier, or the settings. id null = a new one.
--   product:  { id?, version?, name, pack, par, handlingFee, stores: [slug], active, via? }
--             via (v17): where stores order it, null for Happy Supply or a
--             location's holder; left out = unchanged. Changing it needs the
--             product at 0 cases with no open order.
--   location: { id?, name, ord?, active, heldBy? }
--             heldBy (v17): the HQ vendor name holding it, null for HEH's own;
--             left out = unchanged. One location per holder; changing it needs
--             the location empty and no product ordered through it.
--   supplier: { id?, name, active }
--   settings: { version, markupPct, deliveryFee }
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
    if exists (select 1 from mog.wh_products p where lower(p.name) = lower(v_name) and p.id is distinct from v_id) then
      raise exception 'REJECTED: there''s already a product called "%"', v_name;
    end if;
    if v_id is null then
      insert into mog.wh_products (name, pack, par, handling_fee, stores, active, via, updated_by)
      values (v_name, v_pack, v_par, v_fee, v_stores, v_active, v_via, p_by) returning id into v_id;
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
             version = version + 1, updated_at = now(), updated_by = p_by
       where id = v_id;
    end if;
    return jsonb_build_object('kind', 'product', 'id', v_id, 'name', v_name);
  end if;

  if p_kind = 'location' or p_kind = 'supplier' then
    v_name := mog.wh_name(p_row -> 'name', case when p_kind = 'location' then 'The location' else 'The supplier' end, 60);
    v_active := mog.wh_bool(p_row -> 'active', 'Active', true);
  end if;

  if p_kind = 'location' then
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
    if v_id is null then
      insert into mog.wh_locations (name, ord, active, held_by)
      values (v_name, coalesce(v_ord, (select coalesce(max(l.ord), 0) + 10 from mog.wh_locations l)), v_active, v_holder)
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
           or exists (select 1 from mog.wh_products p join mog.wh_locations l on lower(l.held_by) = lower(p.via) where l.id = v_id) then
          raise exception 'REJECTED: % holds stock or has products ordered through it: who holds it can''t change', v_name;
        end if;
      end if;
      update mog.wh_locations set name = v_name, ord = coalesce(v_ord, ord), active = v_active,
             held_by = case when v_set then v_holder else held_by end where id = v_id;
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

-- Ship a sent order: { id, version, lines: [{ ord, cases, locationId }] },
-- every line once (0 = none of it). A line ships at most what was ordered,
-- from one location, never taking it below 0; its price locks. Never from
-- a location a vendor holds (v17: Elpis).
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
    if v_cases > 0 then
      v_loc := mog.wh_id(ln -> 'locationId', 'Where ' || x.item_name || ' ships from');
      if not exists (select 1 from mog.wh_locations l where l.id = v_loc and l.active) then
        raise exception 'REJECTED: that location isn''t open';
      end if;
      if exists (select 1 from mog.wh_locations l where l.id = v_loc and l.held_by is not null) then
        raise exception 'REJECTED: Happy Supply never ships from %: % holds it',
          (select l.name from mog.wh_locations l where l.id = v_loc), (select l.held_by from mog.wh_locations l where l.id = v_loc);
      end if;
      perform mog.wh_move(p_by, x.product_id, v_loc, -v_cases, 'shipped', o.number, null, null);
      v_total := v_total + v_cases;
    end if;
    update mog.wh_order_lines l
       set cases_shipped = v_cases, location_id = v_loc, avg_cost = p.avg_cost,
           price = mog.wh_store_price(p.avg_cost, p.handling_fee, v_set.markup_pct)
      from mog.wh_products p
     where p.id = l.product_id and l.order_id = o.id and l.ord = x.ord;
  end loop;
  if v_total = 0 then
    raise exception 'REJECTED: nothing ships; cancel the order instead';
  end if;
  update mog.wh_orders
     set status = 'shipped', shipped_at = now(), shipped_by = p_by, delivery_fee = v_set.delivery_fee, version = version + 1
   where id = o.id;
  return jsonb_build_object('orderId', o.id, 'number', o.number, 'cases', v_total);
end;
$$;

-- Mark a delivery from a held location received, its row locked by the
-- caller: lines [{ ord, cases }] (a line left out arrived as ordered; one
-- can be more). Each line's cases leave the location under the delivery's
-- number. When the records hold fewer, the difference is first logged as a
-- count with a reason naming the store, and kept on the line (beyond): the
-- cases are physically there, so HEH's records never stop a store's
-- receipt. The line keeps the average cost for W3.
create or replace function mog.wh_held_receive(p_id bigint, p_by text, p_received_by text, p_lines jsonb)
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
  v_have  numeric;
  v_store text;
begin
  select * into o from mog.wh_orders where id = p_id;
  if jsonb_typeof(v_lines) <> 'array' then
    raise exception 'REJECTED: the lines are a list';
  end if;
  if exists (select 1 from jsonb_array_elements(v_lines) e
              where not exists (select 1 from mog.wh_order_lines l where l.order_id = o.id and l.ord::text = e ->> 'ord')) then
    raise exception 'REJECTED: a line here isn''t in %', o.number;
  end if;
  perform mog.wh_lock_products(array(select distinct l.product_id from mog.wh_order_lines l where l.order_id = o.id));
  select coalesce(s.location, s.slug) into v_store from mog.stores s where s.slug = o.slug;
  for x in select * from mog.wh_order_lines where order_id = o.id order by ord loop
    select e into ln from jsonb_array_elements(v_lines) e where e ->> 'ord' = x.ord::text;
    v_cases := case when ln is null then x.cases else mog.wh_cases(ln -> 'cases', x.item_name, true) end;
    v_have := null;
    if v_cases > 0 then
      insert into mog.wh_stock (product_id, location_id, cases) values (x.product_id, o.held_at, 0) on conflict do nothing;
      select s.cases into v_have from mog.wh_stock s where s.product_id = x.product_id and s.location_id = o.held_at;
      if v_have < v_cases then
        perform mog.wh_move(p_by, x.product_id, o.held_at, v_cases - v_have, 'count', o.number, null,
                            'Received at ' || v_store || ' beyond the records');
      end if;
      perform mog.wh_move(p_by, x.product_id, o.held_at, -v_cases, 'shipped', o.number, null, null);
    end if;
    update mog.wh_order_lines l
       set cases_received = v_cases, avg_cost = p.avg_cost,
           beyond = case when v_have < v_cases then v_cases - v_have end
      from mog.wh_products p
     where p.id = l.product_id and l.order_id = o.id and l.ord = x.ord;
  end loop;
  update mog.wh_orders
     set status = 'received', received_at = now(), received_by = p_received_by, version = version + 1
   where id = o.id;
end;
$$;

-- HQ marks a store's delivery received for it (one nobody marked):
-- { id, version, lines: [{ ord, cases }] }. The store's card then shows it
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
  if not found or o.held_at is null then
    raise exception 'REJECTED: that delivery isn''t there any more';
  end if;
  if o.version is distinct from (p_r ->> 'version')::bigint then
    raise exception 'CONFLICT: % changed since you opened it', o.number;
  end if;
  if o.status <> 'ordered' then
    raise exception 'CONFLICT: % is % already', o.number, o.status;
  end if;
  perform mog.wh_held_receive(o.id, p_by, left('HQ · ' || p_by, 40), p_r -> 'lines');
  return jsonb_build_object('orderId', o.id, 'number', o.number);
end;
$$;

-- The close's step (mog_sync_close_cycle): the closing cycle's order-log
-- lines a store ordered from a vendor holding a location (its Elpis), for
-- items linked to a product held there, become one open delivery per held
-- location (EL-0001). A same-day re-close replaces an open one, or deletes it
-- when nothing is left; a received one stays. Answers how many lines.
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
  for h in select w.id, w.held_by from mog.wh_locations w where w.held_by is not null order by w.id loop
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
     where g.slug = p_slug and g.cycle_date = p_cycle and g.vendor = v_vend and lower(p.via) = lower(h.held_by);
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
     where g.slug = p_slug and g.cycle_date = p_cycle and g.vendor = v_vend and lower(p.via) = lower(h.held_by);
    v_all := v_all + v_n;
  end loop;
  return v_all;
end;
$$;


-- ---------------------------------------------------------------------
-- Public: the store's phone (its PIN session)
-- ---------------------------------------------------------------------

-- Send to Happy Supply: { vendor, neededBy (YYYY-MM-DD or null), note, by,
-- lines: [{ itemId, cases }] }. Each line is an active item on the store's
-- Happy Supply list, linked to a product Happy Supply sells to this store,
-- once. The cycle is the store's open one; sending again replaces this
-- cycle's order while it's still sent. More than is available is allowed
-- (the phone warns; Dan ships what he has). Answers with the order and the
-- phone's Happy Supply part.
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

-- Mark received: { id, by, lines: [{ ord, cases }] }, an order of this
-- store's. A Happy Supply order: shipped; a line left out arrived as
-- shipped, and one can't be more than shipped. A delivery from a held
-- location (v17, Elpis): ordered; a line left out arrived as ordered,
-- one can be more, and its cases leave the location (mog.wh_held_receive).
-- Received already (another phone): answers as it stands.
create or replace function public.mog_wh_received(p_token text, p_receipt jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v       jsonb := mog.phone_session(p_token);
  v_slug  text;
  o       mog.wh_orders%rowtype;
  x       mog.wh_order_lines%rowtype;
  ln      jsonb;
  v_lines jsonb;
  v_cases numeric;
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
      v_lines := coalesce(p_receipt -> 'lines', '[]'::jsonb);
      if jsonb_typeof(v_lines) <> 'array' then
        raise exception 'REJECTED: the lines are a list';
      end if;
      if exists (select 1 from jsonb_array_elements(v_lines) e
                  where not exists (select 1 from mog.wh_order_lines l where l.order_id = o.id and l.ord::text = e ->> 'ord')) then
        raise exception 'REJECTED: a line here isn''t in %', o.number;
      end if;
      for x in select * from mog.wh_order_lines where order_id = o.id order by ord loop
        select e into ln from jsonb_array_elements(v_lines) e where e ->> 'ord' = x.ord::text;
        v_cases := case when ln is null then coalesce(x.cases_shipped, 0)
                        else mog.wh_cases(ln -> 'cases', x.item_name, true) end;
        if v_cases > coalesce(x.cases_shipped, 0) then
          raise exception 'REJECTED: % shipped %; it can''t arrive more', x.item_name, mog.wh_cs(coalesce(x.cases_shipped, 0));
        end if;
        update mog.wh_order_lines set cases_received = v_cases where order_id = o.id and ord = x.ord;
      end loop;
      update mog.wh_orders
         set status = 'received', received_at = now(), received_by = v_by, version = version + 1
       where id = o.id;
    end if;
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'data',
    jsonb_build_object('order', mog.wh_order_phone_json(o.id)) || mog.wh_live_json(v_slug));
end;
$$;


-- ---------------------------------------------------------------------
-- HQ's read
-- ---------------------------------------------------------------------

-- v16's warehouse, plus who holds a location (heldBy, with its last real
-- count), a product's via, the deliveries from held locations, and the
-- vendor names a location's holder is picked from (HQ's remembered names
-- and the real stores' vendors, one spelling each).
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
-- The nightly close (v2), with the held deliveries
-- ---------------------------------------------------------------------

-- v2's close, unchanged but for one step after the log is written:
-- mog.wh_held_from_log, in a block of its own. A failure there rolls back
-- only that block and comes back as heldError beside the close's answer;
-- the log, the new cycle and the counts are as before.
create or replace function public.mog_sync_close_cycle(
  p_slug text, p_key text,
  p_closing date, p_new_cycle date, p_new_dow text,
  p_rows jsonb, p_todays_log jsonb, p_logged_at timestamptz default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  st   mog.store_state%rowtype;
  v_n  integer;
  v_at timestamptz := coalesce(p_logged_at, now());
  v_err text;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  if p_closing is null or p_new_cycle is null or p_new_cycle < p_closing
     or coalesce(p_new_dow, '') not in ('Mon','Tue','Wed','Thu','Fri','Sat','Sun') then
    return jsonb_build_object('ok', false, 'error',
      'a closing date, a new cycle date on or after it, and a Mon..Sun day are required');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'a rows array is required');
  end if;

  select * into st from mog.store_state where slug = p_slug for update;   -- serializes concurrent closes
  if not found then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;
  if st.cycle_date <> p_closing then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'closed', false, 'reason', 'CYCLE_MOVED', 'cycleDate', to_char(st.cycle_date, 'YYYY-MM-DD')));
  end if;

  delete from mog.order_log where slug = p_slug and cycle_date = p_closing;
  insert into mog.order_log
    (slug, cycle_date, seq, vendor, item_id, item_name, pack, area, on_hand_prev, qty_ordered, logged_at)
  select p_slug, p_closing, t.ord::integer,
         trim(coalesce(t.e ->> 'vendor', '')), trim(coalesce(t.e ->> 'id', '')),
         coalesce(t.e ->> 'name', ''), coalesce(t.e ->> 'pack', ''), coalesce(t.e ->> 'area', ''),
         mog.to_onhand(t.e -> 'onHandPrev'), mog.to_onhand(t.e -> 'qty'), v_at
    from jsonb_array_elements(p_rows) with ordinality as t(e, ord)
   where trim(coalesce(t.e ->> 'vendor', '')) <> ''
     and trim(coalesce(t.e ->> 'id', '')) <> ''
     and coalesce(mog.to_onhand(t.e -> 'qty'), 0) > 0;
  get diagnostics v_n = row_count;

  -- v17: the store's deliveries of HEH's stock held at Elpis, from the log
  -- just written. In a block of its own: nothing in it can stop the close.
  begin
    perform mog.wh_held_from_log(p_slug, p_closing);
  exception when others then
    v_err := sqlerrm;
  end;

  update mog.store_state
     set cycle_date         = p_new_cycle,
         day_of_week        = p_new_dow,
         emergency_override = false,
         vendor_picks       = '{}'::jsonb,
         todays_log         = coalesce(p_todays_log, '[]'::jsonb),
         updated_at         = now()
   where slug = p_slug;

  if p_new_cycle = p_closing then
    delete from mog.counts where slug = p_slug and cycle_date = p_new_cycle;
  end if;
  delete from mog.counts where slug = p_slug and cycle_date < p_new_cycle - 45;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'closed', true, 'logged', v_n,
    'closedCycle', to_char(p_closing, 'YYYY-MM-DD'),
    'cycleDate', to_char(p_new_cycle, 'YYYY-MM-DD'))
    || case when v_err is null then '{}'::jsonb else jsonb_build_object('heldError', v_err) end);
end;
$$;


-- ---------------------------------------------------------------------
-- Public: HQ (warehouse role)
-- ---------------------------------------------------------------------

create or replace function public.mog_wh_held_receive(p_token text, p_receipt jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := mog.wh_session(p_token);
  v_done jsonb;
begin
  if v_name is null then
    return mog.wh_refusal(p_token);
  end if;
  begin
    v_done := mog.wh_do_held_receive(v_name, p_receipt);
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return mog.wh_answer(v_name, v_done);
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: lock the new columns' tables and internals, open exactly
-- the entry points.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_wh_held_receive(text, jsonb)',
    'public.mog_wh_received(text, jsonb)',
    'public.mog_wh_send(text, jsonb)',
    'public.mog_sync_close_cycle(text, text, date, date, text, jsonb, jsonb, timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
