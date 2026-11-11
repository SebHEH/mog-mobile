-- =====================================================================
-- MOG schema v23 — smoke test (run in the SQL Editor AFTER schema_v23.sql)
-- =====================================================================
-- Sheet retirement step 2, on the throwaway store 'zztest23' (New York
-- time, two vendors, three recipients of which one inactive) and the
-- test store 'zztest23t' (is_test). Checks:
--   * mog_sync_close_cycle, now a key check in front of mog.close_cycle,
--     closes as before and refuses a bad key and a second close;
--   * mog.night_due: a store closes from 3:30 AM its own time once
--     close_direct is on, never before, in winter and in summer time; a
--     store Apps Script closes gets one shadow between 3:00 and 3:20; a
--     test store never; a recap is due until it's sent, 15 minutes apart,
--     at most 3 tries;
--   * mog.night_close: refused while close_direct is off; a cycle with
--     orders owes its recap unless the Daily summary already went out;
--     nothing ordered owes none; a second close is CYCLE_MOVED; each close
--     leaves a night_log row;
--   * the recap claim and outcome: one claim per 15 minutes, the active
--     recipients in order, the log in order; sent sets the flag; the flag
--     set by Apps Script settles it; 3 failed tries give up;
--   * Apps Script's two calls (mog_sync_night, mog_sync_set_recap_sent)
--     and the trigger's retirement stamp;
--   * nothing internal is open to anon.
-- Cleans up after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke23 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke23;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke23 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

create or replace function pg_temp.clean23()
returns void language sql as $$
  delete from mog.stores where slug in ('zztest23', 'zztest23t');
$$;

create or replace function pg_temp.store23(p_slug text)
returns text language plpgsql as $$
declare
  k text;
begin
  k := mog.provision_store(p_slug);
  perform public.mog_sync_set_pins(p_slug, k, '4321', null);
  perform mog.replace_catalog_tables(p_slug, jsonb_build_object(
    'profile', jsonb_build_object('timeZone', 'America/New_York', 'location', 'ZZ Smoke 23', 'abbr', 'ZZ23', 'concept', 'roll-play'),
    'vendors', '[{"name": "Alpha Foods", "mults": [1,1,1,1,1,1,1], "cutoff": null},
                 {"name": "Beta Supply", "mults": [1,1,1,1,1,1,1], "cutoff": null}]'::jsonb,
    'areas', '[{"name": "Freezer", "ord": 10}]'::jsonb, 'items', '[]'::jsonb, 'pickRows', '[]'::jsonb));
  perform public.mog_sync_switch_editor(p_slug, k, false);
  insert into mog.store_state (slug, cycle_date, day_of_week) values (p_slug, date '2026-11-11', 'Wed')
  on conflict (slug) do update set cycle_date = excluded.cycle_date;
  update mog.stores set location = 'ZZ Smoke 23', concept = 'roll-play' where slug = p_slug;
  return k;
end;
$$;

-- Is (slug, step) in night_due at this moment?
create or replace function pg_temp.due23(p_slug text, p_step text, p_at timestamptz)
returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(mog.night_due(p_at)) e
                  where e ->> 'slug' = p_slug and e ->> 'step' = p_step);
$$;

create or replace function pg_temp.cycle23(p_slug text, p_cycle date)
returns void language sql as $$
  update mog.store_state set cycle_date = p_cycle, recap_due = null, recap_tries = 0, recap_next_at = null,
         recap_sent_for = null where slug = p_slug;
  delete from mog.night_log where slug = p_slug;
$$;

-- What a close sends: two lines, one with nothing to order (left out of the log).
create or replace function pg_temp.rows23()
returns jsonb language sql as $$
  select '[{"vendor": "Alpha Foods", "id": "ITEM-0001", "name": "Shrimp", "pack": "CASE", "area": "Freezer", "onHandPrev": 1, "qty": 3},
           {"vendor": "Alpha Foods", "id": "ITEM-0002", "name": "Lids", "pack": "", "area": "", "onHandPrev": 0, "qty": 0},
           {"vendor": "Beta Supply", "id": "ITEM-0003", "name": "Tea <Jasmine>", "pack": "BAG", "area": "Freezer", "onHandPrev": 2.5, "qty": 1}]'::jsonb;
