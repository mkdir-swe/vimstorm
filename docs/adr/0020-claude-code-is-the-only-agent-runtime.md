# 0020 Claude Code is the only agent runtime

Status: accepted for 2.0 (design), 23 Oct 2026; 1.0 unchanged. Supersedes, for 2.0, ADR 0008's "Copilot runs each step", the 2.0 design's Copilot default with Claude Code allowed per org, and the Agents › Runtime setting.

Claude Code is better than Copilot CLI, so 2.0 is built for Claude Code and runs only Claude Code. Copilot CLI is dropped: no runtime choice, no generated Copilot copies of skills or settings.

- CC2 / CC10: Chat is a running Claude Code terminal, one per session in its container, under VimStorm's quiet header. Abe reads where the session stands from Claude Code's hooks and transcript; it does not draw a chat of its own.
- CC3: no API billing (no Bedrock, no API keys). People sign in to Claude Code the way any CLI user does, with their own Claude seat (`/login` in the browser). The login is stored once per developer, readable only by their boxes (ADR 0016).
- CC4b: skills and docs keep Matt Pocock's harness-neutral wording. Only the integration is Claude Code specific: `abe serve`, the hooks, `.claude/` settings, the plugin, and Reach turned into permission rules.
- CC5b: each repo has `CLAUDE.md`; `AGENTS.md` is a symlink to it.
  - Amended 27 Oct 2026: `AGENTS.md` is linked to `CLAUDE.md` only when the repo has none; an existing one stays as it is.
- CC6: Reach (ADR 0010) becomes Claude Code permission rules plus its sandbox.
- CC7: Opus for the coordinator and writers, Haiku or Sonnet for readers, lowered by the allowed models setting.
- CC8: a selection sent to Chat is typed as `@file#L8-15 <message>`.
- CC9: background work runs in attachable terminal sessions; tiny one-shots use `claude -p`.

## Considered options

- **Copilot CLI as default, Claude Code allowed per org:** two runtimes to integrate, test and write permission rules for, and the weaker one as the default.
- **Both runtimes supported, Claude Code first:** every hook, permission rule and setting would need a Copilot twin.
- **API billing (Bedrock or API keys):** pay per token and manage keys, where a seat login costs a known amount and needs no secret of ours.

## Trade-offs

- Every developer needs a Claude seat, and the org's agent work depends on one vendor's CLI and its release pace.
- Seat limits, not our own budget, decide how much a person can run at once.
- The terminal is the chat, so Chat looks and behaves the way Claude Code does; VimStorm adds only its header.

## Consequences

- 1.0 keeps Copilot as it is; nothing in 1.0 changes.
- Adding another runtime later means a second set of hooks, permission rules and settings, so skills stay harness-neutral to keep that door open.
- Tests launch a fake `claude` in a real PTY, not a fake Copilot.
