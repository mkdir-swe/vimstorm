-- Stock Vim's keys (#214, config/feel.lua `stock_keys`: Feel vim, and webstorm / vscode with Vim mode turned on):
-- VimStorm's own Vim keys come off the editor (config/keymaps.lua's ideavimrc port: k l ö ä, h / j / the arrows
-- turned off, s, the z register, Tab indents ...; Esc stays: it closes the app's hover / error popups) and so does
-- every map on VimStorm's leader `,`, global or a buffer's (Snacks' ,f…, gitsigns' ,c…, ,v ...), and its caret keys
-- (⌃ö ⌃l ⌃n ⌃x): h j k l move, `,`
-- repeats f / t backwards and the leader is Vim's `\` unless your config (config/userconfig.lua) sets one. The
-- WebStorm / VS Code Cmd keys stay. Off again (Feel vimstorm) puts every one of them back as it was.
--
-- VimStorm's leader is `,` whatever g:mapleader says: `vim.keymap.set` (wrapped here) turns <leader> in a map VimStorm
-- makes (its config, its plugins as lazy.nvim loads them) into `,`, and a `,` map VimStorm makes while stock keys are
-- on is held back until they come off. A map your own config makes (userconfig.origin) is left as it is: your leader.
local M = {}

local MODES = { "n", "x", "s", "o" }

local raw_set = vim.keymap.set

-- What stock keys took off: { mode, maparg dict, buf? }, and what VimStorm mapped on `,` since: keymap.set's args
local saved ---@type {[1]: string, [2]: table, [3]: integer?}[]?
local held = {} ---@type {[1]: string|string[], [2]: string, [3]: string|function, [4]: table?}[]
local leader_before ---@type {[1]: string?}?

