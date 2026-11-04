---
name: install
description: Sets a repo up for Abe in the Abe chat, part by part, until `abe install check --all` passes. Use when the person invokes /abe:install (`abe install` and `:install` say it while the install is not Done).
---

# Install

**The goal**: every required part passes. `abe install check --all` says so; the install is Done then, and not before.

This skill is your guide, not a script. The person is here for the whole install, and you work like their own Claude Code, with no sandbox: you read and edit the repo, write `abe.yaml` and the files in `.abe/`, and run any command. Whatever the person asks, you do yourself: add an MCP server and start its sign-in, edit an env file, add a check.

## The parts

| Part        | Required | Set up means                                                                                                                                                      | Load                                 |
| ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `logins`    | yes      | every tool the repo needs answers, and reads GitHub and the cloud live                                                                                            | [logins](references/logins.md)       |
| `board`     | yes      | `abe.yaml` names a board that reads live, where cards run, who merges, when a card is Done, where specs go                                                        | [board](references/board.md)         |
| `sources`   | no       | each source found is added and reads, or is skipped                                                                                                               | [sources](references/sources.md)     |
| `env-files` | yes      | the three Abe env files exist; each environment has an aws profile or none                                                                                        | [env-files](references/env-files.md) |
| `worktree`  | yes      | `abe.yaml`'s `worktree:` gives a new worktree what the main checkout has that git doesn't (env files the app and tests read), and its script passes               | [worktree](references/worktree.md)   |
| `checks`    | yes      | every check in `checks:` passes as serve runs it, in the checks env you judged                                                                                    | [checks](references/checks.md)       |
| `workflows` | yes      | `abe/` holds the repo's workflows and Abe's skills, copied in from Abe once                                                                                       | [workflows](references/workflows.md) |
| `skills`    | yes      | the repo's testing skill and `CLAUDE.md` (with its `## Find out before you ask`) are written                                                                      | [skills](references/skills.md)       |
| `verify`    | yes      | the app runs locally through the gate (or can't run here), a read-only `query` script when it has a database, the Verification pack proves a feature, checks pass | [verify](references/verify.md)       |
| `prototype` | no       | `abe/scripts/prototype-start` starts the app on `$ABE_PORT_BASE` with its env file, signed in, and its check passes step by step (or nothing runs here)           | [prototype](references/prototype.md) |
| `done`      | yes      | every required part passes; its line names the files for the person to commit                                                                                     | [done](references/done.md)           |

Load a part's reference before you work on it. [read](references/read.md) says what Read found and how to read the repo: load it at the start.

## Start and come back

Read `abe install status --json` first, every time this skill is invoked: it may be a new install, one half done, or one Done before.

- **A join** (`join: true`): the repo has a teammate's `abe.yaml`. Do only the person's own parts (logins, env files, each source's sign-in, each environment's aws profile); a team part that fails is a warning for the team, not yours to fix unless the person asks.
- **Done before**: check every part again, change only what is stale, and ask about anything new (a new CI job).
- **Half done**: go on from the first part that does not pass.

Ask in rounds with AskUserQuestion. Turn prod on for agents only after a question of its own, and only once the person said yes.

## Where things go

- **`abe.yaml`** at the repo root is the team's: the board, where cards run, who merges, when a card is Done, specs, environments, checks, setup, the worktree recipe (`worktree:`, its script the `worktree-setup` hook), the hook points (`hooks:`, below), and `sources:` (the team's MCP servers, added with `abe install source`). **`abe/`** holds the repo's workflows (`abe/workflows/<id>.yaml`) and Abe's skills (`abe/skills/`), copied in once by the workflows part, and its scripts for Abe (`abe/scripts/`: the worktree recipe's, a prototype's start). **`.claude/skills/`** holds the repo's own skills, the app's scripts (`run-app`) and the Verification pack. Write both as ordinary changes: never commit them and never exclude them. The person reviews them in `git diff`, commits and pushes.
- **Hook points** (ADR 0035): Abe calls each of these by its role, never by its path: the scripts `start`, `stop`, `seed`, `db`, `query` (in `.claude/skills/run-app/scripts/`), `prototype-start`, `prototype-stop` (in `abe/scripts/`) and `worktree-setup`, the skills `run-app`, `testing` (`<app>-testing`) and `verify` (`verify-<app>`), and the headings `find-out` (`CLAUDE.md`'s `## Find out before you ask`) and `read-data` (run-app's `## Read data`). Those places are the defaults: write there. A repo that already has such a script or skill elsewhere declares its path in `abe.yaml`'s `hooks:` (`hooks: { start: scripts/dev-up }`) instead of moving it; the checks then read the declared one. What a session's `abe run` may run is read from the committed `abe.yaml`, so a declared path takes effect there once the person commits it.
- **`.abe/`** is the person's alone, always kept out of git: `.abe/abe.<env>.env` and `.abe/settings.local.yaml` (their logins per tool, each environment's aws profile, their overrides).
- Edit a settings file in place, keeping every key already there, then run `abe settings check .`.

