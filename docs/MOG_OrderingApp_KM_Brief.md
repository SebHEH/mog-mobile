# MOG Order Guide — KM Tool Brief

**TOOL:** MOG (Master Ordering Guide): the ordering app on the phone at `sebheh.github.io/mog-mobile/<store>/`, and its **Manage** pages on a computer.
**AUDIENCE:** Kitchen Managers. They count and order on the phone every day, and set up their store's items, pars, vendors and storage areas in Manage on a computer.
**Written from the deployed code, 2026-11-03** (app v0.30.0, schema v18; `template/index.html`, `template/editor/`, `apps-script/OrderMath.gs`, `apps-script/Recap.gs`, `apps-script/Sync.gs`). It replaces the 2026-07-27 brief, which described the app before it moved off the Google Sheet. Section 13 lists what changed since then.

## 1. ONE-LINER

Count what's on the shelf and the app tells you how much to order from each vendor delivering on today's order, then emails the order list so it can be placed.

## 2. WHY IT EXISTS

Ordering used to mean a shared spreadsheet on a computer: easy to skip an item, easy to over-order, and nothing warned you a cutoff was coming. The app puts the count on your phone in the order you walk the shelves and does the order math the same way every time. It protects food cost (no guess-ordering), prep time (no trips to the office) and order accuracy (nothing due today gets forgotten). Manage lets each store keep its own items and pars right, with every change logged and undoable.

## 3. THE 60-SECOND EXPLANATION

Open the app, enter the store PIN and pick your name. **Today** lists only the vendors you order from today, earliest cutoff first. Tap a vendor and walk the shelves: items come up area by area, in shelf order. Type what you have for every item, 0 if you're out. The **Order** column shows what to order: the par for the days this delivery covers, minus what you have, rounded up. Tap **Review order**, then **Mark as reviewed**. When every card is done, tap **Email me the daily summary** so the order goes out, and place each order before its cutoff. At about 3:30 AM the day closes by itself: today's order goes into History and the counts clear for tomorrow.

## 4. WHO TOUCHES IT

| Role | What they do in it | How often |
|---|---|---|
| KM | Counts and reviews every vendor, sends the daily email, places orders (mostly the KM, sometimes the GM: Sebastian, 2026-07-27). On a computer: Manage (items, pars, vendors, areas, shelf order), Undo in Changes. | Daily; Manage weekly or as needed |
| BOH shift lead | Counts when the KM can't. Same PIN, same screens. Changes a par with **Just today** only; a par changed for good (**From now on**) is the KM's call (Sebastian, 2026-11-03). | As assigned |
| GM | Gets the daily email. The GM row on the email list is changed only on a computer. | Daily (email) |
| Anyone with the PIN | Settings → **Recipients**: who gets the daily email. **VERIFY:** who owns this list now (July: admin, HR or regional managers). | As needed |
| HQ (Sebastian) | Sends LTOs and vendors to many stores at once. Each one shows in the store's **Changes** as "HQ · <name>", and the store can undo it there. | As needed |

A KM can't change: the store PIN, an item's ID, or anything about an LTO (create, end, roll back). A KM can undo any change in Changes.

## 5. THE KM WORKFLOW

**On the phone, every day**

1. Open the app from the home-screen icon → enter the PIN → **Sign in**. The first time on a phone, **Who's counting?** asks your name: pick it (or **Someone else…**) → **Continue**. Others now see "<your name> counting" on the card.
2. **Today** → **Vendors today · N**. Each card shows the item count, the cutoff ("· cutoff 2:00 PM") and a status: **Not started** (red card), **In progress** (amber), **Reviewed**.
3. Tap a vendor → columns **Item / On hand / Order**, under storage-area headers, with "**5 of 23 counted**" at the top.
4. Type a count for every item, or use **−** / **+**. Decimals are fine. **DO NOT SKIP: out of it means type 0. A blank shows "—" and orders nothing.** Counts save by themselves a few seconds after you stop typing.
5. Tap **Review order** → check the list → **Mark as reviewed** → **Mark as reviewed** on the confirm. The bar fills, "<Vendor> reviewed!", and the card turns your concept's colour.
   - **Copy order for email** on the same screen copies that vendor's order (delivery day and store address included) to paste into an email or text to the rep.
