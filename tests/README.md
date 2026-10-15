# tests/

Node gates that run the real Apps Script code locally. No dependencies; Node 18+.

```bash
node tests/run_all.js
```

A passing run ends with `run_all: ALL PASS (4 gates)`. Run it before deploying any change to `apps-script/OrderMath.gs`, `MOGApi.gs`'s count/dashboard path, or `Sync.gs`.

| Gate | What it proves |
|---|---|
| `ordermath_equivalence.test.js` | The 2026-10-15 move of the order math into `OrderMath.gs` changed no server answer: old (`c0b6dfb`) and new give identical output, order, errors and cells read on 400 randomized stores. The old side is pinned on purpose: a change that *means* to alter answers fails here, and you re-pin `BASE`. |
| `ordermath_phone_parity.test.js` | The phone's path (catalog JSON → `orderInputsFromSnapshot_` → shared builders) matches the server through `Sync.gs`'s own `supabaseParityReport_`. Tabs are built by the documented column-M rule, so this proves the plumbing, **not** that the rule matches the live formula. Run `test_supabaseParity` on a real store for that. |
| `ordermath_purity.test.js` | `OrderMath.gs` runs with no Apps Script or DOM around it (the PWA runs it verbatim), names no service or outside constant, holds only functions, kept the two moved functions byte-identical, and no function name is declared in two `.gs` files. |
| `slice_js_selftest.js` | The slicer the gates use takes exactly one function, never more. |

Every gate carries planted-defect controls: each one breaks the code on purpose, and the gate must catch it. A control that doesn't bite fails the run.

**Never put `.js` files under `apps-script/`.** clasp pushes every `.js` there to all stores as script code. Gates live here.
