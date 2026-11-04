-- Diff / merge panes' line kinds. The app draws the gutters (numbers, » / « icons, gap lines, scrollbar
-- marks) itself from config/app/diff.lua's description; Lua keeps the kind of every line (git/merge.lua
-- colors the lines from them) and tells the app when they change.
local M = {}

---@class GitGutter
---@field only_hl string number highlight for lines only in this pane
---@field conflict? fun(lnum: integer): boolean conflict lines (merge)
---@field lines? table<integer, {hl: string}>
---@field key? string what lines was computed from (see key_of)

M.wins = {} ---@type table<integer, GitGutter>

local KIND_HL = {
  change = "GitDiffChangedNr",
  conflict = "GitDiffConflictNr",
}

local scrollsync = require("git.scrollsync")

-- What the gutter of win was last computed from: its buffer and the other diff windows' buffers
-- (diff_hlID depends on all of them), their changes, 'diffopt'
local function key_of(win)
  local parts = { vim.o.diffopt }
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(vim.api.nvim_win_get_tabpage(win))) do
    if vim.wo[w].diff then
      local b = vim.api.nvim_win_get_buf(w)
      parts[#parts + 1] = w .. "=" .. b .. "@" .. vim.api.nvim_buf_get_changedtick(b)
    end
  end
  return table.concat(parts, ",")
end

---@param win integer
function M.update(win)
  local g = M.wins[win]
  if not (g and vim.api.nvim_win_is_valid(win)) then return end
  local n = vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))
  local lines, names = {}, {}
  vim.api.nvim_win_call(win, function()
    for l = 1, n do
      local id = vim.fn.diff_hlID(l, 1)
      local kind ---@type string?
      if g.conflict and g.conflict(l) then
        kind = "conflict"
      elseif id ~= 0 then
        names[id] = names[id] or vim.fn.synIDattr(id, "name")
        kind = names[id] == "DiffAdd" and "only" or "change"
      end
      lines[l] = { hl = kind == "only" and g.only_hl or KIND_HL[kind] or "GitDiffNr" }
    end
  end)
  g.lines, g.key = lines, key_of(win)
  require("config.app.diff").changed()
end

function M.update_all()
  for win in pairs(M.wins) do M.update(win) end
end

---@param win integer
---@param opts GitGutter
function M.attach(win, opts)
  M.wins[win] = opts
  -- cells the app's native gutter / scrollbar marks paint over, the line number coded in the first one
  vim.wo[win].statuscolumn = require("config.app.diff").COLUMN
  M.update(win)
end

function M.detach(win) M.wins[win] = nil end

-- A click on folded unchanged code (wavy line) in a pane's text unfolds it in every pane
require("config.menu").zone(function(pos)
  if not M.wins[pos.winid] then return end
  local win, line = pos.winid, pos.line
  if vim.api.nvim_win_call(win, function() return vim.fn.foldclosed(line) end) == -1 then return end
  return function()
    for w in pairs(M.wins) do
      if vim.api.nvim_win_is_valid(w) and vim.wo[w].diff then
        local l = w == win and line or scrollsync.map(line, scrollsync.win_changes(win, w))
        vim.api.nvim_win_call(w, function() pcall(vim.cmd, l .. "foldopen") end)
      end
    end
  end
end)

-- Diff recomputed (it fires several times while a diff opens): one pass afterwards, and only for
-- gutters whose inputs changed
local queued = false
vim.api.nvim_create_autocmd("DiffUpdated", {
  callback = function()
    if queued or next(M.wins) == nil then return end
    queued = true
    vim.schedule(function()
      queued = false
      for win, g in pairs(M.wins) do
        if vim.api.nvim_win_is_valid(win) and g.key ~= key_of(win) then M.update(win) end
      end
    end)
  end,
})
vim.api.nvim_create_autocmd("WinClosed", {
  callback = function(args) M.wins[tonumber(args.match) or -1] = nil end,
})

return M
