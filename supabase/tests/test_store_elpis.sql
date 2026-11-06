-- =====================================================================
-- MOG — the TEST store's held-place deliveries (run in the SQL Editor)
-- =====================================================================
-- For first use on Rosslyn FOH (TEST), 'rprfotest' (2026-11-03; read by
-- route since schema v21, 2026-11-05). The TEST store has no Sheet, so no
-- 3:30 AM close ever runs there (D21). This file stands in for two nights'
-- closes: it writes the TEST store's order log for the two days before
-- today and runs the close's own step, mog.wh_held_from_log, for each, so
-- its "To check in" list and HQ's Stock page get two open deliveries per
-- held place (Elpis, or a place held at another store).
--
-- Run it after HQ has routed at least one TEST item from a held place:
-- HQ → HEH STOCK → Items → the item → its Stores table → Rosslyn FOH
-- (TEST), from that place, under the TEST store's vendor for it. It orders
-- every active TEST item routed from a held place, under its route's
-- vendor: 2 cases each two days ago, 1 case each yesterday.
--
-- Refuses any store that isn't a test store, and stops before writing
-- anything when there's nothing to deliver. Answers one line per step.
--
-- What it writes stays. Re-running replaces those two days' log lines for
-- the routes' vendors and any delivery still open (a received one stays),
-- and clears the TEST store's counts and today edits again
-- (prepare_test_store). Checking a delivery in takes its cases out of the
-- held place, so count the place again afterwards.
-- =====================================================================

create or replace function pg_temp.test_store_held_deliveries(p_slug text)
returns setof text
language plpgsql
as $$
declare
  s      mog.stores%rowtype;
  v_tz   text;
  v_day  date;
  v_on   date;
  v_n    integer;
  v_k    integer;
begin
  select * into s from mog.stores where slug = p_slug;
  if not found then
    raise exception 'No store %', p_slug;
  end if;
  if not s.is_test then
    raise exception 'Store % is a real store; refusing', p_slug;
  end if;
  v_tz := coalesce(nullif(s.time_zone, ''), 'America/New_York');
  v_day := (now() at time zone v_tz)::date;

  -- Checked before anything is written: the routes the close would read.
  create temp table if not exists test_store_routes (item_id text, name text, pack text, vendor text, place bigint, product bigint)
    on commit drop;
  delete from test_store_routes;
  insert into test_store_routes
  select i.item_id, i.name, i.pack, i.wh_vendor, w.id, i.wh_product
    from mog.items i
    join mog.wh_locations w on w.id = i.wh_place
   where i.slug = p_slug and i.active and i.wh_product is not null and i.wh_vendor is not null
     and w.held_by is not null and w.held_store is distinct from p_slug
     and mog.wh_place_carries(i.wh_product, w.id);
  if not exists (select 1 from test_store_routes) then
    raise exception 'Nothing to deliver: no active item at % is routed from a held place (HQ → Items → the item''s Stores table first)',
      s.location;
  end if;

  for v_k in reverse 2 .. 1 loop
    v_on := v_day - v_k;
    delete from mog.order_log g
     where g.slug = p_slug and g.cycle_date = v_on and g.vendor in (select r.vendor from test_store_routes r);
    insert into mog.order_log (slug, cycle_date, seq, vendor, item_id, item_name, pack, area, on_hand_prev, qty_ordered, logged_at)
    select p_slug, v_on, row_number() over (order by i.seq, i.item_id), r.vendor, r.item_id, r.name, r.pack,
           coalesce((select pr.area from mog.pick_rows pr
                      where pr.slug = p_slug and pr.vendor = r.vendor and pr.item_id = r.item_id limit 1), ''),
           0, v_k, ((v_on + 1) + time '03:30') at time zone v_tz
      from test_store_routes r
      join mog.items i on i.slug = p_slug and i.item_id = r.item_id;
    get diagnostics v_n = row_count;
    perform mog.wh_held_from_log(p_slug, v_on);
    return next format('%s: %s order-log lines, %s', to_char(v_on, 'Dy YYYY-MM-DD'), v_n,
      coalesce((select string_agg(o.number || ' ' || o.status || ' (' ||
                                  (select string_agg(l.item_name || ' ' || l.cases, ', ' order by l.ord)
                                     from mog.wh_order_lines l where l.order_id = o.id) || ')', '; ' order by o.id)
                  from mog.wh_orders o where o.slug = p_slug and o.cycle_date = v_on and o.held_at is not null),
               'no delivery'));
  end loop;

  return next mog.prepare_test_store(p_slug);
  return next 'Held stock now: ' || coalesce((
    select string_agg(p.name || ' ' || coalesce(st.cases, 0) || ' at ' || w.name, ', ' order by lower(p.name), w.name)
      from (select distinct product, place from test_store_routes) r
      join mog.wh_products p on p.id = r.product
      join mog.wh_locations w on w.id = r.place
      left join mog.wh_stock st on st.product_id = r.product and st.location_id = r.place), 'none');
end;
$$;

select * from pg_temp.test_store_held_deliveries('rprfotest');