6. Repeat for each vendor. Shortcut: the **✓ 5 / 23** pill on a card marks it reviewed. **Mark all remaining as reviewed** (bottom of the list) marks the rest and sends the email.
   - **Two people counting:** anyone can count (counts show on every phone within seconds), but **one phone** marks every vendor reviewed and sends the email. Reviewed is saved on the phone that marked it (Sebastian, 2026-11-03).
7. **DO NOT SKIP:** when every card is done, **All vendors reviewed** appears → the KM taps **Email me the daily summary** (Sebastian, 2026-11-03). It goes to everyone on Settings → Recipients; you should see "**Daily summary emailed · N recipients**". Marking the last vendor reviewed does NOT send it by itself.
8. Place each order with its vendor before its cutoff.

**On a computer (Manage)**

Open the same store link on a computer (a mouse and a wide window). The sidebar has **ORDER GUIDE** (Today, Order history) and **MANAGE** (Overview, Items, Vendors, Storage areas, Shelf to Sheet, Health check), with **Changes** and **Settings** at the bottom.

- **Overview** → **Set up <store>**, a 5-step checklist: Add your items · Set each vendor's delivery days · Create storage areas · Give each item a storage area and a par · Put each area in shelf order. Under it, **Needs attention**: par review flags, the phones' one-day edits (**Apply** / **Dismiss**), Health check problems.
- **Items** → click an item → set **Par**, **Storage area**, **Vendors** (the **Main** vendor plus backups) → **Save changes**. Saving needs a name, a main vendor and a par. An item reaches a count list only once it has a storage area.
- **Vendors** → **Delivery days** and **Order due by**. A vendor with no delivery days never shows on Today.
- **Changes** → every change, newest first, with who made it → **Undo**.

## 6. THE WEEKLY / DAILY RHYTHM

- **Every day, after the lunch rush** (Sebastian, 2026-07-27): count and review every vendor on Today, tightest cutoff first. Cards turn orange **"cutoff approaching"** 90 minutes before the cutoff and red **"cutoff missed"** after it.
- **Count everything, type a number, every day.** The counts are what show over-ordering and stock sitting on the shelf.
- **Before you leave:** send the daily email (step 7). If nobody sends it, it goes at the 3:30 AM close, after that day's cutoffs (`apps-script/Sync.gs`, `nightlyMaintenance_`).
- **Missed cutoff:** that vendor's order slips a full delivery. Call the rep for a favor, or add the items to a similar vendor's delivery (Sebastian, 2026-07-27).
- **Weekly, on a computer:** Manage → **Items** → the **Par review** filter. Read each flagged item's note and adjust its par. Also Overview → **Needs attention**.
- **When HQ sends an LTO:** Items shows **"New from HQ: <LTO> · N items to set up"** → **Set it up**: give each item a par and a storage area. Until then they're on no count list.
- **Overnight (about 3:30 AM):** nothing to do. The day closes, the order goes into History, counts clear, Emergency override turns off.

## 7. THE 3–5 THINGS THAT GO WRONG

1. **"I left it blank."** Blank orders nothing. Out of it, that's a stockout. Spot it: "—" in **Order**, "X of Y counted" short of Y. Fix: type a number for every item, 0 when you're out.
2. **The item isn't on any count list.** No storage area, no par, or its vendor has no delivery days: nobody counts it and it never gets ordered, with no warning on the phone. Spot it: Overview checklist, Items → **Needs setup**, the Vendors alert "<vendor> has no delivery days, so it never shows on Today." Fix: give it an area and a par, and set the vendor's days.
3. **Nobody sends the email.** Every card is green but nobody tapped **Email me the daily summary**, so whoever places orders has no list until 3:30 AM. Spot it: no "Daily summary emailed" toast; the panel doesn't say "Already sent today". Fix: send it from the all-done panel, or Settings → **Daily summary**.
4. **Counting after the cutoff.** Spot it: red "cutoff missed" on the card. Cost: a full delivery cycle. Fix: start with the tightest cutoff; if it slips, call the rep.
5. **A par changed for good by mistake.** On the phone, **From now on** changes the par for every order after today, and **Just today** changes it for today only. Shift leads use Just today; From now on is the KM's call. Spot it: Manage → **Changes**, "Changed the par of "<item>" on a phone: 4 → 6". Fix: **Undo** it there.

