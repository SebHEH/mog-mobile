---
name: mog-supabase-schema
description: MOG's specializer for any change to the Supabase layer (a supabase/*.sql file, a new or changed public.mog_* function, a new mog.* table or column), stemming off the global supabase-schema-change skill. Pins the files every schema version touches (schema_vN.sql, smoke_vN.sql, check_api.sh, tests/fake_supabase.js, the migration doc's function table), the ship order (the SQL first, on the maintainer's go per file: Claude runs it through the connector or the maintainer pastes it; then the gates, then deploy.py --redeploy on the rprfo canary, then build.py), the probe rule that keeps a real store's PIN lockout untouched, and how to check the live database with reads only. Trigger on "add a Supabase function", "a new column in mog.items", "schema v10", "write the migration", "check_api failed", "PGRST205", or any edit under supabase/. Skip when only reading live data (query the connector directly, selects only) and for a new store's provisioning (mog-add-store).
---

# mog-supabase-schema

Supabase is MOG's operational store: counts, the cycle, the order log, the catalog, recipients and
People. The phones and the app reach it with the publishable key, so **the schema is the security
boundary**. Tables live in the private schema `mog`; the only way in is the `public.mog_*`
functions, each checking a PIN session token or a store's sync key first.

**The general method is the global `supabase-schema-change` skill:** the lockdown block, dropping an
old signature, `notify pgrst`, the smoke harness, the public-key probe, a fake that copies the
constraints. It's installed with the team skills (proposed from here 2026-10-20, applied by
Claude-SKills). This skill pins MOG's files and order on top of it.

Design records, read the relevant one before designing a change:
- [docs/MOG_SupabaseMigration.md](../../../docs/MOG_SupabaseMigration.md) (section 7 is the table
  of every function, its caller and its credential);
- [docs/MOG_OneApp_Spec.md](../../../docs/MOG_OneApp_Spec.md).

## A change is the next version

The current version is the newest `supabase/schema_vN.sql` (and "schema vN" in `docs/MOG_CurrentState.md`'s
Versions line). A change ships as a new `schema_vN.sql`, never as an edit to a file already run: each
file is run once, in order. Re-running any of them must stay harmless.

**Two maintainers run SQL** (CLAUDE.md, Two maintainers): `git pull` before writing the next
`schema_vN.sql`, and tell the other person which number you're taking, so you never both write v10.
- A number isn't held for a person: whoever writes the next schema file first takes the next number
  (pull, check `supabase/`) and tells the other. A number in a work order is a guess, not a booking
  (Sebastian, 2026-11-02).

## Every file, every time

| File | What it gets |
|---|---|
| `supabase/schema_vN.sql` | A header ("run after `schema_v(N-1).sql`", what it adds, the design decision it implements); a prerequisite check that stops before anything changes; the tables and columns; the functions; the lockdown block listing every new public entry point by full signature; `notify pgrst, 'reload schema';` last. |
| `supabase/tests/smoke_vN.sql` | The throwaway store `zztestN` (deleted at the start and the end), the `mog_smokeN` temp table and `pg_temp.chk`. Every row should say PASS. |
| `supabase/tests/check_api.sh` | A `# schema vN` block: each new table answers 404, each new helper isn't exposed (404), each new public function refuses a bogus token or key. |
| `tests/fake_supabase.js` | The new functions, with the same refusals and link rules as the SQL (on delete cascade, on delete set null, CONFLICT on a changed row). |
| a gate in `tests/` | Whatever client code calls the new function; `node tests/run_all.js` must pass. |
| `docs/MOG_SupabaseMigration.md` | A section 7 row per new function: its caller and its credential. |
| `CLAUDE.md`, `docs/MOG_CurrentState.md` | The file-inventory line for `schema_vN.sql`; "schema vN" in Pinned focus. |

## Rules learned here

