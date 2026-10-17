-- =====================================================================
-- MOG on Supabase — schema v4   (run AFTER schema.sql, v2 and v3)
-- =====================================================================
-- Step 6, part 1: the catalog moves into real tables (design record
-- D15-D17, D19-D22). Nothing here changes what a phone or the Sheet does
-- today. The tables stay inert until a store's editor_direct switch is on,
-- and no function turns that on yet.
--
-- Adds:
--   * Tables mog.vendors, mog.areas, mog.items, mog.pick_rows, which hold the
--     catalog the Sheet keeps in MASTER_ITEMS and SETUP. They are normalized,
--     with the rules enforced by the database: a pick row points at a real
--     vendor, item and storage area. Its area order and item name are looked
--     up, not stored per row, so they can't drift (the col-O drift finding).
--   * mog.stores gains the store profile the catalog JSON carries (time zone,
--     location, abbr, concept), plus editor_direct (off) and is_test.
--   * mog.catalog_from_tables(slug): builds today's catalog JSON (schema 1,
--     design record section 6) from the tables, so phones don't change.
--   * mog_sync_seed_catalog: Apps Script copies the Sheet's catalog into the
--     tables in one transaction and gets the built JSON back (the live parity
--     gate, Sync.gs test_catalogTablesParity). Refused once editor_direct is on.
--   * mog_sync_get_status: switches plus the stored catalog, for the Store
--     Health Check.
--   * mog.copy_store_catalog: SQL Editor only. Copies a store's seeded catalog
--     to a test store that has no Sheet (D21).
--
-- REPLACES mog_sync_push_catalog (same signature): once a store's
-- editor_direct is on, the Sheet can no longer overwrite its catalog.
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================


-- The vendor list must sort exactly as JS localeCompare does, which takes
-- ICU's root collation. Stop here, before anything changes, if it's missing.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_collation where collname = 'und-x-icu') then
    raise exception 'This database has no ICU root collation (und-x-icu); schema v4 needs it to sort vendors like the app does.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Store profile + switches
-- ---------------------------------------------------------------------

alter table mog.stores add column if not exists time_zone     text;
alter table mog.stores add column if not exists location      text;
alter table mog.stores add column if not exists abbr          text;
alter table mog.stores add column if not exists concept       text;
alter table mog.stores add column if not exists editor_direct boolean not null default false;  -- Supabase owns the catalog (D16)
alter table mog.stores add column if not exists is_test       boolean not null default false;  -- made by copy_store_catalog; no Sheet behind it


-- ---------------------------------------------------------------------
-- Catalog tables
-- ---------------------------------------------------------------------

