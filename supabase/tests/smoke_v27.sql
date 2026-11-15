-- =====================================================================
-- MOG schema v27 — smoke test (run AFTER schema_v27.sql)
-- =====================================================================
-- Apps Script's close and recap flag, refused once Supabase closes the
-- store, on the throwaway store 'zztest27' (New York time, cycle 11-11).
-- Checks:
--   * while close_direct is off, mog_sync_close_cycle closes and
--     mog_sync_set_recap_sent sets the flag, as in v23;
--   * a wrong key is still BAD_SYNC_KEY, before anything about the store;
--   * while close_direct is on, both answer CLOSE_DIRECT and change
--     nothing: the cycle, the order log and the recap flag stay put;
--   * Supabase's own close (mog.night_close) still closes and owes its
--     recap, and a refused flag write doesn't settle it;
--   * close_direct off again (the rollback): Apps Script closes again;
--   * both stay open to anon (the Sheets call them with the public key).
--
-- Rolls itself back, as smoke_v25 does: every write happens inside one
-- inner block that ends by raising 'mog_smoke27_rollback', which undoes
-- all of it; the results ride out in that error's detail. Nothing is kept,
-- so there is no clean-up step, and the Supabase connector runs it without
-- asking for a confirmation. Every row should say PASS; the last row
-- proves nothing was kept.
-- =====================================================================

select set_config('mog.smoke27', '[]', false);

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  select set_config('mog.smoke27',
    (current_setting('mog.smoke27')::jsonb || jsonb_build_array(jsonb_build_object(
      'check_name', p_name, 'ok', coalesce(p_ok, false), 'detail', left(coalesce(p_detail::text, ''), 300))))::text,
    false);
$$;

-- What a close sends: two lines, one with nothing to order (left out of the log).
create or replace function pg_temp.rows27()
returns jsonb language sql as $$
  select '[{"vendor": "Alpha Foods", "id": "ITEM-0001", "name": "Shrimp", "pack": "CASE", "area": "Freezer", "onHandPrev": 1, "qty": 3},
           {"vendor": "Alpha Foods", "id": "ITEM-0002", "name": "Lids", "pack": "", "area": "", "onHandPrev": 0, "qty": 0}]'::jsonb;
$$;

do $$
declare
  k     text;
  r     jsonb;
  st    mog.store_state%rowtype;
  v_out text;
  w_0005 timestamptz := timestamptz '2026-11-13 05:05:00+00';   -- 11-13 12:05 AM New York
