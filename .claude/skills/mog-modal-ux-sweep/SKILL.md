---
name: mog-modal-ux-sweep
user-invocable: false
description: Apply an identical UX micro-change consistently across all MOG Apps Script modals so they don't drift apart. Use whenever Sebastian asks to "do this on all the modals", "make sure every modal has X", "the Saved feedback should be the same everywhere", "add a Close button to the ones missing it", or any change phrased as a sweep across the modal set. ALSO trigger when fixing a UX inconsistency Sebastian flagged (e.g. one modal has ✓ + green flash, the others don't — that's a sweep waiting to happen). Skip for changes scoped to a single modal's unique workflow (e.g. ManageVendors edit-form redesign, StorageAreas draft-mode rework) — those aren't sweeps, they're per-modal redesigns.
---

# mog-modal-ux-sweep

The MOG modals weren't built in lockstep — they drift apart between sessions. The 2026-05-27 session shipped the strongest cross-modal sweep yet (✓ + green flash, Close buttons, etc.). Treat sweeps as their own discipline: inventory first, apply identically, gotchas captured.

**This is the MOG specialization of the global `modal-ux-sweep` skill.** The global skill owns the generic discipline (detector → inventory → apply identically → ES5 → deploy → smoke-test) and the generic anti-patterns; read it for the *why*. This file pins the MOG specifics: the concrete modal inventory, the canonical Saved-beat block, the StorageAreas flex gotcha, the `audit_modals.py` detector, and MOG deploy routing.

## Modal inventory (carry forward — used by every sweep)

**Save-capable modals (5)** — have a save flow with `.status.ok` feedback, need Saved-beat consistency:
- `apps-script/AdminReset.html`
- `apps-script/ManageItems.html`
- `apps-script/ManageVendors.html`
- `apps-script/ReorderPickPath.html`
- `apps-script/StorageAreas.html`

**Read-only / non-save modals (2)** — show data, no save flow:
- `apps-script/OrderHistory.html`
- `apps-script/HowToUse.html`

When a sweep is about save feedback, apply to the 5. When it's about a Close button or layout chrome, apply to all 7. State which set you're sweeping before editing.

## The RPC shim is now centralized — do NOT re-fork it per modal (2026-07-14, #19)

The web-editor RPC plumbing (`MIRPC()` / web-fail handling / editor-close) used to be **copy-pasted into every dual-host modal**, each with its own hand-maintained function allowlist — and those lists drifted (it once broke `getVendorTableData`). The #19 refactor moved it into **`EditorShell.html`** as shared helpers `mgeRpc_` / `mgeWebFail_` / `mgeEditorClose_`, where **`mgeRpc_` is a generic `Proxy`** so the server's `webeditDispatch_` switch is the *only* allowlist. Each modal keeps just a one-line `MIRPC` delegate to the shared helper (ManageItems wraps `mgeEditorClose_` for its Assign-tab close guard).

**Sweep implication:** if a sweep touches RPC calls, close behavior, or web-fail UX, change it **once in `EditorShell`**, not per modal — and never re-introduce a per-modal function allowlist. A sweep that copies a shim body back into individual modals is re-creating exactly the drift #19 removed.

## The "Saved" feedback block (canonical, copy verbatim)

This CSS block is shared across all 5 save-capable modals as of 2026-05-27. If a sweep adjusts it, change all five identically:

```css
.status.ok   { color: #1f6d2a; font-weight: bold; animation: saveFlash 0.9s ease-out; padding: 3px 8px; border-radius: 4px; }
.status.ok::before { content: '✓ '; }
.status.warn { color: #9a2c2c; font-weight: bold; }
.status.info { color: #555; }
@keyframes saveFlash {
  0%   { background: rgba(31,109,42,0.20); }
  100% { background: transparent; }
}
```

If any of the 5 doesn't have it, that's a sweep gap — the modal is drifting.

## The Close-button pattern

Sticky-footer Close button in the modal-footer div, outside the scrolling body. Pattern matches AdminReset, ReorderPickPath. The 5/27 sweep added it to StorageAreas and ManageVendors which were previously missing both a top X and a footer Close. If you find a modal without one, add it during the sweep.

## The StorageAreas flex-column gotcha (caught the hard way, 2026-05-27)

`StorageAreas.html` body uses `display: flex; flex-direction: column; height: 100vh; overflow: hidden;` with `.body` as the scrolling middle child and `.modal-footer` as a sticky bottom child. Flex children default to `flex-shrink: 1`, so children of `.body` with `overflow: hidden` (like `.list-card`) get *clipped* instead of triggering `.body`'s scroll. The fix:

```css
.body > * { flex-shrink: 0; }
```

If any future sweep adds a new top-level card or section inside `.body` in StorageAreas, it must remain a flex child with `flex-shrink: 0` or the scroll silently breaks. This bit twice during the 5/27 session — two failed push iterations before nailed.

## The discipline (MOG specifics — generic step order lives in global `modal-ux-sweep`)

Two steps have MOG-specific mechanics:

- **Step 0 — run the MOG drift detector** over the 5 save-capable modals before deciding what to sweep:

  ```
  python .claude/skills/mog-modal-ux-sweep/scripts/audit_modals.py
  ```

  Per-modal grid, exits non-zero on drift. Add a new signature to track to the `SIGNATURES` list. The detector finds presence/absence only — *where* a missing block goes stays your judgment.

- **Step 5 — deploy.** Modal HTML changes are bound-sidebar only — no `--redeploy` (sidebars read HEAD). Route via `mog-deploy-workflow`: `python .claude/skills/mog-deploy-workflow/scripts/route.py apps-script/StorageAreas.html`. Then smoke-test 2-3 of the swept modals in the canary Sheet (rprfo) before fanning out.

The other steps (inventory the right set, read-before-edit, apply identically, ES5 on JS edits) are generic — see global `modal-ux-sweep`.

## Anti-patterns

The generic sweep anti-patterns (fixing one modal and stopping, re-deriving the CSS block per modal, ES6 in modal JS, bundling a sweep with a per-modal redesign) live in global `modal-ux-sweep`. The MOG-specific one worth repeating: **skipping `flex-shrink: 0` when adding a new card inside StorageAreas' `.body`** silently breaks the scroll (see the gotcha above) — it bit twice in one session.

## Composition with other skills

- [[architectural-walkthrough]] runs first if the sweep introduces a *new* pattern (not just propagating an existing one).
- [[rhino-safe-html]] auto-triggers on any JS edits inside modal HTML.
- [[mog-deploy-workflow]] confirms no `--redeploy` is needed for modal HTML changes.
- [[mog-cheatsheet]] has the deploy commands.
