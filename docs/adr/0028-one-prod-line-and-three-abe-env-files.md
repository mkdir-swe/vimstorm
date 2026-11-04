# 0028 · One prod line and three Abe env files

Status: accepted, 28 Oct 2026; its "one line: never write to prod" superseded by ADR 0029 (agents reach only the enabled environments). Supersedes ADR 0027's credentials part (allowed or never per env file, key names only in sessions, a read-only profile for prod). ADR 0027's sources part stands, except that a source's writing tools are no longer denied.

The install's enforcement stopped real work:
- Credentials asked about every env file and mapped files to environments by name. That got a monorepo's dotenv cascade wrong: the base file went to dev only, mixed files were taken whole, and old copies were fed in.
- Sessions were refused reads of the repo's own env files and hundreds of per-tool MCP rules, and a session's settings grew past what Claude Code starts with in time.
- Verify could not save a record or place an order on test, so a run could not prove the change it made.
- A source's sign-in ran in the install session's sandbox, where the browser hand-off broke.

**One line: never write to prod.**
- No session, check or `abe run` writes to prod. Prod is what `.abe/abe.prod.env` names: its hosts and URLs, its database, its keys, and the prod aws profile for write verbs.
- No Layer or Override lifts this line. A Layer value that tries is refused, and the refusal says why.
- Secret values never appear in logs.
- Everything else the person set up is allowed. Sessions read anything, prod included. They write to dev and test. They use every tool of every source.
- A session's settings carry only the prod-write denies, never per-file or per-tool rules.

**Three Abe env files.**
- `.abe/abe.dev.env`, `.abe/abe.test.env` and `.abe/abe.prod.env` sit in the main checkout. Abe's `info/exclude` block keeps them out of git, and they are linked into every card worktree. They replace `.abe/agents.<env>.env`.
- The install's Env files stage prefills them the way the repo's own loaders would: a base file and then a stage overlay, stage-suffixed keys to their environment only, old and empty copies left out.
- Which repo file feeds which environment is a judge kept as a decision. Its evidence comes from scripts, the README, CI, key names and file names, in that order. A file the install can't place is the person's to place.
- The person fills the files in the editor. Sessions may read them. Checks and `abe run` get them, plus short-lived keys from each environment's aws profile, and any profile is accepted.

**Sign-in by serve.** Serve runs a source's sign-in outside any sandbox, in the person's own browser, from the install page. It then checks one read and resumes the install's session.

Considered:
- **Keep allowed or never per file and key names only.** That is what failed. The person already holds these values, and a session that runs the app needs them.
- **No writes to any remote system.** That would stop Verify from proving changes on test.
- **A prod line a Layer can lower.** A team setting could then lift it by mistake. Prod is the one place where a mistake can't be undone by a later card.

Hard to reverse: the three files' paths are written into every checkout, linked into every worktree, and named by every check and run.

28 Oct: skill versions dropped.

Amended by ADR 0040, 2 Nov 2026: which repo file feeds which environment is written into `abe.yaml`, the team's: `worktree.link` / `copy` grouped per environment, `env.notUsed` for files the app never uses. The judgement's evidence and its Not sure stay in the record; the Abe env files and aws profiles stay yours, prefilled from `abe.yaml`'s groups first.
