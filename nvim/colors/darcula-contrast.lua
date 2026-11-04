-- Darcula Contrast, matching WebStorm's scheme (Darcula syntax + new-UI contrast chrome).
-- Values from WebStorm.app: lib/app.jar themes/expUI/expUI_darculaContrastScheme.xml (parent: "Darcula" in
-- DefaultColorSchemesManager.xml), themes/islands/ManyIslandsDark.theme.json (tool window chrome),
-- plugins' colorSchemes/*Darcula.xml, and the TextAttributesKey fallbacks in the language plugins.
-- The app draws its chrome natively (app/src/look/theme.rs): these are the editor grid's colors, the colors Lua
-- reads for app payloads (menus, floats, picker previews) and the few nvim floats / snacks fallback pickers.
-- Treesitter capture splits: after/queries/.
local c = require("darcula")
-- a look (config/app/look.lua) may make it light: 'background' first, so `highlight clear` puts
-- back nvim's defaults for it (unnamed meanwhile: setting it would load this file again)
local background = c.light and "light" or "dark"
if vim.o.background ~= background then
  vim.g.colors_name = nil
  vim.o.background = background
end
vim.cmd("highlight clear")
vim.g.colors_name = "darcula-contrast"

local hl = function(group, opts) vim.api.nvim_set_hl(0, group, opts) end

