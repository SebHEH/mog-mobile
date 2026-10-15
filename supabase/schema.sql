-- =====================================================================
-- MOG on Supabase — schema v1
-- =====================================================================
-- Run in the Supabase SQL Editor (it runs as `postgres`). Re-running is
-- safe: tables use IF NOT EXISTS and functions use CREATE OR REPLACE.
-- CHANGING A FUNCTION'S PARAMETERS later creates a second overload rather
-- than replacing it — drop the old signature in the same migration.
--
-- Design record: docs/MOG_SupabaseMigration.md. In short:
--   * Tables live in the private schema `mog`, which the Data API does not
--     expose. The publishable key cannot read or write any table.
--   * The ONLY way in is the functions in `public`, and each one checks a
--     credential before touching data:
--       - mog_login / mog_snapshot / mog_save_counts / mog_set_override /
--         mog_set_vendor_pick: the PWA. A correct store or master PIN buys
--         a 12-hour session token; the rest take that token.
--       - mog_sync_*: each store's Apps Script, using that store's own sync
--         key. A leaked key reaches only that one store.
--       - mog.provision_store: SQL Editor only; not exposed at all.
--   * The database OWNS counts and the Emergency Override settings. It
--     MIRRORS the catalog, which the Sheet still owns and Apps Script pushes.
--   * No order math lives here. The phone and Apps Script share
--     apps-script/OrderMath.gs for that, so there is one copy of the math.
--   * Every function returns the same envelope as the /exec API:
--     { "ok": true, "data": ... } or { "ok": false, "error": "..." }.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- The 2026-10-15 speed-test table. Anyone with the publishable key could
-- write to it, so it goes before anything real lands.
drop table if exists public.speedtest;

