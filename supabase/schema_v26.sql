-- =====================================================================
-- MOG on Supabase — schema v26   (run AFTER schema.sql and v2 to v25)
-- =====================================================================
-- Sheet retirement step 4 (docs/MOG_SheetRetirement_Spec.md, R5 and R6;
-- walkthrough and mockups approved by Sebastian 2026-11-15):
--
--   * HQ → Stores → New store: one call makes a whole store in one
--     transaction, with no Sheet behind it: its row (phones, Manage and the
--     nightly close all on Supabase), today's cycle, an empty catalog and
--     the GM as its first recap recipient. Then the store is put on the web
--     with stores.json and build.py, as before.
--   * PINs belong to Supabase. HQ sets a store's PIN. A Sheet's PIN push
--     (mog_sync_set_pins) is refused with PINS_IN_HQ once Supabase closes
--     that store (close_direct), so nothing overwrites what HQ set.
--   * One manager PIN for every store (Sebastian, 2026-11-15: "the same
--     across all stores and concepts, locked to one PIN"). It lives once in
--     mog.manager_pin; HQ sets it for every store at once, a new store gets
--     it, and a trigger keeps every store's master_pin_hash equal to it, so
--     nothing can give one store a different manager PIN. Until it's first
--     set in HQ, each store keeps the manager PIN its Sheet gave it.
--
-- The one new public entry point: mog_hq_stores(token, action, row), for
-- HQ people with the hq role. mog_hq_data gains each store's PIN dates,
-- flags, time zone, address and recap count, and the manager PIN's state.
--
-- Rollback: re-run mog_hq_data from schema_v14.sql and mog_sync_set_pins
-- from schema.sql (create or replace), and turn the trigger off with
-- `alter table mog.stores disable trigger stores_manager_pin;`. The new
-- columns and mog.manager_pin are read by nothing else. A store made in HQ
-- stays (it is a store like any other).
-- Re-running is safe: columns and the table are `if not exists`, the
-- functions and the trigger `create or replace`.
-- =====================================================================

do $$
begin
  if to_regprocedure('mog.night_due(timestamptz)') is null
     or to_regprocedure('mog.hq_session(text)') is null
     or to_regprocedure('mog.editor_publish(text)') is null
     or to_regprocedure('mog.wh_error(text)') is null then
    raise exception 'Run schema_v25.sql (and everything before it) first.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- What a store made in HQ, and its PIN, record
-- ---------------------------------------------------------------------

alter table mog.stores add column if not exists address    text check (address is null or length(address) <= 200);
alter table mog.stores add column if not exists created_by text;          -- the HQ person; null = it came from a Sheet
alter table mog.stores add column if not exists pin_set_at timestamptz;   -- the store PIN's last change in HQ
alter table mog.stores add column if not exists pin_set_by text;

-- The one manager PIN (bcrypt), once set in HQ. One row at most.
create table if not exists mog.manager_pin (
  id       boolean primary key default true check (id),
  pin_hash text not null,
  set_at   timestamptz not null default now(),
  set_by   text not null
);
alter table mog.manager_pin enable row level security;

-- Every store's manager PIN is the one in mog.manager_pin, whatever writes
-- the row: a store made in HQ, a Sheet's provisioning, a test store's copy.
create or replace function mog.stores_manager_pin()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v text;
begin
  select m.pin_hash into v from mog.manager_pin m;
  if v is not null then
    new.master_pin_hash := v;
  end if;
  return new;
end;
$$;

create or replace trigger stores_manager_pin
  before insert or update of master_pin_hash on mog.stores
  for each row execute function mog.stores_manager_pin();

-- ---------------------------------------------------------------------
-- The rules (internal; HQ reaches them through mog_hq_stores)
-- ---------------------------------------------------------------------

-- A PIN is 4 to 8 digits (the setup wizard's rule).
create or replace function mog.pin_ok(p text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select coalesce(p, '') ~ '^[0-9]{4,8}$';
$$;

-- The four concepts a store can be, by their theme keys, and the name each
-- store's location starts with. A new concept is a code change (themes,
-- build.py, the app), so it is added here in the same change.
create or replace function mog.concept_name(p_concept text)
returns text
language sql immutable
set search_path = ''
as $$
  select case p_concept
           when 'roll-play' then 'Roll Play'
           when 'teasnyou'  then 'Teas''n You'
           when 'an'        then 'ĂN'
           when 'leid'      then 'Lei''d Poke'
         end;
$$;

-- Is this the manager PIN?
create or replace function mog.is_manager_pin(p_pin text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from mog.manager_pin m
                  where extensions.crypt(coalesce(p_pin, ''), m.pin_hash) = m.pin_hash);
$$;

-- A new store, in one transaction (R5). p_row: { concept, side, site,
-- slug, abbr, timeZone?, address?, pin, gmEmail?, isTest? }. Raises
-- 'REJECTED: ...' with what to fix. The store's name is
-- "<concept name> <site> <side>", plus " (TEST)" for a test store.
create or replace function mog.store_create(p_by text, p_row jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_concept text := btrim(coalesce(p_row ->> 'concept', ''));
  v_cname   text := mog.concept_name(btrim(coalesce(p_row ->> 'concept', '')));
  v_side    text := upper(btrim(coalesce(p_row ->> 'side', '')));
  v_site    text := regexp_replace(btrim(coalesce(p_row ->> 'site', '')), '\s+', ' ', 'g');
  v_slug    text := lower(btrim(coalesce(p_row ->> 'slug', '')));
  v_abbr    text := upper(btrim(coalesce(p_row ->> 'abbr', '')));
  v_tz      text := coalesce(nullif(btrim(coalesce(p_row ->> 'timeZone', '')), ''), 'America/New_York');
  v_address text := nullif(btrim(coalesce(p_row ->> 'address', '')), '');
  v_pin     text := coalesce(p_row ->> 'pin', '');
  v_email   text := lower(nullif(btrim(coalesce(p_row ->> 'gmEmail', '')), ''));
  v_test    boolean := coalesce((p_row ->> 'isTest')::boolean, false);
  v_loc     text;
  v_day     date;
begin
  if v_cname is null then
    raise exception 'REJECTED: pick the concept';
  end if;
  if v_side not in ('BOH', 'FOH') then
    raise exception 'REJECTED: pick BOH or FOH';
  end if;
  if length(v_site) < 2 or length(v_site) > 40 then
    raise exception 'REJECTED: the site is 2 to 40 letters (the place, like Ballston)';
  end if;
  if v_site ~* '\m(BOH|FOH)\M' then
    raise exception 'REJECTED: leave BOH or FOH out of the site: pick the side instead';
  end if;
  if lower(v_site) like lower(v_cname) || '%' then
    raise exception 'REJECTED: the site is the place only (like Ballston), without the concept';
  end if;
  v_loc := v_cname || ' ' || v_site || ' ' || v_side || case when v_test then ' (TEST)' else '' end;
  if exists (select 1 from mog.stores s where lower(s.location) = lower(v_loc)) then
    raise exception 'REJECTED: there''s already a store called %', v_loc;
  end if;

  if v_slug !~ '^[a-z0-9]{2,20}$' then
    raise exception 'REJECTED: the web address is 2 to 20 lowercase letters or digits, no spaces or dashes';
  end if;
  -- Folders the site already has at its root (hq/, docs/, ...).
  if v_slug in ('hq', 'docs', 'icons', 'supabase', 'template', 'tests', 'scripts', 'brand', 'assets', 'editor', 'preview') then
    raise exception 'REJECTED: the web address % is taken by the site itself', v_slug;
  end if;
  if exists (select 1 from mog.stores s where s.slug = v_slug) then
    raise exception 'REJECTED: the web address % is taken', v_slug;
  end if;
  if v_abbr !~ '^[A-Z0-9]{2,10}$' then
    raise exception 'REJECTED: the store code is 2 to 10 capital letters or digits';
  end if;
  begin
    perform now() at time zone v_tz;
  exception when others then
    raise exception 'REJECTED: % isn''t a time zone', v_tz;
  end;
  if v_address is not null and length(v_address) > 200 then
    raise exception 'REJECTED: the address is 200 characters at most';
  end if;
  if not mog.pin_ok(v_pin) then
    raise exception 'REJECTED: the store PIN is 4 to 8 digits';
  end if;
  if mog.is_manager_pin(v_pin) then
    raise exception 'REJECTED: that''s the manager PIN: a store PIN must be different';
  end if;
  if v_email is not null and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 120) then
    raise exception 'REJECTED: the GM email doesn''t look like an email address';
  end if;

  -- A sync key nobody holds: no Sheet will ever write to this store.
  insert into mog.stores (slug, sync_key_hash, pin_hash, time_zone, location, abbr, concept, side,
                          phone_direct, editor_direct, close_direct, is_test, recipients_seeded,
                          address, created_by, pin_set_at, pin_set_by)
  values (v_slug, mog.sha256_hex(encode(extensions.gen_random_bytes(32), 'hex')),
          extensions.crypt(v_pin, extensions.gen_salt('bf', 8)), v_tz, v_loc, v_abbr, v_concept, v_side,
          true, true, true, v_test, true,
          v_address, p_by, now(), p_by);

  v_day := (now() at time zone v_tz)::date;
  insert into mog.store_state (slug, cycle_date, day_of_week)
  values (v_slug, v_day, to_char(v_day, 'Dy'));

  if v_email is not null then
    insert into mog.recipients (slug, pos, name, email, active, gm)
    values (v_slug, 1, 'GM', v_email, true, true);
  end if;

  perform mog.editor_publish(v_slug);   -- the empty catalog the phones read

  return jsonb_build_object('slug', v_slug, 'location', v_loc, 'abbr', v_abbr, 'isTest', v_test,
    'cycleDate', to_char(v_day, 'YYYY-MM-DD'), 'dayOfWeek', to_char(v_day, 'Dy'),
    'managerPin', exists (select 1 from mog.manager_pin), 'recipients', case when v_email is null then 0 else 1 end);
end;
$$;

-- A store's PIN, set in HQ (R6). Every phone and computer signed in at the
-- store is signed out, and its lockout is cleared.
create or replace function mog.store_set_pin(p_by text, p_slug text, p_pin text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s     mog.stores%rowtype;
  v_out integer;
begin
  select * into s from mog.stores where slug = lower(btrim(coalesce(p_slug, ''))) for update;
  if not found then
    raise exception 'REJECTED: there''s no store %', coalesce(p_slug, '(none)');
  end if;
  if not mog.pin_ok(p_pin) then
    raise exception 'REJECTED: the store PIN is 4 to 8 digits';
  end if;
  if mog.is_manager_pin(p_pin) then
    raise exception 'REJECTED: that''s the manager PIN: a store PIN must be different';
  end if;
  update mog.stores
     set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 8)),
         pin_set_at = now(), pin_set_by = p_by, fail_count = 0, locked_until = null
   where slug = s.slug;
  delete from mog.sessions where slug = s.slug;
  get diagnostics v_out = row_count;
  return jsonb_build_object('slug', s.slug, 'location', s.location, 'signedOut', v_out);
end;
$$;

-- The one manager PIN, for every store at once. It must differ from every
-- store's PIN (a store PIN is checked first at sign-in, so a shared code
-- would never open manager mode there). Manager-mode sign-ins end.
create or replace function mog.manager_pin_set(p_by text, p_pin text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_loc  text;
  v_hash text;
  v_out  integer;
begin
  if not mog.pin_ok(p_pin) then
    raise exception 'REJECTED: the manager PIN is 4 to 8 digits';
  end if;
  select s.location into v_loc from mog.stores s
   where s.pin_hash is not null and extensions.crypt(p_pin, s.pin_hash) = s.pin_hash
   order by s.location limit 1;
  if v_loc is not null then
    raise exception 'REJECTED: that''s the store PIN at %: the manager PIN must differ from every store''s PIN', v_loc;
  end if;
  v_hash := extensions.crypt(p_pin, extensions.gen_salt('bf', 8));
  insert into mog.manager_pin (id, pin_hash, set_at, set_by) values (true, v_hash, now(), p_by)
  on conflict (id) do update set pin_hash = excluded.pin_hash, set_at = excluded.set_at, set_by = excluded.set_by;
  update mog.stores set master_pin_hash = v_hash where master_pin_hash is distinct from v_hash;
  delete from mog.sessions where auth_type = 'master';
  get diagnostics v_out = row_count;
  return jsonb_build_object('stores', (select count(*) from mog.stores), 'signedOut', v_out);
end;
$$;

-- ---------------------------------------------------------------------
-- HQ's entry point (hq role)
-- ---------------------------------------------------------------------

-- p_action: 'create' (p_row: mog.store_create's row), 'pin' ({ slug, pin })
-- or 'managerPin' ({ pin }). Answers { ok, data } or { ok: false, error },
-- the error 'REJECTED: ...' saying what to fix.
create or replace function public.mog_hq_stores(p_token text, p_action text, p_row jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := mog.hq_session(p_token);
  v_out  jsonb;
begin
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  begin
    if jsonb_typeof(p_row) is distinct from 'object' then
      raise exception 'REJECTED: nothing to save';
    end if;
    if p_action = 'create' then
      v_out := mog.store_create(v_name, p_row);
    elsif p_action = 'pin' then
      v_out := mog.store_set_pin(v_name, p_row ->> 'slug', p_row ->> 'pin');
    elsif p_action = 'managerPin' then
      v_out := mog.manager_pin_set(v_name, p_row ->> 'pin');
    else
      raise exception 'REJECTED: HQ can create a store, or set a PIN or the manager PIN';
    end if;
  exception when others then
    return mog.wh_error(sqlerrm);
  end;
  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

-- ---------------------------------------------------------------------
-- HQ's data (v14) with what HQ → Stores shows
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
    -- v26: the one manager PIN: null until it's first set in HQ.
    'managerPin', (select jsonb_build_object('setAt', m.set_at, 'setBy', m.set_by,
                     'everyStore', not exists (select 1 from mog.stores s where s.master_pin_hash is distinct from m.pin_hash))
                     from mog.manager_pin m),
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', s.slug, 'location', s.location, 'abbr', s.abbr, 'concept', coalesce(s.concept, ''),
               'isTest', s.is_test, 'editorDirect', s.editor_direct, 'side', s.side,
               'tables', case when s.editor_direct then mog.tables_json(s.slug) end)
             -- v26: what HQ → Stores shows
             || jsonb_build_object(
               'timeZone', coalesce(nullif(s.time_zone, ''), 'America/New_York'), 'address', s.address,
               'createdAt', s.created_at, 'createdBy', s.created_by, 'pinSetAt', s.pin_set_at, 'pinSetBy', s.pin_set_by,
               'hasPin', s.pin_hash is not null, 'phoneDirect', s.phone_direct, 'closeDirect', s.close_direct,
               'recipients', (select count(*) from mog.recipients r where r.slug = s.slug and r.active and r.email <> ''),
               'managerPin', m.pin_hash is not null and s.master_pin_hash is not distinct from m.pin_hash)
             order by coalesce(s.concept, ''), s.is_test, s.location, s.slug)
        from mog.stores s left join mog.manager_pin m on true), '[]'::jsonb),
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

