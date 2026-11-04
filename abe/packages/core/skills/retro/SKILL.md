---
name: retro
description: Looks back over the person's agent sessions from the Abe chat and talks the findings through, most severe first, each traced to moments in the logs, sorted into Fix here (the repo's files, or the person's own) and Send to Abe (an issue on Abe); makes the fixes the person picks. Use when the person invokes /abe:retro or asks what to improve after hard runs.
metadata:
  upstream: "mattpocock/skills@a7d038f skills/engineering/retro (one go over the log store, no tools; Abe's sources, Layers and earlier fixes on top)"
---

# Retro

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

1. Ask Abe's Retro one-shot (`PROTOCOL.md`, 1. Read the sessions): it reads your sessions in this repo since the last retro and answers findings, most severe first, each with its moments in the logs (`<session>/<file>#<line>`), where its fix belongs and the fix itself. When nothing moved since, read the last one.
2. Write every finding in the chat before you ask anything, in the order the JSON gives them (most severe first; never regrouped or resorted). For each:
   - `#<n> <severity> · <title>` and its label: **Fix here** or **Send to Abe**.
   - What happened: `whatHappened`, in full.
   - The log moments, one line each: `at` (when there), `ref`, and its `text` in quotes, as `02:37:56 · 4-a1b2/transcript.jsonl#7 · "…"`. Never paste raw JSON, never a backslash before a quote: `text` is already words (a JSON file's line reads `doneWhen: An existing id…`).
   - The fix: **Fix here** with `layer` `repo` says it is written into this checkout, uncommitted (a pull request instead, when the person asks), and names `fix.files`; `layer` `individual` says it becomes a personal proposal, applied through Abe's Improve. **Send to Abe** (`layer` `abe`, a bug or missing feature in Abe itself) gives the drafted issue's title and its whole body (`fix.issue`), word for word.

   Fix here covers anything in the repo (`abe.yaml` incl. `worktree:` and its env groups, `env.notUsed`, `checksEnv`, `kind`, checks, scripts under `abe/scripts`, `.claude/skills`, `CLAUDE.md`, `settings.local.yaml`) or the person's own files. Read a moment's line in the logs when they doubt it.

3. Ask with AskUserQuestion which findings to make; each option's label carries its number and Fix here or Send to Abe. Picking makes nothing yet and files nothing. Then, for each picked, in order:
   - A repo one: Abe makes it, writing its files into this checkout, uncommitted (`PROTOCOL.md`, 3. Make the picked). Show `git diff`; never commit. No further question. (A pull request instead, only when the person asks for one.)
   - A personal one becomes an Improve proposal: show it and ask before Abe applies it.
   - A Send to Abe one: write its title and whole body in the chat again, word for word, then ask with AskUserQuestion, options in this order: **Don't file**, **Change it**, **File it** (never File it first: the first is picked on a bare ⏎, and File it opens a public issue). It must read generic: no repo, host, area, person, environment variable or card names; if it has any, show your rewrite instead.
     - File it: Abe files it on Abe's repo (never one you ask the person for). For your rewrite: write it to `.abe/abe-issue.md` here (never your own scratchpad), file it through Abe on Abe's repo, then remove the file (`PROTOCOL.md`, 3. Make the picked).
     - Change it: rewrite it with their words, show it whole, ask again.
     - Don't file: nothing is filed.
       Never file a finding before the person picked File it for that finding.
4. Say what was made: the files changed here, each issue's link.
