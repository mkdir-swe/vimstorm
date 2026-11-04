# 0002 Abe becomes a mode of VimStorm with a native Rust core

Status: accepted (2026-10-18); its shell and navigation superseded by ADR 0003 and ADR 0004. Historical record: the Inbox, factory jobs and views it names are gone in 1.0. Its implementation is gone since 26 Oct 2026: `app/src/abe`, `crates/abe-core` and `crates/abe-ports` were deleted; Abe is TypeScript on the Rust shell (ADR 0013).

## Decision

abe (the team's terminal app for Azure Boards, agent chats, GitHub, deploys and the cloud factory; TypeScript, Ink, tmux) merges into VimStorm as **Abe mode**. One window, two modes: Abe mode (orchestration, team-wide, not tied to the shown project) and VimStorm mode (the IDE). Cmd+Alt+A or the status bar's mode segment flips the whole window; the mode belongs to the window.

- **Native Rust core.** abe's pure `step(state, event) -> effects` and its rules are ported to an `abe-core` crate (no GPUI, no IO, no clock), with `abe-ports` for Azure, GitHub, the factory, git, agents, ConfigCat and the shared files, and GPUI views that hold no logic. One Cargo workspace, one binary; invoked as `abe` it serves `abe cli`.
- **No tmux.** A local agent chat is a native VimStorm PTY terminal tab in Abe mode. On restart it comes back through its CLI's resume (`claude --resume`, `copilot --resume`, `codex resume`).
- VimStorm owns the IDE parts (Project tree, Local Changes, Log, the PR review in its diff viewer). Abe's `W` / `C` open a worktree or PR diff as a VimStorm project; Cmd+Alt+A goes back.
- Every local agent launch goes through the tool policy: env allowlist and a read-only AWS identity check, refused otherwise.
- Until cutover the Rust app and TS abe share `.scratch/abe` and `~/.config/abe`. The factory's content stays in the abe repo.

## Why

- Every handoff between the two apps was a jump (`^W` to the IDE, review diffs through IDE adapters, chats in tmux panes the IDE can't see). One window makes each handoff a mode flip on the same state.
- The terminal grid capped Abe's polish the same way it capped VimStorm's before ADR 0001; GPUI removes the cap and VimStorm already draws WebStorm's Islands Dark chrome.
- The factory views still to build would be thrown away if built in Ink.
- A Rust core keeps abe's best property, a pure step function with scenario tests, and the crate graph enforces the purity that lint enforced in TS. Calling a TS core from Rust (sidecar, JS engine) was rejected: two runtimes, two toolchains and a process boundary on every key.
- tmux only gave chats persistence across quitting; the agents' own resume gives enough, and VimStorm removed tmux in 405421c. Keeping a headless tmux would bring back key-binding twins and a second terminal model.
- A separate Abe window or app was rejected: the deck's point is that a card, its job, its worktree and its PR are one place.

## Consequences

- Chats end when the app quits and are resumed on the next start; a running agent's in-flight turn is lost.
- Abe mode's keys are Abe's letters (plus `k l ö ä`); VimStorm mode's review actions sit under a `,i` leader prefix.
- The mode switch is a status bar segment, not a toolbar widget: ADR 0001's "no toolbar widgets" stands.
- TS abe keeps running beside the app until the cutover ticket; its IDE adapters, launchers, `ide-attach`, `abe reload` and the token eater are not ported.

## Addendum (2026-10-19): the mode flip becomes a view switch

Superseded by ADR 0003 (2026-10-20): Abe is a tool window, there is no Command mode, Copilot is the only agent.

The window has four peer views instead of two modes (spec `abe-shell`): ⌘1 Editor (VimStorm mode as it was), ⌘2 Inbox, ⌘3 Board, ⌘4 Code, from anywhere; ⌘⌥A (and the status bar's segment) goes back to the view used last. Which view is on show is abe-core's (`abe::shell`); the projects window takes ⌘1–4 before any surface or nvim. Abe mode is now what draws Inbox, Board and Code; today's Abe mode is the Board view. One status bar under every view.

- ⌘1 on the Editor stays its Project tree key, so nothing the Editor relies on moves; ⌘2 (focus code) and ⌘3 (Git) give way to the views, and the Git tool window moves to ⌘9, WebStorm's own.
- Launch lands on the Inbox when something needs the user (stubbed to gates and auto to test until the Inbox reads its own needs), else the Editor.

### The places are gone (abe-shell 18)

- The mode flip is a view switch and nothing else: ⌘⌥A, View > Last View and the status bar's segment go back to the view used last; `Mode` in the code is only the window's name for "the Editor, or a view Abe mode draws". The segment names the view.
- The Board's tool windows are Chats (⌘7) and Factory (⌘6). Factory chats (⌘5) is gone: a job opens as its Job workspace in the Inbox view, from everywhere (`J`, the Inbox, Search Everywhere, `:job <n>`); the session log is the workspace's Log tab, no tab of its own. The GitHub tool window (⌘8) is gone: the Code view (⌘4) lists pull requests, issues, pipelines and branches, and holds the Release tab as its fifth sub-tab; the PR, run and Job log centre tabs stay, opened by ⏎, `:pr <n>` and the jumps.
- The ask bar is gone: `:ask <question>` takes the question in Command mode's bar and opens the ask as its chat tab; `^T` in the prompt asks the factory instead (`:new-job <question>`). The earlier asks are the Chats tool window's.
- The keymap is the spec's set alone (the moves, ⏎, Esc, `/`, `?`, `:`, `⌘⏎`, `g`, `^O` / `^I`); every other action is a command whose old key stays its binding, shown dim in Command mode and the Action menu (ticket 03 left the choice to 18: the keys stay, so the muscle memory does; `G` and `g` went to the keymap). A view's digits (the Board's tabs, Chats' filters) stay the view's nth; elsewhere a digit is a count.
