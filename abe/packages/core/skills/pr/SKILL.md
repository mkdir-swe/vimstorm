---
name: pr
description: Writes the card branch's pull request title and body (summary, one verification line, Notes of at most five bullets) and hands it to Abe. Use at the Factory's PR stage, or when writing a PR body.
metadata:
  upstream: 'mattpocock/skills@59db609 skills/engineering/pr (card line, one Verified line for Evidence, door and blast radius as Notes bullets, handed to Abe, Abe commands in PROTOCOL.md)'
  credits:
    skill: show-me
    author: Dex Horthy
    organisation: Humanlayer
    url: 'https://github.com/humanlayer/skills/blob/main/plugins/show-me/skills/show-me/SKILL.md'
---

# PR

The pull request is **Tracking**: a reviewer, a product owner and the next session read it. It says what changed, how it was proven in one line, and what they must know in at most five bullets. Screenshots and reports stay in `.scratch`; the body points at none of them.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

## 1. Gather

- The card, its id and title (`PROTOCOL.md`, Gather).
- What changed: `git log <base>..HEAD --oneline` and `git diff <base>...HEAD --stat`, `<base>` being the merge base with the default branch.
- The proof: the After report's `## For the pull request` section (`.scratch/<card>/verify-after.md`), or when verify picked level None or the workflow has no verify, the checks that ran (`.scratch/<card>/checks.md`). For risky work, the run's status names the regression tests the After pass (or the clean review) ran (`PROTOCOL.md`, Gather).
- What a reader must know: the review reports Abe kept in `.scratch/<card>/review/`, the decisions the build took, a pack step fixed during verification.

Done when you can say what changed, why, and how it was proven, each in one sentence.

## 2. Write

The title is the commit-style line for the whole change: `<name> <Summary>.`, `<name>` the card's name as the launch said it: `AB#<id>` on Azure Boards, `L-<id>` on a board on this machine (never `AB#<id>` there: GitHub links it to Azure Boards' card).

Write `.scratch/<card>/pr.md` with this body:

```markdown
Card: <name>

## Summary

<what changed and why, one to three sentences, in the card's words>

<optional sketch>

**Verified:** <one line>

## Notes

- <at most five bullets>
```

- **Sketch**: the smallest view that makes the point, only when the sentences leave it unclear, placed next to the sentence it supports. Pseudocode for logic; a call tree for runtime control flow; a component tree for UI structure, with the state and module boundaries that matter; a shallow file tree for file responsibility or a broad refactor; a Mermaid diagram for interaction or data flow; a `diff` of one of these when the point is what changes in a shape that already exists; the whole block when most of it is new. Keep only the calls, files, props, states and boundaries the point needs. Usually one view, sometimes two, never all. (The menu is Dex Horthy's show-me skill's.)
- **Verified**: exactly one line starting `**Verified:**`. Take it from the verify report. Concrete beats words: before and after, the test that failed and now passes. With no verification beyond the checks: `**Verified:** checks only: <the checks> green.` For risky work it names the regression tests run.
- **Notes**: what a reviewer or the next session must know, and nothing else. With a **prototype reference** (`.scratch/<card>/prototype/`), one bullet says `Built from Prototype v<n> (prototype://…)`, its link line's address. Good bullets: a small decision as "we saw X, did Y"; a one-way door, one a revert cannot walk back ("the migration drops the old column; a revert needs a new migration"); the blast radius when it reaches past the diff (a consumer that breaks, a layout shift, mobile); a link to the ADR a big decision got; a pack step fixed. Leave Notes as one bullet when one is all there is. When the run has a Launch note (the run's status has it: `PROTOCOL.md`, Gather), one bullet says what it asked and how it was followed: `Launch note: <its first line> · followed: <how>`. Each assumption the run took instead of asking (the spec's "we chose Y", one build or reproduce took from the code or the data) is a bullet: `Assumed: <Y>, because <citation>`, so the reviewer can overturn it. A question only prod data settles, with prod off for the run, is a bullet with the query that would settle it.

Skip preambles and keep prose brief. Write it with the technical-writing skill, edit it with the unslop skill, and use the words of `GLOSSARY.md`. When the run has a Playbook (the run's status names it), one Notes bullet names it: `Playbook: .abe/playbooks/<card>.md · <n> steps, <m> yours`.

Done when the body has the card line, a summary, exactly one `**Verified:**` line, and a `## Notes` section of one to five bullets (more only for the run's assumptions).

## 3. Hand it over

Hand the title and `.scratch/<card>/pr.md` to Abe (`PROTOCOL.md`, Hand it over). Abe pushes with the repo's pre-push hook, which can take minutes: wait for its answer. Never push yourself: Abe pushes, outside your sandbox. A push that times out means the hook is slow: say so; the repo raises `pr.pushTimeout` in `abe.yaml`.

Abe checks the body, pushes the branch, opens the pull request (or updates it, when run again) and links it to the card; a body that names no `<name>` gets the card's link line added. When the workflow's pr step has `into:` (a teammate's pull request's head, such as `feature/cart-badge`), the pull request goes into that branch, not the default branch: take `<base>` in Gather to be `origin/<that branch>`, so the summary covers only your fixes onto their work. Abe opens the body with ``Fixes onto `<branch>` (#N).``, so don't write that line yourself. It never pushes onto their branch and never turns auto merge on. A refusal because origin has no such branch now: say so and stop. A refusal names what is wrong (no verification line, two of them, no Notes, more than five bullets, a risky line without its regression tests, an `AB#` name for a card on this machine's board): fix the body and hand it over again.

The run then waits for the merge (a person's, or auto merge when the team turned it on) and is done when the team's `factory.done` says: deployed to that environment (`test` unless set), or merged. While a person's merge is awaited it shows as Ready for review (never call it Needs you). Your work is finished: say the pull request's URL (from Abe's answer) in one line and stop.

## Completion

Done when Abe answers `ok` to the hand-over and you have said the pull request's URL in one line.
