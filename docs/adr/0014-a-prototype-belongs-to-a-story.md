# 0014 A prototype belongs to a story

Status: accepted for 2.0 (design), 22 Oct 2026; 1.0 unchanged. Partly superseded 23 Oct 2026: P2's one key into the Factory by ADR 0017 (a product owner never launches); P1, P4, P5 and P6 by ADR 0018 (a prototype runs in your environment and lives in the org store, no branch). R1 and P3 stand.

A Prototype is something for a story, not code: it is never a pull request and never merged. It shows a proposed change in the app so a story can be agreed before the Factory builds it.

- R1: Role is a personal setting: Developer, Product owner or Designer. A product owner or designer sees the Factory overview, specs and Prototype mode, and by default no Editor, git or terminal; a developer sees everything.
- P1: a product owner's or designer's prototype is JS / CSS injected into the app in the built-in browser, against our local version of the app, never the repo.
- P2: a finished prototype becomes a card and a spec draft (the changes and screenshots); one key sends it into the Factory.
- P3: a developer's prototype is real code in a throwaway worktree, made with Matt Pocock's prototype skill. It is an advanced option, a setting tied to the role.
- P4: a prototype runs locally, never against the real site; developers can open anyone's.
- P5: a prototype is versioned: it records the commit it was made on, and reopening it starts the app at that commit locally (a hidden worktree and the repo's pack start script), with no terminal for the product owner.
- P6: prototypes are stored as files on a `prototypes` branch in the repo, linked from the card, never merged.

## Consequences

- Reopening a prototype depends on the repo's pack start script starting the app at any commit unattended.
