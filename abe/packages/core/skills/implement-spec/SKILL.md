---
name: implement-spec
description: 'Implement the result of create-specification and to-tickets in code: a whole spec and its slices on one integration branch.'
disable-model-invocation: true
metadata:
  upstream: 'mattpocock/skills@59db609 skills/engineering/implement-spec (spec and slices read through Abe, abe:writer implementers, merged by you, no pull request of its own, Abe commands in PROTOCOL.md)'
---

You have been provided a spec. This spec should have tickets associated with it, describing how to implement the spec.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

The spec and its tickets are on Abe's tracker: the spec issue the create-specification skill opened and its slices as sub-issues (Abe reads one with its sub-issues), or the cards the to-tickets skill made on the board (`PROTOCOL.md`, Steps). If you were given neither, ask the person for the spec.

This is for a person's own session. A Factory run builds a card through its stages (the implement skill at build), not with this skill.

The goal is the entire spec implemented on a single **integration branch**, with every ticket done.

The tickets are not a list of steps. They are a **task graph** with blocking relationships between them. This means there is always a **frontier** of tickets which are ready to be grabbed.

Communication to and from subagents should be sparse. Communicate primarily through **context pointers**: to the spec, tickets, research notes, and previous commits. Don't duplicate information already available via pointers.

**Implementer subagents** should be run in the background where possible for maximum concurrency.

## Steps

1. Read the spec and tickets to understand the task graph.

2. (optional) Use an **exploration subagent** (`abe:reader`) to conduct any exploration required by the tickets - relevant codebase files or external documentation. It returns its notes and you save them under `.scratch/` (git-ignored), where every later subagent can read them. This lets **implementer subagents** focus on implementation rather than exploration.

3. Create the integration branch.

4. Use **implementer subagents** (`abe:writer`) to implement each ticket, each in its own worktree on its own branch. Each implementer subagent:
   - confirms its worktree is based on the integration branch before starting, and resets onto it if not;
   - calls the Skill tool with `tdd` to build the ticket;
   - merges the integration branch tip into its own branch before reporting done

5. Once an **implementer subagent** completes, merge its branch into the integration branch yourself.

6. If this changes the **frontier** of available tickets, kick off more **implementer subagents** to work on the new tickets. This allows for maximum concurrency.

7. Once all tickets are complete, call the Skill tool with `code-review` on the integration branch. Fix all issues raised by the code review in a single **implementer subagent**.

8. Report the integration branch and which ticket each merge resolved. A pull request is the person's to open (the pr skill shapes its body).

9. Clean up all **implementer subagent** worktrees.
