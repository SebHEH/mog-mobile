-- =====================================================================
-- MOG on Supabase — schema v15   (run AFTER schema.sql and v2 to v14)
-- =====================================================================
-- Renaming a vendor at a store (Sebastian, 2026-11-02): the store's
-- Vendors page can now change a vendor's name, so names can be lined up
-- across stores ("B&T" to "B&T Distribution", "ELPIS" to "Elpis"). As in
-- v8's storage area rename, it reaches this file as a rename step in the
-- editor's changes, { "rename": "vendors", "from", "to" }, not as a delete
-- and an add: a delete would take HQ's remembered name for the store with
-- it and leave the counts already saved today under a name no list has.
--
-- Replaces (same signature):
--   * mog.editor_apply_ops (from v14): the rename step also takes
--     "vendors". The vendor's row is renamed, and its items' main vendor,
--     its pick rows and HQ's remembered names follow (their on update
--     cascade). The step renames it in the items' vendor lists
--     (eligible_vendors), the store's counts (a count already under the new
--     name keeps its place), its "just today" edits, the override's day
--     picks and presence. Refused with CONFLICT: a vendor that isn't there
--     by that exact name, or a new name another vendor has (ignoring case).
--     A change of capitals only ("ELPIS" to "Elpis") is a rename.
--   * mog_editor_undo needs no change: since v8 it reverses any rename step
--     (to back to from), and its "undo that first" search skips them.
--
-- Not renamed: the order log and the recap (history keeps the name it
-- had), and an LTO's record of the vendors it added (Roll back then leaves
-- a renamed vendor in place; it still deletes the LTO's items).
--
-- Adds no table, column or public function. Writes no store data.
-- Re-running is safe (CREATE OR REPLACE).
-- =====================================================================

do $$
begin
  if to_regclass('mog.ltos') is null or to_regclass('mog.quick_edits') is null or to_regclass('mog.presence') is null then
    raise exception 'Run schema_v14.sql first: mog.ltos is missing.';
  end if;
end;
$$;


-- Apply ops to a store's tables (v14), with a vendor rename step too.
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


-- ---------------------------------------------------------------------
-- Privileges: no new entry point; the internals stay locked.
-- ---------------------------------------------------------------------

revoke all on all functions in schema mog from public, anon, authenticated;

notify pgrst, 'reload schema';
