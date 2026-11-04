-- Multiple cursors like WebStorm's Clone Caret Above/Below (Ctrl+L / Ctrl+Ö):
-- * Ctrl+Ö / Ctrl+L add a cursor below / above. Going back the other way removes
--   the cursors you added (the one you're passing), so you can shrink the column.
-- * With several cursors, ö / l move only the cursor being placed, so rows can be skipped.
-- * Everything else (typing, Cmd+W, motions) runs on all cursors. Esc collapses them.
-- * Ctrl+N adds the next match of the word, Ctrl+X skips it, Ctrl+P drops the current cursor.
-- * Insert mode types on every caret as it goes, like WebStorm (see "Live insert" below).
-- * Feel vscode: VS Code's ⌘D / ⌘K ⌘D / ⌥click on the same cursors (see "VS Code" below).
-- * The app draws the other carets like the caret (config/app/carets.lua reads M.carets()).
local M = {}
local api = vim.api

---@param dir -1|1
function M.clone(dir)
  local mc = require("multicursor-nvim")
  local retracted = false
  mc.action(function(ctx)
    local main = ctx:mainCursor()
    local line = main:line()
    local others = vim.tbl_filter(function(c) return not c:isMainCursor() end, ctx:getCursors())
    if #others == 0 then return end
    -- main is the far end and every other cursor lies the way we're going: drop main
    for _, c in ipairs(others) do
      if (c:line() - line) * dir <= 0 then return end
    end
    table.sort(others, function(a, b) return math.abs(a:line() - line) < math.abs(b:line() - line) end)
    main:delete()
    others[1]:select()
    retracted = true
  end)
  if not retracted then mc.lineAddCursor(dir, { skipEmpty = false }) end
end

-- Live insert ----------------------------------------------------------------------------------------------
-- multicursor.nvim types into the other cursors only when Insert mode ends (it replays the insert at the next
-- SafeState) and has no option for more. WebStorm types on every caret as it goes, so while Insert mode runs
-- with several cursors this mirrors the main caret's edits onto the others, in the same redraw:
-- * InsertEnter: each other cursor runs the command that started Insert mode: i / a / I / A by position,
--   o / O by hand (indent relative to its own line, as the main got), operators (cw / cc / s ...) as a
--   nested "." and selections as gv + the key, noting where the caret lands in that nested Insert mode. This
--   runs before Insert mode sets its start (Insstart), and from a Vimscript function: each nested "." sees
--   the whole redo buffer and the main insert's dot-repeat stays intact.
-- * Typing (TextChangedI / CursorMovedI): the main caret's change since the last sync (diff of a few rows,
--   anchored at the caret) becomes "delete n chars before it and m after, insert this text, caret here".
--   That covers keys, Backspace / Delete, Enter, completion, pairs, paste and Copilot alike; it's applied at
--   each other caret (extmarks) with nvim_buf_set_text, new lines re-indented relative to that caret's line.
--   <C-w> / <C-u> delete each caret's own word / line start; Replace mode overwrites and Backspace restores
--   each caret's own text. Arrow keys move every caret. A plain click drops the other carets (WebStorm).
-- * Leaving Insert mode: the plugin's replay is skipped (wrapped _onSafeState) and its cursors go where Esc
--   leaves them (one char left). All edits stay in the main insert's undo step.
-- The plugin's internals used (pinned in lazy-lock.json): InputManager._onSafeState / _applying / _typed /
-- _keys / _wasMode, CursorManager:action, the CursorContext (upvalue) and the snippet manager's original
-- vim.snippet.

local NS = api.nvim_create_namespace("vimstorm_mc_live") -- caret anchors + insert starts
local DRAW = api.nvim_create_namespace("vimstorm_mc_live_draw") -- carets drawn while typing
local GROUP = api.nvim_create_augroup("vimstorm_mc_live", { clear = true })
local CARET_HL = "MultiCursorLiveCaret"
local CAPTURE = vim.keycode("<Cmd>lua require('config.multicursor')._capture()<CR>")
local ROWS = 3 -- rows above / below the main caret diffed on each sync
-- insert commands whose other-cursor caret is found by position (no text change)
local AT = { i = true, a = true, I = true, A = true, gI = true, gi = true, R = true, gR = true }
local MOTION = { Left = true, Right = true, Up = true, Down = true, Home = true, End = true, PageUp = true,
  PageDown = true, kHome = true, kEnd = true }

---@class LiveCaret
---@field cursor table multicursor.nvim cursor
---@field id integer caret anchor (right gravity: text typed at it goes before it)
---@field start integer insert start (left gravity)
---@field reg? table its unnamed register after its own change
---@field stack string[] Replace mode: the text each typed char overwrote
---@field merged? boolean reached another caret (WebStorm merges them)
---@field final? integer[] normal-mode position after Esc { row0, col }

---@class LiveSession
---@field sid integer
---@field buf integer
---@field carets LiveCaret[]
---@field hl table MultiCursorCursor while the session hides the plugin's cursors
---@field draws boolean MultiCursorCursor shows something: draw() draws the carets
---@field w0 integer rows diffed: snapshot of [w0, w1]
---@field w1 integer
---@field snap string[]
---@field c0 integer main caret's byte offset in the snapshot text
---@field crow integer main caret at the last sync
---@field ccol integer
---@field mode string last Insert sub-mode (i / R)
---@field keys string[] keys since the last sync
---@field dirty? boolean the main changed the rows since the last sync
---@field invalid? boolean ... beyond them: not mirrored
---@field applying? boolean our own edits
---@field left_pre? boolean InsertLeavePre synced the typing
---@field active boolean
---@field pending? boolean Insert mode ended, cursors not placed yet
---@field typed_len? integer
---@field keys_len? integer
---@field mode_after? string

local mc, im, cm, sm, Ctx, state
local L ---@type LiveSession?
local sid = 0
local busy = false -- running the entry at the other cursors
local captured ---@type table?
local track = { keys = {}, start = 1, mode = "n" } -- typed keys since SafeState, outside Insert mode
local ctrl_o = false -- in Insert-Normal mode (CTRL-O): returning to Insert isn't a new insert

local function is_ins(m) local c = m:sub(1, 1) return c == "i" or c == "R" end
local function cps(s) return vim.str_utfindex(s, "utf-32") end
local function is_cont(b) return b ~= nil and b >= 0x80 and b < 0xC0 end
local function get_line(buf, r) return api.nvim_buf_get_lines(buf, r, r + 1, false)[1] or "" end
local function mark(buf, id) return api.nvim_buf_get_extmark_by_id(buf, NS, id, {}) end
local function set_mark(buf, id, r, c, gravity)
  return api.nvim_buf_set_extmark(buf, NS, r, c, { id = id, right_gravity = gravity ~= false, strict = false })
end

local function upvalue(fn, name)
  for i = 1, 60 do
    local n, v = debug.getupvalue(fn, i)
    if not n then return end
    if n == name then return v end
  end
