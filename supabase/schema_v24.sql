-- =====================================================================
-- MOG on Supabase — schema v24   (run AFTER schema.sql and v2 to v23)
-- =====================================================================
-- Two things, approved by Sebastian on 2026-11-12 ("Yes, build the watchdog
-- in v24 and include the via/par/stores drop"):
--
-- 1. The backup watchdog (docs/MOG_SheetRetirement_Spec.md, step 1's
--    watchdog). The nightly backup (SebHEH/mog-backup) emails only when a
--    run goes red; a night with no run emails nobody. So:
--    * mog.backup_heartbeats: one row per good backup. The backup's GitHub
--      Action writes it after the dump restored and matched the live
--      database, as mog_backup, through mog.backup_heartbeat (the one write
--      that role may make).
--    * mog.backup_watch (one row): where the alert goes (alert_to, set once
--      by a maintainer, never in this public repo), the hours that count as
--      stale (30), when the watch started (the moment this file first ran,
--      so a heartbeat step that never works still alerts), and the last
--      alert and test.
--    * mog.backup_status: the newest good backup and whether an alert is due:
--      an address is set, nothing good is newer than 30 hours (counting from
--      the watch's start until the first heartbeat), and the last alert is a
--      day old (an hour, when it failed). One email a day while it lasts.
--    * mog.night_due names { slug: null, step: 'backup' } when it's due, so
--      pg_cron's 15-minute tick (night_schedule.sql) posts to the Edge
--      Function `close`, which sends it through the mail relay
--      (mog.backup_alert_claim, mog.backup_alert_done). A test email goes to
--      the same address (mog.backup_test_data; night_schedule.sql's
--      mog.backup_watch_test()).
--
-- 2. The drop of mog.wh_products.via, par and stores, retired and unread
--    since v21 (docs/MOG_Warehouse_Spec.md, "Retired, kept unread"). Their
--    values are copied first into mog.wh_products_retired (product id and
--    name with the three values), so the drop can be undone. The drop stops
--    before anything changes if any function in mog or public still names
--    them.
--
-- Rollback:
--   * the watchdog: `update mog.backup_watch set alert_to = null;` stops
--     every alert (night_due names nothing without an address). The
--     backup's heartbeat step skips itself when mog.backup_heartbeat is
--     missing.
--   * the columns:
--       alter table mog.wh_products add column via text,
--         add column par numeric not null default 0 check (par >= 0),
--         add column stores text[] not null default '{}';
--       update mog.wh_products p set via = r.via, par = r.par, stores = r.stores
--         from mog.wh_products_retired r where r.product_id = p.id;
--     (v17's via check, `via is null or via = btrim(via) and length(via)
--     between 1 and 60`, is the only constraint that isn't in those lines.)
-- Re-running is safe: the copy and the drop run only while the columns
-- exist; the tables are made only if missing; the watch row is never reset.
-- =====================================================================

do $$
begin
  if to_regprocedure('mog.night_due(timestamptz)') is null
     or to_regclass('mog.night_log') is null then
    raise exception 'Run schema_v23.sql first: mog.night_due is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. The retired warehouse columns: copied, then dropped
-- ---------------------------------------------------------------------

create table if not exists mog.wh_products_retired (
  product_id bigint primary key,           -- mog.wh_products.id (no link: a product deleted later keeps its row here)
  name       text not null,
  via        text,
  par        numeric,
  stores     text[],
  saved_at   timestamptz not null default now()
);
alter table mog.wh_products_retired enable row level security;

do $$
declare
  n_cols  integer;
  readers text;
  n_saved integer;
begin
  select count(*) into n_cols
    from information_schema.columns
   where table_schema = 'mog' and table_name = 'wh_products' and column_name in ('via', 'par', 'stores');
  if n_cols = 0 then
    return;   -- dropped already (a re-run)
  end if;
  if n_cols <> 3 then
    raise exception 'mog.wh_products has % of via, par and stores; expected all 3 (or none). Nothing changed.', n_cols;
  end if;

  -- Anything that still names them stops the drop. Postgres doesn't track a
  -- function's columns, so their bodies are read: a function that mentions
  -- wh_products and the word via or par, or a stores that isn't the table
  -- mog.stores or a quoted JSON key. A view, a policy, an index or a
  -- trigger on them makes the drop itself fail (no cascade).
  select string_agg(format('%s.%s', n.nspname, p.proname), ', ' order by n.nspname, p.proname) into readers
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('mog', 'public')
     and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ 'wh_products'
     and (regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ '\m(via|par)\M'
          or regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ '(\m(?!mog\.)[a-z_]+\.stores\M|,\s*stores\s*[,)])');
  if readers is not null then
    raise exception 'These functions still name mog.wh_products.via, par or stores: %. Nothing was dropped.', readers;
  end if;

  insert into mog.wh_products_retired (product_id, name, via, par, stores)
    select p.id, p.name, p.via, p.par, p.stores from mog.wh_products p
  on conflict (product_id) do nothing;
  get diagnostics n_saved = row_count;

  alter table mog.wh_products drop column via, drop column par, drop column stores;
  raise notice 'mog.wh_products: via, par and stores dropped; % product(s) copied to mog.wh_products_retired first', n_saved;
end;
$$;


-- ---------------------------------------------------------------------
-- 1. The backup watchdog: tables
-- ---------------------------------------------------------------------

create table if not exists mog.backup_heartbeats (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  run_id     text not null check (run_id = btrim(run_id) and length(run_id) between 1 and 100),
  tables     integer not null check (tables > 0),
  row_total  bigint not null check (row_total >= 0),
  dump_bytes bigint not null check (dump_bytes > 0)
);
create index if not exists backup_heartbeats_at on mog.backup_heartbeats (at desc);
alter table mog.backup_heartbeats enable row level security;

create table if not exists mog.backup_watch (
  id                boolean primary key default true check (id),   -- one row
  watch_from        timestamptz not null default now(),
  alert_to          text check (alert_to is null or (alert_to = btrim(alert_to) and length(alert_to) <= 254
                                                     and alert_to ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  stale_hours       integer not null default 30 check (stale_hours between 1 and 240),
  last_alert_at     timestamptz,
  last_alert_ok     boolean,              -- null while a send is under way (or died): tried again after an hour
  last_alert_detail jsonb,
  last_test_at      timestamptz,
  last_test_ok      boolean,
  last_test_detail  jsonb
);
alter table mog.backup_watch enable row level security;
insert into mog.backup_watch (id) values (true) on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 1. The backup watchdog: functions
-- ---------------------------------------------------------------------

-- A good backup: written by the backup's GitHub Action (SebHEH/mog-backup,
-- scripts/heartbeat.sh) after its dump restored and matched, as mog_backup
-- (read-only by default; the script opens a read-write transaction for this
-- one call). Security definer: the role can't write a table itself.
create or replace function mog.backup_heartbeat(p_run text, p_tables integer, p_rows bigint, p_bytes bigint)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_at timestamptz;
begin
  if p_run is null or p_run <> btrim(p_run) or length(p_run) not between 1 and 100 then
    raise exception 'backup_heartbeat: the run id is 1 to 100 characters';
  end if;
  if coalesce(p_tables, 0) < 1 or coalesce(p_rows, -1) < 0 or coalesce(p_bytes, 0) < 1 then
    raise exception 'backup_heartbeat: tables (%), rows (%) and bytes (%) must be counts from a real dump', p_tables, p_rows, p_bytes;
  end if;
  insert into mog.backup_heartbeats (run_id, tables, row_total, dump_bytes)
  values (p_run, p_tables, p_rows, p_bytes)
  returning id, at into v_id, v_at;
  return jsonb_build_object('ok', true, 'id', v_id, 'at', v_at);
end;
$$;

-- Where the backups stand at p_at:
--   newest      the newest good backup's time and run (null before the first)
--   since       the later of newest and the watch's start (so setting
--               watch_from = now() restarts the clock)
--   hours       hours since then, one decimal
--   stale       more than stale_hours
--   hasAddress  an alert address is set
--   due         an alert should go now: an address, stale, and no alert in
--               the last day (the last hour, when the last one failed or
--               never finished)
create or replace function mog.backup_status(p_at timestamptz default now())
returns jsonb
language sql stable
set search_path = ''
as $$
  select case when w.id is null then jsonb_build_object('due', false, 'stale', false, 'hasAddress', false)
    else jsonb_build_object(
      'newest',     h.at,
      'run',        h.run_id,
      'watchFrom',  w.watch_from,
      'since',      greatest(h.at, w.watch_from),
      'hours',      round((extract(epoch from (p_at - greatest(h.at, w.watch_from))) / 3600)::numeric, 1),
      'staleHours', w.stale_hours,
      'stale',      greatest(h.at, w.watch_from) < p_at - make_interval(hours => w.stale_hours),
      'hasAddress', w.alert_to is not null,
      'lastAlertAt', w.last_alert_at,
      'lastAlertOk', w.last_alert_ok,
      'due',        w.alert_to is not null
                    and greatest(h.at, w.watch_from) < p_at - make_interval(hours => w.stale_hours)
                    and (w.last_alert_at is null
                         or (w.last_alert_ok is true and w.last_alert_at <= p_at - interval '24 hours')
                         or (w.last_alert_ok is not true and w.last_alert_at <= p_at - interval '1 hour')))
    end
    from (select 1) one
    left join mog.backup_watch w on w.id
    left join lateral (select b.at, b.run_id from mog.backup_heartbeats b order by b.at desc, b.id desc limit 1) h on true;
$$;

-- The alert, if it's still due: claimed (last_alert_at = p_at, the outcome
-- unknown until mog.backup_alert_done), with the address and the status.
-- Else { due: false }.
create or replace function mog.backup_alert_claim(p_at timestamptz default now())
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
declare
  w  mog.backup_watch%rowtype;
  st jsonb;
begin
  select * into w from mog.backup_watch where id for update;
  if not found then
    return jsonb_build_object('due', false);
  end if;
  st := mog.backup_status(p_at);
  if not coalesce((st ->> 'due')::boolean, false) then
    return jsonb_build_object('due', false);
  end if;
  update mog.backup_watch set last_alert_at = p_at, last_alert_ok = null, last_alert_detail = null where id;
  return st || jsonb_build_object('due', true, 'to', w.alert_to, 'claimedAt', p_at);
end;
$$;

-- How a send went: p_kind 'alert' (the claimed one) or 'test'.
create or replace function mog.backup_alert_done(p_kind text, p_ok boolean, p_detail jsonb, p_at timestamptz default now())
returns jsonb
language plpgsql volatile
set search_path = ''
as $$
begin
  if p_kind = 'alert' then
    update mog.backup_watch
       set last_alert_ok = coalesce(p_ok, false), last_alert_detail = coalesce(p_detail, '{}'::jsonb)
     where id and last_alert_at is not null;
  elsif p_kind = 'test' then
    update mog.backup_watch
       set last_test_at = p_at, last_test_ok = coalesce(p_ok, false), last_test_detail = coalesce(p_detail, '{}'::jsonb)
     where id;
  else
    raise exception 'backup_alert_done: the kind is alert or test, not %', coalesce(p_kind, 'null');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- A test email's address and status: the watch's own address only.
create or replace function mog.backup_test_data(p_at timestamptz default now())
returns jsonb
language sql stable
set search_path = ''
as $$
  select case when w.alert_to is null then jsonb_build_object('ok', false, 'error', 'NO_ADDRESS')
              else mog.backup_status(p_at) || jsonb_build_object('ok', true, 'to', w.alert_to) end
    from (select 1) one left join mog.backup_watch w on w.id;
$$;

-- ---------------------------------------------------------------------
-- The night's list gains the watchdog (v23's night_due, one branch more)
-- ---------------------------------------------------------------------

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
--   backup  (v24, slug null) the backup watchdog's alert, when
--           mog.backup_status says it's due.
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
      union all
      select null::text, 'backup', 4
       where coalesce((mog.backup_status(p_at) ->> 'due')::boolean, false)
    ) d;
$$;

-- ---------------------------------------------------------------------
-- Privileges: lock the internals. No new public entry point; the one
-- grant is the heartbeat to the backup role (supabase/backup_role.sql),
-- when it exists (it does live; PGlite has none).
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mog_backup') then
    grant execute on function mog.backup_heartbeat(text, integer, bigint, bigint) to mog_backup;
  end if;
end;
$$;

notify pgrst, 'reload schema';
