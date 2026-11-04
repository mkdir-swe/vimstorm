# Part: workflows

Passes when the repo's `abe/` folder holds its workflows and Abe's skills. A team part: on a join a failing one is a warning.

1. Run `abe install check workflows`. In a repo with no `abe/` folder it copies Abe's in: `abe/workflows/<id>.yaml` (Feature, Quick fix, Bug, Investigate), `abe/skills/<name>/` (Abe's skills, loaded as `/abe:<name>`; the Abe chat's guide, the run's driver and the install's skill, `abe`, `factory` and `install`, stay Abe's own, and so does each skill's `PROTOCOL.md`, the `abe` commands its steps make) and `abe/installed.json` (what was copied, so a newer Abe's changes are said, never written over). A repo with `abe/` already (a teammate's) gets nothing copied.
2. From then on the files are the repo's: the person and the Abe chat change them like code. A deleted copy is off, never Abe's again. The repo's own Claude Code skills stay in `.claude/skills/`; a person's own workflows stay `.abe/workflows/<id>.local.yaml`.
3. Ordinary changes for the person to review in `git diff` and commit: never commit them, never exclude them.

A warning `Abe x.y has newer <names>` (on the Workflows part, and on `abe/` in the Project tree) means a newer Abe changed those since their base. Nothing is overwritten: when the person asks, run `abe workflow update [<name>…] --json`, each file's three-way update (Abe's as copied, the repo's copy, Abe's now: `copy`, `merged` with their edits kept, `conflict` with git's markers, `deleted` staying deleted), show it, and apply it as they say with `abe workflow update [<name>…] --write`, which writes the files and moves their base in `abe/installed.json`. Resolve any conflict markers it leaves with the person.
