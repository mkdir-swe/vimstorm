# Create specification: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## 1. Map the design tree

`abe card show <card>` reads the card, its links and comments.

## 2. Find out first

- The board's earlier cards: `abe card list`.
- An earlier spec the card or the code names: `abe issue show <owner/repo>#<n> --json`.
- The repo's data route: the `run-app` skill's scripts through `abe run`, such as `abe run query <file.sql>` (what the data holds today).
- Prod data, when prod is on for this run: `abe run query <file.sql> --env prod`, read-only. Refused `env-off` when prod is off for this run: take the recommended answer and write in the spec the query that would settle it on prod.

## 3. Ask what is left

Away (a cloud run, or nobody answers), the round waits as Needs you:

```sh
abe factory needs-you --reason "<the first question, as asked>" --option "<recommended answer>" --option "<another>"
```

Then stop. The person's answer clears Needs you and comes as your next message.

## 7. Publish

`abe settings get spec.where` says where the spec goes: `issue` (the default), `card` or `file`.

**`issue`**: open the spec issue:

```sh
abe issue create --repo <owner/repo> --title "<card title>" --body-file .scratch/<card>/spec-body.md --label spec --json
```

**`card`**: the spec is the card's comment: `abe card comment <card> --body-file .scratch/<card>/spec-body.md --json`.

## Completion

In a run, end the step:

```sh
abe factory stage-done create-specification --report .scratch/<card>/spec.md --json
```
