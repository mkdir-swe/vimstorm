//! The `ui` kit on one screen (tree-like list, menu popup, search / text fields, speed search),
//! to compare with WebStorm. `cargo run --example kit_gallery` opens it; with `--features shots`
//! and a path argument it renders the window offscreen to that PNG and quits:
//! `cargo run --example kit_gallery --features shots -- /tmp/kit.png`
//!
//! `-- git [out.png]`: the M3 widgets instead (the Git tool window of WebStorm's 30.png rebuilt
//! from them: header tabs, Branches strip, search field, filter chips, toolbars, ref labels,
//! splitter, changes trees with checkboxes, commit message).

use std::time::Duration;

use gpui_kit::{
    AnyElement, App, AppContext as _, Bounds, Context, Entity, Focusable as _, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, Rgba, SharedString,
    Styled as _, TitlebarOptions, Window, WindowBounds, WindowOptions, div,
    prelude::FluentBuilder as _, px, size,
};
use vimstorm::kit;
use vimstorm::kit::TextField;
use vimstorm::kit::{Icon, IconName, for_file};
use vimstorm::kit::{ListDelegate, ListOptions, ListSource, ListView, RowState, match_text};
use vimstorm::look;
use vimstorm::render;

/// (depth, name, dir open?, kind) like the Project tool window in WebStorm's screenshot.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Root,
    Dir,
    Excluded,
    Library,
    File,
}

struct Row {
    depth: usize,
    name: &'static str,
    open: bool,
    kind: Kind,
    /// Git status color of the name, if any.
    color: Option<Rgba>,
}

const fn r(depth: usize, name: &'static str, open: bool, kind: Kind) -> Row {
    Row {
        depth,
        name,
        open,
        kind,
        color: None,
    }
}

fn tree_rows() -> Vec<Row> {
    use Kind::*;
    let mut rows = vec![
        r(0, "app-demo-checkout", true, Root),
        r(1, ".claude", false, Excluded),
        r(1, ".github", false, Dir),
        r(1, ".husky", false, Dir),
        r(1, ".idea", false, Dir),
        r(1, ".turbo", false, Excluded),
        r(1, ".vscode", false, Dir),
        r(1, "API-Collection", false, Dir),
        r(1, "assets", false, Dir),
        r(1, "backend", false, Dir),
        r(1, "docs", false, Dir),
        r(1, "frontend", false, Dir),
        r(1, "learning-records", false, Dir),
        r(1, "node_modules", false, Library),
        r(1, "packages", true, Dir),
        r(2, "config", true, Dir),
        r(3, "eslint", false, Dir),
        r(3, "node_modules", false, Library),
        r(3, "types", true, Dir),
        r(4, "eslint", true, Dir),
        r(5, "index.d.ts", false, File),
        r(4, "index.d.ts", false, File),
        r(3, "eslint.config.js", false, File),
        r(3, "package.json", false, File),
        r(3, "README.md", false, File),
        r(3, "App.tsx", false, File),
        r(3, "styles.scss", false, File),
        r(3, ".gitignore", false, File),
        r(3, "tsconfig.json", false, File),
    ];
    for row in &mut rows {
        row.color = match row.name {
            ".claude" | ".turbo" | "node_modules" => Some(look::GIT_IGNORED.rgba()),
            "assets" | "learning-records" => Some(look::GIT_UNTRACKED.rgba()),
            "README.md" => Some(look::GIT_MODIFIED.rgba()),
            "App.tsx" => Some(look::GIT_ADDED.rgba()),
            _ => None,
        };
    }
    rows
}

struct Tree(Vec<Row>);

impl ListSource for Tree {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn text(&self, ix: usize) -> SharedString {
        self.0[ix].name.into()
    }
}

impl ListDelegate for Tree {
    fn options(&self) -> ListOptions {
        ListOptions::tree()
    }

    fn row_background(&self, ix: usize) -> Option<Rgba> {
        matches!(self.0[ix].kind, Kind::Excluded | Kind::Library)
            .then_some(look::EXCLUDED_ROW_BG.rgba())
    }

