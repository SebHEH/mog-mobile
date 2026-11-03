-- =====================================================================
-- MOG on Supabase — schema v16   (run AFTER schema.sql and v2 to v15)
-- =====================================================================
-- Happy Supply W2a, store orders (docs/MOG_Warehouse_Spec.md §2, "W2 spec"
-- and "W2a design", approved by Sebastian 2026-11-02): a store item linked
-- to a warehouse product, the phone's Send to Happy Supply (sent, then
-- shipped, then received; no Approve step), Dan's Ship from a location
-- (stock drops, the price locks) and the store's Mark received, plus the
-- cases available that a phone shows on each linked item. As in v13, the
-- rules live HERE: the handling fee and the prices never reach a phone,
-- the price locks on the server, and stock never goes below 0.
--
-- Adds:
--   * mog.items.wh_product: the warehouse product a store item comes from
--     (null = none). It is part of the item's row, as v14's lto is: an
--     edit keeps it, a store's Undo brings it back with the item, and an
--     item added later under a reused number never has it. HQ sets it
--     (catalogEdit.js hqRollout, hqLinkItems) through mog_hq_apply.
--   * mog.wh_orders / wh_order_lines: a store's Happy Supply order
--     (HS-0001) and its lines. sent -> shipped -> received, or cancelled
--     while sent. A line keeps the store's item and name, the product, the
--     cases ordered, shipped (and from where) and received, and, at ship,
--     the price per case and the average cost.
--   * mog.wh_store_vendor: a store's Happy Supply is the vendor HQ's
--     "Happy Supply" maps to in mog.hq_vendor_links (it follows a rename
--     and leaves with the vendor).
--   * mog.wh_available: a product's cases at every location minus what
--     sent orders hold, leaving out the asking store's own order this
--     cycle (the one it may be replacing).
--   * mog.wh_store_price: (average cost + handling fee) x (1 + markup %),
--     to the cent; hq/warehouse.js storePrice is the same sum.
--   * mog_wh_send(token, order) and mog_wh_received(token, receipt): the
--     phone, with its PIN session. Sending again the same cycle replaces
--     the order while it's still sent.
--   * mog_wh_ship(token, ship) and mog_wh_order_cancel(token, id, version):
--     Dan, with the warehouse role.
--
-- Replaces (same signatures):
--   * mog.item_row_json (from v14): an item carries `whProduct` only when it
--     has one, so every store's tables read exactly as before.
--   * mog.editor_fields_match (from v14): an item's whProduct is compared.
--   * mog.editor_apply_ops (from v15): an item's insert and update write it.
--   * mog.live_json (from v9): `happySupply` (the vendor, each linked item's
--     product and cases available, the open orders and this cycle's), only
--     for a store with a linked item or an order.
--   * mog.wh_state (from v13): the orders (open ones and the last 30
--     closed), with their prices, for Dan's Orders page.
--   * mog.wh_next_number (from v13): HS-0001 too.
--
-- Writes no store data. Not covered: mog.copy_store_catalog (SQL Editor
-- only, for test stores) doesn't copy an item's link.
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================

do $$
begin
  if to_regclass('mog.ltos') is null or to_regclass('mog.wh_products') is null
     or position('in (''areas'', ''vendors'')' in pg_get_functiondef('mog.editor_apply_ops(text, jsonb)'::regprocedure)) = 0 then
    raise exception 'Run schema_v15.sql first: the vendor rename step is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

alter table mog.items add column if not exists wh_product bigint references mog.wh_products (id) on delete set null;
create index if not exists items_wh_product_idx on mog.items (wh_product) where wh_product is not null;

create table if not exists mog.wh_orders (
  id           bigint generated always as identity primary key,
  number       text not null unique,                  -- HS-0001
  slug         text not null references mog.stores (slug) on delete cascade,
  vendor       text not null,                         -- the store's name for Happy Supply when sent
  cycle_date   date not null,
  needed_by    date,
  note         text not null default '' check (length(note) <= 300),
  status       text not null default 'sent' check (status in ('sent', 'shipped', 'received', 'cancelled')),
  sent_at      timestamptz not null default now(),
  sent_by      text,                                  -- the name on the phone, if it has one
  shipped_at   timestamptz,
  shipped_by   text,
  delivery_fee numeric check (delivery_fee >= 0),     -- per order, set at ship (W3 bills it)
  received_at  timestamptz,
  received_by  text,
  cancelled_at timestamptz,
  cancelled_by text,
  version      bigint not null default 1
);
-- One open order per store and cycle: sending again replaces it.
create unique index if not exists wh_orders_one_sent on mog.wh_orders (slug, cycle_date) where status = 'sent';
create index if not exists wh_orders_slug_idx on mog.wh_orders (slug, id desc);

create table if not exists mog.wh_order_lines (
  order_id       bigint not null references mog.wh_orders (id) on delete cascade,
  ord            integer not null,
  item_id        text not null,                       -- the store's item, as sent
  item_name      text not null,
  product_id     bigint not null references mog.wh_products (id),
  cases          numeric not null check (cases > 0),  -- ordered
  cases_shipped  numeric check (cases_shipped >= 0),
  location_id    bigint references mog.wh_locations (id),
  price          numeric check (price >= 0),          -- per case, locked at ship
  avg_cost       numeric check (avg_cost >= 0),       -- the product's, at ship
  cases_received numeric check (cases_received >= 0),
  primary key (order_id, ord)
);
create index if not exists wh_order_lines_product_idx on mog.wh_order_lines (product_id);

alter table mog.wh_orders      enable row level security;
alter table mog.wh_order_lines enable row level security;


-- ---------------------------------------------------------------------
-- An item's row: whProduct only when it has one
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
    || case when i.wh_product is not null then jsonb_build_object('whProduct', i.wh_product) else '{}'::jsonb end;
$$;

-- Does the stored row still look the way the editor read it (v10), an
-- item's lto (v14) and whProduct too.
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
      when 'items'    then array['name','primaryVendor','pack','par','active','useMult','notes','sku','category','eligible','lto','whProduct']
      when 'pickRows' then array['area','shelfOrder']
      when 'vendors'  then array['mults','cutoff','contact']
      when 'areas'    then array['ord'] end) f;
