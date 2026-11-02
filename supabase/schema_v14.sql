-- =====================================================================
-- MOG on Supabase — schema v14   (run AFTER schema.sql and v2 to v13)
-- =====================================================================
-- LTOs (docs/MOG_LTO_Spec.md): an HQ rollout becomes a named LTO that HQ
-- can send to more stores, end (its items made inactive), roll back (its
-- items deleted, as if never sent) or make standard (its items go into the
-- concept library). As in v11, WHAT changes at each store is decided in
-- template/editor/catalogEdit.js and reaches this file as ordinary ops,
-- applied all stores or none, one change per store that the store can
-- undo; this file keeps the LTO's record in the same transaction.
--
-- Adds:
--   * mog.ltos: one row per LTO (id made by HQ, concept, name, the items as
--     sent with HQ's vendor names, status running / ended / rolledback /
--     standard, a version for two HQ tabs, who and when).
--   * mog.lto_stores: each store an LTO went to, the change that sent it,
--     the vendors it added there and the backups it added to items the
--     store already had (what Roll back takes off again).
--   * mog.items.lto: the LTO that created the item (null = the store's
--     own). It is part of the item's row, so an edit keeps it, a store's
--     Undo brings it back with the item, and an item the store adds later
--     never has it (item ids are reused).
--   * mog.lto_before / mog.lto_after: an LTO action's checks and record,
--     inside mog_hq_apply.
--
-- Replaces (same signatures):
--   * mog.item_row_json: an item carries `lto` only when it has one, so
--     every store's tables read exactly as before until its first LTO.
--   * mog.editor_fields_match: an item's lto is compared too (Undo of an
--     older change is refused rather than unlinking an item).
--   * mog.editor_apply_ops (from v10): an item's insert and update write lto.
--   * mog.tables_json (from v10): `ltos` (id, name, status, sentAt) for the
--     LTOs sent to the store, only when there is one.
--   * mog_hq_data (from v12): also every LTO with its stores.
--   * mog_hq_apply(token, changes, links, libraries) becomes a wrapper of
--     the new five-argument form (from v12's body); the v11 form stays.
--
-- Adds a public function:
--   * mog_hq_apply(token, changes, links, libraries, lto): v12's save plus
--     lto = { action: send | more | end | rollback | standard, id, version
--     (all but send), concept, name, items (send), stores: [{ slug,
--     vendorsAdded, backupsAdded }] (send, more) }. Refused: a moved LTO
--     version (CONFLICT), an LTO that isn't running, a store of another
--     concept, a change at a store the LTO isn't about.
--
-- Writes no store data. Not covered: mog.copy_store_catalog (SQL Editor
-- only, for test stores) doesn't copy an item's lto.
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================

do $$
begin
  if to_regprocedure('mog.wh_session(text)') is null then
    raise exception 'Run schema_v13.sql first: mog.wh_session is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists mog.ltos (
  id         text primary key check (id ~ '^lto_[a-z0-9]{8,40}$'),        -- made by HQ, before the items name it
  concept    text not null check (concept ~ '^[a-z0-9-]{1,30}$'),           -- as mog.stores.concept
  name       text not null check (name = btrim(name) and name <> '' and length(name) <= 80),
  items      jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),  -- as sent, HQ's vendor names
  status     text not null default 'running' check (status in ('running', 'ended', 'rolledback', 'standard')),
  version    bigint not null default 1,
  created_at timestamptz not null default now(),
  created_by text not null,
  status_at  timestamptz,
  status_by  text
);

create table if not exists mog.lto_stores (
  lto_id        text not null references mog.ltos (id) on delete cascade,
  slug          text not null references mog.stores (slug) on delete cascade,
  sent_at       timestamptz not null default now(),
  sent_by       text not null,
  change_id     bigint references mog.change_log (id) on delete set null,   -- null = nothing to change there
  vendors_added text[] not null default '{}',
  backups_added jsonb not null default '[]'::jsonb check (jsonb_typeof(backups_added) = 'array'),  -- [{ id, vendors }]
  primary key (lto_id, slug)
);
create index if not exists lto_stores_slug_idx on mog.lto_stores (slug);

alter table mog.items add column if not exists lto text references mog.ltos (id) on delete set null;

alter table mog.ltos       enable row level security;
alter table mog.lto_stores enable row level security;


