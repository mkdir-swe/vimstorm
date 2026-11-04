//! Feel vscode's Problems tab (VS Code's Problems panel, ⌘⇧M): the first tab of the bottom
//! pane under the Feel vscode, the workspace's diagnostics by file (errors first, then by line),
//! as `config/app/pane.lua` sends them while the pane is open and they change. A file's row
//! (icon, name, its folder dimmed, the count) heads its problems (severity icon, message, the
//! source and code dimmed, `[Ln l, Col c]`); ⏎ or a click on a problem opens its file there (the
//! keyboard goes to the code), on a file row its first problem. None: VS Code's "No problems have
//! been detected in the workspace."

use gpui_kit::{
    AnyElement, Context, InteractiveElement as _, IntoElement, MouseButton, MouseUpEvent,
    ParentElement as _, SharedString, Styled as _, Window, div, prelude::FluentBuilder as _, px,
};
use serde::Deserialize;

use crate::editor::tabs::seq;
use crate::kit::{self, Icon, IconName};
use crate::kit::{ListDelegate, ListOptions, ListSource, ListView, RowState, SearchMode};
use crate::look;
use crate::shell::SurfaceCx;

/// One diagnostic (`config/app/pane.lua` problems()): 1-based line and column.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Problem {
    pub lnum: u32,
    pub col: u32,
    /// "error" | "warning" | "info" | "hint".
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub code: String,
}

/// A file's problems: its absolute path, its name and folder relative to the project.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct ProblemFile {
    pub path: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub dir: String,
    #[serde(default, deserialize_with = "seq")]
    pub items: Vec<Problem>,
}

/// A row: a file's header, or one of its problems.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Row {
    File(usize),
    Item(usize, usize),
}

/// The list's model: the files and their rows, flattened.
pub struct ProblemsList {
    scx: SurfaceCx,
    files: Vec<ProblemFile>,
    rows: Vec<Row>,
}

const LUA: &str = "config.app.pane";

impl ProblemsList {
    pub fn new(scx: SurfaceCx) -> Self {
        Self {
            scx,
            files: Vec::new(),
            rows: Vec::new(),
        }
    }

    pub fn files(&self) -> &[ProblemFile] {
        &self.files
    }

    /// The rows as drawn (tests): a file's `name dir n`, a problem's `message source(code) [Ln l, Col c]`.
    pub fn row_texts(&self) -> Vec<String> {
        (0..self.rows.len())
            .map(|i| self.text(i).to_string())
            .collect()
    }

    /// New problems from Lua; true when they differ.
    pub fn set(&mut self, files: Vec<ProblemFile>) -> bool {
        if files == self.files {
            return false;
        }
        self.rows = files
            .iter()
            .enumerate()
            .flat_map(|(f, file)| {
                std::iter::once(Row::File(f))
                    .chain((0..file.items.len()).map(move |i| Row::Item(f, i)))
            })
            .collect();
        self.files = files;
        true
    }

    /// Opens what row `ix` points at: a problem's spot, a file's first problem.
    pub fn open(&self, ix: usize) {
        let (f, i) = match self.rows.get(ix) {
            Some(Row::File(f)) => (*f, 0),
            Some(Row::Item(f, i)) => (*f, *i),
            None => return,
        };
        let Some(file) = self.files.get(f) else {
            return;
        };
        let (lnum, col) = file.items.get(i).map_or((1, 1), |p| (p.lnum, p.col));
        self.scx.navigate(
            LUA,
            "open_problem",
            vec![file.path.clone().into(), lnum.into(), col.into()],
        );
    }

    fn severity_icon(severity: &str) -> IconName {
        match severity {
            "error" => IconName::Error,
            "warning" => IconName::Warning,
            _ => IconName::Info,
        }
    }
}

fn place(p: &Problem) -> String {
    format!("[Ln {}, Col {}]", p.lnum, p.col)
}

fn origin(p: &Problem) -> String {
    match (p.source.is_empty(), p.code.is_empty()) {
        (true, true) => String::new(),
        (false, true) => p.source.clone(),
        (true, false) => format!("({})", p.code),
        (false, false) => format!("{}({})", p.source, p.code),
    }
}

