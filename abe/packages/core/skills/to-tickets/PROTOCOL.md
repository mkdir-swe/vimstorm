# To tickets: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## 1. Read the work

- The card: `abe card show <card>`.
- The spec issue (`.scratch/<card>/spec.md` names it): `abe issue show <owner/repo>#<n> --json`.

## 5. Publish

`abe settings get spec.where` says where: `issue` (the default), `card` or `file`. Publish blockers first, so each ticket's "Blocked by" names real references.

**`issue`**: each ticket a sub-issue of the spec issue:

```sh
abe issue create --repo <owner/repo> --title "<ticket title>" --body-file .scratch/<card>/tickets/<NN>-<slug>.md --parent <spec number> --json
```

**`card`**: each ticket a child card of the card (a session makes only its own card's):

```sh
abe card create --title "<ticket title>" --description-file .scratch/<card>/tickets/<NN>-<slug>.md --parent <card> --json
```

## Completion

In a run, end the step:

```sh
abe factory stage-done to-tickets --report .scratch/<card>/tickets.md --made .scratch/<card>/tickets.json --json
```

A file that does not hold is refused `bad-made`, naming what is wrong: fix it and run it again.
