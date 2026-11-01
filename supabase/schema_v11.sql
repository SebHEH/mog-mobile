-- =====================================================================
-- MOG on Supabase — schema v11   (run AFTER schema.sql and v2 to v10)
-- =====================================================================
-- HQ control: one person adds a vendor, or a concept's LTO items, to many
-- stores at once (hq/ in the app's site). The rules for WHAT changes (new
-- items with no par and no area, backups on items a store already has, a
-- vendor with its days and contact) stay in template/editor/catalogEdit.js,
-- as for the editor; this file signs people in, reads every store's tables
-- and applies each store's changes, all stores or none.
--
-- Adds:
--   * mog.hq_users: one row per person, a bcrypt passphrase hash, their own
--     lockout (5 wrong, then 15 minutes), never shared with a store's PIN.
--   * mog.hq_sessions: 12-hour HQ sign-ins.
--   * mog.hq_vendor_links: what each store calls an HQ vendor ("B&T" is
--     "B&T Distributions" at rpr), remembered once confirmed. It follows the
--     store's vendor (on update / on delete cascade).
--   * mog.hq_invite(name) / mog.hq_remove_user(name): SQL Editor only. An
--     invite is a one-use code, good for 24 hours; the person sets their own
--     passphrase with it on the HQ page, so it never passes through the SQL
--     Editor's history and nobody else knows it. A new invite also resets a
--     forgotten passphrase.
--   * mog_hq_claim(name, code, passphrase): an invite becomes a passphrase
--     (12 characters or more) and a sign-in.
--   * mog_hq_login(name, passphrase): an HQ token.
--   * mog_hq_data(token): every store (its tables once its editor has moved),
--     the remembered vendor names, the last 50 HQ changes.
--   * mog_hq_apply(token, changes, links): [{slug, label, ops}] applied with
--     mog.editor_apply_ops, one change per store logged by "HQ · <name>"
--     (so each store sees it in Changes and can undo it there), the catalog
--     republished; then the vendor names. A CONFLICT or a refused change at
--     any store writes nothing anywhere.
--
-- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE).
-- =====================================================================

do $$
begin
  if to_regprocedure('mog.vendor_contact_clean(jsonb)') is null then
    raise exception 'Run schema_v10.sql first: mog.vendor_contact_clean is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table if not exists mog.hq_users (
  name           text primary key check (name = btrim(name) and length(name) between 1 and 30),
  pass_hash      text,                    -- bcrypt; null until the invite is used
  invite_hash    text,                    -- sha256 hex of the one-use code
  invite_expires timestamptz,
  fail_count     integer not null default 0,
  locked_until   timestamptz,
  created_at     timestamptz not null default now()
);
create unique index if not exists hq_users_name_ci on mog.hq_users (lower(name));

create table if not exists mog.hq_sessions (
  token_hash text primary key,            -- sha256 hex; the raw token only lives in the browser
  name       text not null references mog.hq_users (name) on update cascade on delete cascade,
  expires_at timestamptz not null
);
create index if not exists hq_sessions_expires_idx on mog.hq_sessions (expires_at);

create table if not exists mog.hq_vendor_links (
  slug    text not null,
  hq_name text not null check (hq_name = btrim(hq_name) and length(hq_name) between 1 and 100),
  vendor  text not null,
  primary key (slug, hq_name),
  foreign key (slug, vendor) references mog.vendors (slug, name) on update cascade on delete cascade
);
create unique index if not exists hq_vendor_links_ci on mog.hq_vendor_links (slug, lower(hq_name));

alter table mog.hq_users        enable row level security;
alter table mog.hq_sessions     enable row level security;
alter table mog.hq_vendor_links enable row level security;


-- ---------------------------------------------------------------------
-- People (SQL Editor only)
-- ---------------------------------------------------------------------

