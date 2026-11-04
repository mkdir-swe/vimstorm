-- Ctrl+Tab switcher, WebStorm style: tool windows on the left, recent files on the right. The app draws it
-- (app/src/search/switcher.rs: Tab / Shift+Tab move while Ctrl is held, releasing Ctrl opens the selection);
-- Lua gives it the rows (open files in the order they were used) and opens what was picked (M.pick).
-- Recent Files (M.recent) is the same popup in its recent mode, like WebStorm's: the project's file history,
-- "Show edited only".
local focus = require("config.focus")
local M = {}

---@class SwitcherTool
---@field [1] string label
---@field [2] string icon name (the app's tool window icons)
---@field [3] string shortcut
---@field [4]? fun() open (none: the app opens it, `column`)
---@field column? "chat" the Chat column's mode the app shows with the keyboard (app/src/search/switcher.rs)

-- Picking a tool window focuses it (never hides it). The keys: ⌘1 Project · ⌘4 Chat · ⌘T and ⌘3 Code's bottom
-- panel's Terminal and Git (Terminal · Git · Problems). Boxes and Pipelines are rail tiles, Sessions is the Board's
---@type SwitcherTool[]
local TOOLS = {
  { "Project", "project", "⌘1", focus.tree },
  { "Chat", "chat", "⌘4", column = "chat" },
  { "Terminal", "terminal", "⌘T", function() require("config.app.pane").show("terminal") end },
  { "Git", "vcs", "⌘3", function() require("config.app.pane").show("git") end },
}

---@class SwitcherFile
---@field path string
---@field name string file name
---@field buf integer loaded buffer

-- Order buffers were entered in ('lastused' only has seconds: quick Ctrl+Tab flips tie)
local entered, tick = {}, 0 ---@type table<integer, integer>, integer
-- Files changed in the editor this session (Recent Files' "Show edited only"; WS's recently edited files)
local edited = {} ---@type table<string, true>
local group = vim.api.nvim_create_augroup("ws_switcher", { clear = true })
vim.api.nvim_create_autocmd("BufEnter", {
  group = group,
  callback = function(ev)
    tick = tick + 1
    entered[ev.buf] = tick
  end,
})
vim.api.nvim_create_autocmd("BufModifiedSet", {
  group = group,
  callback = function(ev)
    if vim.bo[ev.buf].modified and vim.bo[ev.buf].buftype == "" then
      local name = vim.api.nvim_buf_get_name(ev.buf)
      if name ~= "" then edited[name] = true end
    end
  end,
})

---@param path string
---@param buf? integer
---@return SwitcherFile
local function file(path, buf)
  return { path = path, name = vim.fn.fnamemodify(path, ":t"), buf = buf }
end

-- Listed file buffers (no folders), most recently used first (the current one on top, like WebStorm)
---@return SwitcherFile[]
local function recent_files()
  local infos = vim.tbl_filter(function(b)
    return b.name ~= "" and vim.bo[b.bufnr].buftype == "" and vim.fn.isdirectory(b.name) == 0
  end, vim.fn.getbufinfo({ buflisted = 1 }))
  table.sort(infos, function(a, b)
    local ea, eb = entered[a.bufnr] or 0, entered[b.bufnr] or 0
    if ea ~= eb then return ea > eb end
    return a.lastused > b.lastused
  end)
  local cur = vim.api.nvim_get_current_buf()
  local ret = vim.tbl_map(function(b) return file(b.name, b.bufnr) end, infos)
  for i, f in ipairs(ret) do
    if f.buf == cur then
      table.remove(ret, i)
      table.insert(ret, 1, f)
      break
    end
  end
  return ret
end

-- The switcher the app has open (token), and the files it lists
local native = { token = 0, files = {}, open = false } ---@type {token: integer, files: SwitcherFile[], open: boolean}

-- A files row: name, path as shown, git status (the name's color), errors (red wave), edited
---@param f SwitcherFile
local function row(f)
  local valid = f.buf and vim.api.nvim_buf_is_valid(f.buf)
  local modified = valid and vim.bo[f.buf].modified
  return {
    name = f.name,
    path = vim.fn.fnamemodify(f.path, ":~:."),
    modified = modified == true,
    status = require("git.status").of(f.path) or "",
    error = valid and require("config.tabbar").has_errors(f.buf) or false,
    -- changed this session, or with undo history (a persistent undofile: edited before too, like WS's
    -- recently edited files)
    edited = edited[f.path] == true or (valid and (vim.fn.undotree(f.buf).seq_last or 0) > 0) or false,
  }
end

local function tool_rows()
  local tools = {}
  for i, t in ipairs(TOOLS) do tools[i] = { name = t[1], key = t[3], icon = t[2], column = t.column } end
  return tools
end

---@param opts? {wait?: boolean, back?: boolean} wait = false: stays open on Ctrl release (tests, screenshots);
--- back: Ctrl+Shift+Tab, starts at the bottom (moves up when open)
function M.open(opts)
  opts = opts or {}
  -- already open (Ctrl+Tab again before the app gave it the keyboard): the app moves its selection
  if native.open then
    return require("config.app.bridge").notify("pickers", { event = "switcher_step", token = native.token, back = opts.back == true })
  end
  vim.cmd.stopinsert()
  local files = recent_files()
  -- (the Chat column has the keyboard: no file is current, nvim's window is still the split; the terminal's
  -- host window is no file's either)
  local away = require("config.app").native()
  local cur = (away == "terminal" or away == "chat") and -1 or vim.api.nvim_get_current_buf()
  native = { token = native.token + 1, files = files, open = true }
  require("config.app.bridge").notify("pickers", {
    event = "switcher", token = native.token, files = vim.tbl_map(row, files), tools = tool_rows(),
    back = opts.back == true, wait = opts.wait ~= false, current_on_top = files[1] ~= nil and files[1].buf == cur,
  })
end

-- Most files Recent Files lists (WS "editor.recent.files.limit" default 50)
local RECENT_MAX = 50

-- Recent Files: the switcher in its recent mode. Open files (most recent first, the current one on top),
-- then the file history (vim.v.oldfiles: existing files, this project's unless `all`).
---@param opts? {all?: boolean, edited_only?: boolean}
function M.recent(opts)
  opts = opts or {}
  vim.cmd.stopinsert()
  local files = recent_files()
  local seen = {}
  for _, f in ipairs(files) do seen[f.path] = true end
  local cwd = vim.fs.normalize(vim.fn.getcwd()) .. "/"
  local skip = { vim.fn.stdpath("data"), vim.fn.stdpath("cache"), vim.fn.stdpath("state") }
  for _, p in ipairs(vim.v.oldfiles) do
    if #files >= RECENT_MAX then break end
    p = vim.fs.normalize(p)
    local ok = not seen[p] and (opts.all or p:sub(1, #cwd) == cwd)
    for _, s in ipairs(skip) do
      if ok and p:sub(1, #s + 1) == s .. "/" then ok = false end
    end
    if ok and vim.fn.filereadable(p) == 1 then
      seen[p] = true
      local buf = vim.fn.bufnr(p)
      files[#files + 1] = file(p, buf ~= -1 and buf or nil)
    end
  end
  local cur = vim.api.nvim_get_current_buf()
  native = { token = native.token + 1, files = files, open = true }
  require("config.app.bridge").notify("pickers", {
    event = "switcher", token = native.token, files = vim.tbl_map(row, files), tools = tool_rows(), recent = true,
    edited_only = opts.edited_only == true, wait = false, current_on_top = files[1] ~= nil and files[1].buf == cur,
  })
end

-- The app's switcher closed
---@param token integer
function M.done(token)
  if token == native.token then native.open = false end
end

-- The app's pick: a tool window or a file (1-based row) of the switcher it was opened as (token)
---@param col "tools"|"files"
---@param i integer
---@param token integer
function M.pick(col, i, token)
  if token ~= native.token then return end
  native.open = false
  if col == "tools" then
    if not (TOOLS[i] and TOOLS[i][4]) then return end
    TOOLS[i][4]()
    if vim.bo.buftype ~= "terminal" then vim.cmd.stopinsert() end
    return
  end
  local f = native.files[i]
  if not f then return end
  if require("config.app").native() then require("config.app").focus(nil) end
  focus.edit()
  if f.buf and vim.api.nvim_buf_is_valid(f.buf) then return vim.api.nvim_set_current_buf(f.buf) end
  vim.cmd.edit(vim.fn.fnameescape(f.path))
end

-- Open files, most recently used first (Go to File lists them before the rest, config/app/pickers.lua)
---@return string[]
function M.recent_paths()
  return vim.tbl_map(function(f) return f.path end, recent_files())
end

return M
