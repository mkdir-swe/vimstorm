//! Which session the Chat column shows (README "Layout"): one [`ChatTarget`] the window pins
//! (the shown workspace's, the Board's selected card, the repo's Abe chat on Boxes and Pipelines,
//! a prototype's own session on its tile, or back on the last quit's session), and one pure rule
//! from it, the Board's selection, the column's mode and the shown project to the `chat` screen's
//! open params ([`open_params`]). The Factory view tells the target what moved and opens Chat
//! again when the params change.
//!
//! Chat back on its last quit's session ([`ChatTarget::Restored`]) holds over the place it was
//! pinned to: the Board's first selection since is not followed, another is (or the shown
//! workspace changing, or Chat saying another session before that one) and Chat is the place's
//! again.
//!
//! This rule decides what Abe's Chat shows, so it is Abe's logic in Rust (ADR 0013 T1 says none
//! stays here); it lives here, behind this one interface, until the bridge takes it over.

use std::collections::BTreeMap;

/// The Factory screen's selected card (`selected`): its teammate owner and its title.
#[derive(Clone, Debug, PartialEq)]
pub struct Selected {
    pub card: u64,
    pub owner: Option<String>,
    pub title: Option<String>,
}

/// What Chat is on (closed).
#[derive(Clone, Debug, Default, PartialEq)]
pub enum ChatTarget {
    /// The shown workspace's session (the Editor, a workspace's Run and Card pages).
    #[default]
    Workspace,
    /// The Board's selected card (the Factory view shown, not on Run).
    Card,
    /// The repo's Abe chat, its main checkout's folder (Boxes, Pipelines), wherever you came from.
    Abe(String),
    /// A prototype's own session (its tile), whatever the Board selects.
    Prototype(String),
    /// Back on the session it was on at the last quit in the shown workspace, over the place it
    /// is pinned to ([`Restored`]).
    Restored(Restored),
}

/// Chat back on the session it was on at the last quit: [`ChatTarget::Restored`].
#[derive(Clone, Debug, PartialEq)]
pub struct Restored {
    session: String,
    /// Chat said it is on it.
    said: bool,
    /// The card the Board selected first since (`Some(None)`: none).
    first: Option<Option<u64>>,
    /// The place it is over, never itself restored.
    under: Box<ChatTarget>,
}

impl ChatTarget {
    /// The place Chat is pinned to (a restore's: the one under it).
    fn pin(&self) -> &ChatTarget {
        match self {
            ChatTarget::Restored(r) => &r.under,
            t => t,
        }
    }

    fn pin_mut(&mut self) -> &mut ChatTarget {
        match self {
            ChatTarget::Restored(r) => &mut r.under,
            t => t,
        }
    }

    /// Pinned to the Factory view's places (the Board's card, the Abe chat, a prototype's), not
    /// the shown workspace.
    fn in_factory(&self) -> bool {
        !matches!(self.pin(), ChatTarget::Workspace)
    }

    /// The restore Chat is back on.
    fn restored(&self) -> Option<&Restored> {
        match self {
            ChatTarget::Restored(r) => Some(r),
            _ => None,
        }
    }

    /// Chat follows the Board's selected card: on the Board, not on the Run page (the shown
    /// workspace's run: Chat on that workspace).
    pub fn follows_card(&self, on_run: bool) -> bool {
        matches!(self.pin(), ChatTarget::Card) && !on_run
    }

    /// `place` pinned (a restore stays over it). True when that moved Chat.
    fn pin_to(&mut self, place: ChatTarget) -> bool {
        let pin = self.pin_mut();
        if *pin == place {
            return false;
        }
        *pin = place;
        true
    }

    /// Chat on the Board's card (`on`) or the shown workspace.
    pub fn on_card(&mut self, on: bool) -> bool {
        self.pin_to(if on {
            ChatTarget::Card
        } else {
            ChatTarget::Workspace
        })
    }

    /// Chat on the repo's Abe chat, `root` its main checkout.
    pub fn on_abe(&mut self, root: String) -> bool {
        self.pin_to(ChatTarget::Abe(root))
    }

    /// Chat on a prototype's `session`.
    pub fn on_prototype(&mut self, session: String) -> bool {
        self.pin_to(ChatTarget::Prototype(session))
    }

    /// The Board selected `card` (none: no card). True while a restore holds Chat (its first
    /// selection since); another ends it.
    pub fn selected(&mut self, card: Option<u64>) -> bool {
        let ChatTarget::Restored(r) = self else {
            return false;
        };
        if *r.first.get_or_insert(card) == card {
            return true;
        }
        *self = (*r.under).clone();
        false
    }