    fn render_row(
        &mut self,
        ix: usize,
        row: RowState<'_>,
        _: &mut Window,
        _: &mut Context<ListView<Self>>,
    ) -> AnyElement {
        let it = &self.0[ix];
        let dir = it.kind != Kind::File;
        let chevron = if it.open {
            IconName::ChevronDown
        } else {
            IconName::ChevronRight
        };
        let icon = match it.kind {
            Kind::Root | Kind::Dir => IconName::Folder,
            Kind::Excluded | Kind::Library => IconName::FolderExcluded,
            Kind::File => for_file(it.name),
        };
        let suffix: Option<(SharedString, bool)> = match it.kind {
            Kind::Root => Some(("~/projects/app-demo-checkout".into(), false)),
            Kind::Library => Some(("library root".into(), false)),
            _ => None,
        };
        div()
            .flex()
            .items_center()
            // chevron at the tree's padding + one indent per level (WS ClassicPainter)
            .pl(px(look::TREE_PAD_X + it.depth as f32 * look::TREE_INDENT))
            .child(
                div()
                    .size(px(look::ICON_SIZE))
                    .flex_none()
                    .when(dir, |d| d.child(Icon::new(chevron))),
            )
            .child(
                div()
                    .w(px(look::TREE_CHEVRON_TO_RENDERER - look::TREE_CHEVRON_SIZE
                        + look::TREE_RENDERER_PAD_X))
                    .flex_none(),
            )
            .child(Icon::new(icon))
            .child(div().w(px(look::TREE_ICON_GAP)).flex_none())
            .child(
                div()
                    .text_color(it.color.unwrap_or(look::TEXT.rgba()))
                    .when(it.kind == Kind::Root, |d| {
                        d.font_weight(FontWeight::SEMIBOLD)
                    })
                    .child(match_text(it.name, row.matches)),
            )
            .when(it.kind == Kind::Root, |d| {
                d.child(
                    div()
                        .pl(px(4.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child("[demo-shop-github]"),
                )
            })
            .children(suffix.map(|(s, _)| div().pl(px(4.)).text_color(look::TEXT_DIM).child(s)))
            .into_any_element()
    }
}

/// Menu rows: (icon, label, shortcut); "-" is a separator.
struct Menu(Vec<(Option<IconName>, &'static str, &'static str)>);

impl ListSource for Menu {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn text(&self, ix: usize) -> SharedString {
        self.0[ix].1.into()
    }
    fn selectable(&self, ix: usize) -> bool {
        self.0[ix].1 != "-"
    }
}

impl ListDelegate for Menu {
    fn options(&self) -> ListOptions {
        ListOptions::menu()
    }

    fn render_row(
        &mut self,
        ix: usize,
        row: RowState<'_>,
        _: &mut Window,
        _: &mut Context<ListView<Self>>,
    ) -> AnyElement {
        let (icon, label, key) = self.0[ix];
        if label == "-" {
            return div()
                .w_full()
                .h(px(1.))
                .bg(look::SEPARATOR)
                .into_any_element();
        }
        div()
            .w_full()
            .flex()
            .items_center()
            .gap(px(look::TREE_ICON_GAP))
            .child(
                div()
                    .size(px(look::ICON_SIZE))
                    .flex_none()
                    .children(icon.map(Icon::new)),
            )
            .child(div().flex_1().child(match_text(label, row.matches)))
            .child(div().text_color(look::TEXT_DIM).child(key))
            .into_any_element()
    }
}

struct Gallery {
    tree: Entity<ListView<Tree>>,
    menu: Entity<ListView<Menu>>,
    search: Entity<ListView<Tree>>,
    field: Entity<TextField>,
    plain: Entity<TextField>,
}

impl Gallery {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let tree = cx.new(|cx| {
            let mut l = ListView::new(Tree(tree_rows()), cx);
            l.state.set_cursor(Some(8));
            l
        });
        let menu = cx.new(|cx| {
            let mut l = ListView::new(
                Menu(vec![
                    (Some(IconName::Copy), "Copy", "⌘C"),
                    (None, "Copy Path/Reference…", "⇧⌘C"),
                    (None, "Paste", "⌘V"),
                    (None, "-", ""),
                    (Some(IconName::Locate), "Select in Project View", "⌥F1"),
                    (Some(IconName::History), "Show History", ""),
                    (Some(IconName::Commit), "Commit…", "⌘K"),
                    (None, "-", ""),
                    (Some(IconName::ExpandAll), "Expand All", "⌘+"),
                    (Some(IconName::CollapseAll), "Collapse All", "⌘-"),
                ]),
                cx,
            );
            l.state.set_cursor(Some(4));
            l
        });
        let search = cx.new(|cx| {
            let mut l = ListView::new(Tree(tree_rows()), cx);
            let q = Some("conf".to_string());
            l.state.set_query(q, &l.delegate);
            l
        });
        let field = cx.new(|cx| {
            let mut f = TextField::new(cx).search().placeholder("Search");
            f.set_text("report.get", cx);
            f
        });
        let plain = cx.new(|cx| TextField::new(cx).placeholder("New branch name"));
        // the tree has focus (focused selection); the rest show their unfocused look
        window.focus(&tree.read(cx).focus_handle(cx), cx);
        Self {
            tree,
            menu,
            search,
            field,
            plain,
        }
    }
}

fn island() -> gpui_kit::Div {
    div()
        .bg(look::PANEL_BG)
        .rounded(px(look::ISLAND_ARC.get()))
        .overflow_hidden()
}

impl Render for Gallery {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let label = |s: &'static str| {
            div()
                .text_color(look::TEXT_DIM)
                .text_size(px(look::UI_SMALL_FONT_SIZE))
                .child(s)
        };
        div()
            .id("gallery")
            .size_full()
            .bg(look::FRAME_BG)
            .p(px(look::ISLAND_GAP.get()))
            .gap(px(look::ISLAND_GAP.get()))
            .flex()
            .font_family(render::UI_FONT)
            .text_size(px(look::UI_FONT_SIZE))
            .text_color(look::TEXT)
            .child(
                island()
                    .w(px(460.))
                    .h_full()
                    .pt(px(look::TREE_PAD_Y + look::ISLAND_CONTENT_INSET))
                    .pl(px(look::ISLAND_CONTENT_INSET.get()))
                    .child(self.tree.clone()),
            )
            .child(
                island()
                    .flex_1()
                    .h_full()
                    .p(px(16.))
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(label("Search field / text field"))
                    .child(div().w(px(320.)).child(self.field.clone()))
                    .child(div().w(px(320.)).child(self.plain.clone()))
                    .child(label("Popup menu (header, separator, ad text)"))
                    .child(
                        kit::popup_frame()
                            .w(px(320.))
                            .child(kit::header("Project", None))
                            .child(
                                div()
                                    .h(px(10. * look::LIST_ROW_HEIGHT + 2. * look::POPUP_PADDING_Y))
                                    .py(px(look::POPUP_PADDING_Y))
                                    .child(self.menu.clone()),
                            )
                            .child(kit::ad_text("Press ⌥⏎ to show actions")),
                    )
                    .child(label("Speed search after / (filter, matches highlighted)"))
                    .child(
                        div()
                            .w(px(360.))
                            .h(px(5. * look::TREE_ROW_HEIGHT))
                            .child(self.search.clone()),
                    ),
            )
    }
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let git_page = args.first().is_some_and(|a| a == "git");
    if git_page {
        args.remove(0);
    }
    let shot = args.first().cloned();
    gpui_kit::application().run(move |cx: &mut App| {
        if let Err(e) = render::load_fonts(cx) {
            eprintln!("fonts: {e:#}");
        }
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(px(1100.), px(860.)),
                cx,
            ))),
            titlebar: Some(TitlebarOptions {
                title: Some("VimStorm kit".into()),
                ..Default::default()
            }),
            focus: true,
            ..Default::default()
        };
        let options = if git_page {
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(git_page::WIDTH), px(git_page::HEIGHT)),
                    cx,
                ))),
                ..options
            }
        } else {
            options
        };
        let window = cx
            .open_window(options, |window, cx| {
                cx.new(|cx| {
                    Root(if git_page {
                        cx.new(|cx| git_page::GitPage::new(window, cx)).into()
                    } else {
                        cx.new(|cx| Gallery::new(window, cx)).into()
                    })
                })
            })
            .expect("window");
        cx.activate(true);
        let Some(path) = shot else { return };
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_millis(800))
                .await;
            // draw a few frames first: widgets that measure themselves (splitter, tabs) lay out
            // again once they know their size; an offscreen window gets no frames by itself
            for _ in 0..3 {
                let _ = cx.update_window(window.into(), |_, window, cx| {
                    window.draw(cx).clear(cx);
                });
            }
            let _ = window.update(cx, |_, window, cx| {
                save(window, &path);
                cx.quit();
            });
        })
        .detach();
    });
}

