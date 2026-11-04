//! The bundled New UI ("expui") icons (`assets/icons/`, dark and light variants) and the file -> icon
//! mapping.
//!
//! Mirrors `nvim/lua/config/icons.lua` (the mini.icons setup the terminal UI uses), so the GPUI app
//! and the nvim lists show the same icon for a file. Every SVG is an IntelliJ Platform icon from intellij-community
//! or VimStorm's own; sources and licenses are in `assets/icons/NOTICE`. The set is the kit's
//! gallery: some icons have no surface using them yet (kept, checked by the `ALL` test).
//!
//! Matching follows mini.icons, which config/icons.lua feeds:
//! * exact file names first, case-sensitive (`README.md` matches, `readme.md` does not);
//! * then the widest extension after a dot that is not the name's first character, case-insensitive
//!   (`foo.d.ts` tries `d.ts`, then `ts`; `foo.test.ts` falls to `ts`; `X.PNG` is an image; a dotfile
//!   like `.bashrc` has no extension); WebStorm matches extensions case-insensitively too;
//! * anything else is plain text ([`IconName::Text`]). mini.icons' last resort (`vim.filetype.match`)
//!   is not replicated, so names nvim only knows by filetype detection (`.bashrc` -> bash -> Shell
//!   there) are Text here.
//!
//! Only uses std.

/// Declares the icons once: the enum, [`IconName::ALL`], the embedded SVGs and their asset paths.
/// An entry is `Name => "dark.svg" | "light.svg",`, or `Name => "both.svg",` for an icon JetBrains
/// ships one SVG for in both themes.
macro_rules! icons {
    ($( $(#[$doc:meta])* $name:ident => $path:literal $(| $light:literal)?, )*) => {
        /// Every bundled icon.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum IconName {
            $( $(#[$doc])* $name, )*
        }

        impl IconName {
            /// Every icon, in declaration order.
            pub const ALL: &'static [IconName] = &[$(IconName::$name,)*];

            /// The SVG a dark (`true`) or light theme shows, embedded.
            pub fn svg_in(self, dark: bool) -> &'static [u8] {
                match self {
                    $(IconName::$name => icons!(@pick dark, $path $(, $light)?),)*
                }
            }

            /// Asset path of the dark SVG, e.g. "icons/fileTypes/typeScript_dark.svg".
            pub fn path(self) -> &'static str {
                self.path_in(true)
            }

            /// Asset path of the SVG a dark (`true`) or light theme shows.
            pub fn path_in(self, dark: bool) -> &'static str {
                match self {
                    $(IconName::$name => icons!(@path dark, $path $(, $light)?),)*
                }
            }
        }
    };
    (@pick $dark:ident, $path:literal) => {
        include_bytes!(concat!("../../../assets/icons/", $path))
    };
    (@pick $dark:ident, $path:literal, $light:literal) => {
        if $dark {
            include_bytes!(concat!("../../../assets/icons/", $path))
        } else {
            include_bytes!(concat!("../../../assets/icons/", $light))
        }
    };
    (@path $dark:ident, $path:literal) => {
        concat!("icons/", $path)
    };
    (@path $dark:ident, $path:literal, $light:literal) => {
        if $dark { concat!("icons/", $path) } else { concat!("icons/", $light) }
    };
}

