-- =====================================================================
-- MOG on Supabase — schema v21   (run AFTER schema.sql and v2 to v20)
-- =====================================================================
-- Routes (docs/MOG_Warehouse_Spec.md §2, "Routes spec" and "v21 design",
-- approved by Sebastian 2026-11-05): each store that takes an HEH item has
-- a route, on its own item's row: the HQ item (wh_product, v16), the place
-- it comes from (wh_place; empty = HEH's own places, Happy Supply) and the
-- store vendor its KMs order it under (wh_vendor). Every stock reader reads
-- the route, never HQ's remembered vendor names: the 3:30 AM close's
-- deliveries, the phone's 10-second read, Send to Happy Supply. HQ sets
-- routes through mog_hq_apply (catalogEdit.js commitHqRoutes), one undoable
-- change per store. As in v13 to v20, the rules live HERE.
--
-- Adds:
--   * mog.items.wh_place (a place; places are never deleted) and
--     mog.items.wh_vendor (a foreign key to the store's vendors, like
--     primary_vendor: a rename follows, a removed vendor empties it, which
--     HQ shows as a broken route). Both in the item's row (item_row_json,
--     the editor's compare and its writes), so Undo puts a route back.
--   * mog.wh_routes_json: every linked item, in the warehouse read (routes).
--   * Row security on mog.wh_product_places (v20 left it off).
--   * Once, when the columns are new: each linked item's wh_vendor = its
--     main vendor and wh_place = the place v20 would have used, or its only
--     place; a place held at a store has no low point of its own (the
--     holder's par refills it), so those go to 0.
--
-- Replaces (same signatures): mog.item_row_json, mog.editor_fields_match,
-- mog.editor_apply_ops (from v16), mog.wh_order_phone_json (from v17),
-- mog.wh_place_carries, mog.wh_available, mog.wh_live_json,
-- mog.wh_held_from_log, mog.wh_do_save, mog.wh_state, public.mog_wh_send
-- (from v20).
--
-- Drops: mog.wh_item_place, mog.wh_store_vendor, mog.wh_held_vendor (the
-- routing through HQ's remembered names).
--
-- Retired, kept unread until v22 (Sebastian 2026-11-05, so re-running v20's
-- functions stays a rollback): mog.wh_products.via, par and stores. Nothing
-- here reads or writes them.
--
-- Rollback: re-run v20's versions of the replaced functions (and v16's,
-- v17's for the editor and the phone's order), then v17's wh_held_vendor,
-- v16's wh_store_vendor and v20's wh_item_place. The two columns can stay.
-- Writes no store data beyond the one-time step above; re-running is safe.
-- =====================================================================

do $$
begin
  if to_regclass('mog.wh_product_places') is null then
    raise exception 'Run schema_v20.sql first: mog.wh_product_places is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Tables, and the one-time fill (it uses v20's routing, replaced below)
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'mog' and table_name = 'items' and column_name = 'wh_vendor') then
    alter table mog.items add column wh_place bigint references mog.wh_locations (id);
    alter table mog.items add column wh_vendor text;
    alter table mog.items add constraint items_slug_wh_vendor_fkey foreign key (slug, wh_vendor)
      references mog.vendors (slug, name) on update cascade on delete set null (wh_vendor);
    -- Each linked item is ordered under its main vendor, from:
    --   the held place v20 matched through HQ's remembered names;
    --   else its one held place, when it isn't at HEH's own (the TEST
    --   store's bowls and lids: Elpis, whose remembered name was forgotten);
    --   else HEH's own (empty), v20's answer.
    -- An item at none of these is left without a route (wh_vendor empty),
    -- which HQ shows on the item.
    with c as (
      select i.slug, i.item_id,
             mog.wh_item_place(i.slug, i.primary_vendor, i.wh_product) as matched,
             (select count(*) from mog.wh_locations l
               where l.held_by is not null and l.held_store is distinct from i.slug
                 and mog.wh_place_carries(i.wh_product, l.id)) as n_held,
             (select min(l.id) from mog.wh_locations l
               where l.held_by is not null and l.held_store is distinct from i.slug
                 and mog.wh_place_carries(i.wh_product, l.id)) as one_held,
             exists (select 1 from mog.wh_locations l
                      where l.held_by is null and mog.wh_place_carries(i.wh_product, l.id)) as at_own
        from mog.items i
       where i.wh_product is not null and i.primary_vendor is not null)
    update mog.items i
       set wh_vendor = i.primary_vendor,
           wh_place = case when c.matched is not null then c.matched
                           when c.n_held = 1 and not c.at_own then c.one_held end
      from c
     where c.slug = i.slug and c.item_id = i.item_id
       and (c.matched is not null or (c.n_held = 1 and not c.at_own) or c.at_own);
    update mog.wh_product_places pp set low_point = 0
      from mog.wh_locations l
     where l.id = pp.location_id and l.held_store is not null and pp.low_point <> 0;
  end if;
end;
$$;

alter table mog.wh_product_places enable row level security;


-- ---------------------------------------------------------------------
-- An item's row: whPlace and whVendor too, each only when set
-- ---------------------------------------------------------------------

create or replace function mog.item_row_json(i mog.items)
returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', i.item_id, 'name', i.name, 'primaryVendor', i.primary_vendor, 'pack', i.pack, 'par', i.par,
    'active', i.active, 'useMult', i.use_mult, 'notes', i.notes, 'sku', i.sku, 'category', i.category,
    'eligible', to_jsonb(i.eligible_vendors), 'seq', i.seq)
    || case when i.lto is not null then jsonb_build_object('lto', i.lto) else '{}'::jsonb end
    || case when i.wh_product is not null then jsonb_build_object('whProduct', i.wh_product) else '{}'::jsonb end
    || case when i.wh_place is not null then jsonb_build_object('whPlace', i.wh_place) else '{}'::jsonb end
    || case when i.wh_vendor is not null then jsonb_build_object('whVendor', i.wh_vendor) else '{}'::jsonb end;