$$;

do $$
declare
  k   text;
  kt  text;
  r   jsonb;
  c   jsonb;
  st  mog.store_state%rowtype;
  -- New York: 11-12 03:35 EST = 08:35 UTC; summer 07-02 03:35 EDT = 07:35 UTC.
  w_0235 timestamptz := timestamptz '2026-11-12 07:35:00+00';
  w_0305 timestamptz := timestamptz '2026-11-12 08:05:00+00';
  w_0325 timestamptz := timestamptz '2026-11-12 08:25:00+00';
  w_0335 timestamptz := timestamptz '2026-11-12 08:35:00+00';
  s_0335 timestamptz := timestamptz '2026-07-02 07:35:00+00';
  s_0325 timestamptz := timestamptz '2026-07-02 07:25:00+00';
begin
  perform pg_temp.clean23();
  k  := pg_temp.store23('zztest23');
  kt := pg_temp.store23('zztest23t');
  update mog.stores set is_test = true where slug = 'zztest23t';
  insert into mog.recipients (slug, pos, name, email, active, gm) values
    ('zztest23', 1, 'GM', 'gm@zz23.example', true, true),
    ('zztest23', 2, 'Off', 'off@zz23.example', false, false),
    ('zztest23', 3, 'KM', 'km@zz23.example', true, false);

  -- ---- The public close, now a key check in front of mog.close_cycle ----
  r := public.mog_sync_close_cycle('zztest23', 'not-the-key', date '2026-11-11', date '2026-11-12', 'Thu', pg_temp.rows23(), '[]'::jsonb);
  perform pg_temp.chk('mog_sync_close_cycle: a bad key is refused', r ->> 'error' = 'BAD_SYNC_KEY', r);
  r := public.mog_sync_close_cycle('zztest23', k, date '2026-11-11', date '2026-11-12', 'Thu', pg_temp.rows23(), '[]'::jsonb);
  perform pg_temp.chk('mog_sync_close_cycle: closes as before (2 of 3 rows logged, seq 1 and 3, new cycle)',
    (r -> 'data' ->> 'closed')::boolean and (r -> 'data' ->> 'logged')::int = 2
      and (select array_agg(seq order by seq) from mog.order_log where slug = 'zztest23' and cycle_date = '2026-11-11') = array[1, 3]
      and (select cycle_date from mog.store_state where slug = 'zztest23') = date '2026-11-12', r);
  r := public.mog_sync_close_cycle('zztest23', k, date '2026-11-11', date '2026-11-12', 'Thu', pg_temp.rows23(), '[]'::jsonb);
  perform pg_temp.chk('mog_sync_close_cycle: a second close is CYCLE_MOVED', r -> 'data' ->> 'reason' = 'CYCLE_MOVED', r);
  perform pg_temp.chk('mog_sync_close_cycle: Apps Script''s close owes Supabase no recap',
    (select recap_due is null from mog.store_state where slug = 'zztest23')
      and not exists (select 1 from mog.night_log where slug = 'zztest23'), null);
  delete from mog.order_log where slug = 'zztest23';

  -- ---- When a close is due ----
  perform pg_temp.cycle23('zztest23', date '2026-11-11');
  perform pg_temp.chk('due: close_direct off, nothing to close at 3:35 AM', not pg_temp.due23('zztest23', 'close', w_0335), null);
  update mog.stores set close_direct = true where slug in ('zztest23', 'zztest23t');
  perform pg_temp.chk('due: close_direct on, not at 2:35 AM (winter)', not pg_temp.due23('zztest23', 'close', w_0235), null);
  perform pg_temp.chk('due: close_direct on, not at 3:25 AM (winter)', not pg_temp.due23('zztest23', 'close', w_0325), null);
  perform pg_temp.chk('due: close_direct on, at 3:35 AM (winter, 08:35 UTC)', pg_temp.due23('zztest23', 'close', w_0335), null);
  perform pg_temp.chk('due: a test store with close_direct on closes too', pg_temp.due23('zztest23t', 'close', w_0335), null);
  perform pg_temp.cycle23('zztest23', date '2026-07-01');
  perform pg_temp.chk('due: summer time, at 3:35 AM (07:35 UTC) and not at 3:25',
    pg_temp.due23('zztest23', 'close', s_0335) and not pg_temp.due23('zztest23', 'close', s_0325), null);
  perform pg_temp.cycle23('zztest23', date '2026-11-12');
  perform pg_temp.chk('due: a cycle that is already today''s is not closed', not pg_temp.due23('zztest23', 'close', w_0335), null);
  r := mog.night_plan('zztest23', 'close', w_0335);
  perform pg_temp.chk('plan: not due answers { due: false }', r = '{"due": false}'::jsonb, r);
  perform pg_temp.cycle23('zztest23', date '2026-11-11');
  r := mog.night_plan('zztest23', 'close', w_0335);
  perform pg_temp.chk('plan: due answers the sync snapshot (its cycle, catalog and counts)',
    (r ->> 'due')::boolean and r -> 'snapshot' -> 'state' ->> 'cycleDate' = '2026-11-11'
      and r -> 'snapshot' -> 'catalog' ->> 'location' is not null and jsonb_typeof(r -> 'snapshot' -> 'counts') = 'array', r);
  perform pg_temp.chk('due: no shadow for a store Supabase closes', not pg_temp.due23('zztest23', 'shadow', w_0305), null);

  -- ---- Shadows: the stores Apps Script still closes ----
  update mog.stores set close_direct = false where slug in ('zztest23', 'zztest23t');
  perform pg_temp.cycle23('zztest23t', date '2026-11-11');
  perform pg_temp.chk('shadow: due at 3:05 AM, not at 3:25 or 2:35',
    pg_temp.due23('zztest23', 'shadow', w_0305) and not pg_temp.due23('zztest23', 'shadow', w_0325)
      and not pg_temp.due23('zztest23', 'shadow', w_0235), null);
  perform pg_temp.chk('shadow: never for a test store', not pg_temp.due23('zztest23t', 'shadow', w_0305), null);
  perform mog.night_shadow_done('zztest23', date '2026-11-11', pg_temp.rows23(), 12);
  perform pg_temp.chk('shadow: kept once, with its rows as worked out, then not due again',
    (select count(*) from mog.night_log where slug = 'zztest23' and step = 'shadow' and cycle_date = '2026-11-11') = 1
      and (select jsonb_array_length(detail -> 'rows') from mog.night_log where slug = 'zztest23' and step = 'shadow') = 3
      and not pg_temp.due23('zztest23', 'shadow', w_0305), null);
  perform pg_temp.chk('shadow: nothing else written (cycle, log)',
    (select cycle_date from mog.store_state where slug = 'zztest23') = date '2026-11-11'
      and not exists (select 1 from mog.order_log where slug = 'zztest23'), null);

  -- ---- Supabase's close ----
  perform pg_temp.cycle23('zztest23', date '2026-11-11');
  r := mog.night_close('zztest23', date '2026-11-11', date '2026-11-12', 'Thu', pg_temp.rows23(), w_0335, 40);
  perform pg_temp.chk('night_close: refused while close_direct is off, nothing changed, the refusal logged',
    r ->> 'error' = 'NOT_CLOSE_DIRECT' and (select cycle_date from mog.store_state where slug = 'zztest23') = date '2026-11-11'
      and (select not ok and detail ->> 'error' = 'NOT_CLOSE_DIRECT' from mog.night_log where slug = 'zztest23' and step = 'close'), r);
  update mog.stores set close_direct = true where slug = 'zztest23';
  perform pg_temp.cycle23('zztest23', date '2026-11-11');
  r := mog.night_close('zztest23', date '2026-11-11', date '2026-11-12', 'Thu', pg_temp.rows23(), w_0335, 40);
  select * into st from mog.store_state where slug = 'zztest23';
  perform pg_temp.chk('night_close: closes (2 rows, logged at the run''s time), the new cycle, its recap owed',
    (r -> 'data' ->> 'logged')::int = 2 and (r ->> 'recapDue')::boolean and st.cycle_date = date '2026-11-12'
      and st.day_of_week = 'Thu' and st.recap_due = date '2026-11-11' and st.recap_tries = 0
      and (select bool_and(logged_at = w_0335) from mog.order_log where slug = 'zztest23'), r);
  perform pg_temp.chk('night_close: one close row in night_log (logged 2, recap due, its ms)',
    (select count(*) = 1 and bool_and(ok and (detail ->> 'logged')::int = 2 and detail ->> 'recap' = 'due' and (detail ->> 'ms')::int = 40)
       from mog.night_log where slug = 'zztest23' and step = 'close'), null);
  r := mog.night_close('zztest23', date '2026-11-11', date '2026-11-12', 'Thu', pg_temp.rows23(), w_0335, 40);
  perform pg_temp.chk('night_close: a second close is CYCLE_MOVED and owes nothing new',
    r -> 'data' ->> 'reason' = 'CYCLE_MOVED' and not (r ->> 'recapDue')::boolean
      and (select count(*) from mog.order_log where slug = 'zztest23') = 2, r);
  perform pg_temp.chk('due: the recap is due now; the close isn''t',
    pg_temp.due23('zztest23', 'recap', w_0335) and not pg_temp.due23('zztest23', 'close', w_0335), null);

  -- ---- The recap ----
  c := mog.night_recap_claim('zztest23', w_0335);
  perform pg_temp.chk('claim: the cycle, try 1, the store''s name and concept',
    (c ->> 'due')::boolean and c ->> 'cycle' = '2026-11-11' and (c ->> 'attempt')::int = 1
      and c ->> 'location' = 'ZZ Smoke 23' and c ->> 'concept' = 'roll-play', c);
  perform pg_temp.chk('claim: the active recipients, in order (the inactive one left out)',
    c -> 'recipients' = '[{"name": "GM", "email": "gm@zz23.example"}, {"name": "KM", "email": "km@zz23.example"}]'::jsonb, c -> 'recipients');
  perform pg_temp.chk('claim: the log in order, as mog_sync_get_log gives it',
    c -> 'rows' = (public.mog_sync_get_log('zztest23', k, date '2026-11-11') -> 'data' -> 'rows'), c -> 'rows');
  r := mog.night_recap_claim('zztest23', w_0335 + interval '1 minute');
  perform pg_temp.chk('claim: a second run within 15 minutes gets nothing (no second send)',
    r ->> 'reason' = 'next try later' and not pg_temp.due23('zztest23', 'recap', w_0335 + interval '1 minute'), r);
  r := mog.night_recap_done('zztest23', date '2026-11-11', 0, 2, '{"attempt": 1}'::jsonb);
  perform pg_temp.chk('done: every send failed: try again, the flag unset', r ->> 'state' = 'try again'
    and (select recap_sent_for is null and recap_due = date '2026-11-11' from mog.store_state where slug = 'zztest23'), r);
  c := mog.night_recap_claim('zztest23', w_0335 + interval '16 minutes');
  r := mog.night_recap_done('zztest23', date '2026-11-11', 1, 1, '{"attempt": 2}'::jsonb);
  select * into st from mog.store_state where slug = 'zztest23';
  perform pg_temp.chk('done: one reached sets the flag and settles it (try 2)',
    (c ->> 'attempt')::int = 2 and r ->> 'state' = 'sent' and st.recap_sent_for = date '2026-11-11' and st.recap_due is null
      and not pg_temp.due23('zztest23', 'recap', w_0335 + interval '1 hour'), r);
  perform pg_temp.chk('done: each try left a recap row (try again, then sent)',
    (select array_agg(detail ->> 'state' order by id) from mog.night_log where slug = 'zztest23' and step = 'recap') = array['try again', 'sent'], null);

  -- The Daily summary went out first (Apps Script marks the flag): the close owes nothing.
  r := public.mog_sync_set_recap_sent('zztest23', 'not-the-key', date '2026-11-12');
  perform pg_temp.chk('mog_sync_set_recap_sent: a bad key is refused', r ->> 'error' = 'BAD_SYNC_KEY', r);
  r := public.mog_sync_set_recap_sent('zztest23', k, null);
  perform pg_temp.chk('mog_sync_set_recap_sent: a cycle is required', r ->> 'error' = 'a cycle date is required', r);
  r := public.mog_sync_set_recap_sent('zztest23', k, date '2026-11-12');
  r := mog.night_close('zztest23', date '2026-11-12', date '2026-11-13', 'Fri', pg_temp.rows23(), w_0335 + interval '1 day', 40);
  perform pg_temp.chk('night_close: the Daily summary already went out: logged, no recap owed',
    (r -> 'data' ->> 'logged')::int = 2 and not (r ->> 'recapDue')::boolean
      and (select recap_due is null from mog.store_state where slug = 'zztest23')
      and (select detail ->> 'recap' from mog.night_log where slug = 'zztest23' and step = 'close' order by id desc limit 1) = 'already sent', r);

  -- Owed, then Apps Script sends it (a phone's Daily summary of that cycle): settled, nothing claimed.
  perform pg_temp.cycle23('zztest23', date '2026-11-13');
  r := mog.night_close('zztest23', date '2026-11-13', date '2026-11-14', 'Sat', pg_temp.rows23(), w_0335 + interval '2 days', 40);
  r := public.mog_sync_set_recap_sent('zztest23', k, date '2026-11-13');
  c := mog.night_recap_claim('zztest23', w_0335 + interval '2 days');
  perform pg_temp.chk('the flag set by Apps Script settles an owed recap: nothing to claim',
    not (c ->> 'due')::boolean and (select recap_due is null from mog.store_state where slug = 'zztest23'), c);
  -- The claim checks the flag itself too (a send that landed between the close and the claim).
  update mog.store_state set recap_due = date '2026-11-13', recap_tries = 0, recap_next_at = null where slug = 'zztest23';
  c := mog.night_recap_claim('zztest23', w_0335 + interval '2 days');
  perform pg_temp.chk('claim: the flag already names the owed cycle: nothing claimed, settled',
    c ->> 'reason' = 'already sent' and (select recap_due is null and recap_tries = 0 from mog.store_state where slug = 'zztest23'), c);

  -- Nothing ordered: no recap owed.
  perform pg_temp.cycle23('zztest23', date '2026-11-14');
  r := mog.night_close('zztest23', date '2026-11-14', date '2026-11-15', 'Sun', '[]'::jsonb, w_0335 + interval '3 days', 40);
  perform pg_temp.chk('night_close: nothing ordered owes no recap',
    (r -> 'data' ->> 'closed')::boolean and not (r ->> 'recapDue')::boolean
      and (select detail ->> 'recap' from mog.night_log where slug = 'zztest23' and step = 'close') = 'nothing ordered', r);

  -- Three failed tries: given up, no longer due, the cycle still named.
  perform pg_temp.cycle23('zztest23', date '2026-11-15');
  r := mog.night_close('zztest23', date '2026-11-15', date '2026-11-16', 'Mon', pg_temp.rows23(), w_0335 + interval '4 days', 40);
  c := mog.night_recap_claim('zztest23', w_0335 + interval '4 days');
  perform mog.night_recap_done('zztest23', date '2026-11-15', 0, 2, '{}'::jsonb);
  c := mog.night_recap_claim('zztest23', w_0335 + interval '4 days 16 minutes');
  perform mog.night_recap_done('zztest23', date '2026-11-15', 0, 2, '{}'::jsonb);
  c := mog.night_recap_claim('zztest23', w_0335 + interval '4 days 32 minutes');
  r := mog.night_recap_done('zztest23', date '2026-11-15', 0, 2, '{}'::jsonb);
  select * into st from mog.store_state where slug = 'zztest23';
  perform pg_temp.chk('three failed tries: gave up, not due, recap_due still names the cycle',
    (c ->> 'attempt')::int = 3 and r ->> 'state' = 'gave up' and st.recap_tries = 3 and st.recap_due = date '2026-11-15'
      and not pg_temp.due23('zztest23', 'recap', w_0335 + interval '5 days')
      and (mog.night_recap_claim('zztest23', w_0335 + interval '5 days') ->> 'reason') = 'tried 3 times', r);

  -- Nothing to send (no recipients): ends it without the flag.
  perform pg_temp.cycle23('zztest23', date '2026-11-16');
  r := mog.night_close('zztest23', date '2026-11-16', date '2026-11-17', 'Tue', pg_temp.rows23(), w_0335 + interval '5 days', 40);
  c := mog.night_recap_claim('zztest23', w_0335 + interval '5 days');
  r := mog.night_recap_done('zztest23', date '2026-11-16', 0, 0, '{"nothing": true}'::jsonb);
  perform pg_temp.chk('nothing to send: settled, the flag unset, logged ok',
    r ->> 'state' = 'nothing to send' and (select recap_due is null and recap_sent_for is null from mog.store_state where slug = 'zztest23')
      and (select ok from mog.night_log where slug = 'zztest23' and step = 'recap'), r);

  -- ---- Apps Script's mog_sync_night ----
  r := public.mog_sync_night('zztest23', 'not-the-key', false);
  perform pg_temp.chk('mog_sync_night: a bad key is refused', r ->> 'error' = 'BAD_SYNC_KEY', r);
  perform public.mog_sync_set_recap_sent('zztest23', k, date '2026-11-16');
  r := public.mog_sync_night('zztest23', k, false);
  perform pg_temp.chk('mog_sync_night: close_direct and the flag, no stamp yet',
    (r -> 'data' ->> 'closeDirect')::boolean and r -> 'data' ->> 'recapSentFor' = '2026-11-16'
      and r -> 'data' -> 'sheetTriggerOffAt' = 'null'::jsonb, r);
  r := public.mog_sync_night('zztest23', k, true);
  perform pg_temp.chk('mog_sync_night: the trigger''s retirement is stamped while close_direct is on',
    (select sheet_trigger_off_at is not null from mog.stores where slug = 'zztest23'), r);
  update mog.stores set close_direct = false, sheet_trigger_off_at = null where slug = 'zztest23';
  r := public.mog_sync_night('zztest23', k, true);
  perform pg_temp.chk('mog_sync_night: no stamp while close_direct is off',
    not (r -> 'data' ->> 'closeDirect')::boolean and (select sheet_trigger_off_at is null from mog.stores where slug = 'zztest23'), r);

  -- ---- The test email's data, and the log's own rule ----
  r := mog.night_test_data('nosuchstore', date '2026-11-11');
  perform pg_temp.chk('test data: an unknown store is refused', r ->> 'error' = 'UNKNOWN_STORE', r);
  r := mog.night_test_data('zztest23', date '2026-11-11');
  perform pg_temp.chk('test data: the store''s name, concept and that cycle''s log',
    r ->> 'location' = 'ZZ Smoke 23' and jsonb_array_length(r -> 'rows') = 2, r);
  perform mog.night_note('nosuchstore', 'test', null, true, '{}'::jsonb);
  perform pg_temp.chk('night_note: an unknown store writes nothing', not exists (select 1 from mog.night_log where slug = 'nosuchstore'), null);

  -- ---- Privileges ----
  perform pg_temp.chk('anon: mog.night_close, night_plan and night_recap_claim are closed; the two sync calls open',
    not has_function_privilege('anon', 'mog.night_close(text, date, date, text, jsonb, timestamptz, integer)', 'execute')
      and not has_function_privilege('anon', 'mog.night_plan(text, text, timestamptz)', 'execute')
      and not has_function_privilege('anon', 'mog.night_recap_claim(text, timestamptz)', 'execute')
      and not has_function_privilege('anon', 'mog.close_cycle(text, date, date, text, jsonb, jsonb, timestamptz)', 'execute')
      and has_function_privilege('anon', 'public.mog_sync_night(text, text, boolean)', 'execute')
      and has_function_privilege('anon', 'public.mog_sync_set_recap_sent(text, text, date)', 'execute'), null);
  perform pg_temp.chk('anon: mog.night_log is closed', not has_table_privilege('anon', 'mog.night_log', 'select'), null);

  perform pg_temp.clean23();
  perform pg_temp.chk('cleanup: nothing of the smoke is left',
    not exists (select 1 from mog.stores where slug in ('zztest23', 'zztest23t'))
      and not exists (select 1 from mog.night_log where slug in ('zztest23', 'zztest23t'))
      and not exists (select 1 from mog.order_log where slug in ('zztest23', 'zztest23t')), null);
end;
$$;

select n, case when ok then 'PASS' else 'FAIL' end as result, check_name, detail from mog_smoke23 order by n;
