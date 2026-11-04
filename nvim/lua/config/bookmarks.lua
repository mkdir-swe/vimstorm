-- Numbered bookmarks like WebStorm's mnemonic ones: Ctrl+Shift+1..9 sets one at the caret (line and
-- column), Ctrl+1..9 jumps back to that exact spot (opens the file as a tab). The gutter shows the number
-- in a small box (WebStorm's mnemonic icon) in the cell between the line number and the change bar
-- (config/gutter.lua), so the gutter keeps its width. Extmarks keep them on their text while editing
-- (typing before one on its line moves it right); saved per project in stdpath("state")/bookmarks/.
local M = {}

local NS = vim.api.nvim_create_namespace("ws_bookmarks")
local dir = vim.fn.stdpath("state") .. "/bookmarks"

---@class Bookmark
---@field file string absolute path
---@field line integer 1-based; the extmark is the truth while the file is loaded
---@field col integer 0-based byte column
---@field num integer 1..9
---@field buf? integer loaded buffer holding the extmark
---@field mark? integer extmark id
---@field text? string its line's text when the file was last read / written: a reload finds the line by it

local list = {} ---@type Bookmark[]
local loaded_for ---@type string? project the list belongs to
local count = {} ---@type table<integer, integer> buffer -> bookmarks with an extmark there
local cache = {} ---@type table<integer, {tick: integer, version: integer, lines: table<integer, Bookmark>}>
local version = 0 -- bumped on every add / remove / move

local function store()
  return dir .. "/" .. vim.fn.getcwd():gsub("[/\\:]", "%%") .. ".json"
end

-- Current line + column of a bookmark, nil when its line was deleted
---@param b Bookmark
---@return integer?, integer?
local function pos_of(b)
  if b.buf and b.mark and vim.api.nvim_buf_is_valid(b.buf) then
    local m = vim.api.nvim_buf_get_extmark_by_id(b.buf, NS, b.mark, { details = true })
    if not m[1] or (m[3] and m[3].invalid) then return nil end
    return m[1] + 1, m[2]
  end
  return b.line, b.col
end

-- 0-based row for a bookmark in buf: its line, else (the file changed on disk: lines added / removed above)
-- the nearest line with its text, like WebStorm's bookmarks following their code
---@param b Bookmark
---@param buf integer
local function anchor(b, buf)
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  local row = math.max(1, math.min(b.line, #lines))
  if b.text and lines[row] ~= b.text then
    for d = 1, #lines do
      if lines[row - d] == b.text then return row - d - 1 end
      if lines[row + d] == b.text then return row + d - 1 end
      if row - d < 1 and row + d > #lines then break end
    end
  end
  return row - 1
end

---@param b Bookmark
---@param buf integer
local function attach(b, buf)
  local row = anchor(b, buf)
  local line = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""
  local len = #line
  b.line, b.text = row + 1, line
  -- invalidate: a deleted line hides its bookmark (undo brings it back); right gravity: text typed at
  -- its column pushes it along, Enter at the start of the line moves it down with the text
  b.mark = vim.api.nvim_buf_set_extmark(buf, NS, row, math.min(b.col, len), { invalidate = true, undo_restore = true })
  b.buf = buf
  count[buf] = (count[buf] or 0) + 1
end

---@param b Bookmark
---@param reload? boolean the file is being read again: its text is already gone, the spot from the last read /
---  write (b.line, b.col, b.text) is kept
local function detach(b, reload)
  if b.buf and b.mark then
    if not (reload and b.text) then
      local l, c = pos_of(b)
      b.line, b.col = l or b.line, c or b.col
    end
    if vim.api.nvim_buf_is_valid(b.buf) then pcall(vim.api.nvim_buf_del_extmark, b.buf, NS, b.mark) end
    count[b.buf] = math.max(0, (count[b.buf] or 1) - 1)
    if count[b.buf] == 0 then count[b.buf] = nil end
  end
  b.buf, b.mark = nil, nil
end

local function redraw()
  version = version + 1
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.wo[win].statuscolumn ~= "" then pcall(vim.api.nvim__redraw, { win = win, statuscolumn = true }) end
  end
end

local save_timer = assert(vim.uv.new_timer())

-- Write the list (positions from the extmarks; bookmarks on deleted lines are dropped)
function M.save()
  save_timer:stop()
  if not loaded_for then return end
  local out = {}
  for _, b in ipairs(list) do
    local l, c = pos_of(b)
    if l then out[#out + 1] = { file = b.file, line = l, col = c, num = b.num } end
  end
  pcall(vim.fn.mkdir, dir, "p") -- (another project's nvim may create it at the same time: app quit)
  pcall(vim.fn.writefile, { vim.json.encode(out) }, loaded_for)
end

local function changed()
  redraw()
  save_timer:stop()
  save_timer:start(500, 0, vim.schedule_wrap(M.save))
end

-- Read this project's bookmarks and put them on the files already open (older files: no column = 0,
-- unnumbered entries are skipped)
local function load()
  local path = store()
  if loaded_for == path then return end
  for _, b in ipairs(list) do detach(b) end
  list, loaded_for = {}, path
  local ok, data = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(path), "")) end)
  if ok and type(data) == "table" then
    for _, d in ipairs(data) do
      if type(d) == "table" and type(d.file) == "string" and type(d.line) == "number" and type(d.num) == "number" then
        list[#list + 1] = { file = d.file, line = d.line, col = type(d.col) == "number" and d.col or 0, num = d.num }
      end
    end
  end
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) then
      local name = vim.api.nvim_buf_get_name(buf)
      for _, b in ipairs(list) do
        if b.file == name then attach(b, buf) end
      end
    end
  end
  redraw()
end

-- Line -> bookmark of a buffer (lowest number wins), rebuilt after edits / changes to the list
---@param buf integer
---@return table<integer, Bookmark>
local function lines(buf)
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  local c = cache[buf]
  if c and c.tick == tick and c.version == version then return c.lines end
  local map = {}
  for _, b in ipairs(list) do
    if b.buf == buf then
      local l = pos_of(b)
      if l and (not map[l] or b.num < map[l].num) then map[l] = b end
    end
  end
  cache[buf] = { tick = tick, version = version, lines = map }
  return map
end

-- statuscolumn cell right of the line number (config/gutter.lua): number box / blank
function M.cell()
  if vim.v.virtnum ~= 0 then return " " end
  local buf = vim.api.nvim_get_current_buf() -- the window being drawn
  if not count[buf] then return " " end
  local b = lines(buf)[vim.v.lnum]
  if not b then return " " end
  return "%#WsBookmarkNum#" .. b.num .. "%*"
end

---@param num integer
---@return Bookmark?, integer?
local function numbered(num)
  for i, b in ipairs(list) do
    if b.num == num then return b, i end
  end
end

-- Caret's file + line + column in a split, nil elsewhere (tree, tool windows, diff scratch buffers)
---@return string?, integer?, integer?, integer?
local function here()
  local win = vim.api.nvim_get_current_win()
  local buf = vim.api.nvim_win_get_buf(win)
  local file = vim.api.nvim_buf_get_name(buf)
  if file == "" or not require("config.focus").is_split(win, true) then return end
  local cur = vim.api.nvim_win_get_cursor(win)
  return file, cur[1], cur[2], buf
end

-- Ctrl+Shift+N: bookmark N at the caret; again on the same spot removes it; set elsewhere: moves here
---@param num integer
function M.toggle_num(num)
  load()
  local file, lnum, col, buf = here()
  if not file then return end
  local old, oi = numbered(num)
  if old then
    local l, c = pos_of(old)
    detach(old)
    table.remove(list, assert(oi))
    if old.file == file and l == lnum and c == col then return changed() end
  end
  local b = { file = file, line = lnum, col = assert(col), num = num } ---@type Bookmark
  list[#list + 1] = b
  attach(b, assert(buf))
  changed()
end

-- Open a bookmark's file in the last focused split (as a tab) with the caret on its spot
---@param b Bookmark
local function open(b)
  if not vim.uv.fs_stat(b.file) then
    return vim.notify("Bookmark: " .. vim.fn.fnamemodify(b.file, ":~:.") .. " no longer exists", vim.log.levels.WARN)
  end
  local focus = require("config.focus")
  -- typing in a split: typing goes on at the bookmark (WebStorm has no modes); elsewhere the split takes over
  local typing = vim.api.nvim_get_mode().mode:match("^[iR]") ~= nil
  local stay = typing and focus.is_split(vim.api.nvim_get_current_win(), true)
  if not stay then focus.edit() end
  if vim.api.nvim_buf_get_name(0) ~= b.file then vim.cmd.edit(vim.fn.fnameescape(b.file)) end
  local l, c = pos_of(b)
  local lnum = math.min(l or b.line, vim.api.nvim_buf_line_count(0))
  local visible = lnum >= vim.fn.line("w0") and lnum <= vim.fn.line("w$")
  vim.cmd("normal! m'")
  local pos = { lnum, math.min(c or b.col, #vim.fn.getline(lnum)) }
  vim.api.nvim_win_set_cursor(0, pos)
  if not visible then vim.cmd("normal! zz") end
  -- focus.edit() left Insert mode: that moves the caret one left once this returns, so it's put back
  if typing and not stay then require("config.popup").leave_insert(vim.api.nvim_get_current_win(), pos[1], pos[2]) end
end

-- Ctrl+N: go to numbered bookmark N
---@param num integer
function M.jump(num)
  load()
  local b = numbered(num)
  -- its line deleted: hidden (undo brings it back), so not set
  if not b or not pos_of(b) then return vim.notify(("Bookmark %d is not set"):format(num), vim.log.levels.INFO) end
  open(b)
end

---@class BookmarkEntry
---@field num integer
---@field file string
---@field line integer
---@field col integer 0-based

-- Bookmarks by number
---@return BookmarkEntry[]
function M.list()
  load()
  local out = {}
  for _, b in ipairs(list) do
    local l, c = pos_of(b)
    if l then out[#out + 1] = { num = b.num, file = b.file, line = l, col = c } end
  end
  table.sort(out, function(x, y) return x.num < y.num end)
  return out
end

-- Popup of 1..9, each with where it is now; picking n runs fn(n)
---@param title string
---@param keys string shortcut shown for an unset number
---@param fn fun(n: integer)
---@param only_set boolean list only the numbers that are set
local function choose(title, keys, fn, only_set)
  load()
  local items = {}
  for n = 1, 9 do
    local b = numbered(n)
    local l = b and pos_of(b)
    if l or not only_set then
      items[#items + 1] = {
        tostring(n), function() fn(n) end,
        key = l and (vim.fn.fnamemodify(b.file, ":t") .. ":" .. l) or (keys .. n),
      }
    end
  end
  if #items == 0 then return vim.notify("No bookmarks set", vim.log.levels.INFO) end
  require("config.menu").open(items, { title = title, icons = false })
end

-- Toggle Bookmark with Number…
function M.choose_num()
  choose("Toggle Bookmark with Number", "⌃⇧", M.toggle_num, false)
end

-- Go to Bookmark…: the numbers that are set
function M.choose_jump()
  choose("Go to Bookmark", "⌃", M.jump, true)
end

-- Editor context menu: "Bookmarks ›" opens these
---@return MenuEntry[]
function M.menu_items()
  return {
    { "Toggle Bookmark with Number…", M.choose_num, key = "⌃⇧1…9" },
    { "Go to Bookmark…", M.choose_jump, key = "⌃1…9" },
  }
end

function M.menu()
  require("config.menu").open(M.menu_items(), { title = "Bookmarks" })
end

function M.setup()
  local group = vim.api.nvim_create_augroup("ws_bookmarks", { clear = true })
  -- before a (re)load: the extmark goes with the old text (already gone here); the spot and line text from the
  -- last read / write find it again in the new text (BufReadPost)
  vim.api.nvim_create_autocmd("BufReadPre", {
    group = group,
    callback = function(ev)
      for _, b in ipairs(list) do
        if b.buf == ev.buf then detach(b, true) end
      end
    end,
  })
  -- saved: the file on disk now has this text
  vim.api.nvim_create_autocmd("BufWritePost", {
    group = group,
    callback = function(ev)
      if not count[ev.buf] then return end
      for _, b in ipairs(list) do
        if b.buf == ev.buf then
          local l, c = pos_of(b)
          if l then
            b.line, b.col = l, c
            b.text = vim.api.nvim_buf_get_lines(ev.buf, l - 1, l, false)[1]
          end
        end
      end
    end,
  })
  vim.api.nvim_create_autocmd("BufReadPost", {
    group = group,
    callback = function(ev)
      if not loaded_for then return end
      local name = vim.api.nvim_buf_get_name(ev.buf)
      for _, b in ipairs(list) do
        if b.file == name and not b.buf then attach(b, ev.buf) end
      end
    end,
  })
  vim.api.nvim_create_autocmd({ "BufUnload", "BufWipeout" }, {
    group = group,
    callback = function(ev)
      for _, b in ipairs(list) do
        if b.buf == ev.buf then detach(b) end
      end
      cache[ev.buf] = nil
    end,
  })
  vim.api.nvim_create_autocmd("VimLeavePre", { group = group, callback = M.save })
  vim.api.nvim_create_autocmd("VimEnter", { group = group, once = true, callback = load })
  if vim.v.vim_did_enter == 1 then load() end

  local map = vim.keymap.set
  local modes = { "n", "i", "x" }
  for n = 1, 9 do
    map(modes, "<C-" .. n .. ">", function() M.jump(n) end, { desc = "Go to bookmark " .. n })
    map(modes, "<C-S-" .. n .. ">", function() M.toggle_num(n) end, { desc = "Toggle bookmark " .. n })
  end
end

return M