-- ---------------------------------------------------------------------
-- An item's row: lto only when it has one
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
    || case when i.lto is not null then jsonb_build_object('lto', i.lto) else '{}'::jsonb end;
$$;

-- Does the stored row still look the way the editor read it (v10), an
-- item's lto too.
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
      when 'items'    then array['name','primaryVendor','pack','par','active','useMult','notes','sku','category','eligible','lto']
      when 'pickRows' then array['area','shelfOrder']
      when 'vendors'  then array['mults','cutoff','contact']
      when 'areas'    then array['ord'] end) f;
$$;

-- Apply ops to a store's tables (v10), an item's lto written too.
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
                               notes, sku, category, eligible_vendors, seq, lto)
        values (p_slug, v_a ->> 'id', coalesce(v_a ->> 'name', ''), nullif(v_a ->> 'primaryVendor', ''),
                coalesce(v_a ->> 'pack', ''), (v_a ->> 'par')::numeric,
                coalesce((v_a ->> 'active')::boolean, true), coalesce((v_a ->> 'useMult')::boolean, true),
                coalesce(v_a ->> 'notes', ''), coalesce(v_a ->> 'sku', ''), coalesce(v_a ->> 'category', ''),
                mog.json_text_array(v_a -> 'eligible'),
                coalesce((v_a ->> 'seq')::integer,
                         (select coalesce(max(i.seq), 0) + 1 from mog.items i where i.slug = p_slug)),
                nullif(v_a ->> 'lto', ''));
      else
        update mog.items
           set name = coalesce(v_a ->> 'name', ''), primary_vendor = nullif(v_a ->> 'primaryVendor', ''),
               pack = coalesce(v_a ->> 'pack', ''), par = (v_a ->> 'par')::numeric,
               active = coalesce((v_a ->> 'active')::boolean, true), use_mult = coalesce((v_a ->> 'useMult')::boolean, true),
               notes = coalesce(v_a ->> 'notes', ''), sku = coalesce(v_a ->> 'sku', ''),
               category = coalesce(v_a ->> 'category', ''), eligible_vendors = mog.json_text_array(v_a -> 'eligible'),
               lto = nullif(v_a ->> 'lto', '')
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

-- The store's catalog tables (v10), plus the LTOs sent to it.
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
        from mog.pick_rows p where p.slug = p_slug), '[]'::jsonb))
  || case when exists (select 1 from mog.lto_stores ls where ls.slug = p_slug)
         then jsonb_build_object('ltos', (
                select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'status', l.status, 'sentAt', ls.sent_at)
                                 order by ls.sent_at, l.id)
                  from mog.lto_stores ls join mog.ltos l on l.id = ls.lto_id where ls.slug = p_slug))
         else '{}'::jsonb end;
$$;


-- ---------------------------------------------------------------------
-- An LTO's checks and record, inside mog_hq_apply
-- ---------------------------------------------------------------------

-- Before any store changes. send: the LTO is new, named, of one concept,
-- and created here so its items can name it. more / end / rollback /
-- standard: it exists, is running and is at the version HQ loaded (row
-- locked). Every store a change is for is one the action is about.
-- Raises CONFLICT: / REJECTED: for mog_hq_apply.
create or replace function mog.lto_before(p_by text, p_lto jsonb, p_changes jsonb)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_act     text := p_lto ->> 'action';
  v_id      text := p_lto ->> 'id';
  v_row     mog.ltos;
  v_name    text;
  v_concept text;
  v_slugs   text[];
  v_sent    text[];
  v_bad     text;
