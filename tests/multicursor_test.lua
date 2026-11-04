-- VS Code's multi-cursor under the Feel vscode (#123, config/multicursor.lua "VS Code", config/keymap_vscode.lua):
-- ⌘D selects the word, then adds its next occurrence (whole word, case sensitive; a selection you made: any case,
-- anywhere), ⌘K ⌘D skips one, ⌥click adds / removes a caret, typing edits at every caret as one undo step, Esc
-- back to one caret (Vim mode off: still typing). The other carets' cells for the app (`vimstorm.carets`,
-- config/app/carets.lua); how they're drawn is the cargo suite's (tests/input.rs).
local H = dofile(os.getenv("NVT_HARNESS"))
local ESC = "<Esc>"
local D = "<D-d>"

local FILES = {
  ["words.txt"] = { "foo bar foo", "Foo foo.x", "food foo" },
  ["sv.txt"] = { "här och här", "där" },
}
local DIR = H.project("multicursor", FILES)

local function text() return table.concat(H.lua("return vim.api.nvim_buf_get_lines(0, 0, -1, false)") or {}, "|") end
local function at(l, c) H.lua(("vim.api.nvim_win_set_cursor(0, { %d, %d })"):format(l, c)) end
local function n() return H.lua("return require('multicursor-nvim').numCursors()") end
local function textoff() return H.lua("return vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff") end
-- the last carets payload's cells as "row:col" (col without the gutter), sorted
local function cells()
  local p = H.last("carets", "carets")
  if not p then return "none" end
  local off, out = textoff(), {}
  for _, c in ipairs(p.cells) do out[#out + 1] = c[1] .. ":" .. (c[2] - off) end
  return table.concat(out, " ")
end
local function state() return { text(), H.mode(), n(), cells() } end

-- A file in the split with its fixture text, Normal mode, one caret, at the top
local function fresh(name)
  H.keys(ESC .. ESC)
  H.lua(([[
    pcall(function() require('multicursor-nvim').clearCursors() end)
    require('config.focus').editor()
    vim.cmd('silent! wall')
    vim.cmd('edit ' .. vim.fn.fnameescape(%q))
    vim.api.nvim_buf_set_lines(0, 0, -1, false, %s)
    vim.cmd('normal! gg0')]]):format(name, vim.inspect(FILES[name])))
  H.wait_for(("vim.fn.expand('%%:t') == %q and vim.api.nvim_get_mode().mode == 'n'"):format(name))
end

H.run(function()
  H.start(DIR, { "words.txt" })
  H.call("config.feel", "set", { feel = "vscode" })

  -- ⌘D: the word, then its next occurrences (whole word, case sensitive), typing at every one ------------
  fresh("words.txt")
  at(1, 1)
  H.keys(D)
  H.expect("⌘D with no selection selects the word at the caret (one caret)", function()
    return H.mode() == "v" and n() == 1
  end, state)
  H.keys(D .. D .. D)
  H.expect("⌘D ×3 adds the next three: whole word, case sensitive (not Foo, not food)", function()
    return n() == 4 and cells() == "0:2 0:10 1:6"
  end, state)
  H.keys(D)
  H.expect("...once every occurrence is selected, ⌘D adds none", function() return n() == 4 end, state)
  H.keys("cX")
  H.expect("typing edits at every caret, on screen as it's typed", function()
    return text() == "X bar X|Foo X.x|food X" and H.mode() == "i" and cells() == "0:1 0:7 1:5"
  end, state)
  H.keys(ESC)
  H.expect("Esc: Normal mode, the carets stay (Vim mode on)", function()
    return H.mode() == "n" and n() == 4 and cells() == "0:0 0:6 1:4"
  end, state)
  H.keys(ESC)
  H.expect("Esc again: one caret, none for the app to draw", function() return n() == 1 and cells() == "" end, state)
  H.keys("u")
  H.expect("one undo takes back the edit at all four carets", function() return text() == "foo bar foo|Foo foo.x|food foo" end, state)
  H.keys("<C-r>")
  H.expect("...and one redo puts it back", function() return text() == "X bar X|Foo X.x|food X" end, state)

  -- a selection you made: any case, inside words ------------------------------------------------------------
  fresh("words.txt")
  at(1, 0)
  -- (Feel vscode with Vim mode on here: stock Vim keys, #214)
  H.keys("vll")
  H.keys(D .. D .. D .. D .. D)
  H.expect("⌘D on a selection you made: every foo, any case, inside words too", function() return n() == 6 end, state)
  H.keys("cY" .. ESC .. ESC)
  H.expect("...each one changed", function() return text() == "Y bar Y|Y Y.x|Yd Y" end, state)

  -- ⌘K ⌘D: skip ------------------------------------------------------------------------------------------
  fresh("words.txt")
  at(1, 0)
  H.keys(D .. D .. "<D-k>" .. D)
  H.expect("⌘K ⌘D moves the newest selection on to the next occurrence", function() return n() == 2 end, state)
  H.keys("cZ" .. ESC .. ESC)
  H.expect("...the skipped one stays as it was", function() return text() == "Z bar foo|Foo Z.x|food foo" end, state)

  -- ⌘D while typing: Select-mode selections, typing replaces them ------------------------------------------
  fresh("words.txt")
  at(1, 0)
  H.keys("i" .. D)
  H.expect("⌘D while typing selects the word as a Select-mode selection", function() return H.mode() == "s" end, state)
  H.keys(D)
  H.expect("...⌘D again: the next occurrence, selected too", function() return H.mode() == "s" and n() == 2 end, state)
  H.keys("WV")
  H.expect("typing replaces each selection and goes on at both", function()
    return text() == "WV bar WV|Foo foo.x|food foo" and H.mode() == "i"
  end, state)
  H.keys(ESC .. ESC)
  H.expect("Esc Esc: one caret", function() return n() == 1 end, state)

  -- ⌥click ------------------------------------------------------------------------------------------------
  fresh("words.txt")
  local win = H.lua("return vim.api.nvim_get_current_win()")
  at(1, 0)
  H.click(win, 2, textoff(), "M")
  H.expect("⌥click adds a caret", function() return n() == 2 and cells() == "0:0" end, state)
  H.click(win, 2, textoff(), "M")
  H.expect("⌥click on a caret removes it", function() return n() == 1 end, state)
  H.click(win, 2, textoff(), "M")
  H.keys("iQ" .. ESC .. ESC)
  H.expect("typing goes to the clicked caret too", function() return text() == "Qfoo bar foo|Foo foo.x|Qfood foo" end, state)
  fresh("words.txt")
  H.keys("A")
  -- typing first (under load the ⌥click could land before `A` ran, #213): wait on the mode, not time
  H.expect("A: typing at the line's end", function() return H.mode() == "i" end, state)
  H.click(win, 1, textoff() + 3, "M")
  H.expect("⌥click while typing: a caret there, still typing", function() return n() == 2 and H.mode() == "i" end, state)
  H.keys("!")
  H.expect("...typing goes on at both, each where it typed", function()
    return text() == "foo bar foo!|Foo! foo.x|food foo"
  end, state)
  H.keys(ESC .. ESC)

  -- Vim mode off (the Feel's editor.vim false, config/vimmode.lua): always typing; Esc is one caret again --------
  fresh("words.txt")
  H.call("config.feel", "set", { feel = "vscode", editor = { vim = false } })
  H.expect("Vim mode off: typing", function() return H.mode() == "i" end, state)
  at(1, 1)
  H.keys(D)
  H.expect("Vim mode off: ⌘D selects the word (Select mode, exclusive)", function() return H.mode() == "s" end, state)
  H.keys(D)
  H.expect("...⌘D again: two selections", function() return n() == 2 end, state)
  H.keys("R")
  H.expect("...typing replaces both", function() return text() == "R bar R|Foo foo.x|food foo" end, state)
  H.keys(ESC)
  -- (the completion menu typing R opened closes on the first Esc, as VS Code's suggestions do)
  if n() > 1 then
    H.check("Esc with the completion menu up closes it, the carets stay", H.lua("return not require('blink.cmp').is_visible()") and n() == 2)
    H.keys(ESC)
  end
  H.expect("...Esc: one caret, still typing", function() return n() == 1 and H.mode() == "i" end, state)
  H.keys("T")
  H.expect("...typing goes to the one caret", function() return text() == "R bar RT|Foo foo.x|food foo" end, state)
  at(2, 5)
  H.keys(D)
  H.keys(D)
  H.expect("⌘D ⌘D: two selections again", function() return n() == 2 and H.mode() == "s" end, state)
  H.keys(ESC)
  H.expect("...Esc on the selections: one caret, typing after the newest one (the line's end)", function()
    local c = H.cursor() or {}
    return n() == 1 and H.mode() == "i" and c[1] == 3 and c[2] == 8
  end, function() return { state(), H.cursor() } end)
  H.click(win, 2, textoff() + 4, "M")
  H.expect("⌥click: a caret there, still typing", function() return n() == 2 and H.mode() == "i" end, state)
  H.keys("+")
  H.expect("...typing goes on at both", function() return text() == "R bar RT|Foo foo.x|food+ foo+" end, state)
  H.keys(ESC)
  H.expect("...Esc: one caret", function() return n() == 1 and H.mode() == "i" end, state)
  at(1, 1)
  H.keys(D)
  H.click(win, 1, textoff(), "M")
  H.expect("⌥click with a selection (Select mode): a caret there too", function() return n() == 2 end, state)
  H.keys(ESC)
  H.expect("...Esc: one caret", function() return n() == 1 and H.mode() == "i" end, state)
  H.lua("vim.cmd('edit sv.txt')")
  H.expect("Swedish words: typing", function() return H.mode() == "i" and text() == "här och här|där" end, state)
  at(1, 1)
  H.keys(D)
  H.keys(D)
  H.keys("x")
  H.expect("...⌘D ⌘D on här (multibyte, exclusive end) and typing replace both", function()
    return text() == "x och x|där"
  end, state)
  H.keys(ESC)

  -- Feel vimstorm: ⌘D duplicates again (editing_test checks the whole keymap) --------------------------------
  H.call("config.feel", "set", { feel = "vimstorm" })
  H.expect("Vim mode on again", function() return H.mode() == "n" end, state)
  fresh("words.txt")
  H.keys(D)
  H.expect("Feel vimstorm: ⌘D duplicates the line", function() return text() == "foo bar foo|foo bar foo|Foo foo.x|food foo" end, state)
end)