## 8. QUIZ-ABLE FACTS

- Q: You're out of an item. What do you type? / A: 0. A blank orders nothing.
- Q: How early does the orange cutoff warning show? / A: 90 minutes before the cutoff.
- Q: What do 5 wrong PINs do? / A: Lock the store's phones out for 5 minutes.
- Q: Does marking the last vendor reviewed send the email? / A: No. Tap Email me the daily summary.
- Q: When does Emergency override turn itself off? / A: At the overnight close, about 3:30 AM.
- Q: Which count screen does an item show on? / A: Its main vendor's.
- Q: Where do you undo a change to an item? / A: Manage → Changes → Undo.
- Q: What must an item have to reach a count list? / A: A storage area.
- Q: On the phone, who changes a par for good? / A: The KM, with From now on.

## 9. NUMBERS AND DEFINITIONS

- **The order:** par × the days this delivery covers − on hand, always rounded up to a whole number. At or above that: "0". Not counted: "—" (`apps-script/OrderMath.gs`, `computeSuggestedQty_`). Example: par 2 a day, Monday's order covers 3 days, 1 on hand: order 5.
- **Par:** set per item in Items. **Per delivery day** (the default, shown "N / day"): one day's use, multiplied by the days the order covers. **Fixed amount**: the same target every order day. Count, par and order are all in the item's pack unit (cases, bags) at every store (Sebastian, 2026-11-03).
- **Days covered (multiplier):** from the vendor's delivery days in Vendors. Orders go in the day before each delivery and cover until the next one (Vendors shows "Monday's order arrives Tuesday and covers 3 days").
- **Main / backup vendor:** the main vendor is where the item is ordered by default. A backup sits behind the small arrow next to the item name ("Main vendor: Sysco · Backups: Baldor"). Counting it on a backup's screen orders it from that backup.
- **Main vendor not ordered today (app v0.32.0, 2026-11-10):** the item shows on every backup that is ordered today. Whichever list counts it keeps it; on the other lists it moves to the bottom, greyed with no count box, under "Counted on B&T's list today", and that includes the main vendor's own list. To count it somewhere else, clear its count on that list first (`template/index.html`, `listSplit_`).
- **Today only:** an item added to a list, or a par changed, for today's order only. Manage flags it in Overview → Needs attention.
- **Reviewed:** a check that you finished a vendor. It locks nothing, and it's saved on that phone only: another phone doesn't see it (`template/index.html`, `setReviewed`).
- **Cutoff warning:** 90 minutes. **PIN lockout:** 5 wrong tries, 5 minutes, all the store's phones.
- **Par review** (Items, last 28 days, needs 3+ orders): **"Runs out"** when on hand was at most 10% of par at 75% of orders (par 3 or more); **"Over-ordered"** when on hand was at least 75% of par at half the orders. After a par change the item shows **"Par changed"** for 7 days (`OrderMath.gs`; `template/editor/Items.html`).
- **History:** the last 30 days. Today's order appears after the 3:30 AM close; before that use **View full order list**.
- **Limits:** 18 storage areas; a name not used in 30 days isn't offered in Who's counting?

## 10. WHAT IT DOES NOT DO

- It does not place orders. The email and Copy order are the handoff; a person places every order.
- It won't catch a blank. Blank is skipped silently.
- It doesn't share Reviewed between phones. Two KMs on two phones each see only their own checks, which is why one phone finishes the day.
- It won't warn about an item that's on no count list. Check Overview and Items → Needs setup.
- It won't stop two phones counting the same item on two lists at the same moment: both order. Once one count is saved, the item moves to the bottom of the other lists within about 10 seconds.
- It doesn't know what arrived, invoice prices or waste (MarginEdge does).
- Counts typed offline that reach the server after the 3:30 AM close aren't ordered. The app says so when they arrive.

## 11. NOT BUILT YET

