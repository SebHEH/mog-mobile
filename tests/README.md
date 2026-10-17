# tests/

Node gates that run the real Apps Script code locally. No dependencies; Node 18+.

```bash
node tests/run_all.js
```

A passing run ends with `run_all: ALL PASS (6 gates)`. Run it before deploying any change to `apps-script/OrderMath.gs`, `MOGApi.gs`'s count/dashboard path, or `Sync.gs`.

| Gate | What it proves |
|---|---|
| `ordermath_equivalence.test.js` | The 2026-10-15 move of the order math into `OrderMath.gs` changed no server answer: old (`c0b6dfb`) and new give identical output, order, errors and cells read on 400 randomized stores. The old side is pinned on purpose: a change that *means* to alter answers fails here, and you re-pin `BASE`. |
| `ordermath_phone_parity.test.js` | The phone's path (catalog JSON → `orderInputsFromSnapshot_` → shared builders) matches the server through `Sync.gs`'s own `supabaseParityReport_`. Tabs are built by the documented column-M rule, so this proves the plumbing, **not** that the rule matches the live formula. Run `test_supabaseParity` on a real store for that. |
| `ordermath_purity.test.js` | `OrderMath.gs` runs with no Apps Script or DOM around it (the PWA runs it verbatim), names no service or outside constant, holds only functions, kept the two moved functions byte-identical, and no function name is declared in two `.gs` files. |
| `supabase_step4.test.js` | Step 4. The same randomized store is built twice, on the Sheet and switched to a fake Supabase (`fake_supabase.js`), and driven through the real `doPost`. Every count-path answer matches, before and after each write. The Supabase cycle close logs what the Sheet reset would, touches only `LOG_ORDERS`, never closes twice, and changes nothing when Supabase is down. A store that isn't connected never calls Supabase. The web-editor envelope and the background-push queue behave. |
| `supabase_move.test.js` | 📱 Mobile API → Move this store to Supabase, run with a scripted fake menu. Nothing changes until the connect code checks out and the person says Yes. A missing permission shows Google's consent link, escaped. A move leaves Supabase exactly as `supabase_step4`'s seed path does. A failure part-way, or a rollback, resumes without asking for the code again. `supabase/provision_stores.sql` lists every deploy target with its Sheet and never re-keys a store that already connected. |
| `pwa_direct.test.js` | Step 5. The phone's direct mode runs from the real template code (`api()`, the save queue, the DIRECT CLIENT block) plus `OrderMath.gs`. Every count-path answer equals `/exec`'s for the same store, for fresh and reused snapshots, before and after every write. `supabase_step4` already proves `/exec` matches the Sheet. Also checks: sign-in fallbacks (store not moved, Supabase down), a wrong PIN not retried on `/exec`, the master PIN, history and reset on `/exec` with the snapshot refreshed after, a queued save draining into its own cycle after the close, re-sign-in after the session expires, `USE_EXEC` mid-session, and the template's 5 build placeholders. |
| `public_surface.test.js` | What a page served by the web app can reach on the server (D18). Every public function in `apps-script/*.gs` is on a reviewed list with its reason. Editor-run ones start with `requireEditorRun_()`; UI ones start by touching the Sheet's UI. Pages call `google.script.run` only for `webedit_call` and the auth layer. Every dispatcher action maps to an existing private function, and every action a page sends is one of them. Menu items and trigger handlers name real functions. |
| `editor_fixes.test.js` | The whole Apps Script codebase in one fake context. Removing a vendor deletes only its own cells (R:AA, AF), leaving storage areas, the pick path and recipients alone. An item save from a form without notes keeps them. Sheet-only dispatcher actions need a Sheet token, and the editor-run guard refuses a web caller. |
| `editor_link.test.js` | `editor_link.py` names the right `.gs` file and links, refuses requests that can't be followed, and every store's Sheet is recorded. |
| `slice_js_selftest.js` | The slicer the gates use takes exactly one function, never more. |

**Testing any server function at runtime:** every `apps-script/*.gs` file holds only declarations, so the WHOLE codebase loads into one vm context with the fakes. `editor_fixes.test.js` does it in a few lines (`compileAll`); no slicing needed. Add any missing fake method to `fake_apps_script.js`. A fake's reads must never create data (`FakeSupabase.countsIn`).

Every gate carries planted-defect controls: each one breaks the code on purpose, and the gate must catch it. A control that doesn't bite fails the run.

**Never put `.js` files under `apps-script/`.** clasp pushes every `.js` there to all stores as script code. Gates live here.
