-- =====================================================================
-- MOG on Supabase — schema v9   (run AFTER schema.sql and v2 to v8)
-- =====================================================================
-- One app per store, the rest of Phase 4 (docs/MOG_OneApp_Spec.md T1-T4):
-- order history, the daily summary's recipients and the Health Check move to
-- Supabase with a store's editor, and People renames or removes names in
-- "Who's counting?" for every store.
--
-- Adds:
--   History (T1)
--   * mog_history(token, from, to): the store's order log for a date range
--     (the phone's History tab and the editor's Order History), once its
--     editor has moved. Rows in log order, times in the store's time zone.
--   * mog_sync_backfill_log(slug, key, rows): the Sheet's LOG_ORDERS copied
--     in at the switch, only for dates the order log doesn't have yet, so
--     running it twice adds nothing.
--   Recipients (T2)
--   * mog.recipients and mog.stores.recipients_seeded.
--   * mog_recipients_get / mog_recipients_save(token, list, gmEdit): Settings
--     -> Recipients once the editor has moved. The save's rules are
--     Recap.gs api_saveRecipients_'s, with the GM row locked unless gmEdit
--     (a computer, T2).
--   * mog_sync_get_recipients / mog_sync_seed_recipients(slug, key, list): the
--     nightly email's list, and the one copy from the Sheet (refused once
--     seeded, so a list emptied on purpose stays empty).
--   People (T3)
--   * mog.store_people.removed_at / renamed_to. A removed name is never added
--     back by a device that still holds it; a renamed one is recorded under
--     the new name. mog_snapshot2 tells the device (nameNow, nameGone).
--   * mog_people_list / mog_people_rename / mog_people_remove: Settings ->
--     People on a computer, every store with phones on Supabase.
--   * mog_people_join(token, name): a name picked or typed in "Who's
--     counting?", the one way a removed name comes back.
--   Health (T4)
--   * mog_editor_status(token): phones on Supabase, the current cycle and the
--     store's local time (did last night's close run?), the PIN lockout.
--   * mog_editor_clear_lockout(token).
--
-- Replaces:
--   * mog.touch_presence, mog.live_json, mog_snapshot2 (same signatures).
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists mog.recipients (
  slug    text not null references mog.stores (slug) on delete cascade,
  pos     integer not null,
  name    text not null default '' check (length(name) <= 200),
  email   text not null default '' check (length(email) <= 320),
  active  boolean not null default false,
  gm      boolean not null default false,
  primary key (slug, pos)
);
alter table mog.recipients enable row level security;

alter table mog.stores add column if not exists recipients_seeded boolean not null default false;

alter table mog.store_people add column if not exists removed_at timestamptz;
alter table mog.store_people add column if not exists renamed_to text check (length(renamed_to) <= 40);


-- ---------------------------------------------------------------------
-- Internal
-- ---------------------------------------------------------------------

-- JavaScript's String(x).trim() for the texts the app sends.
create or replace function mog.js_trim(p text)
returns text
language sql immutable
set search_path = ''
as $$
  select regexp_replace(coalesce(p, ''), '^\s+|\s+$', '', 'g');
$$;

-- The store's local date and time.
create or replace function mog.store_tz(p_slug text)
returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select nullif(s.time_zone, '') from mog.stores s where s.slug = p_slug), 'America/New_York');
$$;

