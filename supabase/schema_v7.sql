-- =====================================================================
-- MOG on Supabase — schema v7   (run AFTER schema.sql and v2 through v6)
-- =====================================================================
-- One app per store, Phase 3 (docs/MOG_OneApp_Spec.md): quick edits from a
-- phone's count screen.
--   * "Just today": a par for this cycle only, or an existing item added to a
--     vendor's list for this cycle only. They are cycle data, so they work on
--     every store whose phones are on Supabase; the next cycle has none.
--   * "From now on": the item's par changes in the catalog, logged in
--     mog.change_log (with Undo). Only where Supabase owns the catalog
--     (editor_direct); everywhere else the phone offers "just today" only.
--
-- Adds:
--   * mog.quick_edits: every "just today" edit: when, who, which cycle, item,
--     vendor, par before and after, whether it was taken back, and its review
--     state for Manage Items (open / applied / dismissed / reverted).
--   * mog_quick_edit(token, cycleDate, kind, vendor, itemId, par, by, haveVersion):
--     kinds par_today, par_today_clear, add_today, add_today_remove. The
--     phone_direct rules of the other phone calls; refused unless cycleDate is
--     the current cycle (STALE_CYCLE). Answers the fresh snapshot, like
--     mog_set_vendor_pick.
--   * mog_set_par(token, itemId, parBefore, par, by, haveVersion): "from now
--     on". Needs editor_direct; refused (CONFLICT) when the par is no longer
--     parBefore. Logs to mog.change_log, ends the item's today par, rebuilds
--     the catalog phones read.
--   * mog_editor_review(token, id, status): Manage Items marks a today edit
--     applied or dismissed.
--   * mog.prepare_test_store(slug), SQL Editor only: gives a test store
--     (is_test) a cycle and turns its phones on, so the phone app can be tried
--     against it.
--
-- Replaces:
--   * mog.snapshot_json: the state also carries todayEdits = { pars: {itemId:
--     par}, adds: [[vendor, itemId]] } for the current cycle, and the answer
--     carries editorDirect. apps-script/OrderMath.gs applies todayEdits in
--     orderInputsFromSnapshot_, so the phone, /exec, the nightly order log and
--     the recap all honour them. Older app versions ignore both fields.
--   * mog.editor_data: also the open reviews (mog_editor_get, mog_editor_login).
--
-- Deploy order: apps-script/OrderMath.gs (deploy.py --redeploy) must be live
-- BEFORE any phone can make a today edit, or the nightly order log would
-- ignore it. This file alone changes nothing a phone shows.
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================


-- ---------------------------------------------------------------------
-- Quick edits
-- ---------------------------------------------------------------------

create table if not exists mog.quick_edits (
  id          bigint generated always as identity primary key,
  slug        text not null references mog.stores (slug) on delete cascade,
  cycle_date  date not null,
  at          timestamptz not null default now(),
  by_name     text,                                  -- null = no name given ("Someone")
  kind        text not null check (kind in ('par_today', 'add_today')),
  vendor      text,                                  -- the list it was made on / joined
  item_id     text not null,
  par_before  numeric,                               -- par_today: the catalog par then
  par_after   numeric,                               -- par_today: the par for the day
  active      boolean not null default true,         -- false once taken back on a phone
  review      text not null default 'open'
              check (review in ('open', 'applied', 'dismissed', 'reverted')),
  reviewed_at timestamptz
);
create index if not exists quick_edits_cycle_idx  on mog.quick_edits (slug, cycle_date);
create index if not exists quick_edits_review_idx on mog.quick_edits (slug, review);
alter table mog.quick_edits enable row level security;


-- ---------------------------------------------------------------------
-- The snapshot, with this cycle's today edits (replaces schema.sql's)
-- ---------------------------------------------------------------------

create or replace function mog.today_edits_json(p_slug text, p_cycle date)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'pars', coalesce((
      select jsonb_object_agg(q.item_id, q.par_after)
        from (select distinct on (e.item_id) e.item_id, e.par_after
                from mog.quick_edits e
               where e.slug = p_slug and e.cycle_date = p_cycle and e.kind = 'par_today' and e.active
               order by e.item_id, e.id desc) q), '{}'::jsonb),
    'adds', coalesce((
      select jsonb_agg(jsonb_build_array(e.vendor, e.item_id) order by e.id)
        from mog.quick_edits e
       where e.slug = p_slug and e.cycle_date = p_cycle and e.kind = 'add_today' and e.active), '[]'::jsonb));
