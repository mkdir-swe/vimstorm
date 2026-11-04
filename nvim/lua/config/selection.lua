-- Selection look like WebStorm: a selection over several lines is a block, not a ragged edge. Charwise (v):
-- the first line from the start column to the window's right edge, the lines in between full width (empty
-- ones too), the last line from column 0 up to the end column (Neovim's own Visual already draws that).
-- Linewise (V): every line full width. Blockwise and one-line selections: Neovim's own.
-- One extmark per visible selected row (Visual as line_hl_group; the first charwise row a range with hl_eol),
-- in a namespace scoped to the current window, updated on cursor moves / scrolls (only rows that changed).
-- Code and diff windows only; lists (tree, Git tool window, terminal) keep their own selection rendering.
local M = {}

local ns = vim.api.nvim_create_namespace("ws_selection")
local marked ---@type integer? buffer holding the marks
local drawn = {} ---@type table<integer, integer> row (1-based, = mark id) -> start column of its mark (-1: whole row)
local scoped ---@type integer? window the namespace is scoped to

local KIND = { v = "v", s = "v", V = "V", S = "V" }

local function clear()
  if marked and vim.api.nvim_buf_is_valid(marked) then vim.api.nvim_buf_clear_namespace(marked, ns, 0, -1) end
  marked, drawn = nil, {}
end

---@param win integer
local function in_editor(win)
  local focus = require("config.focus")
  return focus.is_split(win, true) or focus.is_viewer_win(win)
end

-- Rows to fill, by row: -1 = the whole row (line_hl_group), else from that byte column to the window edge
-- (a range to the next row's start with hl_eol). Closed folds are skipped: Neovim already draws a selected
-- fold row full width (and marks around it could change how its {...} text combines with Visual).
---@param spans integer[][] row ranges {from, to} to look at
---@return table<integer, integer>
local function rows(kind, sr, sc, er, spans)
  local want = {} ---@type table<integer, integer>
  for _, span in ipairs(spans) do
    local last = math.min(kind == "V" and er or er - 1, span[2]) -- charwise: the last row's cells are Visual's
    local r = math.max(sr, span[1])
    while r <= last do
      local fold_end = vim.fn.foldclosedend(r)
      if fold_end ~= -1 then
        r = fold_end + 1
      else
        if r == sr and kind == "v" then
          -- the hl_eol range ends at the next row's start: not when that row is a closed fold (text only then)
          if vim.fn.foldclosed(r + 1) == -1 then want[r] = sc end
        else
          want[r] = -1
        end
        r = r + 1
      end
    end
  end
  return want
end

-- Draw / move the marks for the current selection; clear them outside visual / select mode
function M.update()
  local kind = KIND[vim.api.nvim_get_mode().mode:sub(1, 1)]
  local win = vim.api.nvim_get_current_win()
  if not kind or not in_editor(win) then return clear() end
  local buf = vim.api.nvim_win_get_buf(win)
  local v, c = vim.fn.getpos("v"), vim.api.nvim_win_get_cursor(win)
  local sr, sc, er, ec = v[2], v[3] - 1, c[1], c[2]
  if sr > er or (sr == er and sc > ec) then sr, sc, er = er, ec, sr end
  -- only the visible rows (a huge selection stays cheap; only rows that changed get redrawn), plus a window
  -- height around the cursor: CursorMoved runs before the view follows the cursor (no row flashes unfilled)
  local top, bot, h = vim.fn.line("w0"), vim.fn.line("w$"), vim.api.nvim_win_get_height(win)
  local spans = { { top, bot } }
  if c[1] - h < top or c[1] + h > bot then
    local a, b = c[1] - h, c[1] + h
    if b < top or a > bot then
      spans[2] = { a, b }
    else
      spans[1] = { math.min(a, top), math.max(b, bot) }
    end
  end
  local want = rows(kind, sr, sc, er, spans)
  if marked and marked ~= buf then clear() end
  if scoped ~= win then
    pcall(vim.api.nvim__ns_set, ns, { wins = { win } }) -- only this window shows them (like Visual)
    scoped = win
  end
  for r in pairs(drawn) do
    if not want[r] then
      pcall(vim.api.nvim_buf_del_extmark, buf, ns, r)
      drawn[r] = nil
    end
  end
  for r, col in pairs(want) do
    if drawn[r] ~= col then
      local opts = { id = r, priority = 150, strict = false } -- over syntax (bg only: their fg stays)
      if col == -1 then
        opts.line_hl_group = "Visual"
      else
        opts.end_row, opts.end_col, opts.hl_group, opts.hl_eol = r, 0, "Visual", true
      end
      drawn[r] = pcall(vim.api.nvim_buf_set_extmark, buf, ns, r - 1, col == -1 and 0 or col, opts) and col or nil
    end
  end
  marked = buf
end

function M.setup()
  local group = vim.api.nvim_create_augroup("ws_selection", { clear = true })
  vim.api.nvim_create_autocmd("ModeChanged", {
    group = group,
    pattern = { "*:[vVsS]*", "[vVsS]*:*" },
    callback = function()
      clear() -- fresh marks (edits may have moved the old ones)
      M.update()
    end,
  })
  -- SafeState too: a mapping can move the selection's start without moving the cursor (Cmd+W); and it
  -- catches a stale mark after a plugin's mode juggling (multicursor)
  vim.api.nvim_create_autocmd({ "CursorMoved", "WinScrolled", "SafeState" }, {
    group = group,
    callback = function()
      if marked or KIND[vim.api.nvim_get_mode().mode:sub(1, 1)] then M.update() end
    end,
  })
  vim.api.nvim_create_autocmd({ "WinLeave", "BufLeave" }, { group = group, callback = clear })
end

return M
