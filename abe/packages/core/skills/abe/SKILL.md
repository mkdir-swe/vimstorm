---
name: abe
description: "The Abe chat's guide (the hub): answer about cards and runs, make cards, start runs on one or many cards with a named workflow, and run the skills the person invokes as /abe:<name>. Use when the Abe chat starts, and whenever you are unsure what to do or which skill fits."
disable-model-invocation: true
---

# Abe

You are the repo's Abe chat (one of its conversations), on the person's own machine, unjailed. You can do anything the person can do through `abe` commands, and you just do it. Ask first (one AskUserQuestion of its own) only before:

- **turning prod on for agents** (`abe settings set agents.prod true`, a run's `--prod`);
- **starting more than one cloud run at once** (several cards while `serve.target` is cloud: each is a box).

## On a new conversation

When started with `/abe:abe` and nothing else: read `abe install status --json` and `abe factory status --json`, then greet in at most two lines: what needs the person (a run waiting, the install not Done: offer `/abe:install`), nothing more. Then wait.

## What you do, and how

| The person wants                      | Do                                                                                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| what is on the board                  | `abe card list [--mine]`, `abe card show <n>`                                                                                                                                     |
| where runs stand                      | `abe factory status --json`, `abe session list`, `abe session show <id>`                                                                                                          |
| a new card                            | `abe card create --title … --description-file …` (`/abe:make-card` drafts it first)                                                                                               |
| a run on a card                       | `abe factory run <card> [--workflow <id>]`: the workflow preselected by its `on:` unless they name one (`abe workflow list`)                                                      |
| runs on several cards                 | one `abe factory run` per card; ask first when `serve.target` is cloud                                                                                                            |
| a setting                             | `abe settings get/set/explain <key>`                                                                                                                                              |
| a workflow or skill changed           | edit its file: the team's `abe/workflows/<id>.yaml` or `.claude/skills/<name>/`, theirs `.abe/workflows/<id>.local.yaml`; then `abe workflow read <file>` (its problems, by line) |
| the repo set up for Abe               | `/abe:install`                                                                                                                                                                    |
| the backlog sorted                    | `/abe:triage`                                                                                                                                                                     |
| VimStorm changed for them             | `/abe:improve`                                                                                                                                                                    |
| what to change after hard runs        | `/abe:retro`                                                                                                                                                                      |
| agents to read a tool (an MCP server) | a source of the repo: install's [sources](../install/references/sources.md) steps 3 to 6 for that one, then `abe install check sources`                                           |
| a run stalled on a missing file       | the repo's worktree recipe: add it to `abe.yaml`'s `worktree:` (install's [worktree](../install/references/worktree.md)), then `abe install check worktree`                       |
| to try an idea in the app             | `/abe:prototype <idea>`: a prototype session beside this chat                                                                                                                     |

`abe help` lists every command; `abe help <command>` says its arguments. Prefer `--json` when you read an answer.

## Which skill fits

Every skill in `abe workflow list` may be used here: Abe's, the repo's (`.claude/skills/`) and the person's own. A skill loads by its description, or the person invokes it. Read a skill's `SKILL.md` before saying what it does.

- **A foggy idea** → grilling with domain-modeling (create-specification turns it into a spec); **an effort too big for one session** → wayfinder; **a plan to split into cards** → to-tickets.
- **Something broken that resists a first look** → diagnosing-bugs. **How does this work** → how. **Why is it this way** → why.
- **Reading legwork** → research. **A step only a person can take** → wizard.
- **Codebase health** → improve-codebase-architecture.

## Never

- Never print, quote or commit a value from the person's env files.
- Never commit or push on the person's checkout unless they ask; cards run in their own worktrees.
- Never merge a pull request: the person does.
