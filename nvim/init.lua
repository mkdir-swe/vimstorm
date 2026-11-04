-- LuaJIT allocates machine code in small areas (32-64 KB) placed within branch range of the VM; on Apple Silicon
-- a new one often can't be placed, and each failure flushes every compiled trace (20 flushes in 40 Ctrl+D in a
-- TSX file: the highlighter kept running interpreted and recompiling). Bigger areas: no failures.
if jit then jit.opt.start("sizemcode=256", "maxmcode=4096") end

-- Leader must be set before plugins load
vim.g.mapleader = ","
vim.g.maplocalleader = "\\"

require("config.options")
require("config.keymaps")

-- Plain `nvim` (not the VimStorm app: $EDITOR, git commit, `nvim` typed in a terminal tab) only gets the
-- options, his vim keys and the colors; no plugins. Keys that need the app's modules fall back to built-ins.
if not vim.g.vimstorm_app then
  vim.keymap.set("n", "<Esc>", "<Cmd>nohlsearch<CR><Esc>")
  for _, lhs in ipairs({ "<leader>q", "<leader>e", "gh", "<leader>a" }) do pcall(vim.keymap.del, "n", lhs) end
  pcall(vim.keymap.del, "x", "<leader>a")
  -- options.lua's border glyphs are the app's (drawn as sprites); a terminal font would show box art
  vim.o.winborder = "rounded"
  vim.cmd.colorscheme("darcula-contrast")
  return
end

-- Each workspace its own ShaDa (marks, history, registers), by its folder: the app runs an nvim per
-- workspace, and at a quit they all wrote one main.shada at once (a torn one: E576 on the next read).
do
  local shada = vim.fn.stdpath("state") .. "/shada"
  vim.fn.mkdir(shada, "p")
  vim.o.shadafile = shada .. "/" .. vim.fn.getcwd():gsub("[/\\:]", "%%") .. ".shada"
end

-- line numbers / change bars / tooltips, then tab state + the status bar's content (the app draws them)
require("config.gutter")
require("config.empty_editor").setup()
require("config.tabbar").setup()
require("config.editor_tabs").setup()
require("config.statusline").setup()
require("config.autocmds")
-- a swap file left behind never stops a file opening at Vim's ATTENTION prompt
require("config.swap").setup()
-- the native tree's entry points: in package.loaded["snacks.explorer"] before snacks loads
require("config.tree")

-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.uv.fs_stat(lazypath) then
  vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", "https://github.com/folke/lazy.nvim.git", lazypath })
end
vim.opt.rtp:prepend(lazypath)

require("lazy").setup("plugins", {
  install = { colorscheme = { "darcula-contrast" } },
  change_detection = { notify = false },
  checker = { enabled = false }, -- no update checks (network) at startup; :Lazy update by hand
  rocks = { enabled = false }, -- no plugin needs luarocks
  performance = {
    rtp = {
      -- built-ins nobody uses here (the app's tree replaces netrw)
      disabled_plugins = { "gzip", "netrwPlugin", "rplugin", "tarPlugin", "tohtml", "tutor", "zipPlugin" },
    },
  },
})

vim.cmd.colorscheme("darcula-contrast")

require("config.webstorm")
-- the app's key bridge and keys (config/app.lua)
require("config.app").setup()
-- Feel vscode's chords over those keys (config/feel.lua decides when)
require("config.keymap_vscode").setup()
-- Reopen last open files when starting nvim in a project
require("config.session").setup()

-- Last: the key layers the Feel puts on the editor (config/feel_keys.lua): Vim mode off, stock Vim keys, and your
-- own nvim configs (the personal Layer's nvim/, your ~/.config/nvim) over all of VimStorm's
require("config.feel_keys").setup()