/// The page shown (M2 gallery or the git page).
struct Root(gpui_kit::AnyView);

impl Render for Root {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.0.clone()
    }
}

#[cfg(feature = "shots")]
fn save(window: &mut Window, path: &str) {
    match window.render_to_image() {
        Ok(img) => match img.save(path) {
            Ok(()) => eprintln!("saved {path}"),
            Err(e) => eprintln!("saving {path}: {e}"),
        },
        Err(e) => eprintln!("render_to_image: {e:#}"),
    }
}

#[cfg(not(feature = "shots"))]
fn save(_: &mut Window, path: &str) {
    eprintln!("{path}: build with --features shots for screenshots");
}

/// The M3 page: 30.png's Git tool window rebuilt from the kit, then the other widgets.
mod git_page {
    use gpui_kit::{
        AnyElement, AppContext as _, Context, Entity, Focusable as _, FontWeight, IntoElement,
        ParentElement as _, Render, SharedString, Styled as _, Window, div,
        prelude::FluentBuilder as _, px,
    };
    use vimstorm::kit::FilterChip;
    use vimstorm::kit::IconName;
    use vimstorm::kit::ListView;
    use vimstorm::kit::SearchField;
    use vimstorm::kit::{Axis, IconButton, TextButton, toolbar, toolbar_separator};
    use vimstorm::kit::{ChangeFile, ChangeGroup, ChangeStatus, ChangesTree};
    use vimstorm::kit::{CheckState, Checkbox, check_box, checkbox_icon};
    use vimstorm::kit::{CollapsedStripe, VerticalLabel};
    use vimstorm::kit::{Fixed, SplitAxis, SplitState, split};
    use vimstorm::kit::{RefKind, RefLabel};
    use vimstorm::kit::{TextArea, TextAreaStyle};
    use vimstorm::kit::{ToolTab, ToolTabs};
    use vimstorm::look;
    use vimstorm::render;

