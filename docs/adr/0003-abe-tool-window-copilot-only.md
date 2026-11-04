# 0003 Abe is a tool window, Copilot is the only agent, GitHub is the record

Status: accepted (2026-10-20); its shell, Jobs and ask decisions superseded by ADR 0004, its cloud handoff by ADR 0005, its readiness gate by ADR 0006. Historical record. Supersedes the 2026-10-19 addendum of ADR 0002 (four views on ⌘1–4, Command mode, three agent harnesses). ADR 0002's core decision stands: one window, a native Rust core with `step(state, event) -> effects`, the runner as the only caller of ports, PTY chats, the launch guard. Its implementation is gone since 26 Oct 2026: the Abe tool window, Copilot sessions and the Rust core were deleted; Claude Code is the only agent runtime (ADR 0020).

## Decision

- **Abe is a tool window in the bottom tool window**, beside Terminal and Git; opening one hides the others. ⌘4 toggles it, as ⌘T toggles the Terminal. ⌃⌘⏎ maximizes and restores it, with the terminal's maximize. Its tabs are Jobs, Board and Pull requests, then closable job and pull request tabs. ⌘1 Project, ⌘2 Editor, ⌘3 Git and ⌘T Terminal are VimStorm's own again. The views, the ⌘6 / ⌘7 tool windows, ⌘⌥A and the Inbox as home are gone.
- **No Command mode.** Ask (`i`, read-only) is the only typed mode. ⌘⏎ opens the Action menu of what is in focus, the only way to act; a greyed row says why. Every Abe list has Vim movement, counts, `gg` / `G`, ⏎, Esc, `/` with `n` / `N`, and `?`.
- **Copilot is the only agent.** The Claude Code and Codex providers, their deny rules, transcripts and settings go. Every local launch is Copilot through the launch guard, with `--agent`, `--model` and the deny rules (merge tool, `gh api`, `gh pr merge`); Copilot's read-only GitHub tools stay on.
- **A job is the code repo's issue and ends in one pull request.** Its state is derived each time by a pure core function from the issue, the pull request and its timeline, the Actions runs on its head branch, the worktree and the card. There is no ledger, control-repo issue, stage or fix round on the main path.
- **The issue is the ticket, and `ready-for-agent` is the gate** (revised 2026-10-20; there is no spec gate). A job's issue has the to-tickets GitHub shape: `## Parent` (the spec issue, if any), `## What to build`, `## Acceptance criteria`, `## Blocked by` with native blocking links. A ready, unblocked issue goes to Copilot directly; a raw one (`needs-triage`, `needs-info`) is triaged first. A spec, when there is one, is its own parent issue. A card started in Abe creates its issue in the ticket shape.
- **Every trigger is the person, signed in as themself.** Abe triages, assigns the issue to Copilot with the org's custom agent and a model, reviews, requests changes, reruns held checks, merges, and moves the card, all as the person. No bot account or token is on the main path. Agents never merge.
- **Two lanes, both GitHub's own.** Cloud: assign the issue to Copilot; changes by a review that requests changes or `@copilot`. Local: a job worktree on `copilot/*` or `job/<issue>-<slug>` with the Copilot CLI and the same agent; Abe pushes and opens the draft pull request as the person. `/delegate` is not used. Take local resumes the cloud session in a worktree; Hand back pushes and posts `@copilot`.
- **Reads use the core REST API only**, with conditional requests, on one scheduler. The agents API (60 calls an hour) is called only when the person acts (Take local, a full session log), never in the background.
- **The factory is an optional add-on**: the decider, reviewer agents, multi-repo jobs, intake and unattended card moves. Its custom agents, tool policy, check App and connect / doctor tooling remain the configuration both lanes use.

## Why

- The try-out: Abe took the editor's keys and spread one job over five places; three harnesses meant every feature was built three times.
- The factory was a second job system beside Copilot's, kept in step by matching times, held up by Actions approval, and stopped when background polling spent the agents API's hourly limit.
- Verified on the demo org: assigning an issue as the person with an agent and model works; job state is readable from the timeline and Actions runs; a person's review or `@copilot` starts a native session on the same pull request; a person's rerun runs held checks.

## Consequences

- Abe works without the factory installed; a repo needs only Copilot and the org's agents.
- Card moves happen only while the starter's Abe runs; a card catches up on the next open (the factory can move cards unattended where installed).
- The Inbox, the Job workspace, refine, the Features tab, the Release sub-tab, Auto to test and snooze are cut for now.
- The local agent writes to the issue and card only through the `abe` command, checked against the tool policy.
- Spec and settled defaults: `.scratch/copilot-native/spec.md` (git-excluded; the defaults are marked "default, revisit").
