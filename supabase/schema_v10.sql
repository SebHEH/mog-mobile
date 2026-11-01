-- =====================================================================
-- MOG on Supabase — schema v10   (run AFTER schema.sql and v2 to v9)
-- =====================================================================
-- Vendor contacts: who to call at each vendor and how to order from it,
-- per store (a store's accounts are its own). Edited on the app's Vendors
-- page, shown on the phone's vendor card.
--
-- Adds:
--   * mog.vendors.contact: an object, {} = none. Its keys: person, phone,
--     email, orderVia (how to order, in words), orderEmail, website,
--     account, notes. Text only, trimmed, empty ones left out.
--   * mog.vendor_contact_clean(jsonb): the one rule for what a contact holds.
--   * mog.vendor_row_json(mog.vendors): a vendor as the editor reads it.
--
-- Replaces (same signatures):
--   * mog.tables_json, mog.editor_current: a vendor row carries `contact`
--     only when it has one, so every store's tables read exactly as before
--     until someone saves a contact.
--   * mog.editor_fields_match: a vendor's contact is compared too, and an
--     empty contact is the same as none. So Undo of an older vendor change
--     is refused (CONFLICT) instead of wiping a contact saved since.
--   * mog.editor_apply_ops (from v8): a vendor's insert and update write its
--     contact. Nothing else changes.
--   * mog.catalog_from_tables (from v4): the phone's catalog gains
--     vendorContacts {vendor: contact}, only when a vendor has one.
--
-- No new public function: contacts are saved with mog_editor_apply (logged
-- in Changes, undoable) and phones read them in the catalog.
-- Not covered: mog.copy_store_catalog (SQL Editor only, for test stores)
-- doesn't copy contacts.
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================

do $$
begin
  if to_regprocedure('mog.js_trim(text)') is null then
    raise exception 'Run schema_v9.sql first: mog.js_trim is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- The column
-- ---------------------------------------------------------------------

alter table mog.vendors add column if not exists contact jsonb not null default '{}'::jsonb
  check (jsonb_typeof(contact) = 'object');


-- ---------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------

-- What a contact may hold: the eight keys, text only, trimmed the way the
-- app trims (mog.js_trim), empty ones left out. Anything else is dropped.
-- Too long raises, so the whole save is refused.
create or replace function mog.vendor_contact_clean(p jsonb)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  k     text;
  v     text;
  v_max integer;
  v_out jsonb := '{}'::jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return v_out;
  end if;
  foreach k in array array['person', 'phone', 'email', 'orderVia', 'orderEmail', 'website', 'account', 'notes'] loop
    if jsonb_typeof(p -> k) = 'string' then
      v := mog.js_trim(p ->> k);
      v_max := case k when 'notes' then 500 else 200 end;
      if length(v) > v_max then
        raise exception 'Contact % is longer than % characters', k, v_max;
      end if;
      if v <> '' then
        v_out := v_out || jsonb_build_object(k, v);
      end if;
    end if;
  end loop;
  return v_out;
end;
$$;

-- A vendor as the editor reads it: contact only when it has one.
create or replace function mog.vendor_row_json(v mog.vendors)
returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object('name', v.name, 'mults', to_jsonb(v.mults), 'cutoff', v.cutoff)
         || case when v.contact <> '{}'::jsonb then jsonb_build_object('contact', v.contact) else '{}'::jsonb end;
$$;

-- The store's catalog tables (v6), vendors through mog.vendor_row_json.
create or replace function mog.tables_json(p_slug text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'vendors', coalesce((
      select jsonb_agg(mog.vendor_row_json(v)
                       order by v.name collate pg_catalog."und-x-icu", v.name)
        from mog.vendors v where v.slug = p_slug), '[]'::jsonb),
    'areas', coalesce((
      select jsonb_agg(jsonb_build_object('name', a.name, 'ord', a.ord) order by a.ord, a.name)
        from mog.areas a where a.slug = p_slug), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(mog.item_row_json(i) order by i.seq, i.item_id)
        from mog.items i where i.slug = p_slug), '[]'::jsonb),
    'pickRows', coalesce((
      select jsonb_agg(mog.pick_row_json(p) order by p.seq, p.vendor, p.item_id)
        from mog.pick_rows p where p.slug = p_slug), '[]'::jsonb));
$$;

-- The row a change is about, as stored now (v6), vendors as above.
create or replace function mog.editor_current(p_slug text, p_t text, p_row jsonb)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select case p_t
    when 'items' then (select mog.item_row_json(i) from mog.items i
                        where i.slug = p_slug and i.item_id = p_row ->> 'id')
    when 'pickRows' then (select mog.pick_row_json(p) from mog.pick_rows p
                           where p.slug = p_slug and p.vendor = p_row ->> 'vendor' and p.item_id = p_row ->> 'id')
    when 'vendors' then (select mog.vendor_row_json(v)
                           from mog.vendors v where v.slug = p_slug and v.name = p_row ->> 'name')
    when 'areas' then (select jsonb_build_object('name', a.name, 'ord', a.ord)
                         from mog.areas a where a.slug = p_slug and a.name = p_row ->> 'name')
  end;
$$;

