-- =====================================================================
-- MOG on Supabase — schema v23   (run AFTER schema.sql and v2 to v22)
-- =====================================================================
-- Sheet retirement step 2 (docs/MOG_SheetRetirement_Spec.md, R1, R2, R8,
-- R9): the 3:30 AM close and the recap email move from each store's Apps
-- Script into Supabase, one store at a time.
--
--   * mog.stores.close_direct (off): Supabase closes this store. While it's
--     off, Apps Script's 3:30 AM trigger closes it as before; the night it's
--     on, that trigger deletes itself (Sync.gs nightMovedToDb_) and stamps
--     mog.stores.sheet_trigger_off_at.
--   * mog.store_state.recap_sent_for: the once-per-cycle recap flag (was the
--     Script Property MOG_LAST_RECAP_SENT_DATE). Apps Script's Daily summary
--     and its own close read and write it too, so a cycle gets one recap
--     whoever sends it. recap_due / recap_tries / recap_next_at: a recap
--     Supabase's close owes, tried up to 3 times, 15 minutes apart.
--   * mog.night_log: one row per close, recap, shadow or test the nightly
--     function makes (kept 90 days, shadows 30): where to look when a night
--     goes wrong.
--   * mog.close_cycle: v17's mog_sync_close_cycle body, minus the key check;
--     mog_sync_close_cycle (same signature) is now the key check plus it.
--   * The nightly function's SQL (internal, called by the Edge Function
--     `close` over its own database connection): mog.night_due, night_plan,
--     night_close, night_recap_claim, night_recap_done, night_shadow_done,
--     night_test_data, night_note.
--   * Apps Script's two calls: mog_sync_night (close_direct and the flag,
--     and the trigger's retirement) and mog_sync_set_recap_sent.
--
-- The schedule (pg_cron, pg_net, the Vault secret, mog.night_tick) is
-- supabase/night_schedule.sql, run once after this file: PGlite can't run
-- it, and it's the switch that starts the nightly runs.
--
-- Takes v23; the drop of mog.wh_products.via, par and stores (planned as
-- v23 in the 11-06 handoff) moves to v24.
--
-- Rollback: a store back to Apps Script is `update mog.stores set
-- close_direct = false where slug = '...'` plus its trigger re-installed
-- (Move this store to Supabase installs it). The functions: re-run v17's
-- mog_sync_close_cycle. Writes no store data; re-running is safe.
-- =====================================================================

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'mog' and table_name = 'items' and column_name = 'wh_vendor') then
    raise exception 'Run schema_v21.sql and schema_v22.sql first: mog.items.wh_vendor is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

alter table mog.stores add column if not exists close_direct boolean not null default false;
alter table mog.stores add column if not exists sheet_trigger_off_at timestamptz;

alter table mog.store_state add column if not exists recap_sent_for date;
alter table mog.store_state add column if not exists recap_due      date;
alter table mog.store_state add column if not exists recap_tries    integer not null default 0;
alter table mog.store_state add column if not exists recap_next_at  timestamptz;

create table if not exists mog.night_log (
  id         bigint generated always as identity primary key,
  slug       text not null references mog.stores (slug) on delete cascade,
  at         timestamptz not null default now(),
  step       text not null check (step in ('close', 'recap', 'shadow', 'test')),
  cycle_date date,
  ok         boolean not null,
  detail     jsonb not null default '{}'::jsonb
);
create index if not exists night_log_slug_at on mog.night_log (slug, at desc);
alter table mog.night_log enable row level security;

-- ---------------------------------------------------------------------
-- The close, callable without a key (internal)
-- ---------------------------------------------------------------------

-- The cycle close: v17's mog_sync_close_cycle body, unchanged, minus the key
-- check. Both closers call it: Apps Script through mog_sync_close_cycle (its
-- sync key), and Supabase's nightly close through mog.night_close. The log,
-- the held deliveries (v17 to v22, in their own exception block), the new
-- cycle and the second-close refusal (CYCLE_MOVED) are the same either way.
create or replace function mog.close_cycle(
  p_slug text,
  p_closing date, p_new_cycle date, p_new_dow text,
  p_rows jsonb, p_todays_log jsonb, p_logged_at timestamptz default null)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  st   mog.store_state%rowtype;
  v_n  integer;
  v_at timestamptz := coalesce(p_logged_at, now());
  v_err text;
begin
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

  -- v17: the store's deliveries of HEH's stock held at Elpis, from the log
  -- just written. In a block of its own: nothing in it can stop the close.
  begin
    perform mog.wh_held_from_log(p_slug, p_closing);
  exception when others then
    v_err := sqlerrm;
  end;

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
    'cycleDate', to_char(p_new_cycle, 'YYYY-MM-DD'))
    || case when v_err is null then '{}'::jsonb else jsonb_build_object('heldError', v_err) end);
