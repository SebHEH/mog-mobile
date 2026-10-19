-- =====================================================================
-- MOG on Supabase — schema v8   (run AFTER schema.sql and v2 to v7)
-- =====================================================================
-- One app per store, Phase 4 (docs/MOG_OneApp_Spec.md): Manage Vendors,
-- Storage Areas and Shelf to Sheet on Supabase, and the switch that hands a
-- store's catalog to the app. TNY Rockville (tnyr, tnyrf) switches first.
--
-- Adds:
--   * a "rename" step in the editor's changes: { "rename": "areas", "from",
--     "to" } renames a storage area, and its pick rows follow (the table's on
--     update cascade, D19). Storage Areas' save renames this way; a delete and
--     an add would take the area's pick rows with the delete. Undo renames it
--     back.
--   * mog_sync_switch_editor(slug, key, startEmpty): the Sheet's menu item
--     "Move the editor to the app". Turns the store's editor_direct on, so the
--     app's editor writes the catalog and the Sheet's pushes are refused
--     (schema v4), and rebuilds the catalog phones read from the tables (D22).
--     startEmpty = true clears the store's catalog tables first (a store whose
--     Sheet is an unused copy, like TNY Rockville); false keeps the tables the
--     Sheet seeded just before (mog_sync_seed_catalog). Switching a store that
--     is already switched changes nothing. Its sync key, as every mog_sync_*.
--
-- Replaces:
--   * mog.editor_apply_ops: the rename step.
--   * mog_editor_undo: renames go back; the "undo that first" search skips them.
--
-- The app never copies the catalog back into the Sheet (Sebastian,
-- 2026-10-18): once a store switches, its Sheet keeps the catalog it had.
-- Emergency rollback for one store, in the SQL Editor:
--   update mog.stores set editor_direct = false where slug = '<slug>';
-- then, in that Sheet, run Sync.gs editorBackToSheet (it clears the Sheet's
-- mark, so its catalog tools work and push again).
--
-- Re-running is safe (CREATE OR REPLACE).
-- =====================================================================


-- ---------------------------------------------------------------------
-- The editor's changes: the rename step
-- ---------------------------------------------------------------------

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

  -- Each change reversed, last first; a renamed area goes back. Seq shifts
  -- stay: a gap in the order changes nothing.
  select coalesce(jsonb_agg(case when x.e ? 'rename'
                                 then jsonb_build_object('rename', x.e ->> 'rename', 'from', x.e -> 'to', 'to', x.e -> 'from')
                                 else jsonb_build_object('t', x.e ->> 't', 'before', x.e -> 'after', 'after', x.e -> 'before') end
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
            where not (le ? 'shift') and not (ce ? 'shift') and not (le ? 'rename') and not (ce ? 'rename')
              and le ->> 't' = ce ->> 't'
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
-- Moving a store's editor to the app
-- ---------------------------------------------------------------------

create or replace function public.mog_sync_switch_editor(p_slug text, p_key text, p_start_empty boolean)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s     mog.stores%rowtype;
  v_ver bigint;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  select * into s from mog.stores where slug = p_slug for update;   -- one switch, seed or editor write at a time
  if s.editor_direct then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('alreadySwitched', true,
      'catalogVersion', (select c.version from mog.catalog c where c.slug = p_slug)));
  end if;

  if coalesce(p_start_empty, false) then
    delete from mog.pick_rows where slug = p_slug;
    delete from mog.items     where slug = p_slug;
    delete from mog.areas     where slug = p_slug;
    delete from mog.vendors   where slug = p_slug;
    -- Phones' one-day edits name items that are gone now.
    update mog.quick_edits
       set active = false, review = case when review = 'open' then 'dismissed' else review end
     where slug = p_slug and (active or review = 'open');
  elsif not exists (select 1 from mog.vendors v where v.slug = p_slug)
        and not exists (select 1 from mog.items i where i.slug = p_slug) then
    return jsonb_build_object('ok', false, 'error', 'NOT_SEEDED');
  end if;

  update mog.stores set editor_direct = true where slug = p_slug;
  v_ver := mog.editor_publish(p_slug);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('alreadySwitched', false,
    'startedEmpty', coalesce(p_start_empty, false), 'catalogVersion', v_ver));
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: internals stay locked; the switch is a sync call like the rest
-- ---------------------------------------------------------------------

revoke all on all functions in schema mog from public, anon, authenticated;
revoke all on function public.mog_sync_switch_editor(text, text, boolean) from public, anon, authenticated;
grant execute on function public.mog_sync_switch_editor(text, text, boolean) to anon, authenticated;

notify pgrst, 'reload schema';
