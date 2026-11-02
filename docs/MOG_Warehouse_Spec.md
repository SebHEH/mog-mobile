# MOG — Warehouse (Happy Supply), concept library and new stores: spec

**Agreed:** 2026-11-01, Sebastian (spec-first, decisions below).
**Status:** approved. §1 (concept library) built as schema v12 on 2026-11-01; §2's W1 built as schema v13 and live on 2026-11-02; the rest isn't built. HQ control (schema v11) and vendor contacts (v10) shipped the same day and are the base for it.
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

**Built (schema v12, 2026-11-01; walked through and approved first):**
- **Lives in Supabase** (`mog.libraries`, `mog.library_items`, `mog.library_log`), edited on HQ's Libraries tab. Each item: name, pack, main vendor and backups as **HQ vendor names** (mapped to each store's names through HQ's remembered names, `mog.hq_vendor_links`), notes. No par and no storage area: both stay per store. (The suggested area was dropped once setup was decided to leave items without one.)
- **Starting a library from a store** (`librarySeed`): its active items with a vendor, in list order; a name listed twice (one row per vendor) becomes one item with the other vendors as backups. Then cleaned in HQ. A save is the whole list, refused (CONFLICT) if someone saved it since; every save is logged with the list before it.
- **Seeds (Sebastian, 2026-11-01):** Roll Play BOH from Rosslyn BOH (rpr), Roll Play FOH from Rosslyn FOH (rprfo), Teas'n You BOH from Tysons BOH (tnyt; 71 of its 208 items had no vendor yet and are left out), Teas'n You FOH from Rockville FOH (tnyrf).
- **Setting up a store** sends the saved library through the HQ rollout (`commitHqRollout`): items arrive with no par and **no area**, in the store's Needs setup, like an LTO (Sebastian's pick over placing them in the library's areas).
- **An HQ LTO rollout can add its items to the library** in the same save (a checkbox per concept and side of the ticked stores).
- **A store's side** is `mog.stores.side`, read from its location's name now and for new stores.
- **Not built:** proposing a store's own additions back to the library (still open).

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

### Design: W1, with W2's data (walkthrough 2026-11-02)

**Status:** approved by Sebastian 2026-11-02, and so were W1's screens (mocked up on the HQ canvas: Inventory and count, Incoming, Products and prices, https://claude.ai/artifact/3pJWHSWbMxVUyaRjmXkXqg). **W1 is built and live (schema v13, 2026-11-02; smoke_v13 44/44 in the SQL Editor)**; W2's tables below are designed, not built.

