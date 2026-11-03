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
- **Versions:** app v0.28.0 / store cache v69, hub cache v11, schema v14 (LTOs, live 2026-11-02: smoke_v14 26/26, probe 94/94; HQ side shipped in `6fee3a1`). Schema v15 (vendor rename) live 2026-11-02: smoke_v15 18/18, probe 96/96; the Vendors page's rename shipped with it, together with the Items page's new-LTO banner and HQ's library tick boxes (30 gates). Schema v16 (Happy Supply W2a, store orders) live 2026-11-02: smoke_v16 50/50, probe 105/105; the app (v0.28.0) and HQ shipped with it in `37588dd` (31 gates). Schema v17 (W2b, HEH's stock held at Elpis) live 2026-11-03: smoke_v17 47/47, probe 111/111; the app (v0.29.0, store cache v70) and HQ shipped with it in `42db1a9` (32 gates). Donny's count-screen change (PR #7, `de0b787`) followed the same day: **app v0.30.0 / store cache v71, 33 gates**.
- **New stores** follow `mog-add-store` (11 steps, `scripts/validate.py`). The setup wizard and the Sheet menus accept all four concepts.
- **The three stores that moved empty:**
  - Rockville BOH (`tnyr`) and FOH (`tnyrf`): their KMs set them up themselves from the Overview checklist. Both import from the same Rockville MarginEdge file, each ticking only its own items; nothing stops an item landing in both.
  - Tysons BOH (`tnyt`): its KMs have been setting it up since 10-26 (208 items on 11-01). It seeds the Teas'n You BOH library.
- **The first all-Supabase night (10-19 → 10-20) was clean:**
  - all 10 stores closed between 3:23 and 3:38 AM;
  - rpr and rprfo had orders, and their recaps went to their Supabase recipients;
  - the other stores had nothing ordered, so no email (by design).

**2026-11-03: Donny's count screen** (PR #7, `5a2767b`, merged `de0b787`): each item lists only on its main vendor's count screen, its other vendors behind an arrow; app v0.30.0, cache v71, gate `count_lists`. Checked against W2b the same day: nothing of it changed, 33 gates and the SQL check pass, live on all 10 stores (`docs/MOG_SessionHandoff_2026_11_03.md`, Section B). The blueprint doesn't describe it yet.

