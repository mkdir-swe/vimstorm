# Make card: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## Making it

- **In the Abe chat**: `abe card create --title "<title>" --description-file <file>`. Its answer has the card's number.
- **In a prototype session**: `abe prototype screenshot add` first, for each screenshot that matters, then `abe prototype make-card --title "<title>" --description-file <file>`. Abe adds the `## Prototype` section and keeps the diff and screenshots in the org store as the card's reference.
- **As a one-shot**: `abe card draft` runs this skill and reads only the JSON it asked for.
