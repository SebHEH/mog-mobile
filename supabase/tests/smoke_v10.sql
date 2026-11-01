-- =====================================================================
-- MOG schema v10 — smoke test (run in the SQL Editor AFTER schema_v10.sql)
-- =====================================================================
-- Throwaway store 'zztest10': vendor contacts. Every vendor starts with none
-- and the tables and catalog read as before; what a contact may hold; a
-- contact saved through the editor reaches the tables and the phones'
-- catalog; a stale read is a CONFLICT; a days change keeps the contact;
-- Undo of an older change is refused instead of wiping it; Undo of the
-- contact, of a removal, and a too-long field refused. Cleans up after
-- itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke10 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke10;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke10 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

do $$
declare
  k      text;
  r      jsonb;
  tok    text;
  cur    jsonb;
  cid_a  bigint;
  cid_b  bigint;
  cid_d  bigint;
  pat    jsonb := '{"person": "Pat", "phone": "(555) 010-0100", "orderVia": "App / website"}';
  tabs   jsonb := '{
    "profile": {"timeZone": "America/New_York", "location": "Smoke v10", "abbr": "ZZ10", "concept": "roll-play"},
    "vendors": [{"name": "Amazon", "mults": [1,0,0,0,0,0,0], "cutoff": null},
                {"name": "Sysco",  "mults": [1,1,1,1,1,0,0], "cutoff": "10:00"}],
    "areas":   [{"name": "Walk-in", "ord": 10}],
    "items":   [{"id": "ITEM-0001", "name": "Lime", "primaryVendor": "Sysco", "pack": "CS", "par": 3, "active": true,
                 "useMult": true, "notes": "", "sku": "", "category": "", "eligible": ["Sysco"], "seq": 2}],
    "pickRows": [{"vendor": "Sysco", "id": "ITEM-0001", "area": "Walk-in", "shelfOrder": 10, "seq": 2}]}';
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key cannot call the new helpers',
    not has_function_privilege('anon', 'mog.vendor_contact_clean(jsonb)', 'execute')
      and not has_function_privilege('anon', 'mog.vendor_row_json(mog.vendors)', 'execute'), null);

  delete from mog.stores where slug = 'zztest10';
  k := mog.provision_store('zztest10');
  perform public.mog_sync_set_pins('zztest10', k, '4321', null);
  perform mog.replace_catalog_tables('zztest10', tabs);
  perform public.mog_sync_switch_editor('zztest10', k, false);
  tok := public.mog_editor_login('zztest10', '4321') -> 'data' ->> 'token';

  -- ---- Nothing changes until a contact is saved ----
  perform pg_temp.chk('start: every vendor has no contact, and the tables and catalog read as before',
    (select bool_and(contact = '{}'::jsonb) from mog.vendors where slug = 'zztest10')
      and not exists (select 1 from jsonb_array_elements(mog.tables_json('zztest10') -> 'vendors') e where e ? 'contact')
      and (select not (payload ? 'vendorContacts') from mog.catalog where slug = 'zztest10')
      and mog.editor_current('zztest10', 'vendors', '{"name": "Sysco"}')
          = '{"name": "Sysco", "mults": [1,1,1,1,1,0,0], "cutoff": "10:00"}'::jsonb, null);

  -- ---- What a contact may hold ----
  perform pg_temp.chk('clean: trimmed, empty and unknown keys dropped, text only',
    mog.vendor_contact_clean('{"person": "  Pat ", "phone": "(555) 010-0100", "email": "", "fax": "x", "account": 5}')
      = '{"person": "Pat", "phone": "(555) 010-0100"}'::jsonb, null);
  perform pg_temp.chk('clean: null, a string or an array is no contact',
    mog.vendor_contact_clean(null) = '{}'::jsonb and mog.vendor_contact_clean('"Pat"') = '{}'::jsonb
      and mog.vendor_contact_clean('[]') = '{}'::jsonb, null);

  -- ---- A change before any contact (undone further down) ----
  cur := mog.editor_current('zztest10', 'vendors', '{"name": "Sysco"}');
  r := public.mog_editor_apply(tok, 'Updated vendor "Sysco": day multipliers', 'Maria', jsonb_build_array(
         jsonb_build_object('t', 'vendors', 'before', cur, 'after', cur || '{"mults": [2,1,1,1,1,0,0]}')));
  cid_a := (r -> 'data' ->> 'changeId')::bigint;
  perform pg_temp.chk('days: a change with no contact saves as before', (r ->> 'ok')::boolean, r);

  -- ---- Saving a contact ----
  cur := mog.editor_current('zztest10', 'vendors', '{"name": "Sysco"}');
  r := public.mog_editor_apply(tok, 'Updated vendor "Sysco": contact', 'Maria', jsonb_build_array(
         jsonb_build_object('t', 'vendors', 'before', cur,
                            'after', cur || jsonb_build_object('contact', pat || '{"person": " Pat  ", "bogus": "x"}'))));
  cid_b := (r -> 'data' ->> 'changeId')::bigint;
  perform pg_temp.chk('save: the contact is stored clean, and the tables carry it',
    (r ->> 'ok')::boolean
      and (select contact = pat from mog.vendors where slug = 'zztest10' and name = 'Sysco')
      and mog.editor_current('zztest10', 'vendors', '{"name": "Sysco"}') -> 'contact' = pat, r);
  perform pg_temp.chk('save: phones get vendorContacts, only for vendors that have one',
    (select payload -> 'vendorContacts' = jsonb_build_object('Sysco', pat) from mog.catalog where slug = 'zztest10'), null);

  -- ---- A stale read ----
  r := public.mog_editor_apply(tok, 'Updated vendor "Sysco": day multipliers', 'Luis', jsonb_build_array(
         jsonb_build_object('t', 'vendors', 'before', cur, 'after', cur || '{"mults": [3,1,1,1,1,0,0]}')));
  perform pg_temp.chk('conflict: a change read before the contact was saved is refused, nothing written',
    r ->> 'error' = 'CONFLICT'
      and (select mults[1] = 2 and contact = pat from mog.vendors where slug = 'zztest10' and name = 'Sysco'), r);

  -- ---- Undo ----
  r := public.mog_editor_undo(tok, cid_a, null);
  perform pg_temp.chk('undo: the change before the contact is refused, so the contact stays',
    r ->> 'error' = 'CONFLICT'
      and (select contact = pat from mog.vendors where slug = 'zztest10' and name = 'Sysco'), r);
  r := public.mog_editor_undo(tok, cid_b, null);
  perform pg_temp.chk('undo: the contact comes off, and phones no longer get vendorContacts',
    (r ->> 'ok')::boolean
      and (select contact = '{}'::jsonb from mog.vendors where slug = 'zztest10' and name = 'Sysco')
      and (select not (payload ? 'vendorContacts') from mog.catalog where slug = 'zztest10'), r);

  -- ---- A days change carries the contact along ----
  cur := mog.editor_current('zztest10', 'vendors', '{"name": "Amazon"}');
  r := public.mog_editor_apply(tok, 'Updated vendor "Amazon": contact', 'Maria', jsonb_build_array(
         jsonb_build_object('t', 'vendors', 'before', cur, 'after', cur || jsonb_build_object('contact', pat))));
  cur := mog.editor_current('zztest10', 'vendors', '{"name": "Amazon"}');
  r := public.mog_editor_apply(tok, 'Updated vendor "Amazon": day multipliers', 'Maria', jsonb_build_array(
         jsonb_build_object('t', 'vendors', 'before', cur, 'after', cur || '{"mults": [1,1,0,0,0,0,0]}')));
  perform pg_temp.chk('days: a change that carries the contact keeps it',
    (r ->> 'ok')::boolean
      and (select mults[2] = 1 and contact = pat from mog.vendors where slug = 'zztest10' and name = 'Amazon'), r);

  -- ---- A new vendor with a contact ----
  r := public.mog_editor_apply(tok, 'Added vendor "Samuel"', 'Maria',
         '[{"t": "vendors", "before": null,
            "after": {"name": "Samuel", "mults": [0,0,0,0,0,0,0], "cutoff": null,
                      "contact": {"orderEmail": "orders@example.com", "website": ""}}}]'::jsonb);
  perform pg_temp.chk('add: a new vendor saves with its contact',
    (r ->> 'ok')::boolean
      and (select contact = '{"orderEmail": "orders@example.com"}'::jsonb from mog.vendors where slug = 'zztest10' and name = 'Samuel'), r);

  -- ---- Too long ----
  cur := mog.editor_current('zztest10', 'vendors', '{"name": "Samuel"}');
  r := public.mog_editor_apply(tok, 'Updated vendor "Samuel": contact', 'Maria', jsonb_build_array(
         jsonb_build_object('t', 'vendors', 'before', cur,
                            'after', cur || jsonb_build_object('contact', jsonb_build_object('notes', repeat('x', 501))))));
  perform pg_temp.chk('too long: a 501-character note is refused, nothing written',
    r ->> 'error' like 'REJECTED%'
      and (select contact = '{"orderEmail": "orders@example.com"}'::jsonb from mog.vendors where slug = 'zztest10' and name = 'Samuel'), r);

  -- ---- Removing a vendor with a contact, and undoing it ----
  cur := mog.editor_current('zztest10', 'vendors', '{"name": "Samuel"}');
  r := public.mog_editor_apply(tok, 'Removed vendor "Samuel"', 'Maria', jsonb_build_array(
         jsonb_build_object('t', 'vendors', 'before', cur, 'after', null)));
  cid_d := (r -> 'data' ->> 'changeId')::bigint;
  r := public.mog_editor_undo(tok, cid_d, null);
  perform pg_temp.chk('remove: undo brings the vendor back with its contact',
    (r ->> 'ok')::boolean
      and (select contact = '{"orderEmail": "orders@example.com"}'::jsonb from mog.vendors where slug = 'zztest10' and name = 'Samuel'), r);

  -- ---- Clean up ----
  delete from mog.stores where slug = 'zztest10';
  perform pg_temp.chk('cleanup: the test store is gone',
    not exists (select 1 from mog.stores where slug = 'zztest10')
      and not exists (select 1 from mog.vendors where slug = 'zztest10')
      and not exists (select 1 from mog.change_log where slug = 'zztest10'), null);
end;
$$;

select n, check_name, case when ok then 'PASS' else 'FAIL' end as result, detail
  from mog_smoke10 order by n;
