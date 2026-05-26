---
name: mog-session-handoff
description: Produce the end-of-session handoff document for the MOG (Master Ordering Guide / mog-mobile) repo. Use at the natural close of any session that shipped material changes — code, config, docs, or deploy. Trigger on phrases like "close out the session", "session summary", "wrap up", "what should I bring to the next chat", "write the handoff", or any close variant. ALSO trigger automatically at the end of any session that produced commits or pushed deploys, even if Sebastian doesn't explicitly ask. Skip only when the session was purely exploratory and nothing was decided or shipped.
---

# mog-session-handoff

The artifact that bridges chat sessions for the MOG codebase. Produces `docs/MOG_SessionHandoff_YYYY_MM_DD.md` AND updates `CLAUDE.md`'s @-import line to point at the new file.

## When to use

End of any session that produced material changes:
- Code commits (push to GitHub, `clasp push` to one or more stores)
- New skills, new docs, scaffold changes
- Deploy infrastructure changes (deploy.py edits, .clasp-targets.json edits)
- Schema-ish changes (new fields in stores.json, new placeholder in template/index.html)

Skip when the session was pure exploration (read-only, no commits) or when the work was a single-line typo fix with no architectural implication.

## Date discipline (read this before naming the file)

Use **today's actual date** — the date in the session context is authoritative. Then:

- **If `docs/MOG_SessionHandoff_<today>.md` already exists, UPDATE it in place.** Don't create a second file for the same day, and don't bump to tomorrow's date to get a unique filename. Append this session's work as a new `## Later session — <topic>` block under the existing content (keep the earlier session's sections intact above it). One handoff file per calendar day.
- **Never invent a future date.** A filename collision is the signal to *update today's file*, not to increment the date. Bumping past today (e.g. writing a 05-28 file when today is 05-26) corrupts the chronology and is the specific mistake this rule exists to prevent.
- A collision with an *older* date (today's file doesn't exist yet, but yesterday's does) is normal — just write today's file.

## Three-file update — all mandatory

1. **Write or update** `docs/MOG_SessionHandoff_<today>.md` per the date discipline above.
2. **Edit** `CLAUDE.md` — point the `@docs/MOG_SessionHandoff_<...>.md` line at today's file. If it already points there (because you updated today's existing file), no change needed — just confirm.
3. **Edit** `docs/MOG_CurrentState.md` — append a row to the "Recent significant changes" table at the bottom; update "Pinned focus" and "Next-session candidates" if material.

Skipping step 2 means the next session loads a stale handoff. Skipping step 3 means CurrentState drifts from reality. All happen in the same session.

## Handoff document spine

Use this structure, in this order:

```markdown
# Session Handoff — <Topic>

**Session date:** YYYY-MM-DD
**Session focus:** <one sentence — what we set out to do>
**Outcome:** <1-3 sentences — what actually shipped, with the key verification result>
**Next session focus:** <one sentence — the most likely next direction>

---

## What shipped

<Itemized list. For each item:
- What changed (file path, function name, behavior)
- Mechanism (commit hash if applicable, deploy.py run, build.py run)
- Why this approach (the one or two sentences that future-you needs to NOT re-litigate)>

## Outstanding (carry forward)

<Deferred items with priority. Include "this thing was started but not finished" items, "we noticed but didn't fix" items, and any verification gates not yet closed.>

## Files touched this chat

<Concrete file list grouped by purpose. Distinguish source edits from generated-file refreshes (build.py output, deploy.py pushes).>

## Commits landed this session

```
<git log --oneline of the new SHAs since session start>
```

## Opening prompt for next session

```
<copy-pasteable 3-5 sentence block:
 - Where things stand
 - 2-3 candidate next directions
 - Pointer to docs/MOG_CurrentState.md for invariants
 - Any session-specific gotcha to surface immediately>
```
```

## Multi-topic sessions

When a session bundled unrelated bodies of work (e.g., consolidation + scaffold setup on 2026-05-24), split the "What shipped" and "Outstanding" sections into `## Section A — <topic>` / `## Section B — <topic>` so future readers don't conflate them. Keep "Files touched" and "Commits landed" merged at the bottom.

## Anti-patterns

- **Don't restate `CLAUDE.md` invariants** in the handoff. Those live in `CLAUDE.md` and `MOG_CurrentState.md`. The handoff is about what's NEW this session.
- **Don't include a play-by-play timeline.** "First I read X, then I edited Y" is noise. Skip to "we changed X from A to B because C."
- **Don't paste tool output.** If `clasp push` printed "10 files pushed to rpr", you say "deployed to rpr via deploy.py, all targets succeeded." Verbose tool transcripts make the doc unscannable.
- **Don't bundle the carry-forward list with the pitched next-session focus.** Carry-forward is "things we didn't finish"; next-session focus is "what we'd start next." A clean handoff distinguishes them.
- **Don't forget the canary-first reminder** when the carry-forward includes a deploy. Future Claude needs the explicit prompt to do a `--target <slug>` test push before fanning out.
- **Don't create a future-dated handoff to dodge a filename collision.** If today's file already exists, update it in place (see Date discipline). Same-day work belongs in the same-day file; a bumped date corrupts the chronology.

## After the handoff lands

1. Confirm `CLAUDE.md`'s @-import line points at the new dated handoff (not the old one).
2. Confirm `docs/MOG_CurrentState.md` has been updated.
3. Suggest a commit. Recommended message: `docs: session handoff YYYY-MM-DD — <one-line topic>`.
4. Provide a copy-pasteable chat name for Sebastian (the conversation often gets labeled by topic — match the handoff's topic).
