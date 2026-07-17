# MOG (Master Ordering Guide): Blueprint Questionnaire

Fill this out and send it back. Goal: capture the *whys* behind the ordering logic that the code
cannot show, so the Logic Blueprint is precise and nothing gets "simplified away" when MOG eventually
folds into the company operations app.

**How to answer:** each question has my current best guess after `Guess:`. Just write your answer
after `▶`. If my guess is right, write "correct" (or tweak it). If you don't know or it doesn't
matter, write "skip". Short answers are fine. Anything you leave blank stays marked ASSUMED in the
blueprint.

The blueprint draft is in `docs/MOG_LogicBlueprint.md`. The `Q-…` codes below match the "Open
questions for the owner" list at the bottom of it.

---

## Part A: Who uses it and how they get in

**A1. The users.** Who actually places orders in MOG day to day?
Guess: kitchen managers (KMs), one per store, on their phones. ▶ Kitchen Managers, General Managers if needed, Assist Managers or Assistant General Managers, Back of House Shift Leads, etc. Alsos light correction but its not placing orders in MOG. MOG is just counting inventory essentially to get how much we should order. No orders are actually placed through here.

**A2. Role distinctions (Q-ROLE-1).** Is there any role tiering in MOG, or is it flat "anyone with
the store PIN can do everything, and the master PIN unlocks the destructive stuff"?
Guess: flat — store PIN for normal use, master PIN for resets/admin; no per-person roles like Store
Reports has. ▶ Yup no per person roles.

**A3. Do GMs or shift leads use MOG at all**, or is ordering purely a KM job? (e.g. does a GM ever
place an order, or only review?)
Guess: KMs place orders; GMs mostly own the catalog/pars via the web editor. ▶ KMs and GMs can own the catalog/pars. Other members use it only to do the count if needed so that GMs and KMs can place the order if they are not able to be at the store or it's a day off. Shift leads use MOG and AM (assistant managers)/ AGM (assistant general managers). The goal is that pars are BAU (Business as Usual) and this is an easy way for people to do a simple task, counting whats on hand, so that anybody can come in and be a KM and not have to deal with figuring it out on their own or having to create their own thing. Also allows our KMs to go on vacation without having to worry that the store will suffer without them. (Also some distinction where BOH ordering (mostly food items) and FOH ordering (mostly paper goods))

**A4. PIN login (Q-ACCESS-1).** Why PIN instead of real accounts/passwords?
Guess: same PINs they already use to clock in, so it's simpler and there are no company emails to
manage. ▶ Pins instead of real accounts/password because I wanted it to be easy to access but also make it not possible that one store accidentally uses another store's order guide since there's like a hub where you can choose which location to login to. Pin is set to store's street number. But yes also no company emails to manage and our shift leads can use it because they typically don't have company emails.

**A5. Store isolation (Q-ACCESS-2).** Why is each store walled off so strictly — a KM only ever sees
their own store's items/vendors/orders?
Guess: need-to-know; a KM has no reason to see another store's ordering, and it keeps the app simple.
▶ Yes correct.

---

## Part B: The order math (the core asset)

This is the part a rebuild is most likely to get subtly wrong, so the whys here matter most.

**B1. Round up (Q-ORDER-1).** Suggested quantities always round UP to a whole unit
(`ceil(par × coverage − onHand)`). Why never round down / never order short?
Guess: running out mid-service is far worse than a little extra on the shelf. ▶ Yes correct. Also rounds to whole units because vendors sell the items whole, you can't order .5 or .25 of an item.

**B2. Shared par (Q-ORDER-2).** Each item has ONE base par, shared across every vendor that can
supply it, and the day multiplier (not a second par) handles vendor-specific coverage. Why one
shared par rather than a par per vendor?
Guess: the target stock level for an item is the same no matter who you buy it from; only *how many
days you're covering* changes by vendor, and the multiplier already does that. One number is also
easier to maintain and can't drift. ▶ Yes correct. I wanted an easy way for people to be able to compare prices of items between vendors to determine if they should buy from a cheaper source that didn't require them to manually create a new duplicated item and also have to manually figure out the new par based on that vendor's delivery days. I also wanted them to be able to know where else they can buy an item easily without having to search on the vendors website + if our primary vendor is not delivering tomorrow but we run out of the item sooner then expected we can recover by using a secondary vendor. Basically cut out the time spent on manually searching and looking each time we have to change things.

**B3. The day multiplier / coverage model.** The multiplier encodes "how many days of par this order
must cover" based on when the vendor next delivers (e.g. a Thursday-only vendor might be 3× on
Thursday to cover through Sunday). Is that the right mental model, and is the multiplier set per
vendor per weekday by hand, or derived from delivery days?
Guess: right model; delivery days are picked and the per-weekday multipliers are derived from them.
▶ yes correct.

**B4. Use-multiplier flag.** When an item's use-multiplier is OFF, it orders flat to par (coverage =
1×) regardless of vendor cadence. What kind of item is that for?
Guess: items billed/sized by the week or on a fixed contract, where par is already the right number
and shouldn't be scaled up. ▶ Sort of. It's for items taht we don't actually go through that quickly. Things that come in bulk that we can't order smaller quantities of or it's cheaper in bulk and doesn't go bad quickly don't need a multiplier. Same with batch recipes because some recipes you don't have to scale based on when you make it because it's a set recipe. It's to avoid over-ordering.