    /// Chat said it is on `session`: another than the restored one, before that one, ends the
    /// restore (gone since: Chat as without it). True when it ended.
    pub fn chat_said(&mut self, session: Option<&str>) -> bool {
        let ChatTarget::Restored(r) = self else {
            return false;
        };
        if r.said {
            return false;
        }
        if session == Some(r.session.as_str()) {
            r.said = true;
            return false;
        }
        *self = (*r.under).clone();
        true
    }

    /// Another workspace is shown: a restore ends; `restore` (the session Chat was on there at
    /// the last quit) starts one over the place pinned.
    pub fn shown_moved(&mut self, restore: Option<String>) {
        let pin = self.pin().clone();
        *self = match restore {
            Some(session) => ChatTarget::Restored(Restored {
                session,
                said: false,
                first: None,
                under: Box::new(pin),
            }),
            None => pin,
        };
    }
}

/// The column's mode as the views draw it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Modes {
    /// The Factory view is shown.
    pub factory_shown: bool,
    /// The Factory view's column is in Terminal mode.
    pub factory_terminal: bool,
    /// The shown view's column is in Terminal mode.
    pub terminal_now: bool,
}

/// Where Chat's target is read: the Board's selection, the main slot's page, the column's mode
/// and the shown project.
#[derive(Clone, Copy, Debug, Default)]
pub struct ChatAt<'a> {
    pub selected: Option<&'a Selected>,
    /// The Board said what it selects since the view started (before it, Chat is on the shown
    /// workspace; a null then is no card: `{card: none}`).
    pub said_selected: bool,
    /// The main slot is on the Run page.
    pub on_run: bool,
    pub modes: Modes,
    /// The shown project's folder, its box (a cloud one's) and branch.
    pub root: Option<&'a str>,
    pub box_: Option<&'a str>,
    pub branch: Option<&'a str>,
}

