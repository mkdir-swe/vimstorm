//! The Feel's behaviour switches (`abe settings feel`): the bridge's `feel` shell effect,
//! kept whole as a global the tree, the tabs and the editor's Lua read. Until the first effect
//! arrives (no bridge, serve not answering) the shell behaves as VimStorm always did.

use gpui_kit::Global;
use serde::{Deserialize, Serialize};

/// The pick: which bundle the switches started from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FeelName {
    #[default]
    Vimstorm,
    Webstorm,
    Vscode,
    /// Stock Vim keys and your own `~/.config/nvim`; WebStorm's Cmd keys and chrome.
    Vim,
}

/// What the Project tree marks a changed file with.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Decorations {
    /// Git colours only (WebStorm).
    #[default]
    Colors,
    /// Git colours and M / U / D letters at the right (VS Code).
    Letters,
}

/// When an edited file is written (VS Code's names).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoSave {
    Off,
    #[default]
    OnFocusChange,
    AfterDelay,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeFeel {
    /// The tree selects and scrolls to the file shown in the editor.
    pub auto_reveal: bool,
    /// A single click opens the file (as a preview where `tabs.preview`).
    pub single_click: bool,
    pub decorations: Decorations,
    /// A folder chain with one child each on one row (`a/b/c`).
    pub compact_folders: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsFeel {
    /// Tabs per split before the least recently used closes; None: no limit.
    pub limit: Option<u32>,
    /// A modified tab shows ● in place of its ×.
    pub dirty_dot: bool,
    /// A single-click open is an italic preview tab the next one replaces.
    pub preview: bool,
}

impl Default for TabsFeel {
    fn default() -> Self {
        Self {
            limit: Some(10),
            dirty_dot: false,
            preview: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesFeel {
    pub auto_save: AutoSave,
}

/// The switches in force: `Default` is VimStorm's (what the code did before the Feels).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Feel {
    pub feel: FeelName,
    pub tree: TreeFeel,
    pub tabs: TabsFeel,
    pub files: FilesFeel,
    /// The editor's switches: the minimap, Vim mode; a bridge older than them sends
    /// none (no minimap, Vim mode on).
    #[serde(default)]
    pub editor: EditorFeel,
    /// The Chat column's settings; a bridge older than them sends none.
    #[serde(default)]
    pub chat: ChatFeel,
    /// Your keys (your Layer's keys.json): nvim binds each (`config/keys.lua`); the app
    /// only hands them on. A bridge older than them sends none.
    #[serde(default)]
    pub keys: Vec<KeyBind>,
}

/// One key of yours: nvim's names for it, and VimStorm's key for its action (whose map does it).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct KeyBind {
    /// As keys.json writes it: `⌘Y`.
    pub key: String,
    pub action: String,
    pub lhs: Vec<String>,
    pub does: String,
}

/// `editor.minimap`: VS Code's minimap at each editor split's right ([`crate::editor::minimap`]);
/// `editor.vim`: off, the editor is always typing (no modes, arrows, the Feel's keymap).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct EditorFeel {
    #[serde(default)]
    pub minimap: bool,
    #[serde(default = "on")]
    pub vim: bool,
}

fn on() -> bool {
    true
}

impl Default for EditorFeel {
    fn default() -> Self {
        Self {
            minimap: false,
            vim: true,
        }
    }
}

/// `chat.openByDefault` and `chat.width`: the column shown when a window starts, its width.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFeel {
    pub open_by_default: bool,
    pub width: u32,
}

impl Default for ChatFeel {
    fn default() -> Self {
        Self {
            open_by_default: true,
            width: 420,
        }
    }
}

impl Global for Feel {}

/// The Feel vscode is in force: the layout's VS Code parts (breadcrumbs under the
/// tabs, the Activity bar, Problems in the bottom pane) follow it.
pub fn vscode(cx: &gpui_kit::App) -> bool {
    cx.try_global::<Feel>()
        .is_some_and(|f| f.feel == FeelName::Vscode)
}

impl Feel {
    /// Stock Vim keys in the editor (`config/feel.lua` `stock_keys`): Vim mode on under any
    /// Feel but vimstorm. VimStorm's leader `,` maps are off then.
    pub fn stock_keys(&self) -> bool {
        self.editor.vim && self.feel != FeelName::Vimstorm
    }

