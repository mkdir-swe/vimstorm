-- Editor tabs and splits (config/editor_tabs.lua, config/empty_editor.lua): every split has its own tabs, like
-- WebStorm's editor groups, sent to the app as tab bars (config/app/tabs.lua bars(); H.tab_bars). Closing (,w / ,q),
-- splits (,v / ,h), the same file in two splits, the 10-tab limit and where a new tab goes, the empty editor's
-- window, each tab's scroll position and caret. Drawing, mouse and the tab menu are cargo tests
-- (tabs.rs).
local H = dofile(os.getenv("NVT_HARNESS"))
local K = H.KEY

-- Wait until the splits' tab bars are `want` (see H.tab_bars), then check
local function expect_bars(label, want)
  H.expect(label, function() return H.tab_bars() == want end, function() return H.tab_bars() .. "   (want " .. want .. ")" end)
end

local function edit(file) H.keys("<Cmd>e " .. file .. "<CR>") end

-- Positions { row, col } of the editor splits, top-left to bottom-right
local function split_pos()
  return H.lua([[
    local out = vim.tbl_map(vim.api.nvim_win_get_position, require('config.editor_tabs').splits())
    table.sort(out, function(a, b) return a[1] < b[1] or a[1] == b[1] and a[2] < b[2] end)
    return out]]) or {}
end