$$;

-- Apply ops to a store's tables (v15), an item's whProduct written too.
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
      end if;
      if v_a is null then
        delete from mog.items where slug = p_slug and item_id = v_b ->> 'id';
      elsif v_b is null then
        insert into mog.items (slug, item_id, name, primary_vendor, pack, par, active, use_mult,
                               notes, sku, category, eligible_vendors, seq, lto, wh_product)
        values (p_slug, v_a ->> 'id', coalesce(v_a ->> 'name', ''), nullif(v_a ->> 'primaryVendor', ''),
                coalesce(v_a ->> 'pack', ''), (v_a ->> 'par')::numeric,
                coalesce((v_a ->> 'active')::boolean, true), coalesce((v_a ->> 'useMult')::boolean, true),
                coalesce(v_a ->> 'notes', ''), coalesce(v_a ->> 'sku', ''), coalesce(v_a ->> 'category', ''),
                mog.json_text_array(v_a -> 'eligible'),
                coalesce((v_a ->> 'seq')::integer,
                         (select coalesce(max(i.seq), 0) + 1 from mog.items i where i.slug = p_slug)),
                nullif(v_a ->> 'lto', ''), (v_a ->> 'whProduct')::bigint);
      else
        update mog.items
           set name = coalesce(v_a ->> 'name', ''), primary_vendor = nullif(v_a ->> 'primaryVendor', ''),
               pack = coalesce(v_a ->> 'pack', ''), par = (v_a ->> 'par')::numeric,
               active = coalesce((v_a ->> 'active')::boolean, true), use_mult = coalesce((v_a ->> 'useMult')::boolean, true),
               notes = coalesce(v_a ->> 'notes', ''), sku = coalesce(v_a ->> 'sku', ''),
               category = coalesce(v_a ->> 'category', ''), eligible_vendors = mog.json_text_array(v_a -> 'eligible'),
               lto = nullif(v_a ->> 'lto', ''), wh_product = (v_a ->> 'whProduct')::bigint
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
-- Internal: Happy Supply at a store
-- ---------------------------------------------------------------------

