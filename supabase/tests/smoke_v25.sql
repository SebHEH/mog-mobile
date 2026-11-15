-- =====================================================================
-- MOG schema v25 — smoke test (run AFTER schema_v25.sql)
-- =====================================================================
-- The nightly close from midnight, on the throwaway store 'zztest25'
-- (New York time, its cycle on 11-11). Checks:
--   * mog.night_due names its close from midnight its own time once its
--     cycle is behind, in winter and in summer time, and not the evening
--     before; not when the cycle is already today's; not while
--     close_direct is off;
--   * mog.night_plan follows it (due at 12:05 AM);
--   * the shadow keeps its 3:00 to 3:20 window;
--   * nothing internal is open to anon.
--
-- Rolls itself back (2026-11-15): every write happens inside one inner
-- block that ends by raising 'mog_smoke25_rollback', which undoes all of
-- it; the results ride out in that error's detail. Nothing is ever kept,
-- so there is no clean-up step, and the Supabase connector runs it without
-- asking to confirm a destructive statement (that confirmation never
-- appeared in the app and the call hung for 10 minutes). The results live
-- in the setting mog.smoke25 for this session only. Every row should say
-- PASS; the last row proves nothing was kept.
-- =====================================================================

select set_config('mog.smoke25', '[]', false);

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  select set_config('mog.smoke25',
    (current_setting('mog.smoke25')::jsonb || jsonb_build_array(jsonb_build_object(
      'check_name', p_name, 'ok', coalesce(p_ok, false), 'detail', left(coalesce(p_detail::text, ''), 300))))::text,
    false);
$$;

-- Is (slug, step) in night_due at this moment?
create or replace function pg_temp.due25(p_step text, p_at timestamptz)
returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(mog.night_due(p_at)) e
                  where e ->> 'slug' = 'zztest25' and e ->> 'step' = p_step);
$$;

create or replace function pg_temp.cycle25(p_cycle date)
returns void language sql as $$
  update mog.store_state set cycle_date = p_cycle, recap_due = null, recap_tries = 0, recap_next_at = null,
         recap_sent_for = null where slug = 'zztest25';
$$;

do $$
declare
  k     text;
  r     jsonb;
  v_out text;
  -- New York, winter (EST, UTC-5): 11-11 11:55 PM = 11-12 04:55 UTC; 11-12 12:05 AM = 05:05 UTC.
  w_2355 timestamptz := timestamptz '2026-11-12 04:55:00+00';
  w_0005 timestamptz := timestamptz '2026-11-12 05:05:00+00';
  w_0235 timestamptz := timestamptz '2026-11-12 07:35:00+00';
  w_0305 timestamptz := timestamptz '2026-11-12 08:05:00+00';
  -- Summer (EDT, UTC-4): 07-01 11:55 PM = 07-02 03:55 UTC; 07-02 12:05 AM = 04:05 UTC.
  s_2355 timestamptz := timestamptz '2026-07-02 03:55:00+00';
  s_0005 timestamptz := timestamptz '2026-07-02 04:05:00+00';
