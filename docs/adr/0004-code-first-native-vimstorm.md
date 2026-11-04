# 0004 Code-first native VimStorm

Status: accepted product decision; staged for the implementation branch. Supersedes the shell/navigation portions of ADR 0002 and ADR 0003; preserves their native architecture and core/ports separation. Its editor decisions hold; the Rust Abe core and ports it preserved were deleted on 26 Oct 2026, Abe's core / ports split lives on in TypeScript (ADR 0013).

Keep VimStorm's native editor, project tree, Git/diff/merge tools, terminal and Islands Dark/Darcula theme. Replace the first-generation Abe navigation around that foundation. Rebuilding the browser prototype as a new editor shell would discard working behavior and regress the code-first experience; the prototype records product intent rather than an implementation foundation.

This supersedes the old Abe shell/navigation decisions, not VimStorm's editor architecture or its existing Git behavior.

The replacement navigation is code-first workspaces, compact activity in tabs/overflow, a shared pinned Board and temporary Pipelines/Reviews tools. There is no permanent Inbox or top Ask control. Existing ADRs remain historical records.
