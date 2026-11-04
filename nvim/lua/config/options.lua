local o = vim.opt

o.number = true
o.relativenumber = false -- static line numbers, like WebStorm
-- diffs scroll in sync instead of padding blank rows, like WebStorm (linematch forces them)
o.diffopt:remove({ "filler", "linematch:40" })
o.cursorline = true
o.signcolumn = "yes" -- fixed width: text never shifts when a change bar appears
o.foldcolumn = "0" -- no folding outline (he hides it in WebStorm)
o.fillchars:append({ eob = " ", fold = " " }) -- no ~ after the last line, no dots after a folded region
vim.g.snacks_indent = false -- no indent guides (off in his WebStorm)
o.scrolloff = 3
o.mouse = "a"
o.showcmd = false -- the status bar shows the selection size (it showed twice, below the bar too)
o.mousemodel = "extend" -- right-click menus are our own (config/menu.lua), not the built-in PopUp

-- Search
o.incsearch = true
o.hlsearch = true
o.ignorecase = true
o.smartcase = true -- case-sensitive when query has uppercase
o.inccommand = "split" -- live preview of :%s

-- Yank to system clipboard (deferred: clipboard provider is slow to load)
vim.schedule(function() o.clipboard = "unnamedplus" end)

-- Indent
o.expandtab = true
o.shiftwidth = 2
o.tabstop = 2
o.smartindent = true

-- Splits / misc
o.splitright = true
o.splitbelow = true
o.equalalways = false -- opening / closing tool windows never resizes the others (like WebStorm)
o.undofile = true -- persistent undo across sessions
-- no fsync after each write (perf: ~13 ms per file on APFS, paid by every autosave when switching files / splits
-- after an edit); macOS flushes the cache itself, WebStorm doesn't fsync its autosaves either
o.fsync = false
o.updatetime = 250
o.timeoutlen = 400
o.confirm = true
o.wrap = false
o.termguicolors = true
-- Floats nvim still draws (git hunk preview, snacks fallback pickers, neotest...): no line border, the popup's
-- bg is its frame (FloatBorder: fill color over the editor bg), corners cut (smooth-mosaic glyphs the app draws as
-- sprites), top / bottom edge a third of a row. Same set as config/popup.lua's framed floats.
o.winborder = table.concat({ "\u{1fb48}", "\u{1fb2d}", "\u{1fb3d}", "\u{2588}", "\u{1fb58}", "\u{1fb02}", "\u{1fb63}", "\u{2588}" }, ",")

-- Window title (the app's toolbar shows it): "project – file", set by config/statusline.lua
o.title = true
