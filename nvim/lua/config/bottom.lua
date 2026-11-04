-- The bottom tool window, one place shared by the bottom pane (config/app/pane.lua), Git and the Terminal
-- (config/app/terminal.lua) like in WebStorm: opening one hides the others, all keep the same height.
local M = {}

-- A bottom tool window opens at least this many rows tall (#156: one restored at 3 rows showed the Sessions and
-- Boxes tables' header and key line, no rows); its height is kept as a share of nvim's rows
local MIN_ROWS = 8

local share ---@type number? the last height as a share of the IDE window's (nil: a third)
local tools = {} ---@type table<string, {hide: fun(keep_focus: boolean), is_open: fun(): boolean, show: fun(), win?: fun(): integer?}>
local last ---@type string? the tool window that opened last

---@param name string
---@param hide fun(keep_focus: boolean)
---@param is_open fun(): boolean
---@param show fun() open it with the keyboard
---@param win? fun(): integer? its window while open (its height is noted for the session)
function M.register(name, hide, is_open, show, win)
  tools[name] = { hide = hide, is_open = is_open, show = show, win = win }
end

-- Hide every other tool window before `name` opens
function M.claim(name)
  last = name
  for other, p in pairs(tools) do
    if other ~= name then p.hide(true) end
  end
end

-- The tool window that opened last (nil: none yet)
---@return string?
function M.last() return last end

-- Feel vscode's ⌘J (Toggle Panel, #128: the terminal too, as VS Code's panel holds it): the shown bottom tool
-- window hides, else the last one shown opens (Git the first time)
function M.toggle()
  for name, p in pairs(tools) do
    if p.is_open and p.is_open() then
      last = name
      return p.hide(false)
    end
  end
  local t = tools[last or "git"] or tools.git
  if t and t.show then t.show() end
end

-- Height for a bottom tool window that opens: the last one's share of the IDE window's height (it scales
-- with the window), else a third (2.1 board F-Sessions: the pane is 280 of a 900 px window); never under
-- MIN_ROWS nor over all but MIN_ROWS (on a small screen: half of it; the editor above gets those rows less the
-- status line, command line and separator), never under 1
function M.height()
  local lines = vim.o.lines
  local floor = math.min(MIN_ROWS, math.floor(lines / 2))
  local rows = math.floor((share or 1 / 3) * lines + 0.5)
  return math.max(1, floor, math.min(rows, lines - floor))
end

---@param h integer rows
function M.set_height(h)
  if vim.o.lines > 0 then share = h / vim.o.lines end
end

function M.save_height(win)
  if win and vim.api.nvim_win_is_valid(win) then M.set_height(vim.api.nvim_win_get_height(win)) end
end

-- The session's part (config/session.lua, per project like WebStorm's tool window sizes): the open bottom tool
-- window's height, else the last one's, as a share of the IDE window's (nil: never sized, a third)
---@return {share: number}?
function M.layout()
  for _, t in pairs(tools) do
    if t.win and t.is_open() then M.save_height(t.win()) end
  end
  if share then return { share = share } end
end

---@param l {share?: number}?
function M.restore(l)
  local s = type(l) == "table" and l.share or nil
  if type(s) == "number" and s > 0 and s < 1 then share = s end
end

-- The app window resized: the windows keep their proportions, like WebStorm's (Neovim alone shrinks the last split
-- to a column and keeps the bottom tool window's rows, and never gives them back). Sizes come from the last
-- layout you made (window sizes noted on WinResized, not the ones a resize itself causes), so shrinking
-- and growing back gives the same layout. Fixed-width and one-row windows keep their size.
local snap = {} ---@type table<integer, {[1]: integer, [2]: integer}> window -> { width, height }
local snap_screen = "" -- columns x lines when noted
local resized_at = 0

local function frame(win)
  return { vim.api.nvim_win_get_width(win), vim.api.nvim_win_get_height(win) }
end

local function screen() return vim.o.columns .. "x" .. vim.o.lines end

local function note()
  snap, snap_screen = {}, screen()
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_config(w).relative == "" then snap[w] = frame(w) end
  end
end