$$;

create or replace function mog.snapshot_json(p_slug text, p_auth text, p_have_version bigint)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  c       mog.catalog%rowtype;
  st      mog.store_state%rowtype;
  v_tz    text;
  v_today date;
begin
  select * into c from mog.catalog where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;
  select * into st from mog.store_state where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;

  -- "Today" in the store's own time zone (the spreadsheet's), the same frame
  -- of reference as the Sheet's =TODAY() in ORDER_ENTRY!AE2.
  v_tz    := coalesce(nullif(c.payload ->> 'timeZone', ''), 'America/New_York');
  v_today := (now() at time zone v_tz)::date;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'slug',           p_slug,
    'authType',       p_auth,
    'isManagerMode',  p_auth = 'master',
    'editorDirect',   coalesce((select s.editor_direct from mog.stores s where s.slug = p_slug), false),
    'catalogVersion', c.version,
    'catalog',        case when p_have_version is not null and p_have_version = c.version
                           then null else c.payload end,
    'state', jsonb_build_object(
      'cycleDate',         to_char(st.cycle_date, 'YYYY-MM-DD'),
      'dayOfWeek',         st.day_of_week,
      'today',             to_char(v_today, 'YYYY-MM-DD'),
      'isStale',           st.cycle_date < v_today,      -- mirrors getResetStaleness_ (Core.gs)
      'emergencyOverride', st.emergency_override,
      'vendorPicks',       st.vendor_picks,
      'todaysLog',         st.todays_log,
      'todayEdits',        mog.today_edits_json(p_slug, st.cycle_date),
      'updatedAt',         st.updated_at),
    'counts', coalesce((
      select jsonb_agg(jsonb_build_object('vendor', k.vendor, 'id', k.item_id, 'onHand', k.on_hand)
                       order by k.vendor, k.item_id)
        from mog.counts k
       where k.slug = p_slug and k.cycle_date = st.cycle_date
    ), '[]'::jsonb),
    'serverTime', now()));
end;
$$;


-- ---------------------------------------------------------------------
-- Phone entry points (the phone_direct rules of schema v3)
-- ---------------------------------------------------------------------

