# 0008 The Factory runs in VimStorm

Status: accepted for 2.0 (design), 22 Oct 2026; 1.0 unchanged. Supersedes, for 2.0, ADR 0006's "core Abe does not introduce a parallel scheduler" and ADR 0003's factory as an optional add-on.

The Factory is the flow that carries a card from the Decider through spec (when needed), build, review and verification to a pull request and done, and VimStorm runs it. Copilot runs each step from SKILL.md skills; Claude can run the same skills by hand. The first-generation factory (Copilot cloud tasks driven by a control repo's `factory.yml` and `orchestrate.ts`, with decider / investigate / spec / build / review-standards / review-spec stage agents) was a second job system beside the app, and its orchestration goes.

- The old control repo becomes configuration only: the org's Layer repo (with the org's `.github-private`) holds the org's settings, reaches, skills, instructions and rulesets. Nothing orchestrates from it.
- The Decider is a one-shot on launch that pre-fills kind, spec or build, verification level and repos; ⏎ confirms. It also sets the launch default.
- One review (standards and spec together) and one verification; an extra regression pass only when the Decider marks the work risky. No double verification, no per-decision audit log.
- No Investigate step: questions go to General.
- The Factory overview is VimStorm's page for it (⌘⌥A): cards strip, stage lanes with time in stage, chat; no workspace strip; Done clears the next day and removes a clean worktree; review findings go back to Build unasked; teammates' cards greyed.

## Amended 23 Oct 2026

- The Decider runs inside the session's model as its first step, shown in Chat; it is no longer a pre-filled launch dialog. ⏎ on a card launches at once into Cloud · your environment (ADR 0016); Local is ⌘⏎ or Chat, and a choice is changed by telling Chat.
- Deterministic checks (tests, types, lint, no deleted tests, no new suppressions) run from the repo's pack before the agent's verification; a failure goes back to Build with the output.
- Done means deployed to the test environment, not just merged.
- Review goes to Needs you after three rounds with findings.
- A session's main agent keeps its context: most work runs in subagents (at most four per session; the coordinator and writers on Opus, readers on Haiku or Sonnet), the coordinator merging writers' worktrees.
- Claude Code runs each step, not Copilot; it is 2.0's only agent runtime (ADR 0020).
- The overview has two bands, cards and the running cards' place in the flow; a card that needs you stands out, a running card that does not is greyed.

## Consequences

- The owner's GitHub org is remade from scratch as the boilerplate and demo of an org set up with Abe; the old factory repos are archived as `*-old`, only on the owner's go.
