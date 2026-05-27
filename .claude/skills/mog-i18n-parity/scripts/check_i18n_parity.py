#!/usr/bin/env python3
"""
check_i18n_parity.py — deterministic EN/ES key-parity checker (MOG fork).

Parses the `var T = { en: {...}, es: {...} };` glossary block in an HTML modal
and verifies that T.en and T.es declare exactly the same keys. Replaces the
error-prone "open the file and count keys" step the MOG modal sessions kept
doing by hand ("102 keys each, verified") — counting keys by eye is a token
sink and easy to get wrong; this gives the same answer every time for free.

MOG FORK NOTE (see the checker-script-sync skill): this is a per-repo fork of
the canonical ~/.claude/skills/i18n-parity-checker/scripts/check_i18n_parity.py.
The ONLY intentional divergence is the `--all` glob target: MOG's modals live in
`apps-script/*.html`, not the repo root, so `--all` scans there. All parsing
logic is shared with the canonical copy — if you fix a parser bug here, port it
to the canonical copy (and vice versa); do NOT let the parsing drift.

Handles the codebase's real quirks:
  - multiple keys per line (e.g. `colA: 'A', colB: 'B',`)
  - colons inside string values (stripped before key extraction)
  - escaped quotes inside strings
  - Unicode escapes in values (left untouched — only structure matters)

Usage:
    python scripts/check_i18n_parity.py <modal.html> [<modal2.html> ...]
    python scripts/check_i18n_parity.py --all        # every apps-script/*.html

Two modes, auto-detected per file:
    - Mode B (JS glossary): `var T = {en, es}` present -> compares the key sets.
    - Mode A (CSS dual-span): no glossary, but `class="en"`/`class="es"` spans
      present -> compares span counts (static help modals like HowToUse).
    - Neither: SKIP (English-only templates / non-bilingual files).

Exit code:
    0  every applicable file has full EN/ES parity (skips count as pass)
    1  at least one file has a key/span mismatch
    2  bad arguments / file not found

Output: per file, the EN and ES key counts, plus any keys missing from each
side and any order drift (keys present in both but in a different relative
order — usually a sign a key was inserted in one block but appended in the
other).
"""

import sys
import re
import glob
import os

GLOSSARY_START = "BILINGUAL GLOSSARY"
GLOSSARY_END = "END GLOSSARY"

# Matches a single- or double-quoted JS string, respecting backslash escapes.
_STRING_RE = re.compile(r"'(?:\\.|[^'\\])*'" r'|"(?:\\.|[^"\\])*"')
# A top-level object key: identifier followed by a colon (after strings stripped).
_KEY_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*:")


def _find_block_body(text, label, search_from=0):
    """Return (body_text, end_index) for `label: { ... }` via brace matching
    that ignores braces inside string literals. label is 'en' or 'es'."""
    m = re.search(r"\b" + re.escape(label) + r"\s*:\s*\{", text[search_from:])
    if not m:
        return None, search_from
    open_idx = search_from + m.end() - 1  # index of the '{'
    depth = 0
    i = open_idx
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in "'\"":
            sm = _STRING_RE.match(text, i)
            if sm:
                i = sm.end()
                continue
            i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[open_idx + 1:i], i + 1
        i += 1
    return None, search_from  # unbalanced


def _extract_keys(block_body):
    """Ordered list of top-level keys in an object body. Strings stripped first
    so colons/identifiers inside values can't masquerade as keys."""
    cleaned = _STRING_RE.sub("''", block_body)
    return _KEY_RE.findall(cleaned)


def _locate_glossary(text):
    """Narrow to the glossary region if the fence comments are present;
    otherwise fall back to the first `T = {` declaration."""
    start = text.find(GLOSSARY_START)
    if start != -1:
        end = text.find(GLOSSARY_END, start)
        return text[start: end if end != -1 else len(text)]
    t = re.search(r"\bT\s*=\s*\{", text)
    return text[t.start():] if t else text


# Match the EXACT dual-span content shape (`class="en"` / `class="es"`), not
# "any class containing en/es". Every bilingual content span in the modals
# uses this exact form; the loose `\ben\b` variant also caught language-MODE
# classes like `lang-en` (the body/button toggle classes that `setLang()`
# swaps at runtime), inflating the count and reporting a phantom mismatch on a
# file that was actually at parity. Mechanism classes stay namespaced
# (`lang-en`); content spans stay bare — keep that distinction and this stays
# precise.
_SPAN_EN_RE = re.compile(r'class\s*=\s*"en"')
_SPAN_ES_RE = re.compile(r'class\s*=\s*"es"')

