# 0030 · Settings live in the repo

Status: accepted, 28 Oct 2026. Supersedes ADR 0011's Layer list (org, team), ADR 0025's `checkouts:` blocks and the settings parts of ADR 0010 (org-only environments, write reach from the org or a team) and of ADR 0027 and 0029 where they say "your own Layer's block for the checkout".

Settings came from six Layers: core, feel, org, team, repo and yours. That could not hold:
- One person works in two worlds on one Mac: a personal demo org and a work org. The org and team files the IDE read were one world's, so the other world's repos read them too.
- The org and team files were read by the IDE from a checkout of the org's repo (`org.dir`, `team`). A stale or missing checkout changed what every repo got, and only on that Mac.
- A factory value in your machine-wide file (`~/.config/abe/settings.yaml`), such as a board, a model or a check, applied to every repo on the Mac. ADR 0025's `checkouts:` blocks patched that for a few keys only.

**The IDE never reads org- or team-level settings.** Orgs help teams set up their factories outside the IDE (infrastructure, logins, boxes). What a repo's agents do is in the repo.

**Layers: core, repo, yours.** Core is built in, with the Feel's bundle as its own step (`feel`) after it. A lower Layer adds to the ones above; it lowers one only by an Override, with its reason.

**Three files.**
- **The repo's**: `.abe/settings.yaml` in the checkout. Committed when the install is Connected. Kept out of git by Abe's `info/exclude` block when it is Just this Mac.
- **Yours for this repo**: `.abe/settings.local.yaml` in the main checkout. Never tracked: it is always in Abe's `info/exclude` block. Every card worktree and linked worktree of the repo reads the main checkout's.
- **Yours on this Mac**: `~/.config/abe/settings.yaml` (`$ABE_CONFIG_DIR`). Editor preferences and your environment only.

**Which settings live where.**
- Editor preferences and your environment are read only from yours on this Mac: `ui.feel` and its switches, theme, fonts, keys, tree, tabs, chat, `role`, `views`, local mode, Improve's own settings, `serve.target` (superseded in 3.2.2, below), `box.region`, `box.owner`, `box.idleMinutes`, `box.waitingMinutes` and `stores.*`. The box's idle and waiting stops are the box's, not a repo's: a cloud launch hands your file on this Mac to the box, which reads them without a checkout.
- `box.profile` may be set in either of yours. This repo's wins.
- **Superseded in 3.2.2:** `serve.target` is per repo: `.abe/settings.local.yaml` over the repo's `abe.yaml` over yours on this Mac. A plain `abe settings set serve.target` in a checkout writes `settings.local.yaml`; outside one, yours on this Mac.
- Factory and agent settings are read from the repo's file and yours for this repo, yours over the repo's: `board`, `checks`, `testFiles`, `sources`, `setup`, `spec.where`, `logins`, `reach`, `environments`, `limits.*`, `box.size`, `models.*`, `effort`, `allowedModels`, `autoMerge`, `factory.done`, `session.mcp`, `launch.notes`, browser profiles and the rest. A factory value in `~/.config/abe/settings.yaml` is not read.
- Yours for this repo alone, only in `settings.local.yaml`: `github.account`, `githubIdentity`, `credentials`, `testWrites`, `agents.dev`, `agents.test`, `agents.prod` and `board.azureConfigDir`.

**Refusals.** Each says why.
- The repo's file setting one of yours alone is refused. A shared file naming a login, a profile or a folder would apply to everyone who clones the repo.
- `agents.*` in the repo's file is refused, an Override there too. Only the person turns an environment on for agents (ADR 0029).
- `environments` and `reach` are repo settings. A write Reach name is granted only by an Override in the repo's file, never by yours. A write to prod is never granted (ADR 0029).
- An Override needs its reason, in the repo's file or yours. It keeps its reason and since when, as before (ADR 0010).

**Retired.** `team`, `org.dir` (and `$ABE_ORG_DIR`), `budget.email`, `budget.monthlyUsd`, and your Layer's `checkouts:` blocks (ADR 0025): their values move into each repo's `settings.local.yaml`. Org and team skill and workflow places are dropped: skills and workflows are core's, the repo's `.abe/skills/` and `.abe/workflows/`, and yours in `~/.config/abe`. Claude Code's `~/.claude/skills` stays Claude Code's. Propose to team is removed; Improve proposes to yours or to the repo.

**Migration, once per installed repo.** On the first read of a checkout whose main checkout has `.abe/` and no `.abe/settings.local.yaml`:
- What it read before from your machine-wide file (its factory values, and its `checkouts:` block for that checkout) is written into `settings.local.yaml`.
- What came from the org's and team's files, as last read on this Mac, is written into `.abe/settings.yaml` where it changed the value in force.
- `~/.config/abe/settings.yaml` is never written or replaced, only read.
- After that the old files are not read again. `settings.local.yaml` existing marks it done.

**CLI.**
- `abe settings set <key> <value> --repo` writes the repo's file; `--mine` writes `settings.local.yaml`. `--here` stays as an alias of `--mine`.
- With neither, an editor or environment key goes to `~/.config/abe/settings.yaml` and a factory key to `--mine`.
- `abe settings unset <key> --repo|--mine` takes the entry out.
- `abe settings propose` proposes to the repo only: a pull request on its `.abe/settings.yaml`.
- Settings shows each factory setting's source as Repo or Yours, built-in when neither file sets it.

Considered:
- **Keep the org and team files, read-only.** The IDE would still read another world's files, and still from a checkout that can be stale. Read-only does not fix either.
- **One file per repo with a `people:` block.** Everyone's values in one tracked file: a login or a profile is then public to the repo, and every change is a pull request.
- **Per-checkout blocks as before (ADR 0025).** They cover a few keys. Every factory key would need one, and the values would still live outside the repo they belong to.

Hard to reverse: the migration writes each installed repo's files once and then stops reading the old ones. Going back means reading the old files again, and every value set since then is only in the repo's files.

Amended 28 Oct 2026: your card workflows are `.abe/workflows/<id>.local.yaml` beside the repo's in the main checkout, never tracked (Abe's `info/exclude` block holds `.abe/workflows/*.local.yaml`), no longer `~/.config/abe/workflows/`. Of one id the nearest wins: yours, the repo's, Abe's. Your skills stay in `~/.config/abe/skills/`.

Superseded in part by ADR 0031, 28 Oct 2026: the repo's file is `abe.yaml` at the repo's root, not `.abe/settings.yaml`, and the repo's skills are `.claude/skills/`, not `.abe/skills/`; Abe never commits them nor keeps them out of git. `.abe/` is yours alone, always kept out of git. An old `.abe/settings.yaml` is not read.

Superseded in part by ADR 0033, 29 Oct 2026: Abe's workflows and skills are copied into the repo's `abe/` by the install and are the repo's from then on; Abe's own load only in a repo not installed yet.

Amended 1 Nov 2026: migration removed: no install predates it (the one-time settings move, the retired keys `team`, `org.dir`, `$ABE_ORG_DIR` and `checkouts:` read without a problem).
