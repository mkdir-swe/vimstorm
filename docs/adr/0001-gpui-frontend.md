# 0001 VimStorm is a GPUI app around an embedded Neovim

Status: accepted (2026-10-16)
Switch done in M5 (2026-10-17): the app is the only frontend; the Ghostty setup, glyph-drawn chrome and key-release helpers are deleted.

M5 amendments (the decision below stands; these details changed):
- One window, one embedded nvim per open project; only the shown project is drawn (hidden ones keep running).
- No branch widget in the main toolbar: the branch popup opens from the Branches… / New Branch… menu items (the branch shows in the status bar).
- No project widget either (the user removed it): Recent Projects (Cmd+Shift+O, the app / editor menus) opens projects, the title shows the project.
- The WebStorm Icons font stays: bundled in the app (`app/assets/fonts/WebStormIcons.otf`), not deleted.
- Key releases aren't routed to nvim: Rust detects double Shift natively.

## Decision

VimStorm stops being "Neovim in Ghostty" and becomes a native macOS app written in Rust with GPUI (via gpui-kit), in `app/`. One window, one embedded `nvim --embed`. Neovim stays the editing engine: buffers, Vim modes, editing logic, LSP, Copilot, treesitter, sessions (the Lua in `nvim/`). Rust draws everything (editor grids via `ext_multigrid`, tree, tabs, status bar, popups, pickers, switcher, balloons, git tool window, diff/merge chrome, completion menu, hover/peek floats, markdown preview) and owns the git logic, the terminal (`alacritty_terminal`) and the WebStorm keymap (Cmd keys, double Shift, key releases). Vim keys go straight to Neovim.

- Projects switch inside the one window and stay alive (terminals, LSP, tabs) until closed. `vimstorm <path>` hands the path to the running app.
- Look: WebStorm New UI, Islands Dark chrome, Darcula Contrast editor, Inter 13 UI font, JetBrains Mono 13 editor font, WebStorm's real metrics (from its theme files and IntelliJ source), checked against screenshots. WebStorm-style main toolbar with the window buttons, a project widget and a branch widget. No tool window stripe (keys only).
- Big-bang switch: the Ghostty setup stays on `main` until the app reaches parity (every behaviour test scenario ported); then the terminal workarounds (Ghostty Cmd remaps, tmux key twins, the icon font, glyph-drawn frames/pills/corners, key-release C helpers) are deleted.

## Why

The terminal cell grid caps the polish: no proportional UI font, no sub-cell spacing (icon gaps), no real row heights, rounded corners or icons, key releases and Cmd keys only through remaps, terminal reflow bugs. A native frontend removes the cap while keeping the Lua engine that already matches WebStorm's behaviour. Writing a native editor instead (Zed-style, no Neovim) was rejected: Vim mode, LSP, completion and diff/merge would all have to be rebuilt.

## Consequences

- Zed's app crates are GPL: never copy from them. Allowed: gpui / gpui-kit / gpui-pre (Apache-2.0), alacritty_terminal (Apache-2.0), Neovide and nvim-gpui (MIT, with attribution). Neovim RPC over `rmpv`, not `nvim-rs` (LGPL).
- Tests move from "type Ghostty bytes into a nested nvim in a `:terminal`" to GPUI test-context tests for views plus headless Lua tests for engine logic.
