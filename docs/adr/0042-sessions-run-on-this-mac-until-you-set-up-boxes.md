# 0042 · Sessions run on this Mac until you set up boxes

Status: accepted, 3 Nov 2026. Amends ADR 0021 (its "`serve.target` defaults to cloud").

`serve.target` defaults to `local`: a session, a prototype and a run start on this Mac. Your environment (your boxes) is where they go once you set `serve.target: cloud`, after the cloud setup (an AWS account with IAM Identity Center, the platform Terraform, your `abe-*` profiles).

Why: VimStorm is open source. A new person has a Mac, a Claude Code seat and GitHub, and no AWS. A default that sends the first launch to boxes they do not have fails before they see anything work. The team that runs boxes sets `cloud` once, in yours.

Not Local mode: Local mode still means the board read-only and every write held on this Mac. A local session writes as usual.