-- Was SETUP Z (name), S:Y (Mon..Sun day multipliers), AA (cutoff "HH:MM").
create table if not exists mog.vendors (
  slug    text not null references mog.stores (slug) on delete cascade,
  name    text not null check (name = btrim(name) and name <> '' and length(name) <= 100),
  mults   numeric[] not null default '{0,0,0,0,0,0,0}'
          check (array_length(mults, 1) = 7 and array_position(mults, null) is null),
  cutoff  text check (cutoff ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  primary key (slug, name)
);
create unique index if not exists vendors_name_ci on mog.vendors (slug, lower(name));

-- Was SETUP H:I (storage area, area order).
create table if not exists mog.areas (
  slug  text not null references mog.stores (slug) on delete cascade,
  name  text not null check (name = btrim(name) and name <> '' and length(name) <= 100),
  ord   numeric not null,
  primary key (slug, name)
);
create unique index if not exists areas_name_ci on mog.areas (slug, lower(name));

-- Was MASTER_ITEMS: A id, B name, C primary vendor, D sku, E pack, F category,
-- G par, L active, M use multiplier, N notes, O eligible vendors.
create table if not exists mog.items (
  slug             text not null references mog.stores (slug) on delete cascade,
  item_id          text not null check (item_id = btrim(item_id) and item_id <> '' and length(item_id) <= 100),
  name             text not null default '' check (length(name) <= 300),
  primary_vendor   text,                          -- null = none
  pack             text not null default '',
  par              numeric,                       -- null = not a number (the phone reads it as NaN)
  active           boolean not null default true,
  use_mult         boolean not null default true,
  notes            text not null default '',
  sku              text not null default '',      -- kept for the nightly copy back to the Sheet (D17)
  category         text not null default '',      -- same
  eligible_vendors text[] not null default '{}',  -- primary first; who the item MAY be ordered from
  seq              integer not null,              -- MASTER_ITEMS row order
  primary key (slug, item_id),
  foreign key (slug, primary_vendor) references mog.vendors (slug, name) on update cascade
);

-- Was SETUP K:P. One row = this item sits on this vendor's list. Item name
-- and area order are NOT stored here: catalog_from_tables looks them up.
-- Deleting a storage area deletes its pick rows, as the Sheet's area editor
-- does (commitStorageAreasDraft_); renaming one carries its rows along.
create table if not exists mog.pick_rows (
  slug         text not null references mog.stores (slug) on delete cascade,
  vendor       text not null,
  item_id      text not null,
  area         text,                              -- null = no storage area
  shelf_order  numeric,                           -- null = blank (sorts last)
  seq          integer not null,                  -- SETUP K:P row order
  primary key (slug, vendor, item_id),
  foreign key (slug, vendor)  references mog.vendors (slug, name)  on update cascade on delete cascade,
  foreign key (slug, item_id) references mog.items (slug, item_id) on update cascade on delete cascade,
  foreign key (slug, area)    references mog.areas (slug, name)    on update cascade on delete cascade
);
create index if not exists pick_rows_item_idx on mog.pick_rows (slug, item_id);

alter table mog.vendors   enable row level security;
alter table mog.areas     enable row level security;
alter table mog.items     enable row level security;
alter table mog.pick_rows enable row level security;


-- ---------------------------------------------------------------------
-- Internal: the catalog JSON, built from the tables
-- ---------------------------------------------------------------------

-- Same shape and rules as Sync.gs buildCatalogPayload_ (design record
-- section 6), from data that can't hold the Sheet's drift:
--   * vendorList: sorted the way JS localeCompare sorts (ICU root collation;
--     smoke_v4.sql pins the order against a JS-computed list).
--   * items: par null = not a number; primaryVendor '' = none.
--   * pickRows: [vendor, id, item name, area ('' = none), area order (null =
--     none), shelf order (null = blank)], in SETUP row order.
--   * itemCounts: active items per primary vendor (countActiveItemsByVendor_).
--   * backupCounts: active items on a vendor's list whose primary is another
--     vendor or none (countBackupItemsByVendor_). Names are canonical here, so
--     plain equality replaces the JS lower-case compare.
-- Returns null for a store that doesn't exist.
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
  from mog.stores s
 where s.slug = p_slug;
$$;

-- Replace a store's catalog tables with p_tables (the shape Sync.gs
-- buildCatalogTables_ sends). Raises on bad data; the caller decides what to
-- do with that. Profile fields that are absent keep their stored value.
create or replace function mog.replace_catalog_tables(p_slug text, p_tables jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_profile jsonb := coalesce(p_tables -> 'profile', '{}'::jsonb);
begin
  if p_tables is null or jsonb_typeof(p_tables) <> 'object'
     or jsonb_typeof(coalesce(p_tables -> 'vendors',  'null')) <> 'array'
     or jsonb_typeof(coalesce(p_tables -> 'areas',    'null')) <> 'array'
     or jsonb_typeof(coalesce(p_tables -> 'items',    'null')) <> 'array'
     or jsonb_typeof(coalesce(p_tables -> 'pickRows', 'null')) <> 'array' then
    raise exception 'tables must be an object with vendors, areas, items and pickRows arrays';
  end if;

  update mog.stores
     set time_zone = coalesce(v_profile ->> 'timeZone', time_zone),
         location  = coalesce(v_profile ->> 'location', location),
         abbr      = coalesce(v_profile ->> 'abbr',     abbr),
         concept   = coalesce(v_profile ->> 'concept',  concept)
   where slug = p_slug;

  delete from mog.pick_rows where slug = p_slug;
  delete from mog.items     where slug = p_slug;
  delete from mog.areas     where slug = p_slug;
  delete from mog.vendors   where slug = p_slug;

  insert into mog.vendors (slug, name, mults, cutoff)
  select p_slug, e ->> 'name',
         array(select m.x::numeric
                 from jsonb_array_elements_text(coalesce(e -> 'mults', '[0,0,0,0,0,0,0]')) with ordinality m(x, o)
                order by m.o),
         nullif(e ->> 'cutoff', '')
    from jsonb_array_elements(p_tables -> 'vendors') e;

  insert into mog.areas (slug, name, ord)
  select p_slug, e ->> 'name', (e ->> 'ord')::numeric
    from jsonb_array_elements(p_tables -> 'areas') e;

  insert into mog.items (slug, item_id, name, primary_vendor, pack, par, active, use_mult,
                         notes, sku, category, eligible_vendors, seq)
  select p_slug, e ->> 'id', coalesce(e ->> 'name', ''), nullif(e ->> 'primaryVendor', ''),
         coalesce(e ->> 'pack', ''), (e ->> 'par')::numeric,
         coalesce((e ->> 'active')::boolean, true), coalesce((e ->> 'useMult')::boolean, true),
         coalesce(e ->> 'notes', ''), coalesce(e ->> 'sku', ''), coalesce(e ->> 'category', ''),
         array(select g.x
                 from jsonb_array_elements_text(coalesce(e -> 'eligible', '[]')) with ordinality g(x, o)
                order by g.o),
         coalesce((e ->> 'seq')::integer, t.ord::integer)
    from jsonb_array_elements(p_tables -> 'items') with ordinality t(e, ord);

  insert into mog.pick_rows (slug, vendor, item_id, area, shelf_order, seq)
  select p_slug, e ->> 'vendor', e ->> 'id', nullif(e ->> 'area', ''), (e ->> 'shelfOrder')::numeric,
         coalesce((e ->> 'seq')::integer, t.ord::integer)
    from jsonb_array_elements(p_tables -> 'pickRows') with ordinality t(e, ord);

  return jsonb_build_object(
    'vendors',  jsonb_array_length(p_tables -> 'vendors'),
    'areas',    jsonb_array_length(p_tables -> 'areas'),
    'items',    jsonb_array_length(p_tables -> 'items'),
    'pickRows', jsonb_array_length(p_tables -> 'pickRows'));
end;
$$;


-- ---------------------------------------------------------------------
-- Apps Script entry points (publishable key + the store's sync key)
-- ---------------------------------------------------------------------

-- Copy the Sheet's catalog into the tables, in one transaction, and return
-- the catalog JSON built from them. While editor_direct is off the tables are
-- inert (phones read mog.catalog, which the Sheet still pushes), so running
-- this any number of times changes nothing a KM sees. Bad data (a pick row
-- for a vendor that isn't listed, two vendors differing only in case, ...)
-- rejects the whole seed and leaves the previous tables as they were.
create or replace function public.mog_sync_seed_catalog(p_slug text, p_key text, p_tables jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s     mog.stores%rowtype;
  v_n   jsonb;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  select * into s from mog.stores where slug = p_slug for update;   -- serializes seeds per store
  if s.editor_direct then
    return jsonb_build_object('ok', false, 'error', 'EDITOR_DIRECT');
  end if;

  begin
    v_n := mog.replace_catalog_tables(p_slug, p_tables);
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'SEED_REJECTED: ' || sqlerrm);
  end;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'seeded',  v_n,
    'catalog', mog.catalog_from_tables(p_slug)));
end;
$$;

-- The store's switches and the catalog phones currently read, in one call.
create or replace function public.mog_sync_get_status(p_slug text, p_key text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  s mog.stores%rowtype;
  c mog.catalog%rowtype;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  select * into s from mog.stores  where slug = p_slug;
  select * into c from mog.catalog where slug = p_slug;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'phoneDirect',     s.phone_direct,
    'editorDirect',    s.editor_direct,
    'hasCycle',        exists (select 1 from mog.store_state t where t.slug = p_slug),
    'tablesSeeded',    exists (select 1 from mog.vendors v where v.slug = p_slug),
    'catalogVersion',  c.version,
    'catalogPushedAt', c.pushed_at,
    'catalog',         c.payload));
