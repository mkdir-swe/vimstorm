# Part: verify

Passes when the app runs locally through the gate (or the person chose "can't run here"), the Verification pack exists and proves a mapped feature, and the checks pass again after the pack is written. A team part: on a join a failing one is a warning.

## Run it locally: the gate

The gate: the app answers on localhost from the checkout via `.claude/skills/run-app/scripts/start`, and every backend it talks to is local, a shared test environment (test databases) or a provider's sandbox. Any prod target fails it.

**Nothing to run here** (`read.kind.runs` false in `abe install status --json`): the repo's kind (config as code, infrastructure as code, a library, a CLI) has nothing to serve on localhost, so there is nothing to run: no scripts, no app started, no gate. Don't invent a server to pass a gate. When the kind is wrong (it does serve an app), tell the person with the files that say so.

### Never run

- **What needs a login that is not ok.** While [logins](logins.md) has aws not ok or skipped, aws is off: never run a repo script that calls aws, `aws sso login`, or a credentials script `read.awsProfiles` names, neither yourself nor through `abe run`. Write `start` without it when the app can run so; else write it, leave it unrun, and tell the person what it needs.
- **What writes real systems** (`read.outward`: a deploy, an import, a sync, a secret or variable set, `a0deploy`, `terraform apply`, any `cdk` command (synth and diff load the env and may call aws too), a `curl -X POST` to a host not on this machine), neither by its package script nor by the command itself, unless the person says so for that one run.
- **Cloud credentials in an env file** (`read.cloudCredentials`: `.env.aws.dev` from `aws configure export-credentials`) reach a real cloud account with those keys. A `start` may load one (`dotenv -e`, `source`, a compose `env_file:`) only when the person wants the app run against that account: the gate passes it with a warning naming the file and the script.

### 1. Write the scripts

The app's scripts are the team's: they live in the repo's `run-app` skill, an ordinary change for the person to commit. Each is a hook point Abe calls by its role (`start`, `stop`, `seed`, `db`, `query`); a repo whose app already starts from a script elsewhere names it in `abe.yaml`'s `hooks:` (`start: scripts/dev-up`) instead. Write `.claude/skills/run-app/scripts/start` (starts the app in the background, prints its URL as the last line), `stop` and `seed` (test data for an empty database) there, and `.claude/skills/run-app/SKILL.md` (frontmatter `name: run-app` and a `description`): how the app runs locally (`abe run start`, `abe run seed`, `abe run stop`; never the scripts themselves), its port rule, the backends it talks to and how each is reached (never a value). Cards' sessions run the scripts too, inside their sandbox, so write them for it:

