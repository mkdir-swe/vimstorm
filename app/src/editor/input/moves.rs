//! Mouse moves vs pending key sequences. nvim takes `<MouseMove>` (hover: tooltips) as a key: one
//! arriving between `,` and `v`, or inside `ciw`, ends the sequence. So a move goes to nvim only
//! once nvim is known to wait for a fresh key; after keys were sent, the latest move is held and
//! nvim asked with `nvim_get_mode` (a fast call: it doesn't break the sequence itself, unlike any
//! Lua call). Its `blocking` is true while a mapping / operator / `f` waits for more keys.
//!
//! The answer can be stale: keys still queued in nvim's input buffer (sent in the same read as the
//! probe) aren't counted yet. A probe sent after the previous answer came back is read after nvim
//! took those keys, so a move needs two "not blocking" answers in a row with no key in between.

use super::Action;

/// What the view does next.
#[derive(Debug, PartialEq)]
pub enum MoveStep {
    /// Forward this move now.
    Send(Action),
    /// Ask nvim (`nvim_get_mode`) and pass the answer to [`MoveGuard::answer`] with this id.
    Probe(u64),
    /// A sequence is pending: ask again a moment later ([`MoveGuard::retry`]).
    RetryLater,
    /// Nothing to do.
    Wait,
}

#[derive(Debug, Default)]
pub struct MoveGuard {
    /// Count of keys / clicks sent to nvim.
    keys: u64,
    /// `keys` when nvim was last seen waiting for a fresh key.
    idle_at: u64,
    /// "Not blocking" answers in a row for `keys`.
    confirmed: u8,
    probing: bool,
    /// The latest move not sent yet.
    held: Option<Action>,
}

impl MoveGuard {
    /// A key, text or click went to nvim: it may start or continue a sequence.
    pub fn key_sent(&mut self) {
        self.keys += 1;
        self.confirmed = 0;
    }

    /// A hover move for nvim.
    pub fn hover(&mut self, action: Action) -> MoveStep {
        if self.idle_at == self.keys && self.held.is_none() {
            return MoveStep::Send(action);
        }
        self.held = Some(action);
        self.probe()
    }

    /// Something changed (a flush, a timer): ask again if a move waits.
    pub fn retry(&mut self) -> MoveStep {
        self.probe()
    }

    /// nvim's answer to probe `id`: `None` when it didn't answer (gone).
    pub fn answer(&mut self, id: u64, blocking: Option<bool>) -> MoveStep {
        self.probing = false;
        let Some(blocking) = blocking else {
            return MoveStep::Wait;
        };
        if id != self.keys {
            // keys went out meanwhile: start over
            return self.probe();
        }
        if blocking {
            self.confirmed = 0;
            return MoveStep::RetryLater;
        }
        self.confirmed += 1;
        if self.confirmed < 2 {
            return self.probe();
        }
        self.idle_at = self.keys;
        self.held.take().map_or(MoveStep::Wait, MoveStep::Send)
    }

    fn probe(&mut self) -> MoveStep {
        if self.probing || self.held.is_none() {
            return MoveStep::Wait;
        }
        self.probing = true;
        MoveStep::Probe(self.keys)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mv(col: u64) -> Action {
        Action::Mouse {
            button: "move",
            action: "",
            modifier: String::new(),
            grid: 2,
            row: 0,
            col,
        }
    }

    /// What the view tells the guard.
    #[derive(Clone, Copy, Debug)]
    enum Event {
        /// A key went to nvim.
        Key,
        /// The mouse moved to this column.
        Hover(u64),
        /// nvim answered a probe: (id, a sequence is pending; None: no answer).
        Answer(u64, Option<bool>),
        Retry,
    }
    use Event::*;

    /// What the guard says back; `Sends(col)` is `MoveStep::Send(mv(col))`.
    #[derive(Clone, Copy, Debug)]
    enum Says {
        Sends(u64),
        Probe(u64),
        RetryLater,
        Wait,
    }

    /// (name, events each with the step it gives; None for a key, which gives none)
    type Guard = (&'static str, &'static [(Event, Option<Says>)]);

    const GUARD: &[Guard] = &[
        (
            "moves go straight through when no key was sent",
            &[
                (Hover(1), Some(Says::Sends(1))),
                (Hover(2), Some(Says::Sends(2))),
            ],
        ),
        (
            "after a key the latest move waits for two idle answers",
            &[
                (Key, None),
                (Hover(1), Some(Says::Probe(1))),
                // one probe at a time; the newer move replaces the held one
                (Hover(2), Some(Says::Wait)),
                (Answer(1, Some(false)), Some(Says::Probe(1))),
                (Answer(1, Some(false)), Some(Says::Sends(2))),
                // idle confirmed: straight through again
                (Hover(3), Some(Says::Sends(3))),
            ],
        ),
        (
            "a pending sequence holds the move until it ends",
            &[
                (Key, None),
                (Hover(1), Some(Says::Probe(1))),
                (Answer(1, Some(true)), Some(Says::RetryLater)),
                (Retry, Some(Says::Probe(1))),
                (Answer(1, Some(true)), Some(Says::RetryLater)),
                (Key, None),
                (Retry, Some(Says::Probe(2))),
                (Answer(2, Some(false)), Some(Says::Probe(2))),
                (Answer(2, Some(false)), Some(Says::Sends(1))),
            ],
        ),
        (
            "a key between answers restarts the check",
            &[
                (Key, None),
                (Hover(1), Some(Says::Probe(1))),
                (Answer(1, Some(false)), Some(Says::Probe(1))),
                (Key, None),
                (Answer(1, Some(false)), Some(Says::Probe(2))),
                (Answer(2, Some(false)), Some(Says::Probe(2))),
                (Answer(2, Some(false)), Some(Says::Sends(1))),
            ],
        ),
        (
            "nothing held, nothing probed",
            &[
                (Key, None),
                (Retry, Some(Says::Wait)),
                (Answer(1, None), Some(Says::Wait)),
            ],
        ),
    ];

    #[test]
    fn a_hover_after_a_key_waits_until_nvim_is_idle() {
        for &(name, events) in GUARD {
            let mut g = MoveGuard::default();
            for (i, &(event, says)) in events.iter().enumerate() {
                let got = match event {
                    Key => {
                        g.key_sent();
                        None
                    }
                    Hover(col) => Some(g.hover(mv(col))),
                    Answer(id, blocking) => Some(g.answer(id, blocking)),
                    Retry => Some(g.retry()),
                };
                let want = says.map(|s| match s {
                    Says::Sends(col) => MoveStep::Send(mv(col)),
                    Says::Probe(id) => MoveStep::Probe(id),
                    Says::RetryLater => MoveStep::RetryLater,
                    Says::Wait => MoveStep::Wait,
                });
                assert_eq!(got, want, "{name}: event {i} {event:?}");
            }
        }
    }
}
