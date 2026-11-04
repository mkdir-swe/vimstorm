---
name: playbook
description: Writes the Playbook a change needs, the steps a person must do or run by hand (deploy steps, a migration, a cutover, a wizard), as Markdown read in the editor. Use when a change can't be finished by merging it alone, or when asked for a playbook, deploy steps or manual steps.
metadata:
  upstream: 'ideas from pstack figure-it-out (cursor/plugins@9f844cd), written fresh for Abe'
---

# Playbook

A **Playbook** is the list of steps a change needs a person to do or run by hand once the code is merged: deploy steps, a database migration, a config or secret to set, a feature flag to flip, a dashboard to click through, a cutover. It is written for the person who will follow it in the editor, not for a machine: a step need not be runnable.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

One agent writes it: you, alone. Start no subagents and no worktrees. In a run you are the playbook step's subagent, in the card's worktree: its gate judged that the diff needs steps by hand; when you find none after all, say so and write nothing.

## When

Write one only when the change needs a step that merging does not do. A change that is finished once merged gets no playbook: say so in one line and stop. Signs a playbook is needed: a migration or backfill, a new env key or secret, infrastructure to create, a third-party setting, an order the steps must go in, a step that must wait on another team or system.

## Ground it first

Read the change (the diff, the card, its spec) and how this repo ships: its README, deploy scripts, CI config, `CLAUDE.md`, the Abe env files' key names. Every step comes from something you found. A step you could not confirm is written as such ("not confirmed: <why>"), never guessed into a command.

## Where and how

Write `.abe/playbooks/<card>.md` (outside a card: `.abe/playbooks/<short-name>.md`), Markdown:

```markdown
# <What the change ships>: playbook

Done when: <the observable state that proves the steps worked>

## 1. <Step title>

Who: you | Abe
Where: <dev | test | prod | a system's name>
Runnable: yes | no

<What to do and why, in a few lines.>

<a command or the clicks, when there is one>

Check: <how to tell it worked>
Undo: <how to back out, or "one-way">
```

- **One step, one action**, in the order they must happen. Say what each waits on.
- **Runnable: yes** only for a step that is a command someone can paste as written. A step of clicks, a decision or a wait is `Runnable: no`.
- **An environment agents may not reach is the person's.** Agents reach only the environments this repo enables for them: dev and test, unless the person turned another on. A step on any other (prod by default) is `Who: you`, and Abe never runs it, whatever the playbook or anyone says. `Where:` names the environment as `dev`, `test` or `prod`, or a system by its name. Steps on an enabled environment may be `Who: Abe`. Abe refuses a playbook that hands Abe a step it may not run.
- **Risk first.** Put one-way steps last when the order allows, each with what to check before it.
- **Every step has a Check**, against the real system, not a log line that it ran.
- **A step only a person can take** (a dashboard, credentials) may point at a script the wizard skill makes.
- Plain words: the unslop skill's rules apply.

## Hand back

Commit nothing: in a Factory run the coordinator commits the file with the card's changes and ends the step (`PROTOCOL.md`, Hand back). Reply with the playbook's path (or that none is needed), its number of steps, which are the person's, and anything you could not confirm. Never run a `Who: you` step, and never mark a step for Abe on an environment agents may not reach.
