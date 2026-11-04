---
name: maintain-verification-skill
description: 'A pass on a card that keeps a project''s verification skill and its feature map up to date: parallel source readers per feature, one live session driving every feature, proven corrections committed on the card''s own branch. Use for maintain-verification-skill or "audit the verify skill".'
metadata:
  upstream: 'cursor/plugins@9f844cd pstack/skills/maintain-verification-skill (.claude/skills paths, abe:reader subagents, notes in .scratch; serial driving within a run; fixes committed on the card branch, no PR of its own; keeps the features/ map create-verification-skill wrote at install, every user-facing feature in it, grouped, most used first, Abe commands in PROTOCOL.md)'
---

# Maintain a verification skill

A feature map rots the moment the app changes. The **create-verification-skill** skill writes the verification skill and its feature map (`.claude/skills/verify-<app>/features/`) at install; this skill is the upkeep loop that keeps that map up to date (it works on any project-local verification skill with a feature map). It runs on a card: its fixes are commits on the card's own branch, so they ship with the card's pull request. It never opens a pull request of its own. The unit of rigor is the feature, not every sentence: cover every feature file from source and exercise every feature live, without terminalising every bullet.

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

## Outcomes

Pick one, and say which:

- **clean** — every feature got source and live coverage; nothing to fix. No commit.
- **changed** — proven doc, harness, or map corrections, committed on the card's branch.
- **blocked** — coverage could not finish or a proven fix could not be made safely. Say exactly what blocked it.

## Edit scope

Only edit the verification skill's own directory (its SKILL.md, features/, and any harness scripts it owns). Never edit product code during a run: a behavior the map describes that the app no longer does is either doc drift (fix the map) or a product regression (report it, don't paper over it in docs).

## Pass

0. **Locate the target.** Find the verification skill to maintain: the project-local skill whose body has launch/drive sections and a feature map (usually `.claude/skills/verify-*/`). Several candidates → ask which one; none → stop and point at the **create-verification-skill** skill instead of inventing a target.

1. **Index hygiene.** Read the feature map README and glob its sibling files. Fix missing, extra, duplicate, or dead entries. Lightweight; no generated inventory.

2. **Source wave.** One `abe:reader` subagent per feature file, launched concurrently with the Agent tool. Each explains "how does this user-facing feature work?" from source, flags likely doc drift with citations, and returns one concise live-verification recipe. Children never drive the app and never edit files. Return shape: feature summary / source entry points / likely drift or none / one recipe. Running inside a subagent (a Factory stage runs in one, and a subagent starts none): do the wave yourself, one feature file after another, with the same return shape per feature.

3. **Reconcile.** Every feature file has a returned summary. Merge overlapping recipes into as few app states as practical. Spot-check cited drift; don't re-prove clean claims. Sweep recent churn for user-facing surfaces missing from the map — require a concrete source path before calling one missing. The map holds every user-facing feature, not a sample: add each missing one in its group, the most used first.

4. **Live pass.** Required even when source looks clean. The coordinator owns all driving and drives serially, never two instances in one run (every launch and drive goes through Abe's runner, which runs one at a time per session, against the local app only; `PROTOCOL.md`, Pass); follow the verification skill's own launch model — one long-lived instance driven serially for servers and UIs, or a fresh isolated session per drive for short-lived CLIs (the skill's Launch section decides, not this one). Exercise every feature at least once, and hold three invariants the whole pass, whatever the failure: (1) never drive an instance you haven't health-checked since it last did something surprising — doctor before first drive, doctor on each fresh session where sessions are the unit, doctor again after any failed drive, and where doctor can't see the failure (a wedged UI state on a healthy process), reset to a known state or relaunch rather than hoping; (2) evidence captured so far survives every cleanup, checked at its named location, not assumed; (3) nothing a drive started outlives that drive's usefulness — failed-iteration residue is cleaned whether the session is stuck, exited, or shared (for a shared instance, clean the residue, not the instance). A doctor failure caused by skill drift is drift: fix it under edit scope and retry once — restart whatever the fix invalidated, nothing more — before calling the pass `blocked`. A feature that can't be reached is `verified-unreachable` only with the concrete prerequisite (auth, entitlement, OS, external state) and the route attempted; if the map omits that prerequisite, that's drift. Any harness fix from triage gets re-driven live before it ships. Final teardown happens after the last drive of the run — including those re-proofs — so nothing outlives the run (evidence stays, per the skill).

5. **Triage.** Wrong or missing user-POV description → doc drift, fix it. Working behavior the harness can't drive → harness gap, fix it; a harness fix follows the same helpers rule as generation (scripts executable, invocation documented in the skill body). App behavior that's actually broken → product gap; record it for the user, keep it out of these fixes. A feature its recipe drives with no browser (an HTTP endpoint, a command) whose file doesn't say so → drift: add `surface: api` (or `cli`) to that file's front matter, so a transcript proves it.

6. **Commit or stop.** For changed: re-read every changed file, then commit the proven corrections on the card's branch; they ship with the card's pull request. For clean or blocked: no commit. Either way, report the outcome and the coverage honestly. Never open a pull request.

Keep concise run notes (features covered, unreachable prerequisites, confirmed drift, outcome) in `.scratch/<card>/`; don't commit them.
