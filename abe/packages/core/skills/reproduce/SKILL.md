---
name: reproduce
description: Reproduces a bug before it is fixed, on the merge base (Before), with the steps verify will use to show it gone, and records the result with Abe. One that does not reproduce ends the run with a cited report on its Run page. Use at a Bug run's reproduce step, or when asked to reproduce a bug.
---

# Reproduce

A bug is fixed only once it is seen. This step shows it on today's code, the merge base of the card branch and the default branch, before anything is built: the **Before**. The steps you use here are the ones verify runs on the branch after the fix (the **After**), so write them so they can be run again.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

## 1. Plan the steps

Read the card (`PROTOCOL.md`, Plan the steps): its repro steps, expected and actual result, its environment. When the bug lives in data (a record shown wrong, a total off, a state the card names), find the rows it happens to first with the repo's data route (the `run-app` skill's scripts, such as its `query` against test; `CLAUDE.md`'s **Find out before you ask** names this repo's), and errors and traces in the team's sources (its MCP servers). The steps then drive those rows. Read the repo's **Verification pack** (`.claude/skills/verify-<app>/`, its Feature map) for how to launch and drive the app, as the verify skill's **Plan the steps** says. Write the steps to `.scratch/<card>/verify-steps.md`: one numbered step per thing the card says is wrong, each with what is done and the result that shows the bug.

A bug only a test can show: the steps are a test that fails on the merge base.

- **Never skip reproduction** while a data route exists, and never offer to "build on the likely cause" instead: find the data, then drive it. With no route to the data the bug needs, reproduce what a test can, and say in the report which `run-app` script the repo lacks (a read-only `query` for its database, a seed) for the person to add.
- **Prod data.** When the bug shows only in prod's data and prod is on for this run, find its rows there through the data route against prod, read-only (`PROTOCOL.md`, Plan the steps), then reproduce on test with rows like those (or a test). When prod is off, do the same from test and write in the report the prod query that would confirm it. Never ask for prod access.

## 2. Reproduce on the merge base

Make a worktree at the merge base through Abe (`PROTOCOL.md`, Reproduce on the merge base). In that worktree, launch the app the way the pack's Launch says, through Abe's runner (the verify skill's **Driving the app**), and drive the steps exactly as written. A bug that shows in the app is also looked for with the session's browser (your `chrome-devtools` tools): a not reproduced while it never ran is recorded as inconclusive, not as the bug's verdict. Save each step's Evidence under `.scratch/<card>/verify/evidence/<feature>/before-*` in the card's worktree (absolute paths). Clean up the way the pack says (its stop).

## 3. Write the report

Write `.scratch/<card>/verify-before.md`. When the bug did not reproduce it is the report the card gets, so write it for the person who filed the card:

```markdown
# Before · AB#<card> <title>

Merge base <short sha> · <what was run: the app, a test>

## What the card says

<the expected and actual result, in the card's words>

## What was tried

1. <step> → <what was seen> (<evidence path or citation>)

## Verdict

Reproduced | Not reproduced | Could not run: <one line why>

## What would help

<only when not reproduced: the detail the card lacks (data, account, environment, version)>
```

Every claim cites where it was seen: a screenshot or log path, a file and line, a commit.

## 4. Record it

Record the Before with its verdict, `.scratch/<card>/verify-before.md` its report (`PROTOCOL.md`, Record it):

- `pass`: the bug showed as the card says. The run goes on to build: never ask whether to fix it or end the run. The fix's verify runs the same steps on the branch.
- `not-reproduced`: it did not show. The run ends with the report (its workflow's `ends:`); nothing is built, and the card stays where it is for a person to decide.
- `fail`: the app or a step could not run on the merge base at all. The run stops at Needs you with what broke.

## Completion

Done when `.scratch/<card>/verify-before.md` holds the steps, what was seen with its Evidence and the verdict, and Abe answered `ok` to the Before's record.
