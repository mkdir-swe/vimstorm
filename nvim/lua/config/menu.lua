-- WebStorm-style popup menu: right-click, or Cmd+Enter at the cursor. Also backs vim.ui.select (code actions,
-- confirmations). The app draws it natively (config/app/menu.lua -> app/src/popups: keys, speed search after /,
-- mouse); Lua keeps the items' actions and where it opened from (config/popup.lua's origin). Each split / tool
-- window registers what its menu holds (M.provider) and special left-clicks (M.zone).
local M = {}

---@class MenuItem
---@field [1] string label
---@field [2]? fun() action
---@field key? string shortcut shown on the right
---@field enabled? boolean false greys it out
---@field icon? string[] { text, hl } before the label
---@field hl? {[1]: integer, [2]: integer, [3]: string}[] byte ranges in the label to highlight
---@field focus? integer label byte kept visible when a long label is cut (usages: the name)

---@class MenuInfo
---@field info string dim text the menu only says (wraps; never chosen, never searched)

---@alias MenuEntry MenuItem|MenuInfo|"-" "-" = separator

---@class MenuOpts
---@field title? string shown as a header row
---@field icons? boolean false: no icon column from the label table (vim.ui.select: code actions...)
---@field at? "mouse"|"cursor" where it opens (default: the mouse after a click, else the cursor)
---@field on_cancel? fun()
---@field header? {left: string[][], right?: string[][]} fixed header row (chunks { text, hl }), e.g. "Usages of x   3 usages"
---@field max_width? integer longer labels are cut with "…"
---@field max_height? integer rows shown; more scroll
---@field match_key? boolean the speed search also matches the right column (usages: file name)
---@field mode? "n"|"i" mode to go back to on close (default: the current one)
---@field pos? {x: number, y: number} app only: top-left in window px (a native surface's menu: the tree)

-- Was the last key a mouse key? Then follow-up menus (vim.ui.select) open at the mouse too
local MOUSE = {}
for _, k in ipairs({ "<LeftMouse>", "<LeftRelease>", "<RightMouse>", "<RightRelease>", "<2-LeftMouse>", "<MiddleMouse>",
  "<2-RightMouse>", "<3-RightMouse>", "<4-RightMouse>" }) do
  MOUSE[vim.keycode(k)] = true
end
local last_mouse = false
vim.on_key(function(_, typed)
  if typed and typed ~= "" then last_mouse = MOUSE[typed] or false end
end)

-- The app's native menu was picked with the mouse (true) or the keys: nvim never saw that input
---@param mouse boolean
function M.set_last_mouse(mouse)
  last_mouse = mouse
end

-- WebStorm's menu icons (expui actions) by label, for items that don't bring their own; rows
-- without one keep the column blank
local ICONS = {
  ["Cut"] = "\u{f0190}",
  ["Copy"] = "\u{ebcc}",
  ["Paste"] = "\u{f0a38}",
  ["Show Context Actions"] = "\u{ea61}",
  ["Show History"] = "\u{ea82}",
  ["Show History for File"] = "\u{ea82}",
  ["Show History for Selection"] = "\u{ea82}",
  ["Commit…"] = "\u{eab2}",
  ["Push…"] = "\u{eaa1}",
  ["Rollback…"] = "\u{eae2}",
  ["Rollback Lines"] = "\u{eae2}",
  ["Show Diff"] = "\u{eae1}",
  ["Show Diff for Lines"] = "\u{eae1}",
  ["Select in Project View"] = "\u{ebf8}",
  ["Split Right"] = "\u{eb56}",
  ["Split Down"] = "\u{eb57}",
  ["Open in Terminal"] = "\u{ea85}",
  ["Collapse All"] = "\u{eac5}",
  ["Expand All"] = "\u{eb95}",
}

---@param items MenuEntry[]
---@param opts? MenuOpts
function M.open(items, opts)
  opts = opts or {}
  -- a title is a header row inside, like WebStorm's popup titles
  if opts.title and not opts.header then opts.header = { left = { { opts.title, "WsMenuTitle" } } } end
  local vscode = package.loaded["config.keymap_vscode"]
  for _, item in ipairs(items) do
    if type(item) == "table" and not item.icon and opts.icons ~= false and ICONS[item[1]] then
      item.icon = { ICONS[item[1]], "WsMenuIcon" }
    end
    -- Feel vscode: VS Code's chord in the shortcut column
    if vscode and type(item) == "table" and type(item[1]) == "string" then item.key = vscode.key_label(item[1], item.key) end
  end
  local origin = require("config.popup").origin()
  if opts.mode then origin.mode = opts.mode end
  local at = opts.at or (last_mouse and "mouse" or "cursor")
  local app = require("config.app.menu")
  local where = app.anchor(at, opts.pos) -- before stopinsert: the caret where it was typed
  vim.cmd.stopinsert()
  return app.open(items, opts, origin, where)
end

function M.is_open() return require("config.app.menu").is_open() end

-- Test hook: the items sent to the native menu
function M.shown() return require("config.app.menu").shown() end

-- vim.ui.select as this menu (code actions, confirmations, pickers of a few items)
function M.select(items, opts, on_choice)
  opts = opts or {}
  local fmt = opts.format_item or tostring
  -- code actions: just the title (the default format adds " [vtsls]")
  if opts.kind == "codeaction" then
    local default = fmt
    fmt = function(it) return type(it) == "table" and it.action and it.action.title or default(it) end
  end
  local entries = {}
  for i, it in ipairs(items) do
    entries[i] = { fmt(it), function() on_choice(it, i) end }
  end
  local prompt = opts.prompt and opts.prompt:gsub(":%s*$", "") or nil
  M.open(entries, { title = prompt, icons = false, pos = opts.pos, on_cancel = function() on_choice(nil, nil) end })
end

-- Context menus --------------------------------------------------------------------------

---@class MenuProvider
---@field priority integer higher wins
---@field items fun(win: integer, buf: integer, ctx: {visual: boolean}): MenuEntry[]?

local providers = {} ---@type MenuProvider[]

---@param priority integer
---@param items fun(win: integer, buf: integer, ctx: {visual: boolean}): MenuEntry[]?
function M.provider(priority, items)
  providers[#providers + 1] = { priority = priority, items = items }
  table.sort(providers, function(a, b) return a.priority > b.priority end)
end

--- The context menu's items here (the first provider that has some), not opened: `:`'s rows (#346).
---@param visual? boolean
---@return MenuEntry[]?
function M.items(visual)
  local win, buf = vim.api.nvim_get_current_win(), vim.api.nvim_get_current_buf()
  for _, p in ipairs(providers) do
    local items = p.items(win, buf, { visual = visual or false })
    if items then return items end
  end
end

---@param at "mouse"|"cursor"
---@param visual? boolean
function M.context(at, visual)
  local items = M.items(visual)
  if items then return M.open(items, { at = at }) end
end

-- Cmd+Enter
function M.cursor()
  local visual = vim.api.nvim_get_mode().mode:match("^[vV\22]") ~= nil
  if visual then vim.cmd("normal! \27") end -- sets '< '> for the actions
  M.context("cursor", visual)
end

-- Is the mouse over a window's text area (also below the buffer's last line), not its winbar / status line?
---@param pos table getmousepos()
local function in_text(pos)
  if pos.winid == 0 then return false end
  if pos.line ~= 0 then return true end
  local info = vim.fn.getwininfo(pos.winid)[1]
  return info ~= nil and pos.winrow > info.winbar and pos.winrow <= info.winbar + info.height
end

-- Right-click: caret to the click (kept when clicking inside a selection), then the menu
function M.right_click()
  local pos = vim.fn.getmousepos()
  if not in_text(pos) then return end
  -- a menu still open: the app's menu, this click landed outside it
  require("config.app.menu").dismissed()
  local mode = vim.api.nvim_get_mode().mode
  local visual = false
  if mode:match("^[vV\22]") and pos.winid == vim.api.nvim_get_current_win() then
    local a, b = vim.fn.line("v"), vim.fn.line(".")
    visual = pos.line >= math.min(a, b) and pos.line <= math.max(a, b)
    vim.cmd("normal! \27")
  end
  if not visual then
    if mode:match("^[vV\22]") then vim.cmd("normal! \27") end
    vim.api.nvim_set_current_win(pos.winid)
    if vim.bo.buftype ~= "terminal" then
      if pos.line > 0 then pcall(vim.api.nvim_win_set_cursor, pos.winid, { pos.line, math.max(pos.column - 1, 0) }) end
    end
  end
  M.context("mouse", visual)
end

-- Left-click zones (diff arrows, checkboxes, tree chevrons, ...): fn(pos) -> action or nil
local zones = {} ---@type (fun(pos: table): fun()?)[]

---@param fn fun(pos: table): fun()?
function M.zone(fn)
  zones[#zones + 1] = fn
end

local function left_click()
  local pos = vim.fn.getmousepos()
  if pos.winid ~= 0 and pos.line ~= 0 then
    for _, z in ipairs(zones) do
      local ok, action = pcall(z, pos)
      if ok and action then
        vim.schedule(action)
        return ""
      end
    end
  end
  return "<LeftMouse>"
end

function M.setup()
  vim.ui.select = M.select
  local modes = { "n", "i", "x" }
  vim.keymap.set(modes, "<LeftMouse>", left_click, { expr = true, desc = "Click (zones, else default)" })
  -- (quick right-clicks on one cell arrive as <2-RightMouse> ...: each opens the menu too, never a selection)
  for _, k in ipairs({ "<RightMouse>", "<2-RightMouse>", "<3-RightMouse>", "<4-RightMouse>" }) do
    vim.keymap.set(modes, k, function()
      -- tabs, winbar, statusline: their own click handlers
      if not in_text(vim.fn.getmousepos()) then return k end
      vim.schedule(M.right_click)
      return ""
    end, { expr = true, desc = "Context menu" })
  end
  vim.keymap.set(modes, "<D-CR>", function() vim.schedule(M.cursor) end, { desc = "Context menu (like right-click)" })
end

return M