-- A session's store, for the phone's calls: { ok, slug } once its phones
-- talk to Supabase (People), or { ok: false, error }.
create or replace function mog.phone_session(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_slug text;
begin
  select v.slug into v_slug from mog.sessions v
   where v.token_hash = mog.sha256_hex(p_token) and v.expires_at > now();
  if v_slug is null then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  if not mog.phone_direct_on(v_slug) then
    return jsonb_build_object('ok', false, 'error', 'USE_EXEC');
  end if;
  return jsonb_build_object('ok', true, 'slug', v_slug);
end;
$$;

create or replace function mog.recipients_json(p_slug text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce((select jsonb_agg(jsonb_build_object('name', r.name, 'email', r.email,
                                                       'active', r.active, 'gm', r.gm) order by r.pos)
                     from mog.recipients r where r.slug = p_slug), '[]'::jsonb);
$$;

-- Recap.gs api_saveRecipients_'s rules over a whole new list: blank rows
-- dropped; a name, an email of the form a@b.c and no email twice (ignoring
-- case) on every other row. Unless p_gm_edit, every GM row already stored
-- must come back with its email, name and active unchanged and gm true, and
-- only those rows stay GM; with p_gm_edit, gm is what the list says.
-- { ok, list } or { ok: false, error } (Recap.gs's messages).
create or replace function mog.recipients_check(p_slug text, p_list jsonb, p_gm_edit boolean)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  e        jsonb;
  g        record;
  m        jsonb;
  v_name   text;
  v_email  text;
  v_out    jsonb := '[]'::jsonb;
  v_seen   text[] := '{}';
  v_gm     boolean;
begin
  if p_list is null or jsonb_typeof(p_list) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'recipients must be an array');
  end if;
  if jsonb_array_length(p_list) > 200 then
    return jsonb_build_object('ok', false, 'error', 'Too many recipients');
  end if;

  if not coalesce(p_gm_edit, false) then
    for g in select r.name, r.email, r.active from mog.recipients r where r.slug = p_slug and r.gm order by r.pos loop
      m := null;
      for e in select x from jsonb_array_elements(p_list) x loop
        if lower(mog.js_trim(e ->> 'email')) = lower(g.email) and mog.js_trim(e ->> 'email') <> '' then
          m := e;   -- the last one with this email, as Recap.gs's Map keeps
        end if;
      end loop;
      if m is null then
        return jsonb_build_object('ok', false, 'error',
          'Cannot remove GM recipient "' || g.name || '". The GM row is changed on a computer.');
      end if;
      if mog.js_trim(m ->> 'name') <> g.name
         or (m -> 'active') is distinct from to_jsonb(g.active)
         or (m -> 'gm') is distinct from 'true'::jsonb then
        return jsonb_build_object('ok', false, 'error',
          'Cannot modify GM recipient "' || g.name || '". The GM row is changed on a computer.');
      end if;
    end loop;
  end if;

  for e in select x from jsonb_array_elements(p_list) x loop
    v_name  := mog.js_trim(e ->> 'name');
    v_email := mog.js_trim(e ->> 'email');
    continue when v_name = '' and v_email = '';
    if v_name = '' then
      return jsonb_build_object('ok', false, 'error', 'Recipient is missing a name.');
    end if;
    if v_email = '' then
      return jsonb_build_object('ok', false, 'error', 'Recipient "' || v_name || '" is missing an email.');
    end if;
    if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
      return jsonb_build_object('ok', false, 'error', 'Recipient "' || v_name || '" has an invalid email: ' || v_email);
    end if;
    if lower(v_email) = any (v_seen) then
      return jsonb_build_object('ok', false, 'error', 'Duplicate email: ' || v_email);
    end if;
    if length(v_name) > 200 or length(v_email) > 320 then
      return jsonb_build_object('ok', false, 'error', 'Recipient "' || left(v_name, 40) || '" is too long.');
    end if;
    v_seen := v_seen || lower(v_email);
    if coalesce(p_gm_edit, false) then
      v_gm := (e -> 'gm') = 'true'::jsonb;
    else
      v_gm := exists (select 1 from mog.recipients r
                       where r.slug = p_slug and r.gm and lower(r.email) = lower(v_email));
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'name', v_name, 'email', v_email, 'active', (e -> 'active') = 'true'::jsonb, 'gm', v_gm));
  end loop;
  return jsonb_build_object('ok', true, 'list', v_out);
end;
$$;

create or replace function mog.recipients_write(p_slug text, p_list jsonb)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  delete from mog.recipients where slug = p_slug;
  insert into mog.recipients (slug, pos, name, email, active, gm)
  select p_slug, t.ord::integer, t.e ->> 'name', t.e ->> 'email',
         coalesce((t.e ->> 'active')::boolean, false), coalesce((t.e ->> 'gm')::boolean, false)
    from jsonb_array_elements(p_list) with ordinality as t(e, ord);
  update mog.stores set recipients_seeded = true where slug = p_slug;