create schema if not exists mog;
comment on schema mog is 'MOG ordering data, schema v1. Private: reach it only through the public.mog_* functions.';


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists mog.stores (
  slug            text primary key check (slug ~ '^[a-z0-9]{2,20}$'),
  sync_key_hash   text not null,          -- sha256 hex of the store's sync key
  pin_hash        text,                   -- bcrypt; null until Apps Script pushes it
  master_pin_hash text,                   -- bcrypt; optional multi-unit manager PIN
  fail_count      integer not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

-- One catalog block per store, pushed by Apps Script on every editor save.
-- Format: docs/MOG_SupabaseMigration.md section 6.
create table if not exists mog.catalog (
  slug       text primary key references mog.stores (slug) on delete cascade,
  version    bigint not null,             -- push time in ms; an older push never overwrites a newer one
  payload    jsonb  not null,
  pushed_at  timestamptz not null default now()
);

create table if not exists mog.store_state (
  slug               text primary key references mog.stores (slug) on delete cascade,
  cycle_date         date not null,       -- the cycle being worked (was ORDER_ENTRY!AE9)
  day_of_week        text not null check (day_of_week in ('Mon','Tue','Wed','Thu','Fri','Sat','Sun')),
  emergency_override boolean not null default false,          -- was ORDER_ENTRY!AD2
  vendor_picks       jsonb   not null default '{}'::jsonb,    -- { "<vendor>": 1..7 }, was SETUP!AF; only used while the override is on
  todays_log         jsonb   not null default '[]'::jsonb,    -- LOG_ORDERS summary for cycle_date (dashboard "sent" status)
  updated_at         timestamptz not null default now()
);

create table if not exists mog.counts (
  slug        text not null references mog.stores (slug) on delete cascade,
  cycle_date  date not null,
  vendor      text not null,
  item_id     text not null,
  on_hand     numeric,                    -- null = the KM cleared it
  updated_at  timestamptz not null default now(),
  primary key (slug, cycle_date, vendor, item_id)
);

create table if not exists mog.sessions (
  token_hash  text primary key,           -- sha256 hex; the raw token only ever lives on the phone
  slug        text not null references mog.stores (slug) on delete cascade,
  auth_type   text not null check (auth_type in ('store', 'master')),
  expires_at  timestamptz not null
);
create index if not exists sessions_expires_idx on mog.sessions (expires_at);

-- Defense in depth: RLS on with no policies. The functions below run as the
-- table owner, which bypasses RLS; every other role sees nothing.
alter table mog.stores      enable row level security;
alter table mog.catalog     enable row level security;
alter table mog.store_state enable row level security;
alter table mog.counts      enable row level security;
alter table mog.sessions    enable row level security;


-- ---------------------------------------------------------------------
-- Internal helpers (schema mog — not callable through the API)
-- ---------------------------------------------------------------------

create or replace function mog.sha256_hex(p text)
returns text
language sql immutable
set search_path = ''
as $$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex');
$$;

-- Same check as the PWA's sign-in today, minus timing: the key is 256 bits
-- of randomness, so comparing hashes leaks nothing useful.
create or replace function mog.sync_ok(p_slug text, p_key text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from mog.stores s
     where s.slug = p_slug
       and s.sync_key_hash = mog.sha256_hex(p_key)
  );
$$;

-- jsonb -> on-hand number. Numbers pass; numeric strings are parsed; blank,
-- null, or junk become null (a cleared count), never an error that would
-- fail the whole save.
create or replace function mog.to_onhand(p jsonb)
returns numeric
language plpgsql immutable
set search_path = ''
as $$
declare
  v text;
begin
  if p is null then
    return null;
  end if;
  case jsonb_typeof(p)
    when 'number' then
      return p::numeric;
    when 'string' then
      v := trim(p #>> '{}');
      if v ~ '^-?([0-9]+(\.[0-9]*)?|\.[0-9]+)$' then
        return v::numeric;
      end if;
      return null;
    else
      return null;
  end case;
end;
$$;

-- Upsert count rows for one cycle. p_default_vendor (KM saves) wins over a
-- per-row "vendor" (Apps Script imports). Duplicate ids inside one payload
-- collapse to the LAST one, so a single save can never hit the
-- "ON CONFLICT cannot affect row a second time" error.
create or replace function mog.upsert_counts(p_slug text, p_cycle_date date, p_default_vendor text, p_rows jsonb)
returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  insert into mog.counts as k (slug, cycle_date, vendor, item_id, on_hand, updated_at)
  select p_slug, p_cycle_date, d.vendor, d.item_id, d.on_hand, now()
    from (
      select distinct on (x.vendor, x.item_id) x.vendor, x.item_id, x.on_hand
        from (
          select trim(coalesce(p_default_vendor, t.e ->> 'vendor', '')) as vendor,
                 trim(coalesce(t.e ->> 'id', ''))                       as item_id,
                 mog.to_onhand(t.e -> 'onHand')                         as on_hand,
                 t.ord
            from jsonb_array_elements(p_rows) with ordinality as t(e, ord)
        ) x
       where x.vendor <> '' and x.item_id <> ''
         and length(x.vendor) <= 100 and length(x.item_id) <= 100   -- real names are short; caps abuse
       order by x.vendor, x.item_id, x.ord desc
    ) d
  on conflict (slug, cycle_date, vendor, item_id)
  do update set on_hand = excluded.on_hand, updated_at = excluded.updated_at;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Everything the phone needs for every screen, in one response. The catalog
-- is left out (null) when the phone already holds this exact version.
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

-- Run once per store from the SQL Editor:  select mog.provision_store('rprfo');
-- Returns the store's sync key. Enter it in that store's setupSupabase()
-- prompt; never paste it into chat. Running it again ROTATES the key (the
-- old one stops working immediately).
create or replace function mog.provision_store(p_slug text)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_slug text := lower(trim(coalesce(p_slug, '')));
  v_key  text;
begin
  if v_slug !~ '^[a-z0-9]{2,20}$' then
    raise exception 'Bad store slug: %', p_slug;
  end if;
  v_key := encode(extensions.gen_random_bytes(32), 'hex');
  insert into mog.stores (slug, sync_key_hash)
  values (v_slug, mog.sha256_hex(v_key))
  on conflict (slug) do update set sync_key_hash = excluded.sync_key_hash;
  return v_key;
end;
$$;


-- ---------------------------------------------------------------------
-- PWA entry points (publishable key + PIN / session token)
-- ---------------------------------------------------------------------

-- Sign in. Mirrors doPost's PIN handling (MOGApi.gs): lockout checked FIRST,
-- 5 failures -> 5-minute lockout per store, an expired lockout gives a fresh
-- 5 tries, success clears the counter. Returns the token plus the full
-- snapshot, so signing in is one round trip, not two.
create or replace function public.mog_login(p_slug text, p_pin text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s       mog.stores%rowtype;
  v_type  text;
  v_count integer;
  v_token text;
  v_snap  jsonb;
begin
  select * into s from mog.stores
   where slug = lower(trim(coalesce(p_slug, '')))
     for update;                          -- serializes concurrent sign-ins per store
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Unknown store');
  end if;

  if s.locked_until is not null then
    if s.locked_until > now() then
      return jsonb_build_object('ok', false, 'error', 'Too many attempts', 'lockout', true,
        'retryAfterMs', ceil(extract(epoch from (s.locked_until - now())) * 1000)::bigint);
    end if;
    update mog.stores set fail_count = 0, locked_until = null where slug = s.slug;
    s.fail_count := 0;
    s.locked_until := null;
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

  v_snap := mog.snapshot_json(s.slug, v_type, null);
  if not (v_snap ->> 'ok')::boolean then
    return v_snap;                        -- e.g. STORE_NOT_SYNCED: no session handed out
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into mog.sessions (token_hash, slug, auth_type, expires_at)
  values (mog.sha256_hex(v_token), s.slug, v_type, now() + interval '12 hours');
  delete from mog.sessions where expires_at < now() - interval '1 day';   -- housekeeping

  return jsonb_build_object('ok', true, 'data',
    (v_snap -> 'data') || jsonb_build_object(
      'token',     v_token,
      'expiresAt', now() + interval '12 hours'));
end;
$$;

create or replace function public.mog_snapshot(p_token text, p_have_version bigint default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_sess mog.sessions%rowtype;
begin
  select * into v_sess from mog.sessions
   where token_hash = mog.sha256_hex(p_token) and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  return mog.snapshot_json(v_sess.slug, v_sess.auth_type, p_have_version);
end;
$$;

-- Save counts for one vendor. Items: [{ "id": "ITEM-0042", "onHand": 3 }, ...]
-- (onHand null/"" clears). Rows are written under the cycle date the PHONE
-- sends: a phone that saves after the reset lands in the old cycle and gets
-- stale:true back, so the new cycle can never be polluted.
create or replace function public.mog_save_counts(p_token text, p_cycle_date date, p_vendor text, p_items jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_sess   mog.sessions%rowtype;
  v_vendor text := trim(coalesce(p_vendor, ''));
  v_cycle  date;
  v_n      integer;
begin
  select * into v_sess from mog.sessions
   where token_hash = mog.sha256_hex(p_token) and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
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

  select cycle_date into v_cycle from mog.store_state where slug = v_sess.slug;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'saved',     v_n,
    'vendor',    v_vendor,
    'cycleDate', to_char(v_cycle, 'YYYY-MM-DD'),
    'stale',     v_cycle is distinct from p_cycle_date));
end;
$$;

-- Store-wide Emergency Override. Turning it off clears the per-vendor day
-- picks with it (they are children of the flag, as in api_setEmergencyOverride_).
-- Returns the fresh snapshot so the phone re-renders without a second call.
create or replace function public.mog_set_override(p_token text, p_on boolean, p_have_version bigint default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_sess mog.sessions%rowtype;
  v_on   boolean := coalesce(p_on, false);
begin
  select * into v_sess from mog.sessions
   where token_hash = mog.sha256_hex(p_token) and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  update mog.store_state
     set emergency_override = v_on,
         vendor_picks       = case when v_on then vendor_picks else '{}'::jsonb end,
         updated_at         = now()
   where slug = v_sess.slug;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;
  return mog.snapshot_json(v_sess.slug, v_sess.auth_type, p_have_version);
end;
$$;

-- One vendor's override day pick: mult 1-7 (days from tomorrow up to its next
-- delivery, frozen at pick time); 0 clears it. Same contract as
-- api_setVendorOverride_. Returns the fresh snapshot.
create or replace function public.mog_set_vendor_pick(p_token text, p_vendor text, p_mult integer, p_have_version bigint default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_sess   mog.sessions%rowtype;
  v_vendor text := trim(coalesce(p_vendor, ''));
begin
  select * into v_sess from mog.sessions
   where token_hash = mog.sha256_hex(p_token) and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  if v_vendor = '' or length(v_vendor) > 100 then
    return jsonb_build_object('ok', false, 'error', 'Vendor is required.');
  end if;
  if p_mult is null or p_mult < 0 or p_mult > 7 then
    return jsonb_build_object('ok', false, 'error',
      'Invalid override multiplier (expected 0-7): ' || coalesce(p_mult::text, 'null'));
  end if;
  update mog.store_state
     set vendor_picks = case when p_mult = 0 then vendor_picks - v_vendor
                             else vendor_picks || jsonb_build_object(v_vendor, p_mult) end,
         updated_at   = now()
   where slug = v_sess.slug;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;
  return mog.snapshot_json(v_sess.slug, v_sess.auth_type, p_have_version);
end;
$$;


-- ---------------------------------------------------------------------
-- Apps Script entry points (publishable key + the store's sync key)
-- ---------------------------------------------------------------------

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

-- The current cycle's state and counts, for the copy-back into the Sheet
-- that runs at the top of commitLogAndReset (and for a rollback).
create or replace function public.mog_sync_get_cycle(p_slug text, p_key text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  st mog.store_state%rowtype;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  select * into st from mog.store_state where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'state', jsonb_build_object(
      'cycleDate',         to_char(st.cycle_date, 'YYYY-MM-DD'),
      'dayOfWeek',         st.day_of_week,
      'emergencyOverride', st.emergency_override,
      'vendorPicks',       st.vendor_picks),
    'counts', coalesce((
      select jsonb_agg(jsonb_build_object('vendor', k.vendor, 'id', k.item_id, 'onHand', k.on_hand)
                       order by k.vendor, k.item_id)
        from mog.counts k
       where k.slug = p_slug and k.cycle_date = st.cycle_date
    ), '[]'::jsonb)));
end;
$$;

-- Write count rows from Apps Script: the one-time import at cutover, and the
-- mirror of /exec saveOnHand calls from phones still on the old PWA.
-- Rows: [{ "vendor": "Amazon", "id": "ITEM-0059", "onHand": 2 }, ...]
create or replace function public.mog_sync_put_counts(p_slug text, p_key text, p_cycle_date date, p_rows jsonb)
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
  if p_cycle_date is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'cycle date and a rows array are required');
  end if;
  v_n := mog.upsert_counts(p_slug, p_cycle_date, null, p_rows);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('saved', v_n));
end;
$$;

-- Set the store state. After a reset: the new cycle date, override off, no
-- picks, the fresh log summary, and p_clear_cycle_counts = true (a same-day
-- re-reset must start the cycle with no counts, exactly as the Sheet clears
-- column E). At cutover: the Sheet's current values, without clearing.
-- Old cycles' counts are kept 45 days as evidence, then purged.
create or replace function public.mog_sync_set_state(
  p_slug text, p_key text,
  p_cycle_date date, p_day_of_week text,
  p_emergency_override boolean, p_vendor_picks jsonb, p_todays_log jsonb,
  p_clear_cycle_counts boolean)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  if p_cycle_date is null
     or coalesce(p_day_of_week, '') not in ('Mon','Tue','Wed','Thu','Fri','Sat','Sun') then
    return jsonb_build_object('ok', false, 'error', 'cycle date and a Mon..Sun day are required');
  end if;

  insert into mog.store_state as st
    (slug, cycle_date, day_of_week, emergency_override, vendor_picks, todays_log, updated_at)
  values
    (p_slug, p_cycle_date, p_day_of_week, coalesce(p_emergency_override, false),
     coalesce(p_vendor_picks, '{}'::jsonb), coalesce(p_todays_log, '[]'::jsonb), now())
  on conflict (slug) do update
     set cycle_date         = excluded.cycle_date,
         day_of_week        = excluded.day_of_week,
         emergency_override = excluded.emergency_override,
         vendor_picks       = excluded.vendor_picks,
         todays_log         = excluded.todays_log,
         updated_at         = excluded.updated_at;

  if coalesce(p_clear_cycle_counts, false) then
    delete from mog.counts where slug = p_slug and cycle_date = p_cycle_date;
  end if;
  delete from mog.counts where slug = p_slug and cycle_date < p_cycle_date - 45;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'cycleDate', to_char(p_cycle_date, 'YYYY-MM-DD')));
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: close everything, then open exactly the entry points.
-- ---------------------------------------------------------------------

revoke all on schema mog from public, anon, authenticated;
revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_login(text, text)',
    'public.mog_snapshot(text, bigint)',
    'public.mog_save_counts(text, date, text, jsonb)',
    'public.mog_set_override(text, boolean, bigint)',
    'public.mog_set_vendor_pick(text, text, integer, bigint)',
    'public.mog_sync_push_catalog(text, text, bigint, jsonb)',
    'public.mog_sync_set_pins(text, text, text, text)',
    'public.mog_sync_get_cycle(text, text)',
    'public.mog_sync_put_counts(text, text, date, jsonb)',
    'public.mog_sync_set_state(text, text, date, text, boolean, jsonb, jsonb, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

-- Make the new functions callable right away instead of after the API's
-- next schema-cache refresh (the cause of the PGRST205 error on 10-15).
notify pgrst, 'reload schema';
