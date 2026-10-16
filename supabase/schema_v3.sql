-- =====================================================================
-- MOG on Supabase — schema v3   (run AFTER schema.sql and schema_v2.sql)
-- =====================================================================
-- Step 5: phones talk to Supabase directly (design record D12-D14). This
-- adds the per-store switch that decides it:
--   * mog.stores.phone_direct (default OFF). While it's off, every PWA
--     function answers USE_EXEC and the phone uses /exec, as it does today.
--     mog_login checks it BEFORE the PIN, so a store whose phones aren't
--     direct never touches its Supabase lockout counter.
--   * mog_sync_set_phone_direct: Apps Script turns it off (Switch back to the
--     Sheet does that first, so phones can never count into Supabase while
--     the Sheet counts) or on.
-- Turning a store on by hand (the canary):
--     update mog.stores set phone_direct = true where slug = 'rprfo';
--
-- It REPLACES the five PWA functions, keeping their signatures and adding
-- only the switch check: mog_login, mog_snapshot, mog_save_counts,
-- mog_set_override, mog_set_vendor_pick.
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================


alter table mog.stores add column if not exists phone_direct boolean not null default false;


-- ---------------------------------------------------------------------
-- Internal
-- ---------------------------------------------------------------------

create or replace function mog.phone_direct_on(p_slug text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select s.phone_direct from mog.stores s where s.slug = p_slug), false);
$$;


-- ---------------------------------------------------------------------
-- The five PWA functions, with the switch check (same signatures)
-- ---------------------------------------------------------------------

-- v1's sign-in (lockout first, 5 failures -> 5 minutes, success clears the
-- counter, token + snapshot in one round trip), with the switch checked
-- before anything else touches the store.
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
  if not s.phone_direct then
    return jsonb_build_object('ok', false, 'error', 'USE_EXEC');
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
  if not mog.phone_direct_on(v_sess.slug) then
    return jsonb_build_object('ok', false, 'error', 'USE_EXEC');
  end if;
  return mog.snapshot_json(v_sess.slug, v_sess.auth_type, p_have_version);
end;
$$;

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

  select cycle_date into v_cycle from mog.store_state where slug = v_sess.slug;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'saved',     v_n,
    'vendor',    v_vendor,
    'cycleDate', to_char(v_cycle, 'YYYY-MM-DD'),
    'stale',     v_cycle is distinct from p_cycle_date));
end;
$$;

create or replace function public.mog_set_override(p_token text, p_on boolean, p_have_version bigint default null)
returns jsonb
language plpgsql volatile security definer
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
  if not mog.phone_direct_on(v_sess.slug) then
    return jsonb_build_object('ok', false, 'error', 'USE_EXEC');
  end if;
  if not mog.apply_override(v_sess.slug, p_on) then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;
  return mog.snapshot_json(v_sess.slug, v_sess.auth_type, p_have_version);
end;
$$;

create or replace function public.mog_set_vendor_pick(p_token text, p_vendor text, p_mult integer, p_have_version bigint default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_sess mog.sessions%rowtype;
  v_err  text;
begin
  select * into v_sess from mog.sessions
   where token_hash = mog.sha256_hex(p_token) and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  if not mog.phone_direct_on(v_sess.slug) then
    return jsonb_build_object('ok', false, 'error', 'USE_EXEC');
  end if;
  v_err := mog.apply_vendor_pick(v_sess.slug, p_vendor, p_mult);
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;
  return mog.snapshot_json(v_sess.slug, v_sess.auth_type, p_have_version);
end;
$$;


-- ---------------------------------------------------------------------
-- Apps Script entry point
-- ---------------------------------------------------------------------

create or replace function public.mog_sync_set_phone_direct(p_slug text, p_key text, p_on boolean)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  update mog.stores set phone_direct = coalesce(p_on, false) where slug = p_slug;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('phoneDirect', coalesce(p_on, false)));
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: lock the new internal, open exactly the new entry point.
-- ---------------------------------------------------------------------

revoke all on all functions in schema mog from public, anon, authenticated;
revoke all on function public.mog_sync_set_phone_direct(text, text, boolean) from public, anon, authenticated;
grant execute on function public.mog_sync_set_phone_direct(text, text, boolean) to anon, authenticated;

notify pgrst, 'reload schema';
