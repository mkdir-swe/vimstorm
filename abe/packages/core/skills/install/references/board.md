# Part: board

Passes when `abe.yaml` names a board that reads live, where cards run, who merges and when a card is Done, and where specs go. Do it once the logins work. A team part: on a join a failing one is a warning.

## 1. Read what is there

- `abe install status --json`: `board` (the board in force, its `from`), `boardProposal`, `read.boards` (the boards the repo names: an Azure DevOps origin first, `why: origin`, then links in CLAUDE.md, AGENTS.md, the README, docs and CI, each with file and line, and a GitHub origin's issues last, `provider: github-issues`, `why: origin`), `shaped.mergeDeploys`.
- What the settings already say: `abe settings explain board --json`, `abe settings explain factory.done --json`, `abe settings explain autoMerge --json`, `abe settings explain spec.where --json`.
- The board's card kinds and states: `abe card list --json`.

**A board that refuses the az login (401, 403): check whether the board is the wrong one before any account.** Compare its org and project with `read.boards`. When the repo names another board, propose that one. Ask the person to sign in again only when the repo names this board, or none. A short answer such as "the other one" means the other board or option you offered, never another account: ask when unsure.

## 2. The up-front questions

Part of the up-front round: each preselected from evidence, each with **Not sure: find out** last. Leave out what `abe.yaml` already says.

- **Where the board is.** **GitHub Issues** (the repo's own issues are its cards: Abe reads and writes them as the gh login), **Azure Boards** (Abe writes to it, or **read-only**: Abe reads the real board; moves, comments, new cards and edits stay on this machine, never sent), or **On this machine** (a board of its own; nothing of it leaves the machine). `provider` is `github`, `azure` or `local` only: GitHub Projects and Jira have no cards in Abe yet. Offer the first Azure board in `read.boards` first, with its `why`; with none and a `github-issues` hint (origin is on GitHub), preselect **GitHub Issues**; the person may name another in their own words or by its URL. The board is never taken from another checkout or a sibling folder.
  - **`boardProposal` set**: a setting names a board the az login can't read, so it is not in force (`board` is null). Ask with its `said` as the reason and its `hint` first (`Use <hint> (<its why>)`). Never offer to keep that board, and never ask the person to switch accounts for it: the repo names its own board. `hint` null: ask for the board's URL.
- **Where cards run**: **On this machine** or **In cloud boxes** (`serve.target: local|cloud`). Cloud boxes need the platform's box infrastructure ([logins](logins.md)'s Cloud fact).
- **Who merges, and when a card is Done** (`autoMerge`, `factory.done`: an environment's name, or `merged`). A card's run always ends in a pull request. When no merge deploys: **A person merges** first, then **Auto merge**, Done at the merge (`factory.done: merged`). When a merge deploys (`shaped.mergeDeploys`): say "a merge here deploys <envs>" and offer **A person merges · Done once <env> deployed** (its first environment that is not prod), **A person merges · Done at the merge**, **Auto merge · Done once <env> deployed**.
- **Where a card's spec goes** (`spec.where`): **GitHub issues** (`issue`: a spec issue with a sub-issue per slice), **On the board** (`card`: the spec and its slices as comments on the card), **Files in the repo** (`file`: `.abe/specs/<card>/`). Recommend `issue` with a GitHub repo, else `card`.

Later, one at a time, when the board raises them:

- **Which cards are this repo's**, only on a **shared board** (an Azure board other repos use too): **an area path** (`board.area`), **a tag** (`board.tag`), both, or **all of the board's cards**. Ask; never guess an area or tag from card titles.
- **Cards no agent can take**, when `abe card list --json` shows cards in a swimlane (`lane`) of cards waiting on others (such as `External dependencies`), or the team tags them: leave that lane (`board.excludeLanes`) or tag (`board.notTag`) out of every list, or keep them. A card's lane is the one on the board of the team that owns its area path.
- **The card kinds the Factory takes**, `multiSelect: true`: the kinds you recommend together first (`User Story, Bug`), then each kind the board has, as `abe card list --json` shows them. On a board On this machine the kinds are only labels: offer the defaults (`User Story`, `Bug`). On GitHub Issues the kinds are `Issue` and `Bug` (an issue labelled `bug`): offer both. Each option's note says which workflow its cards preselect: `Bug` → Bug, `Task` → Quick fix, any other kind → Feature. A board with no `Task` (or no `Bug`) kind taken never preselects Quick fix (or Bug): say so in the question.

## 3. Write it

Edit `abe.yaml` in place, keeping every key there, then `abe settings check .`.

- **An Azure board**: `board: { provider: azure, organization: https://dev.azure.com/<org>, project: <project>, team: <team> }`, plus `area:` (one area path, or a list when the repo's cards sit under several) and/or `tag:` when chosen; `abe settings set board.area '<path>' --repo` (or `'[<path>, <path>]'`) and `abe settings set board.tag <tag> --repo` write them alone; `excludeLanes:` (one lane or a list) and `notTag:` when chosen, `abe settings set board.excludeLanes '[<lane>]' --repo`, `board.notTag <tag> --repo`. From a URL, read org, project and team from its path: a team board (`/<org>/<project>/_boards/board/t/<team>/…`), a backlog or sprint (`_backlogs/backlog/<team>`, `_sprints/taskboard/<team>`), an older link with the team in its path. A link with no team (a query, a work item) takes the project's default team (`<project> Team`), which the board's live read names; when the person names another team, ask for that team board's URL.
- **GitHub Issues**: `board: { provider: github }`: its repo is origin's (`board.repo: <owner>/<name>` only for another repo). Its cards are the open issues, their columns New, then the labels `active` and `resolved`, closed is Closed; `bug` makes a card a Bug, so `board.types` stays `[Issue, Bug]` unless the person narrows it; `tag:` and `notTag:` are labels; no area or lanes. A card is yours when the issue is assigned to your gh login.
- **A board On this machine**: `board: { provider: local, project: <the repo folder> }`, keeping `types`. It starts empty: from what Read saw (the README, CI, the checks) suggest a first small card, and tell the person the command that makes it: `card create --title "<title>"`, after `abe` in Terminal.
- **Read-only** is the person's own, never the team's file: `abe board read-only on`.
- **Where cards run** (`serve.target`), **when a card is Done** (`factory.done`: `<env>` or `merged`), **who merges** (`autoMerge`; when a merge deploys, as an Override with its reason: `overrides: { autoMerge: { value: false, reason: "a merge here deploys <envs>: a person merges" } }`), **the spec** (`spec.where`), **the card kinds** (`board.types`).
- Never write `sources:` by hand ([sources](sources.md)), and never a setting that says who the person is ([logins](logins.md)).

An Azure board picked now needs az: check [logins](logins.md) again. GitHub Issues need only gh.

## 4. The live read

`abe install connection` reads the board live: its kind, org, project, team, iteration and its 3 newest cards, as the board answers them; `Writes` says when it is read-only. A board On this machine shows its name and its newest cards (none yet is fine); GitHub Issues their repo and newest cards. A refused az login's fix names the az folder this checkout reads; a second org's login goes in a folder of its own for this checkout (`board.azureConfigDir`, in `.abe/settings.local.yaml`), never into the other org's folder.

Show the person the board as read in one line, then `abe install check board`. When its line says a workflow is never preselected (no `Task` or `Bug` cards in `board.types`), tell the person in one line: their cards preselect only Feature, and Quick fix or Bug is still theirs to pick at launch; when the board has that kind under another name or left out, offer to add it to `board.types`.
