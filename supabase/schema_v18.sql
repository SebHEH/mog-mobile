-- =====================================================================
-- MOG on Supabase — schema v18   (run AFTER schema.sql and v2 to v17)
-- =====================================================================
-- HQ remembers a device (Sebastian, 2026-11-03). The HQ sign-in gets a
-- "Remember this device for 30 days" box, off by default. Ticked, the page
-- asks for 30 days at sign-in and again each time HQ opens on that device,
-- so a device used at least once a month never asks again. Unticked, a
-- sign-in lasts 12 hours and ends when the browser closes, as before.
-- Sign out now ends the sign-in here too, not only in the browser.
--
-- Adds:
--   * mog_hq_remember(token): that sign-in runs 30 days from now. Any HQ
--     person (hq, warehouse or both); a sign-in already over is refused.
--   * mog_hq_signout(token): that sign-in ends.
--
-- Unchanged: mog_hq_login and mog_hq_claim (still 12 hours), and a new
-- invite (mog.hq_invite) still ends every sign-in that person has, which
-- is how a lost device is signed out.
--
-- Writes no row. Re-running is safe (CREATE OR REPLACE).
-- =====================================================================

do $$
begin
  if to_regprocedure('mog.wh_held_from_log(text, date)') is null then
    raise exception 'Run schema_v17.sql first: mog.wh_held_from_log is missing.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- Public: the HQ page
-- ---------------------------------------------------------------------

-- A remembered device: called after signing in with the box ticked, and on
-- every open of HQ there. Answers the new end.
create or replace function public.mog_hq_remember(p_token text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_until timestamptz := now() + interval '30 days';
begin
  update mog.hq_sessions
     set expires_at = v_until
   where token_hash = mog.sha256_hex(coalesce(p_token, '')) and expires_at > now();
  if not found then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('expiresAt', v_until));
end;
$$;

-- Sign out: the sign-in is gone, wherever its token is kept.
create or replace function public.mog_hq_signout(p_token text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_until timestamptz;
begin
  delete from mog.hq_sessions where token_hash = mog.sha256_hex(coalesce(p_token, ''))
  returning expires_at into v_until;
  if v_until is null or v_until <= now() then
    return jsonb_build_object('ok', false, 'error', 'SESSION_EXPIRED');
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('signedOut', true));
end;
$$;


-- ---------------------------------------------------------------------
-- Privileges: open exactly the two entry points.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_hq_remember(text)',
    'public.mog_hq_signout(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
