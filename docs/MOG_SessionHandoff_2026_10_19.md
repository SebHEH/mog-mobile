# Session Handoff — MarginEdge import, Phase 4 editor tools, Rockville BOH moves to the app

**Session date:** 2026-10-18 → 2026-10-19 (one chat)
**Session focus:** pull items from MarginEdge instead of typing them in (TNY Rockville first), then Phase 4 of the one-app spec: the remaining catalog tools on Supabase and the per-store switch.
**Outcome:**
- **Import from MarginEdge** is built into the Supabase editor: a CSV upload, vendors first, then items.
- **Manage Vendors, Storage Areas and Shelf to Sheet** run on Supabase, gated against the real `.gs` code.
- **Schema v8** is installed (smoke 18/18, check_api 43/43), and the Apps Script is on all 10 stores + template, every `/exec` healthy.
- **TNY Rockville BOH (`tnyr`) has moved**, starting empty. Its editor is live at `sebheh.github.io/mog-mobile/tnyr/editor/`, and every store app is on v0.21.0 / cache v61.

**Next session focus:** a mockup artifact of design options for switching between the order guide and the editor on a computer (Sebastian, 2026-10-19), then build the one he picks; after that the rest of Phase 4 (History, Health, Recipients, People) before rprfo moves.

---

## Section A — Import from MarginEdge (decisions M1-M5)

- **Source (M1):** MarginEdge's **Vendor Items export** (`vendorItems.csv`), uploaded on a computer.
  - Its columns: Vendor, Vendor Item Name, Product, Category, Item Code, Last Purch Date, Last Purch $, Order Guide.
  - The Purchase Report adds only quantities, so the import doesn't use it. A Purchase Report uploaded by mistake is refused with a message saying so.
  - MarginEdge's read-only API (`x-api-key`; vendors, vendor items, packaging) would add pack sizes. It needs a key from MarginEdge and a server to hold it, so it isn't built.
- **Where (M2):** the Supabase editor only, as a "⬇ Import from MarginEdge" button in the host bar on Manage Items (`template/editor/meImport.js`).
  - It saves through `catalogEdit.js` `commitImportItems`: one logged change, undoable.
  - It has no `Items.gs` twin, so a store uses it only once its editor has moved.
- **Names (M3):** the MarginEdge product name (e.g. "Butter, Unsalted"), editable before importing.
  - Each MarginEdge vendor that sells a product becomes one of its vendors; the vendor bought from most recently is the primary (R6).
- **Two steps (M5, Sebastian):** vendors first, then items.
  - **Step 1:** map each vendor to a store vendor, a new one, or skip it. Every new vendor ticked here is added, with items or not.
  - **Step 2:** lists only products a ticked vendor sells.
- **Ticked to start:**
  - **Items:** not in the store yet (by name or item code), in a restocked category (not equipment, furniture, repairs, linen, office or services), and bought in the file's last 60 days.
  - **Vendors:** already in the store, or selling a ticked item.
