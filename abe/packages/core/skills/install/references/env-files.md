# Part: env-files

Passes when `abe.yaml` places each of the repo's env files (its `worktree:` groups, its `env.notUsed`), the three Abe env files exist, and each environment has an aws profile or none. Prod stays off for agents unless the person turned it on. Where each env file goes is the team's (ADR 0040): the env map is written into `abe.yaml`, so a teammate's install reads it and is not judged again. The Abe env files and the aws profiles stay the person's own: on a join they are theirs to make, prefilled from `abe.yaml`'s groups with no env map to judge.

The Abe env files hold this repo's values per environment: `.abe/abe.dev.env`, `.abe/abe.test.env`, `.abe/abe.prod.env`, in the main checkout. `.abe/` is always kept out of git; serve links them into every card worktree. `abe run` hands a script dev's values (`--env test` for test's; prod only once the person turned it on for agents), and the checks the environment [checks](checks.md) records, each with its aws profile's short-lived keys.

You read and edit these files directly. Key names only: never print, quote or commit a value.

Run steps 1 to 3 in a subagent: hand it this file, and have it report the mapping it recorded, the files it was not sure of, and the keys each environment still lacks. On a join whose `abe.yaml` groups the env files already, skip them: `abe install check env-files` prefills the Abe env files from those groups.

## 1. Find the repo's env files

`read.envFiles` in `abe install status --json` lists the env files Read found at the top and in the workspaces. Look for any other file a script names too. Read each, values included.

## 2. Judge each file, evidence in this order

1. **Scripts and commands**: package.json scripts, Makefile, compose `env_file:`.
   - `dotenv -e <file>` loads that file.
   - `dotenv -c <stage>` loads the cascade `.env`, `.env.local`, `.env.<stage>`, `.env.<stage>.local`.
   - `node --env-file=<file>` loads that file. So does `-e .env.aws.dev`.
   - A base file that every stage's cascade loads feeds every stage that loads it.
2. **Docs**: README and CLAUDE.md lines about env setup.
3. **CI**: a job's `environment:`, `STAGE:` or `target_environment`, and which example CI copies. A copied example is a fixture, not an environment.
4. **Key names**: `STAGE`, `APP_ENV`, the `_DEV`, `_TEST` and `_PROD` suffixes, `AWS_*` (credentials).
5. **File names**: `.env.dev`, `.env.test`, `.env.prod`. The weakest evidence: use it only when nothing above says otherwise.

Give each file one of:

- the environments it feeds (`dev`, `test`, `prod`, any of them), with the evidence: its file and line, and what that line says;
- `not-used`, with why: an old copy (`.old`, `.bak`, `.orig`), a credentials file an aws profile replaces, a unit-test fixture, an example;
- `not-sure`, with why: it feeds more than one stage and no cascade says which, only a value could tell, or its name and the scripts disagree. The subagent reports it; you ask the person where each goes (`AskUserQuestion`: your best guess first, then dev, test, prod, Not used, **Not sure: find out**), then map it as they said.

Don't split a mixed file yourself: serve sends each `_DEV`, `_TEST` and `_PROD` key to its own environment, and leaves out empty files, old copies and the aws keys a profile covers.

## 3. Prefill with env-map

Map every file in `read.envFiles`, in load order (a base before its overlay; the last file that sets a key keeps it). serve writes the mapping into `abe.yaml` (below) and the three files from it the way the repo's loader would:

```
abe install env-map \
  --file "backend/.env -> dev,test,prod: backend/package.json:11 dotenv -e .env -c dev" \
  --file "backend/.env.dev -> dev: backend/package.json:11 dotenv -c dev" \
  --file "backend/.env.test -> test: backend/package.json:12 dotenv -c test" \
  --file "backend/.env.dev.old -> not-used: an old copy"
```

A repo that keeps its environments only in CI (GitHub Environments, repo variables) has no env files: record where CI keeps them and CI's key names, never values. Each environment no file feeds gets a header naming CI's keys. One call may have both `--file` and `--ci`.

```
abe install env-map --ci ".github/workflows/deploy.yml:47 environment: dev|test|prod" --ci-key STAGE --ci-key AUTH_DOMAIN
```

Calling `env-map` again replaces the mapping and writes Abe's blocks again. Each block runs from `# --- from <file> · <evidence>` to `# --- end <file>`.

What lands in `abe.yaml` (the team's, committed with the rest): each placed file in `worktree.link` grouped by environment (`copy` when the recipe copies it), and each `not-used` one in `env.notUsed` with its why. A file feeding every environment goes in `all`. A `not-sure` one stays out of the groups until the person places it. The evidence stays in the Abe env files' block heads and the record on this Mac, never in `abe.yaml`.

```yaml
worktree:
  link:
    all: [backend/.env]
    dev: [backend/.env.dev]
    test: [backend/.env.test]
    prod: [backend/.env.prod] # only while prod is on for agents
env.notUsed:
  - { key: backend/.env.dev.old, why: an old copy }
```

The group is the file's placement: a `prod:` group never turns prod on (ADR 0029), it only says the file is prod's. An `abe.yaml` edited by hand is read the same way.

## 4. Finish the files yourself

- Trim and fill each file: the keys the app and the checks need, for that environment. Your own edits go outside Abe's blocks (an `env-map` call rewrites the blocks); a key set outside a block is left out of the blocks.
- **Never ask for `DATABASE_URL`**: [checks](checks.md) and [verify](verify.md) get their own database from Abe.
- A value no file on this machine holds (a secret only the person has): name the key and the file, and ask them to add it there. Never ask for a value in chat.

## 5. Each environment's aws profile

When the repo uses aws, each environment needs its profile, or none: `abe install env-profile <dev|test|prod> <profile|none>`. It is kept in `.abe/settings.local.yaml` (`credentials`), names only. Which profile is an up-front question ([logins](logins.md)).

Then `abe install check env-files`.
