-- =====================================================================
-- MOG — the TEST store's Elpis deliveries (run in the SQL Editor)
-- =====================================================================
-- For W2b's first use on Rosslyn FOH (TEST), 'rprfotest' (2026-11-03).
-- The TEST store has no Sheet, so no 3:30 AM close ever runs there (D21).
-- This file stands in for two nights' closes: it writes the TEST store's
-- order log for the two days before today and runs the close's own step,
-- mog.wh_held_from_log, for each, so its Elpis card and HQ's Elpis page
-- get two open deliveries (EL-0001 and EL-0002 on a database with none).
-- Then mog.prepare_test_store gives it today's cycle with its phones on.
--
-- Run it after HQ's steps 1-4 (docs/MOG_SessionHandoff_2026_11_03.md,
-- Outstanding 2): a location held by a vendor, products ordered through
-- it, and the TEST store's items linked with Send to stores. It orders
-- every active TEST item linked to a product held there, from the TEST
-- store's vendor for that holder: 2 cases each two days ago, 1 case each
-- yesterday.
--
-- Refuses any store that isn't a test store, and stops before writing
-- anything when there's nothing to deliver. Answers one line per step.
--
-- What it writes stays. Re-running replaces those two days' log lines and
-- any delivery still open (a received one stays), and clears the TEST
-- store's counts and today edits again (prepare_test_store). Marking a
-- delivery received takes its cases out of the held location, so count
-- the location again afterwards.
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
  h      record;
  v_vend text;
  v_n    integer;
  v_k    integer;
  v_any  boolean := false;
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

  -- Everything is checked before anything is written.
  for h in select w.id, w.name, w.held_by from mog.wh_locations w where w.held_by is not null order by w.id loop
    v_vend := mog.wh_held_vendor(p_slug, h.held_by);
    select count(*) into v_n
      from mog.items i join mog.wh_products p on p.id = i.wh_product
     where i.slug = p_slug and i.active and lower(p.via) = lower(h.held_by);
    if v_n > 0 and v_vend is null then
      raise exception '% has items linked to products held by % but no vendor for it: Send to stores picks it the first time',
        s.location, h.held_by;
    end if;
    if v_n > 0 and not exists (select 1 from mog.vendors v where v.slug = p_slug and v.name = v_vend) then
      raise exception '%''s vendor for % is "%", which it no longer has', s.location, h.held_by, v_vend;
    end if;
    v_any := v_any or v_n > 0;
  end loop;
  if not v_any then
    raise exception 'Nothing to deliver: no active item at % is linked to a product held at a location with a holder (HQ steps 1-4 first)',
      s.location;
  end if;

  for v_k in reverse 2 .. 1 loop
    v_on := v_day - v_k;
    delete from mog.order_log g
     where g.slug = p_slug and g.cycle_date = v_on
       and g.vendor in (select mog.wh_held_vendor(p_slug, w.held_by) from mog.wh_locations w where w.held_by is not null);
    insert into mog.order_log (slug, cycle_date, seq, vendor, item_id, item_name, pack, area, on_hand_prev, qty_ordered, logged_at)
    select p_slug, v_on, row_number() over (order by i.seq, i.item_id), x.vendor, i.item_id, i.name, i.pack,
           coalesce((select r.area from mog.pick_rows r
                      where r.slug = p_slug and r.vendor = x.vendor and r.item_id = i.item_id limit 1), ''),
           0, v_k, ((v_on + 1) + time '03:30') at time zone v_tz
      from mog.items i
      join mog.wh_products p on p.id = i.wh_product
      join mog.wh_locations w on lower(w.held_by) = lower(p.via)
      cross join lateral (select mog.wh_held_vendor(p_slug, w.held_by) as vendor) x
     where i.slug = p_slug and i.active and x.vendor is not null;
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
    select string_agg(p.name || ' ' || coalesce(st.cases, 0) || ' at ' || w.name, ', ' order by lower(p.name))
      from mog.wh_products p
      join mog.wh_locations w on lower(w.held_by) = lower(p.via)
      left join mog.wh_stock st on st.product_id = p.id and st.location_id = w.id
     where p.id in (select i.wh_product from mog.items i where i.slug = p_slug and i.active)), 'none');
end;
$$;

select * from pg_temp.test_store_held_deliveries('rprfotest');
