# MOG: one app per store (spec)

**Status:** agreed with Sebastian, 2026-10-18 (spec-first). Phase 1 (live counting) is live on every store since 2026-10-18: `supabase/schema_v5.sql`, app v0.19.1. It also brought autosave on the count screen (a count saves ~4s after the last change, Supabase stores only), because counts used to reach Supabase only on Save or Review, so nobody else could see them. The Supabase design record (`docs/MOG_SupabaseMigration.md`) still holds how the data moves. This file holds what the app becomes.

## Why the editor and the ordering app were separate, and why that ends

- **Technical:** the editor had to be Apps Script pages at the slow `/exec` address, because Apps Script was the only thing that could write the Sheet. The ordering app is a static site on GitHub Pages. Step 6 puts both on Supabase as static pages, so the technical reason goes away.
- **Product rule (June 2026):** "editor = computer only + PIN". In practice the same store PIN unlocks both, and "computer only" is a screen-width check in the page (`mgeIsPhone_`). So the protection was friction, not permission.
- **Still true:**
  - No framework or bundler: each store page is one file built by `build.py`, so editor code must load as separate files, and only on computers, to keep phones fast.
  - Store URLs never change.
  - Admin Reset stays Sheet-only.

## Purpose

Each store's existing address (`/rpt/`, `/rprfo/`, …) becomes the whole app:
- **Phones** count and order, with a few guarded quick edits.
- **Computers** do the same, plus an **Editor** section: items, vendors, storage areas, Shelf to Sheet, history, health, recipients, people.

Several people can work at once and see each other's progress within seconds. There's one sign-in and one Supabase backend.

## Who it's for / not for

- **For:** KMs, GMs and the shift leads who count, often two people on different vendors at the same time.
- **Not for:** line staff editing the catalog; people working in the Sheet (it becomes a backup); vendors; a multi-store admin console (manager mode stays as it is).

## Success looks like

- Two people counting different vendors each see the other's counts and "in progress" status within about 10 seconds, without touching the screen.
- Opening a vendor someone else is counting warns who it is ("Maria is counting Chef Center") and shows their counts live. It doesn't lock.
- On a laptop, a KM signs in once and can count, review, copy an order and edit the catalog with no second tab or PIN. A phone that opens the Editor sees "Use your computer to edit".
- **Phone, adjust par:** asks "Just today, or from now on?"
  - **Just today:** only this cycle's order uses the new par, and Manage Items flags the item for review, e.g. "Par raised for one day, 3 → 5".
  - **From now on:** the catalog changes, logged.
- **Phone, add an existing item to this vendor's list:** today only, with a warning that it's only for today's order. Manage Items flags it, e.g. "Added to Chef Center for Oct 18: add it for good?".
- Every catalog change is logged (what, before and after, when, who), deletes always confirm, and a computer can Undo any change.
- Editor pages open and save in under 1s.

## Decisions (2026-10-18)

| # | Decision | Chosen |
|---|---|---|
| A1 | One app or two | **One app** at each store's address; the Editor loads only on computers. |
| A2 | Phone quick edits | **Adjust par** (just today, or from now on) and **add an existing item to this list** (today only). Both confirm, are logged, and leave a review flag in Manage Items. Nothing that deletes or deactivates on a phone. |
| A3 | Protection from accidents | **Same PIN as today**, plus the change log, Undo, and confirmations on deletes. No second PIN. |
| A4 | Desktop layout for the ordering screens | **After the editor.** Until then, ordering on a laptop stays the centered phone column. |
| A5 | Naming people (one shared PIN) | On first sign-in, a device asks **"Who's counting?"** and remembers the answer. It's a pick from the **store's list of leaders**, with "Someone else…" to type a name, and a typed name joins the list. The Editor gets a People tool to rename or remove names. A label, not a password. |
| A6 | Two people on the same vendor | **Warn, don't lock.** Counts are saved per item, so a collision needs the exact same item (the last save wins). |
| A7 | Order of work | **Live counting first**, then the editor foundation, phone quick edits, the remaining tools with each store switching over, and the desktop layout. |

### Phase 1 decisions (2026-10-18)

| # | Decision | Chosen |
|---|---|---|
| P1 | Someone else's counts while you're on that vendor | **Fill them in live** within ~10s, with a brief highlight, on items you haven't touched. Anything you typed stays yours. |
| P2 | The name step | **Asked once per device, Skip allowed** (shown as "Someone"). It never blocks counting. |
| P3 | Keeping the name list tidy before the People tool exists | **Names unused for 30 days drop out of the picker.** Nothing is deleted. |
| P4 | How "who's counting" travels | The refresh read (every 10s; 15s until v0.19.1) carries this device's name and open vendor (no extra requests). Opening or leaving a vendor, and coming back from the lock screen, send one at once (v0.19.1, after Sebastian's rprfo test found names slow and unreliable). A device unseen for 90s counts as gone, so a phone locked for longer drops off until it's back on screen. New calls `mog_snapshot2` / `mog_save_counts2`, with the old ones kept for older app versions. |

