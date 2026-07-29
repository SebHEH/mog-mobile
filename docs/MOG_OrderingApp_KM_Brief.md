# MOG Daily Ordering App — KM Tool Brief

**TOOL:** MOG (Master Ordering Guide) — the phone ordering app at `sebheh.github.io/mog-mobile/<store>/`
**AUDIENCE:** Kitchen Managers — they use it daily; they do not configure items, pars, or vendors (that lives in the computer editor, admin-side).
**Written from the deployed code, 2026-07-29** (`template/index.html`, `apps-script/MOGApi.gs`, `apps-script/Recap.gs`).

## 1. ONE-LINER

You count what's on the shelf, and the app tells you exactly how much to order from each vendor delivering on today's order — then emails the whole order list for you.

## 2. WHY IT EXISTS

Before this, ordering meant a shared spreadsheet on a computer: easy to skip an item, easy to over-order, and nothing reminded you a vendor's cutoff was coming. The app puts the count on your phone in shelf order, does the order math for you, and protects food cost (no guess-ordering), prep time (no walking back to the office), and order accuracy (nothing due today gets forgotten).

## 3. THE 60-SECOND EXPLANATION

Open the app and put in the store PIN. The **Today** screen lists only the vendors you order from today, each with its cutoff time. Tap a vendor and walk the shelf — items appear in the same order you walk it. Type a number for every item — 0 if you're out; the **Order** column instantly shows how much to order, based on the par set for each item. A blank orders nothing. When a vendor's list looks right, tap **Review order**, then **Mark as reviewed** — the card turns green. When the last vendor goes green, the app automatically emails the full order to everyone on the recipients list. Overnight, it files today's order into History and clears the counts for tomorrow — by itself.

## 4. WHO TOUCHES IT

| Role | What they do in it | How often |
|---|---|---|
| KM | Count items, mark vendors reviewed, resend the summary email, turn Emergency override on/off; **places the orders from the daily email** (mostly the KM; sometimes the GM) | Daily |
| BOH shift lead | May do the counting when the KM can't — same flow, same PIN | As assigned |
| GM | Receives the daily order email; may place orders; GM rows on the recipients list show "Managed by GM — edit in the spreadsheet" and can't be changed in the app | Daily (email) |
| Admin / HR / regional managers | Keep the Settings → Recipients list current per store; store PINs | As needed |
| KM (on a computer) | Items, pars, vendors, delivery days, cutoffs live in the separate computer editor — each store sets up its own vendors there. Separate training session. | Weekly / as needed |

## 5. THE KM WORKFLOW

1. Open the app from the phone's home-screen icon → enter the store PIN. On the first open of a new day you'll see **"Detected new day — resetting On Hand…"** run by itself — that's normal, let it finish.
2. **Today** tab → the header shows the date and store, then **Vendors today** with a count. Each card shows items, the cutoff (e.g. "cutoff 2:00 PM"), and a status: **Not started**, **In progress**, **Reviewed**, or **Submitted**.
3. Tap a vendor card → the count screen. Columns are **Item / On hand / Order**, grouped under storage-area headers in walk order. The top strip shows **"X of Y counted"**.
4. For each item, type what you have (decimals like 1.5 are fine) or use the **−  +** buttons. The **Order** number updates as you type. **DO NOT SKIP: if you're out of an item, type 0. A blank shows "—" and orders NOTHING.**
5. Tap **Review order** → check the list → **Mark as reviewed**. The confirm says "This locks counts for this vendor. You can still come back and edit if you need to." You should see the card turn green with a ✓ **Reviewed** pill and drop to the bottom of the list.
6. Repeat for every vendor. Shortcut: once a card shows counts entered, a **Mark reviewed** button appears right on the card. If every remaining vendor has at least one count, a **Mark all remaining as reviewed** link appears at the bottom.
7. When the last vendor goes green: the **"All vendors reviewed"** panel appears and the summary email sends itself — watch for the **"Daily summary emailed"** toast. If it fails, tap **Email me the daily summary** on that panel.
8. Place the orders with each vendor from the email, before each cutoff. This is usually the KM's job (sometimes the GM's).

## 6. THE WEEKLY / DAILY RHYTHM

- **Every day, after the lunch rush:** count and review every vendor shown on Today, before each vendor's cutoff time. Counting at a consistent time matters — the pars are tuned to a post-lunch shelf. The orange **"cutoff approaching"** badge appears 90 minutes before cutoff; after it passes you'll see **"cutoff missed"**.
- **Count EVERYTHING, type a number — even when you have plenty.** Every item on the guide should be ordering roughly once a week; if something goes 2+ weeks without ordering, that's sitting inventory tying up cash. The counts are the data that surfaces it — blanks hide it.
- **Deadline reality:** miss a cutoff and that vendor's order slips a full cycle. Recovery: call the vendor rep and ask for a favor; failing that, check whether another vendor that carries similar items can add them to its delivery.
- **Weekly (KM judgment):** review MarginEdge for items climbing in price — if a Secondary vendor is now cheaper, it may be worth making it the Primary for the coming week (done in the computer editor, not this app).
- **Overnight:** nothing to do — the next morning's first open logs the day into **History** and clears counts automatically.

## 7. THE 3–5 THINGS THAT GO WRONG

