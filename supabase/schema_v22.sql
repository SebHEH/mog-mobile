-- =====================================================================
-- MOG on Supabase — schema v22   (run AFTER schema.sql and v2 to v21)
-- =====================================================================
-- An inactive HQ item or a closed place stops its routes (Sebastian,
-- 2026-11-05, "Stop and flag"): a route moves stock only while its HQ item
-- is active and its place is open. The routes stay on each store's item, so
-- making the item active again or reopening the place resumes them with no
-- store change; HQ shows the stopped ones on Stock's "Needs you"
-- (warehouse.js routeStatus). As in v13 to v21, the rules live HERE.
--
-- Before v22 the 3:30 AM close recorded deliveries from a closed place and
-- for an inactive item, while HQ called a closed place's routes broken.
--
-- Replaces (same signatures): mog.wh_held_from_log, mog.wh_live_json,
-- public.mog_wh_send (from v21), mog.wh_available_at (from v20).
--   * the close's step: nothing from a closed place or for an inactive item;
--   * the phone's read: a route from a closed place reads as unlinked (an
--     inactive item already did);
--   * available at HEH's own places, and Send to Happy Supply: open own
--     places only.
-- A delivery recorded before the item went inactive can still be checked
-- in: the cases did leave the place.
--
-- No table changes. Retired since v21 and still unread: mog.wh_products.via,
-- par and stores (dropped in v23).
--
-- Rollback: re-run v21's wh_held_from_log, wh_live_json and mog_wh_send,
-- and v20's wh_available_at. Writes no data; re-running is safe.
-- =====================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'mog' and table_name = 'items' and column_name = 'wh_vendor') then
    raise exception 'Run schema_v21.sql first: mog.items.wh_vendor is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- The close, the phone and Send: a route stops with its item or place
-- ---------------------------------------------------------------------

-- v17's close step: a held place's deliveries, from the order log lines of
-- the items whose route names that place, ordered under the route's vendor
-- (v21), never from the store that holds it; nothing from a closed place or
-- for an inactive HQ item (v22: its routes stop until it's open or active
-- again). A re-run for the same cycle deletes a delivery still open there.
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
  for h in select w.id, w.held_by, w.active from mog.wh_locations w
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
       and mog.wh_place_carries(p.id, h.id) and p.active and h.active;
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
       and mog.wh_place_carries(p.id, h.id) and p.active and h.active
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
       and mog.wh_place_carries(p.id, h.id) and p.active and h.active;
    v_all := v_all + v_n;
  end loop;
  return v_all;
end;
$$;

-- v17's phone read, from each item's route (v21): its Happy Supply vendor is
-- the one routing to HEH's own places, heldVendors the ones routing to a
-- held place, each item's cases from its route's place. Same shape as v20.
-- v22: a route stops while its HQ item is inactive or its place is closed
-- (then the item reads as a plain item, as an inactive one already did).
create or replace function mog.wh_live_json(p_slug text)
returns jsonb
language sql stable
set search_path = ''
as $$
  with st as (select s.cycle_date from mog.store_state s where s.slug = p_slug),
  linked as (
    select i.item_id, i.wh_product, i.wh_place, i.wh_vendor from mog.items i join mog.wh_products p on p.id = i.wh_product
     where i.slug = p_slug and i.active and p.active and i.wh_vendor is not null
       and (i.wh_place is null
            or exists (select 1 from mog.wh_locations w where w.id = i.wh_place and w.active))),
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

-- A product's cases a store can count on from one place. Null = Happy
-- Supply: HEH's own open locations (v22), minus what sent orders hold. A held place:
-- its cases, minus the deliveries from it no store has checked in. The
-- store's own order for p_cycle is left out. Never below 0.
create or replace function mog.wh_available_at(p_product bigint, p_place bigint, p_slug text, p_cycle date)
returns numeric
language sql stable
set search_path = ''
as $$
  select greatest(0, case when p_place is null then
      coalesce((select sum(s.cases) from mog.wh_stock s join mog.wh_locations l on l.id = s.location_id
                 where s.product_id = p_product and l.held_by is null and l.active), 0)
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
                      where pp.product_id = pr.id and l.held_by is null and l.active) then
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
-- Privileges: lock the internals; v22 adds no entry point.
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
