-- =====================================================================
-- MOG on Supabase — schema v5   (run AFTER schema.sql through schema_v4.sql)
-- =====================================================================
-- Live counting (docs/MOG_OneApp_Spec.md, Phase 1, P1-P4): several people
-- counting at once see each other within ~15 seconds.
--   * mog.presence: one row per device, with the name it counts under and
--     the vendor it has open. A device unseen for 90 seconds counts as gone.
--   * mog.store_people: the store's list of names, built from what people
--     pick or type. A name unused for 30 days drops out of the picker; nothing
--     is deleted.
--   * mog.counts.counted_by: who saved each count, so a vendor card can say
--     who started it after that person has left.
--   * mog_snapshot2: the phone's 15-second read. It also records this
--     device's name and open vendor, so the refresh IS the heartbeat (no extra
--     requests), and returns presence, the name list and per-vendor activity.
--   * mog_save_counts2: mog_save_counts plus who saved.
-- The v1/v3 calls (mog_snapshot, mog_save_counts) are untouched, so a phone
-- still on an older app keeps working while the new one rolls out.
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists mog.presence (
  slug       text not null references mog.stores (slug) on delete cascade,
  device_id  text not null check (device_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  name       text check (length(name) <= 40),   -- null = skipped the name step ("Someone")
  vendor     text check (length(vendor) <= 100), -- null = not on a vendor's screen
  seen_at    timestamptz not null default now(),
  primary key (slug, device_id)
);

create table if not exists mog.store_people (
  slug        text not null references mog.stores (slug) on delete cascade,
  name        text not null check (name = btrim(name) and name <> '' and length(name) <= 40),
  created_at  timestamptz not null default now(),
  last_used   timestamptz not null default now()
);
create unique index if not exists store_people_name_ci on mog.store_people (slug, lower(name));

alter table mog.counts add column if not exists counted_by text;

alter table mog.presence     enable row level security;
alter table mog.store_people enable row level security;


-- ---------------------------------------------------------------------
-- Internal
-- ---------------------------------------------------------------------

-- Record that a device is here, under a name, on a vendor (or none). A bad
-- device id is ignored rather than failing the read it rides on: presence is
-- best-effort, the snapshot is not. A name joins the store's list (first
-- spelling wins, matched ignoring case).
create or replace function mog.touch_presence(p_slug text, p_device text, p_name text, p_vendor text)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name   text := nullif(left(btrim(coalesce(p_name, '')), 40), '');
  v_vendor text := nullif(left(btrim(coalesce(p_vendor, '')), 100), '');
begin
  if coalesce(p_device, '') !~ '^[A-Za-z0-9_-]{8,64}$' then
    return;
  end if;
  insert into mog.presence as p (slug, device_id, name, vendor, seen_at)
  values (p_slug, p_device, v_name, v_vendor, now())
  on conflict (slug, device_id) do update
     set name = excluded.name, vendor = excluded.vendor, seen_at = excluded.seen_at;
  if v_name is not null then
    insert into mog.store_people as sp (slug, name, last_used)
    values (p_slug, v_name, now())
    on conflict (slug, (lower(name))) do update set last_used = excluded.last_used;
  end if;
  delete from mog.presence where slug = p_slug and seen_at < now() - interval '1 day';   -- housekeeping
end;
$$;

