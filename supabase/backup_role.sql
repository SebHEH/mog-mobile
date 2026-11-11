-- MOG: the read-only login for the nightly off-site backup
-- (docs/MOG_SheetRetirement_Spec.md, decision R4, step 1).
--
-- WHO RUNS IT: a maintainer, pasted in the Supabase SQL Editor. Never through Claude's connector:
-- the result is the role's new password, shown once, and it must not pass through a chat.
--
-- WHAT TO DO WITH THE RESULT: copy the one value it shows into the private repo's secret
-- MOG_BACKUP_PASSWORD (https://github.com/SebHEH/mog-backup/settings/secrets/actions), then close
-- the result. Nothing else keeps it.
--
-- WHY THE PASSWORD IS MADE HERE: it's generated inside the function below, so it never appears in
-- the query text, the SQL Editor's saved query, the Postgres log (log_statement = ddl logs only the
-- statement the client sent) or pg_stat_statements (track = top), all measured 2026-11-11. Never
-- type a password into an "alter role ... password" here: with log_statement = ddl that line lands
-- in the Postgres log, which everyone in the Supabase org can read.
--
-- RE-RUNNING IT is harmless: it makes a new password (update the GitHub secret) and applies the
-- grants again. It is not part of the schema_vN chain: it takes no schema number, and PGlite's CI
-- run doesn't run it.
--
-- WHAT THE ROLE CAN DO: log in (at most 2 connections) and read every table and sequence in mog,
-- including tables a later schema file adds (default privileges). BYPASSRLS because every mog table
-- has row level security on with no policies: without it pg_dump stops, or reads no rows. No write
-- grant anywhere, and its transactions are read-only by default. The mog_* functions' grants are
-- unchanged (pg_dump reads a function's definition from the catalog, it never calls it).
--
-- UNDO: drop owned by mog_backup; drop role mog_backup;
-- (then delete the secret; the nightly run goes red until the role is back).

create or replace function pg_temp.mog_backup_role() returns text
language plpgsql as $fn$
declare
  pw text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if current_user <> 'postgres' then
    raise exception 'Run this as postgres (the SQL Editor''s default role), not %', current_user;
  end if;
  if to_regnamespace('mog') is null then
    raise exception 'No mog schema here: this is the wrong database';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'mog_backup') then
    create role mog_backup;  -- a new role has no superuser, createdb, createrole or replication
  end if;
  -- Supabase's postgres isn't a superuser, so the file never names SUPERUSER, even as NOSUPERUSER:
  -- Postgres lets only a superuser mention it (first live run, 2026-11-11). A mog_backup that
  -- already has more power than this file gives is refused instead.
  if exists (select 1 from pg_roles where rolname = 'mog_backup'
              and (rolsuper or rolcreaterole or rolcreatedb or rolreplication)) then
    raise exception 'mog_backup already exists with more power than a backup needs: drop it first (drop owned by mog_backup; drop role mog_backup;)';
  end if;
  execute format('alter role mog_backup with login bypassrls connection limit 2 password %L', pw);
  alter role mog_backup set default_transaction_read_only = on;

  grant usage on schema mog to mog_backup;  -- public: everyone has usage already
  grant select on all tables in schema mog to mog_backup;
  grant select on all sequences in schema mog to mog_backup;
  alter default privileges for role postgres in schema mog grant select on tables to mog_backup;
  alter default privileges for role postgres in schema mog grant select on sequences to mog_backup;

  return pw;
end
$fn$;

select pg_temp.mog_backup_role() as "Copy into GitHub's MOG_BACKUP_PASSWORD secret; shown once";