/// The `chat` screen's params for `target` at `at`: `{abe}` on the Abe chat, `{session}` on a
/// prototype's, the selected card `{card, whose?, title?}` while Chat follows it (`{card: none}`
/// once the Board said it selects none), else `{root?, box?, branch?}` of the shown workspace,
/// with `restore` while Chat is back on its last quit's session; `mode: terminal` while the
/// column it draws in is in Terminal mode (the Factory view's on its places, else the shown
/// view's: a workspace's Run and Card pages too).
pub fn open_params(target: &ChatTarget, at: &ChatAt) -> BTreeMap<String, String> {
    let mut params = BTreeMap::new();
    let mut put = |k: &str, v: &str| params.insert(k.to_owned(), v.to_owned());
    let terminal = if target.in_factory() {
        at.modes.factory_shown && at.modes.factory_terminal
    } else {
        at.modes.terminal_now
    };
    if terminal {
        put("mode", "terminal");
    }
    match target.pin() {
        // Boxes, Pipelines: the main checkout's, never the shown card workspace's (the bridge
        // fills `root` with the shown one's, `abe` it takes over it)
        ChatTarget::Abe(root) => {
            put("abe", root);
            return params;
        }
        ChatTarget::Prototype(session) => {
            put("session", session);
            return params;
        }
        _ => {}
    }
    let restored = target.restored();
    if let Some(r) = restored {
        put("restore", &r.session);
    }
    if target.follows_card(at.on_run) && restored.is_none() {
        if let Some(s) = at.selected {
            put("card", &s.card.to_string());
            if let Some(owner) = &s.owner {
                put("whose", owner);
            }
            if let Some(title) = &s.title {
                put("title", title);
            }
            return params;
        }
        if at.said_selected {
            put("card", "none");
            return params;
        }
    }
    for (k, v) in [("root", at.root), ("box", at.box_), ("branch", at.branch)] {
        if let Some(v) = v {
            put(k, v);
        }
    }
    params
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A move of what Chat is on.
    enum Move {
        Card(bool),
        Abe(&'static str),
        Prototype(&'static str),
        /// The Board's selection; whether a restore held Chat.
        Selected(Option<u64>, bool),
        /// Chat said its session; whether that ended a restore.
        Said(Option<&'static str>, bool),
        Shown(Option<&'static str>),
    }

    #[test]
    fn chat_opens_on_what_its_target_and_the_window_say() {
        use Move as M;
        let story = |card, title: &str| Selected {
            card,
            owner: None,
            title: Some(title.to_owned()),
        };
        let five = story(5, "Story 5");
        let seven = Selected {
            owner: Some("Lee Park".to_owned()),
            ..story(7, "Story 7")
        };
        let editor = ChatAt {
            root: Some("/wt/s4"),
            branch: Some("card/4-cart"),
            ..ChatAt::default()
        };
        let board = |selected| ChatAt {
            selected,
            said_selected: true,
            modes: Modes {
                factory_shown: true,
                ..Modes::default()
            },
            ..editor
        };
        fn terminal(at: ChatAt) -> ChatAt {
            ChatAt {
                modes: Modes {
                    factory_terminal: true,
                    terminal_now: true,
                    ..at.modes
                },
                ..at
            }
        }
        let (five, seven) = (&five, &seven);
        let rows: Vec<(&str, Vec<Move>, ChatAt, &str)> = vec![
            (
                "the Editor: the shown workspace, its branch",
                vec![],
                editor,
                r#"{"branch":"card/4-cart","root":"/wt/s4"}"#,
            ),
            (
                "a cloud workspace: its box",
                vec![],
                ChatAt {
                    root: Some("/p/shop"),
                    box_: Some("box-1"),
                    branch: None,
                    ..editor
                },
                r#"{"box":"box-1","root":"/p/shop"}"#,
            ),
            (
                "the Board: its selected card, at once",
                vec![M::Card(true)],
                board(Some(five)),
                r#"{"card":"5","title":"Story 5"}"#,
            ),
            (
                "a teammate's card: whose",
                vec![M::Card(true)],
                board(Some(seven)),
                r#"{"card":"7","title":"Story 7","whose":"Lee Park"}"#,
            ),
            (
                "the ring on an empty column: no card",
                vec![M::Card(true)],
                board(None),
                r#"{"card":"none"}"#,
            ),
            (
                "the Board before it said what it selects: the shown workspace",
                vec![M::Card(true)],
                ChatAt {
                    said_selected: false,
                    ..board(None)
                },
                r#"{"branch":"card/4-cart","root":"/wt/s4"}"#,
            ),
            (
                "the Board in Terminal mode: the card's Claude Code",
                vec![M::Card(true)],
                terminal(board(Some(seven))),
                r#"{"card":"7","mode":"terminal","title":"Story 7","whose":"Lee Park"}"#,
            ),
            (
                "the Board's card back to the Editor: the workspace again",
                vec![M::Card(true), M::Card(false)],
                editor,
                r#"{"branch":"card/4-cart","root":"/wt/s4"}"#,
            ),
            (
                "the Editor in Terminal mode: the workspace's Claude Code",
                vec![],
                terminal(editor),
                r#"{"branch":"card/4-cart","mode":"terminal","root":"/wt/s4"}"#,
            ),
            (
                "a workspace's Run page: the workspace, not the Board's card",
                vec![M::Card(true)],
                ChatAt {
                    on_run: true,
                    ..board(Some(five))
                },
                r#"{"branch":"card/4-cart","root":"/wt/s4"}"#,
            ),
            (
                "a workspace's Card page in Terminal mode: the Editor's mode is the shown view's",
                vec![M::Card(false)],
                ChatAt {
                    modes: Modes {
                        factory_shown: true,
                        factory_terminal: false,
                        terminal_now: true,
                    },
                    ..editor
                },
                r#"{"branch":"card/4-cart","mode":"terminal","root":"/wt/s4"}"#,
            ),
            (
                "Boxes, Pipelines: the Abe chat, wherever you came from",
                vec![M::Card(true), M::Abe("/p/shop")],
                board(Some(five)),
                r#"{"abe":"/p/shop"}"#,
            ),
            (
                "the Abe chat from the Editor in Terminal mode: the Factory view's mode",
                vec![M::Abe("/p/shop")],
                ChatAt {
                    modes: Modes {
                        factory_shown: false,
                        factory_terminal: true,
                        terminal_now: true,
                    },
                    ..editor
                },
                r#"{"abe":"/p/shop"}"#,
            ),
            (
                "a prototype's tile: its own session, whatever the Board selects",
                vec![M::Prototype("p1")],
                board(Some(five)),
                r#"{"session":"p1"}"#,
            ),
            (
                "a prototype's tile left for the workspace in the same folder: the workspace's \
                 own chat, never the prototype's",
                vec![M::Prototype("p1"), M::Card(false)],
                editor,
                r#"{"branch":"card/4-cart","root":"/wt/s4"}"#,
            ),
            (
                "a prototype's tile left for Abe (⌘↓ round): the Abe chat, never the prototype's",
                vec![M::Prototype("p1"), M::Abe("/p/shop")],
                editor,
                r#"{"abe":"/p/shop"}"#,
            ),
            (
                "a prototype's tile left for the Board: its card",
                vec![M::Prototype("p1"), M::Card(true)],
                board(Some(five)),
                r#"{"card":"5","title":"Story 5"}"#,
            ),
            (
                "a launch: the workspace's last quit session restored",
                vec![M::Shown(Some("s7"))],
                editor,
                r#"{"branch":"card/4-cart","restore":"s7","root":"/wt/s4"}"#,
            ),
            (
                "the last quit's session a prototype's: restored on the workspace (the bridge \
                 pins the workspace's own)",
                vec![M::Shown(Some("p1"))],
                editor,
                r#"{"branch":"card/4-cart","restore":"p1","root":"/wt/s4"}"#,
            ),
            (
                "restored, on the Board: its first selection not followed",
                vec![
                    M::Shown(Some("s7")),
                    M::Card(true),
                    M::Selected(Some(5), true),
                    M::Selected(Some(5), true),
                ],
                board(Some(five)),
                r#"{"branch":"card/4-cart","restore":"s7","root":"/wt/s4"}"#,
            ),
            (
                "restored, on the Board: another card followed",
                vec![
                    M::Shown(Some("s7")),
                    M::Card(true),
                    M::Selected(Some(5), true),
                    M::Selected(Some(7), false),
                ],
                board(Some(seven)),
                r#"{"card":"7","title":"Story 7","whose":"Lee Park"}"#,
            ),
            (
                "restored: Chat said that session, then another: still restored",
                vec![
                    M::Shown(Some("s7")),
                    M::Said(Some("s7"), false),
                    M::Said(Some("s9"), false),
                ],
                editor,
                r#"{"branch":"card/4-cart","restore":"s7","root":"/wt/s4"}"#,
            ),
            (
                "restored: Chat said another first (gone since): as without it",
                vec![M::Shown(Some("s7")), M::Said(Some("s9"), true)],
                editor,
                r#"{"branch":"card/4-cart","root":"/wt/s4"}"#,
            ),
            (
                "restored, then another workspace shown: as without it",
                vec![M::Shown(Some("s7")), M::Shown(None)],
                editor,
                r#"{"branch":"card/4-cart","root":"/wt/s4"}"#,
            ),
            (
                "restored over Boxes and back: the restore again",
                vec![M::Shown(Some("s7")), M::Abe("/p/shop"), M::Card(false)],
                editor,
                r#"{"branch":"card/4-cart","restore":"s7","root":"/wt/s4"}"#,
            ),
            (
                "restored while on Boxes: the Abe chat",
                vec![M::Abe("/p/shop"), M::Shown(Some("s7"))],
                editor,
                r#"{"abe":"/p/shop"}"#,
            ),
            (
                "no restore: the Board's selection and Chat's session move nothing",
                vec![M::Selected(Some(5), false), M::Said(Some("s9"), false)],
                editor,
                r#"{"branch":"card/4-cart","root":"/wt/s4"}"#,
            ),
        ];
        for (name, moves, at, want) in rows {
            let mut t = ChatTarget::default();
            for m in moves {
                match m {
                    M::Card(on) => {
                        t.on_card(on);
                    }
                    M::Abe(root) => {
                        t.on_abe(root.to_owned());
                    }
                    M::Prototype(s) => {
                        t.on_prototype(s.to_owned());
                    }
                    M::Selected(card, held) => assert_eq!(t.selected(card), held, "{name}"),
                    M::Said(s, ended) => assert_eq!(t.chat_said(s), ended, "{name}"),
                    M::Shown(restore) => t.shown_moved(restore.map(str::to_owned)),
                }
            }
            let got = serde_json::to_string(&open_params(&t, &at)).unwrap();
            assert_eq!(got, want, "{name}");
        }
        // pinned again where it is: nothing moved (no reopen)
        let mut t = ChatTarget::default();
        assert!(!t.on_card(false));
        assert!(t.on_card(true) && !t.on_card(true));
        assert!(t.on_abe("/p".into()) && !t.on_abe("/p".into()) && t.on_abe("/q".into()));
        assert!(t.on_prototype("p1".into()) && !t.on_prototype("p1".into()));
        t.shown_moved(Some("s7".into()));
        assert!(!t.on_prototype("p1".into()) && t.on_card(true) && !t.on_card(true));
    }
}
