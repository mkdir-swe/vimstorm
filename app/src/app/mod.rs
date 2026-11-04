//! Process life: the menu bar and window shortcuts, the app's log and why it exits, the single
//! instance, and startup timing.

mod instance;
mod log;
mod menu;
mod timing;

pub(crate) use instance::project_for_file;
#[cfg(feature = "shots")]
pub(crate) use instance::same_user;
pub use instance::{
    ANSWER_TIMEOUT, Bind, Handoff, Incoming, Server, Startup, Target, UrlInbox, attach, bind,
    decode_request, git_root, hand_off, launch_args, locale_fallback, locate, open, platform_hooks,
    quit_signals, remote_main, serve, startup, startup_project,
};
pub(crate) use log::now_stamp;
pub use log::{init as init_log, launch_failed, line, quit_asked, quitting, reason, stderr_is_tty};
pub(crate) use menu::replay_key;
pub use menu::{Replay, Workspaces, init as init_menu, shown_keys};
pub(crate) use timing::{Latency, enabled as timing_enabled};
pub use timing::{mark, redraw_received, start as start_timing};
