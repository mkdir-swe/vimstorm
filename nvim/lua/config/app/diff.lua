-- The app's diff viewer / merge window chrome (Rust side: app/src/git/diff, "DiffView"). The panes stay nvim
-- windows (git/diff.lua, git/merge.lua: buffers, highlights, revert / accept / ignore); Lua draws no
-- toolbar window, winbar headers, gutter numbers, gap lines or scrollbar-mark floats. Instead this module
-- describes the open viewer to the app, which draws all of that natively around and between the grids:
--
-- Lua -> Rust (`vimstorm.diff`):
--   viewer {gen, viewer = "diff"|"merge", panes, dividers, toolbar}: whenever something shown changed
--     panes[i] (left to right) = {win, title = {lock?, hash?, path?, text?}, lines (line count), drafts? (a PR
--       diff: the lines with a review comment drafted, {line, body}: a comment mark in the gutter), cards? (a PR
--       diff: the review cards under their lines, {kind = thread | draft | outdated | writing, line, rows, id? | seq? | token?})}
--     dividers[i] (between panes i and i + 1) = changes {a = {s, e}, b = {s, e}, kind, actions?}: 1-based
--       line ranges [s, e) (s == e: an empty side, between lines s - 1 and s), kind inserted / deleted /
--       modified / conflict; actions = gutter icons {pane, icon, action, args, tip}
--     toolbar = diff {files = {index, count}, differences, ignore, highlight, review? = {pr, path}} / merge {conflicts, total,
--       simple, ignore, highlight}; both: collapsed (unchanged code folded), synced (panes scroll together)
--   close: no viewer anymore
-- Rust -> Lua: action(gen, name, ...) (toolbar buttons, gutter icons: stale gen = the change moved, ignored),
--   dropdown(name, x, y) (toolbar dropdown menu at window px), menu(win, line, x, y) (right-click on the native
--   gutter / header: the pane's context menu).
--
-- Gutter rows: every pane's statuscolumn (COLUMN) holds the buffer line drawn in that row as one character
-- U+F0000 + line (cell 0, drawn invisible) and a fold mark in cell 1; the app reads them from the grid it
-- draws, so the native line numbers, change bands and connectors follow the text in every frame (smooth
-- scrolling, held sync-group pictures, folds) without asking nvim. The first (left) pane keeps just those two
-- cells (its gutter is drawn right of the grid, next to the divider, like WebStorm's mirrored left editor; the
-- two cells are its scrollbar-marks strip), the others reserve their whole gutter in the statuscolumn.
local bridge = require("config.app.bridge")

local M = {}

M.CODE = 0xF0000 -- line l is U+F0000 + l (plane 15 private use: one cell, no font has it)
M.MAX_LINE = 0xFFFD -- lines past it get no code (the app draws no number / band there)
M.FOLD = 0xF0001 -- cell 1 of a closed fold's row
M.COLUMN = "%{%v:lua.require'config.app.diff'.column()%}"

local gen = 0
local last = nil ---@type string? the last description sent (json), "close" after a close
local cells = {} ---@type table<integer, integer> window -> statuscolumn cells

---@return "diff"|"merge"|nil, table? state
local function viewer()
  local d = package.loaded["git.diff"]
  if d and d.state() then return "diff", d.state() end
  local m = package.loaded["git.merge"]
  if m and m.state() then return "merge", m.state() end
end

-- The viewer's windows left to right
---@return integer[]
local function pane_wins()
  local kind, s = viewer()
  if kind == "diff" then return { s.old_win, s.new_win } end
  if kind == "merge" then return { s.wins.yours, s.wins.result, s.wins.theirs } end
  return {}
end

local function valid(win) return win ~= nil and vim.api.nvim_win_is_valid(win) end

-- The view toggles' state (WS Collapse Unchanged Fragments / Synchronize Scrolling)
---@param s table the viewer state (its `sync` group: the panes)
local function view_state(s)
  local wins = s.sync or {}
  local collapsed = false
  for _, w in ipairs(wins) do
    if valid(w) and vim.wo[w].foldenable then collapsed = true end
  end
  local synced = wins[1] ~= nil and require("git.scrollsync").group_of(wins[1]) ~= nil
  return collapsed, synced
end

-- Cells of a pane's native gutter: the line numbers and an icon column (4 cells: padding, icon, gaps; the
-- merge window's sides have two icons per conflict: accept and ignore)
---@param win integer
local function gutter_cells(win)
  local n = vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))
  local kind, s = viewer()
  local two = kind == "merge" and (win == s.wins.yours or win == s.wins.theirs)
  return #tostring(n) + 4 + (two and 2 or 0)
