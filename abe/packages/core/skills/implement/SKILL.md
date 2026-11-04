---
name: implement
description: Builds a card, or its spec's tickets in parallel, test-first on the card branch through writer subagents (a big ticket's writer may start writers of its own), tests lightly per ticket and fully at each milestone, and commits it. Use at the Factory's build stage, when checks or review send the run back to build, or when asked to implement a card or ticket.
metadata:
  upstream: 'mattpocock/skills@59db609 skills/engineering/implement (the card and its to-tickets tickets, writer subagents in parallel and nested, milestones for the heavy tests, review its own stage in a Factory run, commits per Abe stage rules)'
---

# Implement

Build what the card, or its spec's tickets, asks for, test-first, on the card branch. Fast: the tickets go to writers side by side, each tested lightly; the heavy testing waits for the milestones.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

## 1. Read the work

- The card (`PROTOCOL.md`, Read the work).
- With a spec: `.scratch/<card>/spec.md` says where it is.
- With tickets: `.scratch/<card>/tickets.md` maps them (the to-tickets skill's): each ticket's reference, blocking edges, wave, milestone and whether it is `Big`. Read a ticket from its issue, its card or its file (`PROTOCOL.md`, Read the work).
- Back from checks: `.scratch/<card>/checks.md` holds each check's result and the failing output.
- Back from review: the run's last review names the report with the findings (`PROTOCOL.md`, Read the work).
- With a prototype: `.scratch/<card>/prototype/` is the **prototype reference** (`PROTOTYPE.md` first). Read it for intent and shape only. Build the real thing in the app's own code, with tests; never paste its injected CSS, JS, mocks or diff.

State the card's title (and the ticket, milestone or round you are on) in one line before you start. Outside a Factory run, when the card or ticket you were given is ambiguous, ask which one.

The work is clear when you can say what changes for the user, where in the code it changes, and how you would know it works. When the card leaves one of those open and no spec settles it, settle it with the create-specification skill's **Find out first** and **Ask what is left** before you build, and say why in Chat. A reproduce step that passed settled the bug: build the fix without asking. A choice the code or the data settles (the repo's data route, the `run-app` skill's `query`; the team's sources) is taken, not asked, and written in the pull request's Notes as an assumption.

## 2. Work the tickets in parallel

Without tickets, the card is one ticket, or a few you cut the way the to-tickets skill does: tracer bullets, each a complete path with its test, files that do not overlap. With tickets, work the **frontier**: every ticket whose blockers are merged.

- Start a writer subagent for each ticket on the frontier at once, up to your session's Subagents limit, each in its own worktree off the card branch. Start the next as one returns and its merge opens new tickets.
- A writer's brief names the ticket (its reference), its acceptance criteria, its area, the seams to test at, the commands to run (`AGENTS.md` names them), the commit style, and what to return: its branch, its commits, and one line per acceptance criterion.
- A `Big` ticket's brief says its writer may hand parts to writers of its own (`abe:writer`), each on a branch off the writer's, and merge them into its own branch before it returns. Never hand a whole wave to one writer.
- Merge each writer's branch into the card branch when it returns, as the Subagents rules say, then run the typecheck: a merge that breaks it is fixed before the next merge.

## 3. Build each ticket

Use the tdd skill wherever you can, at the seams the spec or the card agreed: red, then green. The principle skills load by their triggers as their situations come up (prove it works, fix root causes); a writer's brief says so too.

**Light per ticket, heavy at a milestone.** A writer runs the typecheck and the tests it wrote or touched, no full suite. When every ticket of a milestone is merged, run the heavy testing on the card branch: the full test suite, and the app looked at when the milestone shows in it. A failure there goes to one writer with the output, before the next milestone's tickets start. The last milestone is all of them: the checks step then runs the repo's checks.

- A bug that shows in the app is seen there first, on today's code, with the browser the verify skill's **The session's browser** starts: the pack's start, then the session's browser for your `chrome-devtools` tools (`PROTOCOL.md`, Build each ticket). When the browser or the app cannot be reached, that is no verdict: wait as Needs you with what the browser's start said, never "not reproduced". A not reproduced while your session's browser never ran is recorded as inconclusive.
- A bug gets a test that fails on today's code first. A test the repo skipped for this bug is unskipped.
- Run the typecheck and the touched test files often; the full suite runs at the milestones.
- Back from checks: fix what the output names, never the check. Back from review: fix every finding the report lists, in the report's order.

Done with a ticket when its acceptance criteria each have a passing test or a reason they cannot (a pure UI look, which verification covers).

## 4. Run the checks yourself

The repo's checks are the ones Abe runs after build: each a name, or a `name` with the command it `run`s (the repo's pack gives them; `AGENTS.md` names the commands of a bare name). Run each command in the card's worktree, or all of them at once through Abe, which writes `.scratch/<card>/checks.md` and moves nothing (`PROTOCOL.md`, Run the checks yourself): green here is green there.

## 5. Commit

Commit on the card branch in the repo's commit style. One commit per ticket or per round of fixes reads best. Leave pushing to the PR stage.

## 6. Write down what was built

In a Factory run, write `.scratch/<card>/build.json`: what this build round made, one lane per writer. The Run page shows it; nobody reads it from the transcript.

- A lane is one writer's work: its ticket (`ticket` the map's id, `ref` its reference), its wave, its worktree's folder name, its commits on the card branch as `git log --format='%h %s'` gives them, the files it changed, the tests it ran and how long it took (`tookMs`).
- A round of fixes is one lane with no ticket and a `label`: `findings 1–2`, `lint`, `checks`.
- A milestone's heavy testing goes under `milestones`: after which wave, what then works, the full suite's result, and what the app showed when you looked (`looked`).
- Each round writes the file anew with that round's lanes only.

```json
{
  "kind": "build",
  "lanes": [
    {
      "ticket": "T1",
      "ref": "#41",
      "title": "Sign-in tokens",
      "wave": 1,
      "worktree": "4-t1",
      "commits": [{ "sha": "a1f20c3", "subject": "Sign-in tokens" }],
      "files": { "count": 3, "added": 118, "removed": 0 },
      "tests": [
        { "name": "typecheck", "ok": true },
        { "name": "auth/token.test.ts", "ok": true, "count": 6 }
      ],
      "tookMs": 240000
    },
    {
      "label": "findings 1–2",
      "title": "The review's findings",
      "commits": [{ "sha": "c7d01e2", "subject": "Name the link window" }]
    }
  ],
  "milestones": [
    {
      "n": 1,
      "afterWave": 2,
      "text": "A visitor signs in",
      "tests": [{ "name": "full suite", "ok": true, "count": 212 }],
      "looked": "sign-in → check email → open link"
    }
  ]
}
```

## Completion

Done when every ticket is built and merged into the card branch, the last milestone's heavy testing is green, every check is green in the card's worktree, the work is committed, and `git status` is clean. In a Factory run, then end the stage with `.scratch/<card>/build.json` as what was made (`PROTOCOL.md`, Completion) and go on at the stage Abe names (review is its own stage there). A file that does not hold is refused, naming what is wrong: fix it and record it again. Outside a Factory run, then review the work with the code-review skill.
