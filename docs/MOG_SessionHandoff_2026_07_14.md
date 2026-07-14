# Session Handoff — Multi-vendor QOL, Tier-3 finish, par-review overhaul, audit integration, RPC-shim centralization, new-vendor B1 bug

**Session date:** 2026-07-14
**Session focus:** Close the multi-vendor follow-ups, then work down the backlog — finish Tier-3, tune par-review, integrate the 2026-07-12 audit that landed on GitHub from another machine, do the #19 RPC-shim refactor + cosmetics, and chase a live "vendor shows a count but empty list" bug.
**Outcome:** 8 commits, all on all 9 + master + pushed; the 2026-07-12 audit (11 commits) integrated cleanly via rebase. Biggest wins: the backend order path is now **fully formula-free** (Tier-3 done), par-review detection is much sharper (28-day window, severity %, actionability floors), the copy-pasted web-editor RPC shim is centralized into EditorShell, and a real data-integrity bug — **new vendors added via the webapp got a tab with the wrong B1 header, rendering the tab empty** — was root-caused, fixed, hardened, and given a Health Check.
**Next session focus:** Sebastian runs the new Health Check "Vendor tab headers" fix across stores (repairs any other webapp-added vendors with bad B1); optionally profile the web-editor slowness; then the remaining audit carry-forwards (#24 MOGApi split) or the backup backfill.

---

## Section A — Multi-vendor QOL + PWA badges (`6fc98ff`, `eea4664`, CACHE v30)

- **Assign-to-Vendor close guard** (`ManageItems.html`): closing the modal with unsaved Assign-tab checkbox edits now routes through the existing Save / Don't save / Cancel popup (previously only tab- and vendor-switch were guarded; Close silently dropped staged edits). `editorClose()` checks `assignHasPendingChanges_` before handing off to the shared base close.
- **PWA count badges** (`template/index.html`): Primary/Secondary vendor badges are now **fixed semantic colors** — green for primary, amber/yellow for secondary (not concept-themed, so the traffic-light reading is consistent on every store). The **secondary badge again names the item's primary vendor** (`Secondary · <vendor>`) so a KM ordering next-day knows the fallback source. `it.primaryVendor` was already on the API item; pure client render change.

## Section B — Tier-3: backend order path fully formula-free (`3cf1dcf`)

`snapshotVendorOrders_` (order log) and `vendorOnHandSnapshot_` (dashboard "to order" counts) no longer read the vendor tab's col-A (name) or col-F (suggested) formulas. Both now use the **shared `computeSuggestedQty_` helper** — the single source of the count/order math already driving `api_getVendorItems_`, the PWA count screen, and the recap — with names from `MASTER_ITEMS`. Vendor tabs are now read for **On Hand (E) + Item ID (M) only**. The dashboard builds a shared `masterMeta`/`vendorMults` read context once (not per vendor). Normal-ops behavior is byte-identical; under Emergency Override the log/dashboard now follow the in-code next-delivery multiplier (matching the PWA/recap) — the intended, more-correct behavior. **This was the last Tier-3 remainder** — the audit's carry-forward list showed it as open, but it's done and survived the audit merge (verified in the merged code).

## Section C — Par-review overhaul (`f17704e`, `0c745c5`, `38cdb91`)

- **Detection widened** (`History.gs`): rolling window **14 → 28 days**, `MIN_ORDERS` **2 → 3**, and the client display threshold **5 → 3** (shared `MIN_FLAG_ORDERS_` constant in `ManageItems.html`). Fixes "a ton of items show No data yet" — slower-moving items now get a verdict.
- **Severity %** on the flag (`ManageItems.html`): `parPct_` shows avg On Hand ÷ par next to the verdict in both the pill and the detail (`⚠ Over · 86%`). High = over, low = running empty; makes the thresholds transparent and the list sortable worst-first.
- **Sort order** (`ManageItems.html` `sortValue_`): clicking Par Review now sorts over-ordering → under → no-review, inactive last.
- **Column-header sort row** (`ManageItems.html`, web only): the 8 sort headers scroll horizontally in lockstep with the body and center the clicked header; **the Item column is frozen** (sticky-left) so it stays readable while scrolling right to Par Review.
- **Over-flag actionability floors** (`History.gs`) — three cumulative reasons to *skip* the over flag, so it only fires when there's genuinely something to trim: base par < 1 (`OVER_MIN_BASE_PAR`); avg multiplied order (`qty + onHand`) < 2 units (`OVER_MIN_EFF_PAR`); and **avg On Hand < 1 whole unit** (`OVER_MIN_AVG_ONHAND`). The last one caught the Pellegrino case — a small-base-par / high-multiplier case-pack item was tripping "over" on a fraction of a unit because detection compares On Hand to the BASE par.
- **75% post-lunch cutoff** (`History.gs`): `OVER_ONHAND_PCT` **0.50 → 0.75**. On Hand is counted post-lunch, so ~half a daily par is legitimately reserved for dinner + PM prep; only 75%+ still on the shelf (on ≥50% of orders) is a genuinely high par. Sebastian's call; biased conservative.

## Section D — Integrated the 2026-07-12 audit (git rebase, clean)

Sebastian pulled the last local commit onto his computer, ran the `codebase-audit-method` audit (11 commits, `2db6a5b`→`682a4b9`, CACHE v30→v35 — data-loss fixes, `withPickDbLock_` locking, perf, one-RPC Manage Items, Health Check maintenance fixes), and pushed. This laptop was behind 11 with one uncommitted file (the over-flag `History.gs` tuning). Because the audit was built on top of all our committed work and our only loose change sat in a region the audit didn't touch (comment-only edits at 295/356 vs our PAR_FLAG constants/agg/decision), integration was a clean **commit-then-rebase** — no conflicts. Verified History.gs carried both sides + parsed; pushed. Confirmed the Tier-3 snapshot/dashboard work survived the audit's MOGApi.gs refactor.

## Section E — #19 RPC-shim centralization + 4 cosmetics (`74ffb31`)

- **#19**: the per-modal `MIRPC()`/`webHandleFail`/`editorClose` shim (copy-pasted across 6 modals, with hand-maintained function allowlists that had drifted — the class that once broke `getVendorTableData`) is replaced by shared `mgeRpc_`/`mgeWebFail_`/`mgeEditorClose_` in `EditorShell`. **`mgeRpc_` is a generic ES6 `Proxy`** — the server's `webeditDispatch_` switch is the single allowlist, so there's no client-side list left to maintain or drift. Each modal keeps a one-line `MIRPC` delegate; ManageItems keeps its close-guard wrapping the shared base. ~94 net lines removed. rpr-canaried across all 6 web tools.
- **Cosmetics**: (1) OrderHistory EN/ES toggle preserves an open Recent detail instead of collapsing to the list (`recentDetailOpen_`); (2) ReorderPickPath's close + vendor-switch use a real **Save / Don't save / Cancel** dialog instead of the sandbox-unreliable `window.confirm`; (3) the token-"checking" gate shows a card instead of a blank overlay; (4) `api_getVendorItems_` narrows its vendor-tab read A:M → E:M.

## Section F — New-vendor B1 bug: root cause, fix, Health Check gap closed (`59001e9`)

**Symptom:** tnytf's "Sysco" vendor card showed 14 items but the PWA list was empty and wouldn't refresh. **Root cause (diagnosed with a temp read-only diagnostic, since removed):** the card count comes from MASTER (`countActiveItemsByVendor_`), the list from the vendor TAB's col-M spill. The 14 items had pick rows (K=Sysco), but the tab's **B1 header still read "VENDOR TEMPLATE"** instead of "Sysco" — and B1 drives both the H2 multiplier match and the M-spine `FILTER(SETUP!K = TRIM(B1))`, so the tab filtered by the wrong value and spilled 0. `commitAddVendor`'s plain `setValue("B1", name)` on the merged header cell didn't persist on the clone.

- **`setVendorHeaderB1_`** (`Vendors.gs`): shared robust writer — break-merge → write → re-merge → flush → read-back-retry. `commitAddVendor` now uses it so a new vendor can't be born with a stale header.
- **Health Check** (`Health.gs`): new **"Vendor tab headers"** check flags any tab whose B1 ≠ its vendor name, with a one-click **Fix** (`fix_vendor_headers` → `fixVendorHeaders_core_`) that repairs them all and bumps the mutation ts. This closes the gap that let the Health Check report "nothing wrong" — its consistency check only looked for orphan/inactive rows and col-O eligible placement, never a mismatched B1.

## Outstanding (carry forward)

- **Run the new "Vendor tab headers" Health Check fix per store** (Sebastian): any vendor added via the webapp before today could have the same wrong B1 (shows a count, empty list). tnytf/Sysco specifically — confirm it's repaired (either the manual B1 edit or the new fix). ~10s/store.
- **Web-editor slowness** (parked): the editor felt slower after the audit + #19. Reasoned most likely cold-start from repeated redeploys (transient) or the audit's `withPickDbLock_` on writes; #19 adds no round-trips. Profile the read path / dashboard recompute if it persists after warm-up.
- **Backup-vendor backfill** per store (audit carry-forward): web Health Check → "Place Backup Vendors on Tabs" fix; only rpr done. Safe in any order.
- **Audit carry-forwards not yet done**: #24 MOGApi.gs split → `Recap.gs` + `Admin.gs` (pure code-motion); the remaining audit cosmetics list (in the 2026-07-12 handoff) minus the ones done this session (#19 and all 4 cosmetics are now shipped).
- **Pre-existing**: Claude-SKills mirror commit; ManageVendors "Advanced" disclosure; hub brand SVGs; Batch D; sync the in-Sheet H2 formula to next-delivery override (accepted divergence).

## Files touched this chat

- **Backend (.gs, all 9 + master):** `MOGApi.gs` (Tier-3 snapshot/dashboard, `computeSuggestedQty_`, A:M→E:M read narrowing), `ResetLog.gs` (Tier-3 `snapshotVendorOrders_`), `History.gs` (par-review window/min-orders/severity/floors/75% cutoff), `Vendors.gs` (`setVendorHeaderB1_`, `fixVendorHeaders_core_`, `commitAddVendor` B1), `Health.gs` (vendor_headers check + fix), `Core.gs` (temp diagnostic menu item added then removed — net no change).
- **Modals (.html):** `EditorShell.html` (shared RPC shim + checking card), `ManageItems.html` (close guard, par-review sort/scroll/severity/frozen-Item, delegate), `ManageVendors.html` / `StorageAreas.html` / `HealthCheck.html` (RPC delegate), `OrderHistory.html` (delegate + lang-detail preserve), `ReorderPickPath.html` (delegate + unsaved-changes dialog).
- **PWA:** `template/index.html` + `sw.js` (CACHE v29→v30 for badges; the audit later carried it to v35) + generated store dirs via `build.py`.
- **Docs:** this handoff, `CLAUDE.md` @-import, `docs/MOG_CurrentState.md`.

## Commits landed this session

```
59001e9 fix(api): new vendor's B1 header not persisting → empty tab; harden + detect
74ffb31 refactor(editor): centralize RPC shim into EditorShell + audit cosmetics
38cdb91 fix(editor): par-review — skip over-flag when avg On Hand is below one unit
0c745c5 feat(editor): par-review over-flag — low-volume floors + 75% post-lunch cutoff
f17704e feat(editor): widen par-review detection + severity % + Manage Items sort/scroll QOL
3cf1dcf feat(api): compute order-log + dashboard counts in code, not vendor-tab formulas
eea4664 feat(pwa): color-code Primary/Secondary count badges + name the primary vendor (CACHE v30)
6fc98ff fix(editor): guard the Assign-to-Vendor tab against losing edits on modal close
```
(Plus the 2026-07-12 audit's 11 commits, integrated via rebase — authored on another machine.)

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session (2026-07-14) shipped 8 commits
(all on all 9 + master), integrated the 2026-07-12 audit cleanly, finished Tier-3
(backend order path is now fully formula-free), overhauled par-review (28-day
window, severity %, over-flag actionability floors + 75% post-lunch cutoff),
centralized the web-editor RPC shim into EditorShell (#19), shipped 4 cosmetics,
and root-caused + fixed a data bug: new vendors added via the webapp got a tab
with B1 stuck on "VENDOR TEMPLATE" instead of the vendor name → empty tab despite
items existing. commitAddVendor now writes B1 robustly, and a new Health Check
"Vendor tab headers" check flags + one-click-fixes any drifted tab.

FIRST: run the Health Check "Vendor tab headers" fix on each store (any vendor
added via the webapp before today could have the same bad B1 — shows a count,
empty list). Also worth: the backup-vendor backfill per store (Place Backup
Vendors on Tabs).

Candidate directions: #24 MOGApi.gs split (Recap.gs + Admin.gs, pure code-motion);
profile the web-editor slowness if it persists after warm-up; or the remaining
audit cosmetics. Canary rpr (or rpfrf); the web app (/exec) is the PRIMARY surface
→ ALWAYS deploy.py --redeploy.
```
