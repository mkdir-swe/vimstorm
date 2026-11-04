/**
 * The built-in themes' values, one per colour token (`theme-tokens.ts`); `{other}` is an alias: the
 * token follows that one (in a theme over it too). Islands Dark is DS 2.0's own values (each
 * token's `usage` names its source); Islands Light is WebStorm's Islands Light, each value's source
 * noted as `app/src/ui/theme.rs` does.
 */

/** Islands Dark: DS 2.0's values, as `app/src/ui/theme.rs` and `nvim/lua/darcula.lua` draw them. */
export const ISLANDS_DARK = {
  'frame-bg': '#26282b',
  'panel-bg': '#191a1c',
  'editor-bg': '#1e1f22',
  'editor-caret-row-bg': '#2b2d30',
  'popup-bg': '#26282b',
  'popup-header-bg': '{popup-bg}',
  'popup-ad-bg': '{popup-bg}',
  'speed-search-bg': '#191a1c',
  'tab-strip-bg': '#191a1c',
  'toolbar-bg': '#26282b',
  'status-bar-bg': '#26282b',
  'tooltip-bg': '#323438',
  'balloon-bg': '#323438',
  'field-bg': '#191a1c',
  'commit-message-bg': '{editor-bg}',
  'excluded-row-bg': '#291f1c',
  'library-root-row-bg': '{excluded-row-bg}',
  'test-row-bg': '#1c261c',
  'vcs-log-hover-bg': '#292a2c',
  'vcs-log-current-branch-bg': '#283044',
  'diff-separators-bg': '#2b2d30',
  'diff-divider-bg': '{editor-bg}',
  'stripe-hover-bg': '#0f0f0f28',
  'abe-lane-bg': '#2b2d30',
  'island-border': '#191a1c',
  border: '#26282b',
  separator: '#323438',
  'popup-border': '{separator}',
  'tab-strip-border': '{border}',
  'toolwindow-header-border': '{border}',
  'field-border': '#43454a',
  'commit-message-border': '{field-border}',
  'button-border': '#4e5157',
  'button-disabled-border': '#393b40',
  text: '#d1d3d9',
  'text-dim': '#6f737a',
  'text-disabled': '#5a5d63',
  'selection-text': '#dfe1e5',
  'editor-fg': '#a9b7c6',
  'editor-line-number': '#4e5157',
  'editor-line-number-current': '#9da0a8',
  'tab-text': '{text}',
  'tab-text-inactive': '#afb1b6',
  'status-bar-text': '#9da0a8',
  'status-bar-text-inactive': '#85888f',
  'status-bar-separator': '{text-dim}',
  'toolbar-title-fg': '#dfe1e5',
  'popup-ad-fg': '#868a91',
  'popup-caption-fg': '{text-dim}',
  'empty-hint-text': '#868a91',
  'empty-hint-shortcut': '#548af7',
  'tooltip-fg': '#f0f1f2',
  'tooltip-shortcut-fg': '#9da0a8',
  'balloon-fg': '#f0f1f2',
  placeholder: '{text-dim}',
  'menu-shortcut-fg': '{text-dim}',
  'menu-shortcut-selected-fg': '#bbbbbb',
  'menu-disabled-fg': '{text-disabled}',
  'filter-chip-name-fg': '{text-dim}',
  'changes-count-fg': '{text-dim}',
  'vcs-log-unmatched-fg': '#808080',
  'vcs-details-committer-fg': '#808080',
  'vcs-ref-text-fg': '{text-dim}',
  'diff-icon-fg': '#ced0d6',
  'annotation-fg': '#8d9199',
  'annotation-last-commit-fg': '#ced0d6',
  link: '#6b9bfa',
  'selection-bg': '#2e436e',
  'selection-bg-inactive': '#393b40',
  'hover-bg': '#393b40',
  'editor-selection-bg': '#214283',
  'field-selection-bg': '{selection-bg}',
  'focus-border': '#3574f0',
  caret: '#bbbbbb',
  'search-match-bg': '#ba9752',
  'search-match-fg': '#000000',
  'tab-selected-bg': '#25324d',
  'tab-selected-border': '#35538f',
  'tab-selected-inactive-bg': '#2b2d30',
  'tab-selected-inactive-border': '#43454a',
  'tab-hover-bg': '#2b2d30',
  'toolbar-button-hover-bg': '#ffffff16',
  'toolbar-button-pressed-bg': '#ffffff26',
  'toolbar-dropdown-hover-bg': '#ffffff12',
  'toolbar-dropdown-pressed-bg': '#393b40',
  'status-bar-hover-bg': '#ffffff18',
  'search-field-toggle-on-bg': '#35538f',
  'search-field-toggle-on-hover-bg': '#375fad',
  'button-primary-bg': '#3574f0',
  'button-primary-fg': '#ffffff',
  'button-danger-bg': '#bd5757',
  'button-danger-border': '#9c4e4e',
  'button-danger-text': '#db5c5c',
  'scrollbar-thumb': '#80808059',
  'scrollbar-thumb-hover': '#8080808c',
  'text-error': '#db5c5c',
  'text-warning': '#ba9752',
  'text-success': '#5fad65',
  'tree-problem-underline': '#fa6675',
  'merge-done-fg': '#57965c',
  'abe-good': '#73bd79',
  'abe-bad': '#db5c5c',
  'abe-warn': '#d6ae58',
  'abe-needs-you': '#5ec8c0', // teal: its own hue, apart from purple's file and branch icons
  'abe-accent': '#6b9bfa',
  'abe-person': '#cf84cf',
  'abe-path': '#70aeff',
  'abe-card-title': '#dfe1e5',
  'abe-bug': '#e88f89',
  'abe-story': '#9da0a8',
  'abe-points': '#6897bb',
  'abe-tags': '#e8bf6a',
  'abe-lane-mark': '#9876aa',
  'git-modified': '#70aeff',
  'git-added': '#73bd79',
  'git-untracked': '#e88f89',
  'git-ignored': '#d69a6b',
  'git-deleted': '#6f737a',
  'git-conflict': '#de6a66',
  'git-merged': '#cf84cf',
  'vcs-ref-head': '#f5d273',
  'vcs-ref-local': '#5fad65',
  'vcs-ref-remote': '#b589ec',
  'vcs-ref-tag': '#868a91',
  'vcs-log-graph-main': '#99783d',
  'blame-1': '#2f5194',
  'blame-2': '#2d416b',
  'blame-3': '#283754',
  'blame-4': '#242d42',
  'blame-5': '#22252e',
  'diff-inserted-bg': '#294436',
  'diff-deleted-bg': '#484a4a',
  'diff-modified-bg': '#385570',
  'diff-conflict-bg': '#45302b',
  'diff-inserted-ignored': '#222e2a',
  'diff-deleted-ignored': '#2f3032',
  'diff-modified-ignored': '#283541',
  'diff-conflict-ignored': '#2e2626',
  'diff-inserted-stripe': '#447152',
  'diff-deleted-stripe': '#656e76',
  'diff-modified-stripe': '#43698d',
  'diff-conflict-stripe': '#8f5247',
  'gutter-added': '#549159',
  'gutter-modified': '#375fad',
  'gutter-deleted': '#868a91',
  'gutter-whitespace-modified': '#52433d',
  'syntax-bg-alt': '#2b2d30',
  'syntax-fg-bright': '#dfe1e5',
  'syntax-selection': '#214283',
  'syntax-search': '#32593d',
  'syntax-search-cur': '#155221',
  'syntax-ref': '#344134',
  'syntax-ref-write': '#40332b',
  'syntax-brace-bg': '#326146',
  'syntax-brace-fg': '#ced9d2',
  'syntax-keyword': '#cc7832',
  'syntax-string': '#6a8759',
  'syntax-number': '#6897bb',
  'syntax-comment': '#808080',
  'syntax-doc': '#629755',
  'syntax-jsdoc-tag': '#8a653b',
  'syntax-func': '#ffc66d',
  'syntax-field': '#9876aa',
  'syntax-type-param': '#507874',
  'syntax-tag': '#e8bf6a',
  'syntax-attr': '#bababa',
  'syntax-attr-val': '#a5c261',
  'syntax-decorator': '#bbb529',
  'syntax-todo': '#a8c023',
  'syntax-entity': '#6d9cbe',
  'syntax-link': '#287bde',
  'syntax-error': '#bc3f3c',
  'syntax-error-fg': '#f75464',
  'syntax-error-bg': '#402929',
  'syntax-warn': '#be9117',
  'syntax-warn-bg': '#3d3322',
  'syntax-info': '#aeae80',
  'syntax-hint': '#8d9199',
  'syntax-unnecessary': '#72737a',
  'syntax-inlay-fg': '#787878',
  'syntax-inlay-bg': '#3b3b3b',
  'syntax-whitespace': '#606060',
  'syntax-bookmark-fg': '#f2c55c',
  'syntax-bookmark-bg': '#3d3223',
  'syntax-fold-fg': '#8c8c8c',
  'syntax-fold-bg': '#3a3a3a',
  'syntax-pmenu-match': '#548af7',
  'icon-blue': '#548af7',
  'icon-yellow': '#f2c55c',
  'icon-gold': '#d6ae58',
  'icon-purple': '#b589ec',
  'icon-red': '#db5c5c',
  'icon-green': '#57965c',
  'icon-orange': '#c77d55',
  'icon-pink': '#cd669a',
  'icon-gray': '#ced0d6',
  'float-menu-bg': '#2b2d30',
  'float-menu-fg': '#b4b8bf',
  'float-menu-match-fg': '#548af7',
  'float-doc-bg': '#2b2d30',
  'float-doc-dim-fg': '#868a91',
  'float-inline-code-bg': '#3f4145',
  'float-signature-border': '#313234',
  'float-signature-active-bg': '#252d26',
  'md-code-bg': '#d4dee719',
  'md-quote-border': '#6b9bfa66',
  'chat-card-bg': '#43454a',
  'chat-card-border': '#4d4d4d',
  'chat-accept-hover-bg': '#366acf',
  'chat-inline-code-bg': '#55575c',
  'mode-normal-bg': '#393b40',
  'mode-normal-fg': '#ced0d6',
  'mode-insert-bg': '#2e436e',
  'mode-insert-fg': '#dfe1e5',
  'mode-visual-bg': '#433358',
  'mode-visual-fg': '#dfe1e5',
  'mode-replace-bg': '#5e3838',
  'mode-replace-fg': '#dfe1e5',
  'mode-command-bg': '#43454a',
  'mode-command-fg': '#dfe1e5',
  'term-black': '#000000',
  'term-red': '#f27481',
  'term-green': '#6bcc62',
  'term-yellow': '#e0ce70',
  'term-blue': '#5594fa',
  'term-magenta': '#c092fa',
  'term-cyan': '#47ccbd',
  'term-white': '#ced0d6',
  'term-bright-black': '#4e5157',
  'term-bright-red': '#ff6b7a',
  'term-bright-green': '#67ff59',
  'term-bright-yellow': '#ffec1a',
  'term-bright-blue': '#3399ff',
  'term-bright-magenta': '#d970ff',
  'term-bright-cyan': '#40ffe9',
  'term-bright-white': '#ffffff',
  'term-fg': '#bbbbbb',
  'term-find-bg': '#ffea00',
  'term-find-current-bg': '#ff941a',
  'term-float-backdrop': '#00000066',
  'popup-shadow-color': '#00000020',
  'balloon-shadow-color': '#00000010',
  'avatar-1-start': '#e08855',
  'avatar-1-end': '#e9806f',
  'avatar-2-start': '#b08b14',
  'avatar-2-end': '#bb7f19',
  'avatar-3-start': '#a1a359',
  'avatar-3-end': '#87aa59',
  'avatar-4-start': '#3b92b8',
  'avatar-4-end': '#6183ec',
  'avatar-5-start': '#3574f0',
  'avatar-5-end': '#7a64f0',
  'avatar-6-start': '#c84d8f',
  'avatar-6-end': '#a956cf',
  'avatar-7-start': '#955ae0',
  'avatar-7-end': '#a84de0',
  'avatar-8-start': '#24a394',
  'avatar-8-end': '#279ccd',
  'avatar-9-start': '#5fad65',
  'avatar-9-end': '#3d968b',
} as const;

