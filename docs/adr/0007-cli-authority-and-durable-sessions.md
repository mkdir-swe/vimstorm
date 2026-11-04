# 0007 Actual CLI and durable agent sessions

Status: accepted product decision; staged for the implementation branch. Superseded by ADR 0020; its implementation (the Copilot Agent tab and the session supervisor) is gone since 26 Oct 2026: sessions are Claude Code's, owned by `abe serve`.

The actual Copilot CLI remains the complete agent interface. Its lifecycle is independent of a workspace tab, terminal visibility and ordinary editor quit. A session runtime owns durable execution and reconnection; the visible terminal is an attachable view rather than the process owner.

Rich chat is optional and may only join that same running CLI session. An independent SDK agent or terminal-screen reconstruction would break the shared conversation contract, so failure to prove the bridge means terminal-only 1.0. The documented extension attachment is a candidate, not completed integration; local and cloud behavior must both be validated. General AI also retains an actual terminal route.
