-- Diff panes scroll together, also when the wheel scrolls a pane that isn't focused.
-- Replaces scrollbind (which only follows the focused pane and fights other scrolling):
-- lines are mapped through the diff, so the panes stay on the same code across
-- inserted / deleted lines.
local M = {}

local groups = {} ---@type integer[][]
local ids = setmetatable({}, { __mode = "k" }) ---@type table<integer[], integer> group -> its id (the app's sync group)
local next_id = 0
local busy = false
local moved = {} ---@type table<integer, integer> windows we scrolled -> their new topline
local wheel = false -- last key was the mouse wheel (it scrolls the pane under the mouse)

local WHEEL = {}
for _, k in ipairs({ "<ScrollWheelUp>", "<ScrollWheelDown>", "<ScrollWheelLeft>", "<ScrollWheelRight>" }) do
  WHEEL[vim.keycode(k)] = true
end
vim.on_key(function(_, typed)
  if typed and typed ~= "" then wheel = WHEEL[typed] or false end
end)

local function text(buf)
  return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n") .. "\n"
end

-- Changes from buffer a to b (vim.text.diff indices), cached until either buffer changes (scrolling and the gutters
-- ask for them all the time; diffing the whole text each time cost ~0.5 ms per scroll).
-- opts: extra vim.text.diff options (e.g. from 'diffopt'), part of the cache key.
local cache = {} ---@type table<string, {ta: integer, tb: integer, changes: integer[][]}>
---@param a integer buffer
---@param b integer buffer
---@param opts? table<string, any>
---@return integer[][]
function M.changes(a, b, opts)
  local key = a .. ":" .. b
  local o = { result_type = "indices" }
  local names = vim.tbl_keys(opts or {})
  table.sort(names)
  for _, k in ipairs(names) do
    o[k] = opts[k]
    key = key .. ":" .. k .. "=" .. tostring(opts[k])
  end
  local ta, tb = vim.api.nvim_buf_get_changedtick(a), vim.api.nvim_buf_get_changedtick(b)
  local c = cache[key]
  if c and c.ta == ta and c.tb == tb then return c.changes end
  local changes = vim.text.diff(text(a), text(b), o)
  ---@cast changes integer[][]
  cache[key] = { ta = ta, tb = tb, changes = changes }
  return changes
end

-- vim.text.diff options doing what 'diffopt' does to diff mode's own (internal xdiff) diff
---@return table<string, any>
function M.diffopt()
  local o = {}
  for _, flag in ipairs(vim.opt.diffopt:get()) do
    local name, val = flag:match("^(%w+):(.+)$")
    if flag == "iwhite" then o.ignore_whitespace_change = true
    elseif flag == "iwhiteall" then o.ignore_whitespace = true
    elseif flag == "iwhiteeol" then o.ignore_whitespace_change_at_eol = true
    elseif flag == "iblank" then o.ignore_blank_lines = true
    elseif flag == "indent-heuristic" then o.indent_heuristic = true
    elseif name == "algorithm" then o.algorithm = val
    elseif name == "linematch" then o.linematch = tonumber(val)
    end
  end
  return o
end

-- Changes between the buffers shown in two windows
---@param a integer window
---@param b integer window
function M.win_changes(a, b)
  return M.changes(vim.api.nvim_win_get_buf(a), vim.api.nvim_win_get_buf(b))
end

vim.api.nvim_create_autocmd("BufWipeout", {
  callback = function(args)
    for key in pairs(cache) do
      local a, b = key:match("^(%d+):(%d+)")
      if tonumber(a) == args.buf or tonumber(b) == args.buf then cache[key] = nil end
    end
  end,
})

-- Line in a -> line in b, through the changes from a to b
---@param line integer
---@param changes integer[][]
function M.map(line, changes)
  local offset = 0
  for _, h in ipairs(changes) do
    local as, ac, bs, bc = h[1], h[2], h[3], h[4]
    local a_first = ac == 0 and as + 1 or as
    if line < a_first then break end
    if ac > 0 and line < as + ac then
      return math.max(bc == 0 and bs + 1 or bs + math.min(line - as, bc - 1), 1)
    end
    offset = ((bc == 0 and bs + 1) or (bs + bc)) - ((ac == 0 and as + 1) or (as + ac))
  end
  return math.max(line + offset, 1)
end

-- The app presents a group's panes together (app/src/editor/mod.rs sync groups): config/app/layout.lua reports
-- each pane's group id, and after every sync `synced` tells it the toplines the panes now line up at, so a
-- frame never shows one pane moved and the other not yet.
local function app_layout()
  require("config.app.layout").sync()
end

---@param g integer[]
local function marker(g)
  local tops = {}
  for _, w in ipairs(g) do
    -- 0-based like the UI's win_viewport topline
    if vim.api.nvim_win_is_valid(w) then tops[#tops + 1] = { win = w, top = vim.fn.line("w0", w) - 1 } end
  end
  require("config.app.bridge").notify("sync", { event = "synced", group = ids[g], tops = tops })
end

---@param wins integer[]
function M.add(wins)
  groups[#groups + 1] = wins
  next_id = next_id + 1
  ids[wins] = next_id
  app_layout()
  marker(wins)
end

---@param wins integer[]
function M.remove(wins)
  groups = vim.tbl_filter(function(g) return g ~= wins end, groups)
  app_layout()
end

-- The sync group id of a window (nil: none)
---@param win integer
---@return integer?
function M.group_of(win)
  for _, g in ipairs(groups) do
    if vim.tbl_contains(g, win) then return ids[g] end
  end
end

-- Scroll a partner there line by line (Ctrl+E / Ctrl+Y) when it's a short way, so Neovim redraws it
-- with a grid scroll like the pane that moved (winrestview redraws the whole window: no rows kept for the app's
-- smooth scrolling, the partner couldn't move with the pane at the same sub-row offset). True when it got there
-- (a fold on the way, the end of the buffer: no; winrestview does it).
---@param other integer window
---@param target integer topline
local function scroll_rows(other, target)
  local from = vim.fn.line("w0", other)
  if math.abs(target - from) > vim.api.nvim_win_get_height(other) then return false end
  local down = target > from
  vim.api.nvim_win_call(other, function()
    for _ = 1, math.abs(target - from) do
      local w0 = vim.fn.line("w0")
      if w0 == target or (down and w0 > target) or (not down and w0 < target) then break end
      vim.cmd("normal! " .. (down and "\5" or "\25")) -- Ctrl+E / Ctrl+Y
      if vim.fn.line("w0") == w0 then break end -- can't go further
    end
  end)
  return vim.fn.line("w0", other) == target
end

local function sync(win)
  for _, g in ipairs(groups) do
    if vim.tbl_contains(g, win) then
      local top = vim.fn.line("w0", win)
      for _, other in ipairs(g) do
        if other ~= win and vim.api.nvim_win_is_valid(other) then
          local target = math.min(M.map(top, M.win_changes(win, other)), vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(other)))
          if vim.fn.line("w0", other) ~= target then
            if not scroll_rows(other, target) then
              vim.api.nvim_win_call(other, function()
                -- keep the cursor on screen, else Neovim scrolls back to it
                local so = vim.wo.scrolloff
                local last = vim.api.nvim_buf_line_count(0)
                local lnum = math.max(vim.fn.line("."), math.min(target + so, last))
                -- text rows (nvim_win_get_height counts the winbar too: the cursor ended up one row
                -- under the scrolloff margin and the pane scrolled by one)
                local rows = vim.fn.getwininfo(other)[1].height
                lnum = math.min(lnum, math.max(target + rows - 1 - so, target))
                vim.fn.winrestview({ topline = target, lnum = lnum })
              end)
            end
            moved[other] = vim.fn.line("w0", other)
          end
        end
      end
      marker(g)
    end
  end
end

-- Bring the other panes of win's group to it now (after a programmatic jump)
---@param win integer
function M.sync(win)
  busy = true
  pcall(sync, win)
  busy = false
end

-- The app's wheel / trackpad over a pane of a group: scroll it `lines` (+ = down the file) and its partners
-- with it in this one call, so nvim redraws them in the same flush.
---@param win integer
---@param lines integer
function M.scroll(win, lines)
  if lines == 0 or not vim.api.nvim_win_is_valid(win) then return end
  vim.api.nvim_win_call(win, function()
    vim.cmd("normal! " .. math.abs(lines) .. (lines > 0 and "\5" or "\25")) -- Ctrl+E / Ctrl+Y
  end)
  M.sync(win)
end

vim.api.nvim_create_autocmd("WinScrolled", {
  callback = function()
    if busy or #groups == 0 then return end
    local scrolled = {} ---@type integer[]
    for id, change in pairs(vim.v.event) do
      local win = tonumber(id)
      if win and change.topline ~= 0 and vim.api.nvim_win_is_valid(win) then
        if moved[win] == vim.fn.line("w0", win) then
          moved[win] = nil -- our own sync, don't bounce it back
        else
          scrolled[#scrolled + 1] = win
        end
      end
    end
    if #scrolled == 0 then return end
    -- the wheel scrolls the pane under the mouse, keys the focused pane; a resize while another window has focus
    -- (the Git window opening below) moves every pane: the pane last focused leads, so its caret stays put
    local source = wheel and vim.fn.getmousepos().winid or vim.api.nvim_get_current_win()
    if not vim.tbl_contains(scrolled, source) then
      local last = vim.fn.win_getid(vim.fn.winnr("#"))
      source = vim.tbl_contains(scrolled, last) and last or scrolled[1]
    end
    busy = true
    pcall(sync, source)
    busy = false
  end,
})

return M