**B5. "Vendor doesn't deliver today" = multiplier 0 = nothing to order.** When a vendor's multiplier
for today is 0, its items simply don't show an order. Is that purely "you can't order what won't be
delivered," or is there more to it?
Guess: purely that — no delivery today means nothing to order today. ▶ Basically. When we place an order it's typically that the vendor delivers the next day. As a restaurant we don't have the luxury of having a lot of space to hold perishable foods and also we value freshness and quality. So we order just enough to cover us until the next delivery so that we don't over order, produce waste, and eliminate issues with cash flow (no unnecessary sitting inventory).

**B6. Emergency override (Q-ORDER-4).** It switches coverage from "today's cadence" to "bridge to
the vendor's next scheduled delivery," it's store-wide, and any KM can turn it on (with a confirm).
Why is it any-KM rather than manager-only, and is store-wide (vs. per-vendor) the right scope?
Guess: any KM because it's an operational "we're ordering off-schedule today" call, not an admin
action; store-wide because when you're off-schedule it usually applies to the whole order. ▶ Yes correct. THis is more of when there are issues with vendors being able to delivery in their regular cadence like a holiday falling on their typical delivery date, and a lot of vendors share more or less the same delivery days so it applies to all vendors to make it simple.

**B7. Par ownership (Q-PAR-1).** Who sets and owns the par values, and are pars true *one-day* pars
at every store now? (There was a note that Rosslyn's pars might have been multi-day.)
Guess: GMs/KMs own pars via the web editor; pars are meant to be one-day pars everywhere, recalibrated
where they weren't. ▶ GMs/KMs own pars via the web editor. pars are meant to be one-day pars but for BAUs meaning we have to ensure we have more then enough because sometimes a certain day of the week that typically isn't busy might become a lot busier suddenly, maybe there's an event, so we accomdate for that in the par or maybe we have a lot of caterings that we don't typically get week to week so we have to ensure we don't run out either. We can't set it exactly to 0 because we have to take into account when we place the order (meaning most vendors have cutoff times, so we have to order before we even finish the day so some things that we count on hand might end up getting used, so in the par itself we have it built in to cover taht, and also maybe a vendor has an itme that is oos so the "one-day" par is more like a 1.5-2 day par for safety measures)

---

## Part C: Multi-vendor sourcing

**C1. Why multiple vendors per item.** An item can sit on several vendor tabs at once (one primary,
the rest backups), all fully orderable, sharing one par. What's the real-world need?
Guess: some items are stocked by more than one supplier with complementary delivery days (e.g. B&T
and Chef Center), so you order from whichever is delivering / in stock that day. ▶ Correct and also like said earlier to minimize the time spent on looking for a substitute if a vendor is out of stock. Rather then having to search each vendor's catalog manually you already know you can order from another vendor. Also vendor pricing on items may vary week to week and oyu notice we can save a lot ordering from a different vendor so you can swap that vendor to be the primary to make sure you order from them more often then the other more expensive vendor in the current moment if that makes sense.

**C2. Per-tab on-hand routing.** Because each vendor tab tracks its own on-hand for the item, the KM
effectively chooses the source by which tab they count/order on. Is that intentional, or would you
rather the system pick the vendor for them?
Guess: intentional — the KM knows which vendor is delivering / has stock; the app shouldn't guess. ▶ Yes more or less, combined with other reasons stated above.

**C3. Promote-in-place (Q-ORDER-3).** When you reassign an item's primary vendor, the old primary
stays on as a backup rather than being dropped. Why keep it?
Guess: you rarely want to fully sever a vendor relationship for an item — the old one is still a
valid backup, so removing it would lose a source you'll likely want again. ▶ Yes exactly.

---

## Part D: The daily cycle

**D1. Auto-reset (no manual button).** A new order day auto-resets on first app/sheet open, and the
manual "start the new day" button was removed. Confirm that's the desired behavior and there's no
case where a KM needs to force a reset mid-day.
Guess: correct — auto only; no mid-day manual reset needed. ▶ Yes correct. This was to also make sure the recap email gets sent out and it's logged in the order history.

**D2. Recap email (Q-INT-1).** The recap ("today's suggested order") is sent exactly once per order
cycle, guaranteed, no matter which path triggers it. Who is it actually for — the person who places
the order with the vendor? And if the email send fails, should it retry, or is once-per-cycle final?
Guess: it goes to whoever actually places the orders / leadership; if it fails it's currently
once-and-done (no retry). ▶ It should retry if the email send fails, but ideally once-per-cycle. It goes to the manager and the KM for review. For example the KM might use the email after they're done counting whats on hand to then open up the email on their phone and place the orders through vendor websites on their laptop or vice versa. It's also an accountability thing, meaning if they filled it out, and it told them to order a certain amount, but we run out and the GM looks to see what was actually placed in the order, if the person who placed it actually followed the par or not, and if they didn't why didn't they. If they did, did the vendor make the error, or are they out of stock and couldn't delivery any or like only half the order. If so how did we no recover from there because the BOH SL who received the delivery and checked the delivery and checked the invoice should have caught it, flagged it, and let the KM or GM know so that we can get the item before we run out and have to 86.

**D3. Offline counts.** Counts entered offline are queued and flushed before any reset can wipe them.
Confirm this is a hard requirement (never lose a KM's counts to a bad connection).
Guess: hard requirement. ▶ Yes

**D4. What gets logged.** Only lines with a positive suggested quantity are recorded to history
(zero/nothing-to-order lines aren't). Is order history mainly for the par-review flags, or do you
use it directly (auditing, reordering patterns)?
Guess: mainly feeds par-review + a reference of what was ordered; not a formal audit trail. ▶ For par-review + a reference of what was ordered. Also useful for audit trail and useful for having a history of how much product we go through for each item so that if want to discuss with a new vendor we can show them how much we go through week to week or in a month so they guage if they would be able to supply us, or be able to source items for us, etc. It's useful data.

---

## Part E: Par review

**E1. The 75% cutoff + whole-unit floors.** Over-order flags only fire when average on-hand is ≥ 1
whole unit and there's a whole unit's worth to trim, and the on-hand cutoff is 75% (because counts
are post-lunch and ~half a par is reserved for dinner + PM prep). Confirm that reasoning is right and
still current.
Guess: correct as documented. ▶ correct more or less.

**E2. What happens with a flag in real life.** When par-review flags an item as over/under, what's
the intended follow-up — does someone actually adjust the par, or is it just informational?
Guess: informational nudge for the GM/KM to reconsider the par; no automatic change. ▶ Yes informational nudge so the GM/KM make the final decision because they know what they truly need for their operations.

---

## Part F: Scope, concepts, integrations

**F1. Catering (Q-SCOPE-1).** Does MOG handle catering ordering at all, or is catering only in the
Store Reports tool? (I flagged this as a possible cross-over — want to make sure I'm not importing a
Store Reports concept into MOG by mistake.)
Guess: catering is a Store Reports thing, NOT MOG — MOG is daily inventory ordering only. ▶ Correct

**F2. Concepts.** MOG currently runs Roll Play and Teas'n You stores. Do ĂN and Lei'd Poke use MOG
yet, and does any concept need genuinely different ordering *logic*, or just different theming/data?
Guess: RP + TNY live today; ĂN/Lei'd themed but not deployed; concept difference is theming + data,
not different order math. ▶ Correct.

**F3. Integrations (Q-INT-2).** For Store Reports you named MarginEdge (cost) and Toast (POS) as the
big future integrations. Do those apply to MOG too — e.g. pulling cost onto orders, or sales/usage to
inform pars?
Guess: yes — cost from MarginEdge on orders, and eventually Toast sales/usage to inform pars, are the
integrations MOG most wants. ▶ Yes. Ideally it's to make it as simple and efficient as possible and it's a plug and play kindof thing where our KMs / GMs can focus on training the people and that they are able to run a store without needing to spend too much time on fixed recurring tasks that can be delegated because the system is strong enough to handle it.

**F4. What hurts most about the current version** that a rebuild must fix?
Guess: it's a Google Sheet under the hood, so it's hard to evolve and can't easily tie into cost/POS
data from MarginEdge and Toast. ▶ Yes correct. + limitations to offline capability and limitations to editability / adjusting per concept needs.

---

## Part G: The future (integration / website)

**G1 (Q-FUTURE-1).** End state: is MOG meant to (a) become a module inside one big HEH operations
app, (b) stay a separate tool behind a shared portal login, or (c) not decided yet?
Guess: most likely a module in a centralized HEH operations app, but not firmly decided. ▶ Not firmly decided.

**G2. Shared identity/roster.** If MOG joins the other tools (Order Guides, Visual Schedule, Prep
Schedule), should they share one login + one people/store system, or stay separate?
Guess: shared login and a shared store/people system would be ideal, with per-store/per-concept
configuration on top. ▶ not sure yet.

**G3. Stack preference for a rebuild** — any, or "just capture the logic"?
Guess: capture the logic; stack is open. ▶ Capture the logic.

---

## Part H: Terminology & style

**H1.** Any MOG terms I'm using wrong? I've been using: KM (kitchen manager), par, on-hand,
day multiplier, coverage, primary/backup vendor, pick path, storage area, recap email, reset.
▶ none that i have noticed but I can catch them along the way.

**H2.** Anything currently in MOG that exists for a non-obvious reason a new developer would NOT
guess and might "fix" by mistake? (This is gold for the rebuild — e.g. the shared-par design, the
per-tab on-hand routing, the auto-reset.)
▶

**H3.** Style for the shareable version: HEH-branded like the Store Reports plan, professional tone,
no em-dashes?
Guess: yes — HEH-branded, professional. ▶ Yes.

---

*Send this back with your answers after the ▶ marks. I'll fold them into the blueprint (removing the
ASSUMED flags), then regenerate the presentable HTML.*
