-- =====================================================================
-- MOG — the nightly close, checked the morning after (reads only)
-- =====================================================================
-- Sheet retirement step 2. Two selects, safe to run any time:
--
-- 1. The shadows: for each store Apps Script still closes, the close
--    Supabase worked out between 3:00 and 3:20 AM (mog.night_log, step
--    'shadow') against what Apps Script then logged (mog.order_log), row by
--    row in order, after the same filter mog.close_cycle applies (a vendor,
--    an item, a quantity above 0). `match` true on every row of a night is
--    the live proof that Supabase's close writes what Apps Script would.
--    `counted_after` true means a count was saved after the shadow, so a
--    difference there can be the count, not the code. `closed_at` empty:
--    Apps Script hasn't closed that cycle (yet).
-- 2. The last three days of Supabase's own closes and recaps.
-- =====================================================================

with s as (
  select g.slug, g.cycle_date, g.at, g.detail
    from mog.night_log g
   where g.step = 'shadow' and g.at > now() - interval '7 days'
),
sr as (
  select s.slug, s.cycle_date,
         row_number() over (partition by s.slug, s.cycle_date order by t.ord) as n,
         trim(coalesce(t.e ->> 'vendor', '')) as vendor, trim(coalesce(t.e ->> 'id', '')) as item_id,
         coalesce(t.e ->> 'name', '') as item_name, coalesce(t.e ->> 'pack', '') as pack, coalesce(t.e ->> 'area', '') as area,
         mog.to_onhand(t.e -> 'onHandPrev') as on_hand_prev, mog.to_onhand(t.e -> 'qty') as qty
    from s cross join lateral jsonb_array_elements(s.detail -> 'rows') with ordinality as t(e, ord)
   where trim(coalesce(t.e ->> 'vendor', '')) <> '' and trim(coalesce(t.e ->> 'id', '')) <> ''
     and coalesce(mog.to_onhand(t.e -> 'qty'), 0) > 0
),
lr as (
  select l.slug, l.cycle_date, row_number() over (partition by l.slug, l.cycle_date order by l.seq) as n,
         l.vendor, l.item_id, l.item_name, l.pack, l.area, l.on_hand_prev, l.qty_ordered as qty
    from mog.order_log l join s on s.slug = l.slug and s.cycle_date = l.cycle_date
),
d as (
  select coalesce(a.slug, b.slug) as slug, coalesce(a.cycle_date, b.cycle_date) as cycle_date, coalesce(a.n, b.n) as n,
         (a.vendor, a.item_id, a.item_name, a.pack, a.area, a.on_hand_prev, a.qty)
           is not distinct from (b.vendor, b.item_id, b.item_name, b.pack, b.area, b.on_hand_prev, b.qty) as same,
         concat_ws(' | ', 'row ' || coalesce(a.n, b.n),
                   'supabase: ' || coalesce(a.vendor || ' / ' || a.item_name || ' x' || a.qty || ' (on hand ' || a.on_hand_prev || ')', 'none'),
                   'apps script: ' || coalesce(b.vendor || ' / ' || b.item_name || ' x' || b.qty || ' (on hand ' || b.on_hand_prev || ')', 'none')) as what
    from sr a full join lr b on a.slug = b.slug and a.cycle_date = b.cycle_date and a.n = b.n
)
select s.slug, s.cycle_date,
       to_char(s.at at time zone 'America/New_York', 'HH24:MI') as shadow_at,
       (select count(*) from sr where sr.slug = s.slug and sr.cycle_date = s.cycle_date) as shadow_rows,
       (select count(*) from lr where lr.slug = s.slug and lr.cycle_date = s.cycle_date) as logged_rows,
       not exists (select 1 from d where d.slug = s.slug and d.cycle_date = s.cycle_date and not d.same) as match,
       (select d.what from d where d.slug = s.slug and d.cycle_date = s.cycle_date and not d.same order by d.n limit 1) as first_difference,
       coalesce((select max(k.updated_at) from mog.counts k where k.slug = s.slug and k.cycle_date = s.cycle_date)
                > s.at, false) as counted_after,
       (select to_char(min(l.logged_at) at time zone 'America/New_York', 'HH24:MI')
          from mog.order_log l where l.slug = s.slug and l.cycle_date = s.cycle_date) as closed_at
  from s
 order by s.cycle_date desc, s.slug;

select g.slug, g.step, g.cycle_date, to_char(g.at at time zone 'America/New_York', 'MM-DD HH24:MI') as at_ny,
       g.ok, g.detail - 'rows' as detail
  from mog.night_log g
 where g.step <> 'shadow' and g.at > now() - interval '3 days'
 order by g.id desc;
