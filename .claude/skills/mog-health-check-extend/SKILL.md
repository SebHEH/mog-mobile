---
name: mog-health-check-extend
description: Add a new diagnostic check (and optionally a one-click web fix) to the MOG Store Health Check. Use whenever a session discovers a store-integrity problem the Health Check didn't catch, or Sebastian asks to "add a health check for X", "make the Health Check catch this", "flag any store where …", "give it a one-click fix", or "the Health Check said nothing was wrong but X was broken". This is the recurring pattern behind the H2-sync / template / purge / col-O-migrate / backup-placement / PIN-lockout / vendor-tab-header checks — three sessions in a row extended it. Skip for one-off manual repairs that don't belong in the recurring diagnostic, and for PWA-only or modal-only changes.
---

# mog-health-check-extend

The Store Health Check (`apps-script/Health.gs` + `apps-script/HealthCheck.html`) is MOG's anti-fragility + new-store safety net: one read-only pass that reports config/structure integrity as `pass | warn | fail` and, for the fixable ones, offers a **one-click web repair**. It has grown by one or two checks nearly every session that found a store-data bug the tool missed:

| Session | Added |
|---|---|
| 2026-07-01 | Born: config/PIN, concept, template+H2, per-vendor tabs, col-O schema, pick-DB consistency + 4 fixes (`sync_h2`, `reestablish_template`, `purge_pickpath`, `migrate_vendors`) |
| 2026-07-12 | `place_backups` (backup vendor placement) + `clear_lockout` (PIN lockout) |
| 2026-07-14 | `fix_vendor_headers` (vendor tab B1 ≠ vendor name → shows a count but an empty list) |

When you find a class of store corruption, the durable fix isn't just repairing the one store — it's **teaching the Health Check to detect it** so the other 8 (and every future store) get flagged. This skill is that recipe.

## Two moving parts

- **The check** — a read-only probe inside `getStoreHealthReport()` (`Health.gs`). Reports status + a human sentence, and *names* a repair.
- **The fix (optional)** — a headless, UI-free repair invoked from the web editor via `runHealthFix(fixId)` (`Health.gs`), delegating to a `_core_` function in the owning domain file.

A check with no fix is fine (it just tells the operator what to run in the Sheet). A fix without a check is not — every `fixId` must be produced by a check.

## Adding the check (always)

In `getStoreHealthReport()`, add to the numbered sections. Use the local `add()` helper — its signature is the contract:

```js
add(id, label, status, detail, fix, fixId, destructive)
```

- `id` — stable slug for the check row (e.g. `'vendor_headers'`).
- `label` — short human title (e.g. `'Vendor tab headers'`).
- `status` — `'pass' | 'warn' | 'fail'`. **fail** = broken now; **warn** = degraded / self-heals / not-yet-placed; **pass** = healthy.
- `detail` — one sentence, English only, that a KM/admin can act on. Name counts and the offending vendors/items.
- `fix` — a human sentence describing the repair (shown even when there's no web button — e.g. "Run 📱 Mobile API → Setup").
- `fixId` — omit for a check-only probe; set it to wire a **one-click web Fix button** (see below). Must match a `case` in `runHealthFix`.
- `destructive` — `true` makes the web client **confirm before running** (used by `purge_pickpath`).

**Hard rules:**
1. **Read-only. Never write** to the sheet or properties inside `getStoreHealthReport()` — not even a self-healing delete of an expired key (the PIN-lockout check reads the raw property precisely to avoid this). The report must be safe to run anytime.
2. **Wrap each check in its own `try/catch`** that degrades to `warn`/`fail` with `'Check errored: ' + e.message`. One broken probe must not sink the whole report.
3. **A `pass` branch too** — every check emits a row in all states, so the report reads as a complete checklist.

## Adding the fix (when the check is web-actionable)

1. **Write a UI-free `_core_` function** in the domain file that owns the data (`Vendors.gs`, `PickPath.gs`, `Items.gs`, …), e.g. `fixVendorHeaders_core_()`. It does the repair and returns a plain result object (`{ fixed, names }`, `{ removed }`, `{ added, itemsAffected }`, …). **No `SpreadsheetApp.getUi()`** anywhere in the path — `getUi()` throws in a web-app context, which is exactly how the web Fix button runs. If a Sheet-menu version already exists and calls `getUi()`, extract the logic into `<name>_core_` and have the menu wrapper call the core (this is how `purge`/`migrate` were unified — one source of truth, `f51869e`).
2. **Bump the server mutation ts** if the repair changes data the PWA reads, so KM caches invalidate (the shared cores generally already do; confirm).
3. **Add a `case` to `runHealthFix(fixId)`** in `Health.gs` that calls the core and returns `{ ok, message }`. `ok:false` only when the core reports errors (see `sync_h2`, which surfaces `r.errors`). The `message` is shown verbatim in the web UI — make it say what happened, including the "nothing to do" branch.

**Dispatch is already wired — a new `fixId` needs NO dispatch change.** Both `getStoreHealthReport` and `runHealthFix` are registered in `webeditDispatch_()` (`Editor.gs`), and `runHealthFix` routes internally by `fixId`. You only touch `webeditDispatch_` if you add a *brand-new client-callable function* (rare — prefer riding `runHealthFix`).

## HealthCheck.html usually needs no change

The modal is **data-driven** — it renders whatever `getStoreHealthReport()` returns and shows a Fix button whenever a check has a `fixId` (confirming first when `destructive`). A new check/fix appears automatically. Only touch `HealthCheck.html` for a genuinely new rendering need (and then `rhino-safe-html` applies to its script block, though modals are browser-side ES6-safe — see invariant #4).

## Conventions

- **English only.** The Health Check is an admin tool — no EN/ES parity, no `mog-i18n-parity` pass needed.
- **`.gs`/`.html` basename collision:** the server file is **`Health.gs`, not `HealthCheck.gs`** — clasp errors if a `.gs` and `.html` share a basename. Keep it.
- **Deploy = `--redeploy`.** `Health.gs` is reached by the web editor (`webedit_call` at `/exec`, the primary surface) and the Sheet dialog. Route via `mog-deploy-workflow`; the web editor's `/exec` is a versioned snapshot, so **always `python deploy.py --redeploy`**. Editor canary is **`rpfrf`** (or `rpr`); iterate by redeploying the canary and opening its bare `/exec` home → Maintenance → 🩺 Store Health Check.
- **Verify by running it**, not by clean tooling output: open the canary's Health Check, confirm the new row reports correctly, click Fix, confirm the check flips to `pass`.

## After shipping: carry it forward

A new check often surfaces latent corruption on *other* stores (the B1 bug could exist on any webapp-added vendor). Put a **"run the new Fix per store"** line in the session handoff (`mog-session-handoff`) so the fleet gets repaired, not just the one store that triggered the work.

## Composition with other skills

- [[architectural-walkthrough]] first if the *repair* is a new operation (not just a new probe over existing data).
- [[mog-sheet-formula-verify]] if the check or fix depends on / writes a sheet column or formula — prove it against the live sheet.
- [[mog-deploy-workflow]] routes the deploy (`--redeploy`, canary rpfrf).
- [[mog-session-handoff]] carries the "run the fix fleet-wide" follow-up.
- [[rhino-safe-html]] only if you edit `HealthCheck.html`'s script block.
