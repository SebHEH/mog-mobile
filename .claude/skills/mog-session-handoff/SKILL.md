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

## Run the handoff BEFORE the session's commit — not after

Write the handoff (all three files) **before** committing and pushing the session's actual work, so the doc edits — the new/updated `docs/MOG_SessionHandoff_<today>.md`, the `CLAUDE.md` @-import bump, and the `docs/MOG_CurrentState.md` row — **ride in the same commit** as the code/config. Running it after means a second `docs:` commit (and a second push) for work that was already done — double the ceremony for one session.

So the close-out order is:
1. Verify the session's work (build/deploy/preview as applicable).
2. **Run this skill** — produce the handoff + update `CLAUDE.md` + `CurrentState`.
3. Suggest ONE commit covering code + docs together, then push.

The exception is when the session **already** committed + pushed mid-way (e.g. a canary that had to go out before the work was done). Then the handoff is necessarily a follow-up `docs:` commit — that's fine; the rule is "don't commit the *final* work without the handoff," not "never commit twice." When in doubt, hold the commit until the handoff is written.

## Gather the facts deterministically first

Before naming the file or assembling the commit list, run the fact-gather — it removes the two mechanical lookups (today's date + whether today's file exists) and the recurring future-date mistake along with them:

```
python .claude/skills/mog-session-handoff/scripts/handoff_facts.py
```

It prints today's date in filename form, the binary **UPDATE-IN-PLACE vs CREATE-NEW** decision (a script can't be tempted to bump the date to dodge a collision — that's the whole point), the commits not yet on `origin/main` (your "Commits landed this session" block), and any uncommitted changes (so the handoff doesn't claim work shipped that's still dirty). It's read-only and never commits. Use its output as the factual spine; spend your judgment on the prose.

## Date discipline (the script makes this call — this is the why)

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
3. Suggest a commit. **If the session's code/config is still uncommitted (the normal case — see "Run the handoff BEFORE the session's commit"), suggest ONE commit covering code + docs together**, using the feature's message (e.g. `feat(hub): …`); the handoff docs ride along, no separate `docs:` commit. Only when the work was already committed/pushed mid-session does the handoff get its own follow-up commit: `docs: session handoff YYYY-MM-DD — <one-line topic>`.
4. Provide a copy-pasteable chat name for Sebastian. **Match the established naming pattern of his existing MOG chat list:**
    - Prefix: `MOG:` (sometimes `MOG —`, but `MOG:` is the dominant form).
    - Length: short — **~4-6 words after the prefix**, no more. The sidebar truncates aggressively; a name that's already short reads well truncated. Date prefixes (e.g. `2026-05-28 —`), comma-joined lists of every shipped item, and "kitchen-sink summary" framings are wrong here — they read as foreign next to peers like `MOG: PWA fixes + ManageVendors picker` or `MOG: ManageVendors edit form`.
    - Topic choice: pick the **dominant one or two themes** of the session (joined with `+` when two). On a multi-topic session, the rule is **biggest new feature** + (optionally) the second-biggest concrete deliverable — NOT every shipped item.
    - Examples that fit the pattern (real ones from prior sessions): `MOG: chunked History`, `MOG: Recalibrate Vendor + StorageAreas draft`, `MOG: PWA audit + background-refresh gate`, `MOG: ManageItems multi-vendor`.
    - **Always present it in a fenced code block** so Sebastian can copy it directly, the same way suggested commits are presented — never inline prose.
5. Also surface the **"Opening prompt for next session"** block in the chat wrap-up as its own fenced code block (not just buried in the handoff doc), so Sebastian can copy it straight into the next session. Both the chat name and the opening prompt should be copy-pasteable code blocks in the final message.