- **On Rockville's real file:** 540 products from 34 vendors; 410 ticked with 25 new vendors before the two-step change.
- **Imported items:** active, with no par, pack or storage area (Import Vendor's contract), so they wait under Unassigned. New vendors have no delivery days.
- **Gate:** `tests/me_import.test.js` (13 planted defects), plus one import through the host in `editor_host`.

## Section B — Phase 4: the catalog tools on Supabase and the switch (decisions S1-S5)

- **S1, ports:** `catalogEdit.js` ports Manage Vendors (add, import, update, remove), Storage Areas (the draft save) and Shelf to Sheet (read, reorder).
  - `catalog_edit` runs them on 100 random stores next to the real `Vendors.gs` / `PickPath.gs` on the fake Sheet: 10 write calls, 16 planted defects.
  - Intended differences:
    - removing a vendor keeps its items active with no primary vendor (D23 → blueprint R27; the Sheet deactivates them);
    - names the database can't hold (vendor over 100 characters, item over 300) are refused;
    - in the gate's phone catalog, a blank par is 0 on the Sheet and null in the tables.
- **Renames (schema v8):**
  - An area rename is one `{ rename: 'areas', from, to }` step, so its pick rows follow (on update cascade). A delete plus an add would have taken them with the delete.
  - A swap, or a rename into a deleted area's name, goes through a temporary name. Undo renames back.
- **Save order:** renames, then pick-row and area deletes, then inserts and updates (vendors, areas, items, pick rows), then item and vendor deletes. So a vendor's items let go before the vendor goes.
  - `editor_host` runs every tool through the fake Supabase's link rules, undoes and redoes each, and has two planted save-order defects.
- **S2, no copy back (Sebastian, replaces D17's nightly copy):** a moved store's Sheet keeps the catalog it had and is never updated.
  - Its catalog tools refuse and point to the app: the Sheet menu openers, `webedit_call`'s catalog writes, the Health Check's catalog repairs, catalog pushes, and the `/exec` editor pages for those four tools.
  - Gate: `editor_fixes`.
- **S3, the switch:** 📱 Mobile API → **Move the editor to the app** (`Sync.gs` `moveEditorToApp_`).
  - **Start empty:** you type the store code to confirm, and the store's catalog tables are cleared.
  - **Copy:** it seeds from the Sheet with `mog_sync_seed_catalog`. **It doesn't run the parity check itself yet**: run `test_catalogTablesParity` first.
  - Then it calls `mog_sync_switch_editor` and sets the Sheet's `MOG_EDITOR` property.
  - A Sheet that missed the switch gets a Health Check warning with a one-click fix (`mark_editor_in_app`).
  - Emergency rollback: `editorBackToSheet` in Sync.gs, plus a SQL `update`.
- **S4, page refactors:** Storage Areas and Shelf to Sheet read their data in their start-up function, so the static host can supply it after sign-in. Nothing changes in the Sheet or `/exec`.
- **Static pages:**
  - `build.py` renders Editor Home, Manage Items, Manage Vendors, Storage Areas and Shelf to Sheet. It publishes them at `<slug>/editor/` for a store marked `"editor": "supabase"` in `stores.json`, and builds them for `--preview`.
  - `BASE_URL` is `index.html`, so Editor Home's `?page=x` sends you on to `x.html`. History and Health show as coming soon.
  - The host bar has **← Ordering**, and sits above the Save footer on Storage Areas and Shelf to Sheet.
- **The app (v0.21.0, cache v61):**
  - Settings → **Editor** appears on a computer (mouse and ≥900px) once the snapshot says `editorDirect`. It hands the app's session token to the editor, so there's no second PIN.
  - The store service worker caches only the app's own page. Before, an editor page opened online would have replaced the cached offline app.
- **S5, Rockville first:** Sebastian ran the switch in the **BOH** Sheet (start empty). FOH (`tnyrf`) stays on the Sheet for now, by his call.
- **Deploys:**
  - schema v8 (Sebastian; smoke 18/18; check_api 43/43);
  - Apps Script `--redeploy`: canary rprfo, which Sebastian checked, then all 10 + template, every `/exec` GET and POST healthy;
  - `build.py` + push. The editor went live on Pages after ~40s and loads to the PIN screen with no errors.

## Outstanding (carry forward)

1. **Set up Rockville BOH in its editor**:
   - Import from MarginEdge;
   - delivery days in Manage Vendors;
   - storage areas;
   - each item's area and par;
   - Shelf to Sheet order.

   Sign-in and the import haven't been tried live (they need the store PIN).
2. **The computer switch between the order guide and the editor.** Next session starts with a **mockup artifact of the design options** (Sebastian chose that over picking from the walkthrough).
   - Options walked through: a shared top strip on both sides (store name + Order guide | Editor tabs; recommended), or a button in each app's own header.
   - Decided: once the switch exists, **remove** the app's Settings → Editor row and the editor's "← Ordering" button.
   - Known limit: opening the editor directly, then clicking Order guide, asks for the PIN once, because History, Recipients and the reset fallback still use `/exec` with the PIN.
3. **Make "copy the Sheet's catalog" refuse unless the parity check passes.** It switches today even if `test_catalogTablesParity` would fail. Do this before any store copies its catalog (rprfo is next).
4. **Rest of Phase 4 before rprfo moves:**
   - History, with the order log backfilled from LOG_ORDERS and the par flags in shared JS (E4);
   - Health;
   - Recipients;
   - People.
5. **Rockville FOH (`tnyrf`)** moves when Sebastian decides: start empty plus MarginEdge, like BOH.
6. **Unused stores' parity:** rpt, rptfo and rpfrf need Health Check → "Storage areas on pick rows" → Fix before they can copy their catalog.
7. **Later:**
   - the MarginEdge API (pack sizes);
   - the recap email sent from Supabase (Sebastian: "ideal but not needed asap");
   - the setup wizard still rejects ĂN and Lei'd;
   - `mog-add-store` lacks the Supabase steps.

## Files touched this chat

- **Editor (static, Supabase):**
  - `template/editor/catalogEdit.js` (4 tools, renames, save order, CSV reader);
  - `template/editor/meImport.js` (new);
  - `template/editor/host.js` (pages, links, page data, Import button, ← Ordering).
- **App:** `template/index.html` (Settings → Editor, v0.21.0), `template/sw.js` (shell-only caching, v61).
- **Build:**
  - `build.py` (five editor pages, `"editor": "supabase"` publishing);
  - `stores.json` (`tnyr`);
  - `.claude/launch.json` (`mog-static-alt` on 8767).
  - All 10 store folders rebuilt, plus `tnyr/editor/` (generated).
- **Apps Script** (all 10 stores + template):
  - `Sync.gs` (Move the editor to the app, refusals, `editorBackToSheet`);
  - `Editor.gs` (catalog-write refusals, moved page);
  - `Health.gs` (row + `mark_editor_in_app`, repairs refuse);
  - `MOGApi.gs` (doGet);
  - `Core.gs` (menu);
  - `Items.gs` / `Vendors.gs` / `PickPath.gs` (openers refuse);
  - `StorageAreas.html`, `ReorderPickPath.html` (start-up refactor).
- **Supabase:**
  - `supabase/schema_v8.sql` (generated from v6's function text plus the new parts);
  - `supabase/tests/smoke_v8.sql`;
  - `supabase/tests/check_api.sh`.
- **Tests:**
  - new `me_import`;
  - extended `catalog_edit`, `editor_host`, `editor_fixes`, `health_supabase`, `public_surface`;
  - fakes `fake_apps_script.js` (tab copies, A1 ranges, `insertRowsAfter`, `parseCsv`) and `fake_supabase.js` (rename step, slice plan);
  - `tests/README.md`.
- **Docs:**
  - `docs/MOG_OneApp_Spec.md` (M1-M5, S1-S5);
  - `docs/MOG_SupabaseMigration.md` (D17 revised, API row, step 6.4);
  - `docs/MOG_LogicBlueprint.md` + `.html` (R23, new R27, MarginEdge row);
  - `CLAUDE.md` (inventory);
  - this handoff;
  - `docs/MOG_CurrentState.md`.

## Process lessons

- Python patch scripts sent through a Bash heredoc lost their backslashes three more times (`\\n` in build.py's head string, `\\r`/`\\n` in the fake's CSV parser). Write any script containing backslashes with the Write tool and run it from the scratchpad. [→ memory reference_bash_heredoc_backslashes]
- An Apps Script page that reads its baked data (`<?!= ...Json ?>`) at parse time can't run on the static host, which only has the data after sign-in. Read it in the page's start-up function. [→ apps-script/StorageAreas.html]
- Every navigation inside a store's folder hit the service worker's "cache as the app shell" path, so a page added under `/<slug>/` (the editor) would have replaced the offline app. Cache only the app's own page. [→ template/sw.js]
- On the database, an area rename sent as delete plus insert loses its pick rows (on delete cascade), and a vendor deleted before its items are updated trips a CONFLICT (on delete set null). The editor's op order and its rename step exist for these. Check new writes against the fake Supabase's link rules, not just `applyOps`. [→ template/editor/catalogEdit.js]
- A constant used by a function that a gate loads by slicing must be added to that gate's slice plan (`supabase_step4` failed on `CATALOG_WRITE_ACTIONS_`). [→ tests/fake_supabase.js]
- `.claude/launch.json`'s server hard-codes port 8765, so when another chat's server holds it the preview starts on a port nothing listens on. `mog-static-alt` (8767, `autoPort: false`) is the fallback. [→ memory feedback_preview_urls]
- Don't write behavior into the blueprint that the code doesn't enforce yet: "copied after the parity check" became "the menu doesn't enforce that check yet". [→ docs/MOG_LogicBlueprint.md]

## Commits landed this session

```
09b3279 build: Rockville BOH's editor moves to the app (v0.21.0, cache v61)
b0f53aa feat(editor): one app, Phase 4 - Manage Vendors, Storage Areas, Shelf to Sheet on Supabase, and the switch
62a356d feat(editor): Import from MarginEdge (Supabase editor only)
```

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md, docs/MOG_OneApp_Spec.md and docs/MOG_SessionHandoff_2026_10_19.md
first. As of 2026-10-19: schema v8 is installed; Manage Items, Manage Vendors, Storage Areas and
Shelf to Sheet run on Supabase (catalogEdit.js + host.js), with Import from MarginEdge (vendors,
then items); TNY Rockville BOH (tnyr) moved its catalog to the app, starting empty, and its editor
is live at sebheh.github.io/mog-mobile/tnyr/editor/. FOH (tnyrf) and every other store are still
edited in their Sheets. App v0.21.0 / cache v61 everywhere.

Next: build a mockup artifact of design options for switching between the order guide and the
editor on a computer (a shared top strip on both, or a button in each header; see the handoff's
Outstanding item 2), go over it with Sebastian, then build the one he picks and remove the old
Settings -> Editor row and the editor's "<- Ordering" button. Then make "copy the Sheet's catalog" refuse unless test_catalogTablesParity passes, and port
History, Health, Recipients and People before rprfo moves.

Rules: node tests/run_all.js before any deploy (18 gates); canary rprfo first; schema files are run
by Sebastian; preview with python build.py --preview rprfotest --like rprfo and the mog-static
server (mog-static-alt on 8767 if 8765 is busy); every next step that involves a file links it in
the final message.
```

---

## Later session — one app on a computer, Phase 4's rest, and every store moved

**Session focus:** the computer switch between the order guide and the editor, then the rest of Phase 4, then (Sebastian, after seeing the first version live) a unified computer look and every store's editor moved.
**Outcome:** 6 commits (`30c08ce`→`7f23850`), all pushed.
- Schema v9 is installed (smoke 39/39, check_api 58/58).
- App v0.26.0 / cache v66 on every store; Apps Script on all 10 stores + template.
- **All 10 stores' editors are in the app** (checked in Supabase).
- 21 gates.

**Next session focus:** watch the first night with every store on the app, set up the three empty stores, and bring new-store onboarding up to date.

### Section A — The computer switch (decisions L1-L4)

- **One rail for the order guide and the editor** (`30c08ce`, v0.22.0):
  - Today keeps its vendor list on the left while a count opens beside it.
  - Clicking another vendor saves the open one first.
  - History and Settings sit in a centered column.
  - Settings → Editor and the editor's "← Ordering" went.
- **The move refuses a copy that fails parity** (`06ec8a8`): Move the editor to the app copies a Sheet's catalog only after `test_catalogTablesParity`'s check passes, and says why when it refuses.

### Section B — Phase 4's rest, schema v9 (decisions T1-T4, `ca6df8f`, v0.23.0)

- **T1, order history:** the switch copies LOG_ORDERS dates the database lacks (copy path only).
  - The phone's History tab, the editor's Order History and the Par Review flags then read `mog.order_log`.
  - History and par-flag math moved into `OrderMath.gs` (`historyRowsFiltered_` … `parReviewFlags_`), so the Sheet, the phone and the editor run the same code.
  - Gate: `history_app`.
- **T2, recipients:** `mog.recipients`, copied at the switch (and once by the nightly run for a store already moved).
  - Settings → Recipients reads and saves Supabase. The GM row is locked on a phone and editable on a computer.
  - The nightly email reads the list there, falling back to the Sheet's if Supabase is down.
- **T3, People:** Settings → People on a computer, every store.
  - Rename follows to devices using the old name.
  - A removed name isn't re-added by devices (`removed_at`, `renamed_to`).
- **T4, Health:** in the app.
  - Store checks: phones, last night's close, lockout.
  - Catalog checks, with Place backups (logged, undoable) and Clear lockout.
  - Gate: `health_app`.
- Gates `history_app`, `recipients_people`, `health_app` are new.

### Section C — The computer redesign, three phases (decisions U1-U11)

Mockup: https://claude.ai/artifact/5AzTC1GpAYepis3kPrxzHr. Sebastian picked the brand-panel sign-in, one Order history entry, one shell, three phases, Changes as a page, and "Shelf to Sheet done after its first save".

- **Phase 1, one shell** (`86073cc`, v0.24.0):
  - A 248px sidebar replaces the rail: the concept's circular logo and the store, then Order guide (Today, Order history) and Manage (Overview, Items, Vendors, Storage areas, Shelf to Sheet, Health check). Changes and Settings sit at the bottom.
  - Each Manage page is the editor's own page in a frame (`editor/<page>.html?embed=1`), so switching never reloads the app.
  - host.js embed mode:
    - takes the app's session, and asks the app for a fresh one (`window.MOG_SHELL.token`) instead of a PIN;
    - routes `?page=` links to the app;
    - hides the floating bar.
  - EditorShell embed branch: no band, breadcrumb or EN/ES; the title is the header.
  - Unsaved edits ask first through the page's own `MGE_LEAVE_GUARD`.
  - An editor page opened by itself on a computer forwards to `../#<page>`.
  - Order history is the editor's where the editor moved.
  - New `template/editor/Changes.html`: `build.py` builds pages from `template/editor/` as `editor:<name>`.
- **Phase 2, the Overview** (`61cfc9b`, v0.25.0):
  - `template/editor/Overview.html` shows:
    - today's order, from the app's dashboard via `MOG_SHELL.today`;
    - counts, using `catalogEdit.js getOverviewCounts` (the Health Check's rules);
    - the setup checklist, hidden for good once done (a per-store localStorage flag);
    - Needs attention: phone edits with Apply/Dismiss, Par Review, Health;
    - Recent changes with Undo.
  - The flash fix: inside the app a page stays hidden (`mge-embed-boot`) until its header mounts.
  - **Every `stores.json` entry is now `"editor": "supabase"`**, so every store's editor pages are published, and Manage shows once Supabase says the store moved (U11).
- **Phase 3, the look** (`7f23850`, v0.26.0):
  - The computer sign-in has a brand panel: concept color, circular logo, and the place and concept, which `build.py` now puts in `MOG_STORE`.
  - A script in `<head>` sets `desk` and `restoring` before the first paint, so a reload while signed in shows a "Signing in…" splash, not the PIN screen.
  - On a computer the top bar and the breadcrumb move into `#desk-head` over the pane they title. The split view is a grid. Today, History and Settings keep their own titles; Recipients and People keep Back.
  - EN/ES is in the sidebar.
  - The circular logos are one hidden SVG sprite (`#mog-logo-rp/tny/an`) drawn with `<use>`.

### Section D — Every store moved (U10)

- **Order of events:**
  - Sebastian ran 📱 Mobile API → Move the editor to the app in every Sheet.
  - Supabase shows `editor_direct` on for all 10.
  - Seven copied their catalog: rpr, rprfo, tnytf, rpt, rptfo, rpfr, rpfrf.
  - Rockville BOH, Rockville FOH and **Tysons BOH** started empty. tnyt had never been counted in the app, and Sebastian confirmed empty was intended; I had misread his earlier answer.
- **tnyt's `/exec` flaked** (~40% of POSTs, one GET) after the phase 3 push, which touched no Apps Script.
  - A fresh deployment (`AKfycbzdV2Ba…OVMm9g` @81) flaked the same way, so it wasn't rot.
  - ~15 minutes later both answered 12/12 beside two other stores. Nothing was repointed; the fresh deployment is unused.

## Outstanding (carry forward)

1. **Tomorrow morning:** every store's 3:30 AM close and recap email. Tonight is the first night every store reads recipients from Supabase; check rpr, rprfo and tnytf's emails arrived.
2. **Recipients on the empty stores:**
   - tnyr has none yet (tonight's run copies its Sheet's list once);
   - tnyrf and tnyt copied theirs at the move.
   - Rockville's Sheets are copies of Tysons, so the lists may be Tysons' people: check Settings → Recipients before they order.
3. **Set up tnyr, tnyrf, tnyt** from each one's Overview checklist (MarginEdge import, delivery days, areas, item areas and pars, Shelf to Sheet).
4. **Tell whoever edited in the Sheets** that those Sheets are frozen (S2).
5. **New-store onboarding** (`mog-add-store`) lacks the two Sheet moves (Move this store to Supabase, Move the editor to the app). Do it before the next store opens.
6. **Later:**
   - keep visited Manage pages alive, for instant switching;
   - a Health dot in the sidebar;
   - a circular logo for Lei'd;
   - the Daily summary button and the reset fallback are the last `/exec` uses;
   - the recap email from Supabase;
   - the setup wizard still rejects ĂN and Lei'd;
   - tnyr's order log has bogus Oct 17-19 closes from the copied Tysons catalog.

## Files touched this chat

- **App:**
  - `template/index.html`: sidebar, Manage frame and routing, `MOG_SHELL`, the head script, sign-in panel, splash, `#desk-head`, sprite, People, Recipients GM toggle, direct history;
  - `template/sw.js`.
- **Editor:**
  - `template/editor/host.js` (embed mode, overview API);
  - `catalogEdit.js` (`getOverviewCounts`, Health Check);
  - new `Changes.html` and `Overview.html`;
  - `apps-script/EditorShell.html` (embed branch).
- **Apps Script:** `OrderMath.gs` (history + par flags), `History.gs`, `Items.gs`, `MOGApi.gs`, `Sync.gs` (backfill, recipients seed, parity refusal), `Recap.gs`, `Admin.gs`.
- **Supabase:** `supabase/schema_v9.sql`, `supabase/tests/smoke_v9.sql`, `supabase/tests/check_api.sh`.
- **Build:** `build.py` (`editor:` pages, the store profile), `stores.json` (every store's editor published).
- **Tests:**
  - new `history_app`, `recipients_people`, `health_app`, `phone_harness.js`;
  - updated `editor_host` (embed), `catalog_parity`, `pwa_direct`, `ordermath_purity`, the fakes and `tests/README.md`.
- **Docs:**
  - `docs/MOG_OneApp_Spec.md` (T1-T4, L1-L4, U1-U11);
  - `docs/MOG_SupabaseMigration.md`;
  - `docs/MOG_LogicBlueprint.md` + `.html` (R23, R25, the diagram, recipients, boundaries);
  - `CLAUDE.md`;
  - this handoff;
  - `docs/MOG_CurrentState.md`;
  - `.claude/skills/mog-exec-repoint/SKILL.md`.
- **Generated:** every store's dir and `<slug>/editor/`.

### Process lessons

- When a store's `/exec` flakes, test a freshly cut deployment before repointing. If it flakes too it isn't rot: re-probe beside other stores instead. [→ .claude/skills/mog-exec-repoint/SKILL.md]
- An editor page's in-Sheet HTML paints before its chrome mounts, so inside the app it has to be hidden from `<head>` until `mgeMountWebChrome_` runs. [→ template/editor/host.js]
- A gate control's anchor must stay unique. New code that repeats an anchored line (a copied `const active = …`) crashes that control: name new locals differently. [→ tests/README.md]
- In the browser pane, navigating to the same page with only a new `#hash` doesn't reload it. After a rebuild, use `location.reload()`. [→ memory reference_fake_supabase_preview]
- Check stores' real state with the Supabase connector (project `mnfwqmrstdeuczveyykv`, read-only `execute_sql`) instead of asking. It found tnyt had moved empty. [→ memory reference_supabase_connector]

## Commits landed this session (later)

```
7f23850 feat(app): computer sign-in, pane headers and no PIN flash on a reload (v0.26.0, cache v66)
61cfc9b feat(editor): the Overview, no flash inside the app, and every store's editor published (v0.25.0, cache v65)
86073cc feat(app): one shell on a computer - the sidebar, and the Manage pages inside the app (v0.24.0, cache v64)
ca6df8f feat: one app, Phase 4's rest - order history, recipients, People and the Health Check move with the editor (schema v9, app v0.23.0, cache v63)
06ec8a8 fix(sync): Move the editor to the app copies a Sheet's catalog only after the parity check passes
30c08ce feat(app): computer layout - one rail for the order guide and the editor (v0.22.0, cache v62)
```

## Opening prompt for next session (supersedes the one above)

```
Read docs/MOG_CurrentState.md, docs/MOG_OneApp_Spec.md and docs/MOG_SessionHandoff_2026_10_19.md
(the Later session block) first. As of 2026-10-19 every store's editor is in the app (Supabase
owns each catalog, order history and recipients list); on a computer the order guide and Manage
share one sidebar, with Manage pages in a frame (?embed=1). App v0.26.0 / cache v66, schema v9.

First: check that last night's 3:30 AM close ran and every store's recap email arrived
(recipients now come from Supabase), and look at Settings -> Recipients on tnyr, tnyrf and tnyt.
Then: help set up the three empty stores from their Overview checklists, and bring new-store
onboarding (mog-add-store) up to date with the two Sheet moves.

Rules: node tests/run_all.js before any deploy (21 gates); schema files are run by Sebastian;
preview with python build.py --preview rprfotest --like rprfo plus the scratch fake server;
read-only checks via the Supabase connector (project mnfwqmrstdeuczveyykv); every next step
that involves a file links it in the final message.
```

---

## Later session (3) — new-store onboarding, and all four concepts in setup

**Session focus:** bring `mog-add-store` up to date now that every store's editor is in the app (a side session started from the one above), then fix the gaps it found.
**Outcome:** 1 commit (`4720ff2`), pushed.
- Apps Script is on all 10 stores + template. Canary rprfo was checked by Sebastian, and every `/exec` answers GET and POST.
- GitHub Pages serves hub cache v11.
- 22 gates.

**Next session focus:** unchanged from the block above (the first night with every store on the app, setting up the three empty stores), plus the runbook's first real use.

### Section A — The new-store runbook

- **[.claude/skills/mog-add-store/SKILL.md](../.claude/skills/mog-add-store/SKILL.md) rewritten.** A new store follows 11 steps and ends in the same state as the other ten (phones direct, editor in the app, Sheet frozen):
  1. copy the master template (never a live store's Sheet);
  2. the Script ID, and a check that Script Properties hold no `MOG_SUPABASE_*`, `MOG_BACKEND` or `MOG_EDITOR`;
  3. deploy the web app in the editor (its Authorize step is the OAuth grant);
  4. a `.clasp-targets.json` entry with `deploymentId` and `sheet`, a `provision_stores.sql` row, then `deploy.py --redeploy --target <slug>`;
  5. the `?page=setup` wizard, Set Master PIN, then Status (which copies the GM email into the recipients);
  6. `provision_stores.sql` for the connect code;
  7. Move this store to Supabase;
  8. Move the editor to the app, start empty;
  9. `stores.json` with `"editor": "supabase"`, the hub cache bump, `build.py`;
  10. the Overview checklist (Import from MarginEdge first);
  11. a smoke test, then the next morning's close.
- **Publishing comes after both moves,** so no phone ever counts into the new Sheet.
- **Why the old runbook fell short:**
  - it predated Supabase (no connect code, no moves);
  - it still taught `setupMobileApi_`'s prompts;
  - it had no `provision_stores.sql` row or `sheet` block, which the `supabase_move` gate needs;
  - it missed the hub cache bump.
- **`scripts/validate.py`** gained five checks:
  - `slug`: Supabase's rule, and unused in all three registries and as a repo path;
  - `concept`: the exact `build.py` key, a hub entry, and the Dashboard.gs list;
  - `sheetid`;
  - `exec-url`, which prints the deploymentId;
  - `wired <slug> [--published]`: the three registries agree, the pages are built, the hub registry has the store.

  All 10 stores pass `wired`, and it caught 12 planted registry mistakes.
- **Checked, fine for a brand-new store:** `provision_stores.sql` returns only unconnected stores, and both Sheet moves can be re-run after stopping partway.

### Section B — All four concepts in setup, one Lei'd spelling

Walked through first; Sebastian picked every recommended option.

- **One concept list:** Dashboard.gs `CONCEPT_THEMES`, which now carries a `name` per concept (`knownConcepts_`, `isKnownConcept_`).
  - Its order is the Sheet menus' numbering: 1 Roll Play, 2 Teas’n You, 3 ĂN, 4 Lei’d Poke. 1 and 2 are unchanged.
  - `commitStoreSetup` (Editor.gs) and Setup / Re-run Setup and Set Store Concept (Admin.gs `conceptMenuText_`, `conceptFromMenu_`) accept exactly that list.
  - Before, they took only Roll Play and Teas'n You, although the wizard offered all four.
- **Lei'd is `Lei’d Poke`** (curly U+2019, like Teas’n You) in `build.py` and the hub.
  - That matches the app's `CONCEPT_NAMES_`, the wizard and the brand kit.
  - It was spelled `Lei'd`, `Lei'd Poke` and `Lei’d Poke`.
- **`build.py` now fails loud** on a slug outside `[a-z0-9]{2,20}` (Supabase's rule) and on a concept it doesn't know. It used to build such a store unthemed without a word.
- **EditorShell `mgeShortLoc_`** strips `ăn` and `lei'd poke`. It left "ĂN …" whole, and would have shown "Poke Ballston BOH".
- **New gate `tests/concepts.test.js`** (the 22nd):
  - seven places agree with the server list;
  - the wizard's save and both menus save each concept and refuse anything else;
  - 9 planted defects.
- **Deploy:**
  - `--redeploy` to canary rprfo (@110). Sebastian checked Set Store Concept.
  - Then all 10 + template; every store answers GET and POST.
  - Hub cache v10 → v11. The store apps came out byte-identical; the editor pages changed by one line each.

### Outstanding (carry forward)

1. **The runbook's first real onboarding:** record whether a copied Sheet keeps its Script Properties (step 2's VERIFY), and whether a `clasp deploy` deployment would need its own OAuth grant.
2. **Clear Config doesn't clear the four Supabase keys** (Admin.gs `clearMobileApiConfig_`). It only matters if a live store's Sheet gets copied. It's an Apps Script change, so walk it through first.
3. **`tests/supabase_move.test.js` `provisionProblems` counts a commented-out SQL row as a row.** `validate.py` strips comments; the gate doesn't.
4. **Lei'd has no circular logo (U6) and no rail badge;** it shows initials.
5. **The block above's Outstanding** still stands (the first night, the three empty stores, the rest).

### Files touched this chat

- **Runbook:** `.claude/skills/mog-add-store/SKILL.md` and `scripts/validate.py`; `CLAUDE.md` (its skills-table line).
- **Apps Script (all 10 + template):** `Dashboard.gs`, `Editor.gs`, `Admin.gs`, `EditorShell.html`, `MOGApi.gs` (a comment).
- **Build and hub:** `build.py`, `index.html` (`CONCEPT_VISUALS`), `sw.js` (v11).
- **Tests:** new `tests/concepts.test.js`; `tests/README.md`.
- **Generated:** every store's `<slug>/editor/` pages, one line each.
- **Docs:** this block; `docs/MOG_CurrentState.md`.

### Process lessons

- A new store touches registries the gates read together: `.clasp-targets.json` needs `deploymentId` and `sheet`, and `provision_stores.sql` a row with the identical Sheet title. Run `validate.py wired` before the gates. [→ .claude/skills/mog-add-store/SKILL.md]
- A concept's name is spelled in seven files, and a near miss (a straight apostrophe for a curly one) failed silently. The concepts gate and `build.py`'s refusal catch it now. [→ tests/concepts.test.js]
- Heredoc patches lost backslashes twice more (a `\'` in a find string); an `assert count == 1` before replacing stopped both before anything was written. The Edit tool also turned a typed `ă` into the character `ă`. [→ memory reference_bash_heredoc_backslashes]
- A regex over a SQL file counts commented-out rows: strip `--` comments first. [→ .claude/skills/mog-add-store/scripts/validate.py]

## Commits landed this session (later, 3)

```
4720ff2 New-store onboarding for Supabase stores; the wizard and Sheet menus accept all four concepts
```

## Opening prompt for next session (supersedes the ones above)

```
Read docs/MOG_CurrentState.md, docs/MOG_OneApp_Spec.md and docs/MOG_SessionHandoff_2026_10_19.md
(the two Later session blocks) first. As of 2026-10-19 every store's editor is in the app (Supabase
owns each catalog, order history and recipients list); on a computer the order guide and Manage
share one sidebar. App v0.26.0 / cache v66, hub cache v11, schema v9. New stores follow the
mog-add-store runbook (11 steps, scripts/validate.py checks each value and the wiring), and the
setup wizard and Sheet menus accept all four concepts.

First: check that last night's 3:30 AM close ran and every store's recap email arrived
(recipients now come from Supabase), and look at Settings -> Recipients on tnyr, tnyrf and tnyt.
Then: help set up the three empty stores from their Overview checklists.

Rules: node tests/run_all.js before any deploy (22 gates); schema files are run by Sebastian;
preview with python build.py --preview rprfotest --like rprfo plus the scratch fake server;
read-only checks via the Supabase connector (project mnfwqmrstdeuczveyykv); every next step
that involves a file links it in the final message.
```
