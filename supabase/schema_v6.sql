-- =====================================================================
-- MOG on Supabase — schema v6   (run AFTER schema.sql, v2, v3, v4 and v5)
-- =====================================================================
-- One app per store, Phase 2 (docs/MOG_OneApp_Spec.md): the editor writes
-- the catalog tables itself, on stores whose editor_direct is on. Today that
-- is only the test store rprfotest (D21). Nothing here changes what a phone
-- or a Sheet does on any other store.
--
-- Adds:
--   * mog.change_log: every catalog change the editor makes: when, who (the
--     device's "Who's counting?" name), what in words, and each changed row
--     before and after. Undo replays a change backwards.
--   * mog_editor_login(slug, pin): the editor's sign-in. Same PIN rules and
--     the same lockout counter as mog_login; it needs editor_direct instead
--     of phone_direct, and checks it before the PIN.
--   * mog_editor_get(token): the store's catalog tables and its recent
--     changes, in one read (the editor's page open).
--   * mog_editor_apply(token, label, by, ops): writes the changed rows in one
--     transaction, but only if every row is still what the editor read (else
--     CONFLICT, and nothing is written). Then it logs the change and rebuilds
--     the catalog phones read (D22) under a new version.
--   * mog_editor_undo(token, changeId, by): a logged change, replayed
--     backwards as a new change. Refused when a row it touched has changed
--     since, naming the later change to undo first.
--   The store always comes from the token, never from what a page sends, so
--   one store's editor can't read or change another store's catalog.
--
-- Changes:
--   * D23: removing a vendor keeps its items; the items it was the primary
--     vendor of get none (v4 refused the delete instead). Needs Postgres 15+
--     for the column list on SET NULL.
--
-- ops, as template/editor/catalogEdit.js builds them, in order:
--   { "shift": "items", "from": n }   every item with seq >= n moves down one
--                                     (a row inserted above them)
--   { "t": "items" | "pickRows" | "vendors" | "areas",
--     "before": row | null, "after": row | null }
--   Rows have mog_editor_get's fields. "before" must match the stored row
--   (every field but seq); null means the row must not exist yet. "after"
--   null deletes. An updated item keeps its seq; a pick row takes the new one.
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================


-- D23's SET NULL (column) needs Postgres 15. Stop here, before anything
-- changes, on an older database.
do $$
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'Schema v6 needs Postgres 15 or newer (this database is %).', current_setting('server_version');
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Change log
-- ---------------------------------------------------------------------

create table if not exists mog.change_log (
  id         bigint generated always as identity primary key,
  slug       text not null references mog.stores (slug) on delete cascade,
  at         timestamptz not null default now(),
  by_name    text,                                   -- null = no name given ("Someone")
  label      text not null,                          -- what changed, in words
  ops        jsonb not null,                         -- the row changes, as applied
  undoes     bigint references mog.change_log (id) on delete set null,
  undone_by  bigint references mog.change_log (id) on delete set null
);
create index if not exists change_log_slug_idx on mog.change_log (slug, id desc);
alter table mog.change_log enable row level security;


-- ---------------------------------------------------------------------
-- D23: a removed vendor leaves its items, with no primary vendor
-- ---------------------------------------------------------------------

alter table mog.items drop constraint if exists items_slug_primary_vendor_fkey;
alter table mog.items add constraint items_slug_primary_vendor_fkey
  foreign key (slug, primary_vendor) references mog.vendors (slug, name)
  on update cascade on delete set null (primary_vendor);


-- ---------------------------------------------------------------------
-- Internal: rows as JSON (the editor's shape), and how a change applies
-- ---------------------------------------------------------------------

create or replace function mog.item_row_json(i mog.items)
returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', i.item_id, 'name', i.name, 'primaryVendor', i.primary_vendor, 'pack', i.pack, 'par', i.par,
    'active', i.active, 'useMult', i.use_mult, 'notes', i.notes, 'sku', i.sku, 'category', i.category,
    'eligible', to_jsonb(i.eligible_vendors), 'seq', i.seq);
$$;

create or replace function mog.pick_row_json(p mog.pick_rows)
returns jsonb
language sql immutable
set search_path = ''
as $$
  select jsonb_build_object('vendor', p.vendor, 'id', p.item_id, 'area', p.area,
                            'shelfOrder', p.shelf_order, 'seq', p.seq);
$$;

-- The store's catalog tables, in the shape Sync.gs buildCatalogTables_
-- builds: vendors A to Z (as the app sorts them), areas in their order,
-- items and pick rows in row order.
create or replace function mog.tables_json(p_slug text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'vendors', coalesce((
      select jsonb_agg(jsonb_build_object('name', v.name, 'mults', to_jsonb(v.mults), 'cutoff', v.cutoff)
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

-- Which row a change is about, in words (also how two changes are matched).
create or replace function mog.editor_ident(p_t text, p_row jsonb)
returns text
language sql immutable
set search_path = ''
as $$
  select case p_t
    when 'items'    then p_row ->> 'id'
    when 'pickRows' then (p_row ->> 'vendor') || ' / ' || (p_row ->> 'id')
    else p_row ->> 'name' end;
$$;

-- The row a change is about, as stored now (null = not there).
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
    when 'vendors' then (select jsonb_build_object('name', v.name, 'mults', to_jsonb(v.mults), 'cutoff', v.cutoff)
                           from mog.vendors v where v.slug = p_slug and v.name = p_row ->> 'name')
    when 'areas' then (select jsonb_build_object('name', a.name, 'ord', a.ord)
                         from mog.areas a where a.slug = p_slug and a.name = p_row ->> 'name')
  end;
$$;

-- Does the stored row still look the way the editor read it? Every field
-- but seq (which only places a row). An empty string and null are the same.
create or replace function mog.editor_fields_match(p_t text, p_cur jsonb, p_want jsonb)
returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(bool_and(
           coalesce(nullif(p_cur -> f, '""'::jsonb), 'null'::jsonb) =
           coalesce(nullif(p_want -> f, '""'::jsonb), 'null'::jsonb)), false)
    from unnest(case p_t
      when 'items'    then array['name','primaryVendor','pack','par','active','useMult','notes','sku','category','eligible']
      when 'pickRows' then array['area','shelfOrder']
      when 'vendors'  then array['mults','cutoff']
      when 'areas'    then array['ord'] end) f;
$$;

create or replace function mog.json_text_array(p jsonb)
returns text[]
language sql immutable
set search_path = ''
as $$
  select coalesce(array(select g.x from jsonb_array_elements_text(coalesce(p, '[]'::jsonb)) with ordinality g(x, o)
                         order by g.o), '{}');
$$;

-- Apply ops to a store's tables. Raises 'CONFLICT: ...' when a row isn't
-- what a change expects, and the database's own errors on data the tables
-- can't hold (a pick row for a vendor that isn't listed, say). The caller
-- runs it inside an exception block, so a failure writes nothing.
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
        insert into mog.vendors (slug, name, mults, cutoff)
        values (p_slug, v_a ->> 'name',
                array(select m.x::numeric from jsonb_array_elements_text(coalesce(v_a -> 'mults', '[0,0,0,0,0,0,0]')) with ordinality m(x, o) order by m.o),
                nullif(v_a ->> 'cutoff', ''));
      else
        update mog.vendors
           set mults = array(select m.x::numeric from jsonb_array_elements_text(coalesce(v_a -> 'mults', '[0,0,0,0,0,0,0]')) with ordinality m(x, o) order by m.o),
               cutoff = nullif(v_a ->> 'cutoff', '')
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

-- The catalog phones read, rebuilt from the tables (D22) under a version
-- newer than the last one.
create or replace function mog.editor_publish(p_slug text)
returns bigint
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_ver bigint;
begin
  v_ver := greatest((extract(epoch from clock_timestamp()) * 1000)::bigint,
                    coalesce((select c.version + 1 from mog.catalog c where c.slug = p_slug), 0));
  insert into mog.catalog as c (slug, version, payload, pushed_at)
  values (p_slug, v_ver, mog.catalog_from_tables(p_slug), now())
  on conflict (slug) do update
     set version = excluded.version, payload = excluded.payload, pushed_at = excluded.pushed_at;
  return v_ver;
end;
$$;

-- The editor's session: the store a token belongs to, if that store's
-- editor writes to Supabase. { ok, slug } or { ok: false, error }.
create or replace function mog.editor_session(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_slug text;
begin
  select v.slug into v_slug from mog.sessions v
   where v.token_hash = mog.sha256_hex(p_token) and v.expires_at > now();
  if v_slug is null then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  if not exists (select 1 from mog.stores s where s.slug = v_slug and s.editor_direct) then
    return jsonb_build_object('ok', false, 'error', 'EDITOR_NOT_DIRECT');
  end if;
  return jsonb_build_object('ok', true, 'slug', v_slug);
end;
$$;

-- What the editor opens with: the tables, the recent changes, the store.
create or replace function mog.editor_data(p_slug text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'store', jsonb_build_object('slug', s.slug, 'location', s.location, 'abbr', s.abbr, 'concept', s.concept),
    'tables', mog.tables_json(s.slug),
    'changes', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'at', l.at, 'by', l.by_name, 'label', l.label,
                                          'undoes', l.undoes, 'undoneBy', l.undone_by) order by l.id desc)
        from (select * from mog.change_log c where c.slug = s.slug order by c.id desc limit 100) l), '[]'::jsonb),
    'catalogVersion', (select c.version from mog.catalog c where c.slug = s.slug))
  from mog.stores s where s.slug = p_slug;
$$;


-- ---------------------------------------------------------------------
-- Editor entry points (publishable key + a session token)
-- ---------------------------------------------------------------------

-- mog_login's rules (schema v3): lockout first, 5 failures -> 5 minutes, a
-- success clears the counter, the master PIN works too. The switch checked
-- here is editor_direct, before the PIN, so a store whose editor still runs
-- in the Sheet never touches its lockout counter.
create or replace function public.mog_editor_login(p_slug text, p_pin text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s       mog.stores%rowtype;
  v_type  text;
  v_count integer;
  v_token text;
begin
  select * into s from mog.stores
   where slug = lower(trim(coalesce(p_slug, '')))
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Unknown store');
  end if;
  if not s.editor_direct then
    return jsonb_build_object('ok', false, 'error', 'EDITOR_NOT_DIRECT');
  end if;

  if s.locked_until is not null then
    if s.locked_until > now() then
      return jsonb_build_object('ok', false, 'error', 'Too many attempts', 'lockout', true,
        'retryAfterMs', ceil(extract(epoch from (s.locked_until - now())) * 1000)::bigint);
    end if;
    update mog.stores set fail_count = 0, locked_until = null where slug = s.slug;
    s.fail_count := 0;
  end if;

  if s.pin_hash is not null
     and extensions.crypt(coalesce(p_pin, ''), s.pin_hash) = s.pin_hash then
    v_type := 'store';
  elsif s.master_pin_hash is not null
     and extensions.crypt(coalesce(p_pin, ''), s.master_pin_hash) = s.master_pin_hash then
    v_type := 'master';
  end if;

  if v_type is null then
    v_count := s.fail_count + 1;
    if v_count >= 5 then
      update mog.stores
         set fail_count = v_count, locked_until = now() + interval '5 minutes'
       where slug = s.slug;
      return jsonb_build_object('ok', false, 'error', 'Too many attempts', 'lockout', true,
        'retryAfterMs', 300000);
    end if;
    update mog.stores set fail_count = v_count where slug = s.slug;
    return jsonb_build_object('ok', false, 'error', 'Invalid PIN');
  end if;

  if s.fail_count <> 0 then
    update mog.stores set fail_count = 0, locked_until = null where slug = s.slug;
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into mog.sessions (token_hash, slug, auth_type, expires_at)
  values (mog.sha256_hex(v_token), s.slug, v_type, now() + interval '12 hours');
  delete from mog.sessions where expires_at < now() - interval '1 day';

  return jsonb_build_object('ok', true, 'data',
    mog.editor_data(s.slug) || jsonb_build_object('token', v_token, 'expiresAt', now() + interval '12 hours'));
end;
$$;

-- The editor's page open (and its "is this sign-in still good?" check).
-- Any session for the store works, the phones' included, so one sign-in
-- covers the whole app.
create or replace function public.mog_editor_get(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v jsonb := mog.editor_session(p_token);
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  return jsonb_build_object('ok', true, 'data', mog.editor_data(v ->> 'slug'));
end;
$$;

create or replace function public.mog_editor_apply(p_token text, p_label text, p_by text, p_ops jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v      jsonb := mog.editor_session(p_token);
  v_slug text;
  v_id   bigint;
  v_ver  bigint;
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  v_slug := v ->> 'slug';
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'ops must be an array');
  end if;
  if jsonb_array_length(p_ops) > 5000 then
    return jsonb_build_object('ok', false, 'error', 'Too many changes at once');
  end if;
  if jsonb_array_length(p_ops) = 0 then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('changeId', null,
      'catalogVersion', (select c.version from mog.catalog c where c.slug = v_slug)));
  end if;

  perform 1 from mog.stores s where s.slug = v_slug for update;   -- one editor write at a time per store
  begin
    perform mog.editor_apply_ops(v_slug, p_ops);
  exception when others then
    if sqlerrm like 'CONFLICT: %' then
      return jsonb_build_object('ok', false, 'error', 'CONFLICT', 'detail', substr(sqlerrm, 11));
    end if;
    return jsonb_build_object('ok', false, 'error', 'REJECTED: ' || sqlerrm);
  end;

  insert into mog.change_log (slug, by_name, label, ops)
  values (v_slug, nullif(left(btrim(coalesce(p_by, '')), 40), ''),
          left(coalesce(nullif(btrim(coalesce(p_label, '')), ''), 'Catalog change'), 300), p_ops)
  returning id into v_id;
  v_ver := mog.editor_publish(v_slug);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('changeId', v_id, 'catalogVersion', v_ver));
end;
$$;

create or replace function public.mog_editor_undo(p_token text, p_change_id bigint, p_by text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v       jsonb := mog.editor_session(p_token);
  v_slug  text;
  c       mog.change_log%rowtype;
  v_inv   jsonb;
  v_id    bigint;
  v_ver   bigint;
  v_later mog.change_log%rowtype;
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  v_slug := v ->> 'slug';
  perform 1 from mog.stores s where s.slug = v_slug for update;
  select * into c from mog.change_log l where l.id = p_change_id and l.slug = v_slug for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Unknown change');
  end if;
  if c.undone_by is not null then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_UNDONE');
  end if;

  -- Each row change reversed, last first. Seq shifts stay: a gap in the
  -- order changes nothing.
  select coalesce(jsonb_agg(jsonb_build_object('t', x.e ->> 't', 'before', x.e -> 'after', 'after', x.e -> 'before')
                            order by x.o desc), '[]'::jsonb)
    into v_inv
    from jsonb_array_elements(c.ops) with ordinality x(e, o)
   where not (x.e ? 'shift');

  begin
    perform mog.editor_apply_ops(v_slug, v_inv);
  exception when others then
    if sqlerrm like 'CONFLICT: %' then
      select * into v_later from mog.change_log l
       where l.slug = v_slug and l.id > c.id and l.undone_by is null
         and exists (
           select 1 from jsonb_array_elements(l.ops) le, jsonb_array_elements(c.ops) ce
            where not (le ? 'shift') and not (ce ? 'shift') and le ->> 't' = ce ->> 't'
              and mog.editor_ident(le ->> 't', coalesce(nullif(le -> 'after', 'null'::jsonb), le -> 'before'))
                = mog.editor_ident(ce ->> 't', coalesce(nullif(ce -> 'after', 'null'::jsonb), ce -> 'before')))
       order by l.id desc limit 1;
      return jsonb_build_object('ok', false, 'error', 'CONFLICT', 'detail', substr(sqlerrm, 11),
        'laterChange', case when v_later.id is null then null
                            else jsonb_build_object('id', v_later.id, 'label', v_later.label, 'by', v_later.by_name, 'at', v_later.at) end);
    end if;
    return jsonb_build_object('ok', false, 'error', 'REJECTED: ' || sqlerrm);
  end;

  insert into mog.change_log (slug, by_name, label, ops, undoes)
  values (v_slug, nullif(left(btrim(coalesce(p_by, '')), 40), ''), left('Undo: ' || c.label, 300), v_inv, c.id)
  returning id into v_id;
  update mog.change_log set undone_by = v_id where id = c.id;
  if c.undoes is not null then
    update mog.change_log set undone_by = null where id = c.undoes;   -- undoing an undo puts the change back
  end if;
  v_ver := mog.editor_publish(v_slug);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('changeId', v_id, 'catalogVersion', v_ver));
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: lock the new table and internals, open exactly the four
-- entry points.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_editor_login(text, text)',
    'public.mog_editor_get(text)',
    'public.mog_editor_apply(text, text, text, jsonb)',
    'public.mog_editor_undo(text, bigint, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
