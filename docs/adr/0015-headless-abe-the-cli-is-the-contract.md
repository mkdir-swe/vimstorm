# 0015 Headless Abe: the CLI is the contract

Status: accepted for 2.0 (design), 22 Oct 2026; 1.0 unchanged.

2.0's TypeScript core (ADR 0013) runs headless: `abe serve` is a long-running process that holds agent sessions and Factory runs, and every action is an `abe <noun> <verb>` command with `--json` output and an `abe watch` event stream. The CLI is the handshake between applications: VimStorm's UI, agents (under Reach, ADR 0010) and any tool a developer writes are all clients of the same commands, the same list as VimStorm's `:` mode. The `abe` command starts `abe serve` when none is running. It ships as one binary (`bun build --compile`), bundled with VimStorm and installable on its own.

The core holds data, commands and events and no UI; VimStorm's screens are a separate TypeScript package built only on the core's public commands, so nothing VimStorm does is out of reach for other tools. No plugins run inside the core; a TypeScript client is optional sugar over the CLI.

## Considered options

- **An in-process library API** that VimStorm links: rejected, other tools and agents would get a second-class surface.
- **Plugins inside the core:** rejected for now, a tool can do anything through the CLI without sharing the core's process.

## Consequences

- State lives on GitHub (Tracking, ADR 0009) plus a local store, so the same core runs headless without VimStorm. Amended 23 Oct 2026: it runs on your own boxes (ADR 0016), and VimStorm and the `abe` CLI talk to your remote `abe serve` by default; there is no team server, team views read from GitHub.
- Every new feature lands as a command first; a screen is only a client of it.
