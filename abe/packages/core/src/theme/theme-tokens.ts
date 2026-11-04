/**
 * The design system's colour tokens (DS 2.0 `tokens.json`, `color.tokens`, in its order): each one's
 * name, its group in the Colours editor and where it shows (its `usage` names the Rust or Lua
 * constant it comes from). Their Islands Dark values are `ISLANDS_DARK` (`theme-built-in.ts`).
 */
export const TOKENS = [
  {
    name: 'frame-bg',
    group: 'chrome',
    usage:
      'FRAME_BG (theme.rs:54). Window ground: title/toolbar band, status bar and the 3px gaps between islands. Text on it: text, status-bar-text.',
  },
  {
    name: 'panel-bg',
    group: 'chrome',
    usage:
      'PANEL_BG (theme.rs:56). Island fill: project tree, tool windows, Board, Abe tabs, tab strip, fields. Text on it: text, text-dim.',
  },
  {
    name: 'editor-bg',
    group: 'editor',
    usage:
      'EDITOR_BG (theme.rs:58). Code area, terminal, commit message, diff divider. Text on it: editor-fg and the syntax-* tokens.',
  },
  {
    name: 'editor-caret-row-bg',
    group: 'editor',
    usage: 'EDITOR_CARET_ROW_BG (theme.rs:61). Caret row band in the editor.',
  },
  {
    name: 'popup-bg',
    group: 'chrome',
    usage: 'POPUP_BG (theme.rs:168). Popup / menu / Search Everywhere body.',
  },
  {
    name: 'popup-header-bg',
    group: 'chrome',
    usage: 'POPUP_HEADER_BG (theme.rs:174). Popup header.',
  },
  {
    name: 'popup-ad-bg',
    group: 'chrome',
    usage: 'POPUP_AD_BG (theme.rs:178). Popup advertiser (hint) strip at the bottom.',
  },
  {
    name: 'speed-search-bg',
    group: 'chrome',
    usage: 'SPEED_SEARCH_BG (theme.rs:121). "Search for:" speed-search popup in tree / lists.',
  },
  {
    name: 'tab-strip-bg',
    group: 'chrome',
    usage: 'TAB_STRIP_BG (theme.rs:206). Editor tab strip.',
  },
  {
    name: 'toolbar-bg',
    group: 'chrome',
    usage: 'TOOLBAR_BG (theme.rs:258). Main toolbar (title band with traffic lights).',
  },
  { name: 'status-bar-bg', group: 'chrome', usage: 'STATUS_BAR_BG (theme.rs:305). Status bar.' },
  {
    name: 'tooltip-bg',
    group: 'chrome',
    usage: 'TOOLTIP_BG (theme.rs:311). Tooltip. Text: tooltip-fg.',
  },
  {
    name: 'balloon-bg',
    group: 'chrome',
    usage: 'BALLOON_BG (theme.rs:321). Notification balloon. Text: balloon-fg.',
  },
  { name: 'field-bg', group: 'chrome', usage: 'FIELD_BG (theme.rs:345). Text field fill.' },
  {
    name: 'commit-message-bg',
    group: 'chrome',
    usage: 'COMMIT_MESSAGE_BG (theme.rs:573). Commit message editor.',
  },
  {
    name: 'excluded-row-bg',
    group: 'chrome',
    usage:
      'EXCLUDED_ROW_BG (theme.rs:129). Tree row tint for excluded dirs / non-project files (FileColor.Yellow).',
  },
  {
    name: 'library-root-row-bg',
    group: 'chrome',
    usage: 'LIBRARY_ROOT_ROW_BG (theme.rs:130). Tree tint for library roots.',
  },
  {
    name: 'test-row-bg',
    group: 'chrome',
    usage: 'TEST_ROW_BG (theme.rs:131). Tree tint for the Tests scope (FileColor.Green).',
  },
  {
    name: 'vcs-log-hover-bg',
    group: 'chrome',
    usage: 'VCS_LOG_HOVER_BG (theme.rs:602). Git log row hover.',
  },
  {
    name: 'vcs-log-current-branch-bg',
    group: 'chrome',
    usage: 'VCS_LOG_CURRENT_BRANCH_BG (theme.rs:603). Git log rows on the current branch.',
  },
  {
    name: 'diff-separators-bg',
    group: 'diff',
    usage: 'DIFF_SEPARATORS_BG (theme.rs:658). Collapsed-unchanged separators in diffs.',
  },
  {
    name: 'diff-divider-bg',
    group: 'diff',
    usage: 'DIFF_DIVIDER_BG (theme.rs:660). Strip between the two diff panes.',
  },
  {
    name: 'stripe-hover-bg',
    group: 'chrome',
    usage: 'STRIPE_HOVER_BG (theme.rs:534). Collapsed Branches stripe hover.',
  },
  {
    name: 'abe-lane-bg',
    group: 'chrome',
    usage: 'ABE_LANE_BG (theme.rs:729). Board column (lane) fill.',
  },
  {
    name: 'island-border',
    group: 'chrome',
    usage: 'ISLAND_BORDER (theme.rs:74). 1px outline inside each island edge.',
  },
  {
    name: 'border',
    group: 'chrome',
    usage:
      'BORDER (theme.rs:79). Generic 1px component border, splitters (SPLITTER_LINE theme.rs:528), tab strip underline, tool window header line.',
  },
  {
    name: 'separator',
    group: 'chrome',
    usage:
      'SEPARATOR (theme.rs:80). OnePixelDivider, popup / tooltip / balloon borders, toolbar separators.',
  },
  {
    name: 'popup-border',
    group: 'chrome',
    usage: 'POPUP_BORDER (theme.rs:169). 1px popup border.',
  },
  {
    name: 'tab-strip-border',
    group: 'chrome',
    usage: 'TAB_STRIP_BORDER (theme.rs:208). 1px line under the editor tab strip.',
  },
  {
    name: 'toolwindow-header-border',
    group: 'chrome',
    usage: 'TOOLWINDOW_HEADER_BORDER (theme.rs:439). Line under a tool window header.',
  },
  {
    name: 'field-border',
    group: 'chrome',
    usage: 'FIELD_BORDER (theme.rs:346). Text field border at rest (focused: focus-border 2px).',
  },
  {
    name: 'commit-message-border',
    group: 'chrome',
    usage:
      'COMMIT_MESSAGE_BORDER (theme.rs:576). Commit message border (focused 2px focus-border).',
  },
  {
    name: 'button-border',
    group: 'chrome',
    usage: 'BUTTON_BORDER (theme.rs:557). Plain push-button border.',
  },
  {
    name: 'button-disabled-border',
    group: 'chrome',
    usage: 'BUTTON_DISABLED_BORDER (theme.rs:563). Disabled button border.',
  },
  {
    name: 'text',
    group: 'chrome',
    usage: 'TEXT (theme.rs:87). Default UI foreground on frame-bg, panel-bg, popup-bg.',
  },
  {
    name: 'text-dim',
    group: 'chrome',
    usage:
      'TEXT_DIM (theme.rs:89). Secondary text: paths, counts, ref labels, captions, placeholders, menu shortcuts. 3.7:1 on panel-bg, 3.1:1 on frame-bg (WebStorm value, below 4.5:1): keep it for secondary text, never for body copy.',
  },
  {
    name: 'text-disabled',
    group: 'chrome',
    usage:
      'TEXT_DISABLED (theme.rs:90). Disabled rows, todo steps. Below 4.5:1 on purpose (WebStorm value).',
  },
  {
    name: 'selection-text',
    group: 'chrome',
    usage:
      'SELECTION_TEXT (theme.rs:104). Text on selection-bg rows; window title; Board card titles.',
  },
  {
    name: 'editor-fg',
    group: 'editor',
    usage: 'EDITOR_FG (theme.rs:59). Plain code text on editor-bg.',
  },
  {
    name: 'editor-line-number',
    group: 'editor',
    usage: 'EDITOR_LINE_NUMBER (theme.rs:62). Gutter line numbers.',
  },
  {
    name: 'editor-line-number-current',
    group: 'editor',
    usage: 'EDITOR_LINE_NUMBER_CURRENT (theme.rs:63). Caret-row line number.',
  },
  {
    name: 'tab-text',
    group: 'chrome',
    usage: 'TAB_TEXT (theme.rs:230). Selected / hovered editor tab label.',
  },
  {
    name: 'tab-text-inactive',
    group: 'chrome',
    usage: 'TAB_TEXT_INACTIVE (theme.rs:232). Unselected editor tab label.',
  },
  {
    name: 'status-bar-text',
    group: 'chrome',
    usage: 'STATUS_BAR_TEXT (theme.rs:306). Status bar widgets.',
  },
  {
    name: 'status-bar-text-inactive',
    group: 'chrome',
    usage:
      'STATUS_BAR_TEXT_INACTIVE (theme.rs:248). Status bar while the window is in the background.',
  },
  {
    name: 'status-bar-separator',
    group: 'chrome',
    usage: 'STATUS_BAR_SEPARATOR (theme.rs:250). Breadcrumb chevrons in the status bar.',
  },
  {
    name: 'toolbar-title-fg',
    group: 'chrome',
    usage: 'TOOLBAR_TITLE_FG (theme.rs:282). Centred window title.',
  },
  {
    name: 'popup-ad-fg',
    group: 'chrome',
    usage: 'POPUP_AD_FG (theme.rs:177). Popup advertiser hint text.',
  },
  {
    name: 'popup-caption-fg',
    group: 'chrome',
    usage: 'POPUP_CAPTION_FG (theme.rs:302). Popup group captions ("Recent").',
  },
  {
    name: 'empty-hint-text',
    group: 'chrome',
    usage: 'EMPTY_HINT_TEXT (theme.rs:243). Empty-editor action names.',
  },
  {
    name: 'empty-hint-shortcut',
    group: 'chrome',
    usage: 'EMPTY_HINT_SHORTCUT (theme.rs:244). Empty-editor shortcuts.',
  },
  {
    name: 'tooltip-fg',
    group: 'chrome',
    usage: 'TOOLTIP_FG (theme.rs:312). Tooltip text on tooltip-bg.',
  },
  {
    name: 'tooltip-shortcut-fg',
    group: 'chrome',
    usage: 'TOOLTIP_SHORTCUT_FG (theme.rs:314). Shortcut inside a tooltip.',
  },
  {
    name: 'balloon-fg',
    group: 'chrome',
    usage: 'BALLOON_FG (theme.rs:322). Balloon text on balloon-bg.',
  },
  { name: 'placeholder', group: 'chrome', usage: 'PLACEHOLDER (theme.rs:360). Field placeholder.' },
  {
    name: 'menu-shortcut-fg',
    group: 'chrome',
    usage: 'MENU_SHORTCUT_FG (theme.rs:388). Menu shortcut column.',
  },
  {
    name: 'menu-shortcut-selected-fg',
    group: 'chrome',
    usage: 'MENU_SHORTCUT_SELECTED_FG (theme.rs:389). Shortcut on the selected context-menu row.',
  },
  {
    name: 'menu-disabled-fg',
    group: 'chrome',
    usage: 'MENU_DISABLED_FG (theme.rs:390). Greyed menu rows (Action menu rows show why).',
  },
  {
    name: 'filter-chip-name-fg',
    group: 'chrome',
    usage: 'FILTER_CHIP_NAME_FG (theme.rs:514). Git log filter chip name ("Branch:").',
  },
  {
    name: 'changes-count-fg',
    group: 'chrome',
    usage: 'CHANGES_COUNT_FG (theme.rs:545). " 3 files" counts in change trees.',
  },
  {
    name: 'vcs-log-unmatched-fg',
    group: 'chrome',
    usage: 'VCS_LOG_UNMATCHED_FG (theme.rs:604). Git log rows filtered out.',
  },
  {
    name: 'vcs-details-committer-fg',
    group: 'chrome',
    usage: 'VCS_DETAILS_COMMITTER_FG (theme.rs:606). Committer line in commit details.',
  },
  {
    name: 'vcs-ref-text-fg',
    group: 'chrome',
    usage: 'VCS_REF_TEXT_FG (theme.rs:631). Ref label text in the log.',
  },
  {
    name: 'diff-icon-fg',
    group: 'diff',
    usage: 'DIFF_ICON_FG (theme.rs:661). Diff gutter icons (apply, revert).',
  },
  {
    name: 'annotation-fg',
    group: 'chrome',
    usage: 'ANNOTATION_FG (theme.rs:699). Blame annotation text.',
  },
  {
    name: 'annotation-last-commit-fg',
    group: 'chrome',
    usage: 'ANNOTATION_LAST_COMMIT_FG (theme.rs:700). Blame text for the newest commit.',
  },
  {
    name: 'link',
    group: 'chrome',
    usage: 'LINK / LINK_HOVER (theme.rs:95-96). Links; underlined on hover, same colour.',
  },
  {
    name: 'selection-bg',
    group: 'chrome',
    usage:
      'SELECTION_BG (theme.rs:101). Focused list / tree / menu selection, Board card selected (focused). Text: selection-text.',
  },
  {
    name: 'selection-bg-inactive',
    group: 'chrome',
    usage:
      'SELECTION_BG_INACTIVE (theme.rs:103). Selection in an unfocused list; selected Board card without focus.',
  },
  {
    name: 'hover-bg',
    group: 'chrome',
    usage:
      'HOVER_BG (theme.rs:106). Row hover; action-button hover (ACTION_BUTTON_HOVER_BG theme.rs:475).',
  },
  {
    name: 'editor-selection-bg',
    group: 'editor',
    usage: 'EDITOR_SELECTION_BG (theme.rs:60). Editor / terminal text selection, docs selection.',
  },
  {
    name: 'field-selection-bg',
    group: 'chrome',
    usage:
      'FIELD_SELECTION_BG (theme.rs:355). Selected text in a field (fg field-selection-fg #DFE1E5).',
  },
  {
    name: 'focus-border',
    group: 'chrome',
    usage:
      'FOCUS_BORDER (theme.rs:348). 2px focus ring on fields, filter chips, action buttons; Board carried card ring (ABE_CARRY_BORDER theme.rs:750).',
  },
  {
    name: 'caret',
    group: 'editor',
    usage: 'CARET (theme.rs:354). Text-field caret, editor caret (nvim/ui.rs CARET_COLOR).',
  },
  {
    name: 'search-match-bg',
    group: 'chrome',
    usage:
      'SEARCH_MATCH_BG (theme.rs:116). Speed-search match highlight; text search-match-fg #000000.',
  },
  {
    name: 'search-match-fg',
    group: 'chrome',
    usage: 'SEARCH_MATCH_FG (theme.rs:117). Text on search-match-bg.',
  },
  {
    name: 'tab-selected-bg',
    group: 'chrome',
    usage:
      'TAB_SELECTED_BG (theme.rs:215). Selected editor / tool-window tab box, focused (TOOLWINDOW_TAB_SELECTED_BG theme.rs:460).',
  },
  {
    name: 'tab-selected-border',
    group: 'chrome',
    usage: 'TAB_SELECTED_BORDER (theme.rs:216). 1px border of the selected tab box, focused.',
  },
  {
    name: 'tab-selected-inactive-bg',
    group: 'chrome',
    usage:
      'TAB_SELECTED_INACTIVE_BG (theme.rs:217). Selected tab in an unfocused split / tool window.',
  },
  {
    name: 'tab-selected-inactive-border',
    group: 'chrome',
    usage: 'TAB_SELECTED_INACTIVE_BORDER (theme.rs:218). Its 1px border.',
  },
  {
    name: 'tab-hover-bg',
    group: 'chrome',
    usage: 'TAB_HOVER_BG (theme.rs:219). Tab hover, no border.',
  },
  {
    name: 'toolbar-button-hover-bg',
    group: 'chrome',
    usage: 'TOOLBAR_BUTTON_HOVER_BG (theme.rs:260). Toolbar icon button hover.',
  },
  {
    name: 'toolbar-button-pressed-bg',
    group: 'chrome',
    usage:
      'TOOLBAR_BUTTON_PRESSED_BG (theme.rs:261). Pressed / toggled icon button (ACTION_BUTTON_TOGGLED_BG theme.rs:477).',
  },
  {
    name: 'toolbar-dropdown-hover-bg',
    group: 'chrome',
    usage: 'TOOLBAR_DROPDOWN_HOVER_BG (theme.rs:262). Toolbar dropdown widget hover.',
  },
  {
    name: 'toolbar-dropdown-pressed-bg',
    group: 'chrome',
    usage: 'TOOLBAR_DROPDOWN_PRESSED_BG (theme.rs:278). Toolbar dropdown open.',
  },
  {
    name: 'status-bar-hover-bg',
    group: 'chrome',
    usage: 'STATUS_BAR_HOVER_BG (theme.rs:307). Status bar widget hover.',
  },
  {
    name: 'search-field-toggle-on-bg',
    group: 'chrome',
    usage: 'SEARCH_FIELD_TOGGLE_ON_BG (theme.rs:502). Match case / words / regex toggle on.',
  },
  {
    name: 'search-field-toggle-on-hover-bg',
    group: 'chrome',
    usage: 'SEARCH_FIELD_TOGGLE_ON_HOVER_BG (theme.rs:503). Toggle on + hover.',
  },
  {
    name: 'button-primary-bg',
    group: 'chrome',
    usage:
      'BUTTON_PRIMARY_BG / _BORDER (theme.rs:559-560). Default button; text button-primary-fg #FFFFFF.',
  },
  {
    name: 'button-primary-fg',
    group: 'chrome',
    usage: 'BUTTON_PRIMARY_FG (theme.rs:561). Text on button-primary-bg and button-danger-bg.',
  },
  {
    name: 'button-danger-bg',
    group: 'chrome',
    usage: 'BUTTON_DANGER_BG (theme.rs:566). Destructive button fill (focused).',
  },
  {
    name: 'button-danger-border',
    group: 'chrome',
    usage: 'BUTTON_DANGER_BORDER (theme.rs:569). Destructive button border.',
  },
  {
    name: 'button-danger-text',
    group: 'chrome',
    usage: 'BUTTON_DANGER_TEXT (theme.rs:568). Destructive button text when not focused.',
  },
  {
    name: 'scrollbar-thumb',
    group: 'chrome',
    usage: 'SCROLLBAR_THUMB (theme.rs:409). Overlay scrollbar thumb.',
  },
  {
    name: 'scrollbar-thumb-hover',
    group: 'chrome',
    usage: 'SCROLLBAR_THUMB_HOVER (theme.rs:410). Thumb hovered.',
  },
  {
    name: 'text-error',
    group: 'chrome',
    usage:
      'TEXT_ERROR (theme.rs:91). Error labels, speed-search no match, tab error underline (theme.rs:239).',
  },
  { name: 'text-warning', group: 'chrome', usage: 'TEXT_WARNING (theme.rs:92). Warning labels.' },
  {
    name: 'text-success',
    group: 'chrome',
    usage: 'TEXT_SUCCESS (theme.rs:94). Done / installed checks.',
  },
  {
    name: 'tree-problem-underline',
    group: 'chrome',
    usage: 'TREE_PROBLEM_UNDERLINE (theme.rs:241). Wavy underline on tree files with errors.',
  },
  {
    name: 'merge-done-fg',
    group: 'diff',
    usage: 'MERGE_DONE_FG (theme.rs:681). "No changes. No conflicts."',
  },
  {
    name: 'abe-good',
    group: 'abe',
    usage:
      'ABE_GOOD (theme.rs:706). Passed, approved, ready, done (ABE_DONE, ABE_SPRINT_ON). Always paired with a word or glyph.',
  },
  {
    name: 'abe-bad',
    group: 'abe',
    usage:
      'ABE_BAD (theme.rs:707). Failed, changes requested, blocked, prod gate (ABE_FAILED). Always paired with a word or glyph.',
  },
  {
    name: 'abe-warn',
    group: 'abe',
    usage: 'ABE_WARN (theme.rs:708). Running, waiting, group headings (ABE_NOW).',
  },
  {
    name: 'abe-needs-you',
    group: 'abe',
    usage:
      'Int UI Purple9 (expUI_dark palette); not yet in theme.rs. Needs you only: workspace dots, the overflow count, status words and badges. Never red, never shared with Running.',
  },
  {
    name: 'abe-accent',
    group: 'abe',
    usage: 'ABE_ACCENT (theme.rs:709). Ids (#412, AB-1388), card refs, keys in hints.',
  },
  {
    name: 'abe-person',
    group: 'abe',
    usage: 'ABE_PERSON (theme.rs:710). Who said it: authors in threads and comments.',
  },
  {
    name: 'abe-path',
    group: 'abe',
    usage: 'ABE_PATH (theme.rs:711). Files and branches named in Abe text.',
  },
  {
    name: 'abe-card-title',
    group: 'chrome',
    usage: 'ABE_CARD_TITLE (theme.rs:732). Board card title.',
  },
  { name: 'abe-bug', group: 'chrome', usage: 'ABE_BUG (theme.rs:734). Bug work-item type mark.' },
  {
    name: 'abe-story',
    group: 'chrome',
    usage: 'ABE_STORY (theme.rs:736). Story / other type mark.',
  },
  { name: 'abe-points', group: 'chrome', usage: 'ABE_POINTS (theme.rs:742). Story points.' },
  { name: 'abe-tags', group: 'chrome', usage: 'ABE_TAGS (theme.rs:744). Card tags.' },
  {
    name: 'abe-lane-mark',
    group: 'chrome',
    usage: 'ABE_LANE_MARK (theme.rs:746). Card in a swimlane.',
  },
  {
    name: 'git-modified',
    group: 'git',
    usage:
      'GIT_MODIFIED (theme.rs:420). Modified files (tree, tabs, changes); also renamed (GIT_RENAMED :426) and folders with changes below (GIT_NOT_CHANGED_DIR :547).',
  },
  {
    name: 'git-added',
    group: 'git',
    usage: 'GIT_ADDED (theme.rs:421). Added files; copied (GIT_COPIED :548).',
  },
  {
    name: 'git-untracked',
    group: 'git',
    usage: 'GIT_UNTRACKED (theme.rs:422). Unversioned files.',
  },
  { name: 'git-ignored', group: 'git', usage: 'GIT_IGNORED (theme.rs:423). Ignored files.' },
  { name: 'git-deleted', group: 'git', usage: 'GIT_DELETED (theme.rs:424). Deleted files.' },
  {
    name: 'git-conflict',
    group: 'git',
    usage: 'GIT_CONFLICT (theme.rs:425). Files with merge conflicts.',
  },
  { name: 'git-merged', group: 'git', usage: 'GIT_MERGED (theme.rs:427). Merged files.' },
  {
    name: 'vcs-ref-head',
    group: 'git',
    usage: 'VCS_REF_HEAD (theme.rs:626). HEAD ref icon in the log.',
  },
  {
    name: 'vcs-ref-local',
    group: 'git',
    usage: 'VCS_REF_LOCAL (theme.rs:627). Local branch ref icon.',
  },
  {
    name: 'vcs-ref-remote',
    group: 'git',
    usage: 'VCS_REF_REMOTE (theme.rs:628). Remote branch ref icon.',
  },
  {
    name: 'vcs-ref-tag',
    group: 'git',
    usage: 'VCS_REF_TAG / OTHER (theme.rs:629-630). Tag and other refs.',
  },
  {
    name: 'vcs-log-graph-main',
    group: 'git',
    usage:
      'VCS_LOG_GRAPH_MAIN (theme.rs:615). Graph line of origin/master; other branches hash a hue at saturation 0.6, brightness 0.6 (git/graph.rs).',
  },
  {
    name: 'blame-1',
    group: 'git',
    usage:
      'ISL VCS_ANNOTATIONS_COLOR_1; blame.rs interpolates 21 steps, newest commit first (blame-1) to oldest (blame-5).',
  },
  {
    name: 'blame-2',
    group: 'git',
    usage:
      'ISL VCS_ANNOTATIONS_COLOR_2; blame.rs interpolates 21 steps, newest commit first (blame-1) to oldest (blame-5).',
  },
  {
    name: 'blame-3',
    group: 'git',
    usage:
      'ISL VCS_ANNOTATIONS_COLOR_3; blame.rs interpolates 21 steps, newest commit first (blame-1) to oldest (blame-5).',
  },
  {
    name: 'blame-4',
    group: 'git',
    usage:
      'ISL VCS_ANNOTATIONS_COLOR_4; blame.rs interpolates 21 steps, newest commit first (blame-1) to oldest (blame-5).',
  },
  {
    name: 'blame-5',
    group: 'git',
    usage:
      'ISL VCS_ANNOTATIONS_COLOR_5; blame.rs interpolates 21 steps, newest commit first (blame-1) to oldest (blame-5).',
  },
  {
    name: 'diff-inserted-bg',
    group: 'diff',
    usage: 'DIFF_INSERTED_BG (theme.rs:643). Inserted lines.',
  },
  {
    name: 'diff-deleted-bg',
    group: 'diff',
    usage: 'DIFF_DELETED_BG (theme.rs:644). Deleted lines.',
  },
  {
    name: 'diff-modified-bg',
    group: 'diff',
    usage: 'DIFF_MODIFIED_BG (theme.rs:645). Modified lines (changed words).',
  },
  {
    name: 'diff-conflict-bg',
    group: 'diff',
    usage: 'DIFF_CONFLICT_BG (theme.rs:646). Conflict lines.',
  },
  {
    name: 'diff-inserted-ignored',
    group: 'diff',
    usage: 'DIFF_INSERTED_IGNORED (theme.rs:654). Line around changed word fragments, inserted.',
  },
  {
    name: 'diff-deleted-ignored',
    group: 'diff',
    usage: 'DIFF_DELETED_IGNORED (theme.rs:655). Same, deleted.',
  },
  {
    name: 'diff-modified-ignored',
    group: 'diff',
    usage: 'DIFF_MODIFIED_IGNORED (theme.rs:656). Same, modified (Lua diff_change).',
  },
  {
    name: 'diff-conflict-ignored',
    group: 'diff',
    usage: 'DIFF_CONFLICT_IGNORED (theme.rs:657). Same, conflict.',
  },
  {
    name: 'diff-inserted-stripe',
    group: 'diff',
    usage: 'DIFF_INSERTED_STRIPE (theme.rs:648). Scrollbar mark, inserted.',
  },
  {
    name: 'diff-deleted-stripe',
    group: 'diff',
    usage: 'DIFF_DELETED_STRIPE (theme.rs:649). Scrollbar mark, deleted.',
  },
  {
    name: 'diff-modified-stripe',
    group: 'diff',
    usage: 'DIFF_MODIFIED_STRIPE (theme.rs:650). Scrollbar mark, modified.',
  },
  {
    name: 'diff-conflict-stripe',
    group: 'diff',
    usage: 'DIFF_CONFLICT_STRIPE (theme.rs:651). Scrollbar mark, conflict.',
  },
  {
    name: 'gutter-added',
    group: 'diff',
    usage: 'GUTTER_ADDED (theme.rs:690). Editor gutter change bar, added.',
  },
  {
    name: 'gutter-modified',
    group: 'diff',
    usage: 'GUTTER_MODIFIED (theme.rs:691). Gutter bar, modified.',
  },
  {
    name: 'gutter-deleted',
    group: 'diff',
    usage: 'GUTTER_DELETED (theme.rs:692). Gutter mark, deleted.',
  },
  {
    name: 'gutter-whitespace-modified',
    group: 'diff',
    usage: 'GUTTER_WHITESPACE_MODIFIED (theme.rs:693). Gutter bar, whitespace-only change.',
  },
  {
    name: 'syntax-bg-alt',
    group: 'editor',
    usage: 'bg_alt: caret row, NormalFloat, Pmenu, docs. (darcula.lua:4). On editor-bg.',
  },
  {
    name: 'syntax-fg-bright',
    group: 'editor',
    usage: 'fg_bright: Title, FloatTitle. (darcula.lua:6). On editor-bg.',
  },
  {
    name: 'syntax-selection',
    group: 'editor',
    usage: 'Visual, IncSearch, CurSearch. (darcula.lua:10). On editor-bg.',
  },
  {
    name: 'syntax-search',
    group: 'editor',
    usage:
      'Search results (TEXT_SEARCH_RESULT); picker preview match. (darcula.lua:11). On editor-bg.',
  },
  {
    name: 'syntax-search-cur',
    group: 'editor',
    usage: 'Substitute. (darcula.lua:12). On editor-bg.',
  },
  {
    name: 'syntax-ref',
    group: 'editor',
    usage: 'LspReferenceText / Read. (darcula.lua:13). On editor-bg.',
  },
  {
    name: 'syntax-ref-write',
    group: 'editor',
    usage: 'LspReferenceWrite (darcula-contrast.lua:270). (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-brace-bg',
    group: 'editor',
    usage: 'MatchParen background. (darcula.lua:14). On editor-bg.',
  },
  {
    name: 'syntax-brace-fg',
    group: 'editor',
    usage: 'MatchParen text, bold. (darcula.lua:15). On editor-bg.',
  },
  {
    name: 'syntax-keyword',
    group: 'editor',
    usage:
      'Keywords, booleans, `, ;`, this, builtin types, escapes, markdown markers. (darcula.lua:22). On editor-bg.',
  },
  {
    name: 'syntax-string',
    group: 'editor',
    usage: 'Strings, markdown code / quote. (darcula.lua:23). On editor-bg.',
  },
  {
    name: 'syntax-number',
    group: 'editor',
    usage: 'Numbers, regex. (darcula.lua:24). On editor-bg.',
  },
  {
    name: 'syntax-comment',
    group: 'editor',
    usage: 'Comments (not italic), Copilot ghost text. (darcula.lua:25). On editor-bg.',
  },
  {
    name: 'syntax-doc',
    group: 'editor',
    usage: 'Doc comments (italic), JSDoc. (darcula.lua:26). On editor-bg.',
  },
  {
    name: 'syntax-jsdoc-tag',
    group: 'editor',
    usage:
      'JSDoc type / param tags (darcula-contrast.lua:171-176). (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-func',
    group: 'editor',
    usage:
      'Function declarations, methods, active signature parameter. (darcula.lua:27). On editor-bg.',
  },
  {
    name: 'syntax-field',
    group: 'editor',
    usage:
      'Properties, members, constants (italic), globals (bold italic). (darcula.lua:28). On editor-bg.',
  },
  {
    name: 'syntax-type-param',
    group: 'editor',
    usage: 'Type parameters. (darcula.lua:29). On editor-bg.',
  },
  {
    name: 'syntax-tag',
    group: 'editor',
    usage: 'HTML / JSX tags, CSS selectors. (darcula.lua:30). On editor-bg.',
  },
  {
    name: 'syntax-attr',
    group: 'editor',
    usage: 'Tag attributes, CSS properties. (darcula.lua:31). On editor-bg.',
  },
  {
    name: 'syntax-attr-val',
    group: 'editor',
    usage: 'HTML attribute values, CSS values. (darcula.lua:32). On editor-bg.',
  },
  {
    name: 'syntax-decorator',
    group: 'editor',
    usage: 'Decorators. (darcula.lua:33). On editor-bg.',
  },
  { name: 'syntax-todo', group: 'editor', usage: 'TODO (italic). (darcula.lua:34). On editor-bg.' },
  {
    name: 'syntax-entity',
    group: 'editor',
    usage: '@character.special. (darcula.lua:35). On editor-bg.',
  },
  {
    name: 'syntax-link',
    group: 'editor',
    usage:
      'CSS url, markdown link label (darcula-contrast.lua:197, 207). (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-error',
    group: 'editor',
    usage: 'Error undercurl. (darcula.lua:37). On editor-bg.',
  },
  {
    name: 'syntax-error-fg',
    group: 'editor',
    usage: 'ErrorMsg, DiagnosticError. (darcula.lua:38). On editor-bg.',
  },
  {
    name: 'syntax-error-bg',
    group: 'editor',
    usage: 'Error virtual text background. (darcula.lua:41). On editor-bg.',
  },
  {
    name: 'syntax-warn',
    group: 'editor',
    usage: 'WarningMsg, DiagnosticWarn. (darcula.lua:39). On editor-bg.',
  },
  {
    name: 'syntax-warn-bg',
    group: 'editor',
    usage: 'Warning underline background (no underline). (darcula.lua:40). On editor-bg.',
  },
  {
    name: 'syntax-info',
    group: 'editor',
    usage: 'DiagnosticInfo (darcula-contrast.lua:252). (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-hint',
    group: 'editor',
    usage: 'DiagnosticHint. (darcula.lua:42). On editor-bg.',
  },
  {
    name: 'syntax-unnecessary',
    group: 'editor',
    usage: 'Unused code (darcula-contrast.lua:265). (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-inlay-fg',
    group: 'editor',
    usage:
      'Inlay hints / code lens text (darcula-contrast.lua:271-272). (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-inlay-bg',
    group: 'editor',
    usage: 'Inlay hint background. (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-whitespace',
    group: 'editor',
    usage: 'NonText / Whitespace. (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-bookmark-fg',
    group: 'editor',
    usage:
      'Bookmark number in the gutter (WsBookmarkNum :308). (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-bookmark-bg',
    group: 'editor',
    usage: 'Bookmark number background. (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-fold-fg',
    group: 'editor',
    usage:
      'Fold placeholder {...} text (WsFoldPlaceholder :356). (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-fold-bg',
    group: 'editor',
    usage: 'Fold placeholder background. (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'syntax-pmenu-match',
    group: 'editor',
    usage:
      'Matched characters in completion (PmenuMatch :53). (darcula-contrast.lua). On editor-bg.',
  },
  {
    name: 'icon-blue',
    group: 'editor',
    usage:
      'WsIconBlue (darcula-contrast.lua:413-423). File-icon glyph colour for TS, tsx, md, css, less, image, archive, prettier.',
  },
  {
    name: 'icon-yellow',
    group: 'editor',
    usage: 'WsIconYellow (darcula-contrast.lua:413-423). File-icon glyph colour for JS.',
  },
  {
    name: 'icon-gold',
    group: 'editor',
    usage: 'WsIconGold (darcula-contrast.lua:413-423). File-icon glyph colour for jsx.',
  },
  {
    name: 'icon-purple',
    group: 'editor',
    usage:
      'WsIconPurple (darcula-contrast.lua:413-423). File-icon glyph colour for json, sql, sourceMap.',
  },
  {
    name: 'icon-red',
    group: 'editor',
    usage: 'WsIconRed (darcula-contrast.lua:413-423). File-icon glyph colour for yaml.',
  },
  {
    name: 'icon-green',
    group: 'editor',
    usage: 'WsIconGreen (darcula-contrast.lua:413-423). File-icon glyph colour for html.',
  },
  {
    name: 'icon-orange',
    group: 'editor',
    usage: 'WsIconOrange (darcula-contrast.lua:413-423). File-icon glyph colour for xml.',
  },
  {
    name: 'icon-pink',
    group: 'editor',
    usage: 'WsIconPink (darcula-contrast.lua:413-423). File-icon glyph colour for sass / scss.',
  },
  {
    name: 'icon-gray',
    group: 'editor',
    usage:
      'WsIconGray (darcula-contrast.lua:413-423). File-icon glyph colour for folders, other files; menu icons (WsMenuIcon).',
  },
  {
    name: 'float-menu-bg',
    group: 'editor',
    usage: 'floats/style.rs:17 (DCS LOOKUP_COLOR). Completion menu body.',
  },
  { name: 'float-menu-fg', group: 'editor', usage: 'floats/style.rs:19. Completion item text.' },
  {
    name: 'float-menu-match-fg',
    group: 'editor',
    usage: 'floats/style.rs:21-22. Matched characters in completion, selected or not.',
  },
  {
    name: 'float-doc-bg',
    group: 'editor',
    usage: 'floats/style.rs:63. Hover / docs / diagnostics popup body.',
  },
  {
    name: 'float-doc-dim-fg',
    group: 'editor',
    usage: 'floats/style.rs:66. Secondary text in docs.',
  },
  {
    name: 'float-inline-code-bg',
    group: 'editor',
    usage: 'floats/style.rs:102. Inline code in docs.',
  },
  {
    name: 'float-signature-border',
    group: 'editor',
    usage: 'floats/style.rs:141. Signature help border (bg editor-bg).',
  },
  {
    name: 'float-signature-active-bg',
    group: 'editor',
    usage: 'floats/style.rs:151. Active overload row.',
  },
  {
    name: 'md-code-bg',
    group: 'editor',
    usage: 'markdown/style.rs:33. Code background in the markdown preview (rgba 212,222,231,.098).',
  },
  { name: 'md-quote-border', group: 'editor', usage: 'markdown/style.rs:50. Blockquote bar.' },
  {
    name: 'chat-card-bg',
    group: 'editor',
    usage:
      'Unused since 2.1 retired the Copilot inline chat card; kept so themes keep their slots.',
  },
  {
    name: 'chat-card-border',
    group: 'editor',
    usage: "Unused since 2.1 (the inline chat card's border).",
  },
  {
    name: 'chat-accept-hover-bg',
    group: 'editor',
    usage: "Unused since 2.1 (the inline chat card's Accept hovered).",
  },
  {
    name: 'chat-inline-code-bg',
    group: 'editor',
    usage: "Unused since 2.1 (inline code in the inline chat card's answers).",
  },
  {
    name: 'mode-normal-bg',
    group: 'chrome',
    usage:
      'statusbar/mod.rs:75-82 mode_colors. Status-bar mode badge fill for NORMAL (VIMSTORM \u00b7 NORMAL); the ABE \u00b7 NORMAL / ACTIONS / SEARCH badges use the normal pair. Text: mode-normal-fg.',
  },
  {
    name: 'mode-normal-fg',
    group: 'chrome',
    usage: 'Mode badge text for NORMAL on mode-normal-bg.',
  },
  {
    name: 'mode-insert-bg',
    group: 'chrome',
    usage:
      'statusbar/mod.rs:75-82 mode_colors. Status-bar mode badge fill for INSERT (VIMSTORM \u00b7 INSERT); the ABE \u00b7 NORMAL / ACTIONS / SEARCH badges use the normal pair. Text: mode-insert-fg.',
  },
  {
    name: 'mode-insert-fg',
    group: 'chrome',
    usage: 'Mode badge text for INSERT on mode-insert-bg.',
  },
  {
    name: 'mode-visual-bg',
    group: 'chrome',
    usage:
      'statusbar/mod.rs:75-82 mode_colors. Status-bar mode badge fill for VISUAL (VIMSTORM \u00b7 VISUAL); the ABE \u00b7 NORMAL / ACTIONS / SEARCH badges use the normal pair. Text: mode-visual-fg.',
  },
  {
    name: 'mode-visual-fg',
    group: 'chrome',
    usage: 'Mode badge text for VISUAL on mode-visual-bg.',
  },
  {
    name: 'mode-replace-bg',
    group: 'chrome',
    usage:
      'statusbar/mod.rs:75-82 mode_colors. Status-bar mode badge fill for REPLACE (VIMSTORM \u00b7 REPLACE); the ABE \u00b7 NORMAL / ACTIONS / SEARCH badges use the normal pair. Text: mode-replace-fg.',
  },
  {
    name: 'mode-replace-fg',
    group: 'chrome',
    usage: 'Mode badge text for REPLACE on mode-replace-bg.',
  },
  {
    name: 'mode-command-bg',
    group: 'chrome',
    usage:
      'statusbar/mod.rs:75-82 mode_colors. Status-bar mode badge fill for COMMAND (VIMSTORM \u00b7 COMMAND); the ABE \u00b7 NORMAL / ACTIONS / SEARCH badges use the normal pair. Text: mode-command-fg.',
  },
  {
    name: 'mode-command-fg',
    group: 'chrome',
    usage: 'Mode badge text for COMMAND on mode-command-bg.',
  },
  {
    name: 'term-black',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 0. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-red',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 1. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-green',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 2. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-yellow',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 3. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-blue',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 4. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-magenta',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 5. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-cyan',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 6. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-white',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 7. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-bright-black',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 8. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-bright-red',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 9. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-bright-green',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 10. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-bright-yellow',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 11. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-bright-blue',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 12. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-bright-magenta',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 13. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-bright-cyan',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 14. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-bright-white',
    group: 'terminal',
    usage:
      'terminal/colors.rs:12-15 ANSI 15. Terminal palette on editor-bg; minimum contrast 4.5 enforced at draw time.',
  },
  {
    name: 'term-fg',
    group: 'terminal',
    usage: 'terminal/colors.rs:20. Terminal foreground and cursor.',
  },
  {
    name: 'term-find-bg',
    group: 'terminal',
    usage: 'terminal/colors.rs:26. Find match (text #000000).',
  },
  {
    name: 'term-find-current-bg',
    group: 'terminal',
    usage: 'terminal/colors.rs:29. Current find match.',
  },
  {
    name: 'term-float-backdrop',
    group: 'terminal',
    usage: 'terminal/float.rs:29. Scrim behind the ,G lazygit float. The only scrim in the app.',
  },
  {
    name: 'popup-shadow-color',
    group: 'chrome',
    usage: 'POPUP_SHADOW (theme.rs:172). Colour of popup-shadow.',
  },
  {
    name: 'balloon-shadow-color',
    group: 'chrome',
    usage: 'BALLOON_SHADOW (theme.rs:340). Colour of balloon-shadow.',
  },
  {
    name: 'avatar-1-start',
    group: 'chrome',
    usage:
      'theme.rs:290-300. Project avatar gradient 1, top-right stop (letters in white JetBrains Mono semibold).',
  },
  { name: 'avatar-1-end', group: 'chrome', usage: 'Project avatar gradient 1, bottom-left stop.' },
  {
    name: 'avatar-2-start',
    group: 'chrome',
    usage:
      'theme.rs:290-300. Project avatar gradient 2, top-right stop (letters in white JetBrains Mono semibold).',
  },
  { name: 'avatar-2-end', group: 'chrome', usage: 'Project avatar gradient 2, bottom-left stop.' },
  {
    name: 'avatar-3-start',
    group: 'chrome',
    usage:
      'theme.rs:290-300. Project avatar gradient 3, top-right stop (letters in white JetBrains Mono semibold).',
  },
  { name: 'avatar-3-end', group: 'chrome', usage: 'Project avatar gradient 3, bottom-left stop.' },
  {
    name: 'avatar-4-start',
    group: 'chrome',
    usage:
      'theme.rs:290-300. Project avatar gradient 4, top-right stop (letters in white JetBrains Mono semibold).',
  },
  { name: 'avatar-4-end', group: 'chrome', usage: 'Project avatar gradient 4, bottom-left stop.' },
  {
    name: 'avatar-5-start',
    group: 'chrome',
    usage:
      'theme.rs:290-300. Project avatar gradient 5, top-right stop (letters in white JetBrains Mono semibold).',
  },
  { name: 'avatar-5-end', group: 'chrome', usage: 'Project avatar gradient 5, bottom-left stop.' },
  {
    name: 'avatar-6-start',
    group: 'chrome',
    usage:
      'theme.rs:290-300. Project avatar gradient 6, top-right stop (letters in white JetBrains Mono semibold).',
  },
  { name: 'avatar-6-end', group: 'chrome', usage: 'Project avatar gradient 6, bottom-left stop.' },
  {
    name: 'avatar-7-start',
    group: 'chrome',
    usage:
      'theme.rs:290-300. Project avatar gradient 7, top-right stop (letters in white JetBrains Mono semibold).',
  },
  { name: 'avatar-7-end', group: 'chrome', usage: 'Project avatar gradient 7, bottom-left stop.' },
  {
    name: 'avatar-8-start',
    group: 'chrome',
    usage:
      'theme.rs:290-300. Project avatar gradient 8, top-right stop (letters in white JetBrains Mono semibold).',
  },
  { name: 'avatar-8-end', group: 'chrome', usage: 'Project avatar gradient 8, bottom-left stop.' },
  {
    name: 'avatar-9-start',
    group: 'chrome',
    usage:
      'theme.rs:290-300. Project avatar gradient 9, top-right stop (letters in white JetBrains Mono semibold).',
  },
  { name: 'avatar-9-end', group: 'chrome', usage: 'Project avatar gradient 9, bottom-left stop.' },
] as const;
