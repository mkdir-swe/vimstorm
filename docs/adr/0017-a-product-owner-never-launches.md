# 0017 A product owner never launches

Status: accepted for 2.0 (design), 23 Oct 2026; 1.0 unchanged. Supersedes ADR 0014's P2 ("one key sends it into the Factory") and the 2.0 design answer that a product owner or designer may launch agents.

A product owner or designer never sends work to the Factory. Their work ends in a card a developer can launch: a prototype finishes with Make card, which writes the card and a spec issue on GitHub that the product owner reads first, and a developer launches it later. The Factory then skips Spec and Build gets the prototype's changes as its reference.

- A product owner still runs agents: to write cards to the board, to ask questions and to prototype, all from the Factory overview.
- A product owner triages (`:triage`) but never launches from it. A card triage marks "needs info" gets an Azure comment and a needs-info tag and comes back to its product owner as Needs you.
- Launching, with the boxes, reaches and spend it uses, is a developer's.

## Trade-offs

- An agreed idea waits for a developer to pick it up instead of starting at once.
- In return every Factory run has a developer who launched it and owns its pull request, and the spec a product owner signs off is the one that is built.

## Consequences

- The product owner's views have no Launch: Make card is where their flow ends.
- A product owner's own environment is for prototypes and asking; it builds nothing.
- Changing this later means deciding who owns a run a product owner starts and which reaches it gets.
