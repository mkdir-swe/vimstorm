# 0033 · Workflows are files, read in the Editor

Status: accepted, 29 Oct 2026. Supersedes ADR 0031's place for the team's workflows (`workflows:` in `abe.yaml`), and ADR 0030's built-in Layer as something a repo runs at runtime.  Amended by ADR 0034: per file, a copy wins and a deleted copy is off (no fallback to core's), and each skill's Abe commands stay Abe's (`PROTOCOL.md`).

The `:workflows` page drew every workflow in force as a swimlane, with its own chat to change them. That could not hold:
- It was not clear. All workflows open at once, left to right, and no YAML to see.
- It was a page of its own, away from the code. The workflows are the repo's: they belong where the repo is read.
- The team's workflows were map entries in `abe.yaml`, so a workflow had no file to open, diff or review on its own.
- Abe's own workflows and skills were read-only built-ins the repo could not change, only shadow.

**Workflows are files in the repo.**
- The team's: `abe/workflows/<id>.yaml`, one file each, the id its name. Ordinary files like `abe.yaml`: Abe never commits them and never excludes them.
- Yours: `.abe/workflows/<id>.local.yaml` in the main checkout, as before. Of one id, yours wins.
- `workflows:` in `abe.yaml` is no longer read. The load check says each one `moved to abe/workflows/<id>.yaml`. No migration: installs are reset.

**Abe's are copied in, and the repo owns them.**
- The install's Workflows part (required) copies Abe's workflows into `abe/workflows/` and Abe's skills into `abe/skills/<name>/`, with `abe/installed.json` recording what was copied and each file's hash.
- A repo that has `abe/` already (a teammate's) gets nothing copied.
- From then on Abe's own do not load: only the repo's files do. A repo not installed yet still runs Abe's own.
- Sessions load `abe/skills/` as the `abe` plugin: each skill there replaces core's of that name, so `/abe:<name>` runs the repo's copy. The Abe chat's guide (`abe`) and the run's driver (`factory`) say how this Abe's own CLI works: they stay core's, never copied nor replaced. The repo's own Claude Code skills stay in `.claude/skills/`.
- A newer Abe never writes over them. The Workflows part says `Abe x.y has newer <names>`; the Abe chat shows the diff and applies it when asked.

**They are read in the Editor.**
- In the main checkout the Project tree shows `abe/` first, with Abe's head. Each workflow file carries a dim tag: whose it is and what it takes, red while it fails the load check. `:workflows` opens the tree there.
- A workflow file opens with its preview on the right, like markdown's: one card per step, top to bottom, the loops as brackets, gates and ways out marked, the caret's step ringed. Abe decides the words and hues (`abe workflow read`'s `preview`); the app draws them.
- The load check runs on the file. Its problems show at their lines, and on the preview.
- ⌘B on a step goes to its skill's `SKILL.md`; ⌘B in a `SKILL.md` lists the steps that run it.
- A change in words is the Abe chat's: it edits the files.

Considered:
- **Keep the page, redraw it vertically.** Still a page away from the code, and still no file to open.
- **Keep Abe's as read-only built-ins.** The repo could not change the skills its runs depend on, and a copy to change them hid the original.
- **Copy Abe's into `.claude/skills/`.** They would mix with the repo's own skills, and Claude Code would load them twice, once as the repo's and once as the plugin's.

Hard to reverse: once installed, a repo's runs depend on its own copies. Going back means loading the built-ins again over files the team may have changed.

Amended 1 Nov 2026: migration removed: no install predates it (`workflows:` in `abe.yaml` said moved: it is an unknown setting now).