end;
$$;

-- What a name stands for now: itself, the name it was renamed to, or nothing
-- (removed). { name, status: 'ok' | 'renamed' | 'removed' | 'new' }.
create or replace function mog.person_now(p_slug text, p_name text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  sp mog.store_people%rowtype;
  v  text := nullif(left(btrim(coalesce(p_name, '')), 40), '');
begin
  if v is null then
    return jsonb_build_object('name', null, 'status', 'new');
  end if;
  select * into sp from mog.store_people p where p.slug = p_slug and lower(p.name) = lower(v);
  if not found then
    return jsonb_build_object('name', v, 'status', 'new');
  end if;
  if sp.renamed_to is not null then
    return jsonb_build_object('name', sp.renamed_to, 'status', 'renamed');
  end if;
  if sp.removed_at is not null then
    return jsonb_build_object('name', null, 'status', 'removed');
  end if;
  return jsonb_build_object('name', sp.name, 'status', 'ok');
end;
$$;

-- v5's presence, with People's names: a device still holding a renamed name
-- is recorded under the new one, and one holding a removed name counts as
-- "Someone" without adding the name back. A new name joins the list (first
-- spelling wins, matched ignoring case).
create or replace function mog.touch_presence(p_slug text, p_device text, p_name text, p_vendor text)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_now    jsonb := mog.person_now(p_slug, p_name);
  v_name   text := v_now ->> 'name';
  v_vendor text := nullif(left(btrim(coalesce(p_vendor, '')), 100), '');
begin
  if coalesce(p_device, '') !~ '^[A-Za-z0-9_-]{8,64}$' then
    return;
  end if;
  insert into mog.presence as p (slug, device_id, name, vendor, seen_at)
  values (p_slug, p_device, v_name, v_vendor, now())
  on conflict (slug, device_id) do update
     set name = excluded.name, vendor = excluded.vendor, seen_at = excluded.seen_at;
  if v_name is not null then
    insert into mog.store_people as sp (slug, name, last_used)
    values (p_slug, v_name, now())
    on conflict (slug, (lower(name))) do update set last_used = excluded.last_used
     where sp.removed_at is null and sp.renamed_to is null;
  end if;
  delete from mog.presence where slug = p_slug and seen_at < now() - interval '1 day';   -- housekeeping
end;
$$;

-- v5's live data; the picker's names leave out removed and renamed ones.
create or replace function mog.live_json(p_slug text, p_device text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'presence', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', p.name, 'vendor', p.vendor,
               'secondsAgo', floor(extract(epoch from (now() - p.seen_at)))::int)
             order by p.seen_at desc)
        from mog.presence p
       where p.slug = p_slug and p.device_id <> coalesce(p_device, '')
         and p.seen_at > now() - interval '90 seconds'), '[]'::jsonb),
    'people', coalesce((
      select jsonb_agg(sp.name order by lower(sp.name), sp.name)
        from mog.store_people sp
       where sp.slug = p_slug and sp.removed_at is null and sp.renamed_to is null
         and sp.last_used > now() - interval '30 days'), '[]'::jsonb),
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object(
               'vendor', a.vendor, 'by', a.counted_by,
               'secondsAgo', floor(extract(epoch from (now() - a.updated_at)))::int)
             order by a.vendor)
        from (select distinct on (k.vendor) k.vendor, k.counted_by, k.updated_at
                from mog.counts k
                join mog.store_state st on st.slug = k.slug and st.cycle_date = k.cycle_date
               where k.slug = p_slug and k.counted_by is not null
               order by k.vendor, k.updated_at desc) a), '[]'::jsonb));
$$;

-- People's list for the screen: every name not removed or renamed, A-Z, with
-- when it was last used and whether the picker still shows it (30 days).
create or replace function mog.people_json(p_slug text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object('name', sp.name, 'lastUsed', sp.last_used,
                                        'inPicker', sp.last_used > now() - interval '30 days')
           order by lower(sp.name), sp.name)
      from mog.store_people sp
     where sp.slug = p_slug and sp.removed_at is null and sp.renamed_to is null), '[]'::jsonb);