### Phase 2 decisions (2026-10-18)

| # | Decision | Chosen |
|---|---|---|
| E1 | Where Manage Items' logic runs | **One shared JS file, `template/editor/catalogEdit.js`, in the browser**, checked automatically against today's `Items.gs` on random stores (`tests/catalog_edit.test.js`, like `OrderMath.gs`). Supabase gets one general write, `mog_editor_apply`: it writes the changed rows only if each is still what the editor read, logs them, and rebuilds the phones' catalog. The same call serves the later tools and Undo. Rejected: the 7 actions written in SQL (no automatic comparison with `Items.gs` possible). Each store stays separate: the store comes from the sign-in token on the server, never from the page. |
| E2 | How `ManageItems.html` runs in the app | **The unchanged file, rendered static by `build.py`**, with `template/editor/host.js` standing in for `google.script.run`. No `apps-script/` file changes, so the live Sheet dialog and `/exec` editor can't break. Rejected: a Supabase mode inside `EditorShell.html` / `ManageItems.html` (every change a `--redeploy` and a risk to the editor every store uses). |
| E3 | Testing on `rprfotest` | **A local preview**: `python build.py --preview rprfotest --like rprfo` writes a git-ignored `_preview/` folder, served on localhost. Nothing public. |
| E4 | Par Review flags on Supabase | **Phase 4, with History**: the order log is copied from LOG_ORDERS at each store's switch, and the flag math moves to shared JS then. Until then a Supabase store's flags show "No data yet". |

**Phase 2 status (2026-10-18):** built and gated, not yet run against Supabase:
- `supabase/schema_v6.sql` + `smoke_v6.sql`: the change log, `mog_editor_login` / `_get` / `_apply` / `_undo`, D23.
- `catalogEdit.js` + `host.js` + the `build.py` preview.
- Gates `catalog_edit` (3,000 random steps, no difference from `Items.gs`) and `editor_host`.
- The Changes panel (Undo) shows on the page.

Intended differences from the Sheet: a pick row's item name and area order are looked up, not stored (D19); deleting an item removes its pick rows by ID.

### Phase 3 decisions (2026-10-18)

| # | Decision | Chosen |
|---|---|---|
| Q1 | "From now on" where the Sheet still owns the catalog | **"Just today" only, for now.** The phone offers "From now on" only where Supabase owns the catalog (`editor_direct`); elsewhere it says to use Manage Items on a computer. Each store gets it when its editor switches (Phase 4). The app never writes the Sheet (D9). |
| Q2 | Where an item added for today shows | **In its usual storage area** (taken from its first pick row that has one), with a "Today only" badge. |
| Q3 | Where a today par applies | **The item everywhere today** (one par per item, R6). |
| Q4 | What gets a "Needs review" flag | **Only the today-only edits.** A "from now on" change is permanent already: it shows in ↶ Changes with Undo. |

How it works: today edits live in `mog.quick_edits` and ride in the snapshot (`state.todayEdits`); `orderInputsFromSnapshot_` (`OrderMath.gs`) applies them, the one place the phone, `/exec`, the nightly order log and the recap all go through. The next cycle has none. Gates: `tests/quick_edits.test.js` (a today edit behaves exactly like the same catalog edit), `pwa_direct` (phone answers equal `/exec`'s with edits in; "from now on"), `editor_host` (Apply / Dismiss). Schema v7 + `smoke_v7.sql`. App v0.20.0.

**Deploy order (the close must honour edits before any phone can make one):** `OrderMath.gs` to every store (`deploy.py --redeploy`, canary rprfo), then schema v7, then the PWA (canary rprfo).

### Import from MarginEdge decisions (2026-10-18)

| # | Decision | Chosen |
|---|---|---|
| M1 | Where the items come from | **MarginEdge's Vendor Items export (vendorItems.csv), uploaded.** Works today with no key or setup. MarginEdge's read-only API (an `x-api-key`; vendors, vendor items, packaging) could feed the same screen later and would bring pack sizes. The CSV has none, so packs come in blank. Not built: it needs a key from MarginEdge and a server to hold it. |
| M2 | Where the import lives | **The Supabase editor only**: a button in the editor's bottom bar (`template/editor/meImport.js`), saving through `catalogEdit.js` `commitImportItems` like any edit (logged, undoable). No `Items.gs` twin, so a store uses it once its editor switches (Phase 4). |
| M3 | What an imported item is called | **MarginEdge's product name** (the company's own name, e.g. "Butter, Unsalted"), editable on the screen. Each MarginEdge vendor selling it becomes one of its vendors; the one bought from most recently is the primary (R6). |
| M4 | TNY Rockville's copied catalog | **Cleared at its switch.** tnyr/tnyrf's Sheets are copies of Tysons that nobody uses, so the switch starts them from an empty catalog instead of seeding it from the Sheet, then imports from MarginEdge. |

