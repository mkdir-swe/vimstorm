//! The bridge session at its interface, over the in-memory pair: what each bridge is told (the
//! first, a restarted one, a retried one) and which of its frames count.

use std::time::{Duration, Instant};

use futures::channel::mpsc::{UnboundedReceiver, unbounded};

use super::*;
use crate::factory::protocol::Lines;

struct Rig {
    s: Session,
    pair: Pair,
    rx: UnboundedReceiver<BridgeEvent>,
}

impl Rig {
    fn new() -> Rig {
        let (tx, rx) = unbounded();
        let mut s = Session::new(tx);
        s.screen_is(Slot::Main, "factory");
        Rig {
            s,
            pair: Pair::new(),
            rx,
        }
    }

    fn start(&mut self) {
        self.s
            .start(Box::new(self.pair.clone()), Landing::default())
            .unwrap();
    }

    /// The next event of any bridge, as its reader thread decoded it.
    fn event(&mut self) -> BridgeEvent {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(ev) = self.rx.try_recv() {
                return ev;
            }
            assert!(Instant::now() < deadline, "no event from the bridge");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// What the session hands on of the next event, as a word.
    fn heard(&mut self) -> String {
        let ev = self.event();
        match self.s.take(ev) {
            None => "dropped".into(),
            Some(Heard::Exited) => "exited".into(),
            Some(Heard::Refused) => "refused".into(),
            Some(Heard::Frame(f)) => match *f {
                BridgeFrame::Tree {
                    rev, slot, tree, ..
                } => {
                    let ids: Vec<&str> = tree.children().iter().filter_map(Node::id).collect();
                    let ids = if ids.is_empty() {
                        String::new()
                    } else {
                        format!(" [{}]", ids.join(" "))
                    };
                    format!("tree {:?} {rev}{ids}", slot.unwrap_or_default())
                }
                BridgeFrame::Layer { rev, tree, .. } => {
                    format!("layer {rev} {}", if tree.is_some() { "up" } else { "none" })
                }
                BridgeFrame::Closed { slot, .. } => format!("closed {slot:?}"),
                BridgeFrame::Shell { .. } => "shell".into(),
                BridgeFrame::Answer { .. } | BridgeFrame::Error { .. } => "?".into(),
            },
        }
    }

    /// The bridge exits; the view's restart follows with `landing`.
    fn die(&mut self, landing: Landing) -> Result<(), String> {
        self.pair.end();
        assert_eq!(self.heard(), "exited");
        self.s.lost();
        self.s.restart("abe ui bridge exited".into(), landing)
    }

    /// What start `n` heard, the app's version as `V`.
    fn told(&self, n: usize) -> Vec<String> {
        let version = format!(r#""version":"{}""#, env!("CARGO_PKG_VERSION"));
        self.pair
            .heard(n)
            .into_iter()
            .map(|l| l.replace(&version, r#""version":"V""#))
            .collect()
    }
}

fn params(kv: &[(&str, &str)]) -> Params {
    kv.iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn size(width: f32, height: f32) -> ViewSize {
    ViewSize { width, height }
}

fn tree(slot: &str, rev: u64) -> String {
    let slot = if slot == "main" {
        String::new()
    } else {
        format!(r#","slot":"{slot}""#)
    };
    format!(
        r#"{{"v":2,"type":"tree","screen":"s","rev":{rev},"tree":{{"kind":"Island","props":{{}}}}{slot}}}"#
    )
}

/// Main's tree: an Island of Empty nodes with these ids.
fn island(rev: u64, ids: &[&str]) -> String {
    format!(
        r#"{{"v":2,"type":"tree","screen":"s","rev":{rev},"tree":{{"kind":"Island","props":{{}},"children":[{}]}}}}"#,
        ids.iter().map(|id| empty(id)).collect::<Vec<_>>().join(",")
    )
}

fn empty(id: &str) -> String {
    format!(r#"{{"kind":"Empty","id":"{id}","props":{{"title":"{id}","line":""}}}}"#)
}

/// Main's patch of `base` with these ops.
fn patch(rev: u64, base: u64, ops: &str) -> String {
    format!(r#"{{"v":2,"type":"patch","screen":"s","rev":{rev},"base":{base},"ops":[{ops}]}}"#)
}

const AGAIN_MAIN: &str = r#"{"type":"again","v":2,"slot":"main"}"#;

fn layer(rev: u64, up: bool) -> String {
    let tree = if up {
        r#"{"kind":"Island","props":{}}"#
    } else {
        "null"
    };
    format!(r#"{{"v":2,"type":"layer","rev":{rev},"tree":{tree}}}"#)
}

/// Everything a window wants told: the shown project, Chat and the pane open and measured, the
/// keyboard in Chat, the window, a caret, the Settings dialog up.
fn everything(r: &mut Rig) {
    r.s.want_size(size(800., 600.));
    r.s.want_project(Project {
        root: Some("/demo".into()),
        box_: None,
        branch: Some("main".into()),
    });
    r.s.open(Slot::Chat, "chat", params(&[("root", "/demo")]));
    r.s.open(Slot::Pane, "sessions", params(&[("view", "editor")]));
    r.s.want_slot_size(Slot::Chat, size(400., 700.));
    r.s.want_slot_size(Slot::Pane, size(800., 200.));
    r.s.want_focus(Some(Slot::Chat));
    r.s.want_window(WindowAt {
        view: ViewName::Editor,
        active: true,
        place: Some("code".into()),
    });
    r.s.want_caret(Some(Caret {
        file: "src/cart.ts".into(),
        line: 12,
        selection: Some(Lines { from: 12, to: 14 }),
    }));
    r.s.open_settings(params(&[("page", "general")]));
}

const HELLO: &str =
    r#"{"type":"hello","v":2,"size":{"width":800.0,"height":600.0},"version":"V","root":"/demo"}"#;
const OPEN_MAIN: &str = r#"{"type":"open","v":2,"screen":"factory","params":{}}"#;
const OPEN_SETTINGS: &str =
    r#"{"type":"open","v":2,"screen":"settings","params":{"page":"general"}}"#;
const PROJECT: &str = r#"{"type":"project","v":2,"root":"/demo","branch":"main"}"#;
const OPEN_CHAT: &str =
    r#"{"type":"open","v":2,"screen":"chat","params":{"root":"/demo"},"slot":"chat"}"#;
const OPEN_PANE: &str =
    r#"{"type":"open","v":2,"screen":"sessions","params":{"view":"editor"},"slot":"pane"}"#;
const RESIZE_CHAT: &str =
    r#"{"type":"resize","v":2,"size":{"width":400.0,"height":700.0},"slot":"chat"}"#;
const RESIZE_PANE: &str =
    r#"{"type":"resize","v":2,"size":{"width":800.0,"height":200.0},"slot":"pane"}"#;
const FOCUS_CHAT: &str = r#"{"type":"focus","v":2,"slot":"chat"}"#;
const WINDOW: &str = r#"{"type":"window","v":2,"view":"editor","active":true,"place":"code"}"#;
const CARET: &str =
    r#"{"type":"caret","v":2,"file":"src/cart.ts","line":12,"selection":{"from":12,"to":14}}"#;

/// Everything wanted, in the order a new bridge is told it.
const ALL: &[&str] = &[
    HELLO,
    OPEN_MAIN,
    OPEN_SETTINGS,
    PROJECT,
    OPEN_CHAT,
    OPEN_PANE,
    RESIZE_CHAT,
    RESIZE_PANE,
    FOCUS_CHAT,
    WINDOW,
    CARET,
];

type Row = (
    &'static str,
    fn(&mut Rig) -> Vec<String>,
    &'static [&'static str],
);

const ROWS: &[Row] = &[
    (
        "the first bridge is told what was wanted before it started",
        |r| {
            everything(r);
            r.start();
            r.told(0)
        },
        ALL,
    ),
    (
        "what is wanted while it runs is told once, only as it changes",
        |r| {
            r.start();
            everything(r);
            everything(r);
            r.s.want_size(size(900., 600.));
            r.s.want_focus(Some(Slot::Chat));
            r.told(0)[1..].to_vec()
        },
        &[
            OPEN_MAIN,
            r#"{"type":"resize","v":2,"size":{"width":800.0,"height":600.0}}"#,
            PROJECT,
            OPEN_CHAT,
            OPEN_PANE,
            RESIZE_CHAT,
            RESIZE_PANE,
            FOCUS_CHAT,
            WINDOW,
            CARET,
            OPEN_SETTINGS,
            // opened again: the screen there hears its `open`
            OPEN_CHAT,
            OPEN_PANE,
            OPEN_SETTINGS,
            r#"{"type":"resize","v":2,"size":{"width":900.0,"height":600.0}}"#,
        ],
    ),
    (
        "a restarted bridge is told everything again",
        |r| {
            r.start();
            everything(r);
            r.die(Landing::default()).unwrap();
            r.told(1)
        },
        ALL,
    ),
    (
        "a restart opens the screens the landing says, the others as kept",
        |r| {
            everything(r);
            r.start();
            let landing = Landing {
                slots: vec![
                    (Slot::Main, params(&[("card", "4"), ("tab", "mine")])),
                    (Slot::Chat, params(&[("root", "/demo"), ("session", "s7")])),
                ],
            };
            r.die(landing).unwrap();
            r.told(1)[1..5].to_vec()
        },
        &[
            r#"{"type":"open","v":2,"screen":"factory","params":{"card":"4","tab":"mine"}}"#,
            OPEN_SETTINGS,
            PROJECT,
            r#"{"type":"open","v":2,"screen":"chat","params":{"root":"/demo","session":"s7"},"slot":"chat"}"#,
        ],
    ),
    (
        "a restart opens the screen the bridge drew last, never one opened once",
        |r| {
            r.start();
            r.s.open(Slot::Main, "run", params(&[("card", "2")]));
            r.s.screen_is(Slot::Main, "card");
            r.s.open(Slot::Review, "review", params(&[("pr", "7")]));
            r.s.open_once(Slot::Review, "review-pick", Params::new());
            r.s.screen_is(Slot::Pane, "boxes");
            r.die(Landing::default()).unwrap();
            r.told(1)[1..].to_vec()
        },
        &[
            r#"{"type":"open","v":2,"screen":"card","params":{"card":"2"}}"#,
            r#"{"type":"open","v":2,"screen":"review","params":{"pr":"7"},"slot":"review"}"#,
        ],
    ),
    (
        "what is wanted while it is down is told the restarted one",
        |r| {
            r.start();
            r.pair.end();
            assert_eq!(r.heard(), "exited");
            r.s.lost();
            r.s.want_focus(Some(Slot::Pane));
            r.s.want_caret(None);
            r.s.restart("exited".into(), Landing::default()).unwrap();
            r.told(1)[2..].to_vec()
        },
        &[
            r#"{"type":"focus","v":2,"slot":"pane"}"#,
            r#"{"type":"no-caret","v":2}"#,
        ],
    ),
    (
        "a new bridge starts with no slot focused and nothing said of a caret",
        |r| {
            r.start();
            r.s.want_focus(Some(Slot::Chat));
            r.s.want_focus(None);
            r.die(Landing::default()).unwrap();
            r.told(1)[1..].to_vec()
        },
        &[OPEN_MAIN],
    ),
    (
        "another workspace's caret is told even when it is the same",
        |r| {
            r.start();
            let caret = Caret {
                file: "a.ts".into(),
                line: 1,
                selection: None,
            };
            r.s.want_caret(Some(caret.clone()));
            r.s.forget_caret();
            r.s.want_caret(Some(caret));
            r.told(0)[2..].to_vec()
        },
        &[
            r#"{"type":"caret","v":2,"file":"a.ts","line":1}"#,
            r#"{"type":"caret","v":2,"file":"a.ts","line":1}"#,
        ],
    ),
    (
        "a landing in the slot with the keys tells them leave and come back",
        |r| {
            r.start();
            r.s.refocus();
            r.s.want_focus(Some(Slot::Chat));
            r.s.refocus();
            r.told(0)[2..].to_vec()
        },
        &[
            FOCUS_CHAT,
            r#"{"type":"focus","v":2,"slot":null}"#,
            FOCUS_CHAT,
        ],
    ),
    (
        "the Settings dialog closed is not opened again on a restart",
        |r| {
            r.start();
            r.s.open_settings(Params::new());
            r.s.set_settings(None);
            r.die(Landing::default()).unwrap();
            r.told(1)[1..].to_vec()
        },
        &[OPEN_MAIN],
    ),
    (
        "a dead bridge's frames and end never count",
        |r| {
            r.start();
            r.pair.say(&tree("main", 5));
            let late = r.event();
            r.s.lost();
            r.s.restart("gone".into(), Landing::default()).unwrap();
            let dropped = format!("{:?}", r.s.take(late).is_some());
            // the first one's end (its link dropped) and the new one's first tree, in either order
            r.pair.say(&tree("main", 1));
            let mut heard = vec![r.heard(), r.heard()];
            heard.sort();
            heard.insert(0, dropped);
            heard
        },
        &["false", "dropped", "tree Main 1"],
    ),
    (
        "a tree or a layer older than the one taken is dropped, a closed slot's count anew",
        |r| {
            r.start();
            for line in [
                tree("main", 3),
                tree("main", 2),
                tree("chat", 1),
                tree("main", 4),
                layer(5, true),
                layer(4, true),
                layer(6, false),
                tree("popup", 7),
                r#"{"v":2,"type":"closed","slot":"popup"}"#.into(),
                tree("popup", 2),
            ] {
                r.pair.say(&line);
            }
            (0..10).map(|_| r.heard()).collect()
        },
        &[
            "tree Main 3",
            "dropped",
            "tree Chat 1",
            "tree Main 4",
            "layer 5 up",
            "dropped",
            "layer 6 none",
            "tree Popup 7",
            "closed Popup",
            "tree Popup 2",
        ],
    ),
    (
        "the app closing the popup counts its trees anew",
        |r| {
            r.start();
            r.pair.say(&tree("popup", 7));
            let mut heard = vec![r.heard()];
            r.s.close(Slot::Popup);
            r.pair.say(&tree("popup", 3));
            heard.push(r.heard());
            heard.push(r.told(0).last().cloned().unwrap_or_default());
            heard
        },
        &[
            "tree Popup 7",
            "tree Popup 3",
            r#"{"type":"close","v":2,"slot":"popup"}"#,
        ],
    ),
    (
        "a run is answered by its id; a bridge gone first cancels it",
        |r| {
            r.start();
            let rx = r.s.run(vec!["pr".into(), "draft-plan".into()]).unwrap();
            r.pair
                .say(r#"{"v":2,"type":"answer","id":"pr-draft-plan:1","reply":{"ok":true}}"#);
            let mut heard = vec![r.heard()];
            heard.push(futures::executor::block_on(rx).unwrap().to_string());
            let gone = r.s.run(vec!["pr".into()]).unwrap();
            r.s.lost();
            heard.push(format!("{:?}", futures::executor::block_on(gone).is_err()));
            heard.push(format!("{:?}", r.s.run(vec!["pr".into()]).is_none()));
            heard.push(r.told(0)[2].clone());
            heard
        },
        &[
            "dropped",
            r#"{"ok":true}"#,
            "true",
            "true",
            r#"{"type":"run","v":2,"id":"pr-draft-plan:1","argv":["pr","draft-plan"]}"#,
        ],
    ),
    (
        "a bridge dying once is restarted, again it stops; a retry starts it anew",
        |r| {
            r.start();
            let mut heard = vec![format!("{:?}", r.die(Landing::default()))];
            heard.push(format!("{:?}", r.die(Landing::default())));
            heard.push(format!("{:?} {:?}", r.s.stopped(), r.s.up()));
            r.s.want_focus(Some(Slot::Chat));
            heard.push(format!("{:?}", r.s.send(AppFrame::NoCaret { v: VERSION })));
            let pair = r.pair.clone();
            heard.push(format!(
                "{:?}",
                r.s.retry(|| Box::new(pair), Landing::default())
            ));
            heard.push(format!(
                "{} {} {:?}",
                r.pair.starts(),
                r.s.generation(),
                r.s.stopped()
            ));
            heard.push(r.told(2)[2].clone());
            heard
        },
        &[
            "Ok(())",
            r#"Err("abe ui bridge exited")"#,
            r#"Some("abe ui bridge exited") false"#,
            "false",
            "Ok(())",
            "3 3 None",
            FOCUS_CHAT,
        ],
    ),
    (
        "a bridge that fails to start again says why it stays down",
        |r| {
            r.start();
            r.pair.refuse("no such file");
            vec![
                format!("{:?}", r.die(Landing::default())),
                format!("{:?}", r.s.stopped()),
            ]
        },
        &[r#"Err("no such file")"#, r#"Some("no such file")"#],
    ),
    (
        "a patch of the tree held is heard as the whole tree, the next one built on it",
        |r| {
            r.start();
            r.pair.say(&island(1, &["a", "b"]));
            let splice = format!(r#"{{"path":[],"splice":[1,0],"add":[{}]}}"#, empty("c"));
            r.pair.say(&patch(2, 1, &splice));
            let replace = format!(r#"{{"path":[0],"node":{}}}"#, empty("d"));
            let cut = r#"{"path":[],"splice":[2,1],"add":[]}"#;
            r.pair.say(&patch(4, 2, &format!("{replace},{cut}")));
            (0..3).map(|_| r.heard()).collect()
        },
        &[
            "tree Main 1 [a b]",
            "tree Main 2 [a c b]",
            "tree Main 4 [d c]",
        ],
    ),
    (
        "a patch on a base not held asks for the whole tree again, and builds on that one",
        |r| {
            r.start();
            r.pair.say(&island(1, &["a"]));
            r.pair
                .say(&patch(3, 2, r#"{"path":[],"splice":[0,1],"add":[]}"#));
            // what was held went with it: a patch of rev 1 has nothing to build on
            r.pair
                .say(&patch(4, 1, r#"{"path":[],"splice":[0,1],"add":[]}"#));
            r.pair.say(&island(5, &["a", "b"]));
            r.pair
                .say(&patch(6, 5, r#"{"path":[],"splice":[0,1],"add":[]}"#));
            let mut heard: Vec<String> = (0..5).map(|_| r.heard()).collect();
            heard.extend(r.told(0)[2..].iter().cloned());
            heard
        },
        &[
            "tree Main 1 [a]",
            "dropped",
            "dropped",
            "tree Main 5 [a b]",
            "tree Main 6 [b]",
            AGAIN_MAIN,
            AGAIN_MAIN,
        ],
    ),
    (
        "a patch past the tree, or of another screen, asks again",
        |r| {
            r.start();
            r.pair.say(&island(1, &["a"]));
            r.pair
                .say(&patch(2, 1, r#"{"path":[3],"splice":[0,0],"add":[]}"#));
            r.pair.say(&island(3, &["a"]));
            r.pair
                .say(&patch(4, 3, r#"{"path":[],"splice":[0,2],"add":[]}"#));
            r.pair.say(&island(5, &["a"]));
            r.pair.say(
                &patch(6, 5, r#"{"path":[],"splice":[0,1],"add":[]}"#)
                    .replace(r#""screen":"s""#, r#""screen":"chat""#),
            );
            let mut heard: Vec<String> = (0..6).map(|_| r.heard()).collect();
            heard.push(r.told(0)[2..].len().to_string());
            heard
        },
        &[
            "tree Main 1 [a]",
            "dropped",
            "tree Main 3 [a]",
            "dropped",
            "tree Main 5 [a]",
            "dropped",
            "3",
        ],
    ),
    (
        "a restarted bridge's reader holds no tree: its patch asks that bridge again",
        |r| {
            r.start();
            r.pair.say(&island(1, &["a"]));
            let mut heard = vec![r.heard()];
            r.die(Landing::default()).unwrap();
            r.pair
                .say(&patch(2, 1, r#"{"path":[],"splice":[0,1],"add":[]}"#));
            heard.push(r.heard());
            heard.push(r.told(1).last().cloned().unwrap_or_default());
            heard
        },
        &["tree Main 1 [a]", "dropped", AGAIN_MAIN],
    ),
    (
        "a bridge of another contract version is refused: stopped with why, never restarted",
        |r| {
            r.start();
            r.pair.say(&tree("main", 1).replace(r#""v":2"#, r#""v":1"#));
            let mut heard = vec![r.heard()];
            heard.push(format!("{:?} {:?}", r.s.stopped(), r.s.up()));
            heard.push(format!(
                "{:?}",
                r.s.restart("gone".into(), Landing::default())
            ));
            heard
        },
        &[
            "refused",
            r#"Some("abe ui bridge speaks contract v1, this VimStorm v2: install the Abe that ships with this VimStorm") false"#,
            r#"Err("gone")"#,
        ],
    ),
    (
        "a bridge that refuses this contract's frames is refused the same way",
        |r| {
            r.start();
            r.pair.say(
                r#"{"v":2,"type":"error","error":{"code":"unsupported-version","message":"this bridge speaks v3, not v2"}}"#,
            );
            vec![r.heard(), format!("{:?}", r.s.stopped())]
        },
        &[
            "refused",
            r#"Some("abe ui bridge refused this VimStorm's contract v2 (this bridge speaks v3, not v2): install the Abe that ships with this VimStorm")"#,
        ],
    ),
];

#[test]
fn the_bridge_session_tells_each_bridge_what_is_wanted_and_takes_what_counts() {
    for &(name, script, want) in ROWS {
        let mut r = Rig::new();
        let got = script(&mut r);
        assert_eq!(got, want, "{name}");
    }
}
