-- =====================================================================
-- MOG schema v12 — smoke test (run in the SQL Editor AFTER schema_v12.sql)
-- =====================================================================
-- Throwaway stores 'zztest12a' and 'zztest12b', the HQ user 'zz smoke 12'
-- and the library 'zz-smoke12' BOH (no real concept, so no real library is
-- touched): a store's side from its location (now and for a new store), a
-- library saved whole (cleaned, versioned, logged with the list before),
-- a stale save refused, bad lists refused writing nothing, an LTO and its
-- library in one save, all or none across stores and libraries, the v11
-- call still answering, and a library never reaching a store's tables or
-- phones. Cleans up after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke12 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke12;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke12 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  ka   text;
  kb   text;
  code text;
  r    jsonb;
  tok  text;
  lib  jsonb;
  v    bigint;
  n    integer;
  me   text := 'zz smoke 12';
  pass text := 'correct horse battery';
  c    text := 'zz-smoke12';
  tabs jsonb := '{
    "profile": {"timeZone": "America/New_York", "location": "Smoke v12 BOH", "abbr": "ZZ12", "concept": "roll-play"},
    "vendors": [{"name": "Sysco", "mults": [1,1,1,1,1,0,0], "cutoff": "10:00"},
                {"name": "B&T Distributions", "mults": [0,0,1,0,0,0,0], "cutoff": null}],
    "areas":   [{"name": "Walk-in", "ord": 10}],
    "items":   [{"id": "ITEM-0001", "name": "Lime", "primaryVendor": "Sysco", "pack": "CS", "par": 3, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Sysco"], "seq": 2}],
    "pickRows": [{"vendor": "Sysco", "id": "ITEM-0001", "area": "Walk-in", "shelfOrder": 10, "seq": 2}]}';
  mango jsonb := '{"t": "items", "before": null, "after": {"id": "ITEM-0002", "name": "Mango puree", "primaryVendor": "Sysco",
                   "pack": "CS", "par": null, "active": true, "useMult": true, "notes": "Spring LTO", "sku": "", "category": "",
                   "eligible": ["Sysco"], "seq": 3}}';
  stale jsonb := '{"t": "vendors", "before": {"name": "Sysco", "mults": [9,9,9,9,9,9,9], "cutoff": null},
                   "after": {"name": "Sysco", "mults": [1,1,1,1,1,1,1], "cutoff": null}}';
  seed jsonb := '[{"name": "  Lime ", "pack": "CS ", "vendor": " Sysco", "backups": [" B&T ", "sysco", "", "b&t"], "notes": ""},
                  {"name": "Yuzu Mayo", "pack": "", "vendor": "B&T", "backups": [], "notes": "LTO from spring"}]';
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key can call HQ''s read and both saves',
    has_function_privilege('anon', 'public.mog_hq_data(text)', 'execute')
      and has_function_privilege('anon', 'public.mog_hq_apply(text, jsonb, jsonb)', 'execute')
      and has_function_privilege('anon', 'public.mog_hq_apply(text, jsonb, jsonb, jsonb)', 'execute'), null);
  perform pg_temp.chk('privileges: the public key cannot reach the library helpers or tables',
    not has_function_privilege('anon', 'mog.library_put(text, jsonb)', 'execute')
      and not has_function_privilege('anon', 'mog.side_from_location(text)', 'execute')
      and not has_table_privilege('anon', 'mog.libraries', 'select')
      and not has_table_privilege('anon', 'mog.library_items', 'select')
      and not has_table_privilege('anon', 'mog.library_log', 'select'), null);

  -- ---- A store's side ----
  perform pg_temp.chk('side: every store whose location says BOH or FOH has that side',
    not exists (select 1 from mog.stores s where mog.side_from_location(s.location) is not null
                                             and s.side is distinct from mog.side_from_location(s.location)),
    (select jsonb_agg(jsonb_build_object(s.slug, s.side)) from mog.stores s));
  perform pg_temp.chk('side: read as a word, in any case',
    mog.side_from_location('Roll Play Rosslyn FOH (TEST)') = 'FOH' and mog.side_from_location('tny boh') = 'BOH'
      and mog.side_from_location('Shrimp BOHEMIA') is null and mog.side_from_location(null) is null, null);

  delete from mog.stores where slug in ('zztest12a', 'zztest12b');
  delete from mog.hq_users where name = me;
  delete from mog.libraries where concept = c;
  delete from mog.library_log where concept = c;
  ka := mog.provision_store('zztest12a');
  kb := mog.provision_store('zztest12b');
  perform mog.replace_catalog_tables('zztest12a', tabs);
  perform mog.replace_catalog_tables('zztest12b', jsonb_set(tabs, '{profile,location}', '"Smoke v12"'));
  perform public.mog_sync_switch_editor('zztest12a', ka, false);
  perform public.mog_sync_switch_editor('zztest12b', kb, false);
  perform pg_temp.chk('side: a new store takes it from the location it is given; none when the name has neither',
    (select side = 'BOH' from mog.stores where slug = 'zztest12a') and (select side is null from mog.stores where slug = 'zztest12b'), null);
  update mog.stores set location = 'Smoke v12 FOH' where slug = 'zztest12a';
  update mog.stores set location = 'Smoke v12 FOH' where slug = 'zztest12b';
  perform pg_temp.chk('side: a store keeps the side it has; one without takes it from a new location',
    (select side = 'BOH' from mog.stores where slug = 'zztest12a') and (select side = 'FOH' from mog.stores where slug = 'zztest12b'), null);

  -- ---- Signing in (v11) ----
  code := substring(mog.hq_invite(me) from ': ([0-9A-F]+)');
  tok := public.mog_hq_claim(me, code, pass) -> 'data' ->> 'token';
  r := public.mog_hq_data(tok);
  perform pg_temp.chk('data: each store''s side, and the libraries (none for the test concept yet)',
    (r ->> 'ok')::boolean
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'stores') s where s ->> 'slug' = 'zztest12a' and s ->> 'side' = 'BOH')
      and jsonb_typeof(r -> 'data' -> 'libraries') = 'array'
      and not exists (select 1 from jsonb_array_elements(r -> 'data' -> 'libraries') l where l ->> 'concept' = c), null);

  -- ---- A library saved whole ----
  lib := jsonb_build_object('concept', c, 'side', 'BOH', 'version', 0, 'label', 'Started from Smoke v12 BOH (2 items)',
                            'seededFrom', 'Smoke v12 BOH', 'items', seed);
  r := public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, jsonb_build_array(lib));
  perform pg_temp.chk('save: a new library is version 1, by "HQ · <name>", started from the store named',
    (r ->> 'ok')::boolean and r -> 'data' -> 'libraries' -> 0 ->> 'version' = '1'
      and (select version = 1 and updated_by = 'HQ · ' || me and seeded_from = 'Smoke v12 BOH'
             from mog.libraries where concept = c and side = 'BOH'), r);
  perform pg_temp.chk('save: items cleaned (trimmed; backups without the main vendor, blanks or repeats), in order, no par',
    (select jsonb_agg(jsonb_build_array(ord, name, pack, vendor, backups, notes) order by ord)
       from mog.library_items where concept = c and side = 'BOH')
      = '[[1, "Lime", "CS", "Sysco", ["B&T"], ""], [2, "Yuzu Mayo", "", "B&T", [], "LTO from spring"]]'::jsonb,
    (select jsonb_agg(to_jsonb(i) - 'concept' - 'side') from mog.library_items i where concept = c));
  perform pg_temp.chk('save: logged with its label and the list before (empty)',
    (select count(*) = 1 and min(label) = 'Started from Smoke v12 BOH (2 items)' and min(version) = 1
            and bool_and(items_before = '[]'::jsonb) from mog.library_log where concept = c), null);
  r := public.mog_hq_data(tok);
  perform pg_temp.chk('data: the library with its items',
    exists (select 1 from jsonb_array_elements(r -> 'data' -> 'libraries') l
             where l ->> 'concept' = c and l ->> 'side' = 'BOH' and (l ->> 'version')::int = 1
               and l -> 'items' = '[{"name": "Lime", "pack": "CS", "notes": "", "vendor": "Sysco", "backups": ["B&T"]},
                                     {"name": "Yuzu Mayo", "pack": "", "notes": "LTO from spring", "vendor": "B&T", "backups": []}]'::jsonb), null);

  -- ---- Refused saves write nothing ----
  r := public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, jsonb_build_array(lib));
  perform pg_temp.chk('conflict: a save from an older version is refused, the library as it was',
    r ->> 'error' = 'CONFLICT' and r ->> 'detail' like '%zz-smoke12 BOH library was saved since%'
      and (select version = 1 from mog.libraries where concept = c and side = 'BOH')
      and (select count(*) = 1 from mog.library_log where concept = c), r);
  n := 0;
  foreach lib in array array[
    jsonb_build_object('concept', c, 'side', 'BOH', 'version', 1, 'items', '[{"name": "Lime", "vendor": "Sysco"}, {"name": "LIME ", "vendor": "B&T"}]'::jsonb),
    jsonb_build_object('concept', c, 'side', 'BOH', 'version', 1, 'items', '[{"name": "Lime", "vendor": " "}]'::jsonb),
    jsonb_build_object('concept', c, 'side', 'BOH', 'version', 1, 'items', '[{"name": "", "vendor": "Sysco"}]'::jsonb),
    jsonb_build_object('concept', c, 'side', 'XOH', 'version', 0, 'items', '[]'::jsonb),
    jsonb_build_object('concept', 'Roll Play', 'side', 'BOH', 'version', 0, 'items', '[]'::jsonb),
    jsonb_build_object('concept', c, 'side', 'BOH', 'version', 1, 'items', '{}'::jsonb),
    jsonb_build_object('concept', c, 'side', 'BOH', 'items', '[]'::jsonb)
  ] loop
    r := public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, jsonb_build_array(lib));
    if r ->> 'error' like 'REJECTED: %' then n := n + 1; end if;
  end loop;
  perform pg_temp.chk('refused: a name twice (any case), no main vendor, no name, a bad side or concept, items or version missing',
    n = 7 and (select version = 1 from mog.libraries where concept = c and side = 'BOH')
      and (select count(*) = 2 from mog.library_items where concept = c)
      and not exists (select 1 from mog.libraries where concept = c and side = 'XOH')
      and (select count(*) = 1 from mog.library_log where concept = c), to_jsonb(n));
  r := public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb);
  perform pg_temp.chk('refused: libraries must be a list', r ->> 'error' like 'libraries must be an array%', r);

  -- ---- An edit, and the list kept before it ----
  r := public.mog_hq_apply(tok, '[]'::jsonb, '[]'::jsonb, jsonb_build_array(jsonb_build_object(
         'concept', c, 'side', 'BOH', 'version', 1, 'label', 'Saved the library: 1 changed, 1 removed',
         'items', '[{"name": "Lime", "pack": "CS (4 x 5 LB)", "vendor": "Sysco", "backups": [], "notes": ""}]'::jsonb)));
  perform pg_temp.chk('edit: version 2, seeded store kept, the log holds the version-1 list exactly',
    (r ->> 'ok')::boolean
      and (select version = 2 and seeded_from = 'Smoke v12 BOH' from mog.libraries where concept = c and side = 'BOH')
      and (select items_before from mog.library_log where concept = c and version = 2)
        = '[{"name": "Lime", "pack": "CS", "notes": "", "vendor": "Sysco", "backups": ["B&T"]},
            {"name": "Yuzu Mayo", "pack": "", "notes": "LTO from spring", "vendor": "B&T", "backups": []}]'::jsonb, r);

  -- ---- An LTO and its library in one save ----
  r := public.mog_hq_apply(tok,
         jsonb_build_array(jsonb_build_object('slug', 'zztest12a', 'label', 'HQ "Spring LTO": added 1 item (Mango puree)', 'ops', jsonb_build_array(mango))),
         '[]'::jsonb,
         jsonb_build_array(jsonb_build_object('concept', c, 'side', 'BOH', 'version', 2, 'label', 'LTO "Spring LTO": added 1 item',
           'items', '[{"name": "Lime", "pack": "CS (4 x 5 LB)", "vendor": "Sysco"}, {"name": "Mango puree", "pack": "CS", "vendor": "Sysco"}]'::jsonb)));
  perform pg_temp.chk('lto: the store and the library change in the same save',
    (r ->> 'ok')::boolean and jsonb_array_length(r -> 'data' -> 'changes') = 1 and r -> 'data' -> 'libraries' -> 0 ->> 'version' = '3'
      and exists (select 1 from mog.items where slug = 'zztest12a' and name = 'Mango puree' and par is null)
      and exists (select 1 from mog.library_items where concept = c and name = 'Mango puree'), r);

  -- ---- All or none ----
  r := public.mog_hq_apply(tok,
         jsonb_build_array(jsonb_build_object('slug', 'zztest12b', 'label', 'HQ: stale', 'ops', jsonb_build_array(stale))),
         '[]'::jsonb,
         jsonb_build_array(jsonb_build_object('concept', c, 'side', 'BOH', 'version', 3, 'items', '[{"name": "Lime", "vendor": "Sysco"}]'::jsonb)));
  perform pg_temp.chk('all or none: a store''s CONFLICT leaves the library as it was',
    r ->> 'error' = 'CONFLICT' and r ->> 'detail' like 'zztest12b%'
      and (select version = 3 from mog.libraries where concept = c and side = 'BOH')
      and (select count(*) = 2 from mog.library_items where concept = c), r);
  r := public.mog_hq_apply(tok,
         jsonb_build_array(jsonb_build_object('slug', 'zztest12b', 'label', 'HQ: should not land', 'ops', jsonb_build_array(mango))),
         '[]'::jsonb,
         jsonb_build_array(jsonb_build_object('concept', c, 'side', 'BOH', 'version', 2, 'items', '[]'::jsonb)));
  perform pg_temp.chk('all or none: a library''s CONFLICT writes no store',
    r ->> 'error' = 'CONFLICT' and r ->> 'detail' like '%library was saved since%'
      and not exists (select 1 from mog.items where slug = 'zztest12b' and name = 'Mango puree')
      and not exists (select 1 from mog.change_log where slug = 'zztest12b'), r);

  -- ---- The v11 call, and a library never reaching a store ----
  r := public.mog_hq_apply(tok, '[]'::jsonb, '[{"slug": "zztest12a", "hqName": "B&T", "vendor": "B&T Distributions"}]'::jsonb);
  perform pg_temp.chk('v11 call: still saves, with no library',
    (r ->> 'ok')::boolean and r -> 'data' -> 'libraries' = '[]'::jsonb
      and exists (select 1 from mog.hq_vendor_links where slug = 'zztest12a' and hq_name = 'B&T'), r);
  perform pg_temp.chk('library: never in a store''s tables or its phones'' catalog',
    mog.tables_json('zztest12a')::text not like '%Yuzu%' and mog.tables_json('zztest12b')::text not like '%Yuzu%'
      and (select bool_and(payload::text not like '%Yuzu%') from mog.catalog where slug in ('zztest12a', 'zztest12b')), null);

  -- ---- Clean up ----
  delete from mog.stores where slug in ('zztest12a', 'zztest12b');
  delete from mog.hq_users where name = me;
  delete from mog.libraries where concept = c;
  delete from mog.library_log where concept = c;
  perform pg_temp.chk('cleanup: the test stores, person and library are gone',
    not exists (select 1 from mog.stores where slug like 'zztest12%')
      and not exists (select 1 from mog.hq_users where name = me)
      and not exists (select 1 from mog.library_items where concept = c)
      and not exists (select 1 from mog.library_log where concept = c), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke12 order by n;
