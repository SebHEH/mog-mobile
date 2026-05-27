#!/usr/bin/env python
"""Deterministic pre-scan for the MOG PWA audit.

The mog-pwa-audit skill reads template/index.html (~6100 lines) + sw.js looking
for latent issues. Three of its finding categories are pure mechanical greps,
not judgment calls — running them by eye across 6100 lines is a token sink and
misses things. This script does them in <1s so the human pass starts from a
list of concrete candidates and spends its judgment on the categories that
actually need it (unlocalized strings, stale comments, class-mismatch logic).

What it scans (all in template/index.html unless noted):

  1. Dangling DOM-id references — every getElementById('X') / $('X') whose 'X'
     never appears as id="X"/id='X' in the markup. THIS is the check that would
     have caught the dead uiIsInteractive_ gate (it looked up '#modal-overlay',
     an id that doesn't exist; the real ids are modal-backdrop / busy-overlay).
     Note: ids created dynamically in JS (createElement + id=) will show up as
     candidates too — that's why each is a CANDIDATE to eyeball, not a hard
     failure. A dead gate and a dynamic id look the same to a grep; only a human
     can tell them apart, but the grep is what surfaces the short list.

  2. Undefined CSS custom properties — every var(--X) whose --X is never defined
     (--X: ...) anywhere in the file. Caught the --text-1 (should be --text)
     typo on 2026-05-27. Properties set only via JS style.setProperty are rare
     here and will surface as candidates.

  3. Leftover console.* calls — line numbers of console.log/debug/info, the
     debug-print residue (e.g. the '[reset] api result:' log). Advisory: some
     may be intentional error logging — verify before deleting.

Usage:
    python .claude/skills/mog-pwa-audit/scripts/pwa_scan.py
    python .claude/skills/mog-pwa-audit/scripts/pwa_scan.py --file template/index.html

Exit code is ADVISORY: 0 = no candidates, 1 = candidates to review. It does not
mean "broken" — every hit needs the human eyeball the skill describes. Pure
stdlib, Python 3, zero deps. Matches build.py / deploy.py conventions.
"""
import re
import sys
from pathlib import Path

# scripts -> mog-pwa-audit -> skills -> .claude -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_FILE = REPO_ROOT / "template" / "index.html"

# getElementById('x'), getElementById("x"), and the $('x') / $("x") helper.
_ID_REF_RE = re.compile(r"""(?:getElementById|\$)\(\s*['"]([^'"]+)['"]\s*\)""")
# id="x" / id='x' in markup.
_ID_DEF_RE = re.compile(r"""\bid\s*=\s*['"]([^'"]+)['"]""")
# var(--x) usage and --x: definition. Group 2 is the char after the name: a
# comma means a fallback was supplied (var(--x, 6px)) -> defensive, harmless if
# --x is undefined; anything else means NO fallback -> an undefined --x renders
# as nothing (the --text-1 class of real bug).
_VAR_USE_RE = re.compile(r"var\(\s*(--[A-Za-z0-9_-]+)\s*(,?)")
_VAR_DEF_RE = re.compile(r"(--[A-Za-z0-9_-]+)\s*:")
# console.log / .debug / .info (leave .warn/.error alone — usually intentional).
_CONSOLE_RE = re.compile(r"console\.(log|debug|info)\s*\(")


def scan(text):
    """Return a dict of the three candidate lists."""
    id_refs = set(_ID_REF_RE.findall(text))
    id_defs = set(_ID_DEF_RE.findall(text))
    dangling_ids = sorted(id_refs - id_defs)

    var_defs = set(_VAR_DEF_RE.findall(text))
    # Track, per used var name, whether EVERY usage supplied a fallback.
    undef_no_fallback = {}   # name -> True if at least one usage had no fallback
    for name, comma in _VAR_USE_RE.findall(text):
        if name in var_defs:
            continue
        has_fallback = comma == ","
        undef_no_fallback[name] = undef_no_fallback.get(name, False) or (not has_fallback)
    undefined_no_fb = sorted(n for n, no_fb in undef_no_fallback.items() if no_fb)
    undefined_with_fb = sorted(n for n, no_fb in undef_no_fallback.items() if not no_fb)

    consoles = []
    for i, line in enumerate(text.splitlines(), 1):
        if _CONSOLE_RE.search(line):
            consoles.append((i, line.strip()))

    return {
        "dangling_ids": dangling_ids,
        "undefined_no_fb": undefined_no_fb,
        "undefined_with_fb": undefined_with_fb,
        "consoles": consoles,
    }


def main(argv):
    target = DEFAULT_FILE
    if len(argv) >= 3 and argv[1] == "--file":
        target = Path(argv[2])
    elif len(argv) > 1:
        print(__doc__)
        return 2

    if not target.is_file():
        print("ERROR: file not found: " + str(target))
        return 2

    text = target.read_text(encoding="utf-8", errors="replace")
    r = scan(text)
    print("Scanned: " + str(target))
    print("")

    found = False

    print("[1] Dangling DOM-id references (getElementById/$ with no matching id= in markup):")
    if r["dangling_ids"]:
        found = True
        for x in r["dangling_ids"]:
            print("    - " + x)
        print("    ^ each is EITHER a dynamically-created id (fine) OR a dead reference")
        print("      (the uiIsInteractive_-class bug). Verify each against the markup.")
    else:
        print("    none")
    print("")

    print("[2a] Undefined CSS custom properties, NO fallback (var(--x) with no --x: def):")
    if r["undefined_no_fb"]:
        found = True
        for x in r["undefined_no_fb"]:
            print("    - " + x)
        print("    ^ HIGH SIGNAL -- renders as nothing. Likely a typo (cf. --text-1 -> --text).")
    else:
        print("    none")
    print("")

    print("[2b] Undefined CSS custom properties, WITH fallback (var(--x, fallback)):")
    if r["undefined_with_fb"]:
        for x in r["undefined_with_fb"]:
            print("    - " + x)
        print("    ^ LOW SIGNAL -- always resolves to its fallback. Harmless, but the")
        print("      design token was probably meant to exist. Not a bug; tidy if you like.")
    else:
        print("    none")
    print("")

    print("[3] Leftover console.log/debug/info calls:")
    if r["consoles"]:
        found = True
        for ln, src in r["consoles"]:
            print("    L%-5d %s" % (ln, src[:100]))
        print("    ^ advisory: some may be intentional. Remove debug residue only.")
    else:
        print("    none")
    print("")

    print("RESULT: %s (advisory -- every hit needs the human eyeball the skill describes)"
          % ("CANDIDATES FOUND" if found else "clean"))
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
