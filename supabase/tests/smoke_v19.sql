-- =====================================================================
-- MOG schema v19 — smoke test (run in the SQL Editor AFTER schema_v19.sql)
-- =====================================================================
-- The throwaway store 'zztest19' (concept 'zz-smoke19'), the HQ person
-- 'zz smoke 19' (warehouse) and warehouse rows named 'zz smoke 19 ...': a
-- product's concept is saved and read back only when set, a concept no
-- store has is refused, a save that leaves it out keeps it, an empty one
-- clears it, and everything v17 saved still saves the same. Cleans up after
-- itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke19 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke19;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke19 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

create or replace function pg_temp.clean19()
returns void language sql as $$
  delete from mog.stores where slug = 'zztest19';
  delete from mog.wh_products where name like 'zz smoke 19 %';
  delete from mog.wh_locations where name like 'zz smoke 19 %';
  delete from mog.hq_users where name = 'zz smoke 19';
$$;

-- The product as the warehouse's state reads it.
create or replace function pg_temp.prod19(p_state jsonb, p_id bigint)
returns jsonb language sql as $$
  select p from jsonb_array_elements(p_state -> 'products') p where (p ->> 'id')::bigint = p_id;
$$;

do $$
declare
  me    text := 'zz smoke 19';
  code  text;
  tok   text;
  k     text;
  r     jsonb;
  bowls bigint;
  ver   bigint;
begin
  perform pg_temp.clean19();
  code := substring(mog.hq_invite(me, '{warehouse}') from ': ([0-9A-F]+)');
  tok := public.mog_hq_claim(me, code, 'correct horse battery') -> 'data' ->> 'token';
  k := mog.provision_store('zztest19');
  perform mog.replace_catalog_tables('zztest19', jsonb_build_object(
    'profile', jsonb_build_object('timeZone', 'America/New_York', 'location', 'Smoke v19 FOH', 'abbr', 'ZZ19', 'concept', 'zz-smoke19'),
    'vendors', '[{"name": "Elpis", "mults": [0,1,0,1,0,0,0], "cutoff": null}]'::jsonb,
    'areas',   '[{"name": "Dry", "ord": 10}]'::jsonb,
    'items',   '[]'::jsonb, 'pickRows', '[]'::jsonb));
  perform pg_temp.chk('setup: the warehouse person signs in and the store is in its concept',
    tok is not null and (select concept from mog.stores where slug = 'zztest19') = 'zz-smoke19', null);

  r := public.mog_wh_save(tok, 'location', '{"name": "zz smoke 19 Elpis", "heldBy": "zz smoke 19 Holder"}');
  perform pg_temp.chk('setup: a location held by a vendor', (r ->> 'ok')::boolean, r -> 'error');

  -- ---- The concept ----
  r := public.mog_wh_save(tok, 'product', '{"name": "zz smoke 19 bowls", "pack": "CASE (300)", "par": 0, "handlingFee": 0, "stores": [], "active": true, "concept": "zz-smoke19"}');
  bowls := (r -> 'data' -> 'done' ->> 'id')::bigint;
  perform pg_temp.chk('save: a product takes its concept, and the state reads it back',
    (r ->> 'ok')::boolean and (select concept from mog.wh_products where id = bowls) = 'zz-smoke19'
      and pg_temp.prod19(r -> 'data', bowls) ->> 'concept' = 'zz-smoke19', r -> 'error');

  r := public.mog_wh_save(tok, 'product', '{"name": "zz smoke 19 lids", "pack": "CASE (300)", "par": 0, "handlingFee": 0, "stores": [], "active": true}');
  perform pg_temp.chk('save: a product with no concept is for every concept, and the state leaves the key out',
    (r ->> 'ok')::boolean and (select concept from mog.wh_products where name = 'zz smoke 19 lids') is null
      and not (pg_temp.prod19(r -> 'data', (r -> 'data' -> 'done' ->> 'id')::bigint) ? 'concept'), r -> 'error');

  r := public.mog_wh_save(tok, 'product', '{"name": "zz smoke 19 cups", "pack": "CASE", "par": 0, "handlingFee": 0, "stores": [], "active": true, "concept": "zz no such concept"}');
  perform pg_temp.chk('save: a concept no store has is refused, and nothing is written',
    r ->> 'error' like 'REJECTED: no store is in the concept zz no such concept%'
      and not exists (select 1 from mog.wh_products where name = 'zz smoke 19 cups'), r);

  ver := (select version from mog.wh_products where id = bowls);
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('id', bowls, 'version', ver, 'name', 'zz smoke 19 bowls', 'pack', 'CASE (300)',
         'par', 0, 'handlingFee', 0, 'stores', '[]'::jsonb, 'active', true));
  perform pg_temp.chk('save: a save that leaves the concept out keeps it',
    (r ->> 'ok')::boolean and (select concept from mog.wh_products where id = bowls) = 'zz-smoke19', r -> 'error');

  ver := (select version from mog.wh_products where id = bowls);
  r := public.mog_wh_save(tok, 'product', jsonb_build_object('id', bowls, 'version', ver, 'name', 'zz smoke 19 bowls', 'pack', 'CASE (300)',
         'par', 0, 'handlingFee', 0, 'stores', '[]'::jsonb, 'active', true, 'concept', ''));
  perform pg_temp.chk('save: an empty concept clears it (every concept again)',
    (r ->> 'ok')::boolean and (select concept from mog.wh_products where id = bowls) is null, r -> 'error');

  r := public.mog_wh_save(tok, 'product', jsonb_build_object('id', bowls, 'version', ver, 'name', 'zz smoke 19 bowls', 'pack', 'CASE (300)',
         'par', 0, 'handlingFee', 0, 'stores', '[]'::jsonb, 'active', true, 'concept', 'zz-smoke19'));
  perform pg_temp.chk('save: an old version is still a CONFLICT, the concept untouched',
    r ->> 'error' = 'CONFLICT' and (select concept from mog.wh_products where id = bowls) is null, r);

  -- ---- As before ----
  perform pg_temp.chk('v17 unchanged: the product kept its pack (v21 retired its via)',
    (select pack = 'CASE (300)' from mog.wh_products where id = bowls), null);
  perform pg_temp.chk('privileges: the public key still cannot reach the save itself',
    not has_function_privilege('anon', 'mog.wh_do_save(text, text, jsonb)', 'execute')
      and not has_function_privilege('anon', 'mog.wh_state(text)', 'execute')
      and has_function_privilege('anon', 'public.mog_wh_save(text, text, jsonb)', 'execute'), null);

  perform pg_temp.clean19();
  perform pg_temp.chk('cleanup: nothing of the smoke is left',
    not exists (select 1 from mog.stores where slug = 'zztest19')
      and not exists (select 1 from mog.wh_products where name like 'zz smoke 19 %')
      and not exists (select 1 from mog.wh_locations where name like 'zz smoke 19 %'), null);
end;
$$;

select n, case when ok then 'PASS' else 'FAIL' end as result, check_name, detail from mog_smoke19 order by n;
