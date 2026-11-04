//! The app's log and why it exits.
//!
//! A Dock / Finder / `open -a` launch has stdout and stderr on `/dev/null`: [`init`] points them at
//! `~/Library/Logs/VimStorm/vimstorm.log` (`$VIMSTORM_LOG`), as the `vimstorm` script's `nohup`
//! does, so what the app, its nvims and Abe print lands where the user can find it. Stderr that
//! already goes somewhere (a terminal, `open --stderr`, the script's log) stays.
//!
//! Every way out says why in one `exit:` line: [`quitting`] at the point of no return (the last
//! project closed, Quit, a signal, a launch that failed), else the app's quit hook's
//! [`quit_asked`] (macOS asked: Dock Quit, logout, an Apple event). A panic logs its message. A
//! launch that fails ([`launch_failed`]) says the fix in the log and, started from Finder / the
//! Dock / `open`, in a native alert instead of vanishing.

use std::os::fd::{AsRawFd as _, IntoRawFd as _};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;

/// The log override.
pub const LOG_ENV: &str = "VIMSTORM_LOG";
/// A log this big at launch is moved to `vimstorm.log.old` (one kept).
const ROTATE_BYTES: u64 = 8 << 20;

/// Why the app is quitting: the first reason given wins (a signal's quit closes every project,
/// whose last close is not the reason).
static REASON: Mutex<Option<String>> = Mutex::new(None);
/// What [`init`] found: the log stdout / stderr went to, whether LaunchServices started the app.
static STARTED: OnceLock<Started> = OnceLock::new();

struct Started {
    log: Option<PathBuf>,
    launch_services: bool,
}

/// The log file: `$VIMSTORM_LOG`, else `~/Library/Logs/VimStorm/vimstorm.log`.
pub fn log_path(get: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let set = |k: &str| get(k).filter(|v| !v.trim().is_empty());
    set(LOG_ENV).map(PathBuf::from).or_else(|| {
        set("HOME").map(|h| PathBuf::from(h).join("Library/Logs/VimStorm/vimstorm.log"))
    })
}

/// Whether fd `fd` goes nowhere: `/dev/null` or closed (a LaunchServices launch).
fn goes_nowhere(fd: i32) -> bool {
    let Some(of) = stat_fd(fd) else {
        return true;
    };
    std::fs::File::open("/dev/null")
        .ok()
        .and_then(|null| stat_fd(null.as_raw_fd()))
        .is_some_and(|null| (null.st_dev, null.st_ino) == (of.st_dev, of.st_ino))
}

fn stat_fd(fd: i32) -> Option<libc::stat> {
    // SAFETY: fstat only writes the out-parameter, which is a valid zeroed struct.
    unsafe {
        let mut st: libc::stat = std::mem::zeroed();
        (libc::fstat(fd, &mut st) == 0).then_some(st)
    }
}

/// Whether stderr is a terminal (a shell run: nothing to hand to a log).
pub fn stderr_is_tty() -> bool {
    // SAFETY: isatty only reads the fd.
    unsafe { libc::isatty(2) == 1 }
}

/// First thing the app does: stdout / stderr that go nowhere go to the log, panics are logged, a
/// `start:` line written.
pub fn init() {
    // SAFETY: getppid has no preconditions.
    let launch_services = unsafe { libc::getppid() } == 1;
    let log = (goes_nowhere(2))
        .then(|| log_path(|k| std::env::var(k).ok()))
        .flatten()
        .and_then(|path| redirect(&path).ok().map(|()| path));
    let _ = STARTED.set(Started {
        log,
        launch_services,
    });
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("?");
        line(&format!("panic on thread {name}: {info}"));
        // the main thread's unwinds into AppKit, which aborts: the app ends here
        // (not `quitting`: its lock may be what panicked)
        if name == "main" {
            line("exit: a panic on the main thread (above)");
        }
        default(info);
    }));
    // a shell run's terminal needs no start line
    if stderr_is_tty() {
        return;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    line(&format!(
        "start: VimStorm {} (pid {}){}{}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        if args.is_empty() {
            String::new()
        } else {
            format!(" {}", args.join(" "))
        },
        if launch_services {
            ", started by macOS (Finder / Dock / open)"
        } else {
            ""
        }
    ));
}

