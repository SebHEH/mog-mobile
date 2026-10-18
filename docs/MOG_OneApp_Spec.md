# MOG: one app per store (spec)

**Status:** agreed with Sebastian, 2026-10-18 (spec-first). Phase 1 (live counting) is built and gated, not yet deployed: `supabase/schema_v5.sql`, app v0.19.0. It also brought autosave on the count screen (a count saves ~4s after the last change, Supabase stores only), because counts used to reach Supabase only on Save or Review, so nobody else could see them. The Supabase design record (`docs/MOG_SupabaseMigration.md`) still holds how the data moves. This file holds what the app becomes.

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

- Two people counting different vendors each see the other's counts and "in progress" status within about 15 seconds, without touching the screen.
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
| P1 | Someone else's counts while you're on that vendor | **Fill them in live** within ~15s, with a brief highlight, on items you haven't touched. Anything you typed stays yours. |
| P2 | The name step | **Asked once per device, Skip allowed** (shown as "Someone"). It never blocks counting. |
| P3 | Keeping the name list tidy before the People tool exists | **Names unused for 30 days drop out of the picker.** Nothing is deleted. |
| P4 | How "who's counting" travels | The 15-second refresh read carries this device's name and open vendor (no extra requests). A device unseen for 90s counts as gone. New calls `mog_snapshot2` / `mog_save_counts2`, with the old ones kept for older app versions. |

## Phases

1. **Live counting.** Today and the open vendor refresh every ~15s while the app is on screen (one Supabase read, ~0.3s; no Apps Script). Vendor cards show who is counting. The first-sign-in name picker and the self-building leaders list ship here too. An auto-refresh never overwrites a count you're typing.
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
