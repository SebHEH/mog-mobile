---
name: mog-modal-ux-sweep
user-invocable: false
description: Apply an identical UX micro-change consistently across all MOG Apps Script modals so they don't drift apart. Use whenever Sebastian asks to "do this on all the modals", "make sure every modal has X", "the Saved feedback should be the same everywhere", "add a Close button to the ones missing it", or any change phrased as a sweep across the modal set. ALSO trigger when fixing a UX inconsistency Sebastian flagged (e.g. one modal has ✓ + green flash, the others don't — that's a sweep waiting to happen). Skip for changes scoped to a single modal's unique workflow (e.g. ManageVendors edit-form redesign, StorageAreas draft-mode rework) — those aren't sweeps, they're per-modal redesigns.
---

# mog-modal-ux-sweep

The MOG modals weren't built in lockstep — they drift apart between sessions. The 2026-05-27 session shipped the strongest cross-modal sweep yet (✓ + green flash, Close buttons, etc.). Treat sweeps as their own discipline: inventory first, apply identically, gotchas captured.

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

## The discipline

0. **Run the drift detector first.** Before deciding what to sweep, see which of the 5 save-capable modals already have the canonical signatures (`saveFlash`, `.status.ok::before`, a `google.script.host.close()` affordance):

   ```
   python .claude/skills/mog-modal-ux-sweep/scripts/audit_modals.py
   ```

   It prints a per-modal grid and exits non-zero on any drift. This replaces a manual eyeball pass across 5 files and tells you exactly which modals need the change. Adding a new signature to track? Add it to the `SIGNATURES` list in the script. The detector only finds presence/absence — *where* to place a missing block stays your judgment.

1. **Inventory the modals first.** Save-capable (5) vs all-modals (7) — pick the set based on what's being swept. Don't fix one and forget the rest.
2. **Read each target file before editing** — modals drift; assume the starting state differs slightly. The change may already be present in 2 of 5 and missing in 3.
3. **Apply the change identically** — copy-paste the canonical block, don't re-derive it per modal. Re-derivation is how the drift happens in the first place.
4. **Rhino ES5 on any JS edits.** All seven modal HTML files run in Rhino. No arrow fns / `let` / `const` / template literals in `<script>` blocks. `rhino-safe-html` auto-triggers.
5. **Deploy.** Skill-specific routing fact: modal HTML changes are bound-sidebar only — no `--redeploy` (sidebars read HEAD). For the exact command + canary discipline, defer to `mog-deploy-workflow` — run its router: `python .claude/skills/mog-deploy-workflow/scripts/route.py apps-script/StorageAreas.html`.
6. **Smoke-test more than one modal in the canary Sheet** — the whole point of a sweep is consistency; verify it in 2-3 of the swept modals before fanning out.

## Anti-patterns (caught in past sessions)

- **Fixing one modal and stopping.** That's how the drift started. If the change is justified for one save-capable modal, it's justified for all 5.
- **Re-deriving the CSS block per modal.** Diffs that look "the same-ish" but have one different color or one missing rule. Copy-paste the canonical block.
- **ES6 syntax in the JS rewrite.** The `.gs` side is V8; the HTML side is Rhino. Sweep edits live in HTML. ES5 only.
- **Skipping `flex-shrink: 0` when adding a new card inside StorageAreas' `.body`.** Silently breaks the scroll. The gotcha is real.
- **Bundling a sweep with a per-modal redesign.** Mixed scopes, hard to review, hard to verify. Sweep is its own session (or its own commit at minimum).

## Composition with other skills

- [[architectural-walkthrough]] runs first if the sweep introduces a *new* pattern (not just propagating an existing one).
- [[rhino-safe-html]] auto-triggers on any JS edits inside modal HTML.
- [[mog-deploy-workflow]] confirms no `--redeploy` is needed for modal HTML changes.
- [[mog-cheatsheet]] has the deploy commands.