begin
  if p_lto is null then
    return;
  end if;
  if v_act is null or v_act not in ('send', 'more', 'end', 'rollback', 'standard') then
    raise exception 'REJECTED: an LTO''s action is send, more, end, rollback or standard';
  end if;
  if v_id is null or v_id !~ '^lto_[a-z0-9]{8,40}$' then
    raise exception 'REJECTED: no LTO called %', coalesce(v_id, '(none)');
  end if;
  select coalesce(array_agg(distinct c ->> 'slug'), '{}') into v_slugs
    from jsonb_array_elements(p_changes) c
   where case when jsonb_typeof(c -> 'ops') = 'array' then jsonb_array_length(c -> 'ops') else 1 end > 0;

  if v_act in ('send', 'more') then
    if jsonb_typeof(p_lto -> 'stores') is distinct from 'array' or jsonb_array_length(p_lto -> 'stores') = 0
       or jsonb_array_length(p_lto -> 'stores') > 50 then
      raise exception 'REJECTED: an LTO goes to 1 to 50 stores';
    end if;
    select coalesce(array_agg(s ->> 'slug'), '{}') into v_sent from jsonb_array_elements(p_lto -> 'stores') s;
    select x into v_bad from unnest(v_slugs) x where not (x = any (v_sent)) limit 1;
    if v_bad is not null then
      raise exception 'REJECTED: a change at %, which the LTO isn''t going to', v_bad;
    end if;
  end if;

  if v_act = 'send' then
    v_concept := p_lto ->> 'concept';
    v_name := mog.js_trim(p_lto ->> 'name');
    if v_concept is null or v_concept !~ '^[a-z0-9-]{1,30}$' then
      raise exception 'REJECTED: no concept called %', coalesce(v_concept, '(none)');
    end if;
    if v_name = '' or length(v_name) > 80 then
      raise exception 'REJECTED: an LTO needs a name of at most 80 characters';
    end if;
    if jsonb_typeof(p_lto -> 'items') is distinct from 'array' or jsonb_array_length(p_lto -> 'items') > 200 then
      raise exception 'REJECTED: an LTO''s items are a list of at most 200';
    end if;
    if exists (select 1 from mog.ltos l where l.id = v_id) then
      raise exception 'REJECTED: that LTO was already sent';
    end if;
    insert into mog.ltos (id, concept, name, items, created_by)
    values (v_id, v_concept, v_name, p_lto -> 'items', p_by);
  else
    select * into v_row from mog.ltos l where l.id = v_id for update;
    if not found then
      raise exception 'REJECTED: no LTO called %', v_id;
    end if;
    if v_row.status <> 'running' then
      raise exception 'REJECTED: LTO "%" is % already', v_row.name,
        case v_row.status when 'ended' then 'ended' when 'rolledback' then 'rolled back' else 'standard' end;
    end if;
    if jsonb_typeof(p_lto -> 'version') is distinct from 'number' or v_row.version <> (p_lto ->> 'version')::numeric then
      raise exception 'CONFLICT: LTO "%" was changed since HQ loaded it (by %)', v_row.name,
        coalesce(v_row.status_by, v_row.created_by);
    end if;
    v_concept := v_row.concept;
    if v_act = 'more' then
      select x into v_bad from unnest(v_sent) x
       where exists (select 1 from mog.lto_stores s where s.lto_id = v_id and s.slug = x) limit 1;
      if v_bad is not null then
        raise exception 'REJECTED: LTO "%" already went to %', v_row.name, v_bad;
      end if;
    else
      select x into v_bad from unnest(v_slugs) x
       where not exists (select 1 from mog.lto_stores s where s.lto_id = v_id and s.slug = x) limit 1;
      if v_bad is not null then
        raise exception 'REJECTED: LTO "%" never went to %', v_row.name, v_bad;
      end if;
    end if;
  end if;

  if v_act in ('send', 'more') then
    select x into v_bad from unnest(v_sent) x
     where not exists (select 1 from mog.stores s where s.slug = x and s.concept = v_concept) limit 1;
    if v_bad is not null then
      raise exception 'REJECTED: % isn''t a % store', coalesce(v_bad, '(no store)'), v_concept;
    end if;
  end if;
end;
$$;

