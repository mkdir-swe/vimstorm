# 0035 · A repo's hook points

Status: accepted, 31 Oct 2026. Generalises ADR 0032's `worktree.run`. Builds on ADR 0029 (agents reach only the enabled environments), ADR 0031 (the team's file is `abe.yaml`) and ADR 0034 (what Abe ships and the repo owns).

Abe called a repo's files by paths written into its code:

- the app's scripts in `.claude/skills/run-app/scripts/` (`start`, `stop`, `seed`, `db`, `query`);
- a prototype's in `abe/scripts/` (`prototype-start`, `prototype-stop`) and the worktree recipe's `worktree.run`;
- the testing skill (`*-testing`) and the Verification pack (`verify-<app>`) by name;
- the headings the install checks (`CLAUDE.md`'s `## Find out before you ask`, run-app's `## Read data`) by regex.

A repo whose app already starts from `scripts/dev-up` had to move it. Each path was a hidden contract, and a box's `abe run` allowlist was a regex over the same paths.

**The repo declares its hook points: `hooks:` in `abe.yaml`.**

- One flat map of roles: the scripts `start`, `stop`, `seed`, `db`, `query`, `prototype-start`, `prototype-stop`, `worktree-setup`; the skills `run-app`, `testing`, `verify`; the headings `find-out`, `read-data`.
- A role left out is today's place. A repo that declares nothing runs as before: `worktree-setup` none, any `*-testing` skill, any `verify-*` pack's helpers.
- An older recipe's `worktree.run` is read as `worktree-setup` where `hooks:` names none.
- It is the team's, like `worktree:`; Settings shows each role as a row.
- Abe calls a role, never a path: `core/src/repo-hooks/` is the one module that knows the places.

**What an agent may run comes from the committed `abe.yaml`.**

- An agent's `abe run` takes a role's script (by role or path), the run-app skill's `scripts/`, or the pack's `scripts/`. Never the worktree's own script.
- The map for it is read on the Mac from the main checkout's `HEAD:abe.yaml`, never a working copy: a card's agent can write its worktree's, and a box clone's is the agent's.
- The Mac hands that map to a box with each sync (launch and turn). The box keeps it beside its workspaces and builds its allowlist from it only. A Mac session's `abe run` reads the same map, so Mac and box agree.
- What serve runs itself (a prototype's start, the database hook, the seed, the worktree's script, the install's checks) reads the main checkout's `abe.yaml` as the other settings do.

Considered:

- **Read the allowlist from the clone's `abe.yaml` on the box.** The agent writes the clone: it could name any file and run it outside the sandbox.
- **The Mac's working copy, handed.** An uncommitted edit the Abe chat or a card made in the main checkout would widen what every agent may run, unreviewed.
- **Nested maps (`scripts:`, `skills:`, `headings:`).** Settings draws one level of fields as rows; a flat map needs no new input kind.

Known limits:

- A declared path takes effect for agents only once committed; until then they run today's place.
- A sync carries each hook script's folder with the team's files, so a script moved to `scripts/dev/` brings that folder's uncommitted changes too.

Amended 1 Nov 2026: migration removed: no install predates it (`worktree.run` read as `worktree-setup`: the recipe has no `run`).
