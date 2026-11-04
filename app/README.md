# VimStorm app

A native macOS window, drawn with GPUI, around an embedded Neovim that runs the repo's `nvim/` config. It is VimStorm's only frontend. The Lua in `nvim/` is the engine, the data providers and the bridges, and Rust draws everything, Abe's screens included (`src/factory`, from `abe ui bridge`'s component trees; `../abe/README.md`). Why and how: [ADR 0001](../docs/adr/0001-gpui-frontend.md), [ADR 0013](../docs/adr/0013-abe-in-typescript-on-a-rust-shell.md).

The app's nvim runs with `NVIM_APPNAME=vimstorm` and `XDG_CONFIG_HOME=~/Library/Application Support/VimStorm/config` (`vimstorm` there links to `<repo>/nvim`), so its plugins / state live in `~/.local/share/vimstorm` / `~/.local/state/vimstorm`.

## Prerequisites

- Rust via rustup. cargo isn't on PATH by default here:
  `export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"`
- Neovim 0.12+ (`nvim` on PATH), plus the tools `install.sh` installs (git, rg, fd, node)
- Xcode Command Line Tools are enough: GPUI's `runtime_shaders` feature compiles the Metal shaders at startup (no `xcrun metal`)

## Run

```sh
scripts/warmup.sh            # once (network, a few minutes; again: what is missing): plugins, parsers, Mason packages into ~/.local/share/vimstorm
cargo run -- <path>          # a project dir, or a file (opens its git work tree / dir); default: cwd
                             # a running VimStorm takes the path instead (VIMSTORM_NO_INSTANCE=1: a second app)
                             # open projects: one nvim each in the one window (src/shell/projects/mod.rs),
                             # Cmd+↑ / Cmd+↓ walk the rail, Cmd+Q = Close Project (the last one quits; also the
                             # context menu / Recent Projects… popup); app menu Quit = all, saved (asks if work would be lost)
                             # no path from the Dock / Finder: reopens the projects open at the last quit
                             # (<state>/vimstorm/open-projects.json; hidden ones start on first show)
VIMSTORM_BACKGROUND=1 cargo run -- <path>  # window without focus / bringing the app to the front
VIMSTORM_TIMING=1 cargo run -- <path>   # startup milestones (ms) + per-key latency on stderr
```

Startup: "editor frame painted" = first frame with an editor split (as `config/app/layout.lua` reports it) with text; the tree is native since M2. Key latency (`VIMSTORM_TIMING`): per key, ms from the key reaching the view to `nvim_input` sent / flush read / flush applied / frame draw / paint / next vsync (≈ on screen). Bench on a real window: `VIMSTORM_BENCH_KEYS='#normal ö ö ä #insert o c o n s t escape' cargo run --release -- <path>` dispatches GPUI keystrokes (space separated; `#name` starts a summary section) one at a time, prints median / p95 / max per section, then quits nvim without saving (`VIMSTORM_BENCH_DELAY_MS`, default 3000, waits for plugins / LSP first). `~<ms>` waits, `open:<dir>` opens / shows a project (switch / memory runs with `cmd-down`, `cmd-q`). macOS draws no frames for a window that's covered (`VIMSTORM_BACKGROUND` runs behind your work): a key then logs up to the flush after `VIMSTORM_BENCH_KEY_TIMEOUT_MS` (default 500); frame numbers come from the test context (`tests/perf.rs`).

The repo (the `nvim/` config) is `$VIMSTORM_REPO`, else an ancestor of the binary, else the path the binary was built from. Fonts (JetBrains Mono, Inter, the WebStorm Icons font for icon glyphs in nvim text; all in `assets/fonts/`) are compiled in.