$$;

-- A People name, checked: trimmed, 1-40 characters.
create or replace function mog.people_name_ok(p text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select btrim(coalesce(p, '')) <> '' and length(btrim(coalesce(p, ''))) <= 40;
$$;


-- ---------------------------------------------------------------------
-- History (T1)
-- ---------------------------------------------------------------------

-- The order log for [p_from, p_to] (either open), once the store's editor has
-- moved: { today, timeZone, abbr, vendors, rows: [{ date, at, vendor, id,
-- name, pack, area, onHandPrev, qty }], truncated }. Rows in log order (date,
-- then the close's order); at most 50,000, the newest kept. vendors: every
-- vendor in the whole log, for Order History's dropdown.
create or replace function public.mog_history(p_token text, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v      jsonb := mog.editor_session(p_token);
  v_slug text;
  v_tz   text;
  v_rows jsonb;
  v_n    integer;
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  v_slug := v ->> 'slug';
  v_tz := mog.store_tz(v_slug);
  select count(*) into v_n from mog.order_log l
   where l.slug = v_slug and (p_from is null or l.cycle_date >= p_from) and (p_to is null or l.cycle_date <= p_to);
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(t.cycle_date, 'YYYY-MM-DD'),
           'at', to_char(t.logged_at at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
           'vendor', t.vendor, 'id', t.item_id, 'name', t.item_name, 'pack', t.pack, 'area', t.area,
           'onHandPrev', t.on_hand_prev, 'qty', t.qty_ordered)
         order by t.cycle_date, t.seq, t.id), '[]'::jsonb)
    into v_rows
    from (select * from mog.order_log l
           where l.slug = v_slug and (p_from is null or l.cycle_date >= p_from) and (p_to is null or l.cycle_date <= p_to)
           order by l.cycle_date desc, l.seq desc, l.id desc
           limit 50000) t;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'today', to_char((now() at time zone v_tz)::date, 'YYYY-MM-DD'),
    'timeZone', v_tz,
    'abbr', (select s.abbr from mog.stores s where s.slug = v_slug),
    'vendors', coalesce((select jsonb_agg(d.vendor) from (select distinct l.vendor from mog.order_log l
                                                          where l.slug = v_slug and l.vendor <> '') d), '[]'::jsonb),
    'rows', v_rows,
    'truncated', v_n > 50000));
end;
$$;

-- The Sheet's LOG_ORDERS, copied in at the switch (Sync.gs moveEditorToApp_).
-- Rows [{ date: 'YYYY-MM-DD', at (a timestamp, or null), vendor, id, name,
-- pack, onHandPrev, qty }] in the Sheet's order; a date already in the order
-- log is skipped whole, so a second run (or a date split across two calls)
-- adds nothing twice. Rows with neither a vendor nor a name, or without a
-- date, are left out (Order History hides them too).
create or replace function public.mog_sync_backfill_log(p_slug text, p_key text, p_rows jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_tz      text;
  v_dates   integer;
  v_skipped integer;
  v_n       integer;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'a rows array is required');
  end if;
  if jsonb_array_length(p_rows) > 20000 then
    return jsonb_build_object('ok', false, 'error', 'Too many rows in one call');
  end if;
  v_tz := mog.store_tz(p_slug);
  perform 1 from mog.store_state x where x.slug = p_slug for update;   -- not while a close writes the log

  with incoming as (
    select distinct (t.e ->> 'date')::date as d
      from jsonb_array_elements(p_rows) as t(e)
     where coalesce(t.e ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
       and (btrim(coalesce(t.e ->> 'vendor', '')) <> '' or btrim(coalesce(t.e ->> 'name', '')) <> ''))
  select count(*) filter (where exists (select 1 from mog.order_log l where l.slug = p_slug and l.cycle_date = i.d)),
         count(*) filter (where not exists (select 1 from mog.order_log l where l.slug = p_slug and l.cycle_date = i.d))
    into v_skipped, v_dates
    from incoming i;

  with incoming as (
    select t.ord::integer as ord, (t.e ->> 'date')::date as d, t.e
      from jsonb_array_elements(p_rows) with ordinality as t(e, ord)
     where coalesce(t.e ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$'
       and (btrim(coalesce(t.e ->> 'vendor', '')) <> '' or btrim(coalesce(t.e ->> 'name', '')) <> '')),
  fresh as (
    select i.* from incoming i
     where not exists (select 1 from mog.order_log l where l.slug = p_slug and l.cycle_date = i.d))
  insert into mog.order_log
    (slug, cycle_date, seq, vendor, item_id, item_name, pack, area, on_hand_prev, qty_ordered, logged_at)
  select p_slug, f.d, row_number() over (partition by f.d order by f.ord)::integer,
         btrim(coalesce(f.e ->> 'vendor', '')), btrim(coalesce(f.e ->> 'id', '')),
         btrim(coalesce(f.e ->> 'name', '')), btrim(coalesce(f.e ->> 'pack', '')), '',
         mog.to_onhand(f.e -> 'onHandPrev'), coalesce(mog.to_onhand(f.e -> 'qty'), 0),
         coalesce((f.e ->> 'at')::timestamptz, (f.d::timestamp at time zone v_tz))
    from fresh f;
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'inserted', v_n, 'dates', v_dates, 'skippedDates', v_skipped));
end;
$$;


