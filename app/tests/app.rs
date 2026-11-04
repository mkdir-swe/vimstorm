//! The app's integration tests as one test binary (`cargo test --test app`): each former
//! `tests/<file>.rs` is a module here, so `cargo test --test app <file>::` runs just that file's
//! tests. One binary links once per edit instead of once per file. They share one process:
//! nothing here may set the process's env, cwd or a library global for its own tests only (a
//! test that needs that runs itself again as a child process). The perf budgets
//! are the `perf` binary (`tests/perf.rs`).

mod common;

mod abe_review;
mod annotate;
mod browser;
mod chat_column;
mod contract;
mod diff_merge;
#[cfg(feature = "shots")]
mod drive;
mod factory;
mod factory_layout;
mod factory_slots;
mod floats;
mod git_changes;
mod git_data;
mod git_log;
mod gitwin;
mod input;
mod install;
mod instance;
mod jumps;
mod kit;
mod markdown;
mod maximize;
mod pane;
mod pickers;
mod popups;
mod projects;
mod quit;
mod rail;
mod remote_workspace;
mod replace;
mod screen;
mod shell_effects;
mod statusbar;
mod stripe;
mod tabs;
mod terminal;
mod toolbar;
mod tree;
mod workspace;
