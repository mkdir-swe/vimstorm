-- Quick Definition (WebStorm's Cmd+Shift+I / Alt+Space, here Cmd+L): a popup at the caret with the
-- declaration of the name under it, syntax colored, its file in the header. The popup takes focus:
-- l / ö / k / ä / wheel / a click move its caret, Enter / Cmd+B / F4 / double-click open the file at that
-- caret, Esc / Cmd+L / q / clicking elsewhere closes, Tab / Shift+Tab step through several declarations.
-- The app draws the frame and the header natively around the popup's window (config/app/floats.lua).
local popup = require("config.popup")
local usages = require("config.usages")

local M = {}

local ROWS = 15

---@class PeekState
---@field win integer
---@field buf integer
---@field locs UsageLoc[]
---@field index integer
---@field from integer window the popup was opened from
---@field origin PopupOrigin caret + mode it was opened with (typing goes on after Esc)
---@field view? vim.fn.winrestview.dict the declaration shown (caret on its name)
---@field jump? fun() to the declaration at the popup's caret (Enter, the header's Edit Source)
local S = nil ---@type PeekState?

-- Close; back to where it was opened from only when the popup still has focus (a click elsewhere keeps that)
---@param back? boolean
local function close(back)
  local s = S
  S = nil
  if not s then return end
  local inside = vim.api.nvim_get_current_win() == s.win
  if vim.api.nvim_win_is_valid(s.win) then vim.api.nvim_win_close(s.win, true) end
  require("config.app.floats").peek_close()
  if back ~= false and inside then popup.back(s.origin) end
end

-- Lines of a file: its buffer when loaded, else from disk
---@return string[]
local function file_lines(fname)
  local b = vim.fn.bufnr(fname)
  if b ~= -1 and vim.api.nvim_buf_is_loaded(b) then return vim.api.nvim_buf_get_lines(b, 0, -1, false) end
  return vim.fn.filereadable(fname) == 1 and vim.fn.readfile(fname) or {}
end

