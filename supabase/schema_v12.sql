-- =====================================================================
-- MOG on Supabase — schema v12   (run AFTER schema.sql and v2 to v11)
-- =====================================================================
-- The concept library (docs/MOG_Warehouse_Spec.md §1): each concept's
-- standard items for one side (Roll Play BOH, Roll Play FOH, ...), kept by
-- HQ (hq/) so a new store's order guide starts from it and an LTO can land
-- in it too. A library is never a store's catalog: nothing here reaches a
-- store's tables, its phones or its Changes until an HQ rollout writes the
-- items there, the same save as an LTO (no par, no storage area). As in
-- v11, the rules stay in template/editor/catalogEdit.js (librarySeed,
-- cleanLibrary, libraryAdd); this file checks the shape, the version and
-- the sign-in.
--
-- Adds:
--   * mog.stores.side: BOH or FOH, read from the location's name ("Roll Play
--     Rosslyn BOH"), now and whenever a store with no side gets a location
--     (a trigger), so Apps Script needs no change.
--   * mog.libraries (one per concept and side: its version, the store it
--     was started from, who saved it last) and mog.library_items (name,
--     pack, main vendor and backups as HQ's vendor names, notes). No par and
--     no storage area: those are each store's.
--   * mog.library_log: every save, by whom, and the list as it was before,
--     so a wrong save can be put back by hand in the SQL Editor.
--   * mog_hq_data(token): also each store's side and every library.
--   * mog_hq_apply(token, changes, links, libraries): v11's save plus whole
--     libraries, each refused (CONFLICT) when someone saved it after HQ
--     loaded it. Stores, vendor names and libraries: all or none. The
--     three-argument mog_hq_apply stays, for HQ pages opened before this.
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================

do $$
begin
  if to_regprocedure('public.mog_hq_apply(text, jsonb, jsonb)') is null then
    raise exception 'Run schema_v11.sql first: public.mog_hq_apply is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- A store's side
-- ---------------------------------------------------------------------

alter table mog.stores add column if not exists side text check (side in ('BOH', 'FOH'));

-- BOH or FOH from a location's name, as a word ("Roll Play Rosslyn FOH
-- (TEST)" is FOH). null = neither.
create or replace function mog.side_from_location(p text)
returns text
language sql immutable
set search_path = ''
as $$
  select case when p ~* '\mFOH\M' then 'FOH' when p ~* '\mBOH\M' then 'BOH' end;
$$;

-- A store with no side takes it from its location when the location is set
-- (provisioning, Move this store to Supabase, a test copy).
create or replace function mog.store_side_fill()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.side is null then
    new.side := mog.side_from_location(new.location);
  end if;
  return new;
end;
$$;

drop trigger if exists stores_side_fill on mog.stores;
create trigger stores_side_fill before insert or update of location, side on mog.stores
  for each row execute function mog.store_side_fill();

update mog.stores set side = mog.side_from_location(location) where side is null;


-- ---------------------------------------------------------------------
-- Libraries
-- ---------------------------------------------------------------------

create table if not exists mog.libraries (
  concept     text not null check (concept ~ '^[a-z0-9-]{1,30}$'),  -- the theme slug, as mog.stores.concept
  side        text not null check (side in ('BOH', 'FOH')),
  version     bigint not null default 0,                          -- 0 = never saved
  seeded_from text,                                               -- the store it was started from, by name
  updated_at  timestamptz,
  updated_by  text,
  primary key (concept, side)
);

create table if not exists mog.library_items (
  concept text not null,
  side    text not null,
  ord     integer not null,
  name    text not null check (name = btrim(name) and name <> '' and length(name) <= 300),
  pack    text not null default '' check (length(pack) <= 300),
  vendor  text not null check (vendor = btrim(vendor) and vendor <> '' and length(vendor) <= 100),  -- HQ's name
  backups text[] not null default '{}' check (array_position(backups, null) is null and cardinality(backups) <= 20),
  notes   text not null default '' check (length(notes) <= 1000),
  primary key (concept, side, ord),
  foreign key (concept, side) references mog.libraries (concept, side) on delete cascade
);
create unique index if not exists library_items_name_ci on mog.library_items (concept, side, lower(name));

create table if not exists mog.library_log (
  id           bigint generated always as identity primary key,
  concept      text not null,
  side         text not null,
  at           timestamptz not null default now(),
  by_name      text not null,
  label        text not null,
  version      bigint not null,     -- the version this save made
  items_before jsonb not null       -- the list as it was before this save
);
create index if not exists library_log_lib_idx on mog.library_log (concept, side, id);

alter table mog.libraries     enable row level security;
alter table mog.library_items enable row level security;
alter table mog.library_log   enable row level security;


-- One library saved whole, as HQ sends it:
--   { concept, side, version, label, seededFrom?, items: [{ name, pack, vendor, backups, notes }] }
-- version is the one HQ loaded (0 = none yet): another one now is a
-- CONFLICT. The items are cleaned as catalogEdit.js cleanLibrary cleans
-- them (trimmed, backups without the main vendor or repeats) and refused
-- as it refuses them (no name, no main vendor, a name twice, too long).
-- Raises CONFLICT: / REJECTED: for mog_hq_apply. Returns { concept, side, version }.
create or replace function mog.library_put(p_by text, p_lib jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_concept text := p_lib ->> 'concept';
  v_side    text := p_lib ->> 'side';
  v_items   jsonb := p_lib -> 'items';
  v_have    bigint;
  v_last    text;
  v_before  jsonb;
  v_new     bigint;
  v_n       integer := 0;
  it        jsonb;
  b         jsonb;
  v_name    text;
  v_vendor  text;
  v_pack    text;
  v_notes   text;
  v_back    text;
  v_backups text[];
  v_what    text;
begin
  if jsonb_typeof(p_lib) is distinct from 'object' then
    raise exception 'REJECTED: a library must be an object';
  end if;
  if v_concept is null or v_concept !~ '^[a-z0-9-]{1,30}$' then
    raise exception 'REJECTED: no concept called %', coalesce(v_concept, '(none)');
  end if;
  if v_side is null or v_side not in ('BOH', 'FOH') then
    raise exception 'REJECTED: a library''s side is BOH or FOH';
  end if;
  if jsonb_typeof(p_lib -> 'version') is distinct from 'number' then
    raise exception 'REJECTED: the library''s version is missing';
  end if;
  if jsonb_typeof(v_items) is distinct from 'array' or jsonb_array_length(v_items) > 2000 then
    raise exception 'REJECTED: a library''s items are a list of at most 2000';
  end if;

  insert into mog.libraries (concept, side) values (v_concept, v_side) on conflict do nothing;
  select l.version, l.updated_by into v_have, v_last
    from mog.libraries l where l.concept = v_concept and l.side = v_side for update;
  if v_have <> (p_lib ->> 'version')::numeric then
    raise exception 'CONFLICT: the % % library was saved since HQ loaded it (by %)', v_concept, v_side, coalesce(v_last, 'someone');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'pack', i.pack, 'vendor', i.vendor,
                                               'backups', to_jsonb(i.backups), 'notes', i.notes) order by i.ord), '[]'::jsonb)
    into v_before
    from mog.library_items i where i.concept = v_concept and i.side = v_side;
  delete from mog.library_items i where i.concept = v_concept and i.side = v_side;

  for it in select x from jsonb_array_elements(v_items) x loop
    v_n := v_n + 1;
    if jsonb_typeof(it) is distinct from 'object' then
      raise exception 'REJECTED: item % isn''t an item', v_n;
    end if;
    v_name := mog.js_trim(it ->> 'name');
    v_what := case when v_name = '' then 'Item ' || v_n else '"' || left(v_name, 60) || '"' end;
    if v_name = '' then
      raise exception 'REJECTED: Item % has no name', v_n;
    end if;
    if length(v_name) > 300 then
      raise exception 'REJECTED: % is longer than 300 characters', v_what;
    end if;
    if exists (select 1 from mog.library_items i
                where i.concept = v_concept and i.side = v_side and lower(i.name) = lower(v_name)) then
      raise exception 'REJECTED: % is in the library twice', v_what;
    end if;
    v_vendor := mog.js_trim(it ->> 'vendor');
    if v_vendor = '' then
      raise exception 'REJECTED: % has no main vendor', v_what;
    end if;
    if length(v_vendor) > 100 then
      raise exception 'REJECTED: %''s main vendor is longer than 100 characters', v_what;
    end if;
    v_backups := '{}';
    if jsonb_typeof(it -> 'backups') = 'array' then
      for b in select y from jsonb_array_elements(it -> 'backups') y loop
        v_back := case when jsonb_typeof(b) = 'string' then mog.js_trim(b #>> '{}') else '' end;
        if v_back = '' or lower(v_back) = lower(v_vendor)
           or exists (select 1 from unnest(v_backups) u where lower(u) = lower(v_back)) then
          continue;
        end if;
        if length(v_back) > 100 then
          raise exception 'REJECTED: %''s backup vendor "%" is longer than 100 characters', v_what, left(v_back, 40);
        end if;
        v_backups := v_backups || v_back;
      end loop;
    end if;
    if cardinality(v_backups) > 20 then
      raise exception 'REJECTED: % has more than 20 backup vendors', v_what;
    end if;
    v_pack := mog.js_trim(it ->> 'pack');
    v_notes := mog.js_trim(it ->> 'notes');
    if length(v_pack) > 300 then
      raise exception 'REJECTED: %''s pack is longer than 300 characters', v_what;
    end if;
    if length(v_notes) > 1000 then
      raise exception 'REJECTED: %''s notes are longer than 1000 characters', v_what;
    end if;
    insert into mog.library_items (concept, side, ord, name, pack, vendor, backups, notes)
    values (v_concept, v_side, v_n, v_name, v_pack, v_vendor, v_backups, v_notes);
  end loop;

  update mog.libraries l
     set version = l.version + 1, updated_at = now(), updated_by = p_by,
         seeded_from = case when p_lib ? 'seededFrom'
                            then nullif(left(mog.js_trim(p_lib ->> 'seededFrom'), 100), '') else l.seeded_from end
   where l.concept = v_concept and l.side = v_side
  returning l.version into v_new;
  insert into mog.library_log (concept, side, by_name, label, version, items_before)
  values (v_concept, v_side, p_by,
          left(coalesce(nullif(mog.js_trim(p_lib ->> 'label'), ''), 'Saved the library'), 300), v_new, v_before);
  return jsonb_build_object('concept', v_concept, 'side', v_side, 'version', v_new);
end;
$$;


-- ---------------------------------------------------------------------
-- HQ: the read, and the save with libraries (both from schema_v11.sql)
-- ---------------------------------------------------------------------

-- v11's read, plus each store's side and every library with its items.
create or replace function public.mog_hq_data(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_name text := mog.hq_session(p_token);
begin
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'name', v_name,
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', s.slug, 'location', s.location, 'abbr', s.abbr, 'concept', coalesce(s.concept, ''),
               'isTest', s.is_test, 'editorDirect', s.editor_direct, 'side', s.side,
               'tables', case when s.editor_direct then mog.tables_json(s.slug) end)
             order by coalesce(s.concept, ''), s.is_test, s.location, s.slug)
        from mog.stores s), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('slug', l.slug, 'hqName', l.hq_name, 'vendor', l.vendor) order by l.hq_name, l.slug)
        from mog.hq_vendor_links l), '[]'::jsonb),
    'libraries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'concept', l.concept, 'side', l.side, 'version', l.version, 'seededFrom', l.seeded_from,
               'updatedAt', l.updated_at, 'updatedBy', l.updated_by,
               'items', coalesce((
                 select jsonb_agg(jsonb_build_object('name', i.name, 'pack', i.pack, 'vendor', i.vendor,
                                                     'backups', to_jsonb(i.backups), 'notes', i.notes) order by i.ord)
                   from mog.library_items i where i.concept = l.concept and i.side = l.side), '[]'::jsonb))
             order by l.concept, l.side)
        from mog.libraries l), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'at', c.at, 'by', c.by_name, 'label', c.label,
                                          'undoneBy', c.undone_by) order by c.id desc)
        from (select * from mog.change_log x where x.by_name like 'HQ · %' order by x.id desc limit 50) c), '[]'::jsonb)));
