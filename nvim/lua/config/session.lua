-- Reopen a project like WebStorm left it: the editor splits (layout, each one's tabs, active tab and caret),
-- the bottom tool window (terminal tabs in their folders, or git with its tab and filters), its
-- height (the bottom tool windows' one share of the window) and what had focus. Saved per directory on exit, restored when nvim starts there
-- without file arguments. Cursor positions come from shada.
local M = {}

local dir = vim.fn.stdpath("state") .. "/open-files"

local function path()
  return dir .. "/" .. vim.fn.getcwd():gsub("[/\\:]", "%%") .. ".json"
end

local function read()
  local ok, data = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(path()), "")) end)
  return ok and type(data) == "table" and data or nil
end

-- Saved focus: "terminal" | "git" | "tree" | "code" (any split, viewer, popup)
local function focused()
  local target = require("config.focus").target()
  if target == "terminal" or target == "git" or target == "tree" then return target end
  return "code"
end

---@alias SessionSplit {tabs: string[], active: string?, cursor: integer[]?}
---@alias SessionEditor {[1]: "leaf", [2]: SessionSplit} | {[1]: "row"|"col", [2]: SessionEditor[]}

-- Editor splits as a tree (winlayout() without the tool windows): each split's tabs, active tab and its
-- caret; plus the number of the focused split (leaves in order)
---@return SessionEditor?, integer
local function editor()
  local saved, cur = require("config.editor_tabs").snapshot(), require("config.focus").split_win()
  local n, active = 0, 1
  local function walk(node)
    if node[1] == "leaf" then
      local w = node[2]
      local st = saved[w]
      if not st or #st.tabs == 0 then return nil end
      n = n + 1
      if w == cur then active = n end
      -- (a diff may have taken the window over: no caret then)
      local shown = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(w)) == st.active
      return { "leaf", { tabs = st.tabs, active = st.active, cursor = shown and vim.api.nvim_win_get_cursor(w) or nil } }
    end
    local kids = {}
    for _, c in ipairs(node[2]) do
      kids[#kids + 1] = walk(c)
    end
    if #kids <= 1 then return kids[1] end
    return { node[1], kids }
  end
  return walk(vim.fn.winlayout()), active
end

-- Splits of the tree in order
---@param node SessionEditor?
---@param out SessionSplit[]?
local function leaves(node, out)
  out = out or {}
  if not node then return out end
  if node[1] == "leaf" then
    out[#out + 1] = node[2]
  else
    for _, c in ipairs(node[2]) do leaves(c, out) end
  end
  return out
end

-- Sessions saved before per-split tabs: one tab list, a file per split
local function from_old(data)
  local l, files = data.layout or {}, data.files or {}
  local splits = l.splits or {}
  if #splits > 1 then
    local kids = {}
    for i, f in ipairs(splits) do
      kids[i] = { "leaf", { tabs = i == 1 and files or { f }, active = f } }
    end
    return { "row", kids }
  end
  return { "leaf", { tabs = files, active = data.current } }
end

-- The app's native tree (app/src/shell/tree tells config/app/tree.lua): open, width, expanded folders
local function app_tree()
  local st = require("config.app.tree").get_state()
  return { tree = st == nil or st.open, tree_dirs = st and st.dirs or nil, tree_width = st and st.width or nil }
end

local function layout()
  local ed, active = editor()
  local tree = app_tree()
  return {
    tree = tree.tree,
    tree_dirs = tree.tree_dirs,
    tree_width = tree.tree_width,
    terminal = require("config.app.terminal").layout(),
    git = require("config.app.git").layout(),
    bottom = require("config.bottom").layout(),
    editor = ed,
    active_split = active,
    focus = focused(),
  }
end

local function save()
  -- (pcall: every open project's nvim saves at once on app quit; mkdir "p" fails when another one
  -- creates the dir between its check and its mkdir)
  pcall(vim.fn.mkdir, dir, "p")
  local ok, l = pcall(layout)
  -- files: every tab (also for older versions of this file)
  local files, seen = {}, {}
  for _, sp in ipairs(leaves(ok and l.editor or nil)) do
    for _, f in ipairs(sp.tabs) do
      if not seen[f] and vim.uv.fs_stat(f) then files[#files + 1], seen[f] = f, true end
    end
  end
  local cur = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(require("config.focus").split_win() or 0))
  vim.fn.writefile({ vim.json.encode({ files = files, current = cur, layout = ok and l or nil }) }, path())
end

local restored = nil ---@type table?

-- Was the tree open last time? (default yes)
function M.tree_open()
  local l = restored or (vim.fn.argc() == 0 and (read() or {}).layout) or {}
  return l.tree ~= false
end

-- Cursor to where it was when the file was last closed ('" mark from shada)
local function last_position(win)
  local buf = vim.api.nvim_win_get_buf(win)
  local mark = vim.api.nvim_buf_get_mark(buf, '"')
  if mark[1] > 0 and mark[1] <= vim.api.nvim_buf_line_count(buf) then pcall(vim.api.nvim_win_set_cursor, win, mark) end
end

-- A split's tabs (files that still exist) as buffers, and the active one
---@param sp SessionSplit
---@return integer[], integer?
local function split_bufs(sp)
  local bufs, active = {}, nil
  for _, f in ipairs(sp.tabs or {}) do
    if f ~= "" and vim.uv.fs_stat(f) then
      local b = vim.fn.bufadd(f)
      vim.bo[b].buflisted = true
      bufs[#bufs + 1] = b
      if f == sp.active then active = b end
    end
  end
  return bufs, active or bufs[#bufs]
end

-- Fill a window with a split's tabs and show its active tab at the saved caret
---@param win integer
---@param sp SessionSplit
local function fill(win, sp)
  local bufs, active = split_bufs(sp)
  require("config.editor_tabs").set_tabs(win, bufs, active)
  if not active then return end
  if vim.api.nvim_win_get_buf(win) ~= active then
    vim.api.nvim_win_call(win, function() vim.cmd.buffer(active) end)
  end
  if sp.cursor and pcall(vim.api.nvim_win_set_cursor, win, sp.cursor) then return end
  last_position(win) -- already loaded (open in another split): no BufReadPost
end

-- Split `win` like the saved tree; returns the windows of its splits in order
---@param node SessionEditor
---@param win integer
---@return integer[]
local function build(node, win)
  if node[1] == "leaf" then
    fill(win, node[2])
    return { win }
  end
  local wins = { win }
  for i = 2, #node[2] do
    vim.api.nvim_win_call(wins[i - 1], function()
      vim.cmd(node[1] == "row" and "rightbelow vsplit" or "rightbelow split")
      wins[i] = vim.api.nvim_get_current_win()
    end)
  end
  local out = {}
  for i, child in ipairs(node[2]) do vim.list_extend(out, build(child, wins[i])) end
  return out
end

-- Tool windows and focus
---@param l table layout
---@param ed SessionEditor?
local function restore_layout(l, ed)
  local focus = require("config.focus")
  local git = require("config.app.git")
  -- another native surface got the keys as this nvim started (a move lands in Chat's composer): it keeps them
  local away = require("config.app").native() ~= nil and not git.is_focused()
  local split = focus.split_win()
  local active ---@type integer?
  if split and ed then
    local wins = build(ed, split)
    active = wins[l.active_split or 1]
  end
  -- the native tree: open or closed as it was, its width and folders, focused if it had the keyboard
  require("config.app.bridge").notify("tree", {
    event = "restore", open = l.tree ~= false, width = l.tree_width, dirs = l.tree_dirs or {},
    focus = l.focus == "tree" and not away,
  })
  -- the bottom tool window's height (sessions before #156: the Git / Abe tool window's rows)
  local legacy = l.git or l.abe
  if l.bottom then
    require("config.bottom").restore(l.bottom)
  elseif type(legacy) == "table" and type(legacy.height) == "number" and legacy.height > 0 then
    require("config.bottom").set_height(legacy.height)
  end
  -- the terminal's tabs (their shells start; the Terminal shows only when it had the keyboard)
  if l.terminal then require("config.app.terminal").restore(l.terminal) end
  if l.git then
    require("config.app.git").restore(l.git)
  end -- (the 1.0 Abe tool window (`l.abe`) and the bottom pane (2.1) are not restored: hidden by default)
  vim.cmd.stopinsert()
  -- the Git tool window took the keyboard as the project started (a PR review): it keeps it
  local focus_on = git.is_focused() and "git" or l.focus
  if away then
    if active and vim.api.nvim_win_is_valid(active) then vim.api.nvim_set_current_win(active) end
  elseif focus_on == "terminal" and l.terminal then
    require("config.app.terminal").focus()
  elseif focus_on == "git" and (l.git or git.is_open()) then
    git.open(nil, true)
  elseif focus_on == "tree" then
    return -- the restore event above focused it
  else
    focus.editor()
    if active and vim.api.nvim_win_is_valid(active) then vim.api.nvim_set_current_win(active) end
  end
end

local function restore()
  local data = read()
  if not data then return end
  restored = data.layout
  local ed = restored and restored.editor or from_old(data)
  -- the other splits and the tool windows a moment later (after VimEnter's other handlers: plugins/ui.lua)
  if restored then
    local l = restored
    vim.defer_fn(function()
      local ok, err = pcall(restore_layout, l, ed)
      if not ok then vim.notify("Session layout: " .. tostring(err), vim.log.levels.WARN) end
    end, 50)
  end
  -- now: the first split's tabs in the window nvim starts with (the other splits open beside it later)
  local first = leaves(ed)[1]
  if not first then return end
  local bufs, cur = split_bufs(first)
  if not cur then return end
  local empty = vim.api.nvim_get_current_buf() -- the [No Name] buffer nvim starts with
  require("config.editor_tabs").set_tabs(vim.api.nvim_get_current_win(), bufs, cur)
  vim.cmd.buffer(cur)
  if vim.api.nvim_buf_is_valid(empty) and vim.api.nvim_buf_get_name(empty) == "" and not vim.bo[empty].modified then
    vim.api.nvim_buf_delete(empty, {})
  end
end

function M.setup()
  vim.api.nvim_create_autocmd("VimLeavePre", { callback = save })
  vim.api.nvim_create_autocmd("VimEnter", {
    nested = true, -- so filetype / LSP / treesitter start for the restored files
    callback = function()
      if vim.fn.argc() == 0 and #vim.api.nvim_list_uis() > 0 then restore() end
    end,
  })
  -- Reopen files at the last cursor position
  vim.api.nvim_create_autocmd("BufReadPost", {
    callback = function(args)
      if vim.api.nvim_win_get_buf(0) == args.buf then last_position(0) end
    end,
  })
end

return M