What starts ticked: products not in the store yet (by name or item code), in a category that's restocked (not equipment, furniture, repairs, linen, office or services), bought in the file's last 60 days. Imported items arrive active, with no par, no pack and no storage area (the Import Vendor contract), so they wait under Unassigned. New vendors have no delivery days. Gate: `tests/me_import.test.js`, plus one import through the host in `editor_host`.

**M5 (2026-10-18, later):** the import runs in two steps, **vendors first, then items** (Sebastian). Step 1 adds every new vendor ticked there, with items or not; step 2 lists only the products a ticked vendor sells.

### Phase 4 decisions (2026-10-18)

| # | Decision | Chosen |
|---|---|---|
| S1 | Tools ported before the first switch | **Manage Vendors, Storage Areas, Shelf to Sheet** (what a store set up from nothing needs). History, Health, Recipients and People come before rprfo's switch. |
| S2 | The Sheet after a store switches | **No copy back** (Sebastian; this replaces D17's nightly copy). The Sheet keeps the catalog it had and is not updated; its catalog tools refuse and point to the app. |
| S3 | How a store switches | **📱 Mobile API → Move the editor to the app** (Sync.gs): start from an empty catalog or copy the Sheet's (only when the parity check passes: the menu runs `catalogTablesParity_` and refuses otherwise, since 2026-10-19), then `mog_sync_switch_editor` (schema v8) turns `editor_direct` on and the Sheet marks itself (`MOG_EDITOR`). The store's `stores.json` entry gets `"editor": "supabase"`, so `build.py` publishes its editor at `/<slug>/editor/`. |
| S4 | Pages that read their data at load | **A small refactor of Storage Areas and Shelf to Sheet**: they read it in their start-up function, so `host.js` can supply it after sign-in. Nothing changes in the Sheet or `/exec`. |
| S5 | First store to switch | **TNY Rockville** (tnyr, tnyrf), starting empty, then Import from MarginEdge. rprfo next, the unused Tysons/Founders stores last. |

How it works:
- `catalogEdit.js` ports Manage Vendors (`Vendors.gs`), Storage Areas and Shelf to Sheet (`PickPath.gs`), gated against that real code in `catalog_edit`. Removing a vendor follows D23 (items stay active); the Sheet deactivates them.
- A renamed area is one `rename` step (schema v8), so its pick rows follow; a swap goes through a temporary name.
- Saves go in an order the database's links allow (renames, then pick-row and area deletes, then inserts and updates, then item and vendor deletes); `editor_host` runs them against the fake Supabase's link rules and undoes each.
- The app shows **Editor** on a computer once `editorDirect` is on (Settings until 2026-10-19, the rail since: L1), and hands its sign-in to the editor (no second PIN).
- The store service worker caches only the app's own page, so the editor never replaces the offline app.

**Rollout order:** run `supabase/schema_v8.sql`, then `smoke_v8.sql` and `check_api.sh`. Then Apps Script with `deploy.py --redeploy` (canary rprfo: the two page refactors, the menu item, the refusals). Then Rockville's switch in each of its Sheets (start empty). Then `"editor": "supabase"` for tnyr and tnyrf in `stores.json` and `build.py` (app v0.21.0, cache v61).

**Later (Sebastian):** the recap email could go out from Supabase too, once everything lives there. Not needed soon.

### Computer layout decisions (2026-10-19)

Sebastian picked from mockups (top strip, a button in each header, a side rail; then two computer layouts for the order guide): https://claude.ai/artifact/KjiL9rkTALw6HDnxhJC6MX

| # | Decision | Chosen |
|---|---|---|
| L1 | How a computer moves between the order guide and the editor | **A rail down the left** of both, replacing the bottom tabs on a computer: Today, History, Editor (only where the store's editor has moved), Settings. It replaces Settings → Editor and the editor's "← Ordering" button. Phones keep the bottom tabs and never see the editor. |
| L2 | The order guide on a computer | **Count beside the list**: Today's vendor list stays on the left; a vendor's count, its review, or the full order list opens on the right ("Pick a vendor" until one is open). History and Settings sit in a centered column (a two-pane History comes later). |
| L3 | Clicking another vendor while counting | **Save, then switch**: the open vendor's counts save quietly (the autosave's save); a failed save keeps it open. |
| L4 | Which stores, and when | **Every store on a computer** (a mouse and a window at least 900px wide), built **before** the History, Health, Recipients and People ports (A4 and A7 had it last); rprfo's switch waits for it. |

### Phase 4 port decisions (2026-10-19, later)

| # | Decision | Chosen |
|---|---|---|
| T1 | Order history once a store's editor moves | **Copied at each switch** (E4 as written): the Sheet's LOG_ORDERS dates that `mog.order_log` doesn't have are copied in (copy path only; a store that starts empty gets none, so tnyr gets none). From then on the phone's History tab and the editor's Order History read `mog.order_log`. Stores still on the Sheet keep `/exec`. Par Review flags move to shared JS, read from the same log. |
| T2 | Daily summary recipients | **Supabase, in Settings** (Sebastian): copied from the Sheet at the switch (and once for a store already moved); Settings → Recipients stays on phone and computer, answered by Supabase; the nightly email reads the list there. The GM row stays locked on a phone and is editable on a computer. |
| T3 | People ("Who's counting?" names) | **Settings → People, on a computer, every store**: rename or remove. A removed name isn't re-added by devices still holding it (they ask again); a rename follows to devices using the old name. Past counts keep the name they were saved with. |
| T4 | Health Check in the app (a moved store) | **Store and catalog checks**: phones on Supabase, last night's close ran, PIN lockout; vendors with no delivery days, active items with no area, par or primary vendor, backup vendors not on their vendor's list (one-click fix, logged and undoable), repeated item names. The Sheet-structure checks don't apply. |

How it works (schema v9):
- History: `mog_history` reads the order log; the History tab's answers, Order History's rows and the Par Review flags are `OrderMath.gs` functions (`historyRowsFiltered_`, `historyDatesFromRows_`, ..., `parReviewFlags_`), the ones `History.gs` and `MOGApi.gs` now run too, so the app and the Sheet can't drift. The switch's copy (`Sync.gs backfillOrderLogToDb_`, `mog_sync_backfill_log`) adds only dates the log lacks, with the pack the Sheet showed. Gate: `history_app`.
- Recipients: `mog.recipients`; `Recap.gs readRecipients_` reads it once the editor moved (the Sheet's list if Supabase can't be reached). The switch copies the Sheet's list, and so does the nightly run once for a store already moved; once a store has a list, the copy is refused. An older app's `/exec` save is refused. Gate: `recipients_people`.
- People: a removed name is marked, not deleted (`removed_at`), so a device still holding it can't add it back; picking it in "Who's counting?" (`mog_people_join`) does. A rename leaves the old name pointing at the new one (`renamed_to`). Gate: `recipients_people`.
- Health: `mog_editor_status` and `mog_editor_clear_lockout`; the report is `catalogEdit.js getStoreHealthReport`, in `Health.gs`'s shape, so the unchanged `HealthCheck.html` shows it. Gate: `health_app`.
- Still on `/exec`: the Daily summary button and the new-day reset fallback, so opening the editor first and then the order guide asks for the PIN once.

**Rollout order:** run `supabase/schema_v9.sql`, then `smoke_v9.sql` and `check_api.sh`. Then Apps Script with `deploy.py --redeploy`. Then `build.py` and push (app v0.23.0, cache v63). Until a store's editor moves, only People and the shared history math change anything there.

## Phases

1. **Live counting.** Today and the open vendor refresh every ~10s while the app is on screen (one Supabase read, ~0.3s; no Apps Script). Vendor cards show who is counting. The first-sign-in name picker and the self-building leaders list ship here too. An auto-refresh never overwrites a count you're typing.
2. **Editor foundation.**
   - The next schema version: the editor's saves in Supabase, the change log, Undo.
   - Manage Items as a computer-only section of the app, re-hosting today's `ManageItems.html` (one copy of the page).
   - Tested on the Sheet-less `rprfotest`.
3. **Phone quick edits.** "Just today" par and "today only" items. Both are data for the current cycle only, which the shared order math has to honour, so they go through `OrderMath.gs` with its gates. Manage Items gets a "Needs review" filter with Apply and Dismiss.
4. **Remaining tools, and switching each store.**
   - The tools: Vendors, Areas, Shelf to Sheet (built 2026-10-18, S1), then History (order log backfilled from LOG_ORDERS), Health, Recipients, People.
   - Each store's editor then switches: TNY Rockville (tnyr, tnyrf) first, since it's unused and starts from an empty catalog plus its MarginEdge import (M4; Sebastian, 2026-10-18), then rprfo, and the unused Tysons/Founders stores last.
5. **Desktop layout** for the ordering screens. Moved ahead of Phase 4's remaining ports on 2026-10-19 (L1-L4): the rail and count-beside-the-list first; a two-pane History later.

## Out of scope (for now)

- Roles beyond the shared PIN.
- The one-click vendor email: the Copy order builder already returns the subject, table and text it needs. It needs vendor email addresses, which belong with the vendor data in Supabase.
- New-store onboarding. (MarginEdge catalog seeding is in: see M1-M4.)