-- Windows opened / closed since noted
local function wins_changed()
  local now = {}
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_config(w).relative == "" then
      if not snap[w] then return true end
      now[w] = true
    end
  end
  for w in pairs(snap) do
    if not now[w] then return true end
  end
  return false
end

-- The window to size a node by: its first leaf
local function leaf_of(node)
  if node[1] == "leaf" then return node[2] end
  return leaf_of(node[2][1])
end

-- Size of a layout node along dim (1 width, 2 height): now, or noted (`noted`)
local function size(node, dim, noted)
  if node[1] == "leaf" then
    local win = node[2]
    return (noted and snap[win] or frame(win))[dim]
  end
  local along = (node[1] == "row") == (dim == 1)
  if not along then -- across: a noted child's
    local kid = node[2][1]
    for _, c in ipairs(node[2]) do
      if c[1] ~= "leaf" or snap[c[2]] then kid = c break end
    end
    return size(kid, dim, noted)
  end
  local sum = 0
  for _, c in ipairs(node[2]) do sum = sum + size(c, dim, noted) end
  return sum
end

local function fixed(node, dim)
  if node[1] ~= "leaf" then return false end
  local win = node[2]
  if dim == 1 then return vim.wo[win].winfixwidth end
  return (snap[win] or frame(win))[2] <= 2
end

local function scale(node)
  if node[1] == "leaf" then return end
  local dim = node[1] == "row" and 1 or 2
  local kids = node[2]
  local avail, flex_noted, flex = 0, 0, {}
  for i, c in ipairs(kids) do
    avail = avail + size(c, dim, false)
    if fixed(c, dim) then
      avail = avail - size(c, dim, true)
    else
      flex[#flex + 1] = i
      flex_noted = flex_noted + size(c, dim, true)
    end
  end
  local targets, left = {}, avail
  for n, i in ipairs(flex) do
    local t = n == #flex and left or math.floor(avail * size(kids[i], dim, true) / math.max(flex_noted, 1) + 0.5)
    targets[i] = math.max(1, t)
    left = left - targets[i]
  end
  for i = 1, #kids - 1 do
    local win = leaf_of(kids[i])
    local t = targets[i] or size(kids[i], dim, true)
    if dim == 1 then
      vim.api.nvim_win_set_width(win, math.max(1, t))
    else
      vim.api.nvim_win_set_height(win, math.max(1, t))
    end
  end
  for _, c in ipairs(kids) do scale(c) end
end

-- (the bottom tool windows keep their height with winfixheight: it would block the editor growing back)
local function wins_key()
  local ids = {}
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_config(w).relative == "" then ids[#ids + 1] = w end
  end
  return table.concat(ids, ",")
end
local scaled_wins = "" -- windows when last scaled

local function relayout()
  scaled_wins = wins_key()
  local fixh = {}
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.wo[w].winfixheight then
      fixh[#fixh + 1] = w
      vim.wo[w].winfixheight = false
    end
  end
  pcall(scale, vim.fn.winlayout())
  for _, w in ipairs(fixh) do vim.wo[w].winfixheight = true end
  -- side-by-side panes that keep their shares (markdown preview, diff / merge) go by those, not the snapshot
  require("config.shares").apply_all()
end

local group = vim.api.nvim_create_augroup("ws_layout_scale", { clear = true })
vim.api.nvim_create_autocmd("WinResized", {
  group = group,
  callback = function()
    -- right after a resize: windows others re-create for it get scaled too
    if (vim.uv.hrtime() - resized_at) / 1e6 < 500 then
      if wins_key() ~= scaled_wins then relayout() end
      return
    end
    -- later: the layout you made, noted (at another IDE size only when windows opened / closed: what
    -- rounding moved there doesn't count)
    if screen() == snap_screen or wins_changed() then note() end
  end,
})
vim.api.nvim_create_autocmd("VimEnter", { group = group, callback = note })
vim.api.nvim_create_autocmd("VimResized", {
  group = group,
  callback = function()
    resized_at = vim.uv.hrtime()
    if next(snap) == nil then note() end
    relayout()
  end,
})

return M
