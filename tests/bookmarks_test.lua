-- Bookmarks (config/bookmarks.lua): Ctrl+Shift+N toggles bookmark N at the caret (line + column), Ctrl+N jumps
-- to that exact spot, the number in a box in the gutter (statuscolumn), following edits, the editor context
-- menu's Bookmarks › submenu (native menu payloads), saved per project across restarts.
local H = dofile(os.getenv("NVT_HARNESS"))
local function SET(n) return H.KEY.ctrl_shift_digit(n) end
local function GO(n) return H.KEY.ctrl_digit(n) end

local A = {}
for i = 1, 40 do A[i] = ("const v%d = %d;"):format(i, i) end
local DIR = H.project("bmk", { ["a.ts"] = A, ["b.ts"] = { "export const b = 1;", "export const bb = 2;" } })

local function at(l, c) H.lua(("vim.api.nvim_win_set_cursor(0, { %d, %d })"):format(l, c)) end
local function caret() return H.lua("return { vim.fn.expand('%:t'), vim.api.nvim_win_get_cursor(0)[1], vim.api.nvim_win_get_cursor(0)[2] }") or {} end
local function caret_is(file, l, c)
  return function()
    local p = caret()
    return p[1] == file and p[2] == l and p[3] == c
  end
end
-- The gutter of the line holding `text` in the current window, as the statuscolumn draws it: "<line number><bookmark>"
local function gutter(text)
  return H.lua([[
    local text = ...
    local win = vim.api.nvim_get_current_win()
    for l, s in ipairs(vim.api.nvim_buf_get_lines(0, 0, -1, false)) do
      if s == text then
        return vim.api.nvim_win_call(win, function()
          return vim.api.nvim_eval_statusline(vim.wo.statuscolumn, { winid = win, use_statuscol_lnum = l }).str
        end)
      end
    end
    return '']], { text }) or ""
end
local function marked(text, lnum, num)
  return function() return gutter(text):match(lnum .. num .. "%s*$") ~= nil end
end
-- The editor context menu at the caret, then its Bookmarks › submenu: the submenu's payload
local function bookmarks_menu()
  H.bridge_clear()
  H.keys(H.KEY.cmd_enter)
  local menu = H.wait_menu()
  H.bridge_clear()
  if not H.menu_choose(menu, "Bookmarks") then return nil end
  return H.wait_menu()
end
local function key_of(menu, label)
  for _, it in ipairs(menu and menu.items or {}) do
    if it.label == label then return it.key end
  end
end

