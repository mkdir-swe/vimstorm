# Triage: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## 1. Read the backlog

`abe triage --json` reads your cards this sprint; `abe triage --team --json` the team's whole backlog. A one-shot answers one verdict each, with its reason and, for `needs-info`, its one question. It writes nothing.

## 3. Act

- Ask the needs-info cards their question: `abe triage apply <id>…` (one comment and the `needs-info` tag each, once).
- Launch the ready cards: `abe triage launch <id>…` (one Factory run each).