    /// The env a project's nvim starts with (`config/feel_keys.lua` `started_with`): its Feel, so
    /// it loads only the configs of yours that Feel has before the first `feel.set` arrives.
    pub fn spawn_env(&self) -> [(String, String); 2] {
        let name = serde_json::to_value(self.feel)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        [
            ("VIMSTORM_FEEL".into(), name),
            (
                "VIMSTORM_FEEL_VIM".into(),
                if self.editor.vim { "1" } else { "0" }.into(),
            ),
        ]
    }
}

/// [`Feel::stock_keys`] of the Feel in force: the tree and the Git window hand no `,` leader key
/// to nvim then (it has none).
pub fn stock_keys(cx: &gpui_kit::App) -> bool {
    cx.try_global::<Feel>().is_some_and(Feel::stock_keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_feel_is_vimstorm_as_before() {
        let f = Feel::default();
        assert_eq!(f.feel, FeelName::Vimstorm);
        assert_eq!(f.tabs.limit, Some(10));
        assert_eq!(f.files.auto_save, AutoSave::OnFocusChange);
        assert!(!f.tree.auto_reveal && !f.tree.single_click && !f.tree.compact_folders);
        assert_eq!(f.tree.decorations, Decorations::Colors);
        assert!(!f.editor.minimap);
        assert!(f.editor.vim);
    }

    /// The contract's feel frame, then each field an older bridge leaves out read as before.
    #[test]
    fn the_contract_feel_reads_and_an_older_bridges_falls_back() {
        let frame: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../abe/packages/ui/contract/frames/bridge-shell-feel.json"
            ))
            .unwrap(),
        )
        .unwrap();
        let sent = frame["effect"]["feel"].clone();
        let f: Feel = serde_json::from_value(sent.clone()).unwrap();
        assert!(f.editor.minimap, "the minimap comes with vscode");
        assert!(!f.editor.vim);
        assert_eq!(serde_json::to_value(&f).unwrap()["editor"]["vim"], false);
        assert_eq!(
            f.keys[0],
            KeyBind {
                key: "⌘Y".into(),
                action: "goToFile".into(),
                lhs: vec!["<D-y>".into()],
                does: "<D-o>".into(),
            }
        );
        assert_eq!(
            serde_json::to_value(&f).unwrap()["keys"],
            sent["keys"],
            "your keys go on to nvim as sent"
        );

        let without = |field: &str| {
            let mut v = sent.clone();
            v.as_object_mut().unwrap().remove(field);
            serde_json::from_value::<Feel>(v).unwrap()
        };
        let old = without("editor");
        assert!(!old.editor.minimap, "no editor: minimap off");
        assert!(old.editor.vim, "no editor: Vim mode on");
        assert!(without("keys").keys.is_empty(), "no keys: none");
    }

    #[test]
    fn the_feel_vim_reads_and_has_stock_keys() {
        let f: Feel = serde_json::from_value(serde_json::json!({
            "feel": "vim",
            "tree": {"autoReveal": false, "singleClick": false, "decorations": "colors", "compactFolders": false},
            "tabs": {"limit": 10, "dirtyDot": false, "preview": false},
            "files": {"autoSave": "onFocusChange"},
            "editor": {"minimap": false, "vim": true},
        }))
        .unwrap();
        assert_eq!(f.feel, FeelName::Vim);
        assert!(f.stock_keys());
        assert!(!Feel::default().stock_keys(), "vimstorm: VimStorm's keys");
        let off = Feel {
            feel: FeelName::Webstorm,
            editor: EditorFeel {
                minimap: false,
                vim: false,
            },
            ..Feel::default()
        };
        assert!(!off.stock_keys(), "Vim mode off: no Vim keys at all");
        assert_eq!(
            off.spawn_env(),
            [
                ("VIMSTORM_FEEL".into(), "webstorm".into()),
                ("VIMSTORM_FEEL_VIM".into(), "0".into())
            ]
        );
        assert_eq!(f.spawn_env()[0].1, "vim");
    }

    #[test]
    fn the_feel_goes_to_nvim_in_the_bridges_shape() {
        let f = Feel {
            feel: FeelName::Vscode,
            tabs: TabsFeel {
                limit: None,
                dirty_dot: true,
                preview: true,
            },
            ..Feel::default()
        };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v["feel"], "vscode");
        assert_eq!(v["tabs"]["limit"], serde_json::Value::Null);
        assert_eq!(v["tabs"]["dirtyDot"], true);
        assert_eq!(v["tree"]["autoReveal"], false);
        assert_eq!(v["files"]["autoSave"], "onFocusChange");
        assert_eq!(serde_json::from_value::<Feel>(v).unwrap(), f);
    }
}
