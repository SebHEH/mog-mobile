-- =====================================================================
-- MOG schema v18 — smoke test (run in the SQL Editor AFTER schema_v18.sql)
-- =====================================================================
-- The HQ people 'zz smoke 18' (hq and warehouse) and 'zz smoke 18 wh'
-- (warehouse only): a remembered sign-in runs 30 days from each call and
-- still reads, for either role and nothing more; only that sign-in; one
-- that's over can't be revived; sign out ends it here (the person's other
-- sign-ins go on); a new invite ends a remembered one; a plain sign-in is
-- still 12 hours. Cleans up after itself. Every row should say PASS.
-- =====================================================================

create temp table if not exists mog_smoke18 (n serial, check_name text, ok boolean, detail text);
truncate mog_smoke18;

create or replace function pg_temp.chk(p_name text, p_ok boolean, p_detail jsonb default null)
returns void language sql as $$
  insert into mog_smoke18 (check_name, ok, detail)
  values (p_name, coalesce(p_ok, false), left(coalesce(p_detail::text, ''), 300));
$$;

-- When the sign-in with this token ends, or null.
create or replace function pg_temp.until18(p_token text)
returns timestamptz language sql as $$
  select expires_at from mog.hq_sessions where token_hash = mog.sha256_hex(p_token);
$$;

do $$
declare
  me    text := 'zz smoke 18';
  pass  text := 'correct horse battery';
  code  text;
  r     jsonb;
  tok   text;    -- hq and warehouse, remembered
  tok2  text;    -- the same person on another device, not remembered
  tokw  text;    -- warehouse only, remembered
begin
  -- ---- Lockdown ----
  perform pg_temp.chk('privileges: the public key can call remember and sign out',
    has_function_privilege('anon', 'public.mog_hq_remember(text)', 'execute')
      and has_function_privilege('anon', 'public.mog_hq_signout(text)', 'execute'), null);
  perform pg_temp.chk('privileges: the sign-ins'' table and helpers stay closed',
    not has_table_privilege('anon', 'mog.hq_sessions', 'select')
      and not has_function_privilege('anon', 'mog.hq_session(text)', 'execute')
      and not has_function_privilege('anon', 'mog.hq_new_session(text)', 'execute'), null);

  delete from mog.hq_users where name in (me, me || ' wh');
  code := substring(mog.hq_invite(me, '{hq,warehouse}') from ': ([0-9A-F]+)');
  tok := public.mog_hq_claim(me, code, pass) -> 'data' ->> 'token';
  tok2 := public.mog_hq_login(me, pass) -> 'data' ->> 'token';
  code := substring(mog.hq_invite(me || ' wh', '{warehouse}') from ': ([0-9A-F]+)');
  tokw := public.mog_hq_claim(me || ' wh', code, pass) -> 'data' ->> 'token';
  perform pg_temp.chk('setup: both people sign in, each sign-in for 12 hours',
    tok is not null and tok2 is not null and tokw is not null
      and pg_temp.until18(tok) = now() + interval '12 hours' and pg_temp.until18(tokw) = now() + interval '12 hours', null);

  -- ---- Remember ----
  r := public.mog_hq_remember('bogus');
  perform pg_temp.chk('remember: a bad token is refused', r ->> 'error' = 'SESSION_EXPIRED', r);
  r := public.mog_hq_remember(tok);
  perform pg_temp.chk('remember: the sign-in runs 30 days from now, and says so',
    (r ->> 'ok')::boolean and pg_temp.until18(tok) = now() + interval '30 days'
      and (r -> 'data' ->> 'expiresAt')::timestamptz = now() + interval '30 days', r);
  perform pg_temp.chk('remember: only that sign-in (the other device keeps its 12 hours)',
    pg_temp.until18(tok2) = now() + interval '12 hours', null);
  r := public.mog_hq_data(tok);
  perform pg_temp.chk('remember: a remembered sign-in still reads the stores', (r ->> 'ok')::boolean and r -> 'data' ->> 'name' = me, r - 'data');
  update mog.hq_sessions set expires_at = now() + interval '3 days' where token_hash = mog.sha256_hex(tok);
  r := public.mog_hq_remember(tok);
  perform pg_temp.chk('remember: each call starts the 30 days again',
    (r ->> 'ok')::boolean and pg_temp.until18(tok) = now() + interval '30 days', r);

  r := public.mog_hq_remember(tokw);
  perform pg_temp.chk('remember: a warehouse-only person is remembered too',
    (r ->> 'ok')::boolean and pg_temp.until18(tokw) = now() + interval '30 days', r);
  perform pg_temp.chk('remember: and still can''t read the stores (no hq role)',
    not coalesce((public.mog_hq_data(tokw) ->> 'ok')::boolean, false)
      and (public.mog_wh_data(tokw) ->> 'ok')::boolean, null);

  update mog.hq_sessions set expires_at = now() - interval '1 second' where token_hash = mog.sha256_hex(tok2);
  r := public.mog_hq_remember(tok2);
  perform pg_temp.chk('remember: a sign-in that is over can''t be brought back',
    r ->> 'error' = 'SESSION_EXPIRED' and pg_temp.until18(tok2) = now() - interval '1 second', r);

  -- ---- Sign out ----
  tok2 := public.mog_hq_login(me, pass) -> 'data' ->> 'token';
  r := public.mog_hq_signout(tok);
  perform pg_temp.chk('sign out: the sign-in is gone, and its token reads nothing',
    (r ->> 'ok')::boolean and pg_temp.until18(tok) is null and public.mog_hq_data(tok) ->> 'error' = 'SESSION_EXPIRED', r);
  perform pg_temp.chk('sign out: the person''s other sign-in goes on',
    (public.mog_hq_data(tok2) ->> 'ok')::boolean, null);
  r := public.mog_hq_signout(tok);
  perform pg_temp.chk('sign out: again, or with a bad token, is refused',
    r ->> 'error' = 'SESSION_EXPIRED' and public.mog_hq_signout('bogus') ->> 'error' = 'SESSION_EXPIRED', r);
  r := public.mog_hq_remember(tok);
  perform pg_temp.chk('sign out: a signed-out token can''t be remembered again', r ->> 'error' = 'SESSION_EXPIRED', r);

  -- ---- A new invite, a plain sign-in ----
  perform mog.hq_invite(me || ' wh');
  perform pg_temp.chk('invite: a new invite ends a remembered sign-in',
    pg_temp.until18(tokw) is null and public.mog_hq_remember(tokw) ->> 'error' = 'SESSION_EXPIRED', null);
  perform pg_temp.chk('login: a sign-in without remember is still 12 hours', pg_temp.until18(tok2) = now() + interval '12 hours', null);

  delete from mog.hq_users where name in (me, me || ' wh');
  perform pg_temp.chk('cleanup: nothing of the smoke is left',
    not exists (select 1 from mog.hq_users where name like 'zz smoke 18%')
      and not exists (select 1 from mog.hq_sessions where name like 'zz smoke 18%'), null);
end;
$$;

select n, case when ok then 'PASS' else 'FAIL' end as result, check_name, detail from mog_smoke18 order by n;
