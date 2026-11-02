#!/usr/bin/env python3
"""MOG handoff fact-gather — thin wrapper over the canonical script.

This script was born here and was promoted to the global session-handoff skill
on 2026-06-10 (genericized: it auto-discovers the project prefix from docs/, so
the MOG-specific version became redundant). This wrapper keeps the documented
invocation path working and delegates everything to the canonical copy.

Canonical: ~/.claude/skills/session-handoff/scripts/handoff_facts.py
(synced from the Claude-SKills repo — logic fixes land THERE, never here.)

MOG addition: --check-lessons also needs a "**Skill gate:**" line per Process
lessons block (see the end of this file).

Note for MOG: on a same-day collision the canonical prints both legal moves;
MOG's convention is UPDATE-IN-PLACE (append a '## Later session' block) — never
a second file for the same date, never a future date.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
CANON = os.path.join(os.path.expanduser("~"), ".claude", "skills",
                     "session-handoff", "scripts", "handoff_facts.py")

if not os.path.exists(CANON):
    sys.exit("canonical handoff_facts not found: " + CANON +
             "\nSync global skills first (Claude-SKills repo: sync-skills.ps1).")

code = subprocess.call([sys.executable, CANON] + sys.argv[1:], cwd=ROOT)
if code != 0 or "--check-lessons" not in sys.argv:
    sys.exit(code)

# MOG addition (2026-11-01): the skill gate must be on record, so it can't be
# skipped without Sebastian seeing it. Every Process lessons block needs a
# "**Skill gate:**" line saying what was asked and picked, or "nothing new
# (checked: ...)". The canonical check only sees the [-> dest] tags.
import glob
import re

given = [a for a in sys.argv[1:] if a.endswith(".md")]
paths = given or sorted(glob.glob(os.path.join(ROOT, "docs", "MOG_SessionHandoff_*.md")))
if not paths:
    sys.exit("SKILL GATE CHECK: FAIL (no handoff found)")
path = paths[-1] if not given else os.path.join(ROOT, given[0]) if not os.path.isabs(given[0]) else given[0]
with open(path, encoding="utf-8") as f:
    text = f.read()
blocks = len(re.findall(r"^#{2,3} Process lessons\s*$", text, re.M))
gates = len(re.findall(r"^\*\*Skill gate:\*\*\s*\S", text, re.M))
if gates < max(blocks, 1):
    print("SKILL GATE CHECK: FAIL  " + os.path.relpath(path, ROOT) + ": " + str(blocks) +
          " Process lessons block(s), " + str(gates) + " **Skill gate:** line(s). Run skill-enhance-from-session, ask the"
          " picker round (or say \"nothing new\" and what was checked), and record it under Process lessons.")
    sys.exit(1)
print("SKILL GATE CHECK: PASS  (" + str(gates) + " skill gate line(s))")