$$;

-- Does the stored row still look the way the editor read it (v10), an
-- item's lto (v14), whProduct (v16) and route (whPlace, whVendor, v21) too.
create or replace function mog.editor_fields_match(p_t text, p_cur jsonb, p_want jsonb)
returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(bool_and(
           coalesce(nullif(nullif(case when f = 'contact' then mog.vendor_contact_clean(p_cur -> f) else p_cur -> f end,
                                  '""'::jsonb), '{}'::jsonb), 'null'::jsonb) =
           coalesce(nullif(nullif(case when f = 'contact' then mog.vendor_contact_clean(p_want -> f) else p_want -> f end,
                                  '""'::jsonb), '{}'::jsonb), 'null'::jsonb)), false)
    from unnest(case p_t
      when 'items'    then array['name','primaryVendor','pack','par','active','useMult','notes','sku','category','eligible','lto','whProduct','whPlace','whVendor']
      when 'pickRows' then array['area','shelfOrder']
      when 'vendors'  then array['mults','cutoff','contact']
      when 'areas'    then array['ord'] end) f;
$$;

-- Apply ops to a store's tables (v16), an item's route written too (v21).
-- A vendor renamed: the route's vendor follows (on update cascade), as
-- its main vendor does; a vendor removed empties it (on delete set null).
create or replace function mog.editor_apply_ops(p_slug text, p_ops jsonb)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  op    jsonb;
  v_t   text;
  v_b   jsonb;
  v_a   jsonb;
  v_row jsonb;
  v_cur jsonb;
  v_bad text;