/// Points stdout (when it goes nowhere too) and stderr at `path`, appended to.
fn redirect(path: &Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(path).is_ok_and(|m| m.len() > ROTATE_BYTES) {
        let mut old = path.as_os_str().to_owned();
        old.push(".old");
        let _ = std::fs::rename(path, old);
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    // (a closed std fd at launch: `open` may have handed out 1 or 2 itself, which stays open)
    let fd = file.into_raw_fd();
    // SAFETY: dup2 onto the standard fds (valid targets); `fd` is ours, closed once copied.
    unsafe {
        if fd != 1 && goes_nowhere(1) {
            libc::dup2(fd, 1);
        }
        let failed = fd != 2 && libc::dup2(fd, 2) < 0;
        let err = std::io::Error::last_os_error();
        if fd > 2 {
            libc::close(fd);
        }
        if failed {
            return Err(err);
        }
    }
    Ok(())
}

/// The log stdout / stderr were pointed at (None: they go where they went).
pub fn log_file() -> Option<PathBuf> {
    STARTED.get().and_then(|s| s.log.clone())
}

/// One timestamped line on stderr (the log, once [`init`] pointed it there).
pub fn line(text: &str) {
    use std::io::Write as _;
    // (never panics: a full disk must not turn an exit line into a panic)
    let _ = writeln!(
        std::io::stderr().lock(),
        "{}",
        format_line(&now_stamp(), text)
    );
}

/// `<stamp> [vimstorm] <text>`.
pub fn format_line(stamp: &str, text: &str) -> String {
    format!("{stamp} [vimstorm] {text}")
}

/// The local time as `YYYY-MM-DD HH:MM:SS`.
pub(crate) fn now_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as libc::time_t)
        .unwrap_or_default();
    // SAFETY: localtime_r writes only the out-parameter, a valid zeroed struct.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&secs, &mut tm).is_null() {
            return secs.to_string();
        }
        tm
    };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

/// The app is quitting for `reason` (no way back): logs `exit: <reason>`, unless an earlier
/// reason already did (that one is why).
pub fn quitting(reason: impl Into<String>) {
    let mut held = REASON.lock();
    if held.is_some() {
        return;
    }
    let reason = reason.into();
    line(&format!("exit: {reason}"));
    *held = Some(reason);
}

/// The reason [`quitting`] holds (None: none given yet).
pub fn reason() -> Option<String> {
    REASON.lock().clone()
}

/// The app's quit hook: a quit nothing in the app asked for is macOS's.
pub fn quit_asked() {
    quitting("macOS asked VimStorm to quit (Dock Quit, logout or an Apple event)");
}

/// A launch that can't go on: logs it with the fix and, when macOS started the app (Finder, the
/// Dock, `open`: no terminal to read), shows it in an alert. The caller then exits.
pub fn launch_failed(e: &anyhow::Error) {
    let error = format!("{e:#}");
    let fix = fix_for(&error, std::env::var("PATH").ok().as_deref());
    line(&format!("launch failed: {error}"));
    line(&format!("fix: {fix}"));
    quitting(format!("launch failed: {error}"));
    if STARTED.get().is_some_and(|s| s.launch_services) {
        let log = log_file()
            .map(|p| format!("\n\nThe log: {}", p.display()))
            .unwrap_or_default();
        alert("VimStorm couldn't start", &format!("{error}\n\n{fix}{log}"));
    }
}

/// What to do about a launch error (its `{:#}` text), in words; `path`: the app's PATH.
pub fn fix_for(error: &str, path: Option<&str>) -> String {
    let missing = error.contains("No such file or directory") || error.contains("os error 2");
    if error.contains("spawning nvim") && missing {
        return format!(
            "Install Neovim (brew install neovim). VimStorm looks for nvim on the PATH it was \
             installed with ({}); run install.sh again from a shell where `nvim` works.",
            path.unwrap_or("none")
        );
    }
    if error.contains("VimStorm repo") || error.contains("VIMSTORM_REPO") {
        return "Run install.sh in your VimStorm checkout again: the app finds its nvim config \
                through the checkout it was built from."
            .into();
    }
    if error.contains("HOME not set") {
        return "Start VimStorm from Finder or the Dock (its environment has no HOME).".into();
    }
    "Run install.sh in your VimStorm checkout again; if it keeps failing, the log below says more."
        .into()
}

