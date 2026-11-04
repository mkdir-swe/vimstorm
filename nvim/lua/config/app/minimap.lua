-- VS Code's minimap (#122, `editor.minimap`): the app draws it at each code split's right (app/src/editor/minimap); this
-- module only reports what to draw. The app asks for the lines a window's minimap shows (`want`, as its layout
-- picks them from nvim's viewport) and gets them back as `lines`: one byte a column (at most VS Code's 120), " "
-- blank, else "!" + i for colour palette[i] (0xRRGGBB), coloured as the editor's treesitter highlights colour
-- them (Normal elsewhere). Lines already made for the buffer's text as it is are kept, so scrolling makes only
-- the new ones; an edit makes them again once typing rests. A click / drag on the minimap: `scroll`.
local bridge = require("config.app.bridge")
local M = {}

local MAX_COLS = 120
local TYPING_MS = 150 -- an edit: once typing rests
local SOON_MS = 16 -- the app asked, a window shows another buffer
local CHUNK = 100 -- lines made in one main-loop turn (~6 ms of a big TSX file)

local on = false
local wanted = {} ---@type table<integer, {from: integer, to: integer}>
local dirty = {} ---@type table<integer, true>
local timer ---@type uv.uv_timer_t?
local group = vim.api.nvim_create_augroup("ws_app_minimap", { clear = true })

---@class MinimapMade
---@field tick integer
---@field lines table<integer, string> 0-based line -> bytes
---@field palette integer[]
---@field index table<integer, integer> colour -> 0-based palette index

local made = {} ---@type table<integer, MinimapMade> by buffer

-- hl group -> fg (false: none); lang -> capture id -> fg (false: none)
local fg_of, capture_fg = {}, {}

local CH = {}
for i = 0, 93 do CH[i] = string.char(33 + i) end

---@param name string
---@return integer?
local function fg(name)
  local c = fg_of[name]
  if c == nil then
    local ok, hl = pcall(vim.api.nvim_get_hl, 0, { name = name, link = false, create = false })
    c = ok and hl.fg or false
    fg_of[name] = c
  end
  return c or nil
end

-- A capture's colour the way the highlighter picks its group: @a.b.lang, else @a.b, else @a
---@return integer|false
local function capture_color(name, lang)
  if name:byte(1) == 95 then return false end -- "_private"
  local hl = "@" .. name .. "." .. lang
  while hl do
    local v = fg(hl)
    if v then return v end
    hl = hl:match("^(@.+)%.[^.]+$")
  end
  return false
end