begin
  for op in select e from jsonb_array_elements(p_ops) e loop
    if jsonb_typeof(op) <> 'object' then
      raise exception 'BAD_OP: %', left(op::text, 200);
    end if;
    if op ? 'shift' then
      if op ->> 'shift' is distinct from 'items' or jsonb_typeof(op -> 'from') is distinct from 'number' then
        raise exception 'BAD_OP: %', left(op::text, 200);
      end if;
      update mog.items set seq = seq + 1 where slug = p_slug and seq >= (op ->> 'from')::integer;
      continue;
    end if;
    -- An area renamed (schema v8): its pick rows follow (on update cascade).
    -- A vendor renamed (schema v15): its items' main vendor, its pick rows
    -- and HQ's remembered names follow the same way; its name in the items'
    -- vendor lists, the store's counts, "just today" edits, override day
    -- picks and presence are renamed here. A count already saved under the
    -- new name keeps its place (the old one stays, unread).
    if op ? 'rename' then
      if coalesce(op ->> 'rename', '') not in ('areas', 'vendors') or jsonb_typeof(op -> 'from') is distinct from 'string'
         or jsonb_typeof(op -> 'to') is distinct from 'string' then
        raise exception 'BAD_OP: %', left(op::text, 200);
      end if;
      if op ->> 'rename' = 'areas' then
        if not exists (select 1 from mog.areas a where a.slug = p_slug and a.name = op ->> 'from') then
          raise exception 'CONFLICT: areas % has changed', op ->> 'from';
        end if;
        if exists (select 1 from mog.areas a where a.slug = p_slug and a.name <> op ->> 'from'
                      and lower(a.name) = lower(op ->> 'to')) then
          raise exception 'CONFLICT: areas % is already there', op ->> 'to';
        end if;
        update mog.areas set name = op ->> 'to' where slug = p_slug and name = op ->> 'from';
        continue;
      end if;
      if not exists (select 1 from mog.vendors v where v.slug = p_slug and v.name = op ->> 'from') then
        raise exception 'CONFLICT: vendors % has changed', op ->> 'from';
      end if;
      if exists (select 1 from mog.vendors v where v.slug = p_slug and v.name <> op ->> 'from'
                    and lower(v.name) = lower(op ->> 'to')) then
        raise exception 'CONFLICT: vendors % is already there', op ->> 'to';
      end if;
      update mog.vendors set name = op ->> 'to' where slug = p_slug and name = op ->> 'from';
      update mog.items set eligible_vendors = array_replace(eligible_vendors, op ->> 'from', op ->> 'to')
       where slug = p_slug and (op ->> 'from') = any (eligible_vendors);
      update mog.counts k set vendor = op ->> 'to'
       where k.slug = p_slug and k.vendor = op ->> 'from'
         and not exists (select 1 from mog.counts c where c.slug = p_slug and c.cycle_date = k.cycle_date
                            and c.vendor = op ->> 'to' and c.item_id = k.item_id);
      update mog.quick_edits set vendor = op ->> 'to' where slug = p_slug and vendor = op ->> 'from';
      update mog.store_state
         set vendor_picks = (vendor_picks - (op ->> 'from')) || jsonb_build_object(op ->> 'to', vendor_picks -> (op ->> 'from'))
       where slug = p_slug and vendor_picks ? (op ->> 'from');
      update mog.presence set vendor = op ->> 'to' where slug = p_slug and vendor = op ->> 'from';
      continue;
    end if;

    v_t := op ->> 't';
    v_b := nullif(op -> 'before', 'null'::jsonb);
    v_a := nullif(op -> 'after',  'null'::jsonb);
    v_row := coalesce(v_a, v_b);
    if v_row is null or v_t is null or v_t not in ('items', 'pickRows', 'vendors', 'areas') then
      raise exception 'BAD_OP: %', left(op::text, 200);
    end if;
    if v_a is not null and v_b is not null and mog.editor_ident(v_t, v_a) is distinct from mog.editor_ident(v_t, v_b) then
      raise exception 'BAD_OP: before and after are different rows';
    end if;

    v_cur := mog.editor_current(p_slug, v_t, v_row);
    if v_b is null then
      if v_cur is not null then
        raise exception 'CONFLICT: % % is already there', v_t, mog.editor_ident(v_t, v_row);
      end if;
    elsif v_cur is null or not mog.editor_fields_match(v_t, v_cur, v_b) then
      raise exception 'CONFLICT: % % has changed', v_t, mog.editor_ident(v_t, v_row);
    end if;

    if v_t = 'items' then
      if v_a is not null then
        select x into v_bad from unnest(mog.json_text_array(v_a -> 'eligible')) x
         where not exists (select 1 from mog.vendors v where v.slug = p_slug and v.name = x) limit 1;
        if v_bad is not null then
          raise exception 'Vendor "%" is not listed', v_bad;
        end if;
        -- v21: a route's vendor is one of the store's, and its place is a place.
        if nullif(v_a ->> 'whVendor', '') is not null
           and not exists (select 1 from mog.vendors v where v.slug = p_slug and v.name = v_a ->> 'whVendor') then
          raise exception 'Vendor "%" is not listed', v_a ->> 'whVendor';
        end if;
        if nullif(v_a ->> 'whPlace', '') is not null
           and not exists (select 1 from mog.wh_locations l where l.id = (v_a ->> 'whPlace')::bigint) then
          raise exception 'REJECTED: that place isn''t in the warehouse any more';
        end if;
      end if;
      if v_a is null then
        delete from mog.items where slug = p_slug and item_id = v_b ->> 'id';
      elsif v_b is null then
        insert into mog.items (slug, item_id, name, primary_vendor, pack, par, active, use_mult,
                               notes, sku, category, eligible_vendors, seq, lto, wh_product, wh_place, wh_vendor)
        values (p_slug, v_a ->> 'id', coalesce(v_a ->> 'name', ''), nullif(v_a ->> 'primaryVendor', ''),
                coalesce(v_a ->> 'pack', ''), (v_a ->> 'par')::numeric,
                coalesce((v_a ->> 'active')::boolean, true), coalesce((v_a ->> 'useMult')::boolean, true),
                coalesce(v_a ->> 'notes', ''), coalesce(v_a ->> 'sku', ''), coalesce(v_a ->> 'category', ''),
                mog.json_text_array(v_a -> 'eligible'),
                coalesce((v_a ->> 'seq')::integer,
                         (select coalesce(max(i.seq), 0) + 1 from mog.items i where i.slug = p_slug)),
                nullif(v_a ->> 'lto', ''), (v_a ->> 'whProduct')::bigint,
                (nullif(v_a ->> 'whPlace', ''))::bigint, nullif(v_a ->> 'whVendor', ''));
      else
        update mog.items
           set name = coalesce(v_a ->> 'name', ''), primary_vendor = nullif(v_a ->> 'primaryVendor', ''),
               pack = coalesce(v_a ->> 'pack', ''), par = (v_a ->> 'par')::numeric,
               active = coalesce((v_a ->> 'active')::boolean, true), use_mult = coalesce((v_a ->> 'useMult')::boolean, true),
               notes = coalesce(v_a ->> 'notes', ''), sku = coalesce(v_a ->> 'sku', ''),
               category = coalesce(v_a ->> 'category', ''), eligible_vendors = mog.json_text_array(v_a -> 'eligible'),
               lto = nullif(v_a ->> 'lto', ''), wh_product = (v_a ->> 'whProduct')::bigint,
               wh_place = (nullif(v_a ->> 'whPlace', ''))::bigint, wh_vendor = nullif(v_a ->> 'whVendor', '')
         where slug = p_slug and item_id = v_a ->> 'id';
      end if;

    elsif v_t = 'pickRows' then
      if v_a is null then
        delete from mog.pick_rows where slug = p_slug and vendor = v_b ->> 'vendor' and item_id = v_b ->> 'id';
      elsif v_b is null then
        insert into mog.pick_rows (slug, vendor, item_id, area, shelf_order, seq)
        values (p_slug, v_a ->> 'vendor', v_a ->> 'id', nullif(v_a ->> 'area', ''), (v_a ->> 'shelfOrder')::numeric,
                coalesce((v_a ->> 'seq')::integer,
                         (select coalesce(max(p.seq), 0) + 1 from mog.pick_rows p where p.slug = p_slug)));
      else
        update mog.pick_rows
           set area = nullif(v_a ->> 'area', ''), shelf_order = (v_a ->> 'shelfOrder')::numeric,
               seq = coalesce((v_a ->> 'seq')::integer, seq)
         where slug = p_slug and vendor = v_a ->> 'vendor' and item_id = v_a ->> 'id';
      end if;

    elsif v_t = 'vendors' then
      if v_a is null then
        delete from mog.vendors where slug = p_slug and name = v_b ->> 'name';
      elsif v_b is null then
        insert into mog.vendors (slug, name, mults, cutoff, contact)
        values (p_slug, v_a ->> 'name',
                array(select m.x::numeric from jsonb_array_elements_text(coalesce(v_a -> 'mults', '[0,0,0,0,0,0,0]')) with ordinality m(x, o) order by m.o),
                nullif(v_a ->> 'cutoff', ''), mog.vendor_contact_clean(v_a -> 'contact'));
      else
        update mog.vendors
           set mults = array(select m.x::numeric from jsonb_array_elements_text(coalesce(v_a -> 'mults', '[0,0,0,0,0,0,0]')) with ordinality m(x, o) order by m.o),
               cutoff = nullif(v_a ->> 'cutoff', ''),
               contact = mog.vendor_contact_clean(v_a -> 'contact')
         where slug = p_slug and name = v_a ->> 'name';
      end if;

    else   -- areas
      if v_a is null then
        delete from mog.areas where slug = p_slug and name = v_b ->> 'name';
      elsif v_b is null then
        insert into mog.areas (slug, name, ord) values (p_slug, v_a ->> 'name', (v_a ->> 'ord')::numeric);
      else
        update mog.areas set ord = (v_a ->> 'ord')::numeric where slug = p_slug and name = v_a ->> 'name';
      end if;
    end if;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------
