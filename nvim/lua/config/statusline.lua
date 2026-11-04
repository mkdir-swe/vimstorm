-- Status bar content like WebStorm's New UI (the app draws it: app/src/editor/statusbar via config/app/status.lua): vim
-- mode badge, navigation path "project › dir › file" on the left; line:col, line ending, encoding, indent and git
-- branch on the right. It always describes the last focused split (the tree, Git tool window and terminal don't
-- replace it). Also sets the window title: "project – file".
local M = {}

-- badge letter, kind
local modes = {
  n = { "N", "Normal" },
  i = { "I", "Insert" },
  v = { "V", "Visual" },
  V = { "V", "Visual" },
  ["\22"] = { "V", "Visual" },
  s = { "S", "Visual" },
  S = { "S", "Visual" },
  ["\19"] = { "S", "Visual" },
  R = { "R", "Replace" },
  c = { "C", "Command" },
}

local function esc(s) return (s:gsub("%%", "%%%%")) end

-- Global cwd, cached (perf: getcwd() is half the cost of a status bar redraw); DirChanged resets it
local cwd ---@type string?
local function global_cwd()
  cwd = cwd or vim.fn.getcwd(-1, -1)
  return cwd
end

local function project() return vim.fn.fnamemodify(global_cwd(), ":t") end

-- The focused / last focused split and its file ("" when it shows no file)
local function code()
  local win = require("config.focus").split_win()
  if not win then return nil, nil, "" end
  local buf = vim.api.nvim_win_get_buf(win)
  return win, buf, vim.api.nvim_buf_get_name(buf)
end

-- The navigation path's parts: project and folders ({} outside the project), and the file name
---@param path string
---@return string[] parts, string? file
local function path_parts(path)
  local parts = { project() }
  if path ~= "" then
    local rel = vim.fn.fnamemodify(path, ":~:.")
    if rel:match("^[/~]") then parts = {} end -- outside the project
    vim.list_extend(parts, vim.split(rel, "/", { trimempty = true }))
  end
  local file = path ~= "" and table.remove(parts) or nil
  return parts, file
end