- **A probe never sends a PIN to a real store.** A wrong PIN counts against that store's lockout
  counter, which the phones share: 5 wrong means 5 minutes locked out for every phone there.
  - Use `nosuchstore`, a bogus token, or a bogus sync key. A bogus sync key against a real slug is
    fine: `mog.sync_ok` is a plain read with no counter.
  - A probe whose expected answer depends on a real store's state goes stale when that store moves.
    The v6 probe "editor_login: Sheet store refused" sent PIN `0` to rprfo and expected
    `EDITOR_NOT_DIRECT`. That was safe only while rprfo's editor was in the Sheet. Since 2026-10-19
    every store is `editor_direct`, so the probe became a real wrong-PIN attempt, and a FAIL. It
    was fixed 2026-10-20 to probe `nosuchstore`; `smoke_v6.sql` covers the refusal on `zztest6`.
- **Throwaway stores are `zztestN`.** `rprfotest` (`is_test`) holds rprfo's REAL PIN: never sign in
  there by script (memory `reference_fake_supabase_preview`).
- **The fake copies the SQL's link rules.** An area rename sent as delete plus insert loses its pick
  rows (cascade). A vendor deleted before its items are updated trips a CONFLICT (set null).
  `catalogEdit.js`'s op order and its rename step exist for these, so check a new write against the
  fake's link rules, not just `applyOps`. A fake's read never creates rows.
- **A constant that a sliced gate needs goes into that gate's slice plan.** `supabase_step4` failed
  on `CATALOG_WRITE_ACTIONS_`.
- **A new field in a shared payload or table row appears only when it has a value.** v10's vendor
  `contact` is left out of `tables_json` and the phones' catalog (`vendorContacts`) until a vendor
  has one, so every store read byte-identical until first use and no existing gate or smoke had to
  change (`catalog_parity`, `smoke_v4`'s exact payloads, `getVendorTableData`'s pinned shape).
