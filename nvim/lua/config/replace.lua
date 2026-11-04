-- Replace in file (WebStorm's Cmd+R): the engine of the app's native replace bar (app/src/editor/replace, drawn at the
-- top right of the split; bridge config/app/replace.lua). The bar owns its two fields and the keys; this keeps
-- the state: the search text and the replacement it was last told, Match Case / Regex, the matches in the file
-- (highlighted live, the current one selected and scrolled into view) and the count ("3/12", "0 results",
-- "Bad pattern"). Next / previous match, Replace (the current match, then the next one) and Replace All (one
-- undo step). Closing leaves the caret on the current match and `n` / `N` keep searching for it. Opens with
-- the selection (one line), else the word at the caret; keys typed right after Cmd+R are held for the bar
-- (config/app/typeahead.lua), never run in the file.
local app = require("config.app.replace")
local typeahead = require("config.app.typeahead")

local M = {}

local NS = vim.api.nvim_create_namespace("ws_replace") -- matches in the file
local MAX = 10000 -- matches counted

---@class ReplaceState
---@field id integer the bar the app draws for it
---@field target_win integer
---@field target integer the file's buffer
---@field find string the search text
---@field rep string the replacement
---@field origin integer[] where "next" counts from: 1-based row, 0-based col
---@field matches integer[][] { 0-based row, start col, end col }
---@field cur integer index of the current match (0: none)
---@field case boolean
---@field regex boolean
---@field bad? boolean regex doesn't compile
---@field query? string search text the matches are for
local S = nil ---@type ReplaceState?
local last_id = 0

-- Vim pattern of the search text: case-insensitive unless "Cc", literal unless ".*"
---@return string?
local function pattern(s)
  local q = s.find
  if q == "" then return end
  return (s.case and "\\C" or "\\c") .. (s.regex and ("\\v" .. q) or ("\\V" .. q:gsub("\\", "\\\\")))
end

local function find_all(s)
  s.matches, s.bad = {}, false
  local pat = pattern(s)
  if not pat or not vim.api.nvim_buf_is_valid(s.target) then return end
  local ok, re = pcall(vim.regex, pat)
  if not ok then
    s.bad = true
    return
  end
  local lines = vim.api.nvim_buf_get_lines(s.target, 0, -1, false)
  for row, line in ipairs(lines) do
    local col = 0
    while col <= #line do
      local ms, me = re:match_line(s.target, row - 1, col)
      if not ms then break end
      ms, me = ms + col, me + col
      if me > ms then
        s.matches[#s.matches + 1] = { row - 1, ms, me }
        if #s.matches >= MAX then return end
        col = me
      else
        col = ms + 1 -- empty match (`x*`): skip it
      end
    end
  end
end

-- First match at / after origin (wrapping around)
local function pick(s)
  s.cur = 0
  local r, c = s.origin[1] - 1, s.origin[2]
  for i, m in ipairs(s.matches) do
    if m[1] > r or (m[1] == r and m[2] >= c) then
      s.cur = i
      return
    end
  end
  if #s.matches > 0 then s.cur = 1 end
end

-- The count as the bar shows it and whether it reads as "nothing found" (red)
---@return string, boolean
local function count_text(s)
  if s.find == "" then return "", false end
  if s.bad then return "Bad pattern", true end
  if #s.matches == 0 then return "0 results", true end
  return ("%d/%d%s"):format(s.cur, #s.matches, #s.matches >= MAX and "+" or ""), false
end

-- What the bar draws
local function payload(s)
  local count, none = count_text(s)
  return {
    id = s.id, win = s.target_win, find = s.find, replace = s.rep, case = s.case, regex = s.regex,
    count = count, none = none, current = s.cur > 0, total = #s.matches,
  }
end

-- Matches in the file: all green, the current one selected
local function render_matches(s)
  if not vim.api.nvim_buf_is_valid(s.target) then return end
  vim.api.nvim_buf_clear_namespace(s.target, NS, 0, -1)
  for i, m in ipairs(s.matches) do
    vim.api.nvim_buf_set_extmark(s.target, NS, m[1], m[2], {
      end_col = m[3], hl_group = i == s.cur and "WsReplaceCurrent" or "WsReplaceMatch", priority = 300,
    })
  end
end

-- Caret of the file on the current match, scrolled into view (centered when it was off screen)
local function reveal(s)
  local m = s.matches[s.cur]
  if not (m and vim.api.nvim_win_is_valid(s.target_win)) then return end
  vim.api.nvim_win_call(s.target_win, function()
    local top, bot = vim.fn.line("w0"), vim.fn.line("w$")
    vim.api.nvim_win_set_cursor(0, { m[1] + 1, m[2] })
    if m[1] + 1 < top or m[1] + 1 > bot then vim.cmd("normal! zz") end
  end)
end

local function refresh(s)
  if s.find ~= s.query then
    s.query = s.find
    find_all(s)
    pick(s)
    reveal(s)
  end
  render_matches(s)
  app.state(payload(s))
end

local function redo_matches(s)
  s.query = nil
  refresh(s)
end

-- Next / previous match
local function step(s, dir)
  if #s.matches == 0 then return end
  s.cur = (s.cur - 1 + dir) % #s.matches + 1
  local m = s.matches[s.cur]
  s.origin = { m[1] + 1, m[2] }
  render_matches(s)
  app.state(payload(s))
  reveal(s)
end

-- A change of the file starts its own undo step
local function undo_break(buf)
  vim.api.nvim_buf_call(buf, function() vim.cmd("let &l:undolevels = &l:undolevels") end)
end

-- Replacement for a match: literal, or with regex groups ($1 like WebStorm, also \1)
local function replacement(s, text)
  local rep = s.rep
  if not s.regex then return rep end
  rep = rep:gsub("[&~]", "\\%0"):gsub("%$(%d)", "\\%1")
  return vim.fn.substitute(text, pattern(s), rep, "")
end

local function editable(s)
  if vim.bo[s.target].modifiable and not vim.bo[s.target].readonly then return true end
  vim.notify("File is read-only", vim.log.levels.WARN)
  return false
end

-- The bar `id`'s state, if it's still the open one
---@return ReplaceState?
local function bar(id)
  if S and S.id == id then return S end
end

-- Replace the current match, go to the next one
function M.replace()
  local s = S
  local m = s and s.matches[s.cur]
  if not (s and m and editable(s)) then return end
  local text = vim.api.nvim_buf_get_text(s.target, m[1], m[2], m[1], m[3], {})[1]
  local new = replacement(s, text)
  undo_break(s.target)
  vim.api.nvim_buf_set_text(s.target, m[1], m[2], m[1], m[3], vim.split(new, "\n", { plain = true }))
  s.origin = { m[1] + 1, m[2] + #new }
  redo_matches(s)
end

-- Replace all matches, one undo step
function M.replace_all()
  local s = S
  if not (s and #s.matches > 0 and editable(s)) then return end
  local n = #s.matches
  undo_break(s.target)
  for i = n, 1, -1 do
    local m = s.matches[i]
    local text = vim.api.nvim_buf_get_text(s.target, m[1], m[2], m[1], m[3], {})[1]
    vim.api.nvim_buf_set_text(s.target, m[1], m[2], m[1], m[3], vim.split(replacement(s, text), "\n", { plain = true }))
  end
  redo_matches(s)
  vim.notify(("%d occurrence%s replaced"):format(n, n == 1 and "" or "s"), vim.log.levels.INFO)
end

-- The bar closed: highlights gone, `n` / `N` go on from here (without highlighting all of them); `inside`
-- (Esc, ×): the caret on the current match in the file (a click elsewhere leaves it where it went)
---@param inside? boolean
local function close(s, inside)
  if S ~= s then return end
  S = nil
  typeahead.stop("replace")
  local pat = pattern(s)
  local m = s.matches[s.cur]
  if vim.api.nvim_buf_is_valid(s.target) then vim.api.nvim_buf_clear_namespace(s.target, NS, 0, -1) end
  if inside and m and vim.api.nvim_win_is_valid(s.target_win) then
    pcall(vim.api.nvim_win_set_cursor, s.target_win, { m[1] + 1, m[2] })
  end
  if pat and not s.bad then
    vim.fn.setreg("/", pat)
    vim.v.hlsearch = 0
  end
  app.hide(s.id)
end

-- Rust -> Lua (through config/app/replace.lua) ------------------------------------------------------------------

-- The fields as typed
---@param id integer
---@param find string
---@param rep string
function M.fields(id, find, rep)
  local s = bar(id)
  if not s then return end
  s.find, s.rep = find, rep
  refresh(s)
end

---@param id integer
---@param name "case"|"regex"
function M.toggle(id, name)
  local s = bar(id)
  if not s or (name ~= "case" and name ~= "regex") then return end
  s[name] = not s[name]
  redo_matches(s)
end

---@param id integer
---@param dir integer 1 next, -1 previous
function M.step(id, dir)
  local s = bar(id)
  if s then step(s, dir) end
end

---@param id integer
function M.replace_in(id)
  if bar(id) then M.replace() end
end

---@param id integer
function M.replace_all_in(id)
  if bar(id) then M.replace_all() end
end

---@param id integer
---@param inside boolean
function M.close(id, inside)
  local s = bar(id)
  if s then close(s, inside) end
end

-- Cmd+F in the bar: closed, Neovim's search instead
---@param id integer
function M.find(id)
  local s = bar(id)
  if not s then return end
  close(s, true)
  vim.api.nvim_feedkeys("/", "n", false)
end

-- Cmd+R (the editor's context menu: Replace…)
function M.open()
  if S then return app.focus(S.id) end
  local mode = vim.api.nvim_get_mode().mode
  local target_win = vim.api.nvim_get_current_win()
  local target = vim.api.nvim_get_current_buf()
  if not require("config.focus").is_split(target_win, true) then return end
  local cur = vim.api.nvim_win_get_cursor(target_win)
  -- the selection (one line), else the word at the caret
  local text = ""
  if mode:match("^[vV\22]") then
    local a, b = vim.fn.getpos("v"), vim.fn.getpos(".")
    if a[2] == b[2] then
      local s, e = math.min(a[3], b[3]), math.max(a[3], b[3])
      text = vim.api.nvim_get_current_line():sub(s, e)
      if mode == "V" then text = "" end
      cur = { a[2], s - 1 }
    end
    vim.cmd("normal! \27")
  else
    text = vim.fn.expand("<cword>")
    local line = vim.api.nvim_get_current_line()
    -- the word's start, so the first match is this word
    local s = cur[2]
    while s > 0 and line:sub(s, s):match("[%w_$]") do s = s - 1 end
    if text ~= "" and line:sub(s + 1, s + #text) == text then cur = { cur[1], s } end
  end
  last_id = last_id + 1
  local s = {
    id = last_id, target_win = target_win, target = target, find = text, rep = "", origin = cur, matches = {},
    cur = 0, case = false, regex = false,
  }
  S = s
  -- keys typed right after Cmd+R wait for the bar's fields
  typeahead.hold("replace")
  s.query = s.find
  find_all(s)
  pick(s)
  reveal(s)
  render_matches(s)
  -- the bar has the keyboard now (WebStorm has no modes): the file back in normal mode, its caret kept
  if mode:match("^[iR]") then
    local keep = vim.api.nvim_win_get_cursor(target_win)
    vim.cmd.stopinsert()
    vim.schedule(function()
      if vim.api.nvim_win_is_valid(target_win) then pcall(vim.api.nvim_win_set_cursor, target_win, keep) end
    end)
  end
  if not app.show(payload(s)) then
    -- no app to draw it (plain nvim)
    S = nil
    typeahead.stop("replace")
    vim.api.nvim_buf_clear_namespace(target, NS, 0, -1)
  end
end

-- The file's window closed or its buffer left it: the bar goes too
vim.api.nvim_create_autocmd({ "WinClosed", "BufWinLeave" }, {
  group = vim.api.nvim_create_augroup("ws_replace", { clear = true }),
  callback = function(ev)
    local s = S
    if not s then return end
    if (ev.event == "WinClosed" and tonumber(ev.match) == s.target_win) or (ev.event == "BufWinLeave" and ev.buf == s.target) then
      close(s, false)
    end
  end,
})

function M.is_open() return S ~= nil end

-- Test hook
function M.state()
  local s = S
  if not s then return end
  return {
    id = s.id, find = s.find, replace = s.rep, count = (count_text(s)), cur = s.cur, matches = #s.matches,
    case = s.case, regex = s.regex,
  }
end

return M