end;
$$;

-- v2's signature, now a key check in front of mog.close_cycle.
create or replace function public.mog_sync_close_cycle(
  p_slug text, p_key text,
  p_closing date, p_new_cycle date, p_new_dow text,
  p_rows jsonb, p_todays_log jsonb, p_logged_at timestamptz default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  return mog.close_cycle(p_slug, p_closing, p_new_cycle, p_new_dow, p_rows, p_todays_log, p_logged_at);
end;
$$;


-- ---------------------------------------------------------------------
-- The nightly function's SQL (internal: the Edge Function `close` calls
-- these over SUPABASE_DB_URL; nothing here is reachable with a key)
-- ---------------------------------------------------------------------

-- The store's wall clock, in the time zone its "today" comes from
-- (mog.snapshot_json, v7: the catalog's timeZone, else New York). Daylight
-- saving is Postgres's.
create or replace function mog.night_local(p_slug text, p_at timestamptz)
returns timestamp
language sql stable
set search_path = ''
as $$
  select p_at at time zone coalesce(
    (select nullif(c.payload ->> 'timeZone', '') from mog.catalog c where c.slug = p_slug),
    'America/New_York');
$$;

-- One row in mog.night_log (a known store only).
create or replace function mog.night_note(p_slug text, p_step text, p_cycle date, p_ok boolean, p_detail jsonb)
returns void
language sql volatile
set search_path = ''
as $$
  insert into mog.night_log (slug, step, cycle_date, ok, detail)
  select p_slug, p_step, p_cycle, coalesce(p_ok, false), coalesce(p_detail, '{}'::jsonb)
   where exists (select 1 from mog.stores s where s.slug = p_slug);
$$;

-- What the night owes, as [{ slug, step }], closes first:
--   close   a store Supabase closes (close_direct) whose cycle is behind its
--           own today, from 3:30 AM its time. A failed close is due again on
--           the next run, 15 minutes later.
--   recap   a recap a close of ours owes, under 3 tries, its 15 minutes up.
--   shadow  a store Apps Script still closes, between 3:00 and 3:20 AM its
--           time, once per cycle: the close Supabase would make, worked out
--           and kept, written nowhere else (the live proof before a store
--           switches; supabase/tests/night_shadow_check.sql compares it with
--           what Apps Script logs at 3:30).
create or replace function mog.night_due(p_at timestamptz default now())
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('slug', d.slug, 'step', d.step) order by d.ord, d.slug), '[]'::jsonb)
    from (
      select s.slug, 'close' as step, 1 as ord
        from mog.stores s
        join mog.store_state st on st.slug = s.slug
        join mog.catalog c on c.slug = s.slug
       where s.close_direct
         and st.cycle_date < mog.night_local(s.slug, p_at)::date
         and mog.night_local(s.slug, p_at)::time >= time '03:30'
      union all
      select st.slug, 'recap', 2
        from mog.store_state st
       where st.recap_due is not null and st.recap_tries < 3
         and (st.recap_next_at is null or st.recap_next_at <= p_at)
      union all
      select s.slug, 'shadow', 3
        from mog.stores s
        join mog.store_state st on st.slug = s.slug
        join mog.catalog c on c.slug = s.slug
       where not s.close_direct and not s.is_test
         and st.cycle_date < mog.night_local(s.slug, p_at)::date
         and mog.night_local(s.slug, p_at)::time >= time '03:00'
         and mog.night_local(s.slug, p_at)::time <  time '03:20'
         and not exists (select 1 from mog.night_log g
                          where g.slug = s.slug and g.step = 'shadow' and g.cycle_date = st.cycle_date)
    ) d;
$$;

-- A close or a shadow, if it's still due: the store's snapshot (the one
-- Apps Script's closeCycleInDb_ reads, mog_sync_get_snapshot), else
-- { due: false }.
create or replace function mog.night_plan(p_slug text, p_step text, p_at timestamptz default now())
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_snap jsonb;
begin
  if p_step is null or p_step not in ('close', 'shadow') then
    raise exception 'night_plan: the step is close or shadow, not %', coalesce(p_step, 'null');
  end if;
  if not exists (select 1 from jsonb_array_elements(mog.night_due(p_at)) e
                  where e ->> 'slug' = p_slug and e ->> 'step' = p_step) then
    return jsonb_build_object('due', false);
  end if;
  v_snap := mog.snapshot_json(p_slug, 'sync', null);
  if not coalesce((v_snap ->> 'ok')::boolean, false) then
    return jsonb_build_object('due', false, 'reason', v_snap ->> 'error');
  end if;
  return jsonb_build_object('due', true, 'snapshot', v_snap -> 'data');
end;
$$;

-- A cycle's order log, as mog_sync_get_log gives Apps Script's recap.
create or replace function mog.night_log_rows(p_slug text, p_date date)
returns jsonb
language sql stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'vendor', l.vendor, 'id', l.item_id, 'name', l.item_name, 'pack', l.pack,
           'area', l.area, 'onHandPrev', l.on_hand_prev, 'qty', l.qty_ordered,
           'loggedAt', l.logged_at)
         order by l.seq), '[]'::jsonb)
    from mog.order_log l
   where l.slug = p_slug and l.cycle_date = p_date;