-- Internal: routes
-- ---------------------------------------------------------------------

-- A product sits at a place: a row in mog.wh_product_places (v20; v21 drops
-- the fallback through a product's via).
create or replace function mog.wh_place_carries(p_product bigint, p_location bigint)
returns boolean
language sql stable
set search_path = ''
as $$
  select exists (select 1 from mog.wh_product_places pp where pp.product_id = p_product and pp.location_id = p_location);
$$;

-- v17's signature: a product's cases a store can count on, from the place
-- its route names (empty = HEH's own). A store with no route for it: HEH's own.
create or replace function mog.wh_available(p_product bigint, p_slug text, p_cycle date)
returns numeric
language sql stable
set search_path = ''
as $$
  select mog.wh_available_at(p_product,
    (select i.wh_place from mog.items i
      where i.slug = p_slug and i.wh_product = p_product and i.wh_vendor is not null
      order by i.active desc, i.item_id limit 1),
    p_slug, p_cycle);
$$;

-- Every store item linked to an HQ item, for HQ's Stock, Items and Places:
-- its route (placeId empty = HEH's own; vendor empty = no route yet, or its
-- vendor was removed) beside what the store has now (its main vendor,
-- active, par), so the page can say when a route is broken.
create or replace function mog.wh_routes_json()
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'slug', i.slug, 'store', coalesce(s.location, i.slug), 'isTest', s.is_test, 'concept', coalesce(s.concept, ''),
           'itemId', i.item_id, 'item', i.name, 'productId', i.wh_product, 'placeId', i.wh_place, 'vendor', i.wh_vendor,
           'mainVendor', i.primary_vendor, 'active', i.active, 'par', i.par, 'pack', i.pack)
           order by i.wh_product, s.is_test, s.location, i.slug, i.item_id), '[]'::jsonb)
    from mog.items i join mog.stores s on s.slug = i.slug
   where i.wh_product is not null;
