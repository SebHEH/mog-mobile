---
name: mog-sheet-formula-verify
user-invocable: false
description: Prove a MOG data-model or order-math change is safe against the LIVE store spreadsheet before shipping it — confirm which in-sheet formulas depend on a column or value, so you don't repurpose a column some XLOOKUP silently reads. Use BEFORE adding/repurposing/removing a MASTER_ITEMS column, changing how par or order quantities are computed, changing a vendor-tab formula, or anything where "the sheet might already use this." Trigger on "is this safe against the sheet", "does any formula use column X", "can I repurpose the SKU column", "verify the order math", "will switching the active vendor give the right quantity", "check the par setup", or any data-model change to the Apps Script backend. This is the discipline that caught the column-D-vs-O near-miss and surfaced the rpr 1-day-par caveat. Skip for pure UI/CSS/i18n modal changes (no sheet-formula dependency) and for PWA-only changes.
---

# mog-sheet-formula-verify

The MOG `.gs` code writes into a spreadsheet whose tabs are full of live `XLOOKUP`/`ROUNDUP` formulas. A change that looks purely additive in code can break order math if some formula reads the cell you touched. This skill is the "check the actual sheet first" discipline — it's what caught the **column-D near-miss** (the multi-vendor plan was going to repurpose the "dead" SKU column D; reading the real sheet showed every vendor tab's hidden SKU column does `XLOOKUP(id, MASTER_ITEMS!A, MASTER_ITEMS!D)`, so writing vendor lists into D would have surfaced them — the feature went into the genuinely-unused column **O** instead) and surfaced the **rpr 1-day-par caveat**.

## The verified formula map (2026-05-27, from RP_ROSSLYN_FOH.xlsx)

These are the load-bearing in-sheet formulas. Re-confirm against the actual store sheet before relying on them — pars and layouts can differ per store.

- **Order quantity** (vendor tab, col **F**): `ROUNDUP(par × H2 − onHand)`
  - `par = XLOOKUP(id, MASTER_ITEMS!A, MASTER_ITEMS!G)` — **par lives in MASTER_ITEMS column G**, shared per-item.
  - `H2` = the vendor tab's day-of-week **multiplier**.
  - **SKU is NOT in the math.** It only feeds the hidden display columns.
- **Hidden SKU display** (vendor tabs, cols **C** and **S**): `XLOOKUP(id, MASTER_ITEMS!A, MASTER_ITEMS!D)` — these read **MASTER_ITEMS column D**. That's why D could not be repurposed.
- **MASTER_ITEMS columns the code knows about:** A = item id, D = SKU (blank for items, but XLOOKUP'd → leave alone), G = par, **O = Eligible Vendors** (the additive multi-vendor column, referenced by no in-sheet formula → safe to write).

**Implication for the active-vendor switch:** par is shared per-item; switching an item to another vendor's tab just applies that vendor's `H2` multiplier. "1-day par, the multiplier does the rest." This is only correct if the store's pars are true **1-day** pars.

## The two rules this skill enforces

1. **A new MASTER_ITEMS column is safe to write ONLY if no in-sheet formula references it.** Before writing to a column, confirm nothing `XLOOKUP`s / `INDEX`es / ranges over it. Column O passed this test; column D failed it. Don't trust "this column looks empty/dead" — empty ≠ unreferenced (D is blank for items but still read).
2. **Order math assumes 1-day pars.** Any feature that re-applies a vendor multiplier (the active-vendor switch) produces wrong quantities on a store whose pars aren't 1-day. **rpr (Rosslyn BOH) pars may not be true 1-day pars** — flag this before using the switch there; rprfo (canary) is fine. Sebastian recalcs rpr's pars manually before relying on it.

## How to verify (the procedure)

1. **Get the live sheet.** Download the relevant store's spreadsheet as `.xlsx` (Sebastian can export it, or it may already be in the working dir from a prior session). Don't reason from memory of the formula map — re-read it; layouts drift per store.
2. **Read the actual formulas**, not just the values. For an `.xlsx`, the `anthropic-skills:xlsx` skill can extract cell formulas. Look at: the vendor-tab order column (F), the hidden SKU columns (C/S), and the MASTER_ITEMS columns your change touches.
3. **Trace every formula that could read the cell you're about to write.** Grep the formulas for the column letter / `MASTER_ITEMS!<col>`. If anything references it, the column is NOT free.
4. **Confirm par semantics** if the change re-applies a multiplier: are this store's pars 1-day? If you can't confirm, treat it as the rpr caveat — flag it, don't assume.
5. **State the finding explicitly** before writing code: "Column X is referenced by <formulas> / is referenced by nothing → (un)safe." Sebastian decided SKU didn't need scrubbing because it's hidden — surface the finding and let him make that call.

## Anti-patterns (the near-misses this skill exists to prevent)

- **Assuming a blank column is unused.** D was blank for items but XLOOKUP'd by every vendor tab. Blank ≠ free.
- **Reasoning from the code alone.** The code didn't show the dependency — the *sheet's* formulas did. You have to read the spreadsheet.
- **Shipping a multiplier-based feature without checking par semantics.** The active-vendor switch is silently wrong on non-1-day-par stores.
- **Re-litigating the column-O decision.** It's settled: O is additive and safe, D stays as-is (hidden, not scrubbed). Don't reopen it.

## Composition with other skills

- [[architectural-walkthrough]] runs first for any data-model change; this skill is the verification step inside that walkthrough.
- [[anthropic-skills:xlsx]] extracts cell formulas from a downloaded store `.xlsx`.
- [[mog-deploy-workflow]] routes the deploy once the change is verified safe (data-model changes in `.gs` that the PWA reads need `--redeploy`).
- [[mog-session-handoff]] — carry any new par caveat (like rpr's) into the handoff so the next session inherits it.
