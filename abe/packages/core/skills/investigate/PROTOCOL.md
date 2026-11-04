# Investigate: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## 1. Pin the question

`abe card show <card>` reads the card, its links and comments.

## 2. Find out

- The repo's data route: the `run-app` skill's scripts through `abe run`, such as `abe run query <file.sql> --env test`.
- Prod data, when prod is on for this run: the same with `--env prod`, read-only. Refused `env-off` when prod is off: the report gives the query that would settle it.
- A spike: commit it on the card branch (`card/<card>`) and push nothing. When the run ends, `abe serve` pushes the branch and the run keeps its commits.
- A product call nothing in reach settles: `abe factory needs-you --reason "<the question>"` with its options, then wait.

## 4. End the run

```sh
abe factory stage-done investigate --report .scratch/<card>/report.md --json
```

`abe serve` keeps the report on the run's Run page and the run ends (its workflow's `ends:`).

## Completion

The run is done when `abe factory stage-done investigate` answers `ok`.
