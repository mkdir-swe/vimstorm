-- Markdown files like WebStorm's editor: three modes per file, picked with the toolbar at the editor's top-right
-- (Editor Only / Editor and Preview / Preview Only icons), the editor's right-click menu or ,m (cycles).
-- * Editor and Preview (default, as in WebStorm): raw text left, the rendered preview right (updated while typing,
--   scrolled together with the editor).
-- * Preview Only: the file itself rendered in place, read-only.
-- The mode is remembered per file for this Neovim session. The app renders the previews and draws the toolbar
-- (app/src/editor/markdown via config/app/markdown.lua): the preview window is an empty placeholder, Preview Only keeps
-- the file's window, both get role "markdown". This module keeps the modes and the windows.
local menu = require("config.menu")
local focus = require("config.focus")
local shares = require("config.shares")
local M = {}

---@alias MdMode "editor"|"split"|"preview"
local MODES = { "editor", "split", "preview" } ---@type MdMode[]
M.DEFAULT = "split" ---@type MdMode
local LABEL = { editor = "Editor Only", split = "Editor and Preview", preview = "Preview Only" }
local ICON = { editor = "\u{eae9}", split = "\u{eb56}", preview = "\u{eb2f}" } -- menu icons (WebStorm Icons font)
local MIN_WIDTH = 30 -- narrower editors get no toolbar / preview
-- The preview's share of its pair's width: the last one dragged to (any file's, this Neovim session), as
-- WebStorm keeps one splitter proportion for its editors with preview; at first half
local last_share = 0.5

local modes = {} ---@type table<string, MdMode> file -> mode
---@class MdPair
---@field win integer preview window
---@field buf integer preview buffer
---@field src integer source buffer
---@field shares Shares editor and preview keep their shares of the pair's width (config/shares.lua)
local previews = {} ---@type table<integer, MdPair> by source window
local bars = {} ---@type table<integer, {src: integer, host: integer}> by source window: the app's toolbar

---@param w integer?
local function valid_win(w) return w ~= nil and vim.api.nvim_win_is_valid(w) end
local function app() return require("config.app.markdown") end

-- A real markdown file (not a preview, hover docs or other scratch buffer), or a Layer's workflow / skill markdown
-- once abe read it (config/workflow.lua: its readable side is what the preview shows). A skill folder's other files
-- (JSON, scripts) are never one.
---@param buf integer
function M.is_md(buf)
  if not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].buftype ~= "" or vim.api.nvim_buf_get_name(buf) == "" then
    return false
  end
  if vim.bo[buf].filetype == "markdown" then return true end
  local layer = vim.b[buf].abe_layer == true and vim.b[buf].abe_layer_file
  return type(layer) == "table" and (layer.kind == "workflow" or vim.api.nvim_buf_get_name(buf):lower():match("%.md$") ~= nil)
end
local is_md = M.is_md

-- Source buffer of a preview buffer (or the buffer itself)
---@param buf integer
---@return integer
local function source_of(buf)
  local src = vim.api.nvim_buf_is_valid(buf) and vim.b[buf].ws_md_preview
  return type(src) == "number" and src or buf
end

---@param buf integer
---@return MdMode
function M.mode(buf)
  return modes[vim.api.nvim_buf_get_name(source_of(buf))] or M.DEFAULT
end

-- Preview buffer ------------------------------------------------------------------------------------

-- Keys that would edit do nothing in a preview (WebStorm's preview is read-only; no E21 messages)
local EDIT_KEYS = { "i", "a", "o", "O", "I", "A", "s", "S", "c", "C", "x", "X", "d", "D", "p", "P", "r", "R", "u", "J", "<C-r>", ".", "<Del>" }
---@param buf integer
---@param on boolean
local function read_only_keys(buf, on)
  for _, k in ipairs(EDIT_KEYS) do
    if on then
      vim.keymap.set("n", k, "<Nop>", { buffer = buf, nowait = true })
    else
      pcall(vim.keymap.del, "n", k, { buffer = buf })
    end
  end
end

---@param src integer
---@return integer
local function new_preview(src)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.b[buf].ws_md_preview = src
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].swapfile = false
  -- an empty placeholder: the app draws the preview over its window
  vim.bo[buf].modifiable = false
  vim.bo[buf].filetype = "wsmdpreview"
  read_only_keys(buf, true)
  app().preview_keys(buf, true)
  return buf
