-- Vim mode off (#131, the Feel's `editor.vim` false: Feel webstorm / vscode): the editor is always typing, as in
-- WebStorm without IdeaVim or VS Code. A file you can edit is in Insert mode whenever it has the caret (back in
-- it after anything that left it: a picker, a jump, a tab click, a search), Esc closes what is up (hover, the
-- error popup, the search highlight) and stays typing, Shift+arrows and the mouse select (Select mode: typing
-- replaces the selection, ⌘C / ⌘X / Backspace act on it; a Visual selection Lua makes, ⌘W's, turns into one too;
-- the Cmd / special keys mapped on a Visual selection act on it), arrows move in a read-only view and in the diff
-- / merge viewers (they keep Normal mode and their own keys). The WebStorm / VS Code Cmd keys are the same maps as
-- with Vim mode on (config/webstorm.lua, config/keymap_vscode.lua: they work in Insert mode). Undo goes word by
-- word; error underlines follow the typing. Vim mode on puts everything back exactly as before (the maps it
-- covered, the options). config/feel_keys.lua applies and removes it as the Feel's editor.vim says.
local M = {}

local GROUP = "ws_vimmode_off"

-- What was there before: { mode, lhs, maparg dict or false } and the options
local saved ---@type {[1]: string, [2]: string, [3]: table|false}[]?
local options ---@type table<string, any>?

-- Where the caret was in Insert mode just before it was left (Esc moves it one left): { win, buf, row, col }
local left_at ---@type {[1]: integer, [2]: integer, [3]: integer, [4]: integer}?

local function global_map(mode, lhs)
  local raw = vim.api.nvim_replace_termcodes(lhs, true, true, true)
  for _, m in ipairs(vim.api.nvim_get_keymap(mode)) do
    if m.lhsraw == raw then
      -- (nvim_get_keymap says a <Nop> map's rhs is "": mapset would restore a map that does what the key does)
      if m.rhs == "" and not m.callback then m.rhs = "<Nop>" end
      return m
    end
  end
  return false
end

-- A window whose file you type into: an editor split (not a diff / merge viewer's: its keys are Normal mode's),
-- modifiable, not the empty editor
---@param win integer
local function typing_win(win)
  if not vim.api.nvim_win_is_valid(win) then return false end
  if not require("config.focus").is_split(win) then return false end
  local buf = vim.api.nvim_win_get_buf(win)
  if not vim.bo[buf].modifiable or vim.bo[buf].readonly then return false end
  local empty = package.loaded["config.empty_editor"]
  return not (empty and empty.is_empty(buf))
end

-- Back to typing when Normal mode came back in a file you type into (nothing pending: a count, an operator, a
-- chord's second key, the command-line window)
function M.ensure()
  if not saved then return end
  if vim.api.nvim_get_mode().mode ~= "n" or vim.fn.getcmdwintype() ~= "" then return end
  if require("config.app").chord_waiting then return end
  -- keys still waiting (a mapping that leaves Insert mode and feeds its own `a` / `i`): theirs
  if vim.fn.getchar(1) ~= 0 then return end
  local win = vim.api.nvim_get_current_win()
  if not typing_win(win) then return end
  local buf = vim.api.nvim_win_get_buf(win)
  local row, col = unpack(vim.api.nvim_win_get_cursor(win))
  local line = vim.api.nvim_buf_get_lines(buf, row - 1, row, false)[1] or ""
  local at = left_at
  left_at = nil
  -- the caret where typing left it (leaving Insert mode moved it one left), if nothing moved it since
  -- (one character back: two bytes for å / ä / ö)
  local back = at and at[4] >= col and vim.fn.strchars(line:sub(col + 1, at[4])) <= 1
  if at and at[1] == win and at[2] == buf and at[3] == row and back then
    if at[4] >= #line then return vim.cmd("startinsert!") end
    vim.api.nvim_win_set_cursor(win, { row, at[4] })
  end
  vim.cmd.startinsert()
end

local function later() vim.schedule(M.ensure) end

-- Esc while typing: closes the hover / error popup and the search highlight, stays typing; with nothing up the
-- app hears it (a maximized split restores, #102), as Vim mode's Normal-mode Esc
local function esc()
  local ok, blink = pcall(require, "blink.cmp")
  if ok and blink.is_visible() then return blink.hide() end
  local sok, sug = pcall(require, "copilot.suggestion")
  if sok and sug.is_visible() then return sug.dismiss() end
  local mok, mc = pcall(require, "multicursor-nvim")
  if mok and mc.numCursors() > 1 then return mc.clearCursors() end
  require("config.editing").esc()
  vim.cmd.nohlsearch()
end

-- A Visual selection in a file you type into (Lua's `normal! v`, ⌘W) becomes a Select one: typing replaces it
local function to_select()
  vim.schedule(function()
    if not saved or vim.fn.getchar(1) ~= 0 then return end
    if not vim.api.nvim_get_mode().mode:match("^[vV\22]$") then return end
    if typing_win(vim.api.nvim_get_current_win()) then vim.api.nvim_feedkeys(vim.keycode("<C-g>"), "n", false) end
  end)
end

---@param mode string
---@param lhs string
---@param rhs string|function
---@param desc string
---@param remap? boolean
local function over(mode, lhs, rhs, desc, remap)
  saved[#saved + 1] = { mode, lhs, global_map(mode, lhs) }
  vim.keymap.set(mode, lhs, rhs, { desc = desc, buffer = false, remap = remap })
end

-- (`:behave mswin`'s: an exclusive selection, so ⇧→ from before a character selects just it)
local OPTIONS = { keymodel = "startsel,stopsel", selectmode = "mouse,key", selection = "exclusive" }

-- The global Visual-mode maps of special keys (⌘ keys, Tab, the right mouse button) with no Select-mode map of
-- their own: in Select mode they switch to Visual for the key (<C-g>), then back (to_select)
local function select_mirrors()
  local out = {}
  for _, m in ipairs(vim.api.nvim_get_keymap("x")) do
    if m.lhs:sub(1, 1) == "<" and m.lhs ~= "<Esc>" and not global_map("s", m.lhs) then out[#out + 1] = m.lhs end
  end
  return out
end

function M.apply()
  if saved then return later() end
  saved = {}
  options = {}
  for k, v in pairs(OPTIONS) do
    options[k] = vim.o[k]
    vim.o[k] = v
  end
  -- the error underlines follow the typing (Insert mode is all there is)
  options.update_in_insert = vim.diagnostic.config().update_in_insert or false
  vim.diagnostic.config({ update_in_insert = true })
  over("i", "<Esc>", esc, "Close popups (Vim mode off: stays typing)")
  -- Select all as a selection you type over (Vim mode's is a Visual one)
  over("i", "<D-a>", "<C-o>gg<C-o>0<C-o>vG$<C-g>", "Select all")
  over("n", "<D-a>", "gg0vG$<C-g>", "Select all")
  -- `:` types now: Command mode is WebStorm's Find Action key, ⌘⇧A (VS Code's ⌘⇧P too, keymap_vscode)
  for _, lhs in ipairs(select_mirrors()) do over("s", lhs, "<C-g>" .. lhs, "As in Visual mode", true) end
  -- undo word by word, as WebStorm (one Insert mode session would be one undo step)
  over("i", "<Space>", "<C-g>u<Space>", "Space (an undo step)")
  local command_mode = function() require("config.app.colon").open() end
  for _, mode in ipairs({ "n", "i", "x", "s" }) do
    for _, lhs in ipairs({ "<D-S-a>", "<D-A>" }) do over(mode, lhs, command_mode, "Command mode (Find Action)") end
  end
  -- arrows move in what stays in Normal mode (a read-only view; Vim mode's keymap turns them off there)
  for _, k in ipairs({ "<Up>", "<Down>", "<Left>", "<Right>" }) do
    over("n", k, k, "Move")
    over("x", k, "<Esc>" .. k, "Move")
  end
  vim.api.nvim_create_autocmd({ "BufEnter", "WinEnter", "FocusGained" }, {
    group = vim.api.nvim_create_augroup(GROUP, { clear = true }),
    callback = later,
  })
  vim.api.nvim_create_autocmd("ModeChanged", { group = GROUP, pattern = "*:n", callback = later })
  vim.api.nvim_create_autocmd("ModeChanged", { group = GROUP, pattern = { "*:v", "*:V", "*:\22" }, callback = to_select })
  vim.api.nvim_create_autocmd("InsertLeavePre", {
    group = GROUP,
    callback = function()
      local win = vim.api.nvim_get_current_win()
      local row, col = unpack(vim.api.nvim_win_get_cursor(win))
      left_at = { win, vim.api.nvim_get_current_buf(), row, col }
    end,
  })
  later()
end

function M.remove()
  if not saved then return end
  pcall(vim.api.nvim_del_augroup_by_name, GROUP)
  for i = #saved, 1, -1 do
    local mode, lhs, before = saved[i][1], saved[i][2], saved[i][3]
    pcall(vim.keymap.del, mode, lhs, { buffer = false })
    if before then vim.fn.mapset(before) end
  end
  for k, v in pairs(options or {}) do
    if k == "update_in_insert" then vim.diagnostic.config({ update_in_insert = v }) else vim.o[k] = v end
  end
  saved, options, left_at = nil, nil, nil
  if vim.api.nvim_get_mode().mode:sub(1, 1) == "i" then vim.cmd.stopinsert() end
end

-- Vim mode is off right now
function M.off() return saved ~= nil end

return M
