# Prototype: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it. `UI.md` and `LOGIC.md` beside it name no command.

## In the Abe chat: start one

1. `abe prototype start <idea…> [--card <n>] --json` (with `--card` when the idea is a card's) starts the prototype session where cards run (`serve.target`).
2. Read `abe prototype list --json` (the list is `.data.prototypes`, an array: yours is the one whose `id` `start` gave) until its `state` is `live`, then give its `url`: the preview link. `failed`: say its `reason`. `stopped`: it was stopped or discarded, so stop waiting.
3. A card of a prototype on a box: `abe prototype make-card --id <prototype> --title … --description-file …` reads its diff from the box.
4. A prototype app that does not start: the Abe chat checks the repo's script with `abe install check prototype`.

## In the prototype session: build it

- On this machine: the app runs from the worktree by the repo's `prototype-start` hook (else its `start`), behind the prototype proxy; its `url` in `abe prototype list --json` is the preview link.
- On a box: start it with `abe run prototype-start` (`--env test` when its `# abe-env:` line says test; `abe run start` when the repo has none).

## Rules that apply to both

- `abe factory stage-done` is refused `prototype-never-ships` in a prototype session.
- Keep a screenshot: `abe prototype screenshot add --file <png> --what "<what it shows>"`.
- Make it a card: `abe prototype make-card` (the make-card skill says how).
- Throw the worktree away: `abe prototype discard`.
