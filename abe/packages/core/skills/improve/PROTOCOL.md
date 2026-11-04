# Improve: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## Show before you ask

`abe improve` prints its answer as a ready block (label, then the whole change or the whole draft), then a `Next` line. Paste everything above `Next` word for word, then do what `Next` says.

## 1. Ask Abe

Run `abe improve "<the wish, in their words>"`. A one-shot proposes whole files in the personal Layer and writes nothing; or it says the wish needs Abe's code (a draft issue, not filed), or that nothing needs to change. It also says where Abe's own issues go.

## 2. A proposal

- Apply: `abe improve apply <id>`. `abe improve undo` takes it back.
- Change it: `abe improve "<what to change>" --again <id>` with the person's words.

Only `abe improve apply` writes the personal Layer's files, so `undo` can take it back.

## 3. Send to Abe

Only on File it, with the body in `.abe/abe-issue.md` in this checkout, on the repo `abe improve` named:

```sh
abe issue create --repo <that repo> --title "<title>" --body-file .abe/abe-issue.md
```

Then remove the file and give the issue's link.

## A source

The install skill's [sources](../install/references/sources.md) reference, steps 3 to 6, for that one source: `abe install source <name> …`, its sign-in or the person's values in `.abe/sources.env`, `abe install connection`, `abe install check sources`. A server that needs a secret is added by reference (`--env <KEY>`).

## A run stalled on a missing file

After the worktree recipe is edited: `abe install check worktree`.