impl ListSource for ProblemsList {
    fn len(&self) -> usize {
        self.rows.len()
    }

    fn text(&self, ix: usize) -> SharedString {
        match self.rows.get(ix) {
            Some(Row::File(f)) => self
                .files
                .get(*f)
                .map_or_else(SharedString::default, |file| {
                    let dir = if file.dir.is_empty() {
                        String::new()
                    } else {
                        format!(" {}", file.dir)
                    };
                    format!("{}{dir} {}", file.name, file.items.len()).into()
                }),
            Some(Row::Item(f, i)) => self
                .files
                .get(*f)
                .and_then(|file| file.items.get(*i))
                .map_or_else(SharedString::default, |p| {
                    let o = origin(p);
                    let sep = if o.is_empty() { "" } else { " " };
                    format!(
                        "{}{sep}{o} {}",
                        p.message.lines().next().unwrap_or(""),
                        place(p)
                    )
                    .into()
                }),
            None => SharedString::default(),
        }
    }
}

impl ListDelegate for ProblemsList {
    fn options(&self) -> ListOptions {
        ListOptions {
            search: SearchMode::Off,
            vim: Some(""),
            ..ListOptions::default()
        }
    }

    fn render_row(
        &mut self,
        ix: usize,
        _row: RowState<'_>,
        _window: &mut Window,
        cx: &mut Context<ListView<Self>>,
    ) -> AnyElement {
        let dim = |t: String| {
            div()
                .flex_none()
                .text_color(look::TEXT_DIM)
                .child(SharedString::from(t))
        };
        let row = div()
            .size_full()
            .flex()
            .items_center()
            .gap(px(look::TAB_ICON_GAP + 2.))
            .overflow_hidden()
            .whitespace_nowrap()
            // a click opens it (the press selected the row)
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |this, ev: &MouseUpEvent, _, _| {
                    if !(ev.modifiers.platform || ev.modifiers.shift) {
                        this.delegate.open(ix);
                    }
                }),
            );
        match self.rows.get(ix).copied() {
            Some(Row::File(f)) => {
                let Some(file) = self.files.get(f) else {
                    return row.into_any_element();
                };
                row.child(Icon::new(kit::for_file(&file.name)))
                    .child(
                        div()
                            .flex_none()
                            .child(SharedString::from(file.name.clone())),
                    )
                    .when(!file.dir.is_empty(), |d| d.child(dim(file.dir.clone())))
                    .child(
                        div()
                            .flex_none()
                            .px(px(6.))
                            .rounded(px(8.))
                            .bg(look::SEPARATOR)
                            .child(SharedString::from(file.items.len().to_string())),
                    )
                    .into_any_element()
            }
            Some(Row::Item(f, i)) => {
                let Some(p) = self.files.get(f).and_then(|file| file.items.get(i)) else {
                    return row.into_any_element();
                };
                let o = origin(p);
                row.pl(px(20.))
                    .child(Icon::new(Self::severity_icon(&p.severity)))
                    .child(
                        div()
                            .flex_shrink(1.)
                            .min_w_0()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(SharedString::from(
                                p.message.lines().next().unwrap_or("").to_owned(),
                            )),
                    )
                    .when(!o.is_empty(), |d| d.child(dim(o)))
                    .child(dim(place(p)))
                    .into_any_element()
            }
            None => row.into_any_element(),
        }
    }

    fn confirm(
        &mut self,
        ix: usize,
        _state: &crate::kit::ListState,
        _window: &mut Window,
        _cx: &mut Context<ListView<Self>>,
    ) {
        self.open(ix);
    }
}

/// VS Code's words for an empty Problems panel.
pub const NONE: &str = "No problems have been detected in the workspace.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_problems_text_is_its_message_source_code_and_place() {
        let p = Problem {
            lnum: 3,
            col: 7,
            severity: "error".into(),
            message: "Cannot find name 'x'.\nmore".into(),
            source: "ts".into(),
            code: "2304".into(),
        };
        assert_eq!(origin(&p), "ts(2304)");
        assert_eq!(place(&p), "[Ln 3, Col 7]");
        let bare = Problem {
            source: String::new(),
            code: String::new(),
            ..p
        };
        assert_eq!(origin(&bare), "");
    }
}