/// A native alert with one OK button, shown by macOS's notification center
/// (`CFUserNotificationDisplayAlert`): it blocks without running this process's run loop, so
/// GPUI's tasks don't run under it (an `NSAlert` would, re-entering the app mid-update).
#[cfg(target_os = "macos")]
fn alert(title: &str, text: &str) {
    use objc2_foundation::{NSString, NSURL};
    use std::ffi::c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFUserNotificationDisplayAlert(
            timeout: f64,
            flags: usize,
            icon: *const c_void,
            sound: *const c_void,
            localization: *const c_void,
            header: *const c_void,
            message: *const c_void,
            default_button: *const c_void,
            alternate_button: *const c_void,
            other_button: *const c_void,
            response: *mut usize,
        ) -> i32;
    }
    // the bundle's icon (Contents/Resources/VimStorm.icns), else macOS's stop sign
    let icon = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.parent()?.join("Resources/VimStorm.icns")))
        .filter(|p| p.is_file())
        .map(|p| NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy())));
    let (title, text, ok) = (
        NSString::from_str(title),
        NSString::from_str(text),
        NSString::from_str("OK"),
    );
    let cf = |s: &NSString| (s as *const NSString).cast::<c_void>();
    let mut response = 0usize;
    // SAFETY: NSString / NSURL are toll-free bridged to CFString / CFURL; every pointer outlives
    // the call (which blocks until OK); null is allowed for the optional ones.
    unsafe {
        CFUserNotificationDisplayAlert(
            0.0,
            0, // kCFUserNotificationStopAlertLevel
            icon.as_deref()
                .map_or(std::ptr::null(), |u| (u as *const NSURL).cast()),
            std::ptr::null(),
            std::ptr::null(),
            cf(&title),
            cf(&text),
            cf(&ok),
            std::ptr::null(),
            std::ptr::null(),
            &mut response,
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn alert(_: &str, _: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        |k| {
            vars.iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn the_log_is_vimstorm_log_else_the_users_logs_folder() {
        assert_eq!(
            log_path(env(&[("VIMSTORM_LOG", "/tmp/x.log"), ("HOME", "/home/a")])),
            Some(PathBuf::from("/tmp/x.log"))
        );
        assert_eq!(
            log_path(env(&[("VIMSTORM_LOG", " "), ("HOME", "/home/a")])),
            Some(PathBuf::from("/home/a/Library/Logs/VimStorm/vimstorm.log"))
        );
        assert_eq!(log_path(env(&[])), None);
    }

    #[test]
    fn a_line_has_its_time_and_the_apps_name() {
        assert_eq!(
            format_line("2026-10-24 15:36:09", "exit: the last open project closed"),
            "2026-10-24 15:36:09 [vimstorm] exit: the last open project closed"
        );
        let stamp = now_stamp();
        assert_eq!(stamp.len(), "2026-10-24 15:36:09".len(), "{stamp}");
    }

    #[test]
    fn a_launch_failure_names_its_fix() {
        let nvim = fix_for(
            "spawning nvim: No such file or directory (os error 2)",
            Some("/usr/bin:/bin"),
        );
        assert!(nvim.contains("brew install neovim"), "{nvim}");
        assert!(nvim.contains("/usr/bin:/bin"), "{nvim}");
        let repo = fix_for("can't find the VimStorm repo (set VIMSTORM_REPO)", None);
        assert!(repo.contains("install.sh"), "{repo}");
        let repo = fix_for("VIMSTORM_REPO=/x has no nvim/init.lua", None);
        assert!(repo.contains("checkout"), "{repo}");
        let other = fix_for("creating /x: Permission denied", None);
        assert!(other.contains("log"), "{other}");
    }

    #[test]
    fn dev_null_goes_nowhere_a_file_does_not() {
        let null = std::fs::File::open("/dev/null").unwrap();
        assert!(goes_nowhere(null.as_raw_fd()));
        let file = tempfile::tempfile().unwrap();
        assert!(!goes_nowhere(file.as_raw_fd()));
        assert!(goes_nowhere(-1), "a closed fd");
    }
}
