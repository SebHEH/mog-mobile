# Session Handoff — Supabase migration steps 1-5 + editor security fixes

**Session date:** 2026-10-15 → 2026-10-17 (one chat)
**Session focus:** Retire the Google Sheet from the app's path for speed: move counting to Supabase, then let the phones talk to it directly.
**Outcome:** Steps 1-5 of the migration are live on all 10 stores. Counts, the current day, overrides and the order log live in Supabase; cycles close at 3:30 AM in one transaction; every store's phones read and save straight to Supabase. On the canary, Settings showed "Supabase" with calls under 1s. rprfo's first nightly close ran on 10-17 and sent its recap. The step 6 measurement also exposed a PIN bypass on every store's `/exec` page and two data-loss bugs; all three are fixed and live on all 10 stores.
**Next session focus:** Step 6, the KM web editor on Supabase (static pages on GitHub Pages, Supabase owns the catalog). Designed, measured and approved (D15-D17); nothing built.

**Design record: `docs/MOG_SupabaseMigration.md`.** It holds every decision (D1-D18), the ownership table, the rollout steps and the measurements. Read it before touching this layer; this handoff only summarizes.

---

## Section A — The migration, steps 1-5 (all live)

**Measured first (2026-10-15, from Sebastian's PC against rprfo):**

| Request | Median |
|---|---|
| `/exec` doing no work | 1.70s |
| Supabase snapshot read (300 items) | 0.39s |
| Supabase count save | 0.32s |

The cost is per `/exec` request, so only leaving `/exec` removes it. Sebastian chose to proceed (D1-D4, D5-D8).

**What shipped, in order:**

- **Schema v1** (`supabase/schema.sql`):
  - a private `mog` schema reachable only through `public.mog_*` SECURITY DEFINER functions;
  - per-store sync keys (sha256), bcrypt PINs, 12-hour phone sessions.
  - Verified by `smoke.sql` (40/40) and `check_api.sh`.
- **Step 3** (`6584c10`):
  - `apps-script/OrderMath.gs` is one pure copy of the order math and the two payload builders, shared by the server and the phone.
  - `Sync.gs` builds the catalog payload and runs `test_supabaseParity`, which passed live on rprfo.
  - Gated by three Node gates (equivalence against `c0b6dfb` on 400 stores, phone parity, purity).
- **Step 4** (`d6b57e8` schema v2, `49db80f` code):
  - cycles close in Supabase in one transaction (`mog_sync_close_cycle`: logs, starts the new day, refuses a second close);
  - the 3:30 AM nightly run; the recap is built from `mog.order_log`; a nightly LOG_ORDERS backup;
  - `/exec` serves moved stores from Supabase (`DbApi.gs`), so old app versions keep working.
  - Copy-back into the Sheet was **rejected** by Sebastian ("remove the app writing to the sheet and back"). The Sheet now holds only the script, the catalog until step 6, and a backup (D9-D11).
- **Permission step** (`5b3ae50`):
  - Google's consent screen lets a person untick a scope listed in `appsscript.json`; a Sheet menu can't re-ask for it, and the editor only re-asks via `ScriptApp.requireScopes`.
  - `authorizeSupabase` (Sync.gs) does that request.
- **One-step move** (`00de566`):
  - **📱 Mobile API → Move this store to Supabase** replaces the separate Connect and Switch items. It takes one pasted connect code, confirms the store by name, then connects, copies the cycle and counts, installs the nightly run and switches.
  - [supabase/provision_stores.sql](../supabase/provision_stores.sql) makes every store's code in one query; it never re-keys a store that already connected.
  - When the permission is missing, the Move dialog shows Google's consent link.
- **Step 5** (`af39578`; schema v3):
  - the phone answers the count path itself from one shared snapshot plus `OrderMath.gs`, inside `api()`, with the same shapes `/exec` returns, so no screen code changed;
  - `mog.stores.phone_direct` is the per-store switch; Switch back to the Sheet turns it off first;
  - `build.py` copies `OrderMath.gs` and the Supabase config into each store page (invariant #5 now has 5 placeholders);
  - app v0.18.0, cache v54; Settings shows "Server: Supabase · N ms";
  - queued saves carry their day, so a save that arrives after its day closed lands in that day.
  - Gate: `tests/pwa_direct.test.js` (phone answers equal `/exec` answers, 9,298 compared).
- **Rollout:**
  - rprfo canary throughout;
  - 10-16: rprfo moved, then its phones went direct (Settings showed "Supabase", under 1s);
  - 10-17: rprfo's first close ran and its recap sent; Sebastian moved the other 9 stores and ran [supabase/phones_direct.sql](../supabase/phones_direct.sql); all 10 show `phone_direct = true` (`e37ef98`).

## Section B — Standing rules added (Sebastian's)

- **Convention #8** (`ec218dd`): every "run X in the Apps Script editor" request pastes `python editor_link.py <function> <store>`, which names the `.gs` file, the store, and the editor and Sheet links.
- **Convention #9** (`3adb2f8`): every next step that involves a file links it, in the turn's **final** message. The app collapses text written above a next-step question box into one line, so links placed there disappear; that happened this session.
- **Invariant #10** (`3b86411`): every server function is private unless it's on the reviewed list in `tests/public_surface.test.js`.

## Section C — Security and data fixes found while measuring step 6 (D18, all live)

Mapping the editor turned up three problems, now fixed in `3b86411`. They were canaried on rprfo, where Sebastian clicked through the web editor, the Sheet's dialogs, the menu items and `test_ping`. Then all 10 stores and the template.

- **PIN bypass.**
  - The web app runs as the owner for anonymous visitors, and Apps Script lets any page it serves call any **public** function. So anyone with a store's `/exec` URL (public in `stores.json`) could call the editor's save functions, `commitSelectiveReset`, `clearOrderLog` and `commitLogAndReset` directly, skipping the PIN.
  - Fix: 51 functions became private (79 → 33 public, each reviewed).
  - Pages and Sheet dialogs now reach the server only through `webedit_call`, and dialogs get a 6-hour token from their menu (`sheetBootJson_`). Admin Reset and Recalibrate need that Sheet token.
  - Public editor-run functions start with `requireEditorRun_()`.
  - This rests on Apps Script's documented rule plus the code (Editor.gs's header wrongly assumed the bare CRUD was Sheet-only). It was not reproduced live, because the browser pane couldn't open script.google.com.
- **`commitRemoveVendor` deleted the whole SETUP row,** which also removed a pick-path row, a storage area and a recipient. Now it deletes only R:AA and AF.
- **Every Manage Items save erased the item's Notes** (MASTER N), because the form never sends notes. Now a form without notes keeps them.
- Gates: `tests/public_surface.test.js` (static) and `tests/editor_fixes.test.js`. The latter loads the **whole** `.gs` codebase into one fake context; that works because every file is declarations only.

## Section D — Step 6 measured and designed (not built)

- **Measured on rprfo:**
  - each editor page is a `doGet` taking 1.1–3.1s of server time (Manage Items 8.5s cold);
  - each save is a `webedit_call` taking 2.6–6.2s;
  - `editorPing` runs in the background, about 1–1.8s.
  - So the fix is architectural, not tuning.
- **Approved (D15-D17):**
  - static editor pages on GitHub Pages that read and write Supabase directly;
  - Supabase owns the catalog in real tables, with today's catalog JSON built from them so the phones don't change;
  - each store's whole catalog flips at once behind an `editor_direct` switch, after every tool is ported and tested on a test store;
  - afterwards the Sheet gets a nightly catalog copy, and its own editing menus refuse that store.
- **Size:** about 6,600 lines of tool UI and 3,400 lines of server rules (Items/Vendors/PickPath). It's the biggest job of the migration.
- **The server-side map** (every RPC, every Sheet write, which writes exist only to keep Sheet structures in sync) is summarized in the design record. Rebuild it from the code when needed; nothing beyond that was saved.
- **The order the walkthrough proposed:**
  1. schema v4 tables plus a catalog parity gate;
  2. port Manage Items first (pars are the most-used edit);
  3. then Vendors, Areas, Shelf to Sheet, History, Health and Recipients;
  4. switch rprfo's editor and measure (target: page open and save each under 1s);
  5. then the other stores.

## Outstanding (carry forward)

1. **Step 6** (top). Start with the walkthrough's step 1: the schema v4 tables and the catalog parity gate. Canary rprfo, as always.
2. **"Move this store to Supabase" should turn `phone_direct` on by itself** (small). New stores currently need [supabase/phones_direct.sql](../supabase/phones_direct.sql) run by hand.
3. **Health Check rows**: moved to Supabase, catalog in sync, nightly run installed, phones direct.
4. **Two small findings left open:**
   - the setup wizard offers ĂN and Lei'd, but `commitStoreSetup_` rejects both concepts;
   - MASTER col O (eligible vendors) can drift from the pick rows (Shelf to Sheet save and vendor removal leave stale rows).
5. **Watch tnyt.** It flaked right after both 10-16 redeploys (a 31s POST, then a 27s 404 on GET) and cleared on retry each time. If it repeats, follow `mog-exec-repoint`.
6. **Docs debt:**
   - `mog-add-store` still teaches the pre-wizard flow, and has no Supabase steps (provision row, Move, phones);
   - the Rockville Sheets were copies of Tysons (their location names now read Rockville, but check their data);
   - loading-screen polish is parked until step 6 is done (memory: `project_polish_after_migration`).
7. Standing items from August, unchanged: Tier-2 `onboard.py`, audits at #20 / A11, the tnytf orphan deployment archive, disarming `FORCE_CLIENT_RELOAD`. Per-entity cache keys and the TABNAME/SHEETGID cleanup are now low value, since the Sheet path is retired.

## Files touched this chat

- **Supabase:**
  - `supabase/schema.sql`, `schema_v2.sql`, `schema_v3.sql`, `provision_stores.sql`, `phones_direct.sql`;
  - `supabase/tests/smoke.sql`, `smoke_v2.sql`, `smoke_v3.sql`, `check_api.sh` (17 checks).
  - Sebastian ran every schema and smoke file in the SQL Editor; all PASS.
- **Apps Script** (all 10 stores + template via `deploy.py --redeploy`, canary rprfo each time):
  - new: `OrderMath.gs`, `Sync.gs`, `DbApi.gs`;
  - changed: `MOGApi.gs`, `Core.gs`, `Editor.gs`, `EditorShell.html`, `Recap.gs`, `ResetLog.gs`, `Admin.gs`, `Items.gs`, `Vendors.gs`, `PickPath.gs`, `History.gs`, `Health.gs`, `Dashboard.gs`, `AdminReset.html`, `RecalibrateVendor.html`, `.clasp-targets.json` (Sheet ids).
- **PWA:**
  - `template/index.html` (DIRECT CLIENT, `api()` routing, queue cycle dates, Settings Server row, v0.18.0), `template/sw.js` (v54);
  - `build.py` (OrderMath + Supabase injection);
  - all 10 generated store dirs, rebuilt and pushed.
- **Tooling and tests:**
  - `editor_link.py`;
  - `tests/` (10 gates: `ordermath_*`, `supabase_step4`, `supabase_move`, `pwa_direct`, `public_surface`, `editor_fixes`, `editor_link`, `slice_js_selftest`; helpers `fake_apps_script.js`, `fake_supabase.js`, `mog_fixture.js`, `run_all.js`).
- **Docs:**
  - `docs/MOG_SupabaseMigration.md` (new), `docs/MOG_LogicBlueprint.md` + `.html` (bumped to `e37ef98`: R13, R14, R15, new R23, R24), this handoff, `docs/MOG_CurrentState.md`;
  - `CLAUDE.md` (conventions #8, #9, invariants #5, #10, inventory), `README.md`, `tests/README.md`;
  - skills `mog-add-store` and `mog-health-check-extend`.

## Process lessons

- The app collapses the text written above a next-step question box into a one-line summary, so file links and instructions placed there vanish. Put them in the final message, under a box with no question. [→ CLAUDE.md, memory feedback_link_files_in_next_steps]
- A scope listed in `appsscript.json` can still be missing for a person: Google's consent screen lets them untick it, a Sheet menu cannot re-ask, and running another function from the editor doesn't either. Only `ScriptApp.requireScopes` re-asks. A menu can show `getAuthorizationInfo(...).getAuthorizationUrl()` as a link. [→ apps-script/Sync.gs, proposal appsscript-oauth-scopes-2026-10-17]
- With `executeAs: USER_DEPLOYING` + `access: ANYONE_ANONYMOUS`, every PUBLIC function is callable from any page the script serves, so a token dispatcher protects nothing unless what it guards is private. Menus and installable triggers can call private functions. Keep a static gate on the public list. [→ CLAUDE.md, tests/public_surface.test.js, proposal appsscript-sheet-modal-app-2026-10-17]
- Every `.gs` file is declarations only, so the WHOLE codebase loads into one Node vm context with the fakes, and any server function can be tested at runtime without slicing. [→ tests/README.md]
- A fake's READ must never create rows (`countsFor` did, which faked a "changed something" failure). [→ tests/fake_supabase.js]
- A store that flakes right after redeploys (tnyt, twice) is worth watching as an early sign of `/exec` rot. [→ mog-exec-repoint]
- Ship the database switch before the app that relies on it. Schema v1's `mog_login` had no `phone_direct` check, so shipping app v0.18 before schema v3 would have sent rprfo's phones direct with no switch. [→ docs/MOG_SupabaseMigration.md]

## Commits landed this session

```
e37ef98 supabase: phones_direct.sql; every store's phones now talk to Supabase
e7f615a docs(supabase): D18 rollout - canary rprfo passed, then all 10 stores + template
3b86411 fix(security): server functions private behind the PIN-checked door; vendor removal and Notes fixes
3adb2f8 docs(CLAUDE.md): convention #9 - every next step that involves a file links it
af39578 feat(supabase): step 5 - phones talk to Supabase directly, per-store switch
00de566 feat(supabase): one-step "Move this store to Supabase" + provision_stores.sql
5b3ae50 fix(supabase): authorizeSupabase asks for the external-request permission by name
49db80f feat(supabase): step 4 - cycles close in Supabase, /exec serves switched stores from it
d6b57e8 supabase: schema v2 - order log, one-transaction cycle close, sync-key snapshot/override calls
ec218dd tooling: editor_link.py names the file for every "run this in Apps Script" request
6584c10 refactor(order-math): shared OrderMath.gs + read-only Sync.gs, gated by tests/
a401999 supabase: schema v1, smoke + public-key checks, migration design record
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md and docs/MOG_SupabaseMigration.md first. As of 2026-10-17, steps
1-5 of the Supabase migration are live on all 10 stores: counts, the current day, overrides and
the order log live in Supabase; cycles close at 3:30 AM in one transaction; every store's phones
read and save straight to Supabase (phone_direct = true, Settings shows "Supabase"). The D18
security fix is live too: every server function is private except the reviewed list in
tests/public_surface.test.js (CLAUDE.md invariant #10).

Next: step 6, the KM web editor on Supabase. It's designed, measured (pages 1.1-3.1s,
saves 2.6-6.2s of server time) and approved (D15-D17): static pages on GitHub Pages, Supabase
owns the catalog in real tables (today's catalog JSON built from them, so phones don't change),
whole-catalog flip per store behind an editor_direct switch, Sheet gets a nightly copy with its
own editing locked. Start with schema v4 + a catalog parity gate, then port Manage Items first,
against a test store. Small items to fold in: Move to Supabase should turn phone_direct on by
itself; Health Check rows for the Supabase state; watch tnyt for /exec rot.

Rules: node tests/run_all.js before any deploy (10 gates); canary rprfo; schema files are run by
Sebastian in the SQL Editor; every editor-run request pastes editor_link.py output; every next
step that involves a file links it in the final message.
```
