# 0019 Session logs go to one org store, open to every team

Status: accepted for 2.0 (design), 23 Oct 2026; 1.0 unchanged.

Improve retro (`:improve-retro`, scope me, team or org) is how we improve: it reads what happened in agent sessions and proposes fixes to the layer they belong in. For that, every session's logs are shipped to one store in the tooling account (`abe-logs/<team>/<you>/<session>`), secrets redacted, kept 90 days. Every team can read all teams' logs, because every team runs the same skills; you see your own.

- R1: retro is a core loop. It proposes fixes to their layer and never applies them.
- R2: it reads transcripts, checks, verification reports, review rounds, pull request comments, Overrides and their reasons, deploy failures and time in stage.
- R3: the store above.
- R4: every team sees all teams' logs; you see yours.
- R5: personal after a hard session and weekly, team per sprint, org monthly.
- R6: a retro is a chat, not a view: findings most severe first, each traced to a moment in a log, talked through; "make it" opens a pull request to its layer (a personal fix through Improve).
- R7: earlier fixes are checked again; recurring or noisy ones are proposed for removal.
- R8: Matt Pocock's retro skill is the base (navigation pointers, automated checks, reviewer standards, AGENTS.md trims, tool economy, no-ops, information access); our sources and layers go on top, in core.

## Considered options

- **Logs kept on each machine or box:** a retro could only see its own sessions, and a team or org retro would have nothing to read.
- **Logs per team, closed to other teams:** a fix one team finds in a shared skill would stay hidden from the teams running the same skill.

## Trade-offs

- Everything an agent did, said and read is visible across the org for 90 days. Redaction covers secrets, not what a session was about.
- The store, its redaction and its retention are something we run and must get right before the first log is shipped.

## Consequences

- Retro is not its own concept name: it lives inside Improve, beside `:improve <wish>`.
- Shipping logs is part of every session, local or cloud.