- Copy this skill's `scripts/ports.sh` to `.claude/skills/run-app/scripts/ports.sh` as it is, and source it from `start` and `stop` (its head shows how). Its port checks need `lsof`: without it they are off and both scripts say so; tell the person.
- `start`: `abe_run_start` first (the run's process group kept in `.abe/.run/pgid`); each part started with `&` from the script itself (never `setsid` or `set -m`), its output to `$ABE_RUN/<part>.log`, so it and its children stay in the process group `abe run` gives it. Before a part, `abe_port_free <port> || exit 1`: a port something holds already fails, saying what holds it (a server an earlier run left: `abe run stop`). After it, `abe_bound <port> || exit 1`: it waits until this run's own server listens there, and only then prints the URL as the last line. Never print the URL of a server that did not bind.
- `stop`: `abe_stop` ends the whole process group (TERM, up to 5 s, KILL), then each port the run bound: what still holds it is ended only when it is the server start saw or descends from it (a shim like Volta's node forks the real server apart, so its pid from `$!` is not the server's); anything else is said, never killed. Never `pkill -P` or only the pids `start` saw: a watcher's children (`tsx watch`, vite, `next dev`, npm's) outlive their parent and keep the ports. Never call `ps` (setuid, which a card's sandbox refuses); `ports.sh` reads groups and parents with `lsof`.
- **Ports** come from `ABE_PORT_BASE` (the app's port is `ABE_PORT_BASE`, others count up from it). When `ports.fixed` has ports (`ports.rule` and `ports.why`: an auth callback registered at a provider, or the repo's own dev port because its sign-in redirect is the page's origin, `read.originAuth`), keep those ports as the repo has them and say so in the start script's comment: one run at a time. Moving such a part breaks its sign-in.
- **Docker compose**: `start` may run `docker compose up -d` (and `stop` its `down`). `abe run` hands it the card's own project (`COMPOSE_PROJECT_NAME`; never pass `-p`), so each card has its own containers and data. It runs on the local Docker only: a remote `DOCKER_HOST` or docker context is refused `compose-not-local`; tell the person.

### 2. The database

Abe hands every session and prototype its own `DATABASE_URL`; never ask the person for one. A Postgres app needs no more when the repo's env example (`.env.example`) or `abe.yaml` names `DATABASE_URL`: Abe's local database gives each run its own database, which `seed` fills. With neither, add a comment to `abe.yaml` naming it (`# the app reads DATABASE_URL`). Write `.claude/skills/run-app/scripts/db` only for another engine, or for a shared test database the app must use: `start` makes or names it from `ABE_DB_NAME` and prints its URL as the last line, `stop` ends it.

### 3. What start loads

`start` takes its values from what Abe hands it: `abe run start` hands it the dev Abe env file's values (`.abe/abe.dev.env`) and its aws profile's short-lived keys, plus `DATABASE_URL` and `ABE_PORT_BASE`; `abe run start --env test` hands it test's. Besides those, it loads only env files git tracks (a test's fixture) and ones whose every key is public (`VITE_`, `NEXT_PUBLIC_`, `PUBLIC_`, `REACT_APP_`, `EXPO_PUBLIC_`, or the `envPrefix` the repo's vite config declares). A key the app needs that the Abe env file lacks goes into it ([env-files](env-files.md)).

The gate judges what `start`'s commands load, its package scripts followed: the env files they name (`dotenv -e backend/.env.dev`, `source`), a dotenv cascade (`dotenv -c dev`), a framework's own (vite, next: the folder's `.env*`), dotenv loaded in the code `start` runs, and what Abe hands it. An env file nothing loads is listed `not loaded by start`, not judged. When one points at prod (`.env.prod`, a prod host) beside a command that names no env file, have `start` load its env files by name, never a prod one. It also reads what `start` sets, sources and the configs it names or writes (`config.generated.json`): a host there passes only on this machine, or when the person says it is a test backend. Point `start` at a stand-in on this machine rather than a real tenant or backend. A comment loads nothing and is not read: never reword a comment or rename a file so the gate stops seeing what start loads.

### 4. Run it and the gate

Start it through `abe run start` (with the database and ports a session gets), never the script itself, then run the gate with the URL it printed:

```
abe install gate --url http://localhost:4100
```

`abe run start` judges what start loads first. While a backend is neither on this machine nor a test one, or start loads cloud credentials, it starts the app all the same and prints a warning first (`warning, started all the same: …`). Show the person the warning as it is, at once.

When the gate stops on a key or host, ask the person which is true (`AskUserQuestion`): not used by the app (`--not-used "<key>: <how you know>"`, the evidence named: the code that never reads it), a test backend (`--test-host <host>`, only when it truly is one), prod the app only reads from (`--read-only-host <host>`), or change it. Record it with `abe install gate --before-run` and those flags, then run the gate again. serve writes each answer into `abe.yaml` (`gate.testHosts`, `gate.readOnlyHosts`, `env.notUsed`: ADR 0040), so every card run of the repo and every teammate's install knows it too. Never give an answer that isn't true to get past the gate; when none is, stop and say so.

When it passed, **start the Verification pack at once** (below), in the background, while you go on with the person; the pack's subagent starts and stops the app itself. Stop an app you started with `abe run stop`, never the script itself or `kill`.

### 5. When it can't run here

The app needs what is not on this machine: a login the person skipped, values only they have, or a port held by a process the person keeps running (never stop it). Say so instead of working around it, and ask with `AskUserQuestion`: **I'll add it** (they sign in, add the values or free the port; then start it again and run the gate) or **Can't run here**. On Can't run here, record it: `abe install gate --cannot-run "<why>"`, one plain sentence about the app, not addressed to the person and no instruction: "it needs a VPN login to the orders API", "port 3000 is held by another process (pid 54387) kept running". The pack then says what was not run and why. Keep the scripts you wrote.

## Read data: the query script

Agents settle a question from the data before they ask the person: how many orders have no total, which rows a bug left behind. Give them one read-only way in.

**Ask** (`AskUserQuestion`): does the app have a database the agents should read? Preselect **Yes** from evidence, naming where it was seen: a drizzle, prisma or knex config, an ORM's models, `DATABASE_URL` or a db host in an env example, a postgres or mysql service in a compose file, a SQLite file the app opens. Then **No**, and **Not sure: find out**. Nothing runs here (`shaped.nothingToRun`) and no database seen: don't ask.

On **Yes**, write `.claude/skills/run-app/scripts/query` (executable) and the script it runs. A session runs `abe run query <file.sql> [--env test]`, which hands it that environment's Abe env file values and its aws profile's short-lived keys, as it hands `start`; dev's `DATABASE_URL` is the session's own database, test's and prod's come from their env files. `--env prod` works the same when prod is on for agents (else `abe run` refuses it `env-off`): the session is read-only there too.

- **One statement per file**, `SELECT`, `WITH` or `EXPLAIN` only: comments stripped, one trailing `;` allowed, any other `;` refused. A second statement could `COMMIT` and end the read-only transaction.
- **The guard runs first.** Load the app's db config after it, with a dynamic `await import(...)` inside `main`, never a top-level import: imports hoist, and a config that reads env vars at load would run before the guard. A refused file loads no config and reaches no database.
- **Read-only by the database**, never by trusting the file (a `WITH` can delete; `EXPLAIN ANALYZE` runs its statement):
  - Postgres: connect with `default_transaction_read_only=on` (`options: '-c default_transaction_read_only=on'`) **and** run the statement inside `BEGIN READ ONLY`, then `ROLLBACK`.
  - MySQL: `SET SESSION TRANSACTION READ ONLY`, then `START TRANSACTION READ ONLY`; never `multipleStatements`.
  - SQLite: open it read-only (`mode=ro`, bun's `{ readonly: true }`), and `PRAGMA query_only = ON`.
- **The app's own connection**: reuse its db config or connection helper and its driver, from the package that owns them, so the query gets the credentials the app gets (an IAM token, a secret read at start). Never a second way to the database.
- **aws**: unset `AWS_PROFILE`, so the SDK takes the keys `abe run` handed.
- **Output**: the rows as JSON on stdout, the row count on stderr; a refusal or the database's error on stderr, exit non-zero. A connect timeout (10 s) says what this repo needs to reach it (`connect timeout: the test database is reached over the VPN`) when you know it.

The shape, for a demo-shop whose `packages/db` owns the Postgres config:

```sh
#!/bin/sh
# abe run query <file.sql> [--env test]: one read-only statement, rows as JSON on stdout
set -eu
[ $# -eq 1 ] || { echo "usage: abe run query <file.sql> [--env test]" >&2; exit 2; }
case $1 in /*) file=$1 ;; *) file=$PWD/$1 ;; esac
here=$(cd "$(dirname "$0")" && pwd)
unset AWS_PROFILE # the SDK takes the keys abe run handed
cd "$here/../../../../packages/db"
exec node --experimental-strip-types --no-warnings "$here/query.ts" "$file"
```

```ts
// query.ts: the guard first; the app's db config loads only after it
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const fail = (why: string): never => {
  process.stderr.write(`query: ${why}\n`);
  process.exit(2);
};

const main = async (): Promise<void> => {
  const file = process.argv[2] ?? fail('usage: abe run query <file.sql> [--env test]');
  const sql = readFileSync(file, 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
    .replace(/;\s*$/, '');
  if (sql === '') fail(`${file} holds no statement`);
  if (sql.includes(';')) fail('one statement per file: no ; inside it');
  if (!/^(select|with|explain)\b/i.test(sql)) fail('SELECT, WITH or EXPLAIN only');

  const pkg = `${process.cwd()}/`;
  const { dbConfig } = (await import(`${pkg}src/config.ts`)) as {
    dbConfig: () => import('pg').ClientConfig;
  };
  const { Client } = createRequire(`${pkg}package.json`)('pg') as typeof import('pg');
  const client = new Client({
    ...dbConfig(),
    options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: 10_000,
  });

  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const r = await client.query(sql);
    await client.query('ROLLBACK');
    process.stdout.write(`${JSON.stringify(r.rows, null, 2)}\n`);
    process.stderr.write(`${r.rows.length} rows\n`);
  } finally {
    await client.end();
  }
};

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
```

Write it in the repo's own language, module kind and style (its lint covers it), with its own driver and config.

**Test it once, here**, against the dev database `abe run` hands (seeded with `abe run seed`), with three files in `.scratch/install/query/`:

1. a read that returns rows (`select count(*) from <a table seed fills>`): JSON on stdout, its count on stderr;
2. a write the guard lets through and the database refuses (Postgres: `with d as (delete from <table> returning 1) select count(*) from d`; SQLite or MySQL: `with x as (select 1) insert into <table> select …`): the database's read-only error, and the row count unchanged after;
3. two statements (`select 1; delete from <table>`): refused before anything loads.

All three must hold; fix the script until they do. When the app can't run here, write it all the same and say it was not tested.

**Document it** in run-app's `SKILL.md`, under `## Read data`:

- the command: `abe run query <file.sql> [--env test]` (and `--env prod` when prod is on for agents), one read-only statement a file;
- where query files go: `.scratch/<card>/` (never committed);
- "Count and aggregate; print no customer personal data.";
- what a connect timeout means for this repo (the VPN, a tunnel), or "not known".

On **No**, write no script; [skills](skills.md) says in `CLAUDE.md` that no data route is set up.

## The Verification pack

The **Verification pack** is the repo's own skill `.claude/skills/verify-<app>/`, an ordinary change for the person to commit: `<app>` is the checkout folder's name, lowercase, any other character a dash (`verify-demo-shop` for `demo-shop`). Every card's Verify drives the app through it, and maintain-verification-skill keeps it true when a card changes a mapped feature.

**Start it in a background subagent as soon as the app runs locally** (the gate passed), with this file and the create-verification-skill skill, and go on with the other parts while it works. It writes the pack, maps the features, proves one, runs the checks again and reports back. What needs the person, it reports, and you ask.

### 1. Write the pack

Use the create-verification-skill skill, on this checkout. These choices are made for it:

- **Launch**: the app starts with `abe run start` and stops with `abe run stop` (the `run-app` skill's `start` and `stop`), seeded with `abe run seed`; never another way. Cards' sessions run in a sandbox: an app started in their own shell is gone by the next command, and no browser starts there.
- **Drive**: a web app is driven by headless Playwright with its own browser, against the local app only (the URL `abe run start` printed, on localhost or 127.0.0.1); never a deployed, shared or prod host. Ship the drive as the skill's own helper, `.claude/skills/verify-<app>/scripts/<name>` (executable, its invocation in the skill body), run through `abe run .claude/skills/verify-<app>/scripts/<name> <args>`. Pin its Playwright version (the repo's own when it has one), installed by the helper into a cache outside every checkout (`~/.cache/abe-verify-<app>/playwright-<version>`), never the repo's `node_modules` nor another checkout's. A surface that is no web app (a CLI, an API) is driven as create-verification-skill says, through `abe run` the same way.
- **Surface**: the skill's frontmatter says the app's under `metadata:` as `surface: web`, `cli` or `api` (none: web). A feature driven another way declares its own in its feature file's front matter: in a web app's pack, each API endpoint feature driven over HTTP with no browser starts with `---\nsurface: api\n---`, a CLI command's with `surface: cli`.
- **Evidence**: each driven `web` feature keeps a screenshot (`.png`) and a recording (Playwright's `recordVideo`, `.webm`); a feature with no UI (`cli`, `api`) keeps a text transcript (`.txt`, `.log`, `.cast`, a response as `.json`) or a screenshot, a recording optional. They go in the folder its caller names: `.scratch/<card>/verify/evidence/<feature>/` in a card's run, `.scratch/install/verify/<feature>/` here. Both stay out of git. Cleanup never removes them.
- **Isolate**: two cards verify at once, each with its own browser and data. `abe run` hands each card's scripts its own compose project (`COMPOSE_PROJECT_NAME`; never pass `-p`), its own database (`DATABASE_URL`) and its own port base (`ABE_PORT_BASE`). A host port a compose service publishes comes from `ABE_PORT_BASE` (`"${DB_PORT}:5432"`, set by `start`) or is not published, never a fixed number: two cards at once would clash on it. Compose runs on the local Docker only (`compose-not-local`). On a box the workspace has no Docker: a script's `docker compose` goes to the box, which joins the workspace to its network, so the app reaches each service by its name (`db:5432`), not on localhost; name paths relative to the compose file, or a named volume (`compose-path-outside`). One runner per run: never two browsers or two instances in one run (`one-runner`).
- **Data**: what `abe run` hands the scripts (the session's database, the dev Abe env file's values, `--env test` for test's); writes to dev and test are fine, never to prod.
- Skip its maintenance offer: maintain-verification-skill runs on the cards that change a mapped feature.

### 2. The Feature map

`features/README.md` and one file per user-facing feature, every one found (from routes, commands, menus, docs, API endpoints), each in create-verification-skill's shape (the four H2s, in order). The README groups them, the most used first, and links each as `[<Title>](./<feature>.md)`; `<feature>` is the name a run's report calls it by.

### 3. Prove it once, end to end

**Prove it once, end to end**: launch, doctor, drive ONE mapped feature, keep its proof (a screenshot and recording, or its surface's transcript) in `.scratch/install/verify/<feature>/`, clean up, then check both are still there. Fix what fails, and run the cleanup after every failed try too.

- **Nothing to run here** (`read.kind.runs` false): verify by static checks only (ADR 0026's table says what for each kind). `verify-<app>` says what is checked (each static check, its command) and what only the deployed system shows (read the diff, say "not run"), and never a step that deploys, synthesizes, plans or applies. No Feature map, no proof: run the static checks once.
- **The app could not run here** (the person chose "can't run here" above): write the pack all the same, with a section saying what could not run here and why, and what a run needs first (the login, the values). Skip the proof.

### 4. Keep the pack lint-clean, and check again

The pack's scripts sit in the repo, so the repo's lint and format checks cover them, in this install and in every card's checks after it. Keep them clean; never take them out of the repo's lint.

1. Write the helpers in the repo's own style: its language, module kind and formatter settings.
2. Run the checks again now the pack is written: `abe install try <name>` for each check in `checks:`.
3. A lint or format failure in a pack file is fixed in the pack: run the repo's own fixer on those files only (`npx prettier --write .claude/skills/verify-<app>`, `npx eslint --fix <file>`), then fix the rest by hand. Never edit the repo's lint config or ignore files to pass: it hides the team's own files from their lint, and every card that edits the pack runs the same checks.
4. When a rule can't pass for a file outside the repo's build (typed lint that needs the file in a `tsconfig`), write that helper as a shell script, which the repo's lint does not read.

### 5. Agree with the other files

- **Take the checks in `verify-<app>` from one list**: `checks:` in `abe.yaml`. A check the repo has and the list leaves out is a line "Not a check yet: `<command>` (<why>)", never a step.
- **Check `verify-<app>` agrees with `abe.yaml`**: no step runs a command its own "never run" list bans, and no "never run" bans a command `setup:` or a `checks:` entry runs. When they conflict, ask the person which is true and fix the file that is wrong. A limit the person gave for this session only ("never run X") is not written here unless they said to keep it.
- **Write only what you checked.** A fact about the repo (a file there or not, why a check fails) goes in a file only once you looked in the repo; a cause you did not confirm is written as unknown ("why: not known"), never as a fact.

Then `abe install check verify`. It runs the gate's judgement too; its line names what can't stand, by file: `no-query-script` (run-app's `SKILL.md` has `## Read data` and `scripts/query` is not there); `no-verify-skill`; `verify-skill-shape` (frontmatter `name: verify-<app>` and a `description`; a `## Launch`, `## Doctor`, `## Drive`, `## Evidence` and `## Cleanup` section); `no-feature-map`; `feature-shape` (a linked file not there, a file not linked, the four H2s); `install-unproven` (no mapped feature has its proof in `.scratch/install/verify/<feature>/`); a check that fails since the pack was written.
