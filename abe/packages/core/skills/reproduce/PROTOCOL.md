# Reproduce: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## 1. Plan the steps

- The card: `abe card show <card>`.
- The repo's data route: the `run-app` skill's scripts through `abe run`, such as `abe run query <file.sql> --env test`.
- Prod data, when prod is on for this run: `abe run query <file.sql> --env prod`, read-only. Refused `env-off` when prod is off for this run: do the same from test and write in the report the prod query that would confirm it.

## 2. Reproduce on the merge base

```sh
abe factory base-worktree --json
```

It answers the worktree at the merge base in `data.path`. Launch and drive the app there through `abe run` (the verify skill's `PROTOCOL.md`, Driving the app, has its rules), and look with the session's browser: `abe browser start --json`, then your `chrome-devtools` tools. Clean up with `abe run stop`.

## 4. Record it

```sh
abe factory verify --phase before --result pass|not-reproduced|fail --report .scratch/<card>/verify-before.md --json
```

- `pass`: the bug showed. The run goes on to build.
- `not-reproduced`: the run ends with the report (its workflow's `ends:`).
- `fail`: the app or a step could not run on the merge base. The run stops at Needs you.

## Completion

Done when `abe factory verify --phase before` answers `ok`.
