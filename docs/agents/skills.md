# Skill layers: keep / move (2.0 design)

Where each skill goes under [ADR 0011](../adr/0011-skill-layers.md) (grill Q30, with Q34 / Q37; amended 23 Oct 2026 with Matt Pocock's skills added to core). Since [ADR 0030](../adr/0030-settings-live-in-the-repo.md) the Layers are core, repo and yours: the org and team rows below are no Layer the IDE reads, only skills a repo may copy into its `.claude/skills/`. Upstream skills are copied from Matt Pocock's latest repo with the version noted. 1.0 is unchanged.

| Layer | Skill | From |
|---|---|---|
| Core (VimStorm) | create-specification | grilling, grill-with-docs and to-spec in one (3.3): find out first, ask what is left, spec it, linked to the card; `decide` retired in 3.3 (the workflow is picked at launch) |
| | implement | old Abe, lean: no before capture of its own, no double review |
| | tdd | one, upstream base |
| | code-review | one pass, standards and spec |
| | verify | generic, from a large app's verify and regression-test skills and show-your-work: pack, levels, `report.md`, the PR's verification line |
| | pr | upstream base; PR body with Notes and the verification line |
| | install | factory-setup, as the wizard; `/abe:install` in the Abe chat |
| | writing-fragments, writing-beats, writing-shape | upstream; writing-shape and unslop for text people read; `:write` |
| | to-tickets | upstream base, Abe's own since 3.3: Feature's step after create-specification, tickets for a parallel build (sub-issues, child cards or files, as `spec.where`) |
| | handoff, teach | upstream |
| | to-questionnaire, wayfinder | upstream; product owners too (wayfinder's planning maps) |
| | improve-codebase-architecture | upstream; a Sheet under `:improve` |
| | triage | upstream; `/abe:triage` in the Abe chat, over the backlog |
| | retro | upstream base of `/abe:retro` in the Abe chat (ADR 0019) |
| | improve, prototype, make-card | Abe's own: `/abe:improve`, `/abe:prototype`, `/abe:make-card` in the Abe chat |
| For a repo to copy (was the org Layer's, `skills/`) | typescript | old Abe's conventions / `typescript.md`, generalised |
| | domain-modeling, grill-with-docs, grilling | upstream (`GLOSSARY.md`) |
| | research, diagnosing-bugs, codebase-design, prototype | upstream |
| | resolving-merge-conflicts | kept (upstream removed it) |
| | write-card | old Abe |
| | chrome-devtools | chrome-devtools-mcp's bundled skill |
| | unslop | for writing people read; referenced by to-spec, pr, comments and Notes |
| For a repo to copy (was a team Layer's, the org Layer's `teams/<team>`) | commit-style | the team's `AB#<id>` form: Factory agents commit this way |
| | user-story | a team's story style |
| Repo (a repo's own pack, through Factory install) | its run skill | `run-app` (`.claude/skills/run-app/scripts`) and the Verification pack |
| | its feature maps | the Verification pack |
| | the repo's other skills | stay repo skills |
| Personal (setting, off by default) | commit-style | a person's own commit form, only in their own repos |
| | writing-for-agents | |
| | ask-matt, chief-of-staff, claude-handoff, wizard | upstream |

Dropped: override (Reach replaces it) · merge-local · show-your-work, create-verification-skill, maintain-verification-skill (folded into verify) · implement-spec, loop-me (local-tracker oriented; to-spec makes sub-issues) · old Abe's retro · write-a-skill (upstream removed it; writing-for-agents) · Codex `openai.yaml` · setup-ts-deep-modules, setup-pre-commit, git-guardrails, migrate-to-shoehorn · the archives and the factoryx / ado-rust copies · the stage agents investigate, review-standards, review-spec.