icons! {
    /// Plain folder (nodes/folder).
    Folder => "nodes/folder_dark.svg" | "nodes/folder.svg",
    /// Excluded folder (nodes/excludeRoot); WebStorm also draws node_modules (excluded + "library root") with it.
    FolderExcluded => "nodes/excludeRoot_dark.svg" | "nodes/excludeRoot.svg",
    /// Library folder (nodes/libraryFolder, old ppLibFolder).
    FolderLibraryRoot => "nodes/libraryFolder_dark.svg" | "nodes/libraryFolder.svg",
    /// Library (nodes/library, old ppLib).
    Library => "nodes/library_dark.svg" | "nodes/library.svg",
    /// Module / content root folder (nodes/module).
    FolderModule => "nodes/module_dark.svg" | "nodes/module.svg",
    /// Module group (nodes/moduleGroup).
    FolderModuleGroup => "nodes/moduleGroup_dark.svg" | "nodes/moduleGroup.svg",
    /// Sources root (nodes/sourceRoot).
    FolderSourceRoot => "nodes/sourceRoot_dark.svg" | "nodes/sourceRoot.svg",
    /// Test sources root (nodes/testRoot).
    FolderTestRoot => "nodes/testRoot_dark.svg" | "nodes/testRoot.svg",
    /// Resources root (nodes/resourcesRoot).
    FolderResourcesRoot => "nodes/resourcesRoot_dark.svg" | "nodes/resourcesRoot.svg",
    /// Test resources root (nodes/testResourcesRoot).
    FolderTestResourcesRoot => "nodes/testResourcesRoot_dark.svg" | "nodes/testResourcesRoot.svg",
    /// Symlink arrow overlay (nodes/symlink), drawn over Folder or a file icon.
    SymlinkOverlay => "nodes/symlink_dark.svg" | "nodes/symlink.svg",
    /// Generic file (fileTypes/anyType).
    AnyType => "fileTypes/anyType_dark.svg" | "fileTypes/anyType.svg",
    /// Plain text (fileTypes/text); the default.
    Text => "fileTypes/text_dark.svg" | "fileTypes/text.svg",
    /// TypeScript (javascript-plugin fileTypes/typeScript).
    TypeScript => "fileTypes/typeScript_dark.svg" | "fileTypes/typeScript.svg",
    /// TypeScript JSX (VimStorm's own: </> on TypeScript blue).
    Tsx => "fileTypes/tsx_dark.svg" | "fileTypes/tsx.svg",
    /// JavaScript (fileTypes/javaScript).
    JavaScript => "fileTypes/javaScript_dark.svg" | "fileTypes/javaScript.svg",
    /// JavaScript JSX (VimStorm's own: </> on JavaScript yellow).
    Jsx => "fileTypes/jsx_dark.svg" | "fileTypes/jsx.svg",
    /// JSON (fileTypes/json).
    Json => "fileTypes/json_dark.svg" | "fileTypes/json.svg",
    /// Markdown (markdown plugin expui/markdown).
    Markdown => "fileTypes/markdown_dark.svg" | "fileTypes/markdown.svg",
    /// CSS (fileTypes/css).
    Css => "fileTypes/css_dark.svg" | "fileTypes/css.svg",
    /// Less (VimStorm's own: curly braces).
    Less => "fileTypes/less_dark.svg" | "fileTypes/less.svg",
    /// Sass and SCSS (VimStorm's own: an S on a pink disc; one SVG for both themes).
    Sass => "fileTypes/sass.svg",
    /// HTML (fileTypes/html).
    Html => "fileTypes/html_dark.svg" | "fileTypes/html.svg",
    /// XHTML (fileTypes/xhtml).
    Xhtml => "fileTypes/xhtml_dark.svg" | "fileTypes/xhtml.svg",
    /// XML (fileTypes/xml).
    Xml => "fileTypes/xml_dark.svg" | "fileTypes/xml.svg",
    /// YAML (fileTypes/yaml).
    Yaml => "fileTypes/yaml_dark.svg" | "fileTypes/yaml.svg",
    /// Image (fileTypes/image).
    Image => "fileTypes/image_dark.svg" | "fileTypes/image.svg",
    /// Font (fileTypes/font).
    Font => "fileTypes/font_dark.svg" | "fileTypes/font.svg",
    /// Ignore files (fileTypes/ignored).
    Ignored => "fileTypes/ignored_dark.svg" | "fileTypes/ignored.svg",
    /// Shell script (fileTypes/shell).
    Shell => "fileTypes/shell_dark.svg" | "fileTypes/shell.svg",
    /// SQL (Database Tools expui/sql).
    Sql => "fileTypes/sql_dark.svg" | "fileTypes/sql.svg",
    /// Archive (fileTypes/archive).
    Archive => "fileTypes/archive_dark.svg" | "fileTypes/archive.svg",
    /// .editorconfig (fileTypes/editorConfig).
    EditorConfig => "fileTypes/editorConfig_dark.svg" | "fileTypes/editorConfig.svg",
    /// Source map (fileTypes/sourceMap).
    SourceMap => "fileTypes/sourceMap_dark.svg" | "fileTypes/sourceMap.svg",
    /// ESLint config (VimStorm's own: a hexagon).
    Eslint => "fileTypes/eslint_dark.svg" | "fileTypes/eslint.svg",
    /// Prettier config (VimStorm's own: indented bars).
    Prettier => "fileTypes/prettier_dark.svg" | "fileTypes/prettier.svg",
    /// Chevron right; New UI tree collapsed icon (Tree.collapsedIcon), submenu arrow.
    ChevronRight => "general/chevronRight_dark.svg" | "general/chevronRight.svg",
    /// Chevron down; New UI tree expanded icon (Tree.expandedIcon), widget / combo arrow.
    ChevronDown => "general/chevronDown_dark.svg" | "general/chevronDown.svg",
    /// Chevron up (find: previous match).
    ChevronUp => "general/chevronUp_dark.svg" | "general/chevronUp.svg",
    /// Chevron left.
    ChevronLeft => "general/chevronLeft_dark.svg" | "general/chevronLeft.svg",
    /// Large chevron down (main toolbar widgets: project, branch).
    ChevronDownLarge => "general/chevronDownLarge_dark.svg" | "general/chevronDownLarge.svg",
    /// Large chevron up.
    ChevronUpLarge => "general/chevronUpLarge_dark.svg" | "general/chevronUpLarge.svg",
    /// Close (dialogs, notifications, popups).
    Close => "general/close_dark.svg" | "general/close.svg",
    /// Small close (editor tab x).
    CloseSmall => "general/closeSmall_dark.svg" | "general/closeSmall.svg",
    /// Small close, hovered (editor tab x on hover).
    CloseSmallHovered => "general/closeSmallHovered_dark.svg" | "general/closeSmallHovered.svg",
    /// Search / find (general/search, also actions/find).
    Search => "general/search_dark.svg" | "general/search.svg",
    /// VCS branch (general/vcs, New UI for vcs/branch).
    Branch => "general/vcs_dark.svg" | "general/vcs.svg",
    /// Add.
    Add => "general/add_dark.svg" | "general/add.svg",
    /// Settings gear.
    Settings => "general/settings_dark.svg" | "general/settings.svg",
    /// More (vertical dots).
    MoreVertical => "general/moreVertical_dark.svg" | "general/moreVertical.svg",
    /// More (horizontal dots).
    MoreHorizontal => "general/moreHorizontal_dark.svg" | "general/moreHorizontal.svg",
    /// Refresh.
    Refresh => "general/refresh_dark.svg" | "general/refresh.svg",
    /// Filter.
    Filter => "general/filter_dark.svg" | "general/filter.svg",
    /// Locate (select opened file).
    Locate => "general/locate_dark.svg" | "general/locate.svg",
    /// Collapse all.
    CollapseAll => "general/collapseAll_dark.svg" | "general/collapseAll.svg",
    /// Expand all.
    ExpandAll => "general/expandAll_dark.svg" | "general/expandAll.svg",
    /// Show / view options (eye).
    Show => "general/show_dark.svg" | "general/show.svg",
    /// Hide tool window.
    Hide => "general/hide_dark.svg" | "general/hide.svg",
    /// Maximize the tool window over the middle, again restore (VimStorm's own drawing: two arrows
    /// apart, in the New UI's stroke colors).
    Maximize => "general/maximize_dark.svg" | "general/maximize.svg",
    /// Copy.
    Copy => "general/copy_dark.svg" | "general/copy.svg",
    /// Edit.
    Edit => "general/edit_dark.svg" | "general/edit.svg",
    /// Delete.
    Delete => "general/delete_dark.svg" | "general/delete.svg",
    /// History.
    History => "general/history_dark.svg" | "general/history.svg",
    /// Pin (pinned tab).
    Pin => "general/pin_dark.svg" | "general/pin.svg",
    /// Help.
    Help => "general/help_dark.svg" | "general/help.svg",
    /// External link arrow.
    ExternalLink => "ide/externalLink_dark.svg" | "ide/externalLink.svg",
    /// Checkmark (selected item in menus and popups).
    Checked => "actions/checked_dark.svg" | "actions/checked.svg",
    /// Find backward.
    FindBackward => "actions/findBackward_dark.svg" | "actions/findBackward.svg",
    /// Find forward.
    FindForward => "actions/findForward_dark.svg" | "actions/findForward.svg",
    /// Replace.
    Replace => "actions/replace_dark.svg" | "actions/replace.svg",
    /// New folder.
    NewFolder => "actions/newFolder_dark.svg" | "actions/newFolder.svg",
    /// New file.
    AddFile => "actions/addFile_dark.svg" | "actions/addFile.svg",
    /// Regex toggle (search field).
    Regex => "inline/regex_dark.svg" | "inline/regex.svg",
    /// Match case toggle (search field).
    MatchCase => "inline/matchCase_dark.svg" | "inline/matchCase.svg",
    /// Whole words toggle (search field).
    Words => "inline/exactWords_dark.svg" | "inline/exactWords.svg",
    /// Search with history (search field).
    SearchHistory => "inline/searchHistory_dark.svg" | "inline/searchHistory.svg",
    /// Information (balloons, notifications).
    Info => "status/info_dark.svg" | "status/info.svg",
    /// Warning (balloons, notifications).
    Warning => "status/warning_dark.svg" | "status/warning.svg",
    /// Error (balloons, notifications).
    Error => "status/error_dark.svg" | "status/error.svg",
    /// Success.
    Success => "status/success_dark.svg" | "status/success.svg",
    /// Editor inspections widget: no problems.
    InspectionsOk => "general/inspections/inspectionsOK_dark.svg" | "general/inspections/inspectionsOK.svg",
    /// Editor inspections widget: errors.
    InspectionsError => "general/inspections/inspectionsError.svg",
    /// Editor inspections widget: warnings.
    InspectionsWarning => "general/inspections/inspectionsWarning.svg",
    /// Editor inspections widget: still analyzing.
    InspectionsEye => "general/inspections/inspectionsEye_dark.svg" | "general/inspections/inspectionsEye.svg",
    /// VCS fetch.
    Fetch => "vcs/fetch_dark.svg" | "vcs/fetch.svg",
    /// VCS push.
    Push => "vcs/push_dark.svg" | "vcs/push.svg",
    /// VCS update project (pull).
    Update => "vcs/update_dark.svg" | "vcs/update.svg",
    /// VCS commit.
    Commit => "vcs/commit_dark.svg" | "vcs/commit.svg",
    /// The GitHub plugin's pull requests (expui/pullRequests): Create Draft PR….
    PullRequests => "vcs/pullRequests_dark.svg" | "vcs/pullRequests.svg",
    /// VCS changelist.
    Changelist => "vcs/changelist_dark.svg" | "vcs/changelist.svg",
    /// Show diff.
    Diff => "vcs/diff_dark.svg" | "vcs/diff.svg",
    /// Rollback.
    Revert => "vcs/revert_dark.svg" | "vcs/revert.svg",
    /// Merge.
    Merge => "vcs/merge_dark.svg" | "vcs/merge.svg",
    /// Run.
    Run => "run/run_dark.svg" | "run/run.svg",
    /// Stop.
    Stop => "run/stop_dark.svg" | "run/stop.svg",
    /// Debug.
    Debug => "run/debug_dark.svg" | "run/debug.svg",
    /// Rerun.
    Rerun => "run/rerun_dark.svg" | "run/rerun.svg",
    /// Project tool window.
    ToolWindowProject => "toolwindows/project_dark.svg" | "toolwindows/project.svg",
    /// Commit tool window.
    ToolWindowCommit => "toolwindows/commit_dark.svg" | "toolwindows/commit.svg",
    /// Git tool window.
    ToolWindowVcs => "toolwindows/vcs_dark.svg" | "toolwindows/vcs.svg",
    /// Structure tool window.
    ToolWindowStructure => "toolwindows/structure_dark.svg" | "toolwindows/structure.svg",
    /// Problems tool window.
    ToolWindowProblems => "toolwindows/problems_dark.svg" | "toolwindows/problems.svg",
    /// Find tool window.
    ToolWindowFind => "toolwindows/find_dark.svg" | "toolwindows/find.svg",
    /// Notifications tool window.
    ToolWindowNotifications => "toolwindows/notifications_dark.svg" | "toolwindows/notifications.svg",
    /// Bookmarks tool window.
    ToolWindowBookmarks => "toolwindows/bookmarks_dark.svg" | "toolwindows/bookmarks.svg",
    /// Run tool window.
    ToolWindowRun => "toolwindows/run_dark.svg" | "toolwindows/run.svg",
    /// The stripe's Board (VimStorm's own: three columns).
    StripeBoard => "stripe/board_dark.svg" | "stripe/board.svg",
    /// The stripe's Run (VimStorm's own: the path a run took).
    StripeRunPath => "stripe/runPath_dark.svg" | "stripe/runPath.svg",
    /// Terminal tool window (terminal plugin).
    ToolWindowTerminal => "toolwindows/terminal_dark.svg" | "toolwindows/terminal.svg",
    /// Current branch tag (yellow; dvcs icons/new/currentBranchLabel), branch popup.
    CurrentBranch => "dvcs/currentBranchLabel_dark.svg" | "dvcs/currentBranchLabel.svg",
    /// Cut (general/cut), menus.
    Cut => "general/cut_dark.svg" | "general/cut.svg",
    /// Paste (general/paste), menus.
    Paste => "general/paste_dark.svg" | "general/paste.svg",
    /// Show Context Actions (codeInsight/intentionBulb), menus.
    IntentionBulb => "codeInsight/intentionBulb_dark.svg" | "codeInsight/intentionBulb.svg",
    /// Split Right (general/splitVertically), menus.
    SplitVertically => "general/splitVertically_dark.svg" | "general/splitVertically.svg",
    /// Split Down (general/splitHorizontally), menus.
    SplitHorizontally => "general/splitHorizontally_dark.svg" | "general/splitHorizontally.svg",
    /// Markdown Editor Only (general/editorOnly), menus.
    EditorOnly => "general/editorOnly_dark.svg" | "general/editorOnly.svg",
    /// Markdown Preview Only (general/previewOnly), menus.
    PreviewOnly => "general/previewOnly_dark.svg" | "general/previewOnly.svg",
    /// Markdown Editor and Preview (general/editorPreview), the preview's mode toolbar.
    EditorPreview => "general/editorPreview_dark.svg" | "general/editorPreview.svg",

    /// Chat (VimStorm's own: a speech bubble), the switcher's chat rows.
    Chat => "ai/chat_dark.svg" | "ai/chat.svg",

    // ---- Git tool window / diff / merge (sources in assets/icons/NOTICE)
    /// Shelve (ChangesView.ShelveSilently).
    Shelve => "vcs/shelve_dark.svg" | "vcs/shelve.svg",
    /// Show all affected files (Vcs.Log.ShowAllAffected).
    ListChanges => "vcs/changes_dark.svg" | "vcs/changes.svg",
    /// Annotate (actions/annotate -> general/listFiles).
    Annotate => "general/listFiles_dark.svg" | "general/listFiles.svg",
    /// Previous difference (diff toolbar up arrow).
    PreviousDifference => "general/up_dark.svg" | "general/up.svg",
    /// Next difference (diff toolbar down arrow).
    NextDifference => "general/down_dark.svg" | "general/down.svg",
    /// Previous file in the diff (Diff.PrevChange).
    PreviousFile => "general/left_dark.svg" | "general/left.svg",
    /// Next file in the diff (Diff.NextChange).
    NextFile => "general/right_dark.svg" | "general/right.svg",
    /// Open in a new tab (Vcs.Log.OpenAnotherTabInEditor).
    OpenNewTab => "general/openNewTab_dark.svg" | "general/openNewTab.svg",
    /// The corner triangle of toolbar buttons that open a popup.
    Dropdown => "general/dropdown_dark.svg" | "general/dropdown.svg",
    /// Read-only lock.
    Locked => "general/locked_dark.svg" | "general/locked.svg",
    /// Green check (merge: "No changes. No conflicts.").
    GreenCheckmark => "general/greenCheckmark_dark.svg" | "general/greenCheckmark.svg",
    /// Synchronize scrolling (diff).
    SynchronizeScrolling => "actions/synchronizeScrolling_dark.svg" | "actions/synchronizeScrolling.svg",
    /// Group by directory.
    GroupByDirectory => "actions/groupByPackage_dark.svg" | "actions/groupByPackage.svg",
    /// Diff read-only lock (diff/lock).
    DiffReadOnlyLock => "diff/disableEditing_dark.svg" | "diff/disableEditing.svg",
    /// Merge: apply non-conflicting changes (both sides).
    ApplyNonConflicts => "diff/applyNotConflicts_dark.svg" | "diff/applyNotConflicts.svg",
    /// Merge: apply non-conflicting changes from the left.
    ApplyNonConflictsLeft => "diff/applyNotConflictsLeft_dark.svg" | "diff/applyNotConflictsLeft.svg",
    /// Merge: apply non-conflicting changes from the right.
    ApplyNonConflictsRight => "diff/applyNotConflictsRight_dark.svg" | "diff/applyNotConflictsRight.svg",
    /// Merge toolbar: resolve simple conflicts (magic wand).
    MagicResolve => "diff/magicResolveToolbar_dark.svg" | "diff/magicResolveToolbar.svg",
    /// Merge gutter: resolve simple conflict (14x14).
    MagicResolveGutter => "diff/magicResolve@14x14_dark.svg" | "diff/magicResolve@14x14.svg",
    /// Diff gutter "<<" (apply the right side; 14x14).
    AcceptRightGutter => "diff/arrow@14x14_dark.svg" | "diff/arrow@14x14.svg",
    /// Diff gutter ">>" (apply the left side; 14x14).
    AcceptLeftGutter => "diff/arrowRight@14x14_dark.svg" | "diff/arrowRight@14x14.svg",
    /// Merge gutter: append the left side (14x14).
    AppendLeftGutter => "diff/arrowRightDown@14x14_dark.svg" | "diff/arrowRightDown@14x14.svg",
    /// Merge gutter: append the right side (14x14).
    AppendRightGutter => "diff/arrowLeftDown@14x14_dark.svg" | "diff/arrowLeftDown@14x14.svg",
    /// Merge gutter: ignore a side (×, 14x14).
    IgnoreGutter => "diff/remove@14x14_dark.svg" | "diff/remove@14x14.svg",
    /// PR diff gutter: a review comment drafted on the line (collaboration tools' comment).
    ReviewComment => "review/comment_dark.svg" | "review/comment.svg",
    /// Diff gutter: revert / reset a resolved change (14x14).
    RevertGutter => "diff/revert@14x14_dark.svg" | "diff/revert@14x14.svg",
    /// Partial-commit gutter checkbox (14x14).
    GutterCheckBox => "diff/gutterCheckBox@14x14_dark.svg" | "diff/gutterCheckBox@14x14.svg",
    /// Partial-commit gutter checkbox, checked (14x14).
    GutterCheckBoxSelected => "diff/gutterCheckBoxSelected@14x14_dark.svg" | "diff/gutterCheckBoxSelected@14x14.svg",
    /// Partial-commit gutter checkbox, partly (14x14).
    GutterCheckBoxIndeterminate => "diff/gutterCheckBoxIndeterminate@14x14_dark.svg" | "diff/gutterCheckBoxIndeterminate@14x14.svg",
    /// Resume log indexing (▷ in a gray circle, 30.png's first log toolbar button).
    ResumeIndexing => "progress/resume_dark.svg" | "progress/resume.svg",
    /// Tag.
    Tag => "nodes/tag_dark.svg" | "nodes/tag.svg",
    /// Favorite branch (star).
    Favorite => "nodes/star_dark.svg" | "nodes/star.svg",
    /// Not a favorite (empty star, on hover).
    FavoriteEmpty => "nodes/starEmpty_dark.svg" | "nodes/starEmpty.svg",
    /// Cherry-pick (Vcs.CherryPick).
    CherryPick => "dvcs/cherryPick_dark.svg" | "dvcs/cherryPick.svg",
    /// A branch (branches tree / popup).
    BranchLabel => "dvcs/branchLabel_dark.svg" | "dvcs/branchLabel.svg",
    /// The current branch, favorite.
    CurrentBranchFavorite => "dvcs/currentBranchFavoriteLabel_dark.svg" | "dvcs/currentBranchFavoriteLabel.svg",
    /// Incoming commits.
    IncomingUpdate => "dvcs/incomingUpdate_dark.svg" | "dvcs/incomingUpdate.svg",
    /// Outgoing commits.
    OutgoingPush => "dvcs/outgoingPush_dark.svg" | "dvcs/outgoingPush.svg",
    /// Incoming commits, small (12x12).
    IncomingSmall => "dvcs/changesUpdate@12x12_dark.svg" | "dvcs/changesUpdate@12x12.svg",
    /// Outgoing commits, small (12x12).
    OutgoingSmall => "dvcs/changesPush@12x12_dark.svg" | "dvcs/changesPush@12x12.svg",
    /// The log's sort / IntelliSort button.
    IntelliSort => "vcsLog/intelliSort_dark.svg" | "vcsLog/intelliSort.svg",
    /// New UI checkbox (24x24 canvas, box at 4.5..19.5): unchecked.
    CheckBox => "checkbox/checkBox.svg" | "checkbox/light/checkBox.svg",
    /// Checkbox: unchecked, disabled.
    CheckBoxDisabled => "checkbox/checkBoxDisabled.svg" | "checkbox/light/checkBoxDisabled.svg",
    /// Checkbox: unchecked, focused.
    CheckBoxFocused => "checkbox/checkBoxFocused.svg" | "checkbox/light/checkBoxFocused.svg",
    /// Checkbox: checked.
    CheckBoxSelected => "checkbox/checkBoxSelected.svg" | "checkbox/light/checkBoxSelected.svg",
    /// Checkbox: checked, disabled.
    CheckBoxSelectedDisabled => "checkbox/checkBoxSelectedDisabled.svg" | "checkbox/light/checkBoxSelectedDisabled.svg",
    /// Checkbox: checked, focused.
    CheckBoxSelectedFocused => "checkbox/checkBoxSelectedFocused.svg" | "checkbox/light/checkBoxSelectedFocused.svg",
    /// Checkbox: partly checked (tri-state folders).
    CheckBoxIndeterminate => "checkbox/checkBoxIndeterminateSelected.svg" | "checkbox/light/checkBoxIndeterminateSelected.svg",
    /// Checkbox: partly checked, disabled.
    CheckBoxIndeterminateDisabled => "checkbox/checkBoxIndeterminateSelectedDisabled.svg" | "checkbox/light/checkBoxIndeterminateSelectedDisabled.svg",
    /// Checkbox: partly checked, focused.
    CheckBoxIndeterminateFocused => "checkbox/checkBoxIndeterminateSelectedFocused.svg" | "checkbox/light/checkBoxIndeterminateSelectedFocused.svg",
}

