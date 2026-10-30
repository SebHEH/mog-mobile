# Claude Code task: act on the 2026-10-30 audit

Paste this file's contents into Claude Code at the repo root, or tell Claude Code: "Read `MOG_ClaudeCodeTask_2026_10_30.md` and start with Batch A."

---

## Mission

I had an independent audit of MOG done on 2026-10-30. Act on it in small, verified batches. The findings and their evidence are in [docs/MOG_Audit_2026_10_30.md](docs/MOG_Audit_2026_10_30.md); read it before touching anything. This file is the work order, not a second copy of the findings.

The audit found no emergency. The code is in good shape and the gates are strong. What it found is a set of places where the tooling around the code can silently ship the wrong thing, plus a few low-risk hardening and doc fixes.

## Non-negotiables

1. `git pull` first. Then work on a branch (`audit/2026-10-30-fixes`), not `main`, unless I say otherwise. Open a PR.
2. **Never edit a generated `<slug>/` directory.** Edit `template/` or `stores.json`, then run `python build.py`.
3. **Never deploy without asking me.** Batch A and B need no deploy. If a task would need one, stop and ask, and name the command and the canary.
4. Run `node tests/run_all.js` before and after each batch. Today it is **red on Windows**: `slice_js_selftest.js` fails 3 controls. That is task #22; fix it first so every later batch has a green baseline.
5. Every behavior change gets a gate or a stated manual check. No "verified by reading".
6. Do not refactor for taste. The audit deliberately did not ask for a rewrite of `template/index.html` or the Sheet modals.

## Read first

- [docs/MOG_Audit_2026_10_30.md](docs/MOG_Audit_2026_10_30.md), the findings and evidence.
- [CLAUDE.md](CLAUDE.md), invariants and routing.
- [tests/README.md](tests/README.md), what each gate proves.
- [.claude/skills/mog-deploy-workflow/SKILL.md](.claude/skills/mog-deploy-workflow/SKILL.md) before changing `route.py`.

## Batch A: the tooling that decides what ships (no deploy)

Do these in order. They are independent of each other except that #22 gives you a green baseline.

### A1. #22 Make the gate suite pass on a Windows checkout

Fix [tests/slice_js_selftest.js](tests/slice_js_selftest.js): it reads `slice_js.js` from disk with CRLF and its control anchors contain `\n`. Normalise newlines once at load, or make the control find/replace EOL-agnostic. Do not weaken a control and do not delete one.

Acceptance:
- `node tests/slice_js_selftest.js` passes on this CRLF checkout.
- The same two files copied to a temp folder with LF still pass (`node` both copies).
- `node tests/run_all.js` ends `run_all: ALL PASS (24 gates)`.

### A2. #21 Gate the build output

The repo's #1 pitfall is editing `template/` and forgetting `python build.py`, and CI cannot see it. Add a gate (suggested: `tests/build_output.test.js`, following the style of [tests/editor_link.test.js](tests/editor_link.test.js), which already shells a Python tool) that:

- renders each store's `index.html` from `template/index.html` + `stores.json` exactly as `build.py` does, and compares it to the committed `<slug>/index.html`;
- compares the editor output for one store (`editor/*.js`, `orderMath.js`, and the eight rendered pages) the same way;
- compares line endings normalised, so the gate passes on LF (CI) and CRLF (Windows);
- runs `python build.py --dry-run` and fails on a non-zero exit;
- never writes to tracked files.

Acceptance:
- Green on a clean tree.
- Editing `template/index.html` by one character without rebuilding makes it fail with the store names.
- Editing one `<slug>/index.html` by hand without a rebuild makes it fail.
- A planted-defect control for each of the two failures above, in the house style.

### A3. #20 Fix the deploy router

[.claude/skills/mog-deploy-workflow/scripts/route.py](.claude/skills/mog-deploy-workflow/scripts/route.py) returns one action per file and takes the max, so it cannot say "build AND redeploy". It also routes `apps-script/OrderMath.gs` to push-only, which skips both the phone copy and the `/exec` snapshot.

Do this:
- Return a **set** of actions per file and print every one, strongest first.
- `apps-script/OrderMath.gs` requires `BUILD` + `REDEPLOY`.
- `appsscript.json` requires `REDEPLOY` when the `webapp` block changes (a VERIFY note is fine when only scopes change).
- Any change under `template/` plus any change under `apps-script/` prints both commands.
- Update [.claude/skills/mog-deploy-workflow/SKILL.md](.claude/skills/mog-deploy-workflow/SKILL.md) to match.
- Add `tests/route.test.js` (shell `python route.py`, assert the printed commands) covering: `OrderMath.gs`, `template/index.html` + `apps-script/MOGApi.gs`, `stores.json`, `MOGApi.gs`, `supabase/schema_v10.sql`, an unknown path.

Acceptance:
- `python .claude/skills/mog-deploy-workflow/scripts/route.py apps-script/OrderMath.gs` prints both `python build.py` and `python deploy.py --redeploy`.
- The combined case prints both commands.
- The new gate is in `run_all`.

### A4. #23 Re-stamp the audit map

In [docs/MOG_AuditMap.md](docs/MOG_AuditMap.md): add the five area rows from the audit's section 6, stamped at the commit Batch A lands in, with the item ids. Set "next code item #38, next visual item A12". Do not delete the old sections.

Acceptance: the table has no area still stamped `8a8de37`, and the resume line names #38 / A12.

## Batch B: small and safe (no deploy)

