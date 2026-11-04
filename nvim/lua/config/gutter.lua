-- Editor gutter and tooltips like WebStorm (distraction-free mode, which he uses):
-- * line number right-aligned, then the change bar (gitsigns), then code. No gutter icons,
--   no fold outline, no diagnostic letters: errors are only the wavy underline.
-- * Hovering the mouse over code shows a tooltip: the error under it, then the documentation.
--   gh shows the same popup for the word at the cursor (ShowHoverInfo), ,e only the error.
local M = {}

-- statuscolumn of splits (git/blame.lua puts the annotation in front of it). The cell after the
-- number is blank or a bookmark (config/bookmarks.lua: number box), so the width never changes.
M.COLUMN = "%=%l%{%v:lua.require'config.bookmarks'.cell()%}%s"

local DELAY = 500 -- ms the mouse has to rest, like WebStorm's tooltip delay

-- A split with line numbers on (not the empty editor)
local function is_code_split(win)
  return vim.api.nvim_win_is_valid(win) and require("config.focus").is_split(win, true) and vim.wo[win].number
end

-- Give splits the WebStorm column; take it from anything else (a terminal window split off one)
local function sync(win)
  if not vim.api.nvim_win_is_valid(win) then return end
  local stc = vim.wo[win].statuscolumn
  if is_code_split(win) then
    if stc == "" then vim.wo[win].statuscolumn = M.COLUMN end
  elseif stc == M.COLUMN then
    vim.wo[win].statuscolumn = ""
  end
end

function M.sync_all()
  for _, win in ipairs(vim.api.nvim_list_wins()) do sync(win) end
end

local pending = false
vim.api.nvim_create_autocmd({ "BufWinEnter", "WinNew", "TermOpen", "FileType", "VimEnter" }, {
  group = vim.api.nvim_create_augroup("ws_gutter", { clear = true }),
  callback = function()
    if pending then return end
    pending = true
    vim.schedule(function()
      pending = false
      M.sync_all()
    end)
  end,
})

-- "TS2307: Cannot find module…", "ESLint: Unexpected any. (no-explicit-any)", like WebStorm's tooltip
---@param d vim.Diagnostic
function M.format(d)
  local src = (d.source or ""):lower()
  if src == "ts" or src == "typescript" then
    return d.code and ("TS%s: %s"):format(d.code, d.message) or d.message
  elseif src == "eslint" then
    return "ESLint: " .. d.message .. (d.code and (" (" .. d.code .. ")") or "")
  end
  return d.message
end

vim.diagnostic.config({
  signs = false,
  underline = true,
  virtual_text = false,
  severity_sort = true,
  update_in_insert = false,
  -- format() already has the code ("TS2307: …"): no "(2307)" suffix after it
  float = { header = "", prefix = "", suffix = "", source = false, format = M.format },
})

---@class GutterTarget
---@field win integer
---@field buf integer
---@field lnum integer 1-based
---@field col integer 0-based byte
---@field word {[1]: integer, [2]: integer} byte range of the word under it