/**
 * Islands Light: WebStorm 2025.3's Islands Light (ManyIslandsLight and its parents, the "Light"
 * editor scheme), each value's source beside it. Sources (jars under /Applications/WebStorm.app/Contents):
 *   MIL: lib/app.jar!/themes/islands/ManyIslandsLight.theme.json (Islands Light; parentTheme ExperimentalLightWithLightHeader, editorScheme "Light")
 *   EXPLH: lib/app.jar!/themes/expUI/expUI_light_with_light_header.theme.json (parentTheme ExperimentalLight)
 *   EXPL: lib/app.jar!/themes/expUI/expUI_light.theme.json (palette Gray1..14, Blue1..13 ...; parentTheme IntelliJ)
 *   IJ: lib/app.jar!/themes/intellijlaf.theme.json (base light LaF)
 *   LS: lib/app.jar!/themes/expUI/expUI_lightScheme.xml (editor scheme "Light", parent_scheme "Default" = lib/app.jar!/DefaultColorSchemesManager.xml, plus plugins/javascript-plugin/lib/javascript-plugin.jar!/colorSchemes/Default.xml)
 *   icons: lib/app.jar!/expui/** and plugins/javascript-plugin/lib/javascript-plugin-frontend.jar!/icons/expui/** (light = file without _dark)
 *   Copilot: ~/Library/Application Support/JetBrains/WebStorm2025.3/plugins/github-copilot-intellij/lib/core-1.16.1-251.jar (constant pools)
 *   markdown: plugins/markdown/lib/markdown.jar!/org/intellij/plugins/markdown/ui/preview/PreviewStyleScheme$Companion.class
 */
