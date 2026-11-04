---
name: create-specification
description: Makes sure before the work starts. Settles a card's open decisions (found out from the code, the docs and the team's sources first, then asked), then writes its spec where the repo keeps specs, linked to the card (the to-tickets skill slices it). Use at a run's create-specification step, or when asked to grill, interview or spec a card.
metadata:
  upstream: 'mattpocock/skills@59db609 skills/productivity/grilling, skills/engineering/grill-with-docs and skills/engineering/to-spec (one skill: find out first, ask what is left, spec it; tracker is the card and its spec issue, Abe commands in PROTOCOL.md)'
---

# Create specification

Make sure before you start: share one understanding of the card with the person, then write it down as the spec. Two parts, in order: **settle** the open decisions (section 1 to 3), then **spec** the work (section 4 to 7). Facts are never asked: you find them. A decision goes to the person only when it is a product call nothing in reach settles; everything the code, the data or an earlier decision answers, you take.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

## 1. Map the design tree

Read the card and what it links (`PROTOCOL.md`, Map the design tree) and, when the launch prompt has one, the **prototype reference** in `.scratch/<card>/prototype/` (its `PROTOTYPE.md` first: a mock-up asking "can we do this?", not a spec). Every decision the card leaves open branches into the decisions that hang off it: that is the **design tree**.

- A decision is the person's: what the user sees, the scope, a trade-off, which reading of the card is meant, which flows change. It stays theirs only while nothing in reach settles it (section 2).
- A fact is yours: what the code does, which API exists, what a screen shows today. Hand each fact to a reader subagent with a short brief and never ask it.
- From a prototype: each of its assumptions is a question (each mock: does the real API have it?), and so is what it does not show (errors, empty states, other markets, mobile).

Done when you can name the tree's first decisions and what each one blocks.

## 2. Find out first

Before you ask anything, look for each decision's answer where the team already wrote it or where the data shows it: the code and its history (`git log -S`, blame), `GLOSSARY.md` and the ADRs, `docs/`, the card's links and comments, the board (earlier cards), earlier specs the card or the code names, the repo's data route (the `run-app` skill's scripts, such as its `query`: what the data holds today), and the team's sources your session reaches (its MCP servers: errors and traces, feature flags, wiki, chat, tickets). Abe reads the board, the issues and the data route (`PROTOCOL.md`, Find out first). `CLAUDE.md`'s **Find out before you ask** names this repo's. Reader subagents do the looking.

- An answer found is settled: write it down with its **citation** (the file and line, the ADR, the issue, the query and its result, the page's link). Never settle one from a guess.
- **An earlier run.** When the card's comments link a spec, tickets or a pull request from a run that ended or was abandoned (open or closed), read them: the spec and its tickets, the pull request and its review. Start from what they decided; each decision stands, cited, unless the card or the code changed since. Ask only about what changed.
- **A recommended answer is taken, not asked.** When the code or the data supports one answer (an existing gate, a pattern the code repeats, what the rows show), take it and write it as an assumption: "The card leaves X open; <citation> shows Y, so we chose Y." The spec and the pull request carry it, so the person can overturn it at review.
- **Prod data.** When only prod data can answer and prod is on for this run, read it through the data route against prod, read-only (`PROTOCOL.md`, Find out first). When prod is off, take the recommended answer and write in the spec the query that would settle it on prod. Never ask for prod access.
- Two sources that disagree are a question for the person, with both cited.

Done when every decision on the frontier is either answered with a citation or still open.

## 3. Ask what is left

Ask only a product call nothing in reach settles: one you would recommend from a citation is not a question (section 2). The **frontier** is every open decision whose prerequisites are settled. Ask it in rounds, the recommended answer first, worded so "yes" accepts it; a question whose answer hangs on another one still open belongs to a later round. Recompute the frontier after each round.

- **With the person here** (a local run, or Chat open): one `AskUserQuestion` call per round, at most 4 questions. Your turn ends; the answers come as your next message.
- **Away** (a cloud run, or nobody answers): put the round in the run's Chat and wait as Needs you, with the first question as asked, the recommended answer first among its options (`PROTOCOL.md`, Ask what is left). Then stop. The rest of the round goes in the same Chat message, numbered. Their answer clears Needs you and comes as your next message.

Append every round to `.scratch/<card>/questions.md`: what you found (with its citation) and what you asked (with the answer, in the person's words). "Product owner decides" is a full answer: the spec lists it as open for them; never press for another. When the person says "skip the rest, just build", stop asking and write what you have.

When the frontier is empty, record what the session settled with the domain-modeling skill (`GLOSSARY.md`, an ADR for a decision that is hard to reverse).

## 4. Explore

Read the code the card reaches, with reader subagents for the wide parts. Use the words of `GLOSSARY.md` throughout and respect the ADRs in the area. Look for prefactoring that makes the work easier: make the change easy, then make the easy change.

Done when you can name the modules the change touches and the interface each one changes.

## 5. Pick the seams

A **seam** is the public boundary the tests observe behaviour at. Prefer existing seams to new ones, and the highest seam that shows the behaviour. Write each with a one-line note on what it catches and what it misses.

Cutting the work into tickets is the to-tickets skill's, the step after this one: leave slices out of the spec.

## 6. Write the spec

Write `.scratch/<card>/spec-body.md`, `<name>` the card's name as the launch said it (`AB#<id>`, or `L-<id>` on a board on this machine):

```markdown
Card: <name>

## Problem Statement

The problem from the user's point of view.

## Solution

The solution from the user's point of view.

## User Stories

1. As a <actor>, I want <feature>, so that <benefit>

## Implementation Decisions

The modules built or changed, the interfaces that change, the decisions and their reasons. A
decision found says where: "Found in <citation>: X." One the person settled says so: "Decided
with <who>: X." One the card left open: "The card leaves X open; we chose Y because Z."

## Open for the product owner

Only when an answer was "Product owner decides": each such question, as asked.

## Testing Decisions

The seams, what a good test checks here (external behaviour only), the modules tested, and
prior art in the repo.

## Out of Scope

## Further Notes
```

With a prototype reference, add a `## Prototype` section under the Solution: its link line, what it shows in words, its screenshots by their words, each mock as an API decision. Keep file paths and code out of the spec: they go stale. Make the story list as long as the work has distinct behaviours. Edit the text with the unslop skill.

## 7. Publish

The repo's `spec.where` setting says where (`PROTOCOL.md`, Publish): `issue` (a GitHub issue; the default), `card` (a comment on the card) or `file` (a file in the repo). The to-tickets skill puts the tickets in the same place.

**`issue`**: the spec issue in the card's repo, titled as the card, its body `.scratch/<card>/spec-body.md`, labelled `spec` (`PROTOCOL.md`, Publish).

**`card`**: the spec is a comment on the card. **`file`**: `.abe/specs/<card>/spec.md` in the card's worktree.

Write `.scratch/<card>/spec.md` with where the spec is (the issue's reference, the comment's link or the file's path).

## Completion

Done when every decision on the tree is settled (found with a citation, answered, or left to the product owner), the spec exists where `spec.where` says, and `.scratch/<card>/spec.md` says where. In a run, then end the step with `.scratch/<card>/spec.md` as its report (`PROTOCOL.md`, Completion).
