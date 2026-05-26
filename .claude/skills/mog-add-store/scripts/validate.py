#!/usr/bin/env python
"""Deterministic validators for add-store inputs.

Replaces eyeballing the Script ID / web-app URL shape in Steps 2 and 5 of the
mog-add-store procedure. A wrong-shape value sends you down the wrong
troubleshooting branch, so this fails loud and tells you exactly what went wrong.

Usage:
    python .claude/skills/mog-add-store/scripts/validate.py scriptid <value>
    python .claude/skills/mog-add-store/scripts/validate.py exec-url <value>

Exit 0 + "OK" on match; exit 1 + reason on mismatch; exit 2 on bad usage.
Pure stdlib, Python 3, zero deps. Matches build.py / deploy.py conventions.
"""
import re
import sys

CHECKS = {
    # Apps Script project IDs start with "1" and are ~57 base64url chars.
    # Deployment IDs start with "AKfycb" — the most common wrong-field paste.
    "scriptid": (
        r"^1[A-Za-z0-9_-]{50,70}$",
        "Not a Script ID. If it starts with 'AKfycb' that's a deployment ID "
        "(wrong field) - grab the Script ID from Project Settings (gear icon) "
        "in the Apps Script editor.",
    ),
    # The web-app URL the PWA hits must be the /exec endpoint, not /edit or /dev.
    "exec-url": (
        r"^https://script\.google\.com/macros/s/[^/]+/exec$",
        "Not a valid web-app /exec URL. If it ends in /edit or /dev you copied "
        "the wrong field - use the 'Web app URL' shown after Deploy completes.",
    ),
}


def main(argv):
    if len(argv) != 3 or argv[1] not in CHECKS:
        print("usage: validate.py {scriptid|exec-url} <value>")
        return 2

    kind = argv[1]
    value = argv[2].strip()
    pattern, hint = CHECKS[kind]

    if re.match(pattern, value):
        print("OK")
        return 0

    print("INVALID (" + kind + "): " + hint)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
