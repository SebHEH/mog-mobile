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