$$;

-- An order as its store's phone sees it: no price, no fee, no cost. A
-- delivery from a held place also says so, with the store's vendor for it
-- now ("Elpis"): its routes' vendor (v21), else the one the close recorded.
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
                   coalesce((select i.wh_vendor from mog.items i
                              where i.slug = o.slug and i.wh_place = o.held_at and i.wh_vendor is not null
                              order by i.item_id limit 1), o.vendor)) end
    from mog.wh_orders o where o.id = p_id;
$$;


-- v17's phone read, from each item's route (v21): its Happy Supply vendor is
-- the one routing to HEH's own places, heldVendors the ones routing to a
-- held place, each item's cases from its route's place. Same shape as v20.
create or replace function mog.wh_live_json(p_slug text)
returns jsonb
language sql stable
set search_path = ''
as $$
  with st as (select s.cycle_date from mog.store_state s where s.slug = p_slug),
  linked as (
    select i.item_id, i.wh_product, i.wh_place, i.wh_vendor from mog.items i join mog.wh_products p on p.id = i.wh_product
     where i.slug = p_slug and i.active and p.active and i.wh_vendor is not null),
  ords as (
    select o.id, o.sent_at from mog.wh_orders o
     where o.slug = p_slug
       and (o.status in ('sent', 'shipped', 'ordered') or o.cycle_date = (select cycle_date from st)
            or (o.held_at is not null and o.received_at > now() - interval '18 hours'))
     order by o.sent_at desc, o.id desc limit 10),
  held as (
    select distinct l.wh_vendor as vendor from linked l where l.wh_place is not null)
  select case when not exists (select 1 from linked) and not exists (select 1 from ords) then '{}'::jsonb
    else jsonb_build_object('happySupply', jsonb_build_object(
      'vendor', (select min(l.wh_vendor) from linked l where l.wh_place is null),
      'items', coalesce((
        select jsonb_object_agg(l.item_id, jsonb_build_object(
                 'productId', l.wh_product,
                 'available', mog.wh_available_at(l.wh_product, l.wh_place, p_slug, (select cycle_date from st))))
          from linked l), '{}'::jsonb),
      'orders', coalesce((select jsonb_agg(mog.wh_order_phone_json(x.id) order by x.sent_at desc, x.id desc) from ords x),
                         '[]'::jsonb))
      || coalesce((select jsonb_build_object('heldVendors', jsonb_agg(h.vendor order by h.vendor))
                     from held h where h.vendor is not null having count(*) > 0), '{}'::jsonb))
  end;
