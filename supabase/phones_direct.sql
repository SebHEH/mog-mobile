-- Turn on direct phone access (step 5, schema v3) for every store that has
-- moved to Supabase, then list every store's state. Run in the SQL Editor.
--
-- "Moved" here = Supabase holds the store's catalog AND its cycle, which
-- Move this store to Supabase writes. Only use this after each store's
-- move finished with "Moved to Supabase": a store that stopped part-way
-- still counts in its Sheet, and its phones must stay on /exec.
--
-- A phone already open keeps its current mode until the app restarts or
-- signs in again; then Settings → Server shows "Supabase".
--
-- To turn one store's phones back off (each phone switches on its next call):
--     update mog.stores set phone_direct = false where slug = '<slug>';

update mog.stores s
   set phone_direct = true
 where not s.phone_direct
   and exists (select 1 from mog.catalog c where c.slug = s.slug)
   and exists (select 1 from mog.store_state t where t.slug = s.slug);

select s.slug,
       s.phone_direct,
       t.cycle_date,
       t.day_of_week,
       c.pushed_at at time zone 'America/New_York' as catalog_pushed_et
  from mog.stores s
  left join mog.store_state t on t.slug = s.slug
  left join mog.catalog c on c.slug = s.slug
 order by s.slug;