- **WIP:** **Happy Supply** (HEH's own warehouse). Built, but no store has it yet. When it starts, its items show "N available"; its review screen has **Needed by**, **Note for Dan (optional)** and **Send to Happy Supply** instead of Copy order. A shipped order then shows under **To check in** at the top of Today, with a **Check in** button. Don't teach it as current; a one-slide "coming soon" is fine.
- **WIP:** **Elpis** (HEH's own packaging held at Elpis). Built, not in use. KMs keep ordering from Elpis as today. Once HQ sets it up, each delivery of HEH's items shows under **To check in** on Today ("From Elpis · HEH's items ordered Tue · EL-0002"): tap **Check in**, count what came, tap **Checked in**. No change to how you teach ordering now.
- **WIP:** the daily email sent from the new system instead of the Sheet. Doesn't change what KMs do.

## 12. OPEN QUESTIONS FOR SEBASTIAN

**Answered 2026-11-03 (folded into the sections above):**

- Sending the email? → **The KM taps Email me the daily summary when every card is green.** The last Mark as reviewed no longer sends it (removed on purpose: it sent emails people didn't know about). (§5 step 7)
- Two people counting one store? → **Anyone counts; one phone marks every vendor reviewed and sends the email.** (§5 step 6, §10)
- From now on on the phone? → **KMs only; shift leads use Just today.** (§4, §7 #5)
- Pars in the pack unit? → **Yes, at every store.** (§9)

**Still open:**

- Who owns Settings → Recipients now? Anyone with the PIN can change it on a phone (except the GM row).
- Do all KMs edit in Manage, or one setup person per store? (Rockville and Tysons BOH KMs set up their own stores.)
- Still true from July: the KM places most orders, sometimes the GM?

## 13. WHAT'S NEW SINCE THE 2026-07-27 BRIEF

- **Aug 4–7:** pull down to refresh on every screen; app updates arrive without signing out. Emergency override got a per-vendor day pick ("When is this vendor's next delivery after this one?"). The order math matches everywhere (screen, email, history).
- **Oct 4:** Teas'n You Rockville BOH and FOH joined.
- **Oct 15–17:** every store moved off the Google Sheet: phones save straight to the new system, and the day closes by itself at about 3:30 AM instead of at the first open in the morning.
- **Oct 18:**
  - **Copy order for email** on the review screen, with the delivery day and the store's address.
  - **Live counting:** **Who's counting?**, "<name> counting" on cards, and counts showing on other phones within seconds.
  - **Quick edits on the phone:** **Just today** / **From now on** par, **+ Add an item to this list (today only)**.
- **Oct 19:** Manage moved into the app on a computer, with one sidebar for Today and Manage. Order history, Recipients, People and the Health check came with it, plus the Overview checklist and **Import from MarginEdge**.
- **Oct 20:**
  - **Items** redesigned: search, filters (Active, Needs setup, Par review, Inactive), an item panel, and tick several items to change them together.
  - No more duplicate daily emails.
  - Late offline counts are flagged.
  - Typed negative counts become 0.
- **Nov 1:** **Vendors** page with each vendor's contact; a **Contact** pill on the Today card (Call, Text, Email).
- **Nov 2:**
  - HQ can send a named LTO to many stores. Its items wait at the top of Items until set up.
  - A store can rename a vendor, and its items and lists follow.
  - One spelling per vendor: "B&T Distributors LLC", "Elpis Wholesale".
- **Nov 3:** each item shows on its **main vendor's count screen only**, its other vendors behind a small arrow. Fewer double counts. Happy Supply and Elpis are built (section 11).

---

### Code notes for Sebastian (not for slides)

Found while writing this; none is taught above.
- **Stale wording, fixed in app v0.30.1 (2026-11-04):** "Unassigned" and "Manage Items / Manage Vendors" in the import message and Health check fixes; "Reset On Hand" in Order History; "vendor tabs" in Storage areas and Shelf to Sheet; "This locks counts" on Mark as reviewed; the ended-LTO note (now: par kept, storage area comes off); the Items bulk-bar note about backups.
- **Bug, confirmed and being fixed:** changing the area of an item with a backup vendor moved only the main vendor's row, so Items kept showing the old area (Rosslyn FOH: Ramekin Cups and Lids).