-- What the phone needs to show other people, for one store:
--   presence: devices other than p_device seen in the last 90 seconds,
--             newest first: { name, vendor, secondsAgo }
--   people:   names used in the last 30 days, A-Z (the picker)
--   activity: per vendor, who saved this cycle's latest count and when:
--             { vendor, by, secondsAgo }
create or replace function mog.live_json(p_slug text, p_device text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'presence', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', p.name, 'vendor', p.vendor,
               'secondsAgo', floor(extract(epoch from (now() - p.seen_at)))::int)
             order by p.seen_at desc)
        from mog.presence p
       where p.slug = p_slug and p.device_id <> coalesce(p_device, '')
         and p.seen_at > now() - interval '90 seconds'), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(sp.name order by lower(sp.name), sp.name)
        from mog.store_people sp
       where sp.slug = p_slug and sp.last_used > now() - interval '30 days'), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object(
               'vendor', a.vendor, 'by', a.counted_by,
               'secondsAgo', floor(extract(epoch from (now() - a.updated_at)))::int)
             order by a.vendor)
        from (select distinct on (k.vendor) k.vendor, k.counted_by, k.updated_at
                from mog.counts k
                join mog.store_state st on st.slug = k.slug and st.cycle_date = k.cycle_date
               where k.slug = p_slug and k.counted_by is not null
               order by k.vendor, k.updated_at desc) a), '[]'::jsonb));
$$;


-- ---------------------------------------------------------------------
-- PWA entry points (same session + phone_direct rules as schema v3)
-- ---------------------------------------------------------------------

-- The 15-second read: mog_snapshot's answer plus presence, people and
-- activity, recording this device on the way (when p_device is given).
create or replace function public.mog_snapshot2(
  p_token text, p_have_version bigint default null,
  p_device text default null, p_name text default null, p_vendor text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_sess mog.sessions%rowtype;
  v_snap jsonb;
begin
  select * into v_sess from mog.sessions
   where token_hash = mog.sha256_hex(p_token) and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  if not mog.phone_direct_on(v_sess.slug) then
    return jsonb_build_object('ok', false, 'error', 'USE_EXEC');
  end if;
  v_snap := mog.snapshot_json(v_sess.slug, v_sess.auth_type, p_have_version);
  if not (v_snap ->> 'ok')::boolean then
    return v_snap;
  end if;
  if p_device is not null then
    perform mog.touch_presence(v_sess.slug, p_device, p_name, p_vendor);
  end if;
  return jsonb_build_object('ok', true, 'data',
    (v_snap -> 'data') || mog.live_json(v_sess.slug, p_device));
end;
$$;

-- mog_save_counts (schema v3) plus who saved: each saved item's count
-- remembers p_by (null when the person skipped the name step).
create or replace function public.mog_save_counts2(
  p_token text, p_cycle_date date, p_vendor text, p_items jsonb, p_by text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_sess   mog.sessions%rowtype;
  v_vendor text := trim(coalesce(p_vendor, ''));
  v_by     text := nullif(left(btrim(coalesce(p_by, '')), 40), '');
  v_cycle  date;
  v_n      integer;
begin
  select * into v_sess from mog.sessions
   where token_hash = mog.sha256_hex(p_token) and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  if not mog.phone_direct_on(v_sess.slug) then
    return jsonb_build_object('ok', false, 'error', 'USE_EXEC');
  end if;
  if v_vendor = '' or length(v_vendor) > 100 then
    return jsonb_build_object('ok', false, 'error', 'Vendor is required.');
  end if;
  if p_cycle_date is null then
    return jsonb_build_object('ok', false, 'error', 'Cycle date is required.');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'items must be an array');
  end if;
  if jsonb_array_length(p_items) > 1000 then
    return jsonb_build_object('ok', false, 'error', 'Too many items in one save');
  end if;

  v_n := mog.upsert_counts(v_sess.slug, p_cycle_date, v_vendor, p_items);
  update mog.counts k
     set counted_by = v_by
   where k.slug = v_sess.slug and k.cycle_date = p_cycle_date and k.vendor = v_vendor
     and k.item_id in (select trim(coalesce(e ->> 'id', '')) from jsonb_array_elements(p_items) e);

  select cycle_date into v_cycle from mog.store_state where slug = v_sess.slug;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'saved',     v_n,
    'vendor',    v_vendor,
    'cycleDate', to_char(v_cycle, 'YYYY-MM-DD'),
    'stale',     v_cycle is distinct from p_cycle_date));
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
    'public.mog_snapshot2(text, bigint, text, text, text)',
    'public.mog_save_counts2(text, date, text, jsonb, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