-- A window the minimap is drawn for: a code split, the one with the WebStorm gutter (config/gutter.lua; the app
-- leaves the minimap's room where config/app/layout.lua reports its textoff)
---@param win integer
local function shown(win)
  return vim.api.nvim_win_is_valid(win) and require("config.focus").is_split(win)
    and vim.wo[win].statuscolumn == require("config.gutter").COLUMN
end

-- Makes the lines from..to (0-based, exclusive) of buf into m.lines
---@param buf integer
---@param m MinimapMade
---@param from integer
---@param to integer
local function make(buf, m, from, to)
  local palette, index = m.palette, m.index
  local function idx(color)
    local i = index[color]
    if not i then
      if #palette > 93 then return 0 end
      i = #palette
      palette[i + 1] = color
      index[color] = i
    end
    return i
  end
  local text = vim.api.nvim_buf_get_lines(buf, from, to, false)
  local ts = vim.bo[buf].tabstop
  local cells, maps, widths = {}, {}, {}
  for i, line in ipairs(text) do
    local row, w = {}, 0
    if line:find("[\t\128-\255]") then
      -- byte -> column: tabs to the next tabstop, a multibyte char one column
      local map, col = {}, 0
      for b = 1, #line do
        local ch = line:byte(b)
        if ch >= 128 and ch < 192 then
          map[b] = col - 1
        else
          map[b] = col
          if ch == 9 then
            col = col + ts - (col % ts)
          else
            if ch ~= 32 and col < MAX_COLS then
              row[col + 1] = 0
              w = col + 1
            end
            col = col + 1
          end
        end
      end
      map[#line + 1] = col
      maps[i] = map
    else
      for b = 1, math.min(#line, MAX_COLS) do
        if line:byte(b) ~= 32 then
          row[b] = 0
          w = b
        end
      end
    end
    cells[i], widths[i] = row, w
  end
  -- treesitter's captures over them (injected languages after their host: they win)
  local hl = vim.treesitter.highlighter.active[buf]
  if hl and hl.tree then
    pcall(hl.tree.parse, hl.tree, { from, to })
    hl.tree:for_each_tree(function(tstree, ltree)
      local lang = ltree:lang()
      local ok, query = pcall(vim.treesitter.query.get, lang, "highlights")
      if not ok or not query then return end
      local colors = capture_fg[lang]
      if not colors then
        colors = {}
        capture_fg[lang] = colors
      end
      for id, node in query:iter_captures(tstree:root(), buf, from, to) do
        local color = colors[id]
        if color == nil then
          color = capture_color(query.captures[id], lang)
          colors[id] = color
        end
        if color then
          local k = idx(color)
          local sr, sc, er, ec = node:range()
          for r = math.max(sr, from), math.min(er, to - 1) do
            local i = r - from + 1
            local row, map = cells[i], maps[i]
            local c0 = r == sr and sc or 0
            local c1 = r == er and ec or MAX_COLS
            if map then
              c0 = map[c0 + 1] or MAX_COLS
              c1 = (r == er and map[c1 + 1]) or MAX_COLS
            end
            for c = c0 + 1, math.min(c1, widths[i]) do
              if row[c] then row[c] = k end
            end
          end
        end
      end
    end)
  end
  local out = {}
  for i, row in ipairs(cells) do
    local w = widths[i]
    for c = 1, w do
      local k = row[c]
      out[c] = k and CH[k] or " "
    end
    m.lines[from + i - 1] = table.concat(out, "", 1, w)
  end
end

-- The kept lines of win's buffer and the span the app wants (nil: win shows no minimap)
---@param win integer
---@return MinimapMade?, integer, integer, integer, integer
local function span(win)
  local w = wanted[win]
  if not w or not shown(win) then return nil, 0, 0, 0, 0 end
  local buf = vim.api.nvim_win_get_buf(win)
  local total = vim.api.nvim_buf_line_count(buf)
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  local m = made[buf]
  if not m or m.tick ~= tick then
    local normal = fg("Normal") or 0xcccccc
    m = { tick = tick, lines = {}, palette = { normal }, index = { [normal] = 0 } }
    made[buf] = m
  end
  return m, buf, total, math.max(0, math.min(w.from, total)), math.min(total, w.to)
end

-- Makes up to `limit` (all: nil) of the span's missing lines, a stretch at a time; whether some are still missing
---@param win integer
---@param limit? integer
---@return boolean
local function make_some(win, limit)
  local m, buf, _, from, to = span(win)
  if not m then return false end
  local left = limit or math.huge
  local n = from
  while n < to do
    if m.lines[n] then
      n = n + 1
    elseif left <= 0 then
      return true
    else
      local e = n
      while e < to and e - n < left and not m.lines[e] do e = e + 1 end
      make(buf, m, n, e)
      left = left - (e - n)
      n = e
    end
  end
  return false
end

-- What the app gets for win: the lines it wants (made where not kept); none when win shows no minimap now (a
-- help page there: the app drops what it had); nil when it wants nothing of win
---@param win integer
---@return table?
function M.report(win)
  if not wanted[win] or not vim.api.nvim_win_is_valid(win) then return nil end
  make_some(win)
  local m, buf, total, from, to = span(win)
  if not m then
    buf = vim.api.nvim_win_get_buf(win)
    return { event = "lines", win = win, buf = buf, tick = vim.api.nvim_buf_get_changedtick(buf),
      total = vim.api.nvim_buf_line_count(buf), from = 0, lines = {}, palette = {} }
  end
  local lines = {}
  for l = from, to - 1 do lines[#lines + 1] = m.lines[l] end
  return { event = "lines", win = win, buf = buf, tick = m.tick, total = total, from = from, lines = lines, palette = m.palette }
end

-- Each window asked for: its span made a chunk a main-loop turn (a key typed meanwhile waits for one chunk at
-- most), then sent
local function flush()
  local wins = dirty
  dirty = {}
  if not on then return end
  local more = false
  for win in pairs(wins) do
    local ok, missing = pcall(make_some, win, CHUNK)
    if ok and missing then
      dirty[win] = true
      more = true
    elseif ok then
      local sent, payload = pcall(M.report, win)
      if sent and payload then bridge.notify("minimap", payload) end
    end
  end
  if more then vim.schedule(flush) end
end

---@param win integer
---@param ms integer
local function mark(win, ms)
  dirty[win] = true
  timer = timer or vim.uv.new_timer()
  if not timer then return end
  -- an edit waits for typing to rest; anything else goes soon unless something waits already
  if ms == TYPING_MS or not timer:is_active() then
    timer:stop()
    timer:start(ms, 0, vim.schedule_wrap(flush))
  end
end

local function mark_buf(buf, ms)
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    if wanted[win] then mark(win, ms) end
  end
end

-- The app: the minimap is on / off
---@param want boolean
function M.enable(want)
  on = want == true
  vim.api.nvim_clear_autocmds({ group = group })
  wanted, dirty, made = {}, {}, {}
  if not on then return end
  local au = vim.api.nvim_create_autocmd
  au({ "TextChanged", "TextChangedI", "TextChangedP" }, {
    group = group,
    callback = function(ev) mark_buf(ev.buf, TYPING_MS) end,
  })
  -- another buffer in a window; treesitter colours a file once FileType starts it
  au("BufWinEnter", {
    group = group,
    callback = function(ev) mark_buf(ev.buf, SOON_MS) end,
  })
  au("FileType", {
    group = group,
    callback = function(ev)
      made[ev.buf] = nil
      mark_buf(ev.buf, TYPING_MS)
    end,
  })
  au("ColorScheme", {
    group = group,
    callback = function()
      fg_of, capture_fg, made = {}, {}, {}
      for win in pairs(wanted) do mark(win, SOON_MS) end
    end,
  })
  au("WinClosed", { group = group, callback = function(ev) wanted[tonumber(ev.match) or -1] = nil end })
  au("BufWipeout", { group = group, callback = function(ev) made[ev.buf] = nil end })
end

-- The app: the lines from..to (0-based, exclusive) of win are what its minimap shows now
---@param win integer
---@param from integer
---@param to integer
function M.want(win, from, to)
  if not on then return end
  wanted[win] = { from = math.max(0, math.floor(from)), to = math.max(0, math.floor(to)) }
  mark(win, SOON_MS)
end

-- A click / drag on the minimap: win's top line to top (0-based). The cursor stays where it is while the view
-- shows it, else it goes to the nearest line `scrolloff` lets it (as the wheel moves it)
---@param win integer
---@param top integer
function M.scroll(win, top)
  if not vim.api.nvim_win_is_valid(win) then return end
  local last = vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))
  local line = math.min(math.max(1, math.floor(top) + 1), last)
  vim.api.nvim_win_call(win, function()
    local view = vim.fn.winsaveview()
    local height = vim.api.nvim_win_get_height(win)
    local so = math.min(vim.wo[win].scrolloff, math.floor((height - 1) / 2))
    local lo = line == 1 and 1 or line + so
    local hi = math.min(last, line + height - 1 - (line + height - 1 >= last and 0 or so))
    local lnum = math.min(math.max(view.lnum, lo), math.max(lo, hi))
    vim.fn.winrestview({ topline = line, lnum = lnum, col = lnum == view.lnum and view.col or 0, curswant = view.curswant })
  end)
end

-- Tests: on / off, what the app wants
function M.state() return { on = on, wanted = wanted } end

return M
