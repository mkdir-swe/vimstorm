-- The other carets of several (multi-cursor, config/multicursor.lua) for the app to draw like the caret (Rust:
-- `vimstorm.carets` -> EditorView::set_carets, render/grid.rs): the current window's carets as cells of its grid,
-- sent at the end of a redraw whenever they changed ({ win, cells = {} } once there's one caret again). nvim draws none
-- of them itself (MultiCursorCursor links to nothing in colors/darcula-contrast.lua). Set up once the
-- multi-cursor plugin loads (none before: nothing to draw).
local M = {}
local api = vim.api

local NS = api.nvim_create_namespace("vimstorm_carets")
local sent = "" -- the payload last sent, as text

-- Buffer positions { row0, col } -> cells { row, col } of the window's grid (screen positions minus the
-- window's): a caret past the line's end (Insert mode) is the cell after its last character; a hidden one
-- (scrolled away, in a closed fold) isn't sent
---@param win integer
---@param list integer[][]
---@return integer[][]
local function cells(win, list)
  local origin = vim.fn.win_screenpos(win)
  local buf = api.nvim_win_get_buf(win)
  local insert = api.nvim_get_mode().mode:match("^[iR]") ~= nil
  local out, seen = {}, {}
  for _, p in ipairs(list) do
    local lnum = p[1] + 1
    local line = api.nvim_buf_get_lines(buf, p[1], lnum, false)[1] or ""
    local s
    if p[2] >= #line and #line > 0 then
      local last = vim.str_utf_start(line, #line) + #line -- 1-based byte of the last character
      local sp = vim.fn.screenpos(win, lnum, last)
      if sp.row > 0 then s = { sp.row, sp.endcol + 1 } end
    else
      local sp = vim.fn.screenpos(win, lnum, math.min(p[2], #line) + 1)
      -- a Tab: Normal mode's caret is on its last cell, Insert mode's before it
      if sp.row > 0 then s = { sp.row, insert and sp.col or sp.curscol } end
    end
    if s and vim.fn.foldclosed(lnum) == -1 then
      local cell = { s[1] - origin[1], s[2] - origin[2] }
      local key = cell[1] .. ":" .. cell[2]
      if not seen[key] then
        seen[key] = true
        out[#out + 1] = cell
      end
    end
  end
  table.sort(out, function(a, b) return a[1] < b[1] or (a[1] == b[1] and a[2] < b[2]) end)
  return out
end

-- What the app is told now: { win, cells }
function M.payload()
  local win = api.nvim_get_current_win()
  local mcl = package.loaded["config.multicursor"]
  local list = mcl and mcl.carets(api.nvim_win_get_buf(win)) or {}
  return { event = "carets", win = win, cells = #list > 0 and cells(win, list) or {} }
end

function M.report()
  local ok, p = pcall(M.payload)
  if not ok then return end
  local parts = {}
  for _, c in ipairs(p.cells) do parts[#parts + 1] = c[1] .. ":" .. c[2] end
  local key = #parts > 0 and (p.win .. "|" .. table.concat(parts, ",")) or ""
  if key == sent then return end
  sent = key
  require("config.app.bridge").notify("carets", p)
end

function M.setup()
  -- at the end of each redraw (the windows' views are current then; read-only work, no state changed: a
  -- scheduled report would run its own SafeState, and the plugin redraws its cursors on every one), only while
  -- there are carets or some were sent
  api.nvim_set_decoration_provider(NS, {
    on_end = function()
      local mcl = package.loaded["config.multicursor"]
      if sent == "" and not (mcl and mcl.several()) then return end
      M.report()
    end,
  })
end

return M