---@param buf integer? nil: global
local function find(mode, lhs, buf)
  local raw = vim.api.nvim_replace_termcodes(lhs, true, true, true)
  local list = buf and vim.api.nvim_buf_get_keymap(buf, mode) or vim.api.nvim_get_keymap(mode)
  for _, m in ipairs(list) do
    if m.lhsraw == raw or m.lhs == lhs then
      -- (a <Nop> map's rhs reads ""; mapset would restore one that does what the key does)
      if m.rhs == "" and not m.callback then m.rhs = "<Nop>" end
      return m
    end
  end
end

local function take(mode, lhs, buf)
  local m = find(mode, lhs, buf)
  if not m then return end
  -- a key of yours (config/keys.lua, keys.json) stays yours
  local keys = not buf and package.loaded["config.keys"]
  if keys and keys.before and keys.before(mode, lhs) ~= nil then return end
  saved[#saved + 1] = { mode, m, buf }
  if buf then
    pcall(vim.api.nvim_buf_del_keymap, buf, mode, m.lhs)
  else
    pcall(vim.api.nvim_del_keymap, mode, m.lhs)
  end
end

local function leader_map(lhs) return lhs:sub(1, 1) == "," and #lhs > 1 end

-- VimStorm's multi-caret keys built on its own moves (config/multicursor.lua, plugins/editor.lua): ⌃ö / ⌃l clone
-- the caret below / above, ⌃n / ⌃x IdeaVim's multiple-cursors; stock Vim's ⌃l redraws, ⌃x decrements, ⌃n moves
local CARETS = { ["<C-ö>"] = { "n", "x", "i" }, ["<C-l>"] = { "n", "x", "i" }, ["<C-n>"] = { "n", "x" }, ["<C-x>"] = { "n", "x" } }

-- A key VimStorm's stock Vim keys leave Vim's: its `,` leader maps and the caret keys
local function vimstorm_only(mode, lhs)
  if leader_map(lhs) then return true end
  local modes = CARETS[lhs]
  if not modes then return false end
  for _, m in ipairs(type(mode) == "table" and mode or { mode }) do
    if vim.tbl_contains(modes, m) then return true end
  end
  return false
end

-- Stock keys are on
function M.on() return saved ~= nil end

function M.apply()
  if saved then return end
  saved = {}
  for _, e in ipairs(require("config.keymaps").maps) do
    if e[2] ~= "<Esc>" then take(e[1], e[2]) end
  end
  for lhs, modes in pairs(CARETS) do
    for _, mode in ipairs(modes) do take(mode, lhs) end
  end
  for _, mode in ipairs(MODES) do
    for _, m in ipairs(vim.api.nvim_get_keymap(mode)) do
      if leader_map(m.lhs) then take(mode, m.lhs) end
    end
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_loaded(buf) then
        for _, m in ipairs(vim.api.nvim_buf_get_keymap(buf, mode)) do
          if leader_map(m.lhs) then take(mode, m.lhs, buf) end
        end
      end
    end
  end
  leader_before = { vim.g.mapleader }
  vim.g.mapleader = nil
end

function M.remove()
  if not saved then return end
  vim.g.mapleader = leader_before and leader_before[1] or ","
  for i = #saved, 1, -1 do
    local mode, m, buf = saved[i][1], saved[i][2], saved[i][3]
    if not buf then
      vim.fn.mapset(mode, false, m)
    elseif vim.api.nvim_buf_is_valid(buf) then
      vim.api.nvim_buf_call(buf, function() vim.fn.mapset(mode, false, m) end)
    end
  end
  for _, h in ipairs(held) do
    local buf = h[4] and h[4].buffer
    if not (type(buf) == "number" and buf ~= 0 and not vim.api.nvim_buf_is_valid(buf)) then
      pcall(raw_set, h[1], h[2], h[3], h[4])
    end
  end
  saved, held, leader_before = nil, {}, nil
end

local function global(opts) return not (opts and opts.buffer ~= nil and opts.buffer ~= false) end

local function vimstorm_lhs(lhs) return (lhs:gsub("<[Ll][Ee][Aa][Dd][Ee][Rr]>", ",")) end

-- vim.keymap.set: your config's maps as they are (and noted, to come off with it); VimStorm's with <leader> as `,`,
-- a `,` one (and a caret key) held back while stock keys are on
local function set(mode, lhs, rhs, opts)
  local user = package.loaded["config.userconfig"]
  local own = user and type(lhs) == "string" and user.origin()
  if own then
    user.track(own, mode, lhs, opts)
    return raw_set(mode, lhs, rhs, opts)
  end
  if type(lhs) ~= "string" then return raw_set(mode, lhs, rhs, opts) end
  lhs = vimstorm_lhs(lhs)
  if user and global(opts) then user.vimstorm_made(mode, lhs) end
  if saved and vimstorm_only(mode, lhs) then
    local o = opts and vim.deepcopy(opts) or nil
    -- a buffer-local map for the buffer it was made in (0 = the current one then)
    if o and (o.buffer == 0 or o.buffer == true) then o.buffer = vim.api.nvim_get_current_buf() end
    held[#held + 1] = { mode, lhs, rhs, o }
    return
  end
  return raw_set(mode, lhs, rhs, opts)
end

local raw_del = vim.keymap.del

-- vim.keymap.del: VimStorm's <leader> is `,` here too (lazy.nvim deleting a key stub must not take your <leader>
-- map of the same name); a key held back is dropped from what comes back
local function del(mode, lhs, opts)
  local user = package.loaded["config.userconfig"]
  if type(lhs) ~= "string" or (user and user.origin()) then return raw_del(mode, lhs, opts) end
  lhs = vimstorm_lhs(lhs)
  if saved and vimstorm_only(mode, lhs) then
    for i = #held, 1, -1 do
      if held[i][2] == lhs and vim.deep_equal(held[i][1], mode) then table.remove(held, i) end
    end
  end
  return raw_del(mode, lhs, opts)
end

-- From config/feel_keys.lua's setup (init.lua, after VimStorm's own maps are made)
function M.install()
  vim.keymap.set = set
  vim.keymap.del = del
end

return M