-- A one-use code for <name>, good for 24 hours. Adds the person, or resets
-- an existing one (their passphrase stops working and they're signed out).
create or replace function mog.hq_invite(p_name text)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_code text := upper(encode(extensions.gen_random_bytes(5), 'hex'));
  v_have text;
begin
  if v_name = '' or length(v_name) > 30 then
    raise exception 'A name of 1 to 30 characters, please.';
  end if;
  select u.name into v_have from mog.hq_users u where lower(u.name) = lower(v_name);
  if v_have is null then
    insert into mog.hq_users (name) values (v_name);
    v_have := v_name;
  end if;
  update mog.hq_users
     set pass_hash = null, invite_hash = mog.sha256_hex(v_code), invite_expires = now() + interval '24 hours',
         fail_count = 0, locked_until = null
   where name = v_have;
  delete from mog.hq_sessions where name = v_have;
  return 'HQ invite for ' || v_have || ': ' || v_code || '  (one use, good for 24 hours)';
end;
$$;

create or replace function mog.hq_remove_user(p_name text)
returns text
language sql volatile security definer
set search_path = ''
as $$
  with gone as (delete from mog.hq_users u where lower(u.name) = lower(btrim(coalesce(p_name, ''))) returning u.name)
  select coalesce((select 'Removed ' || name || ' from HQ' from gone), 'No HQ user called ' || coalesce(p_name, ''));
$$;


-- ---------------------------------------------------------------------
-- Signing in
-- ---------------------------------------------------------------------

-- The person signed in with this token, or null.
create or replace function mog.hq_session(p_token text)
returns text
language sql stable security definer
set search_path = ''
as $$
  select s.name from mog.hq_sessions s
   where s.token_hash = mog.sha256_hex(coalesce(p_token, '')) and s.expires_at > now();
$$;

-- A new 12-hour token for <name>.
create or replace function mog.hq_new_session(p_name text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  update mog.hq_users set fail_count = 0, locked_until = null where name = p_name;
  insert into mog.hq_sessions (token_hash, name, expires_at) values (mog.sha256_hex(v_token), p_name, now() + interval '12 hours');
  delete from mog.hq_sessions where expires_at < now() - interval '1 day';
  return jsonb_build_object('ok', true, 'data',
    jsonb_build_object('token', v_token, 'name', p_name, 'expiresAt', now() + interval '12 hours'));
end;
$$;

-- One wrong try for <name>: 5 in a row lock them out for 15 minutes. Only
-- that person: a store's PIN lockout is never touched.
create or replace function mog.hq_fail(p_name text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update mog.hq_users set fail_count = fail_count + 1 where name = p_name returning fail_count into v_count;
  if v_count >= 5 then
    update mog.hq_users set locked_until = now() + interval '15 minutes' where name = p_name;
    return jsonb_build_object('ok', false, 'error', 'Too many attempts', 'lockout', true, 'retryAfterMs', 900000);
  end if;
  return null;
end;
$$;

-- The person's row, locked, with an expired lockout cleared. null = unknown.
create or replace function mog.hq_user_for_try(p_name text)
returns mog.hq_users
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  u mog.hq_users%rowtype;
begin
  select * into u from mog.hq_users where lower(name) = lower(btrim(coalesce(p_name, ''))) for update;
  if not found then
    return null;
  end if;
  if u.locked_until is not null and u.locked_until <= now() then
    update mog.hq_users set fail_count = 0, locked_until = null where name = u.name;
    u.fail_count := 0;
    u.locked_until := null;
  end if;
  return u;
end;
$$;

create or replace function public.mog_hq_claim(p_name text, p_code text, p_passphrase text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  u mog.hq_users%rowtype := mog.hq_user_for_try(p_name);
  v jsonb;
begin
  if u.name is null or u.invite_hash is null or u.invite_expires < now() then
    return jsonb_build_object('ok', false, 'error', 'This invite isn''t valid any more. Ask for a new one.');
  end if;
  if u.locked_until is not null then
    return jsonb_build_object('ok', false, 'error', 'Too many attempts', 'lockout', true,
      'retryAfterMs', ceil(extract(epoch from (u.locked_until - now())) * 1000)::bigint);
  end if;
  if mog.sha256_hex(upper(btrim(coalesce(p_code, '')))) <> u.invite_hash then
    v := mog.hq_fail(u.name);
    return coalesce(v, jsonb_build_object('ok', false, 'error', 'Wrong name or code'));
  end if;
  if length(coalesce(p_passphrase, '')) < 12 then
    return jsonb_build_object('ok', false, 'error', 'PASSPHRASE_TOO_SHORT');
  end if;
  update mog.hq_users
     set pass_hash = extensions.crypt(p_passphrase, extensions.gen_salt('bf', 10)), invite_hash = null, invite_expires = null
   where name = u.name;
  return mog.hq_new_session(u.name);
end;
$$;

create or replace function public.mog_hq_login(p_name text, p_passphrase text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  u mog.hq_users%rowtype := mog.hq_user_for_try(p_name);
  v jsonb;
begin
  if u.name is null or u.pass_hash is null then
    return jsonb_build_object('ok', false, 'error', 'Wrong name or passphrase');
  end if;
  if u.locked_until is not null then
    return jsonb_build_object('ok', false, 'error', 'Too many attempts', 'lockout', true,
      'retryAfterMs', ceil(extract(epoch from (u.locked_until - now())) * 1000)::bigint);
  end if;
  if extensions.crypt(coalesce(p_passphrase, ''), u.pass_hash) <> u.pass_hash then
    v := mog.hq_fail(u.name);
    return coalesce(v, jsonb_build_object('ok', false, 'error', 'Wrong name or passphrase'));
  end if;
  return mog.hq_new_session(u.name);
end;
$$;


-- ---------------------------------------------------------------------
-- Reading and applying
-- ---------------------------------------------------------------------

create or replace function public.mog_hq_data(p_token text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_name text := mog.hq_session(p_token);
begin
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'name', v_name,
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', s.slug, 'location', s.location, 'abbr', s.abbr, 'concept', coalesce(s.concept, ''),
               'isTest', s.is_test, 'editorDirect', s.editor_direct,
               'tables', case when s.editor_direct then mog.tables_json(s.slug) end)
             order by coalesce(s.concept, ''), s.is_test, s.location, s.slug)
        from mog.stores s), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('slug', l.slug, 'hqName', l.hq_name, 'vendor', l.vendor) order by l.hq_name, l.slug)
        from mog.hq_vendor_links l), '[]'::jsonb),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'at', c.at, 'by', c.by_name, 'label', c.label,
                                          'undoneBy', c.undone_by) order by c.id desc)
        from (select * from mog.change_log x where x.by_name like 'HQ · %' order by x.id desc limit 50) c), '[]'::jsonb)));
