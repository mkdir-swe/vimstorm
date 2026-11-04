-- Windows side by side that keep their shares of the width they span, like WebStorm's splitters keep their
-- proportion: the layout around them changes (window resized, tree opened) -> each keeps its share; a divider
-- between them moved (dragged, <C-w>< / >, :vertical resize) leaves their total as it was -> the new widths are
-- the new shares. None narrower than M.MIN columns while the total has room. The markdown editor + preview pair
-- (config/markdown.lua) and the diff / merge viewers' panes (git/diff.lua, git/merge.lua).
local M = {}

M.MIN = 20 -- least columns of each window (~160 pt at the editor font's ~8 pt cell)

local live = setmetatable({}, { __mode = "k" }) ---@type table<Shares, true> (gone with their owner's state)

---@class Shares
---@field wins integer[] left to right, one row
---@field shares number[] each window's share of their total width (sums to 1)
---@field widths integer[] their widths when last seen

---@param n integer
---@return number[]
function M.equal(n)
  local out = {}
  for i = 1, n do out[i] = 1 / n end
  return out
end

---@param t integer[]
local function sum(t)
  local n = 0
  for _, v in ipairs(t) do n = n + v end
  return n
end

---@param s Shares
local function valid(s)
  for _, w in ipairs(s.wins) do
    if not vim.api.nvim_win_is_valid(w) then return false end
  end
  return true
end

---@param s Shares
---@return integer[]
local function widths(s)
  local out = {}
  for i, w in ipairs(s.wins) do out[i] = vim.api.nvim_win_get_width(w) end
  return out
end

-- The least each of n windows keeps of `total` columns
---@param total integer
---@param n integer
function M.least(total, n)
  return math.max(1, math.min(M.MIN, math.floor(total / n)))
end

-- Widths for `shares` of `total` columns: each edge rounded where the shares put it (the widths add up to
-- the total), each width at least its least
---@param shares number[]
---@param total integer
---@return integer[]
function M.widths_for(shares, total)
  local n = #shares
  local least = M.least(total, n)
  local out, used, acc = {}, 0, 0
  for i = 1, n - 1 do
    acc = acc + shares[i]
    local w = math.floor(total * acc + 0.5) - used
    w = math.max(least, math.min(w, total - used - least * (n - i)))
    out[i], used = w, used + w
  end
  out[n] = total - used
  return out
end

---@param ws integer[]
---@return number[]
local function shares_of(ws)
  local total = math.max(sum(ws), 1)
  local out = {}
  for i, w in ipairs(ws) do out[i] = w / total end
  return out
end

-- Left to right, so each takes its room from the window right of it
---@param s Shares
---@param want integer[]
local function set(s, want)
  for i = 1, #s.wins - 1 do
    if vim.api.nvim_win_get_width(s.wins[i]) ~= want[i] then vim.api.nvim_win_set_width(s.wins[i], want[i]) end
  end
  s.widths = widths(s)
end

-- The windows at their shares now
---@param s Shares
function M.apply(s)
  if valid(s) then set(s, M.widths_for(s.shares, sum(widths(s)))) end
end

-- Windows `wins` (left to right, side by side) keep `shares` (default: equal), from now on at them
---@param wins integer[]
---@param shares? number[]
---@return Shares
function M.new(wins, shares)
  local s = { wins = wins, shares = shares and #shares == #wins and shares or M.equal(#wins), widths = {} }
  live[s] = true
  M.apply(s)
  return s
end

-- Every one with all its windows back at its shares: after another module resized windows by its own rule
-- (config/bottom.lua's proportional relayout), which their next WinResized must not take for a drag
function M.apply_all()
  for s in pairs(live) do M.apply(s) end
end

-- Back to equal widths
---@param s Shares
function M.reset(s)
  s.shares = M.equal(#s.wins)
  M.apply(s)
end

-- After WinResized: the same total -> a divider between them moved, the widths (each at least its least) are
-- the new shares; another total -> each back at its share. True when the shares changed.
---@param s Shares
---@return boolean
function M.update(s)
  if not valid(s) then return false end
  local now = widths(s)
  if vim.deep_equal(now, s.widths) then return false end
  local total = sum(now)
  if total ~= sum(s.widths) then
    set(s, M.widths_for(s.shares, total))
    return false
  end
  local want = M.widths_for(shares_of(now), total)
  s.shares = shares_of(want)
  set(s, want)
  return true
end

return M