- **B1. #33** `deploy.py --discover` prints invalid JSON. Make it print a pasteable object per target. Verify with `python deploy.py --discover --dry-run`; if that path needs a live clasp login, add a unit-level check of the formatting function instead and say so.
- **B2. #35** `deploy.py` says `--redeploy` skips the template but redeploys it. Skip `isTemplate` targets in the redeploy phase, or fix the help text. Prefer skipping; the template has no `/exec`.
- **B3. #34** Reserve every existing top-level entry in `build.py` (`docs`, `tests`, `icons`, `supabase`, `editor`, `_preview`, plus the current list), or refuse a slug whose target directory exists and is not a store. Add a case to `concepts.test.js`'s area or a tiny new check.
- **B4. #30** Rebuild the file table in [apps-script/README.md](apps-script/README.md) from the actual folder. Remove `HowToUse.html`. Add the missing files and one short section on Supabase and on `--redeploy`.
- **B5. #31** Fix the stale sizes and the `validate.py` path in [CLAUDE.md](CLAUDE.md) (drop the KB numbers or make them "one file").
- **B6. #32** Make the Settings version come from one place. Prefer a `build.py` injection over a second constant; if that is more than a small change, add a gate that asserts `versionStr` equals the version in the current handoff and leave the literal.
- **B7. #29** In [Items.html](template/editor/Items.html), [Overview.html](template/editor/Overview.html), [Changes.html](template/editor/Changes.html), replace `document.body.className = 'lang-…'` with the classList toggle pattern used in [ManageItems.html](apps-script/ManageItems.html).
- **B8. A11** In [Items.html](template/editor/Items.html) and [Overview.html](template/editor/Overview.html), route the error text, Delete link, error toast and "bad" icon chip through `var(--danger)` (and one background token or a single literal chosen once). Do not touch the recorded neutral-grey decision.

Acceptance for Batch B: `node tests/run_all.js` green; `python build.py --dry-run` clean; for B7/B8, `python build.py` if `template/` changed, and say that a browser check is still needed.

## Batch C: decisions before code

Do not implement these until I pick. Present each with the options, the cost, and a recommendation.

### C1. #24 PIN policy

4-digit PINs, one shared 5-try/5-min lockout, checked before the master PIN, on a public slug. Options: raise the minimum to 6 digits for new/changed PINs; exponential backoff; a separate master-PIN counter so a lockout does not block it; a lockout clear from a signed-in device. State what each does to the existing 10 stores and to the `/exec` path.

### C2. H1 same-day close destroys the day's log

This is the held-back CurrentState item, now diagnosed in the audit. The recommended fix is `last_closed_date` on `mog.store_state`, set on every close. A close whose `p_closing <= last_closed_date` and is not an explicit `sameDay` re-close still advances the cycle, but skips the log replacement in both `mog.order_log` and `LOG_ORDERS`, so the day's history survives and the new day still starts. If I approve, follow [.claude/skills/mog-supabase-schema/SKILL.md](.claude/skills/mog-supabase-schema/SKILL.md): new `schema_v10.sql`, `smoke_v10.sql`, fake-Supabase and gate updates, SQL run by a maintainer first, then the code.

### C3. H2 override off before 3:30 changes the log and recap

Same shape: the log is computed at close from live state. Options: persist the override context on each count row; snapshot it when the first vendor is marked reviewed; or refuse to clear the override while the cycle has counts, unless the KM confirms. Recommend one and say what it costs.

### C4. #36 partial recap send

Decide whether a partially delivered recap should retry the failed addresses or stay "one attempt, delivered is delivered". If retry: keep the failed list in `MOG_PENDING_RECAP`.

## Batch D: hardening, after Batch A (no deploy)

- **D1. #25** Bound `p_cycle_date` in `mog_sync_set_state` to 7 days either side of the store's local today. Needs a schema version (fold into C2's `schema_v10.sql` if both are approved).
- **D2. #26** Cap the rows array in `mog.upsert_counts` (and its wrappers) at ~2,000, returning the normal error envelope. Fold into the same schema version.
- **D3. #27** Make `api_saveOnHand_` treat a blank or non-finite `onHand` the way `mog.to_onhand` does. Add a case to `supabase_step4.test.js` or a small unit check.
- **D4. #37** When `appendLogBackup_` fails, send the recap from the rows in hand (`sendRecapRowsNow_`) instead of scheduling a read of an empty log.
- **D5. #28** Make the app's language switch update an open Manage frame. This needs a browser check: open the app, open Items, switch to ES, confirm the frame's labels change. Say it is unverified if you cannot run a browser.

Acceptance for Batch D: gates green; every schema change has a smoke file and a fake-Supabase update; no deploy until I approve.

## Do not

- Do not edit `<slug>/` output, `apps-script/.clasp-targets.json` unless the task says so, or any deployed `clasp` state.
- Do not change `FORCE_RELOAD_ID`.
- Do not run `python deploy.py` or `--redeploy`.
- Do not run SQL. Write the file and tell me to run it.
- Do not "fix" the recorded NOT-findings in the audit (Rhino lint, the `audit_modals.py` false positive, neutral greys).
- Do not add a bundler, a framework, or a new runtime dependency.

## Finish with

1. `node tests/run_all.js` output pasted, not summarised.
2. A short table: item, what changed, how it was verified, whether a deploy is needed.
3. The audit map updated (A4) and any new decision or open item written into [docs/MOG_CurrentState.md](docs/MOG_CurrentState.md).
4. A session handoff per [.claude/skills/mog-session-handoff/SKILL.md](.claude/skills/mog-session-handoff/SKILL.md), with the items that stayed open, not only the ones that closed.