end;
$$;

-- v1 replacement (same signature): refused once the store's editor_direct is
-- on, so a Sheet push can never overwrite the catalog Supabase owns (D16).
create or replace function public.mog_sync_push_catalog(p_slug text, p_key text, p_version bigint, p_payload jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  if (select s.editor_direct from mog.stores s where s.slug = p_slug) then
    return jsonb_build_object('ok', false, 'error', 'EDITOR_DIRECT');
  end if;
  if p_version is null or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'version and an object payload are required');
  end if;
  insert into mog.catalog as c (slug, version, payload, pushed_at)
  values (p_slug, p_version, p_payload, now())
  on conflict (slug) do update
     set version = excluded.version, payload = excluded.payload, pushed_at = excluded.pushed_at
   where c.version <= excluded.version;  -- a slow, older push never overwrites a newer one
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'applied', v_n > 0, 'version', p_version));
end;
$$;


-- ---------------------------------------------------------------------
-- SQL Editor only (not exposed to the API)
-- ---------------------------------------------------------------------

-- Copy a store's seeded catalog to a test store with no Sheet behind it:
--     select mog.copy_store_catalog('rprfo', 'rprfotest');
-- The test store gets the source's PINs (so the same PIN opens its editor),
-- editor_direct on (Supabase is its only writer), phone_direct off (no phone
-- can count into it), a random sync key nobody holds, and a catalog row built
-- from its tables. Running it again replaces the test store's catalog. It
-- refuses to overwrite a store that isn't a test store. To remove it:
--     delete from mog.stores where slug = 'rprfotest';
create or replace function mog.copy_store_catalog(p_from text, p_to text)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  src  mog.stores%rowtype;
  dst  mog.stores%rowtype;
  v_to text := lower(trim(coalesce(p_to, '')));