-- After the stores changed. send / more: one row per store, with the
-- change that sent it (p_out is mog_hq_apply's [{ slug, changeId }]), the
-- vendors it added and the backups it added there. end / rollback /
-- standard: the new status. Returns { id, status, version }, or null.
create or replace function mog.lto_after(p_by text, p_lto jsonb, p_out jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_act text := p_lto ->> 'action';
  v_id  text := p_lto ->> 'id';
  s     jsonb;
begin
  if p_lto is null then
    return null;
  end if;
  if v_act in ('send', 'more') then
    for s in select x from jsonb_array_elements(p_lto -> 'stores') x loop
      if jsonb_typeof(s) is distinct from 'object'
         or jsonb_typeof(coalesce(s -> 'vendorsAdded', '[]'::jsonb)) <> 'array'
         or jsonb_typeof(coalesce(s -> 'backupsAdded', '[]'::jsonb)) <> 'array'
         or jsonb_array_length(coalesce(s -> 'backupsAdded', '[]'::jsonb)) > 2000 then
        raise exception 'REJECTED: each store of an LTO is { slug, vendorsAdded, backupsAdded }';
      end if;
      insert into mog.lto_stores (lto_id, slug, sent_by, change_id, vendors_added, backups_added)
      values (v_id, s ->> 'slug', p_by,
              (select (o ->> 'changeId')::bigint from jsonb_array_elements(p_out) o where o ->> 'slug' = s ->> 'slug'),
              mog.json_text_array(coalesce(s -> 'vendorsAdded', '[]'::jsonb)),
              coalesce(s -> 'backupsAdded', '[]'::jsonb));
    end loop;
    if v_act = 'more' then
      update mog.ltos l set version = l.version + 1 where l.id = v_id;
    end if;
  else
    update mog.ltos l
       set status = case v_act when 'end' then 'ended' when 'rollback' then 'rolledback' else 'standard' end,
           status_at = now(), status_by = p_by, version = l.version + 1
     where l.id = v_id;
  end if;
  return (select jsonb_build_object('id', l.id, 'status', l.status, 'version', l.version) from mog.ltos l where l.id = v_id);
end;
$$;


-- ---------------------------------------------------------------------
-- HQ: the read and the save (from schema_v12.sql)
-- ---------------------------------------------------------------------

-- v12's read, plus every LTO with the stores it went to.
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
    'ltos', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'concept', l.concept, 'name', l.name, 'items', l.items, 'status', l.status,
               'version', l.version, 'createdAt', l.created_at, 'createdBy', l.created_by,
               'statusAt', l.status_at, 'statusBy', l.status_by,
               'stores', coalesce((
                 select jsonb_agg(jsonb_build_object('slug', s.slug, 'sentAt', s.sent_at, 'sentBy', s.sent_by,
                                                     'changeId', s.change_id, 'vendorsAdded', to_jsonb(s.vendors_added),
                                                     'backupsAdded', s.backups_added) order by s.sent_at, s.slug)
                   from mog.lto_stores s where s.lto_id = l.id), '[]'::jsonb))
             order by l.created_at desc, l.id)
        from mog.ltos l), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'at', c.at, 'by', c.by_name, 'label', c.label,
                                          'undoneBy', c.undone_by) order by c.id desc)
        from (select * from mog.change_log x where x.by_name like 'HQ · %' order by x.id desc limit 50) c), '[]'::jsonb)));
end;
$$;

-- v12's save, plus the LTO: its checks before any store changes, its
-- record after, all in the same all-or-none block.
create or replace function public.mog_hq_apply(p_token text, p_changes jsonb, p_links jsonb, p_libraries jsonb, p_lto jsonb)
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
  v_lto  jsonb;
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
  if p_lto is not null and jsonb_typeof(p_lto) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'lto must be an object');
  end if;
  v_by := left('HQ · ' || v_name, 40);

  -- One editor write at a time per store (as mog_editor_apply), taken in
  -- slug order so two HQ saves never wait on each other in a circle.
  perform 1 from mog.stores s
   where s.slug in (select c ->> 'slug' from jsonb_array_elements(p_changes) c)
   order by s.slug for update;

  begin
    -- The LTO first (schema v14): a new one exists before its items name it.
    perform mog.lto_before(v_by, p_lto, p_changes);

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

    -- The LTO's record, with each store's change (schema v14).
    v_lto := mog.lto_after(v_by, p_lto, v_out);
  exception when others then
    if sqlerrm like 'CONFLICT: %' then
      return jsonb_build_object('ok', false, 'error', 'CONFLICT', 'detail', substr(sqlerrm, 11));
    end if;
    if sqlerrm like 'REJECTED: %' then
      return jsonb_build_object('ok', false, 'error', sqlerrm);
    end if;
    return jsonb_build_object('ok', false, 'error', 'REJECTED: ' || sqlerrm);
  end;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object('by', v_by, 'changes', v_out, 'libraries', v_libs, 'lto', v_lto));
end;
$$;

-- The v12 call, for an HQ page opened before this file ran.
create or replace function public.mog_hq_apply(p_token text, p_changes jsonb, p_links jsonb, p_libraries jsonb)
returns jsonb
language sql volatile security definer
set search_path = ''
as $$
  select public.mog_hq_apply(p_token, p_changes, p_links, p_libraries, null::jsonb);
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
    'public.mog_hq_apply(text, jsonb, jsonb, jsonb)',
    'public.mog_hq_apply(text, jsonb, jsonb, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
