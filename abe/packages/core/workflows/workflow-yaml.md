# Workflow YAML

A workflow is steps in order and the loops back between them. Plain YAML; the schema
(`abe/packages/core/schema/workflow.schema.json`) completes and checks it as you type, and Abe
checks it again when it loads (`abe workflow list`).

## Where workflows live

The repo's as `abe/workflows/<id>.yaml` (one file each, committed like the code), yours as
`.abe/workflows/<id>.local.yaml` in the main checkout (never committed), and Abe's built-in ones:
Feature (`feature`), Quick fix (`quick-fix`), Bug (`bug`) and Investigate (`investigate`). The
id is the file's name; of the same id the nearest Layer wins. `workflows:` in `abe.yaml` is no
longer read: the load check says where each one goes. A step's skill is
found the same way: yours, the repo's `.claude/skills/`, then Abe's.

```yaml
name: Bug
description: Reproduced first, then fixed and shown gone.
on: { type: Bug } # or { tags: [quick] }, or default: a card no other takes; none: picked only
branch: card/<card>
steps:
  - reproduce:
      skill: reproduce
      ends: { check: bug.reproduced == 0, then: report } # no repro: the run ends with the report
  - build: { skill: implement, fresh: loop }
  - checks # serve runs them
  - review: { skill: code-review, fresh: true }
  - verify: { skill: verify, fresh: true }
  - playbook:
      skill: playbook
      when: { judge: 'Does the diff need manual steps after merge?', sees: [diff] }
  - pr: { skill: pr, fresh: true }
loops:
  - from: review
    to: build
    when: { check: review.findings > 0 }
    carries: [review.findings]
    max: 2
```

## Which workflow a card runs

You pick it at launch (`abe factory run <card> --workflow <id>`, or the Launch box); it is
preselected by `on:`. Yours or the repo's first: the first whose `on:` takes the card's type or
tags, else their `on: default`. Only when none of them does, Abe's: Bug cards Bug, Tasks Quick
fix, any other Feature. A workflow with no `on:` is offered, never preselected (Investigate). In the cloud the
preselected one runs.

## Steps

A step is a name, or a name with options. Each step runs in a subagent of its own.

- `skill:` its **one main skill** (Abe's, the repo's or yours); every other skill is there by its
  description. None given: the built-in step's own (below), else the skill of the step's name.
- `fresh: true` its subagent starts fresh, given only the card, the spec, the diff and the
  findings carried back to it; `fresh: loop` fresh only on a loop back to it (build).
- `when:` a **gate**: the step runs only when it holds; else it is skipped. A `judge:` gate is one
  yes/no call that sees only what `sees:` names (`card`, `spec`, `diff`); its answer and reason are
  a decision on the Run page. A gate holds for the step's first pass only: a loop back to it runs
  it whatever its gate says (what the loop carries is its work). A loop back to a step that still
  does not run stops the run at Needs you, never another round with nothing done.
- `ends: { then: report }` the run ends after this step, with the step's report on its Run page
  (no pull request, no comment on the card) and its card to Done; with a `check:` or `judge:`,
  only when it holds. A spike the step committed is pushed and kept with the run. A reproduce step's report (a bug that does not
  reproduce) leaves the card where it is, for a person to decide.

The built-in steps keep their jumps in code: `create-specification` (`spec`), `reproduce` (a
bug's Before on the merge base, recorded with `abe factory verify --phase before`, reports
`bug.reproduced`), `build` (`implement`), `checks` (serve runs them; no skill), `review`
(`code-review`), `verify` (picks its own level from the spec and the diff), `pr` (serve opens
it). Any other skill is a plain step: the agent runs it and says `abe factory stage-done <step>`.

A step's other options: `pin: <layer>` (a nearer copy keeps it, in order), `reviewers:`,
`reports:` (the facts it reports, beside a built-in's own), `done_when:` (a condition, as
below) and, on `pr` only, `into:`.

## A pull request into a teammate's branch

`into:` on the pr step names a text fact an earlier step reports: the branch the pull request
goes into, such as a teammate's pull request's head. Once a step reports it
(`abe factory stage-done audit --fact audit.head=feature/cart-badge`), the card branch starts
from that branch on origin, so the fixes land on their work. The pull request goes from
`card/<card>` into their branch, and its body opens with ``Fixes onto `feature/cart-badge` (#41).``.
Nothing is ever pushed onto their branch, and auto merge stays off: they merge it. The run is
Done when it is merged. Here `review-pr` is the repo's own skill, reporting the head and its
findings:

```yaml
name: Review PR
steps:
  - audit: { skill: review-pr, reports: [audit.head, audit.findings] }
  - build: { skill: implement, fresh: loop, when: { check: audit.findings > 0 } }
  - checks
  - review: { skill: code-review, fresh: true }
  - verify: { skill: verify, fresh: true }
  - pr: { skill: pr, fresh: true, into: audit.head }
```

The run stops when the branch is no branch name (`bad-into-branch`), when no step reported it or
origin has no such branch (`no-into-branch`), or when the card branch already holds work of its
own (`own-work`).

## Two kinds of condition

- **check:** a fact a step reports, compared: `criteria.failed > 0`. Abe evaluates it, no model,
  the same answer every time. Use it whenever a fact exists.
- **judge:** a yes/no question the step's own agent answers, with what it `sees:`. It answers with
  `abe factory judge --answer yes|no --reason <why>`; its answer and reason are a decision step on
  the Run page. Only when no fact says it.

## Rules

1. A `when:` (a loop's, a gate's or a step's `done_when:`) has exactly one of `check:` or
   `judge:`; an `ends:` at most one (none: always).
2. A `check:` uses only the facts the steps report (the list below): `> < >= <= == !=`, `and`,
   `or`, `not`, parentheses. A fact not reported yet reads as 0.
3. A `judge:` is one yes/no question ending in `?`, and names what it `sees:` (a gate's: `card`,
   `spec` or `diff`).
4. `max:` is required. Past it the run stops: Needs you.
5. `from:` and `to:` name steps of this workflow; `to:` comes before `from:`, or is the same step.
6. `carries:` names what goes back: facts, or the step's evidence.

Also checked: every step's skill is found in some Layer; checks names no skill; each step once;
checks, review and verify each after a build step; `pr` last when there; `into:` on `pr` alone,
naming a text fact a step before it reports; pinned steps kept. A
file failing its check is not offered on a card, and its last good version is not run either.
A checks, review or verify step with no loop of its own goes back to the nearest build before it
(10 times, review 2), as Feature does.

## Facts

| fact                   | reported by   | what                            |
| ---------------------- | ------------- | ------------------------------- |
| `checks.failed`        | build, checks | checks that failed              |
| `checks.output`        | build, checks | the failing output (text)       |
| `review.findings`      | review        | every finding to fix            |
| `review.findings.high` | review        | findings rated high or critical |
| `criteria.failed`      | verify        | acceptance criteria not proven  |
| `bug.reproduced`       | reproduce     | the bug showed (1) or not (0)   |
| `pr.checks.failed`     | pr            | the PR's failed checks          |
| `pr.comments.open`     | pr            | review comments not resolved    |
| `spec.questions.open`  | spec          | open questions in the spec      |

A plain step reports the facts it lists in `reports:`, with
`abe factory stage-done <step> --fact name=value`. Text facts are carried, never compared.