$$;


-- v17's close step: a held place's deliveries, from the order log lines of
-- the items whose route names that place, ordered under the route's vendor
-- (v21), never from the store that holds it.
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
    select o.id, o.status into v_id, v_st from mog.wh_orders o
     where o.slug = p_slug and o.cycle_date = p_cycle and o.held_at = h.id for update;
    if v_st = 'received' then
      continue;
    end if;
    select count(*) into v_n
      from mog.order_log g
      join mog.items i on i.slug = g.slug and i.item_id = g.item_id
      join mog.wh_products p on p.id = i.wh_product
     where g.slug = p_slug and g.cycle_date = p_cycle and i.wh_place = h.id and g.vendor = i.wh_vendor
       and mog.wh_place_carries(p.id, h.id);
    if v_n = 0 then
      if v_id is not null then
        delete from mog.wh_orders where id = v_id;
      end if;
      continue;
    end if;
    select g.vendor into v_vend
      from mog.order_log g
      join mog.items i on i.slug = g.slug and i.item_id = g.item_id
      join mog.wh_products p on p.id = i.wh_product
     where g.slug = p_slug and g.cycle_date = p_cycle and i.wh_place = h.id and g.vendor = i.wh_vendor
       and mog.wh_place_carries(p.id, h.id)
     order by g.seq, g.id limit 1;
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
     where g.slug = p_slug and g.cycle_date = p_cycle and i.wh_place = h.id and g.vendor = i.wh_vendor
       and mog.wh_place_carries(p.id, h.id);
    v_all := v_all + v_n;
  end loop;
  return v_all;
end;
$$;