local groups = {
  -- Editor chrome
  Normal = { fg = c.fg, bg = c.bg },
  NormalNC = { fg = c.fg, bg = c.bg },
  NormalFloat = { fg = c.fg, bg = c.bg_alt },
  -- popup border edges of 'winborder' (config/popup.lua): the popup fill (NormalFloat) over the editor bg
  FloatBorder = { fg = c.bg_alt, bg = c.bg },
  FloatTitle = { fg = c.fg_bright, bg = c.bg_alt, bold = true },
  Cursor = { fg = c.bg, bg = c.caret },
  CursorLine = { bg = c.bg_alt },
  CursorColumn = { bg = c.bg_alt },
  ColorColumn = { bg = c.bg_alt },
  LineNr = { fg = c.line_nr },
  -- the caret row's band (CARET_ROW_COLOR) runs through the gutter too, like WebStorm's: number, change bar, fold
  CursorLineNr = { fg = c.line_nr_cur, bg = c.bg_alt }, -- LINE_NUMBER_ON_CARET_ROW_COLOR
  CursorLineSign = { bg = c.bg_alt },
  CursorLineFold = { fg = c.line_nr, bg = c.bg_alt },
  SignColumn = { bg = c.bg },
  FoldColumn = { fg = c.line_nr, bg = c.bg },
  Folded = { fg = c.fg, bg = c.bg }, -- a closed region's line: plain code, the placeholder is WsFoldPlaceholder
  WinSeparator = { fg = "#26282b", bg = "#191a1c" },
  VertSplit = { link = "WinSeparator" },
  StatusLine = { fg = c.line_nr_cur, bg = c.bg_alt },
  StatusLineNC = { fg = c.fg_dim, bg = c.bg_alt },
  TabLine = { fg = c.fg_dim, bg = c.bg_alt },
  TabLineSel = { fg = c.fg_bright, bg = c.bg },
  TabLineFill = { bg = c.bg_alt },
  Visual = { bg = c.selection },
  -- Find: other matches TEXT_SEARCH_RESULT green, the current one is selected (SELECTION_BACKGROUND)
  Search = { bg = c.search },
  IncSearch = { bg = c.selection },
  CurSearch = { bg = c.selection },
  Substitute = { bg = c.search_cur }, -- SEARCH_RESULT_ATTRIBUTES
  MatchParen = { fg = c.brace_fg, bg = c.brace_bg, bold = true },
  -- Completion: LOOKUP_COLOR bg, CompletionPopup.foreground Gray10, matchForeground Blue8
  Pmenu = { fg = c.pmenu_fg, bg = c.bg_alt },
  PmenuSel = { fg = c.text_ui, bg = c.pmenu_sel },
  PmenuMatch = { fg = c.pmenu_match },
  PmenuMatchSel = { fg = c.pmenu_match },
  PmenuKind = { fg = c.fg_dim, bg = c.bg_alt },
  PmenuExtra = { fg = c.fg_dim, bg = c.bg_alt },
  PmenuSbar = { bg = c.bg_alt },
  PmenuThumb = { bg = c.line_nr },
  NonText = { fg = c.whitespace }, -- WHITESPACES
  Whitespace = { fg = c.whitespace },
  EndOfBuffer = { fg = c.bg },
  Directory = { fg = c.text_ui },
  Title = { fg = c.fg_bright, bold = true },
  ErrorMsg = { fg = c.error_fg },
  WarningMsg = { fg = c.warn },
  MoreMsg = { fg = c.string },
  Question = { fg = c.string },
  ModeMsg = { fg = c.fg },
  WildMenu = { bg = c.pmenu_sel },
  QuickFixLine = { bg = c.pmenu_sel },
  SpellBad = { sp = "#659c6b", undercurl = true }, -- TYPO
  SpellCap = { sp = "#659c6b", undercurl = true },
  SpellRare = { sp = "#659c6b", undercurl = true },
  SpellLocal = { sp = "#659c6b", undercurl = true },

  -- Syntax (Darcula DEFAULT_* attributes: comments plain, only doc comments italic)
  Comment = { fg = c.comment },
  Constant = { fg = c.field, italic = true },
  String = { fg = c.string },
  Character = { fg = c.string },
  Number = { fg = c.number },
  Float = { fg = c.number },
  Boolean = { fg = c.keyword },
  Identifier = { fg = c.fg },
  Function = { fg = c.func }, -- DEFAULT_FUNCTION_DECLARATION (calls stay default text)
  Statement = { fg = c.keyword },
  Keyword = { fg = c.keyword },
  Conditional = { fg = c.keyword },
  Repeat = { fg = c.keyword },
  Label = { fg = c.keyword },
  Exception = { fg = c.keyword },
  Operator = { fg = c.fg },
  PreProc = { fg = c.keyword },
  Include = { fg = c.keyword },
  Type = { fg = c.fg },
  StorageClass = { fg = c.keyword },
  Structure = { fg = c.keyword },
  Typedef = { fg = c.keyword },
  Special = { fg = c.keyword },
  SpecialChar = { fg = c.keyword },
  Tag = { fg = c.tag },
  Delimiter = { fg = c.fg },
  SpecialComment = { fg = c.doc, italic = true },
  Underlined = { underline = true },
  Error = { fg = c.error_fg },
  Todo = { fg = c.todo, italic = true }, -- TODO_DEFAULT_ATTRIBUTES

  -- Treesitter. WebStorm JS/TS keys and their fallbacks (javascript-plugin JavaScriptHighlightDescriptor):
  -- locals/params/classes/interfaces/imports = default text, properties = JS.INSTANCE_MEMBER_VARIABLE purple,
  -- methods = JS.INSTANCE_MEMBER_FUNCTION gold (also at call sites), function declarations gold but calls of
  -- imported/local functions plain, lib globals (console, window) = JS.GLOBAL_VARIABLE purple bold italic,
  -- only , and ; orange (DEFAULT_COMMA/SEMICOLON). after/queries/{typescript,javascript} split the captures.
  ["@variable"] = { fg = c.fg },
  ["@variable.builtin"] = { fg = c.keyword }, -- this, super
  ["@variable.global"] = { fg = c.field, bold = true, italic = true }, -- JS.GLOBAL_VARIABLE
  ["@variable.exported"] = { fg = c.field, bold = true, italic = true }, -- TS.EXPORTED_VARIABLE -> GLOBAL_VARIABLE
  -- a module namespace object (`z` of `import { z } from 'zod'`, `import * as ns`): WebStorm resolves it to the
  -- library's top-level binding = JS.GLOBAL_VARIABLE; tsserver sends no semantic token for it (plugins/lsp.lua)
  WsNamespaceImport = { fg = c.field, bold = true, italic = true },
  ["@variable.parameter"] = { fg = c.fg },
  ["@variable.member"] = { fg = c.field },
  ["@variable.member.static"] = { fg = c.field, italic = true }, -- static fields, enum members (DEFAULT_STATIC_FIELD)
  -- a local named like a lib global (`(location) =>`): drops the bold / italic of the treesitter global capture
  ["@variable.plain"] = { fg = c.fg, nocombine = true },
  ["@property"] = { fg = c.field },
  ["@constant"] = { fg = c.fg }, -- WebStorm doesn't color ALL_CAPS names
  ["@constant.builtin"] = { fg = c.keyword }, -- null, undefined
  ["@module"] = { fg = c.fg },
  ["@module.builtin"] = { fg = c.fg },
  ["@label"] = { fg = c.fg },
  ["@string"] = { fg = c.string },
  ["@string.escape"] = { fg = c.keyword }, -- DEFAULT_VALID_STRING_ESCAPE
  ["@string.regexp"] = { fg = c.number }, -- JS.REGEXP
  -- regex injection: the whole literal stays JS.REGEXP blue
  ["@constant.regex"] = { fg = c.number }, ["@number.regex"] = { fg = c.number },
  ["@operator.regex"] = { fg = c.number }, ["@property.regex"] = { fg = c.number },
  ["@punctuation.bracket.regex"] = { fg = c.number }, ["@punctuation.delimiter.regex"] = { fg = c.number },
  ["@string.escape.regex"] = { fg = c.number }, ["@variable.builtin.regex"] = { fg = c.number },
  ["@string.special.url"] = { fg = c.string }, -- import paths, href/src values: plain strings
  ["@character"] = { fg = c.string },
  ["@character.special"] = { fg = c.entity },
  ["@number"] = { fg = c.number },
  ["@boolean"] = { fg = c.keyword },
  ["@type"] = { fg = c.fg },
  ["@type.builtin"] = { fg = c.keyword }, -- TS.PRIMITIVE.TYPES -> keyword
  ["@type.parameter"] = { fg = c.type_param },
  ["@attribute"] = { fg = c.decorator }, -- TS.DECORATOR -> DEFAULT_METADATA
  ["@function"] = { fg = c.func },
  ["@function.call"] = { fg = c.fg },
  ["@function.builtin"] = { fg = c.func }, -- JS.GLOBAL_FUNCTION
  ["@function.method"] = { fg = c.func },
  ["@function.method.call"] = { fg = c.func },
  ["@function.method.static"] = { fg = c.func, italic = true }, -- DEFAULT_STATIC_METHOD
  ["@constructor"] = { fg = c.fg },
  ["@keyword"] = { fg = c.keyword },
  ["@keyword.directive"] = { fg = c.string }, -- "use strict"
  ["@keyword.conditional.ternary"] = { fg = c.fg }, -- ? : are operation signs
  ["@operator"] = { fg = c.fg },
  ["@punctuation.delimiter"] = { fg = c.keyword }, -- , ;
  ["@punctuation.delimiter.plain"] = { fg = c.fg }, -- . ?. : (after/queries)
  ["@punctuation.bracket"] = { fg = c.fg },
  ["@punctuation.special"] = { fg = c.fg }, -- ${ } -> JS.TEMPLATE_LITERAL_PLACEHOLDER_DELIMITERS -> braces
  ["@comment"] = { fg = c.comment },
  ["@comment.documentation"] = { fg = c.doc, italic = true },
  ["@comment.todo"] = { fg = c.todo, italic = true },
  ["@comment.note"] = { fg = c.todo, italic = true },
  ["@comment.warning"] = { fg = c.todo, italic = true },
  ["@comment.error"] = { fg = c.todo, italic = true },
  -- JSDoc: tags DEFAULT_DOC_COMMENT_TAG, names + {types} DEFAULT_DOC_COMMENT_TAG_VALUE
  ["@keyword.jsdoc"] = { fg = c.doc, italic = true, bold = true, underline = true },
  ["@type.jsdoc"] = { fg = c.jsdoc_tag, italic = true },
  ["@variable.jsdoc"] = { fg = c.doc, italic = true },
  ["@variable.parameter.jsdoc"] = { fg = c.jsdoc_tag, italic = true },
  ["@property.jsdoc"] = { fg = c.jsdoc_tag, italic = true },
  ["@function.jsdoc"] = { fg = c.jsdoc_tag, italic = true },
  ["@punctuation.bracket.jsdoc"] = { fg = c.jsdoc_tag, italic = true },
  ["@punctuation.delimiter.jsdoc"] = { fg = c.doc, italic = true },
  -- HTML / JSX (XML_TAG / XML_TAG_NAME / XML_ATTRIBUTE_NAME; JSX attribute values are strings)
  ["@tag"] = { fg = c.tag },
  ["@tag.builtin"] = { fg = c.tag },
  ["@tag.attribute"] = { fg = c.attr },
  ["@tag.delimiter"] = { fg = c.tag },
  ["@string.html"] = { fg = c.attr_val }, -- HTML_ATTRIBUTE_VALUE
  -- JSON: keys JSON.PROPERTY_KEY -> instance field, : -> DEFAULT_SEMICOLON
  ["@property.json"] = { fg = c.field },
  ["@property.jsonc"] = { fg = c.field },
  -- CSS: selectors/functions -> HTML_TAG_NAME, properties -> HTML_ATTRIBUTE_NAME, values -> HTML_ATTRIBUTE_VALUE
  ["@property.css"] = { fg = c.attr },
  ["@property.scss"] = { fg = c.attr },
  ["@type.css"] = { fg = c.tag },
  ["@type.scss"] = { fg = c.tag },
  ["@function.css"] = { fg = c.tag },
  ["@function.call.css"] = { fg = c.tag },
  ["@string.css"] = { fg = c.attr_val },
  ["@string.scss"] = { fg = c.attr_val },
  ["@number.css"] = { fg = c.number },
  ["@string.special.url.css"] = { fg = c.link }, -- CSS.URL
  ["@punctuation.delimiter.css"] = { fg = c.keyword },
  -- Markdown (MarkdownHighlighterColors fallbacks): headers DEFAULT_CONSTANT, markers/bold/italic keyword,
  -- code + quotes string, link text HYPERLINK, destination DEFAULT_STATIC_METHOD
  ["@markup.heading"] = { fg = c.field, italic = true },
  ["@markup.strong"] = { fg = c.keyword, bold = true },
  ["@markup.italic"] = { fg = c.keyword, italic = true },
  ["@markup.strikethrough"] = { strikethrough = true },
  ["@markup.quote"] = { fg = c.string },
  ["@markup.link"] = { fg = c.keyword },
  ["@markup.link.label"] = { fg = c.link, underline = true },
  ["@markup.link.url"] = { fg = c.func, italic = true },
  ["@markup.raw"] = { fg = c.string },
  ["@markup.list"] = { fg = c.keyword },
  ["@punctuation.special.markdown"] = { fg = c.keyword },
  ["@label.markdown"] = { fg = c.field, italic = true }, -- fence language
  -- JSX text inside <h1>/<b>/<a>... gets markup captures; WebStorm shows it as plain text
  ["@markup.heading.1.tsx"] = { fg = c.fg }, ["@markup.heading.2.tsx"] = { fg = c.fg },
  ["@markup.heading.3.tsx"] = { fg = c.fg }, ["@markup.strong.tsx"] = { fg = c.fg },
  ["@markup.italic.tsx"] = { fg = c.fg }, ["@markup.link.label.tsx"] = { fg = c.fg },
  ["@markup.raw.tsx"] = { fg = c.fg },

  -- LSP semantic tokens (priority over treesitter), set so they agree with the treesitter colors drawn before
  -- the server answers (no color change a few seconds after opening a file). tsserver tags anything callable
  -- "function": `z.object(` (member call: gold), `const run = wrap(fn)` / function-typed params (variables:
  -- default), `@sealed` (decorator). Treesitter knows those from the syntax, so function tokens add nothing;
  -- only lib (defaultLibrary) functions are JS.GLOBAL_FUNCTION gold. Token fixes: LspTokenUpdate in
  -- config/autocmds.lua; matching captures: after/queries.
  ["@lsp.type.property"] = { fg = c.field },
  ["@lsp.type.member"] = { fg = c.func },
  ["@lsp.type.method"] = { fg = c.func },
  ["@lsp.type.function"] = {},
  ["@lsp.typemod.function.declaration"] = {},
  ["@lsp.typemod.function.defaultLibrary"] = { fg = c.func },
  ["@lsp.typemod.member.static"] = { fg = c.func, italic = true }, -- DEFAULT_STATIC_METHOD
  ["@lsp.typemod.method.static"] = { fg = c.func, italic = true },
  ["@lsp.typemod.property.static"] = { fg = c.field, italic = true }, -- DEFAULT_STATIC_FIELD
  ["@lsp.type.typeParameter"] = { fg = c.type_param }, -- TS.TYPE_PARAMETER
  ["@lsp.type.parameter"] = { fg = c.fg },
  ["@lsp.type.variable"] = {},
  ["@lsp.type.class"] = {}, -- also anything typed as a class (`get: vi.fn()` is a property): treesitter decides
  ["@lsp.type.interface"] = { fg = c.fg },
  ["@lsp.type.type"] = { fg = c.fg },
  ["@lsp.type.enum"] = { fg = c.fg },
  ["@lsp.type.enumMember"] = { fg = c.field, italic = true },
  ["@lsp.type.namespace"] = { fg = c.fg },
  ["@lsp.typemod.variable.readonly"] = {},
  ["@lsp.typemod.variable.defaultLibrary"] = { fg = c.field, bold = true, italic = true }, -- JS.GLOBAL_VARIABLE
  ["@lsp.typemod.property.declaration"] = { fg = c.field },
  ["@lsp.mod.deprecated"] = { strikethrough = true }, -- DEPRECATED_ATTRIBUTES

  -- Diagnostics: ERRORS_ATTRIBUTES red wave, WARNING_ATTRIBUTES (Contrast) a yellowish background without
  -- underline, INFO_ATTRIBUTES (weak warning) olive wave, NOT_USED_ELEMENT gray text, DEPRECATED strikeout
  DiagnosticError = { fg = c.error_fg },
  DiagnosticWarn = { fg = c.warn },
  DiagnosticInfo = { fg = c.info },
  DiagnosticHint = { fg = c.hint },
  DiagnosticOk = { fg = c.git_add },
  DiagnosticUnderlineError = { sp = c.error, undercurl = true },
  DiagnosticUnderlineWarn = { bg = c.warn_bg },
  DiagnosticUnderlineInfo = { sp = c.info, undercurl = true },
  -- hints are TS unused / unreachable code (Unnecessary tag: gray below) and suggestions; WS draws
  -- NOT_USED_ELEMENT_ATTRIBUTES as fg only, no effect line, and no TS suggestions
  DiagnosticUnderlineHint = {},
  DiagnosticVirtualTextError = { fg = c.error_fg, bg = c.error_bg }, -- ERROR_HINT bg
  DiagnosticVirtualTextWarn = { fg = c.warn, bg = c.warn_bg },
  DiagnosticVirtualTextInfo = { fg = c.info },
  DiagnosticVirtualTextHint = { fg = c.hint },
  DiagnosticUnnecessary = { fg = c.unnecessary }, -- NOT_USED_ELEMENT_ATTRIBUTES
  DiagnosticDeprecated = { strikethrough = true, sp = "#c3c3c3" },
  -- IDENTIFIER_UNDER_CARET / WRITE_IDENTIFIER_UNDER_CARET
  LspReferenceText = { bg = c.ref },
  LspReferenceRead = { bg = c.ref },
  LspReferenceWrite = { bg = c.ref_write },
  LspInlayHint = { fg = c.inlay_fg, bg = c.inlay_bg }, -- INLAY_DEFAULT
  LspCodeLens = { fg = c.inlay_fg }, -- INLAY_TEXT_WITHOUT_BACKGROUND
  LspSignatureActiveParameter = { fg = c.func, bold = true },
  -- Copilot: INLINE_SUGGESTION
  CopilotSuggestion = { fg = c.comment },
  CopilotAnnotation = { fg = c.comment },
  BlinkCmpGhostText = { fg = c.comment },
  ComplHint = { fg = c.comment },

  -- Diff / git
  DiffAdd = { bg = c.diff_add },
  DiffDelete = { bg = c.diff_delete },
  DiffChange = { bg = c.diff_change },
  DiffText = { bg = c.diff_text },
  DiffTextAdd = { bg = c.diff_add },
  -- Diff viewer (git/diff.lua, git/merge.lua). Darcula scheme: DIFF_INSERTED 294436, DIFF_DELETED 484a4a,
  -- DIFF_MODIFIED 385570, DIFF_CONFLICT 45302b; changed lines get the 40% "ignored" mix, the changed
  -- words the full color ("Highlight words")
  GitDiffInserted = { bg = c.diff_add },
  GitDiffDeleted = { bg = c.diff_delete },
  GitDiffChanged = { bg = c.diff_change },
  GitDiffText = { bg = c.diff_text },
  GitDiffConflict = { bg = "#45302b" },
  GitMergeLine = {}, -- merge panes: diff mode's line colors off, git/merge.lua paints the lines
  GitDiffFiller = { fg = c.bg, bg = c.bg },
  GitDiffNr = { fg = c.line_nr, bg = c.bg },
  GitDiffInsertedNr = { fg = c.line_nr_cur, bg = c.diff_add },
  GitDiffDeletedNr = { fg = c.line_nr_cur, bg = c.diff_delete },
  GitDiffChangedNr = { fg = c.line_nr_cur, bg = c.diff_change_nr },
  GitDiffConflictNr = { fg = c.line_nr_cur, bg = c.diff_conflict },
  GitDiffFolded = { bg = c.bg, undercurl = true, sp = c.line_nr }, -- wavy line over folded unchanged code
  GitDiffSep = { fg = "#26282b", bg = c.bg }, -- pane separator blank (fillchars), bottom edge the frame line
  Added = { fg = c.git_add },
  Changed = { fg = c.git_change },
  Removed = { fg = c.git_delete },
  -- Bookmarks (config/bookmarks.lua): the mnemonic box (expui/bookmarks/mnemonic_dark.svg: #3D3223 fill,
  -- #F2C55C stroke) with the digit
  WsBookmarkNum = { fg = c.bookmark_fg, bg = c.bookmark_bg, bold = true },
  -- gutter change bars: ADDED_LINES_COLOR / MODIFIED_LINES_COLOR / DELETED_LINES_COLOR
  GitSignsAdd = { fg = c.git_add },
  GitSignsChange = { fg = c.git_change },
  GitSignsDelete = { fg = c.git_delete },
  GitSignsTopdelete = { fg = c.git_delete },
  GitSignsChangedelete = { fg = c.git_change },
  GitSignsUntracked = { fg = c.git_add },
  -- WebStorm doesn't tell staged from unstaged
  GitSignsStagedAdd = { link = "GitSignsAdd" },
  GitSignsStagedChange = { link = "GitSignsChange" },
  GitSignsStagedDelete = { link = "GitSignsDelete" },
  GitSignsStagedTopdelete = { link = "GitSignsTopdelete" },
  GitSignsStagedChangedelete = { link = "GitSignsChangedelete" },
  GitSignsAddPreview = { bg = c.diff_add },
  GitSignsDeletePreview = { bg = c.diff_delete },
  GitSignsAddInline = { bg = c.diff_add },
  GitSignsDeleteInline = { bg = c.diff_delete },
  GitSignsChangeInline = { bg = c.diff_text },

  -- Plugins
  SnacksPickerMatch = { fg = c.pmenu_match }, -- CompletionPopup.matchForeground (Blue8), also in Search Everywhere
  SnacksPickerDir = { fg = c.fg_dim },
  SnacksPickerPathIgnored = { fg = c.vcs_ignored },
  SnacksPickerPathHidden = { fg = c.text_ui },
  SnacksPickerListCursorLine = { bg = c.tree_sel },
  SnacksPickerDirectory = { fg = c.text_ui },
  SnacksPickerFile = { fg = c.text_ui },
  SnacksPickerIcon = { fg = c.text_ui_dim },
  -- 'guicursor' of windows without a caret (config/autocmds.lua; the app draws none for blend=100)
  GitHiddenCursor = { fg = c.bg, bg = c.bg, blend = 100 },
  -- Multiple cursors (config/multicursor.lua)
  -- the other carets: the app draws them like the caret (config/app/carets.lua); a link to an empty group (a
  -- link counts as set, so the plugin's reverse default stays off) leaves their cells as they are
  WsNoCaret = {},
  MultiCursorCursor = { link = "WsNoCaret" },
  MultiCursorVisual = { bg = c.selection },
  MultiCursorSign = { fg = c.line_nr },
  MultiCursorMatchPreview = { bg = c.search },
  MultiCursorDisabledCursor = { fg = c.bg, bg = c.line_nr },
  MultiCursorDisabledVisual = { bg = c.diff_change },
  MultiCursorDisabledSign = { fg = c.line_nr },
  -- Popup colors (Islands Dark LAF Popup.background Gray1.5, shortcuts Gray7): menu items' title / icon colors
  -- the app reads (config/app/menu.lua), the Cmd+R replace bar, the snacks fallback pickers
  WsMenu = { fg = "#d1d3d9", bg = "#26282b" },
  WsMenuTitle = { fg = "#d1d3d9", bg = "#26282b", bold = true },
  WsMenuIcon = { fg = c.icon_gray }, -- action icons (expui icon gray)
  WsMenuKey = { fg = "#6f737a" },
  WsMenuFooter = { fg = "#868a91", bg = "#26282b" }, -- Popup.Advertiser
  WsUsageMatch = { bold = true }, -- Show Usages popup: the usage in its (syntax colored) code line
  -- Editor features (folding, Quick Definition, Replace in file: config/fold.lua, peek.lua, replace.lua)
  WsFoldPlaceholder = { fg = c.fold_fg, bg = c.fold_bg }, -- FOLDED_TEXT_ATTRIBUTES: the "{...}" of a closed region
  WsPeek = { fg = c.fg, bg = "#26282b" }, -- Quick Definition popup (Popup.background, like the other popups)
  WsPeekLine = { bg = "#313338" }, -- its caret row (follows the caret; opens with the declaration)
  WsReplaceMatch = { bg = c.search }, -- TEXT_SEARCH_RESULT
  WsReplaceCurrent = { bg = c.selection }, -- the current occurrence is selected
  -- snacks pickers (non-explorer) as popups; the preview is an editor
  SnacksPicker = { link = "WsMenu" },
  SnacksPickerBorder = { fg = "#393b40", bg = "#26282b" }, -- line under the search field (padding elsewhere)
  SnacksPickerTitle = { link = "WsMenuTitle" },
  SnacksPickerFooter = { link = "WsMenuFooter" },
  SnacksPickerPrompt = { fg = "#6f737a", bg = "#26282b" },
  SnacksPickerTotals = { fg = "#6f737a" },
  SnacksPickerSpinner = { fg = "#6f737a" },
  SnacksPickerPreview = { fg = c.fg, bg = c.bg },
  SnacksPickerPreviewBorder = { link = "SnacksPickerBorder" },
  SnacksPickerPreviewTitle = { fg = "#868a91", bg = "#26282b" },
  SnacksPickerPreviewCursorLine = { bg = c.bg_alt }, -- CARET_ROW, not a selection
  SnacksPickerToggle = { fg = "#d1d3d9", bg = "#393b40" },
  SnacksPickerRow = { fg = "#6f737a" },
  SnacksPickerCol = { fg = "#6f737a" },
  SnacksPickerDelim = { fg = "#6f737a" },
  SnacksPickerComment = { fg = "#6f737a" },
  SnacksPickerLink = { fg = c.hint, italic = true },
  SnacksPickerLinkBroken = { fg = c.error_fg, italic = true },
  -- completion popup: LOOKUP_COLOR bg, CompletionPopup foreground Gray10 / matchForeground Blue8
  BlinkCmpMenu = { fg = c.pmenu_fg, bg = c.bg_alt },
  BlinkCmpMenuBorder = { link = "FloatBorder" },
  BlinkCmpMenuSelection = { bg = c.pmenu_sel },
  BlinkCmpLabelMatch = { fg = c.pmenu_match },
  BlinkCmpLabelDetail = { fg = c.fg_dim },
  BlinkCmpLabelDescription = { fg = c.fg_dim },
  BlinkCmpKind = { fg = c.fg_dim },
  BlinkCmpSource = { fg = c.fg_dim },
  BlinkCmpLabelDeprecated = { fg = c.pmenu_fg, strikethrough = true },
  BlinkCmpDoc = { fg = c.fg, bg = c.bg_alt },
  BlinkCmpDocBorder = { link = "FloatBorder" }, -- popup border ('winborder')
  BlinkCmpSignatureHelpBorder = { link = "FloatBorder" },
}

-- VS Code's capture mapping (#129: Dark Modern's look, config/app/look.lua `syntax`), from Dark+'s tokenColors and
-- semantic token rules: every function name, calls and methods too, is entity.name.function (the function colour,
-- no italic for statics), every type name, primitives, classes, interfaces and constructors too, is
-- entity.name.type / support.type.primitive (the type colour: Dark Modern's syntax-type-param, #4ec9b0)
if c.syntax == "vscode" then
  local func, type = { fg = c.func }, { fg = c.type_param }
  for _, name in ipairs({ "Function", "@function", "@function.call", "@function.builtin", "@function.method",
    "@function.method.call", "@function.method.static", "@lsp.type.function", "@lsp.typemod.function.declaration",
    "@lsp.typemod.function.defaultLibrary", "@lsp.type.member", "@lsp.type.method", "@lsp.typemod.member.static",
    "@lsp.typemod.method.static" }) do
    groups[name] = func
  end
  for _, name in ipairs({ "Type", "@type", "@type.builtin", "@type.definition", "@type.parameter", "@constructor",
    "@lsp.type.class", "@lsp.type.interface", "@lsp.type.type", "@lsp.type.enum", "@lsp.type.typeParameter" }) do
    groups[name] = type
  end
end

for group, opts in pairs(groups) do
  hl(group, opts)
end

-- File icons (config/icons.lua via mini.icons): fills of WebStorm's New UI file type icons
-- (expui/fileTypes/*_dark.svg, darcula.lua's icon_*). No bg, so they take the row / selection background. mini.icons'
-- own color groups (icons not mapped in config/icons.lua) use the same palette.
local icons = {
  WsIconBlue = c.icon_blue,
  WsIconYellow = c.icon_yellow,
  WsIconGold = c.icon_gold,
  WsIconPurple = c.icon_purple,
  WsIconRed = c.icon_red,
  WsIconGreen = c.icon_green,
  WsIconOrange = c.icon_orange,
  WsIconPink = c.icon_pink,
  WsIconGray = c.icon_gray,
  WsIconWhite = "#ffffff", -- eslint (fill "white")
  WsIconFolder = c.icon_gray, -- folder_dark.svg outline
}
for group, fg in pairs(icons) do
  hl(group, { fg = fg })
end
for name, link in pairs({ Azure = "Blue", Blue = "Blue", Cyan = "Blue", Green = "Green", Grey = "Gray",
  Orange = "Orange", Purple = "Purple", Red = "Red", Yellow = "Yellow" }) do
  hl("MiniIcons" .. name, { link = "WsIcon" .. link })
end
