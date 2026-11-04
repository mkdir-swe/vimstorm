return {
  -- Picker engine (native pickers + the ,fd ,fk ,fh fallbacks), notifier state, lazygit command, rename, words
  {
    "folke/snacks.nvim",
    priority = 1000,
    lazy = false,
    init = function()
      -- vim.ui.input (Rename, Move/Rename file...): the app's native field (app/src/popups), which opens with
      -- the value selected like WebStorm
      vim.api.nvim_create_autocmd("User", {
        pattern = "VeryLazy",
        once = true,
        callback = function() vim.ui.input = require("config.app.input").input end,
      })
      -- Always show the file tree on the left, keep cursor in the editor
      vim.api.nvim_create_autocmd("VimEnter", {
        callback = function()
          if #vim.api.nvim_list_uis() == 0 then return end
          vim.schedule(function()
            if not require("config.session").tree_open() then return end -- closed last time
            require("config.tree").open(false)
          end)
        end,
      })
    end,
    opts = {
      -- Snacks.picker.<source>() of the searches the app draws opens its native picker (config/app/pickers.lua);
      -- the rest (,fd ,fk ,fh) stay snacks pickers in Neovim floats
      picker = {
        ui_select = false, -- vim.ui.select is the WebStorm popup (config/menu.lua -> config/app/menu.lua)
        win = {
          -- Your movement keys inside picker lists
          list = { keys = { ["ö"] = "list_down", ["l"] = "list_up" } },
          -- Esc closes right away, like a WebStorm popup
          input = { keys = { ["<Esc>"] = { "cancel", mode = { "i", "n" } } } },
        },
      },
      lazygit = {}, -- ,G builds its command (config/app/terminal.lua)
      -- The notifier keeps levels, ids, history and timeouts; the balloons are native (config/app/balloon.lua)
      notifier = {
        sort = { "added" },
        timeout = 4000,
        filter = function(notif) return require("config.app.balloon").filter(notif) end,
      },
      indent = { enabled = false }, -- no indent guides (off in his WebStorm); off here so its scope tracker doesn't run on every cursor move
      input = { enabled = false }, -- vim.ui.input is the app's native field (see init)
      bigfile = {},
      quickfile = {},
      words = {}, -- highlight other references of word under cursor
    },
    keys = {
      -- Find (Search Everywhere is Shift Shift: config/doubleshift.lua)
      { "<leader>/", function() Snacks.picker.grep() end, desc = "Find in files" },
      { "<leader>fb", function() Snacks.picker.buffers() end, desc = "Buffers" },
      { "<leader>fr", function() Snacks.picker.recent() end, desc = "Recent files" },
      { "<leader>fs", function() Snacks.picker.lsp_workspace_symbols() end, desc = "Symbols" },
      { "<leader>fd", function() Snacks.picker.diagnostics() end, desc = "Problems" },
      { "<leader>fk", function() Snacks.picker.keymaps() end, desc = "Keymaps" },
      { "<leader>fh", function() Snacks.picker.help() end, desc = "Help" },
      -- LSP navigation
      { "gy", function() Snacks.picker.lsp_type_definitions() end, desc = "Go to type definition" },
      { "grr", function() require("config.usages").usages() end, nowait = true, desc = "Find usages (popup)" },
      { "gri", function() Snacks.picker.lsp_implementations() end, desc = "Implementations" },
      -- Project view
      { "<leader>g", function() require("config.tree").reveal_file() end, desc = "Select file in project view" },
      { "<leader>E", function() require("config.tree").toggle() end, desc = "Toggle explorer" },
      -- Files / editors
      { "<leader>w", function() require("config.focus").close_file() end, desc = "Close tab" },
      { "<leader>o", function() require("config.editor_tabs").close_others() end, desc = "Close other tabs" },
      { "<leader>re", function() Snacks.rename.rename_file() end, desc = "Move/rename file (updates imports)" },
      -- lazygit in a native floating terminal (config/app/terminal.lua)
      { "<leader>G", function() require("config.app.terminal").lazygit() end, desc = "Lazygit" },
      -- the app's native key help (app/src/popups/keyhelp.rs)
      { "<leader>?", function() require("config.app.keyhelp").show() end, desc = "Show , shortcuts" },
    },
    config = function(_, opts)
      require("snacks").setup(opts)
      require("config.app.balloon").setup()
    end,
  },

  -- File type icons (tree, pickers, tabs): WebStorm's New UI set, config/icons.lua
  {
    "nvim-mini/mini.icons",
    lazy = false,
    opts = function() return require("config.icons").opts() end,
    config = function(_, opts) require("config.icons").setup(opts) end,
    init = function()
      package.preload["nvim-web-devicons"] = function()
        require("mini.icons").mock_nvim_web_devicons()
        return package.loaded["nvim-web-devicons"]
      end
    end,
  },

  -- Editor tabs and status bar: config/editor_tabs.lua + config/tabbar.lua, config/statusline.lua (no plugin).
  -- Markdown preview: config/markdown.lua (set up by config/app.lua), drawn natively (app/src/editor/markdown).

  -- Git gutter + blame (Annotate)
  {
    "lewis6991/gitsigns.nvim",
    -- right after the first screen (perf: ~6 ms before it otherwise); it attaches to the files already open
    event = "VeryLazy",
    opts = {
      -- WebStorm change markers: the app paints WebStorm's bars itself from the signs' hl groups
      -- (app/src/git/annotate), so the signs are blank
      signs = {
        add = { text = " " }, change = { text = " " }, changedelete = { text = " " },
        delete = { text = " " }, topdelete = { text = " " }, untracked = { text = " " },
      },
      signs_staged = {
        add = { text = " " }, change = { text = " " }, changedelete = { text = " " },
        delete = { text = " " }, topdelete = { text = " " },
      },
      attach_to_untracked = false, -- no markers in unversioned files
      on_attach = function(buf)
        local gs = require("gitsigns")
        local map = function(l, r, desc) vim.keymap.set("n", l, r, { buffer = buf, desc = desc }) end
        map("]h", function() gs.nav_hunk("next") end, "Next change")
        map("[h", function() gs.nav_hunk("prev") end, "Prev change")
        map("<leader>cp", gs.preview_hunk, "Preview change")
        map("<leader>cr", gs.reset_hunk, "Rollback change")
      end,
    },
  },
}
