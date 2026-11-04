-- =====================================================================
-- MOG on Supabase — schema v19   (run AFTER schema.sql and v2 to v18)
-- =====================================================================
-- Elpis on one page (Sebastian, 2026-11-04; the "Checking deliveries in
-- apart from ordering, and Elpis set up on one page" row of the MOG HQ
-- redesign canvas). A product held at a vendor says which concept's stores
-- carry it (RP Large Bowls: Roll Play), so HQ's Elpis page links only that
-- concept's stores, by name. The links themselves go through mog_hq_apply as
-- before (catalogEdit.js), and the phone is unchanged.
--
-- Adds:
--   * mog.wh_products.concept: the concept whose stores carry it, null for
--     every concept. Saved by mog_wh_save (left out = unchanged), read in
--     the warehouse's state only when set.
--
-- Replaces (same signatures): mog.wh_do_save, mog.wh_state (from v17).
--
-- Writes no row. Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================

do $$
begin
  if to_regprocedure('public.mog_hq_remember(text)') is null then
    raise exception 'Run schema_v18.sql first: mog_hq_remember is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

alter table mog.wh_products add column if not exists concept text
  check (concept is null or (concept = btrim(concept) and length(concept) between 1 and 40));


-- ---------------------------------------------------------------------
-- The save and the read, from v17
-- ---------------------------------------------------------------------

-- A product, a location, a supplier, or the settings. id null = a new one.
--   product:  { id?, version?, name, pack, par, handlingFee, stores: [slug], active, via?, concept? }
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
  v_concept text;
  v_cset boolean;
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

-- v17's read, plus a product's concept (v19, only when it has one). v16's warehouse, plus who holds a location (heldBy, with its last real
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
             || case when p.concept is null then '{}'::jsonb else jsonb_build_object('concept', p.concept) end
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
-- Privileges: no new entry point; the internals stay closed.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

notify pgrst, 'reload schema';