-- The store's vendor that HQ's "Happy Supply" maps to, or null.
create or replace function mog.wh_store_vendor(p_slug text)
returns text
language sql stable
set search_path = ''
as $$
  select k.vendor from mog.hq_vendor_links k where k.slug = p_slug and lower(k.hq_name) = 'happy supply';
$$;

-- What a store pays per case when it ships. hq/warehouse.js storePrice is
-- the same sum.
create or replace function mog.wh_store_price(p_avg numeric, p_fee numeric, p_markup_pct numeric)
returns numeric
language sql immutable
set search_path = ''
as $$
  select round((coalesce(p_avg, 0) + coalesce(p_fee, 0)) * (1 + coalesce(p_markup_pct, 0) / 100), 2);
$$;

-- A product's cases a store can count on: every location's, minus what
-- sent orders hold, leaving out the store's own order for p_cycle (the one
-- its phone may be replacing). Never below 0.
create or replace function mog.wh_available(p_product bigint, p_slug text, p_cycle date)
returns numeric
language sql stable
set search_path = ''
as $$
  select greatest(0,
    coalesce((select sum(s.cases) from mog.wh_stock s where s.product_id = p_product), 0)
    - coalesce((select sum(l.cases) from mog.wh_order_lines l join mog.wh_orders o on o.id = l.order_id
                 where l.product_id = p_product and o.status = 'sent'
                   and not (o.slug = p_slug and o.cycle_date is not distinct from p_cycle)), 0));
$$;

-- An order as its store's phone sees it: no price, no fee, no cost.
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
    from mog.wh_orders o where o.id = p_id;
$$;

-- The phone's Happy Supply part of its 10-second read, or {} for a store
-- with no linked item and no order: its Happy Supply vendor, each linked
-- item's product and cases available, and its orders still open plus the
-- ones of this cycle, newest first.
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
     where o.slug = p_slug and (o.status in ('sent', 'shipped') or o.cycle_date = (select cycle_date from st))
     order by o.sent_at desc, o.id desc limit 10)
  select case when not exists (select 1 from linked) and not exists (select 1 from ords) then '{}'::jsonb
    else jsonb_build_object('happySupply', jsonb_build_object(
      'vendor', mog.wh_store_vendor(p_slug),
      'items', coalesce((
        select jsonb_object_agg(l.item_id, jsonb_build_object(
                 'productId', l.wh_product,
                 'available', mog.wh_available(l.wh_product, p_slug, (select cycle_date from st))))
          from linked l), '{}'::jsonb),
      'orders', coalesce((select jsonb_agg(mog.wh_order_phone_json(x.id) order by x.sent_at desc, x.id desc) from ords x),
                         '[]'::jsonb)))
  end;
$$;

-- v9's live data (presence, people, activity), plus Happy Supply.
create or replace function mog.live_json(p_slug text, p_device text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'presence', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', p.name, 'vendor', p.vendor,
               'secondsAgo', floor(extract(epoch from (now() - p.seen_at)))::int)
             order by p.seen_at desc)
        from mog.presence p
       where p.slug = p_slug and p.device_id <> coalesce(p_device, '')
         and p.seen_at > now() - interval '90 seconds'), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(sp.name order by lower(sp.name), sp.name)
        from mog.store_people sp
       where sp.slug = p_slug and sp.removed_at is null and sp.renamed_to is null
         and sp.last_used > now() - interval '30 days'), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object(
               'vendor', a.vendor, 'by', a.counted_by,
               'secondsAgo', floor(extract(epoch from (now() - a.updated_at)))::int)
             order by a.vendor)
        from (select distinct on (k.vendor) k.vendor, k.counted_by, k.updated_at
                from mog.counts k
                join mog.store_state st on st.slug = k.slug and st.cycle_date = k.cycle_date
               where k.slug = p_slug and k.counted_by is not null
               order by k.vendor, k.updated_at desc) a), '[]'::jsonb))
  || mog.wh_live_json(p_slug);
$$;


