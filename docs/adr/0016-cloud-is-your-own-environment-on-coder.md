# 0016 Cloud is your own environment, on Coder open source

Status: accepted for 2.0 (design), 23 Oct 2026; 1.0 unchanged. Supersedes ADR 0012 (Factory cloud on the Actions coding agent), ADR 0009's evidence branch, ADR 0010's cloud credentials from the org's Agents secrets, and ADR 0015's team server.

Cloud is one remote coding environment per developer, **your environment**, and it is the default: ⏎ on a card launches straight into "Cloud · your environment". Local is the exception (⌘⏎ or Chat), and Local sandbox with reads only is the offline fallback. Cloud work is native: VimStorm and the `abe` CLI on the Mac talk to your remote `abe serve`, and `g w` attaches the editor, terminal and LSP in the session's container, so a cloud lane chats and steers like a local one.

- **Boxes.** Your environment is one or more boxes: personal cloud machines, each running your `abe serve` with up to four workspaces (a container per session, its own database in the box's one Postgres; LSP and Chrome start only when needed). A fifth launch starts another box ("Starting box", about a minute); each box sleeps on its own when idle and wakes on open. A launch goes to the least busy box, or to the next one when memory is low; ⌘⏎ Run on box… picks one. Boxes are always personal; a teammate may later attach read-only.
- **Coder open source runs the boxes.** Self-hosted `coderd` and its Postgres in the tooling account, no Coder account, telemetry off. A Coder workspace is one box (a Graviton machine with Docker) from a Terraform template versioned in the org Layer repo. You sign in to Coder with GitHub (restricted to the org); attach goes over Coder's WireGuard tunnel (`coder ssh`, port forwards), with SSM as the fallback; no public ports. Inactivity auto-stop is Coder's.
- **Size.** A box starts at 4 CPU / 16 GB. VimStorm suggests the next size after sustained full CPU or memory; a resize happens on wake (stop and start, a minute or two, asked first if sessions run); the disk grows live. A developer resizes their own box within the team's maximum. Starting another session is the smooth way up; resizing is second.
- **Soft team limits.** The team sets the most boxes per person and the largest size; `abe serve` and VimStorm check them, and an AWS Budgets alarm per team watches spend. No paid Coder tier.
- **Logins stored once.** Your GitHub login is stored once in Secrets Manager, readable only by your boxes, with a device code fallback when it expires; your Claude Code login (your own Claude seat through `/login`, no API keys, ADR 0020) and `az` the same way. Commits are authored as you.
- **AWS hub and spoke.** Each box has its own role carrying your identity. Every environment account has `abe-read` and `abe-write` roles that trust the developer boxes; the box assumes them across accounts with SourceIdentity set to you, so CloudTrail shows who. Reach is per environment (`ABE_AWS_READ_TEST`, `ABE_AWS_WRITE_PROD` and so on, a write only by Override). Write credentials exist only in your cloud environment; a local session gets reads. A team lead adds a reach by a pull request to the org Layer's `teams/<team>`, with the `ABE_*` names checked; Factory install's Terraform creates the roles. One NAT for the org.
- **Download locally is recovery only.** No flow moves work between here and there. "Download locally" is offered when connecting fails and as a menu row on the session; "Move to cloud" is a menu row too. Either copies files into the same session (commits, uncommitted and untracked files, `.scratch`, the transcript; not `node_modules`, builds, write credentials or running servers). No issue is written on a move.
- Each repo's session image comes from Factory install. Evidence stays in your environment's `.scratch`; verification's Chrome runs in the container, its screen streamed to a VimStorm tab.

## Why Coder over our own SSM layer

Our own layer meant writing a broker (a Lambda that starts, stops and finds boxes), workspace lifecycle, auto-stop, sign-in and reconnects, and then keeping them working. Coder open source has all of that, is free to self-host, and keeps the box an ordinary machine from our own Terraform, so leaving it later means replacing the control plane, not the boxes.

## Considered options

- **GitHub's Actions coding agent** (ADR 0012): no steering, not native; work moved only by Send off and Bring back.
- **A team server** with a container per session: one shared machine acting as a GitHub App, so neither commits nor cloud access are yours.
- **Our own SSM layer** with a broker Lambda: everything above to build and run ourselves.
- **Coder's paid tier**: hard quotas we do not need; soft limits and a budget alarm are enough.

## Trade-offs

- We run `coderd` and its Postgres ourselves: upgrades, backups, one more thing to watch.
- Coder is AGPL; the org's licence policy has to allow it.
- Team limits are soft, enforced by our own checks and the budget alarm, not by Coder.
- Daily work now depends on the network; offline is Local sandbox with reads only.

## Consequences

- Before rollout: the AGPL policy check, a security review and the private network.
- The first build step is a spike measuring attach latency and reconnects over Coder's tunnel against SSM. Remote work must feel native, or this decision is revisited.
- 1.0's cloud plumbing (`copilot --resume`, the agents API budget) does not move to 2.0. 1.0 keeps its interactive cloud workspace unchanged.
- There is no team server; team views read from GitHub.

## Amendment (24 Oct 2026): one workspace, one box

The Boxes bullet above is replaced: each workspace gets its own box, one EC2 that is that workspace's Coder workspace. Boxes are smaller (m8g.large by default, resized on wake when the repo asks for more). Four a box, "Starting box", least-busy placement, ⌘⏎ Run on box… and low memory → next box are gone; a launch past the team's limit is still Queued. Why: sharing a box meant writing our own container lifecycle, attach and placement beside Coder's, to save about half the compute cost; one box per workspace lets Coder do all of it, isolates workspaces fully, and a stopped box resumes in about 30 s with its disk.
