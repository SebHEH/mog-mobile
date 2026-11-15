-- =====================================================================
-- MOG on Supabase — schema v25   (run AFTER schema.sql and v2 to v24)
-- =====================================================================
-- The nightly close moves from 3:30 AM to midnight, each store's own time
-- (Sebastian, 2026-11-15; docs/MOG_SheetRetirement_Spec.md, step 3).
--
-- Why: step 3 takes the phone's new-day reset away, so Supabase's close is
-- the only thing that ever closes a cycle. The phone's reset drew the day
-- line at midnight (the first open after midnight closed yesterday's
-- cycle), and the one store that counts after midnight (RP Tysons BOH,
-- Chef Center on Saturday nights, 12:01 to 12:38 AM) counts for the new
-- day. A close at midnight keeps that line where KMs already have it.
-- Measured over the 4 weeks to 11-15: no count between 11 PM and midnight
-- at any store.
--
-- What changes: mog.night_due names a store's close (close_direct on, its
-- cycle behind its own today) at any time of its day, so pg_cron's first
-- tick after midnight (every 15 minutes, supabase/night_schedule.sql)
-- closes it, and a failed close is due again 15 minutes later. Nothing
-- else: the recap still follows its close; the shadow (stores Apps Script
-- still closes, none live since 11-15) keeps its 3:00 to 3:20 window; the
-- backup watchdog is unchanged. No table, no public function.
--
-- Rollback: re-run mog.night_due from schema_v24.sql (create or replace):
-- closes wait for 3:30 AM again.
-- Re-running is safe: one create or replace.
-- =====================================================================

do $$
begin
  if to_regprocedure('mog.backup_status(timestamptz)') is null
     or to_regprocedure('mog.night_due(timestamptz)') is null then
    raise exception 'Run schema_v24.sql first: mog.backup_status is missing.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- A close is due from midnight (v24's night_due, one line less)
-- ---------------------------------------------------------------------

-- What the night owes, as [{ slug, step }], closes first:
--   close   a store Supabase closes (close_direct) whose cycle is behind its
--           own today, from midnight its time (v25; v23 and v24 waited
--           for 3:30 AM). A failed close is due again on the next run,
--           15 minutes later.
--   recap   a recap a close of ours owes, under 3 tries, its 15 minutes up.
--   shadow  a store Apps Script still closes, between 3:00 and 3:20 AM its
--           time, once per cycle: the close Supabase would make, worked out
--           and kept, written nowhere else (the live proof before a store
--           switches; supabase/tests/night_shadow_check.sql compares it with
--           what Apps Script logs at 3:30). Unchanged in v25.
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
-- Privileges: lock the internals. No new public entry point.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

notify pgrst, 'reload schema';
