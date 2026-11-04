-- The app's native context menu (app/src/popups): config/menu.lua's M.open sends the resolved items here. Rust shows it (WebStorm popup menu, the same keys / mouse), then answers by id:
--   choose(id, index, mouse)  the item at `index` (1-based, in the items sent) runs; mouse: picked with the mouse
--                             (menu.lua's last_mouse: a follow-up vim.ui.select opens at the mouse too)
--   cancel(id, restore) Esc / Cmd+Enter (restore: back to the origin's mode / selection) or a click outside (no restore)
-- Lua keeps the items' actions, the origin (popup.origin) and on_cancel.
local M = {}

local bridge = require("config.app.bridge")
local popup = require("config.popup")

---@class AppMenu
---@field id integer
---@field items MenuEntry[]
---@field opts MenuOpts
---@field origin PopupOrigin

local open ---@type AppMenu?
local last_id = 0

-- Color of a highlight group as an RGB int (the app has no highlight groups)
---@return integer?, boolean
local function group(name)
  local hl = vim.api.nvim_get_hl(0, { name = name, link = false })
  return hl.fg, hl.bold == true
end

-- An item's own icon glyph (config/icons.lua's file kinds, menu / markdown action glyphs) by a name the app maps
-- to a WebStorm SVG; by glyph + group first (tsx / jsx share a glyph)
local icon_names ---@type table<string, string>?
local ACTIONS = {
  ["\u{eae9}"] = "editor_only", ["\u{eb56}"] = "split_right", ["\u{eb2f}"] = "preview_only", ["\u{eb57}"] = "split_down",
  ["\u{f0190}"] = "cut", ["\u{ebcc}"] = "copy", ["\u{f0a38}"] = "paste", ["\u{ea61}"] = "intention",
  ["\u{ea82}"] = "history", ["\u{ea85}"] = "terminal",
}
---@param icon? string[] { glyph, group }
---@return string?
local function icon_name(icon)
  if not icon or not icon[1] then return end
  if not icon_names then
    icon_names = vim.deepcopy(ACTIONS)
    for name, i in pairs(require("config.icons").I) do
      icon_names[i.glyph .. "|" .. i.hl] = name
      icon_names[i.glyph] = icon_names[i.glyph] or name
    end
  end
  return icon_names[icon[1] .. "|" .. (icon[2] or "")] or icon_names[icon[1]]
end

-- Chunks { text, group } as one text and its colored ranges (the default title color: none)
---@param chunks? string[][]
---@return string, table[]
local function chunks_hl(chunks)
  local text, hl = "", {}
  for _, c in ipairs(chunks or {}) do
    local s = #text
    text = text .. c[1]
    if c[2] and c[2] ~= "WsMenuTitle" and c[2] ~= "WsMenu" then
      local fg, bold = group(c[2])
      if fg or bold then hl[#hl + 1] = { s = s, e = #text, fg = fg, bold = bold } end
    end
  end
  local lead = #text:match("^%s*")
  text = vim.trim(text)
  for _, h in ipairs(hl) do
    h.s, h.e = math.max(h.s - lead, 0), math.max(math.min(h.e - lead, #text), 0)
  end
  return text, hl
end

---@param item MenuEntry
local function entry(item)
  if item == "-" then return { sep = true } end
  -- an info line (P-12): dim text the menu only says, never a grey item
  if type(item) == "table" and item.info then return { info = item.info } end
  local e = {
    label = item[1], key = item.key, enabled = item.enabled ~= false, file = item.file, icon = icon_name(item.icon),
  }
  if item.hl then
    e.hl = {}
    for _, h in ipairs(item.hl) do
      local fg, bold = group(h[3])
      e.hl[#e.hl + 1] = { s = h[1], e = h[2], fg = fg, bold = bold }
    end
  end
  return e
end

-- Where it opens: opts.pos (window px, from a native surface), the mouse, or below nvim's caret (a cell of `win`)
---@param at "mouse"|"cursor"
---@param pos? {x: number, y: number}
function M.anchor(at, pos)
  if pos then return { pos = pos } end
  if at == "mouse" then return { at = "mouse" } end
  local win = vim.api.nvim_get_current_win()
  local cur = vim.api.nvim_win_get_cursor(win)
  local p = vim.fn.screenpos(win, cur[1], cur[2] + 1)
  if p.row == 0 then return { at = "cursor", win = win, row = 0, col = 0 } end
  local wp = vim.api.nvim_win_get_position(win)
  return { at = "cursor", win = win, row = p.row - 1 - wp[1], col = p.col - 1 - wp[2] }
end

---@param items MenuEntry[]
---@param opts MenuOpts
---@param origin PopupOrigin
---@param anchor table M.anchor(...)
function M.open(items, opts, origin, anchor)
  -- a menu open already goes: back to its origin, no on_cancel
  if open then
    local o = open
    open = nil
    popup.back(o.origin)
  end
  last_id = last_id + 1
  open = { id = last_id, items = items, opts = opts, origin = origin }
  local header = opts.header
  local title, right, title_hl, right_hl = opts.title, nil, nil, nil
  if header then
    title, title_hl = chunks_hl(header.left)
    right, right_hl = chunks_hl(header.right)
  end
  bridge.notify("popups", {
    event = "menu",
    id = last_id,
    items = vim.tbl_map(entry, items),
    title = title,
    title_hl = title_hl,
    header_right = right,
    header_right_hl = right_hl,
    icons = opts.icons ~= false,
    match_key = opts.match_key == true,
    max_width = opts.max_width,
    max_height = opts.max_height,
    anchor = anchor,
  })
end

---@param id integer
---@param index integer
---@param mouse? boolean picked with the mouse
function M.choose(id, index, mouse)
  require("config.menu").set_last_mouse(mouse == true)
  if not open or open.id ~= id then return end
  local m = open
  open = nil
  local item = m.items[index]
  popup.back(m.origin, { visual = false })
  local fn = type(item) == "table" and item[2] or nil
  if fn then vim.schedule(fn) end
end

---@param id integer
---@param restore boolean
function M.cancel(id, restore)
  if not open or open.id ~= id then return end
  local m = open
  open = nil
  if restore then popup.back(m.origin) end
  if m.opts.on_cancel then m.opts.on_cancel() end
end

-- A click outside the menu reached nvim: the app dismissed the menu, but its cancel(id, false) is sent after
-- the click and can run after it. Answered the same way now, so a menu the click opens never puts the caret
-- back at this one's origin; the late cancel then finds no menu.
function M.dismissed()
  if open then M.cancel(open.id, false) end
end

-- Closed from code (no caller today; kept for symmetry with the terminal float)
function M.close()
  if not open then return end
  bridge.notify("popups", { event = "menu_close", id = open.id })
  open = nil
end

function M.is_open()
  return open ~= nil
end

-- Test hook: labels of the items sent (the app filters / selects itself)
---@return string[]?
function M.shown()
  if not open then return end
  return vim.tbl_map(function(it) return type(it) == "table" and (it[1] or it.info) or "" end, open.items)
end

return M
