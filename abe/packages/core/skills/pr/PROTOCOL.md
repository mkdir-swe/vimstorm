# PR: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## 1. Gather

- The card: `abe card show <card>`, its id and title.
- `abe factory status --json`: `regression` names the regression tests the After pass (or the clean review) ran, for risky work; `note` is the run's Launch note; `playbook` is the run's Playbook.
- `abe serve` keeps the review reports in `.scratch/<card>/review/`.

## 3. Hand it over

```sh
abe factory pr --title "<name> <Summary>." --body-file .scratch/<card>/pr.md --json
```

- It pushes with the repo's pre-push hook, which can take minutes: run it in the background (or with the Bash tool's longest timeout) and wait for its answer. `abe serve` pushes, outside your sandbox.
- `abe serve` checks the body, pushes the branch, opens the pull request (or updates it, when run again) and links it to the card. With the pr step's `into:`, it opens the body with ``Fixes onto `<branch>` (#N).``.
- `push-timeout`: the hook is slow; the repo raises `pr.pushTimeout` in `abe.yaml`.
- `no-into-branch`: origin has no such branch now. Say so and stop.
- Any other refusal names what is wrong with the body: fix it and run it again.
- `pr.url` in the answer is the pull request's URL.

## Completion

Done when `abe factory pr` answers `ok`.
