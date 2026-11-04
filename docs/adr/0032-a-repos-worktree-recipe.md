# 0032 · A repo's worktree recipe

Status: accepted, 28 Oct 2026. Builds on ADR 0029 (agents reach only the enabled environments) and ADR 0031 (the team's file is `abe.yaml`).  Since 31 Oct the recipe is the only rule: Abe no longer brings env files of public keys or named for tests by itself; the Worktree part writes an older install's into `link` once.

Every card runs in a new git worktree, which has only what git tracks. Runs stalled on what the main checkout had and the worktree lacked:
- Untracked team files (`abe.yaml`, `.claude/skills`, `CLAUDE.md`) not committed yet: a run had no checks, and a Before worktree had no `.claude`.
- Git-ignored env files the tests read (`backend/.env`): a pre-push hook's tests failed on missing variables, and the agent linked them by hand.
- Abe's own rules copied only env files with public keys or named for tests. Anything else needed a change to Abe.

**The repo says what a new worktree needs: `worktree:` in `abe.yaml`.**
- `link`: untracked files and folders linked to the main checkout's. `copy`: copied, the worktree's own to change. `run`: a script of the repo's (`abe/scripts/worktree-setup`), run last by serve in the new worktree, outside the sandbox.
- It is the team's, checked in with the rest of `abe.yaml`. The install writes it (part `worktree`, required: every repo has worktrees; `worktree: {}` when the defaults are enough) and checks it on a throwaway worktree.
- When a run stalls on a missing file, the repo's Abe chat edits the recipe or the script. Nothing in Abe changes, and nothing names a repo.
- `abe.yaml`, `.claude/skills`, `CLAUDE.md` and `AGENTS.md` come without being listed, as the main checkout has them. `node_modules` stays linked from the main checkout when the lockfile is the same.

**Env files follow the environments on for agents.** A listed env file that the install's env map places only in environments off for agents (prod, by default), or not placed yet, is skipped, and the setup line says why. This is ADR 0029's rule for what a session may read, applied to what it gets. Nothing else about a listed file is judged: the steps are open.

**One recipe, everywhere a worktree is made:** a card's worktree, its Before worktree, a prototype's place, and a box workspace. A box has no main checkout: the Mac's sync (3.2.1) carries the listed files and the script from the Mac's main checkout, at launch and before a turn when they changed, and the box runs the clone's script after its setup.

Considered:
- **More built-in rules in Abe** (copy every env file, or every ignored file). Each repo differs; rules that fit one leak secrets or miss files in another, and each fix needs a release of Abe.
- **Only a script.** A list says plainly what a worktree gets, so the install can check it and the setup line can say it. The script is for what a list can't say.
- **Run the script in the sandbox.** It fetches and installs what the sandbox keeps out, and it is the team's own code, reviewed like the rest of the repo.

Known limits:
- The script runs with its network open, as serve. Its output may be shown on the setup line and at Needs you.
- A linked file is the main checkout's: an edit in a card is an edit there, where the sandbox lets it write at all. What a card should change for itself goes in `copy`.
- On a box, a file the clone tracks is never replaced by the recipe, and a sync carries at most 2000 files and 32 MB of them.

Amended by ADR 0035, 31 Oct 2026: the recipe's script is the `worktree-setup` hook point (`hooks:` in `abe.yaml`); `worktree.run` is read as it where `hooks:` names none.

Amended 1 Nov 2026: migration removed: no install predates it (the Worktree part writing an older install's env files into `link`).

Amended by ADR 0039, 2 Nov 2026: a prototype's worktree on this Mac clones the main checkout's `node_modules` (copy on write) instead of linking them, and runs the lockfile's install only when its manifests differ.

Amended by ADR 0040, 2 Nov 2026: `link` and `copy` may be grouped per environment (`all`, `dev`, `test`, `prod`); the group is the file's env placement and replaces the env map for it, a group off for agents skipped whole and named on the setup line. A flat list keeps the env map's rule.