Release builds print a harmless `rust-objcopy ... libLLVM.dylib` warning with this toolchain (debug info isn't stripped).

## Layout

One Cargo package, `vimstorm` (`src/`, one binary, one `Cargo.lock`, one `target/`): GPUI, everything drawn, the embedded Neovim. Abe is not Rust: its rules, commands and screens are TypeScript in `../abe` (`abe serve`, `abe ui bridge`); `src/factory` draws the bridge's component trees and `src/shell/effects.rs` runs its shell effects ([ADR 0013](../docs/adr/0013-abe-in-typescript-on-a-rust-shell.md)).

The window root is `src/shell` (`Workspace`): main toolbar (traffic lights inside it), the Islands body (tree panel, nvim's windows as rounded islands, Code's bottom panel under them (Terminal · Git · Problems), the Chat column at the right: `src/shell/column.rs`) and the status bar; the projects window draws the rail at the left edge and the header row with a workspace's pages (`src/shell/projects/rail.rs`, `pages.rs`). nvim's layout stays logical: each window is mapped to its island in pixels and its grid sized to fit (`nvim_ui_try_resize_grid`); see `src/shell/layout.rs`. Native surfaces (toolbar, tree, tabs, status bar, popups, pickers, floats, the Git tool window `src/git/window`, diff / merge chrome `src/git/diff`, annotate + change gutter `src/git/annotate`, the terminal `src/terminal`, the markdown preview `src/editor/markdown`) are entities in their own `src/<surface>/`; the contract (bridge, focus, geometry) is at the top of `src/shell/mod.rs`.

State ownership: Rust owns git data (`src/git`: log + graph, status, commit, push / pull / fetch, blame; the git CLI off the UI thread) and draws the Git tool window, the bottom panel's Git tab, over one placeholder nvim window (`config/app/git.lua`); diff / merge panes stay nvim windows with native chrome; Rust owns the terminal (`alacritty_terminal`: PTYs, parsing off the UI thread, tabs, scrollback, find, selection; drawn over one placeholder nvim window as the bottom panel's Terminal, beside Git's, `config/app/terminal.lua`) and renders the markdown preview (pulldown-cmark, WebStorm's preview CSS values); Rust also owns the tree (state, file ops, git status colors), pickers (file walk + fuzzy match with `nucleo-matcher`, Find in Files with `rg --json`), the switcher, balloons, menu rendering and the toolbar (recent projects, branches via the git CLI). Lua keeps editor tab state, menu item providers, LSP (symbols, usages, rename with import updates) and sessions. They talk over typed bridge messages: Lua `require("config.app.bridge").notify(surface, {event = ...})` (one `nvim/lua/config/app/<surface>.lua` per surface) and Rust `nvim::lua::call(rpc, module, fn, args)`, both as notifications (nothing waits on nvim).

Keys: Rust owns detecting and routing them (`src/editor/input`: nvim notation on the Swedish layout, IME, double Shift; `src/editor/input/keymap.rs` lists every WebStorm shortcut, its owner and which keys a focused native surface lets through to nvim) and the window-level shortcuts (`src/app/menu.rs`: menu bar, Hide Cmd+H, Hide Others Cmd+Alt+H, Minimize Cmd+M, Toggle Full Screen Ctrl+Cmd+F, editor + terminal font size Ctrl+Cmd+= / + / -, Cmd+0 reset, kept for the app run). Actions that depend on nvim's mode / focus / view stay Lua maps on the `<D-…>` notation Rust sends (`config/webstorm.lua`, `config/app.lua`). Menu items do what their shortcut does by typing it into the window, except the direct actions (Close Project, Quit VimStorm, Down / Up the Rail, New Workspace…, the font sizes and the window items above).

Licenses of what's bundled: `nucleo-matcher` is MPL-2.0 (used unmodified as a dependency); the icons in `assets/icons` are IntelliJ IDEA Community Edition's (Apache-2.0) or VimStorm's own (its NOTICE lists each file's source), the WebStorm Icons font in `assets/fonts` (`WebStormIcons-NOTICE.txt`, Apache-2.0; `scripts/bundle.sh` copies these notices into the bundle).

## Screenshots

Offscreen, no Screen Recording permission needed (`VIMSTORM_WINDOW_SIZE=<w>x<h>` sets the window size, e.g. to compare with a WebStorm screenshot at the same size):

```sh
VIMSTORM_SHOT=/tmp/shot.png cargo run --features shots -- <path>
```

