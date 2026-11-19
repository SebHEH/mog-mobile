# Working on MOG (for Donny)

MOG is the Master Ordering Guide: the ordering app KMs use on their phones (`sebheh.github.io/mog-mobile/`), the Manage pages they use on a computer, and the Supabase database behind both, which closes each store's day just after midnight and emails the recap through one small Apps Script project (the mail relay). The stores' Google Sheets are retired: frozen in Drive, nothing deployed to them.

You and Sebastian both maintain it. The rules for two people are in [CLAUDE.md](CLAUDE.md), section **Two maintainers**, and Claude reads them at the start of every session. This page covers setup (once), plus the two prompts you paste at the start and end of each session.

## 1. Access (Sebastian sends these)

- [ ] **GitHub:** collaborator invites to `SebHEH/mog-mobile` and `SebHEH/Claude-SKills`. Accept them at <https://github.com/notifications> or from the email.
- [ ] **Supabase:** an invite to the organization **HEH** as **Developer**. It expires after 24 hours.
- [ ] **PINs:** the store and master PINs, from Sebastian through the password manager.
  - Never paste a PIN into a chat.
  - Never sign in at `rprfotest`: it uses rprfo's real PIN.

## 2. Tools

You need Git, Python 3, Node.js 24 or newer, `clasp` (you have it) and Claude Code (<https://claude.com/claude-code>).

Windows (PowerShell):

```powershell
winget install --id Git.Git -e
winget install --id Python.Python.3.12 -e
winget install --id OpenJS.NodeJS.LTS -e
```

Mac (Terminal, with Homebrew):

```bash
brew install git python node
```

Turn on the Apps Script API for your Google account: open <https://script.google.com/home/usersettings> and switch **Google Apps Script API** to On. `clasp` can't push without it.

## 3. Set up Claude

**a. The team skills.** Follow <https://github.com/SebHEH/Claude-SKills/blob/main/ONBOARDING.md>. It installs the shared skills and takes about 15 minutes. Restart Claude Code afterwards.

**b. The repo.** Open Claude Code in any folder and paste:

```
Set me up to work on MOG (https://github.com/SebHEH/mog-mobile), which I maintain with Sebastian:
1. Clone it to Documents/GitHub/mog-mobile in my home folder (git pull instead if it's already
   there). If git asks me to sign in, tell me and wait.
2. Check git, python, node and clasp, and show their versions. For anything missing, give me the
   install command for this computer. On Windows, also check that git config core.autocrlf prints
   true inside the repo; if it doesn't, show me the fix in docs/MOG_ProjectNotes.md (CI and tests).
3. Show which Google account clasp is logged in as.
4. In the repo, run node tests/run_all.js and show me its last line (it should say ALL PASS).
5. Run python deploy.py --relay --dry-run and show me the first lines. It's a preview and
   changes nothing.
6. Add the Supabase connector for this project, read-only:
   claude mcp add --transport http supabase "https://mcp.supabase.com/mcp?project_ref=mnfwqmrstdeuczveyykv&read_only=true"
   Then tell me to finish signing in in the browser, choosing the HEH organization.
7. Read CLAUDE.md (the Two maintainers section) and ONBOARDING.md, and sum up the rules in five
   bullets.
Don't edit files, commit, deploy or run SQL.
```

## 4. Apps Script: nothing to set up

The stores' Sheets were retired in Sheet retirement step 5 (2026-11-20): their web apps are archived and nothing deploys to them, so there is no per-store permission or test deploy. The only Apps Script project left is the mail relay (`mail-relay/`, `python deploy.py --relay`). Deploying it is rare; read CLAUDE.md, Two maintainers, rule 5 first.

## 5. Start of every session: paste this

```
Start a MOG session (I'm Donny):
1. git switch main, then git pull. If I have uncommitted changes or the pull fails, stop and
   tell me.
2. Show me what changed since my last session: git log on main, one line each, newest first, back
   to my last commit. Then git fetch --prune and list the remote branches not merged into main.
3. From docs/MOG_CurrentState.md and the latest handoff, tell me in bullets what's in flight and
   what's next.
4. Ask me what I'm working on today, then create the branch donny/<short-topic> from main.
```

## 6. End of a session: paste this

```
Wrap up my MOG session (I'm Donny):
1. Run node tests/run_all.js and show me its last line.
2. Write the session handoff with the mog-session-handoff skill. Put any lesson for a
   global skill under Process lessons, tagged [→ global proposal], for Sebastian to file.
3. Commit everything on this branch with a clear message, then push it (git push -u origin <branch>).
4. Give me the link to open the pull request:
   https://github.com/SebHEH/mog-mobile/compare/main...<branch>?expand=1
5. List exactly what I deployed and what SQL I ran this session, in the handoff.
```

Sebastian reviews and merges the pull request. GitHub runs the gates on it (`.github/workflows/gates.yml`).

## The rules in short

The full version is in [CLAUDE.md](CLAUDE.md), section **Two maintainers**.

- Pull first. Work on a `donny/<topic>` branch and open a pull request.
- Store folders (`rpr/`, `rprfo/`, …) are generated: never merge them by hand. Re-run `python build.py`.
- **Deploys:** an app change goes live when its pull request merges into `main` (GitHub Pages). The only Apps Script deploy is the mail relay (`python deploy.py --relay`, from an up-to-date copy).
- **SQL:** through the `mog-supabase-schema` skill. Pull first. Claude never writes to the database; you run SQL in the Supabase SQL Editor.
- **Nothing at the stores runs as a person:** Supabase closes every store and sends the recaps; a new store is made in HQ (skill `mog-add-store`).