begin
  select * into src from mog.stores where slug = p_from;
  if not found then
    raise exception 'No store %', p_from;
  end if;
  if not exists (select 1 from mog.vendors v where v.slug = p_from) then
    raise exception 'Store % has no catalog tables yet: run test_catalogTablesParity on it first', p_from;
  end if;
  if v_to !~ '^[a-z0-9]{2,20}$' or v_to = p_from then
    raise exception 'Bad test store slug: %', p_to;
  end if;

  select * into dst from mog.stores where slug = v_to for update;
  if found and not dst.is_test then
    raise exception 'Store % is a real store; refusing to overwrite it', v_to;
  end if;
  if not found then
    insert into mog.stores (slug, sync_key_hash, is_test)
    values (v_to, mog.sha256_hex(encode(extensions.gen_random_bytes(32), 'hex')), true);
  end if;

  update mog.stores
     set pin_hash        = src.pin_hash,
         master_pin_hash = src.master_pin_hash,
         fail_count      = 0,
         locked_until    = null,
         time_zone       = src.time_zone,
         location        = coalesce(src.location, 'Unknown') || ' (TEST)',
         abbr            = src.abbr,
         concept         = src.concept,
         editor_direct   = true,
         phone_direct    = false,
         is_test         = true
   where slug = v_to;

  delete from mog.pick_rows where slug = v_to;
  delete from mog.items     where slug = v_to;
  delete from mog.areas     where slug = v_to;
  delete from mog.vendors   where slug = v_to;
  insert into mog.vendors (slug, name, mults, cutoff)
    select v_to, name, mults, cutoff from mog.vendors where slug = p_from;
  insert into mog.areas (slug, name, ord)
    select v_to, name, ord from mog.areas where slug = p_from;
  insert into mog.items (slug, item_id, name, primary_vendor, pack, par, active, use_mult,
                         notes, sku, category, eligible_vendors, seq)
    select v_to, item_id, name, primary_vendor, pack, par, active, use_mult,
           notes, sku, category, eligible_vendors, seq
      from mog.items where slug = p_from;
  insert into mog.pick_rows (slug, vendor, item_id, area, shelf_order, seq)
    select v_to, vendor, item_id, area, shelf_order, seq from mog.pick_rows where slug = p_from;

  insert into mog.catalog as c (slug, version, payload, pushed_at)
  values (v_to, (extract(epoch from clock_timestamp()) * 1000)::bigint, mog.catalog_from_tables(v_to), now())
  on conflict (slug) do update
     set version = excluded.version, payload = excluded.payload, pushed_at = excluded.pushed_at;

  return format('Copied %s''s catalog to test store %s: %s vendors, %s areas, %s items, %s pick rows.',
    p_from, v_to,
    (select count(*) from mog.vendors   where slug = v_to),
    (select count(*) from mog.areas     where slug = v_to),
    (select count(*) from mog.items     where slug = v_to),
    (select count(*) from mog.pick_rows where slug = v_to));
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: lock the new tables and internals, open exactly the new
-- entry points.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_sync_seed_catalog(text, text, jsonb)',
    'public.mog_sync_get_status(text, text)',
    'public.mog_sync_push_catalog(text, text, bigint, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
