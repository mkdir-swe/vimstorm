//! VimStorm: a GPUI frontend around an embedded Neovim (see docs/adr/0001-gpui-frontend.md).
//!
//! One folder per domain (ADR 0024). A folder's `mod.rs` is its interface; its files are private.

/// Process life: menu bar, log, single instance, timing.
pub mod app;
/// Driving and measuring a live app: key bench, drive socket, offscreen shots.
pub mod devtools;
/// The editor: nvim's grids in their islands, its input, tabs, status bar, floats, markdown,
/// minimap and replace.
pub mod editor;
/// The Factory view: Abe's screens drawn from `abe ui bridge`'s component trees, and the
/// BrowserView's pages.
pub mod factory;
/// Git: the CLI, the Git tool window, the diff / merge viewer, annotate.
pub mod git;
/// The widget kit of the native chrome: icons, list, popup, field, keys.
pub mod kit;
/// The look: the palette and metrics, and a theme's colours, density and fonts put in
/// force live.
pub mod look;
/// Embedded nvim: process, msgpack-rpc, redraw parser, UI state (no GPUI types), and its Lua
/// calls.
pub mod nvim;
/// Menus, vim.ui.input, balloons, key help.
pub mod popups;
/// Drawing nvim grids in GPUI.
pub mod render;
/// Search Everywhere, Find in Files, Recent Files / Projects, Usages, switcher, and the
/// project scope they search.
pub mod search;
/// The window shell: layout, surfaces, toolbar, tree, open and recent projects, a cloud
/// workspace, keyboard focus.
pub mod shell;
/// The terminal tool window over its host nvim window.
pub mod terminal;
