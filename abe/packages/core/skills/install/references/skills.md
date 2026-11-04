# Part: skills

Passes when the repo's testing skill and `CLAUDE.md` are written. Skills need no running app: do them before the app runs ([verify](verify.md)). A team part: on a join a failing one is a warning.

Both are ordinary changes in the repo, for the person to review in `git diff` and commit: never commit them, never exclude them.

1. Write the repo skill `.claude/skills/<repo>-testing/SKILL.md`: how this repo is tested (where tests sit, the test commands, fixtures and fakes, what a good test asserts here). Harness-neutral words.
2. Write `CLAUDE.md`, short: what the repo is, how to run and check it, where things live. A `CLAUDE.md` already there keeps every line it has: add yours, edit only lines the install wrote.
   - When `read.kind.runs` in `abe install status --json` is not false: the app runs with `abe run start` and stops with `abe run stop` ([verify](verify.md) writes the `run-app` skill: `.claude/skills/run-app/`); never name the script itself as the way to run it.
   - When it says nothing runs here, name no start script (none is written): say "nothing runs here: see the Verification pack" (`.claude/skills/verify-<app>/`).
   - [done](done.md) corrects that line when no script was written in the end or the app was not run.
   - **`## Find out before you ask`**: a short section so a session settles what the code, the data and the sources can before it asks the person. Exactly this, filled in:

     ```markdown
     ## Find out before you ask

     - Data: `abe run query <file.sql> [--env test]` runs one read-only statement against the app's database; files in `.scratch/<card>/` (run-app's `## Read data`).
     - Sources: <each `sources:` name in `abe.yaml`, with what it reads: Sentry (org `demo-shop`), ConfigCat (feature flags)>.
     - When the data shows the bug, fix it: take the recommended answer to a question the code or the data settles, and write the assumption in the pull request.
     - Prod: off for agents unless turned on for the repo or the run. When only prod data can answer: with prod on, read it with `abe run query <file.sql> --env prod`; with it off (`env-off`), write the query that would settle it in the report or the pull request. Never ask for prod access.
     ```

     - **Data**: the line above only when [verify](verify.md) wrote the `query` script; skills come first, so come back to this line once verify answered the database question. Else say what is missing: "Data: no query route: the app has no database", or "Data: no query route yet: <why, from verify>", and in the Prod line, write the query in the report or the pull request whatever prod is.
     - **Sources**: by name from `abe.yaml` `sources:`, each with its account as `abe install connection` read it (`Org`, `Project`), never a token. None: "Sources: none".
     - The last two lines as they are.

3. `AGENTS.md`: when the repo has none, make it a symlink to `CLAUDE.md`. An `AGENTS.md` already there, a file or a link, stays exactly as it is: your lines go in `CLAUDE.md`.
4. **Take the checks from one list**: `checks:` in `abe.yaml`. Name a check in `CLAUDE.md` and the testing skill only from it, with its command. A check the repo has and the list leaves out (CI's formatter, which failed when serve ran it) goes on a line of its own in `CLAUDE.md`: "Not a check yet: `<command>` (<why>)", the why from [checks](checks.md).
5. **Check the files agree.** Read `abe.yaml` (`setup:` and each `checks:` command) and `verify-<app>`, when written, beside what you wrote. A command those run (`npm ci` in `setup:`) must not be in a "never run" list in any of them. When they conflict, ask the person which is true and fix the file that is wrong.

**Write only what you checked.** A fact about the repo (a file there or not, why a check fails) goes in a file only once you looked in the repo; a cause you did not confirm is written as unknown ("why: not known"), never as a fact.

**Session-only words stay out of the files.** What the person told this session for this session only (a limit like "never run X", "don't touch Y", "reads only") limits you now. It is not a fact about the repo: never write it into `CLAUDE.md`, the testing skill or any other file, unless they say to keep it.

Then `abe install check skills`. Its line names a file missing (`no-testing-skill`, `no-agent-notes`), `CLAUDE.md` without `## Find out before you ask` (`no-find-out`), or a check named outside the list.
