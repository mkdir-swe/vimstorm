# Wayfinder: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## The Map

`abe settings get spec.where` says where the map lives: `card`, `issue` (the default) or `file`.

**`issue`**: create the map and each ticket with `abe issue create --repo <owner/repo> --title "<title>" --body-file <file> --json`, each ticket with `--parent <map number>` and `--label wayfinder:<type>`. Read one with `abe issue show <owner/repo>#<n> --json`.

**`card`** (a session cannot create or assign cards: the person creates them and gives you their ids):

- **Bodies**: a card's body is a comment: `abe card comment <id> --body-file <file> --json`.
- **The map body**: the newest `# Wayfinder map` comment. Read it with `abe card show <map id>`.
- **Children and types**: `abe card tag <id> --add wayfinder:map-<map id> --add wayfinder:<type> --json`.
- **Frontier**: `abe card list --json` lists the open cards with their tags; read a ticket's comments with `abe card show <id>`.

## Tickets

Claim a ticket, first, before any work: `abe card move <id> Active --json` (or the in-progress state its type has).

## Out of scope

Close a ticket past the destination as Removed: `abe card move <id> Removed --json`.

## Chart the map

Tag the map card: `abe card tag <map id> --add wayfinder:map --json`, then post the map as its first `# Wayfinder map` comment.

## Work through the map

- Load the map: `abe card show <map id>`. Zoom into a ticket: `abe card show <id>`.
- Record the resolution: `abe card comment <id> --body-file .scratch/<map id>/tickets/<id>-resolution.md --json`.
- Close the ticket: `abe card move <id> Closed --json` (or the done state its type has).