-- ---------------------------------------------------------------------
-- Internal: the orders as Dan's page reads them
-- ---------------------------------------------------------------------

-- The next PO-0001, TR-0001 or HS-0001, one at a time (v13). Numbers come
-- from what's there, so nothing is used up by a save that's refused.
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
  elsif p_prefix = 'HS' then
    select coalesce(max(substr(number, 4)::integer), 0) + 1 into v from mog.wh_orders;
  else
    select coalesce(max(substr(number, 4)::integer), 0) + 1 into v from mog.wh_transfers;
  end if;
  return p_prefix || '-' || lpad(v::text, greatest(4, length(v::text)), '0');
end;
$$;

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
             order by x.ord)
        from mog.wh_order_lines x
        join mog.wh_products p on p.id = x.product_id
        left join mog.wh_locations l on l.id = x.location_id
       where x.order_id = o.id), '[]'::jsonb))
    from mog.wh_orders o join mog.stores s on s.slug = o.slug
   where o.id = p_id;
$$;

-- The open orders and the last 30 closed, newest first.
create or replace function mog.wh_orders_json()
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(mog.wh_order_json(x.id) order by x.id desc), '[]'::jsonb)
    from (select id from mog.wh_orders where status in ('sent', 'shipped')
          union all
          (select id from mog.wh_orders where status in ('received', 'cancelled') order by id desc limit 30)) x;
$$;

-- v13's warehouse, plus the orders.
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
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object('slug', s.slug, 'location', s.location, 'concept', coalesce(s.concept, ''),
                                          'side', s.side, 'isTest', s.is_test)
                       order by coalesce(s.concept, ''), s.is_test, s.location, s.slug)
        from mog.stores s), '[]'::jsonb));
$$;


-- ---------------------------------------------------------------------
-- Internal: Dan's writes (raise REJECTED: / CONFLICT:)
-- ---------------------------------------------------------------------

-- Ship a sent order: { id, version, lines: [{ ord, cases, locationId }] },
-- every line once (0 = none of it). A line ships at most what was ordered,
-- from one location, never taking it below 0; its price locks.
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

-- Cancel an order that hasn't shipped.
create or replace function mog.wh_do_order_cancel(p_by text, p_id bigint, p_version bigint)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  o mog.wh_orders%rowtype;
begin
  select * into o from mog.wh_orders where id = p_id for update;
  if not found then
    raise exception 'REJECTED: that order isn''t there any more';
  end if;
  if o.version is distinct from p_version then
    raise exception 'CONFLICT: % changed since you opened it', o.number;
  end if;
  if o.status <> 'sent' then
    raise exception 'CONFLICT: % is % already', o.number, o.status;
  end if;
  update mog.wh_orders set status = 'cancelled', cancelled_at = now(), cancelled_by = p_by, version = version + 1
   where id = o.id;
  return jsonb_build_object('orderId', o.id, 'number', o.number);
end;
$$;


-- ---------------------------------------------------------------------
-- Public: Dan (warehouse role)
-- ---------------------------------------------------------------------

create or replace function public.mog_wh_ship(p_token text, p_ship jsonb)
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
    v_done := mog.wh_do_ship(v_name, p_ship);
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return mog.wh_answer(v_name, v_done);
end;
$$;

create or replace function public.mog_wh_order_cancel(p_token text, p_id bigint, p_version bigint)
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
    v_done := mog.wh_do_order_cancel(v_name, p_id, p_version);
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return mog.wh_answer(v_name, v_done);
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

-- Mark received: { id, by, lines: [{ ord, cases }] }, a shipped order of
-- this store's. A line left out arrived as shipped; one can't be more than
-- shipped. Received already (another phone): answers as it stands.
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
    if o.status <> 'received' then
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
         set status = 'received', received_at = now(),
             received_by = nullif(left(mog.wh_text(p_receipt -> 'by', 'The name', 200), 40), ''), version = version + 1
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
-- Privileges: lock the new tables and internals, open exactly the
-- entry points.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_wh_ship(text, jsonb)',
    'public.mog_wh_order_cancel(text, bigint, bigint)',
    'public.mog_wh_send(text, jsonb)',
    'public.mog_wh_received(text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
