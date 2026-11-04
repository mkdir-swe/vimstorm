//! Async plumbing shared by the git loaders: stale-result dropping (generations) and running a
//! blocking git function on GPUI's background executor.
//!
//! Pattern for a UI entity: keep a [`Latest`]; per load `let t = latest.next();`, run the
//! blocking function with [`spawn`] (or a module's `*_task` helper), and on completion apply the
//! result only `if t.is_current()`. To also stop git early, pass a [`super::cli::Cancel`] and
//! cancel it when a newer load starts. Dropping a GPUI `Task` before it ran skips the work.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use gpui_kit::{App, AppContext as _, Task};

/// Generation counter: the newest ticket wins, results of older ones are stale.
#[derive(Clone, Default, Debug)]
pub struct Latest(Arc<AtomicU64>);

impl Latest {
    pub fn new() -> Self {
        Self::default()
    }

    /// A ticket for a new load; every older ticket becomes stale.
    pub fn next(&self) -> Ticket {
        let generation = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        Ticket {
            generation,
            latest: self.0.clone(),
        }
    }

    /// Makes every ticket stale (the view closed / the repo changed).
    pub fn invalidate(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

/// One load's generation.
#[derive(Clone, Debug)]
pub struct Ticket {
    generation: u64,
    latest: Arc<AtomicU64>,
}

impl Ticket {
    /// No newer load started since this one.
    pub fn is_current(&self) -> bool {
        self.latest.load(Ordering::SeqCst) == self.generation
    }
}

/// Runs a blocking git function off the UI thread: GPUI's background executor, or a thread of
/// its own while a cloud workspace is open (its git is a call to the box).
pub fn spawn<T: Send + 'static>(cx: &App, f: impl FnOnce() -> T + Send + 'static) -> Task<T> {
    let job = crate::shell::remote::background_any(cx, f);
    cx.background_spawn(async move {
        job.await
            .unwrap_or_else(|| panic!("a git job's thread panicked"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_tickets_make_older_ones_stale() {
        let latest = Latest::new();
        let a = latest.next();
        assert!(a.is_current());
        let b = latest.next();
        assert!(!a.is_current());
        assert!(b.is_current());
        latest.invalidate();
        assert!(!b.is_current());
    }
}
