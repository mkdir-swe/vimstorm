-- Normal mode first: every move the app or a key makes (a tab click, the tree's Open, a picker's or the switcher's
-- pick, Problems, the Git window, a Chat file link, ⌥⌘← ⌃Tab ⌘O …) leaves whatever Neovim is in before it moves, as
-- clicking another file in WebStorm just goes there: the command line (`/` `?` `:` `::`; a search cancelled as Esc
-- cancels it, the caret back where it was in the file it was typed in), an operator waiting for its motion (`d`),
-- Insert / Visual / Select mode, the command-line window (`q:`). Left alone, Neovim keeps those across a window or
-- buffer change Lua makes: the command line stays open over the new file (and doesn't redraw the windows under
-- it, so the move looked like nothing happened), a pending `d` waits to act on it.
--
-- `run(fn, ...)` runs at once in Normal mode, after Insert / Visual mode is left; from the command line, an
-- operator, Select mode or a prompt it queues `fn` and types the keys that leave it, then runs the queue in Normal
-- mode, in order. Rust's moves come through `call` (app/src/nvim/lua `navigate`, which also takes Esc to a
-- blocking prompt, hit-enter / -- More -- / confirm(), where Lua can't run); the keys that act anywhere through
-- `again` (config/webstorm.lua). An error is a balloon, never nothing.
local M = {}

local queue = {} ---@type {fn: function, args: table}[]
-- bumped by every run of the queue: a give-up timer of an older batch does nothing
local batch = 0

local LEAVE = vim.keycode("<C-\\><C-n>")
local RESUME = vim.keycode("<Cmd>lua require('config.app.normal').resume()<CR>")
-- how long the keys that leave a mode get before the queue runs anyway (or says why it can't)
local GIVE_UP_MS = 1000

-- The balloon says the error's first line, without its file and line (the traceback goes to :messages' log)
---@param err any
local function report(err)
  local msg = tostring(err)
  local first = (msg:match("E%d+:[^\n]*") or msg:match("^[^\n]*")):gsub("^[^\n]-:%d+: ", "")
  vim.notify(first, vim.log.levels.ERROR, { title = "Couldn't go there" })
end

-- times `resume` typed the leaving keys again (a prompt after the command line)
local retries = 0

local function stuck_report()
  report(("Neovim stayed in mode %q, nothing moved: Esc, then again"):format(vim.api.nvim_get_mode().mode))
end

local function invoke(item)
  local ok, err = xpcall(item.fn, debug.traceback, unpack(item.args, 1, item.args.n))
  if not ok then report(err) end
end

--- What Neovim is in that a move has to leave by typing keys (nil: nothing, or only Insert / Visual mode, which
--- `run` leaves at once). Returns the keys that leave it.
---@return string?
function M.pending()
  if vim.fn.getcmdwintype() ~= "" then return vim.keycode("<C-c>") .. LEAVE end
  local mode = vim.api.nvim_get_mode().mode
  local c = mode:sub(1, 1)
  -- hit-enter / -- More -- / confirm(): Esc answers them (`<C-\><C-n>` would run its <C-n> after)
  if c == "r" then return vim.keycode("<Esc>") end
  if c == "c" or c == "t" or mode:match("^no") or mode:match("^ni") or c == "s" or c == "S" or c == "\19" then
    return LEAVE
  end
end

local function run_queue()
  batch = batch + 1
  local items = queue
  queue = {}
  for _, item in ipairs(items) do
    invoke(item)
  end
end

--- `fn(...)` in Normal mode (see the module's head).
---@param fn function
function M.run(fn, ...)
  local item = { fn = fn, args = { n = select("#", ...), ... } }
  if #queue > 0 then
    queue[#queue + 1] = item
    return
  end
  local keys = M.pending()
  if not keys then
    local mode = vim.api.nvim_get_mode().mode
    if mode:match("^[iR]") then
      vim.cmd.stopinsert()
    elseif mode:match("^[vV\22]") then
      vim.cmd("normal! \27")
    end
    return invoke(item)
  end
  queue[1] = item
  vim.api.nvim_feedkeys(keys .. RESUME, "n", false)
  local mine = batch
  vim.defer_fn(function()
    if mine ~= batch or #queue == 0 then return end
    -- the keys never came through (a mapping's error flushed them): still stuck says so, else go
    retries = 0
    if M.pending() then
      queue = {}
      batch = batch + 1
      return stuck_report()
    end
    run_queue()
  end, GIVE_UP_MS)
end

--- The keys that left the mode came through: the queue runs.
function M.resume()
  local keys = M.pending()
  if keys and retries < 2 then
    -- a prompt came up meanwhile (leaving the command line said something): leave it too
    retries = retries + 1
    return vim.api.nvim_feedkeys(keys .. RESUME, "n", false)
  end
  retries = 0
  if keys then
    queue = {}
    batch = batch + 1
    return stuck_report()
  end
  run_queue()
end

--- Rust -> Lua (app/src/nvim/lua `navigate`): `require(module)[func](...)` in Normal mode.
---@param module string
---@param func string
function M.call(module, func, ...)
  M.run(function(...)
    local f = require(module)[func]
    if type(f) ~= "function" then error(("%s has no %s"):format(module, func), 0) end
    return f(...)
  end, ...)
end

--- A keymap's rhs for the command line and an operator pending (config/webstorm.lua): Normal mode, then `lhs`
--- again, as it is mapped there.
---@param lhs string
---@return function
function M.again(lhs)
  local keys = vim.keycode(lhs)
  return function()
    M.run(function() vim.api.nvim_feedkeys(keys, "m", false) end)
  end
end

return M
