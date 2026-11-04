-- Focus: which split or tool window has it (`target`), the editor's splits (`is_split`, `split_win`), and
-- the keys that act on whatever has focus: Cmd+1, ,w / ,q, Alt+Cmd+Left/Right.
-- Tool windows and viewers register themselves (`register`), so this module never loads them.
local M = {}

---@class FocusTool
---@field is_focused fun(): boolean
---@field close fun() close what has focus (M.close)
---@field cycle? fun(dir: integer) Alt+Cmd+Left/Right: its tabs (none: the editor tabs)
---@field is_active? fun(): boolean viewer (diff viewer / merge window): open?
---@field wins? fun(): integer[] viewer: its windows, the split it took over first
---@field owns? fun(win: integer): boolean tool window: is win one of its windows?

local TOOLS = { "terminal", "git", "pane", "diff", "merge" } -- tool windows and viewers, in the order they're asked
local VIEWERS = { "diff", "merge" }
local tools = {} ---@type table<string, FocusTool>

---@param id "terminal"|"git"|"pane"|"diff"|"merge"
---@param tool FocusTool
function M.register(id, tool)
  tools[id] = tool
end

-- The open viewer; it takes the place of the split it opened in
---@return "diff"|"merge"|nil
function M.viewer()
  for _, id in ipairs(VIEWERS) do
    local t = tools[id]
    if t and t.is_active() then return id end
  end
end

-- Windows of the open viewer, the split it took over first
---@return integer[]
function M.viewer_wins()
  local id = M.viewer()
  return id and tools[id].wins() or {}
end

function M.is_viewer_win(win)
  return vim.tbl_contains(M.viewer_wins(), win)
end

-- A window of the Terminal or Git tool window or the bottom pane (they say which are theirs)
---@param win integer
function M.is_tool_win(win)
  for _, id in ipairs({ "terminal", "git", "pane" }) do
    local t = tools[id]
    if t and t.owns and t.owns(win) then return true end
  end
  return false
end

-- An editor split: a window showing a file, not a tool window, popup or terminal. The open viewer's
-- windows count only with `viewer` (those showing a file: the split it took over keeps its file there).
---@param win integer
---@param viewer? boolean
function M.is_split(win, viewer)
  if vim.api.nvim_win_get_config(win).relative ~= "" then return false end
  local buf = vim.api.nvim_win_get_buf(win)
  if vim.bo[buf].buftype ~= "" or vim.bo[buf].filetype:match("^snacks_") then return false end
  return (viewer or not M.is_viewer_win(win)) and not M.is_tool_win(win) -- (a file there is on its way out)
end

---@alias FocusTarget "tree"|"terminal"|"git"|"pane"|"diff"|"merge"|"split"|"popup"|"other"