-- A "just today" edit, made on the current cycle. par_today replaces any
-- earlier today par for the item (a par equal to the catalog's just clears
-- it); par_today_clear goes back to the catalog par; add_today puts an
-- active item on a vendor's list for today (refused when it's already
-- there); add_today_remove takes it off again. A taken-back edit leaves the
-- review list ("reverted").
create or replace function public.mog_quick_edit(
  p_token text, p_cycle_date date, p_kind text, p_vendor text, p_item_id text,
  p_par numeric default null, p_by text default null, p_have_version bigint default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_sess   mog.sessions%rowtype;
  st       mog.store_state%rowtype;
  c        mog.catalog%rowtype;
  v_id     text := btrim(coalesce(p_item_id, ''));
  v_vendor text;
  v_by     text := nullif(left(btrim(coalesce(p_by, '')), 40), '');
  v_item   jsonb;
  v_normal numeric;
begin
  select * into v_sess from mog.sessions
   where token_hash = mog.sha256_hex(p_token) and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  if not mog.phone_direct_on(v_sess.slug) then
    return jsonb_build_object('ok', false, 'error', 'USE_EXEC');
  end if;

  perform 1 from mog.stores s where s.slug = v_sess.slug for update;   -- one edit at a time per store
  select * into st from mog.store_state where slug = v_sess.slug;
  select * into c  from mog.catalog     where slug = v_sess.slug;
  if st.slug is null or c.slug is null then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;
  if p_cycle_date is null or p_cycle_date <> st.cycle_date then
    return jsonb_build_object('ok', false, 'error', 'STALE_CYCLE');
  end if;
  v_item := c.payload -> 'items' -> v_id;
  if v_id = '' or v_item is null then
    return jsonb_build_object('ok', false, 'error', 'Unknown item');
  end if;

  if p_kind in ('par_today', 'par_today_clear') then
    if p_kind = 'par_today' and (p_par is null or p_par < 0 or p_par > 100000) then
      return jsonb_build_object('ok', false, 'error', 'Par must be a number from 0 up.');
    end if;
    update mog.quick_edits
       set active = false, review = case when review = 'open' then 'reverted' else review end
     where slug = v_sess.slug and cycle_date = st.cycle_date and kind = 'par_today'
       and item_id = v_id and active;
    v_normal := case when jsonb_typeof(v_item -> 'par') = 'number' then (v_item ->> 'par')::numeric end;
    if p_kind = 'par_today' and p_par is distinct from v_normal then
      insert into mog.quick_edits (slug, cycle_date, by_name, kind, vendor, item_id, par_before, par_after)
      values (v_sess.slug, st.cycle_date, v_by, 'par_today', nullif(btrim(coalesce(p_vendor, '')), ''), v_id, v_normal, p_par);
    end if;

  elsif p_kind in ('add_today', 'add_today_remove') then
    select x into v_vendor from jsonb_array_elements_text(coalesce(c.payload -> 'vendorList', '[]'::jsonb)) x
     where x = btrim(coalesce(p_vendor, '')) limit 1;
    if v_vendor is null then
      return jsonb_build_object('ok', false, 'error', 'Vendor is not listed');
    end if;
    if p_kind = 'add_today_remove' then
      update mog.quick_edits
         set active = false, review = case when review = 'open' then 'reverted' else review end
       where slug = v_sess.slug and cycle_date = st.cycle_date and kind = 'add_today'
         and vendor = v_vendor and item_id = v_id and active;
    else
      if (v_item ->> 'active') is distinct from 'true' then
        return jsonb_build_object('ok', false, 'error', 'That item is inactive.');
      end if;
      if exists (select 1 from jsonb_array_elements(coalesce(c.payload -> 'pickRows', '[]'::jsonb)) r
                  where lower(coalesce(r ->> 0, '')) = lower(v_vendor) and btrim(coalesce(r ->> 1, '')) = v_id)
         or exists (select 1 from mog.quick_edits e
                     where e.slug = v_sess.slug and e.cycle_date = st.cycle_date and e.kind = 'add_today'
                       and e.vendor = v_vendor and e.item_id = v_id and e.active) then
        return jsonb_build_object('ok', false, 'error', 'Already on this list');
      end if;
      insert into mog.quick_edits (slug, cycle_date, by_name, kind, vendor, item_id)
      values (v_sess.slug, st.cycle_date, v_by, 'add_today', v_vendor, v_id);
    end if;

  else
    return jsonb_build_object('ok', false, 'error', 'Unknown kind');
  end if;

  return mog.snapshot_json(v_sess.slug, v_sess.auth_type, p_have_version);
end;
$$;

-- "From now on": the item's catalog par, on a store whose catalog Supabase
-- owns. Logged like an editor change (Undo works the same), with any today
-- par for the item ended: the catalog now says what the day should.
create or replace function public.mog_set_par(
  p_token text, p_item_id text, p_par_before numeric, p_par numeric,
  p_by text default null, p_have_version bigint default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_sess   mog.sessions%rowtype;
  i        mog.items%rowtype;
  v_before jsonb;
  v_after  jsonb;
  v_by     text := nullif(left(btrim(coalesce(p_by, '')), 40), '');
  v_cycle  date;
begin
  select * into v_sess from mog.sessions
   where token_hash = mog.sha256_hex(p_token) and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  if not mog.phone_direct_on(v_sess.slug) then
    return jsonb_build_object('ok', false, 'error', 'USE_EXEC');
  end if;
  if not exists (select 1 from mog.stores s where s.slug = v_sess.slug and s.editor_direct) then
    return jsonb_build_object('ok', false, 'error', 'EDITOR_NOT_DIRECT');
  end if;
  if p_par is null or p_par < 0 or p_par > 100000 then
    return jsonb_build_object('ok', false, 'error', 'Par must be a number from 0 up.');
  end if;

  perform 1 from mog.stores s where s.slug = v_sess.slug for update;
  select * into i from mog.items where slug = v_sess.slug and item_id = btrim(coalesce(p_item_id, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Unknown item');
  end if;
  if i.par is distinct from p_par_before then
    return jsonb_build_object('ok', false, 'error', 'CONFLICT', 'detail', 'items ' || i.item_id || ' has changed');
  end if;

  if i.par is distinct from p_par then
    v_before := mog.item_row_json(i);
    update mog.items set par = p_par where slug = v_sess.slug and item_id = i.item_id returning * into i;
    v_after := mog.item_row_json(i);
    insert into mog.change_log (slug, by_name, label, ops)
    values (v_sess.slug, v_by,
            left('Changed the par of "' || i.name || '" on a phone: ' ||
                 coalesce(trim_scale((v_before ->> 'par')::numeric)::text, '(blank)') || ' → ' || trim_scale(p_par)::text, 300),
            jsonb_build_array(jsonb_build_object('t', 'items', 'before', v_before, 'after', v_after)));
  end if;

  select cycle_date into v_cycle from mog.store_state where slug = v_sess.slug;
  update mog.quick_edits
     set active = false, review = case when review = 'open' then 'reverted' else review end
   where slug = v_sess.slug and cycle_date = v_cycle and kind = 'par_today' and item_id = i.item_id and active;
  perform mog.editor_publish(v_sess.slug);
  return mog.snapshot_json(v_sess.slug, v_sess.auth_type, p_have_version);
end;
$$;


-- ---------------------------------------------------------------------
-- Manage Items: the review list (replaces schema v6's editor_data)
-- ---------------------------------------------------------------------

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
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'at', q.at, 'by', q.by_name,
                                          'cycleDate', to_char(q.cycle_date, 'YYYY-MM-DD'), 'kind', q.kind,
                                          'vendor', q.vendor, 'itemId', q.item_id,
                                          'parBefore', q.par_before, 'parAfter', q.par_after) order by q.id desc)
        from (select * from mog.quick_edits e where e.slug = s.slug and e.review = 'open'
               order by e.id desc limit 200) q), '[]'::jsonb),
    'catalogVersion', (select c.version from mog.catalog c where c.slug = s.slug))
  from mog.stores s where s.slug = p_slug;