end

-- A wrapped paragraph cut off at the bottom is just clipped, like WebStorm's preview (Vim drew "@@@")
---@param fc string window 'fillchars'
local function clip_lastline(fc)
  fc = fc:gsub(",?lastline:[^,]*", "")
  return (fc == "" and "" or fc .. ",") .. "lastline: "
end

-- Preview window right of the editor at the last share (each side at least shares.MIN columns: a pane a few
-- letters wide showed a workflow's preview a letter a line)
---@param win integer source window
---@param src integer
local function open_preview(win, src)
  local buf = new_preview(src)
  local pwin = vim.api.nvim_open_win(buf, false, { split = "right", win = win })
  local wo = vim.wo[pwin]
  wo.number, wo.relativenumber, wo.cursorline, wo.list, wo.spell = false, false, false, false, false
  wo.signcolumn, wo.foldcolumn, wo.statuscolumn = "no", "1", "" -- (a blank column: text inset from the edge)
  wo.wrap, wo.linebreak, wo.breakindent = true, true, true
  wo.fillchars = clip_lastline(wo.fillchars)
  wo.scrolloff = 0
  wo.winfixbuf = true
  previews[win] = { win = pwin, buf = buf, src = src, shares = shares.new({ win, pwin }, { 1 - last_share, last_share }) }
end

local closing = {} ---@type table<integer, true> preview windows being closed by us

---@param win integer source window
local function close_preview(win)
  local p = previews[win]
  previews[win] = nil
  if p and valid_win(p.win) then
    closing[p.win] = true
    pcall(vim.api.nvim_win_close, p.win, true)
    closing[p.win] = nil
  end
end

-- Preview Only: the file rendered in place --------------------------------------------------------------

---@param buf integer
---@param on boolean
local function render_in_place(buf, on)
  if (vim.b[buf].ws_md_inplace == true) == on then return end
  vim.b[buf].ws_md_inplace = on or nil
  if on then
    vim.b[buf].ws_md_was_modifiable = vim.bo[buf].modifiable
    vim.bo[buf].modifiable = false
  elseif vim.b[buf].ws_md_was_modifiable ~= nil then
    vim.bo[buf].modifiable = vim.b[buf].ws_md_was_modifiable
    vim.b[buf].ws_md_was_modifiable = nil
  end
  read_only_keys(buf, on)
  app().preview_keys(buf, on)
end

-- Window look of Preview Only (no gutter, wrapped like the rendered text); restored when the window shows
-- something else
---@param win integer
---@param on boolean
local function style_in_place(win, on)
  local saved = vim.w[win].ws_md_style
  local wo = vim.wo[win]
  if on and not saved then
    vim.w[win].ws_md_style = { number = wo.number, statuscolumn = wo.statuscolumn, cursorline = wo.cursorline, wrap = wo.wrap,
      linebreak = wo.linebreak, foldcolumn = wo.foldcolumn, fillchars = wo.fillchars }
    -- the inset is a blank statuscolumn: a fold column showed the file's folds (- │ 2 3) beside the preview
    wo.number, wo.statuscolumn, wo.cursorline, wo.wrap, wo.linebreak, wo.foldcolumn = false, " ", false, true, true, "0"
    wo.fillchars = clip_lastline(wo.fillchars)
  elseif not on and saved then
    vim.w[win].ws_md_style = nil
    wo.number, wo.statuscolumn, wo.cursorline, wo.wrap, wo.linebreak, wo.foldcolumn = saved.number, saved.statuscolumn,
      saved.cursorline, saved.wrap, saved.linebreak, saved.foldcolumn
    if saved.fillchars then wo.fillchars = saved.fillchars end
  end
end

-- Toolbar --------------------------------------------------------------------------------------------

-- Window the toolbar sits on for source window win: its preview when there is one
local function bar_host(win)
  local p = previews[win]
  return p and valid_win(p.win) and p.win or win
end

---@param win integer source window
local function close_bar(win) bars[win] = nil end

-- The app draws the toolbar at the host's top-right (none on a narrow editor)
---@param win integer source window
---@param src integer
local function draw_bar(win, src)
  local host = bar_host(win)
  if vim.api.nvim_win_get_width(host) < MIN_WIDTH then return close_bar(win) end
  bars[win] = { src = src, host = host }
end

-- Sync all windows with the modes ------------------------------------------------------------------------

-- Splits (not the viewer's windows) showing markdown files: window -> buffer
---@return table<integer, integer>
local function md_wins()
  local out = {}
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local b = vim.api.nvim_win_get_buf(w)
    if is_md(b) and focus.is_split(w) then out[w] = b end
  end
  return out
end

-- Window styling only (cheap; right away on BufWinEnter, so another file never shows a frame in preview style)
local function sync_styles()
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    if vim.w[w].ws_md_style then
      local b = vim.api.nvim_win_get_buf(w)
      if not (is_md(b) and M.mode(b) == "preview" and focus.is_split(w, true)) then style_in_place(w, false) end
    end
  end
end

function M.sync()
  local wins = md_wins()
  sync_styles()
  for win, p in pairs(previews) do
    local src = wins[win]
    if not (src and M.mode(src) == "split" and valid_win(p.win) and p.src == src) then close_preview(win) end
  end
  -- in-place rendering per buffer
  local inplace = {} ---@type table<integer, boolean>
  for _, b in pairs(wins) do inplace[b] = M.mode(b) == "preview" end
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.b[b].ws_md_inplace and not inplace[b] then render_in_place(b, false) end
  end
  for b, on in pairs(inplace) do render_in_place(b, on) end
  for win, src in pairs(wins) do
    local mode = M.mode(src)
    style_in_place(win, mode == "preview")
    if mode == "split" and not previews[win] and vim.api.nvim_win_get_width(win) >= 2 * MIN_WIDTH then open_preview(win, src) end
  end
  for win in pairs(bars) do
    if not wins[win] then close_bar(win) end
  end
  for win, src in pairs(wins) do draw_bar(win, src) end
  local list = {}
  for win, src in pairs(wins) do
    local p = previews[win]
    list[#list + 1] = { win = win, buf = src, mode = M.mode(src), preview = p and valid_win(p.win) and p.win or nil,
      bar = bars[win] ~= nil, host = bar_host(win) }
  end
  table.sort(list, function(a, b) return a.win < b.win end)
  app().changed(list)
end

local pending = false
local function sync_later()
  if pending then return end
  pending = true
  vim.schedule(function()
    pending = false
    M.sync()
  end)
end

-- A file became (or stopped being) previewable (config/workflow.lua): sync soon
function M.refresh() sync_later() end

-- Set the mode of a file (default: the current window's)
---@param mode MdMode
---@param buf? integer
---@param win? integer the source window it was picked in (toolbar)
function M.set(mode, buf, win)
  buf = source_of(buf or vim.api.nvim_get_current_buf())
  if not is_md(buf) then return end
  -- picked in a preview that goes away: focus goes to its editor
  local cur, from = vim.api.nvim_get_current_win(), nil
  for w, p in pairs(previews) do
    if p.win == cur then from = w end
  end
  modes[vim.api.nvim_buf_get_name(buf)] = mode
  M.sync()
  if from and not valid_win(cur) and valid_win(from) then vim.api.nvim_set_current_win(from) end
  if win and valid_win(win) and from == nil and vim.api.nvim_get_current_win() ~= win
    and vim.api.nvim_win_get_config(vim.api.nvim_get_current_win()).relative ~= "" then
    vim.api.nvim_set_current_win(win)
  end
end

---@param mode MdMode
---@return MdMode
local function next_mode(mode)
  for k, m in ipairs(MODES) do
    if m == mode then return MODES[k % #MODES + 1] end
  end
  return M.DEFAULT
end

-- ,m: Editor Only -> Editor and Preview -> Preview Only -> ...
---@param buf? integer
function M.cycle(buf)
  buf = source_of(buf or vim.api.nvim_get_current_buf())
  if not is_md(buf) then return end
  M.set(next_mode(M.mode(buf)), buf)
end

-- Menu items (editor right-click on a markdown file, preview); ,m shows on the one it goes to
---@param buf integer
---@return MenuEntry[]
function M.menu_items(buf)
  buf = source_of(buf)
  if not is_md(buf) then return {} end
  local cur = M.mode(buf)
  local items = { "-" } ---@type MenuEntry[]
  for _, m in ipairs(MODES) do
    items[#items + 1] = { LABEL[m] .. (m == cur and "  ✓" or ""), function() M.set(m, buf) end,
      key = m == next_mode(cur) and ",m" or nil, icon = { ICON[m], "WsMenuIcon" } }
  end
  return items
end

-- The share of its pair's width a preview opens at
function M.preview_share() return last_share end

-- Test hook: the current tab's markdown editors
function M.state()
  local out = {}
  for win, src in pairs(md_wins()) do
    local p, b = previews[win], bars[win]
    out[#out + 1] = {
      win = win, buf = src, mode = M.mode(src), preview = p and p.win, preview_buf = p and p.buf,
      bar = b and b.host, bar_host = b and b.host,
      rendered = vim.b[src].ws_md_inplace == true, modifiable = vim.bo[src].modifiable,
    }
  end
  return out
end

function M.setup()
  local group = vim.api.nvim_create_augroup("ws_markdown", { clear = true })
  vim.api.nvim_create_autocmd("BufWinEnter", {
    group = group,
    callback = function()
      sync_styles()
      sync_later()
    end,
  })
  vim.api.nvim_create_autocmd({ "FileType", "WinClosed", "WinResized", "VimResized", "TabEnter", "BufWipeout" }, {
    group = group,
    callback = function(ev)
      if ev.event == "WinClosed" then
        local w = tonumber(ev.match)
        -- the preview closed by hand (:q): that file goes back to Editor Only
        for src, p in pairs(previews) do
          if p.win == w and not closing[w] then
            previews[src] = nil
            if vim.api.nvim_buf_is_valid(p.src) then modes[vim.api.nvim_buf_get_name(p.src)] = "editor" end
          end
        end
      end
      if ev.event == "FileType" and ev.match ~= "markdown" then return end
      sync_later()
    end,
  })
  -- the layout around a pair changed (tree opened, window resized): it keeps its proportion; a dragged divider
  -- (same total) sets a new one, also the one the next preview opens at (another file, this one again)
  vim.api.nvim_create_autocmd("WinResized", {
    group = group,
    callback = function()
      for _, p in pairs(previews) do
        if shares.update(p.shares) then last_share = p.shares.shares[2] end
      end
    end,
  })
  -- right-click / Cmd+Enter in a preview (the app's own right-click adds Copy: config/app/markdown.lua)
  menu.provider(5, function(_, buf)
    if not vim.b[buf].ws_md_preview then return end
    local items = M.menu_items(buf)
    table.remove(items, 1)
    return items
  end)
  -- the app sends the text and scrolls both sides itself (config/app/markdown.lua)
  app().setup()
  vim.keymap.set("n", "<leader>m", function() M.cycle() end, { desc = "Markdown: editor / editor + preview / preview" })
end

return M
