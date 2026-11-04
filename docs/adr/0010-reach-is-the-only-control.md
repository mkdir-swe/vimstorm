# 0010 Reach is the only control

Status: accepted for 2.0 (design), 22 Oct 2026; 1.0 unchanged. Supersedes, for 2.0, 1.0's pinned `agentsNeverMerge`, `readOnlyCloud` and prod confirm, and the tool policy.

Nothing is pinned by rule. What an agent can change is decided only by its reaches: separately granted write credentials such as a cloud role or a database. Everything else is allowed, merging and production included. Reads are always on, everywhere, production too: the dangerous tools are not reachable, so reading cannot do harm and verification can use everything.

- Credentials are only the org's: managed at org level and exposed by the org to some teams; nobody brings their own. Secrets come from SSO or the Keychain locally; in the cloud, your box's role assumes each environment account's `abe-read` / `abe-write` roles (ADR 0016, amended 23 Oct 2026).
- An agent gets them as environment variables with fixed `ABE_` names and no team prefix (`ABE_AWS_READ_*`, `ABE_DB_READ_URL`, `ABE_*_WRITE_*`); each team gets its own values. Every agent gets the read names; VimStorm fills them locally. "AI read / write" means these AWS read / write roles.
- A write name is given only by an explicit Override with a reason.
- Amended 23 Oct 2026: Reach is enforced as Claude Code permission rules plus its sandbox (ADR 0020).
- Amended 23 Oct 2026: Reach is per environment (`ABE_AWS_READ_TEST`, `ABE_AWS_WRITE_PROD` …). Write credentials exist only in your cloud environment; a local session gets reads. A team lead adds a reach by a pull request to the org Layer's `teams/<team>`, the `ABE_*` names checked, so it cannot be set up wrong.
- Layers below the org may lower a default, but only intentionally: an Override with its reason, shown as `lowered by <layer>: <reason>`. Amended 23 Oct 2026: a reason is required and enforced: an Override without one is refused where it is written (Settings, the layer file's check, the org Layer's checks), so it never exists (was: applied and flagged in Problems). A personal Override applies to your own launches only.
- The org default is that a person merges; auto merge is opt-in per team or repo with a reason.
- Amended 24 Oct 2026 (superseding that day's first amendment): every setting can be overridden personally, with intent and visibility. Auto merge on, a check cut, a model the team left out, a bigger box or more boxes: a personal Override, refused only without its reason (`reason-required`). It keeps its reason and since when, and shows in `settings explain` / `list`, as an info row on Problems (not an error), on Chat's header (`Override · autoMerge on`) and the story's Session row for a run launched under it. Proposing it to the team or the repo (`abe settings propose … --to team|repo`) is suggested, never required. Reach's write names are not settings but credentials: still granted only by the org or a team.
- Amended 24 Oct 2026 (reversed the same day): branch protection is not required. Abe neither checks it (`abe settings check`, Problems) nor makes auto merge wait for it. A session's pre-push hook and `gh` merge guard (not merged yet) are to keep a session off the default branch.
- Org rulesets only require green checks; protecting the default branch and a required review are opt-in.

## Consequences

- Pinning anything again is a new decision the owner confirms first.

Superseded in part by ADR 0030, 28 Oct 2026: `environments` and `reach` are repo settings, no longer the org's; a write Reach name is granted only by an Override in the repo's `.abe/settings.yaml`, not by the org or a team. Proposing an Override goes to the repo only.
