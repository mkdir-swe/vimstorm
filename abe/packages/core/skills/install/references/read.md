# Read: what the repo says

Read learns how the repo is built, tested and run from its local files. Run it in a subagent: hand it this file, and have it report in a few lines what the repo says for each part (how the app starts, its backends, its CI checks, the board and sources it names, its env files), each with file and line.

serve's own findings are in `abe install status --json` under `read`; every part draws on them, and every question offers what they found first.

## What serve found

serve has read the files it knows (`read.files`: package.json, the env example, `.github/workflows/*`, docker compose, `abe.yaml`, CLAUDE.md, AGENTS.md, the MCP configs, `docs/*.md`, the Terraform files at the top and in `terraform/` and `infra/`) and the settings in force.

- `sources`: the repo's sources, each with what it is and why it was found ([sources](sources.md)).
- `aws`: where the repo uses aws, each file and line; empty when it does not. `awsProfiles`: the named aws profiles its scripts and CI use (`--profile dev`, `AWS_PROFILE=test`), each with file and line.
- `workspaces` (a monorepo): each workspace's scripts, test scripts, env example keys and stack, found from package.json's `workspaces`, `pnpm-workspace.yaml`, or the folders at the top two levels holding a package.json; `capped` says where Read stopped.
- `envFiles`: the env files at the top and in the workspaces ([env-files](env-files.md)). `cloudCredentials`: env files holding cloud keys (`.env.aws.dev` from `aws configure export-credentials`).
- `devPorts`: the dev-server ports the repo names (vite's `server.port`, webpack's `devServer.port`, a `--port` in a package script). `originAuth`: where a sign-in redirect is the page's origin (`redirect_uri: window.location.origin`); that dev port is then fixed (`fixedPorts`, `ports.rule`) and [verify](verify.md) keeps it. Tell the person when it is.
- `outward`: scripts that write real systems (by name: deploy, import, export, sync, publish, release; or by what they run) and those that call an outside API with a token (a read too: it may carry personal data out), each with where and why. Never run one.
- `kind`: the repo's kind from evidence (web app, service, config as code, infrastructure as code, library, CLI, or a monorepo of these, per workspace), each with the files that say so, its deploy tools, the outside systems it names and its fixed ports; `kind.runs` false: nothing to run here. `deploys`: the CI jobs a merge to main deploys and where to. Tell the person the kind and what a merge deploys in one line. When they say the kind is wrong, ask which it is and record theirs: `abe install kind <kind>` (a monorepo's part: `--part <folder>`), which serve writes into `abe.yaml` as `kind:` for the team (ADR 0040).
- `fixedPorts`: serve writes them into `abe.yaml`'s `ports.fixed` too, so the team sees them.
- `boards`: the boards the repo names, each with where ([board](board.md)).

## How to read

1. Read what `read.files` lists, plus anything the person points at (a Makefile, a `scripts/` folder, a README section on running locally). Note how the app starts, which backends it talks to and which CI jobs check it.
2. **Read only this checkout.** Never open a file outside it: no sibling checkout's `abe.yaml` or `CLAUDE.md`, no parent folder's files, however likely it looks that another repo of the same team has the answer. What the checkout does not say, ask the person, or find out from the team's sources.
3. Leave tool state closed: `cdk.context.json`, `cdk.out/`, Terraform state (`*.tfstate`, `.terraform/`), `*.tfvars` and every path in `read.kind.neverRead`. They hold cached account lookups, synthesized templates and secrets; their names are enough.
