---
name: to-tickets
description: Slices a card's spec into tickets that writers build in parallel (independent vertical slices, their blocking edges, and the milestones where the heavy testing runs) and publishes them where the repo keeps specs, as sub-issues of the spec issue, child cards on the board or files in the repo. Use at a run's to-tickets step, or when asked to split a spec, plan or card into tickets.
metadata:
  upstream: "mattpocock/skills@59db609 skills/engineering/to-tickets (Abe's own: a Feature run's step after create-specification, sliced for parallel writers with waves and milestones, published per spec.where: sub-issues, child cards with the card as parent, or files; Abe's commands in PROTOCOL.md)"
---

# To tickets

Cut the spec into **tickets** the build step hands to writers at once: as many as can run side by side, each small enough for one writer in one fresh context, each tested lightly on its own. The heavy testing waits for a **milestone**, where several tickets together make something whole.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

## 1. Read the work

- The card (`PROTOCOL.md`, Read the work).
- The spec: `.scratch/<card>/spec.md` says where it is (the spec issue, read through Abe as `PROTOCOL.md`, Read the work, says; comments on the card; or `.abe/specs/<card>/spec.md`). Its Implementation and Testing Decisions name the modules, the interfaces that change and the seams.
- The code those modules are in, with reader subagents for the wide parts: what each ticket touches, and which tickets would edit the same files.

Use the words of `GLOSSARY.md` and respect the ADRs in the area.

## 2. Slice for a parallel build

- **Vertical.** Each ticket a tracer bullet: a narrow but complete path through every layer it needs (schema, API, UI, its tests), demoable or verifiable on its own.
- **Independent.** Two tickets that edit the same files cannot run at once: merge them, or order them with a blocking edge. Name each ticket's area (the modules or folders it changes) so the build step can see they do not overlap.
- **Contract first.** What many tickets share (a type, an interface, a schema, a prefactor that makes the change easy) is one ticket that blocks them, so the rest fan out after it.
- **Real edges only.** A ticket is blocked by another only when it cannot start without it. Every edge you add makes the build longer.
- **Wide and short.** Group the tickets in **waves**: wave 1 has no blockers, wave 2 is blocked only by wave 1, and so on. Prefer more tickets per wave and fewer waves.
- **Big tickets.** A ticket one writer cannot finish in one fresh context is split. When it cannot be split cleanly (one feature across tightly coupled files), mark it `Big`: its writer may hand parts to writers of its own.
- **Wide refactors** are the exception to vertical slicing: one mechanical change (rename a column, retype a shared symbol) that breaks call sites across the codebase. Sequence it expand, migrate, contract: add the new form beside the old, migrate the callers in batches (each a ticket blocked by the expand, sized by blast radius), then delete the old form in a ticket blocked by every batch.

## 3. Place the milestones

A **milestone** is the point where a set of tickets together makes a user-visible path work end to end. Its tickets are the ones it needs, done.

- Per ticket the writer tests lightly: the typecheck and the tests it wrote or touched.
- At a milestone the build step runs the heavy testing: the full test suite, and the app looked at when the milestone shows in it.
- One to three milestones for most specs. The last one is every ticket: the run's checks, review and verify steps come after it.

Write each milestone as one line: what works when it is reached.

## 4. With the person here

Outside a run, or when the person is in the run's Chat, show the breakdown as a numbered list (title, blocked by, wave, milestone, what it delivers) and ask whether the granularity and the edges are right, then publish. In a run the spec is already settled: publish without asking.

## 5. Publish

The repo's `spec.where` setting says where, the same place as the spec (`PROTOCOL.md`, Publish). Draft each ticket to `.scratch/<card>/tickets/<NN>-<slug>.md`, numbered from `01` in dependency order, with the template below. Publish blockers first, so each ticket's "Blocked by" names real references.

**`issue`** (the default): each ticket a sub-issue of the spec issue, its body the ticket's draft.

**`card`**: each ticket a child card of the card on the board, its description the ticket's draft (a session makes only its own card's).

**`file`**: `.abe/specs/<card>/tickets/<NN>-<slug>.md` in the card's worktree, beside the spec; the coordinator commits them with the card's changes.

Leave the card's state, tags and comments as they are: `.scratch/<card>/tickets.md` lists the tickets.

<ticket-template>

## Parent

The spec issue (`#<n>`) or the card (`AB#<n>`).

## What to build

The end-to-end behaviour this ticket makes work, from the user's point of view.

## Area

The modules or folders it changes.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

- Each blocking ticket's reference and title, or "None (can start immediately)".

## Milestone

The milestone it belongs to, and `Big` when its writer may hand parts on.

</ticket-template>

Keep file paths and code out of a ticket's text but its Area: they go stale. A prototype's snippet that decides more precisely than prose (a state machine, a schema, a type) may be inlined, trimmed to the decision.

## 6. The build's map

Write `.scratch/<card>/tickets.md`, the map the build step works from:

```markdown
Tickets: <issue | card | file>, of <the spec's reference>

Milestone 1: <what works end to end>

- T1 <reference> <title>. Blocked by: none. Wave 1.
- T2 <reference> <title>. Blocked by: T1. Wave 2. Big.

Milestone 2: <what works end to end>

- T3 <reference> <title>. Blocked by: T1. Wave 2.
```

## 7. What was made

In a run, write `.scratch/<card>/tickets.json` too: each ticket with its data as you published it, and the spec lines it comes from (`from`). The Run page shows it.

`from` names a line of the spec by its section and its number there, counted from 1 in the spec's order: `story-N` the Nth of User Stories, `decision-N` the Nth of Implementation Decisions, `criterion-N` the Nth acceptance criterion. Every ticket names at least one.

```json
{
  "kind": "tickets",
  "where": "issue",
  "parent": "demo-shop/web#40",
  "tickets": [
    {
      "id": "T1",
      "ref": "#41",
      "url": "https://github.com/demo-shop/web/issues/41",
      "title": "Sign-in tokens",
      "what": "A visitor asks for a sign-in link and gets one by email",
      "area": ["auth/token"],
      "criteria": ["The link signs in once"],
      "blockedBy": [],
      "wave": 1,
      "milestone": 1,
      "big": false,
      "from": ["story-1", "decision-2", "criterion-1"]
    }
  ],
  "milestones": [{ "n": 1, "text": "A visitor signs in" }]
}
```

## Completion

Done when every ticket exists where `spec.where` says, linked to its parent, `.scratch/<card>/tickets.md` maps them and `.scratch/<card>/tickets.json` lists them. In a run, then end the step with `.scratch/<card>/tickets.md` as its report and `.scratch/<card>/tickets.json` as what was made (`PROTOCOL.md`, Completion). A file that does not hold is refused, naming what is wrong: fix it and record it again.
