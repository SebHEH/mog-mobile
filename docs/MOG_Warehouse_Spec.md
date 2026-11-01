# MOG — Warehouse (Happy Supply), concept library and new stores: spec

**Agreed:** 2026-11-01, Sebastian (spec-first, decisions below).
**Status:** approved, nothing built yet. HQ control (schema v11) and vendor contacts (v10) shipped the same day and are the base for it.
**Reference, not ported:** Chef Daniel's Happy Supply artifact (a claude.ai page) and "Happy Supply: System Overview for IT" (2026-10-26). They show what people already want; MOG rebuilds it from scratch on Supabase. Daniel's data isn't moved (it isn't really in use); the warehouse starts with a first count.

---

## The rule: three separate lists

| List | What's in it | Owner |
|---|---|---|
| **Warehouse products** | Only what HEH stocks in its own storage (today: king crab, shrimp). Stock per location, cost, handling fee, par. | Chef Dan (warehouse role) |
| **A store's order guide** | Everything the store orders, from every vendor (exists today). | The store |
| **Concept library** (new) | A starting template of a concept's standard items, every vendor, per concept and side. No stock. | HQ (Sebastian, Donny) |

- **Happy Supply is one vendor among the others,** with its own stock system behind it. It is not the master list.
- **The only link between the warehouse and a store:** a store item whose vendor is Happy Supply points at one warehouse product. Only those lines go to the warehouse when a KM sends the order. Sysco's, Baldor's or Chef Center's items never reach it.
- **An item a store gets from Happy Supply with another vendor as backup** sends only its Happy Supply lines to the warehouse.
- **A library item from Happy Supply** only says "stores in this concept get this from Happy Supply". It is not the warehouse product itself.

## Build order

| # | Piece | Size (estimate) | Depends on |
|---|---|---|---|
| 1 | Concept library | about 1 session | HQ (built) |
| 2 | Warehouse W1, W2 (stores already on MOG, and Dan) | about 2 sessions | HQ people and roles |
| 3 | Stores without a Google Sheet | 2 to 3 sessions; its own spec first | nothing |
| 4 | Chasin' Tails and NUE join MOG; warehouse W3 (chargebacks) | 1 to 2 sessions | 1, 2, 3 |

Until step 4, Chasin' Tails and NUE keep ordering through Daniel's artifact.

---

## 1. Concept library

**Purpose.** Each concept's standard items, per side (BOH, FOH), kept in one place so a new store's order guide starts from it in minutes and an LTO lands in the template as well as the stores.

**Who it's for:** HQ (Sebastian, Donny), opening a store or rolling out an LTO.
**Not for:** stores' own day-to-day edits (their order guide stays theirs); stock; pars.