$$;

-- Supabase's close of one store (the rows worked out by OrderMath.gs in the
-- function, from night_plan's snapshot), through mog.close_cycle. A cycle
-- that logged rows owes its recap, unless one already went out for it (the
-- Daily summary during the day). Every call leaves a 'close' row in
-- mog.night_log. Refused when the store isn't close_direct (any more).
create or replace function mog.night_close(
  p_slug text, p_closing date, p_new_cycle date, p_new_dow text,
  p_rows jsonb, p_at timestamptz default now(), p_ms integer default null)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  r       jsonb;
  d       jsonb;
  v_recap text := null;
begin
  if not exists (select 1 from mog.stores s where s.slug = p_slug and s.close_direct) then
    r := jsonb_build_object('ok', false, 'error', 'NOT_CLOSE_DIRECT');
  else
    r := mog.close_cycle(p_slug, p_closing, p_new_cycle, p_new_dow, p_rows, '[]'::jsonb, p_at);
  end if;
  d := coalesce(r -> 'data', '{}'::jsonb);
  if coalesce((d ->> 'closed')::boolean, false) then
    v_recap := 'nothing ordered';
    if coalesce((d ->> 'logged')::integer, 0) > 0 then
      if exists (select 1 from mog.store_state st where st.slug = p_slug and st.recap_sent_for = p_closing) then
        v_recap := 'already sent';
      else
        update mog.store_state
           set recap_due = p_closing, recap_tries = 0, recap_next_at = null
         where slug = p_slug;
        v_recap := 'due';
      end if;
    end if;
  end if;
  perform mog.night_note(p_slug, 'close', p_closing, coalesce((r ->> 'ok')::boolean, false),
    jsonb_strip_nulls(jsonb_build_object(
      'closed', d -> 'closed', 'logged', d -> 'logged', 'reason', d -> 'reason', 'cycleDate', d -> 'cycleDate',
      'heldError', d -> 'heldError', 'error', r -> 'error', 'recap', v_recap, 'ms', p_ms)));
  return r || jsonb_build_object('recapDue', v_recap is not distinct from 'due');
end;
$$;