-- v20's save without a product's par, stores and via (v21), and a place held
-- at a store saved under its own name, with no low point of its own.
create or replace function mog.wh_do_save(p_by text, p_kind text, p_row jsonb)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  v_id     bigint;
  v_name   text;
  v_pack   text;
  v_fee    numeric;
  v_pct    numeric;
  v_active boolean;
  v_have   bigint;
  v_last   text;
  v_ord    integer;
  v_held   numeric;
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
    v_fee := mog.wh_money(p_row -> 'handlingFee', 'The handling fee');
    v_active := mog.wh_bool(p_row -> 'active', 'Active', true);
    -- v21: a product's par, stores and via are retired (kept unread until
    -- v22); which stores take it, and from where, is each store's route.
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
      insert into mog.wh_products (name, pack, handling_fee, active, concept, updated_by)
      values (v_name, v_pack, v_fee, v_active, v_concept, p_by) returning id into v_id;
    else
      select p.version, p.updated_by into v_have, v_last from mog.wh_products p where p.id = v_id for update;
      if v_have is null then
        raise exception 'REJECTED: that product isn''t in the warehouse any more';
      end if;
      if v_have <> mog.wh_num(p_row -> 'version', 'The version') then
        raise exception 'CONFLICT: % was changed since you opened it (by %)', v_name, coalesce(v_last, 'someone');
      end if;
      update mog.wh_products
         set name = v_name, pack = v_pack, handling_fee = v_fee, active = v_active,
             concept = case when v_cset then v_concept else concept end,
             version = version + 1, updated_at = now(), updated_by = p_by
       where id = v_id;
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
        -- v21: a place held at a store refills at its holder's par, not a low point.
        if exists (select 1 from mog.wh_locations l where l.id = v_loc and l.held_store is not null) then
          v_low := 0;
        end if;
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
    -- v21: a place at a store is held under its own name; each store's
    -- route carries the vendor it orders it under.
    if (case when v_sset then v_store else (select l.held_store from mog.wh_locations l where l.id = v_id) end) is not null
       and (case when v_set then v_holder else (select l.held_by from mog.wh_locations l where l.id = v_id) end) is null then
      v_set := true;
      v_holder := v_name;
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
           or exists (select 1 from mog.wh_product_places pp where pp.location_id = v_id)
           or exists (select 1 from mog.items i where i.wh_place = v_id) then
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


-- v20's read, with every store's route (v21) and without a product's par,
-- stores and via.
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
               'id', p.id, 'name', p.name, 'pack', p.pack, 'avgCost', p.avg_cost,
               'handlingFee', p.handling_fee, 'active', p.active, 'version', p.version,
               'updatedAt', p.updated_at, 'updatedBy', p.updated_by,
               'stock', coalesce((select jsonb_object_agg(s.location_id::text, s.cases)
                                    from mog.wh_stock s where s.product_id = p.id and s.cases <> 0), '{}'::jsonb),
               'inTransit', mog.wh_in_transit(p.id),
               'lastReceipt', (select jsonb_build_object('ref', m.ref, 'at', m.at) from mog.wh_moves m
                                where m.product_id = p.id and m.kind = 'received' order by m.id desc limit 1))
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
    'routes', mog.wh_routes_json(),
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

-- v20's send, by the item's route (v21): a line's item routes to HEH's own
-- places under this vendor.
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
    -- v21: the store's Happy Supply is a vendor its routes to HEH's own places use.
    v_vend := p_order ->> 'vendor';
    if not exists (select 1 from mog.items i where i.slug = v_slug and i.wh_product is not null
                      and i.wh_place is null and i.wh_vendor = v_vend) then
      raise exception 'REJECTED: % isn''t this store''s Happy Supply', coalesce(v_vend, 'That vendor');
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
      -- v21: the item's route says where it comes from, and under which vendor.
      if it.wh_place is not null then
        raise exception 'REJECTED: % comes from %, not Happy Supply', it.name,
          (select l.name from mog.wh_locations l where l.id = it.wh_place);
      end if;
      if not it.active or it.wh_vendor is distinct from v_vend then
        raise exception 'REJECTED: % isn''t on Happy Supply''s list here', it.name;
      end if;
      select * into pr from mog.wh_products p where p.id = it.wh_product;
      if not exists (select 1 from mog.wh_product_places pp join mog.wh_locations l on l.id = pp.location_id
                      where pp.product_id = pr.id and l.held_by is null) then
        raise exception 'REJECTED: % isn''t kept at Happy Supply', it.name;
      end if;
      if not pr.active then
        raise exception 'REJECTED: Happy Supply doesn''t sell % now', it.name;
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


-- ---------------------------------------------------------------------
-- The routing through HQ's remembered names goes
-- ---------------------------------------------------------------------

drop function if exists mog.wh_item_place(text, text, bigint);
drop function if exists mog.wh_store_vendor(text);
drop function if exists mog.wh_held_vendor(text, text);


-- ---------------------------------------------------------------------
-- Privileges: lock the internals; v21 adds no entry point.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_wh_send(text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