-- Selected characters (wordcount().visual_chars, but only reading the selection: wordcount() reads the whole
-- buffer, ~1 ms per redraw in a 12k-line file), cached while the selection and the text stay the same
local sel_cache = { key = nil, value = 0 }
local function visual_chars(mode, buf)
  mode = ({ s = "v", S = "V", ["\19"] = "\22" })[mode] or mode -- select mode: same as visual
  local v, c = vim.fn.getpos("v"), vim.fn.getpos(".")
  local key = table.concat({ mode, buf, vim.api.nvim_buf_get_changedtick(buf), v[2], v[3], c[2], c[3] }, ":")
  if sel_cache.key == key then return sel_cache.value end
  local n
  if mode == "\22" then
    n = vim.fn.wordcount().visual_chars or 0 -- block: rare, keep the exact count
  else
    local ok, lines = pcall(vim.fn.getregion, v, c, { type = mode })
    n = 0
    if ok then
      for _, l in ipairs(lines) do n = n + vim.fn.strchars(l) end
      n = n + (mode == "V" and #lines or #lines - 1) -- line breaks count as characters
      -- charwise ending on an empty line or past its end (v$): that line break is selected too
      local last = (v[2] > c[2] or (v[2] == c[2] and v[3] > c[3])) and v or c
      if mode == "v" and last[3] > #(vim.api.nvim_buf_get_lines(buf, last[2] - 1, last[2], false)[1] or "") then n = n + 1 end
    end
  end
  sel_cache.key, sel_cache.value = key, n
  return n
end

-- Right side for a split showing a file: "line:col" (+ selection size), line ending, encoding, indent; and
-- whether the file is read-only
---@param win integer
---@param buf integer
---@param mode string[] modes[...]
---@return string[] right, boolean readonly
local function file_items(win, buf, mode)
  local right = {}
  local pos = vim.api.nvim_win_get_cursor(win)
  local line = vim.api.nvim_buf_get_lines(buf, pos[1] - 1, pos[1], false)[1] or ""
  local lc = ("%d:%d"):format(pos[1], vim.fn.strchars(line:sub(1, pos[2])) + 1)
  -- selection size, like WebStorm: "12:5 (34 chars, 2 line breaks)"
  if mode[2] == "Visual" and win == vim.api.nvim_get_current_win() then
    local chars = visual_chars(vim.api.nvim_get_mode().mode:sub(1, 1), buf)
    local breaks = math.abs(vim.fn.line("v") - vim.fn.line("."))
    lc = lc .. (" (%d chars%s)"):format(chars, breaks > 0 and (", %d line break%s"):format(breaks, breaks > 1 and "s" or "") or "")
  end
  right[#right + 1] = lc
  right[#right + 1] = ({ unix = "LF", dos = "CRLF", mac = "CR" })[vim.bo[buf].fileformat]
  local enc = vim.bo[buf].fileencoding
  right[#right + 1] = (enc ~= "" and enc or vim.o.encoding):upper()
  local sw = vim.bo[buf].shiftwidth
  if sw == 0 then sw = vim.bo[buf].tabstop end
  right[#right + 1] = vim.bo[buf].expandtab and (sw .. (sw == 1 and " space" or " spaces")) or "Tab"
  return right, vim.bo[buf].readonly or not vim.bo[buf].modifiable
end

-- Declarations the navigation path shows after the file (WebStorm "show members": the structure view's elements
-- around the caret), by treesitter node type -> LSP SymbolKind name (the app's icon). Variables only at the top
-- level (exported or not) or when they hold a function.
local DECLS = {
  function_declaration = "Function", generator_function_declaration = "Function", function_definition = "Function",
  function_item = "Function", method_definition = "Method", method_declaration = "Method",
  class_declaration = "Class", abstract_class_declaration = "Class", class_definition = "Class",
  struct_item = "Struct", enum_item = "Enum", trait_item = "Interface", impl_item = "Class", mod_item = "Module",
  interface_declaration = "Interface", type_alias_declaration = "TypeParameter", enum_declaration = "Enum",
  internal_module = "Namespace", variable_declarator = "Variable", public_field_definition = "Property",
}
local FUNCTION_VALUES = { arrow_function = true, ["function"] = true, function_expression = true }

-- A declaration node's name and kind, nil for nodes the structure view doesn't list
---@param node TSNode
---@param buf integer
---@return {name: string, kind: string}?
local function decl(node, buf)
  local kind = DECLS[node:type()]
  if not kind then return nil end
  local name = node:field("name")[1] or (node:type() == "impl_item" and node:field("type")[1])
  if not name then return nil end
  if node:type() == "variable_declarator" then
    local value = node:field("value")[1]
    local holder = node:parent() -- lexical_declaration / variable_declaration
    local top = holder and holder:parent()
    local top_level = top and (top:type() == "program" or (top:type() == "export_statement" and top:parent()
      and top:parent():type() == "program"))
    if value and FUNCTION_VALUES[value:type()] then
      kind = "Function"
    elseif not top_level then
      return nil
    elseif holder and vim.treesitter.get_node_text(holder, buf):match("^const") then
      kind = "Constant"
    end
  end
  return { name = vim.treesitter.get_node_text(name, buf), kind = kind }
end

-- A statement holding a declaration (`export const x = …`, the caret on `export`): the declaration
---@param node TSNode
---@return TSNode
local function into_decl(node)
  if node:type() == "export_statement" then node = node:field("declaration")[1] or node end
  local t = node:type()
  if t == "lexical_declaration" or t == "variable_declaration" then
    for child in node:iter_children() do
      if child:type() == "variable_declarator" then return child end
    end
  end
  return node
end

-- The declarations around the caret, outermost first (at most 3), cached per position and text change
local sym_cache = { key = nil, value = {} }
---@param win integer
---@param buf integer
---@return {name: string, kind: string}[]
local function symbols(win, buf)
  local pos = vim.api.nvim_win_get_cursor(win)
  local row, col = pos[1] - 1, pos[2]
  local key = buf .. ":" .. row .. ":" .. col .. ":" .. vim.api.nvim_buf_get_changedtick(buf)
  if sym_cache.key == key then return sym_cache.value end
  local out = {}
  -- only with a parser already running for the buffer (highlighting): never parse a file just for this, nor look
  -- for a parser a file without highlighting has none of (each look searches the runtimepath: #225)
  local ok, parser = false, nil
  if vim.treesitter.highlighter.active[buf] then ok, parser = pcall(vim.treesitter.get_parser, buf, nil, { error = false }) end
  if ok and parser and parser:trees()[1] then
    local node = parser:named_node_for_range({ row, col, row, col }, { ignore_injections = true })
    node = node and into_decl(node)
    while node do
      local d = decl(node, buf)
      if d then table.insert(out, 1, d) end
      node = node:parent()
    end
  end
  while #out > 3 do table.remove(out, 1) end
  sym_cache.key, sym_cache.value = key, out
  return out
end

-- Feel vscode's breadcrumbs under a split's tabs (#128, the app's tabs surface draws them): the file's folders
-- from the project down (no project name, as VS Code), its name, the declarations around that split's caret.
-- nil for a split showing no file.
---@param win integer
---@return {folders: string[], file: string, symbols: {name: string, kind: string}[]}?
function M.breadcrumbs(win)
  local buf = vim.api.nvim_win_get_buf(win)
  local path = vim.api.nvim_buf_get_name(buf)
  if path == "" or vim.bo[buf].buftype ~= "" then return nil end
  local parts, file = path_parts(path)
  if parts[1] == project() and not vim.fn.fnamemodify(path, ":~:."):match("^[/~]") then table.remove(parts, 1) end
  return { folders = parts, file = file or "", symbols = symbols(win, buf) }
end

---@class StatusParts
---@field mode string badge letter
---@field mode_kind string "Normal" | "Insert" | "Visual" | "Replace" | "Command"
---@field recording string register being recorded into, "" when not
---@field crumbs string[] project and folders of the file (navigation path)
---@field file string file name, "" when the split shows no file
---@field right string[] line:col, line ending, encoding, indent ({} without a file)
---@field readonly boolean
---@field branch string git branch, "" outside a repo
---@field symbols {name: string, kind: string}[] declarations around the caret after the file, outermost first
---@field caret {file: string, line: integer, from?: integer, to?: integer}? the caret: its file relative to the project, its line, the selected lines (#119: Chat's implicit context)

-- The caret as Chat's implicit context: the file relative to the project, the 1-based line, the selected lines
-- while a Visual selection is up in that split
local function caret_of(win, path, mode)
  local rel = vim.fs.relpath(global_cwd(), path) or path
  local c = { file = rel, line = vim.api.nvim_win_get_cursor(win)[1] }
  if mode[2] == "Visual" and win == vim.api.nvim_get_current_win() then
    local a, b = vim.fn.line("v"), vim.fn.line(".")
    c.from, c.to = math.min(a, b), math.max(a, b)
  end
  return c
end

local parts_cache = { key = nil, crumbs = {}, file = nil } ---@type {key: string?, crumbs: string[], file: string?}

-- What the status bar shows, as data (the app draws it: config/app/status.lua). Leading folders aren't folded:
-- the app folds them by pixel width.
---@return StatusParts
function M.parts()
  local mode = modes[vim.api.nvim_get_mode().mode:sub(1, 1)] or modes.n
  local win, buf, path = code()
  local right, readonly, syms, caret = {}, false, {}, nil
  if win and buf and path ~= "" then
    right, readonly = file_items(win, buf, mode)
    syms = symbols(win, buf)
    if vim.bo[buf].buftype == "" then caret = caret_of(win, path, mode) end
  end
  local key = (path or "") .. "\0" .. global_cwd()
  if parts_cache.key ~= key then parts_cache.key, parts_cache.crumbs, parts_cache.file = key, path_parts(path or "") end
  local crumbs, file = parts_cache.crumbs, parts_cache.file
  return {
    mode = mode[1],
    mode_kind = mode[2],
    recording = vim.fn.reg_recording(),
    crumbs = crumbs,
    file = file or "",
    right = right,
    readonly = readonly,
    branch = require("git.status").branch() or "",
    symbols = syms,
    caret = caret,
  }
end

-- The project's name in the title as the app says it (`set_name`): another open repo's folder has the same name
-- (`b/repo`), a worktree's repo while several are open (`demo-shop › 7-filter-orders`); nil: the folder's
local name ---@type string?

-- Window title (the app's toolbar shows it): "project – file", like WebStorm
function M.title()
  local _, _, path = code()
  local t = name or project()
  if path and path ~= "" then t = t .. " – " .. vim.fn.fnamemodify(path, ":t") end
  return t
end

local function update_title()
  local t = esc(M.title())
  if vim.o.titlestring ~= t then vim.o.titlestring = t end
end

-- The app names the project in the title (an empty name: its folder's again)
---@param n string
function M.set_name(n)
  name = n ~= "" and n or nil
  update_title()
end

function M.setup()
  vim.o.laststatus = 3 -- (the app keeps the row: its layout counts it, app/src/shell/layout.rs EXTRA_ROWS)
  vim.o.showmode = false -- the badge shows it
  local group = vim.api.nvim_create_augroup("ws_statusline", { clear = true })
  -- the app draws a native status bar from config/app/status.lua; nvim's row isn't shown
  vim.o.statusline = " "
  require("config.app.status").setup()
  vim.api.nvim_create_autocmd("DirChanged", { group = group, callback = function() cwd = nil end })
  vim.api.nvim_create_autocmd({ "VimEnter", "BufEnter", "WinEnter", "BufFilePost", "DirChanged", "WinClosed" }, {
    group = group,
    callback = function() vim.schedule(update_title) end,
  })
  require("config.focuscue").setup() -- active / inactive colors of what has focus
end

return M
