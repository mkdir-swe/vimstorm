# Install and run

What `install.sh` does, running the app, the repo's layout and notes on the editor.

## Install

```sh
git clone https://github.com/mkdir-swe/vimstorm ~/projects/vimstorm && ~/projects/vimstorm/install.sh
```

The script (unattended, safe to re-run):

- checks for Xcode Command Line Tools, Homebrew and Rust (rustup); if one is missing it says how to get it and stops
- installs what's missing with Homebrew: neovim 0.12+, ripgrep, fd, lazygit, node, tree-sitter-cli, and for Abe bun, gh, tmux, jq, ffmpeg (Verify's recordings as GIFs the Run page plays); awscli only with `install.sh --cloud`, az never (`abe tools check` says how to add it when a repo's board is Azure Boards); Claude Code with its own installer (Docker only a note: a repo with a database needs it for its prototypes and local sessions, and the fake box and image builds)
- builds the VimStorm app (`app/`) with Abe (`abe/`, bun) inside it (`VimStorm.app/Contents/MacOS/abe`, what the app runs as its bridge) into `/Applications` (else `~/Applications`), the `vimstorm [path]` command into `~/.local/bin` and `abe` there as that Abe; a running `abe serve` from the old one is stopped (the next `abe` command starts the new one), unless sessions are live: then it says so and how to restart it
- installs the app's plugins at the versions in `nvim/lazy-lock.json`, treesitter parsers and language servers + prettierd (Mason, list in `nvim/lua/config/tools.lua`): only what is missing, so a re-run retries what failed; if any is still missing it names it and exits 1

### After install.sh

[Getting started](../getting-started.md) walks the first run: the logins, `abe demo new`, `abe install`, ⏎ on a card. Sessions run on this Mac until you set `serve.target` to `cloud` ([Cloud](../cloud.md)).

Your settings on this machine (`~/.config/abe/settings.yaml`, written by `abe settings set`) hold editor preferences and your environment only. A repo's factory settings live in the repo (ADR 0030, 0031): `abe.yaml` at its root is the repo's (`--repo`), `.abe/settings.local.yaml` yours for that repo, never tracked (`--mine`; `--here` is the same). Who you are in a repo goes in yours for it: `logins.gh` (the gh login Abe and its sessions use there without switching gh's active one), `board.azureConfigDir`, `box.profile`, `credentials`, `agents.*`. `abe settings explain <key>` says where a value comes from; `abe settings unset <key> --repo|--mine` takes one out.

`abe tools check` (each tool ✓; Docker is needed for a repo with a database: Abe's local database `abe-pg` gives each prototype and local session its own; also the fake box and image builds) and `abe settings problems` (`No problems`) say what is missing; `abe card list --mine` reads the repo's board. In VimStorm, `:Copilot auth` once, for Copilot's suggestions in the editor.

macOS may ask once, at the first Board read: "Allow VimStorm to find devices on local networks?". It is Abe reaching a server on this machine (127.0.0.1: the fake Azure DevOps a demo or test board runs on); Allow is safe, and Don't Allow only stops a board served on this machine from reading (System Settings › Privacy & Security › Local Network turns it back on).

A repo sets its own `setup` and `checks` in `abe.yaml`, beside the rest of its Verification pack (the `run-app` skill's scripts, `.claude/skills/run-app/scripts/`, and `.claude/skills/verify-<app>/`, a skill and a Feature map of every user-facing feature); without them a run's tests, types and lint checks are skipped.

A repo whose pack names `DATABASE_URL` (its `verify-<app>` skill, `abe.yaml`), or whose env example or `.abe/abe.dev.env` has an empty or Postgres one, or whose CI sets a Postgres one, gets a database of its own for each prototype and local session in Abe's local database (one Docker container `abe-pg`, the boxes' `postgres:17-alpine`, on 127.0.0.1; `abe_proto_<hex>` kept while a prototype is stopped, dropped on Discard; `abe_<session>` dropped when the session ends; `abe serve`'s own `DATABASE_URL` is never handed on). A local session has it in its own environment (its shell, its writers), and its `abe run` and checks in dev, over `.abe/abe.dev.env`'s `DATABASE_URL`; in test or prod they get that environment's Abe env file's. A Factory install's checks (`abe install check`) get its session's the same way. A new prototype database is seeded with the run-app skill's `seed` (`hooks.seed`) before the first start. A repo's `db` script (`hooks.db`; `start` prints the URL last, with `ABE_DB_NAME`; `stop`) is used instead: another engine, extensions. Every pack script run gets `ABE_PORT_BASE`, the first of ten free loopback ports, which its `start` must listen on, so two prototypes and a session's `abe run start` never clash.

Every card runs in a new worktree, which has only what git tracks. A repo says what else a new worktree needs in `abe.yaml`'s `worktree:`, written by the install and checked by `abe install check worktree`: `link` (git-ignored files such as `backend/.env`, linked from the main checkout), `copy`, and `run` (a script, `abe/scripts/worktree-setup`, run last outside the sandbox). An env file mapped only to an environment off for agents (prod, by default) is skipped. The same recipe reaches a card's Before worktree, a prototype and a box workspace (synced from your Mac). A run that stops on a missing file says so; the repo's Abe chat fixes the recipe, no change to Abe needed.

A prototype's worktree gets the main checkout's `node_modules` cloned (copy on write), its install run only when its manifests differ, and its session your Figma MCP server. A repo whose app takes fixed ports (`ports.fixed`) runs a prototype's app the normal way, by its `start` on those ports with no proxy: the main checkout's app is stopped while it runs and started again when the last prototype stops, one prototype on the ports at a time (ADR 0039). Any other prototype's app starts by the repo's `abe/scripts/prototype-start`, written by the install's optional Prototype part (a repo with no web app leaves it): it listens on `$ABE_PORT_BASE`, gets the values of the Abe env file its `# abe-env: dev|test` line names, signs in as the account its `# abe-login:` keys name (names only), and prints the URL to open last. It works on this Mac and on a box (its port forwarded). `abe install check prototype` starts it as a prototype's in a throwaway worktree and goes step by step (script, start, ready on the port, page, login, screenshot), then stops it; a failure names its step and code (`no-start-script`, `port-not-base`, `not-ready`, `no-page`, `login-failed`, …). Without the script a prototype falls back to the Verification pack's start. The script is the team's: you commit it.

## Run

1. `vimstorm [path]` (a project dir or a file; default: the current dir), or VimStorm in Applications / Finder "Open With" / a drop on its Dock icon
2. `:Copilot auth` once (Copilot's grey suggestions)

One app runs at a time: a running VimStorm takes the path (switches to that project or opens it, opens the file in its project) and comes to the front. Every open project keeps its own Neovim (tabs, terminals, Git window, LSP) running in the window until you close it (Close Project); only the shown one is drawn. Cmd+Shift+O (Recent Projects) opens another project in the same window: in place of this one (Enter) or alongside it (Shift+Enter), or switches to an open one.

**Welcome**: closing the last project (Close Project, Cmd+Q, the red button, `:qa`) no longer quits VimStorm when Abe 3.x is installed: the window shrinks to Welcome (its own frame, kept; the project's comes back when one opens), and a launch with nothing to reopen starts there. Welcome lists your cards by state (Needs you, never folded, then Failed, Running, Ready for review, On test, Not started; the longest group folds into `N more…`) above your recent projects. Welcome keeps the stripe at its left edge (a project window has the rail instead): Project (your recent projects), Board; Sessions and Boxes take the Board's place there (Cmd+5 / Cmd+6; Enter on a session: its workspace on its card; a click again or Esc: the Board); Run, Pipelines, Terminal and Git are a workspace's, greyed in its right-click menu; dots, not counts. Settings is the gear in Welcome's title bar. One cursor runs from the cards on into the projects (`k l ö ä`, pages, `gg` / `G`); Tab / Shift+Tab Mine / Team; `/` filters both; Enter on a card opens its project on the Board on that card (its worktree, its box's workspace, or a recent project you pick), launching nothing; Enter / Shift+Enter on a project opens it; Cmd+Enter is the row's menu (a card's: Open story, Assign…, Move…, Comment…, Open in browser, New card…; what needs the project is dim: open the project first; a project's: Open, Show in Finder, Remove from list, also for a folder that is gone, its row dim); Cmd+O Open… and New Project… (the Projects header) pick a folder in the system panel; Clone… (the Projects header, or `:`) asks a repository URL and clones it into `~/projects/<name>`, then opens it (a folder already there opens as it is); Cmd+Shift+O the Projects page (Esc back); `:` and `?` as anywhere. The Dock icon shows the Needs you count and the status bar the board. Cmd+Q on Welcome quits at once; Cmd+W and the red button close the window and VimStorm stays in the Dock (a Dock click or `vimstorm <dir>` brings it back).

Plain `nvim` (`$EDITOR`, `git commit`, `nvim` typed in a terminal tab) gets a light mode of this config if `~/.config/nvim` points at `nvim/`: options, Vim keys and colors, no plugins.

Not in the repo (per machine): Copilot login (`~/.config/github-copilot`), sessions / bookmarks / open projects (`~/.local/state/vimstorm/`), plugins / Mason tools / parsers (`~/.local/share/vimstorm/`). All are recreated by the steps above. The built-in terminal starts a login shell, so it uses your own `~/.zprofile`.

## Layout of this repo

| Path | What |
|---|---|
| `app/` | The VimStorm app (Rust, GPUI): window, native surfaces, terminal, git data; see `app/README.md` |
| `abe/` | Abe (TypeScript, Bun): `abe serve`, the `abe` command and the screens VimStorm draws; see [Abe](abe.md) |
| `nvim/init.lua` | Entry: options, keymaps, plugins, colorscheme, WebStorm keys (plain `nvim`: options, keys, colors only) |
| `nvim/lua/config/` | The engine behind the app's surfaces. Keymaps (`keymaps.lua` from .ideavimrc, `webstorm.lua` Cmd keys), context menu items (`menu.lua`, `context.lua`), tab state (`editor_tabs.lua`, `tabbar.lua`, empty editor `empty_editor.lua`), status bar content + window title (`statusline.lua`), focus model (`focus.lua`), file icons (`icons.lua`), gutter + hover (`gutter.lua`), Shift Shift (`doubleshift.lua`), usages (`usages.lua`), selection / duplicate / paste (`editing.lua`), selection look (`selection.lua`), folding (`fold.lua`), Quick Definition (`peek.lua`), Replace in file (`replace.lua`), `.log` postfix (`postfix.lua`), tree entry points, sessions, Ctrl+Tab switcher data, method jumps; `config/app/` = one bridge module per native surface |
| `nvim/lua/git/` | Git engine for the app: diff / merge panes (alignment, scroll sync), annotate data, `git status` for tab colors, the git CLI runner |
| `nvim/lua/plugins/` | Plugin specs (lazy.nvim) |
| `nvim/colors/darcula-contrast.lua`, `nvim/lua/darcula.lua`, `nvim/after/queries/` | WebStorm Darcula Contrast colors (Islands Dark chrome) |
| `tests/` | Headless engine tests of the Lua (`tests/run.sh`); what the user sees is tested by `cargo test` in `app/` |
| `docs/` | Getting started, cloud, architecture, this reference and the ADRs |
| `infra/aws/` | The Terraform for your own boxes ([Cloud](../cloud.md)) |
| `AGENTS.md` | Notes for agents (and people) working on this repo |

## Notes

- **Feel** (`abe settings set ui.feel vimstorm|webstorm|vscode|vim`, `abe settings feel` lists the switches; one you set yourself wins): VimStorm behaves as this page says; WebStorm is the same with Vim mode off (see Vim mode off); Vim the same with stock Vim keys and your own nvim config (see Feel vim). VS Code: the tree selects the file shown in the editor, one click opens a file as an italic preview tab (the next one-click open takes its place; editing it, saving it or a double-click keeps it), changed files get M / U / A letters at the right, a chain of single folders is one row (`src/deep/one`), no limit of 10 tabs, ● in a modified tab's × place, and no autosave (`files.autoSave` off: Cmd+S saves; closing an unsaved tab asks Save / Don't Save / Cancel; Quit, Close Project and a branch switch still save everything; `afterDelay` writes 1 s after the last change), and a minimap at each editor split's right (`editor.minimap`, also on by itself: the file's lines in small coloured as the editor colours them, the visible part a slider while the pointer is over it; a click centres that line, dragging the slider scrolls)
- Quit VimStorm from its menu (Quit saves every open project; Cmd+Q closes just the shown project)
- Cmd+Enter opens the context menu; full screen is Ctrl+Cmd+F
- Font size (editor and terminal) is Ctrl+Cmd+- / Ctrl+Cmd++ (or Ctrl+Cmd+=; Cmd+- / Cmd++ fold code), Cmd+0 resets it; also in View. Hide / Minimize / Full Screen are in the menu bar. Cmd+E does nothing (Recent Files is `,fr`)
- Colors follow WebStorm's Darcula Contrast (Islands Dark chrome): method calls gold (also `z.object(`), function calls plain, library globals purple, static members and enum members italic; the language server's highlighting, a few seconds after opening a file, keeps the colors drawn on opening (it only adds what needs types, e.g. the italic of `Foo.staticCall()`). The terminal uses WebStorm's terminal palette and the editor font (JetBrains Mono 13), ligatures off
- File icons: WebStorm's own New UI icons (folders, symlinked folders with the arrow, TS / JS / JSON / markdown / CSS / HTML / YAML / text...) in WebStorm's colors
- Islands layout: cards on a gray frame (thin gaps between tree / editor / bottom panel). Popups are cards with icons and rounded selections; the commit files pane stops at the last file
- Gutter: line number, bookmark (number box), then change bar (blue changed, green added, ▁ deleted). Errors are only underlined, no letters; no indent guides or fold column (folding works without it)
- Selections over several lines are a block like WebStorm's: `v` fills the first line from the start column to the edge, the lines in between full width (empty ones too), the last line up to the cursor; `V` fills every line; Ctrl+V block and one-line selections are plain
- `o` / `O` on a `//` line doesn't continue the comment
- Update plugins with `:Lazy update`, then commit `nvim/lazy-lock.json`
