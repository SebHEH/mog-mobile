#!/usr/bin/env python
"""Deterministic fact-gather for the MOG session handoff.

The mog-session-handoff skill writes docs/MOG_SessionHandoff_<today>.md. Two of
its inputs are fixed, repeatable lookups that the skill currently asks Claude to
do by hand — and one of them (the date) is the source of a specific recurring
mistake the skill warns about twice: inventing a FUTURE date to dodge a filename
collision instead of updating today's file in place. A script can't be tempted
to bump the date; it just reports what today is and whether today's file already
exists. This removes the judgment from the parts that don't need it.

Reports:
  - Today's date (system local), in the YYYY_MM_DD form the filename uses.
  - Whether docs/MOG_SessionHandoff_<today>.md ALREADY EXISTS
    -> UPDATE-IN-PLACE  (append a "## Later session" block; do NOT make a new file)
    -> CREATE-NEW       (write today's file fresh)
    (Either way: NEVER a future date. The decision is binary and the script makes it.)
  - Commits not yet on origin/main (git log origin/main..HEAD) -> the "Commits
    landed this session" block, minus the manual git fishing.
  - Uncommitted changes (git status --porcelain) -> sanity check that the work
    is actually committed before the handoff claims it shipped.

Usage:
    python .claude/skills/mog-session-handoff/scripts/handoff_facts.py

Pure stdlib, Python 3, zero deps. Read-only (only `git log`/`git status`; never
writes or commits). Exit 0 always — it's an informational gather, not a gate.
"""
import subprocess
import sys
from datetime import date
from pathlib import Path

# scripts -> mog-session-handoff -> skills -> .claude -> repo root
REPO_ROOT = Path(__file__).resolve().parents[4]
DOCS = REPO_ROOT / "docs"


def git(args):
    """Run a read-only git command from repo root; return stdout or '' on error."""
    try:
        out = subprocess.run(
            ["git"] + args,
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=20,
        )
        return out.stdout.rstrip("\n")
    except Exception as e:  # git missing / not a repo / timeout
        return "ERROR: " + str(e)


def main():
    today = date.today().strftime("%Y_%m_%d")
    handoff = DOCS / ("MOG_SessionHandoff_" + today + ".md")
    exists = handoff.is_file()

    print("Today (filename form): " + today)
    print("Target file: docs/MOG_SessionHandoff_%s.md" % today)
    if exists:
        print("Decision: UPDATE-IN-PLACE  (today's file exists -- append a")
        print("          '## Later session -- <topic>' block; do NOT create a new file,")
        print("          and do NOT bump to a future date.)")
    else:
        print("Decision: CREATE-NEW  (today's file does not exist yet -- write it fresh.")
        print("          Still never a future date; today's date is authoritative.)")
    print("")

    print("Commits not yet on origin/main (git log origin/main..HEAD):")
    ahead = git(["log", "origin/main..HEAD", "--oneline"])
    print(ahead if ahead else "    (none -- everything is pushed, or no new commits)")
    print("")

    print("Uncommitted changes (git status --porcelain):")
    dirty = git(["status", "--porcelain"])
    if dirty and not dirty.startswith("ERROR"):
        print(dirty)
        print("    ^ commit/clean these before the handoff claims the work shipped.")
    elif dirty.startswith("ERROR"):
        print("    " + dirty)
    else:
        print("    (clean)")
    print("")

    print("Recent commits for context (git log --oneline -8):")
    recent = git(["log", "--oneline", "-8"])
    print(recent if recent else "    (none)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
