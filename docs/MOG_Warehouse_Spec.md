# MOG — Warehouse (Happy Supply), concept library and new stores: spec

**Agreed:** 2026-11-01, Sebastian (spec-first, decisions below).
**Status:** approved. §1 (concept library) built as schema v12 on 2026-11-01; §2's W1 built as schema v13 and live on 2026-11-02; §2's W2 spec approved 2026-11-02 (W2a, then W2b), W2a built and live the same day as schema v16, and W2b built and live 2026-11-03 as schema v17; W2c (HEH's stock at three places: Happy Supply, RP Tysons, Elpis) spec approved 2026-11-04 and built as schema v20 the same day; the routes spec (one record per store and item, set on the HQ item) approved 2026-11-05, mockup next; the rest isn't built. HQ control (schema v11) and vendor contacts (v10) shipped the same day and are the base for it.
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
| 3 | Stores without a Google Sheet | 4 to 5 sessions; spec approved 2026-11-11 ([MOG_SheetRetirement_Spec.md](MOG_SheetRetirement_Spec.md)) | nothing |
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
- **An HQ LTO rollout can add its items to the library** in the same save (a checkbox per concept and side of the ticked stores). *Replaced 2026-11-02 (`docs/MOG_LTO_Spec.md`, not built yet): LTO items go to the LTO list only, and "Make it standard" on an LTO moves them into the library.*
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
| W2 | Store orders: Happy Supply's items at each store linked to warehouse products (publishing a product to stores uses the HQ rollout); Send to Happy Supply on review; Dan ships from a chosen location (stock drops, price locks); the store marks it received; cases available on the phone. In two parts (spec approved 2026-11-02, below): W2a Happy Supply, W2b HEH's stock held at Elpis. |
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
| ~~`mog.wh_store_vendor`~~ | which of a store's vendors is Happy Supply | *Replaced at the W2a walkthrough (below): HQ's remembered name, `mog.hq_vendor_links`.* |
| ~~`mog.wh_item_links`~~ | a store item that comes from a warehouse product | *Replaced at the W2a walkthrough (below): `mog.items.wh_product`, on the item's row.* |
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

### W2 spec (spec-first, approved by Sebastian 2026-11-02)

What W2 adds to the design above, and the answers to what was open for it. Not built.

**Purpose.** A store orders Happy Supply's crab and shrimp in its order guide, and the order lands in Dan's queue. A KM sees the cases the warehouse has while ordering. HEH's own packaging held at Elpis gets the same stock records, while KMs keep ordering it from Elpis.

**Who it's for:**
- KMs and GMs at the Roll Play stores (the first to get Happy Supply): order, see cases available, follow the order's status, mark it received.
- Dan: the order queue, shipping from a location.
- Whoever keeps HEH's stock at Elpis: Sebastian for now (who, decided later).

**Not for:** Elpis itself (no sign-in, it never uses MOG); Chasin' Tails and NUE (step 4); finance (W3); stores' other vendors.

**Success looks like:**
- A Roll Play store's Happy Supply order reaches Dan's queue from the phone.
- Dan ships from Berliner or the Tysons freezer, and stock drops; the store's card shows shipped N of M, then received.
- While counting, a KM sees "N available" on each linked item, and N matches the stock minus the orders not yet out.
- After a month, HEH's stock at Elpis matches Elpis's own report.

**Decided:**
- **No Approve step:** sent, shipped, received. Dan decides what goes on his ship screen and can cut a line there; the store's card shows shipped next to ordered. (The HQ mockup's Orders board had Approved; dropped.)
- **Cases available on the phone,** next to each linked item on the count and review screens. Available = on hand, minus open orders: for Happy Supply, sent and not shipped; for Elpis, ordered this cycle and not marked received. Unlinked items show nothing; prices and fees never reach a phone.
- **An order larger than what's available** is sent as typed, with "Only 4 available" on the line at review. Dan ships what he has.
- **Elpis:** KMs keep ordering HEH's own stock from their Elpis vendor, as today. Elpis is a location in Happy Supply's records, and those store items link to its products. Stock drops when the store marks its Elpis delivery received (pre-filled with what was ordered; the KM changes a short line). A Happy Supply order never ships from the Elpis location.
- **An Elpis delivery nobody marks** stays open and is listed for whoever keeps the Elpis stock. Nothing is assumed: cases available stays right (open orders are subtracted); on hand reads high until it's marked or counted.
- **Who keeps the Elpis stock** (shipments from China in, counts from Elpis's report): Sebastian for now. Not final.
- **Linking an item a store already has** (RP Large Bowls under Elpis, say): HQ picks that store's item instead of adding one, so its par and count history stay.
- **Mark received** on the vendor card, for Happy Supply and Elpis lines, pre-filled with what shipped (Happy Supply) or what was ordered (Elpis). Only an Elpis receipt changes stock; Happy Supply's dropped at ship.
- **Cases only.** A linked store item orders in the product's case (the HQ publish sets its pack).
- **Build order:** W2a, Happy Supply store orders (link, Send, ship, received, cases available); then W2b, Elpis as a location and its receipts. Each ships and is checked on its own. Every new screen (Dan's queue, the phone's Happy Supply card) gets a mockup first.

**Out of scope:** an Approve step; chargebacks (W3); emails to Elpis or Berliner; lots and expiry; Teas'n You ordering from Happy Supply until a product is sent there.

**W2a design (walkthrough, approved by Sebastian 2026-11-02).** Not built; mockups of the new screens come first.
- **Schema v16** (the next free number): `mog.items.wh_product`, `mog.wh_orders` / `wh_order_lines` (HS-0001), the phone's `mog_wh_send` and `mog_wh_received` (PIN session), Dan's `mog_wh_ship` and `mog_wh_order_cancel` (warehouse role), the orders in `mog.wh_state`, and `happySupply` in the phone's 10-second read (`mog.live_json`: the vendor, cases available per linked item, this cycle's order), sent only to a store with a link.
- **The link is on the item's row** (`mog.items.wh_product`, like `lto`), not a link table: Undo puts a deleted item's whole row back, and item numbers are reused (Rosslyn BOH's ITEM-0197 was Horse Meat, then the Fall Chicken Pho item, on 2026-11-02). Every item compare site carries it (SQL `editor_fields_match`, `catalogEdit.js` `matches`, the fake's `editorSame`), each held by a planted defect.
- **A store's Happy Supply vendor** is the one HQ's "Happy Supply" maps to in `mog.hq_vendor_links`: it follows a rename and leaves with the vendor. If a store removes it and undoes that, HQ links it again on Vendor names; until then Send is hidden.
- **The needed-by date** defaults to the next day Happy Supply delivers to that store (its delivery days); the KM can change it on review.
- **Linking and publishing are HQ's (hq role):** a product's Send to stores adds the vendor (the first time), the item (no par, no area) and its link in one change per store (`hqRollout` stamps the link); Link an item links one a store already has (`hqLinkItems`). Dan's warehouse sign-in never touches a store's catalog.
- **Pages:** the phone shows "N available" on linked items (count and review), Send to Happy Supply beside Copy order for email, and the order's status with Mark received on the vendor card; HQ gets an Orders page (queue, then Ship from a location). Send needs a connection; offline, the button says so.
- **Ship order:** v16 and smoke_v16 in PGlite, the fake and a gate (`tests/wh_orders.test.js`), the pages in `mog-preview`; then a maintainer runs v16 in the SQL Editor (smoke, `check_api.sh`), then `build.py` and a push with `CACHE_VERSION` bumped. No Apps Script change.
- **Mockups approved** (Sebastian, 2026-11-02; three boards in the "Happy Supply W2a" row of the MOG HQ redesign canvas, https://claude.ai/artifact/3pJWHSWbMxVUyaRjmXkXqg): the store phone (count with "N available", review with needed-by, the warning, a note and Send, Home with the order's status and the Mark received sheet), Dan's Orders (queue by needed-by, Ship and From per line, what's left after, price per case) and HQ's Send to stores (per store: link an item it has, pick-only, or add a new one; the TEST store apart; every store or none). Decided on them:
  - **Linking an item a store orders from another vendor** makes Happy Supply its main vendor and keeps the old one as a backup; its pack becomes the product's case.
  - **Send to Happy Supply also marks the vendor reviewed** (one tap); Home shows the order's status instead.
  - **Dan's Ship box starts with what's left after older orders** (the number the store was told), capped at the location's stock; he can raise it, and the line says which older order gets less.
- **Built (2026-11-02, not live):**
  - `supabase/schema_v16.sql` as above (generated parts: `editor_apply_ops` from v15, `live_json` from v9, `wh_state` from v13), `smoke_v16.sql` (50 rows), a v16 block in `check_api.sh`, `tests/fake_supabase.js` mirroring it, gate `tests/wh_orders.test.js` (9 planted-defect controls; 31 gates).
  - `catalogEdit.js` `commitHqProduct` (link or add, Undo exact) and `productCandidates`; `template/hq/warehouse.js` Orders (queue, Ship, Cancel, stock and open orders) and the product's Send to stores; `template/index.html` cases available, the review's needed-by, note and Send, the card's line and Mark received.
  - **Differs from the mockup:** a store without a Happy Supply vendor can't be ticked on Send to stores; the row sends HQ to Vendors first, since a new vendor needs its delivery days there (pick-only rule). The count screen's "N available" is drawn when the screen opens; the review re-checks it.
  - **Seen in the preview by script** (hidden pane): Send to stores added the item at the TEST store, the KM set it up, the phone showed "9 available", the review warned, Send went to Dan's queue, Ship 9 of 10 from Berliner at the locked price, the card showed it shipped, Mark received with one short. Right after a sign-in the card's line waits for the first 10-second read.

**W2b design (walkthrough, approved by Sebastian 2026-11-03).** Built and live the same day as schema v17 (below): smoke_v17 47/47 in the SQL Editor, `check_api.sh` 111/111.
- **Elpis is a location held by a vendor:** `mog.wh_locations.held_by` = HQ's "Elpis Wholesale" (null for HEH's own Berliner and Tysons freezer). Ship never takes from it.
- **A product says where stores order it:** `mog.wh_products.via`, Happy Supply (default) or Elpis Wholesale. An Elpis product's stock is kept at the Elpis location; shipments from China in (Incoming, a vendor order to Elpis) and counts from Elpis's report (Inventory) use W1's pages.
- **Recorded at the 3:30 AM close** (Sebastian's pick over "Mark as reviewed", which lives only on each phone): `mog_sync_close_cycle` (same signature, no Apps Script change) turns the closing cycle's order-log lines for the store's Elpis vendor whose items are linked to an Elpis product into an open Elpis delivery (EL-0001) in `mog.wh_orders` (`source` = `elpis`). The step runs in its own exception block, so a failure there never stops the close. A same-day re-close replaces that cycle's open delivery; a received one stays.
- **Available** for an Elpis product = its cases at Elpis minus open Elpis deliveries. Other stores' same-day orders count from the morning after their close.
- **The store marks it received** on its Elpis card, pre-filled with what was ordered; a line can be more or fewer. The Elpis stock drops then, and the line keeps the average cost for W3. Elpis gets no Send button: KMs order from Elpis as today.
- **A receipt beyond the records goes through** (Sebastian's pick over "refused until a count"): stock goes to 0, and the difference is logged as a count adjustment naming the store and EL number; HQ's Elpis page flags it for a count.
- **HQ's Elpis page** (warehouse role, Dan included; no new role): stock at Elpis with open and available, the open deliveries by store and age, and Mark received for a store (pre-filled, editable; the store's card then shows "HQ · Sebastian"). Orders and Ship leave Elpis deliveries out.
- **Send to stores for an Elpis product** links the store's own Elpis item (Elpis stays its main vendor); the first time, HQ picks which of the store's vendors is Elpis (pick-only) and that saves HQ's "Elpis Wholesale" name there.
- **Mockups approved** (Sebastian, 2026-11-03: "Approved, build it"): three boards in the "Happy Supply W2b" row of the MOG HQ redesign canvas (https://claude.ai/artifact/3pJWHSWbMxVUyaRjmXkXqg): the store phone (Rosslyn FOH), HQ's Elpis page, an Elpis product with Send to stores.
- **Built (2026-11-03, live the same day):**
  - `supabase/schema_v17.sql`: the columns above (`held_by`, `via`, `wh_orders.held_at`, `wh_order_lines.beyond`, status `ordered`, EL numbers), `mog.wh_held_from_log` (the close's step), `mog.wh_held_receive` (the stock drop and the count beyond the records), `mog_wh_held_receive` (HQ's Mark received), and, generated with asserted replacements, `mog_sync_close_cycle` from v2, `mog.wh_do_save` from v13, `mog.wh_do_ship`, `mog_wh_send`, `mog_wh_received` and `mog.wh_state` from v16. `smoke_v17.sql` (47 rows), a v17 block in `check_api.sh`, `tests/fake_supabase.js` mirroring it, gate `tests/wh_elpis.test.js` (9 planted-defect controls; 32 gates).
  - `template/hq/warehouse.js`: the Elpis page (open deliveries with Mark received for a store, received ones, the receipts beyond the records flagged until a real count, stock at Elpis with open and available, what's coming in, the last count), a product's "Stores order it from", a location's "Held by" (pick-only from HQ's names and the stores' vendors), Send to stores for an Elpis product (the store's Elpis remembered, or picked the first time and saved as HQ's name), Orders and Ship leaving Elpis out, a count and a vendor order offering the location's own products. `template/hq/index.html`: the Elpis entry in the sidebar, shown when a location has a holder.
  - `template/index.html` (app v0.29.0, cache v70): "N available at Elpis" on linked Elpis items, the review's warning and a note under Mark as reviewed, the Elpis card's open delivery and its Mark received (each line starting at what was ordered, more allowed).
  - **Differs from the mockup:** HQ's Elpis page uses the Orders page's list beside a panel (with Open and Received) instead of stacked cards; a store with no vendor named like the holder can't be ticked on Send to stores ("Add it on Vendors first"); an Elpis product shows no Happy Supply store price.
  - **Seen in the preview by script** (hidden pane; `tests/preview_server.js` now has an Elpis sample): the Elpis page with two open deliveries, HQ's Mark received for Rosslyn FOH with lids beyond the records (stock to 0, the count flagged), Send to stores refusing the BOH stores, Stock history's "Delivered to the store on EL-0002"; the phone's Elpis card, "36 available at Elpis", "Only 0 available at Elpis.", the receipt with more than ordered; no console or server errors, no sideways scroll at 375 px.

**Before it can be used (not before building):**
- Dan confirms that no store orders king crab or shrimp by the pound.
- Dan is invited (both roles, Sebastian 2026-11-05; the spec first said warehouse only) and adds products and a first count; until then W2 is checked in the preview only.

**Facts it rests on (live, 2026-11-02):** Roll Play's FOH stores order from "Elpis" a mix of branded packaging (RP bowls, lids, bags, Magnum roll boxes, utensil packets; AN broth containers) and Elpis's own catalog (tea, Karat cups, gloves); Teas'n You's stores order boba, tea, cups, lids and straws from "Elpis Wholesale" / "ELPIS". Which items are HEH's own stock is data HQ sets when it links them. One spelling for every store: "Elpis Wholesale" (Sebastian, 2026-11-02).

**Adding standard items to stores without an LTO** (built 2026-11-02, later 4): on HQ's Libraries page, tick items, then "Send N to stores" (the library's Set up path with only those items: no LTO record, no pin). W2's publish still has to add the product link.

### W2c spec: HEH's stock at three places (spec-first, approved by Sebastian 2026-11-04)

Why: after v19 the HQ pages read as a warehouse that sells to stores, with prices up front, while what Sebastian needs is how much of HEH's stock sits where. "Transfer (Tysons)" landed on Products and prices under "where Happy Supply's stock sits", and the Elpis page felt like a third system. Not built; a mockup comes first.

**Purpose.** HQ shows how much of HEH's own stock sits at each place right now, and what each store took from each place every month:
- **Happy Supply:** Dan's bulk stock, from the big shipments.
- **RP Tysons:** shrimp it holds for itself and for Rosslyn BOH and Founders BOH.
- **Elpis:** HEH's paper goods from China, kept at a vendor HEH also buys from.

**Who it's for:** Sebastian (all three places and the monthly list); Dan (shipments into Happy Supply, sending to RP Tysons); KMs keep ordering on the phone as today: RP Tysons from Happy Supply, Rosslyn and Founders from "Transfer (Tysons)", every store from Elpis.

**Not for:** Elpis's or Capital's own products; Teas'n You (for now); prices and charges (W3); other store-to-store transfers (Founders and Tysons also have a "Transfer (Rosslyn)" vendor).

**Success looks like:**
- One HQ page shows each place's stock per product, in cases, and what's on its way.
- A Happy Supply shipment to RP Tysons moves cases from Happy Supply to Tysons.
- A Rosslyn or Founders order from "Transfer (Tysons)" comes off Tysons' stock once checked in.
- Elpis's number matches Elpis's report on the day it's typed in, then drops with each check-in.
- At month end, a list per store of what it took from each place, in cases.

**Decided (Sebastian, 2026-11-04):**
- **Shrimp at Tysons is HEH's until a store takes it.** Tysons is a holding place like Elpis; the monthly list shows RP Tysons, Rosslyn and Founders each for what they took.
- **RP Tysons' own use comes from its MarginEdge count:** Tysons' Sunday inventory gives its stock; last count + what came in from Happy Supply − what Rosslyn and Founders checked in − the new count = what RP Tysons used.
- **Elpis's number comes from Elpis's report**, typed in as a count; check-ins subtract in between.
- **The monthly list is cases only**; prices come with W3 and stay off the main page.
- **One HEH stock page** replaces Inventory, Products and prices and Elpis as HQ's way in.
- **Round two, after the first mockup** (Sebastian: cards per place "change shape" as items grow; the product page was confusing, it should work like a store's items and vendors):
  - **Stock is one table:** items as rows, places as columns (who counts it and when under each place's name), amber below a place's low point, then "On the way".
  - **Items and Places mirror a store's Manage:** a place is like a vendor and an item sits at one or more places like a store item on vendors' lists; the Items page is the store's list beside a panel with one Save, and Places is the Vendors page (kind, held at, how it's counted, the stores that take from it under which of their vendors, where it gets its stock).
  - **Instead of a par, an item has a price and a stock level per place.** Stock level is both how much is there now (changing it saves a count and asks why) and a low point. The price is cost plus a fee: the cost from deliveries (never typed), a handling fee per case typed, the store price shown.

**Build steps (key decision, then the default):**
1. One HEH stock page: a table of items by place (round two; first drawn as a card per place). Prices live on Items, not here.
2. Tysons as a holding place: the "Transfer (Tysons)" location (made 2026-11-04) held by the vendor Rosslyn and Founders order from; their orders recorded at the 3:30 AM close and checked in on the phone. Default: reuse W2b's held places.
3. Happy Supply to RP Tysons: Dan ships RP Tysons' order and the cases move into Tysons' stock instead of leaving HEH's records. Default: a move between places, not a sale.
4. RP Tysons' own use from the MarginEdge count (above).
5. Elpis: its report as a count (built); its setup moves into step 1's page.
6. The monthly list per store and place, cases only.
7. Items and Places pages shaped like a store's Items and Vendors (round two): an item's name, pack, concept, its places with now and a low point each, and its price; a place's kind, holder, count source and stores.

About two sessions after the mockup. W1's stock records, W2a's orders and W2b's held places and check-ins stay; the HQ pages change most.

**For the walkthrough:**
- **A product is ordered from different places at different stores:** shrimp from Happy Supply at RP Tysons, from "Transfer (Tysons)" at Rosslyn and Founders. Today a product has one `via`; the store's own vendor has to decide it.
- **MarginEdge counts shrimp in pounds** ("Shrimp, 21/25 P&D", 60 on 2026-11-01 at $6.50, so 6 cases); MOG's SHRIMP is CASE (10LBs) at all three stores. Typed in by hand at first, or pulled from MarginEdge later (the MarginEdge API item in CurrentState's "Later").
- **Who types Tysons' Sunday count, and when:** not decided.
- Dan's pound-ordering answer and his invite still come before Happy Supply's real use.

**Facts it rests on (live, 2026-11-04):**
- SHRIMP is CASE (10LBs) at RP Tysons BOH (par 6, from Capital), Rosslyn BOH (par 7.15, main vendor "Transfer (Tysons)", backup SamuelSon) and Founders BOH (par 6, main vendor "Transfer (Tysons)", backup Capital). Rosslyn's last 35 days of shrimp orders went to SamuelSon (7 to 17 cases, twice a week); its main vendor changed after 11-01.
- RP Tysons is in MarginEdge as "Roll Play - Tysons": an inventory every Sunday on four count sheets (FOH, Kitchen, Storage Room, Walk-Ins); shrimp is on Walk-Ins, Walk-In Freezer.
- Live warehouse data: one held location (Elpis Wholesale, 2 products) and one HEH location, "Transfer (Tysons)", with no stock; no suppliers, no Happy Supply products or orders.

**Mockups approved** (Sebastian, 2026-11-04, second round: "Approved, design next"): the "HEH's stock" row of the MOG HQ redesign canvas (https://claude.ai/artifact/3pJWHSWbMxVUyaRjmXkXqg): Stock (one table), Items (like a store's Items page), Places (like its Vendors page), Who took what.

**W2c design (walkthrough, approved by Sebastian 2026-11-04).** Not built; about two sessions, one push.
- **Decided:**
  - **RP Tysons orders its shrimp on the phone from Happy Supply**, as today's W2a order; Dan ships; the cases go into the Tysons place when RP Tysons checks it in. RP Tysons' SHRIMP par covers all three stores (about 19 cases: its 6, Rosslyn's 7.15, Founders' 6), since its KMs count the whole freezer. Not chosen: Dan restocking Tysons from HQ by its low point.
  - **RP Tysons' Sunday count is typed in HQ** (Stock, Count a place, in cases: 60 lb is 6). Reading it from MarginEdge waits for a check that MarginEdge gives a server an API key, and is its own build after W2c.
  - **v20 replaces the close's delivery step** so it matches by place, inside v17's guard (a failure comes back as `heldError` and never stops a store's close). Rollback: re-run v19's version of that function. The morning after, every store's close is checked read-only.
- **Places are the warehouse locations, with a kind:** HEH's own (`held_by` and `held_store` empty), held at a vendor (`held_by` = HQ's vendor name, Elpis Wholesale), held at a store (`held_store` = the store, rpt; `held_by` = the name the other stores order it under, "Transfer (Tysons)"). `count_how` says how it's counted (in HQ, from MarginEdge, from a report); a label only.
- **An item sits at places:** `mog.wh_product_places` (product, place, low point) replaces the product's single `via`, which stays as a column nobody reads. Filled from `via` and from each product's `par` for its HEH-own places.
- **The store's own vendor for an item decides where its order comes from:** a vendor HQ's name maps to at that store (`mog.hq_vendor_links`) for a held place that carries the item, or the store's Happy Supply. The close (`wh_held_from_log`) records a held place's deliveries that way; `wh_available` and the phone's read (`wh_live_json`) give each linked item the cases at its own source place.
- **A Happy Supply order from a store that holds a place carrying the item is a move, not a sale:** `wh_do_ship` sets each such line's `to_location` and locks no price; the check-in (`mog_wh_received`, or HQ's check-in for the store) puts the cases into that place. Stock's "On the way" shows them until then.
- **Who took what** (`mog_wh_taken`, cases only): checked-in held deliveries and Happy Supply receipts per store, the holder store's own use per held-at-store place from count to count (count + in − out − next count), and moves between places apart.
- **Pages:** HQ's HEH STOCK group: Stock (items × places, amber below a low point, On the way with Check in for the store), Items (list and panel: name, pack, concept, places with now and a low point, price as cost plus a fee, the stores linked by name), Places (list and panel: kind, held at, how it's counted, the stores that take from it under which of their vendors, where it gets its stock), Incoming (Suppliers move here), Orders, Who took what, Stock history. Inventory, Products and prices and the Elpis page go. `catalogEdit.js` links items by place. The phone keeps its check-in list; VERIFY nothing there reads `via`.
- **Built (2026-11-04, not live):**
  - `supabase/schema_v20.sql` (generated: `wh_held_from_log`, `wh_do_ship`, `mog_wh_received`, `mog_wh_send`, `wh_order_json` from v17, `wh_in_transit` from v13, `wh_do_save`, `wh_state` from v19), `smoke_v20.sql` (37 rows; ten planted defects all caught), a v20 block in `check_api.sh` (123 probes), `tests/fake_supabase.js` mirroring it, gate `tests/wh_places.test.js` (9 controls).
  - `template/hq/warehouse.js`: Stock (one table, items by place, amber below a low point, "count it" after a receipt beyond the records, On the way with Check in for the store), Items (list and panel: name, pack, concept, places with Now and a low point, the price, which stores, Send to stores), Places (list and panel: kind, held at, the name stores order it under, how it's counted; the stores that take from it linked by name), Who took what (a month, three tables, CSV). `template/hq/index.html`: the HEH STOCK sidebar group.
  - **Found while building:** an opening count (nothing on record) would have read as negative use; the smoke and the SQL leave it out.
  - **Differs from the mockup:** Stock's "Count a place" is one panel for any place (MarginEdge's pounds typed as cases); Items keeps "Which stores can order it" and Send to stores from the old Products page; Who took what has no summary tiles.
- **Ship order:** `git pull` and v20 told to Donny first; v20 (`mog-supabase-schema`: smoke, fake, gate `tests/wh_places.test.js`, PGlite, planted defects), then the pages in `mog-preview`; a maintainer runs v20 and its smoke in the SQL Editor, the probe, then one push the same hour (today's pages save `via`, so they can't run on v20).

### Routes spec (spec-first, approved by Sebastian 2026-11-05)

Why: Sebastian's first W2c setup was refused on 2026-11-05. Items → SHRIMP → Send to stores asked Rosslyn BOH and Founders BOH for a Happy Supply vendor, though they take shrimp from RP Tysons. That screen was kept from v16/v17 and decides one route per item (`p.via || 'Happy Supply'`, `template/hq/warehouse.js`). The fitting link was on another page (Places → "Stores that take from it"). Underneath, HQ has no record of "this store gets this item from that place". It's worked out from six settings on four pages (the item's places, a place's "ordered as" name, HQ's remembered names, the store item's link, "Which stores can order it", the store item's main vendor), so a wrong route can't be seen. Forget on Vendor names also emptied HQ's remembered names, which the close and the phone read. Not built; a mockup comes first.

**Purpose.** For every HEH item, HQ shows and sets which stores take it, from which place, and under which of each store's own vendors. That's one record per store and item (a route), on one screen, saved in one go. The close, the phones and Who took what read that record, so what HQ shows is what happens.

**Who it's for:** Sebastian and Donny (the hq role) set routes; Dan (warehouse) sees them read-only.
**Not for:** KMs (the phone looks the same and reads the route); store catalog edits beyond the link; prices and charges (W3).

**What's separate, and the one link:**

| Record | What's in it | Owner |
|---|---|---|
| HQ item | name, pack, concept, cases at each place | HQ (counts: Dan too) |
| Place | kind (HEH's own, at a store, at a vendor), how it's counted | HQ |
| A store's order guide | its items, vendors, pars | the store |
| **Route** (the one link) | a store's item ← an HQ item, from one place, under one of the store's vendors | HQ sets it; the store's Changes show and undo it |

Live, as routes: RP Tysons BOH's SHRIMP from Happy Supply as "Happy Supply" (from Capital until then); Rosslyn BOH's and Founders BOH's SHRIMP from RP Tysons as "Transfer (Tysons)"; Rosslyn FOH (TEST)'s RP Large Bowls and Lids from Elpis as "Elpis".

**Success looks like:**
- SHRIMP's three stores are set up on one screen in one save, with no visit to Vendor names or Places.
- Each item lists its routes in words ("Rosslyn BOH · SHRIMP · from RP Tysons · as Transfer (Tysons)").
- A broken route (the store renamed or removed that vendor, the item went inactive, its main vendor moved elsewhere) shows on the item and on Stock, never silently.
- Forget on Vendor names can't change what the close records.
- A gate built from the live case runs the screens' own code: SHRIMP (Tysons from Happy Supply; Rosslyn and Founders from Tysons) and the Elpis bowls. The same case is in `tests/preview_server.js` (added 2026-11-05), and the mockup is checked against it.
- No field stays alive only so older smoke rows pass (`mog-supabase-schema`, rule rewritten 2026-11-05).

**Out of scope:** charges (W3); ordering by the pound; reading Tysons' count from MarginEdge; Dan's invite; store-to-store transfers that don't go through an HEH place ("Transfer (Rosslyn)"); history for the catalog side's remembered names.

**Decided (Sebastian, 2026-11-05, all as recommended):**
- **Routes are set on the HQ item:** a Stores table in its panel (store, its item, from, ordered as, status), one Save, like a store item listing its vendors.
- **One refill number for a store-held place:** the holder's par (RP Tysons' SHRIMP par, about 19, as decided 11-04). The place shows it and has no low point of its own.
- **Retired in v21:** `via`, the item's `par`, "Which stores can order it", Send to stores, Places' "Stores that take from it" and the first-word vendor guess. The older smoke rows that read them get rewritten. Existing links become routes.
- **Only the hq role sets routes;** the warehouse role reads them.

**Build steps (key decision, then the default):**
1. The route record. What decides where an order comes from: the route HQ set. The close records a store's lines only under the route's vendor; a store-side change shows on HQ as a broken route instead of rerouting.
2. The Stores table on the item (decided above).
3. Retire the list above (decided above).
4. Happy Supply becomes just a place: no hardcoded name. The phone's Send to Happy Supply appears for a vendor that routes to one of HEH's own places.
5. Carry over what exists: every current link becomes a route. Add `alter table mog.wh_product_places enable row level security;` (v20 left it off, unlike every other `mog` table; Supabase's advisor flagged it on 2026-11-05; the public keys can't reach `mog`).
6. Mockup, then build: one board set that walks the setup task (SHRIMP's three stores), then what Stock, Who took what and a Rosslyn phone show after; then the code design (architectural-walkthrough), then schema v21. About 1 session to mock up and design, 1 to 2 to build.

**Mockups approved** (Sebastian, 2026-11-05: "Approved, design next"): four boards in the "Routes" row of the MOG HQ redesign canvas (https://claude.ai/artifact/3pJWHSWbMxVUyaRjmXkXqg), drawn from live names:
- **Items → SHRIMP:** Places (Happy Supply with its low point; Transfer (Tysons) refilling at RP Tysons BOH's par), then the Stores table (store, its item, from, ordered as, status), "What each store gets", one Save. Price moved to a closed row at the bottom.
- **Stock after:** the stores per item, "Needs you" for a broken route (sample), "Waiting for check-in" (sample).
- **Places after:** the stores that take from a place, read-only; "Stores order it as" and the linking gone from the panel.
- **Rosslyn BOH's phone:** Friday's Transfer (Tysons) count with "104 available at Transfer (Tysons)", Saturday's "To check in", the check-in screen (unchanged screens).

Decided on them (both as recommended):
- **A store's vendor is added in the route row** when it has none (RP Tysons BOH's Happy Supply, delivery days Thu, Sat, Mon), with the Vendors page's rules (delivery days required, the name from HQ's list). Setup stays one save.
- **HQ can put a broken route back or end it:** "Put Transfer (Tysons) back as main vendor" (one change at the store, undoable there) or "End the route".

Noticed while drawing: a delivery from Tysons would be numbered EL-0003, since every held place uses EL (from when Elpis was the only one). Left as is for now.

**v21 design (walkthrough, approved by Sebastian 2026-11-05).** About two sessions, one push.
- **A route is three fields on the store's item row:** `wh_product` (v16), `wh_place` (new; empty = HEH's own places, Happy Supply) and `wh_vendor` (new; the store vendor it's ordered under, a foreign key like `primary_vendor`: a rename follows, a removed vendor empties it, which shows as broken). On the row, not in a table, for W2a's reason: Undo restores a whole row and item numbers get reused.
- **Every stock reader reads the route, never HQ's remembered names:** the close (`wh_held_from_log`: lines under the route's vendor, from the route's place), the phone's read (`wh_live_json`, same shape, so the phone code doesn't change), Send to Happy Supply (`mog_wh_send`: a vendor that routes to HEH's own). `wh_item_place`, `wh_store_vendor` and `wh_held_vendor` go.
- **HQ sets routes through the catalog save** (`catalogEdit.js` `commitHqRoutes`: link, a new vendor in the row, put back, end; one undoable change per store); `mog_wh_data` carries every route, so the warehouse role sees them. Setting one needs both roles (HEH STOCK opens to warehouse, the store write needs hq).
- **One Save, two writes:** the routes (every store or none) first, then the item's own fields; the status says which part saved.
- **Retired, kept unread until v23** (Sebastian's pick, so re-running v20's functions stays a rollback; v22 went to the stop rule below): `wh_products.via`, `par`, `stores`. A store-held place's low point goes to 0 (the holder's par refills it). Row security on `wh_product_places`.
- **One-time backfill:** each linked item's `wh_vendor` = its main vendor, `wh_place` = its only place (else v20's answer). Live 11-05: the TEST store's bowls and lids → Elpis as "Elpis".
- **Tests:** `smoke_v21.sql`; older smoke rows that set routing through remembered names or `via` get their setup rewritten, their assertions kept; a new gate from the live case (`tests/wh_routes.test.js`); `wh_orders`, `wh_elpis`, `elpis_setup`, `wh_places` and `tests/preview_server.js` moved to routes. Store cache v74 so each store's editor reloads `catalogEdit.js`.
- **Built (2026-11-05), live the same day** (`5754aca`; smoke_v21 31/31 in the SQL Editor, probe 129/129):
  - `supabase/schema_v21.sql` (generated with asserted one-match replacements: `item_row_json`, `editor_fields_match`, `editor_apply_ops` from v16, `wh_order_phone_json` from v17, `wh_live_json`, `wh_held_from_log`, `wh_do_save`, `wh_state`, `mog_wh_send` from v20), `smoke_v21.sql` (31 rows; 8 planted defects all caught), a v21 block in `check_api.sh`. The one-time fill was checked against the live shape in PGlite (the TEST store's bowls and lids → Elpis as "Elpis"; Rosslyn and Founders → Tysons when step 1's names exist; a re-run changes nothing).
  - Older smoke files on v21: smoke_v13 (par and stores checks dropped), smoke_v16, smoke_v17 and smoke_v20 (their links set as routes; v17's via rows now places rows; v20's "a place at a store needs the name" row gone, held under its own name), smoke_v19 (via dropped from one row). All pass in PGlite.
  - `catalogEdit.js` `commitHqRoutes` (a route; a new vendor or a new item in the row; End; Put back; ends first, so a route can move to another item); `hqProduct`, `hqHeldLinks` and `heldMatches` gone. `hq/warehouse.js`: the item's Stores table and its one Save (routes first, then the item), `routeStatus`, Stock's Needs you and stores per item, Places read-only; Send to stores, Places' linking, the first-word guess, "Which stores can order it" and par gone. `hq/index.html` passes `storeBy`.
  - Gates: `wh_routes` (new, the live shrimp, 7 controls); `wh_orders`, `wh_elpis`, `wh_places` on routes; `elpis_setup` without linking by name (its 4 controls for it gone); `lto`'s anchor moved.
  - **Differs from the mockup:** a store without the item can get a new one from the row ("+ Add a new item", no par and no area), since Send to stores' add mode went with it; the new vendor's name is picked from HQ's names plus HEH's own places (pre-picked only when there's one, live "Happy Supply").
  - Seen in the preview by script (hidden pane): SHRIMP's three routes set and saved in one go (Happy Supply added at Tysons BOH, Thu, Sat, Mon), no remembered names; Rosslyn BOH's phone reads 104 at Transfer (Tysons); Founders BOH moved to Capital showed on Stock and the item, Put back fixed it; Places listed the takers; no console or server errors.

**v22: an inactive item or a closed place stops its routes (walkthrough, approved by Sebastian 2026-11-05: "Stop and flag", build now).**
- **Found:** on v21 the 3:30 AM close recorded deliveries from a closed place and for an inactive HQ item, and HQ showed an inactive item's routes as Linked (a closed place's as broken, which the SQL didn't honour).
- **The rule:** a route moves stock only while its HQ item is active and its place is open. The close's step, the phone's read and Send all hold it in the SQL; `routeStatus` adds "The item is inactive in HQ". The routes stay on each store's item, so making the item active again or reopening the place resumes them with no store change; until then they're on Stock's "Needs you".
- **On the page:** unticking Active on an item, or Open on a place, names the stores whose routes stop (`warehouse.js` `routesStopped`) and says to End them for good. The server already refuses closing a place that still holds stock.
- **Defaults stated, not asked:** a delivery recorded before the item went inactive still checks in (the cases left the place); a store that moved its main vendor still records what it orders under the route's vendor ("Needs you"'s help line says so now).
- **Built (2026-11-05); SQL live 2026-11-06** (smoke_v22 15/15, probe 133/133): `supabase/schema_v22.sql` (generated: `wh_held_from_log`, `wh_live_json`, `mog_wh_send` from v21, `wh_available_at` from v20, no table change), `smoke_v22.sql` (15 rows; 5 planted SQL defects all caught), a v22 block in `check_api.sh`, the fake, `wh_routes` (3 new controls, 10 in all). Seen in the preview by script: RP Large Bowls made inactive named its 2 stores, then showed on "Needs you" and its Stores table; closing Elpis named the lids' 2 routes.

---

## 3. Stores without a Google Sheet

Sebastian's goal: create a store entirely in Supabase, with no Sheet copy and no per-store setup, for the next Roll Play, Lei'd Poke, Chasin' Tails or NUE store.

**Spec approved 2026-11-11: [MOG_SheetRetirement_Spec.md](MOG_SheetRetirement_Spec.md)** (the inventory of what each Sheet still does, with file and function; the decisions; the order of work). It retires the Sheets of the 10 existing stores too. In short:
- **The close:** a Supabase Edge Function running `OrderMath.gs` verbatim, started by `pg_cron` every 15 minutes for the stores that are due.
- **The recap email:** Resend, from a hehfood.com address (Sebastian adds the DNS records).
- **The backup** (replaces LOG_ORDERS): a nightly dump of every `mog` table to a private GitHub repo, kept 90 days.
- **A new store:** HQ → Stores → New store, PINs set there too.
- **Order:** the backup, the close and email (canary rprfo, then all), the phone off `/exec`, PINs and New store, then retire the triggers and deploy targets. About 4 to 5 sessions. The Sheets stay in Drive as an archive.

## 4. Chasin' Tails and NUE

They join MOG once 1 to 3 are in:
- new concepts (theme, icon, `build.py`'s concept list);
- a library per side;
- set up without a Sheet.

They then order Happy Supply through their own order guides, like every other store.
