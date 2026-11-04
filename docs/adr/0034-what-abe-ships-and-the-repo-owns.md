# 0034 · What Abe ships and the repo owns

Status: accepted, 31 Oct 2026. Amends ADR 0033 (workflows are files, read in the Editor): settles which of Abe's own files load after the install, and keeps each step's Abe commands out of the repo's copies.

ADR 0033 copies Abe's workflows and skills into the repo's `abe/`. Three things about them were unclear:
- "From then on Abe's own do not load" held for the workflow loader, but a session's plugin took core's skill wherever the repo's copy was missing. A deleted copy came back as Abe's in sessions and was off in the loader.
- `abe/installed.json` kept each file's hash as copied and never moved it. An update applied by hand left the skill reading as newer, then as edited, for ever.
- The copied stage skills carried Abe's own CLI calls (`abe factory verify --phase after …`, about 150 of them). Each change to the CLI made every repo's copies stale, and a fix to a skill never reached a repo that had installed it.

**One module owns the shipped files** (`core/src/shipped/`). It holds the shipped set, the copy into a repo, what a session or the workflow loader sees for a repo, and the three-way update. The loader, the session plugin and the Project tree call it; the repo's `abe/` folder is its port.

**One rule, per file.**
- Each shipped file is the repo's once copied, or Abe's own. Abe's own are the Abe chat's guide (`abe`), the run's driver (`factory`), the install's skill, the one-shots' prompts and each skill's `PROTOCOL.md`. They are never copied, and a repo's file at their path is not read.
- In an installed repo a copy wins, and a deleted copy is off: neither a session nor the loader falls back to Abe's.
- A repo not installed yet sees Abe's.

**An update is a three-way merge that moves the base.**
- The base is Abe's text as copied. `installed.json` keeps its hash, and git's history of the file holds its text.
- `abe workflow update` answers each newer file: Abe's when the copy was never edited, a merge that keeps the repo's edits, or a conflict with git's markers. A deleted copy stays deleted.
- `--write` writes them and moves each base to Abe's text now, so the file is no longer newer and is never read as edited.
- The Workflows part and the Project tree's `abe/` row say `Abe x.y has newer <names>`.

**A step's Abe commands stay Abe's.** Each copied skill is in two parts:
- The repo's `SKILL.md` holds its policy: how the repo verifies, tests and reviews, and what a report holds. It calls no `abe` command.
- Abe's `PROTOCOL.md` beside it holds the commands the steps make, their flags, their answers and refusals.
- A session's plugin has the repo's `SKILL.md` and Abe's `PROTOCOL.md` in one folder, so a step runs with this Abe's CLI whatever copy the repo has.
- An existing install's next update merges the commands out of its copies and keeps the team's edits.

Considered:
- **Keep per-skill fallback to core's.** A team could not turn off one of Abe's skills, and the loader and sessions would still disagree.
- **Keep base texts in `installed.json`.** It would put about half a megabyte in every repo. Git already has the copy the person committed, and a base it cannot find makes a conflict, never a silent overwrite.
- **Carry the commands in the factory skill's brief only.** A skill the person invokes in the Abe chat (triage, improve, prototype) has no brief. A file beside the skill serves both.

Hard to reverse: once repos have their copies split, putting the commands back means a merge into every copy.
