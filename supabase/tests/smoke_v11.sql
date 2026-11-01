-- =====================================================================
-- MOG schema v11 — smoke test (run in the SQL Editor AFTER schema_v11.sql)
-- =====================================================================
-- Throwaway stores 'zztest11a' and 'zztest11b' (editor moved) and
-- 'zztest11c' (still on the Sheet), and the HQ user 'zz smoke 11': the invite
-- (wrong code, too-short passphrase, used once), signing in and the lockout
-- (that person's only), the read, one save across two stores logged by
-- "HQ · <name>", a CONFLICT or a Sheet store at one store writing nothing
-- anywhere, the remembered vendor names (kept, forgotten, gone with the
-- vendor), Undo from the store's own editor, and a removed person's sign-in.
-- Cleans up after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke11 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke11;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke11 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  ka   text;
  kb   text;
  kc   text;
  msg  text;
  code text;
  r    jsonb;
  tok  text;
  stok text;
  cid  bigint;
  i    integer;
  me   text := 'zz smoke 11';
  pass text := 'correct horse battery';
  tabs jsonb := '{
    "profile": {"timeZone": "America/New_York", "location": "Smoke v11", "abbr": "ZZ11", "concept": "roll-play"},
    "vendors": [{"name": "Sysco", "mults": [1,1,1,1,1,0,0], "cutoff": "10:00"},
                {"name": "B&T Distributions", "mults": [0,0,1,0,0,0,0], "cutoff": null}],
    "areas":   [{"name": "Walk-in", "ord": 10}],
    "items":   [{"id": "ITEM-0001", "name": "Lime", "primaryVendor": "Sysco", "pack": "CS", "par": 3, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Sysco"], "seq": 2}],
    "pickRows": [{"vendor": "Sysco", "id": "ITEM-0001", "area": "Walk-in", "shelfOrder": 10, "seq": 2}]}';
  happy jsonb := '{"t": "vendors", "before": null, "after": {"name": "Happy Supply", "mults": [0,3,0,0,4,0,0], "cutoff": null,
                                                             "contact": {"person": "Pat", "phone": "(555) 010-0100"}}}';
  mango jsonb := '{"t": "items", "before": null, "after": {"id": "ITEM-0002", "name": "Mango puree", "primaryVendor": "Sysco",
                   "pack": "CS", "par": null, "active": true, "useMult": true, "notes": "Spring LTO", "sku": "", "category": "",
                   "eligible": ["Sysco"], "seq": 3}}';
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key can call the four HQ entry points',
    has_function_privilege('anon', 'public.mog_hq_claim(text, text, text)', 'execute')
      and has_function_privilege('anon', 'public.mog_hq_login(text, text)', 'execute')
      and has_function_privilege('anon', 'public.mog_hq_data(text)', 'execute')
      and has_function_privilege('anon', 'public.mog_hq_apply(text, jsonb, jsonb)', 'execute'), null);
  perform pg_temp.chk('privileges: the public key cannot invite, remove or reach the helpers',
    not has_function_privilege('anon', 'mog.hq_invite(text)', 'execute')
      and not has_function_privilege('anon', 'mog.hq_remove_user(text)', 'execute')
      and not has_function_privilege('anon', 'mog.hq_session(text)', 'execute')
      and not has_function_privilege('anon', 'mog.hq_new_session(text)', 'execute'), null);

  delete from mog.stores where slug in ('zztest11a', 'zztest11b', 'zztest11c');
  delete from mog.hq_users where name = me;
  ka := mog.provision_store('zztest11a');
  kb := mog.provision_store('zztest11b');
  kc := mog.provision_store('zztest11c');
  perform public.mog_sync_set_pins('zztest11a', ka, '4321', null);
  perform mog.replace_catalog_tables('zztest11a', tabs);
  perform mog.replace_catalog_tables('zztest11b', tabs);
  perform mog.replace_catalog_tables('zztest11c', tabs);
  perform public.mog_sync_switch_editor('zztest11a', ka, false);
  perform public.mog_sync_switch_editor('zztest11b', kb, false);

  -- ---- The invite ----
  msg := mog.hq_invite(me);
  code := substring(msg from ': ([0-9A-F]+)');
  perform pg_temp.chk('invite: a one-use code, and no passphrase yet',
    code is not null and (select pass_hash is null and invite_hash is not null from mog.hq_users where name = me),
    to_jsonb(left(msg, 30)));
  r := public.mog_hq_login(me, pass);
  perform pg_temp.chk('invite: no sign-in before the invite is used', r ->> 'error' = 'Wrong name or passphrase', r);
  r := public.mog_hq_claim(me, 'NOTTHECODE', pass);
  perform pg_temp.chk('claim: a wrong code is refused and counts as a try',
    r ->> 'error' = 'Wrong name or code' and (select fail_count = 1 from mog.hq_users where name = me), r);
  r := public.mog_hq_claim(me, code, 'short');
  perform pg_temp.chk('claim: a passphrase under 12 characters is refused, the invite still good',
    r ->> 'error' = 'PASSPHRASE_TOO_SHORT' and (select invite_hash is not null from mog.hq_users where name = me), r);
  r := public.mog_hq_claim(upper(me), lower(code), pass);
  tok := r -> 'data' ->> 'token';
  perform pg_temp.chk('claim: the invite sets the passphrase and signs in (name and code in any case)',
    (r ->> 'ok')::boolean and tok is not null and r -> 'data' ->> 'name' = me
      and (select pass_hash is not null and invite_hash is null and fail_count = 0 from mog.hq_users where name = me), r - 'data');
  r := public.mog_hq_claim(me, code, pass);
  perform pg_temp.chk('claim: an invite works once', r ->> 'error' like 'This invite%', r);

  -- ---- Signing in, and the lockout ----
  for i in 1..4 loop
    r := public.mog_hq_login(me, 'wrong passphrase ' || i);
  end loop;
  perform pg_temp.chk('login: wrong passphrases are refused', r ->> 'error' = 'Wrong name or passphrase', r);
  r := public.mog_hq_login(me, 'wrong passphrase 5');
  perform pg_temp.chk('login: the fifth wrong one locks this person out for 15 minutes',
    (r ->> 'lockout')::boolean and (select locked_until > now() + interval '14 minutes' from mog.hq_users where name = me), r);
  r := public.mog_hq_login(me, pass);
  perform pg_temp.chk('login: even the right passphrase waits out the lockout', (r ->> 'lockout')::boolean, r);
  perform pg_temp.chk('login: a store''s PIN lockout is untouched',
    (select fail_count = 0 and locked_until is null from mog.stores where slug = 'zztest11a'), null);
  update mog.hq_users set locked_until = now() - interval '1 second' where name = me;
  r := public.mog_hq_login(me, pass);
  perform pg_temp.chk('login: after the lockout the right passphrase signs in and clears the count',
    (r ->> 'ok')::boolean and (select fail_count = 0 and locked_until is null from mog.hq_users where name = me), r - 'data');
  tok := r -> 'data' ->> 'token';
  r := public.mog_hq_login('zz nobody', pass);
  perform pg_temp.chk('login: an unknown name gets the same answer', r ->> 'error' = 'Wrong name or passphrase', r);

  -- ---- Reading ----
  r := public.mog_hq_data('bogus');
  perform pg_temp.chk('data: a bad token is refused', r ->> 'error' = 'SESSION_EXPIRED', r);
  r := public.mog_hq_data(tok);
  perform pg_temp.chk('data: every store, with its tables once its editor has moved',
    (r ->> 'ok')::boolean and r -> 'data' ->> 'name' = me
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'stores') s
                   where s ->> 'slug' = 'zztest11a' and jsonb_array_length(s -> 'tables' -> 'vendors') = 2)
      and exists (select 1 from jsonb_array_elements(r -> 'data' -> 'stores') s
                   where s ->> 'slug' = 'zztest11c' and s -> 'tables' = 'null'::jsonb), null);

  -- ---- One save across two stores ----
  r := public.mog_hq_apply(tok, jsonb_build_array(
         jsonb_build_object('slug', 'zztest11a', 'label', 'HQ: added vendor "Happy Supply"', 'ops', jsonb_build_array(happy)),
         jsonb_build_object('slug', 'zztest11b', 'label', 'HQ: Spring LTO', 'ops', jsonb_build_array(mango))),
       '[{"slug": "zztest11a", "hqName": "Happy Supply", "vendor": "Happy Supply"},
         {"slug": "zztest11b", "hqName": "B&T", "vendor": "B&T Distributions"}]'::jsonb);
  perform pg_temp.chk('apply: both stores change, one logged change each by "HQ · <name>"',
    (r ->> 'ok')::boolean and jsonb_array_length(r -> 'data' -> 'changes') = 2
      and exists (select 1 from mog.vendors where slug = 'zztest11a' and name = 'Happy Supply' and contact ->> 'person' = 'Pat')
      and exists (select 1 from mog.items where slug = 'zztest11b' and name = 'Mango puree' and par is null)
      and (select count(*) = 1 from mog.change_log where slug = 'zztest11a' and by_name = 'HQ · ' || me)
      and (select count(*) = 1 from mog.change_log where slug = 'zztest11b' and label = 'HQ: Spring LTO'), r);
  perform pg_temp.chk('apply: phones get the new catalogs',
    (select payload -> 'vendorList' ? 'Happy Supply' from mog.catalog where slug = 'zztest11a')
      and (select payload -> 'items' ? 'ITEM-0002' from mog.catalog where slug = 'zztest11b'), null);
  perform pg_temp.chk('apply: the vendor names are remembered',
    (select count(*) = 2 from mog.hq_vendor_links where slug in ('zztest11a', 'zztest11b'))
      and (select vendor = 'B&T Distributions' from mog.hq_vendor_links where slug = 'zztest11b' and hq_name = 'B&T'), null);
  r := public.mog_hq_data(tok);
  perform pg_temp.chk('data: the save shows in Recent',
    (select count(*) >= 2 from jsonb_array_elements(r -> 'data' -> 'recent') x where x ->> 'slug' like 'zztest11%'), null);

  -- ---- All stores or none ----
  r := public.mog_hq_apply(tok, jsonb_build_array(
         jsonb_build_object('slug', 'zztest11a', 'label', 'HQ: added vendor "IGF"', 'ops',
           '[{"t": "vendors", "before": null, "after": {"name": "IGF", "mults": [1,0,0,0,0,0,0], "cutoff": null}}]'::jsonb),
         jsonb_build_object('slug', 'zztest11b', 'label', 'HQ: stale', 'ops',
           '[{"t": "vendors", "before": {"name": "Sysco", "mults": [9,9,9,9,9,9,9], "cutoff": null},
                              "after":  {"name": "Sysco", "mults": [1,1,1,1,1,1,1], "cutoff": null}}]'::jsonb)), null);
  perform pg_temp.chk('all or none: a CONFLICT at one store writes nothing at the other',
    r ->> 'error' = 'CONFLICT' and r ->> 'detail' like 'zztest11b%'
      and not exists (select 1 from mog.vendors where slug = 'zztest11a' and name = 'IGF')
      and not exists (select 1 from mog.change_log where label in ('HQ: added vendor "IGF"', 'HQ: stale')), r);
  r := public.mog_hq_apply(tok, jsonb_build_array(
         jsonb_build_object('slug', 'zztest11a', 'label', 'HQ: added vendor "IGF"', 'ops',
           '[{"t": "vendors", "before": null, "after": {"name": "IGF", "mults": [1,0,0,0,0,0,0], "cutoff": null}}]'::jsonb),
         jsonb_build_object('slug', 'zztest11c', 'label', 'HQ: Sheet store', 'ops', jsonb_build_array(happy))), null);
  perform pg_temp.chk('all or none: a store still on the Sheet is refused, nothing written',
    r ->> 'error' like 'REJECTED: zztest11c%'
      and not exists (select 1 from mog.vendors where slug = 'zztest11a' and name = 'IGF')
      and not exists (select 1 from mog.vendors where slug = 'zztest11c' and name = 'Happy Supply'), r);
  r := public.mog_hq_apply(tok, '[]'::jsonb,
       '[{"slug": "zztest11a", "hqName": "Happy Supply", "vendor": "Nobody"}]'::jsonb);
  perform pg_temp.chk('links: a name the store doesn''t have is refused, the old one kept',
    r ->> 'error' like 'REJECTED%'
      and exists (select 1 from mog.hq_vendor_links where slug = 'zztest11a' and hq_name = 'Happy Supply'), r);
  r := public.mog_hq_apply(tok, '[]'::jsonb, '[{"slug": "zztest11b", "hqName": "b&t", "vendor": null}]'::jsonb);
  perform pg_temp.chk('links: a link with no vendor is forgotten (name in any case)',
    (r ->> 'ok')::boolean and not exists (select 1 from mog.hq_vendor_links where slug = 'zztest11b'), r);

  -- ---- The store's own editor ----
  stok := public.mog_editor_login('zztest11a', '4321') -> 'data' ->> 'token';
  cid := (select id from mog.change_log where slug = 'zztest11a' and by_name = 'HQ · ' || me);
  r := public.mog_editor_undo(stok, cid, 'Luis');
  perform pg_temp.chk('undo: the store undoes HQ''s change itself, and the link goes with the vendor',
    (r ->> 'ok')::boolean
      and not exists (select 1 from mog.vendors where slug = 'zztest11a' and name = 'Happy Supply')
      and not exists (select 1 from mog.hq_vendor_links where slug = 'zztest11a'), r);

  -- ---- Removing a person ----
  msg := mog.hq_remove_user(me);
  r := public.mog_hq_data(tok);
  perform pg_temp.chk('remove: a removed person''s sign-in stops working',
    r ->> 'error' = 'SESSION_EXPIRED' and not exists (select 1 from mog.hq_users where name = me), r);

  -- ---- Clean up ----
  delete from mog.stores where slug in ('zztest11a', 'zztest11b', 'zztest11c');
  delete from mog.hq_users where name = me;
  perform pg_temp.chk('cleanup: the test stores and person are gone',
    not exists (select 1 from mog.stores where slug like 'zztest11%')
      and not exists (select 1 from mog.change_log where slug like 'zztest11%')
      and not exists (select 1 from mog.hq_vendor_links where slug like 'zztest11%')
      and not exists (select 1 from mog.hq_users where name = me), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke11 order by n;