-- Text position under the mouse in a split, nil over blanks / past the end / elsewhere
---@return GutterTarget?
local function mouse_target()
  local pos = vim.fn.getmousepos()
  if pos.line == 0 or pos.column == 0 or not is_code_split(pos.winid) then return end
  local buf = vim.api.nvim_win_get_buf(pos.winid)
  local line = vim.api.nvim_buf_get_lines(buf, pos.line - 1, pos.line, false)[1] or ""
  local col = pos.column - 1
  if col >= #line or line:sub(col + 1, col + 1):match("%s") then return end
  -- past the end of the line / below the last line getmousepos() still reports the nearest text
  local at = vim.fn.screenpos(pos.winid, pos.line, pos.column)
  if at.row ~= pos.screenrow then return end
  local last = vim.fn.screenpos(pos.winid, pos.line, #line)
  if last.col > 0 and pos.screencol > last.col then return end
  local s, e = col, col
  while s > 0 and line:sub(s, s):match("[%w_$]") do s = s - 1 end
  while e < #line and line:sub(e + 1, e + 1):match("[%w_$]") do e = e + 1 end
  return { win = pos.winid, buf = buf, lnum = pos.line, col = col, word = { s, math.max(e, col + 1) } }
end

local function same(a, b)
  return a and b and a.win == b.win and a.lnum == b.lnum and a.word[1] == b.word[1] and a.word[2] == b.word[2]
end

-- Diagnostics covering a position
---@param t GutterTarget
function M.diagnostics_at(t)
  local found = {}
  for _, d in ipairs(vim.diagnostic.get(t.buf)) do
    local after_start = d.lnum < t.lnum - 1 or (d.lnum == t.lnum - 1 and d.col <= t.col)
    local end_lnum, end_col = d.end_lnum or d.lnum, d.end_col or d.col
    local before_end = end_lnum > t.lnum - 1 or (end_lnum == t.lnum - 1 and (t.col < end_col or end_col == d.col))
    if after_start and before_end then found[#found + 1] = d end
  end
  table.sort(found, function(a, b) return a.severity < b.severity end)
  return found
end

-- The app draws these popups natively (app/src/editor/floats via config/app/floats.lua): no Neovim window; `shown`
-- while its mouse tooltip is up
local hover = { timer = assert(vim.uv.new_timer()) } ---@type {timer: uv.uv_timer_t, shown?: boolean, target?: GutterTarget}

local function close_hover()
  if hover.shown then
    local floats = require("config.app.floats")
    if floats.hover_kind() == "tooltip" then floats.close_hover() end
  end
  hover.shown, hover.target = nil, nil
end

local SEVERITY = { "error", "warning", "info", "info" }

-- The app's popup: the errors, then each server's docs (markdown, "\0" lines between servers)
---@param errors vim.Diagnostic[]
---@param doc string[]
---@return FloatsSection[]
local function native_sections(errors, doc)
  local floats = require("config.app.floats")
  local out = {}
  for _, d in ipairs(errors) do out[#out + 1] = { kind = SEVERITY[d.severity] or "info", text = M.format(d) } end
  local chunk = {}
  local function add()
    local text = vim.trim(table.concat(chunk, "\n"))
    if text ~= "" then out[#out + 1] = floats.markdown(text) end
    chunk = {}
  end
  for _, l in ipairs(doc) do
    if l == "\0" then add() else chunk[#chunk + 1] = l end
  end
  add()
  return out
end

-- Error + documentation popup for a position. relative: "mouse" (tooltip) or "cursor" (gh)
-- The mouse tooltip shows in Normal mode, and while typing with Vim mode off (config/vimmode.lua: always typing)
local function hover_mode()
  local mode = vim.api.nvim_get_mode().mode
  if mode == "n" then return true end
  local vm = package.loaded["config.vimmode"]
  return mode == "i" and vm ~= nil and vm.off()
end

---@param t GutterTarget
---@param relative "mouse"|"cursor"
function M.show_info(t, relative)
  local function open(doc)
    if relative == "mouse" and not (hover_mode() and same(mouse_target(), t)) then return end
    -- gh: the caret moved on (or focus left) before the answer came: no popup for where it was
    if relative == "cursor" and (vim.api.nvim_get_current_win() ~= t.win
      or not vim.deep_equal(vim.api.nvim_win_get_cursor(t.win), { t.lnum, t.col })) then return end
    local sections = native_sections(M.diagnostics_at(t), doc)
    if #sections == 0 then return end
    if relative == "mouse" then close_hover() end
    -- under the word's start, like WebStorm's popup under the element
    local text = vim.api.nvim_buf_get_lines(t.buf, t.lnum - 1, t.lnum, false)[1] or ""
    local start = t.col
    while start > 0 and text:sub(start, start):match("[%w_$]") do start = start - 1 end
    local anchor = require("config.app.floats").anchor(t.win, t.lnum, start)
    if not anchor then return end
    require("config.app.floats").show_hover(relative == "mouse" and "tooltip" or "hover", sections, anchor, t.buf)
    if relative == "mouse" then hover.shown, hover.target = true, t end
  end
  local params = function(client)
    local text = vim.api.nvim_buf_get_lines(t.buf, t.lnum - 1, t.lnum, false)[1] or ""
    return {
      textDocument = { uri = vim.uri_from_bufnr(t.buf) },
      position = { line = t.lnum - 1, character = vim.str_utfindex(text, client.offset_encoding, t.col, false) },
    }
  end
  if #vim.lsp.get_clients({ bufnr = t.buf, method = "textDocument/hover" }) == 0 then return open({}) end
  local floats = require("config.app.floats")
  floats.once("hover", floats.element_key(t.buf, t.lnum, t.col), function(done)
    vim.lsp.buf_request_all(t.buf, "textDocument/hover", params, function(results)
      local doc = {}
      for _, res in pairs(results) do
        local contents = res.result and res.result.contents
        if contents then
          local md = vim.lsp.util.convert_input_to_markdown_lines(contents)
          if #vim.tbl_filter(function(l) return vim.trim(l) ~= "" end, md) > 0 then
            if #doc > 0 then doc[#doc + 1] = "\0" end -- separator between servers' answers
            vim.list_extend(doc, md)
          end
        end
      end
      done(doc)
    end)
  end, open)
end

-- The second gh / ,e goes into the open popup (WebStorm's Ctrl+Q twice)
local function enter_popup() return require("config.app.floats").enter_hover() end

-- ,e: only the error at the caret, in the same popup: the errors on the caret's line, like open_float's scope
function M.show_error()
  if enter_popup() then return end
  local win = vim.api.nvim_get_current_win()
  local cur = vim.api.nvim_win_get_cursor(win)
  local errors = vim.diagnostic.get(0, { lnum = cur[1] - 1 })
  table.sort(errors, function(a, b) return a.severity < b.severity end)
  local anchor = require("config.app.floats").caret()
  if #errors == 0 or not anchor then return end
  require("config.app.floats").show_hover("hover", native_sections(errors, {}), anchor, vim.api.nvim_get_current_buf())
end

-- gh: same popup for the word at the cursor
function M.hover_cursor()
  if enter_popup() then return end
  local win = vim.api.nvim_get_current_win()
  local cur = vim.api.nvim_win_get_cursor(win)
  local buf = vim.api.nvim_win_get_buf(win)
  M.show_info({ win = win, buf = buf, lnum = cur[1], col = cur[2], word = { cur[2], cur[2] + 1 } }, "cursor")
end

-- The app: its native tooltip closed itself / focus left (config/app/floats.lua)
function M.tooltip_closed()
  if hover.shown then hover.shown, hover.target = nil, nil end
end

-- The app: the mouse left the code for its own chrome (no <MouseMove> there)
function M.mouse_left()
  hover.timer:stop()
  close_hover()
end

local function on_mouse_move()
  hover.timer:stop()
  local t = mouse_target()
  if hover.shown and not same(t, hover.target) then close_hover() end
  if not t or same(t, hover.target) then return end
  hover.timer:start(DELAY, 0, vim.schedule_wrap(function()
    if not hover_mode() or not same(mouse_target(), t) then return end
    M.show_info(t, "mouse")
  end))
end

vim.o.mousemoveevent = true
vim.keymap.set("n", "<MouseMove>", on_mouse_move, { desc = "Tooltip under the mouse" })

return M