end

-- (r, c) moved by n characters (a line break counts as one), clamped to the buffer
local function move(buf, r, c, n)
  local last = api.nvim_buf_line_count(buf) - 1
  while n ~= 0 do
    local line = get_line(buf, r)
    local idx = vim.str_utfindex(line, "utf-32", math.min(c, #line), false)
    if n > 0 then
      local rest = cps(line) - idx
      if n <= rest then
        return r, vim.str_byteindex(line, "utf-32", idx + n, false)
      elseif r >= last then
        return r, #line
      end
      n, r, c = n - rest - 1, r + 1, 0
    else
      if -n <= idx then
        return r, vim.str_byteindex(line, "utf-32", idx + n, false)
      elseif r == 0 then
        return 0, 0
      end
      n, r = n + idx + 1, r - 1
      c = #get_line(buf, r)
    end
  end
  return r, c
end

local function offset(lines, ri, col)
  local o = col
  for i = 1, ri do o = o + #lines[i] + 1 end
  return o
end

-- Byte offset in s just after the character before byte offset c (UTF-8)
local function prev_char(s, c)
  c = c - 1
  while c > 0 and is_cont(s:byte(c + 1)) do c = c - 1 end
  return math.max(c, 0)
end

local function word_class(ch)
  if ch:match("^%s") then return 0 end
  if ch:match("^[%w_]") or #ch > 1 then return 2 end
  return 1
end

-- Where <C-w> (word) / <C-u> (line) at (r, c) starts deleting, as Vim's ins_bs() does with
-- 'backspace' indent,eol,start: stop once at the insert start, <C-u> keeps the indent ('autoindent')
local function bs_start(buf, kind, r, c, sr, sc)
  if c == 0 then
    if r == 0 then return r, c end
    return r - 1, #get_line(buf, r - 1)
  end
  local line = get_line(buf, r)
  local min = 0
  if sr == r and sc < c then min = sc end
  if kind == "line" then
    local first = (line:find("%S") or #line + 1) - 1
    if first < c then min = math.max(min, first) end
    return r, min
  end
  local i, cls = c, nil
  while i > min do
    local j = prev_char(line, i)
    local k = word_class(line:sub(j + 1, i))
    if cls == nil then
      if k ~= 0 then cls = k end
    elseif k ~= cls then
      break
    end
    i = j
  end
  return r, i
end

-- The main caret's change between two texts of the same rows: common prefix up to the caret, common suffix
-- after it, on character boundaries. c0 / c1: the caret's byte offset before / after.
local function diff(old, new, c0, c1)
  local lim, p = math.min(c0, c1), 0
  while p < lim and old:byte(p + 1) == new:byte(p + 1) do p = p + 1 end
  while p > 0 and (is_cont(old:byte(p + 1)) or is_cont(new:byte(p + 1))) do p = p - 1 end
  local slim, s = math.min(#old - c0, #new - c1), 0
  while s < slim and old:byte(#old - s) == new:byte(#new - s) do s = s + 1 end
  while s > 0 and is_cont(old:byte(#old - s + 1)) do s = s - 1 end
  return p, s
end

-- Keys since the last sync: n presses of <C-w> / <C-u> and nothing else that edits (Vim's default <C-u>
-- mapping is <C-g>u<C-u>; <F..> are the test harness's markers)
local function bs_keys(keys)
  local kind, n, prev = nil, 0, nil
  for _, key in ipairs(keys) do
    local k = vim.fn.keytrans(key)
    local this = (k == "<C-W>" and "word") or (k == "<C-U>" and "line") or nil
    if this then
      if kind and kind ~= this then return end
      kind, n = this, n + 1
    elseif not (k == "<C-G>" or (k == "u" and prev == "<C-G>") or k == "<Esc>" or k:match("^<F%d+>$")) then
      return
    end
    prev = k
  end
  return kind, n
end

local function count_keys(keys, want)
  local n = 0
  for _, key in ipairs(keys) do
    local k = vim.fn.keytrans(key)
    if want[k] then
      n = n + 1
    elseif not (k == "<Esc>" or k:match("^<F%d+>$")) then
      return 0
    end
  end
  return n
end

-- The last motion key since the last sync (Left, End, ...), or nil
local function motion_key(keys)
  local last
  for _, key in ipairs(keys) do
    local name = vim.fn.keytrans(key):match("^<.-(%a+)>$")
    if name and MOTION[name] then last = name end
  end
  return last
end

local function live_carets(S)
  return vim.tbl_filter(function(c) return not c.merged end, S.carets)
end

-- Carets drawn at the anchors while typing (the plugin draws its cursors at their last Normal-mode spot); none
-- while its cursor highlight shows nothing (the app's colors: the app draws them from M.carets, #225)
local function draw(S)
  if not S.draws then return end
  api.nvim_buf_clear_namespace(S.buf, DRAW, 0, -1)
  for _, c in ipairs(live_carets(S)) do
    local p = c.final or mark(S.buf, c.id)
    if p[1] then
      local line = get_line(S.buf, p[1])
      if p[2] < #line then
        local e = p[2] + 1
        while is_cont(line:byte(e + 1)) do e = e + 1 end
        api.nvim_buf_set_extmark(S.buf, DRAW, p[1], p[2], { end_col = e, hl_group = CARET_HL, priority = 20001 })
      else
        api.nvim_buf_set_extmark(S.buf, DRAW, p[1], #line,
          { virt_text = { { " ", CARET_HL } }, virt_text_pos = "overlay", priority = 20001 })
      end
    end
  end
end

local function snapshot(S, crow, ccol)
  S.w0 = math.max(0, crow - ROWS)
  S.w1 = math.min(api.nvim_buf_line_count(S.buf) - 1, crow + ROWS)
  S.snap = api.nvim_buf_get_lines(S.buf, S.w0, S.w1 + 1, false)
  S.c0 = offset(S.snap, crow - S.w0, ccol)
  S.crow, S.ccol = crow, ccol
  S.dirty, S.invalid = false, false
end

-- Merge carets that met the main caret or each other
local function merge(S, crow, ccol)
  local seen = { [crow .. ":" .. ccol] = true }
  for _, c in ipairs(live_carets(S)) do
    local p = mark(S.buf, c.id)
    local key = (p[1] or -1) .. ":" .. (p[2] or -1)
    if seen[key] then c.merged = true end
    seen[key] = true
  end
end

---@param S LiveSession
local function apply_motion(S, crow, ccol, key)
  local buf, dr = S.buf, crow - S.crow
  local mline = get_line(buf, crow)
  local last = api.nvim_buf_line_count(buf) - 1
  local d = dr == 0 and (cps(mline:sub(1, ccol)) - cps(mline:sub(1, math.min(S.ccol, #mline)))) or 0
  for _, c in ipairs(live_carets(S)) do
    local p = mark(buf, c.id)
    local r = math.max(0, math.min(last, p[1] + dr))
    local line = get_line(buf, r)
    local col
    if key == "Home" or key == "kHome" then
      col = 0
    elseif key == "End" or key == "kEnd" then
      col = #line
    else
      local idx = vim.str_utfindex(get_line(buf, p[1]), "utf-32", p[2], false) + d
      col = vim.str_byteindex(line, "utf-32", math.max(0, math.min(idx, cps(line))), false)
    end
    set_mark(buf, c.id, r, col)
  end
end

---@param S LiveSession
local function apply_change(S, old, new, c0, c1, keys, stopping)
  local buf = S.buf
  local p, s = diff(old, new, c0, c1)
  local del, ins = old:sub(p + 1, #old - s), new:sub(p + 1, #new - s)
  local before, after = cps(old:sub(p + 1, c0)), cps(old:sub(c0 + 1, #old - s))
  local carets = live_carets(S)

  -- Esc removed the main line's auto-indent: same at carets on a blank line
  if stopping then
    if ins == "" and after == 0 and del:match("^[ \t]+$") then
      for _, c in ipairs(carets) do
        local m = mark(buf, c.id)
        local line = get_line(buf, m[1])
        if line:match("^[ \t]+$") and m[2] == #line then
          api.nvim_buf_set_text(buf, m[1], 0, m[1], m[2], { "" })
          set_mark(buf, c.id, m[1], 0)
        end
      end
    end
    return
  end

  -- <C-w> / <C-u>: each caret deletes its own word / line start
  local kind, presses = bs_keys(keys)
  if kind and ins == "" and after == 0 and before > 0 then
    for _, c in ipairs(carets) do
      for _ = 1, presses do
        local m, st = mark(buf, c.id), mark(buf, c.start)
        local sr, sc = bs_start(buf, kind, m[1], m[2], st[1], st[2])
        if sr ~= m[1] or sc ~= m[2] then api.nvim_buf_set_text(buf, sr, sc, m[1], m[2], { "" }) end
        set_mark(buf, c.id, sr, sc)
      end
    end
    return
  end

  if S.mode:sub(1, 1) == "R" and not del:find("\n") and not ins:find("\n") then
    -- Replace mode typing: overwrite at each caret, remembering what it overwrote
    if p == c0 and #ins > 0 and c1 == p + #ins and cps(del) <= cps(ins) then
      local n = cps(ins)
      for _, c in ipairs(carets) do
        local m = mark(buf, c.id)
        local line = get_line(buf, m[1])
        local _, e = move(buf, m[1], m[2], math.min(n, cps(line:sub(m[2] + 1))))
        for _, ch in ipairs(vim.fn.split(line:sub(m[2] + 1, e), "\\zs")) do c.stack[#c.stack + 1] = ch end
        for _ = cps(line:sub(m[2] + 1, e)) + 1, n do c.stack[#c.stack + 1] = "" end
        api.nvim_buf_set_text(buf, m[1], m[2], m[1], e, { ins })
        set_mark(buf, c.id, m[1], m[2] + #ins)
      end
      return
    end
    -- Replace mode Backspace: each caret gets back what it overwrote
    local n = count_keys(keys, { ["<BS>"] = true, ["<C-H>"] = true })
    if n > 0 and c1 < c0 then
      for _, c in ipairs(carets) do
        for _ = 1, n do
          local m = mark(buf, c.id)
          if m[2] == 0 then break end
          local line = get_line(buf, m[1])
          local pc = prev_char(line, m[2])
          local orig = table.remove(c.stack)
          if orig then api.nvim_buf_set_text(buf, m[1], pc, m[1], m[2], { orig }) end
          set_mark(buf, c.id, m[1], pc)
        end
      end
      return
    end
  end

  if del == "" and ins == "" then return end

  -- where the main caret ends: line li of the inserted text, char col cc (extra: chars past its end)
  local mlines = vim.split(ins, "\n", { plain = true })
  local caret, li, cc, extra = cps(new:sub(p + 1, c1)), #mlines, 0, 0
  for i, l in ipairs(mlines) do
    local n = cps(l)
    if caret <= n then
      li, cc = i, caret
      break
    end
    caret = caret - n - 1
    if i == #mlines then li, cc, extra = i, n, caret + 1 end
  end
  local ls = old:sub(1, p):match(".*\n()") or 1
  local mindent = old:match("^[ \t]*", ls)
  local replace = S.mode:sub(1, 1) == "R" and not del:find("\n")

  for _, c in ipairs(carets) do
    local m = mark(buf, c.id)
    local sr, sc = move(buf, m[1], m[2], -before)
    local er, ec = move(buf, m[1], m[2], after)
    if replace and er > m[1] then er, ec = m[1], #get_line(buf, m[1]) end
    local lines = vim.deepcopy(mlines)
    local shift = 0
    if #lines > 1 then
      local oindent = get_line(buf, sr):match("^[ \t]*")
      if oindent ~= mindent then
        for i = 2, #lines do
          if (lines[i] ~= "" or i == #lines) and lines[i]:sub(1, #mindent) == mindent then
            lines[i] = oindent .. lines[i]:sub(#mindent + 1)
            if i == li and cc >= cps(mindent) then shift = cps(oindent) - cps(mindent) end
          end
        end
      end
    end
    api.nvim_buf_set_text(buf, sr, sc, er, ec, lines)
    local r = sr + li - 1
    local col = (li == 1 and sc or 0) + vim.str_byteindex(lines[li], "utf-32", math.max(0, cc + shift), false)
    if extra > 0 then r, col = move(buf, r, col, extra) end
    set_mark(buf, c.id, r, col)
  end
end

-- fn's edits of buf told to the language servers as one change spanning them all (#225): nvim's change tracking
-- takes each nvim_buf_set_text on its own (copies the buffer's lines, diffs them, rearms a timer), ~25 µs per
-- edit and client group, so 50 carets cost more than the rest of the keystroke. Plain fn() if its internals moved.
local function one_lsp_change(buf, fn)
  local ct = package.loaded["vim.lsp._changetracking"]
  local send = ct and ct.send_changes
  if type(send) ~= "function" then return fn() end
  -- the rows changed so far: [first, last) now, last - delta before
  local first, last, delta ---@type integer?, integer, integer
  local done = false
  local function collect(b, f, l, nl)
    if b ~= buf or done then return send(b, f, l, nl) end -- done: kept by a wrapper set meanwhile
    if not first then
      first, last, delta = f, nl, nl - l
    else
      first, last, delta = math.min(first, f), math.max(last, l) + nl - l, delta + nl - l
    end
  end
  ct.send_changes = collect
  local ok, err = pcall(fn)
  done = true
  if ct.send_changes == collect then ct.send_changes = send end
  if first then send(buf, first, last - delta, last) end
  if not ok then error(err, 0) end
end

-- Mirror what the main caret did since the last sync. pos: the main caret { row0, col } (default: the cursor)
local function sync(pos, stopping)
  local S = L
  if not S or not S.active or not S.snap or busy or api.nvim_get_current_buf() ~= S.buf then return end
  local crow, ccol
  if pos then
    crow, ccol = pos[1], pos[2]
  else
    local c = api.nvim_win_get_cursor(0)
    crow, ccol = c[1] - 1, c[2]
  end
  local keys = S.keys
  S.keys = {}
  local motion = not S.dirty and motion_key(keys)
  if not S.dirty and not motion and crow == S.crow and ccol == S.ccol then return end
  local mode = api.nvim_get_mode().mode
  if is_ins(mode) then S.mode = mode end
  S.applying = true
  local main = api.nvim_buf_set_extmark(S.buf, NS, crow, ccol, { right_gravity = false })
  local ok, err = pcall(function()
    if S.dirty then
      if not S.invalid and crow >= S.w0 and crow <= S.w1 then
        local lines = api.nvim_buf_get_lines(S.buf, S.w0, S.w1 + 1, false)
        one_lsp_change(S.buf, function()
          apply_change(S, table.concat(S.snap, "\n"), table.concat(lines, "\n"), S.c0,
            offset(lines, crow - S.w0, ccol), keys, stopping)
        end)
      end
    elseif motion then
      apply_motion(S, crow, ccol, motion)
    end
  end)
  S.applying = false
  local m = mark(S.buf, main)
  api.nvim_buf_del_extmark(S.buf, NS, main)
  if m[1] and (m[1] ~= crow or m[2] ~= ccol) then
    crow, ccol = m[1], m[2]
    if not pos then pcall(api.nvim_win_set_cursor, 0, { crow + 1, ccol }) end
  end
  if not ok then vim.notify("multicursor live insert: " .. tostring(err), vim.log.levels.DEBUG) end
  merge(S, crow, ccol)
  snapshot(S, crow, ccol)
  draw(S)
end

local function cleanup(S)
  if api.nvim_buf_is_valid(S.buf) then
    api.nvim_buf_clear_namespace(S.buf, NS, 0, -1)
    api.nvim_buf_clear_namespace(S.buf, DRAW, 0, -1)
  end
  api.nvim_set_hl(0, "MultiCursorCursor", S.hl)
  if L == S then L = nil end
end

-- Cursors where Esc leaves them; full = inside a multicursor action (registers, undo positions)
local function place(S, alive, full)
  for _, c in ipairs(S.carets) do
    local cur = c.cursor
    if c.final and alive[cur] then
      cur:setMode("n")
      if full and c.reg then
        cur:perform(function() vim.fn.setreg('"', c.reg) end)
      end
      cur:setPos({ c.final[1] + 1, c.final[2] + 1 })
      cur:setVisualAnchor({ c.final[1] + 1, c.final[2] + 1 })
      local st = api.nvim_buf_is_valid(S.buf) and mark(S.buf, c.start) or {}
      if full and st[1] then
        cur:setUndoChangePos({ st[1] + 1, st[2] + 1 })
        cur:setRedoChangePos({ st[1] + 1, st[2] + 1 })
      end
    end
  end
end

local function alive_set(list)
  local t = {}
  for _, cur in ipairs(list) do t[cur] = true end
  return t
end

-- Insert mode ended (SafeState, before the plugin would replay it): place the cursors, then let the plugin
-- carry on as if this insert had been one of its own
local function finalize(self, mode)
  local S = L
  if not S then return end
  if mode:match("^[nvVsS\22\19]$") then
    self._applying = true
    cm:dirty()
    if cm:hasCursors() then
      -- a yank typed after Esc (typeahead) is the plugin's to replay next, not part of this action
      local yanked = state.yanked
      state.yanked = false
      cm:action(function(ctx)
        local alive = alive_set(ctx:getCursors())
        place(S, alive, true)
        if self._modeChangeCallbacks and S.mode ~= mode then
          for _, cb in ipairs(self._modeChangeCallbacks) do
            cb(ctx:mainCursor(), S.mode, mode)
            for cur in pairs(alive) do cb(cur, S.mode, mode) end
          end
        end
      end, { excludeMainCursor = true, allowUndo = false })
      state.yanked = yanked
    end
    self._applying = false
  else
    place(S, alive_set(Ctx:getCursors()), false)
  end
  self._typed = (self._typed or ""):sub((S.typed_len or 0) + 1)
  self._keys = (self._keys or ""):sub((S.keys_len or 0) + 1)
  self._wasMode = S.mode_after or mode
  self._fromSelectMode = (self._wasMode or ""):match("^[sS\19]") ~= nil
  cleanup(S)
end

function M._capture()
  captured = {
    pos = api.nvim_win_get_cursor(0),
    line = api.nvim_get_current_line(),
    mode = api.nvim_get_mode().mode,
    reg = vim.fn.getreginfo('"'),
  }
end

-- The insert command's keys, without count and register
local function command(keys)
  local prev
  repeat
    prev = keys
    keys = keys:gsub("^%d+", ""):gsub('^".', "")
  until keys == prev
  return keys
end

-- o / O: the main's new line indent as a change of its neighbour's: { bytes dropped, text added }
local function open_indent(buf, cmd, row)
  local src = row + (cmd == "o" and -1 or 1)
  local si = get_line(buf, src):match("^[ \t]*")
  local ni = get_line(buf, row):match("^[ \t]*")
  if ni:sub(1, #si) == si then return { 0, ni:sub(#si + 1) } end
  return { #si - #ni, "" }
end

-- Run the insert command at one other cursor; returns its caret { row0, col } (or nil) and register.
-- open: o / O indent from open_indent()
local function enter(buf, cur, cmd, vkeys, open)
  local p = cur:getPos()
  local r, c = p[1] - 1, p[2] - 1
  if not cur:hasSelection() and open then
    -- by hand: Insert mode is half on here, a nested o would split the line at the cursor
    local si = get_line(buf, r):match("^[ \t]*")
    local ind = si:sub(1, math.max(0, #si - open[1])) .. open[2]
    if cmd == "o" then
      api.nvim_buf_set_lines(buf, r + 1, r + 1, false, { ind })
      return { r + 1, #ind }
    end
    api.nvim_buf_set_lines(buf, r, r, false, { ind })
    return { r, #ind }
  end
  if not cur:hasSelection() and AT[cmd] then
    local line = get_line(buf, r)
    if cmd == "a" and c < #line then
      c = c + 1
      while is_cont(line:byte(c + 1)) do c = c + 1 end
    elseif cmd == "A" then
      c = #line
    elseif cmd == "I" then
      c = (line:find("%S") or #line + 1) - 1
    elseif cmd == "gI" then
      c = 0
    end
    return { r, math.min(c, #line) }
  end
  local keys, bang
  if not cur:hasSelection() and not cmd:match("^[csSC]") then
    return { r, c } -- something else started Insert mode (a mapping, :startinsert): at the cursor
  end
  if cur:hasSelection() then
    local vs, ve = cur:getVisual()
    vim.fn.setpos("'<", { 0, vs[1], vs[2], vs[3] or 0 })
    vim.fn.setpos("'>", { 0, ve[1], ve[2], ve[3] or 0 })
    keys, bang = "gv" .. vkeys, 0
  else
    pcall(api.nvim_win_set_cursor, 0, { p[1], c })
    keys, bang = ".", 1
  end
  captured = nil
  pcall(vim.fn.MulticursorLiveEntry, keys .. CAPTURE, bang)
  local got = captured
  if not got or not is_ins(got.mode) then return end
  local row = got.pos[1] - 1
  -- Esc took back an auto-indent nothing was typed after (o, cc, S): keep it, the main has it too
  if get_line(buf, row) ~= got.line and vim.trim(got.line) == vim.trim(get_line(buf, row)) then
    api.nvim_buf_set_lines(buf, row, row + 1, false, { got.line })
  end
  return { row, got.pos[2] }, got.reg
end

local function start()
  if L and L.pending then
    place(L, alive_set(Ctx:getCursors()), false)
    cleanup(L)
  end
  if busy or L or ctrl_o then return end
  if not mc.hasCursors() or not mc.cursorsEnabled() then return end
  if im._applying or require("multicursor-nvim.core").performingAction then return end
  if vim.fn.reg_executing() ~= "" then return end
  local entry = table.concat(track.keys, "", track.start)
  local cmd = command(entry)
  -- keys typed before this command the plugin hasn't run at the other cursors yet (typeahead), or a
  -- dot-repeat (the plugin repeats it at each cursor): leave it to the plugin
  if #(im._typed or "") > #entry or cmd == "." then return end
  local visual = track.mode:match("^[vVsS\22\19]") ~= nil
  local vkeys = track.mode:match("^[sS\19]") and "c" or entry
  if visual and vkeys == "" then return end

  local buf, win = api.nvim_get_current_buf(), api.nvim_get_current_win()
  local view = vim.fn.winsaveview()
  local cur0 = api.nvim_win_get_cursor(win)
  -- the main caret, moved by the other cursors' edits above it / before it on its row (cc deletes and
  -- reopens its line: an extmark would land on the wrong row)
  local mrow, mcol = cur0[1] - 1, cur0[2]
  local regs = {}
  for _, r in ipairs({ "-", "1", "2", "3", "4", "5", "6", "7", "8", "9", '"' }) do regs[r] = vim.fn.getreginfo(r) end
  local vmarks = { vim.fn.getpos("'<"), vim.fn.getpos("'>") }

  sid = sid + 1
  local S = { sid = sid, buf = buf, carets = {}, keys = {}, active = false, mode = "i" } ---@type LiveSession
  local open = (cmd == "o" or cmd == "O") and open_indent(buf, cmd, cur0[1] - 1) or nil
  busy = true
  local ok, err = pcall(function()
    for _, cur in ipairs(Ctx:getCursors()) do
      cm:dirty() -- the cursors' cached positions are stale after the previous cursor's edit
      local cp = cur:getPos()
      local lc, len = api.nvim_buf_line_count(buf), #get_line(buf, mrow)
      local pos, reg = enter(buf, cur, cmd, vkeys, open)
      if cp[1] - 1 < mrow then
        mrow = mrow + api.nvim_buf_line_count(buf) - lc
      elseif cp[1] - 1 == mrow and cp[2] - 1 < mcol then
        mcol = mcol + #get_line(buf, mrow) - len
      end
      if pos then
        S.carets[#S.carets + 1] = {
          cursor = cur,
          id = set_mark(buf, nil, pos[1], pos[2]),
          start = set_mark(buf, nil, pos[1], pos[2], false),
          reg = reg,
          stack = {},
        }
      end
    end
  end)
  busy = false
  for r, info in pairs(regs) do
    if r ~= '"' then pcall(vim.fn.setreg, r, info) end
  end
  pcall(vim.fn.setreg, '"', regs['"'])
  vim.fn.setpos("'<", vmarks[1])
  vim.fn.setpos("'>", vmarks[2])
  -- the view first: winrestview() would take a caret past the line's end back onto its last character
  view.lnum, view.col = nil, nil
  pcall(vim.fn.winrestview, view)
  if mrow ~= cur0[1] - 1 or mcol ~= cur0[2] then
    -- lines changed above the main caret: put it back by hand (Insert mode isn't on yet, so allow the
    -- column after the line's end), and tell InsertEnter not to restore its stale position
    local ve = vim.wo[win].virtualedit
    vim.wo[win].virtualedit = "onemore"
    pcall(api.nvim_win_set_cursor, win, { mrow + 1, mcol })
    vim.wo[win].virtualedit = ve
    vim.v.char = "x"
  else
    pcall(api.nvim_win_set_cursor, win, cur0)
  end
  if not ok then vim.notify("multicursor live insert: " .. tostring(err), vim.log.levels.DEBUG) end
  if #S.carets == 0 then
    api.nvim_buf_clear_namespace(buf, NS, 0, -1)
    return
  end

  S.hl = api.nvim_get_hl(0, { name = "MultiCursorCursor" })
  S.draws = next(api.nvim_get_hl(0, { name = "MultiCursorCursor", link = false })) ~= nil
  api.nvim_set_hl(0, CARET_HL, S.hl)
  api.nvim_set_hl(0, "MultiCursorCursor", {})
  S.active = true
  L = S
  -- first snapshot once Insert mode is on (ModeChanged): only then is the main caret at its insert column
  api.nvim_buf_attach(buf, false, {
    on_bytes = function(_, _, _, sr, _, _, oer, oec, _, ner)
      local T = L
      if not T or T.sid ~= S.sid then return true end
      if not T.active or not T.snap then return end
      local oe, ne = sr + oer, sr + ner
      if oe < T.w0 or (oe == T.w0 and oec == 0 and sr < T.w0) then
        T.w0, T.w1 = T.w0 + ne - oe, T.w1 + ne - oe
      elseif sr <= T.w1 and not T.applying then
        if sr < T.w0 or oe > T.w1 then T.invalid = true end
        T.w1 = T.w1 + ne - oe
        T.dirty = true
      end
    end,
  })
end

local function stop(new_mode)
  local S = L
  if not S or not S.active then return end
  -- '^: where Insert mode stopped (Esc already moved the cursor left and took back an unused auto-indent)
  local ins = vim.fn.getpos("'^")
  local pos = (ins[2] > 0 and ins[2] - 1 >= S.w0 - 1 and ins[2] - 1 <= S.w1 + 1) and { ins[2] - 1, ins[3] - 1 } or nil
  -- typing synced at InsertLeavePre (not run for CTRL-C): what's left is Esc's own change
  if not S.left_pre and S.dirty then sync(pos) end
  if pos then
    S.dirty = true
    sync(pos, true)
  end
  S.active, S.pending = false, true
  S.typed_len, S.keys_len, S.mode_after = #(im._typed or ""), #(im._keys or ""), new_mode
  for _, c in ipairs(S.carets) do
    local m = mark(S.buf, c.id)
    if m[1] then
      local col = m[2]
      if col > 0 and not is_ins(new_mode) then col = prev_char(get_line(S.buf, m[1]), col) end
      c.final = { m[1], col }
    end
  end
  draw(S)
end

local function drop()
  local S = L
  if not S then return end
  cleanup(S)
end

local function live_setup()
  mc = require("multicursor-nvim")
  im = require("multicursor-nvim.input-manager")
  cm = require("multicursor-nvim.cursor-manager")
  sm = require("multicursor-nvim.snippet-manager")
  Ctx = upvalue(cm.hasCursors, "CursorContext")
  state = Ctx and upvalue(Ctx.hasCursors, "state")
  if not (state and Ctx.getCursors and type(im._onSafeState) == "function") then return end -- plugin changed

  -- :normal from a function: Vim saves the redo buffer around it and hands the function a copy, so each
  -- other cursor's "." repeats the whole insert command and the main insert's redo is untouched
  vim.cmd([[
    function! MulticursorLiveEntry(keys, bang) abort
      execute 'noautocmd keepjumps normal' . (a:bang ? '!' : '') . ' ' . a:keys
    endfunction
  ]])

  local orig_safe = im._onSafeState
  im._onSafeState = function(self)
    local mode = vim.fn.mode()
    if L and L.pending and not self._applying and not is_ins(mode) and vim.fn.getcmdtype() == "" then
      local ok, err = pcall(finalize, self, mode)
      if not ok then
        if L then cleanup(L) end
        vim.notify("multicursor live insert: " .. tostring(err), vim.log.levels.DEBUG)
      end
    end
    return orig_safe(self)
  end

  -- The plugin expands a snippet by leaving Insert mode and replaying it at every cursor; while typing live
  -- the main expands it and the text is mirrored like any other edit
  local mc_expand = vim.snippet.expand
  vim.snippet.expand = function(...)
    if L and L.active and sm._snippet then return sm._snippet.expand(...) end
    return mc_expand(...)
  end

  vim.on_key(function(key, typed)
    local S = L
    local m = api.nvim_get_mode().mode
    if S and S.active then
      if is_ins(m) then
        -- typeahead: no TextChangedI between keys, so sync what the previous key did before this one runs
        -- (a burst like <End>x would otherwise read as one change)
        if S.snap and (S.dirty or #S.keys > 0) then
          local ok, err = pcall(sync)
          if not ok then vim.notify("multicursor live insert: " .. tostring(err), vim.log.levels.DEBUG) end
        end
        S.keys[#S.keys + 1] = key
        if vim.fn.keytrans(key):match("^<%d?%-?LeftMouse>$") then
          -- a plain click: WebStorm drops the other carets
          sync()
          S.active = false
          vim.schedule(function()
            if L == S then
              drop()
              mc.clearCursors()
            end
          end)
        end
      end
      return
    end
    if typed == "" or is_ins(m) then return end
    if not vim.fn.state():find("[oS]") then
      track.start, track.mode = #track.keys + 1, m
    end
    track.keys[#track.keys + 1] = typed
  end, api.nvim_create_namespace("vimstorm_mc_live_keys"))

  api.nvim_create_autocmd("SafeState", {
    group = GROUP,
    callback = function()
      track.keys, track.start = {}, 1
    end,
  })
  api.nvim_create_autocmd("InsertEnter", {
    group = GROUP,
    callback = function()
      local ok, err = pcall(start)
      if not ok then
        busy = false
        vim.notify("multicursor live insert: " .. tostring(err), vim.log.levels.DEBUG)
      end
    end,
  })
  api.nvim_create_autocmd("ModeChanged", {
    group = GROUP,
    callback = function()
      local old, new = vim.v.event.old_mode, vim.v.event.new_mode
      if new:match("^ni") then ctrl_o = true elseif not is_ins(new) then ctrl_o = false end
      if is_ins(old) and not is_ins(new) then
        local ok, err = pcall(stop, new)
        if not ok then
          if L then cleanup(L) end
          vim.notify("multicursor live insert: " .. tostring(err), vim.log.levels.DEBUG)
        end
      elseif is_ins(new) and not is_ins(old) then
        if not old:match("^ni") then ctrl_o = false end
        if L and L.active and not L.snap then
          local c = api.nvim_win_get_cursor(0)
          snapshot(L, c[1] - 1, c[2])
          draw(L)
        end
      end
    end,
  })
  api.nvim_create_autocmd({ "TextChangedI", "TextChangedP", "CursorMovedI" }, {
    group = GROUP,
    callback = function()
      if L and L.active then
        local ok, err = pcall(sync)
        if not ok then vim.notify("multicursor live insert: " .. tostring(err), vim.log.levels.DEBUG) end
      end
    end,
  })
  api.nvim_create_autocmd("InsertLeavePre", {
    group = GROUP,
    callback = function()
      if L and L.active then
        local ok, err = pcall(sync)
        L.left_pre = true
        if not ok then vim.notify("multicursor live insert: " .. tostring(err), vim.log.levels.DEBUG) end
      end
    end,
  })
  api.nvim_create_autocmd({ "WinLeave", "BufLeave" }, {
    group = GROUP,
    callback = function()
      if L and L.active then drop() end
    end,
  })
end

-- VS Code (Feel vscode, #123; config/keymap_vscode.lua maps the keys) ----------------------------------------
-- ⌘D with no selection selects the word at each caret (VS Code's word at a position: the caret in it or just
-- after it); with one it adds a selection at the next occurrence after the newest one (wrapping; nothing once
-- every occurrence is selected). Text ⌘D selected as a word matches whole words, case sensitive; text you
-- selected matches anywhere, any case (VS Code's find defaults). From Normal mode the selections are Visual
-- ones (c, d, ... act on each, as VSCodeVim); while typing (Insert mode, Vim mode off) they're Select-mode
-- ones: typing replaces each and goes on at every caret (live insert above). ⌘K ⌘D moves the newest selection
-- to the next occurrence instead (skip it). ⌥click adds a caret, on a caret removes it, typing goes on at all.
-- Esc: one caret again (Vim mode on: Visual / Insert mode ends first, as Vim's Esc).

local word_from ---@type {buf: integer, text: string}? text ⌘D selected as a word

-- Vim mode off (config/vimmode.lua, the Feel's editor.vim false): always typing
local function vim_off()
  local vm = package.loaded["config.vimmode"]
  return vm ~= nil and type(vm.off) == "function" and vm.off() == true
end

-- The word at byte col of line: 0-based start, exclusive end; the caret in it or just after it
---@return integer?, integer?
local function word_at(line, col)
  local from = 0
  while from <= #line do
    local m = vim.fn.matchstrpos(line, [[\k\+]], from)
    local s, e = m[2], m[3]
    if s < 0 or s > col then return end
    if col <= e then return s, e end
    from = e
  end
end

-- The selection's text: vs / ve as the plugin's getVisual gives them ({ row, col } 1-based, ve the cursor's
-- cell: its last character, or the one after with 'selection' exclusive)
local function visual_text(buf, vs, ve)
  local line = get_line(buf, ve[1] - 1)
  local ec = math.min(ve[2] - 1, #line)
  if vim.o.selection ~= "exclusive" and ec < #line then
    ec = ec + 1
    while is_cont(line:byte(ec + 1)) do ec = ec + 1 end
  end
  return table.concat(api.nvim_buf_get_text(buf, vs[1] - 1, vs[2] - 1, ve[1] - 1, ec, {}), "\n")
end

-- A selection of [s, e) on row (1-based) for a cursor, in mode ("v" / "s"), the caret at its end
local function select_range(cur, mode, row, line, s, e)
  local last = vim.o.selection == "exclusive" and e or prev_char(line, e)
  cur:setMode(mode)
  cur:setVisual({ row, s + 1 }, { row, last + 1 })
end

-- Where Esc left each spot { row0, col } of typing (one character left, none at col 0) -> the spot
local function esc_spots(buf, spots)
  local back = {}
  for _, p in ipairs(spots or {}) do
    local col = p[2] > 0 and prev_char(get_line(buf, p[1]), p[2]) or 0
    back[p[1] .. ":" .. col] = p
  end
  return back
end

-- ⌘D with no selection: the word at each caret selected. main_at: the main caret ({ row, col } 1-based, where
-- typing was), spots: the other carets' typing spots (after_typing), typing: Select mode
local function select_words(main_at, typing, spots)
  local buf = api.nvim_get_current_buf()
  local mode = typing and "s" or "v"
  local back = esc_spots(buf, spots)
  mc.action(function(ctx)
    ctx:forEachCursor(function(cur)
      local p = cur:isMainCursor() and main_at or cur:getPos()
      local line = get_line(buf, p[1] - 1)
      local col = p[2] - 1
      -- a caret Esc moved left: the column it typed at
      local spot = not cur:isMainCursor() and back[(p[1] - 1) .. ":" .. col]
      if spot then col = spot[2] end
      local s, e = word_at(line, col)
      if not s then return end
      if cur:isMainCursor() then word_from = { buf = buf, text = line:sub(s + 1, e) } end
      select_range(cur, mode, p[1], line, s, e)
    end)
  end)
end

-- ⌘D / ⌘K ⌘D with a selection: the next occurrence of the newest (main) one, added or instead of it
local function next_occurrence(skip)
  local buf = api.nvim_get_current_buf()
  mc.action(function(ctx)
    local main = ctx:mainCursor()
    local mode, back = main:mode(), main:atVisualStart()
    local vs, ve = main:getVisual()
    local text = visual_text(buf, vs, ve)
    if text == "" then return end
    local whole = word_from ~= nil and word_from.buf == buf and word_from.text == text
    local esc = text:gsub("\\", "\\\\"):gsub("\n", "\\n")
    local pat = whole and ("\\C\\V\\<" .. esc .. "\\>") or ("\\c\\V" .. esc)
    local s, e
    main:perform(function()
      vim.cmd("normal! \27")
      -- from the selection's last character: a match overlapping it isn't the next one
      local line = get_line(buf, ve[1] - 1)
      local last = vim.o.selection == "exclusive" and prev_char(line, ve[2] - 1) or ve[2] - 1
      pcall(api.nvim_win_set_cursor, 0, { ve[1], last })
      local p = vim.fn.searchpos(pat, "w")
      if p[1] == 0 then return end
      local q = vim.fn.searchpos(pat, "cenW")
      if q[1] == 0 then return end
      s, e = p, q
    end)
    local function restore()
      main:setMode(mode)
      if back then main:setVisual(ve, vs) else main:setVisual(vs, ve) end
    end
    if not s then return restore() end
    for _, cur in ipairs(ctx:getCursors()) do
      local cs = (cur == main) and vs or cur:getVisual()
      if (cur == main or cur:hasSelection()) and cs[1] == s[1] and cs[2] == s[2] then return restore() end -- every one selected
    end
    if not skip then
      restore()
      main:clone()
    end
    local eline = get_line(buf, e[1] - 1)
    local ecol = e[2] -- 1-based: the match's last character
    if vim.o.selection == "exclusive" then
      local b = ecol - 1
      local n = b + 1
      while is_cont(eline:byte(n + 1)) do n = n + 1 end
      ecol = n + 1
    end
    main:setMode(mode)
    main:setVisual({ s[1], s[2] }, { e[1], ecol })
  end)
end

-- A key's action on the next tick (the keys map M.soon(name)): the plugin's actions feed keys with "x", which
-- would run the keys typed after this one (⌘D ⌘D ⌘D typed ahead) inside it; the key itself isn't the plugin's to
-- repeat at the other cursors (keys typed in the same instant as ⌘D, ⌘D c X, run before it: fine at typing speed)
---@param name string
function M.soon(name)
  mc = mc or require("multicursor-nvim")
  if im then im:clear() end
  vim.schedule(function() M[name]() end)
end

-- ⌘D (n / x / s)
function M.add_next()
  mc = mc or require("multicursor-nvim")
  local mode = api.nvim_get_mode().mode
  if mode:match("^[vs]") then return next_occurrence(false) end
  if mode:match("^[VS\22\19]") then return mc.matchAddCursor(1) end -- (lines / blocks: the plugin's)
  select_words({ vim.fn.line("."), vim.fn.col(".") }, false)
end

-- ⌘K ⌘D (x / s)
function M.skip_next()
  mc = mc or require("multicursor-nvim")
  local mode = api.nvim_get_mode().mode
  if mode:match("^[vs]") then return next_occurrence(true) end
  if mode:match("^[VS\22\19]") then return mc.matchSkipCursor(1) end
end

-- Insert mode left, then fn() once the carets are where Esc leaves them; at: the main caret's insert spot
-- { row, col } 1-based
local function after_typing(fn)
  local at = { vim.fn.line("."), vim.fn.col(".") }
  -- the other carets' insert spots (Esc moves them left)
  local spots = {}
  if L and L.active then
    for _, c in ipairs(live_carets(L)) do
      local m = mark(L.buf, c.id)
      if m[1] then spots[#spots + 1] = { m[1], m[2] } end
    end
  end
  if im then im:clear() end -- (the key isn't the plugin's to repeat at the other cursors)
  -- the completion menu closed first (left open, leaving Insert mode with several carets hangs in blink)
  local ok, blink = pcall(require, "blink.cmp")
  if ok and blink.is_visible() then blink.hide() end
  vim.cmd.stopinsert()
  vim.schedule(function() fn(at, spots) end)
end

-- ⌘D while typing: the word at each caret, a Select-mode selection
function M.add_next_typing()
  mc = mc or require("multicursor-nvim")
  after_typing(function(at, spots) select_words(at, true, spots) end)
end

-- ⌥click (n / x)
function M.alt_click()
  mc = mc or require("multicursor-nvim")
  mc.handleMouse()
end

-- ⌥click while typing: a caret there too, typing goes on at every caret (each where it typed)
function M.alt_click_typing()
  mc = mc or require("multicursor-nvim")
  after_typing(function(at, spots)
    spots[#spots + 1] = { at[1] - 1, at[2] - 1 }
    local back = esc_spots(api.nvim_get_current_buf(), spots)
    mc.handleMouse()
    mc.action(function(ctx)
      ctx:forEachCursor(function(cur)
        if cur:isMainCursor() then return end
        local p = cur:getPos()
        local spot = back[(p[1] - 1) .. ":" .. (p[2] - 1)]
        if spot then cur:setPos({ spot[1] + 1, spot[2] + 1 }) end
      end)
    end)
    vim.cmd.startinsert()
  end)
end

-- Typing again at { row, col } (1-based; a column past the line's end too): set once Insert mode is on, where
-- such a column is allowed (whatever else asked for Insert mode meanwhile: config/vimmode.lua does too)
local function type_at(at)
  local id = api.nvim_create_autocmd("ModeChanged", {
    pattern = "*:i",
    once = true,
    callback = function()
      pcall(api.nvim_win_set_cursor, 0, { at[1], math.min(at[2] - 1, #api.nvim_get_current_line()) })
    end,
  })
  vim.cmd.startinsert()
  -- (Insert mode didn't come: not on some later one)
  vim.defer_fn(function() pcall(api.nvim_del_autocmd, id) end, 500)
end

-- Esc with several carets (an expr map; Vim mode on: Vim's Esc), Vim mode off: one caret, still typing where the main caret types (or
-- at the end of its selection)
local function esc_one()
  -- (the plugin repeating the key at the other cursors: just Esc there)
  if not vim_off() or im._applying or require("multicursor-nvim.core").performingAction then return "<Esc>" end
  -- a completion menu or a Copilot suggestion closes first (config/vimmode.lua's Esc)
  local ok, blink = pcall(require, "blink.cmp")
  if ok and blink.is_visible() then
    vim.schedule(blink.hide)
    return ""
  end
  local sok, sug = pcall(require, "copilot.suggestion")
  if sok and sug.is_visible() then
    vim.schedule(sug.dismiss)
    return ""
  end
  local at = { vim.fn.line("."), vim.fn.col(".") }
  vim.schedule(function()
    mc.clearCursors()
    type_at(at)
  end)
  return "<Esc>"
end

-- Carets ---------------------------------------------------------------------------------------------------

-- Several carets now (cheap: every redraw asks)
function M.several()
  return (L ~= nil) or (mc ~= nil and mc.hasCursors() and mc.cursorsEnabled())
end

-- The other carets in buf, { row0, col } each (the main caret is nvim's): while typing the live carets, else
-- the plugin's enabled cursors (where it draws them)
---@param buf integer
---@return integer[][]
function M.carets(buf)
  if L and L.buf == buf then
    local out = {}
    for _, c in ipairs(live_carets(L)) do
      local p = c.final or mark(L.buf, c.id)
      if p[1] then out[#out + 1] = { p[1], p[2] } end
    end
    return out
  end
  if not (mc and mc.hasCursors() and mc.cursorsEnabled()) then return {} end
  local ns = api.nvim_get_namespaces()["multicursor-nvim"]
  if not ns then return {} end
  local out = {}
  for _, m in ipairs(api.nvim_buf_get_extmarks(buf, ns, 0, -1, { details = true })) do
    if m[4].hl_group == "MultiCursorCursor" then out[#out + 1] = { m[2], m[3] } end
  end
  return out
end

function M.setup()
  mc = require("multicursor-nvim")
  mc.setup()
  live_setup()
  if vim.g.vimstorm_app then require("config.app.carets").setup() end
  -- a word ⌘D selected is one only until the selection is gone (one caret, out of Visual / Select mode) or you
  -- start one of your own
  local function sel(m) return m:match("^[vVsS\22\19]") ~= nil end
  api.nvim_create_autocmd("ModeChanged", {
    group = GROUP,
    callback = function()
      if not word_from or require("multicursor-nvim.core").performingAction then return end
      local old, new = vim.v.event.old_mode, vim.v.event.new_mode
      if (sel(new) and not sel(old)) or (not sel(new) and not mc.hasCursors()) then word_from = nil end
    end,
  })
  local set = vim.keymap.set

  set({ "n", "x" }, "<C-ö>", function() M.clone(1) end, { desc = "Clone caret below" })
  set({ "n", "x" }, "<C-l>", function() M.clone(-1) end, { desc = "Clone caret above" })
  -- While typing: leave insert mode first (the other carets go where Esc leaves them), then add the
  -- cursor and type on at the same spot
  local function insert_clone(dir)
    return function()
      local col = api.nvim_win_get_cursor(0)[2]
      vim.schedule(function()
        M.clone(dir)
        api.nvim_feedkeys(col == 0 and "i" or "a", "nt", false)
      end)
      return "<Esc>"
    end
  end
  set("i", "<C-ö>", insert_clone(1), { expr = true, desc = "Clone caret below" })
  set("i", "<C-l>", insert_clone(-1), { expr = true, desc = "Clone caret above" })
  set({ "n", "x" }, "<C-n>", function() mc.matchAddCursor(1) end, { desc = "Add next occurrence" })
  set({ "n", "x" }, "<C-x>", function() mc.matchSkipCursor(1) end, { desc = "Skip occurrence" })

  -- Only while there are several cursors
  mc.addKeymapLayer(function(layer)
    layer("n", "ö", function() mc.lineSkipCursor(1, { skipEmpty = false }) end)
    layer("n", "l", function() mc.lineSkipCursor(-1, { skipEmpty = false }) end)
    layer({ "n", "x" }, "<C-p>", mc.deleteCursor)
    -- I / A on selections: a caret at the start / end of each selected line, typing on all of them
    layer("x", "I", mc.insertVisual)
    layer("x", "A", mc.appendVisual)
    -- Vim mode off (Feel vscode / webstorm): Esc is one caret again, typing on
    if vim_off() then layer({ "i", "s" }, "<Esc>", esc_one, { expr = true }) end
    layer("n", "<Esc>", function()
      if not mc.cursorsEnabled() then
        mc.enableCursors()
      else
        mc.clearCursors()
      end
    end)
  end)
end

return M