-- ---------------------------------------------------------------------
-- Recipients (T2)
-- ---------------------------------------------------------------------

create or replace function public.mog_recipients_get(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v jsonb := mog.editor_session(p_token);
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('recipients', mog.recipients_json(v ->> 'slug')));
end;
$$;

create or replace function public.mog_recipients_save(p_token text, p_recipients jsonb, p_gm_edit boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v   jsonb := mog.editor_session(p_token);
  chk jsonb;
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  perform 1 from mog.stores s where s.slug = v ->> 'slug' for update;   -- one save at a time
  chk := mog.recipients_check(v ->> 'slug', p_recipients, p_gm_edit);
  if not (chk ->> 'ok')::boolean then
    return chk;
  end if;
  perform mog.recipients_write(v ->> 'slug', chk -> 'list');
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('recipients', chk -> 'list'));
end;
$$;

-- The nightly email's list (Recap.gs readRecipients_, once the editor moved).
create or replace function public.mog_sync_get_recipients(p_slug text, p_key text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'recipients', mog.recipients_json(p_slug),
    'seeded', (select s.recipients_seeded from mog.stores s where s.slug = p_slug)));
end;
$$;

-- The one copy from the Sheet (SETUP AB:AE as readRecipients_ reads it),
-- kept as it is: trimmed, rows blank in both dropped, a repeated email kept
-- once. Refused once the store has a list (seeded or saved), so the nightly
-- run can call it every night and a list emptied on purpose stays empty.
create or replace function public.mog_sync_seed_recipients(p_slug text, p_key text, p_recipients jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_list jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
  e      jsonb;
  v_name text;
  v_mail text;
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  if p_recipients is null or jsonb_typeof(p_recipients) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'recipients must be an array');
  end if;
  perform 1 from mog.stores s where s.slug = p_slug for update;
  if (select s.recipients_seeded from mog.stores s where s.slug = p_slug) then
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('seeded', false, 'already', true));
  end if;
  for e in select x from jsonb_array_elements(p_recipients) x loop
    v_name := left(mog.js_trim(e ->> 'name'), 200);
    v_mail := left(mog.js_trim(e ->> 'email'), 320);
    continue when v_name = '' and v_mail = '';
    continue when v_mail <> '' and lower(v_mail) = any (v_seen);
    if v_mail <> '' then v_seen := v_seen || lower(v_mail); end if;
    v_list := v_list || jsonb_build_array(jsonb_build_object('name', v_name, 'email', v_mail,
      'active', (e -> 'active') = 'true'::jsonb, 'gm', (e -> 'gm') = 'true'::jsonb));
  end loop;
  perform mog.recipients_write(p_slug, v_list);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('seeded', true, 'count', jsonb_array_length(v_list)));
