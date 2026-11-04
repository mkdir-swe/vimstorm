-- Ported from ~/.ideavimrc. Plugin/LSP keymaps live in lua/plugins/*. These are Feel vimstorm's Vim keys: under
-- stock Vim keys (Feel vim, config/stockvim.lua) every one of them comes off but Esc.
local M = {}

-- Every map made here: { mode, lhs }
M.maps = {} ---@type {[1]: string, [2]: string}[]

local function map(modes, lhs, rhs, opts)
  vim.keymap.set(modes, lhs, rhs, opts)
  for _, m in ipairs(type(modes) == "table" and modes or { modes }) do M.maps[#M.maps + 1] = { m, lhs } end
end
local nx = { "n", "x" }
local nxo = { "n", "x", "o" }

-- Don't use Ex mode, use Q for formatting (not in Select mode: there Q types over the selection)
map(nxo, "Q", "gq")

-- § = end of line, ° = start of line
map(nxo, "§", "$")
map(nxo, "°", "^")

-- Movement: k=left, l=up, ö=down, ä=right (also after operators: d, c, y)
map(nxo, "k", "h")
map(nxo, "l", "k")
map(nxo, "ö", "j")
map(nxo, "ä", "l")
map(nx, "h", "<Nop>")
map(nx, "j", "<Nop>")

-- Move 5 at a time + center
map(nx, "K", "5hzz")
map(nx, "L", "5kzz")
map(nx, "Ö", "5jzz")
map(nx, "Ä", "5lzz")
map("n", "H", "5hzz")
map("n", "J", "5jzz")

-- Center when half-page scrolling
map("n", "<C-d>", "<C-d>zz")
map("n", "<C-u>", "<C-u>zz")

-- Esc clears search highlight and closes the hover / error popup (gh, ,e), like WebStorm; with
-- nothing to do the app hears it (a maximized split restores, #102)
map("n", "<Esc>", "<Cmd>lua require('config.editing').esc()<CR><Cmd>nohlsearch<CR><Esc>")

-- Better find
map("n", "s", "/")

-- Deletes/changes go to register z so they don't clobber the clipboard (typing over a Select-mode
-- selection: config/editing.lua). y and p use the clipboard; <leader>p pastes last delete.
for _, k in ipairs({ "d", "x", "X", "c", "D", "C" }) do
  map(nx, k, '"z' .. k)
end
map(nx, "<Del>", '"zx') -- ("z<Del> drops the register)
map("n", "S", '"zS') -- (visual S is nvim-surround's)
for _, k in ipairs({ "s", "R" }) do map("x", k, '"z' .. k) end -- (normal s is search, normal R types over)
map(nx, "<leader>p", '"zp', { desc = "Paste last delete" })
map(nx, "<leader>P", '"zP', { desc = "Paste last delete before" })
-- Pasting over a selection keeps the clipboard intact
map("x", "p", "P")

-- Indent with Tab
map("n", "<Tab>", ">>")
map("n", "<S-Tab>", "<<")
map("x", "<Tab>", ">gv")
map("x", "<S-Tab>", "<gv")
-- ^I stays the jumplist's (without its own map nvim runs <Tab>'s for it)
map("n", "<C-i>", "<C-i>")

-- Windows
map("n", "<leader>v", "<cmd>vsplit<CR>", { desc = "Split vertically" })
map("n", "<leader>h", "<cmd>split<CR>", { desc = "Split horizontally" })
-- ,q = ,w: close the file tab (the split goes with its last tab); views map their own ,q (diff, history)
map("n", "<leader>q", function() require("config.focus").close_file() end, { desc = "Close tab" })
map("n", "<leader><Right>", "<C-w>l", { desc = "Window right" })
map("n", "<leader><Left>", "<C-w>h", { desc = "Window left" })

-- Diagnostics (ShowErrorDescription)
-- like the gh / mouse tooltip: "TS2322: …" without the code repeated as "[2322]"
map("n", "<leader>e", function() require("config.gutter").show_error() end, { desc = "Show error" })

-- LSP (Rename / hover / code actions). Defaults also exist: grn, gra, grr, gri
-- (wrapped: indexing vim.lsp.buf here would load vim.lsp at startup)
map("n", "<leader>rr", function() vim.lsp.buf.rename() end, { desc = "Rename symbol" })
map("n", "gh", function() require("config.gutter").hover_cursor() end, { desc = "Hover info (error + docs)" })
map({ "n", "x" }, "<leader>a", function() require("config.context").code_actions() end, { desc = "Code action (Alt+Enter)" })

-- Arrow keys disabled
for _, k in ipairs({ "<Up>", "<Down>", "<Left>", "<Right>" }) do
  map(nx, k, "<Nop>")
end

return M