end;
$$;

-- v11's save, plus whole libraries after the stores and the vendor names,
-- in the same all-or-none block: a library CONFLICT writes no store, and a
-- store's CONFLICT writes no library.
create or replace function public.mog_hq_apply(p_token text, p_changes jsonb, p_links jsonb, p_libraries jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := mog.hq_session(p_token);
  v_by   text;
  ch     jsonb;
  l      jsonb;
  lib    jsonb;
  v_libs jsonb := '[]'::jsonb;
  v_slug text;
  v_ops  jsonb;
  v_id   bigint;
  v_ver  bigint;
  v_out  jsonb := '[]'::jsonb;
begin
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 50 then
    return jsonb_build_object('ok', false, 'error', 'changes must be an array of at most 50 stores');
  end if;
  if p_links is not null and (jsonb_typeof(p_links) <> 'array' or jsonb_array_length(p_links) > 1000) then
    return jsonb_build_object('ok', false, 'error', 'links must be an array');
  end if;
  if p_libraries is not null and (jsonb_typeof(p_libraries) <> 'array' or jsonb_array_length(p_libraries) > 20) then
    return jsonb_build_object('ok', false, 'error', 'libraries must be an array of at most 20');
  end if;
  v_by := left('HQ · ' || v_name, 40);

  -- One editor write at a time per store (as mog_editor_apply), taken in
  -- slug order so two HQ saves never wait on each other in a circle.
  perform 1 from mog.stores s
   where s.slug in (select c ->> 'slug' from jsonb_array_elements(p_changes) c)
   order by s.slug for update;

  begin
    for ch in select c from jsonb_array_elements(p_changes) c order by c ->> 'slug' loop
      v_slug := ch ->> 'slug';
      v_ops := ch -> 'ops';
      if not exists (select 1 from mog.stores s where s.slug = v_slug and s.editor_direct) then
        raise exception 'REJECTED: % isn''t on the app''s editor', coalesce(v_slug, '(no store)');
      end if;
      if v_ops is null or jsonb_typeof(v_ops) <> 'array' then
        raise exception 'REJECTED: % ops must be an array', v_slug;
      end if;
      if jsonb_array_length(v_ops) = 0 then
        continue;
      end if;
      if jsonb_array_length(v_ops) > 5000 then
        raise exception 'REJECTED: too many changes at once for %', v_slug;
      end if;
      begin
        perform mog.editor_apply_ops(v_slug, v_ops);
      exception when others then
        if sqlerrm like 'CONFLICT: %' then
          raise exception 'CONFLICT: % %', v_slug, substr(sqlerrm, 11);
        end if;
        raise exception 'REJECTED: % %', v_slug, sqlerrm;
      end;
      insert into mog.change_log (slug, by_name, label, ops)
      values (v_slug, v_by, left(coalesce(nullif(btrim(coalesce(ch ->> 'label', '')), ''), 'HQ change'), 300), v_ops)
      returning id into v_id;
      v_ver := mog.editor_publish(v_slug);
      v_out := v_out || jsonb_build_array(jsonb_build_object('slug', v_slug, 'changeId', v_id, 'catalogVersion', v_ver));
    end loop;

    -- What each store calls an HQ vendor, after the vendors above exist.
    -- A link with no vendor forgets it.
    for l in select x from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) x loop
      delete from mog.hq_vendor_links k
       where k.slug = l ->> 'slug' and lower(k.hq_name) = lower(btrim(coalesce(l ->> 'hqName', '')));
      if nullif(l ->> 'vendor', '') is not null then
        insert into mog.hq_vendor_links (slug, hq_name, vendor)
        values (l ->> 'slug', btrim(l ->> 'hqName'), l ->> 'vendor');
      end if;
    end loop;

    -- Whole libraries (schema v12), each at the version HQ loaded.
    for lib in select x from jsonb_array_elements(coalesce(p_libraries, '[]'::jsonb)) x loop
      v_libs := v_libs || jsonb_build_array(mog.library_put(v_by, lib));
    end loop;
  exception when others then
    if sqlerrm like 'CONFLICT: %' then
      return jsonb_build_object('ok', false, 'error', 'CONFLICT', 'detail', substr(sqlerrm, 11));
    end if;
    if sqlerrm like 'REJECTED: %' then
      return jsonb_build_object('ok', false, 'error', sqlerrm);
    end if;
    return jsonb_build_object('ok', false, 'error', 'REJECTED: ' || sqlerrm);
  end;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object('by', v_by, 'changes', v_out, 'libraries', v_libs));
end;
$$;

-- The v11 call, for an HQ page opened before this file ran.
create or replace function public.mog_hq_apply(p_token text, p_changes jsonb, p_links jsonb)
returns jsonb
language sql volatile security definer
set search_path = ''
as $$
  select public.mog_hq_apply(p_token, p_changes, p_links, null::jsonb);
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
    'public.mog_hq_data(text)',
    'public.mog_hq_apply(text, jsonb, jsonb)',
    'public.mog_hq_apply(text, jsonb, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
