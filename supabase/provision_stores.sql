-- Every store's connect code in one query (docs/MOG_SupabaseMigration.md §8).
-- Run in the Supabase SQL Editor. Each row gives the store, the Sheet it
-- belongs to, and its connect code (store:key). Paste each code ONLY into its
-- own Sheet, at 📱 Mobile API → Move this store to Supabase, and never into a
-- chat.
--
-- Safe to run again. A store that has already connected (Supabase holds its
-- catalog) is skipped, so a working key is never replaced. A store that hasn't
-- connected yet gets a NEW code, and its previous one stops working.
--
-- When a store is added: add a row here, in the same commit as its
-- .clasp-targets.json entry.

select v.store, v.sheet, v.slug || ':' || mog.provision_store(v.slug) as connect_code
from (values
  ( 1, 'rpr',   'Roll Play Rosslyn BOH',   'RP_AN_ROSSLYN_ORDERING_GUIDE'),
  ( 2, 'rprfo', 'Roll Play Rosslyn FOH',   'RP_ROSSLYN_FOH_ORDERING_GUIDE'),
  ( 3, 'rpt',   'Roll Play Tysons BOH',    'RP_TYSON_ORDERING_GUIDE'),
  ( 4, 'rptfo', 'Roll Play Tysons FOH',    'RP_TYSONS_FOH_ORDERING_GUIDE'),
  ( 5, 'rpfr',  'Roll Play Founders BOH',  'RP_FOUNDERS_ORDERING_GUIDE'),
  ( 6, 'rpfrf', 'Roll Play Founders FOH',  'RP_FOUNDERS_FOH_ORDERING_GUIDE'),
  ( 7, 'tnyt',  'Teas''n You Tysons BOH',  'BOH TNY_TYSON_ORDERING_GUIDE'),
  ( 8, 'tnytf', 'Teas''n You Tysons FOH',  'FOH TNY_TYSON_ORDERING_GUIDE'),
  ( 9, 'tnyr',  'Teas''n You Rockville BOH', 'BOH TNY_ROCKVILLE_ORDERING_GUIDE'),
  (10, 'tnyrf', 'Teas''n You Rockville FOH', 'FOH TNY_ROCKVILLE_ORDERING_GUIDE')
) as v(n, slug, store, sheet)
where not exists (select 1 from mog.catalog c where c.slug = v.slug)
order by v.n;
