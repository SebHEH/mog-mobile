# MOG — Current Project State

The running snapshot of where this codebase is *right now*. `CLAUDE.md` @-imports it, so every session starts with it. It stays short on purpose: the history lives in the dated handoffs (`docs/MOG_SessionHandoff_*.md`), and everything this file held before 2026-10-20 is unchanged in [docs/MOG_CurrentState_Archive.md](MOG_CurrentState_Archive.md), which is not auto-loaded.

If this doc and `CLAUDE.md` conflict on a fact, `CLAUDE.md` wins for structure and invariants; this doc wins for what's in flight.

---

## Pinned focus

**Every store runs on Supabase and one app (as of 2026-10-20).**

- **Phones** count straight into Supabase (`phone_direct` on all 10 stores).
- **The catalog, order history, recipients and People** live in Supabase and are edited in the app on a computer (`editor_direct` on all 10).
- **Each Sheet** is frozen for catalog edits. It still holds the Apps Script: the 3:30 AM close, the recap email, the onboarding moves. It also gets a nightly LOG_ORDERS backup.
- **On a computer** the order guide and Manage share one sidebar; Manage pages run in a frame (`?embed=1`).
- **Versions:** app v0.26.1 / store cache v67, hub cache v11, schema v9.
- **New stores** follow `mog-add-store` (11 steps, `scripts/validate.py`). The setup wizard and the Sheet menus accept all four concepts.
- **The three empty stores:**
  - Rockville BOH (`tnyr`) and FOH (`tnyrf`): their KMs set them up themselves from the Overview checklist. Both import from the same Rockville MarginEdge file, each ticking only its own items; nothing stops an item landing in both.
  - Tysons BOH (`tnyt`): stays empty, like the unused Roll Play Tysons and Founders stores.
- **The first all-Supabase night (10-19 → 10-20) was clean:**
  - all 10 stores closed between 3:23 and 3:38 AM;
  - rpr and rprfo had orders, and their recaps went to their Supabase recipients;
  - the other stores had nothing ordered, so no email (by design).

**Two maintainers (2026-10-29).** Sebastian's assistant Donny now maintains MOG too (CLAUDE.md, Two maintainers; his setup in [ONBOARDING.md](../ONBOARDING.md)).
- **Changes:** Donny works on branches and opens pull requests; Sebastian merges.
- **Deploys and SQL:** both can deploy and run SQL, after telling the other. `deploy.py` refuses a copy that is behind `origin/main`, and sends a deploy to every store only from `main`.
- **CI:** the 24 gates run on GitHub (`.github/workflows/gates.yml`) on every push and pull request, and pass there.
- **Project notes:** what used to be Claude's memory on Sebastian's computer is now [docs/MOG_ProjectNotes.md](MOG_ProjectNotes.md).
- **Not finished:** Sebastian's invites and branch protection, then Donny's one-store test deploy, which measures who `/exec` runs as after his redeploy.

**The 2026-10-20 session, status at last update:**

- **Logic check:** all gates pass, and the order math is one shared copy. Four fixes are built and tested:
  - the recap's "already sent" check used a frozen Sheet date (duplicate emails possible);
  - offline counts that sync after the close were silently dropped;
  - the phone's rounding now calls `OrderMath.gs` (new gate `phone_rounding`);
  - typed negative counts become 0.
- **Cleanup:**
  - Import Vendor (CSV) removed: Import from MarginEdge replaces it.
  - Recalibrate Vendor Pars, Vendor Cadence Audit and How To Use deleted.
  - Dead code removed; "1 items" fixed.
