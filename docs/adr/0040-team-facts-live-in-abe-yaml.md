# 0040 · Team facts live in abe.yaml

Status: accepted, 2 Nov 2026. Amends ADR 0026 (the person's correction of a repo's kind is `kind:` in `abe.yaml`; "shape" is renamed "kind"), ADR 0028 (the env map's placements live in `abe.yaml`, the Abe env files stay yours) and ADR 0032 (`worktree.link` and `copy` may be grouped per environment; the group is the file's env placement). Builds on ADR 0029 (only you turn an environment on) and ADR 0031 (the team's file is `abe.yaml`: names, never values).

The install judged facts about the repo and kept them only in the record on this Mac (`<state>/installs/<hash>/install.json`):
- which of the repo's env files feeds which environment (the env map), and which the app never uses;
- the environment the checks run with;
- the hosts the person said are test backends, or prod the app only reads from;
- the repo's kind, when the person corrected Read;
- the ports Read found fixed.

None of these is the person's alone: they are true of the repo. Yet every teammate's install judged them again, invisibly, and could judge them differently. A card on one Mac got `backend/.env.prod` skipped, on another linked, and nobody could see why in the repo.

**What the install judges of the repo, it writes into `abe.yaml`.** Each reader takes `abe.yaml` first, then the record on this Mac as a fallback, so an older install keeps working until its next run writes `abe.yaml`. No migration of other repos.

```yaml
kind: web-app                # or a monorepo's per part: { apps/web: web-app, infra: iac }
checksEnv: test
worktree:
  link:
    all: [frontend/.env]     # every run
    dev: [backend/.env, backend/.env.dev]
    test: [backend/.env, backend/.env.test]
    prod: [backend/.env.prod] # only while prod is on for agents
  copy:
    dev: [.vscode]
env:
  notUsed:
    - { key: backend/.env.old, why: an old copy }
    - { key: LEGACY_API_KEY, why: nothing in src/ reads it }
gate:
  testHosts: [api.test.demo-shop.example]
  readOnlyHosts: [cdn.demo-shop.example]
ports:
  fixed: [4000]
```

**The env map is the recipe's groups.**
- `worktree.link` and `worktree.copy` are each a list, or grouped per environment: `all`, `dev`, `test`, `prod`.
- The group is the file's placement. It replaces the env map for that file: a session is denied it while its groups are all off (ADR 0029), a new worktree and a box's sync skip it, the setup line names the group (`worktree.link.prod: prod is off for agents`), and the Abe env files are prefilled from it.
- `all` is every run, whatever is on. A file in `dev` and `test` goes while either is on.
- A `prod:` group never turns prod on. Only you do, in `.abe/settings.local.yaml`.
- A flat list stays valid with today's rule: its env files are placed by the record's env map.
- `abe install env-map` writes the groups: a file feeding every environment in `all`, any other in each environment's group, in `copy` when the recipe copies it. A `not-used` file goes in `env.notUsed` with its why. A `not-sure` one leaves the groups: placed by none, it is held and skipped until the person places it.
- The env map's evidence (`why`) is not written into `abe.yaml`. It stays in the record and in each Abe env file's block heads. A YAML comment the install wrote would be lost on the next edit, and the file stays plain.

**The rest.**
- `checksEnv:` is top-level: `checks:` is a list. `abe install checks-env` writes it.
- `env.notUsed` holds keys and env files alike, each with how the person knows. `abe install env-map` (not-used) and `abe install gate --not-used` write it. The gate does not judge them.
- `abe install gate --test-host` and `--read-only-host` write `gate.testHosts` and `gate.readOnlyHosts`. The record's are read beside them.
- `kind:` is the person's correction of Read (`abe install kind <kind> [--part <folder>]`), the team's alone. An older record's `shapeSaid` is read as it, and `web` as `web-app`.
- Read writes the fixed ports it found into `ports.fixed`. Readers join both, as before.

**Env files is a team part.** It passes when `abe.yaml` places each of the repo's env files. On a join, a teammate's `abe.yaml` already does: the Abe env files are prefilled from its groups, with no env map to judge. The Abe env files and the aws profiles stay yours: missing ones fail on a join too.

**"Shape" is "kind".** The repo's kind is what Read finds it to be: web app, service, config as code, infrastructure as code, library, CLI, or a monorepo of these. The module, the types, the CLI (`abe install kind`), the status (`read.kind`) and the skills say kind.

Considered:
- **Keep the record, show it in Settings.** Visible, but still per Mac: a teammate's install judges again.
- **A separate `envMap:` block beside `worktree:`.** Two lists of the same files, to keep in step. The group says where the file goes and that a worktree gets it, in one place.
- **Values in the groups.** `abe.yaml` is committed: names only (ADR 0031).
- **Nested `checks.env`.** `checks:` is a list of checks; a key inside it would change its type.

Known limits:
- A file the env map places but no worktree should get has no group to go in. It stays placed by the record on this Mac.
- The env map's CI part (environments that live only in CI) stays in the record.
- An `abe.yaml` the person has not committed yet is read on this Mac alone, like every other team setting.

Hard to reverse: teammates' installs read these keys instead of judging; going back means judging again on every Mac.
