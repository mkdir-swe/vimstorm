-- The editor's key layers the Feel puts on (#131, #214), over VimStorm's own (config/keymaps.lua, config/webstorm.lua,
-- config/app.lua; Feel vscode's chords are config/keymap_vscode.lua's):
--   Vim mode off  editor.vim false (Feel webstorm / vscode): always typing (config/vimmode.lua)
--   stock keys    Vim mode on under any Feel but vimstorm: Vim's own keys, no leader `,` (config/stockvim.lua)
--   your configs  the personal Layer's nvim/ under Feel vimstorm and vim, your ~/.config/nvim under Feel vim, below
--                 it (config/userconfig.lua)
-- A Feel switch takes your configs off before anything else changes (feel.lua's "first" listeners) and puts them on
-- after everything else did ("last"), so each loads over the keys it is meant for and comes off leaving them as they
-- were; Vim mode off and stock keys never both: each comes off before the other goes on.
local M = {}

local state ---@type {off: boolean, stock: boolean, configs: string[]}?
-- What the Feel wants before VimStorm's plugins are all up (User VeryLazy): applied then, so your configs load
-- over every VimStorm key (InsertEnter / VeryLazy plugins' too)
local pending ---@type {off: boolean, stock: boolean, configs: string[]}?
local up = false

---@param f Feel
local function want(f)
  local configs = f.feel == "vim" and { "user", "personal" } or f.feel == "vimstorm" and { "personal" } or {}
  return { off = f.editor.vim == false, stock = require("config.feel").stock_keys(f), configs = configs }
end

local function apply(w)
  local vimmode = require("config.vimmode")
  -- (any Feel change brings typing back where Vim mode is off)
  if state and vim.deep_equal(state, w) then return w.off and vimmode.apply() end
  local user = require("config.userconfig")
  local stock = require("config.stockvim")
  user.unload_all()
  if not w.off then vimmode.remove() end
  if w.stock then stock.apply() else stock.remove() end
  if w.off then vimmode.apply() end
  for _, name in ipairs(w.configs) do
    local ok, err = pcall(user.load, name)
    if not ok then vim.schedule(function() vim.notify(tostring(err), vim.log.levels.ERROR, { title = "Your nvim config" }) end) end
  end
  user.tell_lingering()
  state = w
end

-- lazy.nvim's change check warns "set vim.g.mapleader BEFORE loading lazy" when the leader is not the one it started
-- with (#229): a switch changes it on purpose (stock keys' `\`, your config's own, `,` back), so lazy is told it
local function tell_lazy()
  local ok, lazy = pcall(require, "lazy.core.config")
  if ok then lazy.mapleader, lazy.maplocalleader = vim.g.mapleader, vim.g.maplocalleader end
end

local function go(w)
  if not up then
    pending = w
    return
  end
  local ok, err = pcall(apply, w)
  tell_lazy()
  if not ok then vim.notify(tostring(err), vim.log.levels.ERROR, { title = "Feel" }) end
end

-- The Feel the app started this nvim with (app/src/shell/projects/mod.rs: VIMSTORM_FEEL, VIMSTORM_FEEL_VIM), so a
-- project's nvim never loads a config of yours its Feel has none of before the app's `feel.set` arrives; none (no
-- Feel known yet, the headless tests): the app's first set says
local function started_with()
  local name = vim.env.VIMSTORM_FEEL
  if not name or name == "" then return nil end
  return want({ feel = name, editor = { vim = vim.env.VIMSTORM_FEEL_VIM ~= "0" } })
end

-- From init.lua, last: once VimStorm's config is all up
function M.setup()
  require("config.stockvim").install()
  local feel = require("config.feel")
  feel.on_change(function(f)
    if state and not vim.deep_equal(state, want(f)) then require("config.userconfig").unload_all() end
  end, "first")
  feel.on_change(function(f) go(want(f)) end, "last")
  pending = started_with()
  vim.api.nvim_create_autocmd("User", {
    pattern = "VeryLazy",
    once = true,
    callback = function()
      up = true
      if pending then go(pending) end
      pending = nil
    end,
  })
end

return M