$$;

create or replace function public.mog_editor_review(p_token text, p_id bigint, p_status text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v   jsonb := mog.editor_session(p_token);
  v_n integer;
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  if p_status is null or p_status not in ('applied', 'dismissed') then
    return jsonb_build_object('ok', false, 'error', 'Status must be applied or dismissed');
  end if;
  update mog.quick_edits
     set review = p_status, reviewed_at = now()
   where id = p_id and slug = v ->> 'slug' and review = 'open';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'Not waiting for review');
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('id', p_id, 'review', p_status));
end;
$$;


-- ---------------------------------------------------------------------
-- SQL Editor only: a test store's phones
-- ---------------------------------------------------------------------

-- Let the phone app run against a test store (D21's rprfotest): a cycle
-- starting today, in the store's time zone, and phones on. Refuses a real
-- store. The test store has no Sheet, so nothing ever closes its cycle; run
-- this again to start a fresh one (it clears that store's counts and today
-- edits).
--     select mog.prepare_test_store('rprfotest');
create or replace function mog.prepare_test_store(p_slug text)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s     mog.stores%rowtype;
  v_day date;
begin
  select * into s from mog.stores where slug = p_slug for update;
  if not found then
    raise exception 'No store %', p_slug;
  end if;
  if not s.is_test then
    raise exception 'Store % is a real store; refusing', p_slug;
  end if;
  if not exists (select 1 from mog.catalog c where c.slug = p_slug) then
    raise exception 'Store % has no catalog: run mog.copy_store_catalog first', p_slug;
  end if;
  v_day := (now() at time zone coalesce(nullif(s.time_zone, ''), 'America/New_York'))::date;
  delete from mog.counts      where slug = p_slug;
  delete from mog.quick_edits where slug = p_slug;
  insert into mog.store_state (slug, cycle_date, day_of_week)
  values (p_slug, v_day, to_char(v_day, 'Dy'))
  on conflict (slug) do update
     set cycle_date = excluded.cycle_date, day_of_week = excluded.day_of_week,
         emergency_override = false, vendor_picks = '{}'::jsonb, todays_log = '[]'::jsonb, updated_at = now();
  update mog.stores set phone_direct = true where slug = p_slug;
  return format('Test store %s: phones on, cycle %s (%s).', p_slug, v_day, to_char(v_day, 'Dy'));
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: lock the new table and internals, open exactly the three
-- new entry points.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_quick_edit(text, date, text, text, text, numeric, text, bigint)',
    'public.mog_set_par(text, text, numeric, numeric, text, bigint)',
    'public.mog_editor_review(text, bigint, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