-- Take the recap a close of ours owes, for one try: { due: false } when
-- there's none, it went out already (the flag names its cycle), it was
-- tried 3 times, or its 15 minutes aren't up. Else the try is counted and
-- the next one set 15 minutes on, before anything is sent, so two runs
-- can't both send it; with the store's name, concept, the cycle's log
-- (mog_sync_get_log's rows) and its active recipients, in order.
create or replace function mog.night_recap_claim(p_slug text, p_at timestamptz default now())
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  st mog.store_state%rowtype;
  s  mog.stores%rowtype;
begin
  select * into st from mog.store_state where slug = p_slug for update;
  if not found or st.recap_due is null then
    return jsonb_build_object('due', false);
  end if;
  if st.recap_sent_for is not distinct from st.recap_due then
    update mog.store_state set recap_due = null, recap_next_at = null where slug = p_slug;
    return jsonb_build_object('due', false, 'reason', 'already sent');
  end if;
  if st.recap_tries >= 3 then
    return jsonb_build_object('due', false, 'reason', 'tried 3 times');
  end if;
  if st.recap_next_at is not null and st.recap_next_at > p_at then
    return jsonb_build_object('due', false, 'reason', 'next try later');
  end if;
  update mog.store_state
     set recap_tries = st.recap_tries + 1, recap_next_at = p_at + interval '15 minutes'
   where slug = p_slug;
  select * into s from mog.stores where slug = p_slug;
  return jsonb_build_object(
    'due', true, 'cycle', to_char(st.recap_due, 'YYYY-MM-DD'), 'attempt', st.recap_tries + 1,
    'location', coalesce(s.location, ''), 'concept', coalesce(s.concept, ''),
    'rows', mog.night_log_rows(p_slug, st.recap_due),
    'recipients', coalesce((
      select jsonb_agg(jsonb_build_object('name', r.name, 'email', r.email) order by r.pos)
        from mog.recipients r
       where r.slug = p_slug and r.active and coalesce(r.email, '') <> ''), '[]'::jsonb));
end;
$$;

-- A try's outcome, as Apps Script's sendPendingRecap_ treats it: one
-- recipient reached sets the flag (the others aren't retried); nothing to
-- send (no recipients, nothing in the log) ends it; a try where every send
-- failed waits for the next, and after the third the cycle stays owed in
-- recap_due with recap_tries 3, which the night no longer picks. One
-- 'recap' row in mog.night_log either way.
create or replace function mog.night_recap_done(
  p_slug text, p_cycle date, p_sent integer, p_failed integer,
  p_detail jsonb default '{}'::jsonb)
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  st        mog.store_state%rowtype;
  v_nothing boolean := coalesce((p_detail ->> 'nothing')::boolean, false);
  v_state   text;
begin
  select * into st from mog.store_state where slug = p_slug for update;
  if coalesce(p_sent, 0) > 0 then
    update mog.store_state
       set recap_sent_for = p_cycle,
           recap_due      = case when recap_due = p_cycle then null else recap_due end,
           recap_next_at  = case when recap_due = p_cycle then null else recap_next_at end
     where slug = p_slug;
    v_state := 'sent';
  elsif v_nothing then
    update mog.store_state set recap_due = null, recap_next_at = null
     where slug = p_slug and recap_due = p_cycle;
    v_state := 'nothing to send';
  elsif st.recap_tries >= 3 then
    v_state := 'gave up';
  else
    v_state := 'try again';
  end if;
  perform mog.night_note(p_slug, 'recap', p_cycle, coalesce(p_sent, 0) > 0 or v_nothing,
    coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('sent', coalesce(p_sent, 0), 'failed', coalesce(p_failed, 0), 'state', v_state));
  return jsonb_build_object('state', v_state);
end;
$$;

-- The close Supabase would have made for a store Apps Script still closes:
-- its rows as worked out (unfiltered), and when the cycle's last count was
-- saved, so a count made after this tells a real difference from a late one.
create or replace function mog.night_shadow_done(p_slug text, p_cycle date, p_rows jsonb, p_ms integer default null)
returns void
language sql volatile
set search_path = ''
as $$
  select mog.night_note(p_slug, 'shadow', p_cycle, true, jsonb_strip_nulls(jsonb_build_object(
    'rows', coalesce(p_rows, '[]'::jsonb), 'ms', p_ms,
    'countsAt', (select max(k.updated_at) from mog.counts k where k.slug = p_slug and k.cycle_date = p_cycle))));
$$;

-- A logged cycle's recap, for a test email to one address (the function's
-- 'test' step): the store's name and concept and the cycle's log.
create or replace function mog.night_test_data(p_slug text, p_date date)
returns jsonb
language sql stable
set search_path = ''
as $$
  select case when s.slug is null then jsonb_build_object('ok', false, 'error', 'UNKNOWN_STORE')
              else jsonb_build_object('ok', true, 'location', coalesce(s.location, ''), 'concept', coalesce(s.concept, ''),
                                      'rows', mog.night_log_rows(p_slug, p_date)) end
    from (select 1) one left join mog.stores s on s.slug = p_slug;
$$;

-- ---------------------------------------------------------------------
-- Public: Apps Script (sync key)
-- ---------------------------------------------------------------------

-- Who closes this store, and the cycle whose recap last went out. With
-- p_trigger_off, the store's 3:30 AM trigger has just deleted itself
-- (Sync.gs nightMovedToDb_): stamped only while close_direct is on.
create or replace function public.mog_sync_night(p_slug text, p_key text, p_trigger_off boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s mog.stores%rowtype;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  if coalesce(p_trigger_off, false) then
    update mog.stores set sheet_trigger_off_at = now() where slug = p_slug and close_direct;
  end if;
  select * into s from mog.stores where slug = p_slug;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'closeDirect', s.close_direct,
    'recapSentFor', (select to_char(st.recap_sent_for, 'YYYY-MM-DD') from mog.store_state st where st.slug = p_slug),
    'sheetTriggerOffAt', s.sheet_trigger_off_at));
end;
$$;

-- A recap went out from Apps Script (the Daily summary, or its own close):
-- the flag names that cycle, and a recap Supabase owed for it is settled.
create or replace function public.mog_sync_set_recap_sent(p_slug text, p_key text, p_cycle date)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  if p_cycle is null then
    return jsonb_build_object('ok', false, 'error', 'a cycle date is required');
  end if;
  update mog.store_state
     set recap_sent_for = p_cycle,
         recap_due      = case when recap_due = p_cycle then null else recap_due end,
         recap_next_at  = case when recap_due = p_cycle then null else recap_next_at end
   where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('recapSentFor', to_char(p_cycle, 'YYYY-MM-DD')));
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
    'public.mog_sync_close_cycle(text, text, date, date, text, jsonb, jsonb, timestamptz)',
    'public.mog_sync_night(text, text, boolean)',
    'public.mog_sync_set_recap_sent(text, text, date)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