**Decided:**
- **Split per concept and side** (Roll Play BOH, Roll Play FOH, Teas'n You BOH...). A new BOH store starts from its concept's BOH list. Matches today's separate BOH and FOH order guides (Rosslyn BOH 179 items, its FOH 70).
- **Seeded once from a store you pick** (for example Rosslyn BOH for Roll Play BOH), then cleaned in HQ: fix names, drop store-only items.

**Design notes (to be walked through before building):**
- **Lives in Supabase,** edited on a new HQ tab. Each item: name, pack, main vendor and backups as **HQ vendor names** (mapped to each store's names through HQ's remembered names, `mog.hq_vendor_links`), a suggested storage area, notes. No par: pars stay per store.
- **Setting up a store** copies the library through the HQ rollout (`commitHqRollout`): items arrive in the store's Needs setup, like an LTO.
- **An HQ LTO rollout can add its items to the library** in the same save.
- **A store's side isn't stored today** (only in its location's name), so the library's schema version adds it to `mog.stores`.
- **Open:** whether a store's own additions can be proposed back to the library.

---

## 2. Warehouse (Happy Supply)

**Purpose.** HEH's own warehouse on the same system as the order guide. It shows:
- what sits in each storage location;
- what's coming in from vendors;
- what went to which store;
- what each store owes.

A store orders from Happy Supply in its order guide like any vendor, and the order lands in the warehouse's queue instead of a Facebook chat.

**Who it's for:**
- **Warehouse admin (Chef Dan):** products, cost, handling fee and par; receiving vendor deliveries; counts and moves between locations (Berliner, Tysons freezer); shipping store orders.
- **Store GMs and KMs:** ordering from Happy Supply, seeing where the order stands, marking it received.
- **Sebastian and finance:** each store's monthly chargeback and the value of stock on hand.

**Not for:**
- stores' other vendors;
- store catalogs (Dan's warehouse sign-in can't touch them);
- accounting (chargebacks are exported; finance posts them).

**Success looks like:**
- A store's Happy Supply order reaches Dan's queue with no Facebook chat.
- Stock per location matches a physical count, and every change shows who, when and why.
- At month end, each store gets one CSV and statement listing every shipped line at the price locked when it shipped.

**Out of scope for now:**
- Toast and MarginEdge links;
- automatic emails to vendors or Berliner (copyable text, as Daniel's page does);
- lot and expiry tracking;
- moving Daniel's artifact data.

**Decided:**
- **Sending:** a **Send to Happy Supply** button on the review screen, next to "Copy order for email". The KM taps it after reviewing; Dan sees the order right away with the needed-by date. The vendor card then shows its status (sent, shipped, received). Not the 3:30 AM close.
- **Dan signs in** through the HQ invite and his own passphrase, with a **warehouse role** that reaches only the warehouse. Sebastian and Donny get both roles. HQ itself stays maintainers only (an HQ sign-in can change every store's catalog).
- **Pricing is Daniel's model:**
  - each store pays one all-in price per case: the weighted average cost plus a handling fee per case that covers rent and pickups;
  - stores never see the handling fee;
  - an optional % markup and per-order delivery fee, both 0 to start;
  - the price locks when an order ships.

**Kept from Daniel's page** (it answers questions we have too):
- numbered vendor orders in and transfers between locations, with "in transit";
- counts that log the difference as an adjustment with a reason;
- a product can be limited to some stores;
- monthly chargebacks per store with CSV and PDF.

**Left behind** (it was there only because the app lived in one person's claude.ai account): sharing levels as roles, browser-only storage, no backup.

**Phases:**

| Phase | What gets done |
|---|---|
| W1 | Warehouse data and Dan's page: products, locations, stock, vendor orders in (updating the average cost), transfers, counts and adjustments, history. The warehouse role on HQ's people. |
| W2 | Store orders: Happy Supply's items at each store linked to warehouse products (publishing a product to stores uses the HQ rollout); Send to Happy Supply on review; Dan ships from a chosen location (stock drops, price locks); the store marks it received. |
| W3 | Chargebacks per store and month (CSV, PDF statement). Chasin' Tails and NUE order through their own order guides once they're on MOG (step 4). |

---

## 3. Stores without a Google Sheet

Sebastian's goal: create a store entirely in Supabase, with no Sheet copy and no per-store setup, for the next Roll Play, Lei'd Poke, Chasin' Tails or NUE store.

**What a store's Sheet still does today,** each needing a new home first:
1. the 3:30 AM close and the order log (an Apps Script trigger per store, running `OrderMath.gs`);
2. the daily recap email (Apps Script's mail);
3. the nightly LOG_ORDERS backup;
4. setup: PIN, profile, concept, recipients (the `?page=setup` wizard and "Move this store to Supabase");
5. two leftover `/exec` uses on the phone (the Daily summary button, the reset fallback).

**Key decision for its own spec:** where the close and the email run without a Sheet. Either:
- **one central Apps Script project** (no Sheet per store) that closes every Sheet-less store, reusing today's code;
- or **Supabase itself:** a scheduled function running the order math, and email through a mail service. Fully Supabase, but new pieces and an email account.

It's a multi-session foundation, and it would also let the existing stores drop their Sheets later.

## 4. Chasin' Tails and NUE

They join MOG once 1 to 3 are in:
- new concepts (theme, icon, `build.py`'s concept list);
- a library per side;
- set up without a Sheet.

They then order Happy Supply through their own order guides, like every other store.
