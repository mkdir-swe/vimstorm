# 0005 Native cloud sessions and published editor revisions

Status: accepted product decision; staged for the implementation branch. Supersedes ADR 0003's cloud issue-assignment/local-picker handoff flow and prohibition of delegation. Its implementation is gone since 26 Oct 2026: 1.x cloud workspaces, Take over locally and Hand back were deleted; boxes replace them (ADR 0021).

Native Copilot cloud sandboxes provide the interactive remote agent; VimStorm displays a clearly identified local copy of published commits. The copy follows the cloud agent's own branch by itself (each pushed commit fetched and checked out exactly) and is read-only while the cloud agent drives. This preserves normal native editor/Git tools without promising undocumented live remote filesystem access.

1.0 has one cloud intent, the interactive cloud CLI (amended 21 Oct 2026: Delegate to PR and its task form are retired; a card start hands the agent its card and spec). Local-to-cloud handoff (Start from this workspace) uses a pushed branch and summary, rather than claiming to transport a local process. This replaces the Codespaces/SSH proposal and the older @copilot-comment handback as the main path.

Local editing of a cloud branch (Take over locally) requires the cloud agent's pause answer, read off its terminal, and the branch still at that commit; Hand back to cloud is confirmed and checks the remote before push. No checkpoint, fetch or acknowledgement steps are shown in the UI. This is coordination with the agent, not a provider-enforced lock, and does not stop cloud infrastructure or establish that billing has stopped.