## How to work

1. **Start from the status**: `abe install status --json`. It holds the repo, `join`, and each part's `state` (`pass`, `warn`, `fail`, `todo`) with its `line`: what passed, or what is missing and the fix.
2. **Read in a subagent.** Hand the repo reading to a subagent (Claude Code's Agent tool) with [read](references/read.md), and keep its short report. The main chat talks to the person and coordinates; the heavy work runs in subagents: Read, `env-map` ([env-files](references/env-files.md)), fixing a failing check ([checks](references/checks.md)), and the Verification pack ([verify](references/verify.md)), started in the background as soon as the app runs locally. A subagent never asks the person: it reports back, and you ask.
3. **Ask the up-front round** (below), then work the parts.
4. **Pick the order yourself.** The table's order is the default: logins before anything remote, the board before the sources, checks and skills before the app runs. Change it when the repo says so; while a part waits on the person or a subagent, do another.
5. **After each part, check it**: `abe install check <part>`. Exit 0 is a pass (or a warning). On a fail, do what its `line` says and check it again.
6. **Come back to any part** whenever something changes it: a new board, a new check, an env key. Fix it and check it again; the other parts keep their state.
7. When every required part passes, run `abe install check --all` once more and give the person `done`'s line: the install is Done, and these are the files to commit.

## Asking the person

**The up-front round.** Once Read reported, ask what the repo can't settle, in `AskUserQuestion` rounds of up to 4 questions: where the board is, where cards run, who merges and when a card is Done, where specs go ([board](references/board.md)); each environment's aws profile ([logins](references/logins.md)); which sources to add ([sources](references/sources.md)). Leave out what a file already settles.

- **Preselect from evidence.** The answer Read or a file points to goes first, marked recommended, with where it was seen.
- **Every question offers "Not sure: find out".** On that answer, search the team's sources read-only (Slack, the wiki, the board: the MCP servers this session has) for the answer, and later ask it again on its own, with what you found first and its source cited (`#team-dev, 2 Oct: "prod deploys from main"`).
- **After the round, one question at a time**, as the work raises it.
- Ask only with `AskUserQuestion`; a question in prose has no answer buttons.

## What needs the person

- **A login in their browser or terminal.** Give the exact command, prefixed with `!` so they run it in this chat: `! gh auth login --web`, or the `fix` a check's line names. Then check it again yourself.
- **Prod for agents.** Turning prod on for agents gives every agent session the prod env file and its aws profile. Do it only when the person asks, and only after a confirm question that says so (`AskUserQuestion`: **Keep prod off** first, then **Turn prod on for agents**); then run `abe settings set agents.prod true`.

Everything else you do yourself: write the settings, edit the env files, run the install commands, start Docker, install the lockfile's dependencies.

## Join

When the status says `join: true`, the repo already has a teammate's `abe.yaml`: do only the person's own parts. Their logins, their env files, each environment's aws profile, and their MCP sign-ins for the sources `abe.yaml` names. Ask only those. A team part that fails (the board, a check, the pack) is a warning: tell the person in one line and leave it to the team, unless they ask you to fix it.

## Rules

- **Key names only.** You may read every env file, values included. Never print, quote, copy into chat or commit a value; say key names.
- **Write only what you checked.** A fact goes in a file only once you looked in the repo; a cause you did not confirm is written as unknown ("why: not known").
- **Session-only words stay out of the files.** A limit the person gave for this session ("don't touch Y") limits you now; write it into a file only when they say to keep it.

## Resume

- **Not Done**: `:install` reopens this same chat. Read `abe install status --json`, say in one line where it stands (`5 of 7 pass; checks fails: lint needs the dev env file's API_URL`), and go on from there.
- **Done**: `:install` opens a new chat seeded from the status. Say in one line that the install is Done and what changed since (a part now failing), then do what the person asks.
