# Part: worktree

Passes when `abe.yaml` has the repo's worktree recipe (`worktree:`) and a throwaway worktree made ready by it has every file it names, with its script passing. A team part: the recipe is checked in with the rest of `abe.yaml`.

Every card runs in a new git worktree: its own, its Before worktree at the merge base, a prototype's, a box workspace's clone. Git puts only tracked files there. Whatever the main checkout has that git ignores or doesn't track is missing, unless the recipe brings it. A missing env file shows up as a check failing on "environment variables are not defined", or a pre-push hook's tests failing.

Abe already brings these without the recipe:

- the team's files as the main checkout has them: `abe.yaml`, `.claude/skills/`, `CLAUDE.md` and `AGENTS.md` (uncommitted changes too, held out of the card's commits);
- the Abe env files of the environments on for agents, linked;
- `node_modules`, linked from the main checkout when the lockfile is the same; otherwise `setup:` (or the lockfile's install) runs with only the package registries reachable.

Nothing else: every other file a worktree needs, env files included (public ones and test ones too), is the recipe's. A file it leaves out is missing in the worktree, and the check warns about an env file that feeds an environment on for agents. The recipe is for the rest:

```yaml
worktree:
  link: [backend/.env, frontend/.env] # untracked files and folders linked from the main checkout
  copy: [.vscode/launch.json] # copied: the worktree's own to change
hooks:
  worktree-setup: abe/scripts/worktree-setup # optional: serve runs it last, outside the sandbox
```

## 1. Find what a worktree lacks

Look in the main checkout for files git ignores or doesn't track that the app, its tests or its hooks read:

- the env files Read found (`read.envFiles` in `abe install status --json`) and how [env-files](env-files.md) mapped them;
- files a script, `docker-compose.yml`, a test config or a git hook loads (`dotenv -e <file>`, `env_file:`, `--env-file`), that `git check-ignore` says are ignored;
- generated files the checks need that no command in `setup:` makes (a codegen output kept out of git).

Leave out what Abe already brings (above), caches, build output and `node_modules`.

## 2. Write the recipe

- **`link`**: env files and anything else that should stay the main checkout's: one edit there reaches every worktree. Link by default.
- **`copy`**: only what a card may change for itself.
- **The script** (`hooks.worktree-setup`, a hook point: ADR 0035): only for what a list can't say: a file made from another, a secret fetched, a second install. Write it at `abe/scripts/worktree-setup`, executable (`chmod +x`), and name it in `hooks:`; with no `worktree-setup` none runs. It runs in the new worktree with `MAIN_CHECKOUT`, `WORKTREE` and `CARD` set, has 10 minutes, and its network is open. On a box `MAIN_CHECKOUT` is empty: the recipe's files reach the box with the Mac's sync, and the script there is the clone's.
- A repo whose worktrees need nothing more still gets `worktree: {}`, so the next person knows it was looked at.

Env files follow the environments on for agents (ADR 0029). `link` and `copy` may be grouped per environment (ADR 0040): `all` every run, `dev`, `test`, `prod` only while that environment is on. The group is where the file goes: [env-files](env-files.md)' `env-map` writes the env files there. A group whose environment is off (prod, by default) is skipped whole, and the setup line names the group. A flat list still works: its env files are placed by the env map on this Mac, and one placed only in environments that are off, or not placed yet, is skipped. List a file anyway when it belongs in the recipe: it goes in once the person turns that environment on.

Paths are from the repo's top: never absolute, never `..`.

## 3. Check it

Run `abe install check worktree`. It makes a throwaway worktree of HEAD outside the checkout, applies the recipe (files, packages linked, the script), checks that each listed path is there, then removes it.

- **Fails**: a listed path the main checkout lacks, a path still absent after, or the script failing (its last lines). Fix the recipe or the script, and check again.
- **Warns**: an env file placed (by `abe.yaml`'s groups, else the env map) in an environment on for agents that no part of the recipe brings. Add it to `link`, or tell the person it is left out on purpose.

## Later: a run stalled on a missing file

When a run stopped on a file its worktree lacked, the fix belongs to the repo, not to Abe. Add the file to `worktree.link` (or `copy`, or the script), run `abe install check worktree`, and tell the person to commit `abe.yaml` (and the script). The next worktree gets it.