-- ---------------------------------------------------------------------
-- A Sheet no longer sets the PINs of a store Supabase closes
-- ---------------------------------------------------------------------

-- Push the store PIN and the optional master PIN (plain text over TLS; hashed
-- here with bcrypt). Unchanged PINs keep their hash. A real change signs out
-- every phone for that store, which matches today: a changed PIN fails the
-- very next request.
create or replace function public.mog_sync_set_pins(p_slug text, p_key text, p_pin text, p_master_pin text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s        mog.stores%rowtype;
  v_pin    text;
  v_master text;
  v_changed boolean;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  -- v26: Supabase owns a store's PINs once it closes the store (R6):
  -- they're set in HQ, and a Sheet's push would overwrite them.
  if (select st.close_direct from mog.stores st where st.slug = p_slug) then
    return jsonb_build_object('ok', false, 'error', 'PINS_IN_HQ');
  end if;
  select * into s from mog.stores where slug = p_slug for update;

  v_pin := case
    when coalesce(p_pin, '') = '' then null
    when s.pin_hash is not null and extensions.crypt(p_pin, s.pin_hash) = s.pin_hash then s.pin_hash
    else extensions.crypt(p_pin, extensions.gen_salt('bf', 8))
  end;
  v_master := case
    when coalesce(p_master_pin, '') = '' then null
    when s.master_pin_hash is not null and extensions.crypt(p_master_pin, s.master_pin_hash) = s.master_pin_hash then s.master_pin_hash
    else extensions.crypt(p_master_pin, extensions.gen_salt('bf', 8))
  end;

  v_changed := (v_pin is distinct from s.pin_hash) or (v_master is distinct from s.master_pin_hash);
  if v_changed then
    update mog.stores set pin_hash = v_pin, master_pin_hash = v_master where slug = p_slug;
    delete from mog.sessions where slug = p_slug;
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('changed', v_changed));
end;
$$;

-- ---------------------------------------------------------------------
-- Privileges: lock the internals; open exactly the entry points below.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_hq_stores(text, text, jsonb)',
    'public.mog_hq_data(text)',
    'public.mog_sync_set_pins(text, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