use IconName as I;

/// Exact base names (config/icons.lua `file`), case-sensitive.
const FILE_NAMES: &[(&str, IconName)] = &[
    ("Dockerfile", I::Text),
    ("docker-compose.yml", I::Yaml),
    ("docker-compose.yaml", I::Yaml),
    ("package.json", I::Json),
    ("package-lock.json", I::Json),
    ("tsconfig.json", I::Json),
    ("README.md", I::Markdown),
    ("README", I::Text),
    ("LICENSE", I::Text),
    ("LICENSE.md", I::Markdown),
    (".gitignore", I::Ignored),
    (".prettierignore", I::Ignored),
    (".dockerignore", I::Ignored),
    (".npmignore", I::Ignored),
    (".eslintignore", I::Ignored),
    (".stylelintignore", I::Ignored),
    (".gitattributes", I::Text),
    (".gitmodules", I::Text),
    (".gitkeep", I::Text),
    (".mailmap", I::Text),
    (".npmrc", I::Text),
    (".nvmrc", I::Text),
    (".node-version", I::Text),
    (".prototools", I::Text),
    (".editorconfig", I::EditorConfig),
    // .env / .env.local are YAML in WebStorm (options/filetypes.xml); other .env.* plain text
    (".env", I::Yaml),
    (".env.local", I::Yaml),
    (".env.example", I::Text),
    (".env.unittest", I::Text),
    (".env.development", I::Text),
    (".env.production", I::Text),
    (".env.test", I::Text),
    ("eslint.config.js", I::Eslint),
    ("eslint.config.mjs", I::Eslint),
    ("eslint.config.cjs", I::Eslint),
    ("eslint.config.ts", I::Eslint),
    (".eslintrc", I::Eslint),
    (".eslintrc.js", I::Eslint),
    (".eslintrc.cjs", I::Eslint),
    (".eslintrc.json", I::Eslint),
    ("prettier.config.js", I::Prettier),
    ("prettier.config.mjs", I::Prettier),
    ("prettier.config.cjs", I::Prettier),
    (".prettierrc", I::Prettier),
    (".prettierrc.json", I::Prettier),
    (".prettierrc.js", I::Prettier),
    (".prettierrc.cjs", I::Prettier),
    (".prettierrc.mjs", I::Prettier),
];