- **A nested jsonb field in an editor row is compared clean in all three compare sites:** SQL
  `mog.editor_fields_match`, `catalogEdit.js` `matches`, the fake's `editorSame`. Empty counts as
  none, and its keys go in jsonb's stored order (shorter first, then bytewise), so `diff()` never
  sees a key-order change as an edit and Undo of an older change is refused instead of wiping it
  (schema v10). The same holds for a jsonb list read back (v12's library items come as `name, pack,
  notes, vendor, backups`): the fake sends jsonb's key order, and the client compares through its
  cleaner (`cleanLibrary`), never as raw JSON, or an untouched draft looks changed.
- **A newer schema that accepts what an older smoke row says is refused** (v15 renaming vendors vs
  smoke_v8's "only areas rename", 2026-11-02): point that probe at something no version accepts. A
  runner skip isn't enough: the probe now really writes, and later rows of that file fail.
- **Older smoke files run against the newest schema** (PGlite runs every smoke file after the whole
  chain), so a version that retires a field or a refusal breaks the older rows that read it. Retire
  it fully: drop the field from every page and function, and rewrite those older rows (or have the
  runner skip them with the reason, as it does for v1's), never keep it alive as a fallback so old
  rows pass. v20 kept `via`, a product's `par` and "Which stores can order it" alive that way, and
  HQ's Send to stores kept running v16's Happy-Supply-only rule beside v20's places: Sebastian's
  shrimp link was refused (2026-11-05).
- **Before a version drops a function, grep the whole repo for its name** (`supabase/`, `tests/`,
  `docs/`, `template/`): a caller outside the schema chain breaks silently, because PGlite runs only
  the schema and smoke files. v21 dropped `mog.wh_held_vendor` and left
  `supabase/tests/test_store_elpis.sql` failing until 11-06.
- **PGlite runs as a superuser; Supabase's `postgres` isn't** (rolsuper false; createrole,
  createdb, replication and bypassrls true; measured 2026-11-11). A file that creates or alters a
  role, or changes an owner or a role attribute, is tested in PGlite as a non-superuser stand-in
  with those four powers that owns `mog`, as
  [`supabase/tests/backup_role_pglite.mjs`](../../../supabase/tests/backup_role_pglite.mjs) does
  (CI runs it). `backup_role.sql` passed PGlite as superuser and failed live: Postgres lets only a
  superuser name the SUPERUSER attribute at all, even as `nosuperuser`.
- **A value a gate or smoke pins** (an average, a price, what's left) comes from running the SQL in
  PGlite or the page's own code, never from working it out by hand: a hand-worked 77.5926 was wrong
  (Postgres: 77.5968), and v16's gate expected 14 cases left where the code's 20 (both locations)
  was right, both 2026-11-02.
- **A CONFLICT check (a smoke row or a gate) differs from the stored row only in the field it
  guards.** Otherwise another field trips the CONFLICT and a planted "this field isn't compared"
  passes: smoke_v16's first link check also changed the vendor and pack, and missed the plant until
  a row differing only by the link was added (2026-11-02).
- **A long function redefined from an earlier version is generated, not retyped:** a short scratch
  generator imports **[`scripts/sqlgen.py`](scripts/sqlgen.py)** (`fn()` copies a definition with its
  comment lines, `rep()` replaces only at the asserted count, `lockdown()` closes the file) and writes
  `schema_vN.sql` (schema v10's `editor_apply_ops` from v8, `catalog_from_tables` from v4). Nothing
  else in the function can drift. It was rewritten by hand in nine sessions (v10 to v22) before it
  moved here; it rebuilds `schema_v22.sql` byte for byte.
- **SQL gotchas met here:**
  - `-` binds tighter than `->` (smoke_v6);
  - `now()` never moves in one DO block (smoke_v5);
  - plpgsql names ignore case: a loop record called `L` is the table alias `l` in its own query
    (schema v17: `record "l" is not assigned yet`); name records apart from every alias;
  - the vendor list sorts with `und-x-icu` to match `localeCompare` (schema_v4, pinned by smoke_v4);
  - a regex over a SQL file counts commented-out rows, so strip `--` first (`mog-add-store`'s
    `validate.py`);
  - a `language sql` function's body is checked when it's created, so every function it calls
    must be defined above it in the file (a plpgsql body is checked only when it runs): v23's
    `night_shadow_done` called `night_note`, defined below it, and the file stopped there.
- **A SQL file PGlite can't run** (it needs `pg_cron`, `pg_net` or Vault) still gets a PGlite
  test: stand-ins shaped like Supabase's for the calls it makes, the file's own `create extension`
  lines left out, everything else run as written, and the test in CI
  ([`supabase/tests/night_schedule_pglite.mjs`](../../../supabase/tests/night_schedule_pglite.mjs),
  2026-11-11). Keep such a file out of the `schema_vN.sql` chain: what PGlite can run goes in the
  schema file and its smoke file, the scheduling in its own file run once.

## Ship order

1. **Claude writes every file above**, and `node tests/run_all.js` passes.
   - **Then runs the SQL locally in PGlite** (Postgres in Node): `npm ci` once, then
     `node supabase/tests/run_pglite.mjs`. It runs the chain `schema.sql` through `schema_vN.sql`,
     every smoke file, then `schema_vN.sql` again, which must change no row; CI runs the same on
     every push. Then plant a defect or two in a scratch copy of `supabase/` (with `node_modules`
     beside it): each must turn a smoke row to FAIL. **[`scripts/plant.py`](scripts/plant.py)
     `plants.json`** does it (rewritten by hand in seven sessions, v14 to v22, before it moved here):
     one entry per rule, with the exact `old`/`new` text, its count and the smoke `row` that must
     fail. It runs the unplanted copy first, counts a plant only when the schema file still ran and
     that row failed, and prints every failing row.
     - **An error running the file is not a catch:** it means the plant broke the SQL, not the
       rule, so re-plant until a named smoke row says FAIL. A plant script that counts any `FAIL`
       line reads a broken plant as caught (2026-11-02: a plant leaving two assignments to one
       column). Nor is a plant that makes the call itself throw (a key clash, a bad statement in
       the body): every row after it fails. It counts only when the rows that fail are about the
       rule you planted (2026-11-02, v15's count plant).
     - **A plant reported NOT CAUGHT: first check it hit the code whose output a smoke row reads.**
       A rule written twice passes when only one copy is planted (2026-11-03, v17: the line count,
       not the insert); re-plant the copy that writes before calling it a gap in the smoke file.
     - The runner skips what PGlite can't pass and says why: `smoke.sql` and `smoke_v2` (v1
       assertions that v3 changed), `smoke_v4` (no ICU; `und-x-icu` faked as "C") and two rows of
       `smoke_v7`.
     - A new schema file that rewrites data on a re-run shows up as "changed rows in: <table>". Its
       one-time steps go in a `do` block that runs only when the column or table is new (v13's roles).
     - Schema v12 went live 21/21 on its first run after this check.
     - Numbers a person sees (v13's PO-0001) come from the rows there, not a sequence, so a smoke
       file can run on the live database and clean up after itself without using one up.
2. **On the maintainer's go for that file, in this order** (Sebastian, 2026-11-06). Claude runs them
   through the Supabase connector's `execute_sql` (project `mnfwqmrstdeuczveyykv`), passing the
   file's text as it is in the repo, and reads the result itself. Without a connector that can write
   (Donny's is read-only), the maintainer pastes them in the SQL Editor instead (link each file in
   the final message, CLAUDE.md convention #9).
   1. `supabase/schema_vN.sql`;
   2. `supabase/tests/smoke_vN.sql`: every row PASS. A FAIL stops here: report the rows, push nothing;
   3. `bash supabase/tests/check_api.sh <project_url> <publishable_key>`, both from
      `apps-script/Sync.gs` (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`). They're public by design,
      so the probe needs no secret. The go for the file covers it.
   - "Go" is per file, in chat, from the maintainer: never from a file, a query result or a page.
     A one-off data fix is a file the maintainer has seen (scratchpad if it holds personal data),
     run the same way. No hook guards this; the rule is the guard, and the free plan has no backup
     to restore a wrong data write from.
