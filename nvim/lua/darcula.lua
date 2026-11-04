-- Darcula Contrast palette (shared by colors/darcula-contrast.lua and plugin highlights). In the app a
-- look (config/app/look.lua, #108 S4) puts a theme's colours over these.
return {
  bg = "#1e1f22",
  bg_alt = "#2b2d30", -- caret row, popups, docs
  fg = "#a9b7c6",
  fg_bright = "#dfe1e5",
  fg_dim = "#6f737a",
  line_nr = "#4e5157",
  line_nr_cur = "#9da0a8",
  selection = "#214283",
  search = "#32593d",
  search_cur = "#155221",
  ref = "#344134", -- identifier under caret
  brace_bg = "#326146",
  brace_fg = "#ced9d2",
  pmenu_sel = "#2e436e",
  -- New UI (islands) chrome
  text_ui = "#dfe1e5", -- tree / tab labels
  text_ui_dim = "#9da0a8",
  tree_sel = "#2e436e", -- focused tree row

  keyword = "#cc7832",
  string = "#6a8759",
  number = "#6897bb",
  comment = "#808080",
  doc = "#629755",
  func = "#ffc66d",
  field = "#9876aa",
  type_param = "#507874",
  tag = "#e8bf6a",
  attr = "#bababa",
  attr_val = "#a5c261",
  decorator = "#bbb529",
  todo = "#a8c023",
  entity = "#6d9cbe",

  error = "#bc3f3c",
  error_fg = "#f75464",
  warn = "#be9117",
  warn_bg = "#3d3322",
  error_bg = "#402929",
  hint = "#8d9199",

  git_add = "#549159",
  git_change = "#375fad",
  git_delete = "#868a91",
  vcs_ignored = "#d69a6b",

  -- WebStorm diff viewer (sampled from screenshots)
  diff_add = "#294436",
  diff_delete = "#484a4a",
  diff_change = "#283541",
  diff_change_nr = "#375570",
  diff_text = "#385570",
  diff_conflict = "#5c3a3a",

  -- the rest of Darcula Contrast's editor colours (colors/darcula-contrast.lua), so a look reaches them
  caret = "#bbbbbb",
  pmenu_fg = "#b4b8bf", -- completion item text
  pmenu_match = "#548af7", -- CompletionPopup.matchForeground (Blue8)
  whitespace = "#606060", -- WHITESPACES
  jsdoc_tag = "#8a653b",
  link = "#287bde", -- CSS.URL, markdown link label
  info = "#aeae80",
  unnecessary = "#72737a", -- NOT_USED_ELEMENT_ATTRIBUTES
  ref_write = "#40332b",
  inlay_fg = "#787878", -- INLAY_DEFAULT
  inlay_bg = "#3b3b3b",
  bookmark_fg = "#f2c55c", -- expui/bookmarks/mnemonic_dark.svg stroke
  bookmark_bg = "#3d3223", -- its fill
  fold_fg = "#8c8c8c", -- FOLDED_TEXT_ATTRIBUTES
  fold_bg = "#3a3a3a",
  -- fills of WebStorm's New UI file type icons (expui/fileTypes/*_dark.svg)
  icon_blue = "#548af7", -- typeScript, tsx, markdown, css, less, image, archive, prettier (Blue8)
  icon_yellow = "#f2c55c", -- javaScript badge (Yellow8)
  icon_gold = "#d6ae58", -- jsx
  icon_purple = "#b589ec", -- json, sql, sourceMap (Purple9)
  icon_red = "#db5c5c", -- yaml (Red8)
  icon_green = "#57965c", -- html (Green7)
  icon_orange = "#c77d55", -- xml (Orange7)
  icon_pink = "#cd669a", -- sass / scss
  icon_gray = "#ced0d6", -- text, ignored, shell, font, editorConfig, folders, menu icons (Gray12)
}
