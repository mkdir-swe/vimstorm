# Code review: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## 2. Gather the sources

- **Spec**: `abe card show <card>` reads the card. With a spec, `abe issue show <owner/repo>#<n> --json` reads the spec issue and its slices (`.scratch/<card>/spec.md` names the issue).
- **Round**: `abe factory status --json` gives `round` (rounds with findings in a row so far) and `reviews`. `abe serve` keeps the earlier reports in `.scratch/<card>/review/` (numbered, newest last).

## 5. Record the round

```sh
abe factory review --findings <count> --report .scratch/<card>/review.md --findings-file .scratch/<card>/review.json --json
```

- `--findings` is the report's `Findings:` count; the `must` findings in `--findings-file` are as many.
- Refused `bad-findings`: the file does not hold, or its `must` findings are not `--findings`. The refusal names what is wrong: fix it and run it again.
- A clean round on risky work names the regression tests it ran: `--findings 0 --regression <name>,<name>`.
- `abe serve` keeps a numbered copy of the report in `.scratch/<card>/review/`. The answer's `step` is the next step: build, or the workflow's next.
- The third round in a row with findings stays in review at Needs you by itself. Once the person answers: `--findings <n>` with the findings still to fix goes back to build, `--findings 0` goes on.

## Completion

The round is recorded when `abe factory review` answers `ok`.
