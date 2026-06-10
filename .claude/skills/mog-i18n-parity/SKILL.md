---
name: mog-i18n-parity
description: Verify EN/ES bilingual parity across MOG Apps Script modals deterministically, instead of counting `var T = { en, es }` glossary keys by hand. Use whenever a modal's strings change — adding/removing/renaming a T key, translating a new toast, or finishing any ManageItems/OrderHistory/ManageVendors/etc. edit that touched user-facing text. Trigger on "check the EN/ES parity", "did I drop a translation key", "is this modal at parity", "count the keys", "this string is English-only", or at the end of any modal session that added strings (the old habit was "102 keys each, verified" by eye). Ships scripts/check_i18n_parity.py. Skip for the PWA (template/index.html uses an inline `state.lang` ternary, not a T glossary — different mechanism) and for English-only files.
---

# mog-i18n-parity

Every modal session that touches strings used to end with a hand-count — *"102 keys each, verified"*, *"EN+ES kept at parity"*. Counting glossary keys by eye is a token sink and easy to get wrong (one appended-instead-of-inserted key and the count still matches but the order drifts). This skill replaces that with a deterministic check.

## The one command

```
python .claude/skills/mog-i18n-parity/scripts/check_i18n_parity.py --all
```

`--all` scans every `apps-script/*.html`. Or pass explicit files:

```
python .claude/skills/mog-i18n-parity/scripts/check_i18n_parity.py apps-script/ManageItems.html
```

Exit code 0 = parity everywhere (skips count as pass), 1 = at least one mismatch, 2 = bad args. Run it **after** editing a modal's strings and **before** you call the work done — it's the verification gate that closes the i18n loop.

## What it checks (two auto-detected modes)

- **Mode B — JS glossary** (`var T = { en: {...}, es: {...} }`): the 6 interactive modals (AdminReset, ManageItems, ManageVendors, OrderHistory, ReorderPickPath, StorageAreas). Compares the two key sets and reports keys missing from either side, duplicate keys, and order drift (a key inserted in one block but appended in the other — passes the count test but warns here).
- **Mode A — dual-span** (`class="en"` / `class="es"`): the static-help modal HowToUse. Compares span counts; each `.en` content span needs a sibling `.es`.
- **Neither → SKIP** (counts as pass): English-only or non-bilingual files.

Known-good baseline (2026-05-27): AdminReset 10, ManageVendors 25, ReorderPickPath 24, StorageAreas 15, OrderHistory 41, ManageItems 102, HowToUse 227 spans. If a count drops below these after an edit, you removed a key — intended or not, the script tells you which one.

## How to read a failure

- `MISSING from T.es (present in EN): <keys>` — you added an EN key and forgot its ES translation (or vice versa). Add the missing side.
- `DUPLICATE keys in T.en` — a copy-paste left two entries with the same key; the second silently wins at runtime. Remove one.
- `WARNING: key order differs` — not fatal, but means a key was inserted in one block and appended in the other. Re-order so EN and ES read in the same sequence; makes future diffs reviewable.
- Mode A `MISMATCH` is a heuristic — verify by eye before adding/removing a span; a stray non-content `class="en"` can skew the count.

## The script is a thin wrapper — logic lives in the canonical

`scripts/check_i18n_parity.py` is a logic-free wrapper over the canonical `~/.claude/skills/i18n-parity-checker/scripts/check_i18n_parity.py` (converted from a full fork on 2026-06-10 per the [[checker-script-sync]] push-toward-fewer-copies rule). The wrapper's only job is expanding `--all` to `apps-script/*.html` before delegating; all parsing logic, modes, and exit codes are the canonical's. Parser fixes land in the canonical copy, never here — if this wrapper ever grows parsing logic, that's drift.

## Composition with other skills

- [[mog-modal-ux-sweep]] changes modal markup/CSS; this verifies the i18n side stayed balanced afterward.
- [[rhino-safe-html]] governs the JS syntax of the glossary block (ES5-safe object literal).
- [[checker-script-sync]] owns the canonical↔fork relationship for this and the other deterministic checkers.
- [[mog-session-handoff]] — run this before writing the handoff so "EN/ES at parity" is a verified claim, not an eyeballed one.