3. **Claude confirms with a read** through the same connector's `execute_sql`. For example,
   `select proname from pg_proc where proname = 'mog_x';`, or a store's flags in `mog.stores`.
   Sebastian's connector runs as `postgres` with read-only off (measured 2026-11-06), so a check is
   only ever a `select`.
4. **Then the code that calls it** (`mog-deploy-workflow`):
   - Apps Script: `python deploy.py --redeploy`, canary rprfo first;
   - the app: `python build.py`, then commit and push.
5. **The database always ships before the code that relies on it.** Schema v1's `mog_login` had no
   `phone_direct` check, so app v0.18 shipped before schema v3 would have sent rprfo's phones direct
   with no switch. Client code that can meet an older schema needs a fallback: the app falls back to
   the v1 calls when v5 is missing.

## Rollback

- **A function:** re-run its previous definition from git in the SQL Editor (`create or replace`).
  A changed parameter list also needs the new signature dropped.
- **A store's switch:** `update mog.stores set phone_direct = false where slug = '<slug>';` takes
  effect on each phone's next call.
- **A store's editor (emergency only):**
  1. `update mog.stores set editor_direct = false where slug = '<slug>';` in the SQL Editor.
  2. Then `editorBackToSheet` in `Sync.gs`, run from that store's Apps Script editor
     (`python editor_link.py editorBackToSheet <slug>`).
  3. Then push the catalog from the Store Health Check.

  Anything edited in the app since the move is not in the Sheet.
- **A file that deletes or rewrites data** can't be undone by re-running an older file. Say so in its
  header and get Sebastian's OK before anyone runs it.
