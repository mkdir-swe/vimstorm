//! The Factory's bridge in tests: the contract's fixtures (`abe/packages/ui/contract`, written by
//! `bun run contract`) and a fake `abe ui bridge` (`tests/fixtures/factory/fake-bridge.sh`) printing
//! them, its input logged.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use gpui_kit::{
    Bounds, Entity, Focusable as _, Modifiers, MouseButton, MouseUpEvent, Pixels, TestAppContext,
    TestDispatcher, VisualTestContext, WindowOptions, px, size,
};
use serde_json::Value;
use vimstorm::editor::input;
use vimstorm::factory::{BridgeCommand, FIRST_SCREEN, FactoryEvent, FactoryView, Slot, SlotView};

pub fn contract() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../abe/packages/ui/contract")
}

pub fn fixture(rel: &str) -> PathBuf {
    contract().join(rel)
}

/// The fake bridge with its log in `dir`, printing `frames` on open.
pub fn fake(dir: &Path, frames: &[&str], die: Option<&str>) -> BridgeCommand {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/factory/fake-bridge.sh");
    let mut env = vec![
        (
            "FAKE_BRIDGE_LOG".to_owned(),
            dir.join("log").to_string_lossy().into_owned(),
        ),
        (
            "FAKE_BRIDGE_FRAMES".to_owned(),
            frames
                .iter()
                .map(|f| fixture(f).to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(" "),
        ),
    ];
    if let Some(die) = die {
        env.push(("FAKE_BRIDGE_DIE".into(), die.into()));
    }
    BridgeCommand {
        program: script,
        args: vec!["ui".into(), "bridge".into()],
        env,
    }
}

/// What the fake bridge was sent, a line each.
pub fn log(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("log"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// A Factory view as a test window's root.
pub struct Win {
    pub cx: VisualTestContext,
    pub view: Entity<FactoryView>,
    /// The view's own shell effects handed back to it ([`own_effects`]).
    _effects: gpui_kit::Subscription,
}

/// The view's own shell effects handed back as the window shell's executor does: a test window
/// has no Projects to run the rest.
fn own_effects(view: Entity<FactoryView>, ev: &FactoryEvent, cx: &mut gpui_kit::App) {
    if let FactoryEvent::Shell(effect) = ev {
        vimstorm::shell::effects::give_back(&view, effect.clone(), cx);
    }
}

impl Win {
    pub fn open(command: Option<BridgeCommand>) -> Win {
        Win::open_sized(command, 1000., 700.)
    }

    /// The view in a window of this size.
    pub fn open_sized(command: Option<BridgeCommand>, width: f32, height: f32) -> Win {
        let mut app = TestAppContext::build(TestDispatcher::new(0), None);
        if let Some(c) = command {
            app.update(|cx| cx.set_global(c));
        }
        let window = app.open_window(size(px(width), px(height)), FactoryView::new);
        let view = window.root(&mut app).unwrap();
        let effects = app.update(|cx| cx.subscribe(&view, own_effects));
        let cx = VisualTestContext::from_window(window.into(), &app);
        let w = Win {
            cx,
            view,
            _effects: effects,
        };
        w.cx.run_until_parked();
        w
    }

    /// Shows a tree as if the bridge sent it, for the screen the view opens.
    pub fn tree(&mut self, rel: &str, rev: u64) {
        let tree: Value =
            serde_json::from_str(&std::fs::read_to_string(fixture(rel)).unwrap()).unwrap();
        let line = serde_json::json!({"v": 2, "type": "tree", "screen": FIRST_SCREEN, "rev": rev, "tree": tree})
            .to_string();
        self.view
            .update(&mut self.cx, |v, cx| v.receive_line(&line, cx));
        self.cx.run_until_parked();
    }

    pub fn drawn(&mut self, kind: &str) -> Vec<String> {
        self.cx.run_until_parked();
        self.view.read_with(&self.cx, |v, _| {
            v.drawn()
                .texts(kind)
                .into_iter()
                .map(str::to_owned)
                .collect()
        })
    }

    /// The debug selector of the drawn `kind` with these words (`factory-Badge-12`).
    pub fn sel(&mut self, kind: &str, text: &str) -> &'static str {
        self.cx.run_until_parked();
        let ix = self.view.read_with(&self.cx, |v, _| {
            let d = v.drawn();
            d.items
                .iter()
                .position(|(k, t)| k == kind && t == text)
                .map(|i| d.ix(i))
        });
        let ix = ix.unwrap_or_else(|| panic!("no {kind} {text} drawn"));
        Box::leak(format!("factory-{kind}-{ix}").into_boxed_str())
    }

    pub fn bounds(&mut self, selector: &'static str) -> Bounds<Pixels> {
        self.cx
            .debug_bounds(selector)
            .unwrap_or_else(|| panic!("{selector} isn't drawn"))
    }

    pub fn start(&mut self) {
        let view = self.view.clone();
        self.cx.update(|window, cx| {
            view.update(cx, |v, cx| v.start(window, cx));
            window.focus(&view.focus_handle(cx), cx);
        });
        self.cx.run_until_parked();
    }

    pub fn wait(&mut self, label: &str, mut pred: impl FnMut(&mut Win) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            self.cx.run_until_parked();
            if pred(self) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out waiting for: {label}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn click(&mut self, selector: &'static str) {
        let at = self.bounds(selector).center();
        self.cx
            .simulate_mouse_down(at, MouseButton::Left, Modifiers::default());
        self.cx.simulate_event(MouseUpEvent {
            position: at,
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count: 1,
        });
        self.cx.run_until_parked();
    }
}

impl Win {
    /// Shows a layer as if the bridge sent it (`None`: no layer).
    pub fn layer(&mut self, rel: Option<&str>, rev: u64) {
        let tree = rel.map_or(Value::Null, |rel| {
            serde_json::from_str(&std::fs::read_to_string(fixture(rel)).unwrap()).unwrap()
        });
        self.layer_tree(tree, rev);
    }

    /// A layer frame of this tree.
    pub fn layer_tree(&mut self, tree: Value, rev: u64) {
        let line =
            serde_json::json!({"v": 2, "type": "layer", "rev": rev, "tree": tree}).to_string();
        self.view
            .update(&mut self.cx, |v, cx| v.receive_line(&line, cx));
        self.cx.run_until_parked();
    }

    pub fn keys(&mut self, keys: &[&str]) {
        for k in keys {
            let k = input::keystroke(k).unwrap();
            self.cx
                .update(|window, cx| window.dispatch_keystroke(k, cx));
        }
        self.cx.run_until_parked();
    }
}

/// A layer frame of a contract tree, written to `dir` for the fake bridge to print.
pub fn layer_frame(dir: &Path, rel: Option<&str>, rev: u64) -> PathBuf {
    let tree = rel.map_or(Value::Null, |rel| {
        serde_json::from_str(&std::fs::read_to_string(fixture(rel)).unwrap()).unwrap()
    });
    let name = rel.map_or("none".into(), |r| r.replace('/', "-"));
    let path = dir.join(format!("layer-{rev}-{name}"));
    std::fs::write(
        &path,
        serde_json::json!({"v": 2, "type": "layer", "rev": rev, "tree": tree}).to_string(),
    )
    .unwrap();
    path
}

/// [`fake`], answering frames that hold a text with frame files (`FAKE_BRIDGE_ON`).
pub fn fake_on(dir: &Path, frames: &[&str], on: &[(&str, Vec<PathBuf>)]) -> BridgeCommand {
    let mut command = fake(dir, frames, None);
    let rules = on
        .iter()
        .map(|(when, files)| {
            let files: Vec<String> = files
                .iter()
                .map(|f| f.to_string_lossy().into_owned())
                .collect();
            format!("{when}={}", files.join(" "))
        })
        .collect::<Vec<_>>()
        .join("\n");
    command.env.push(("FAKE_BRIDGE_ON".into(), rules));
    command
}

/// A program that says it is ready (with `$FROM_NODE`) and echoes each line it reads; `quit` ends
/// it with code 3.
pub fn echo_script(dir: &Path) -> String {
    let path = dir.join("echo.sh");
    std::fs::write(
        &path,
        "#!/bin/sh\necho ready $FROM_NODE\nwhile IFS= read -r l; do\n  [ \"$l\" = quit ] && exit 3\n  echo \"got: $l\"\ndone\n",
    )
    .unwrap();
    std::process::Command::new("chmod")
        .args(["+x", path.to_str().unwrap()])
        .status()
        .unwrap();
    path.to_string_lossy().into_owned()
}

/// A line as if the bridge sent it.
pub fn send(w: &mut Win, line: &str) {
    w.view.update(&mut w.cx, |v, cx| v.receive_line(line, cx));
    w.cx.run_until_parked();
}

/// The screen of the view's terminal under `key`, a line each.
pub fn screen(w: &mut Win, key: &str) -> String {
    w.view.read_with(&w.cx, |v, cx| {
        v.terminal(key)
            .map(|t| t.read(cx).screen().join("\n"))
            .unwrap_or_default()
    })
}

/// Keys (`h i enter`) dispatched to the window one by one.
pub fn press(w: &mut Win, keys: &str) {
    for k in keys.split(' ') {
        let ks = input::keystroke(k).unwrap_or_else(|| panic!("no key {k}"));
        w.cx.update(|window, cx| window.dispatch_keystroke(ks, cx));
        w.cx.run_until_parked();
    }
}

/// A view on the fake bridge, started, a first tree drawn.
pub fn started(dir: &Path) -> Win {
    let mut w = Win::open(Some(fake(dir, &["frames/bridge-tree.json"], None)));
    w.start();
    w.wait("the bridge's tree", |w| {
        w.view.read_with(&w.cx, |v, _| v.rev()) == Some(1)
    });
    w
}

/// A slot's view as the app's hosts draw it (the Chat column, the pane): cached, drawn again
/// only when it says so.
pub struct SlotHost(pub Entity<SlotView>);

impl gpui_kit::Render for SlotHost {
    fn render(
        &mut self,
        _: &mut gpui_kit::Window,
        cx: &mut gpui_kit::Context<Self>,
    ) -> impl gpui_kit::IntoElement {
        use gpui_kit::{ParentElement as _, Styled as _};
        gpui_kit::div()
            .size_full()
            .child(SlotView::hosted(&self.0, cx))
    }
}

impl Win {
    /// A [`SlotView`] on `slot` in a window of its own (hosted as the app hosts it), and a test
    /// context on that window.
    pub fn open_slot(&mut self, slot: Slot) -> (VisualTestContext, Entity<SlotView>) {
        let factory = self.view.clone();
        let handle = self
            .cx
            .update(|_, cx| {
                cx.open_window(WindowOptions::default(), |window, cx| {
                    let view = factory.update(cx, |f, cx| f.slot_view(slot, window, cx));
                    gpui_kit::AppContext::new(cx, |_| SlotHost(view))
                })
            })
            .unwrap();
        let view = handle.root(&mut self.cx).unwrap();
        let view = view.read_with(&self.cx, |h, _| h.0.clone());
        let scx = VisualTestContext::from_window(handle.into(), &self.cx);
        scx.run_until_parked();
        (scx, view)
    }
}
