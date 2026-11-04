# Retro: Abe's side

Abe keeps this file; the repo's `SKILL.md` beside it says how the work is done, this file the `abe` commands that record it.

## 1. Read the sessions

`abe improve retro me --json`: a one-shot reads your sessions in this repo since the last retro and answers the findings as JSON, most severe first. Nothing moved since: `abe improve retro last --json` is the last one.

## 3. Make the picked

- A repo one (`layer` `repo`): `abe improve retro make <n> --json` writes its files into this checkout, uncommitted. `--pr` opens a pull request instead, only when the person asks for one.
- A personal one (`layer` `individual`): an Improve proposal, applied with `abe improve apply <id>` once the person says so.
- A Send to Abe one (`layer` `abe`), only once the person picked File it: `abe improve retro make <n> --file --json` files it on Abe's repo. Never run `make` with `--file` before that.
- Your rewrite of a Send to Abe one, from `.abe/abe-issue.md`: `abe issue create --repo <abe settings get improve.issueRepo> --title "<title>" --body-file .abe/abe-issue.md`, then remove the file.
