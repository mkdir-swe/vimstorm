-- Code folding like WebStorm: syntax regions (treesitter folds), everything open when a file opens, a
-- closed region shows its first line and a gray "{...}" placeholder (plus the closing line's tail:
-- `foo(() => {...});`). Click the placeholder to open it. Cmd+- / Cmd+= collapse / expand the region at
-- the caret (again: the enclosing one), Cmd+Shift+- / Cmd+Shift+= all of them (keys in config/webstorm.lua).
-- Only splits showing real files fold; tool windows and the diff viewer / merge window keep their own.
-- No fold column (he hides the folding outline in WebStorm).
local M = {}

local EXPR = "v:lua.vim.treesitter.foldexpr()"
local TEXT = "v:lua.require'config.fold'.text()"

---@param win integer
local function eligible(win)
  if not vim.api.nvim_win_is_valid(win) or vim.wo[win].diff or not require("config.focus").is_split(win) then return false end
  return vim.treesitter.highlighter.active[vim.api.nvim_win_get_buf(win)] ~= nil
end

-- Folding for the file shown in `win` (local to that file in that window: another buffer shown there later
-- gets the window's plain defaults back). Once per file and window, so collapsed regions stay collapsed.
---@param win integer
function M.attach(win)
  if not eligible(win) then return end
  local wo = vim.wo[win][0]
  if wo.foldmethod == "expr" and wo.foldexpr == EXPR then return end
  wo.foldexpr = EXPR
  wo.foldtext = TEXT
  wo.foldlevel = 99
  wo.foldenable = true
  wo.foldmethod = "expr"
end

-- Fold text --------------------------------------------------------------------------------------

local CLOSE = { ["{"] = "}", ["("] = ")", ["["] = "]" }

local cache = {} ---@type table<integer, {tick: integer, texts: table<string, {chunks: string[][], pill: integer[]}>}>

-- Syntax colors of line `lnum0` (0-based) as a group per byte
---@return table<integer, string>
local function line_groups(buf, lnum0, line)
  local groups = {}
  local ok, parser = pcall(vim.treesitter.get_parser, buf, nil, { error = false })
  if not ok or not parser then return groups end
  parser:for_each_tree(function(tree, ltree)
    local lang = ltree:lang()
    local qok, query = pcall(vim.treesitter.query.get, lang, "highlights")
    if not qok or not query then return end
    for id, node in query:iter_captures(tree:root(), buf, lnum0, lnum0 + 1) do
      local name = query.captures[id]
      if not name:match("^_") and name ~= "spell" and name ~= "nospell" and name ~= "conceal" then
        local sr, sc, er, ec = node:range()
        if sr <= lnum0 and er >= lnum0 then
          local s, e = sr < lnum0 and 0 or sc, er > lnum0 and #line or ec
          for b = s, math.min(e, #line) - 1 do groups[b] = "@" .. name .. "." .. lang end
        end
      end
    end
  end)
  return groups
end

-- Bytes [from, to) of a line as highlighted chunks, tabs as spaces
---@param out string[][]
local function add_chunks(out, buf, lnum0, line, from, to)
  local groups = line_groups(buf, lnum0, line)
  local ts = vim.bo[buf].tabstop
  local i = from
  while i < to do
    local g = groups[i]
    local j = i + 1
    while j < to and groups[j] == g do j = j + 1 end
    local text = line:sub(i + 1, j):gsub("\t", string.rep(" ", ts))
    out[#out + 1] = { text, g } -- plain text: no group (Folded); a bg here would beat Visual on a selected fold row
    i = j
  end
end

local function width(chunks)
  local w = 0
  for _, c in ipairs(chunks) do w = w + vim.fn.strdisplaywidth(c[1]) end
  return w
end

-- First line + placeholder (+ the closing line's tail), and the placeholder's display columns
---@return string[][] chunks, integer[] pill {from, to} display columns
local function build(buf, s, e)
  local first = (vim.api.nvim_buf_get_lines(buf, s - 1, s, false)[1] or ""):gsub("%s+$", "")
  local last_raw = vim.api.nvim_buf_get_lines(buf, e - 1, e, false)[1] or ""
  local lead = #last_raw:match("^%s*")
  local last = vim.trim(last_raw)
  local chunks = {}
  local open = first:sub(-1)
  local pill, tail_from
  if CLOSE[open] and last:sub(1, 1) == CLOSE[open] then
    add_chunks(chunks, buf, s - 1, first, 0, #first - 1) -- `function f() ` + {...}
    pill = open .. "..." .. CLOSE[open]
    tail_from = lead + 1
  else
    add_chunks(chunks, buf, s - 1, first, 0, #first)
    pill = "..."
    -- JSX `<div>...</div>`, comment `/** text ...*/`: the short closing line follows
    if last:match("^</") or last:match("^%*/") or (#last <= 3 and last:match("^[%]%)}>]")) then tail_from = lead end
  end
  local from = width(chunks)
  chunks[#chunks + 1] = { pill, "WsFoldPlaceholder" }
  local to = from + #pill
  if tail_from and tail_from < #last_raw then
    add_chunks(chunks, buf, e - 1, last_raw:gsub("%s+$", ""), tail_from, #(last_raw:gsub("%s+$", "")))
  end
  return chunks, { from, to }
end

-- 'foldtext' of splits
function M.text()
  local buf = vim.api.nvim_get_current_buf()
  local s, e = vim.v.foldstart, vim.v.foldend
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  local c = cache[buf]
  if not c or c.tick ~= tick then
    c = { tick = tick, texts = {} }
    cache[buf] = c
  end
  local key = s .. ":" .. e
  if not c.texts[key] then
    local chunks, pill = build(buf, s, e)
    c.texts[key] = { chunks = chunks, pill = pill }
  end
  return c.texts[key].chunks
end

-- Actions ----------------------------------------------------------------------------------------

local function run(cmd)
  M.attach(vim.api.nvim_get_current_win())
  pcall(vim.cmd, "normal! " .. cmd) -- E490 (no fold here) is not an error worth showing
  -- while typing, a collapsed region can't keep the caret inside (the next key would go into hidden text): it
  -- goes to where the region starts, before its placeholder, like WebStorm
  local row = vim.fn.line(".")
  local start = vim.fn.foldclosed(row)
  if start ~= -1 and start ~= row and vim.api.nvim_get_mode().mode:match("^[iR]") then
    local first = (vim.fn.getline(start) --[[@as string]]):gsub("%s+$", "")
    vim.api.nvim_win_set_cursor(0, { start, CLOSE[first:sub(-1)] and #first - 1 or #first })
  end
end

-- Cmd+-: the region at the caret; again: the one around it
function M.collapse() run("zc") end
-- Cmd+=
function M.expand() run("zo") end
-- Cmd+Shift+-
function M.collapse_all() run("zM") end
-- Cmd+Shift+=
function M.expand_all() run("zR") end

---@return MenuEntry[]
function M.menu_items()
  return {
    { "Expand", M.expand, key = "⌘+" },
    { "Collapse", M.collapse, key = "⌘-" },
    { "Expand All", M.expand_all, key = "⌘⇧+" },
    { "Collapse All", M.collapse_all, key = "⌘⇧-" },
  }
end

-- Click on the placeholder of a closed region opens it
require("config.menu").zone(function(pos)
  local win = pos.winid
  if not require("config.focus").is_split(win, true) or vim.wo[win].foldtext ~= TEXT then return end
  local start = vim.api.nvim_win_call(win, function() return vim.fn.foldclosed(pos.line) end)
  if start == -1 then return end
  local buf = vim.api.nvim_win_get_buf(win)
  local c = cache[buf]
  local entry = c and c.texts[start .. ":" .. vim.api.nvim_win_call(win, function() return vim.fn.foldclosedend(pos.line) end)]
  if not entry then return end
  local info = vim.fn.getwininfo(win)[1]
  local vcol = pos.wincol - info.textoff - 1 + vim.api.nvim_win_call(win, function() return vim.fn.winsaveview().leftcol end)
  if vcol < entry.pill[1] or vcol >= entry.pill[2] then return end
  return function()
    vim.api.nvim_set_current_win(win)
    vim.api.nvim_win_set_cursor(win, { start, 0 })
    pcall(vim.cmd, "normal! zo")
  end
end)

function M.setup()
  local group = vim.api.nvim_create_augroup("ws_fold", { clear = true })
  local function attach_buf(buf)
    for _, win in ipairs(vim.fn.win_findbuf(buf)) do M.attach(win) end
  end
  -- the diff viewer / merge window set their own folds right after showing a file (diffthis): eligible() skips them
  vim.api.nvim_create_autocmd("BufWinEnter", { group = group, callback = function(ev) attach_buf(ev.buf) end })
  -- after the treesitter FileType handler (plugins/editor.lua) started highlighting
  vim.api.nvim_create_autocmd("FileType", {
    group = group,
    callback = function(ev) vim.schedule(function() if vim.api.nvim_buf_is_valid(ev.buf) then attach_buf(ev.buf) end end) end,
  })
  vim.api.nvim_create_autocmd("BufWipeout", { group = group, callback = function(ev) cache[ev.buf] = nil end })
  -- typing in a collapsed region expands it (WebStorm), instead of changing text nobody sees
  vim.api.nvim_create_autocmd("InsertCharPre", {
    group = group,
    callback = function()
      if vim.fn.foldclosed(".") ~= -1 then vim.cmd("silent! foldopen!") end
    end,
  })
  for _, win in ipairs(vim.api.nvim_list_wins()) do M.attach(win) end
end

return M