**2026-11-03: Happy Supply W2b, HEH's stock held at Elpis, live** (`docs/MOG_SessionHandoff_2026_11_03.md`; smoke_v17 47/47 in the SQL Editor, probe 111/111, `42db1a9`). Not in use: no location is held by a vendor yet.
- **Checked live first:** W2a not tried yet (no warehouse products, links or orders); Elpis still three spellings; Horse Pho not undone.
- **Decided (walkthrough, all four as recommended):** recorded at the 3:30 AM close (not at Mark as reviewed); a receipt beyond the records goes through, logged as a count; HQ can mark an unmarked delivery received; the warehouse role sees Elpis. Three mockup boards approved ("Happy Supply W2b" row).
- **Built:** schema v17 (`held_by`, `via`, deliveries EL-0001 in `mog.wh_orders`, the close's guarded step, `mog_wh_held_receive`), HQ's Elpis page, the phone's Elpis card, gate `wh_elpis` (32 gates). Detail: `docs/MOG_Warehouse_Spec.md` §2 "W2b design".
- **Next:** check read-only that the 11-04 close ran at every store as usual (nothing can be recorded until an Elpis location exists); then first use on the TEST store (HQ → Locations: Elpis held by Elpis Wholesale, the RP bowls and lids as products, a count from Elpis's report, Send to stores, an Elpis order, the close, Mark received).

**2026-11-02 (later, 5): Happy Supply W2a, store orders, live** (`docs/MOG_SessionHandoff_2026_11_02.md`, "Later session 5").
- **Spec and design:** the W2 spec, the W2a design and its three mockup boards are approved (`docs/MOG_Warehouse_Spec.md` §2).
- **HQ:** a product's Send to stores links an item a store has (Happy Supply its main vendor, the old one a backup) or adds one, at stores that already have Happy Supply (add it on Vendors first). Dan's Orders page ships from a location, starting at what's left after older orders, and locks each line's price.
- **Phone:** "N available" on Happy Supply items; the review's needed-by, note and Send to Happy Supply (also marks it reviewed); the card's order line and Mark received.
- **Schema v16:** the link in the item's row (`mog.items.wh_product`), store orders HS-0001, no price ever on a phone.
- **Live checks:** smoke_v16 50/50, probe 105/105, commit `37588dd`, CI green, Pages live on all 10 stores and HQ. 31 gates.
- **In use:** nobody yet. No store has a link and the warehouse has no products. Seen only in the preview, by script.
- **Next:** W2b, HEH's stock held at Elpis.

**2026-11-02 (later, 4): new LTO items first, library tick boxes, vendor rename, all live** (`docs/MOG_SessionHandoff_2026_11_02.md`, "Later session 4").
- **Items page:** each running LTO's items that lack a par or a storage area are pinned at the top under a banner, with an "LTO · name" chip and a panel note (`catalogEdit.js` `ltoWaiting`). LTO spec session 2 is done.
- **HQ Libraries:** tick boxes and Tick all; Remove from the library, or Send N items to stores (standard items, no LTO).
- **Vendors page:** a store can rename a vendor (schema v15): items, count lists, today's counts and edits, and HQ's remembered names follow; a taken name is refused; Undo renames back.
- **Live checks:** smoke_v15 18/18, `check_api.sh` 96/96, commit `abce087`, CI green, Pages live on all 10 stores and HQ. 30 gates.
- **Used live the same evening** (Sebastian: "all looked right"; checked read-only):
  - the Teas'n You BOH test library cleared with Tick all → Remove (5:36 PM);
  - B&T renamed to "B&T Distributors LLC" at Rosslyn, Founders and Tysons BOH (Rockville BOH already had it);
  - the first real LTO, **Fall Chicken Pho**, sent to Rosslyn, Founders and Tysons BOH (5:41 PM). It's meant to run; its chicken breast has no par yet at any of the three.
- **Not built:** live stock for Happy Supply and Elpis, now open W2 questions in `docs/MOG_Warehouse_Spec.md`.

**2026-11-02 (later, 3): LTOs, the HQ side, are live** (`docs/MOG_SessionHandoff_2026_11_02.md`, "Later session 3"; spec `docs/MOG_LTO_Spec.md`).
- **Schema v14:** an HQ rollout is a named LTO (`mog.ltos`, `mog.lto_stores`); each item it creates carries it in `mog.items.lto`, part of the item's row (a store's Undo brings it back, a reused item number never gets it).
- **HQ:** Roll out became **New LTO** (name required, the library box gone). The new **LTOs** page (`template/hq/ltos.js`) shows each LTO at each store and can Send to more stores, Make it standard (into the library), End (items inactive) or Roll back (as if never sent), every store or none.
- **Live checks:** smoke_v14 26/26 in the SQL Editor; `check_api.sh` 94 passed, 0 failed; commit `6fee3a1`, CI green, Pages live on HQ and all 10 stores. 29 gates. Nobody has used the live LTOs page yet.
- **Not tracked:** the rollouts sent before v14 (Horse Pho, Horse Meat, Fall Chicken Pho): undone by hand in each store's Changes.
- **Next:** session 2, the store's Items page (built in later session 4).

**2026-11-02 (later, 2): the local preview server** (`docs/MOG_SessionHandoff_2026_11_02.md`, "Later session 2").
- **`preview_start` "mog-preview"** (`tests/preview_server.js`) serves the app, the editor, HQ and Happy Supply against the fake Supabase at `http://127.0.0.1:8770/`: PIN 1111, HQ through `/__signin?who=`. Use it instead of building one.
- **`node tests/run_all.js` passes in a fresh Windows worktree** now (the slicer self-test's anchors were LF-only). PR 6, merged.

**2026-11-02 (later): Happy Supply W1, the warehouse, is live** (`docs/MOG_SessionHandoff_2026_11_02.md`, "Later session").
- **Schema v13:** HQ people have roles (`hq`, `warehouse` or both; Sebastian has both). The warehouse keeps its own stock per location (never below 0), vendor orders in (PO-0001), transfers (TR-0001), counts with reasons, and every change kept. The rules live in the SQL (`mog_wh_*`).
- **HQ's Happy Supply pages** (`template/hq/warehouse.js`): Inventory with Count a location, Incoming, Products and prices, Stock history, shown to the warehouse role.
- **Live checks:** smoke_v13 44/44 PASS in the SQL Editor; `check_api.sh` 88 passed, 0 failed; CI green; Sebastian saw the section on the live page: "It shows, looks right". The warehouse holds no data yet; Dan isn't invited.
- **CI now runs the real SQL** in PGlite (`supabase/tests/run_pglite.mjs`): every schema and smoke file, then the newest schema again, which must change no row. 28 gates.
- **Decided:** stock never below 0 (count first); Happy Supply reaches the Roll Play stores with W2's first products, in one HQ rollout per store; schema numbers aren't held for a person.

**2026-11-02: the concept library and the HQ redesign** (`docs/MOG_SessionHandoff_2026_11_02.md`).
- **Concept library** (schema v12): one standard item list per concept and side, kept on HQ's Libraries page. A library starts from one store, then gets cleaned, and sets up a store like an LTO (no par, no area). None is started yet (checked live 11-02).
- **HQ redesigned** in the order guide's computer look with the HEH brand. Stores are picked as a concept, then its stores. The main vendor is a dropdown and backups are chips. Sebastian saw it on a screen on 11-02: it looks right, no changes.
- **HQ in use:** Sebastian is signed up and ran one TEST rollout on rprfotest; its Undo is still untried. Checked live on 11-02: "Horse Pho" (change 237) isn't undone.

**2026-11-01: vendor contacts, HQ control, the warehouse spec** (`docs/MOG_SessionHandoff_2026_11_01.md`).
- **Vendor contacts** (schema v10): each store's vendors carry a contact, edited on the new app-only Vendors page, shown on the phone's vendor card. Rosslyn BOH and Founders BOH are loaded.
- **HQ control** (schema v11, `/hq/`): adds a vendor or LTO items to many stores at once, every store or none, one undoable change per store. Sign-in is per person by invite; only Sebastian is invited.
- **Spec approved:** `docs/MOG_Warehouse_Spec.md`, in the order concept library (built 11-02), warehouse (Happy Supply) W1-W2, stores without a Sheet, then Chasin' Tails and NUE.

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
- **The Vendors redesign** shipped 2026-11-01 (app-only `template/editor/Vendors.html`, with each vendor's contact).

Read before touching the app, the editor or Supabase: [docs/MOG_OneApp_Spec.md](MOG_OneApp_Spec.md), [docs/MOG_SupabaseMigration.md](MOG_SupabaseMigration.md), [docs/MOG_LogicBlueprint.md](MOG_LogicBlueprint.md).

### Next-session candidates

1. **Finish lining up after later session 4** (Sebastian's steps, live; checked 11-02 evening):
   - rename Elpis to "Elpis Wholesale" in Manage → Vendors at Rosslyn FOH, Founders FOH, RP Tysons FOH and TnY Tysons FOH (Rockville BOH and FOH have it already);
   - undo "Horse Pho" in Rosslyn FOH (TEST)'s Manage → Changes (change 237); that also takes away the TEST store's "B&T".
   - Done: B&T lined up, the Teas'n You BOH test library cleared, a real LTO sent (Fall Chicken Pho).

   Later, its own spec: line up each concept's stores with its library, and items a store can't remove.
2. **Use the concept library** (schema v12, HQ's Libraries page; `docs/MOG_Warehouse_Spec.md` §1). Checked live 11-02 evening: Roll Play BOH and Teas'n You BOH are empty (the test cleared); the FOH libraries aren't started. Sebastian's steps:
   - start and clean all four (Rosslyn BOH and FOH, Tysons BOH, Rockville FOH);
   - set up a store from one, or send ticked items with "Send N items to stores".
3. **Start the warehouse** (W1 live; `docs/MOG_Warehouse_Spec.md` §2):
   - Sebastian tells Donny that schemas v13 to v16 are taken;
   - invites Chef Dan with the warehouse role only (SQL Editor: `select mog.hq_invite('Dan', '{warehouse}');`);
   - Dan adds the locations, suppliers and products, then a first count per location.

   Then W2 (store orders). **Its spec is approved** (2026-11-02, `docs/MOG_Warehouse_Spec.md` §2 "W2 spec"):
   - no Approve step (sent, shipped, received);
   - cases available on the phone; an order larger than that is sent with a warning;
   - KMs keep ordering HEH's stock at Elpis from Elpis: Elpis is a location, and the store's receipt lowers it (Sebastian keeps it for now);
   - built in two parts, W2a Happy Supply first, then W2b Elpis.

   W2a's design is approved too (same section, "W2a design": schema v16, the link on the item's row, the Happy Supply vendor from HQ's remembered names, needed-by from its delivery days). **W2a is live** (schema v16, `37588dd`) and untried (checked 11-03). First use on the TEST store:
   1. a product and a first count in HQ → Happy Supply;
   2. Happy Supply added to Rosslyn FOH (TEST) on HQ → Vendors, with its delivery days;
   3. Send to stores, then set the item up at the store;
   4. a phone order, Ship, Mark received.

   **W2b (HEH's stock at Elpis) is live too** (schema v17, `42db1a9`) and unused: its first-use steps are in `docs/MOG_SessionHandoff_2026_11_03.md`, Outstanding 2. Before Happy Supply's real use: Dan's answer on pound ordering, and Dan invited. Happy Supply goes to the Roll Play stores with W2's first products. Then W3 (chargebacks).
4. **Finish Donny's onboarding** ([docs/MOG_SessionHandoff_2026_10_29.md](MOG_SessionHandoff_2026_10_29.md), Outstanding 1-2):
   - Sebastian's steps: GitHub collaborator on both repos, branch protection on `main`, the Supabase Developer invite, Editor on the 11 Sheets, PINs.
   - Then Donny consents in each store and runs `python deploy.py --redeploy --target rprfo`.
   - Record the result in `docs/MOG_ProjectNotes.md` and CLAUDE.md rule 5.
5. **Confirm the 2026-10-20 fixes held:** each store's recap goes out once, and nothing new shows up in the nightly run's log (not checked since 10-20).
6. **Check the phone's Contact sheet live** (checked by script only). The Items page's LTO banner, the Vendors rename and HQ's library tick boxes were used live on 11-02 and looked right. Small follow-up: the Overview's "Give each item a storage area and a par" step could open Items on Needs setup.
7. **Logic findings held back on 2026-10-20** (edge cases; decide before fixing):
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
8. **Redundancy items held back on 2026-10-20:**
   - `VENDOR_META` is empty, but the equivalence gate compiles an older revision against the same constant list.
   - The nightly recipients copy is a no-op on all 10 stores; the `recipients_people` gate is built around it.
   - The old `/exec` editor still serves its pages for moved stores; it should send them to the app.
   - The Sheet Health Check's catalog rows still run, and three of its fixes can write to frozen Sheets.
   - Admin Reset can wipe a moved store's LOG_ORDERS backup.
   - `host.js`'s standalone rail and Changes panel only show off-app, on a narrow non-phone screen.
   - The v1 Supabase fallback (`mog_snapshot` / `mog_save_counts`) can go once old app versions are gone.
   - `template/sw.js` `FORCE_CLIENT_RELOAD`: never change `FORCE_RELOAD_ID`.
   - Stale repo skills: `mog-apps-script-caching`, `mog-rpc-consolidation`, `mog-editor-web-reskin`, `mog-sheet-formula-verify`, `mog-health-check-extend`.
9. **Small open items:**
   - Confirm this repo's origin in the desktop app (Help → Troubleshooting → Review Pinned Git Origins), so worktree sessions can merge `main` when it changed a skill.
   - No GitHub CLI on Sebastian's computer: pull requests are opened by hand and the app can't watch their CI (optional: install `gh`, then `gh auth login`).
   - `mog-deploy-workflow`'s HTML-modal row still says modals run in Rhino ES5 (CLAUDE.md invariant #4 says otherwise).
   - GitHub Actions warns that `checkout@v4`, `setup-node@v4` and `setup-python@v5` target the deprecated Node 20, and that `ubuntu-latest` moves to Ubuntu 26. Bump the actions when newer majors exist, and watch the first run on Ubuntu 26.
   - Clear Config doesn't clear the four Supabase keys (`Admin.gs`; walk through first).
   - `supabase_move`'s `provisionProblems` counts a commented-out SQL row.
   - Lei'd has no circular logo.
   - On the first real onboarding, record whether a copied Sheet keeps its Script Properties.
10. **Later:**
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
| `rpfr` | Roll Play - Founders BOH | In use since 2026-11 (Founders Row is its own store now). |
| `rpfrf` | Roll Play - Founders FOH | Not used yet. |
| `tnyt` | Teas'n You - Tysons BOH | Being set up by its KMs since 10-26. Its `/exec` flaked after redeploys (10-16, 10-19) and recovered both times. |
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
| 2026-11-03 | Happy Supply W2b, HEH's stock held at Elpis | Live check first (W2a untried, Elpis three spellings), then the W2b walkthrough (recorded at the close, a receipt beyond the records goes through, HQ can mark one received, the warehouse role) and three mockup boards, all approved. Schema v17: `held_by`, `via`, deliveries EL-0001 in `mog.wh_orders`, the close's guarded step (`mog_sync_close_cycle` replaced, same signature), `mog_wh_held_receive`. HQ's Elpis page, "Stores order it from", "Held by", Send to stores for Elpis; the phone's "available at Elpis" and Elpis card (app v0.29.0, cache v70). Live: smoke_v17 47/47, probe 111/111, CI green, Pages live. Gate `wh_elpis` (32 total). Blueprint R33. Commit `42db1a9`. Donny's PR #7 (count screen, v0.30.0) merged on top and checked. Detail: `docs/MOG_SessionHandoff_2026_11_03.md`. |
| 2026-11-02 (later, 5) | The W2 spec, Happy Supply store orders (W2a) | Live check first (library cleared, B&T lined up, Elpis three spellings, Fall Chicken Pho real), then the W2 spec (no Approve step, cases available, over-order warned, Elpis as a location in W2b), the W2a design and three mockup boards, all approved. Schema v16: `mog.items.wh_product` in the item's row, `mog.wh_orders` / `wh_order_lines` (HS-0001), `mog_wh_send` / `mog_wh_received` (phone), `mog_wh_ship` / `mog_wh_order_cancel` (warehouse), `happySupply` in the 10-second read. `catalogEdit.js` `commitHqProduct`; HQ's Orders page and Send to stores; the phone's available, Send and Mark received (app v0.28.0, cache v69). Live: smoke_v16 50/50, probe 105/105, CI green, Pages live. Gate `wh_orders` (31 total). Blueprint R32. Commit `37588dd`. Detail: `docs/MOG_SessionHandoff_2026_11_02.md` (Later session 5). |
| 2026-11-02 (later, 4) | New LTO items first on Items, library tick boxes, vendor rename | The store's Items page pins each running LTO's items until set up (banner, chip, panel note; `catalogEdit.js` `ltoWaiting`). HQ Libraries: tick boxes, Remove, Send N items to stores without an LTO. Schema v15: a store renames a vendor with a rename step (items, lists, pick rows, today's counts and edits, HQ's names follow; a taken name refused). Live: smoke_v15 18/18, probe 96/96, CI green, Pages live. Gate `vendor_rename` (30 total). Blueprint R28, R31. Live stock for Happy Supply and Elpis left as open W2 questions. Commit `abce087`. Detail: `docs/MOG_SessionHandoff_2026_11_02.md` (Later session 4). |
| 2026-11-02 (later, 3) | LTOs, the HQ side | Spec `docs/MOG_LTO_Spec.md` and two mockup boards approved. Schema v14: `mog.ltos` / `lto_stores`, `mog.items.lto` in the item's row, `mog_hq_apply`'s fifth argument. `catalogEdit.js` `commitHqLto` (end, rollback, standard), `ltoStoreState`; HQ's New LTO and LTOs page (`template/hq/ltos.js`). Live: smoke_v14 26/26, probe 94/94, CI green, Pages live. Gate `lto` (29 total). Blueprint R31. Handoffs now commit and push. Commit `6fee3a1`. Detail: `docs/MOG_SessionHandoff_2026_11_02.md` (Later session 3). |
| 2026-11-02 (later, 2) | Local preview server, the slicer on Windows | `tests/preview_server.js` and the launch entry "mog-preview": the built app, editor and HQ against the fake Supabase (six stores, three HQ people, the Happy Supply sample), refusing any page that names a real Supabase address; checked in the browser pane. `slice_js_selftest` takes the file's line ending, so the gates pass in new Windows worktrees (28). PR 6: `8ea3603`, `94d496d`, merge `35cb81c`; nothing the stores run changed. Detail: `docs/MOG_SessionHandoff_2026_11_02.md` (the last Later session). |