    /// 30.png is 2000 px wide at 1.4405 px per logical px.
    pub const WIDTH: f32 = 1388.0;
    pub const HEIGHT: f32 = 900.0;
    /// The Git tool window's visible height in 30.png ((1557 - 1075) / 1.4405).
    const GIT_HEIGHT: f32 = 335.0;

    pub struct GitPage {
        log_tabs: Entity<ToolTabs>,
        search: Entity<SearchField>,
        split: Entity<SplitState>,
        details: Entity<ListView<ChangesTree>>,
        changes_tabs: Entity<ToolTabs>,
        changes: Entity<ListView<ChangesTree>>,
        message: Entity<TextArea>,
        stash: Entity<ListView<ChangesTree>>,
        focused_search: Entity<SearchField>,
    }

    fn tree(
        groups: Vec<ChangeGroup>,
        boxes: bool,
        cx: &mut Context<GitPage>,
    ) -> Entity<ListView<ChangesTree>> {
        cx.new(|cx| {
            let mut d = ChangesTree::new();
            if boxes {
                d = d.with_checkboxes();
            }
            let mut v = ListView::new(d, cx);
            let ListView {
                delegate, state, ..
            } = &mut v;
            delegate.set_groups(groups, state);
            v
        })
    }

    impl GitPage {
        pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
            use ChangeStatus::*;
            let log_tabs = cx.new(|cx| {
                let mut t = ToolTabs::new(
                    "Git",
                    vec![
                        ToolTab::new("Local Changes"),
                        ToolTab::new("Stash"),
                        ToolTab::new("Log"),
                        ToolTab::new("Log: HEAD").closable(true),
                        ToolTab::new("Log").closable(true),
                        ToolTab::new("Log: HEAD").closable(true),
                        ToolTab::new("Log: HEAD").closable(true),
                    ],
                );
                t.select(3, cx);
                t
            });
            let search = cx.new(|cx| SearchField::new("Text or hash", cx).with_history());
            let split = cx.new(|_| SplitState::new(SplitAxis::Horizontal, Fixed::Second, px(122.)));
            let details = tree(
                vec![ChangeGroup::plain(vec![
                    ChangeFile::new("infra/src/lambdas/partner.ts", Modified),
                    ChangeFile::new("infra/src/lambdas/query.ts", Modified),
                ])],
                false,
                cx,
            );
            let changes_tabs = cx.new(|cx| {
                let mut t = ToolTabs::new(
                    "Git",
                    vec![
                        ToolTab::new("Local Changes"),
                        ToolTab::new("Stash"),
                        ToolTab::new("Log: HEAD"),
                    ],
                );
                t.set_active(true, cx);
                t
            });
            let changes = tree(
                vec![
                    ChangeGroup::changelist(
                        "changes",
                        "Changes",
                        vec![
                            ChangeFile::new("src/services/api/client.ts", Modified),
                            ChangeFile::new("src/services/api/auth.ts", Added),
                            ChangeFile::new("src/services/old.ts", Deleted),
                            ChangeFile::new("src/views/Overview.tsx", Renamed)
                                .renamed_from("src/views/Summary.tsx"),
                            ChangeFile::new("README.md", Modified),
                        ],
                    ),
                    ChangeGroup::conflicts(vec![ChangeFile::new("package.json", Conflict)]),
                    ChangeGroup::unversioned(vec![ChangeFile::new("notes.txt", Unversioned)]),
                ],
                true,
                cx,
            );
            changes.update(cx, |v, _| {
                let files = v.delegate.rows()[2].files.clone();
                v.delegate.toggle_included(&files);
                v.state.set_cursor(Some(4));
            });
            let message = cx.new(|cx| {
                TextArea::new(cx)
                    .style(TextAreaStyle::commit_message())
                    .placeholder("Commit Message")
            });
            let stash = tree(
                vec![ChangeGroup::plain(vec![
                    ChangeFile::new("app/src/ui/theme.rs", Modified),
                    ChangeFile::new("app/src/ui/button.rs", Added),
                    ChangeFile::new("nvim/lua/git/init.lua", Modified),
                ])],
                false,
                cx,
            );
            let focused_search = cx.new(|cx| {
                let mut s = SearchField::new("Text or hash", cx);
                s.set_text("AB#1118", cx);
                s.set_regex(true, cx);
                s
            });
            // the Local Changes tree has the keyboard (blue selection)
            let h = changes.read(cx).focus_handle(cx);
            window.focus(&h, cx);
            Self {
                log_tabs,
                search,
                split,
                details,
                changes_tabs,
                changes,
                message,
                stash,
                focused_search,
            }
        }
    }

    /// Subject, refs, author, bold (own commit), date.
    type Commit = (
        &'static str,
        &'static [(&'static str, RefKind)],
        &'static str,
        bool,
        &'static str,
    );

    /// 30.png's commits.
    const COMMITS: &[Commit] = &[
        (
            "AB#1101 Kept 10GB on the report query lambda.",
            &[
                ("origin/HEAD", RefKind::Other),
                ("origin/master", RefKind::RemoteBranch),
                ("master", RefKind::LocalBranch),
                ("HEAD", RefKind::Head),
            ],
            "Ada Example*",
            true,
            "Yesterday 11:46",
        ),
        (
            "AB#1101 Lowered memory on the export lambdas.",
            &[],
            "Ada Example*",
            true,
            "Yesterday 11:44",
        ),
        (
            "AB#1101 Raised 256MB lambdas to 512MB and trimmed over-provisioned ones.",
            &[],
            "Ada Example*",
            true,
            "Yesterday 11:41",
        ),
        (
            "AB#1102: Fix height of card to fit translation",
            &[("v1.4.0", RefKind::Tag)],
            "Robin Sample*",
            false,
            "Yesterday 14:09",
        ),
        (
            "AB#1102: Add missing overview translations",
            &[],
            "Robin Sample*",
            false,
            "Yesterday 14:06",
        ),
        (
            "AB#1103 fixed some things from the pr comments.",
            &[
                ("origin/copilot/check-ts-files-count", RefKind::RemoteBranch),
                ("copilot/check-ts-files-count", RefKind::LocalBranch),
            ],
            "Sam Sample*",
            false,
            "Yesterday 09:54",
        ),
        (
            "AB#1103 Added order routing for two regions",
            &[],
            "Sam Sample*",
            false,
            "2026-10-15, 11:56",
        ),
        (
            "AB#1104: Fixed error message when creating view",
            &[("v1.3.9", RefKind::Tag)],
            "Kim Example",
            false,
            "Yesterday 10:22",
        ),
    ];

    fn log_row(i: usize) -> AnyElement {
        let (subject, refs, author, me, date) = COMMITS[i];
        let lane = look::hex(0xC09853);
        div()
            .h(px(look::VCS_LOG_ROW_HEIGHT.get()))
            .flex()
            .items_center()
            .relative()
            // stand-in for LOG's graph: one lane, a dot per commit
            .child(
                div()
                    .absolute()
                    .left(px(19.25))
                    .top_0()
                    .bottom_0()
                    .w(px(1.5))
                    .bg(lane),
            )
            .child(
                div()
                    .absolute()
                    .left(px(16.))
                    .top(px(look::VCS_LOG_ROW_HEIGHT / 2. - 4.))
                    .size(px(8.))
                    .rounded_full()
                    .bg(lane),
            )
            .child(
                div()
                    .pl(px(86. - look::STRIPE_WIDTH - 1.))
                    .pr(px(8.))
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_color(look::VCS_LOG_SUBJECT_FG)
                    .child(subject),
            )
            .child(div().flex_none().pr(px(look::VCS_REF_GAP_AFTER)).children(
                (!refs.is_empty()).then(|| {
                    RefLabel::new(
                        refs.iter()
                            .map(|(n, k)| (SharedString::from(*n), *k))
                            .collect(),
                    )
                }),
            ))
            .child(
                div()
                    .flex_none()
                    .w(px(1128. - 923.))
                    .text_color(look::VCS_LOG_AUTHOR_FG)
                    .when(me, |d| d.font_weight(FontWeight::BOLD))
                    .child(author),
            )
            .child(
                div()
                    .flex_none()
                    .w(px(1264. - 1128.))
                    .text_color(look::VCS_LOG_DATE_FG)
                    .child(date),
            )
            .into_any_element()
    }

    fn island() -> gpui_kit::Div {
        div()
            .bg(look::PANEL_BG)
            .rounded(px(look::ISLAND_ARC.get()))
            .overflow_hidden()
            .flex()
            .flex_col()
    }

    fn line() -> gpui_kit::Div {
        div().flex_none().h(px(1.)).w_full().bg(look::SPLITTER_LINE)
    }

    fn caption(s: &'static str) -> gpui_kit::Div {
        div()
            .text_color(look::TEXT_DIM)
            .text_size(px(look::UI_SMALL_FONT_SIZE))
            .child(s)
    }

    impl Render for GitPage {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let filter_row = div()
                .flex_none()
                .h(px(look::VCS_LOG_FILTER_ROW_HEIGHT))
                .flex()
                .items_center()
                .pl(px(4.))
                .gap(px(look::FILTER_CHIP_GAP))
                .child(div().w(px(219.)).flex_none().child(self.search.clone()))
                .child(
                    FilterChip::new("branch", "Branch")
                        .value(Some("HEAD"))
                        .on_clear(|_, _| {}),
                )
                .child(FilterChip::new("user", "User").value(None::<&str>))
                .child(FilterChip::new("date", "Date").value(None::<&str>))
                .child(FilterChip::new("paths", "Paths").value(None::<&str>))
                .child(IconButton::new("sort", IconName::IntelliSort).dropdown(true))
                .child(div().flex_1())
                .child(
                    toolbar(Axis::Horizontal)
                        .pr(px(look::ACTION_TOOLBAR_PAD_X + 2.))
                        .child(IconButton::new("resume", IconName::ResumeIndexing))
                        .child(
                            IconButton::new("refresh", IconName::Refresh)
                                .tooltip("Refresh", Some("⌘R")),
                        )
                        .child(IconButton::new("pick", IconName::CherryPick).disabled(true))
                        .child(IconButton::new("view", IconName::Show).dropdown(true))
                        .child(IconButton::new("goto", IconName::Search)),
                );
            let log = div()
                .size_full()
                .flex()
                .flex_col()
                .child(filter_row)
                .children((0..COMMITS.len()).map(log_row));
            let details = div()
                .size_full()
                .flex()
                .flex_col()
                .child(
                    div()
                        .flex_none()
                        .h(px(look::VCS_LOG_FILTER_ROW_HEIGHT))
                        .flex()
                        .items_center()
                        .pl(px(8.))
                        .child(
                            toolbar(Axis::Horizontal)
                                .child(IconButton::new("diff", IconName::Diff))
                                .child(IconButton::new("revert", IconName::Revert))
                                .child(IconButton::new("dview", IconName::Show).dropdown(true))
                                .child(IconButton::new("hist", IconName::History)),
                        ),
                )
                .child(div().flex_1().child(self.details.clone()));
            let git = island()
                .h(px(GIT_HEIGHT))
                .w_full()
                .child(self.log_tabs.clone())
                .child(
                    div()
                        .flex_1()
                        .flex()
                        .child(CollapsedStripe::new("branches", VerticalLabel::Branches))
                        .child(div().flex_1().h_full().child(split(
                            "log-split",
                            &self.split,
                            log,
                            details,
                            cx,
                        ))),
                );

            // ---- the other widgets
            let local_changes = island()
                .w(px(520.))
                .h_full()
                .child(self.changes_tabs.clone())
                .child(
                    div()
                        .flex_none()
                        .h(px(look::VCS_LOG_FILTER_ROW_HEIGHT))
                        .flex()
                        .items_center()
                        .px(px(8.))
                        .child(
                            toolbar(Axis::Horizontal)
                                .child(IconButton::new("lc-refresh", IconName::Refresh))
                                .child(IconButton::new("lc-rollback", IconName::Revert))
                                .child(IconButton::new("lc-diff", IconName::Diff))
                                .child(IconButton::new("lc-shelve", IconName::Shelve))
                                .child(toolbar_separator(Axis::Horizontal))
                                .child(
                                    IconButton::new("lc-group", IconName::GroupByDirectory)
                                        .toggled(true),
                                )
                                .child(IconButton::new("lc-view", IconName::Show).dropdown(true))
                                .child(IconButton::new("lc-expand", IconName::ExpandAll))
                                .child(IconButton::new("lc-collapse", IconName::CollapseAll)),
                        ),
                )
                .child(
                    div()
                        .h(px(9. * look::TREE_ROW_HEIGHT))
                        .child(self.changes.clone()),
                )
                .child(line())
                .child(div().h(px(110.)).p(px(8.)).child(self.message.clone()))
                .child(
                    div()
                        .px(px(8.))
                        .pb(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(12.))
                        .child(TextButton::new("commit", "Commit").primary(true))
                        .child(TextButton::new("commit-push", "Commit and Push…"))
                        .child(Checkbox::new("amend", CheckState::Unchecked).label("Amend")),
                );
            let stash = island()
                .w(px(300.))
                .h_full()
                .pt(px(8.))
                .child(
                    div()
                        .px(px(12.))
                        .pb(px(4.))
                        .child(caption("Stash changes (no checkboxes)")),
                )
                .child(div().flex_1().child(self.stash.clone()));
            let states = island()
                .flex_1()
                .h_full()
                .p(px(12.))
                .gap(px(10.))
                .child(caption(
                    "Action buttons: plain / toggled / disabled / popup; vertical toolbar",
                ))
                .child(
                    div()
                        .flex()
                        .gap(px(16.))
                        .child(
                            toolbar(Axis::Horizontal)
                                .child(IconButton::new("s-fetch", IconName::Fetch))
                                .child(IconButton::new("s-pull", IconName::Update))
                                .child(IconButton::new("s-push", IconName::Push))
                                .child(IconButton::new("s-commit", IconName::Commit))
                                .child(toolbar_separator(Axis::Horizontal))
                                .child(
                                    IconButton::new("s-lock", IconName::SynchronizeScrolling)
                                        .toggled(true),
                                )
                                .child(
                                    IconButton::new("s-pick", IconName::CherryPick).disabled(true),
                                )
                                .child(
                                    IconButton::new("s-gear", IconName::Settings).dropdown(true),
                                ),
                        )
                        .child(
                            toolbar(Axis::Vertical)
                                .child(IconButton::new("v-prev", IconName::PreviousDifference))
                                .child(IconButton::new("v-next", IconName::NextDifference))
                                .child(toolbar_separator(Axis::Vertical))
                                .child(IconButton::new("v-magic", IconName::MagicResolve)),
                        ),
                )
                .child(caption(
                    "Search field (focused look: see Local Changes / typed, regex on)",
                ))
                .child(div().w(px(300.)).child(self.focused_search.clone()))
                .child(caption("Filter chips: value + ×, open (pressed), empty"))
                .child(
                    div()
                        .flex()
                        .gap(px(look::FILTER_CHIP_GAP))
                        .child(
                            FilterChip::new("c1", "Branch")
                                .value(Some("main"))
                                .on_clear(|_, _| {}),
                        )
                        .child(
                            FilterChip::new("c2", "User")
                                .value(Some("me"))
                                .open(true)
                                .on_clear(|_, _| {}),
                        )
                        .child(FilterChip::new("c3", "Date").value(None::<&str>)),
                )
                .child(caption("Checkboxes: off / on / some / disabled"))
                .child(
                    div()
                        .flex()
                        .gap(px(12.))
                        .child(check_box(checkbox_icon(CheckState::Unchecked, false)))
                        .child(check_box(checkbox_icon(CheckState::Checked, false)))
                        .child(check_box(checkbox_icon(CheckState::Mixed, false)))
                        .child(
                            Checkbox::new("dis", CheckState::Checked)
                                .disabled(true)
                                .label("Disabled"),
                        ),
                )
                .child(caption("Ref labels: HEAD / local / remote / tag / several"))
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .child(RefLabel::new(vec![("HEAD".into(), RefKind::Head)]))
                        .child(RefLabel::new(vec![("main".into(), RefKind::LocalBranch)]))
                        .child(RefLabel::new(vec![(
                            "origin/main".into(),
                            RefKind::RemoteBranch,
                        )]))
                        .child(RefLabel::new(vec![("v2.0".into(), RefKind::Tag)]))
                        .child(RefLabel::new(vec![
                            ("origin/feature/x".into(), RefKind::RemoteBranch),
                            ("feature/x".into(), RefKind::LocalBranch),
                            ("v2.1".into(), RefKind::Tag),
                        ])),
                );
            div()
                .size_full()
                .bg(look::FRAME_BG)
                .flex()
                .flex_col()
                .gap(px(look::ISLAND_GAP.get()))
                .font_family(render::UI_FONT)
                .text_size(px(look::UI_FONT_SIZE))
                .text_color(look::TEXT)
                .child(git)
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .flex()
                        .gap(px(look::ISLAND_GAP.get()))
                        .child(local_changes)
                        .child(stash)
                        .child(states),
                )
        }
    }
}
