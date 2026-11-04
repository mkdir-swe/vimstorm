-- Tells the app which of Neovim's windows are editor splits, viewer windows or bottom tool windows (by window
-- handle), whenever that changes: the app lays them out as islands (editor splits get a native tab bar, the
-- bottom tool window spans the full width under the tree), with the windows native surfaces are drawn over (role:
-- "git" the Git tool window's host, "terminal" the terminal's host, "markdown" a markdown preview; other modules
-- add theirs with M.role_provider) and sync groups (diff / merge panes presented together). Rust side:
-- app/src/shell (vimstorm.layout).
local bridge = require("config.app.bridge")
local M = {}

---@class AppLayoutWin
---@field win integer window handle
---@field kind "split"|"viewer"|"tool"|"other"
---@field empty boolean the empty editor (no file open)
---@field crumbs boolean? Feel vscode (#128): the app keeps the breadcrumbs strip under the split's tab bar
---@field role? "git"|"terminal"|"pane"|"markdown" a native surface is drawn over it (its grid isn't): the Git tool
---  window's host window, the terminal's host window, a markdown preview (see M.role_provider)
---@field sync? integer sync group: windows presented together (diff / merge panes, git/scrollsync.lua)
---@field viewer? {pane: integer, panes: integer, merge: boolean, gutter: integer} a diff / merge pane: its place
---  left to right and its native gutter's cells (config/app/diff.lua; the app lays out the viewer's chrome)

---@param win integer
---@return "split"|"viewer"|"tool"|"other"
local function kind(win)
  local focus = require("config.focus")
  if focus.is_tool_win(win) then return "tool" end
  if focus.is_viewer_win(win) then return "viewer" end
  if focus.is_split(win) then return "split" end
  -- a tool window's buffer before it registered itself (a host window just opened)
  local buf = vim.api.nvim_win_get_buf(win)
  if vim.b[buf].ws_tool == true then return "tool" end
  return "other"
end

---@alias AppRoleProvider fun(win: integer): ("terminal"|"pane"|"markdown"|nil)

---@type {name: string, fn: AppRoleProvider}[]
local providers = {}

-- Registers (or replaces, by name) a function that gives windows a role, so modules set roles without editing
-- this file. Asked for every split window after Git's host; the first non-nil answer wins. Call M.sync() when
-- your answer for a window changes outside the autocmds below.
---@param name string the module's name (e.g. "terminal", "markdown")
---@param fn AppRoleProvider
function M.role_provider(name, fn)
  for _, p in ipairs(providers) do
    if p.name == name then
      p.fn = fn
      return
    end
  end
  providers[#providers + 1] = { name = name, fn = fn }
end

---@param win integer
---@param git? integer the Git tool window's host
---@return string?
local function role(win, git)
  if win == git then return "git" end
  for _, p in ipairs(providers) do
    local ok, r = pcall(p.fn, win)
    if ok and r then return r end
  end
end

-- A code split with the WebStorm gutter (config/gutter.lua COLUMN): its first text column, which the app
-- draws a few px left (WebStorm's number -> code gap isn't whole cells)
---@return integer?
local function textoff(win, k)
  if k ~= "split" or vim.wo[win].statuscolumn ~= require("config.gutter").COLUMN then return nil end
  local info = vim.fn.getwininfo(win)[1]
  return info and info.textoff or nil
end

-- The current tab page's split windows (not floats)
---@param closing? integer a window being closed (WinClosed runs while it still exists): left out
---@return AppLayoutWin[]
function M.windows(closing)
  local empty_editor = require("config.empty_editor")
  local git = require("config.app.git").win()
  local sync = package.loaded["git.scrollsync"]
  local viewer = package.loaded["config.app.diff"]
  local vscode = require("config.feel").name() == "vscode"
  local out = {}
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if win ~= closing and vim.api.nvim_win_get_config(win).relative == "" then
      local k = kind(win)
      local r = role(win, git)
      out[#out + 1] = {
        win = win,
        kind = k,
        -- a role window is never the empty editor (its surface covers it)
        empty = k == "split" and r == nil and empty_editor.is_empty(vim.api.nvim_win_get_buf(win)),
        role = r,
        sync = sync and sync.group_of(win) or nil,
        viewer = k == "viewer" and viewer and viewer.layout_info(win) or nil,
        textoff = textoff(win, k),
        crumbs = vscode and k == "split" and r == nil and not empty_editor.is_empty(vim.api.nvim_win_get_buf(win)) or nil,
      }
    end
  end
  return out
end

local last = ""

-- Sends the windows when they changed (force: anyway)
---@param force? boolean
---@param closing? integer see M.windows
function M.sync(force, closing)
  local ok, wins = pcall(M.windows, closing)
  if not ok then return end
  local parts = {}
  for _, w in ipairs(wins) do
    local v = w.viewer
    parts[#parts + 1] = w.win .. w.kind .. tostring(w.empty) .. (w.role or "") .. (w.sync or "") .. "/" .. (w.textoff or "")
      .. (w.crumbs and ">" or "")
      .. (v and (v.pane .. "/" .. v.panes .. tostring(v.merge) .. v.gutter) or "")
  end
  local key = table.concat(parts, ",")
  if key == last and not force then return end
  last = key
  bridge.notify("layout", { event = "windows", wins = wins })
end

local pending = false
local function later()
  if pending then return end
  pending = true
  vim.schedule(function()
    pending = false
    M.sync()
  end)
end

-- The line numbers' width follows the line count's digits (textoff with it): check when the digits change
local digits = {} ---@type table<integer, integer>
local function count_digits(ev)
  local n = #tostring(vim.api.nvim_buf_line_count(ev.buf))
  if digits[ev.buf] ~= n then
    digits[ev.buf] = n
    later()
  end
end

function M.setup()
  local group = vim.api.nvim_create_augroup("ws_app_layout_digits", { clear = true })
  -- Feel vscode keeps a breadcrumbs strip under each split's tab bar (#128)
  require("config.feel").on_change(function(now, before)
    if now.feel ~= before.feel then later() end
  end)
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "BufReadPost" }, { group = group, callback = count_digits })
  vim.api.nvim_create_autocmd("BufWipeout", { group = group, callback = function(ev) digits[ev.buf] = nil end })
  vim.api.nvim_create_autocmd("OptionSet", {
    group = group,
    pattern = { "number", "relativenumber", "numberwidth", "statuscolumn", "signcolumn" },
    callback = later,
  })
  vim.api.nvim_create_autocmd(
    { "WinNew", "WinClosed", "BufWinEnter", "TermOpen", "FileType", "WinEnter", "TabEnter", "VimEnter", "UIEnter" },
    {
      group = vim.api.nvim_create_augroup("ws_app_layout", { clear = true }),
      callback = function(ev)
        -- now: it reaches the app before the redraw that shows the window; again once the owner set it up. A
        -- closing window is left out at once: the app must not resize its grid (gone by the time a resize
        -- would arrive: an "Invalid window handle" error)
        M.sync(false, ev.event == "WinClosed" and tonumber(ev.match) or nil)
        later()
      end,
    }
  )
end

return M
