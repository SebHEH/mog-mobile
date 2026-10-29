# Working on MOG (for Donny)

MOG is the Master Ordering Guide: the ordering app KMs use on their phones (`sebheh.github.io/mog-mobile/`), the Manage pages they use on a computer, the Supabase database behind both, and the Apps Script inside each store's Google Sheet that closes the day at 3:30 AM and emails the recap.

You and Sebastian both maintain it. The rules for two people are in [CLAUDE.md](CLAUDE.md), section **Two maintainers**, and Claude reads them at the start of every session. This page covers setup (once), plus the two prompts you paste at the start and end of each session.

## 1. Access (Sebastian sends these)

- [ ] **GitHub:** collaborator invites to `SebHEH/mog-mobile` and `SebHEH/Claude-SKills`. Accept them at <https://github.com/notifications> or from the email.
- [ ] **Supabase:** an invite to the organization **HEH** as **Developer**. It expires after 24 hours.
- [ ] **Google:** Editor on the 11 store Sheets, listed in step 4.
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
   install command for this computer.
3. Show which Google account clasp is logged in as.
4. In the repo, run node tests/run_all.js and show me its last line (it should say ALL PASS).
5. Run python deploy.py --dry-run --target rprfo and show me the first lines. It's a preview and
   changes nothing.
6. Add the Supabase connector for this project, read-only:
   claude mcp add --transport http supabase "https://mcp.supabase.com/mcp?project_ref=mnfwqmrstdeuczveyykv&read_only=true"
   Then tell me to finish signing in in the browser, choosing the HEH organization.
7. Read CLAUDE.md (the Two maintainers section) and ONBOARDING.md, and sum up the rules in five
   bullets.