**Built for W1 (schema v13):**
- `supabase/schema_v13.sql`: the roles, the W1 tables and the nine `mog_wh_*` calls below; `smoke_v13.sql` (44 checks); a `check_api.sh` block.
- `template/hq/warehouse.js`: HQ's Happy Supply section (Inventory with Count a location, Incoming, Products and prices, Stock history), shown to the warehouse role; `template/hq/index.html` signs in with roles and shows each person the sections theirs open. `build.py` copies it into `hq/`.
- The screens match the mockup, with two changes: the sidebar's "Shipments" is "Incoming" (it could have meant orders leaving), and Orders and Chargebacks wait for W2 and W3.
- Gates: `tests/warehouse.test.js` (the page's sums and payloads against the fake; 6 planted-defect controls); CI also runs the real SQL in PGlite (`supabase/tests/run_pglite.mjs`).
- Seen in the browser against the fake only.
- **Price detail for W2:** a store's price uses the average cost to 4 decimals, so it can differ by a cent from the sum of the 2-decimal figures shown (shrimp at $77.3095 + $6 fee + 5% is $87.47, not $87.48).

**Decided (Sebastian, 2026-11-02):**
- Design W1 and W2's data together, build W1 first.
- Happy Supply is added to the Roll Play stores with W2's first products, in one HQ rollout per store (vendor and items in one change, one Undo), not before.
- **Stock never goes below 0.** A ship or transfer that would is refused until Dan counts that product at that location; the count logs the difference with a reason.
- **CI runs the real SQL.** The PGlite runner is committed with W1, and CI runs the schema chain and the smoke files on real Postgres (the repo's first npm dependency, pinned).
- **Schema number:** the next free one when the file is written (pull, then check `supabase/`). Numbers aren't held for a person: either maintainer may build the audit fix (`MOG_ClaudeCodeTask_2026_10_30.md` C2), and whichever schema file comes first takes v13.

**Where Dan works.** The HQ page (`/hq/`), with a Happy Supply section in its sidebar, shown by role. The approved HQ mockup already draws it there ("Happy Supply, inside the same HQ", its Orders board: https://claude.ai/artifact/3pJWHSWbMxVUyaRjmXkXqg). The warehouse screens go in their own file beside the page (`template/hq/warehouse.js`); the page is 83 KB already.

**Who signs in (W1).**
- `mog.hq_users.roles`: `hq`, `warehouse` or both. Everyone already invited gets both.
- `mog.hq_invite(name, roles)` invites with roles. The one-argument form keeps an existing person's roles and gives a new person `hq`.
- `mog_hq_data` and `mog_hq_apply` refuse a token without `hq`; every `mog_wh_*` refuses one without `warehouse`. Signing in returns the roles, and the page shows only the sections they open.

**Warehouse tables (W1).** All in the private `mog` schema, reached only through `mog_wh_*` functions.

| Table | One row is | What it holds |
|---|---|---|
| `mog.wh_locations` | a storage location (Berliner, Tysons freezer) | name, order, active |
| `mog.wh_suppliers` | a vendor the warehouse buys from | name; picked on a vendor order, added on Products and prices (pick-only, never free text) |
| `mog.wh_products` | something HEH stocks (king crab, shrimp) | name, pack (`20 LB case`), par in cases over all locations, average cost per case, handling fee per case, active, the stores it's limited to (none = every store) |
| `mog.wh_stock` | a product's cases at one location | kept by the functions in the same transaction as each move; never below 0 |
| `mog.wh_moves` | one change to stock, never edited | product, location, cases (+ or -), kind (received, transfer out, transfer in, count, shipped), the order or transfer number, cost per case on a receipt, reason on a count, who, when |
| `mog.wh_pos`, `mog.wh_po_lines` | a numbered vendor order in (PO-0001) and its lines | supplier, to which location, ordered then received or cancelled; per line the product, cases and cost per case |
| `mog.wh_transfers`, `mog.wh_transfer_lines` | a numbered move between locations (TR-0001) and its lines | from, to, in transit between send and receive |
| `mog.wh_settings` | one row | markup % and delivery fee per order, both 0 to start |

**What Dan does (W1).** Each is one `mog_wh_*` call, one transaction, with the product's stock rows locked:
- **Products, locations, suppliers, settings:** save one; refused when someone saved it since (CONFLICT).
- **Vendor order in:** create, edit while open, cancel, receive. Receiving takes the cases and cost actually delivered per line; stock rises at the order's location, and the average cost becomes (cases on hand x average + cases in x cost) / (cases on hand + cases in), over every location.
- **Transfer:** send (the cases leave the from-location and show in transit), then receive (they arrive). The cost doesn't change.
- **Count:** the cases counted per product at one location. A difference becomes a `count` move with a reason, required.
- **Reads:** `mog_wh_data` (products, stock, open orders and transfers, settings), `mog_wh_history` (moves, by product or location, newest first).

**Store orders (W2: designed now, built next).**

| Table | One row is | What it holds |
|---|---|---|
| `mog.wh_store_vendor` | which of a store's vendors is Happy Supply | follows a rename, goes with the vendor; set by the HQ publish |
| `mog.wh_item_links` | a store item that comes from a warehouse product | store and item to product; goes with the item; set by the HQ publish |
| `mog.wh_orders`, `mog.wh_order_lines` | a store's Happy Supply order (HS-0001) and its lines | store, cycle date, needed-by date, note, sent by; sent, shipped, received or cancelled; per line the item, product, cases ordered and shipped, ship-from location, price per case locked at ship, average cost at ship |

- **Send to Happy Supply** (the phone, with its PIN session): `mog_wh_send` takes the reviewed vendor's lines (item, cases). The server finds each line's product and refuses an unlinked item by name. Sending again for the same store, vendor and cycle replaces the order while it's still `sent`.
- **Dan ships** (`mog_wh_ship`): a location and cases per line. Stock drops (a `shipped` move with the order number), and each line's price per case locks: (average cost + handling fee) x (1 + markup %).
- **The store marks it received** (`mog_wh_received`).
- **The phone** gets the store's Happy Supply vendor and this cycle's order status in its snapshot, only when there is one. Prices and fees never reach a phone.
- **Publishing a product to stores** extends the HQ rollout: one change per store adds the Happy Supply vendor (the first time), the item (no par, no area) and its link.
- **W3's chargebacks** read `mog.wh_order_lines` (the price locked at ship).

**Where the rules live.** In the SQL functions, not in the pages: the handling fee must never reach a store, a price locks on the server, and two tabs (or Dan and a store) acting at once can't oversell. This differs from the catalog, whose rules live in `catalogEdit.js` and reach the database as ops.

**Checks.** The version's smoke file on the real SQL (PGlite in CI and on the computer, then the SQL Editor), a `check_api.sh` block, the fake (`tests/fake_supabase.js`) for the page, and a gate for the page's calls and the role refusals.

**Not in W1:**
- store orders (W2) and chargebacks (W3);
- undo: a wrong count is fixed by another count; a wrong receipt's cost needs a maintainer (the moves keep each receipt's cost, so the average can be replayed if a "Correct a receipt" is wanted later);
- lots and expiry, emails to vendors or Berliner.

**Open for W2 (not needed for W1):**
- The HQ mockup's Orders board has an Approve step (New, Approved, Shipped); this spec has sent, shipped, received. It's a status value either way, no table change.
- A linked store item orders in the product's case (the HQ publish sets its pack). Check with Dan that no store orders king crab or shrimp by the pound.

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
