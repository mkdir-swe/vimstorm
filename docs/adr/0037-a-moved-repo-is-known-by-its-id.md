# 0037 · A moved repo is known by its id

Status: accepted, 1 Nov 2026. Adds to ADR 0031 (`.abe/` is yours alone).

Abe kept a repo's records by its main checkout's path: the install record (its folder named by a hash of the path), each session's and run's `repo`, local mode's held writes and your Layer's `localMode` and `boardReadOnly` lists. Card worktrees point git at the main checkout's path too. Moving or renaming the folder broke all of it, and nothing said so:
- The repo's new folder read "Not set up for Abe yet".
- Its sessions still ran, but the Board and Linked showed no session for its cards.
- Each card worktree read `not a git repository`.
- In local mode, the repo's writes would have gone out for real.

**A repo has an id: `.abe/id` in its main checkout.** serve mints it the first time it meets a main checkout that has `.abe/`. The id moves with the folder, a clone never has it, and it stays out of git with the rest of `.abe/`. serve keeps where it last saw each id, in `<state>/repos.json`.

**Every request's folder is looked at once.** It is checked again only after the main checkout it was in is gone. Looking at a folder gives one of these (core's `sighting`):
- **known**: the id was last seen here.
- **new**: no id yet (one is minted), or an id never seen before (it is kept).
- **copy**: the id was last seen at a folder that still holds it. This folder gets an id of its own, and nothing moves.
- **moved**: the id was last seen at a folder that is gone, or that now holds another id.

**A moved repo is followed before the request goes on**, one move at a time:
- `git worktree repair` runs in the new folder. Each worktree's session hooks (`core.hooksPath`) then point into the new git folder.
- The install record moves to the new path.
- Each session's and run's paths are rewritten. A card worktree beside the old folder (`<old>-wt/…`) keeps its path.
- Local mode's held records and your Layer's `localMode` and `boardReadOnly` lists name the new path, so its writes stay held.
- The Abe chat's Claude Code conversations move to the folder Claude Code reads for the new path.

**A card worktree whose repo is gone** is looked at the same way. The repo is searched for beside where it was, by its id: a rename is the usual move. If it is not there, that is said, and nothing is guessed.

**It is said once, never silently.** The `repo.moved` event says what followed and what did not. The bridge shows it as a balloon. When something did not follow, or the repo was not found, the balloon needs you and stays. It also tells the window, which moves the repo's Recent Projects entry to the new folder.

Considered:
- **Find the moved repo by its origin URL.** Two clones of one origin are two checkouts. A repo with no origin, or a local one, has nothing to go by.
- **Key every record by the id instead of the path.** Every reader in serve, the bridge and the window takes a path today. The path is what a session runs in and what the person opens. Rewriting the paths once, at the one place a request comes in, keeps every reader as it is.
- **Search the disk for the repo.** That is a guess, and it is slow. Only the folder the repo was in is read, and only an id confirms a match.

Known limits:
- A session that runs while its repo moves keeps the sandbox it started with until it is relaunched.
- A prototype's records keep the old path.
- A repo moved somewhere other than beside where it was is found only once it is opened there.
- Card worktrees that moved too are not followed.