The window is never shown (nothing appears on screen, it never takes focus; it counts as active, so hovers and selections look as in use) and renders to the PNG once the screen is up, then quits; the AppKit traffic lights get drawn stand-ins. `VIMSTORM_SHOT_DELAY_MS` (default 3000) waits before the shot; `VIMSTORM_SHOT_KEYS` runs first, followed by another delay: plain text is nvim input (nvim notation, e.g. `<D-S-a>`), `{@super+o}` a GPUI keystroke (Rust-owned keys; `{@shift}{@shift}` = double Shift, `{@hold ctrl}` / `{@release}`), `{lua:<code>:lua}` Lua without typeahead, `{wait:<ms>}` a pause. Every shot runs on its own XDG state / cache / data dirs (`VIMSTORM_SHOT_STATE=<dir>`, default a fresh temp dir; data links the real plugins minus `snacks/`), so it never touches your sessions or Recent Projects. The mouse: `{@click x,y}` (or `{click:x,y}`), `{@move x,y}` (hover), `{@scroll dy}` where the pointer last went (logical px from the window's top left); `{type:<text>}` types each char as a GPUI keystroke (a Rust-owned field, the Factory view).

Film mode: `VIMSTORM_SHOT_FRAMES=<n>` with `VIMSTORM_SHOT_EVERY_MS=<ms>` (default 100) captures n frames, one every ms from the first key (or from `{film}` in the keys), while the keys play: `<shot>-0001.png …` beside the shot, which waits for the last. `{shot:<label>}` takes one frame `<shot>-<label>.png`. `<shot>-frames.tsv` lists every frame (file, ms since the keys started, label) and every step with its ms. The hidden window draws only when a frame is taken, so what waits for a frame runs at the film's pace. `scripts/qarig` runs many of these at once on isolated Abe envs (fake Azure DevOps, fake `claude` / `gh` / `az` / EC2; its `--help`).

Drive socket (`src/devtools/drive.rs`, shots build only; how a QA agent uses it: [docs/agents/in-app-qa.md](../docs/agents/in-app-qa.md)): `VIMSTORM_DRIVE=<socket>` starts the app offscreen as a shot does, but it stays up and takes steps over a user-only unix socket (0600, the peer's uid checked): one JSON line each way, `{"v":1,"keys":"…"}` (the shot's key grammar; an unknown `{@…}` refused before anything plays), `type`, `click` / `dblclick` / `move` `[x,y]`, `scroll`, `see` (the bridge's trees per slot (`main`, `chat`, `pane`, `review`) and the layer as `abe ui render`'s outline, the status bar, balloons, title, view, the bottom pane's Terminal: its tabs and screen), `wait` `{"text","in","gone","ms"}`, `shot` (the shown BrowserViews' pages drawn in from WebKit's snapshots, as `{shot:<label>}` and the exit shot; a film's frames go without), `film` (with keys) and `quit`. The window draws at a steady pace (`VIMSTORM_DRIVE_FPS`, default 10), so timers and balloons run as in a shown window. Many driven apps run side by side; `scripts/qarig live / do / see / wait / snap / film` is the client (`tests/drive.rs` drives two at once). `qarig gate <env> ../tests/gate/<script>.md` runs a release gate script on a live app into `RESULT.md` (`scripts/qarig_gate.py`: do / wait (`re:` across lines) / see / snap / film / listed reads / teammate / scenario, `judge` and `agent` turns for the tester agent, `down`); `qarig up <env> --real` is a gate env on a private demo-shop copy with the owner's gh / aws / claude logins where they live (accounts from `app/scripts/qarig.local.toml`), `--seed-offset` numbers a tester's cards apart.

## Tests

```sh
cargo test                            # unit tests + tests/ (real embedded nvim with the worktree config)
cargo clippy --all-targets --all-features -- -D warnings && cargo fmt --check
../tests/run.sh                       # headless Lua engine tests against this checkout's nvim/
```

The integration tests are three test binaries (`autotests = false`; one link per edit, not one per file): every `tests/<file>.rs` is a module of `tests/app.rs` (the app), `tests/perf.rs` (the app's perf budgets: timings and RSS stay out of the shared process, one at a time) or `tests/theme.rs` (the look: the palette, density and fonts are process-global); shared helpers (`tests/common`) are modules of the root. A new test file is a `mod <file>;` line in its root. One file's tests:

```sh
cargo test --test app tree::                    # tests/tree.rs
cargo test --test perf frames::                 # tests/perf.rs (release numbers: --release ... -- --nocapture)
cargo test --test theme                         # tests/theme.rs
```

A binary's tests share one process: a test never sets the process's env, cwd or a library global for itself; one that needs that runs itself again as a child process with `--exact <module>::<name>`.

## Bundle and install

```sh
scripts/bundle.sh [--out DIR]   # release build -> DIR/VimStorm.app (default target/bundle/), ad-hoc signed
```

Info.plist's `LSEnvironment` holds the repo path and the PATH of the shell that built it: apps started from Finder / Dock only get `/usr/bin:/bin:...` and wouldn't find nvim, git, rg or node. Rebuild after moving the repo or changing PATH.

The bundle carries Abe as `Contents/MacOS/abe` (`../abe`, `bun install --frozen-lockfile && bun run build:darwin`; `VIMSTORM_BUNDLE_ABE=<path>` bundles that one instead), where the bridge looks when `$ABE_BIN` is unset (`src/factory/bridge/process.rs`), so a Dock launch has it.

`../install.sh` does this (unattended; Rust is required): the editor's and Abe's tools (Homebrew; Claude Code's own installer), `VimStorm.app` -> `/Applications` (replaced; `~/Applications` when that isn't writable; its `LSEnvironment.PATH` with `~/.local/bin` appended), the `vimstorm [path]` command (`scripts/vimstorm`) -> `~/.local/bin`, `abe` there -> the bundle's Abe, and the warm-up (`scripts/warmup.sh` → `nvim/lua/config/warmup.lua`: what is missing of the plugins, parsers and Mason packages, exit 1 naming what still is; it reads the config through a temp link of its own, never the installed app's). Env overrides (a test install into a temp prefix): `VIMSTORM_APPS_DIR`, `VIMSTORM_BIN_DIR`, `XDG_DATA_HOME`, `VIMSTORM_SKIP_TOOLS=1`, `VIMSTORM_SKIP_WARMUP=1`, `VIMSTORM_SKIP_APP=1`, `VIMSTORM_LSREGISTER=0`. Tests: `tests/install.rs`.

### Single instance

One app runs at a time (`src/app/instance.rs`). `vimstorm [path]` (absolute or relative; default cwd) hands the path to the running app over a unix socket; the app opens or switches to the project (a dir), or opens a file in its project (the open project containing it, else its git work tree, else its dir), and comes to the front. The command exits 0 once the app took the path, 1 with the reason when it refused. Without a running app it starts one, detached, with your shell's env; logs go to `~/Library/Logs/VimStorm/vimstorm.log`. A Finder / Dock / `open -a` launch logs there too (`src/app/log.rs`; `VIMSTORM_LOG` overrides; stderr already going somewhere stays): a `start:` line and one `exit: <why>` line per exit (the last project closed, Quit, a signal, nvim exited, a launch that failed, macOS's quit); a launch that fails also shows an alert with the fix. `open -a VimStorm <path>`, Finder "Open With" (folders, text / source files; never the default app) and Dock drops take the same path; a Dock click brings the window back.

- The binary is its own client: `vimstorm <path>` first tries the socket (before nvim / GPUI start, a few ms) and exits once handed over; `vimstorm --remote <path>` only hands off (exit 3: no app running).
- Socket: `$VIMSTORM_SOCKET`, else `~/Library/Application Support/VimStorm/vimstorm.sock` (user-only); removed on quit, a stale one (crash) is replaced. Protocol: one JSON line each way, `{"v":1,"open":"<abs path>"}` -> `{"ok":true}` / `{"ok":false,"error":"..."}`; only existing absolute paths, nothing else.
- `VIMSTORM_NO_INSTANCE=1` runs a separate app (no hand-off, no socket), e.g. `cargo run` next to the installed app; screenshot and bench runs never take part.
