---
name: improve
description: Changes VimStorm for the person from the Abe chat, in their personal Layer (settings, keys, personal commands, personal skills; the Neovim config for developers), fixes the repo's own Abe files here, or drafts an issue on Abe when the wish needs Abe's code. Use when the person invokes /abe:improve or wishes VimStorm did something differently.
---

# Improve

Abe's side of this skill, the `abe` commands that record each step and what they answer, is `PROTOCOL.md` beside this file: read it first.

Sort the wish first:

- **Fix here**, the repo: anything in this repo's files: `abe.yaml` (its `worktree:` and where each env file goes, its groups, `env.notUsed`, `checksEnv`, `kind`, checks, ports, `pr.pushTimeout`, gate answers, `sources:`), scripts under `abe/scripts`, `.claude/skills`, `CLAUDE.md`, `settings.local.yaml`. Make the change yourself in the checkout. Never commit: the person commits it.
- **A source**: a tool for agents to read (an MCP server: feature flags, errors, a wiki). Below.
- **Fix here**, the person's own: their keys, settings, personal commands and skills. Steps 1–2 below.
- **Send to Abe**: a bug or missing feature in Abe itself, which no file here can change. Step 3.

**Show before you ask.** Every answer goes in the chat, whole, under its label, before any AskUserQuestion. An option's label or note never carries it.

- A repo fix: write `**Fix here** · repo: <one line>`, then its whole `git diff` in a fenced block.
- Abe's Improve one-shot prints its answer as a ready block (label, then the whole change or the whole draft), then a `Next` line (`PROTOCOL.md`, Show before you ask). Paste everything above `Next` word for word, then do what `Next` says.
- Several ways (a repo fix and a personal proposal): show each, labeled, then ask once.

1. Hand the wish, in their words, to Abe's Improve one-shot (`PROTOCOL.md`, 1. Ask Abe). It proposes whole files in the personal Layer and writes nothing; or it says the wish needs Abe's code (a draft issue, not filed), or that nothing needs to change.
2. Paste its block. A proposal: ask with AskUserQuestion: Apply, Change it, Not this.
   - Apply: Abe applies it (`PROTOCOL.md`, 2. A proposal). Say it is done and that Abe's undo takes it back.
   - Change it: ask the one-shot again with their words, on the same proposal (`PROTOCOL.md`, 2. A proposal), and paste its block again.
   - Not this: nothing is written.
3. Send to Abe: the block is the draft's title and whole body (from the one-shot; your own when the wish's cause is in Abe though the one-shot proposed something else: write `**Send to Abe** · a draft issue, not filed`, the title, the whole body). Keep it generic: no repo, host, area, person, environment variable or card names from this repo; say "a repo's pre-push hook", "a test host". Then ask with AskUserQuestion, options in this order: Don't file, Change it, File it (never File it first: the first is picked on a bare ⏎, and File it opens a public issue). File where the one-shot says Abe's own issues go, never on a repo you ask the person for. Only on File it: write the body to `.abe/abe-issue.md` in this checkout (never your own scratchpad or a temp folder), file it through Abe (`PROTOCOL.md`, 3. Send to Abe), remove the file and give the issue's link. Change it: rewrite with their words, show it whole, ask again.

Never write the personal Layer's files yourself: only Abe's apply does, so its undo can take it back.

## A source

A wish for agents to read something (feature flags, errors, a wiki: an MCP server) is a source of the repo, not VimStorm's and not the personal Layer's. Load the install skill's [sources](../install/references/sources.md) reference and do its steps 3 to 6 for that one source: add it, its sign-in or the person's values in `.abe/sources.env`, its connection, its check (`PROTOCOL.md`, A source). No Improve one-shot and no issue for it. A server that needs a secret (an API user and password, a token) is added by reference to its key; the person fills its value in their editor (`! open -t .abe/sources.env`), and you never print it, read it back or commit it. Then tell the person to commit `abe.yaml`.

## A run stalled on a missing file

A wish that comes from a run stopping on a file its worktree lacked (an env file the tests read, a generated file, a team skill) is the repo's to fix, not VimStorm's and not the personal Layer's. It goes in the repo's worktree recipe, `worktree:` in `abe.yaml` (`link`, `copy`, or the script at `abe/scripts/worktree-setup`): load the install skill's [worktree](../install/references/worktree.md) reference, edit those files yourself, check the worktree part (`PROTOCOL.md`, A run stalled on a missing file), and tell the person to commit them. No Improve one-shot and no issue for it.
