-- The app's editor tab bars (Rust: app/src/editor/tabs): each split's tabs as config/editor_tabs.lua keeps them, sent to
-- the app whenever what a tab bar shows changes (tabs, active tab, names, git status color, errors, which split has
-- focus, the split set). Nothing per keystroke: callers are tab / window / buffer events, and an unchanged
-- payload isn't sent again. Rust draws the bars and calls back here (activate, close, menus).
local bridge = require("config.app.bridge")
local M = {}

---@class AppTab
---@field buf integer
---@field name string label: file name, "parent/name" when two tabs share a name, "untitled"
---@field path string
---@field status string git file status ("Modified", "Added", "Unversioned", "Ignored", "Deleted", "Conflict"; "" unchanged)
---@field error boolean compiler errors in the file (red wavy underline)
---@field readonly boolean read-only (WebStorm's lock on the icon)
---@field modified boolean unsaved (the Feel's tabs.dirtyDot: VS Code's ● in place of the ×)
---@field preview boolean the split's preview tab (the Feel's tabs.preview: VS Code's italic name)

---@class AppTabBar
---@field win integer
---@field tabs AppTab[]
---@field active integer? buffer of the active tab
---@field focused boolean the split has the keyboard (selected tab: blue box, else gray)
---@field crumbs table? Feel vscode's breadcrumbs (config/statusline.lua breadcrumbs), drawn in the strip under the bar

-- Focus target under a popup (config/focuscue.lua keeps the one under it too)
local last_target = "split"

---@return AppTabBar[]
function M.bars()
  local editor_tabs = require("config.editor_tabs")
  local tabbar = require("config.tabbar")
  local status = require("git.status")
  local target = require("config.focus").target()
  if target == "popup" then target = last_target else last_target = target end
  local app_focused = require("config.focuscue").app_focused()
  local cur = vim.api.nvim_get_current_win()
  local crumbs = require("config.feel").name() == "vscode" and require("config.statusline").breadcrumbs or nil
  local out = {}
  for _, win in ipairs(editor_tabs.splits()) do
    local bufs = editor_tabs.tabs(win)
    local names = tabbar.names(bufs)
    local tabs = {}
    for _, b in ipairs(bufs) do
      local path = vim.api.nvim_buf_get_name(b)
      tabs[#tabs + 1] = {
        buf = b, name = names[b], path = path, status = status.of(path), error = tabbar.has_errors(b),
        readonly = vim.bo[b].readonly or not vim.bo[b].modifiable,
        modified = vim.bo[b].modified, preview = editor_tabs.is_preview(win, b),
      }
    end
    local shown = vim.api.nvim_win_get_buf(win)
    out[#out + 1] = {
      win = win,
      tabs = tabs,
      active = vim.tbl_contains(bufs, shown) and shown or nil,
      focused = app_focused and (target == "split" or target == "diff" or target == "merge") and win == cur,
      crumbs = crumbs and crumbs(win) or nil,
    }
  end
  return out
end

local last = ""

-- Sends the tab bars when they changed (force: anyway)
---@param force? boolean
function M.sync(force)
  local ok, bars = pcall(M.bars)
  if not ok then return end
  local key = vim.json.encode(bars)
  if key == last and not force then return end
  last = key
  bridge.notify("tabs", { event = "bars", bars = bars })
end

local pending = false
local crumbs_pending = false -- Feel vscode's breadcrumbs: one send per batch of caret moves
-- Something a tab bar shows may have changed: send now (it reaches the app before the redraw that goes with it)
-- and once more after the event's other handlers ran (coalesced)
function M.changed()
  M.sync()
  if pending then return end
  pending = true
  vim.schedule(function()
    pending = false
    M.sync()
  end)
end

-- Rust -> Lua ------------------------------------------------------------------------------------------------

local function valid(win, buf)
  return vim.api.nvim_win_is_valid(win) and vim.api.nvim_buf_is_valid(buf)
end

-- Click on a tab: that split gets focus and shows the tab
---@param win integer
---@param buf integer
function M.activate(win, buf)
  if not valid(win, buf) then return end
  vim.cmd.stopinsert()
  vim.api.nvim_set_current_win(win)
  if vim.api.nvim_win_get_buf(win) ~= buf then vim.api.nvim_win_set_buf(win, buf) end
end

-- Click on a tab bar's empty part: that split gets focus
---@param win integer
function M.focus_split(win)
  if not vim.api.nvim_win_is_valid(win) then return end
  vim.cmd.stopinsert()
  vim.api.nvim_set_current_win(win)
end

-- × / middle-click
---@param win integer
---@param buf integer
function M.close(win, buf)
  if not valid(win, buf) then return end
  require("config.editor_tabs").close(buf, win)
end

-- Right-click on a tab: the tab menu (config/context.lua), acting on that split, at the mouse (x, y: window px)
---@param win integer
---@param buf integer
---@param x? number
---@param y? number
function M.menu(win, buf, x, y)
  if not valid(win, buf) then return end
  vim.cmd.stopinsert()
  vim.api.nvim_set_current_win(win)
  require("config.context").tab_menu(buf, win, x and y and { x = x, y = y } or nil)
end

-- The tabs that don't fit the bar (WebStorm's hidden tabs list), under its button (x, y: window px): pick one to
-- show it
---@param win integer
---@param bufs integer[]
---@param x? number
---@param y? number
function M.hidden(win, bufs, x, y)
  if not vim.api.nvim_win_is_valid(win) then return end
  local names = require("config.tabbar").names(require("config.editor_tabs").tabs(win))
  local items = {}
  for _, b in ipairs(bufs) do
    if vim.api.nvim_buf_is_valid(b) then
      items[#items + 1] = { names[b] or vim.fn.fnamemodify(vim.api.nvim_buf_get_name(b), ":t"), function() M.activate(win, b) end }
    end
  end
  if #items > 0 then require("config.menu").open(items, { at = "mouse", pos = x and y and { x = x, y = y } or nil }) end
end

-- Setup ------------------------------------------------------------------------------------------------------

function M.setup()
  require("config.editor_tabs").on_change(M.changed)
  local group = vim.api.nvim_create_augroup("ws_app_tabs", { clear = true })
  vim.api.nvim_create_autocmd({ "WinEnter", "BufEnter", "WinClosed", "FocusGained", "FocusLost", "VimEnter", "UIEnter" }, {
    group = group,
    callback = M.changed,
  })
  -- Feel vscode's breadcrumbs follow the caret (the symbols around it); the Feel changing shows / hides them
  vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
    group = group,
    callback = function()
      if require("config.feel").name() ~= "vscode" or crumbs_pending then return end
      crumbs_pending = true
      vim.schedule(function()
        crumbs_pending = false
        M.sync()
      end)
    end,
  })
  require("config.feel").on_change(function(now, before)
    if now.feel ~= before.feel then M.changed() end
  end)
  -- a tab's unsaved mark (dirty dot): once per tick, not with every first keystroke's redraw
  vim.api.nvim_create_autocmd("BufModifiedSet", { group = group, callback = function() vim.schedule(M.sync) end })
  vim.api.nvim_create_autocmd("UIEnter", {
    group = vim.api.nvim_create_augroup("ws_app_tabs_ui", { clear = true }),
    callback = function() M.sync(true) end,
  })
end

return M
