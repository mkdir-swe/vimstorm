# 0024 · Folders by domain, and a folder's interface is all others may import

Status: accepted for 3.1, 27 Oct 2026. Keeps the package rules of the platform spec; adds a rule inside each package.

Every package in `abe/` is laid out by domain. A folder under `src` is a module, with one interface file (`index.ts` unless its row names another). Other folders, and other packages, import only that file. Everything else in the folder is private. Each package lists its folders in its own table, `packages/<package>/folders.ts`, with the folders each one may import. The dependency graph test reads every table. It fails an import past a folder's interface, an import of a folder the row doesn't name, a folder the table lacks, and a cycle between folders. Test files follow the folder rules too. A test imports its own folder's interface, the interfaces its folder may import, the harness and other packages' entry points. It reaches a private file of its own folder only when the table names that file as a seam.

The move to folders runs over several stages, so each table also lists the folders not swept yet. The graph skips their imports. The list only shrinks, and a folder on it that breaks nothing fails until it comes off. The prose check keeps the same kind of list. It fails on issue numbers in comments, test names and docs, and on em dashes and unslop's words in comments and docs, outside the folders still listed as unswept.

**Why.** Core, serve, ui and ports grew into flat folders of 77 to 158 files with a test file per source file. Nothing said which modules were deep and which were leftovers of one issue, and agents copied the flat shape with every change. A folder with one interface tells an agent what it may import and where a test goes. A table per package means stages that move different packages never edit one shared file.

**Trade-offs.** One more file per package to keep up, and a new folder needs a row before anything builds on it. A seam a test needs has to be named in the table, so reaching inside a folder is visible in review.

**Consequences.** Core's package entry exports one entry per domain folder instead of every file, and ui's list of single core files becomes a list of core's domain interfaces. In the app, Rust's privacy does this job: a folder's `mod.rs` is its interface, with no new test. Nvim's Lua keeps its layout.

Amended 27 Oct 2026: a command row's type, its arguments, its outcome and its exit codes live in core's `command` folder, not in `contract`. `contract` gathers every noun's rows, so it imports every noun, and a noun's rows that imported it would make a cycle.

## The app's folders

The app has no folder table and no graph test. Rust's privacy enforces the rule. Each folder under `app/src` is a module. Its `mod.rs` is the interface, its files are private `mod`s, and `mod.rs` re-exports what other folders use, `pub` when a test or `main.rs` needs it and `pub(crate)` otherwise. A subfolder is a module of its own with its own `mod.rs`, so it can be `pub`. Two names that clash in one interface get an alias at the re-export, such as `kit::popup_frame`.

| Folder | Holds |
|---|---|
| `app` | process life: menu bar, log, single instance, timing |
| `devtools` | key bench, drive socket, offscreen shots |
| `nvim` | the process, RPC, redraw, UI state; `nvim::lua` is the Lua calls (`lua::call`, `lua::decode`, a surface's `on_lua`) |
| `render` | fonts, cell metrics, the grid element |
| `look` | the palette and metrics (`theme.rs`) and the look in force |
| `kit` | the shared widgets |
| `editor` | the editor view; `input`, `tabs`, `statusbar`, `floats`, `markdown`, `minimap`, `replace` |
| `search` | the pickers and the project scope |
| `popups` | menus, dialogs, balloons, key help |
| `shell` | the window root, layout, column, pane; `projects` (open projects, the stripe, maximize, welcome), `toolbar`, `tree`, `remote` (a cloud workspace) and recent projects |
| `git` | the CLI data; `window` (the Git tool window), `diff`, `annotate` |
| `terminal` | PTYs, the terminal element |
| `factory` | the Factory view, Abe's bridge (`BridgeCommand`), the component drawing; `pages` (BrowserView pages) |

"Bridge" in the app means Abe's `abe ui bridge` only. Nvim's Lua side keeps its own folders.