H.run(function()
  local files = { ["a.ts"] = "export const a = 1;", ["b.ts"] = "export const b = 2;", ["c.ts"] = "export const c = 3;" }
  for i = 1, 11 do files["f" .. i .. ".ts"] = "export const f" .. i .. " = " .. i .. ";" end
  files["src/deep/x.ts"] = "export function outer() {\n  return 1;\n}\nlet z = 2;"
  local dir = H.project("tabs", files, { git = true })
  H.start(dir, { "a.ts" })

  -- Empty editor -----------------------------------------------------------------------------------------
  H.keys(",w")
  H.wait_for(function() return H.tab_bars() == "[]*" end)
  local wo = H.lua("return { vim.wo.number, vim.wo.relativenumber, vim.wo.cursorline, require('config.empty_editor').is_empty(0) }") or {}
  H.check("empty editor: no line number, no caret row", wo[1] == false and wo[2] == false and wo[3] == false and wo[4] == true, vim.inspect(wo))
  H.check("empty editor: window title is the project", H.lua("return vim.o.titlestring") == "tabs", H.lua("return vim.o.titlestring"))
  edit("b.ts")
  H.wait_for(function() return H.tab_bars() == "b.ts[b.ts]*" end)
  -- the app names the project (another open repo's folder is `tabs` too, or a worktree's repo), "" its folder again
  for _, row in ipairs({ { "x/tabs", "x/tabs – b.ts" }, { "", "tabs – b.ts" } }) do
    H.lua("require('config.statusline').set_name(...)", { row[1] })
    H.check("title named " .. vim.inspect(row[1]), H.lua("return vim.o.titlestring") == row[2], H.lua("return vim.o.titlestring"))
  end

  -- Splits -------------------------------------------------------------------------------------------------
  H.keys(",v")
  H.wait_for(function() return H.tab_bars() == "b.ts[b.ts] | b.ts[b.ts]*" end)
  edit("a.ts")
  H.wait_for(function() return H.tab_bars() == "b.ts[b.ts] | b.ts,a.ts[a.ts]*" end)
  H.keys(",w")
  expect_bars(",w closes the tab in this split only, its left neighbour active", "b.ts[b.ts] | b.ts[b.ts]*")

  -- the same file in two splits
  edit("c.ts")
  H.keys(",<Left>")
  H.wait_for(function() return H.tab_bars() == "b.ts[b.ts]* | b.ts,c.ts[c.ts]" end)
  edit("a.ts")
  H.wait_for(function() return H.tab_bars() == "b.ts,a.ts[a.ts]* | b.ts,c.ts[c.ts]" end)
  edit("c.ts")
  expect_bars("same file in two splits: a tab in each", "b.ts,a.ts,c.ts[c.ts]* | b.ts,c.ts[c.ts]")
  H.keys(",w")
  expect_bars("closing it in one split keeps it in the other", "b.ts,a.ts[a.ts]* | b.ts,c.ts[c.ts]")
  -- (the right split goes: its two tabs closed)
  H.keys(",<Right>")
  H.keys(",w")
  H.keys(",w")
  H.wait_for(function() return H.tab_bars() == "b.ts,a.ts[a.ts]*" end)

  H.keys(",h")
  expect_bars(",h: split down with the current file", "b.ts,a.ts[a.ts] | a.ts[a.ts]*")
  local pos = split_pos()
  H.check(",h: the new split is below", #pos == 2 and pos[2][1] > pos[1][1] and pos[2][2] == pos[1][2], vim.inspect(pos))
  H.keys(",q")
  expect_bars(",q on a split's only tab closes the split", "b.ts,a.ts[a.ts]*")

  -- at most 10 tabs per split: the least recently used close
  for i = 1, 11 do edit("f" .. i .. ".ts") end
  local want = "f2.ts,f3.ts,f4.ts,f5.ts,f6.ts,f7.ts,f8.ts,f9.ts,f10.ts,f11.ts[f11.ts]*"
  H.expect("13 files opened: 10 tabs, the least recently used ones closed (b.ts, a.ts, f1.ts)",
    function() return H.tab_bars() == want end, H.tab_bars)
  edit("f5.ts")
  edit("c.ts")
  H.expect("a new tab opens right of the active one", function() return H.tab_bars():find("f5.ts,c.ts,f6.ts", 1, true) ~= nil end, H.tab_bars)

  -- ,q closes the tab only, never a split with other tabs
  local left = H.tab_bars():match("^([^%[]*)")
  H.keys(",v")
  H.keys(",<Left>")
  H.wait_for(function() return H.tab_bars():match("%*$") == nil end)
  H.keys(",q")
  H.expect(",q closes the current tab, its split stays when it has other tabs", function()
    local s = H.tab_bars()
    return s:find("|", 1, true) ~= nil and #s:match("^([^%[]*)") < #left
  end, H.tab_bars)
  H.keys(",<Right>")
  H.keys(",q")
  H.wait_for(function() return not H.tab_bars():find("|", 1, true) end)

  -- Back on a tab: the scroll position and caret it had (Neovim alone keeps the caret and re-centres it)
  H.lua("vim.fn.writefile(vim.tbl_map(function(i) return 'line ' .. i end, vim.fn.range(1, 300)), 'long.txt')")
  edit("a.ts")
  edit("long.txt")
  H.lua("vim.fn.winrestview({ topline = 100, lnum = 105 })")
  local function view() return H.lua("return { vim.fn.expand('%:t'), vim.fn.line('w0'), vim.fn.line('.') }") or {} end
  H.keys(K.ctrl_cmd_left)
  H.wait_for(function() return view()[1] == "a.ts" end)
  H.keys(K.ctrl_cmd_right)
  H.expect("Ctrl+Cmd+Left / Right and back: the tab's scroll position and caret as they were",
    function() return vim.deep_equal(view(), { "long.txt", 100, 105 }) end, function() return vim.inspect(view()) end)
  -- a click on a tab: what the app calls (config.app.tabs.activate)
  local ids = H.lua("return { vim.api.nvim_get_current_win(), vim.fn.bufnr('a.ts'), vim.fn.bufnr('long.txt') }")
  H.call("config.app.tabs", "activate", ids[1], ids[2])
  H.wait_for(function() return view()[1] == "a.ts" end)
  H.call("config.app.tabs", "activate", ids[1], ids[3])
  H.expect("click another tab and back: the same view", function() return vim.deep_equal(view(), { "long.txt", 100, 105 }) end,
    function() return vim.inspect(view()) end)

  -- The caret in the status bar's parts (#119): the file relative to the project, its line, the selected lines;
  -- the app hands it to Chat as its implicit context
  edit("b.ts")
  H.keys("ox<Esc>")
  local at = H.wait_bridge("statusbar", "status", function(p) return p.caret and p.caret.line == 2 end)
  H.check("the caret: b.ts line 2, no selection", at ~= nil and at.caret.file == "b.ts" and at.caret.from == nil,
    vim.inspect(at and at.caret))
  H.keys("Vl") -- l is up (his keymap)
  local sel = H.wait_bridge("statusbar", "status", function(p) return p.caret and p.caret.from == 1 end)
  H.check("a Visual selection's lines", sel ~= nil and sel.caret.line == 1 and sel.caret.from == 1 and sel.caret.to == 2,
    vim.inspect(sel and sel.caret))
  H.keys("<Esc>")

  -- The Feel (config/feel.lua: Settings' ui.feel, sent by the app as config.feel.set) ----------------------------
  local function feel(tbl) H.call("config.feel", "set", tbl) end
  local function disk(f) return table.concat(vim.fn.readfile(dir .. "/" .. f), "\n") end
  local function ntabs() return H.lua("return #require('config.editor_tabs').tabs()") end
  -- a tab's payload fields { modified, preview } by its name (nil: no such tab)
  local function tab(name)
    return H.lua([[local n = ... for _, b in ipairs(require('config.app.tabs').bars()) do
        for _, t in ipairs(b.tabs) do if t.name == n then return { t.modified, t.preview } end end
      end]], { name })
  end
  H.check("default Feel = VimStorm's: 10 tabs, autosave on leaving, no preview tabs",
    vim.deep_equal(H.lua("local f = require('config.feel') return { f.tabs_limit(), f.auto_save(), f.preview() }"),
      { 10, "onFocusChange", false }))

  -- tabs.limit nil (VS Code): no limit
  feel({ feel = "vscode", tabs = { limit = vim.NIL } })
  H.call("config.editor_tabs", "close_all")
  H.wait_for(function() return H.tab_bars() == "[]*" end)
  for i = 1, 11 do edit("f" .. i .. ".ts") end
  edit("a.ts")
  H.expect("tabs.limit nil: 12 files opened keep 12 tabs", function() return ntabs() == 12 end, ntabs)
  feel({})
  edit("b.ts")
  H.expect("back to the default Feel: 10 tabs again", function() return ntabs() == 10 end, ntabs)

  -- each tab says whether it's unsaved (the app's dirty dot), re-sent when that flips
  H.bridge_clear()
  H.keys("ggOdirty<Esc>")
  local function bar_has(name, modified)
    return function(p)
      for _, b in ipairs(p.bars or {}) do
        for _, t in ipairs(b.tabs) do if t.name == name and t.modified == modified then return true end end
      end
    end
  end
  H.check("an edit re-sends the tab bars: b.ts modified", H.wait_bridge("tabs", "bars", bar_has("b.ts", true)) ~= nil,
    vim.inspect(tab("b.ts")))
  H.keys("<Cmd>w<CR>")
  H.check("...a save re-sends it unmodified", H.wait_bridge("tabs", "bars", bar_has("b.ts", false)) ~= nil,
    vim.inspect(tab("b.ts")))
  H.check("tab payload: modified / preview fields", vim.deep_equal(tab("b.ts"), { false, false }), vim.inspect(tab("b.ts")))

  -- files.autoSave off: leaving a file / the app writes nothing; closing an unsaved tab asks (VS Code's)
  feel({ files = { autoSave = "off" } })
  edit("c.ts")
  H.keys("ggOoff<Esc>")
  edit("a.ts")
  H.app_focus(false)
  H.app_focus(true)
  H.settle(200)
  H.check("autoSave off: leaving the file and the app writes nothing", disk("c.ts") == "export const c = 3;", disk("c.ts"))
  edit("c.ts")
  H.bridge_clear()
  H.keys(",w")
  local ask = H.wait_menu()
  H.check("autoSave off: closing an unsaved tab asks Save / Don't Save / Cancel",
    vim.deep_equal(H.menu_labels(ask), { "Save", "Don't Save", "Cancel" }), vim.inspect(H.menu_labels(ask)))
  H.menu_choose(ask, "Cancel")
  H.expect("Cancel: the tab comes back, still unsaved", function()
    return H.file() == "c.ts" and H.lua("return vim.bo.modified") == true and vim.deep_equal(tab("c.ts"), { true, false })
  end, function() return { H.file(), tab("c.ts") } end)
  H.bridge_clear()
  H.keys(",w")
  H.menu_choose(H.wait_menu(), "Don't Save")
  H.expect("Don't Save: the tab and its text go, the file as it was", function()
    return tab("c.ts") == nil and H.lua("return vim.fn.bufloaded('c.ts')") == 0 and disk("c.ts") == "export const c = 3;"
  end, function() return { tab("c.ts"), disk("c.ts") } end)
  edit("c.ts")
  H.keys("ggOsaved<Esc>")
  H.bridge_clear()
  H.keys(",w")
  H.menu_choose(H.wait_menu(), "Save")
  H.expect("Save: written, then closed", function() return tab("c.ts") == nil and disk("c.ts"):find("^saved") ~= nil end,
    function() return { tab("c.ts"), disk("c.ts") } end)
  -- Close All with two unsaved files: both come back as tabs, one asks; a menu over the ask loses nothing
  edit("a.ts")
  H.keys("ggOone<Esc>")
  edit("b.ts")
  H.keys("ggOtwo<Esc>")
  H.expect("both unsaved", function()
    return vim.deep_equal(tab("a.ts"), { true, false }) and vim.deep_equal(tab("b.ts"), { true, false })
  end, function() return { tab("a.ts"), tab("b.ts") } end)
  H.bridge_clear()
  H.lua("require('config.editor_tabs').close_all() return true")
  H.wait_menu()
  H.expect("Close All under off: both unsaved files are tabs again", function()
    return tab("a.ts") ~= nil and tab("b.ts") ~= nil
  end, function() return { tab("a.ts"), tab("b.ts") } end)
  H.check("...nothing written", disk("a.ts"):find("^one") == nil and disk("b.ts"):find("^two") == nil)
  H.keys("<Esc>")
  H.lua("for _, n in ipairs({ 'a.ts', 'b.ts' }) do local b = vim.fn.bufnr(n) vim.api.nvim_buf_call(b, function() vim.cmd('silent edit!') end) end return true")

  -- files.autoSave afterDelay: written ~1 s after the last change, without leaving
  feel({ files = { autoSave = "afterDelay" } })
  edit("c.ts")
  H.keys("ggOdelayed<Esc>")
  H.check("afterDelay: not written at once", disk("c.ts"):find("^delayed") == nil, disk("c.ts"))
  H.expect("afterDelay: written after the delay, still on the file", function()
    return disk("c.ts"):find("^delayed") ~= nil and H.file() == "c.ts" and H.lua("return vim.bo.modified") == false
  end, function() return { disk("c.ts"), H.file() } end, 4000)
  H.keys("Otyping")
  H.expect("afterDelay: also while typing (Insert mode stays)", function()
    return disk("c.ts"):find("^typing") ~= nil and H.mode() == "i"
  end, function() return { disk("c.ts"), H.mode() } end, 4000)
  H.keys("<Esc>")
  feel({})

  -- tabs.preview (VS Code's preview tabs): a single click in the tree opens a preview tab, replaced by the next one
  local function open(f, opts) H.call("config.app.tree", "open_files", { dir .. "/" .. f }, opts) end
  local PREVIEW = { preview = true }
  feel({ feel = "vscode", tabs = { limit = vim.NIL, preview = true } })
  H.call("config.editor_tabs", "close_all")
  H.wait_for(function() return H.tab_bars() == "[]*" end)
  open("f1.ts", PREVIEW)
  H.expect("a preview open: a preview tab", function() return vim.deep_equal(tab("f1.ts"), { false, true }) end,
    function() return vim.inspect(tab("f1.ts")) end)
  open("f2.ts", PREVIEW)
  expect_bars("the next preview open replaces it", "f2.ts[f2.ts]*")
  H.check("...its buffer goes", H.lua("return vim.fn.bufloaded('f1.ts')") == 0)
  open("f3.ts")
  expect_bars("a normal open (Enter / double-click) keeps the preview tab", "f2.ts,f3.ts[f3.ts]*")
  open("f4.ts", PREVIEW)
  expect_bars("a preview open replaces the preview tab in its place", "f4.ts,f3.ts[f4.ts]*")
  H.keys("ggOedit<Esc>")
  H.expect("an edit pins the preview tab", function() return vim.deep_equal(tab("f4.ts"), { true, false }) end,
    function() return vim.inspect(tab("f4.ts")) end)
  H.keys("<Cmd>w<CR>")
  -- (keys are typeahead, a call runs at once: the save lands first)
  H.expect("...saved", function() return vim.deep_equal(tab("f4.ts"), { false, false }) end,
    function() return vim.inspect(tab("f4.ts")) end)
  open("f5.ts", PREVIEW)
  expect_bars("a pinned tab stays when the next preview opens", "f4.ts,f5.ts,f3.ts[f5.ts]*")
  open("f5.ts")
  H.expect("opened again without preview: pinned", function() return vim.deep_equal(tab("f5.ts"), { false, false }) end,
    function() return vim.inspect(tab("f5.ts")) end)
  open("f6.ts", PREVIEW)
  expect_bars("...and kept by the next preview", "f4.ts,f5.ts,f6.ts,f3.ts[f6.ts]*")
  H.native_focus("tree")
  local win = H.lua("return vim.api.nvim_get_current_win()")
  open("f7.ts", PREVIEW)
  expect_bars("a preview open from the tree", "f4.ts,f5.ts,f7.ts,f3.ts[f7.ts]")
  H.check("...leaves the keyboard in the tree", H.focus() == "tree" and H.lua("return vim.api.nvim_get_current_win()") == win,
    H.focus())
  H.native_focus(nil)
  feel({ tabs = { preview = false } })
  open("f8.ts", PREVIEW)
  open("f9.ts", PREVIEW)
  H.expect("preview off: a preview open is a normal tab", function()
    return vim.deep_equal(tab("f8.ts"), { false, false }) and vim.deep_equal(tab("f9.ts"), { false, false })
  end, function() return { tab("f8.ts"), tab("f9.ts") } end)
  H.check("...and nothing is replaced", tab("f7.ts") ~= nil, H.tab_bars())
  feel({})

  -- tree.autoReveal: the tree follows the editor's file (Rust selects it)
  local function follows(f)
    return function(p) return p.file and p.file:sub(-#f - 1) == "/" .. f end
  end
  H.bridge_clear()
  feel({ tree = { autoReveal = true } })
  H.check("autoReveal on: the shown file at once", H.wait_bridge("tree", "follow", follows("f9.ts")) ~= nil,
    vim.inspect(H.bridge("tree")))
  edit("a.ts")
  H.check("autoReveal: an opened file", H.wait_bridge("tree", "follow", follows("a.ts")) ~= nil, vim.inspect(H.bridge("tree")))
  feel({})
  H.bridge_clear()
  edit("b.ts")
  H.settle(200)
  H.check("autoReveal off: no follow", #H.bridge("tree", "follow") == 0, vim.inspect(H.bridge("tree", "follow")))

  -- Feel vscode's breadcrumbs under the tabs (#128): the file's folders (no project name), its name, the
  -- symbols around the caret, following it; the layout keeps their strip under the split's tab bar
  local function crumbs_of(p)
    for _, b in ipairs(p.bars or {}) do
      if b.crumbs and b.crumbs.file == "x.ts" then return b.crumbs end
    end
  end
  local function strip(p)
    for _, w in ipairs(p.wins or {}) do if w.crumbs then return true end end
    return false
  end
  H.bridge_clear()
  feel({ feel = "vscode" })
  H.check("vscode: the layout keeps the breadcrumbs strip", H.wait_bridge("layout", "windows", strip) ~= nil,
    vim.inspect(H.last("layout", "windows")))
  edit("src/deep/x.ts")
  -- (Feel vscode with Vim mode on: stock Vim keys, #214)
  H.keys("j")
  local got = H.wait_bridge("tabs", "bars", function(p)
    local c = crumbs_of(p)
    return c and #c.symbols == 1
  end)
  local c = got and crumbs_of(got)
  H.check("breadcrumbs: src › deep › x.ts › outer", c ~= nil and table.concat(c.folders, "/") == "src/deep"
    and c.symbols[1].name == "outer" and c.symbols[1].kind == "Function", vim.inspect(c or H.last("tabs", "bars")))
  H.bridge_clear()
  H.keys("jj")
  H.check("...following the caret: past the function, z", H.wait_bridge("tabs", "bars", function(p)
    local cc = crumbs_of(p)
    return cc and #cc.symbols == 1 and cc.symbols[1].name == "z"
  end) ~= nil, vim.inspect(H.last("tabs", "bars")))
  H.bridge_clear()
  feel({})
  H.check("any other Feel: no strip", H.wait_bridge("layout", "windows", function(p) return not strip(p) end) ~= nil)
  H.check("...and no breadcrumbs in the bars", H.wait_bridge("tabs", "bars", function(p) return crumbs_of(p) == nil end) ~= nil)

  -- Normal mode first (config/app/normal.lua) ------------------------------------------------------------
  -- A move the app makes (Rust's lua::navigate: normal.call, here a tab click) or a key that acts anywhere (⌥⌘→)
  -- from Neovim's command line, with an operator pending or in Insert / Visual mode: Normal mode first, then the
  -- move. A search typed is cancelled as Esc cancels it: the caret back where it was, the last pattern kept.
  H.lua("vim.cmd('silent! only') return true")
  edit("a.ts")
  edit("src/deep/x.ts")
  H.lua("vim.fn.setreg('/', 'kept') vim.api.nvim_win_set_cursor(0, { 1, 0 }) return true")
  local function to(file)
    return H.lua("return vim.api.nvim_get_current_win()"), H.lua("return vim.fn.bufnr(...)", { file })
  end
  -- (`:` is Command mode's: `::`, colon.cmdline, opens Neovim's. `d` waits out 'timeoutlen' for the maps that
  -- start with it, a prompt H.lua would answer with Enter)
  local wait_d = H.lua("return vim.o.timeoutlen") + 200
  local function type_pending(keys)
    if keys:sub(1, 1) == ":" then
      H.call("config.app.colon", "cmdline")
      keys = keys:sub(2)
    end
    H.keys(keys, keys == "d" and wait_d or nil)
  end
  for _, row in ipairs({ { "/", "/let" }, { ":", ":ech" }, { "d", "d" }, { "Insert", "i" }, { "Visual", "v" } }) do
    local from = H.file()
    local other = from == "a.ts" and "src/deep/x.ts" or "a.ts"
    type_pending(row[2])
    H.call("config.app.normal", "call", "config.app.tabs", "activate", to(other))
    H.expect(row[1] .. ": a tab click goes to " .. other .. " in Normal mode", function()
      return H.lua("return vim.fn.expand('%')") == other and H.mode() == "n"
    end, function() return { H.lua("return vim.fn.expand('%')"), H.mode() } end)
  end
  H.check("the search was cancelled: the last pattern kept", H.lua("return vim.fn.getreg('/')") == "kept",
    H.lua("return vim.fn.getreg('/')"))
  edit("src/deep/x.ts")
  H.check("...x.ts's caret where it was before `/let` moved it to line 4: line 1", H.cursor()[1] == 1, H.cursor())
  for _, pending in ipairs({ "/let", ":ech", "d" }) do
    local from = H.file()
    type_pending(pending)
    H.keys("<M-D-Right>")
    H.expect(pending .. " then ⌥⌘→: the next tab, in Normal mode", function()
      return H.file() ~= from and H.mode() == "n"
    end, function() return { H.file(), H.mode() } end)
  end
  -- a click into the file from the command line: Normal mode, the caret where it was clicked
  edit("src/deep/x.ts")
  H.lua("vim.api.nvim_win_set_cursor(0, { 1, 0 }) return true")
  H.keys("/let")
  H.click(H.lua("return vim.api.nvim_get_current_win()"), 2, 4) -- (rows from 0: line 3)
  H.expect("/let, then a click on line 3: there, in Normal mode", function()
    return H.mode() == "n" and H.cursor()[1] == 3
  end, function() return { H.mode(), H.cursor() } end)
  -- a move that fails says so in a balloon, in Normal mode: never nothing
  H.allow_errors("config.app.tabs has no no_such_move")
  H.bridge_clear()
  H.keys("/let")
  H.call("config.app.normal", "call", "config.app.tabs", "no_such_move")
  H.check("a move that fails: a balloon saying why", H.wait_bridge("popups", "balloon", function(p)
    return p.title == "Couldn't go there" and p.msg == "config.app.tabs has no no_such_move"
  end) ~= nil, vim.inspect(H.bridge("popups")))
  H.check("...after the command line was left", H.mode() == "n", H.mode())
end)