end;
$$;


-- ---------------------------------------------------------------------
-- People (T3)
-- ---------------------------------------------------------------------

-- v5's 10-second read, plus what this device's name stands for now: nameNow
-- (renamed: store this instead) or nameGone (removed: ask again).
create or replace function public.mog_snapshot2(
  p_token text, p_have_version bigint default null,
  p_device text default null, p_name text default null, p_vendor text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_sess mog.sessions%rowtype;
  v_snap jsonb;
  v_now  jsonb;
begin
  select * into v_sess from mog.sessions
   where token_hash = mog.sha256_hex(p_token) and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  if not mog.phone_direct_on(v_sess.slug) then
    return jsonb_build_object('ok', false, 'error', 'USE_EXEC');
  end if;
  v_snap := mog.snapshot_json(v_sess.slug, v_sess.auth_type, p_have_version);
  if not (v_snap ->> 'ok')::boolean then
    return v_snap;
  end if;
  v_now := mog.person_now(v_sess.slug, p_name);
  if p_device is not null then
    perform mog.touch_presence(v_sess.slug, p_device, p_name, p_vendor);
  end if;
  return jsonb_build_object('ok', true, 'data',
    (v_snap -> 'data') || mog.live_json(v_sess.slug, p_device)
    || jsonb_build_object('nameNow', case when v_now ->> 'status' = 'renamed' then v_now ->> 'name' end,
                          'nameGone', v_now ->> 'status' = 'removed'));
end;
$$;

create or replace function public.mog_people_list(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v jsonb := mog.phone_session(p_token);
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('people', mog.people_json(v ->> 'slug')));
end;
$$;

-- Rename a name in the list. To a name already listed: the two become one
-- (the older name points to it). A name used before and removed comes back as
-- the new one. Devices still using the old name are told the new one at their
-- next read; counts already saved keep the name they were saved with.
create or replace function public.mog_people_rename(p_token text, p_from text, p_to text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v      jsonb := mog.phone_session(p_token);
  v_slug text;
  v_from text := btrim(coalesce(p_from, ''));
  v_to   text := btrim(coalesce(p_to, ''));
  f      mog.store_people%rowtype;
  t      mog.store_people%rowtype;
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  v_slug := v ->> 'slug';
  if not mog.people_name_ok(v_to) then
    return jsonb_build_object('ok', false, 'error', 'A name is 1 to 40 characters.');
  end if;
  select * into f from mog.store_people p
   where p.slug = v_slug and lower(p.name) = lower(v_from) and p.removed_at is null and p.renamed_to is null
     for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;

  if lower(v_to) = lower(f.name) then   -- only the spelling changes
    update mog.store_people set name = v_to where slug = v_slug and lower(name) = lower(f.name);
  else
    select * into t from mog.store_people p where p.slug = v_slug and lower(p.name) = lower(v_to) for update;
    if found then
      update mog.store_people
         set name = case when removed_at is not null or renamed_to is not null then v_to else name end,
             removed_at = null, renamed_to = null, last_used = greatest(last_used, f.last_used)
       where slug = v_slug and lower(name) = lower(v_to);
      select p.name into v_to from mog.store_people p where p.slug = v_slug and lower(p.name) = lower(v_to);
    else
      insert into mog.store_people (slug, name, created_at, last_used) values (v_slug, v_to, now(), f.last_used);
    end if;
    update mog.store_people set renamed_to = v_to
     where slug = v_slug and (lower(name) = lower(f.name) or lower(renamed_to) = lower(f.name));
  end if;
  update mog.presence set name = v_to where slug = v_slug and lower(name) = lower(f.name);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('name', v_to, 'people', mog.people_json(v_slug)));
end;
$$;

-- Remove a name from the list (and any older names renamed to it). Devices
-- using it ask "Who's counting?" again; nothing already saved changes.
create or replace function public.mog_people_remove(p_token text, p_name text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v      jsonb := mog.phone_session(p_token);
  v_slug text;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  v_slug := v ->> 'slug';
  if not exists (select 1 from mog.store_people p where p.slug = v_slug and lower(p.name) = lower(v_name)
                   and p.removed_at is null and p.renamed_to is null) then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;
  update mog.store_people set removed_at = now(), renamed_to = null
   where slug = v_slug and (lower(name) = lower(v_name) or lower(renamed_to) = lower(v_name));
  update mog.presence set name = null where slug = v_slug and lower(name) = lower(v_name);
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('people', mog.people_json(v_slug)));
end;
$$;

-- A name picked or typed in "Who's counting?": joins the list, or comes back
-- if it was removed; an old name gives the one it was renamed to. { name }.
create or replace function public.mog_people_join(p_token text, p_name text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v      jsonb := mog.phone_session(p_token);
  v_slug text;
  v_name text := btrim(coalesce(p_name, ''));
  sp     mog.store_people%rowtype;
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  v_slug := v ->> 'slug';
  if not mog.people_name_ok(v_name) then
    return jsonb_build_object('ok', false, 'error', 'A name is 1 to 40 characters.');
  end if;
  select * into sp from mog.store_people p where p.slug = v_slug and lower(p.name) = lower(v_name) for update;
  if found and sp.renamed_to is not null then
    update mog.store_people set last_used = now() where slug = v_slug and lower(name) = lower(sp.renamed_to);
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('name', sp.renamed_to));
  elsif found then
    update mog.store_people set removed_at = null, last_used = now() where slug = v_slug and lower(name) = lower(v_name);
    return jsonb_build_object('ok', true, 'data', jsonb_build_object('name', sp.name));
  end if;
  insert into mog.store_people (slug, name, last_used) values (v_slug, v_name, now());
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('name', v_name));
end;
$$;


