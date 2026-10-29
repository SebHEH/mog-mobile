---
name: mog-supabase-schema
description: MOG's specializer for any change to the Supabase layer (a supabase/*.sql file, a new or changed public.mog_* function, a new mog.* table or column), stemming off the global supabase-schema-change skill. Pins the files every schema version touches (schema_vN.sql, smoke_vN.sql, check_api.sh, tests/fake_supabase.js, the migration doc's function table), the ship order (Sebastian or Donny runs the SQL first, then the gates, then deploy.py --redeploy on the rprfo canary, then build.py), the probe rule that keeps a real store's PIN lockout untouched, and how to check the live database read-only. Trigger on "add a Supabase function", "a new column in mog.items", "schema v10", "write the migration", "check_api failed", "PGRST205", or any edit under supabase/. Skip when only reading live data (query the read-only connector directly) and for a new store's provisioning (mog-add-store).
---

# mog-supabase-schema

Supabase is MOG's operational store: counts, the cycle, the order log, the catalog, recipients and
People. The phones and the app reach it with the publishable key, so **the schema is the security
boundary**. Tables live in the private schema `mog`; the only way in is the `public.mog_*`
functions, each checking a PIN session token or a store's sync key first.

**The general method is the global `supabase-schema-change` skill:** the lockdown block, dropping an
old signature, `notify pgrst`, the smoke harness, the public-key probe, a fake that copies the
constraints. It was proposed on 2026-10-20. Until the Claude-SKills repo applies it, read the
proposal: `~/.claude/skills/_global-skill-proposals/supabase-schema-change-2026-10-20.md` (or its
copy under `_archive/` once reviewed). This skill pins MOG's files and order on top of it.

Design records, read the relevant one before designing a change:
- [docs/MOG_SupabaseMigration.md](../../../docs/MOG_SupabaseMigration.md) (section 7 is the table
  of every function, its caller and its credential);
- [docs/MOG_OneApp_Spec.md](../../../docs/MOG_OneApp_Spec.md).

## A change is the next version

The current version is in `docs/MOG_CurrentState.md` ("schema v9" as of 2026-10-20). A change ships
as a new `schema_vN.sql`, never as an edit to a file already run: each file is run once, in order.
Re-running any of them must stay harmless.

**Two maintainers run SQL** (CLAUDE.md, Two maintainers): `git pull` before writing the next
`schema_vN.sql`, and tell the other person which number you're taking, so you never both write v10.

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
- **SQL gotchas met here:**
  - `-` binds tighter than `->` (smoke_v6);
  - `now()` never moves in one DO block (smoke_v5);
  - the vendor list sorts with `und-x-icu` to match `localeCompare` (schema_v4, pinned by smoke_v4);
  - a regex over a SQL file counts commented-out rows, so strip `--` first (`mog-add-store`'s
    `validate.py`).

## Ship order

1. **Claude writes every file above**, and `node tests/run_all.js` passes.
2. **The maintainer (Sebastian or Donny) runs, in the Supabase SQL Editor, in this order** (link each file in the final
   message, CLAUDE.md convention #9):
   1. `supabase/schema_vN.sql`;
   2. `supabase/tests/smoke_vN.sql`: every row PASS;
   3. `bash supabase/tests/check_api.sh <project_url> <publishable_key>`, both from
      `apps-script/Sync.gs` (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`). They're public by design,
      so the probe needs no secret. It calls the live project, so ask before running it yourself.
3. **Claude confirms read-only** with the Supabase connector's `execute_sql` on project
   `mnfwqmrstdeuczveyykv` (memory `reference_supabase_connector`). For example,
   `select proname from pg_proc where proname = 'mog_x';`, or a store's flags in `mog.stores`.
   Never write; writes stay with the maintainers, in the SQL Editor.
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