-- Does the stored row still look the way the editor read it? Every field
-- but seq. An empty string, an empty contact and null are the same, and a
-- contact is compared clean (Undo replays a change exactly as it was sent).
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
      when 'items'    then array['name','primaryVendor','pack','par','active','useMult','notes','sku','category','eligible']
      when 'pickRows' then array['area','shelfOrder']
      when 'vendors'  then array['mults','cutoff','contact']
      when 'areas'    then array['ord'] end) f;
$$;

-- Apply ops to a store's tables (v8), a vendor's contact written too.
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
    if op ? 'rename' then
      if op ->> 'rename' is distinct from 'areas' or jsonb_typeof(op -> 'from') is distinct from 'string'
         or jsonb_typeof(op -> 'to') is distinct from 'string' then
        raise exception 'BAD_OP: %', left(op::text, 200);
      end if;
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
                               notes, sku, category, eligible_vendors, seq)
        values (p_slug, v_a ->> 'id', coalesce(v_a ->> 'name', ''), nullif(v_a ->> 'primaryVendor', ''),
                coalesce(v_a ->> 'pack', ''), (v_a ->> 'par')::numeric,
                coalesce((v_a ->> 'active')::boolean, true), coalesce((v_a ->> 'useMult')::boolean, true),
                coalesce(v_a ->> 'notes', ''), coalesce(v_a ->> 'sku', ''), coalesce(v_a ->> 'category', ''),
                mog.json_text_array(v_a -> 'eligible'),
                coalesce((v_a ->> 'seq')::integer,
                         (select coalesce(max(i.seq), 0) + 1 from mog.items i where i.slug = p_slug)));
      else
        update mog.items
           set name = coalesce(v_a ->> 'name', ''), primary_vendor = nullif(v_a ->> 'primaryVendor', ''),
               pack = coalesce(v_a ->> 'pack', ''), par = (v_a ->> 'par')::numeric,
               active = coalesce((v_a ->> 'active')::boolean, true), use_mult = coalesce((v_a ->> 'useMult')::boolean, true),
               notes = coalesce(v_a ->> 'notes', ''), sku = coalesce(v_a ->> 'sku', ''),
               category = coalesce(v_a ->> 'category', ''), eligible_vendors = mog.json_text_array(v_a -> 'eligible')
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

-- The catalog phones read (v4), plus vendorContacts when a vendor has one.
create or replace function mog.catalog_from_tables(p_slug text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'schema',   1,
    'timeZone', coalesce(nullif(s.time_zone, ''), 'America/New_York'),
    'location', coalesce(s.location, 'Unknown'),
    'abbr',     coalesce(s.abbr, ''),
    'concept',  coalesce(s.concept, ''),
    'vendorList', coalesce((
      select jsonb_agg(v.name order by v.name collate pg_catalog."und-x-icu", v.name)
        from mog.vendors v where v.slug = s.slug), '[]'::jsonb),
    'vendorMults', coalesce((
      select jsonb_object_agg(v.name, jsonb_build_object(
               'Mon', v.mults[1], 'Tue', v.mults[2], 'Wed', v.mults[3], 'Thu', v.mults[4],
               'Fri', v.mults[5], 'Sat', v.mults[6], 'Sun', v.mults[7]))
        from mog.vendors v where v.slug = s.slug), '{}'::jsonb),
    'cutoffs', coalesce((
      select jsonb_object_agg(v.name, v.cutoff)
        from mog.vendors v where v.slug = s.slug), '{}'::jsonb),
    'items', coalesce((
      select jsonb_object_agg(i.item_id, jsonb_build_object(
               'useMult',       i.use_mult,
               'par',           i.par,
               'name',          i.name,
               'pack',          i.pack,
               'primaryVendor', coalesce(i.primary_vendor, ''),
               'active',        i.active))
        from mog.items i where i.slug = s.slug), '{}'::jsonb),
    'pickRows', coalesce((
      select jsonb_agg(jsonb_build_array(p.vendor, p.item_id, i.name, coalesce(p.area, ''), a.ord, p.shelf_order)
                       order by p.seq, p.vendor, p.item_id)
        from mog.pick_rows p
        join mog.items i      on i.slug = p.slug and i.item_id = p.item_id
        left join mog.areas a on a.slug = p.slug and a.name = p.area
       where p.slug = s.slug), '[]'::jsonb),
    'itemCounts', coalesce((
      select jsonb_object_agg(x.vendor, x.n)
        from (select i.primary_vendor as vendor, count(*) as n
                from mog.items i
               where i.slug = s.slug and i.active and i.primary_vendor is not null
               group by i.primary_vendor) x), '{}'::jsonb),
    'backupCounts', coalesce((
      select jsonb_object_agg(x.vendor, x.n)
        from (select p.vendor, count(*) as n
                from mog.pick_rows p
                join mog.items i on i.slug = p.slug and i.item_id = p.item_id
               where p.slug = s.slug and i.active and i.primary_vendor is distinct from p.vendor
               group by p.vendor) x), '{}'::jsonb))
    || (select case when count(*) = 0 then '{}'::jsonb
                    else jsonb_build_object('vendorContacts', jsonb_object_agg(v.name, v.contact)) end
          from mog.vendors v where v.slug = s.slug and v.contact <> '{}'::jsonb)
  from mog.stores s
 where s.slug = p_slug;
$$;

-- ---------------------------------------------------------------------
-- Privileges: no new entry point. Lock the new helpers like every other
-- internal.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

notify pgrst, 'reload schema';
