# VimStorm

VimStorm is the native keyboard-first editor. Abe connects planning, agent work and review while preserving the normal editor, Git and terminal experience. These are the canonical terms; ADRs 0001, 0004 and 0006 hold for the editor and tracking, 0008–0021 are Abe as built (0012 superseded by 0016, 0016's Coder part by 0021), 0022–0023 are 3.0's design; 0002, 0003, 0005 and 0007 are history (the retired Rust Abe of 1.x). Architectural decisions are in [docs/adr](docs/adr).

## Language

### Layout

**IDE window**:
The VimStorm window showing one project: main toolbar, editor, tool windows, status bar.
_Avoid_: screen, frame

**Editor**:
The central area where files are edited, made of one or more splits.
_Avoid_: code area, main window

**Split**:
One rectangle of the editor, with its own editor tabs.
_Avoid_: pane, editor window, code window, group (except in "Move to Opposite Group")

**Editor tab**:
One open file in a split. A split holds at most 10.
_Avoid_: buffer, file tab (as an identifier)

**Tab bar**:
The row of tabs at the top of a split or tool window.
_Avoid_: tabline, winbar, header

**Tool window**:
A docked, toggleable area beside the editor with one job: Project, Terminal or Git.
_Avoid_: panel, pane, sidebar

**Bottom tool window**:
1.0's name for the area below the editor; since 3.5 it is Code's **Bottom panel**. `config/bottom.lua` still shares it between the Terminal's, Git's and the pane's (Problems) host windows. An internal name only: nothing in the UI shows it.
_Avoid_: bottom slot, panels

**Project**:
A folder opened as a whole: its files, sessions, git repo. Several can be **open** in the one IDE window, each with its own Neovim, terminals and Git tool window kept running; one is shown, each a tile on the rail: a click on its tile, ⌘↑ / ⌘↓ (Up / Down the Rail) or Recent Projects switch, Close Project (Cmd+Q) ends one (closing the last quits the app).
_Avoid_: agent session (the running conversation). A Workspace links an editor project to agent work.

**Open project**:
A project open in the IDE window, shown or hidden; switching between open projects never loses anything.
_Avoid_: background project, tab (for this)

**Project tool window**:
The tool window on the left showing the project's files as a tree.
_Avoid_: explorer, file tree, project view

**Terminal tab**:
One shell session in Code's bottom panel's Terminal ("Local", "Local (2)"), the Editor's only.
_Avoid_: terminal buffer

**Maximized tool window**:
A tool window temporarily filling the whole IDE window; toggling it back restores the layout before it.
_Avoid_: fullscreen, zoom

**Focus**:
Which split or tool window receives keys; exactly one has it and is drawn active.
_Avoid_: active pane, current pane

**App focus**:
Whether the VimStorm window is active; without it everything is drawn inactive.

**Status bar**:
The bottom line of the IDE window, always about the last focused split.
_Avoid_: statusline

**Islands**:
The look where the editor and each tool window are rounded islands on a gray frame.
_Avoid_: card (for this)

**Rail**:
The column of tiles down a project window's left edge, toolbar to status bar: Abe first, the card workspaces in the order they opened (a ◆ lights a tile, never moves it; a done card's stays until closed), **+** (the Board's New card), then the repo's places Board, Boxes, Pipelines. ⌘↑ / ⌘↓ walk it, round again past either end; ⌘← the Board, ⌘→ from the Board into the card's workspace, ⌘§ Abe and back. Replaced the workspace strip and the stripe.
_Avoid_: strip, workspace strip, stripe (that is Welcome's), sidebar, dock

**Tile**:
One place on the rail: **Abe** (the repo's main checkout, its face `A`; never closes), a card's workspace (its card number and a dot for its state, ☁ on a box), or a repo place (Board, Boxes, Pipelines). Each tile keeps its Chat: docked, maximized or hidden, Chat or Claude Code, its width; a workspace also keeps its page. A workspace tile's menu (right-click, ⌘⏎ over it): Story, Open in Finder, Stop the session…, Delete Working Files…, Close the workspace.
_Avoid_: workspace tab, tab, icon, card (that is the Board's)

**Page**:
What a workspace shows in the middle, picked in its header row: Code ⌃1 (the editor: tree and splits over its **Bottom panel**), Run ⌃2 (the card's run), Card ⌃3 (the Card page). Kept per workspace across launches; Abe has no Run or Card. Only the middle changes: the title bar, status line, rail and Chat stay. Its panes take the keys by ⌘1 (left: the tree, Run's steps, the story) and ⌘2 (main: the open file, Run's step, the story); ⌘3 and ⌘T are the bottom panel's Git and Terminal. ⌘1 (the tree), ⌘3, ⌘4 and ⌘T are **pane keys**, WebStorm's tool-window keys: hidden, shown with the keys; shown, the keys; with the keys, hidden, the keys back to the editor (the Factory view's main pane); ⌘2 only takes the keys.
_Avoid_: view, place (Board, Boxes and Pipelines are tiles), Terminal page, Git page (retired: the bottom panel's tabs)

**Card page**:
The story as a workspace's page (⌃3): its description, acceptance criteria and comments with a composer, and its actions (Comment, Move…, Assign…, Launch again…, Stop the session). Opened by ⌃3, a tile's Story, a menu's Open card; ⏎ on a Board card opens it as a popup over the Board (Esc back to the Board). Replaces the story dialog.
_Avoid_: story dialog (retired), card dialog (New card's), story tab

### Popups

**Popup**:
A window floating over the IDE window that closes on Esc or a click outside.
_Avoid_: card, float, overlay

**Context menu**:
The popup of actions for what is under the mouse or caret (right-click, Cmd+Enter).
_Avoid_: right-click menu

**Speed search**:
Filtering a list by typing after `/`; letters before `/` only navigate.
_Avoid_: filter, search field (for lists)

**Search Everywhere**:
The popup opened by Shift Shift, with All, Files and Symbols tabs.
_Avoid_: picker

**Go to File**:
Search Everywhere on its Files tab, recent files first (Cmd+O).
_Avoid_: file picker

**Find in Files**:
Project-wide text search (Cmd+Shift+F).
_Avoid_: grep

**Switcher**:
The Ctrl+Tab popup: tool windows left, recent files right.
_Avoid_: tab switcher

**Find bar**:
The field searching text inside a split or terminal tab.
_Avoid_: search bar

**Replace bar**:
The find bar with a replace field (Cmd+R in the editor, current file only).
_Avoid_: replace popup

**Tooltip**:
A popup with the error and documentation for the mouse or caret position.
_Avoid_: hover card, hover float

**Balloon**:
A notification at the bottom right that disappears on its own.
_Avoid_: toast, notif

**Quick Definition**:
A popup showing the declaration of the symbol at the caret (Cmd+L).
_Avoid_: peek

**Show Usages**:
The popup listing a symbol's usages.
_Avoid_: references, usages picker

**Context actions**:
Quick fixes and intentions for the caret (Alt+Enter).
_Avoid_: code actions

### Editor content

**Caret**:
The text insertion point in a split.
_Avoid_: cursor (for the editor caret)

**Selected row**:
The highlighted row of a list, drawn as a rounded selection.
_Avoid_: cursor, cursorline

**Selection**:
The text selected in the editor.
_Avoid_: visual, region

**Gutter**:
The column left of the code: line number, bookmark, change marker.
_Avoid_: statuscolumn, sign column

**Folded region**:
Code collapsed to `{...}`.

**Bookmark**:
A numbered mark (1–9) at an exact line and column that follows edits.
_Avoid_: mark, mnemonic

**Markdown layout**:
How a markdown file is shown: Editor Only, Editor and Preview, Preview Only.
_Avoid_: markdown mode

### Version control

**Change**:
One contiguous range of lines that differs between two versions of a file; the diff viewer's actions call it a "difference".
_Avoid_: hunk, block, chunk

**Change marker**:
The colored bar in the gutter marking a change against HEAD.
_Avoid_: sign, change bar

**Rollback**:
Discarding uncommitted work: lines in the editor, whole files in Local Changes.
_Avoid_: reset, revert

**Revert**:
A new commit undoing a chosen commit.
_Avoid_: rollback (for commits)

**Local Changes**:
The Git tool window tab listing uncommitted changed files.
_Avoid_: status, working tree

**Changed file**:
A file listed in Local Changes or in the selected commits' changed files.
_Avoid_: change (for a file), entry

**Included**:
A changed file whose checkbox is ticked, so it goes into the next commit.
_Avoid_: marked, checked

**Log**:
The Git tool window tab listing commits, with filters.
_Avoid_: history (that is a file's history)

**Log filter**:
A restriction on the Log (text/hash, branch, user, date, paths), shown as a chip.

**Selected commits**:
The commits picked in the Log; their combined changed files show on the right.
_Avoid_: marked commits

**Commit details**:
Message, author, hash and branches of the selected commit.

**Diff viewer**:
The side-by-side view of a file at two versions, taking over a split while open.
_Avoid_: diff view, diff window

**Merge window**:
The three-way view (Yours | Result | Theirs) for resolving a merge conflict.
_Avoid_: merge view

**Yours / Theirs / Result**:
The merge window's sides: Yours is the current branch, Theirs the branch merged in.
_Avoid_: ours, a/b, left/right (except in Accept Left/Right)

**Annotate**:
Per-line author and date in the gutter.
_Avoid_: blame (in UI text)

**History for Selection**:
The commits that touched the selected lines.
_Avoid_: line history

### Abe planning

**Story**:
An Azure Boards work item describing planned business work. A story can link to GitHub implementation work without sharing its state or completion rules.
_Avoid_: Ticket, spec, job

**Spec**:
A GitHub issue describing an agreed change and the decisions needed to implement it. It can be the parent of implementation tickets and link to repository documentation.
_Avoid_: Local-only plan, stage

**Ticket**:
An implementable slice of a spec with acceptance criteria and explicit blockers, sized for one writer. A Feature run's to-tickets step cuts them where the spec is: a spec's subissue, a child card of the card, or a file beside the spec.
_Avoid_: Agent session, workspace, story

**Milestone**:
The point in a build where a set of tickets together makes a path work end to end: the full test suite runs there, not per ticket. The last one is every ticket, followed by the checks step.
_Avoid_: checkpoint, phase

**Blocker**:
A ticket dependency that must be resolved before dependent work is considered ready. Blockers remain informational: the developer can launch implementation regardless.

### Agent work

**Workspace**:
A story's working place: its worktree (or its box's) opened as a project, with Chat on its session; a tile on the rail with its pages. Nothing hides one: Stop the session…, Delete Working Files… and Close the workspace are three things.
_Avoid_: Job, conversation

**Open workspace** / **Open worktree**:
Two rows of a card's menu, both ending on a rail tile. Open workspace goes to the card's session's workspace (a box's attached); Open worktree opens the card's branch as a plain project: a local session's worktree, else checked out from origin first (a teammate's card, a box story).
_Avoid_: ⌃W (retired), checkout (for Open worktree), switch workspace

**Worktree**:
A Git working directory on a particular branch. Local implementation work uses an isolated worktree.
_Avoid_: Agent session, cloud sandbox

**Agent session**:
A persistent conversation and its execution state: a Claude Code process `abe serve` owns. A worktree has one current active agent session and can retain older session history.
_Avoid_: Factory stage, workspace tab

**Local sandbox**:
A local execution environment with restrictions on agent-run tools. It is distinct from ordinary unsandboxed local execution.

### Review and operations

**Pending review**:
Unsubmitted pull-request review comments associated with a particular code revision. Posted discussions are separate from these drafts.

**Workflow run**:
A particular execution of a repository pipeline, containing jobs, dependency relationships, logs and any available artifacts.
_Avoid_: Agent session, ticket

**Deploys**:
The Pipelines overview's first group: each workflow that deploys to an environment (a job with an `environment:` or a deploy command, or a name saying deploy and an environment; by hand ones too, pull request previews not), dev → test → prod, with its newest run however old, or Never run. Read beside the newest runs, so a busy repo's checks never push them out.
_Avoid_: releases, environments page

**Pipeline job**:
A unit within a workflow run whose outcome, dependencies, logs and artifacts can be inspected or sent to an agent with Fix with agent.
_Avoid_: Workspace, spec

### Factory

**Factory**:
The runs that carry cards through their workflows (Feature: create-specification, to-tickets, build, checks, review, verify, a gated playbook, then a pull request and done: deployed to its Done environment, `factory.done`: `test` by default, or `merged` for a repo with no deploy). It runs in VimStorm; the UI says Workflows and names a run by its workflow (a Feature run).
_Avoid_: control repo, factory repo, factory job, ledger, stage agents (decider, investigate, spec, build, review-standards, review-spec are the retired first-generation factory)

**End run**:
A person ending a Factory run that cannot go on by itself (`abe factory end <card> --as done|not-reproduced|abandoned --reason <why>`, the card's and Chat's End run…): the why is kept with the run and goes on the pull request (never on the card), its session stops, the card moves to Done (done, not reproduced) or New (abandoned). An abandoned run reads as ended without shipping: `PR ○ Abandoned`, dim, its rail stopped on the stage it was given up in, never Done or ✓.
_Avoid_: clear the run, stop the run (Stop… only stops its session)

**Card comment**:
A comment on a card's thread. The person's: Abe writes one only when they ask (Comment…, triage asking a needs-info card, an agent told to), or where the repo keeps its specs on the card (`spec.where: card`). A run's report, its pull request, its end, an Override and a Sheet write none (ADR 0038).
_Avoid_: card note, auto comment

**Factory overview**:
The Board tile showing the Factory (⌘←, ⌘⌥A): the Board in the middle, tabs Mine · Team · Sessions, the Chat column at its right on the selected card; each card carries its StageRail. 2.0's cards strip and stage lanes are retired.
_Avoid_: Factory (for the page), Inbox, Jobs, lanes, Flow band, History lane (retired), Abe view (the retired chrome swap: the rail keeps the title bar, status line and Chat, only the middle changes)

**Card**:
The Board's entry for a story. Only the entry: what it shows (id, title, stage rail, box state) and its keys (⏎ opens its Card page, ⌘⏎ its actions). The thing itself is the story.
_Avoid_: card for the work item, ticket

**Decider**:
Retired in 3.3: the person picks the workflow at launch (preselected by its `on:`); each step judges its own extras (verify its level, review the risk), and a gate (`when:`) decides whether a step runs.
_Avoid_: triage, investigate, router, launch dialog

**Triage**:
Sorting a backlog (cards and GitHub issues) into ready for an agent, needs info, too big and not for an agent (`/abe:triage` in the Abe chat). Ready ones can be launched together; a card that needs info goes back to whoever wrote it.
_Avoid_: Decider (retired), grooming

**Claude Code first**:
2.0's rule that Claude Code is the only agent runtime: every agent runs in it, signed in with the person's own Claude seat. Skills stay harness-neutral; only the integration is Claude Code's.
_Avoid_: runtime choice, Copilot CLI (1.0), API billing

**Chat**:
A session drawn by Abe from its transcript (2.1: rendered, changes first, turn by turn) in the Chat column; Claude Code's own terminal is its Terminal mode.
_Avoid_: chat view, composer (the field under it)

**Coordinator**:
A session's main agent: it keeps its context intact, hands most work to subagents and merges what they write.
_Avoid_: orchestrator, lead agent

**Subagent**:
An agent a coordinator starts for one piece of a session's work, shown as a folded row in Chat. Readers share the session's container; a writer gets its own worktree.
_Avoid_: task, GitHub task, worker

**Verification level**:
How much proof a piece of work needs: None, After, or Before+after (before taken on the merge base).
_Avoid_: test level, proof mode

**Tracking**:
The record of work: specs, issues, sub-issues, pull requests and decisions. Always on GitHub, never local.
_Avoid_: local spec, scratch tracker, ledger

**Evidence**:
What shows a change works: screenshots, verification reports, scratch report files. Local, git-ignored, disposable; never Tracking.
_Avoid_: proof, show-your-work report, artifacts

**Notes**:
The pull request body's short section of what a reviewer or the next session must know.
_Avoid_: summary, handoff doc

**Verification pack**:
A repo's own recipe for verifying its changes, kept as the skill `verify-<app>`: how to launch the app, a doctor check, how to drive it, the evidence to keep, cleanup, and a map of every user-facing feature it has. Made and proven once by Factory install's Verify stage, kept current when a card changes a mapped feature.
_Avoid_: verify skill, verification skill, verify.md

**Feature map**:
The Verification pack's list of every user-facing feature of the app, grouped and the most used first, one file each: how a person reaches it, how to drive it, and the end state that proves it works. Verify drives the features a change touches.
_Avoid_: feature list, test plan

**Playbook**:
The steps a change needs a person to do or run by hand (deploy steps, a migration, a wizard), written by a run's playbook step to `.abe/playbooks/<card>.md` when its gate says the diff needs them, and read in the editor. A step on an environment the repo does not enable for agents (prod, unless the person turned it on) is always the person's: Abe never runs it.
_Avoid_: runbook, checklist, manual steps

**Run brief**:
The top of a run's page: what the run is doing, why, the plan, and when it is done, with where that came from (the card).
_Avoid_: summary, goal, overview

**Step summary**:
What one step of a run did and the decisions it took (what it chose, over what, and why), with its Evidence and the skills it used; written from the step's transcript when it ends.
_Avoid_: step log, audit log

**Principle**:
A core skill holding one engineering rule and the situation it applies to (prove it works, fix root causes); an agent loads it only when that situation comes up.
_Avoid_: rule skill, guideline, standard

**Factory install**:
Setting a repo up for Abe: the Abe chat following `/abe:install` (`:install`), part by part, each with a check, the install strip atop it until every required part passes. On a repo that already has `abe.yaml` (a teammate's install) only the personal parts.
_Avoid_: factory-setup, connect repo, onboarding, install session (folded into the Abe chat in 3.3)

**Repo id**:
A repo's identity on this Mac, `.abe/id` in its main checkout. serve mints it the first time it meets the repo, and keeps where it last saw it. A repo moved or renamed is known again at its new folder by its id. Its worktrees, install, sessions, runs and held writes then follow it (ADR 0037).
_Avoid_: repo key, project id

**Local only**:
Retired in 3.2: the install has no kinds.
_Avoid_: local install, offline install, Just this Mac

**Connected**:
Retired in 3.2: the install has no kinds.
_Avoid_: full install, remote install

**Install form**:
Retired in 3.2 with the install page: the install is a chat with an install strip.
_Avoid_: wizard, setup wizard

**Form spec**:
Retired in 3.2 with the install form.
_Avoid_: form schema, form definition

**Connection check**:
The live read inside the install's logins, board and sources checks (`abe install connection`): the board and its newest cards, GitHub's repo and account, the cloud's profile and account, each source and the account its server is signed in as.
_Avoid_: verify connection, connection test

**Source**:
What a repo's sessions may use besides the board and GitHub (Sentry, Figma, any MCP server), found by Read in the repo itself and added per source by the person as an MCP server of the main checkout, signed in by serve. Every tool of a source is allowed.
_Avoid_: integration, data source, connector

**Abe env file**:
One of three files, `.abe/abe.dev.env`, `.abe/abe.test.env` and `.abe/abe.prod.env`, holding the values a repo's sessions, checks and `abe run` use for that environment. Prefilled by the install from the repo's own env files, filled by the person in the editor, kept out of git, linked into every card worktree while its environment is enabled; its values never appear in logs.
_Avoid_: agents env file, credentials file, secrets file

**Repo kind**:
What Read finds a repo to be, from evidence in its files: web app, service / API, config as code, infrastructure as code, library, CLI, or a monorepo of these, one kind per part. Run locally, Verify and Checks follow it (ADR 0026). Read reads it wrong, the person says it, `kind:` in `abe.yaml`, the team's (ADR 0040).
_Avoid_: shape, repo shape, repo type

**Worktree recipe**:
`worktree:` in `abe.yaml`, the team's: what a new worktree gets from the main checkout beyond git, `link` (linked: one edit reaches every card) and `copy` (the worktree's own), its script the `worktree-setup` hook (ADR 0032). Each list flat, or grouped per environment: `all` every run, `dev`, `test`, `prod` only while that environment is on for agents (ADR 0040).
_Avoid_: worktree setup, worktree config

**Env placement**:
Where one of the repo's env files goes: the environments it feeds, not used, or not sure. The worktree recipe's group says it (`worktree.link.dev`), `env.notUsed` names the files never used, both in `abe.yaml`; the **env map** (the install's judgement with its evidence, `abe install env-map`) writes them there, and on this Mac places only what `abe.yaml` leaves out (ADR 0040). A group off for agents is skipped whole and denied to sessions; a `prod:` group never turns prod on.
_Avoid_: env mapping, env file map

**Enabled environment**:
An environment (dev, test, prod) a repo's agents reach, turned on by the person alone, for that repo (`agents.<env>` in `.abe/settings.local.yaml`; dev and test on, prod off). One on is reached in full, read and write; one off is not reached at all: no Abe env file, no aws keys, no secret of it (its hosts take nothing without a key). The repo's settings never turn one on, an Override neither; a change applies to the next session.
_Avoid_: prod line, prod lock, read-only mode, safety rule

**Layer**:
One level that skills and settings come from: core (VimStorm), repo, yours. For settings the **Feel**'s bundle is a Layer of its own (`feel`) between core and repo. The repo's settings are `abe.yaml` at its root; yours are `.abe/settings.local.yaml` for this repo (never tracked) and `~/.config/abe/settings.yaml` for editor preferences and your environment. A lower layer adds to the ones above; it lowers one only by an Override.
_Avoid_: level, scope, tier

**Workflow**:
A YAML file naming steps in order and the loops back between them; each step names one main skill and may be fresh, gated (`when:`) or end the run with its report (`ends:`). Abe's are Feature, Quick fix, Bug and Investigate, copied into the repo's `abe/workflows/` by the install and the repo's from then on (ADR 0033). A **card workflow** has `on:` (a card type, tags, or `default`) and is a file: Repo's (`abe/workflows/<id>.yaml`, committed like code) or Yours (`.abe/workflows/<id>.local.yaml` in the main checkout, never committed); Abe's own load only in a repo not installed yet. Of one id the nearest wins: Yours, then Repo's. It is read in the Editor, its YAML beside its preview. A card runs the workflow picked in its Launch box (`--workflow <id>`), else Yours or Repo's whose `on:` takes its type and tags (their `on: default` included), and only then Abe's (Bug, Task, else Feature); its run names the workflow. One with no `on:` (Investigate) is picked, never preselected. Not a CI pipeline's workflow run.
_Avoid_: pipeline, flow, recipe

**Abe folder**:
The repo's `abe/` folder (ADR 0033): its workflows (`abe/workflows/`) and Abe's skills as the repo has them (`abe/skills/`, loaded as `/abe:<name>`), copied in once by the install's Workflows part, with `abe/installed.json` keeping each copy's base. Per file a copy is the repo's and a deleted copy is off (ADR 0034); Abe's own files (`abe`, `factory`, `install`, each skill's `PROTOCOL.md`: the `abe` commands its steps make) are never copied. A newer Abe's changes arrive as a three-way update (`abe workflow update`). Shown first in the main checkout's Project tree, with Abe's head. The repo's own Claude Code skills stay in `.claude/skills/`.
_Avoid_: built-in Layer, Global skills

**Loop**:
A workflow's way back from one step to an earlier one (or the same), taken when its condition holds, at most `max:` times before Needs you.
_Avoid_: retry, rewind

**Check** / **Judge**:
A loop's or a step's condition: a check compares facts the steps report, evaluated by Abe with no model; a judge is one yes/no question the step's own agent answers, kept as a decision.
_Avoid_: rule, gate, judge agent

**Reach**:
One separately granted thing an agent can write to or act on in one environment, such as a cloud role or a database; the only control on agents. Reads need no reach. A write is granted only by an Override in the repo's settings, never one to prod.
_Avoid_: tool policy, permission, allowlist, pinned rule

**Override**:
An explicit lowering of an upper layer's default, with its reason, shown as lowered. A reason is required: one without is refused. The repo's settings or yours may write one, for any setting (a write reach: the repo's alone): it keeps its reason and since when and is shown wherever it acts.
_Avoid_: exception, bypass, go-ahead

**This machine**:
The person's own computer, where VimStorm and the local `abe serve` run, as opposed to a box; on screen "this machine" or "locally".
_Avoid_: this Mac, your Mac (macOS only where it is macOS's: Keychain, the Dock, Homebrew)

**Local mode**:
Your setting per checkout (yours alone): Abe reads the board and GitHub as usual but holds every write on this machine, and agents run here only. Its board is read-only. Turning it off sends nothing held.
_Avoid_: dry run, offline mode, sandbox (that is Claude Code's)

**Read-only board**:
A board whose writes are held on this machine for a checkout: Abe reads the real board, and every change (a move, a comment, a new card, an edit) is one of its local changes, never sent. Local mode makes the board read-only; you can also make it read-only alone, your setting per checkout (`abe board read-only on`). For trying the Factory and onboarding on a real Azure board.
_Avoid_: dry-run board, sandbox board, mirror

**Local changes**:
A read-only board's held writes, drawn over its real cards on the Board (dashed: `Active here · Azure: New`, `edited here`, `1 comment here`) and its held cards (`LC<n>`). **Discard local changes** (`abe board discard`) drops them all; the board then shows as it is.
_Avoid_: overlay (as a word on screen), draft changes

**On this machine** (a board):
A Board kind beside Azure Boards (`board.provider: local`): its cards, states, comments and new cards are kept in Abe's state on this machine (`<state>/local/board`) and never leave it. Chosen in the install's Board step; nothing of it is held, its writes are its own. Its cards are named `L-<n>` wherever GitHub reads them (commits, pull requests): GitHub links `AB#<n>` to Azure Boards' card n.
_Avoid_: local board (on screen), offline board, On this Mac

**Held write**:
A write local mode recorded instead of sending (a card move, a comment, a spec issue, a push, a pull request, a merge), or a read-only board's change: when, what, where it would have gone. It stays a record; it is never published. Discard local changes drops the board's.
_Avoid_: queued write, pending write, draft

**Local pull request**:
The pr stage's pull request in local mode (`#L<n>`): the same body, checks and evidence, merged into the local main or discarded by a person. The card is Done when it merges.
_Avoid_: draft PR, fake PR

### Cloud

**Your environment**:
Your own remote place to work, made of your boxes: where sessions run once you set it up, attached from VimStorm as if local. Until then they run on this Mac. 2.1's UI names the box itself (`☁ demo-shop-102`), never "your environment".
_Avoid_: Factory cloud, cloud sandbox, team server, Send off / Bring back (all retired)

**Box**:
Your personal cloud machine for one repo. It holds a workspace for each story you work on there; it sleeps when none of them is busy, keeps its disk and wakes on open; never shared.
_Avoid_: server, VM, instance, Coder workspace, a box per card, Starting box (retired: no box is shared, so none is ever full).

**Box workspace**:
One story's place on its box: a container, its clone's volume, its database and its sessions (`abe-ws-<card>`, database `ws_<card>`). It goes when the story is Done and merged, or by Remove workspace….
_Avoid_: box per card, workspace container (as a name).

**Port** (of a box workspace):
A dev server's port listening in a box workspace, opened on this machine as `localhost:<port>` (the same port when free, else the next, said; a fixed one only itself). One forward per workspace and port; it sleeps with its box and comes back on wake. Offered, never opened by itself.
_Avoid_: tunnel, port mapping, exposing a port.

**Old box**:
A 2.2 box made for one story (its `abe:card` tag, its one `abe-workspace`). Listed, never launched on; Download locally or Terminate.
_Avoid_: legacy box, 2.2 box (in UI words).

**Box load**:
What a box has left (memory, CPU, disk), read by its serve every 10 minutes. It drives the resize question at a launch and the disk's own growth.
_Avoid_: box health, usage.

**Launch step**:
Where a cloud session's launch stands while it starts: Box starting, Box booting, Building image, Workspace, Starting Claude Code (`session.step`; the box's own `workspace.step`). Each has a usual time; past it the step turns amber, near the give-up red.
_Avoid_: boot phase, progress stage (Stage is a Factory run's).

**Queued**:
A launched card waiting for a box because you have as many boxes running or starting as the repo's settings allow (`limits.maxBoxesPerPerson`); a stopped box never counts, and waking one counts once it starts. It starts once a box stops or is deleted, or the limit rises.
_Avoid_: pending, waiting (that is Needs you)

**Download locally**:
Recovery only: copying a cloud session's work to this machine to continue it here, offered when connecting fails or from the session's menu. **Move to cloud** is the same the other way.
_Avoid_: Bring back, take over, run locally

### IDE

**Role**:
Retired in 3.3: no roles and no product owner; everyone sees everything (the `role` and `alsoShow` settings are dropped).
_Avoid_: persona, user type, permission

**Prototype**:
Throwaway code that answers a design question, written in a worktree on a `proto/<card or id>-…` branch that is never pushed, its `node_modules` cloned from the main checkout, with the app run from it: a question, never a spec. A repo whose app takes fixed ports runs it the normal way on them, the main checkout's app stopped meanwhile and one prototype at a time; any other behind the prototype proxy (ADR 0039). It may change the backend, never the database's schema. It ends with Make card or Discard.
_Avoid_: mock-up, spike, draft PR, demo, prototypes branch

**Prototype session**:
The session a prototype is built in, started by `/abe:prototype` in the Abe chat where cards run (this machine or a box): its own chat beside the Abe chat, with the app's preview link. On this machine it always loads your Figma MCP server, whatever `session.mcp` says. With a card its run sits in Build and never ships.
_Avoid_: Prototype mode (retired in 3.3), developer prototype, code prototype, design mode

**Prototype tile**:
A prototype's dashed tile on the rail, after the card workspaces, until it is discarded: whether its app runs (`Local · on :4000`) or not, its pages Preview (its app live: its own URL on fixed ports, else through its proxy), Code (its diff) and Logs, its Chat the prototype session.
_Avoid_: prototype workspace, Prototypes place, bench

**Local database**:
Abe's one Postgres container on this machine (`abe-pg`, the boxes' image), with a database of its own per local session and per prototype; the box's one Postgres is its twin. A prototype's is kept while it is stopped and dropped when it is discarded; a new one is seeded with the repo's `seed` hook point.
_Avoid_: shared DB, DATABASE_URL (that is the variable), Mac database

**Database hook**:
A repo's `db` hook point (`.claude/skills/run-app/scripts/db` unless `hooks:` says), used instead of the local database (another engine, extensions): `start` prints the URL last, `stop` ends it.
_Avoid_: db script, local Postgres

**Hook point**:
A role Abe calls in a repo, declared in `abe.yaml`'s `hooks:` (ADR 0035): a script (`start`, `stop`, `seed`, `db`, `query`, `prototype-start`, `prototype-stop`, `worktree-setup`), a skill (`run-app`, `testing`, `verify`) or a heading the install checks (`find-out`, `read-data`). One left out is in today's place. Abe asks for a role, never a path; an agent's `abe run` runs what the committed `abe.yaml` places.
_Avoid_: hook (that is Claude Code's), script path, entry point

**Make card**:
How a prototype ends when it should be built: a plain card (New, tagged `prototype`, its `## Prototype` section) whose diff and screenshots are kept in the org store as its prototype reference. No spec yet: the card's run makes it.
_Avoid_: send to Factory, launch, spec (Make card writes none)

**Prototype reference**:
A card's newest prototype version copied into a run's `.scratch/<card>/prototype/` (its `PROTOTYPE.md` first), wherever the run runs: read by every stage as a question, never copied into code.
_Avoid_: spec, source, attachment

**New card**:
Writing a card straight onto the Board. Not Make card, which is how a prototype ends.
_Avoid_: create card, Make card (the prototype's)

**Grill**:
Retired in 3.3 into **create-specification**: a run's first step in Feature, which finds the card's open decisions' answers in the code, docs and the team's sources first (cited), asks the person what is left in rounds (away: in the run's Chat, as Needs you), then writes the spec.
_Avoid_: interview, Q&A, refine

**Launch note**:
What a developer tells the agent before a launch starts: read with the card, never written to it.
_Avoid_: startup notes, notes (the PR body's section), prompt

**Standing note**:
A Launch note a Layer adds to every launch (`launch.notes`): each Layer adds to the ones above it, an Override drops one.
_Avoid_: default note, template

**Launch box**:
Where a launch is set up before it starts: the workflow, the Launch note, the standing notes and reference that go along, and where it runs. Opened by `Launch agent…` and ⇧⏎; plain ⏎ launches without it.
_Avoid_: launch dialog

**Reopen**:
Going back into an ended session of a card: the same session id, the same worktree or workspace, the same Claude Code conversation. A run not over goes on at its stage; a run over is a plain conversation on its own branch (no Factory stage, no new pull request).
_Avoid_: resume (2.2's word for a new session; Claude Code's own flag), relaunch, retry

**Retry run**:
A new session on the same card and worktree that starts its workflow again at its first step; only on a run not over.
_Avoid_: resume, restart

**Launch new agent**:
An explicit new session on a card that had one; the old session stays in Linked, where it can be picked to reopen.
_Avoid_: relaunch

**Crashed**:
An ended session whose Claude Code exited without ending it (no SessionEnd). Reopen goes on with it.
_Avoid_: died, lost

**Abe chat**:
The repo's one chat on your machine, unsandboxed, in the Chat column (`:chat`): it answers about cards, makes cards, starts workflows on one card or many and runs Abe's skills as `/abe:<name>` (install, triage, retro, improve, prototype, make-card). It asks first only before turning prod on and before starting more than one cloud run at once. New conversation starts it fresh.
_Avoid_: hub (in the UI), Ask, ask-abe, install session, Improve chat

**Ask**:
Retired in 3.3: words typed on the `:` line go to the repo's **Abe chat**.
_Avoid_: ask bar, general chat, new job

**Stripe**:
WebStorm's tool window stripe at Welcome's left edge: Project (your recent projects), Board, Sessions and Boxes; Run, Pipelines, Terminal and Git are a workspace's, greyed in its menu. A dot for news, never a count. A project window has the rail instead.
_Avoid_: ear, dock, launcher, activity bar (VS Code's), stripe for the rail

**Org store**:
The org's shared bucket (a folder in tests) for what outlives one machine and belongs to a card: prototype versions, attached Sheets. Read by anyone in the org; never a branch.
_Avoid_: S3 (the implementation), artifact store, shared drive

**Sheet**:
A page an agent makes to show something (data, a report, a prototype), opened as a tab with Show. Yours until you attach it to a card.
_Avoid_: HTML page, report file, dashboard, artifact

**Vim mode**:
The setting for Vim editing (`editor.vim`). Off, the editor works the WebStorm / VS Code way: always typing, arrows, the Feel's keymap, no modes. On, its keys are VimStorm's own (k l ö ä, leader `,`) under the Feel VimStorm and **stock Vim keys** (h j k l, Vim's leader) under any other.
_Avoid_: Vim keys, modal editing (as a setting name)

**Feel**:
One personal pick (`ui.feel`: VimStorm, WebStorm, VS Code or Vim) that sets a bundle of behaviour switches (Vim mode, the tree's reveal, click and change marks, the tabs' limit, dirty dot and preview, auto-save); its own Layer (`feel`) between core and repo, so a switch any Layer writes wins over it.
_Avoid_: profile, preset, mode (for the pick)

**Editor scheme**:
The editor's colours (`editor.scheme`, Editor › Color scheme): **same as theme**, or a named theme whose editor, git, diff and terminal colours the editor keeps whatever the theme (Darcula on a light UI). Dark or light is the theme's alone (Appearance › Theme); no Feel sets either.
_Avoid_: code style, colour theme (for the editor's)

**Home row**:
The one page a setting's row lives on in Settings. Another page may show a link row naming it (`Editor font · Editor › Font`), never a second control for it.
_Avoid_: mirror

**Your nvim config**:
A Neovim config loaded over VimStorm's: the personal Layer's `nvim/` (Feels VimStorm and Vim) and, under the Feel Vim, your own `~/.config/nvim` (never VimStorm's own `nvim/`). Off again on a Feel switch (its plugins stay until the project opens again); an error in it is a balloon.
_Avoid_: rc file, dotfiles

**Imported config**:
Settings and keys brought in from VS Code, WebStorm or Vim / Neovim on first run, ticked one by one; re-runnable.
_Avoid_: bring your own config, migration, sync

**Improve mode**:
Asking VimStorm to change itself for you (`/abe:improve <wish>` in the Abe chat): an agent proposes edits to your own Layer (keys, settings, personal skills, commands), or to the repo's as a pull request. Never VimStorm's code: a wish that needs code becomes a VimStorm issue.
_Avoid_: self-improve, customize, settings agent

**View tweak**:
A part of a screen hidden, moved or renamed by your own `views` setting, named by its node id (`col:Closed`), built only from the parts already there; usually written by `:improve`. Anything more needs VimStorm's code.
_Avoid_: custom view, layout setting

**Improve retro**:
Retired as a chat in 3.3: the retro is a skill, `/abe:retro` in the Abe chat, over your own sessions in the repo: it names what went wrong most first and makes the fixes you pick, to the repo (a pull request) or to your own Layer (a proposal). No reminder.
_Avoid_: retro (as its own concept), post-mortem

### 2.1 shell

**Chat column**:
The right island (420 px, 320–640) beside the code and beside the Board, full height from the header row to the status bar on every tile, where the agent's Chat lives. ⌘4 shows it with the keys in the mode it is in, again (it has them) hides it; its header (or ⌃⌘← / ⌃⌘→) picks Chat mode or Terminal mode, the column's two modes (they never hide it); × or ⌘⌥2 hides it; ⌘⇧D drags it into a window of its own and back. It is pinned to the shown workspace's session (the Board, Boxes, Pipelines: the selected card's); with none it offers Launch agent. Each tile keeps its own: docked, maximized (⌘⇧2) or hidden (⌘⌥2), its mode and width; a torn-out one is the window's.
_Avoid_: right panel, chat pane, the agent tab

**Bottom panel**:
The area under the tree and the editor on Code: tabs Terminal (the workspace's shells) · Git (the Git tool window) · Problems, one shown at a time, then ⤢ (fills the middle) and Hide. ⌘3 shows it on Git with the keys (again, with them: hidden; on another tab: switched to Git), ⌘T on its Terminal (the same way), ⌘J shows / hides it; its top edge drags its height. Each workspace keeps it: shown or not, its tab, its height; a new one starts hidden. Boxes and Pipelines are rail tiles, Sessions a Board tab. The agent never lives here.
_Avoid_: bottom pane (2.x), terminal area, bottom tool window (1.0), Terminal page, Git page, Board tab, Agent tab, Terminals tab (all retired)

**Chat mode** / **Terminal mode**:
The two modes of the Chat column. Chat mode (⌃⌘←) is the rendered Chat; Terminal mode (⌃⌘→) is the same session's Claude Code TUI in the same column, the backup when you want Claude Code's own screen (shells are the bottom panel's Terminal); beside the Board it is the selected card's session attached (Claude Code's own screen, on its box for a cloud one). The other keeps running hidden.
_Avoid_: chat tab, terminal tab (they are modes, not tabs)

**Question card**:
What Chat draws when the session asks: the question, numbered options with the recommended one first, picked with 1–9, ⏎ to confirm, `y` for the recommended, `o` for your own words, Esc for later (it stays Needs you). The same card carries a permission ask under an Override and the Factory's Needs you; a grill round is one card per question, sent as one message.
_Avoid_: popup, dialog, prompt (for the card), AskUserQuestion (that is Claude Code's tool behind it)

**StageRail**:
The row of a run's stages (spec, build, review, PR, done; reproduce and checks light their neighbours', a plain step the one before it: to-tickets spec, playbook review) with the current one lit, drawn on every Board card, on each Sessions row, in a card's header row and in Chat's header. Replaces the stage lanes.
_Avoid_: lanes, flow band, progress bar

**Improve chat**:
Retired in 3.3: `/abe:improve <wish>` in the Abe chat (`:improve <wish>` says it there).
_Avoid_: proposal popup, ProposalLayer (retired), improve one-shot

**Linked**:
Everything tied to the story you are on, in one popup (⌃L): story, prototype, spec, sessions, pull request, pipelines, worktree or box, sheets, each with its state. ⏎ opens one (Pipelines and Box on those tiles). The toolbar's context line is its summary.
_Avoid_: context panel, side panel, Job workspace rows

**Jump**:
⌃L to Linked, from anywhere; ⌃⌥L inside an nvim split or a terminal, where ⌃ keys already mean something. ⌃W (to the linked workspace) is retired: ⌘→ from the Board; so is ⌃I (to the linked story's Card page): ⏎ on a Board card, a menu's Open card. The `g` jump family (`g w`, `g i`, `g p`, `g r`, `g e`, `g s`) is retired; `gg` / `G` are moves and stay.
_Avoid_: go to workspace, g w, ⌃W

**Maximize**:
⌥⌘⏎: the island with the keyboard fills the middle (editor split, tree, Chat, the bottom panel, the Board); the toolbar, the status bar, the rail and the header row stay. ⌥⌘⏎ again or Esc restores. Chat maximized by ⌘⇧2 is the tile's, kept until ⌘⇧2 docks it.
_Avoid_: fullscreen (that is the window's), zoom

**Browser profile**:
A named browser identity a session or verify step runs in (name, purpose, default), listed in a layer; its sign-ins live with the logins (Secrets Manager on a box, `~/.config/abe/chrome/<profile>` locally). The 1.0 work / work-admin Chromes become the first two profiles.
_Avoid_: Chrome (as the concept), the admin Chrome

**Implicit context**:
What Chat sends with your words without being asked: the editor's selection (`@path#L12-18`), else the file and caret line; on the Factory overview, the selected card. Shown as a chip above the prompt; ⌫ drops it for that message. Replaces 2.0's ⌘G.
_Avoid_: ⌘G, inline chat (as the way to ask about code)

**Override**:
Lowering one limit for this session only, on purpose: `/override <what>` in Chat or `:override`, a reason required, tracked in the session and as a PR note (no story comment), shown in Chat's header as `✎ <what> · overridden by you: <reason>`. Sessions otherwise run in full auto; only an overridden area asks.
_Avoid_: bypass, allow mode, permission prompt (as the normal case)
