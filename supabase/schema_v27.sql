-- =====================================================================
-- MOG on Supabase — schema v27   (run AFTER schema.sql and v2 to v26)
-- =====================================================================
-- Sheet retirement step 5, item 1 (docs/MOG_SheetRetirement_Spec.md,
-- "Step 5"; Sebastian's pick 2026-11-15): once Supabase closes a store
-- (mog.stores.close_direct), Apps Script can no longer close its cycle or
-- mark its recap as sent.
--
--   * mog_sync_close_cycle answers CLOSE_DIRECT while the store's
--     close_direct is on. Until now the Sheet's Reset On Hand checkbox and
--     an app older than v0.34 (through /exec commitReset) could still close
--     a cycle mid-day, write LOG_ORDERS and send a MailApp recap. Apps
--     Script throws on the refusal before it writes or sends anything.
--   * mog_sync_set_recap_sent answers CLOSE_DIRECT too, so a stray Daily
--     summary from an old app can't stop the nightly recap: the recap
--     after Supabase's close is the day's record.
--
-- The nightly close is untouched: the Edge Function closes through
-- mog.night_close, which calls mog.close_cycle directly, not these.
-- Turning a store's close_direct off (the rollback) lets Apps Script close
-- and mark its recap again, with no other change.
--
-- No new entry point. Both functions keep their signatures; the key check
-- still comes first, so a wrong key learns nothing about the store.
--
-- Rollback: re-run both functions from schema_v23.sql (create or replace).
-- Re-running this file is safe: it only replaces the two functions.
-- =====================================================================

do $$
begin
  if to_regprocedure('public.mog_hq_stores(text, text, jsonb)') is null
     or to_regclass('mog.manager_pin') is null
     or to_regprocedure('mog.night_close(text, date, date, text, jsonb, timestamptz, integer)') is null then
    raise exception 'Run schema_v26.sql (and everything before it) first.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Apps Script's close and recap flag, refused once Supabase closes the store
-- ---------------------------------------------------------------------

-- v2's signature: a key check in front of mog.close_cycle (v23), refused
-- once Supabase closes the store (v27).
create or replace function public.mog_sync_close_cycle(
  p_slug text, p_key text,
  p_closing date, p_new_cycle date, p_new_dow text,
  p_rows jsonb, p_todays_log jsonb, p_logged_at timestamptz default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  -- v27: Supabase closes this store and sends its recap (close_direct);
  -- Apps Script's close and recap flag stay out of it.
  if (select st.close_direct from mog.stores st where st.slug = p_slug) then
    return jsonb_build_object('ok', false, 'error', 'CLOSE_DIRECT');
  end if;
  return mog.close_cycle(p_slug, p_closing, p_new_cycle, p_new_dow, p_rows, p_todays_log, p_logged_at);
end;
$$;

-- A recap went out from Apps Script (the Daily summary, or its own close):
-- the flag names that cycle, and a recap Supabase owed for it is settled.
-- Refused once Supabase closes the store (v27): its own recap is the record.
create or replace function public.mog_sync_set_recap_sent(p_slug text, p_key text, p_cycle date)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not mog.sync_ok(p_slug, p_key) then
    return jsonb_build_object('ok', false, 'error', 'BAD_SYNC_KEY');
  end if;
  -- v27: Supabase closes this store and sends its recap (close_direct);
  -- Apps Script's close and recap flag stay out of it.
  if (select st.close_direct from mog.stores st where st.slug = p_slug) then
    return jsonb_build_object('ok', false, 'error', 'CLOSE_DIRECT');
  end if;
  if p_cycle is null then
    return jsonb_build_object('ok', false, 'error', 'a cycle date is required');
  end if;
  update mog.store_state
     set recap_sent_for = p_cycle,
         recap_due      = case when recap_due = p_cycle then null else recap_due end,
         recap_next_at  = case when recap_due = p_cycle then null else recap_next_at end
   where slug = p_slug;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'STORE_NOT_SYNCED');
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('recapSentFor', to_char(p_cycle, 'YYYY-MM-DD')));
end;
$$;

-- ---------------------------------------------------------------------
-- Privileges: lock the internals; open exactly the entry points below.
-- ---------------------------------------------------------------------

revoke all on all tables    in schema mog from public, anon, authenticated;
revoke all on all functions in schema mog from public, anon, authenticated;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.mog_sync_close_cycle(text, text, date, date, text, jsonb, jsonb, timestamptz)',
    'public.mog_sync_set_recap_sent(text, text, date)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
