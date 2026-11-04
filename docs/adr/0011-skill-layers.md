# 0011 Skill layers

Status: accepted for 2.0 (design), 22 Oct 2026; 1.0 unchanged.

An agent's skills and settings come from layers, each adding to the one above: core (shipped in VimStorm), org (the org's Layer repo and `.github-private`: settings, reaches, org skills, instructions, rulesets), team (the org Layer's `teams/<team>/`: board, workflow, team skills), repo (`.abe/`: Verification pack, scripts, repo skills, instructions, environments) and individual (`~/.config/abe`). Skills are SKILL.md only; deterministic steps are scripts in `.abe/scripts` the skills call.

- Matt Pocock's skills are the base: taken from the latest upstream repo (not the installed plugin) and copied in with the upstream version noted, then trimmed. Factory install writes upstream's tracker (GitHub only) and domain docs; the glossary is `GLOSSARY.md`.
- Personal skills and rules on top are a setting, off by default: a launch is pure Abe (core, org, team, repo) unless it is on, and the chat header shows when it is.
- Factory install is an interactive per-repo session that reads the board, issue kinds and how to verify, uses the org and team layers, creates the repo's skills, Verification pack and scripts, and ends in one pull request; it is re-runnable. It creates only the org and team skill and settings repos, asking first.
- A stale recipe is fixed in the pull request that hits it; there is no maintenance job.
- unslop moves to the org layer and is used wherever agents write for people (spec, PR body, comments, Notes).
- Factory agents commit in the team's `AB#<id>` style; the `NO-TASK` style is the owner's personal one, for their own repos.

Amended 23 Oct 2026: more of Matt Pocock's skills join core: the writing set (writing-fragments, writing-beats, writing-shape; agents use writing-shape and unslop for text people read, and `:write` runs it), to-tickets (in Spec), pr (in the PR stage), handoff, to-questionnaire (for product owners), wayfinder (product owners' planning maps too), improve-codebase-architecture (a Sheet under `:improve`), teach and triage (`:triage`). Upstream retro is the base of core's `:improve-retro` (ADR 0019).

Amended 23 Oct 2026 (ADR 0020): skills and docs keep Matt Pocock's harness-neutral wording; only the integration (`abe serve`, hooks, `.claude/` settings, the plugin, Reach as permission rules) is Claude Code specific. Each repo has `CLAUDE.md`, with `AGENTS.md` a symlink to it. No Copilot copies are generated.

Amended 27 Oct 2026: `AGENTS.md` is linked to `CLAUDE.md` only when the repo has none; an existing one stays as it is.

Which skill goes where: [docs/agents/skills.md](../agents/skills.md).

Superseded in part by ADR 0030, 28 Oct 2026: the Layers are core, repo and yours; the org and team Layers and their skill places are gone.