Don't edit files, commit, deploy or run SQL.
```

## 4. Give each store's script your permission (once, before your first deploy)

When you deploy, each store's web app is expected to run as you (`executeAs: USER_DEPLOYING`), so every store's script needs your permission first.

For each row below:

1. Open its **editor** link.
2. In the file list, open **Sync.gs**.
3. In the function dropdown at the top, pick **authorizeSupabase**, then press **Run**.
4. Click **Review permissions**, then pick your HEH Google account.
5. On the permissions list, tick **Select all**, then **Continue** / **Allow**.
6. Check the **Execution log**. It should say `Permission granted. Supabase answered in … ms` and a refusal such as `BAD_SYNC_KEY`. That refusal is expected: the test uses a made-up key.

| Store | Name | Apps Script | Sheet |
|---|---|---|---|
| _template | Master template | [editor](https://script.google.com/d/1uW7k2MLb6-dg-Ovx5wYPQee9y5noBPtBRq5UZksuVG9ghcv5r8Uv-kUO/edit) | [Sheet](https://docs.google.com/spreadsheets/d/1EvXWNiZWc6wR1LK36MLxSTYmARc4n6I5Lfhgoghqiuk/edit) |
| rpr | Roll Play - Rosslyn BOH | [editor](https://script.google.com/d/1FGadbpeTGGsIf2hQEWnjaIZe1wI8_P4RMY8vmWnHFkbjDofIY-cQ538F/edit) | [Sheet](https://docs.google.com/spreadsheets/d/1qWVfV3i50S8yZ771GSCWuVeWzoKM97gJZ9vhWaipk_I/edit) |
| rprfo | Roll Play - Rosslyn FOH (canary) | [editor](https://script.google.com/d/1iHm2I3-NFkEoPcqN4kCnN-mXeMdZfZGlx2xemh1ta1_hCoXBKDM7-otM/edit) | [Sheet](https://docs.google.com/spreadsheets/d/1QDSlXJLG8J91-seF_OY_sIgM-E5nw2P91hJCYQWlemo/edit) |
| rpt | Roll Play - Tysons BOH | [editor](https://script.google.com/d/1VMZFvyfnUm2vUW2mWHssLrHhMS0xG5IUkxPpliBE9EX2yg95sDfWlzkW/edit) | [Sheet](https://docs.google.com/spreadsheets/d/18pfUWtbIQnIPa9L65JViI3fqI1igfxkoIseWkt2lDTs/edit) |
| rptfo | Roll Play - Tysons FOH | [editor](https://script.google.com/d/1LieGgJhLxoOlp0bEbbFqfjcMwpCGkRptBX1em8-dfavmTclB02pmmmTE/edit) | [Sheet](https://docs.google.com/spreadsheets/d/1AKFXXmlau64zVzkXQhW4lnVQWPDaxsBXHCoS_Ir7j7g/edit) |
| rpfr | Roll Play - Founders BOH | [editor](https://script.google.com/d/1qZIWafAt3x1qfg9uG9XlZZjU-nGEwIdoNeg4yRfKVZ9FJzDIOWJqwVv1/edit) | [Sheet](https://docs.google.com/spreadsheets/d/1SSyzTiAGx9A9iFFF5gh6oj_l6i9ApxXULVzer5inZEI/edit) |
| rpfrf | Roll Play - Founders FOH | [editor](https://script.google.com/d/1_CjSGM_AHTKG1BcjJ70sckRVu7QODSNvFLr0bRTc8SoDN6Iz-npDRA04/edit) | [Sheet](https://docs.google.com/spreadsheets/d/1E2rMup4fzuN4MEquTmRz4-B9Xa5Lj0t4OE8tD4MFQ-U/edit) |
| tnyt | Teas'n You - Tysons BOH | [editor](https://script.google.com/d/1bqgHCSMUDUfPSgzgTQg-4yZYU04b51_khWU4ZPP1rD9bvMURmecc81Hb/edit) | [Sheet](https://docs.google.com/spreadsheets/d/1X-mIjbzp_CEABnBW6ju3jtlMmFoJR78RLuHCFKLbFm8/edit) |
| tnytf | Teas'n You - Tysons FOH | [editor](https://script.google.com/d/1j0YLDMlgpdVo_bs9enKzZtvJwmNOrCIZdv6rxWsPv6qPJGU9oODzPOPE/edit) | [Sheet](https://docs.google.com/spreadsheets/d/1youedz_JpcQaNIfijCVPczlcfK9w6EyuGuOnfINGERg/edit) |
| tnyr | Teas'n You - Rockville BOH | [editor](https://script.google.com/d/1rtT6s4QekDEj-Vfrliw6hCd9wgNbw6vZdymMXjV57J3l5vPcjsrEQhBr/edit) | [Sheet](https://docs.google.com/spreadsheets/d/1dgXIoEeiPqsa6h-0FzhQuxxStyLDR3EfVrO4f0w0V0c/edit) |
| tnyrf | Teas'n You - Rockville FOH | [editor](https://script.google.com/d/1KdaVREgsjHs0NzGGTj81PbEWrK3yYIaHPj1ykblXg3RKXP6oty-0Bg3l/edit) | [Sheet](https://docs.google.com/spreadsheets/d/1tbAjG-GEx0urflttemvnygDRsYN1B_0uZ-9CzSEO7ig/edit) |

Running `authorizeSupabase` reads nothing and changes nothing in the store. It only grants the permissions and makes one test call that Supabase refuses.

## 5. Your first deploy: one store, as a test

Do this once, after step 4 and after telling Sebastian:

1. Run `python deploy.py --redeploy --target rprfo`.
2. Ask Claude: *"Probe rprfo's /exec the way mog-exec-repoint does."* The GET and the POST should both answer.
3. If anything fails, tell Sebastian. He puts rprfo back on his account by running the same command from his computer.
4. If it works, tell Sebastian, and add a line to [docs/MOG_ProjectNotes.md](docs/MOG_ProjectNotes.md) under *Deploys and rollout*: "A redeploy by Donny works (tested on rprfo, <date>)".

## 6. Start of every session: paste this

```
Start a MOG session (I'm Donny):
1. git switch main, then git pull. If I have uncommitted changes or the pull fails, stop and
   tell me.
2. Show me what changed since my last session: git log on main, one line each, newest first, back
   to my last commit. Then git fetch --prune and list the remote branches not merged into main.
3. From docs/MOG_CurrentState.md and the latest handoff, tell me in bullets what's in flight and
   what's next.
4. Ask me what I'm working on today, then create the branch donny/<short-topic> from main.
Remind me to tell Sebastian before I deploy to every store or run SQL in Supabase.
```

## 7. End of a session: paste this

```
Wrap up my MOG session (I'm Donny):
1. Run node tests/run_all.js and show me its last line.
2. Write the session handoff with the mog-session-handoff skill, Author: Donny. Put any lesson for a
   global skill under Process lessons, tagged [→ global proposal], for Sebastian to file.
3. Commit everything on this branch with a clear message, then push it (git push -u origin <branch>).
4. Give me the link to open the pull request:
   https://github.com/SebHEH/mog-mobile/compare/main...<branch>?expand=1
5. List exactly what I deployed and what SQL I ran this session, so I can tell Sebastian.
```

Sebastian reviews and merges the pull request. GitHub runs the gates on it (`.github/workflows/gates.yml`).

## The rules in short

The full version is in [CLAUDE.md](CLAUDE.md), section **Two maintainers**.

- Pull first. Work on a `donny/<topic>` branch and open a pull request.
- Store folders (`rpr/`, `rprfo/`, …) are generated: never merge them by hand. Re-run `python build.py`.
- **Deploys:**
  - A canary (`--target rprfo`) can run from your branch.
  - A deploy to every store runs from an up-to-date `main` (`deploy.py` refuses otherwise).
  - Tell Sebastian first.
- **SQL:** through the `mog-supabase-schema` skill. Pull first, and tell Sebastian which `schema_vN` number you're taking. Claude never writes to the database; you run SQL in the Supabase SQL Editor.
- **Agree with Sebastian first** before you onboard a store, run *Move this store to Supabase*, or reinstall a trigger. Whoever does it ends up owning that store's 3:30 AM close and sending its recap email.