export const ISLANDS_LIGHT = {
  'frame-bg': '#ebecf0', // MIL "MainWindow.background"=BackgroundDark=Gray12
  'panel-bg': '#ffffff', // MIL "ToolWindow.background"=BackgroundMid=Gray14
  'editor-bg': '#ffffff', // LS TEXT bg
  'editor-caret-row-bg': '#f5f8fe', // LS CARET_ROW_COLOR
  'popup-bg': '#ffffff', // MIL "Popup.background"=PopupBackground=Gray14
  'popup-header-bg': '{popup-bg}', // MIL "Popup.Header.activeBackground"=PopupBackground (= popup-bg)
  'popup-ad-bg': '#f7f8fa', // MIL "Popup.Advertiser.background"=PopupBackgroundDark=Gray13 (own value in light)
  'speed-search-bg': '#ffffff', // EXPL "SpeedSearch.background"=Gray14 (MIL sets none)
  'tab-strip-bg': '#ffffff', // MIL "EditorTabs.background"=BackgroundLight=Gray14
  'toolbar-bg': '#ebecf0', // MIL "MainToolbar.background"=BackgroundDark=Gray12
  'status-bar-bg': '#ebecf0', // MIL "StatusBar.background"=BackgroundDark=Gray12
  'tooltip-bg': '#ffffff', // MIL "ToolTip.background"=TooltipBackground=Gray14
  'balloon-bg': '#ffffff', // EXPLH "Notification.background"=Gray14 (MIL sets none)
  'field-bg': '#ffffff', // EXPL "TextField.background"=Gray14
  'commit-message-bg': '{editor-bg}', // UISpec.COMMIT_EDITOR_COLOR = scheme bg (LS TEXT bg)
  'excluded-row-bg': '#fff9eb', // MIL "FileColor.Yellow"
  'library-root-row-bg': '{excluded-row-bg}', // same scope / colour as excluded-row-bg (MIL "FileColor.Yellow")
  'test-row-bg': '#edfaef', // MIL "FileColor.Green"
  'vcs-log-hover-bg': '#e9eaec', // EXPL "VersionControl.Log.Commit.hoveredBackground"
  'vcs-log-current-branch-bg': '#edf3ff', // EXPL "VersionControl.Log.Commit.currentBranchBackground"
  'diff-separators-bg': '#e4e6eb', // LS DIFF_SEPARATORS_BACKGROUND
  'diff-divider-bg': '{editor-bg}', // DiffDrawUtil.getDividerColor = gutter bg = editor bg
  'stripe-hover-bg': '#ebecf0', // EXPL "ToolWindow.Button.hoverBackground"=Gray12 (set in light; dark fell back to Gray.x0F a40)
  'abe-lane-bg': '#ebecf0', // MIL "EditorTabs.inactiveUnderlinedTabBackground"=Gray12
  'island-border': '#ffffff', // MIL "Island.borderColor"=BackgroundMid=Gray14
  border: '#ebecf0', // MIL "Borders.color"=BorderDark=Gray12
  separator: '#ebecf0', // EXPL "*.separatorColor"/"OnePixelDivider.background"=Gray12 (MIL sets none)
  'popup-border': '#dfe1e5', // MIL "Popup.borderColor"=PopupBorder=Gray11 (own value in light)
  'tab-strip-border': '{border}', // MIL "EditorTabs.underTabsBorderColor"=BackgroundDark=Gray12 (= border)
  'toolwindow-header-border': '{border}', // MIL "ToolWindow.Header.borderColor"=BorderDark (= border)
  'field-border': '#c9ccd6', // EXPL "Component.borderColor"=Gray9
  'commit-message-border': '{field-border}', // CommitInputBorder: Component.borderColor
  'button-border': '#c9ccd6', // EXPL "Button.startBorderColor"=Gray9
  'button-disabled-border': '#dfe1e5', // EXPL "*.disabledBorderColor"=Gray11
  text: '#000000', // IJ "Label.foreground"/"*.foreground"=black (MIL / EXPL set none)
  'text-dim': '#818594', // EXPL "*.infoForeground"=Gray7
  'text-disabled': '#a8adbd', // EXPL "*.disabledForeground"=Gray8
  'selection-text': '#000000', // EXPL "*.selectionForeground"=Gray1
  'editor-fg': '#080808', // LS TEXT fg (080808)
  'editor-line-number': '#aeb3c2', // LS LINE_NUMBERS_COLOR
  'editor-line-number-current': '#767a8a', // LS LINE_NUMBER_ON_CARET_ROW_COLOR
  'tab-text': '{text}', // selected / hovered: plain fg
  'tab-text-inactive': '#515151', // derived: EXPL "EditorTabs.unselectedBlend" 0.9, ColorUtil.blendColorsInRgb(tab-strip-bg #ffffff, text #000000)
  'status-bar-text': '#6c707e', // EXPL "StatusBar.Widget.foreground"=Gray6
  'status-bar-text-inactive': '#858995', // derived: MIL "Island.inactiveAlphaInStatusBar" 0.2 -> status-bar-text Gray6 at 80% on frame-bg
  'status-bar-separator': '{text-dim}', // = text-dim
  'toolbar-title-fg': '#000000', // EXPLH "MainToolbar.foreground"=Gray1
  'popup-ad-fg': '#818594', // EXPL "Popup.Advertiser.foreground"=Gray7
  'popup-caption-fg': '{text-dim}', // EXPL "*.separatorForeground"=Gray7 (= text-dim)
  'empty-hint-text': '#6c707e', // derived: dark Gray8 -> light Gray6 (the icon / tag-icon grey step, as EXPL "VersionControl.GitLog.tagIconColor")
  'empty-hint-shortcut': '#3574f0', // derived: dark EXP Blue8 (CompletionPopup.matchForeground role) -> EXPL "CompletionPopup.matchForeground"=Blue4
  'tooltip-fg': '#000000', // EXPLH "ToolTip.foreground"=Gray1
  'tooltip-shortcut-fg': '#818594', // EXPLH "ToolTip.shortcutForeground"=Gray7
  'balloon-fg': '#000000', // EXPLH "Notification.foreground"=Gray1
  placeholder: '{text-dim}', // Gray7 (= text-dim)
  'menu-shortcut-fg': '{text-dim}', // EXPL "*.acceleratorForeground"=Gray7 (= text-dim)
  'menu-shortcut-selected-fg': '#818594', // EXPL "*.acceleratorSelectionForeground"=Gray7
  'menu-disabled-fg': '{text-disabled}', // EXPL "*.disabledForeground"=Gray8 (= text-disabled)
  'filter-chip-name-fg': '{text-dim}', // UIUtil.getLabelInfoForeground = EXPL "*.infoForeground"
  'changes-count-fg': '{text-dim}', // GRAYED_ATTRIBUTES = EXPL "*.infoForeground"
  'vcs-log-unmatched-fg': '#808080', // VcsLogGraphTable: JBColor.GRAY (same both themes)
  'vcs-details-committer-fg': '#808080', // CommitPresentationUtil: JBColor.GRAY (same both themes)
  'vcs-ref-text-fg': '#6c707e', // EXPL "VersionControl.Log.Commit.Reference.foreground"=Gray6 (own value in light)
  'diff-icon-fg': '#6c707e', // expui/diff/*@14x14.svg stroke (light variant)
  'annotation-fg': '#5a5d6b', // LS ANNOTATIONS_COLOR
  'annotation-last-commit-fg': '#000000', // LS ANNOTATIONS_LAST_COMMIT_COLOR (0)
  link: '#315fbd', // EXPL "Link.activeForeground"=Blue2
  'selection-bg': '#d4e2ff', // EXPL "*.selectionBackground"=Blue11
  'selection-bg-inactive': '#dfe1e5', // EXPL "*.selectionInactiveBackground"=Gray11
  'hover-bg': '#edf3ff', // EXPL "*.hoverBackground"=Blue12 (row hover; action buttons in light use EXPL "ActionButton.hoverBackground" #00000012, see toolbar-button-hover-bg)
  'editor-selection-bg': '#a6d2ff', // LS SELECTION_BACKGROUND
  'field-selection-bg': '{selection-bg}', // EXPL "*.selectionBackground"=Blue11 (= selection-bg)
  'focus-border': '#3574f0', // EXPL "*.focusColor"=Blue4
  caret: '#000000', // IJ "*.caretForeground"=foreground (LS CARET_COLOR 0 too)
  'search-match-bg': '#fee6b1', // EXPL "SearchMatch.startBackground"/"endBackground"=Yellow7
  'search-match-fg': '#323232', // SimpleColoredComponent: JBColor(Gray._50, Gray._0) light=Gray._50
  'tab-selected-bg': '#e1ebff', // MIL "EditorTabs.underlinedTabBackground" #D4E2FFB3 composited over tab-strip-bg #ffffff
  'tab-selected-border': '#a0bdf8', // MIL "EditorTabs.underlinedBorderColor"=Blue9
  'tab-selected-inactive-bg': '#ebecf0', // MIL "EditorTabs.inactiveUnderlinedTabBackground"=Gray12
  'tab-selected-inactive-border': '#d3d5db', // MIL "EditorTabs.inactiveUnderlinedTabBorderColor"=Gray10
  'tab-hover-bg': '#f3f3f3', // MIL "EditorTabs.hoverBackground" #0000000C composited over tab-strip-bg #ffffff
  'toolbar-button-hover-bg': '#00000012', // EXPL "ActionButton.hoverBackground"
  'toolbar-button-pressed-bg': '#0000001d', // EXPL "ActionButton.pressedBackground"
  'toolbar-dropdown-hover-bg': '#0000000d', // EXPLH "MainToolbar.Dropdown.transparentHoverBackground"
  'toolbar-dropdown-pressed-bg': '#dfe1e5', // EXPLH "MainToolbar.Dropdown.pressedBackground"=Gray11
  'status-bar-hover-bg': '#00000010', // MIL "StatusBar.Widget.hoverBackground"
  'search-field-toggle-on-bg': '#d4e2ff', // EXPL "SearchOption.selectedBackground"=Blue11
  'search-field-toggle-on-hover-bg': '#c2d6fc', // EXPL "SearchOption.selectedHoveredBackground"=Blue10
  'button-primary-bg': '#3574f0', // EXPL "Button.default.startBackground"/"startBorderColor"=Blue4
  'button-primary-fg': '#ffffff', // EXPL "Button.default.foreground"=Gray14
  'button-danger-bg': '#cc3645', // derived: dark Red6 = one step under errorForeground Red7 -> light Red3, one step darker than EXPL "Label.errorForeground"=Red4 (white text 4.9:1)
  'button-danger-border': '#db3b4b', // EXPL "Component.errorFocusColor"=Red4
  'button-danger-text': '#db3b4b', // EXPL "Label.errorForeground"=Red4
  'scrollbar-thumb': '#00000033', // MIL "ScrollBar.Transparent.thumbColor"
  'scrollbar-thumb-hover': '#00000080', // MIL "ScrollBar.Transparent.hoverThumbColor"
  'text-error': '#db3b4b', // EXPL "Label.errorForeground"=Red4
  'text-warning': '#a46704', // EXPL "Label.warningForeground"=Yellow1
  'text-success': '#208a3c', // EXPL "Plugins.Button.installForeground"=Green4
  'tree-problem-underline': '#ff0000', // LS ERRORS_ATTRIBUTES EFFECT_COLOR (inherited from Default; no Islands light scheme)
  'merge-done-fg': '#5d9b47', // MergeThreesideViewer JBColor("#5D9B47", "#57965C") light
  'abe-good': '#067d17', // = git-added: LS FILESTATUS_ADDED
  'abe-bad': '#db3b4b', // = text-error: EXPL "Label.errorForeground"=Red4
  'abe-warn': '#a46704', // derived: dark Yellow6 (warning family) -> light EXPL "Label.warningForeground"=Yellow1 (lighter yellows fail contrast on white)
  'abe-needs-you': '#0e7c76', // teal: dark's #5ec8c0 darkened to 5:1 on white
  'abe-accent': '#315fbd', // = link: EXPL "Link.activeForeground"=Blue2
  'abe-person': '#643cb8', // = git-merged: LS FILESTATUS_MERGED
  'abe-path': '#0033b3', // = git-modified: LS FILESTATUS_MODIFIED
  'abe-card-title': '#000000', // = selection-text: EXPL "*.selectionForeground"=Gray1
  'abe-bug': '#b23247', // LS FILESTATUS_UNKNOWN
  'abe-story': '#6c707e', // = status-bar-text: EXPL "StatusBar.Widget.foreground"=Gray6
  'abe-points': '#1750eb', // LS DEFAULT_NUMBER
  'abe-tags': '#0033b3', // LS HTML_TAG_NAME unset -> fallback DEFAULT_KEYWORD (XmlHighlighterColors) fg; = abe-path
  'abe-lane-mark': '#871094', // LS DEFAULT_INSTANCE_FIELD
  'git-modified': '#0033b3', // LS FILESTATUS_MODIFIED
  'git-added': '#067d17', // LS FILESTATUS_ADDED
  'git-untracked': '#b23247', // LS FILESTATUS_UNKNOWN
  'git-ignored': '#8c4f00', // LS FILESTATUS_IDEA_FILESTATUS_IGNORED (2nd entry 8C4F00 wins over 7d5020)
  'git-deleted': '#6c707e', // LS FILESTATUS_DELETED
  'git-conflict': '#de1b2e', // LS FILESTATUS_IDEA_FILESTATUS_MERGED_WITH_CONFLICTS
  'git-merged': '#643cb8', // LS FILESTATUS_MERGED
  'vcs-ref-head': '#ffaf0f', // EXPL "VersionControl.GitLog.headIconColor"=Yellow4
  'vcs-ref-local': '#369650', // EXPL "VersionControl.GitLog.localBranchIconColor"=Green5
  'vcs-ref-remote': '#834df0', // EXPL "VersionControl.GitLog.remoteBranchIconColor"=Purple4
  'vcs-ref-tag': '#6c707e', // EXPL "VersionControl.GitLog.tagIconColor"/"otherIconColor"=Gray6
  'vcs-log-graph-main': '#b38c47', // derived: origin/master hue (as dark) at EXPL "VersionControl.Log.Graph.saturation" 0.6 / "brightness" 0.7
  'blame-1': '#a1bef7', // LS VCS_ANNOTATIONS_COLOR_1
  'blame-2': '#c9dafb', // LS VCS_ANNOTATIONS_COLOR_2
  'blame-3': '#dee8fc', // LS VCS_ANNOTATIONS_COLOR_3
  'blame-4': '#edf2fa', // LS VCS_ANNOTATIONS_COLOR_4
  'blame-5': '#f7f8fa', // LS VCS_ANNOTATIONS_COLOR_5
  'diff-inserted-bg': '#bee6be', // LS DIFF_INSERTED bg (inherited from Default)
  'diff-deleted-bg': '#d6d6d6', // LS DIFF_DELETED bg (inherited from Default)
  'diff-modified-bg': '#c2d8f2', // LS DIFF_MODIFIED bg
  'diff-conflict-bg': '#ffd5cc', // LS DIFF_CONFLICT bg (inherited from Default)
  'diff-inserted-ignored': '#e5f5e5', // derived: TextDiffTypeImpl.getIgnoredColor = mix(diff-inserted-bg, editor-bg, 0.6)
  'diff-deleted-ignored': '#efefef', // derived: TextDiffTypeImpl.getIgnoredColor = mix(diff-deleted-bg, editor-bg, 0.6)
  'diff-modified-ignored': '#e7effa', // derived: TextDiffTypeImpl.getIgnoredColor = mix(diff-modified-bg, editor-bg, 0.6)
  'diff-conflict-ignored': '#ffeeeb', // derived: TextDiffTypeImpl.getIgnoredColor = mix(diff-conflict-bg, editor-bg, 0.6)
  'diff-inserted-stripe': '#aadeaa', // LS DIFF_INSERTED ERROR_STRIPE_COLOR (inherited from Default)
  'diff-deleted-stripe': '#c8c8c8', // LS DIFF_DELETED ERROR_STRIPE_COLOR (inherited from Default)
  'diff-modified-stripe': '#b6d2f2', // LS DIFF_MODIFIED ERROR_STRIPE_COLOR
  'diff-conflict-stripe': '#ffc8bd', // LS DIFF_CONFLICT ERROR_STRIPE_COLOR (inherited from Default)
  'gutter-added': '#7fc784', // LS ADDED_LINES_COLOR
  'gutter-modified': '#88adf7', // LS MODIFIED_LINES_COLOR
  'gutter-deleted': '#767a8a', // LS DELETED_LINES_COLOR
  'gutter-whitespace-modified': '#f7e2cb', // LS WHITESPACES_MODIFIED_LINES_COLOR
  'syntax-bg-alt': '#f5f8fe', // LS CARET_ROW_COLOR (dark bg_alt = caret row = lookup = docs; in light LOOKUP / DOCUMENTATION are #ffffff)
  'syntax-fg-bright': '#000000', // LS BREADCRUMBS_CURRENT fg (0)
  'syntax-selection': '#a6d2ff', // LS SELECTION_BACKGROUND
  'syntax-search': '#fcd47e', // LS TEXT_SEARCH_RESULT_ATTRIBUTES bg
  'syntax-search-cur': '#ccccff', // LS SEARCH_RESULT_ATTRIBUTES bg (inherited from Default)
  'syntax-ref': '#edebfc', // LS IDENTIFIER_UNDER_CARET_ATTRIBUTES bg
  'syntax-ref-write': '#fce8f4', // LS WRITE_IDENTIFIER_UNDER_CARET_ATTRIBUTES bg
  'syntax-brace-bg': '#93d9d9', // LS MATCHED_BRACE_ATTRIBUTES bg
  'syntax-brace-fg': '#080808', // LS MATCHED_BRACE_ATTRIBUTES sets no fg -> LS TEXT fg
  'syntax-keyword': '#0033b3', // LS DEFAULT_KEYWORD fg
  'syntax-string': '#067d17', // LS DEFAULT_STRING fg
  'syntax-number': '#1750eb', // LS DEFAULT_NUMBER fg
  'syntax-comment': '#8c8c8c', // LS DEFAULT_LINE_COMMENT fg (italic in light)
  'syntax-doc': '#8c8c8c', // LS DEFAULT_DOC_COMMENT fg
  'syntax-jsdoc-tag': '#3d3d3d', // LS DEFAULT_DOC_COMMENT_TAG_VALUE fg
  'syntax-func': '#00627a', // LS DEFAULT_FUNCTION_DECLARATION fg
  'syntax-field': '#871094', // LS DEFAULT_INSTANCE_FIELD fg
  'syntax-type-param': '#007e8a', // LS TYPE_PARAMETER_NAME_ATTRIBUTES fg (TS.TYPE_PARAMETER unset in LS; Default + JS plugin has 20999D)
  'syntax-tag': '#0033b3', // LS HTML_TAG_NAME unset -> fallback DEFAULT_KEYWORD fg (XmlHighlighterColors)
  'syntax-attr': '#174ad4', // LS HTML_ATTRIBUTE_NAME unset -> fallback DEFAULT_ATTRIBUTE fg (XmlHighlighterColors)
  'syntax-attr-val': '#067d17', // LS HTML_ATTRIBUTE_VALUE unset -> fallback DEFAULT_STRING fg (XmlHighlighterColors)
  'syntax-decorator': '#9e880d', // LS DEFAULT_METADATA fg
  'syntax-todo': '#008dde', // LS TODO_DEFAULT_ATTRIBUTES fg
  'syntax-entity': '#174be6', // LS HTML_ENTITY_REFERENCE unset -> fallback DEFAULT_ENTITY fg (XmlHighlighterColors)
  'syntax-link': '#006dcc', // LS HYPERLINK_ATTRIBUTES fg (CSS.URL unset in LS)
  'syntax-error': '#ff0000', // LS ERRORS_ATTRIBUTES EFFECT_COLOR (inherited from Default)
  'syntax-error-fg': '#f50000', // LS WRONG_REFERENCES_ATTRIBUTES fg (dark f75464 = Islands Dark WRONG_REFERENCES / CONSOLE_ERROR fg)
  'syntax-error-bg': '#ffe8e8', // LS ERROR_HINT
  'syntax-warn': '#f2bf57', // LS WARNING_ATTRIBUTES ERROR_STRIPE_COLOR
  'syntax-warn-bg': '#fcf4d4', // LS WARNING_ATTRIBUTES bg
  'syntax-info': '#cccccc', // LS INFO_ATTRIBUTES EFFECT_COLOR (inherited from Default)
  'syntax-hint': '#5a5d6b', // LS ANNOTATIONS_COLOR (dark DCS ANNOTATIONS_COLOR)
  'syntax-unnecessary': '#808080', // LS NOT_USED_ELEMENT_ATTRIBUTES fg (inherited from Default)
  'syntax-inlay-fg': '#7a7a7a', // LS INLAY_DEFAULT / INLAY_TEXT_WITHOUT_BACKGROUND fg (inherited from Default)
  'syntax-inlay-bg': '#ededed', // LS INLAY_DEFAULT bg (inherited from Default)
  'syntax-whitespace': '#adadad', // LS WHITESPACES (inherited from Default)
  'syntax-bookmark-fg': '#ffaf0f', // expui/bookmarks/mnemonic.svg stroke (light variant)
  'syntax-bookmark-bg': '#fffaeb', // expui/bookmarks/mnemonic.svg fill (light variant)
  'syntax-fold-fg': '#414d41', // LS FOLDED_TEXT_ATTRIBUTES fg
  'syntax-fold-bg': '#e9f5e6', // LS FOLDED_TEXT_ATTRIBUTES bg
  'syntax-pmenu-match': '#3574f0', // EXPL "CompletionPopup.matchForeground"=Blue4
  'icon-blue': '#3574f0', // expui/fileTypes/typeScript.svg fill (light; css.svg is #4682FA)
  'icon-yellow': '#ffaf0f', // expui/fileTypes/javaScript.svg fill (light)
  'icon-gold': '#c27d04', // expui/fileTypes/jsx.svg fill (light)
  'icon-purple': '#834df0', // expui/fileTypes/json.svg fill (light)
  'icon-red': '#db3b4b', // expui/fileTypes/yaml.svg fill (light)
  'icon-green': '#369650', // expui/fileTypes/html.svg fill (light)
  'icon-orange': '#e66d17', // expui/fileTypes/xml.svg fill (light)
  'icon-pink': '#cd669a', // sass plugin expui/sass.svg fill (one variant for both themes)
  'icon-gray': '#6c707e', // expui/fileTypes/text.svg fill / expui/nodes/folder.svg stroke (light)
  'float-menu-bg': '#ffffff', // LS LOOKUP_COLOR
  'float-menu-fg': '#27282e', // EXPL "CompletionPopup.foreground"=Gray2
  'float-menu-match-fg': '#3574f0', // EXPL "CompletionPopup.matchForeground"=Blue4
  'float-doc-bg': '#ffffff', // LS DOCUMENTATION_COLOR
  'float-doc-dim-fg': '#6c707e', // derived: dark Gray8 -> light Gray6 (as empty-hint-text)
  'float-inline-code-bg': '#e6e7e9', // derived: dark = Gray10 15% over doc bg -> light Gray5 (mirror step) 15% over float-doc-bg #ffffff
  'float-signature-border': '#e7e7e7', // derived: dark = editor bg ~19% toward #808080 -> same over light editor-bg
  'float-signature-active-bg': '#e7f2ea', // derived: dark ~ 12% green over editor bg (measured) -> light Green5 12% over editor-bg
  'md-code-bg': '#d4dee73f', // markdown PreviewStyleScheme fenceBackgroundColor JBColor(Color(212,222,231,63), Color(212,222,231,25)) light
  'md-quote-border': '#315fbd66', // PreviewLAFThemeStyles blockquote border = Link.activeForeground (EXPL Blue2) at 0.4
  'chat-card-bg': '#f9fafb', // Copilot 1.16.1 Style$Colors$InlineChat.background new UI JBColor(F9FAFB, 43454A) light
  'chat-card-border': '#d3d5db', // Copilot Style$Colors$InlineChat.border JBColor(D3D5DB, 4D4D4D) light
  'chat-accept-hover-bg': '#3369d6', // Copilot CopilotPalette$Button.primaryBgHover JBColor(3369D6, 366ACF) light
  'chat-inline-code-bg': '#e1e2e5', // derived: as float-inline-code-bg, Gray5 15% over chat-card-bg
  'mode-normal-bg': '#dfe1e5', // derived: dark Gray3 (= selection-bg-inactive) -> light selection-bg-inactive Gray11
  'mode-normal-fg': '#27282e', // derived: dark Gray11 (one step under the others' Gray12) -> light Gray2
  'mode-insert-bg': '#d4e2ff', // derived: dark = selection-bg Blue2 -> light selection-bg Blue11
  'mode-insert-fg': '#000000', // derived: dark Gray12 (selection-text) -> light Gray1
  'mode-visual-bg': '#dccbfb', // derived: dark muted Purple3 -> light pale Purple7
  'mode-visual-fg': '#000000', // derived: as mode-insert-fg
  'mode-replace-bg': '#fad4d8', // derived: dark muted Red3 -> light pale Red9
  'mode-replace-fg': '#000000', // derived: as mode-insert-fg
  'mode-command-bg': '#c9ccd6', // derived: dark = field-border Gray4 -> light field-border Gray9
  'mode-command-fg': '#000000', // derived: as mode-insert-fg
  'term-black': '#000000', // LS BLOCK_TERMINAL_BLACK fg (inherited from Default)
  'term-red': '#c93645', // LS BLOCK_TERMINAL_RED fg (inherited from Default)
  'term-green': '#357d1f', // LS BLOCK_TERMINAL_GREEN fg (inherited from Default)
  'term-yellow': '#b2a400', // LS BLOCK_TERMINAL_YELLOW fg (inherited from Default)
  'term-blue': '#225cd6', // LS BLOCK_TERMINAL_BLUE fg (inherited from Default)
  'term-magenta': '#6e32e5', // LS BLOCK_TERMINAL_MAGENTA fg (inherited from Default)
  'term-cyan': '#007a80', // LS BLOCK_TERMINAL_CYAN fg (inherited from Default)
  'term-white': '#bec0c5', // LS BLOCK_TERMINAL_WHITE fg (inherited from Default)
  'term-bright-black': '#6c707e', // LS BLOCK_TERMINAL_BLACK_BRIGHT fg (inherited from Default)
  'term-bright-red': '#ff5462', // LS BLOCK_TERMINAL_RED_BRIGHT fg (inherited from Default)
  'term-bright-green': '#3dcc3d', // LS BLOCK_TERMINAL_GREEN_BRIGHT fg (inherited from Default)
  'term-bright-yellow': '#d4bb00', // LS BLOCK_TERMINAL_YELLOW_BRIGHT fg (inherited from Default)
  'term-bright-blue': '#009dff', // LS BLOCK_TERMINAL_BLUE_BRIGHT fg (inherited from Default)
  'term-bright-magenta': '#d659ff', // LS BLOCK_TERMINAL_MAGENTA_BRIGHT fg (inherited from Default)
  'term-bright-cyan': '#31c4b3', // LS BLOCK_TERMINAL_CYAN_BRIGHT fg (inherited from Default)
  'term-bright-white': '#d2d4d9', // LS BLOCK_TERMINAL_WHITE_BRIGHT fg (inherited from Default)
  'term-fg': '#000000', // LS CONSOLE_NORMAL_OUTPUT fg (inherited from Default)
  'term-find-bg': '#ffea00', // LS BLOCK_TERMINAL_SEARCH_ENTRY bg (same both themes)
  'term-find-current-bg': '#ff941a', // LS BLOCK_TERMINAL_CURRENT_SEARCH_ENTRY bg (same both themes)
  'term-float-backdrop': '#00000066', // derived: own scrim literal, kept
  'popup-shadow-color': '#00000010', // EXPL "Ide.Shadow.*1Color"
  'balloon-shadow-color': '#a0a0a010', // EXPLH "Notification.Shadow.*1Color"
  'avatar-1-start': '#e08855', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-1-end': '#e9806f', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-2-start': '#b08b14', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-2-end': '#bb7f19', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-3-start': '#a1a359', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-3-end': '#87aa59', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-4-start': '#3b92b8', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-4-end': '#6183ec', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-5-start': '#3574f0', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-5-end': '#7a64f0', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-6-start': '#c84d8f', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-6-end': '#a956cf', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-7-start': '#955ae0', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-7-end': '#a84de0', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-8-start': '#24a394', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-8-end': '#279ccd', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-9-start': '#5fad65', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
  'avatar-9-end': '#3d968b', // copied from dark (EXP "RecentProject.ColorN.Avatar.*"; same gradients in light)
} as const;

