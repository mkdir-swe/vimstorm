-- The editor's installed tools, one list for everything that installs them: the treesitter parsers
-- (plugins/editor.lua at start, config/warmup.lua: app/scripts/warmup.sh on a Mac and the workspace image's warm-up in
-- abe/images/base) and Mason's packages with the command each puts in mason/bin (the warm-ups;
-- plugins/lsp.lua's SERVERS name the same servers by their lspconfig names).
return {
  parsers = {
    "javascript", "typescript", "tsx", "jsdoc", "json", "html", "css", "scss",
    "lua", "markdown", "markdown_inline", "yaml", "bash", "regex", "vim", "vimdoc",
    -- colors in the app's picker previews / Find in Files come from treesitter only
    "rust", "toml", "python", "go",
  },
  mason = {
    { package = "vtsls", bin = "vtsls" },
    { package = "eslint-lsp", bin = "vscode-eslint-language-server" },
    { package = "json-lsp", bin = "vscode-json-language-server" },
    { package = "html-lsp", bin = "vscode-html-language-server" },
    { package = "css-lsp", bin = "vscode-css-language-server" },
    { package = "lua-language-server", bin = "lua-language-server" },
    { package = "yaml-language-server", bin = "yaml-language-server" },
    { package = "prettierd", bin = "prettierd" },
  },
}