/// Extensions without the dot (config/icons.lua `extension`), matched case-insensitively.
/// `*.test.ts` etc. fall through to their language, like WebStorm's *Test icons minus the run mark.
const EXTENSIONS: &[(&str, IconName)] = &[
    ("ts", I::TypeScript),
    ("mts", I::TypeScript),
    ("cts", I::TypeScript),
    ("d.ts", I::TypeScript),
    ("tsx", I::Tsx),
    ("js", I::JavaScript),
    ("mjs", I::JavaScript),
    ("cjs", I::JavaScript),
    ("jsx", I::Jsx),
    ("json", I::Json),
    ("jsonc", I::Json),
    ("json5", I::Json),
    ("map", I::SourceMap),
    ("md", I::Markdown),
    ("mdx", I::Markdown),
    ("markdown", I::Markdown),
    ("css", I::Css),
    ("less", I::Less),
    ("scss", I::Sass),
    ("sass", I::Sass),
    ("html", I::Html),
    ("htm", I::Html),
    ("xhtml", I::Xhtml),
    ("xml", I::Xml),
    ("xsd", I::Xml),
    ("yml", I::Yaml),
    ("yaml", I::Yaml),
    ("properties", I::Yaml),
    ("png", I::Image),
    ("jpg", I::Image),
    ("jpeg", I::Image),
    ("gif", I::Image),
    ("webp", I::Image),
    ("svg", I::Image),
    ("ico", I::Image),
    ("bmp", I::Image),
    ("avif", I::Image),
    ("ttf", I::Font),
    ("otf", I::Font),
    ("woff", I::Font),
    ("woff2", I::Font),
    ("eot", I::Font),
    ("txt", I::Text),
    ("log", I::Text),
    ("lock", I::Text),
    ("csv", I::Text),
    ("tsv", I::Text),
    ("sh", I::Shell),
    ("bash", I::Shell),
    ("zsh", I::Shell),
    ("sql", I::Sql),
    ("zip", I::Archive),
    ("tar", I::Archive),
    ("gz", I::Archive),
    ("tgz", I::Archive),
    ("jar", I::Archive),
];

