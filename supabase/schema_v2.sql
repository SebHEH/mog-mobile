-- =====================================================================
-- MOG on Supabase — schema v2   (run AFTER schema.sql)
-- =====================================================================
-- Closing a cycle moves entirely into Supabase (design record D9: the Sheet
-- is retired from the app's path). This adds:
--   * mog.order_log: the order log, which used to live only in the Sheet's
--     LOG_ORDERS.
--   * mog_sync_close_cycle: writes a closed cycle's log rows AND starts the
--     next cycle in ONE transaction; a second close of the same cycle is
--     refused, so nothing is ever logged twice.
--   * mog_sync_get_snapshot / mog_sync_get_log: what Apps Script reads to
--     close a cycle, send the recap, and serve /exec for a switched store.
--   * mog_sync_set_override / mog_sync_set_vendor_pick: sync-key twins of the
--     PWA's override calls, for /exec on a switched store.
--
-- It also REPLACES three v1 functions, keeping their signatures:
--   * mog_set_override and mog_set_vendor_pick now share one internal
--     implementation with their sync-key twins, so the override rules can't
--     drift between the two.
--   * mog_sync_put_counts accepts a null cycle date, meaning "the current
--     cycle".
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================


-- ---------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------

create table if not exists mog.order_log (
  id            bigint generated always as identity primary key,
  slug          text not null references mog.stores (slug) on delete cascade,
  cycle_date    date not null,
  seq           integer not null,       -- order within the close: vendor A-Z, then the count list's order
  vendor        text not null,
  item_id       text not null,
  item_name     text not null default '',
  pack          text not null default '',  -- pack at ORDER time (the Sheet log never stored it)
  area          text not null default '',
  on_hand_prev  numeric,
  qty_ordered   numeric not null,
  logged_at     timestamptz not null default now()
);
create index if not exists order_log_slug_date_idx on mog.order_log (slug, cycle_date, seq);
alter table mog.order_log enable row level security;


-- ---------------------------------------------------------------------
-- Internal: the override rules, one copy for the PWA and Apps Script
-- ---------------------------------------------------------------------

-- Store-wide Emergency Override. Turning it off clears the per-vendor day
-- picks (they're children of the flag). Returns false when the store has no
-- state row yet.
create or replace function mog.apply_override(p_slug text, p_on boolean)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_on boolean := coalesce(p_on, false);
begin
  update mog.store_state
     set emergency_override = v_on,
         vendor_picks       = case when v_on then vendor_picks else '{}'::jsonb end,
         updated_at         = now()
   where slug = p_slug;
  return found;
end;
$$;

-- One vendor's day pick: 1-7 sets it, 0 clears it. Returns an error message,
-- or null on success.
create or replace function mog.apply_vendor_pick(p_slug text, p_vendor text, p_mult integer)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_vendor text := trim(coalesce(p_vendor, ''));
begin
  if v_vendor = '' or length(v_vendor) > 100 then
    return 'Vendor is required.';
  end if;
  if p_mult is null or p_mult < 0 or p_mult > 7 then
    return 'Invalid override multiplier (expected 0-7): ' || coalesce(p_mult::text, 'null');
  end if;
  update mog.store_state
     set vendor_picks = case when p_mult = 0 then vendor_picks - v_vendor
                             else vendor_picks || jsonb_build_object(v_vendor, p_mult) end,
         updated_at   = now()
   where slug = p_slug;
  if not found then
    return 'STORE_NOT_SYNCED';
  end if;
  return null;
end;
$$;


-- ---------------------------------------------------------------------
-- v1 PWA functions, re-pointed at the shared rules (same signatures)
-- ---------------------------------------------------------------------

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
  v_err := mog.apply_vendor_pick(v_sess.slug, p_vendor, p_mult);
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;
  return mog.snapshot_json(v_sess.slug, v_sess.auth_type, p_have_version);
end;
$$;


-- ---------------------------------------------------------------------
-- Apps Script entry points (publishable key + the store's sync key)
-- ---------------------------------------------------------------------

-- Everything a cycle close or a switched store's /exec needs, in one read.
create or replace function public.mog_sync_get_snapshot(p_slug text, p_key text, p_have_version bigint default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  return mog.snapshot_json(p_slug, 'sync', p_have_version);
end;
$$;

create or replace function public.mog_sync_set_override(p_slug text, p_key text, p_on boolean, p_have_version bigint default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  if not mog.apply_override(p_slug, p_on) then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;
  return mog.snapshot_json(p_slug, 'sync', p_have_version);
end;
$$;

create or replace function public.mog_sync_set_vendor_pick(p_slug text, p_key text, p_vendor text, p_mult integer, p_have_version bigint default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_err text;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  v_err := mog.apply_vendor_pick(p_slug, p_vendor, p_mult);
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err);
  end if;
  return mog.snapshot_json(p_slug, 'sync', p_have_version);
end;
$$;

-- v1 replacement (same signature): a null cycle date now means the current
-- cycle, which is what /exec saves on a switched store want. Rows:
-- [{ "vendor": "Amazon", "id": "ITEM-0059", "onHand": 2 }, ...]
create or replace function public.mog_sync_put_counts(p_slug text, p_key text, p_cycle_date date, p_rows jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_cycle date := p_cycle_date;
  v_n     integer;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'a rows array is required');
  end if;
  if jsonb_array_length(p_rows) > 2000 then
    return jsonb_build_object('ok', false, 'error', 'Too many rows in one call');
  end if;
  if v_cycle is null then
    select cycle_date into v_cycle from mog.store_state where slug = p_slug;
    if v_cycle is null then
      return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
    end if;
  end if;
  v_n := mog.upsert_counts(p_slug, v_cycle, null, p_rows);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'saved', v_n, 'cycleDate', to_char(v_cycle, 'YYYY-MM-DD')));
end;
$$;

-- Close a cycle: write its order-log rows and start the next cycle, in ONE
-- transaction.
--   p_closing   the cycle being closed; must equal the stored cycle date,
--               otherwise nothing happens (closed:false, CYCLE_MOVED). That
--               is what makes a repeated or concurrent close harmless.
--   p_new_cycle the cycle that starts (>= p_closing). Equal to p_closing for
--               a same-day re-close, which replaces that day's log rows and
--               clears its counts, exactly as the Sheet's same-day reset did.
--   p_rows      [{ vendor, id, name, pack, area, onHandPrev, qty }] in order;
--               rows without a vendor/id or with qty <= 0 are skipped.
--   p_todays_log  the dashboard's "sent" summary for the NEW cycle (empty
--               unless this is a same-day re-close).
-- The new cycle starts with Emergency Override off and no day picks.
create or replace function public.mog_sync_close_cycle(
  p_slug text, p_key text,
  p_closing date, p_new_cycle date, p_new_dow text,
  p_rows jsonb, p_todays_log jsonb, p_logged_at timestamptz default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  st   mog.store_state%rowtype;
  v_n  integer;
  v_at timestamptz := coalesce(p_logged_at, now());
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  if p_closing is null or p_new_cycle is null or p_new_cycle < p_closing
     or coalesce(p_new_dow, '') not in ('Mon','Tue','Wed','Thu','Fri','Sat','Sun') then
    return jsonb_build_object('ok', false, 'error',
      'a closing date, a new cycle date on or after it, and a Mon..Sun day are required');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'a rows array is required');
  end if;

  select * into st from mog.store_state where slug = p_slug for update;   -- serializes concurrent closes
  if not found then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;
  if st.cycle_date <> p_closing then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object(
      'closed', false, 'reason', 'CYCLE_MOVED', 'cycleDate', to_char(st.cycle_date, 'YYYY-MM-DD')));
  end if;

  delete from mog.order_log where slug = p_slug and cycle_date = p_closing;
  insert into mog.order_log
    (slug, cycle_date, seq, vendor, item_id, item_name, pack, area, on_hand_prev, qty_ordered, logged_at)
  select p_slug, p_closing, t.ord::integer,
         trim(coalesce(t.e ->> 'vendor', '')), trim(coalesce(t.e ->> 'id', '')),
         coalesce(t.e ->> 'name', ''), coalesce(t.e ->> 'pack', ''), coalesce(t.e ->> 'area', ''),
         mog.to_onhand(t.e -> 'onHandPrev'), mog.to_onhand(t.e -> 'qty'), v_at
    from jsonb_array_elements(p_rows) with ordinality as t(e, ord)
   where trim(coalesce(t.e ->> 'vendor', '')) <> ''
     and trim(coalesce(t.e ->> 'id', '')) <> ''
     and coalesce(mog.to_onhand(t.e -> 'qty'), 0) > 0;
  get diagnostics v_n = row_count;

  update mog.store_state
     set cycle_date         = p_new_cycle,
         day_of_week        = p_new_dow,
         emergency_override = false,
         vendor_picks       = '{}'::jsonb,
         todays_log         = coalesce(p_todays_log, '[]'::jsonb),
         updated_at         = now()
   where slug = p_slug;

  if p_new_cycle = p_closing then
    delete from mog.counts where slug = p_slug and cycle_date = p_new_cycle;
  end if;
  delete from mog.counts where slug = p_slug and cycle_date < p_new_cycle - 45;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'closed', true, 'logged', v_n,
    'closedCycle', to_char(p_closing, 'YYYY-MM-DD'),
    'cycleDate', to_char(p_new_cycle, 'YYYY-MM-DD')));
end;
$$;

-- One day's order log, in the order it was logged (the recap email's order).
create or replace function public.mog_sync_get_log(p_slug text, p_key text, p_date date)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'vendor', l.vendor, 'id', l.item_id, 'name', l.item_name, 'pack', l.pack,
               'area', l.area, 'onHandPrev', l.on_hand_prev, 'qty', l.qty_ordered,
               'loggedAt', l.logged_at)
             order by l.seq)
        from mog.order_log l
       where l.slug = p_slug and l.cycle_date = p_date
    ), '[]'::jsonb)));
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: lock the new internals, open exactly the new entry points.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_set_override(text, boolean, bigint)',
    'public.mog_set_vendor_pick(text, text, integer, bigint)',
    'public.mog_sync_get_snapshot(text, text, bigint)',
    'public.mog_sync_set_override(text, text, boolean, bigint)',
    'public.mog_sync_set_vendor_pick(text, text, text, integer, bigint)',
    'public.mog_sync_put_counts(text, text, date, jsonb)',
    'public.mog_sync_close_cycle(text, text, date, date, text, jsonb, jsonb, timestamptz)',
    'public.mog_sync_get_log(text, text, date)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
