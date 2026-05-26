---
name: mog-rpc-consolidation
description: Pattern for collapsing multiple `google.script.run` calls or duplicate sheet reads in MOG Apps Script modals into a single server-side bootstrap or commit function. Use whenever a modal's load or save fires more than one RPC, a `.gs` function does redundant `getRange` / `getDataRange` reads, Sebastian mentions "modal feels slow", "consolidate the RPCs", "merge these calls", "bootstrap function", or the work is the next item on the modal performance audit punch-list. ALSO trigger when reviewing a modal's `window.onload` or save handler and you can count >1 `google.script.run` calls fired in succession or in parallel — that's exactly the smell this skill addresses. Skip for changes that aren't about call-count reduction (pure UX polish, schema migrations, new features that don't have an existing N-call equivalent).
---

# mog-rpc-consolidation

The Apps Script modal performance audit pattern. Three sessions in a row (2026-05-25, -26, -27) shipped variants of this — bootstrap on Order History, save consolidation on ManageVendors, dashboard cache + currentArea inline + getVendorTableData merge. Same recipe every time.

## The recipe

1. **Count the actual RPCs in the file before proposing the consolidation.** The 5/25 audit overstated OrderHistory as "4 sequential RPCs" — it was actually 2 concurrent. The 5/27 audit overstated dashboard impact too. Read the modal's `window.onload`, save handler, or wherever the calls fire and count them in the real source. If the count is wrong, the impact estimate is wrong.

2. **Pick the naming convention based on direction:**
   - **Read consolidation** → `get<Thing>Bootstrap(...)` returns one object with all the fields the client needs. Canonical examples: `getManageItemsBootstrap`, `getOrderHistoryBootstrap`.
   - **Write consolidation** → `commit<Thing>(...)` accepts all payloads and does the row lookup + writes once. Canonical example: `commitUpdateVendorMultsAndCutoff` (replaces a chained `commitUpdateVendorMults` → `commitUpdateVendorCutoff`).
   - **Reorder / list-mutation helper** → `commit<Thing>Mutation_(mutate)` is a server-side higher-order helper that wraps the bump → read → mutate → write → sync skeleton. Canonical example: `commitAreaListMutation_` in `OrderGuideScript.gs`.

3. **Additive only — don't prune the old fns.** Add the new server function, rewire the client to call it, leave the old functions in `.gs` untouched even if they have no remaining callers. Sebastian's pattern across all three sessions: pruning is its own session, not bundled with the consolidation. The diff stays minimal and reviewable.

4. **Validate inputs upfront before any write.** `commitUpdateVendorMultsAndCutoff` validates both `mults` and `cutoffTime` *before* it does the row lookup or any write. No partial-success state is reachable. Apply the same discipline to any new commit fn.

5. **Rhino ES5 safety on the HTML side.** The client rewrite lives in `apps-script/*.html` `<script>` blocks — that's Rhino, not V8. No arrow functions, no `let`/`const`, no template literals, no destructuring. The `rhino-safe-html` user-global skill is the canonical reference and triggers automatically on those edits. The `.gs` server fn itself runs on V8 and can use modern syntax freely — the syntax barrier is one-sided.

6. **Pick the deploy mechanism by where the new server fn lives:**
   - New fn is in `OrderGuideScript.gs` and called only from bound sidebars (e.g. `Manage*.html`) → `python deploy.py` (no `--redeploy`). Bound sidebars read HEAD.
   - New fn is in `MOGApi.gs` or any `api_*` function the PWA calls via `/exec` → `python deploy.py --redeploy`. The `/exec` URL serves a versioned snapshot; push alone leaves it stale.
   - When unsure → `--redeploy`. Costs ~3s/target, ships correctness.

7. **Canary first, fan out second.** `python deploy.py --target rpr` (with `--redeploy` if applicable) → wait for Sebastian to open the live thing and confirm → then full deploy. Don't accept "no tooling errors" as verification — Sebastian validates by using the feature.

## Anti-patterns (caught in past sessions)

- **Trusting the audit's count.** The pre-implementation audit overstated call-counts twice. Always re-read the actual modal file before drafting the consolidation.
- **Adding `let`/`const`/arrow fns in the HTML rewrite.** Rhino runtime error. The `.gs` side accepts them; the HTML side does not.
- **Pruning the old fns in the same change.** Bigger diff, harder to review, no real benefit. Leave the deadcode for a dedicated cleanup session.
- **Forgetting `--redeploy` when the new server fn is in MOGApi.gs.** Push succeeds, bound sidebars look right (they read HEAD), but the PWA's `/exec` URL keeps serving the old code. Symptom: "I deployed but the PWA still shows the old behavior."
- **One big bootstrap that pulls everything the modal might ever need.** Keep it scoped to what the modal fires on open (or on save). Future-proofing inflates the server fn and hides which fields are actually needed.

## Canonical examples to read before writing

- `apps-script/OrderGuideScript.gs` → `getOrderHistoryBootstrap` (read consolidation, vendor list derived from log rows).
- `apps-script/OrderGuideScript.gs` → `commitUpdateVendorMultsAndCutoff` (write consolidation, upfront validation).
- `apps-script/OrderGuideScript.gs` → `commitAreaListMutation_` (higher-order list-mutation helper).
- `apps-script/MOGApi.gs` → `getManageItemsBootstrap` (read consolidation + cache wrap — see also [[mog-apps-script-caching]] if the new fn warrants caching).

## Composition with other skills

- [[architectural-walkthrough]] runs first if the consolidation crosses more than one file or changes a payload shape.
- [[mog-deploy-workflow]] picks the deploy mechanism (push vs `--redeploy`).
- [[rhino-safe-html]] auto-triggers on the HTML rewrite.
- [[mog-apps-script-caching]] is the natural follow-on if the new server fn is a frequently-called read in MOGApi.gs.