/**
 * Dark Modern (#121, Feel `vscode`): VS Code's default dark theme over Islands Dark, from VS Code's
 * `theme-defaults/themes/dark_modern.json` (chrome) and `dark_plus.json` (syntax, terminal); a
 * `#RRGGBBAA` of VS Code's is blended over its editor ground #1F1F1F. Tokens VS Code has no
 * colour for keep Islands Dark's.
 */
export const DARK_MODERN = {
  ...ISLANDS_DARK,
  'frame-bg': '#181818',
  'panel-bg': '#181818',
  'editor-bg': '#1f1f1f',
  'editor-caret-row-bg': '#282828',
  'popup-bg': '#222222',
  'popup-header-bg': '#2b2b2b',
  'tab-strip-bg': '#181818',
  'toolbar-bg': '#181818',
  'status-bar-bg': '#181818',
  'tooltip-bg': '#202020',
  'balloon-bg': '#1f1f1f',
  'field-bg': '#313131',
  'commit-message-bg': '#1f1f1f',
  'island-border': '#2b2b2b',
  border: '#2b2b2b',
  separator: '#2b2b2b',
  'popup-border': '#454545',
  'tab-strip-border': '#2b2b2b',
  'toolwindow-header-border': '#2b2b2b',
  'field-border': '#3c3c3c',
  'commit-message-border': '#3c3c3c',
  'button-border': '#3c3c3c',
  text: '#cccccc',
  'text-dim': '#9d9d9d',
  'text-disabled': '#6e6e6e',
  'selection-text': '#ffffff',
  'editor-fg': '#cccccc',
  'editor-line-number': '#6e7681',
  'editor-line-number-current': '#cccccc',
  'tab-text': '#ffffff',
  'tab-text-inactive': '#9d9d9d',
  'status-bar-text': '#cccccc',
  'status-bar-text-inactive': '#9d9d9d',
  'status-bar-separator': '#2b2b2b',
  'toolbar-title-fg': '#cccccc',
  placeholder: '#989898',
  'tooltip-fg': '#cccccc',
  'balloon-fg': '#cccccc',
  link: '#4daafc',
  'selection-bg': '#04395e',
  'selection-bg-inactive': '#37373d',
  'hover-bg': '#2a2d2e',
  'editor-selection-bg': '#264f78',
  'field-selection-bg': '#264f78',
  'focus-border': '#0078d4',
  caret: '#aeafad',
  'search-match-bg': '#633315',
  'tab-selected-bg': '#1f1f1f',
  'tab-selected-border': '#0078d4',
  'tab-selected-inactive-bg': '#1f1f1f',
  'tab-selected-inactive-border': '#2b2b2b',
  'tab-hover-bg': '#1f1f1f',
  'toolbar-button-hover-bg': '#2b2b2b',
  'status-bar-hover-bg': '#2b2b2b',
  'button-primary-bg': '#0078d4',
  'button-primary-fg': '#ffffff',
  'scrollbar-thumb': '#434343',
  'scrollbar-thumb-hover': '#4f4f4f',
  'text-error': '#f85149',
  'text-warning': '#cca700',
  'text-success': '#73c991',
  'git-modified': '#e2c08d',
  'git-added': '#81b88b',
  'git-untracked': '#73c991',
  'git-ignored': '#8c8c8c',
  'git-deleted': '#c74e39',
  'git-conflict': '#e4676b',
  'diff-inserted-bg': '#383e2a',
  'diff-deleted-bg': '#4c1919',
  'diff-modified-bg': '#193143',
  'gutter-added': '#2ea043',
  'gutter-modified': '#0078d4',
  'gutter-deleted': '#f85149',
  'syntax-keyword': '#569cd6',
  'syntax-string': '#ce9178',
  'syntax-number': '#b5cea8',
  'syntax-comment': '#6a9955',
  'syntax-doc': '#6a9955',
  'syntax-func': '#dcdcaa',
  'syntax-field': '#9cdcfe',
  'syntax-type-param': '#4ec9b0',
  'syntax-tag': '#569cd6',
  'syntax-attr': '#9cdcfe',
  'syntax-attr-val': '#ce9178',
  'syntax-decorator': '#dcdcaa',
  'syntax-entity': '#d7ba7d',
  'syntax-error': '#f14c4c',
  'syntax-warn': '#cca700',
  'syntax-info': '#3794ff',
  'term-black': '#000000',
  'term-red': '#cd3131',
  'term-green': '#0dbc79',
  'term-yellow': '#e5e510',
  'term-blue': '#2472c8',
  'term-magenta': '#bc3fbc',
  'term-cyan': '#11a8cd',
  'term-white': '#e5e5e5',
  'term-bright-black': '#666666',
  'term-bright-red': '#f14c4c',
  'term-bright-green': '#23d18b',
  'term-bright-yellow': '#f5f543',
  'term-bright-blue': '#3b8eea',
  'term-bright-magenta': '#d670d6',
  'term-bright-cyan': '#29b8db',
  'term-bright-white': '#e5e5e5',
  'term-fg': '#cccccc',
} as const;