- **Shipped:** commit `ffc816b`. Apps Script is on all 11 targets (every store's `/exec` answers), and the app is v0.26.1 / store cache v67.
- **Manage Items redesign: live on all 10 stores** (commit `a4e6e98`), built from the approved mockup ([artifact](https://claude.ai/artifact/BmVaV6v55MnHx39gJ7mH4K)). Its layout hasn't been seen on a screen yet: Sebastian checks it live.
  - The page: the app-only [template/editor/Items.html](../template/editor/Items.html).
    - A four-column list with search, a vendor dropdown ("On its list / Not on it"), an area filter, and Active / Needs setup / Par review / Inactive.
    - An item panel beside the list (previous/next, one Save for everything), and Add item as a button.
    - A bulk bar: add to / remove from a vendor, Move to area, Make active/inactive.
  - Three new one-change bulk saves in `catalogEdit.js`, gated by `tests/items_bulk.test.js`.
  - Each touches only the ticked items. The old Assign tab's save rewrote a vendor's whole list and dropped other items' drifted rows.
  - Saving an item now needs a par.
  - `ManageItems.html` stays for the Sheet dialog and `/exec`.
- **The Vendors redesign** is next, from the same mockup.

Read before touching the app, the editor or Supabase: [docs/MOG_OneApp_Spec.md](MOG_OneApp_Spec.md), [docs/MOG_SupabaseMigration.md](MOG_SupabaseMigration.md), [docs/MOG_LogicBlueprint.md](MOG_LogicBlueprint.md).

### Next-session candidates

1. **Finish Donny's onboarding** ([docs/MOG_SessionHandoff_2026_10_29.md](MOG_SessionHandoff_2026_10_29.md), Outstanding 1-2):
   - Sebastian's steps: GitHub collaborator on both repos, branch protection on `main`, the Supabase Developer invite, Editor on the 11 Sheets, PINs.
   - Then Donny consents in each store and runs `python deploy.py --redeploy --target rprfo`.
   - Record the result in `docs/MOG_ProjectNotes.md` and CLAUDE.md rule 5.
2. **Confirm the 2026-10-20 fixes held:** each store's recap goes out once, and nothing new shows up in the nightly run's log (not checked since 10-20).
3. **Check the new Items page live, then build the Vendors redesign** from the same mockup (an app-only `template/editor/Vendors.html` the same way; Import Vendor is already gone). Small follow-up: the Overview's "Give each item a storage area and a par" step could open Items on Needs setup.
4. **Logic findings held back on 2026-10-20** (edge cases; decide before fixing):
   - A same-day manual close from the Sheet, followed by that night's close of the same day, replaces the day's order log with an empty one.
   - Turning Emergency Override off before 3:30 AM drops the vendors ordered under it from that night's log and email.
   - A per-vendor day pick can be saved while Override is off.
   - The blueprint is still out of date in places (R5, R12, R14 and the Import Vendor note were fixed 2026-10-20):
     - the count-flow steps;
     - R1 cites the wrong file;
     - the R10 pseudocode leaves out the per-vendor pick;
     - R27's wording;
     - R16's evidence.
   - `audit_modals.py` (the `mog-modal-ux-sweep` skill) still looks for `google.script.host.close()`, so it flags Manage Items and Vendors, whose Close moved into EditorShell in July.
5. **Redundancy items held back on 2026-10-20:**
   - `VENDOR_META` is empty, but the equivalence gate compiles an older revision against the same constant list.
   - The nightly recipients copy is a no-op on all 10 stores; the `recipients_people` gate is built around it.
   - The old `/exec` editor still serves its pages for moved stores; it should send them to the app.
   - The Sheet Health Check's catalog rows still run, and three of its fixes can write to frozen Sheets.
   - Admin Reset can wipe a moved store's LOG_ORDERS backup.
   - `host.js`'s standalone rail and Changes panel only show off-app, on a narrow non-phone screen.
   - The v1 Supabase fallback (`mog_snapshot` / `mog_save_counts`) can go once old app versions are gone.
   - `template/sw.js` `FORCE_CLIENT_RELOAD`: never change `FORCE_RELOAD_ID`.
   - Stale repo skills: `mog-apps-script-caching`, `mog-rpc-consolidation`, `mog-editor-web-reskin`, `mog-sheet-formula-verify`, `mog-health-check-extend`.
6. **Small open items:**
   - `mog-deploy-workflow`'s HTML-modal row still says modals run in Rhino ES5 (CLAUDE.md invariant #4 says otherwise).
   - GitHub Actions warns that `checkout@v4`, `setup-node@v4` and `setup-python@v5` target the deprecated Node 20, and that `ubuntu-latest` moves to Ubuntu 26. Bump the actions when newer majors exist, and watch the first run on Ubuntu 26.
   - Clear Config doesn't clear the four Supabase keys (`Admin.gs`; walk through first).
   - `supabase_move`'s `provisionProblems` counts a commented-out SQL row.
   - Lei'd has no circular logo.
   - On the first real onboarding, record whether a copied Sheet keeps its Script Properties.
7. **Later:**
   - keep visited Manage pages alive;
   - send the recap email from Supabase;
   - retire the last `/exec` uses (Daily summary button, reset fallback);
   - the MarginEdge API for pack sizes.

> **Dropped (do not re-add):** parallelizing `deploy.py`. Repeatedly considered and abandoned: the serial push isn't hurting, and concurrent `clasp push` adds rate-limit risk.

---

## Standing invariants

See `CLAUDE.md` → "Standing invariants" (10 rules). They aren't repeated here so the two copies can't drift.

---

## Deploy targets (apps-script/.clasp-targets.json)

11 targets: the master template plus 10 stores. The code is identical across all of them, and per-store config lives in each Sheet. Each target has a `scriptId` (for `clasp push`) and a `deploymentId` (for bumping its web app's `/exec` version).

| Slug | Store | Notes |
|---|---|---|
| `_template` | Master template | Copied to seed new stores. Push keeps it current. |
| `rpr` | Roll Play - Rosslyn BOH | |
| `rprfo` | Roll Play - Rosslyn FOH | Canary: the first to get every deploy. |
| `rpt` | Roll Play - Tysons BOH | Not used yet. |
| `rptfo` | Roll Play - Tysons FOH | Not used yet. |
| `rpfr` | Roll Play - Founders BOH | Not used yet. |
| `rpfrf` | Roll Play - Founders FOH | Not used yet. |
| `tnyt` | Teas'n You - Tysons BOH | Empty, not used. Its `/exec` flaked after redeploys (10-16, 10-19) and recovered both times. |
| `tnytf` | Teas'n You - Tysons FOH | |
| `tnyr` | Teas'n You - Rockville BOH | Started empty; KMs setting it up. |
| `tnyrf` | Teas'n You - Rockville FOH | Started empty; KMs setting it up. |

| Goal | Command |
|---|---|
| Push + redeploy the web app (the default for any `.gs` or page change) | `python deploy.py --redeploy` |
| Push only (bound Sheet dialogs) | `python deploy.py` |
| One target | `python deploy.py --redeploy --target <slug>` |
| Dry run | `python deploy.py --dry-run` (add `--redeploy` to preview that step too) |
| Find deploymentIds on a fresh checkout | `python deploy.py --discover` |

---

## Live stores (stores.json)

10 entries, all with `"editor": "supabase"`. The template isn't published. Hub: `https://sebheh.github.io/mog-mobile/`.

| Slug | Concept | Location |
|---|---|---|
| `rpr` | Roll Play | Rosslyn BOH |
| `rprfo` | Roll Play | Rosslyn FOH |
| `rpt` | Roll Play | Tysons BOH |
| `rptfo` | Roll Play | Tysons FOH |
| `rpfr` | Roll Play | Founders BOH |
| `rpfrf` | Roll Play | Founders FOH |
| `tnyt` | Teas’n You | Tysons BOH |
| `tnytf` | Teas’n You | Tysons FOH |
| `tnyr` | Teas’n You | Rockville BOH |
| `tnyrf` | Teas’n You | Rockville FOH |

---

## Open issues / risks

- **CI runs the gates on GitHub's Linux runner** (`.github/workflows/gates.yml`), with LF files. Run `node tests/run_all.js` before every deploy anyway; the live URL is still the final check. Reproducing a CI-only failure: see [docs/MOG_ProjectNotes.md](MOG_ProjectNotes.md), CI and tests.
- **Two maintainers deploy from two computers.** `deploy.py`'s git check is the backstop; telling each other before a deploy is the rule.
- **`python3` on Windows** is the Microsoft Store stub; use `python` or `py`.
- **PowerShell PATH goes stale** after a `winget install` (see `CLAUDE.md` convention #7).
- **A store's `/exec` can rot or flake.** Test a freshly cut deployment before repointing: if it flakes too, it isn't rot (`mog-exec-repoint`).

---

## Architecture notes worth remembering

- **Two `CACHE_VERSION` constants**, `sw.js` (hub) and `template/sw.js` (stores), move independently. Bump the one whose shell changed.
- **`build.py` is idempotent.** It injects six placeholders into each store's page, `OrderMath.gs` among them, so the phone runs the server's order math verbatim. `--dry-run` previews; `--preview <slug> --like <slug>` builds a test store into `_preview/`.
- **The phone's live order quantity** calls `computeSuggestedQty_` from that injected copy and has no rounding of its own; `tests/phone_rounding.test.js` holds it there.
- **`deploy.py`:**
  - writes a temporary `apps-script/.clasp.json` per target, pushes, then cleans up;
  - is stdlib-only and serial on purpose;
  - treats source push and web-app redeploy as separate phases.

  The web app is the primary surface, so default to `--redeploy`.
- **All `apps-script/` files share one global scope.**
  - **15 `.gs`:** Admin, Core, Dashboard, DbApi, Editor, Health, History, Items, MOGApi, OrderMath, PickPath, Recap, ResetLog, Sync, Vendors.
  - **11 `.html`:** AdminReset, EditorHome, EditorShell, HealthCheck, ManageItems, ManageVendors, OrderHistory, ReorderPickPath, Setup, StorageAreas, Styles.
  - A `.gs` and an `.html` can't share a basename, which is why the server file is `Health.gs`.
- **Never put `.js` under `apps-script/`:** clasp pushes it to every store. Tests live in `tests/`.
- **`apps-script/.clasp-targets.json` is committed** with real Script IDs. They identify projects and aren't secrets; pushing still needs `clasp login`.
- **The `STORE_REGISTRY` marker** in root `index.html` is build-injected. Edit `stores.json`, never the line.
- **Every server function is private (`_`)** unless it's on the reviewed list in `tests/public_surface.test.js` (D18). Pages reach the server only through `webedit_call` and the auth layer.

---

## Recent significant changes

Most recent first. Keep about five; older rows move to the archive.

| Date | Session | Outcome |
|---|---|---|
| 2026-10-20 → 10-29 | Supabase skills audit, a second maintainer (Donny) | Skills: two global Supabase skills (`supabase-schema-change`, `appsscript-to-supabase-migration`, applied by Claude-SKills) and repo skill `mog-supabase-schema`; `route.py` routes `supabase/`; `check_api.sh` stopped sending a wrong PIN to rprfo. Two maintainers: a CLAUDE.md section, ONBOARDING.md, a git check in `deploy.py`, CI on GitHub (first run failed on CRLF test anchors, fixed in `plant()`, then green), Claude's memory moved to `docs/MOG_ProjectNotes.md`. Commits `eb907a0`, `2dd9264`, `1dbe516`; nothing the stores run changed. Detail: `docs/MOG_SessionHandoff_2026_10_29.md`. |
| 2026-10-20 | Night check, logic check, cleanup, Manage Items redesign | First all-Supabase night checked clean. Logic check: all gates pass, 4 fixes (recap duplicate check, late offline counts, phone rounding on the shared math, negative counts). Cleanup: Import Vendor and 3 Sheet-only tools removed, dead code removed, this doc trimmed (archive kept). Commit `ffc816b`: Apps Script on all 11 targets, app v0.26.1 / cache v67. Manage Items redesign (app-only `Items.html`, bulk bar with 3 new one-change saves, gate `items_bulk`), commit `a4e6e98`, live on all 10. Blueprint R5, R12, R14 bumped. Detail: `docs/MOG_SessionHandoff_2026_10_20.md`. |
| 2026-10-19 (later, 3) | New-store onboarding + all four concepts | `mog-add-store` rewritten for Supabase stores (11 steps, `validate.py wired`); wizard and Sheet menus accept all four concepts; `build.py` refuses bad slugs and concepts; gate `concepts`. Commit `4720ff2`. Detail: `docs/MOG_SessionHandoff_2026_10_19.md`. |
| 2026-10-19 (later) | Phase 4's rest, one app on a computer, every store moved | Schema v9 (order history, recipients, People, Health in the app); the sidebar shell with Manage pages in a frame; the Overview; all 10 stores' editors moved (tnyr, tnyrf, tnyt started empty). Commits `30c08ce`→`7f23850`. Same handoff. |
| 2026-10-18 → 10-19 | MarginEdge import, Phase 4 editor tools | Import from MarginEdge; Manage Vendors, Storage Areas and Shelf to Sheet on Supabase; schema v8; Move the editor to the app. Commits `62a356d`→`09b3279`. Same handoff. |