1. **"I left it blank."** Blank means NOT COUNTED — the app suggests nothing and the item never reaches the email. Out of it? That blank is a stockout. Have plenty? That blank erases the data point that shows what we over-order. Spot it: "—" in the **Order** column; "X of Y counted" short of Y. Fix: the standard is **count everything, type a number** — 0 when you're out, the real count when you're not.
2. **Nobody marks the last vendor reviewed.** The email only sends itself when ALL vendors are green — stall at 4 of 5 and no order email goes out that day. Spot it: no "All vendors reviewed" panel by end of shift. Cost: a whole missed order day (the morning reset emails it late, after cutoffs). Fix: finish every card; use **Mark all remaining as reviewed** if counts are in.
3. **Counting after the cutoff.** Spot it: red **"cutoff missed (was 2:00 PM)"** on the card. Cost: that vendor slips a full delivery cycle. Fix: hit the tightest-cutoff vendor first (the cards warn you 90 minutes out); if it slips, call the rep for a favor or add the items to a similar vendor's delivery.
4. **Changing counts after the email already went.** Spot it: gold banner **"Daily summary is out of date"**. Cost: whoever places orders works from wrong numbers. Fix: tap **Resend** on that banner.
5. **Emergency override left on / used casually.** It shows every vendor and sizes orders bigger (to cover each vendor's next delivery). Spot it: the amber **"Emergency override on"** banner. Cost: over-ordering across the board. Fix: **Turn off** when done; it also turns itself off at the next morning reset.

## 8. QUIZ-ABLE FACTS

- Q: You're completely out of an item — what do you type? / A: 0. Never leave it blank.
- Q: What does "—" in the Order column mean? / A: Not counted — nothing gets ordered.
- Q: When does the daily email send itself? / A: When the last vendor is marked reviewed.
- Q: You edited counts after the email went — what do you tap? / A: Resend, on the "Daily summary is out of date" banner.
- Q: How early does the orange cutoff warning show? / A: 90 minutes before cutoff.
- Q: Where do you add someone to the order email? / A: Settings → Recipients.
- Q: How many wrong PIN tries lock the app, and for how long? / A: 5 tries, 5 minutes.
- Q: When does Emergency override shut off on its own? / A: At the next morning reset.

## 9. NUMBERS AND DEFINITIONS

- **Order math:** order = par × today's multiplier − on hand, rounded UP; blank if no count entered, the vendor isn't delivering today, or you already have enough (`computeSuggestedQty_`, `apps-script/MOGApi.gs`). Admin changes pars in the computer editor.
- **Par:** the target amount to have for one day. One par per item, even if two vendors carry it (`MASTER_ITEMS` col G).
- **Day multiplier:** per vendor per weekday — how many days that order must cover until the next delivery (`SETUP` S:Y; set via delivery days in Manage Vendors, admin). 0 = vendor hidden that day.
- **Cutoff warning:** 90 minutes (`APPROACH_MINUTES`, `template/index.html`). Cutoff times are per-vendor, per-store data (`SETUP` col AA) — every live vendor should have one entered, but each store sets up its own vendors, so a missing cutoff means no warning will ever show for that vendor.
- **PIN lockout:** 5 wrong attempts → 5-minute lock for the whole store (`PIN_MAX_ATTEMPTS`, `PIN_LOCKOUT_MS`, `MOGApi.gs`).
- **Email dedupe:** the summary sends once per day automatically; **Resend** and **Email me the daily summary** can send again on purpose (`api_emailRecap_`, `apps-script/Recap.gs`). Subject: "[Store] Daily order recap — <date>".
- **Primary / Secondary badge:** Primary = this vendor is the item's default source. Secondary shows "Secondary · <primary vendor>" — you can order it here on your own judgment: primary out of stock, or the secondary's price is now better (check MarginEdge). A lasting switch of who's Primary happens in the computer editor.
- **Submitted (grey pill):** that vendor's order is already filed for this day — usually seen only around the overnight reset.
- **Offline:** counts save on the phone ("Saved offline — will sync when back online") and send when signal returns.

## 10. WHAT IT DOES NOT DO

- It does **not** place orders with any vendor. The email is the handoff; a person places every order.
- It won't catch a blank item — blank is treated as "skip," silently. The house standard (count everything, type a number) exists because the app can't enforce it.
- It won't stop you ordering the same item from its Primary AND a Secondary vendor on the same day (they share one par — that's a double order).
- It doesn't know what actually arrived, invoice prices, or waste. It only knows par minus your count. Price watching lives in MarginEdge.
- Items, pars, vendors, and cutoffs can't be changed in this app — that's the computer editor (a separate tool with its own training).

## 11. NOT BUILT YET

- **WIP:** automatic retry when the daily email fails to send — today a failure shows "Daily summary email failed. Retry from home." and needs a manual resend. Teach the manual resend; it's the real behavior.
- **WIP:** faster new-store setup tooling (`onboard.py`) — admin-side only, no change to how you teach the app.

## 12. OPEN QUESTIONS FOR SEBASTIAN

**All resolved 2026-07-29 (answers folded into the sections above):**

- Who places orders from the daily email? → **KM or GM, mostly the KM.** BOH shift leads may also do the counting. (§4, §5 step 8)
- When to count? → **After the lunch rush.** (§6)
- Missed cutoff recovery? → **Slips a cycle; call the rep for a favor, or add items to a similar vendor's delivery.** (§6, §7 #3)
- Cutoff times entered everywhere? → **Yes for live vendors, but per-store setup — a store that skips one gets no warning.** (§9)
- Blank-on-purpose OK? → **No. Count everything, type a number** — the counts are the data that exposes over-ordering and sitting inventory (anything not ordering ~weekly). (§6, §7 #1)
- Secondary ordering on KM judgment? → **Yes** — including watching MarginEdge prices and proposing a Primary flip for the week. (§6, §9)
- Who owns the Recipients list? → **Admin, HR, or regional managers.** (§4)