-- What has focus: a native surface of the app (its tree, the Git tool window, popups, pickers) first, then the
-- tool windows / viewers
---@return FocusTarget
function M.target()
  local native = require("config.app").native()
  -- (the terminal's lazygit float is a popup)
  if native == "terminal" then return require("config.app.terminal").float_focused() and "popup" or "terminal" end
  if native == "pane" then return "pane" end -- the bottom pane's host (config/app/pane.lua)
  if native then return (native == "tree" or native == "git") and native or "popup" end
  for _, id in ipairs(TOOLS) do
    local t = tools[id]
    if t and t.is_focused() then return id end
  end
  local win = vim.api.nvim_get_current_win()
  if vim.api.nvim_win_get_config(win).relative ~= "" then return "popup" end
  return M.is_split(win, true) and "split" or "other"
end

-- Last split that had focus: files opened from the tree / a tool window go there
local last ---@type integer?
vim.api.nvim_create_autocmd("WinEnter", {
  group = vim.api.nvim_create_augroup("ws_last_split", { clear = true }),
  callback = function()
    local win = vim.api.nvim_get_current_win()
    if M.is_split(win) then last = win end
  end,
})

-- Current window if it's a split, else the last focused split, else the previous window, else the first
---@param except? integer never this window
function M.split_win(except)
  local function ok(w) return w ~= except and vim.api.nvim_win_is_valid(w) and M.is_split(w, true) end
  local cur = vim.api.nvim_get_current_win()
  if ok(cur) then return cur end
  if last and ok(last) then return last end
  local prev = vim.fn.win_getid(vim.fn.winnr("#"))
  if prev ~= 0 and ok(prev) then return prev end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if ok(win) then return win end
  end
end

-- A tool window only ever shows its own buffers. Whatever put another one there (Ctrl+O / Ctrl+I / Ctrl+^
-- through the window's jumplist and alternate file, which it got from the window it was split from; :e, :b,
-- :bnext, ...): a file opens in the last focused split instead, focused; anything else (the tree's list) just
-- goes. The tool window gets its own buffer back. Synchronous, in BufWinEnter, so nothing is drawn in
-- between; nested, so the split gets its own BufWinEnter (tab, gutter). The command goes on in the split:
-- a jump's cursor lands there.
local function is_tool_buf(buf)
  return vim.b[buf].ws_tool == true
end

-- A tool window's new buffer before it is marked `b:ws_tool`: an empty unlisted buffer
local function is_fresh(buf)
  return vim.bo[buf].buftype == "" and not vim.bo[buf].buflisted and vim.api.nvim_buf_get_name(buf) == ""
end

local function is_file(buf)
  return vim.bo[buf].buftype == "" and (vim.bo[buf].buflisted or vim.api.nvim_buf_get_name(buf) ~= "")
end

local tool_bufs = {} ---@type table<integer, integer> window -> the last tool buffer it showed

---@param win integer tool window now showing buf
---@param buf integer
local function evict(win, buf)
  local target ---@type integer?
  if is_file(buf) then
    target = M.split_win(win)
    if not target then -- no split left: a new one above the tool window
      target = vim.api.nvim_open_win(buf, false, { split = "above", win = win })
    else
      vim.api.nvim_win_set_buf(target, buf)
    end
  end
  local back = tool_bufs[win]
  if back and vim.api.nvim_buf_is_valid(back) then
    vim.api.nvim_win_set_buf(win, back)
  else
    pcall(vim.api.nvim_win_close, win, true)
  end
  if target then vim.api.nvim_set_current_win(target) end
end

local tool_group = vim.api.nvim_create_augroup("ws_tool_wins", { clear = true })
vim.api.nvim_create_autocmd("BufWinEnter", {
  group = tool_group,
  nested = true,
  callback = function(ev)
    local win = vim.api.nvim_get_current_win()
    local buf = vim.api.nvim_win_get_buf(win)
    if buf ~= ev.buf then return end
    if is_tool_buf(buf) then
      tool_bufs[win] = buf
    elseif not is_fresh(buf) and M.is_tool_win(win) then
      evict(win, buf)
    end
  end,
})
vim.api.nvim_create_autocmd("WinClosed", {
  group = tool_group,
  callback = function(ev) tool_bufs[tonumber(ev.match) or -1] = nil end,
})

-- Before opening a file: the focused / last focused split
function M.edit()
  vim.cmd.stopinsert()
  local win = M.split_win()
  if win then vim.api.nvim_set_current_win(win) end
end

-- Esc (tool windows), the Chat column's Esc: back to the editor, or into the viewer when one is open
function M.editor()
  vim.cmd.stopinsert()
  -- a native surface gives the keyboard back to Neovim
  if require("config.app").native() then require("config.app").focus(nil) end
  local views = M.viewer_wins()
  local function ok(w) return w ~= 0 and vim.api.nvim_win_is_valid(w) and (M.is_split(w, true) or vim.tbl_contains(views, w)) end
  local cur, prev = vim.api.nvim_get_current_win(), vim.fn.win_getid(vim.fn.winnr("#"))
  if ok(cur) then return end
  local win = ok(prev) and prev or views[1] or M.split_win()
  if win then vim.api.nvim_set_current_win(win) end
end

-- Cmd+1 (the app's pane key, app/src/shell/pane_key.rs: it closes the tree itself when the tree has the keys): open /
-- focus the native tree (config/tree.lua tells it)
function M.tree()
  vim.cmd.stopinsert()
  if M.target() ~= "tree" then require("config.tree").focus() end
end

-- A native Board shortcut reveals its destination; an already open tool behind Board is
-- not a repeated toggle. Keep this in one RPC so focus acknowledgement cannot split the action.
---@param target "tree"|"editor"|"git"|"terminal"
function M.reveal(target)
  if target == "tree" then
    vim.cmd.stopinsert()
    require("config.tree").focus()
  elseif target == "editor" then
    M.editor()
  elseif target == "git" then
    require("config.app.git").open()
  elseif target == "terminal" then
    require("config.app.terminal").show()
  else
    error("Unknown native focus destination: " .. tostring(target))
  end
end

-- Close whatever has focus (terminal tab / Git tool window / viewer / tree / editor tab). The app's Cmd+Q is
-- Close Project (Rust)
function M.close()
  local target = M.target()
  local tool = tools[target]
  if tool then return tool.close() end
  if target == "tree" then return require("config.tree").close() end
  vim.cmd.stopinsert()
  require("config.editor_tabs").close()
end

-- ,w / ,q: close what has focus: the viewer when in it (or in the Git tool window under it), else the tree /
-- Git tool window (hidden), the terminal tab, the editor tab (M.close). (In the native terminal `,` is the
-- shell's: its tabs close with exit / Ctrl+D / × / its menu.)
function M.close_file()
  local target, viewer = M.target(), M.viewer()
  if viewer and (target == viewer or target == "git") then return tools[viewer].close() end
  M.close()
end

-- Close Split (editor menu): close the split you're in, with its tabs (files still open in another split
-- stay); without another split, the editor tab
function M.close_split()
  local cur = vim.api.nvim_get_current_win()
  local splits = vim.tbl_filter(function(w) return M.is_split(w, true) end, vim.api.nvim_tabpage_list_wins(0))
  if #splits > 1 and M.is_split(cur) then
    return vim.api.nvim_win_close(cur, false)
  end
  M.close_file()
end

-- Alt+Cmd+Left/Right (and Ctrl+Cmd+Left/Right on Code, but in Chat: the app calls this): tabs of whatever has
-- focus (terminal tabs, Git tabs, diff files; else the editor tabs of the focused / last focused split)
function M.cycle_tabs(dir)
  local tool = tools[M.target()]
  if tool and tool.cycle then return tool.cycle(dir) end
  require("config.editor_tabs").cycle(dir)
end

return M
