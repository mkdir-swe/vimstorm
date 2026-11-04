return {
  -- Copilot grey inline suggestions. Tab accepts (wired in blink.cmp keymap). Run :Copilot auth once.
  {
    "zbirenbaum/copilot.lua",
    cmd = "Copilot",
    event = "InsertEnter",
    init = function()
      -- Loaded a few seconds after startup while idle in normal mode (perf: the first `o` / `i` otherwise waited
      -- ~10 ms for copilot + the tag closer to load); InsertEnter still loads them when that comes first
      vim.api.nvim_create_autocmd("User", {
        pattern = "VeryLazy",
        once = true,
        callback = function()
          vim.defer_fn(function()
            if vim.v.exiting ~= vim.NIL or vim.api.nvim_get_mode().mode ~= "n" then return end
            require("lazy").load({ plugins = { "copilot.lua", "nvim-ts-autotag", "mini.pairs" } })
          end, 3000)
        end,
      })
    end,
    opts = {
      suggestion = { enabled = true, auto_trigger = true, keymap = { accept = false } },
      panel = { enabled = false },
      filetypes = { markdown = true, yaml = true, gitcommit = true },
    },
  },
}