-- ---------------------------------------------------------------------
-- Health (T4)
-- ---------------------------------------------------------------------

create or replace function public.mog_editor_status(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v      jsonb := mog.editor_session(p_token);
  v_slug text;
  v_tz   text;
  s      mog.stores%rowtype;
  st     mog.store_state%rowtype;
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  v_slug := v ->> 'slug';
  v_tz := mog.store_tz(v_slug);
  select * into s from mog.stores x where x.slug = v_slug;
  select * into st from mog.store_state x where x.slug = v_slug;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'phoneDirect', s.phone_direct,
    'timeZone', v_tz,
    'localNow', to_char(now() at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
    'cycleDate', to_char(st.cycle_date, 'YYYY-MM-DD'),
    'cycleUpdatedAt', to_char(st.updated_at at time zone v_tz, 'YYYY-MM-DD HH24:MI'),
    'lockedForMs', case when s.locked_until > now()
                        then ceil(extract(epoch from (s.locked_until - now())) * 1000)::bigint else 0 end,
    'failCount', s.fail_count,
    'lastOrderDate', (select to_char(max(l.cycle_date), 'YYYY-MM-DD') from mog.order_log l where l.slug = v_slug)));
end;
$$;

-- Clears the store's PIN lockout (5 wrong PINs). Signed in is proof enough.
create or replace function public.mog_editor_clear_lockout(p_token text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v jsonb := mog.editor_session(p_token);
begin
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  update mog.stores set fail_count = 0, locked_until = null where slug = v ->> 'slug';
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('cleared', true));
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: lock the new tables and internals, open exactly the new
-- entry points.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_snapshot2(text, bigint, text, text, text)',
    'public.mog_history(text, date, date)',
    'public.mog_sync_backfill_log(text, text, jsonb)',
    'public.mog_recipients_get(text)',
    'public.mog_recipients_save(text, jsonb, boolean)',
    'public.mog_sync_get_recipients(text, text)',
    'public.mog_sync_seed_recipients(text, text, jsonb)',
    'public.mog_people_list(text)',
    'public.mog_people_rename(text, text, text)',
    'public.mog_people_remove(text, text)',
    'public.mog_people_join(text, text)',
    'public.mog_editor_status(text)',
    'public.mog_editor_clear_lockout(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
