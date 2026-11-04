# 0012 Factory cloud is the Actions coding agent

Status: superseded by ADR 0016 (cloud is your own environment, on Coder open source), 23 Oct 2026. Was: accepted for 2.0 (design), 22 Oct 2026; 1.0 unchanged. Supersedes, for 2.0, ADR 0005's interactive cloud CLI workspace, Take over locally and Hand back to cloud.

Factory cloud work runs on GitHub's Actions coding agent: a pipeline-like job with no steering. Work moves between here and there only through its branch and its Tracking, never by moving a session.

- Send off: push the branch and start the agent with the issue and the PR's Notes as its task.
- Bring back: pull the branch and start a fresh local session from the issue, the PR and its Notes. The cloud session is never resumed.
- A cloud card's stage and state come from its PR, commits and job; its chat area is the read-only log and Bring back, with no composer. Cloud jobs have no gates.
- 2.0 retires 1.0's interactive `--cloud` workspace; 1.0 keeps it unchanged.