begin
  if exists (select 1 from mog.stores where slug = 'zztest27') then
    raise exception 'smoke_v27: a store zztest27 already exists; this file never keeps one, so look before running';
  end if;

  begin
    k := mog.provision_store('zztest27');
    perform public.mog_sync_set_pins('zztest27', k, '4321', null);
    perform mog.replace_catalog_tables('zztest27', jsonb_build_object(
      'profile', jsonb_build_object('timeZone', 'America/New_York', 'location', 'ZZ Smoke 27', 'abbr', 'ZZ27', 'concept', 'roll-play'),
      'vendors', '[{"name": "Alpha Foods", "mults": [1,1,1,1,1,1,1], "cutoff": null}]'::jsonb,
      'areas', '[{"name": "Freezer", "ord": 10}]'::jsonb, 'items', '[]'::jsonb, 'pickRows', '[]'::jsonb));
    perform public.mog_sync_switch_editor('zztest27', k, false);
    insert into mog.store_state (slug, cycle_date, day_of_week) values ('zztest27', date '2026-11-11', 'Wed')
    on conflict (slug) do update set cycle_date = excluded.cycle_date;
    update mog.stores set location = 'ZZ Smoke 27', concept = 'roll-play' where slug = 'zztest27';

    -- ---- close_direct off: Apps Script closes and marks the recap, as in v23 ----
    r := public.mog_sync_close_cycle('zztest27', k, date '2026-11-11', date '2026-11-12', 'Thu', pg_temp.rows27(), '[]'::jsonb);
    perform pg_temp.chk('close_direct off: mog_sync_close_cycle closes (1 row logged, cycle 11-12)',
      (r ->> 'ok')::boolean and (r -> 'data' ->> 'logged')::int = 1
        and (select cycle_date from mog.store_state where slug = 'zztest27') = date '2026-11-12', r);
    r := public.mog_sync_set_recap_sent('zztest27', k, date '2026-11-11');
    perform pg_temp.chk('close_direct off: mog_sync_set_recap_sent sets the flag',
      (r ->> 'ok')::boolean and (select recap_sent_for from mog.store_state where slug = 'zztest27') = date '2026-11-11', r);

    -- ---- close_direct on: both refused, nothing changed ----
    update mog.stores set close_direct = true where slug = 'zztest27';
    r := public.mog_sync_close_cycle('zztest27', 'not-the-key', date '2026-11-12', date '2026-11-13', 'Fri', pg_temp.rows27(), '[]'::jsonb);
    perform pg_temp.chk('close_direct on: a wrong key is still BAD_SYNC_KEY (the key is checked first)',
      r ->> 'error' = 'BAD_SYNC_KEY', r);
    r := public.mog_sync_close_cycle('zztest27', k, date '2026-11-12', date '2026-11-13', 'Fri', pg_temp.rows27(), '[]'::jsonb);
    select * into st from mog.store_state where slug = 'zztest27';
    perform pg_temp.chk('close_direct on: mog_sync_close_cycle answers CLOSE_DIRECT',
      not (r ->> 'ok')::boolean and r ->> 'error' = 'CLOSE_DIRECT', r);
    perform pg_temp.chk('close_direct on: the refused close changed nothing (cycle 11-12, no log for it)',
      st.cycle_date = date '2026-11-12' and st.day_of_week = 'Thu'
        and not exists (select 1 from mog.order_log where slug = 'zztest27' and cycle_date = date '2026-11-12'), null);
    r := public.mog_sync_close_cycle('zztest27', k, date '2026-11-12', date '2026-11-12', 'Thu', pg_temp.rows27(), '[]'::jsonb);
    perform pg_temp.chk('close_direct on: a same-day close (the Sheet''s Reset On Hand) is refused too',
      r ->> 'error' = 'CLOSE_DIRECT'
        and not exists (select 1 from mog.order_log where slug = 'zztest27' and cycle_date = date '2026-11-12'), r);
    r := public.mog_sync_set_recap_sent('zztest27', 'not-the-key', date '2026-11-12');
    perform pg_temp.chk('close_direct on: set_recap_sent with a wrong key is still BAD_SYNC_KEY',
      r ->> 'error' = 'BAD_SYNC_KEY', r);
    r := public.mog_sync_set_recap_sent('zztest27', k, date '2026-11-12');
    perform pg_temp.chk('close_direct on: mog_sync_set_recap_sent answers CLOSE_DIRECT, the flag unchanged',
      r ->> 'error' = 'CLOSE_DIRECT'
        and (select recap_sent_for from mog.store_state where slug = 'zztest27') = date '2026-11-11', r);

    -- ---- Supabase's own close is untouched, and a refused flag write can't settle its recap ----
    r := mog.night_close('zztest27', date '2026-11-12', date '2026-11-13', 'Fri', pg_temp.rows27(), w_0005, 40);
    select * into st from mog.store_state where slug = 'zztest27';
    perform pg_temp.chk('night_close: still closes with close_direct on (1 row logged, recap owed)',
      (r -> 'data' ->> 'logged')::int = 1 and (r ->> 'recapDue')::boolean
        and st.cycle_date = date '2026-11-13' and st.recap_due = date '2026-11-12', r);
    r := public.mog_sync_set_recap_sent('zztest27', k, date '2026-11-12');
    select * into st from mog.store_state where slug = 'zztest27';
    perform pg_temp.chk('night_close: Apps Script marking that cycle is refused; the recap is still owed',
      r ->> 'error' = 'CLOSE_DIRECT' and st.recap_due = date '2026-11-12' and st.recap_sent_for = date '2026-11-11', r);

    -- ---- The rollback: close_direct off, Apps Script closes again ----
    update mog.stores set close_direct = false where slug = 'zztest27';
    r := public.mog_sync_close_cycle('zztest27', k, date '2026-11-13', date '2026-11-14', 'Sat', pg_temp.rows27(), '[]'::jsonb);
    perform pg_temp.chk('rollback: close_direct off, mog_sync_close_cycle closes again',
      (r ->> 'ok')::boolean and (r -> 'data' ->> 'logged')::int = 1
        and (select cycle_date from mog.store_state where slug = 'zztest27') = date '2026-11-14', r);
    r := public.mog_sync_set_recap_sent('zztest27', k, date '2026-11-13');
    perform pg_temp.chk('rollback: close_direct off, mog_sync_set_recap_sent sets the flag again',
      (r ->> 'ok')::boolean and (select recap_sent_for from mog.store_state where slug = 'zztest27') = date '2026-11-13', r);

    -- ---- Privileges ----
    perform pg_temp.chk('anon: both stay open (the Sheets call them with the public key); mog.close_cycle stays closed',
      has_function_privilege('anon', 'public.mog_sync_close_cycle(text, text, date, date, text, jsonb, jsonb, timestamptz)', 'execute')
        and has_function_privilege('anon', 'public.mog_sync_set_recap_sent(text, text, date)', 'execute')
        and not has_function_privilege('anon', 'mog.close_cycle(text, date, date, text, jsonb, jsonb, timestamptz)', 'execute'), null);

    -- Undo every write above; the results leave in the error's detail.
    raise exception 'mog_smoke27_rollback' using detail = current_setting('mog.smoke27');
  exception when raise_exception then
    if sqlerrm <> 'mog_smoke27_rollback' then raise; end if;
    get stacked diagnostics v_out = pg_exception_detail;
    perform set_config('mog.smoke27', v_out, false);
  end;

  perform pg_temp.chk('rollback: nothing of the smoke was kept (store, state, catalog, order log, night log)',
    not exists (select 1 from mog.stores where slug = 'zztest27')
      and not exists (select 1 from mog.store_state where slug = 'zztest27')
      and not exists (select 1 from mog.catalog where slug = 'zztest27')
      and not exists (select 1 from mog.order_log where slug = 'zztest27')
      and not exists (select 1 from mog.night_log where slug = 'zztest27'), null);
end;
$$;

select e.n::int as n, case when (e.c ->> 'ok')::boolean then 'PASS' else 'FAIL' end as result,
       e.c ->> 'check_name' as check_name, e.c ->> 'detail' as detail
  from jsonb_array_elements(current_setting('mog.smoke27')::jsonb) with ordinality as e(c, n)
 order by e.n;