-- Show declaration s.index: the file from the declaration's start, the popup sized to it (at most ROWS)
---@param s PeekState
local function show(s)
  local loc = s.locs[s.index]
  local fname = vim.uri_to_fname(loc.uri)
  local lines = file_lines(fname)
  vim.bo[s.buf].modifiable = true
  vim.api.nvim_buf_set_lines(s.buf, 0, -1, false, lines)
  vim.bo[s.buf].modifiable = false
  local ft = vim.filetype.match({ filename = fname, buf = s.buf }) or ""
  local lang = vim.treesitter.language.get_lang(ft)
  if not (lang and pcall(vim.treesitter.start, s.buf, lang)) then vim.bo[s.buf].syntax = ft end
  local full = loc.full or loc.range
  local top = full.start.line + 1
  local lnum = loc.range.start.line + 1
  if lnum - top >= ROWS then top = lnum end -- long declaration: the name on top
  local h = math.max(math.min(ROWS, #lines - top + 1), 1)
  local tw = 0
  for i = top, math.min(top + h - 1, #lines) do tw = math.max(tw, vim.fn.strdisplaywidth(lines[i])) end
  local w = math.min(math.max(tw + 2, 60), math.min(120, vim.o.columns - 4))
  local line = lines[lnum] or ""
  local col0 = vim.str_byteindex(line, loc.enc, loc.range.start.character, false)
  -- anchored to the caret in its split (the app places it on that grid): below the caret line with two rows
  -- for the native header (WebStorm's 30 px) and the code's top padding, or above it when there's more room
  local cur = vim.api.nvim_win_get_cursor(s.from)
  local wl = vim.api.nvim_win_call(s.from, vim.fn.winline)
  -- winheight / winwidth: the grid the app sized to its island (nvim_ui_try_resize_grid); nvim_win_get_* stay the
  -- window's logical size, wider than the island while the Chat column takes its pixels (#216)
  local below = vim.fn.winheight(s.from) - wl
  local above = below < h + 2 and wl - 1 > below
  if above then h = math.max(math.min(h, wl - 3), 1) else h = math.max(math.min(h, below - 2), 1) end
  -- kept inside its split (#211): the islands beside it (the Chat column) are drawn over a float that pokes out,
  -- and the native frame would stand over them; 2 left of the caret when it fits, else shifted left, narrowed
  -- to the split at most (a column each side for the frame)
  local fw = vim.fn.winwidth(s.from)
  local caret = vim.api.nvim_win_call(s.from, vim.fn.wincol) - 1
  w = math.max(math.min(w, fw - 2), 1)
  local left = math.max(math.min(caret - 2, fw - 1 - w), math.min(1, caret))
  vim.api.nvim_win_set_config(s.win, {
    relative = "win", win = s.from, bufpos = { cur[1] - 1, cur[2] }, anchor = above and "SW" or "NW",
    row = above and 0 or 3, col = left - caret, width = w, height = h, border = "none",
  })
  vim.wo[s.win].winbar = ""
  local hl = vim.api.nvim_get_hl(0, { name = "NormalFloat", link = false })
  local ok, git = pcall(require, "git.status")
  require("config.app.floats").peek(s.win, {
    file = fname,
    path = vim.fn.fnamemodify(fname, ":~:."),
    right = (#s.locs > 1 and ("%d of %d   "):format(s.index, #s.locs) or "") .. ("line %d"):format(lnum),
    bg = hl.bg or 0x2b2d30,
    status = ok and git.of(fname) or "", -- the name in its VCS color (WebStorm's FileStatus)
    count = #s.locs,
  }, above)
  vim.api.nvim_win_set_cursor(s.win, { math.max(lnum, 1), col0 })
  s.view = { topline = top, lnum = lnum, col = col0, curswant = col0 }
  vim.fn.winrestview(s.view)
end

---@param locs UsageLoc[]
---@param origin PopupOrigin
local function open(locs, origin)
  if S then close(false) end
  local from = origin.win
  if vim.api.nvim_get_current_win() ~= from then return end
  -- typing: Insert mode ends in the popup (entered below in this same step), so the caret here stays put
  local typing = vim.api.nvim_get_mode().mode:match("^[iR]") ~= nil
  if typing then vim.cmd.stopinsert() end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].bufhidden = "wipe"
  vim.b[buf].completion = false
  local win = vim.api.nvim_open_win(buf, true, { -- placed and sized by show()
    relative = "editor", row = 0, col = 0, width = 1, height = 2, border = "none", style = "minimal", zindex = 200,
  })
  local wo = vim.wo[win]
  -- WebStorm's Quick Definition body is the documentation color (NormalFloat), its frame native
  wo.winhighlight = "Normal:NormalFloat,NormalNC:NormalFloat,CursorLine:WsPeekLine"
  wo.cursorline = true
  wo.wrap = false
  wo.scrolloff = 0
  vim.bo[buf].filetype = "wspeek"
  local s = { win = win, buf = buf, locs = locs, index = 1, from = from, origin = origin }
  S = s
  show(s)
  if typing then -- Insert mode ends in the popup, its caret one left of the name: put back
    vim.api.nvim_create_autocmd("ModeChanged", {
      callback = function()
        if vim.v.event.new_mode:match("^[iR]") then return end
        vim.schedule(function()
          if S == s and vim.api.nvim_get_current_win() == s.win then vim.fn.winrestview(s.view) end
        end)
        return true
      end,
    })
  end
  local function map(lhs, fn) vim.keymap.set("n", lhs, fn, { buffer = buf, nowait = true, silent = true }) end
  for _, k in ipairs({ "<Esc>", "q", "<D-l>", "<M-Space>" }) do map(k, close) end
  -- To the caret in the popup (moved with l / ö / k / ä / wheel / a click), like WebStorm: the popup shows
  -- the file itself, so its line / column are the file's
  local function jump()
    local loc = s.locs[s.index]
    local cur = vim.api.nvim_win_get_cursor(s.win)
    local line = vim.api.nvim_buf_get_lines(s.buf, cur[1] - 1, cur[1], false)[1] or ""
    local pos = { line = cur[1] - 1, character = vim.str_utfindex(line, loc.enc, math.min(cur[2], #line), false) }
    close(false)
    if not vim.api.nvim_win_is_valid(s.from) then return end
    vim.api.nvim_set_current_win(s.from)
    usages.jump({ uri = loc.uri, enc = loc.enc, range = { start = pos, ["end"] = pos } })
    if s.origin.mode == "i" then vim.cmd.startinsert() end -- typing goes on there
  end
  map("<CR>", jump)
  map("<D-b>", jump)
  map("<F4>", jump) -- WebStorm's Jump to Source
  map("<2-LeftMouse>", jump)
  s.jump = jump
  map("<Tab>", function() M.next() end)
  map("<S-Tab>", function() M.prev() end)
  vim.api.nvim_create_autocmd("WinLeave", {
    buffer = buf,
    once = true,
    callback = function() vim.schedule(function() if S == s then close(false) end end) end,
  })
end

-- The next / previous declaration (Tab / Shift+Tab, the header's ▶ ◀)
function M.next()
  if not S or #S.locs < 2 then return end
  S.index = S.index % #S.locs + 1
  show(S)
end

function M.prev()
  if not S or #S.locs < 2 then return end
  S.index = (S.index - 2) % #S.locs + 1
  show(S)
end

-- The header's ⋮ Edit Source (= Enter)
function M.edit_source()
  if S and S.jump then S.jump() end
end

-- How long Cmd+L waits for a language server that's still starting for this buffer
local ATTACH_WAIT_MS = 15000

-- Cmd+L (also while typing: Esc goes back to typing at the same spot)
function M.open()
  if S then return close() end
  local origin = popup.origin()
  if #vim.lsp.get_clients({ bufnr = 0, method = "textDocument/definition" }) == 0 then
    -- a server for this file type is enabled but not attached yet (just opened, still starting): open once
    -- it attaches, if the caret hasn't moved (pressing Cmd+L right after opening a file)
    local buf, win = vim.api.nvim_get_current_buf(), vim.api.nvim_get_current_win()
    local cur = vim.api.nvim_win_get_cursor(win)
    if #vim.lsp.get_configs({ enabled = true, filetype = vim.bo[buf].filetype }) > 0 then
      local done = false
      local function retry()
        if done then return end
        done = true
        if vim.api.nvim_get_current_win() == win and vim.api.nvim_win_get_buf(win) == buf
          and vim.deep_equal(vim.api.nvim_win_get_cursor(win), cur) then M.open() end
      end
      vim.api.nvim_create_autocmd("LspAttach", {
        buffer = buf,
        callback = function(ev)
          local client = vim.lsp.get_client_by_id(ev.data.client_id)
          if not (client and client:supports_method("textDocument/definition")) then return end
          vim.schedule(retry)
          return true
        end,
      })
      vim.defer_fn(function()
        if done then return end
        done = true
        vim.notify("No definition: the language server didn't start", vim.log.levels.WARN)
      end, ATTACH_WAIT_MS)
      return
    end
    return vim.notify("No definition: no language server here", vim.log.levels.WARN)
  end
  usages.request("textDocument/definition", nil, function(locs)
    if #locs == 0 then return vim.notify("No definition found", vim.log.levels.INFO) end
    open(locs, origin)
  end)
end

function M.is_open() return S ~= nil end

-- Close without going back (focus went elsewhere: the app's tree, a picker)
function M.close() close(false) end

-- Test hook
function M.state()
  if not S then return end
  local loc = S.locs[S.index]
  return {
    win = S.win, from = S.from, file = vim.uri_to_fname(loc.uri), line = loc.range.start.line + 1, count = #S.locs,
    topline = vim.fn.getwininfo(S.win)[1].topline, cursor = vim.api.nvim_win_get_cursor(S.win),
  }
end

return M