begin
  if exists (select 1 from mog.stores where slug = 'zztest25') then
    raise exception 'smoke_v25: a store zztest25 already exists; this file never keeps one, so look before running';
  end if;

  begin
    k := mog.provision_store('zztest25');
    perform public.mog_sync_set_pins('zztest25', k, '4321', null);
    perform mog.replace_catalog_tables('zztest25', jsonb_build_object(
      'profile', jsonb_build_object('timeZone', 'America/New_York', 'location', 'ZZ Smoke 25', 'abbr', 'ZZ25', 'concept', 'roll-play'),
      'vendors', '[{"name": "Alpha Foods", "mults": [1,1,1,1,1,1,1], "cutoff": null}]'::jsonb,
      'areas', '[{"name": "Freezer", "ord": 10}]'::jsonb, 'items', '[]'::jsonb, 'pickRows', '[]'::jsonb));
    perform public.mog_sync_switch_editor('zztest25', k, false);
    insert into mog.store_state (slug, cycle_date, day_of_week) values ('zztest25', date '2026-11-11', 'Wed')
    on conflict (slug) do update set cycle_date = excluded.cycle_date;

    -- ---- close_direct off: never a close ----
    perform pg_temp.cycle25(date '2026-11-11');
    perform pg_temp.chk('due: close_direct off, no close at 12:05 AM or 2:35 AM',
      not pg_temp.due25('close', w_0005) and not pg_temp.due25('close', w_0235), null);

    -- ---- close_direct on: from midnight ----
    update mog.stores set close_direct = true where slug = 'zztest25';
    perform pg_temp.chk('due: not at 11:55 PM the evening of the cycle (winter)', not pg_temp.due25('close', w_2355), null);
    perform pg_temp.chk('due: at 12:05 AM (winter, 05:05 UTC)', pg_temp.due25('close', w_0005), null);
    perform pg_temp.chk('due: still at 2:35 AM, before v24''s 3:30 (winter)', pg_temp.due25('close', w_0235), null);
    r := mog.night_plan('zztest25', 'close', w_0005);
    perform pg_temp.chk('plan: due at 12:05 AM, with the sync snapshot of cycle 11-11',
      (r ->> 'due')::boolean and r -> 'snapshot' -> 'state' ->> 'cycleDate' = '2026-11-11', r);
    perform pg_temp.cycle25(date '2026-07-01');
    perform pg_temp.chk('due: summer time, at 12:05 AM (04:05 UTC) and not at 11:55 PM the evening before',
      pg_temp.due25('close', s_0005) and not pg_temp.due25('close', s_2355), null);
    perform pg_temp.cycle25(date '2026-11-12');
    perform pg_temp.chk('due: a cycle that is already today''s is not closed at 12:05 AM', not pg_temp.due25('close', w_0005), null);
    r := mog.night_plan('zztest25', 'close', w_0005);
    perform pg_temp.chk('plan: not due answers { due: false }', r = '{"due": false}'::jsonb, r);

    -- ---- The shadow keeps its window ----
    update mog.stores set close_direct = false where slug = 'zztest25';
    perform pg_temp.cycle25(date '2026-11-11');
    perform pg_temp.chk('shadow: still 3:00 to 3:20 only (due at 3:05, not at 12:05 AM)',
      pg_temp.due25('shadow', w_0305) and not pg_temp.due25('shadow', w_0005), null);

    -- ---- Privileges ----
    perform pg_temp.chk('anon: mog.night_due and night_plan are closed',
      not has_function_privilege('anon', 'mog.night_due(timestamptz)', 'execute')
        and not has_function_privilege('anon', 'mog.night_plan(text, text, timestamptz)', 'execute'), null);

    -- Undo every write above; the results leave in the error's detail.
    raise exception 'mog_smoke25_rollback' using detail = current_setting('mog.smoke25');
  exception when raise_exception then
    if sqlerrm <> 'mog_smoke25_rollback' then raise; end if;
    get stacked diagnostics v_out = pg_exception_detail;
    perform set_config('mog.smoke25', v_out, false);
  end;

  perform pg_temp.chk('rollback: nothing of the smoke was kept (store, state, catalog, night log)',
    not exists (select 1 from mog.stores where slug = 'zztest25')
      and not exists (select 1 from mog.store_state where slug = 'zztest25')
      and not exists (select 1 from mog.catalog where slug = 'zztest25')
      and not exists (select 1 from mog.night_log where slug = 'zztest25'), null);
end;
$$;

select e.n::int as n, case when (e.c ->> 'ok')::boolean then 'PASS' else 'FAIL' end as result,
       e.c ->> 'check_name' as check_name, e.c ->> 'detail' as detail
  from jsonb_array_elements(current_setting('mog.smoke25')::jsonb) with ordinality as e(c, n)
 order by e.n;
