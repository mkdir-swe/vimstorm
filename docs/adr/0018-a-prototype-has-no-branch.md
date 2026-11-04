# 0018 A prototype has no branch: it lives in the org store

Status: accepted for 2.0 (design), 23 Oct 2026; 1.0 unchanged. Supersedes ADR 0014's P1 (the local version), P4 and P5 (run and reopened locally) and P6 (the `prototypes` branch). ADR 0014's R1 (roles) and P3 (a developer's prototype in real code) stand. PT2 superseded 2 Nov 2026 by ADR 0039 (a prototype may change the backend, never the database's schema).

A prototype is never in the repo, on any branch. It is made and saved in your environment (ADR 0016), and Make card uploads it to the org store, linked from the card. It is shown the same way as a Sheet: an agent-made page opened as a tab.

- PT1: ⏎ Prototype starts the app at the default branch in your environment, with a browser tab and Chat; never against the real site.
- PT2: a prototype injects JS and CSS and mocks API responses; it never changes the backend.
- PT3: saved in your environment; Make card uploads it to the org store and links it from the card. No branch.
- PT4: every save is a version.
- PT5: anyone can Show prototype; it runs at the commit it was recorded on.
- PT6: Make card writes the card and a GitHub spec issue, which the product owner reads first (ADR 0017).
- PT7: the Factory skips Spec for that card, and Build gets the prototype's changes as its reference.

## Why

A `prototypes` branch would sit in every repo, never merged, mixing files that are not code with the code, and asking a product owner for git.

## Trade-offs

- A prototype is not versioned with the code it changes; it keeps only the commit it was made on, so a reopened prototype runs the app at that commit.
- The org store's access and retention are now the prototypes' too, separate from the repo's.

## Consequences

- Testing a prototype means a fixture app in an environment, not a fixture git branch.
