-- The look (#108 S4): a theme's editor colours over darcula.lua's palette. Rust sends the look in
-- force (`app/src/look/mod.rs` `tell_nvim`: when the bridge sends one, and to each project's nvim as it
-- starts) as {dark, syntax, tokens = {<DS token> = "#rrggbb"}}; `syntax` is whose capture mapping the
-- colours follow ("darcula" or Dark Modern's "vscode", #129: colors/darcula-contrast.lua); the design system's tokens name the
-- palette key each one is (`abe/packages/core/src/theme/theme-tokens.ts` usage notes). The colorscheme
-- is applied again with the palette changed in place, so every group and every ColorScheme
-- listener follows. A token a look lacks keeps darcula.lua's own colour.
local M = {}

-- darcula.lua key -> DS token
M.keys = {
  bg = "editor-bg",
  bg_alt = "syntax-bg-alt",
  fg = "editor-fg",
  fg_bright = "syntax-fg-bright",
  fg_dim = "text-dim",
  line_nr = "editor-line-number",
  line_nr_cur = "editor-line-number-current",
  selection = "syntax-selection",
  search = "syntax-search",
  search_cur = "syntax-search-cur",
  ref = "syntax-ref",
  brace_bg = "syntax-brace-bg",
  brace_fg = "syntax-brace-fg",
  pmenu_sel = "selection-bg",
  tree_sel = "selection-bg",

  keyword = "syntax-keyword",
  string = "syntax-string",
  number = "syntax-number",
  comment = "syntax-comment",
  doc = "syntax-doc",
  func = "syntax-func",
  field = "syntax-field",
  type_param = "syntax-type-param",
  tag = "syntax-tag",
  attr = "syntax-attr",
  attr_val = "syntax-attr-val",
  decorator = "syntax-decorator",
  todo = "syntax-todo",
  entity = "syntax-entity",

  error = "syntax-error",
  error_fg = "syntax-error-fg",
  warn = "syntax-warn",
  warn_bg = "syntax-warn-bg",
  error_bg = "syntax-error-bg",
  hint = "syntax-hint",

  git_add = "gutter-added",
  git_change = "gutter-modified",
  git_delete = "gutter-deleted",
  vcs_ignored = "git-ignored",

  diff_add = "diff-inserted-bg",
  diff_delete = "diff-deleted-bg",
  diff_change = "diff-modified-ignored",
  diff_text = "diff-modified-bg",

  caret = "caret",
  pmenu_fg = "float-menu-fg",
  pmenu_match = "syntax-pmenu-match",
  whitespace = "syntax-whitespace",
  jsdoc_tag = "syntax-jsdoc-tag",
  link = "syntax-link",
  info = "syntax-info",
  unnecessary = "syntax-unnecessary",
  ref_write = "syntax-ref-write",
  inlay_fg = "syntax-inlay-fg",
  inlay_bg = "syntax-inlay-bg",
  bookmark_fg = "syntax-bookmark-fg",
  bookmark_bg = "syntax-bookmark-bg",
  fold_fg = "syntax-fold-fg",
  fold_bg = "syntax-fold-bg",
  icon_blue = "icon-blue",
  icon_yellow = "icon-yellow",
  icon_gold = "icon-gold",
  icon_purple = "icon-purple",
  icon_red = "icon-red",
  icon_green = "icon-green",
  icon_orange = "icon-orange",
  icon_pink = "icon-pink",
  icon_gray = "icon-gray",
}

-- darcula.lua's own colours, before any look
local own

local function hex(v)
  return type(v) == "string" and v:match("^#%x%x%x%x%x%x$") and v:lower() or nil
end

--- Puts `look` ({dark, syntax, tokens}) in force: darcula.lua's palette changed in place, the colorscheme
--- applied again (at once when nvim already shows it, else when init.lua applies it).
function M.apply(look)
  local c = require("darcula")
  if not own then
    own = vim.deepcopy(c)
  end
  for key, token in pairs(M.keys) do
    c[key] = hex((look.tokens or {})[token]) or own[key]
  end
  c.light = look.dark == false
  c.syntax = look.syntax == "vscode" and "vscode" or nil
  if vim.g.colors_name == "darcula-contrast" then
    vim.cmd.colorscheme("darcula-contrast")
  end
end

return M
