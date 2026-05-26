#!/usr/bin/env python
"""Deterministic drift detector for the MOG save-capable modals.

The mog-modal-ux-sweep skill exists because the 5 save-capable modals drift
apart between sessions. "Which modals are missing the canonical Saved-beat
feedback?" is a fixed grep, not a judgment call — this reports it in <1s so
the sweep starts from a known state instead of a manual eyeball pass.

Checks each save-capable modal for the canonical signatures:
  - `@keyframes saveFlash`        : the green-flash animation
  - `.status.ok::before`          : the "checkmark" prefix
  - `google.script.host.close()`  : a close affordance exists (markup varies:
    footer button, top-X div, etc. — this is the reliable cross-modal signal)

Usage:
    python .claude/skills/mog-modal-ux-sweep/scripts/audit_modals.py

Exit 0 if every modal has every signature; exit 1 if any drift is found
(so it can gate a sweep). Pure stdlib, Python 3, zero deps. The *placement*
of any missing block stays a judgment call for the sweep itself — this only
detects presence/absence.
"""
import sys
from pathlib import Path

# Repo root: scripts -> mog-modal-ux-sweep -> skills -> .claude -> root
REPO_ROOT = Path(__file__).resolve().parents[4]
APPS = REPO_ROOT / "apps-script"

SAVE_MODALS = [
    "AdminReset.html",
    "ManageItems.html",
    "ManageVendors.html",
    "ReorderPickPath.html",
    "StorageAreas.html",
]

# label -> substring(s); a check passes if ANY of its substrings is present.
SIGNATURES = [
    ("save-flash", ["@keyframes saveFlash"]),
    ("ok-checkmark", [".status.ok::before"]),
    ("close-affordance", ["google.script.host.close()"]),
]


def main():
    if not APPS.is_dir():
        print("ERROR: apps-script/ not found at " + str(APPS))
        return 2

    drift = False
    width = max(len(m) for m in SAVE_MODALS)

    for modal in SAVE_MODALS:
        path = APPS / modal
        if not path.is_file():
            print("{:<{w}}  MISSING FILE".format(modal, w=width))
            drift = True
            continue

        text = path.read_text(encoding="utf-8", errors="replace")
        marks = []
        for label, needles in SIGNATURES:
            present = any(n in text for n in needles)
            marks.append(label if present else "NO:" + label)
            if not present:
                drift = True
        print("{:<{w}}  {}".format(modal, "  ".join(marks), w=width))

    print("")
    if drift:
        print("DRIFT FOUND - modals above with NO:<sig> need the sweep applied.")
        return 1
    print("All save-capable modals are consistent.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
