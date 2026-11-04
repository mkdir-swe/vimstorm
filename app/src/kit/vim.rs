//! The Vim key layer of the tree, the Log table and the Git panel lists (not dropdowns): a count
//! before his moves (`22ö`, `3Ö` = 15 rows), `gg` / `G` first / last row and doubled action keys
//! (`yy` copy, `dd` delete, `rr` rename; `g?` help). Each surface maps the steps to its own
//! actions and says which doubled keys it has.
//!
//! A count is 1-9 then any digits. Esc, or a key that doesn't continue, ends a pending count /
//! prefix; that key is then handled on its own (a `d` and `ö` moves down), nothing is shown
//! while keys are pending (no showcmd).

/// A doubled action key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cmd {
    /// `yy`
    Yank,
    /// `dd` (every surface confirms first)
    Delete,
    /// `rr`
    Rename,
    /// `g?`
    Help,
}

/// What a key means after the keys before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step<'k> {
    /// Swallowed: part of a count / prefix, or Esc cancelling one.
    Pending,
    /// `gg`
    First,
    /// `G`
    Last,
    Cmd(Cmd),
    /// An ordinary key; `count` repeats a move (1 without a count). `cancelled`: the prefix
    /// this key ended without continuing it (the Log's `d` alone is its Date filter).
    Key {
        key: &'k str,
        count: usize,
        cancelled: Option<char>,
    },
}

/// Counts stop growing here (a typo'd `99999999ö` is just "to the end").
const MAX_COUNT: usize = 99_999;

/// Pending count / prefix of one surface.
#[derive(Clone, Debug, Default)]
pub struct Vim {
    /// 0 = no count typed.
    count: usize,
    prefix: Option<char>,
}

impl Vim {
    /// One key (nvim notation). `doubles`: the surface's doubled keys among `y` `d` `r`
    /// (`g` always prefixes: `gg`, `g?`).
    pub fn feed<'k>(&mut self, key: &'k str, doubles: &str) -> Step<'k> {
        if let Some(p) = self.prefix.take() {
            self.count = 0;
            return match key {
                "g" if p == 'g' => Step::First,
                "?" if p == 'g' => Step::Cmd(Cmd::Help),
                "<Esc>" => Step::Pending,
                k if k.chars().eq([p]) => Step::Cmd(match p {
                    'y' => Cmd::Yank,
                    'd' => Cmd::Delete,
                    _ => Cmd::Rename,
                }),
                _ => Step::Key {
                    key,
                    count: 1,
                    cancelled: Some(p),
                },
            };
        }
        if let Some(d) = single(key).and_then(|c| c.to_digit(10))
            && (d > 0 || self.count > 0)
        {
            self.count = (self.count * 10 + d as usize).min(MAX_COUNT);
            return Step::Pending;
        }
        let count = std::mem::take(&mut self.count);
        match key {
            "<Esc>" if count > 0 => Step::Pending,
            "G" => Step::Last,
            _ => match single(key) {
                Some(c) if c == 'g' || (matches!(c, 'y' | 'd' | 'r') && doubles.contains(c)) => {
                    self.prefix = Some(c);
                    Step::Pending
                }
                _ => Step::Key {
                    key,
                    count: count.max(1),
                    cancelled: None,
                },
            },
        }
    }

    /// The prefix waiting for its second key.
    pub fn prefix(&self) -> Option<char> {
        self.prefix
    }

    /// Forgets a pending count / prefix (another handler took the key).
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// The key's char when it's a single plain char (not `<...>` notation).
fn single(key: &str) -> Option<char> {
    let mut it = key.chars();
    match (it.next(), it.next()) {
        (Some(c), None) => Some(c),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all<'k>(v: &mut Vim, keys: &[&'k str], doubles: &str) -> Vec<Step<'k>> {
        keys.iter().map(|k| v.feed(k, doubles)).collect()
    }

    fn key(key: &str, count: usize) -> Step<'_> {
        Step::Key {
            key,
            count,
            cancelled: None,
        }
    }

    #[test]
    fn counts_repeat_the_next_key() {
        let mut v = Vim::default();
        let s = feed_all(&mut v, &["2", "2", "ö", "ö", "3", "Ö"], "");
        assert_eq!(
            s,
            [
                Step::Pending,
                Step::Pending,
                key("ö", 22),
                key("ö", 1),
                Step::Pending,
                key("Ö", 3)
            ]
        );
        // 0 only continues a count; Esc drops it (swallowed)
        assert_eq!(v.feed("0", ""), key("0", 1));
        assert_eq!(feed_all(&mut v, &["1", "0", "<Esc>"], "")[2], Step::Pending);
        assert_eq!(v.feed("l", ""), key("l", 1));
        assert_eq!(v.feed("<Esc>", ""), key("<Esc>", 1));
        // huge counts stay finite
        for _ in 0..20 {
            v.feed("9", "");
        }
        assert_eq!(v.feed("ö", ""), key("ö", MAX_COUNT));
    }

    #[test]
    fn prefixes_and_doubled_keys() {
        let mut v = Vim::default();
        assert_eq!(feed_all(&mut v, &["g", "g"], "")[1], Step::First);
        assert_eq!(v.feed("G", ""), Step::Last);
        assert_eq!(feed_all(&mut v, &["5", "G"], "")[1], Step::Last);
        assert_eq!(feed_all(&mut v, &["g", "?"], "")[1], Step::Cmd(Cmd::Help));
        assert_eq!(
            feed_all(&mut v, &["y", "y", "d", "d", "r", "r"], "ydr"),
            [
                Step::Pending,
                Step::Cmd(Cmd::Yank),
                Step::Pending,
                Step::Cmd(Cmd::Delete),
                Step::Pending,
                Step::Cmd(Cmd::Rename)
            ]
        );
        // a count before a doubled key is ignored
        assert_eq!(
            feed_all(&mut v, &["3", "d", "d"], "d")[2],
            Step::Cmd(Cmd::Delete)
        );
        // not the surface's: an ordinary key
        assert_eq!(v.feed("d", "y"), key("d", 1));
        assert_eq!(v.prefix(), None);
    }

    #[test]
    fn a_key_that_does_not_continue_ends_the_prefix() {
        let mut v = Vim::default();
        v.feed("d", "d");
        assert_eq!(v.prefix(), Some('d'));
        assert_eq!(
            v.feed("ö", "d"),
            Step::Key {
                key: "ö",
                count: 1,
                cancelled: Some('d')
            }
        );
        assert_eq!(v.prefix(), None);
        // Esc cancels silently
        v.feed("y", "y");
        assert_eq!(v.feed("<Esc>", "y"), Step::Pending);
        assert_eq!(v.feed("y", "y"), Step::Pending);
        v.reset();
        assert_eq!(v.feed("y", "y"), Step::Pending);
        assert_eq!(v.prefix(), Some('y'));
    }
}