H.run(function()
  H.start(DIR, { "a.ts" })
  H.wait_focus("split")
  local textoff = H.lua("return vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff")

  -- Ctrl+Shift+1 mid-word: bookmark 1 at that column, its number in a box in the gutter
  at(5, 2) -- the "n" of const
  H.keys(SET(1))
  H.expect("Ctrl+Shift+1 sets bookmark 1: its number in the gutter after the line number", marked("const v5 = 5;", 5, 1), function() return gutter("const v5 = 5;") end)
  local box = H.lua([[
    local b, n = vim.api.nvim_get_hl(0, { name = 'WsBookmarkNum', link = false }), vim.api.nvim_get_hl(0, { name = 'LineNr', link = false })
    return { b.bg or -1, n.bg or vim.api.nvim_get_hl(0, { name = 'Normal' }).bg or -1, vim.wo.statuscolumn:find('bookmarks') ~= nil }]]) or {}
  H.check("the number is drawn in a box (own background)", box[1] ~= -1 and box[1] ~= box[2] and box[3], vim.inspect(box))
  H.check("the bookmark doesn't widen the gutter", H.lua("return vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff") == textoff, textoff)
  at(30, 0)
  H.keys(GO(1))
  H.expect("Ctrl+1 jumps back to its line and column", caret_is("a.ts", 5, 2), caret)

  -- edits: lines added above move it down, text typed before it on its line moves it right
  H.keys("ggO// one<Esc>o// two<Esc>")
  H.keys("7GIexport <Esc>")
  at(30, 0)
  H.keys(GO(1))
  H.expect("the bookmark follows edits: Ctrl+1 lands on the moved spot", caret_is("a.ts", 7, 9), caret)

  -- Ctrl+Shift+1 on its spot removes it; set elsewhere it moves
  H.keys(SET(1))
  H.wait_for(function() return not marked("export const v5 = 5;", 7, 1)() end, 2000)
  at(30, 0)
  H.keys(GO(1))
  H.check("Ctrl+Shift+1 on its spot removes it: gone from the gutter, Ctrl+1 goes nowhere",
    not marked("export const v5 = 5;", 7, 1)() and caret_is("a.ts", 30, 0)(), gutter("export const v5 = 5;") .. " " .. vim.inspect(caret()))
  at(10, 3)
  H.keys(SET(1))
  at(12, 4)
  H.keys(SET(1))
  at(30, 0)
  H.keys(GO(1))
  H.expect("Ctrl+Shift+1 elsewhere moves bookmark 1", function()
    return caret_is("a.ts", 12, 4)() and marked("const v10 = 10;", 12, 1)() and not marked("const v8 = 8;", 10, 1)()
  end, caret)

  -- Ctrl+2 from another file opens a.ts at bookmark 2
  at(14, 6)
  H.keys(SET(2))
  H.lua("vim.cmd.edit('b.ts')")
  H.wait_for("vim.fn.expand('%:t') == 'b.ts'")
  H.keys(GO(2))
  H.expect("Ctrl+2 from b.ts opens a.ts at bookmark 2's line and column", caret_is("a.ts", 14, 6), caret)
  H.keys(GO(7))
  H.check("Ctrl+7 without bookmark 7: the caret stays", caret_is("a.ts", 14, 6)(), caret())

  -- the editor context menu: Bookmarks › Toggle Bookmark with Number… / Go to Bookmark…
  H.lua("vim.cmd.edit('b.ts')")
  H.wait_for("vim.fn.expand('%:t') == 'b.ts'")
  at(2, 13)
  local sub = bookmarks_menu()
  local labels = H.menu_labels(sub)
  H.check("context menu Bookmarks › opens the submenu: Toggle Bookmark with Number…, Go to Bookmark…",
    labels[1] == "Toggle Bookmark with Number…" and labels[2] == "Go to Bookmark…", vim.inspect(labels))
  H.bridge_clear()
  H.menu_choose(sub, "Toggle")
  local nums = H.wait_menu()
  H.menu_choose(nums, "4")
  H.expect("menu: Toggle Bookmark with Number… → 4 sets bookmark 4 at the caret", marked("export const bb = 2;", 2, 4), function()
    return gutter("export const bb = 2;") .. " " .. vim.inspect(nums and nums.items)
  end)
  H.lua("vim.cmd.edit('a.ts')")
  H.wait_for("vim.fn.expand('%:t') == 'a.ts'")
  sub = bookmarks_menu()
  H.bridge_clear()
  H.menu_choose(sub, "Go to")
  local jumps = H.wait_menu()
  H.check("Go to Bookmark… lists the set ones (1, 2, 4) with their spots", table.concat(H.menu_labels(jumps), ",") == "1,2,4"
    and key_of(jumps, "1") == "a.ts:12" and key_of(jumps, "2") == "a.ts:14" and key_of(jumps, "4") == "b.ts:2",
    vim.inspect(jumps and jumps.items))
  H.menu_choose(jumps, "4")
  H.expect("menu: Go to Bookmark… → 4 opens b.ts at its line and column", caret_is("b.ts", 2, 13), caret)

  -- saved per project: back after a restart, on the same spots
  H.restart(DIR, { "a.ts" })
  H.wait_focus("split")
  H.keys(GO(2))
  H.expect("after a restart: Ctrl+2 lands on a.ts:14 col 6, drawn in the gutter", function()
    return caret_is("a.ts", 14, 6)() and marked("const v12 = 12;", 14, 2)()
  end, function() return vim.inspect(caret()) .. " " .. gutter("const v12 = 12;") end)
  H.keys(GO(4))
  H.expect("after a restart: Ctrl+4 lands on b.ts:2 col 13", caret_is("b.ts", 2, 13), caret)
  H.keys(GO(2))
  H.wait_for(caret_is("a.ts", 14, 6))
  -- deleting the line hides the bookmark; undo brings it back
  H.keys("dd")
  at(30, 0)
  H.keys(GO(2))
  local has2 = H.lua("for _, b in ipairs(require('config.bookmarks').list()) do if b.num == 2 then return true end end return false")
  H.check("deleting its line removes the bookmark: Ctrl+2 goes nowhere", caret_is("a.ts", 30, 0)() and has2 == false, vim.inspect(caret()))
  H.keys("u")
  H.expect("undo brings it back", marked("const v12 = 12;", 14, 2), function() return gutter("const v12 = 12;") end)

  -- an old saved file without columns (and an unnumbered entry) still loads, column 0
  local store = H.lua([[return vim.fn.stdpath('state') .. '/bookmarks/' .. vim.fn.getcwd():gsub('[/\\:]', '%%') .. '.json']])
  local afile = H.lua("return vim.api.nvim_buf_get_name(0)")
  H.stop()
  vim.fn.writefile({ vim.json.encode({ { file = afile, line = 3, num = 5 }, { file = afile, line = 4 } }) }, store)
  H.start(DIR, { "a.ts" })
  H.wait_focus("split")
  at(30, 0)
  H.keys(GO(5))
  H.expect("an old save without columns loads at column 0, unnumbered entries dropped", function()
    return caret_is("a.ts", 3, 0)() and marked("const v1 = 1;", 3, 5)() and gutter("const v2 = 2;"):match("4%s*$") ~= nil
  end, function() return vim.inspect(caret()) .. " " .. gutter("const v1 = 1;") .. "|" .. gutter("const v2 = 2;") end)

  -- the file changes on disk (git, a formatter, another tool) and is read again: the bookmark follows its text
  at(20, 6)
  H.keys(SET(6))
  H.wait_for("not vim.bo.modified")
  local disk = vim.fn.readfile(DIR .. "/a.ts")
  table.insert(disk, 1, "// added on disk")
  vim.fn.writefile(disk, DIR .. "/a.ts")
  H.lua("vim.cmd('checktime')")
  H.wait_for("vim.fn.getline(1) == '// added on disk'")
  at(30, 0)
  H.keys(GO(6))
  H.expect("after a reload from disk: Ctrl+6 lands on the same text and column, a line lower", caret_is("a.ts", 21, 6), caret)

  -- Ctrl+N while typing: still typing, exactly on the bookmark (not a column left)
  at(30, 3)
  H.keys("i")
  H.wait_for("vim.api.nvim_get_mode().mode == 'i'")
  H.keys(GO(6))
  H.expect("Ctrl+6 while typing: on its spot, still typing", function()
    return caret_is("a.ts", 21, 6)() and H.mode() == "i"
  end, function() return vim.inspect(caret()) .. " " .. H.mode() end)
  H.keys("<Esc>")
end)
