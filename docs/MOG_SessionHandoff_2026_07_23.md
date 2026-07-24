# Session Handoff — Codebase audit re-sweep + first web-first visual audit (#17–#18, A1–A10)

**Session date:** 2026-07-23 (work spanned 2026-07-22 → 2026-07-23)
**Session focus:** Re-run the codebase audit (resuming the audit map) and a visual-consistency audit, then fix what surfaced.
**Outcome:** Code audit found the codebase clean vs the 07-16 stamps → 2 new LOW items (#17 TZ, #18 dead keys), both shipped. First dedicated visual-consistency audit produced A1–A10; A1/A2/A4 dropped under the modal phase-out, A3/A5/A6/A7/A8/A9/A10 all fixed + shipped. 5 commits (`c26ca15`→`2874ff6`), all on all 9 + master + GitHub Pages + pushed. PWA CACHE v38→v40, hub sw v7→v8.
**Next session focus:** The standing pre-existing backlog — run the Health Check "Vendor tab headers" fix per store, the backup-vendor backfill, and #24 (MOGApi.gs split). Or continue Tier-3 remainder. Next code audit resumes at **#19**, next visual audit at **A11**.

---

## Key framing this session — the modal phase-out (drives everything below)

Sebastian confirmed the **Sheet-dialog modal layer is being phased out** — the `/exec` **web editor is the surviving management surface**. Consequences, now recorded in `docs/MOG_AuditMap.md` and the `project_architecture_direction` memory:

- **Do not invest in Sheet-modal visual polish** (Styles.html tokenization, modal chrome). The visual audit therefore **dropped A1/A2/A4** (all Sheet-modal-cosmetic) with their evidence preserved so no future sweep re-derives them.
- **Behavioral/correctness fixes in the dual-host `*.html` files still matter** — those files live on as the web pages; only the Sheet-dialog *hosting* retires.
- Future visual audits scope to **web editor + PWA + hub only**.

---

## What shipped

### Code audit (#17–#18) — `c26ca15`, all 9 + master via `deploy.py --redeploy`

- **#17 — override-date TZ aligned.** `api_commitReset_` (`MOGApi.gs`) stamped `EMERGENCY_OVERRIDE_LASTDATE_PROP` with `Session.getScriptTimeZone()` while its reader `resetEmergencyOverrideOnOpen_` (Core.gs) and every other writer use `getSpreadsheetTimeZone()`. Same latent day-boundary class as the closed #5; the A1 batch fixed one sibling and missed this one. No behavior change today (all stores US/Eastern).
- **#18 — dead glossary keys.** Removed the 3 `unsaved*` keys (both languages) in `ReorderPickPath.html`, orphaned when the 07-14 `rpp-guard` dialog replaced `window.confirm`. (Note: this file also carried A3 changes, so #18 rode the A3 commit at file granularity.)

### A3 — shared guard/confirm dialog + breadcrumb leave-guard — `a228054`, all 9 + master

The biggest UX item. Centralized **one** confirm/guard dialog in `EditorShell.html` (`mgeGuard3_` / `mgeConfirm_` / `mgeDialogEnsure_` + `.mge-dlg-*` CSS), replacing the per-tool copies (`ManageItems .ig-*`, `ReorderPickPath .rpp-guard-*`) and **every `window.confirm`** (`StorageAreas`, `HealthCheck`) — the sandbox-flaky call is now gone from the whole editor set.

Then a **leave-guard mechanism**: `mgeSetLeaveGuard_(fn)` + a one-time delegated click interceptor on the breadcrumb (`mgeWireCrumbGuard_`, wired from `setBreadcrumb_`) so **breadcrumb navigation honors unsaved edits**, not just the footer Close — a pre-existing hole (breadcrumb is EditorShell chrome that navigates via a raw `<a>`). Each editable tool registers a `guardLeave_(proceed)`; footer close delegates to it too (one code path).

**Coverage swept across ALL web tools** (Sebastian asked to be sure it's caught everywhere):
- **StorageAreas** — draft (`isDirty`) + the two-step **rename / Add field** (typed-but-unconfirmed text lived only in the input, not the draft, so it slipped past `isDirty`); `hasPendingInput_` catches it, and Save folds it into the draft via `commitPendingInput_` (Cancel leaves the open input untouched). 3-button (real unified Save).
- **ManageItems** — Assign tab keeps its 3-button (real save-all); the **Add/Edit item form** (own Add/Save buttons, no unified save) → **2-button warn** (Add dirty = any text typed; Edit dirty = live form ≠ `editFormBaseline_` snapshot captured in `setEditFormState_('loaded')`).
- **ManageVendors** (had **no** guard/dirty model at all) — added `guardLeave_` + `vendorFormPending_` (Add name / Import name / chosen file / open inline-mult edit) → 2-button warn.
- **ReorderPickPath** — every edit flips `isDirty` immediately; no free-text; covered.
- Read-only tools (OrderHistory / VendorCadenceAudit / HealthCheck) register nothing → breadcrumb navigates freely.

**Guard-style decision (Sebastian):** 2-button "Leave without saving?" for the per-form tools (they have their own Save buttons; no ambiguous dialog-Save), 3-button *Save / Don't save / Cancel* only where a unified draft-Save exists (StorageAreas, MI Assign).

### A5 — unified web-editor radius tokens — `a228054`

Cascade traced: EditorShell is `include()`d into `<body>` **after** each page's `<head>`, so **Setup's `--r:12px` was silently clobbered by EditorShell's `--r:10px`** (Setup rendered 10px — its declaration was inert), and **EditorHome used the distinct `--radius` name precisely to dodge that clobber** (genuinely 12px). Fix (zero pixels): added a shared large scale `--r-lg:12px/--r-lg-sm:9px` to EditorShell; pointed EditorHome at it (dropped the orphan `--radius`); deleted Setup's dead `--r/--r-sm`. One naming system.

### A6 — PWA badge green tokenized — `4461239`, CACHE v38→v39

`.vb-primary` hard-coded `#1a7a55`/`#e2f6ee` while `.vb-secondary` used `var(--amber-*)`. Minted fixed `--green-light/--green-dark` beside the amber pair (NOT concept-themed — `--teal` re-themes). Same hex → zero visual change.

### A7 — one web-editor danger token — `3061576`, all 9 + master

The web token set had no danger token; `.mge-err` hard-coded `#b3261e` while the A3 dialog + tool pages used `#c0392b`. Added `--danger:#c0392b` to EditorShell's `:root` (= Styles.html, so tool pages unchanged); `.mge-err` uses it; dropped Setup's redundant `--danger:#b3261e`. Net: gate + Setup invalid-field red shift `#b3261e`→`#c0392b` (imperceptible red-to-red — the intended unification).

### A8/A9/A10 — PWA + hub token cleanup — `2874ff6`, CACHE v39→v40, hub sw v7→v8

- **A8** — recap-stale + override banners hand-coded an identical 5-stop gold ramp; minted a shared `--warn-fill/-border/-text/-accent/-accent-active` (warmer than `--amber-*`, not concept-themed), both banners route through it, off-state one-offs folded on.
- **A9** — vendor-card status tints (`#fde4e4/#fbecec/#f5c2c2/#f0d9a8/#ed8936`) → fixed `--status-*`/`--cutoff-orange` tokens (kept fixed, not the themed `--red*`).
- **A10** — hub `body` + three radii referenced the hub's own tokens; added the missing `--r-sm:6px` so the hub token set matches the PWA.
- All exact-hex → zero visual change by construction.

**Blueprint:** NOT bumped this session — nothing changed a business rule / core flow / integration / business constant (all bug-fix / UI / token / deploy-mechanic work). The breadcrumb leave-guard is client UX, not a stated `R#`.

---

## Outstanding (carry forward)

Nothing from this session is unfinished — all audits closed, everything shipped + committed + pushed. The carry-forward is the **pre-existing** backlog (unchanged):

- **Run the Health Check "Vendor tab headers" fix per store** (Sebastian, ~1 min/store, web editor → Maintenance → 🩺 Store Health Check → Fix). Repairs any pre-#16 webapp-added vendor whose B1 header didn't persist.
- **Run the backup-vendor backfill** on the 7 remaining stores (web Health Check → Fix on the *Backup vendor placement* row; only rpr done). Safe in any order.
- **#24 — MOGApi.gs split** → `Recap.gs` (~700 lines) + `Admin.gs` (~500), pure code-motion (`appsscript-decompose-file`).
- **Tier-3 remainder** (optional; see `project_architecture_direction`) — the count/order path is fully formula-free; what's left is syncing the in-Sheet `H2` formula to the next-delivery override behavior (harmless divergence).
- **Web-editor slowness profile** (noted in prior handoffs).

**Deploy discipline reminder for next session:** the web app (`/exec`) is the PRIMARY surface → any backend change is **`deploy.py --redeploy`**, canary **rprfo** (editor canary **rpfrf**), then fan out. PWA changes → `build.py` + CACHE bump + `git push`.

---

## Files touched this chat

**Source (Apps Script):** `MOGApi.gs` (#17), `EditorShell.html` (A3 dialog+leave-guard, A5 `--r-lg`, A7 `--danger`), `ManageItems.html` / `ManageVendors.html` / `StorageAreas.html` / `HealthCheck.html` / `ReorderPickPath.html` (A3 + #18), `EditorHome.html` / `Setup.html` (A5, A7).
**Source (PWA/hub):** `template/index.html` (A6/A8/A9), `template/sw.js` (CACHE v40), `index.html` (A10), `sw.js` (hub v8).
**Generated (build.py):** the 8 `<slug>/` dirs (A6/A8/A9 propagation, CACHE v40).
**Docs:** `docs/MOG_AuditMap.md` (the resumable audit manifest — #17/#18 + A1–A10 recorded, dates corrected to 07-22/07-23, stamps bumped to `2874ff6`), plus this handoff, `CLAUDE.md` @-import, `docs/MOG_CurrentState.md`.

---

## Commits landed this session

```
2874ff6 style(pwa,hub): tokenize warning-banner + status tints and hub radii (A8-A10, CACHE v40/hub v8)
3061576 refactor(editor): unify the web-editor danger red into one token (A7)
4461239 style(pwa): tokenize the fixed primary-vendor badge green + audit doc (A6, CACHE v39)
a228054 refactor(editor): shared guard dialog + breadcrumb leave-guard + radius tokens (#18, A3, A5)
c26ca15 fix(api): align emergency-override date TZ to the spreadsheet TZ (#17)
```

(This handoff is a follow-up `docs:` commit — the session's code shipped mid-way.)

---

## Gotchas surfaced this session (for future-me)

- **Tokenizing gotcha (logged in the audit map):** a bare `replace_all` of a hex ran *after* the `:root` token def was added and rewrote the def into a self-referential `--warn-x: var(--warn-x)` circular token. Caught by a post-edit grep, fixed to literals. **Lesson: add the `:root` literal def LAST, or anchor the usage-replacement with a prefix string so the def line can't match.** The post-edit "confirm the raw hex is gone from usage but the def is intact" grep is the safety net — always run it after a tokenization sweep.
- **The A5 cascade insight is reusable:** EditorShell's `:root` (body-included) overrides any page `<head>` `:root` of the same token name. So a page that needs a *different* token value can't just re-declare the same name — it gets clobbered. Use a distinct token (or the shared scale). This is why EditorHome used `--radius`.

---

## Opening prompt for next session

```
Read docs/MOG_CurrentState.md first. Last session (2026-07-23) re-ran the codebase
audit + the first web-first visual audit and fixed everything that surfaced: #17
(override-date TZ), #18 (dead keys), and A3–A10 (shared guard/confirm dialog +
breadcrumb leave-guard across every editable tool; web-editor radius + danger tokens;
PWA badge/warning-banner/status-tint tokens; hub token cleanup). 5 commits
c26ca15→2874ff6, all on 9 + master + GitHub Pages. PWA CACHE v40, hub sw v8. Both
audits fully closed — next code audit at #19, next visual audit at A11 (web editor +
PWA + hub scope; the Sheet-modal layer is being phased out, so don't audit it).

Likely next directions: (a) the pre-existing backlog — run the Health Check "Vendor
tab headers" fix + the backup-vendor backfill per store, then #24 (MOGApi.gs split
into Recap.gs + Admin.gs, pure code-motion); (b) Tier-3 remainder; (c) web-editor
slowness profile. The web app (/exec) is the PRIMARY surface → backend changes are
deploy.py --redeploy, canary rprfo (editor canary rpfrf), then fan out. PWA → build.py
+ CACHE bump + git push. docs/MOG_AuditMap.md is the resumable audit manifest.
```
