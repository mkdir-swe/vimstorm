# 0038 · Abe leaves card comments to you

Status: accepted, 2 Nov 2026.

Abe wrote comments on the card by itself as a run went:
- a step's report when an `ends:` ended the run, with its spike's link;
- `Pull request: <url>` when the pull request opened;
- the why when a person ended the run (`abe factory end`);
- an Override's line;
- a Sheet's link line when it was attached.

The skills told agents to add more: the spec issue's link and the tickets' list. On Azure Boards each of these is a comment the team reads, written in the person's name, that they did not write or ask for.

**A card's comments are the person's.** Abe writes one only when the person asks for it: Comment… (`abe card comment`), triage asking its needs-info cards (`abe triage apply`), or an agent the person told to comment. A repo that keeps its specs on the card (`spec.where: card`) has asked for that comment too.

**Every other write that was a comment is gone, not moved.** Each says so in its answer: `not commented: Abe leaves card comments to you` (core's `NOT_COMMENTED`). Where the words went instead:
- A step's report stays with the run, on its Run page. Its spike is still pushed and kept on the run.
- The pull request carries the card in its body (`Card: AB#<id>`), so GitHub links the two. An Override's note and the run's end still go on the pull request.
- An attached Sheet is listed by `abe card show`, from the org store.

**Agents are told the same.** Every session's instructions say a card's comments are the person's. A skill step that says to comment on the card otherwise is skipped, and the words go in the step's report. This covers a repo's own copy of a skill, which Abe does not rewrite.

A board on this machine (`board.provider: local`) follows the same rule. Its comments never leave the Mac, but one rule is simpler than two.

Considered:
- **Keep the comments, behind a setting.** It is a default nobody asked for, and a setting is one more thing to find. The comments a person wants they write, or ask Abe for.
- **Refuse `abe card comment` from a session.** The person could no longer tell an agent to comment.

Known limits:
- A later run no longer finds an earlier run's spec or pull request through the card's comments. It finds them only in its own run record, or in comments people wrote.
- The wayfinder skill still keeps its map and tickets as card comments when its tracker is the board. The person runs it and picks the board.