# Status sentinels for the file-level result.
STATUS_PASS = "pass"
STATUS_FAIL = "fail"
STATUS_SKIP = "skip"


def _check_dual_span(text):
    """Mode A fallback: compare count of class="en" and class="es" spans."""
    en = len(_SPAN_EN_RE.findall(text))
    es = len(_SPAN_ES_RE.findall(text))
    if en == 0 and es == 0:
        return STATUS_SKIP, ["  SKIP -- no JS glossary and no dual-span markup "
                             "(English-only template or non-bilingual file)"]
    rpt = ["  Mode A (dual-span). EN spans: %d   ES spans: %d" % (en, es)]
    if en == es:
        rpt.append("  OK -- dual-span counts match")
        return STATUS_PASS, rpt
    rpt.append("  MISMATCH -- dual-span counts differ by %d. Each .en span needs "
               "a sibling .es span (and vice versa)." % abs(en - es))
    rpt.append("  (heuristic -- verify by eye before adding/removing any span; "
               "a stray non-content class can skew the count)")
    return STATUS_FAIL, rpt


def check_file(path):
    """Return (status: str, report_lines: list[str])."""
    rpt = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        return STATUS_FAIL, ["  ERROR: cannot read file: " + str(e)]

    region = _locate_glossary(text)
    en_body, after_en = _find_block_body(region, "en")
    if en_body is None:
        # No JS glossary -- fall back to Mode A dual-span check.
        return _check_dual_span(text)
    es_body, _ = _find_block_body(region, "es", after_en)
    if es_body is None:
        return STATUS_FAIL, ["  ERROR: T.en found but no T.es glossary block"]

    en_keys = _extract_keys(en_body)
    es_keys = _extract_keys(es_body)
    en_set, es_set = set(en_keys), set(es_keys)

    rpt.append("  EN keys: %d   ES keys: %d" % (len(en_keys), len(es_keys)))

    missing_es = [k for k in en_keys if k not in es_set]
    missing_en = [k for k in es_keys if k not in en_set]

    dup_en = sorted({k for k in en_keys if en_keys.count(k) > 1})
    dup_es = sorted({k for k in es_keys if es_keys.count(k) > 1})

    ok = True
    if missing_es:
        ok = False
        rpt.append("  MISSING from T.es (present in EN): " + ", ".join(missing_es))
    if missing_en:
        ok = False
        rpt.append("  MISSING from T.en (present in ES): " + ", ".join(missing_en))
    if dup_en:
        ok = False
        rpt.append("  DUPLICATE keys in T.en: " + ", ".join(dup_en))
    if dup_es:
        ok = False
        rpt.append("  DUPLICATE keys in T.es: " + ", ".join(dup_es))

    # Order drift: among keys present in both, compare relative order.
    if ok:
        common_en = [k for k in en_keys if k in es_set]
        common_es = [k for k in es_keys if k in en_set]
        if common_en != common_es:
            first = next((k for a, k in zip(common_es, common_en) if a != k), None)
            rpt.append("  WARNING: key order differs between EN and ES "
                       "(first divergence near '%s'). Not fatal, but a sign a key "
                       "was inserted in one block and appended in the other." % first)

    if ok:
        rpt.append("  OK -- full parity")
    return (STATUS_PASS if ok else STATUS_FAIL), rpt


def _repo_root():
    # scripts/ -> mog-i18n-parity/ -> skills/ -> .claude/ -> repo root
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.abspath(os.path.join(here, "..", "..", "..", ".."))


def main(argv):
    args = argv[1:]
    if not args:
        print(__doc__)
        return 2
    if args == ["--all"]:
        modal_dir = os.path.join(_repo_root(), "apps-script")
        files = sorted(glob.glob(os.path.join(modal_dir, "*.html")))
        if not files:
            print("No *.html found under %s" % modal_dir)
            return 2
    else:
        files = args

    any_fail = False
    n_pass = n_skip = n_fail = 0
    for path in files:
        print(path)
        status, lines = check_file(path)
        for ln in lines:
            print(ln)
        if status == STATUS_FAIL:
            any_fail = True
            n_fail += 1
        elif status == STATUS_SKIP:
            n_skip += 1
        else:
            n_pass += 1
        print()

    print("RESULT: %s  (pass=%d skip=%d fail=%d)"
          % ("FAIL" if any_fail else "PASS", n_pass, n_skip, n_fail))
    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
