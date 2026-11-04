return {
  -- vim-surround equivalent: ys, ds, cs
  { "kylechui/nvim-surround", version = "^3.0.0", event = "VeryLazy", opts = {} },

  -- Multiple cursors (same plugin family as terryma/vim-multiple-cursors)
  -- Multiple cursors, WebStorm style (see config/multicursor.lua)
  -- Loads on its first key (perf: it hooks SafeState / every key / every vim.cmd once loaded)
  {
    "jake-stewart/multicursor.nvim",
    branch = "1.0",
    keys = {
      { "<C-ö>", mode = { "n", "x", "i" }, desc = "Clone caret below" },
      { "<C-l>", mode = { "n", "x", "i" }, desc = "Clone caret above" },
      { "<C-n>", mode = { "n", "x" }, desc = "Add next occurrence" },
      { "<C-x>", mode = { "n", "x" }, desc = "Skip occurrence" },
    },
    config = function() require("config.multicursor").setup() end,
  },

  { "echasnovski/mini.pairs", event = "InsertEnter", opts = {} },
  -- JSX/HTML tag auto close / rename; loads on the first insert (perf: ~2 ms before the first screen otherwise)
  {
    "windwp/nvim-ts-autotag",
    event = "InsertEnter",
    config = function(_, opts)
      require("nvim-ts-autotag").setup(opts)
      -- it attaches on FileType (files opened later) and once on InsertEnter: also the files opened before it loaded
      local done = {}
      vim.api.nvim_create_autocmd("InsertEnter", {
        group = vim.api.nvim_create_augroup("ws_autotag", { clear = true }),
        callback = function(ev)
          if done[ev.buf] then return end
          done[ev.buf] = true
          require("nvim-ts-autotag.internal").attach(ev.buf)
        end,
      })
    end,
  },

  -- Syntax highlighting / parsing
  {
    "nvim-treesitter/nvim-treesitter",
    branch = "main",
    lazy = false,
    build = ":TSUpdate",
    config = function()
      require("nvim-treesitter").install(require("config.tools").parsers)
      -- Slim JS/TS injections (perf: nvim-treesitter's took ~40 ms to compile when the first JS/TS file opened,
      -- each pattern costs ms on the big TS grammar). Kept: JSDoc, regex and html`` / svg`` (parsers installed
      -- above). Dropped: sql, graphql, groq, glimmer, styled, angular, comment (no parser installed: they never
      -- colored anything), innerHTML strings and <style jsx>. Set as whole queries, not files: query files of the
      -- languages they inherit from would still be read.
      local INJECTIONS = [[
(((comment) @_jsdoc_comment
  (#lua-match? @_jsdoc_comment "^/[*][*][^*].*[*]/$")) @injection.content
  (#set! injection.language "jsdoc"))

((regex_pattern) @injection.content
  (#set! injection.language "regex"))

(call_expression
  function: (identifier) @_name
  (#any-of? @_name "html" "svg")
  arguments: [
    (arguments
      (template_string) @injection.content)
    (template_string) @injection.content
  ]
  (#offset! @injection.content 0 1 0 -1)
  (#set! injection.include-children)
  (#set! injection.language "html"))
]]
      for _, lang in ipairs({ "javascript", "typescript", "tsx" }) do
        vim.treesitter.query.set(lang, "injections", INJECTIONS)
      end

      -- Compiled queries stay alive: nvim caches them weakly, so after closing the last tsx file (or a picker
      -- preview) a GC meant compiling again (~55 ms for tsx highlights) for the next one
      local keep = {} ---@type table<string, vim.treesitter.Query|false>
      local function hold(lang, name)
        local key = lang .. "/" .. name
        if keep[key] == nil then
          local ok, q = pcall(vim.treesitter.query.get, lang, name)
          keep[key] = ok and q or false
        end
      end
      -- Injections (JSDoc, regex...) get parsed for the lines on screen only: every scroll parses the regions it
      -- brings in and redraws their lines, and when the new top line is one of them nvim redraws the whole window
      -- (Ctrl+D in a TSX file highlighted 35 lines instead of 19, before the frame; app/tests/perf.rs).
      -- So the whole buffer gets parsed once idle (async; ~5 ms for 3000 lines of TSX), and again after edits.
      local parse_pending = {} ---@type table<integer, true>
      local function parse_all(buf)
        if parse_pending[buf] then return end
        parse_pending[buf] = true
        vim.defer_fn(function()
          parse_pending[buf] = nil
          if not vim.treesitter.highlighter.active[buf] then return end
          local ok, parser = pcall(vim.treesitter.get_parser, buf)
          if ok and parser then parser:parse(true, function() end) end
        end, 300)
      end
      vim.api.nvim_create_autocmd({ "TextChanged", "InsertLeave" }, {
        callback = function(args)
          if vim.treesitter.highlighter.active[args.buf] then parse_all(args.buf) end
        end,
      })
      vim.api.nvim_create_autocmd("FileType", {
        callback = function(args)
          if pcall(vim.treesitter.start, args.buf) then
            vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
            local lang = vim.treesitter.language.get_lang(args.match)
            if lang then
              hold(lang, "highlights")
              hold(lang, "injections")
            end
            parse_all(args.buf)
          end
        end,
      })
      -- Compile the main languages' queries while idle, one per tick, so the first .ts / .tsx file (tab, tree,
      -- picker preview) and the first Enter (indents) don't wait for them (tsx 55 + 10 ms, typescript 45 + 7 ms)
      local WARM = {
        { "tsx", "highlights" }, { "tsx", "injections" }, { "tsx", "indents" },
        { "typescript", "highlights" }, { "typescript", "injections" }, { "typescript", "indents" },
        { "javascript", "highlights" }, { "javascript", "injections" },
      }
      local ns, last_key, i = vim.api.nvim_create_namespace("ws_ts_warm"), vim.uv.now(), 1
      vim.on_key(function() last_key = vim.uv.now() end, ns)
      local function step()
        if i > #WARM or vim.v.exiting ~= vim.NIL then return vim.on_key(nil, ns) end
        -- typing / not in normal mode: once idle again (CursorHold: Normal mode, 'updatetime' without keys), not
        -- a timer re-armed every 400 ms while typing
        if vim.uv.now() - last_key < 400 or vim.api.nvim_get_mode().mode ~= "n" then
          return vim.api.nvim_create_autocmd("CursorHold", { once = true, callback = function() vim.schedule(step) end })
        end
        hold(WARM[i][1], WARM[i][2])
        i = i + 1
        vim.defer_fn(step, 30)
      end
      vim.api.nvim_create_autocmd("User", { pattern = "VeryLazy", once = true, callback = function() vim.defer_fn(step, 1500) end })
    end,
  },

  -- Function text objects + MethodUp/MethodDown
  {
    "nvim-treesitter/nvim-treesitter-textobjects",
    branch = "main",
    event = "VeryLazy",
    config = function()
      require("nvim-treesitter-textobjects").setup({ select = { lookahead = true }, move = { set_jumps = true } })
      local select = require("nvim-treesitter-textobjects.select")
      local nxo = { "n", "x", "o" }
      -- Method up/down land on the function name (config/methods.lua)
      vim.keymap.set(nxo, "<leader>s", function() require("config.methods").jump(-1) end, { desc = "Method up / enclosing function name" })
      vim.keymap.set(nxo, "<leader>S", function() require("config.methods").jump(1) end, { desc = "Method down" })
      -- vaf / dif / yac etc.
      for key, obj in pairs({ af = "@function.outer", ["if"] = "@function.inner", ac = "@class.outer", ic = "@class.inner" }) do
        vim.keymap.set({ "x", "o" }, key, function() select.select_textobject(obj, "textobjects") end)
      end
    end,
  },
}
