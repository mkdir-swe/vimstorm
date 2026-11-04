# Part: checks

Passes when every check in `checks:` passes as serve runs it, in the checks env you judged. Checks need no running app: do them before the app runs ([verify](verify.md)). A team part: on a join a failing one is a warning.

## 1. Pick the checks

From `read.ci` in `abe install status --json` and the workflow files, take the commands CI runs to check a change: tests, types, lint. Leave out deploys and releases.

When `read.kind.checks` lists static checks for the repo's kind (config as code, infrastructure as code: syntax with `node --check`, JSON and YAML parse (`abe check json`, `abe check yaml`), every template placeholder mapped in each environment's mapping file, types, unit tests that need no synth, `terraform fmt -check`), offer them in one `AskUserQuestion` (multiSelect, all recommended). Read already ran each that runs none of the repo's code once on a clean tree of HEAD and dropped those that failed (`read.kind.failing`, each with what it printed): tell the person each as a finding (a placeholder an environment does not map); never write it.

## 2. Judge the checks env

Which environment the checks run with, from evidence in this order: the scripts (`dotenv -e .env.test`, `--env-file`, `NODE_ENV=test`), CI (the env file or env the test job loads), the README. Record it: `abe install checks-env <dev|test> --why "<file:line> <what it says>"`; serve writes it into `abe.yaml` as `checksEnv:` for the team (ADR 0040). With no evidence leave it: dev. An environment off for agents (prod by default) is refused when the checks run (`env-off`).

## 3. Try each as serve runs it

A check counts only as serve runs it: `abe install try --command "<command>"` (Bash timeout 15 minutes) runs it in the main checkout with that environment's Abe env file values and its aws profile's keys (as `abe run --env` gets them), in dev the install's own database, and CI's `NODE_OPTIONS`, and answers pass or fail, its exit and the redacted tail of what it said. Once written, `abe install try <name>`, one check at a time. **Fix a failing check in a subagent**: hand it the check, its tail and this file; it finds the cause (running things in its own shell is fine), fixes what is the install's to fix (an env key, a missing dependency, a database), proves it with `try`, and reports back. What needs the person, it reports, and you ask.

- **Dependencies not installed**: run the lockfile's own install yourself (`npm ci`, `pnpm install --frozen-lockfile`) and say so in one line. Never one that changes the lockfile.
- **A database**: the check gets one from Abe (in dev the install's own `DATABASE_URL`, over the env file's; in test, test's Abe env file's). Never ask for a database URL. When `try` says `no database` (Docker isn't running), start Docker yourself (`open -a Docker`) and try again.
- **A value the Abe env file lacks**: add it to `.abe/abe.<env>.env` when a repo env file on this machine holds it ([env-files](env-files.md)); else name the key and ask the person to add it there.
- **A check that fails on a clean main**: tell the person with its tail, and leave it out.

## 4. Write them

Edit `abe.yaml`:

- `setup`: what installs dependencies in a card's new worktree when its lockfile differs from the checkout's. With the same lockfile Abe links the checkout's packages and runs only setup's other steps (split at `&&`, `;` and lines; a package manager's install left out), so put codegen in a step of its own. With no `setup` it runs the lockfile's own `npm ci`-style install. Its network is the package registries alone: a step that downloads from elsewhere fails there.
- `checks`: `{ name, run }` each, core's names `tests`, `types`, `lint` where they fit. This is the one list of the repo's checks: [skills](skills.md) and [verify](verify.md) take theirs from it.

**Write each command as CI runs it**, never with a flag or variable a workaround needs (`--env-mode=loose`, a `TMPDIR=`).

**The files you write now must agree with each other**: `setup: npm ci` and a "never run npm ci" in `CLAUDE.md` or `verify-<app>` can't both be true.

**Remember each check you leave out, and why** (it failed when serve ran it, a value only the person has): [skills](skills.md) writes it in `CLAUDE.md` as "Not a check yet".

**Write only what you checked.** A fact about the repo (a file there or not, why a check fails) goes in a file only once you looked; a cause you did not confirm is written as unknown ("why: not known").

Then `abe install check checks`: it passes once each check in `checks:` passed when serve last ran it.
