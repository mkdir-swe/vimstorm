# Implement: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## 1. Read the work

- The card: `abe card show <card>`.
- A ticket: `abe issue show <owner/repo>#<n> --json` (a sub-issue of the spec issue), `abe card show <id>` (a child card), or its file.
- Back from review: the last entry of `reviews` in `abe factory status --json` names the report (`report`) with the findings.
- The repo's data route: the `run-app` skill's scripts through `abe run`, such as `abe run query`.

## 3. Build each ticket

- A bug that shows in the app: start the pack's start through `abe run`, then `abe browser start --json` for your `chrome-devtools` tools. `Could not connect to Chrome` means it is not started.
- When the browser or the app cannot be reached: `abe factory needs-you --reason "browser unavailable: <what abe browser start said>"`, never "not reproduced".

## 4. Run the checks yourself

- `abe settings get checks --json` lists the checks `abe serve` runs after build: each a name, or a `name` with the command it `run`s.
- `abe factory checks <card> --json` runs them all in the card's worktree. It writes `.scratch/<card>/checks.md` and moves nothing.

## Completion

In a Factory run, end the stage:

```sh
abe factory stage-done build --made .scratch/<card>/build.json --json
```

Go on at the stage it names (review is its own stage there). A file that does not hold is refused `bad-made`, naming what is wrong: fix it and run it again.
