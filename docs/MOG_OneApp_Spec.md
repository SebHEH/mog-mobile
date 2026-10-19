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

## Phases

1. **Live counting.** Today and the open vendor refresh every ~10s while the app is on screen (one Supabase read, ~0.3s; no Apps Script). Vendor cards show who is counting. The first-sign-in name picker and the self-building leaders list ship here too. An auto-refresh never overwrites a count you're typing.
2. **Editor foundation.**
   - The next schema version: the editor's saves in Supabase, the change log, Undo.
   - Manage Items as a computer-only section of the app, re-hosting today's `ManageItems.html` (one copy of the page).
   - Tested on the Sheet-less `rprfotest`.
3. **Phone quick edits.** "Just today" par and "today only" items. Both are data for the current cycle only, which the shared order math has to honour, so they go through `OrderMath.gs` with its gates. Manage Items gets a "Needs review" filter with Apply and Dismiss.
4. **Remaining tools, and switching each store.**
   - The tools: Vendors, Areas, Shelf to Sheet, History (order log backfilled from LOG_ORDERS), Health, Recipients, People.
   - Each store's editor then switches, rprfo first and the unused Tysons/Founders stores last.
5. **Desktop layout** for the ordering screens.

## Out of scope (for now)

- Roles beyond the shared PIN.
- The one-click vendor email: the Copy order builder already returns the subject, table and text it needs. It needs vendor email addresses, which belong with the vendor data in Supabase.
- MarginEdge catalog seeding and new-store onboarding.
