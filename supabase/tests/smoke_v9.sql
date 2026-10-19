-- =====================================================================
-- MOG schema v9 — smoke test (run in the SQL Editor AFTER schema_v9.sql)
-- =====================================================================
-- Throwaway store 'zztest9': the order log read once the editor moves
-- (refused before, log order, the date filter, times in the store's zone),
-- the Sheet's log copied in only for dates the log lacks; recipients (the
-- one seed, refused once seeded, the save's rules with the GM row locked and
-- with it editable); People (rename, a device's old name followed, remove, a
-- removed name not added back by a device, joined back from the picker, two
-- names merged); the Health status and clearing the PIN lockout. Cleans up
-- after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke9 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke9;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke9 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  k     text;
  tok   text;
  r     jsonb;
  rows_ jsonb;
  dev   text := 'smokeDevice9000';
  tabs  jsonb := '{
    "profile": {"timeZone": "America/New_York", "location": "Smoke v9", "abbr": "ZZ9", "concept": "teasnyou"},
    "vendors": [{"name": "Sysco", "mults": [1,1,1,1,1,1,1], "cutoff": null}],
    "areas":   [{"name": "Walk-in", "ord": 10}],
    "items":   [{"id": "ITEM-0001", "name": "Lime", "primaryVendor": "Sysco", "pack": "CS", "par": 3, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Sysco"], "seq": 2}],
    "pickRows": [{"vendor": "Sysco", "id": "ITEM-0001", "area": "Walk-in", "shelfOrder": 10, "seq": 2}]}';
  gm_list jsonb := '[{"name": "GM", "email": "gm@example.com", "active": true, "gm": true},
                     {"name": "Ana", "email": "ana@example.com", "active": true, "gm": false}]';
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key can call the new entry points',
    has_function_privilege('anon', 'public.mog_history(text, date, date)', 'execute')
    and has_function_privilege('anon', 'public.mog_recipients_save(text, jsonb, boolean)', 'execute')
    and has_function_privilege('anon', 'public.mog_people_rename(text, text, text)', 'execute')
    and has_function_privilege('anon', 'public.mog_editor_status(text)', 'execute'), null);
  perform pg_temp.chk('privileges: the public key cannot call the internals',
    not has_function_privilege('anon', 'mog.recipients_check(text, jsonb, boolean)', 'execute')
    and not has_function_privilege('anon', 'mog.person_now(text, text)', 'execute'), null);
  perform pg_temp.chk('privileges: the recipients table is not readable by the public key',
    not has_table_privilege('anon', 'mog.recipients', 'select'), null);

  delete from mog.stores where slug = 'zztest9';
  k := mog.provision_store('zztest9');
  perform public.mog_sync_set_pins('zztest9', k, '4321', null);
  perform mog.replace_catalog_tables('zztest9', tabs);
  perform public.mog_sync_push_catalog('zztest9', k, 1, mog.catalog_from_tables('zztest9'));
  perform public.mog_sync_set_state('zztest9', k, '2026-10-19', 'Mon', false, '{}', '[]', true);
  perform public.mog_sync_set_phone_direct('zztest9', k, true);
  tok := public.mog_login('zztest9', '4321') -> 'data' ->> 'token';

  -- ---- History: refused until the editor moves ----
  r := public.mog_history(tok, null, null);
  perform pg_temp.chk('history: refused while the editor is in the Sheet', r ->> 'error' = 'EDITOR_NOT_DIRECT', r);

  perform public.mog_sync_close_cycle('zztest9', k, '2026-10-19', '2026-10-20', 'Tue',
    '[{"vendor": "Sysco", "id": "ITEM-0001", "name": "Lime", "pack": "CS", "area": "Walk-in", "onHandPrev": 1, "qty": 2}]',
    '[]', '2026-10-20 07:30:00+00');

  -- ---- The Sheet's log copied in ----
  r := public.mog_sync_backfill_log('zztest9', 'not-the-key', '[]');
  perform pg_temp.chk('backfill: a wrong sync key is refused', r ->> 'error' = 'BAD_SYNC_KEY', r);
  rows_ := '[{"date": "2026-10-17", "at": "2026-10-18T07:30:00Z", "vendor": "Sysco", "id": "ITEM-0001", "name": "Lime", "pack": "CS", "onHandPrev": 0, "qty": 3},
             {"date": "2026-10-17", "at": "2026-10-18T07:30:00Z", "vendor": "Sysco", "id": "ITEM-0002", "name": "Tape", "pack": "", "onHandPrev": "", "qty": 1},
             {"date": "2026-10-18", "at": null, "vendor": "Amazon", "id": "ITEM-0003", "name": "Cups", "pack": "", "onHandPrev": 2, "qty": 1},
             {"date": "2026-10-19", "at": "2026-10-20T07:30:00Z", "vendor": "Sysco", "id": "ITEM-0001", "name": "Lime", "pack": "CS", "onHandPrev": 1, "qty": 2},
             {"date": "junk", "vendor": "Sysco", "id": "X", "name": "X", "qty": 1},
             {"date": "2026-10-16", "vendor": "", "id": "Y", "name": "", "qty": 1}]';
  r := public.mog_sync_backfill_log('zztest9', k, rows_);
  perform pg_temp.chk('backfill: two older dates copied, the date the log has skipped, junk and blank rows left out',
    (r -> 'data' ->> 'inserted')::int = 3 and (r -> 'data' ->> 'dates')::int = 2
    and (r -> 'data' ->> 'skippedDates')::int = 1, r);
  r := public.mog_sync_backfill_log('zztest9', k, rows_);
  perform pg_temp.chk('backfill: a second run adds nothing',
    (r -> 'data' ->> 'inserted')::int = 0 and (r -> 'data' ->> 'skippedDates')::int = 3, r);
  perform pg_temp.chk('backfill: rows numbered in order within their date',
    (select array_agg(seq order by seq) from mog.order_log where slug = 'zztest9' and cycle_date = '2026-10-17') = array[1, 2], null);

  perform public.mog_sync_switch_editor('zztest9', k, false);
  r := public.mog_history(tok, null, null);
  perform pg_temp.chk('history: every row once the editor moved, in log order',
    jsonb_array_length(r -> 'data' -> 'rows') = 4
    and (select array_agg(e ->> 'date' order by o) from jsonb_array_elements(r -> 'data' -> 'rows') with ordinality t(e, o))
        = array['2026-10-17', '2026-10-17', '2026-10-18', '2026-10-19']
    and r -> 'data' -> 'rows' -> 1 ->> 'id' = 'ITEM-0002', r);
  perform pg_temp.chk('history: the close time in the store''s zone, the abbreviation, every vendor',
    r -> 'data' -> 'rows' -> 3 ->> 'at' = '2026-10-20 03:30'
    and r -> 'data' -> 'rows' -> 2 ->> 'at' = '2026-10-18 00:00'
    and r -> 'data' ->> 'abbr' = 'ZZ9'
    and (select array_agg(x order by x) from jsonb_array_elements_text(r -> 'data' -> 'vendors') x) = array['Amazon', 'Sysco'], r);
  r := public.mog_history(tok, '2026-10-18', '2026-10-19');
  perform pg_temp.chk('history: the date filter is inclusive', jsonb_array_length(r -> 'data' -> 'rows') = 2, r);
  r := public.mog_history('bogus', null, null);
  perform pg_temp.chk('history: a bad token is refused', r ->> 'error' = 'SESSION_EXPIRED', r);

  -- ---- Recipients ----
  r := public.mog_sync_seed_recipients('zztest9', k,
    '[{"name": " GM ", "email": "gm@example.com", "active": true, "gm": true},
      {"name": "Ana", "email": "ana@example.com", "active": true, "gm": false},
      {"name": "Ana again", "email": "ANA@example.com", "active": false, "gm": false},
      {"name": "", "email": "", "active": true, "gm": false}]');
  perform pg_temp.chk('recipients: seeded once, trimmed, a repeated email kept once',
    (r -> 'data' ->> 'count')::int = 2 and mog.recipients_json('zztest9') -> 0 ->> 'name' = 'GM', r);
  r := public.mog_sync_seed_recipients('zztest9', k, '[]');
  perform pg_temp.chk('recipients: a second seed is refused and changes nothing',
    (r -> 'data' ->> 'already')::boolean and jsonb_array_length(mog.recipients_json('zztest9')) = 2, r);
  r := public.mog_recipients_get(tok);
  perform pg_temp.chk('recipients: get', jsonb_array_length(r -> 'data' -> 'recipients') = 2, r);

  r := public.mog_recipients_save(tok, '[{"name": "Ana", "email": "ana@example.com", "active": true}]', false);
  perform pg_temp.chk('recipients: removing the GM row is refused on a phone', r ->> 'error' like 'Cannot remove GM recipient "GM"%', r);
  r := public.mog_recipients_save(tok, '[{"name": "Boss", "email": "gm@example.com", "active": true, "gm": true}]', false);
  perform pg_temp.chk('recipients: renaming the GM row is refused on a phone', r ->> 'error' like 'Cannot modify GM recipient%', r);
  r := public.mog_recipients_save(tok, gm_list || '[{"name": "Bo", "email": "bo@example", "active": true}]', false);
  perform pg_temp.chk('recipients: a bad email is refused', r ->> 'error' = 'Recipient "Bo" has an invalid email: bo@example', r);
  r := public.mog_recipients_save(tok, gm_list || '[{"name": "Bo", "email": "Ana@Example.com", "active": true}]', false);
  perform pg_temp.chk('recipients: a repeated email is refused', r ->> 'error' = 'Duplicate email: Ana@Example.com', r);
  r := public.mog_recipients_save(tok, gm_list || '[{"name": "", "email": "x@y.z", "active": true}]', false);
  perform pg_temp.chk('recipients: a missing name is refused', r ->> 'error' = 'Recipient is missing a name.', r);
  r := public.mog_recipients_save(tok, gm_list || '[{"name": "Cy", "email": "cy@example.com", "active": true, "gm": true}, {"name": " ", "email": ""}]', false);
  perform pg_temp.chk('recipients: a good save keeps the GM, makes no new GM, drops a blank row',
    jsonb_array_length(r -> 'data' -> 'recipients') = 3
    and (mog.recipients_json('zztest9') -> 2 ->> 'gm')::boolean = false
    and (mog.recipients_json('zztest9') -> 0 ->> 'gm')::boolean = true, r);
  r := public.mog_recipients_save(tok, '[{"name": "New GM", "email": "new@example.com", "active": true, "gm": true}]', true);
  perform pg_temp.chk('recipients: on a computer the GM row can change',
    jsonb_array_length(mog.recipients_json('zztest9')) = 1 and (mog.recipients_json('zztest9') -> 0 ->> 'gm')::boolean, r);
  r := public.mog_sync_get_recipients('zztest9', k);
  perform pg_temp.chk('recipients: the nightly email reads the same list',
    r -> 'data' -> 'recipients' -> 0 ->> 'email' = 'new@example.com' and (r -> 'data' ->> 'seeded')::boolean, r);

  -- ---- People ----
  perform public.mog_snapshot2(tok, null, dev, 'Maria', null);
  perform public.mog_snapshot2(tok, null, 'otherDevice9000', 'Luis', null);
  r := public.mog_people_list(tok);
  perform pg_temp.chk('people: names a device used are listed',
    (select array_agg(e ->> 'name' order by e ->> 'name') from jsonb_array_elements(r -> 'data' -> 'people') e) = array['Luis', 'Maria'], r);
  r := public.mog_people_rename(tok, 'Maria', 'Maria G.');
  perform pg_temp.chk('people: rename', r -> 'data' ->> 'name' = 'Maria G.'
    and not exists (select 1 from jsonb_array_elements(r -> 'data' -> 'people') e where e ->> 'name' = 'Maria'), r);
  r := public.mog_snapshot2(tok, null, dev, 'Maria', null);
  perform pg_temp.chk('people: a device still on the old name is told the new one, and nothing re-adds the old',
    r -> 'data' ->> 'nameNow' = 'Maria G.' and not (r -> 'data' ->> 'nameGone')::boolean
    and not (r -> 'data' -> 'people') ? 'Maria'
    and (select name from mog.presence where slug = 'zztest9' and device_id = dev) = 'Maria G.', r);
  r := public.mog_people_rename(tok, 'Maria G.', 'x' || repeat('y', 40));
  perform pg_temp.chk('people: a name over 40 characters is refused', r ->> 'error' like 'A name is 1 to 40%', r);
  r := public.mog_people_rename(tok, 'Nobody', 'Someone');
  perform pg_temp.chk('people: renaming a name not listed is refused', r ->> 'error' = 'NOT_FOUND', r);
  r := public.mog_people_rename(tok, 'Luis', 'maria g.');
  perform pg_temp.chk('people: renaming onto a listed name merges the two',
    jsonb_array_length(r -> 'data' -> 'people') = 1 and r -> 'data' ->> 'name' = 'Maria G.', r);
  r := public.mog_people_remove(tok, 'Maria G.');
  perform pg_temp.chk('people: remove', jsonb_array_length(r -> 'data' -> 'people') = 0, r);
  r := public.mog_snapshot2(tok, null, dev, 'Maria G.', null);
  perform pg_temp.chk('people: a device holding a removed name is told so, and does not add it back',
    (r -> 'data' ->> 'nameGone')::boolean and jsonb_array_length(r -> 'data' -> 'people') = 0
    and (select name from mog.presence where slug = 'zztest9' and device_id = dev) is null, r);
  r := public.mog_snapshot2(tok, null, dev, 'Luis', null);
  perform pg_temp.chk('people: a name merged then removed is gone too', (r -> 'data' ->> 'nameGone')::boolean, r);
  r := public.mog_people_join(tok, 'maria g.');
  perform pg_temp.chk('people: picking a removed name brings it back (its spelling)',
    r -> 'data' ->> 'name' = 'Maria G.' and jsonb_array_length(public.mog_people_list(tok) -> 'data' -> 'people') = 1, r);
  r := public.mog_people_join(tok, 'Luis');
  perform pg_temp.chk('people: a name removed along with the one it was merged into comes back as itself',
    r -> 'data' ->> 'name' = 'Luis', r);
  perform public.mog_people_rename(tok, 'Maria G.', 'Mia');
  r := public.mog_people_join(tok, 'maria g.');
  perform pg_temp.chk('people: picking an old name gives the one it was renamed to', r -> 'data' ->> 'name' = 'Mia', r);

  -- ---- Health ----
  r := public.mog_editor_status(tok);
  perform pg_temp.chk('status: phones, the cycle, the zone, the last order',
    (r -> 'data' ->> 'phoneDirect')::boolean and r -> 'data' ->> 'cycleDate' = '2026-10-20'
    and r -> 'data' ->> 'timeZone' = 'America/New_York' and r -> 'data' ->> 'lastOrderDate' = '2026-10-19'
    and (r -> 'data' ->> 'lockedForMs')::bigint = 0, r);
  update mog.stores set fail_count = 5, locked_until = now() + interval '5 minutes' where slug = 'zztest9';
  perform pg_temp.chk('status: a lockout shows', (public.mog_editor_status(tok) -> 'data' ->> 'lockedForMs')::bigint > 0, null);
  r := public.mog_editor_clear_lockout(tok);
  perform pg_temp.chk('status: the lockout clears',
    (public.mog_editor_status(tok) -> 'data' ->> 'lockedForMs')::bigint = 0
    and (select fail_count from mog.stores where slug = 'zztest9') = 0, r);

  -- ---- People on a store whose phones are on /exec ----
  perform public.mog_sync_set_phone_direct('zztest9', k, false);
  r := public.mog_people_list(tok);
  perform pg_temp.chk('people: refused while the phones use /exec', r ->> 'error' = 'USE_EXEC', r);

  delete from mog.stores where slug = 'zztest9';
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke9 order by n;