/// nvim filetypes (config/icons.lua `filetype`), matched case-insensitively like mini.icons.
const FILETYPES: &[(&str, IconName)] = &[
    ("typescript", I::TypeScript),
    ("typescriptreact", I::Tsx),
    ("javascript", I::JavaScript),
    ("javascriptreact", I::Jsx),
    ("json", I::Json),
    ("jsonc", I::Json),
    ("json5", I::Json),
    ("markdown", I::Markdown),
    ("css", I::Css),
    ("less", I::Less),
    ("scss", I::Sass),
    ("sass", I::Sass),
    ("html", I::Html),
    ("xhtml", I::Xhtml),
    ("xml", I::Xml),
    ("yaml", I::Yaml),
    ("svg", I::Image),
    ("sh", I::Shell),
    ("bash", I::Shell),
    ("zsh", I::Shell),
    ("sql", I::Sql),
    ("gitignore", I::Ignored),
    ("editorconfig", I::EditorConfig),
    ("text", I::Text),
];

fn lookup(table: &[(&str, IconName)], key: &str) -> Option<IconName> {
    table
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|&(_, icon)| icon)
}

/// Icon for a file name (base name, not path), like config/icons.lua: exact file names first, then
/// the widest matching extension ("d.ts" before "ts"; "*.test.ts" falls to ts), default Text.
pub fn for_file(name: &str) -> IconName {
    if let Some(&(_, icon)) = FILE_NAMES.iter().find(|(n, _)| *n == name) {
        return icon;
    }
    // Every dot past the first character, left to right: the widest suffix comes first.
    name.char_indices()
        .skip(1)
        .filter(|&(_, c)| c == '.')
        .map(|(i, _)| &name[i + 1..])
        .filter(|ext| !ext.is_empty())
        .find_map(|ext| lookup(EXTENSIONS, ext))
        .unwrap_or(IconName::Text)
}

