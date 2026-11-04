---
name: triage
description: 'Sorts the backlog in the Abe chat: a verdict per card or issue (ready for an agent, needs info, too big, not for an agent) with its reason, then, as the person says, asks the needs-info cards their question and launches the ready ones. Use when the person invokes /abe:triage or asks to sort, triage or groom the backlog.'
metadata:
  upstream: 'mattpocock/skills@59db609 skills/engineering/triage (cut to four verdicts read from the item alone; no labels, grilling, briefs or closing)'
---

# Triage

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

1. Ask Abe's Triage one-shot for your cards this sprint, or for the team's whole backlog when the person means it (`PROTOCOL.md`, 1. Read the backlog). It reads each item and answers one verdict each, with its reason and, for `needs-info`, its one question. It writes nothing.
2. Show the verdicts as one short table: item, verdict, reason (and the question). Group them: ready, needs info, too big, not for an agent.
3. Ask once, with AskUserQuestion, what to do with them; offer the picks, each preselected:
   - ask the needs-info cards their question (one comment and the `needs-info` tag each, once; `PROTOCOL.md`, 3. Act);
   - launch the ready cards (one Factory run each). Several runs while `serve.target` is cloud: this question is the confirm the Abe chat asks before starting several cloud runs.
4. Say in one line what was done. A too-big card: offer to split it with to-tickets. A not-for-agent card: leave it to the person.

A verdict is the one-shot's; when the person disagrees, take their word and act on it.