end

-- What config/app/layout.lua reports for a viewer pane: its place and gutter (nil: not a pane)
---@param win integer
---@return {pane: integer, panes: integer, merge: boolean, gutter: integer}?
function M.layout_info(win)
  local wins = pane_wins()
  for i, w in ipairs(wins) do
    if w == win and valid(w) then
      return { pane = i, panes = #wins, merge = viewer() == "merge", gutter = gutter_cells(w) }
    end
  end
end

-- statuscolumn of a pane: line code + fold mark, then blanks for the native gutter (see the header)
function M.column()
  local win = vim.api.nvim_get_current_win() -- the window drawn (nvim makes it current meanwhile)
  local n = cells[win] or 2
  local l = vim.v.lnum
  local code, mark = " ", " "
  if vim.v.virtnum == 0 and l <= M.MAX_LINE then
    code = vim.fn.nr2char(M.CODE + l)
    if vim.fn.foldclosed(l) ~= -1 then mark = vim.fn.nr2char(M.FOLD) end
  end
  return "%#GitDiffFiller#" .. code .. mark .. (" "):rep(n - 2)
end

-- Does a change at [hs, he) touch [a, b)? (either may be empty)
local function touches(hs, he, a, b)
  if hs == he then return hs >= a and hs <= b end
  if a == b then return a >= hs and a <= he end
  return hs < b and he > a
end

-- vim.text.diff hunks -> 1-based [s, e) ranges per side
---@param h integer[] {as, ac, bs, bc}
local function sides(h)
  local as, ac, bs, bc = h[1], h[2], h[3], h[4]
  local a = ac == 0 and as + 1 or as
  local b = bc == 0 and bs + 1 or bs
  return { s = a, e = a + ac }, { s = b, e = b + bc }
end

local function shape(a, b)
  if a.s == a.e then return "inserted" end
  if b.s == b.e then return "deleted" end
  return "modified"
end

-- Header of a diff pane
local function diff_titles(s)
  local f = s.files[s.index]
  if f.snapshot then -- the agent's version on disk beside the editor's unsaved one (W-25)
    return { { lock = true, text = "On disk (changed outside the editor)" }, { text = "Editor (unsaved)" } }
  end
  local old_path = f.old_path or f.path
  local old = (f.status == "A" or f.status == "?") and { text = "(new file)" }
    or { lock = true, hash = s.short[s.revs.old], path = old_path }
  local new
  if f.status == "D" then
    new = { text = "(deleted)" }
  elseif s.revs.new and s.review and s.review.head == s.revs.new and old_path == f.path then
    -- a PR diff (G25): the right side names the PR it is the head of
    new = { lock = true, hash = s.short[s.revs.new], path = ("head of #%d"):format(s.review.pr) }
  elseif s.revs.new then
    new = { lock = true, hash = s.short[s.revs.new], path = old_path ~= f.path and f.path or nil }
  else
    new = { text = "Current version" }
  end
  return { old, new }
end

---@param s GitDiffState
local function describe_diff(s)
  local diff = require("git.diff")
  local scrollsync = require("git.scrollsync")
  local old_buf, new_buf = vim.api.nvim_win_get_buf(s.old_win), vim.api.nvim_win_get_buf(s.new_win)
  local revert = diff.revertable(s)
  local changes = {}
  for i, h in ipairs(scrollsync.changes(old_buf, new_buf, scrollsync.diffopt())) do
    local a, b = sides(h)
    local c = { a = a, b = b, kind = shape(a, b) }
    if revert then
      c.actions = { { pane = 1, icon = "revert", action = "revert", args = { i }, tip = "Revert" } }
    end
    changes[#changes + 1] = c
  end
  local titles = diff_titles(s)
  local panes = {
    { win = s.old_win, title = titles[1], lines = vim.api.nvim_buf_line_count(old_buf) },
    { win = s.new_win, title = titles[2], lines = vim.api.nvim_buf_line_count(new_buf) },
  }
  if s.review then -- a PR diff: the lines with a draft waiting, the review cards (config/app/review.lua)
    local review, path = require("config.app.review"), s.files[s.index].path
    panes[1].drafts, panes[2].drafts = review.drafted(path, "LEFT"), review.drafted(path, "RIGHT")
    panes[1].cards, panes[2].cards = review.cards("LEFT"), review.cards("RIGHT")
  end
  return {
    viewer = "diff",
    panes = panes,
    dividers = { changes },
    toolbar = {
      files = { s.index, #s.files },
      differences = s.count or 0,
      ignore = diff.ignore_mode(),
      highlight = diff.highlight_mode(),
      collapsed = (view_state(s)),
      synced = select(2, view_state(s)),
      -- a PR diff: its number and the file (the app draws `#n`, the scope and Reviewed)
      review = s.review and { pr = s.review.pr, path = s.files[s.index].path } or nil,
    },
  }
end

-- Boundary above base line `b` (1..n+1) in the result, through the base -> result hunks: a boundary inside a
-- hunk goes to its start (`first`) or end
---@param b integer
---@param hunks integer[][]
---@param first boolean
local function map_boundary(b, hunks, first)
  local off = 0
  for _, h in ipairs(hunks) do
    local ra, rr = sides(h)
    if b < ra.s or (b == ra.s and ra.e > ra.s) then
      if b == ra.s then return rr.s end
      break
    end
    if b < ra.e or (b == ra.s and ra.e == ra.s) then return first and rr.s or rr.e end
    off = rr.e - ra.e
  end
  return b + off
end

local function buf_text(buf)
  return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n") .. "\n"
end

---@param s GitMergeState
local function describe_merge(s)
  local diff = require("git.diff")
  local merge = require("git.merge")
  local scrollsync = require("git.scrollsync")
  local b = s.bufs
  -- the whitespace mode applies (as to nvim's own line colors)
  local opts = vim.tbl_extend("force", scrollsync.diffopt(), { result_type = "indices" })
  local function changes(x, y) return vim.text.diff(x, y, opts) --[[@as integer[][] ]] end
  -- unresolved conflicts' result ranges, 1-based [s, e)
  local open = {}
  local left = 0
  for i, c in ipairs(s.conflicts) do
    if not c.resolved then
      local first, last_ = merge.range(c)
      open[i] = { s = first + 1, e = last_ + 1 }
      left = left + 1
    end
  end
  local function conflict_of(r)
    for i, cr in pairs(open) do
      if touches(r.s, r.e, cr.s, cr.e) then return i end
    end
  end
  -- WS: each side's changes against the base, joined to where they are in the result (the base -> result
  -- hunks carry the base lines over); colors as nvim colors the lines (vs the base), conflicts red
  local base = table.concat(s.texts.base, "\n") .. "\n"
  local to_result = changes(base, buf_text(b.result))
  local dividers, first_of = {}, { {}, {} } -- first_of[d][conflict] = the change carrying its icons
  for d, side in ipairs({ "yours", "theirs" }) do
    local list = {}
    for _, h in ipairs(changes(base, buf_text(b[side]))) do
      local rb, rside = sides(h)
      local rres = { s = map_boundary(rb.s, to_result, true), e = map_boundary(rb.e, to_result, false) }
      rres.e = math.max(rres.e, rres.s)
      local i = conflict_of(rres)
      local kind = i and "conflict" or shape(rb, rside)
      local c = d == 1 and { a = rside, b = rres, kind = kind } or { a = rres, b = rside, kind = kind }
      if i and not first_of[d][i] then first_of[d][i] = c end
      list[#list + 1] = c
    end
    dividers[d] = list
  end
  for i in pairs(open) do
    local c = s.conflicts[i]
    local l, r = first_of[1][i], first_of[2][i]
    if l then
      l.actions = l.actions or {}
      vim.list_extend(l.actions, {
        { pane = 1, icon = "accept_left", action = "accept", args = { i, "yours" }, tip = "Accept" },
        { pane = 1, icon = "ignore", action = "ignore", args = { i }, tip = "Ignore" },
      })
      if c.magic then
        l.actions[#l.actions + 1] = { pane = 2, icon = "magic", action = "magic", args = { i }, tip = "Resolve Automatically" }
      end
    end
    if r then
      r.actions = r.actions or {}
      vim.list_extend(r.actions, {
        { pane = 3, icon = "accept_right", action = "accept", args = { i, "theirs" }, tip = "Accept" },
        { pane = 3, icon = "ignore", action = "ignore", args = { i }, tip = "Ignore" },
      })
    end
  end
  local function lines(buf) return vim.api.nvim_buf_line_count(buf) end
  return {
    viewer = "merge",
    panes = {
      { win = s.wins.yours, title = { lock = true, text = "Changes from " .. s.names.yours }, lines = lines(b.yours) },
      { win = s.wins.result, title = { text = "Result" }, lines = lines(b.result) },
      { win = s.wins.theirs, title = { lock = true, text = "Changes from " .. s.names.theirs }, lines = lines(b.theirs) },
    },
    dividers = dividers,
    toolbar = {
      -- non-conflicting changes are already in the result (applied by git): none left to apply
      changes = 0,
      conflicts = left,
      total = #s.conflicts,
      simple = #merge.simple(),
      ignore = diff.ignore_mode(),
      highlight = diff.highlight_mode(),
      collapsed = (view_state(s)),
      synced = select(2, view_state(s)),
    },
  }
end

-- Describes the viewer to the app now (it reaches the app before the redraw that shows the change: one frame
-- with grids and chrome together); nothing when it didn't change
function M.changed()
  local kind, s = viewer()
  local wins = pane_wins()
  local ok = kind ~= nil
  for _, w in ipairs(wins) do ok = ok and valid(w) end
  if not ok then
    cells = {}
    if last ~= "close" then
      last = "close"
      bridge.notify("diff", { event = "close" })
    end
    return
  end
  -- statuscolumn widths (gutter digits) before the layout: it reports them
  for i, w in ipairs(wins) do
    local n = i == 1 and 2 or gutter_cells(w)
    if cells[w] ~= n then
      cells[w] = n
      -- nvim keeps a statuscolumn's width until the option is set again (or the line count's digits change)
      if vim.wo[w].statuscolumn == M.COLUMN then vim.wo[w].statuscolumn = M.COLUMN end
    end
  end
  pcall(function() require("config.app.layout").sync() end)
  local okd, desc = pcall(kind == "diff" and describe_diff or describe_merge, s)
  if not okd then return end
  local key = vim.json.encode(desc)
  if key == last then return end
  last = key
  gen = gen + 1
  desc.event, desc.gen = "viewer", gen
  bridge.notify("diff", desc)
end

-- A pane's line under a native gutter click: caret there (the pane becomes the current window)
---@param win integer
---@param line integer
local function goto_line(win, line)
  if not valid(win) then return end
  vim.api.nvim_set_current_win(win)
  local n = vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))
  pcall(vim.api.nvim_win_set_cursor, win, { math.max(1, math.min(line, n)), 0 })
end

-- Folded unchanged code clicked (its gutter row): open it in every pane (git/gutter.lua's wavy-line click)
local function unfold(win, line)
  local scrollsync = require("git.scrollsync")
  for _, w in ipairs(pane_wins()) do
    if valid(w) then
      local l = w == win and line or scrollsync.map(line, scrollsync.win_changes(win, w))
      vim.api.nvim_win_call(w, function() pcall(vim.cmd, l .. "foldopen") end)
    end
  end
end

-- Toolbar buttons and gutter icons (Rust's clicks). Gutter actions carry the description's gen: a click
-- on an icon of a description that's no longer current is dropped (the change it meant may have moved).
---@param g integer
---@param name string
function M.action(g, name, ...)
  local kind, s = viewer()
  if not kind then return end
  local diff, merge = require("git.diff"), require("git.merge")
  local args = { ... }
  local positional = { revert = true, accept = true, ignore = true, magic = true }
  if positional[name] and g ~= gen then return end
  local acts = {
    prev = function() (kind == "diff" and diff or merge).jump(-1) end,
    next = function() (kind == "diff" and diff or merge).jump(1) end,
    prev_file = function() if kind == "diff" then diff.cycle(-1) end end,
    next_file = function() if kind == "diff" then diff.cycle(1) end end,
    open_in_editor = function() (kind == "diff" and diff or merge).open_in_editor() end,
    close = function() (kind == "diff" and diff or merge).close() end,
    revert = function() diff.revert_hunk(args[1]) end,
    accept = function() merge.accept(args[1], args[2]) end,
    ignore = function() merge.ignore(args[1]) end,
    magic = function() merge.magic(args[1]) end,
    magic_all = function() merge.magic_all() end,
    accept_left = function() merge.accept_all("yours") end,
    accept_right = function() merge.accept_all("theirs") end,
    apply = function() merge.save(true) end,
    cancel = function() merge.close() end,
    line = function() goto_line(args[1], args[2]) end,
    unfold = function() unfold(args[1], args[2]) end,
    -- a divider double-clicked: the panes equally wide again
    equal = function() (kind == "diff" and diff or merge).equal_widths() end,
    -- toolbar toggles: fold unchanged code in every pane (zM / zR) / scroll the panes together or not
    collapse = function()
      local collapsed = view_state(s)
      for _, w in ipairs(s.sync or {}) do
        if valid(w) then vim.wo[w].foldenable, vim.wo[w].foldlevel = not collapsed, 0 end
      end
    end,
    sync_scroll = function()
      local scrollsync = require("git.scrollsync")
      local _, synced = view_state(s)
      if synced then
        scrollsync.remove(s.sync)
      elseif s.sync then
        scrollsync.add(s.sync)
        scrollsync.sync(vim.api.nvim_get_current_win())
      end
    end,
  }
  local fn = acts[name]
  if fn then fn() end
  if name == "collapse" or name == "sync_scroll" then
    M.changed()
    -- the app shows a description with the flush after it: one even when nothing redraws
    pcall(vim.api.nvim__redraw, { flush = true })
  end
  return s ~= nil
end

-- Toolbar dropdowns: viewer / ignore / highlight mode menus below the button (window px)
---@param name "viewer"|"ignore"|"highlight"
function M.dropdown(name, x, y)
  local kind = viewer()
  if not kind then return end
  local diff = require("git.diff")
  local pos = { x = x, y = y }
  local function set(fn)
    return function(choice)
      fn(choice)
      if kind == "merge" then require("git.merge").repaint() end
    end
  end
  if name == "viewer" then
    diff.choose({ { "Side-by-side viewer" } }, "Side-by-side viewer", function() end, pos)
  elseif name == "ignore" then
    diff.choose(diff.IGNORE, diff.ignore_mode(), set(diff.set_ignore), pos)
  elseif name == "highlight" then
    diff.choose(diff.HIGHLIGHT, diff.highlight_mode(), set(diff.set_highlight), pos)
  end
end

-- Right-click on a pane's native gutter / header: caret to that line, the pane's context menu at (x, y)
---@param win integer
---@param line integer 0: the header (caret stays)
function M.menu(win, line, x, y)
  local kind = viewer()
  if not (kind and valid(win)) then return end
  if line > 0 then goto_line(win, line) else vim.api.nvim_set_current_win(win) end
  local items = require(kind == "diff" and "git.diff" or "git.merge").menu_items(win)
  if items then require("config.menu").open(items, { pos = { x = x, y = y } }) end
end

return M
