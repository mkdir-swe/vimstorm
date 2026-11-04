# Verify: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

`abe serve` keeps its own numbered copy of each report in `.scratch/<card>/verify/`, and adds a `Browser profile: <name>` line under each report's title in its copy.

## 1. Plan the steps

The card's acceptance criteria: `abe card show <card>`.

Data steps run the `run-app` skill's data route, read-only: `abe run query <file.sql>` (dev), `--env test`, and `--env prod` when prod is on for this run. Refused `env-off` when prod is off for this run: the step gives the prod query that would settle it, for the person to run.

## 2. Before (Before+after, when no reproduce step ran)

```sh
abe factory base-worktree --json
```

It makes a worktree at the merge base of the card branch and the default branch: `data.path`, with the commit in `data.base`. Run its scripts by their absolute path there (Driving the app, below).

Record the Before from the card's worktree:

```sh
abe factory verify --phase before --result pass --report .scratch/<card>/verify-before.md --json
```

- `--result pass`: the problem reproduced as the card says.
- `--result not-reproduced`: it did not. The run stops at Needs you.
- `--result fail`: the app or a step could not run on the merge base at all. The run stops at Needs you too.
- For a bug in data, the rows it happens to come from the `run-app` skill's `abe run query`.

## 3. After

```sh
abe factory verify --phase after --result pass --report .scratch/<card>/verify-after.md --html .scratch/<card>/verify-after.html --json
```

- Risky work adds `--regression <name>,<name>`: the regression tests run.
- `--result fail`: a step failed. The run goes back to build.
- `--result pass` moves the run on to `pr`.

A pass is refused, each refusal naming what is wrong:

| Refusal                | Means                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `feature-not-listed`   | `## Features` does not list a mapped feature.                                                                          |
| `feature-unknown`      | `## Features` lists one the map has not.                                                                               |
| `feature-unjudged`     | A verdict with no `Judged by:`.                                                                                        |
| `feature-unproven`     | A driven feature without its surface's proof: a screenshot and a recording for `web`, a transcript for `api` or `cli`. |
| `not-driven-no-reason` | A not driven feature with no why.                                                                                      |
| `no-verify-html`       | The HTML report is not given with `--html`.                                                                            |
| `feature-html-differs` | The HTML report says other verdicts: a feature with another verdict, or in one but not the other, each named.          |

When you need the person: `abe factory needs-you` with options that each end in a recorded verify.

## Driving the app

`abe run` runs a script outside the sandbox (in a box's workspace, or locally for a local session), where the app keeps running and its browser reaches it.

- `abe run start` (a bare name is a hook point's script, `start`, `seed`, `stop`, `db`, `query`, `prototype-start`, as the repo's committed `abe.yaml` places it, else the run-app skill's `scripts/<name>`), `abe run seed`, `abe run stop`, in the card's worktree. Before's by the absolute path of its script, `abe run <data.path>/.claude/skills/run-app/scripts/start`, the path `abe factory base-worktree` answered (`/workspace/repo-base` on a box).
- The pack's own helpers: `abe run .claude/skills/verify-<app>/scripts/<name> <args>` (Before's by its absolute path too).
- Arguments go after the script; after `--` when one starts with `-`. `abe run` prints what the script printed (the start script's URL is its last line) and says when it exited non-zero. It returns once the script exits.
- Test's env: `abe run <script> --env test` (then no database of Abe's).
- `ports-held`: another card's app holds the repo's fixed ports; its answer names that session. Wait a few minutes, then `abe run start` again.
- `one-runner`: a second `abe run` beside one still running. Wait for the first to end. `abe run stop` always runs.
- A start that warns `compose publishes fixed host ports (<file>:<line> …)` runs all the same.
- A line starting `warning, started all the same:` (`data.warning`): the app started against a backend nobody said is local or test, or with cloud credentials.
- `compose-not-local`: a script ran docker compose against a remote `DOCKER_HOST` or docker context.

## The session's browser

- `abe browser start --json` starts it: one per session, in the run's browser profile, signed in already when the run names one. Your `chrome-devtools` tools drive it.
- Refused `profile-not-stored` or `profile-unreadable`: a step a person must fix. Run `abe factory needs-you` with what it said.
- `Could not connect to Chrome` (from the tools): it is not running. Start it again.
- Recording the After pass, or a Before that did not reproduce, stops it; else `abe browser stop --json`.

## In a subagent

Everything goes through Bash, `abe run` and `abe factory`. When you need the person, run `abe factory needs-you`.

## The HTML report

`abe serve` sanitises the fragment for the Run page, keeping only the verify kit's parts.

## Completion

Done when `abe factory verify --phase after` has answered `ok` (or `--phase before` with `not-reproduced`).
