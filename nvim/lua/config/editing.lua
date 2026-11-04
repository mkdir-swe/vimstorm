-- Editing actions that work like WebStorm's (keys in config/webstorm.lua):
-- * Extend / Shrink Selection (Cmd+W / Cmd+Shift+W): word, then each bigger syntax node; brackets,
--   quotes, blocks and tags first select what's inside them, then themselves (WebStorm's "contents" step).
--   Shrink walks back the same steps.
-- * Duplicate (Cmd+D): the line (caret stays in its column on the copy), or the selection right after
--   itself with the copy selected.
-- * Cmd+C / Cmd+X without a selection copy / cut the whole line; Cmd+V of such a line inserts it above
--   the caret's line (caret stays where it is in the text). Cmd+V over a selection keeps the clipboard.
-- Also sets up folding (config/fold.lua) and the `.log` postfix template (config/postfix.lua); Quick
-- Definition is config/peek.lua, Replace in file config/replace.lua.
local M = {}

---@alias EditRange {[1]: integer, [2]: integer, [3]: integer, [4]: integer} 0-based start row, col, end row, col (end exclusive)

local function getline(buf, row) return vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or "" end

-- A range ending at the start of a line (node that ends with its newline) ends at the line before instead,
-- so node ranges and selections compare the same.
---@param r EditRange
---@return EditRange
local function norm(buf, r)
  if r[4] == 0 and r[3] > r[1] then return { r[1], r[2], r[3] - 1, #getline(buf, r[3] - 1) } end
  return r
end

local function before_eq(ar, ac, br, bc) return ar < br or (ar == br and ac <= bc) end

-- a contains b and is bigger
---@param a EditRange
---@param b EditRange
local function larger(a, b)
  return before_eq(a[1], a[2], b[1], b[2]) and before_eq(b[3], b[4], a[3], a[4])
    and not (a[1] == b[1] and a[2] == b[2] and a[3] == b[3] and a[4] == b[4])
end

local function key(buf, r) return buf .. ":" .. table.concat(r, ",") end

-- Without the whitespace at both ends; nil when nothing is left
---@param r EditRange
---@return EditRange?
local function trim(buf, r)
  local sr, sc, er, ec = r[1], r[2], r[3], r[4]
  while true do
    local s = getline(buf, sr):find("%S", sc + 1)
    if s and (sr < er or s - 1 < ec) then
      sc = s - 1
      break
    end
    if sr >= er then return nil end
    sr, sc = sr + 1, 0
  end
  while true do
    local e = getline(buf, er):sub(1, ec):find("%S%s*$")
    if e and (er > sr or e > sc) then
      ec = e
      break
    end
    if er <= sr then return nil end
    er = er - 1
    ec = #getline(buf, er)
  end
  return { sr, sc, er, ec }
end

-- Opening token -> closing token of the nodes whose contents are a selection step of their own
local PAIRS = { ["("] = ")", ["["] = "]", ["{"] = "}", ["<"] = ">", ["'"] = "'", ['"'] = '"', ["`"] = "`", ["${"] = "}" }

-- What's between the brackets / quotes / tags of node, trimmed
---@param node TSNode
---@return EditRange?
local function contents(buf, node)
  local n = node:child_count()
  if n < 2 then return end
  local first, last = node:child(0), node:child(n - 1)
  if not first or not last then return end
  local t = node:type()
  local paired = (t == "jsx_element" and first:type() == "jsx_opening_element" and last:type() == "jsx_closing_element")
    or (not t:match("^jsx_") or t == "jsx_expression") and PAIRS[first:type()] == last:type()
  if not paired then return end
  local _, _, sr, sc = first:range()
  local er, ec = last:range()
  if sr > er or (sr == er and sc >= ec) then return end
  return trim(buf, { sr, sc, er, ec })
end

-- The next bigger selection step around r (treesitter); nil when there is none
---@param r EditRange
---@return EditRange|false|nil false: no parser
function M.grow(buf, r)
  local ok, parser = pcall(vim.treesitter.get_parser, buf, nil, { error = false })
  if not ok or not parser then return false end
  parser:parse({ r[1], r[3] + 1 })
  local ltree = parser:language_for_range({ r[1], r[2], r[3], r[4] }) ---@type vim.treesitter.LanguageTree?
  while ltree do
    local node = ltree:named_node_for_range({ r[1], r[2], r[3], r[4] }, { ignore_injections = true })
    while node do
      local inner = contents(buf, node)
      if inner and larger(inner, r) then return inner end
      local whole = norm(buf, { node:range() })
      if larger(whole, r) then return whole end
      node = node:parent()
    end
    ltree = ltree:parent()
  end
end

-- No parser (plain text): line, paragraph, whole file
---@param r EditRange
---@return EditRange?
local function grow_text(buf, r)
  local n = vim.api.nvim_buf_line_count(buf)
  local function blank(row) return not getline(buf, row):find("%S") end
  local ps, pe = r[1], r[3]
  while ps > 0 and not blank(ps - 1) do ps = ps - 1 end
  while pe < n - 1 and not blank(pe + 1) do pe = pe + 1 end
  local steps = {
    trim(buf, { r[1], 0, r[3], #getline(buf, r[3]) }),
    { ps, 0, pe, #getline(buf, pe) },
    { 0, 0, n - 1, #getline(buf, n - 1) },
  }
  for _, s in ipairs(steps) do
    if larger(s, r) then return s end
  end
end

-- Current visual selection as a range (charwise end made exclusive; linewise = whole lines)
---@return EditRange
local function selection(buf)
  local v, c = vim.fn.getpos("v"), vim.fn.getpos(".")
  local s, e = { v[2] - 1, v[3] - 1 }, { c[2] - 1, c[3] - 1 }
  if s[1] > e[1] or (s[1] == e[1] and s[2] > e[2]) then s, e = e, s end
  local last = getline(buf, e[1])
  if vim.fn.mode() == "V" then
    return { s[1], 0, e[1], #last }
  end
  local ec = e[2] < #last and e[2] + vim.str_utf_end(last, e[2] + 1) + 1 or #last
  return { s[1], math.min(s[2], #getline(buf, s[1])), e[1], ec }
end

-- Select r charwise (or linewise), caret at the end like WebStorm. The view never jumps: when the end
-- is off screen but the start isn't, the caret goes to the start instead.
---@param r EditRange
---@param linewise? boolean
local function select(buf, r, linewise)
  local topline, top, bot, last_line = vim.fn.winsaveview().topline, vim.fn.line("w0"), vim.fn.line("w$"), vim.fn.line("$")
  local so = vim.api.nvim_get_option_value("scrolloff", { win = 0 })
  local function visible(lnum)
    return (lnum >= top + so or top == 1) and (lnum <= bot - so or bot == last_line)
  end
  local er, ec = r[3], r[4] - 1
  if ec < 0 and er > r[1] then
    er = er - 1
    ec = #getline(buf, er) - 1
  end
  local last = getline(buf, er)
  ec = math.max(ec, 0)
  if ec < #last then ec = ec + vim.str_utf_start(last, ec + 1) end
  local mode = vim.fn.mode()
  if mode == "v" or mode == "V" or mode == "\22" then vim.cmd("normal! \27") end
  vim.api.nvim_win_set_cursor(0, { r[1] + 1, r[2] })
  vim.cmd("normal! " .. (linewise and "V" or "v"))
  vim.api.nvim_win_set_cursor(0, { er + 1, ec })
  if not visible(er + 1) and visible(r[1] + 1) then
    vim.cmd("normal! o")
    vim.fn.winrestview({ topline = topline })
  end
end

-- Shrink history: selection -> the one it grew from (or, for the first step, the caret it started at), per
-- buffer, forgotten when the text changes
local history = {} ---@type table<integer, {tick: integer, prev: table<string, EditRange|{caret: integer[]}>}>

local function hist(buf)
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  local h = history[buf]
  if not h or h.tick ~= tick then
    h = { tick = tick, prev = {} }
    history[buf] = h
  end
  return h
end

local function is_word(ch) return ch ~= "" and vim.fn.match(ch, [[\k]]) == 0 end

-- Cmd+W from normal / insert mode: the word at (row, col), else the word ending there, else the
-- smallest syntax node there
---@param row integer 1-based
---@param col integer 0-based byte
function M.select_word(row, col)
  local buf = vim.api.nvim_get_current_buf()
  local line = getline(buf, row - 1)
  ---@return string char, integer? start byte
  local function char_at(c)
    if c < 0 or c >= #line then return "", nil end
    local s = c + vim.str_utf_start(line, c + 1)
    return line:sub(s + 1, s + 1 + vim.str_utf_end(line, s + 1)), s
  end
  local ch = char_at(col)
  if not is_word(ch) then
    local prev, at = char_at(col - 1)
    if is_word(prev) and at then
      col, ch = at, prev
    end
  end
  local caret = { row, math.max(math.min(col, #line - 1), 0) }
  vim.api.nvim_win_set_cursor(0, caret)
  if is_word(ch) then
    vim.cmd("normal! viw")
  else
    -- no word: grow from the character under the caret
    local c = caret[2]
    local grown = M.grow(buf, { row - 1, c, row - 1, math.min(c + 1, #line) })
    if grown then
      select(buf, grown)
    else
      vim.cmd("normal! v")
    end
  end
  hist(buf).prev[key(buf, selection(buf))] = { caret = caret } -- Cmd+Shift+W from here: just the caret
end

-- Cmd+W
function M.expand()
  local mode = vim.fn.mode()
  if mode ~= "v" and mode ~= "V" and mode ~= "\22" then
    local cur = vim.api.nvim_win_get_cursor(0)
    return M.select_word(cur[1], cur[2])
  end
  local buf = vim.api.nvim_get_current_buf()
  local r = selection(buf)
  local grown = M.grow(buf, r)
  if grown == false then
    if #vim.lsp.get_clients({ bufnr = buf, method = "textDocument/selectionRange" }) > 0 then
      return vim.lsp.buf.selection_range(1)
    end
    grown = grow_text(buf, r)
  end
  if not grown then return end
  hist(buf).prev[key(buf, grown)] = r
  select(buf, grown)
end

-- Cmd+Shift+W: back to the selection Cmd+W grew from; else the built-in child-node step
function M.shrink()
  local mode = vim.fn.mode()
  if mode ~= "v" and mode ~= "V" and mode ~= "\22" then return end
  local buf = vim.api.nvim_get_current_buf()
  local r = selection(buf)
  local prev = hist(buf).prev[key(buf, r)]
  if prev and prev.caret then
    vim.cmd("normal! \27")
    return vim.api.nvim_win_set_cursor(0, prev.caret)
  end
  if prev then return select(buf, prev --[[@as EditRange]]) end
  local ok, parser = pcall(vim.treesitter.get_parser, buf, nil, { error = false })
  if ok and parser then
    -- the built-in child-node step, only when it really shrinks (on a single name it grows again); else, like
    -- WebStorm at the end of its steps, back to the caret
    vim.cmd("normal in")
    local now = vim.fn.mode():match("^[vV\22]") and selection(buf)
    if now and larger(r, now) then return end
    if now then vim.cmd("normal! \27") end
    return
  end
  if #vim.lsp.get_clients({ bufnr = buf, method = "textDocument/selectionRange" }) > 0 then
    vim.lsp.buf.selection_range(-1)
  end
end

-- Cmd+D
function M.duplicate()
  local buf = vim.api.nvim_get_current_buf()
  local mode = vim.fn.mode()
  if mode == "v" then
    local r = selection(buf)
    local text = vim.api.nvim_buf_get_text(buf, r[1], r[2], r[3], r[4], {})
    vim.cmd("normal! \27")
    vim.api.nvim_buf_set_text(buf, r[3], r[4], r[3], r[4], text)
    local er = r[3] + #text - 1
    local ec = (#text == 1 and r[4] or 0) + #text[#text]
    return select(buf, { r[3], r[4], er, ec })
  end
  if mode == "V" or mode == "\22" then
    local s, e = vim.fn.line("v"), vim.fn.line(".")
    if s > e then s, e = e, s end
    local lines = vim.api.nvim_buf_get_lines(buf, s - 1, e, false)
    vim.cmd("normal! \27")
    vim.api.nvim_buf_set_lines(buf, e, e, false, lines)
    return select(buf, { e, 0, e + #lines - 1, #lines[#lines] }, true)
  end
  local row, col = unpack(vim.api.nvim_win_get_cursor(0))
  -- a collapsed region: all of it, right after it; the caret goes to the copy's first line
  local first, last = vim.fn.foldclosed(row), vim.fn.foldclosedend(row)
  if first ~= -1 then
    vim.api.nvim_buf_set_lines(buf, last, last, false, vim.api.nvim_buf_get_lines(buf, first - 1, last, false))
    return vim.api.nvim_win_set_cursor(0, { last + 1, math.min(col, #getline(buf, last)) })
  end
  vim.api.nvim_buf_set_lines(buf, row, row, false, { getline(buf, row - 1) })
  vim.api.nvim_win_set_cursor(0, { row + 1, col })
end

-- Comments (Cmd+/) -------------------------------------------------------------------------------------
-- Neovim's gc toggles the lines; the caret (and a selection) stays on its text like WebStorm's, typing goes on

-- Column `col` of a line after its comment was toggled (`before` -> `after`): text after the indent moved
-- by the marker's width, a spot inside a removed marker goes to where the text now starts
local function shifted(before, after, col)
  local ind = #before:match("^%s*")
  if col < ind then return col end
  return math.max(col + #after - #before, math.min(ind, #after))
end

---@param first integer 1-based
---@param last integer
---@param ref integer[] caret (its language picks the comment style: JSX gets {/* */})
---@return string[] before, string[] after
local function toggle(first, last, ref)
  local before = vim.api.nvim_buf_get_lines(0, first - 1, last, false)
  require("vim._comment").toggle_lines(first, last, ref)
  return before, vim.api.nvim_buf_get_lines(0, first - 1, last, false)
end

-- Cmd+/ without a selection: the caret's line (a collapsed region: all of it)
function M.comment_line()
  local row, col = unpack(vim.api.nvim_win_get_cursor(0))
  local first, last = vim.fn.foldclosed(row), vim.fn.foldclosedend(row)
  if first == -1 then first, last = row, row end
  local before, after = toggle(first, last, { row, col })
  local i = row - first + 1
  pcall(vim.api.nvim_win_set_cursor, 0, { row, shifted(before[i], after[i], col) })
end

-- Cmd+/ on a selection: its lines; the same text stays selected (a second Cmd+/ uncomments them)
function M.comment_selection()
  local mode = vim.fn.mode()
  local v, c = vim.fn.getpos("v"), vim.api.nvim_win_get_cursor(0)
  local vs = { v[2], v[3] - 1 }
  local first, last = math.min(vs[1], c[1]), math.max(vs[1], c[1])
  local before, after = toggle(first, last, c)
  local function moved(p)
    local i = p[1] - first + 1
    return { p[1], shifted(before[i], after[i], p[2]) }
  end
  vs, c = moved(vs), moved(c)
  vim.cmd("normal! \27")
  vim.api.nvim_win_set_cursor(0, vs)
  vim.cmd("normal! " .. mode)
  vim.api.nvim_win_set_cursor(0, c)
end

-- Whole-line copies: the text of the last Cmd+C / Cmd+X (or yy / dd) without a selection
local line_copy ---@type string?

vim.api.nvim_create_autocmd("TextYankPost", {
  group = vim.api.nvim_create_augroup("ws_line_copy", { clear = true }),
  callback = function()
    local ev = vim.v.event
    local to_clip = ev.regname == "+" or (ev.regname == "" and vim.o.clipboard:find("unnamedplus", 1, true) ~= nil)
    if not to_clip then return end
    line_copy = (ev.regtype == "V" and not ev.visual) and table.concat(ev.regcontents --[[@as string[] ]], "\n") .. "\n" or nil
  end,
})

-- Typing over a Select-mode selection (a field's preselected text, a snippet placeholder) deletes it into the
-- unnamed register, i.e. the clipboard: no clipboard while in Select mode
local select_clipboard ---@type string?
local select_group = vim.api.nvim_create_augroup("ws_select_clipboard", { clear = true })
vim.api.nvim_create_autocmd("ModeChanged", {
  group = select_group,
  pattern = "*:[sS\19]",
  callback = function()
    if vim.o.clipboard == "" then return end
    select_clipboard, vim.o.clipboard = vim.o.clipboard, ""
  end,
})
vim.api.nvim_create_autocmd("ModeChanged", {
  group = select_group,
  pattern = "[sS\19]:*",
  callback = function()
    if not select_clipboard or vim.fn.mode():match("^[sS\19]") then return end
    vim.o.clipboard, select_clipboard = select_clipboard, nil
  end,
})

-- Text fields (the snacks fallback pickers' query): Cmd+C / Cmd+X take their text as text, never as a whole line
-- (Rename / Move, the native pickers, terminal Find and Replace are the app's own fields)
local FIELDS = { snacks_picker_input = true }
function M.in_field() return vim.bo.buftype == "prompt" or FIELDS[vim.bo.filetype] == true end

-- Cmd+C on a selection in Visual or Select mode, which stays selected. opts.skip: lines left out (hidden
-- in the popup)
---@param opts? {skip?: fun(lnum: integer): boolean}
function M.copy(opts)
  local mode = vim.fn.mode()
  local vtype = ({ s = "v", S = "V", ["\19"] = "\22" })[mode] or mode
  if not vtype:match("^[vV\22]$") then return end
  local p1, p2 = vim.fn.getpos("v"), vim.fn.getpos(".")
  local lines = vim.fn.getregion(p1, p2, { type = vtype })
  if opts and opts.skip then
    local pos = vim.fn.getregionpos(p1, p2, { type = vtype })
    local kept = {}
    for i, l in ipairs(lines) do
      if not opts.skip(pos[i][1][2]) then kept[#kept + 1] = l end
    end
    lines = kept
  end
  if M.in_field() then vtype = "v" end
  vim.fn.setreg("+", lines, vtype == "\22" and "b" or vtype)
end

-- Cmd+C / Cmd+X in a text field without a selection: its text
---@param cut? boolean
function M.copy_field(cut)
  local line = vim.api.nvim_get_current_line()
  vim.fn.setreg("+", { line }, "v")
  if cut then
    local row = vim.api.nvim_win_get_cursor(0)[1]
    vim.api.nvim_buf_set_text(0, row - 1, 0, row - 1, #line, {})
  end
end

local function hook_paste()
  local paste = vim.paste
  ---@diagnostic disable-next-line: duplicate-set-field
  vim.paste = function(lines, phase)
    local mode = vim.api.nvim_get_mode().mode
    local editable = vim.bo.buftype == "" and vim.bo.modifiable and vim.fn.getcmdtype() == ""
    if phase == -1 and line_copy and editable and (mode == "n" or mode:match("^i")) and #lines > 1
      and table.concat(lines, "\n"):gsub("\r\n?", "\n") == line_copy then
      local row, col = unpack(vim.api.nvim_win_get_cursor(0))
      local new = vim.list_slice(lines, 1, #lines - 1)
      vim.api.nvim_buf_set_lines(0, row - 1, row - 1, false, new)
      vim.api.nvim_win_set_cursor(0, { row + #new, col })
      return true
    end
    -- over a selection: the replaced text must not end up in the clipboard (the built-in paste deletes
    -- it into the unnamed register, which is the clipboard here)
    if phase < 2 and mode:match("^[vV\22sS\19]") and vim.o.clipboard ~= "" then -- (Select mode: none, above)
      local cb = vim.o.clipboard
      vim.o.clipboard = ""
      local ok, res = pcall(paste, lines, phase)
      vim.o.clipboard = cb
      if not ok then error(res) end
      return res
    end
    return paste(lines, phase)
  end
end

-- The hover / error popup of this buffer (gh, ,e, mouse tooltip), if open
--- Returns whether it closed one.
function M.close_popup()
  local closed = require("config.app.floats").close_hover() == true -- the app's native popup
  local win = vim.b.lsp_floating_preview
  if type(win) == "number" and vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_get_config(win).relative ~= "" then
    closed = pcall(vim.api.nvim_win_close, win, true) or closed
  end
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do -- the change marker's popup (gitsigns preview)
    if vim.w[w].gitsigns_preview then closed = pcall(vim.api.nvim_win_close, w, true) or closed end
  end
  return closed
end

--- Normal mode's Esc (keymaps.lua): closes a popup, clears the search highlight; with nothing of
--- that, no count typed and a single caret (several carets have their own Esc), it tells the app,
--- whose maximized split restores then (#102: Esc restores only where it has nothing else to do).
function M.esc()
  local searching = vim.v.hlsearch == 1 and vim.fn.getreg("/") ~= ""
  local closed = M.close_popup()
  if not closed and not searching and vim.v.count == 0 then
    require("config.app.bridge").notify("maximize", { event = "esc_idle" })
  end
end

function M.setup()
  hook_paste()
  require("config.fold").setup() -- code folding (Cmd+- / Cmd+=)
  require("config.postfix").setup() -- `.log` + Tab
end

return M
