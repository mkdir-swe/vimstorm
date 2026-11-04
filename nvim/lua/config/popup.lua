-- Where a popup was opened from (origin / back / leave_insert), and the frame of the few popups still drawn as
-- Neovim floats (Cmd+R replace bar; D4): the corner cells are smooth-mosaic glyphs (the app draws them as
-- sprites, app/src/render/sprites.rs) filled with the popup bg over the editor bg: a cut corner. "band" borders use
-- a third of a row for the top / bottom edge (tight, like WebStorm's 8pt padding); full ones keep a whole row.
local M = {}

-- tl tr br bl
local CORNERS = {
  full = { "\u{1fb41}", "\u{1fb4c}", "\u{1fb5d}", "\u{1fb52}" }, -- all but a small corner
  band = { "\u{1fb48}", "\u{1fb3d}", "\u{1fb58}", "\u{1fb63}" }, -- the bottom / top third, cut
}
local BAND_TOP, BAND_BOTTOM = "\u{1fb2d}", "\u{1fb02}" -- sextants: bottom / top third of the cell

---@return integer?
local function group_bg(name)
  return vim.api.nvim_get_hl(0, { name = name, link = false }).bg
end

local cell_groups = {} ---@type table<string, true>
vim.api.nvim_create_autocmd("ColorScheme", { callback = function() cell_groups = {} end })

-- Highlight group fg / bg (cached; recreated after a colorscheme change)
local function cell_group(fg, bg)
  local name = ("WsCard_%06x_%06x"):format(fg, bg)
  if not cell_groups[name] then
    vim.api.nvim_set_hl(0, name, { fg = fg, bg = bg })
    cell_groups[name] = true
  end
  return name
end

---@class PopupBorderOpts
---@field fill? string group of the popup body (default WsMenu)
---@field band? boolean top / bottom edge a third of a row (no title / footer)
---@field zindex? integer unused (the corners assume the editor bg under them)

-- Border for a float with inner size w x h (row / col unused: the corners assume the editor bg under them)
---@param opts? PopupBorderOpts
---@return {[1]: string, [2]: string}[] border, table edge: { top = bg, bottom = bg } outside the edge cells
function M.border(_row, _col, _w, _h, opts)
  opts = opts or {}
  local fill = opts.fill or "WsMenu"
  local fbg = group_bg(fill) or 0x26282b
  local under = group_bg("Normal") or 0x1e1f22
  local g = cell_group(fbg, under)
  local cs = CORNERS[opts.band and "band" or "full"]
  local border = {
    { cs[1], g },
    { opts.band and BAND_TOP or " ", opts.band and g or fill },
    { cs[2], g },
    { " ", fill },
    { cs[3], g },
    { opts.band and BAND_BOTTOM or " ", opts.band and g or fill },
    { cs[4], g },
    { " ", fill },
  }
  return border, { top = under, bottom = under }
end

-- Where a popup was opened from -------------------------------------------------------------------
-- WebStorm has no modes: an action started while typing leaves you typing, with the caret where it was, and
-- a popup closed with Esc gives back exactly the window, caret, mode and selection it was opened from.
-- Take the origin before anything leaves Insert / Visual mode; `back` restores it.

---@class PopupOrigin
---@field win integer
---@field mode "n"|"i"|"v"|"V"|"\22"
---@field cur integer[] (1,0)-indexed caret; while typing it can be just past the last character
---@field vstart? integer[] the selection's other end

---@return PopupOrigin
function M.origin()
  local win = vim.api.nvim_get_current_win()
  local mode = vim.api.nvim_get_mode().mode
  local o = { win = win, cur = vim.api.nvim_win_get_cursor(win), mode = "n" } ---@type PopupOrigin
  if mode:match("^[iR]") then
    o.mode = "i"
  elseif mode:match("^[vV\22]") then
    o.mode = mode:sub(1, 1) --[[@as "v"|"V"|"\22"]]
    local v = vim.fn.getpos("v")
    o.vstart = { v[2], v[3] - 1 }
  end
  return o
end

-- Leave Insert mode for good, the caret staying put: Neovim moves it one left once the mapping that stopped
-- Insert mode returns, so it's put back right after
---@param win integer
---@param row integer
---@param col integer
function M.leave_insert(win, row, col)
  vim.cmd.stopinsert()
  vim.schedule(function()
    if vim.api.nvim_win_is_valid(win) and not vim.api.nvim_get_mode().mode:match("^i") then
      pcall(vim.api.nvim_win_set_cursor, win, { row, col })
    end
  end)
end

-- Back to an origin: its window, caret, and typing / the selection again.
-- opts.visual = false: no selection back (a menu item about to run on it uses `gv` itself)
---@param o PopupOrigin?
---@param opts? {visual?: boolean}
function M.back(o, opts)
  if not (o and vim.api.nvim_win_is_valid(o.win)) then return end
  if vim.api.nvim_get_current_win() ~= o.win then vim.api.nvim_set_current_win(o.win) end
  local buf = vim.api.nvim_win_get_buf(o.win)
  local last = vim.api.nvim_buf_line_count(buf)
  local row = math.max(math.min(o.cur[1], last), 1)
  local line = vim.api.nvim_buf_get_lines(buf, row - 1, row, false)[1] or ""
  local col = math.min(o.cur[2], #line)
  local now = vim.api.nvim_get_mode().mode
  local typing = now:match("^[iR]") ~= nil
  if now:match("^[vV\22]") then vim.cmd("normal! \27") end
  if o.mode == "i" then
    pcall(vim.api.nvim_win_set_cursor, o.win, { row, col })
    if not typing then vim.cmd(col >= #line and #line > 0 and "startinsert!" or "startinsert") end
    return
  end
  col = math.min(col, math.max(#line - 1, 0))
  local vstart = not (opts and opts.visual == false) and o.vstart or nil
  local function restore()
    if vim.api.nvim_get_current_win() ~= o.win then return end
    if vstart then
      pcall(vim.api.nvim_win_set_cursor, o.win, { math.max(math.min(vstart[1], last), 1), vstart[2] })
      vim.cmd("normal! " .. o.mode)
    end
    pcall(vim.api.nvim_win_set_cursor, o.win, { row, col })
  end
  pcall(vim.api.nvim_win_set_cursor, o.win, { row, col })
  if not typing then return restore() end
  -- typing in the popup: Insert mode ends once this mapping returns (moving the caret one left), then the
  -- caret / selection are put back
  vim.cmd.stopinsert()
  vim.schedule(function()
    if not vim.api.nvim_get_mode().mode:match("^[iR]") then restore() end
  end)
end

return M
