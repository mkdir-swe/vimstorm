---
name: code-review
description: Reviews a branch's changes since the merge base in one pass on two axes, the repo's standards and the card's spec, and records the round with Abe. Use at the Factory's review stage, or when asked to review a branch, a pull request or work in progress.
metadata:
  upstream: 'mattpocock/skills@59db609 skills/engineering/code-review (one reader subagent for both axes, merge base as default fixed point, card and spec issue as spec, findings counted and recorded with Abe, Abe commands in PROTOCOL.md)'
---

# Code review

One review, two axes, reported side by side:

- **Standards**: does the code follow this repo's documented standards?
- **Spec**: does the code do what the card and its spec asked for?

A change can pass one axis and fail the other:

- Code that follows every standard but builds the wrong thing: **Standards pass, Spec fail.**
- Code that does exactly what the card asked but breaks the repo's conventions: **Spec pass, Standards fail.**

So the report keeps them apart, and neither axis's findings are merged into or ranked against the other's: one axis must not mask the other.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

## 1. Pin the fixed point

The fixed point is the merge base of the card branch and the default branch:

```sh
base=$(git merge-base HEAD "$(git symbolic-ref --short refs/remotes/origin/HEAD)")
git diff "$base"...HEAD --stat
git log "$base"..HEAD --oneline
```

When `origin/HEAD` is not set, name the default branch (`origin/main`). Outside a Factory run, the person may name another fixed point (a commit, branch, tag, `HEAD~5`); use theirs, three-dot diff and all. Confirm it resolves (`git rev-parse "$base"`) and the diff is non-empty before going further: a bad ref or an empty diff fails here, not inside the reviewer. Done when the base resolves and the diff is non-empty.

## 2. Gather the sources

- **Spec**: the card, and with a spec, the spec issue and its slices from `.scratch/<card>/spec.md` (read both through Abe: `PROTOCOL.md`, Gather the sources). Outside a Factory run with no card named, look in this order: card ids (`AB#<id>`) or issue numbers in the commit messages, a path the person named, a spec file under `docs/`, `specs/` or `.scratch/` matching the branch; then ask the person. When there is none, the Spec axis reports `no spec available`.
- **Standards**: search the repo for every file that says how code is written here. `AGENTS.md`, `CONTRIBUTING.md` and `CODING_STANDARDS.md` are on the list when they exist; so are `GLOSSARY.md`, the ADRs in the area, and the coding-standard skills your Layers give (a language skill, the commit style).
- **Round**: the run's status gives the round (rounds with findings in a row so far) and the earlier reviews (`PROTOCOL.md`, Gather the sources). After a round with findings, read the earlier reports Abe kept in `.scratch/<card>/review/` (numbered, newest last): a finding that comes back is the first thing to check.

## 3. Review

Give the review to one reader subagent with a fresh context, so it judges the diff without the build's reasoning. Its brief holds: the diff and log commands, the spec text or where to read it, the standards files, the smell baseline below pasted in full, and this:

> Review the diff on two axes and report under `## Standards` and `## Spec`.
> Standards: every place the diff breaks a documented standard (cite the file and rule), and any baseline smell you spot (name it, quote the hunk). A documented breach can be hard; a smell is always a judgement call, and a documented repo standard overrides the baseline. Skip what tooling enforces.
> Spec: requirements missing or partial; requirements that look implemented but are implemented wrongly; behaviour nobody asked for (scope creep). Quote the spec line for each. With no spec, write `no spec available` under `## Spec`.
> List each finding as `- [<file>:<line>] <what is wrong> → <the change that fixes it>`. Put a finding under `### Findings` when the build must change it to pass; put a judgement call you would not hold the change for under `### Noted`.
> Change nothing. Reply with the report only, under 600 words.

Without subagents, review inline in the same order, Standards first.

### Smell baseline

A fixed set of code smells (Fowler, _Refactoring_, ch. 3) the Standards axis always carries, even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, the smell is suppressed.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Skip anything tooling already enforces.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

- **Mysterious Name**: a function, variable or type whose name doesn't reveal what it does or holds. → rename it; when no honest name comes, the design is murky.
- **Duplicated Code**: the same logic shape in more than one hunk or file of the change. → extract the shared shape, call it from both.
- **Feature Envy**: a function that reaches into another object's data more than its own. → move it onto the data it envies.
- **Data Clumps**: the same few fields or params travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch` or `if`-cascade on the same type recurring across the change. → polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forcing scattered edits across many files. → gather what changes together into one module.
- **Divergent Change**: one file or module edited for several unrelated reasons. → split it so each changes for one reason.
- **Speculative Generality**: abstraction, parameters or hooks for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly delegates onward. → cut it, call the real target directly.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

## 4. Write the report

Write the reviewer's reply to `.scratch/<card>/review.md` (the same file each round), with a first line `Findings: <count>`, where the count is the number of entries under both axes' `### Findings`. Entries under `### Noted` are not counted.

You judge the change's **risk** from the diff: it is risky when it reaches money, authentication or permissions, a data migration or a delete, a contract other systems read, or anything a revert cannot undo. Say so on the report's second line (`Risk: risky | not risky · <why>`).

In a Factory run, write the same findings to `.scratch/<card>/review.json` (the same file each round):

- `findings`: every entry of the report, its axis, file, line, what is wrong and the fix; `severity` is `must` under `### Findings` and `noted` under `### Noted`.
- `id`: `F1`, `F2`, … across the run. A finding that comes back keeps its id; a new one takes the next number.
- `earlier`: every `must` finding of the round before, `fixed` or not. A finding still open is also in `findings`, with its id.
- `risk`: the report's second line, as `risky` and `why`.

Its `must` findings are as many as the report's `Findings:` count.

```json
{
  "findings": [
    {
      "id": "F3",
      "axis": "standards",
      "file": "auth/token.ts",
      "line": 58,
      "text": "The expiry is a bare 900000",
      "fix": "Name it LINK_WINDOW_MS",
      "severity": "must"
    },
    {
      "id": "F4",
      "axis": "spec",
      "file": "auth/link.ts",
      "line": 12,
      "text": "The email's subject differs from the spec's",
      "fix": "Use the spec's words",
      "severity": "noted"
    }
  ],
  "earlier": [
    { "id": "F1", "fixed": true },
    { "id": "F2", "fixed": true }
  ],
  "risk": { "risky": true, "why": "authentication: the diff adds a sign-in path" }
}
```

## 5. Record the round

Record the round with Abe: its finding count, the report and the findings file (`PROTOCOL.md`, Record the round). A file that does not hold, or whose `must` findings are not the count, is refused, naming what is wrong: fix it and record it again. A clean round on risky work runs the regression tests that cover the other flows it reaches and names them in the record.

Abe keeps a numbered copy of the report in `.scratch/<card>/review/`. Its answer names the next step: build (findings to fix: the implement skill takes the report), or the workflow's next. The third round in a row with findings stays in review at Needs you by itself; once the person answers, do what they said (record the findings still to fix to go back to build, or no findings to go on).

Outside a Factory run, reply with the report and its one-line summary instead: the finding count per axis and the worst finding within each axis. Never pick one winner across the axes: that is the ranking the split exists to prevent.

## Completion

Done when the report is in `.scratch/<card>/review.md` with its `Findings:` line, every finding has a `file:line` and a fix, `.scratch/<card>/review.json` holds them (in a Factory run), and Abe has answered `ok` to the round's record.
