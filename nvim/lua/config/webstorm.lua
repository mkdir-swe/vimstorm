-- WebStorm shortcuts. Cmd keys arrive from the app as <D-…> (app/src/editor/input/keys.rs; app/src/editor/input/keymap.rs
-- says which keys reach Neovim). Loaded after plugins (needs Snacks).
local focus = require("config.focus")
local term = require("config.app.terminal")
local map = vim.keymap.set

-- (no Terminal mode: the app's terminal is native)
local all = { "n", "i", "x" }
local edit = { "n", "i", "x" }

-- Shifted Cmd keys can arrive as <D-S-x> or <D-X>; map both
local function map_shift(modes, key, rhs, opts)
  map(modes, "<D-S-" .. key .. ">", rhs, opts)
  map(modes, "<D-" .. key:upper() .. ">", rhs, opts)
end

-- Mouse + context menus (right-click / Cmd+Enter) ---------------------------------
require("config.menu").setup()

-- Tool windows --------------------------------------------------------------
-- (Cmd+2 the open file here. The pane keys Cmd+1 the tree, Cmd+3 Code's bottom panel's Git, Cmd+4 Chat, Cmd+T and Ctrl+`
-- the panel's Terminal (shown with the keys, the keys, hidden: app/src/shell/pane_key.rs, which calls focus.tree),
-- Cmd+J, Ctrl+Cmd+Left / Right Chat's modes, Ctrl+1–3 the pages and the rail's Cmd+arrows are the app's
-- (app/src/shell/projects): they never reach nvim. Cmd+5 / Cmd+6 / Cmd+7 are gone)
map(all, "<D-2>", focus.editor, { desc = "The open file" })
map_shift(all, "t", term.new, { desc = "New terminal tab" })

-- Tabs ----------------------------------------------------------------------
-- (Ctrl+Cmd+Left / Right are the app's: Chat's modes while Chat has the keys or no Code shows, else they call
-- focus.cycle_tabs as these do)
map(all, "<M-D-Left>", function() focus.cycle_tabs(-1) end, { desc = "Previous tab" })
map(all, "<M-D-Right>", function() focus.cycle_tabs(1) end, { desc = "Next tab" })
-- editor tabs of the focused / last focused split, even when focus is in the tree
map(edit, "<C-Left>", function() require("config.editor_tabs").cycle(-1) end, { desc = "Previous tab" })
map(edit, "<C-Right>", function() require("config.editor_tabs").cycle(1) end, { desc = "Next tab" })
require("config.switcher") -- now, not on first Ctrl+Tab: it tracks the order buffers are entered in
map(all, "<C-Tab>", function() require("config.switcher").open() end, { desc = "Switcher (release Ctrl to open)" })
map(all, "<C-S-Tab>", function() require("config.switcher").open({ back = true }) end, { desc = "Switcher, backwards" })

-- Editing -------------------------------------------------------------------
-- Cmd keys must work in insert mode too (unmapped, Neovim would type "<D-w>")
local editing = require("config.editing")
editing.setup()
require("config.selection").setup() -- multi-line selections drawn as a block, like WebStorm
-- Cmd+C / Cmd+X: the selection (it stays selected after Cmd+C, like WebStorm), else the whole line. Select mode
-- (a field's preselected text, a snippet placeholder) too, instead of typing the key over it. In a text field
-- (Rename, the pickers' query, Replace, terminal Find) its text, never as a whole line. The command line has
-- no selection: nothing.
map("x", "<D-c>", function()
  if not editing.in_field() then return '"+ygv' end
  editing.copy()
  return ""
end, { expr = true, desc = "Copy" })
map("s", "<D-c>", function() editing.copy() end, { desc = "Copy" })
map("n", "<D-c>", '"+yy', { desc = "Copy line" })
map("i", "<D-c>", function()
  if editing.in_field() then return editing.copy_field() end
  vim.cmd('normal! "+yy')
end, { desc = "Copy line" })
map("x", "<D-x>", function()
  if not editing.in_field() then return '"+d' end
  editing.copy()
  return '"_c'
end, { expr = true, desc = "Cut" })
map("s", "<D-x>", function()
  editing.copy()
  return '<C-g>"_c'
end, { expr = true, desc = "Cut" })
map("n", "<D-x>", '"+dd', { desc = "Cut line" })
map("i", "<D-x>", function()
  if editing.in_field() then return editing.copy_field(true) end
  vim.cmd('normal! "+dd')
end, { desc = "Cut line" })
map("c", "<D-c>", "<Nop>")
map("c", "<D-x>", "<Nop>")
map("n", "<D-z>", "u", { desc = "Undo" })
map("i", "<D-z>", "<C-o>u", { desc = "Undo" })
map("x", "<D-z>", "<Esc>u", { desc = "Undo" })
map_shift("n", "z", "<C-r>", { desc = "Redo" })
map_shift("i", "z", "<C-o><C-r>", { desc = "Redo" })
map_shift("x", "z", "<Esc><C-r>", { desc = "Redo" })
map("n", "<D-a>", "ggVG", { desc = "Select all" })
map({ "i", "x" }, "<D-a>", "<Esc>ggVG", { desc = "Select all" })
map(all, "<D-s>", "<cmd>lua require('config.app.agent_files').save_all()<CR>", { desc = "Save all" })
-- Extend / shrink selection: word, then syntax nodes with their contents first (config/editing.lua)
map({ "n", "x" }, "<D-w>", editing.expand, { desc = "Extend selection" })
map("i", "<D-w>", function()
  local row, col = unpack(vim.api.nvim_win_get_cursor(0))
  return ("<C-\\><C-n><Cmd>lua require('config.editing').select_word(%d, %d)<CR>"):format(row, col)
end, { expr = true, desc = "Extend selection" })
map_shift("x", "w", editing.shrink, { desc = "Shrink selection" })
map_shift({ "n", "i" }, "w", "<Nop>")
map(edit, "<D-d>", editing.duplicate, { desc = "Duplicate line or selection" })
-- Cmd+/ (Swedish Cmd+Shift+7: config/app.lua maps <D-S-7> to <D-/>): comment with line comment (Neovim's gc); the
-- caret stays on its text, a selection stays selected, typing goes on
map({ "n", "i" }, "<D-/>", editing.comment_line, { desc = "Comment line" })
map("x", "<D-/>", editing.comment_selection, { desc = "Comment selection" })
map({ "n", "x" }, "<C-S-l>", "3<C-y>", { desc = "Scroll up" })
map({ "n", "x" }, "<C-S-ö>", "3<C-e>", { desc = "Scroll down" })
map("i", "<C-S-l>", "<Cmd>normal! 3\25<CR>", { desc = "Scroll up" })
map("i", "<C-S-ö>", "<Cmd>normal! 3\5<CR>", { desc = "Scroll down" })
-- Folding (config/fold.lua): Cmd+- / Cmd++ (Cmd+=) the region at the caret, with Shift all of them
local fold = require("config.fold")
for lhs, fn in pairs({ ["<D-->"] = fold.collapse, ["<D-=>"] = fold.expand, ["<S-D-->"] = fold.collapse_all, ["<D-_>"] = fold.collapse_all, ["<S-D-=>"] = fold.expand_all, ["<D-+>"] = fold.expand }) do
  map(edit, lhs, fn, { desc = "Folding" })
end

-- Search --------------------------------------------------------------------
-- Shift Shift: Search Everywhere (the app detects it, config/doubleshift.lua). Snacks.picker.<source>() of the
-- searches the app draws opens its native picker (config/app/pickers.lua)
require("config.app.pickers").setup()
-- Cmd+O: Go to File (his WebStorm keymap) = Search Everywhere on the Files tab
map(all, "<D-o>", function() Snacks.picker.files() end, { desc = "Go to file" })
map("n", "<D-f>", "/", { desc = "Find" })
map({ "i", "x" }, "<D-f>", "<Esc>/", { desc = "Find" })
map_shift(all, "f", function() Snacks.picker.grep() end, { desc = "Find in files" })
-- Cmd+G: unbound since 2.1 (the Copilot inline chat is retired: ask in Chat, its implicit context); next match is `n`
map_shift("n", "g", "N", { desc = "Previous match" })
map_shift({ "i", "x" }, "g", "<Esc>N", { desc = "Previous match" })

-- Recent projects: the native picker shows the picked project in this window (app/src/search/everywhere.rs)
map_shift(all, "o", function() Snacks.picker.projects() end, { desc = "Recent projects" })
-- Ctrl+Cmd+Shift+O: Reveal in Finder, the current file (the native tree reveals its own selection)
for _, k in ipairs({ "<C-S-D-o>", "<C-D-O>" }) do
  map(edit, k, function() require("config.tree").reveal({ vim.api.nvim_buf_get_name(0) }) end, { desc = "Reveal in Finder" })
end

-- Code ----------------------------------------------------------------------
local declaration_or_usages = require("config.context").declaration_or_usages
map("n", "<D-b>", declaration_or_usages, { desc = "Go to declaration / usages" })
map("n", "gd", declaration_or_usages, { desc = "Go to declaration / usages" })
-- while typing: still typing afterwards (at the declaration, or back at the caret when Show Usages closes)
map("i", "<D-b>", function()
  -- without LSP it's Vim's gd, which throws when nothing is found: a message, not a hit-enter traceback
  local ok, err = pcall(declaration_or_usages)
  if not ok then vim.notify(tostring(err):match("E%d+:.*") or tostring(err), vim.log.levels.WARN) end
end, { desc = "Go to declaration / usages" })
map(edit, "<M-CR>", require("config.context").code_actions, { desc = "Show intention actions" })
map("n", "<S-F6>", function() vim.lsp.buf.rename() end, { desc = "Rename" })
map(edit, "<D-M-l>", function() require("conform").format({ async = true }) end, { desc = "Reformat code" })
-- Cmd+L: Quick Definition popup (config/peek.lua); global, so views that map Cmd+L on their buffers win
map(edit, "<D-l>", function() require("config.peek").open() end, { desc = "Quick definition" })
-- Alt+Space: WebStorm's own key for it (the app sends <M-Space>; unmapped, Neovim read it as Esc + Space and
-- left Insert mode)
map(edit, "<M-Space>", function() require("config.peek").open() end, { desc = "Quick definition" })
-- Cmd+Ö only means something in the diff viewer / merge window (buffer-local there); elsewhere it must not type <D-ö>
map(edit, "<D-ö>", "<Nop>")

-- Git ---------------------------------------------------------------------------
-- F4 in the diff viewer / merge window: open the file in the editor
map("n", "<F4>", function()
  local target = focus.target()
  if target == "diff" then
    require("git.diff").open_in_editor()
  elseif target == "merge" then
    require("git.merge").open_in_editor()
  end
end, { desc = "Open in editor" })
-- Cmd+R: in a diff roll back the change (the Git tool window maps its own), in the editor Replace in file
-- (config/replace.lua); the editor's Rollback Lines is Cmd+Alt+Z like WebStorm
map(edit, "<D-r>", function()
  local target = focus.target()
  if target == "diff" then return require("git.diff").revert_change() end
  if target == "merge" then return end
  require("config.replace").open()
end, { desc = "Replace in file" })
map(edit, "<M-D-z>", function()
  local target = focus.target()
  if target == "diff" then return require("git.diff").revert_change() end
  if target == "merge" then return end
  require("gitsigns").reset_hunk()
end, { desc = "Rollback lines" })
-- Commit / push from anywhere, like WebStorm (the Git tool window maps them on its own buffers too)
map(all, "<D-k>", function() require("git").commit() end, { desc = "Commit" })
map(all, "<M-D-k>", function() require("git").commit_push() end, { desc = "Commit and Push" })
map_shift(all, "k", function() require("git").push() end, { desc = "Push" })
map("n", "<leader>H", function() require("git").file_history(vim.api.nvim_buf_get_name(0)) end, { desc = "Git history of file" })
map("x", "<leader>H", function() require("git").history_for_selection() end, { desc = "Git history of selection" })
map("n", "<leader>å", function() require("git.blame").toggle() end, { desc = "Annotate (git blame)" })

-- Bookmarks: Ctrl+Shift+1..9 set (line + column), Ctrl+1..9 jump (config/bookmarks.lua)
require("config.bookmarks").setup()

-- The keys that act wherever the keys are (app/src/editor/input/keymap.rs: Nvim, Global) act from Neovim's command
-- line (`/` typed) and with an operator pending (`d` typed) too, as WebStorm's work with its Find bar open: Normal
-- mode first (config/app/normal.lua: the search cancelled as Esc, the `d` dropped), then the key again, as it is
-- mapped there (this Feel's, yours). The Feel vscode's own chords too. (⌃← ⌃→ stay the command line's word moves.)
do
  local again = require("config.app.normal").again
  local anywhere = { "<M-D-Left>", "<M-D-Right>", "<C-Tab>", "<C-S-Tab>", "<D-o>", "<D-S-f>", "<D-F>", "<D-S-o>",
    "<D-O>", "<D-s>", "<D-2>", "<D-S-t>", "<D-T>", "<D-k>", "<M-D-k>", "<D-S-k>", "<D-K>", "<D-b>",
    -- Feel vscode
    "<D-p>", "<D-S-p>", "<D-P>", "<D-t>", "<D-S-m>", "<D-M>", "<C-S-g>", "<M-D-s>", "<F12>", "<S-F12>", "<C-->",
    "<C-S-->" }
  for n = 1, 9 do anywhere[#anywhere + 1] = "<C-" .. n .. ">" end
  for _, lhs in ipairs(anywhere) do
    map({ "c", "o" }, lhs, again(lhs), { desc = "Normal mode, then " .. lhs })
  end
  -- a click into a window from the command line too (one on the line itself stays the line's; with an operator
  -- pending a click is its motion, as in Vim)
  for _, lhs in ipairs({ "<LeftMouse>", "<D-LeftMouse>", "<RightMouse>" }) do
    local click = again(lhs)
    map("c", lhs, function()
      if vim.fn.getmousepos().winid == 0 then return vim.api.nvim_feedkeys(vim.keycode(lhs), "n", false) end
      click()
    end, { desc = "Normal mode, then the click" })
  end
end