/// Icon for an nvim filetype (icons.lua `filetype` table), None if unmapped.
pub fn for_filetype(ft: &str) -> Option<IconName> {
    lookup(FILETYPES, ft)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Skips an optional XML declaration, comments and whitespace.
    fn svg_body(bytes: &[u8]) -> &str {
        let mut s = std::str::from_utf8(bytes).expect("utf-8").trim_start();
        loop {
            if let Some(rest) = s.strip_prefix("<?xml") {
                s = rest[rest.find("?>").expect("xml decl end") + 2..].trim_start();
            } else if let Some(rest) = s.strip_prefix("<!--") {
                s = rest[rest.find("-->").expect("comment end") + 3..].trim_start();
            } else {
                return s;
            }
        }
    }

    #[test]
    fn every_svg_is_an_svg_document() {
        for &icon in IconName::ALL {
            for dark in [true, false] {
                let body = svg_body(icon.svg_in(dark));
                assert!(body.starts_with("<svg"), "{icon:?} dark={dark}");
                assert!(body.trim_end().ends_with("</svg>"), "{icon:?} dark={dark}");
                // WS icon canvases: 16 (most), 14 (diff gutter), 12 (small), 24 (checkboxes)
                assert!(
                    ["16 16", "14 14", "12 12", "24 24"]
                        .iter()
                        .any(|s| body.contains(&format!("viewBox=\"0 0 {s}\""))),
                    "{icon:?} dark={dark} has an unexpected canvas"
                );
            }
        }
    }

    #[test]
    fn paths_are_unique_assets() {
        let mut seen = std::collections::HashSet::new();
        for &icon in IconName::ALL {
            let path = icon.path();
            assert!(
                path.starts_with("icons/") && path.ends_with(".svg"),
                "{path}"
            );
            assert!(seen.insert(path), "duplicate {path}");
        }
    }

    /// A light theme draws WebStorm's light SVG wherever JetBrains ships one: every dark
    /// `_dark.svg` and each theme checkbox has its light sibling, and only the few icons JetBrains
    /// ships once for both themes share one file.
    #[test]
    fn light_theme_has_its_own_svgs() {
        let shared: Vec<IconName> = IconName::ALL
            .iter()
            .copied()
            .filter(|i| i.path_in(true) == i.path_in(false))
            .collect();
        assert_eq!(
            shared,
            [
                IconName::Sass,
                IconName::InspectionsError,
                IconName::InspectionsWarning
            ]
        );
        for &icon in IconName::ALL {
            let (dark, light) = (icon.path_in(true), icon.path_in(false));
            if dark != light {
                assert_eq!(
                    light,
                    dark.replace("_dark.svg", ".svg")
                        .replace("checkbox/", "checkbox/light/"),
                    "{icon:?}"
                );
                assert_ne!(icon.svg_in(true), icon.svg_in(false), "{icon:?}");
            }
        }
        // the unchecked box: Islands Dark's dark fill, Islands Light's white box with a grey border
        let light = std::str::from_utf8(IconName::CheckBox.svg_in(false)).expect("utf-8");
        assert!(
            light.contains(r##"fill="#FFFFFF" stroke="#A8ADBD""##),
            "{light}"
        );
        let dark = std::str::from_utf8(IconName::CheckBox.svg_in(true)).expect("utf-8");
        assert!(dark.contains(r##"fill="#2B2D30""##), "{dark}");
    }

    /// path_in() names the file svg_in() embeds (only checkable under cargo, which sets the
    /// manifest dir).
    #[test]
    fn path_matches_embedded_svg() {
        let Some(dir) = option_env!("CARGO_MANIFEST_DIR") else {
            return;
        };
        for &icon in IconName::ALL {
            for dark in [true, false] {
                let path = icon.path_in(dark);
                let on_disk = std::fs::read(std::path::Path::new(dir).join("assets").join(path));
                assert_eq!(
                    on_disk.unwrap_or_else(|e| panic!("{path}: {e}")),
                    icon.svg_in(dark),
                    "{icon:?}"
                );
            }
        }
    }

    /// A file name, then its icon (`icons.lua` picks the same).
    const FILES: &[(&str, IconName)] = &[
        ("package.json", IconName::Json),
        ("tsconfig.json", IconName::Json),
        ("foo.d.ts", IconName::TypeScript),
        ("foo.ts", IconName::TypeScript),
        ("foo.test.ts", IconName::TypeScript),
        ("App.tsx", IconName::Tsx),
        ("App.test.tsx", IconName::Tsx),
        ("index.js", IconName::JavaScript),
        ("Button.jsx", IconName::Jsx),
        ("eslint.config.js", IconName::Eslint),
        (".eslintrc.json", IconName::Eslint),
        (".prettierrc", IconName::Prettier),
        ("prettier.config.mjs", IconName::Prettier),
        ("x.scss", IconName::Sass),
        ("x.sass", IconName::Sass),
        ("x.less", IconName::Less),
        ("x.css", IconName::Css),
        (".gitignore", IconName::Ignored),
        (".env", IconName::Yaml),
        (".env.local", IconName::Yaml),
        (".env.production", IconName::Text),
        ("app.properties", IconName::Yaml),
        (".editorconfig", IconName::EditorConfig),
        ("Dockerfile", IconName::Text),
        ("docker-compose.yml", IconName::Yaml),
        ("unknown.xyz", IconName::Text),
        ("Makefile", IconName::Text),
        ("README.md", IconName::Markdown),
        ("README", IconName::Text),
        ("bundle.js.map", IconName::SourceMap),
        ("logo.svg", IconName::Image),
        ("data.csv", IconName::Text),
        ("schema.sql", IconName::Sql),
        ("run.sh", IconName::Shell),
        ("dist.tar.gz", IconName::Archive),
        ("Inter.woff2", IconName::Font),
        ("page.xhtml", IconName::Xhtml),
        ("pom.xml", IconName::Xml),
        // extensions ignore case, exact names don't
        ("PHOTO.PNG", IconName::Image),
        ("Foo.TS", IconName::TypeScript),
        ("readme.md", IconName::Markdown),
        ("dockerfile", IconName::Text),
        ("PACKAGE.JSON", IconName::Json),
        (".ESLINTRC", IconName::Text),
        // a leading or trailing dot is no extension
        (".ts", IconName::Text),
        (".bashrc", IconName::Text),
        ("foo.", IconName::Text),
        ("", IconName::Text),
        (".eslintrc.yml", IconName::Yaml),
        ("ärger.ts", IconName::TypeScript),
    ];

    #[test]
    fn file_icons_follow_icons_lua() {
        for (name, want) in FILES {
            assert_eq!(for_file(name), *want, "{name:?}");
        }
    }

    const FILETYPES: &[(&str, Option<IconName>)] = &[
        ("typescript", Some(IconName::TypeScript)),
        ("typescriptreact", Some(IconName::Tsx)),
        ("javascriptreact", Some(IconName::Jsx)),
        ("scss", Some(IconName::Sass)),
        ("gitignore", Some(IconName::Ignored)),
        ("editorconfig", Some(IconName::EditorConfig)),
        ("text", Some(IconName::Text)),
        ("lua", None),
        ("", None),
    ];

    #[test]
    fn filetype_icons_follow_icons_lua() {
        for (ft, want) in FILETYPES {
            assert_eq!(for_filetype(ft), *want, "{ft:?}");
        }
    }
}