end;
$$;

create or replace function public.mog_hq_apply(p_token text, p_changes jsonb, p_links jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_name text := mog.hq_session(p_token);
  v_by   text;
  ch     jsonb;
  l      jsonb;
  v_slug text;
  v_ops  jsonb;
  v_id   bigint;
  v_ver  bigint;
  v_out  jsonb := '[]'::jsonb;
begin
  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 50 then
    return jsonb_build_object('ok', false, 'error', 'changes must be an array of at most 50 stores');
  end if;
  if p_links is not null and (jsonb_typeof(p_links) <> 'array' or jsonb_array_length(p_links) > 1000) then
    return jsonb_build_object('ok', false, 'error', 'links must be an array');
  end if;
  v_by := left('HQ · ' || v_name, 40);

  -- One editor write at a time per store (as mog_editor_apply), taken in
  -- slug order so two HQ saves never wait on each other in a circle.
  perform 1 from mog.stores s
   where s.slug in (select c ->> 'slug' from jsonb_array_elements(p_changes) c)
   order by s.slug for update;

  begin
    for ch in select c from jsonb_array_elements(p_changes) c order by c ->> 'slug' loop
      v_slug := ch ->> 'slug';
      v_ops := ch -> 'ops';
      if not exists (select 1 from mog.stores s where s.slug = v_slug and s.editor_direct) then
        raise exception 'REJECTED: % isn''t on the app''s editor', coalesce(v_slug, '(no store)');
      end if;
      if v_ops is null or jsonb_typeof(v_ops) <> 'array' then
        raise exception 'REJECTED: % ops must be an array', v_slug;
      end if;
      if jsonb_array_length(v_ops) = 0 then
        continue;
      end if;
      if jsonb_array_length(v_ops) > 5000 then
        raise exception 'REJECTED: too many changes at once for %', v_slug;
      end if;
      begin
        perform mog.editor_apply_ops(v_slug, v_ops);
      exception when others then
        if sqlerrm like 'CONFLICT: %' then
          raise exception 'CONFLICT: % %', v_slug, substr(sqlerrm, 11);
        end if;
        raise exception 'REJECTED: % %', v_slug, sqlerrm;
      end;
      insert into mog.change_log (slug, by_name, label, ops)
      values (v_slug, v_by, left(coalesce(nullif(btrim(coalesce(ch ->> 'label', '')), ''), 'HQ change'), 300), v_ops)
      returning id into v_id;
      v_ver := mog.editor_publish(v_slug);
      v_out := v_out || jsonb_build_array(jsonb_build_object('slug', v_slug, 'changeId', v_id, 'catalogVersion', v_ver));
    end loop;

    -- What each store calls an HQ vendor, after the vendors above exist.
    -- A link with no vendor forgets it.
    for l in select x from jsonb_array_elements(coalesce(p_links, '[]'::jsonb)) x loop
      delete from mog.hq_vendor_links k
       where k.slug = l ->> 'slug' and lower(k.hq_name) = lower(btrim(coalesce(l ->> 'hqName', '')));
      if nullif(l ->> 'vendor', '') is not null then
        insert into mog.hq_vendor_links (slug, hq_name, vendor)
        values (l ->> 'slug', btrim(l ->> 'hqName'), l ->> 'vendor');
      end if;
    end loop;
  exception when others then
    if sqlerrm like 'CONFLICT: %' then
      return jsonb_build_object('ok', false, 'error', 'CONFLICT', 'detail', substr(sqlerrm, 11));
    end if;
    if sqlerrm like 'REJECTED: %' then
      return jsonb_build_object('ok', false, 'error', sqlerrm);
    end if;
    return jsonb_build_object('ok', false, 'error', 'REJECTED: ' || sqlerrm);
  end;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object('by', v_by, 'changes', v_out));
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
    'public.mog_hq_claim(text, text, text)',
    'public.mog_hq_login(text, text)',
    'public.mog_hq_data(text)',
    'public.mog_hq_apply(text, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
