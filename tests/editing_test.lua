-- Editing like WebStorm (headless engine checks; what's drawn is the cargo suite's): multiple carets (Clone
-- Caret Above / Below), Extend / Shrink Selection (Cmd+W / Cmd+Shift+W), Cmd keys in insert mode, Duplicate
-- (Cmd+D), whole-line copy / cut / paste, deletes keeping the clipboard, Select mode, method jumps, comments,
-- folding, autosave on leaving a file (formatted in the background), the `.log` postfix template, `:` (Command
-- mode; a count keeps Neovim's range).
local H = dofile(os.getenv("NVT_HARNESS"))
local K = H.KEY
local ESC = "<Esc>"

local BIG = { "export function big() {" }
for i = 1, 3000 do BIG[#BIG + 1] = ("  const v%d = { key: 'value %d', n: %d };"):format(i, i, i) end
BIG[#BIG + 1] = "}"

local FILES = {
  ["sel.ts"] = {
    "const getPeriod = (startDate: Date, endDate: Date) => {",
    "  const period = {",
    "    from: format(startDate, 'YYYY-MM-DD'),",
    "    to: format(endDate, 'YYYY-MM-DD'),",
    "  };",
    "  return period;",
    "};",
  },
  ["text.txt"] = { "alpha one", "beta two", "gamma three", "", "delta four" },
  ["carets.txt"] = { "alpha one", "beta two", "gamma three", "delta four", "epsilon five", "zeta six" },
  ["feat.ts"] = {
    'import { add } from "./a";',
    "",
    "export function outer(list: number[]) {",
    "  const total = list.map((x) => {",
    "    return add(x, 1);",
    "  });",
    "  return total;",
    "}",
    "",
    "export const config = {",
    '  name: "alpha",',
    '  other: "alpha beta alpha",',
    "};",
  },
  ["post.ts"] = { "const user = { name: 'x' };", "" },
  ["broken.ts"] = { "const x = {", "" },
  ["big.ts"] = BIG,
}
-- badly formatted header, then plenty of formatted lines to scroll
local UGLY = { "const   a = {x:1,", "  y:2}" }
for i = 1, 100 do UGLY[#UGLY + 1] = ("const k%d = %d;"):format(i, i) end
FILES["ugly.ts"] = UGLY
local DIR = H.project("editing", FILES)

-- Selected text (visual mode), "" outside it
local SEL = [[
  local v, c = vim.fn.getpos('v'), vim.fn.getpos('.')
  if not vim.fn.mode():match('^[vV]') then return '' end
  if v[2] > c[2] or (v[2] == c[2] and v[3] > c[3]) then v, c = c, v end
  local ec = vim.fn.mode() == 'V' and #vim.fn.getline(c[2]) or math.min(c[3], #vim.fn.getline(c[2]))
  local sc = vim.fn.mode() == 'V' and 1 or v[3]
  return table.concat(vim.api.nvim_buf_get_text(0, v[2] - 1, sc - 1, c[2] - 1, ec, {}), '\n')]]
local function sel() return H.lua(SEL) end
local function text() return table.concat(H.lua("return vim.api.nvim_buf_get_lines(0, 0, -1, false)") or {}, "|") end
local function cur() return H.cursor() or {} end
local function at(l, c) H.lua(("vim.api.nvim_win_set_cursor(0, { %d, %d })"):format(l, c)) end
local function clip() return H.clipboard() end

-- Folds of the current window: first line of the closed fold holding lnum (-1: open), its fold text ("" if open)
local function closed(lnum) return H.lua(("return vim.fn.foldclosed(%d)"):format(lnum)) end
local function ftext(lnum)
  return H.lua(("local s = vim.fn.foldclosed(%d) return s == -1 and '' or vim.fn.foldtextresult(s)"):format(lnum)) or ""
end
local function has(s, part) return s:find(part, 1, true) ~= nil end
local function all_open()
  return H.lua("for l = 1, vim.fn.line('$') do if vim.fn.foldclosed(l) ~= -1 then return false end end return true")
end
local function folds() -- failure detail
  return H.lua([[local out = {}
    for l = 1, vim.fn.line('$') do
      local s = vim.fn.foldclosed(l)
      if s == l then out[#out + 1] = l .. '-' .. vim.fn.foldclosedend(l) .. ': ' .. vim.fn.foldtextresult(l) end
    end
    return out]])
end

-- A file in the split with its fixture text, normal mode, one caret, caret at the top (setup only)
local function fresh(name)
  H.keys(ESC .. ESC)
  H.lua(([[
    pcall(function() require('multicursor-nvim').clearCursors() end)
    require('config.focus').editor()
    vim.cmd('silent! wall') -- 'confirm' would ask about the modified file
    vim.cmd('edit ' .. vim.fn.fnameescape(%q))
    vim.api.nvim_buf_set_lines(0, 0, -1, false, %s)
    vim.cmd('normal! gg0')]]):format(name, vim.inspect(FILES[name])))
  H.wait_for(("vim.fn.expand('%%:t') == %q and vim.api.nvim_get_mode().mode == 'n'"):format(name))
end

-- The editor context menu at the caret (Cmd+Enter) -> the native menu's payload; picks the item `label`
local function context_menu(label)
  H.bridge_clear()
  H.keys(K.cmd_enter)
  local menu = H.wait_menu()
  return H.menu_choose(menu, label), H.menu_labels(menu)
end

H.run(function()
  H.start(DIR, { "sel.ts" })

  -- Multiple carets ------------------------------------------------------------------------------------
  fresh("carets.txt")
  H.keys(K.ctrlOe)
  H.keys(K.ctrlOe) -- carets on 1, 2, 3
  H.keys(K.ctrl_l) -- going back removes the passed one: 1, 2
  H.keys("ö") -- moves only the caret being placed: 1, 3
  H.keys(K.ctrlOe) -- 1, 3, 4
  H.keys("IX" .. ESC)
  H.expect("Ctrl+Ö / Ctrl+L / ö place carets, typing goes to every caret", function()
    return text() == "Xalpha one|beta two|Xgamma three|Xdelta four|epsilon five|zeta six"
  end, text)
  H.keys(ESC)
  H.keys("A!" .. ESC)
  H.expect("Esc collapses to one caret, typing goes to one line", function()
    return text() == "Xalpha one|beta two|Xgamma three|Xdelta four!|epsilon five|zeta six"
  end, text)
  fresh("carets.txt")
  H.keys(K.ctrlOe)
  H.keys(K.cmdW)
  H.keys("d")
  H.expect("Cmd+W selects the word at every caret", function()
    return text() == " one| two|gamma three|delta four|epsilon five|zeta six"
  end, text)
  fresh("carets.txt")
  H.keys("2|iX")
  H.keys(K.ctrlOe)
  H.keys("Y" .. ESC)
  H.expect("insert mode Ctrl+Ö adds a caret below, typing goes on at both", function()
    return text() == "aXYlpha one|beYta two|gamma three|delta four|epsilon five|zeta six"
  end, text)
  H.keys(ESC .. ESC)

  -- Live insert: every caret's row changes while still typing (WebStorm), not only once Insert mode ends
  local function rows(a, b) return table.concat(H.lines(a - 1, b) or {}, "|") end
  local function typing(want, a, b, mode)
    return function() return H.mode() == (mode or "i") and rows(a or 1, b or 3) == want end
  end
  local function seen(a, b) return function() return H.mode() .. " " .. rows(a or 1, b or 6) end end
  local function carets3(name)
    fresh(name or "carets.txt")
    H.keys(K.ctrlOe)
    H.keys(K.ctrlOe) -- carets on 1, 2, 3
  end
  carets3()
  H.keys("A!")
  H.expect("live: A + a key types at the end of every caret's line (different lengths) before Esc",
    typing("alpha one!|beta two!|gamma three!"), seen())
  H.keys(K.bs)
  H.keys("?")
  H.expect("live: Backspace and a key at every caret", typing("alpha one?|beta two?|gamma three?"), seen())
  H.keys(K.enter)
  H.expect("live: Enter splits the line at every caret", typing("alpha one?||beta two?||gamma three?|", 1, 6), seen())
  H.paste("P")
  H.expect("live: Cmd+V pastes at every caret", typing("alpha one?|P|beta two?|P|gamma three?|P", 1, 6), seen())
  H.keys(ESC)
  H.expect("live: Esc keeps the text, Normal mode", function()
    return H.mode() == "n" and rows(1, 6) == "alpha one?|P|beta two?|P|gamma three?|P"
  end, seen())
  H.keys("u")
  H.expect("live: one undo takes back the whole insert at every caret",
    function() return text() == table.concat(FILES["carets.txt"], "|") end, text)
  -- Esc leaves every caret on its last typed char (one left, as Vim): x deletes it everywhere; . repeats
  carets3()
  H.keys("A12")
  H.keys(ESC)
  H.keys("x")
  H.expect("live: after Esc each caret is on its last typed char", function()
    return rows(1, 4) == "alpha one1|beta two1|gamma three1|delta four"
  end, seen())
  H.keys("A3")
  H.keys(ESC)
  H.keys(".")
  H.expect("live: dot-repeat of the insert at every caret", function()
    return rows(1, 4) == "alpha one133|beta two133|gamma three133|delta four"
  end, seen())

  -- Ctrl+N matches mid-line, two on one line: ciw replaces every word as it's typed
  fresh("feat.ts")
  at(11, 9)
  H.keys("<C-n>")
  H.keys("<C-n>")
  H.keys("ciwomega")
  H.expect("live: Ctrl+N words (two on one line), ciw + typing changes every match",
    typing('  name: "omega",|  other: "omega beta omega",', 11, 12), seen(11, 12))
  H.keys(ESC)
  H.keys("u")
  H.expect("live: undo after ciw", function() return rows(11, 12) == '  name: "alpha",|  other: "alpha beta alpha",' end,
    seen(11, 12))

  -- Replace mode overwrites at every caret, Backspace gives back each caret's own text
  carets3()
  H.keys("RXY")
  H.expect("live: Replace mode overwrites at every caret", typing("XYpha one|XYta two|XYmma three", 1, 3, "R"),
    seen())
  H.keys(K.bs)
  H.expect("live: Replace mode Backspace restores each caret's text", typing("Xlpha one|Xeta two|Xamma three", 1, 3, "R"),
    seen())
  H.keys(ESC)

  -- Cmd+Backspace (<C-u>): each caret deletes what it typed, then the rest of its line
  carets3()
  H.keys("A-x")
  H.keys("<D-BS>")
  H.expect("live: Cmd+Backspace deletes what was typed at every caret", typing("alpha one|beta two|gamma three"),
    seen())
  H.keys("<D-BS>")
  H.expect("live: Cmd+Backspace again: each line to its start", typing("||"), seen())
  H.keys(ESC)

  -- o opens a line under every caret
  carets3()
  H.keys("o-")
  H.expect("live: o opens a line under every caret", typing("alpha one|-|beta two|-|gamma three|-", 1, 6), seen())
  H.keys(ESC)

  -- I on a selection (multicursor's insertVisual): a caret at the start of each selected line
  fresh("carets.txt")
  H.keys(K.ctrlOe)
  H.keys("vö")
  H.keys("I")
  H.keys("#")
  H.expect("live: v + I puts a caret on every selected line, typing goes to all",
    typing("#alpha one|#beta two|#gamma three|delta four", 1, 4), seen())
  H.keys(ESC)

  -- A plain click while typing drops the other carets (WebStorm); their text stays
  carets3()
  H.keys("iX")
  H.wait_for(typing("Xalpha one|Xbeta two|Xgamma three"))
  local cw = H.lua([[local w = vim.api.nvim_get_current_win()
    return { w, vim.fn.getwininfo(w)[1].textoff, vim.fn.line('w0') }]]) or {}
  H.click(cw[1], 4 - (cw[3] or 1), (cw[2] or 0) + 2)
  H.expect("live: a click while typing leaves one caret", "require('multicursor-nvim').numCursors() == 1")
  H.keys("Y")
  H.expect("live: then typing goes to the clicked spot only", function()
    return H.mode() == "i" and rows(1, 4) == "Xalpha one|Xbeta two|Xgamma three|deYlta four"
  end, seen(1, 4))
  H.keys(ESC)

  -- 50 carets: key to the frame showing the key at all of them (nvim CPU time, median of 9)
  fresh("carets.txt")
  H.lua("local l = {} for i = 1, 60 do l[i] = 'row ' .. i end vim.api.nvim_buf_set_lines(0, 0, -1, false, l)")
  H.keys(("<C-ö>"):rep(49))
  H.expect("50 carets placed", "require('multicursor-nvim').numCursors() == 50")
  H.keys("A")
  H.lua([[
    local L = { cpu = {}, n = 0 }
    _G.mc_live_lat = L
    local ns = vim.api.nvim_create_namespace('mc_live_latency')
    vim.on_key(function() if L.armed and not L.t then L.t = os.clock() end end, ns)
    vim.api.nvim_set_decoration_provider(ns, { on_end = function()
      if not L.t then return end
      local want = ('x'):rep(L.n)
      if vim.fn.getline(1):sub(-#want) == want and vim.fn.getline(50):sub(-#want) == want then
        L.cpu[#L.cpu + 1] = (os.clock() - L.t) * 1e3
        L.t, L.armed = nil, false
      end
    end })]])
  for _ = 1, 10 do
    H.lua("mc_live_lat.n = mc_live_lat.n + 1 mc_live_lat.armed = true")
    H.keys("x")
    H.wait_for("mc_live_lat.armed == false", 3000)
  end
  H.budget("live: typing with 50 carets, key to frame (nvim CPU)", H.lua("return vim.list_slice(mc_live_lat.cpu, 2)") or {}, 5)
  H.expect("live: 50 carets all typed", function()
    local l = H.lines(0, 50) or {}
    for _, s in ipairs(l) do
      if s:sub(-10) ~= ("x"):rep(10) then return false end
    end
    return #l == 50
  end, function() return rows(48, 51) end)
  H.keys(ESC .. ESC)

  -- ...and a language server sees the same text, the other carets' edits as one change per key (#225: nvim's
  -- change tracking costs ~25 µs per edit and client, so 50 carets were half the keystroke's budget)
  fresh("carets.txt")
  H.lua("local l = {} for i = 1, 60 do l[i] = 'row ' .. i end vim.api.nvim_buf_set_lines(0, 0, -1, false, l)")
  H.lua([[
    local F = { changes = 0 }
    _G.fake_lsp = F
    local function off(text, pos) -- ASCII: characters are bytes
      local o = 0
      for _ = 1, pos.line do o = (text:find('\n', o + 1, true) or #text) end
      return o + pos.character
    end
    local function server(dispatchers)
      local closing = false
      local function exit()
        if closing then return end
        closing = true
        dispatchers.on_exit(0, 15)
      end
      return {
        request = function(method, _, callback)
          if method == 'initialize' then
            callback(nil, { capabilities = { textDocumentSync = { openClose = true, change = 2 } } })
          elseif method == 'shutdown' then
            callback(nil, vim.NIL)
          end
          return true, 1
        end,
        notify = function(method, params)
          if method == 'textDocument/didOpen' then
            F.text = params.textDocument.text
          elseif method == 'textDocument/didChange' and F.text then -- (changes pending before it opened: flushed first)
            for _, ch in ipairs(params.contentChanges) do
              F.changes = F.changes + 1
              local a, b = off(F.text, ch.range.start), off(F.text, ch.range['end'])
              F.text = F.text:sub(1, a) .. ch.text .. F.text:sub(b + 1)
            end
          elseif method == 'exit' then
            exit()
          end
          return true
        end,
        is_closing = function() return closing end,
        terminate = exit,
      }
    end
    F.id = vim.lsp.start({ name = 'fake225', cmd = server, root_dir = vim.fn.getcwd() }, { bufnr = 0 })]])
  local function lsp_sees()
    return H.lua([[local F = fake_lsp
      return F.text == table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\n') .. '\n']])
  end
  H.expect("live: the language server has the file", lsp_sees, "=fake_lsp.text")
  H.keys(("<C-ö>"):rep(19))
  H.expect("live: 20 carets placed", "require('multicursor-nvim').numCursors() == 20")
  H.lua("fake_lsp.changes = 0")
  H.keys("A")
  for _, k in ipairs({ "a", "b", "<CR>", "c", "<BS>", "<BS>", "d" }) do H.keys(k) end
  H.keys(ESC)
  H.expect("live: typing, Enter and Backspace at 20 carets reach the language server as the buffer has them",
    function() return lsp_sees() and H.lua("return vim.api.nvim_buf_get_lines(0, 0, 1, false)[1]") == "row 1abd" end,
    function() return { H.lua("return fake_lsp.text"), rows(1, 3) } end)
  local changes = H.lua("return fake_lsp.changes") or -1
  H.check("live: ...as one change per key at the other carets, not one per caret", changes <= 2 * 8, changes)
  H.keys(ESC .. ESC)
  H.lua("vim.lsp.get_client_by_id(fake_lsp.id):stop(true)")
  H.expect("live: the language server stopped", "vim.lsp.get_client_by_id(fake_lsp.id) == nil")

  -- Extend / Shrink Selection -------------------------------------------------------------------------
  fresh("sel.ts")
  at(3, 30) -- in YYYY of the first string
  local steps = {}
  for _ = 1, 9 do
    local before = sel()
    H.keys(K.cmdW)
    H.wait_for(function() return sel() ~= before end, 1000)
    steps[#steps + 1] = sel()
  end
  local want = {
    "YYYY", "YYYY-MM-DD", "'YYYY-MM-DD'", "startDate, 'YYYY-MM-DD'", "(startDate, 'YYYY-MM-DD')",
    "format(startDate, 'YYYY-MM-DD')", "from: format(startDate, 'YYYY-MM-DD')",
    "from: format(startDate, 'YYYY-MM-DD'),\n    to: format(endDate, 'YYYY-MM-DD'),",
    "{\n    from: format(startDate, 'YYYY-MM-DD'),\n    to: format(endDate, 'YYYY-MM-DD'),\n  }",
  }
  H.check("Cmd+W extends: word, string contents, string, arguments, call, property, properties, object",
    vim.deep_equal(steps, want), vim.inspect(steps))
  local back = {}
  for _ = 1, 4 do
    local before = sel()
    H.keys(K.cmdShiftW)
    H.wait_for(function() return sel() ~= before end, 1000)
    back[#back + 1] = sel()
  end
  H.check("Cmd+Shift+W shrinks back through the same steps", vim.deep_equal(back, { want[8], want[7], want[6], want[5] }), vim.inspect(back))
  H.keys(ESC)
  at(3, 30)
  H.keys(K.cmdW .. K.cmdW)
  H.keys(K.cmdShiftW .. K.cmdShiftW)
  H.expect("Cmd+Shift+W after the first step: no selection, the caret where Cmd+W started", function()
    return H.mode() == "n" and cur()[1] == 3 and cur()[2] == 30
  end, function() return H.mode() .. " " .. vim.inspect(cur()) .. " " .. sel() end)
  H.keys(K.cmdShiftW)
  H.check("Cmd+Shift+W with nothing selected does nothing", H.mode() == "n" and cur()[2] == 30, H.mode())
  at(3, 4)
  H.keys("viw")
  H.keys(K.cmdShiftW)
  H.expect("Cmd+Shift+W on a word selected by hand never grows it", function() return sel() == "" or #sel() < 4 end, sel)
  H.keys(ESC)
  at(6, 4)
  H.keys(K.cmdW .. K.cmdW .. K.cmdW)
  H.expect("Cmd+W in a function body: its statements before the braces", function()
    return sel() == "const period = {\n    from: format(startDate, 'YYYY-MM-DD'),\n    to: format(endDate, 'YYYY-MM-DD'),\n  };\n  return period;"
  end, sel)
  H.keys(ESC)
  at(1, 49) -- on ")" right after "Date"
  H.keys(K.cmdW)
  H.expect("Cmd+W on ) right after a word selects the word", function() return sel() == "Date" end, sel)
  H.keys(ESC)
  at(6, 0)
  H.keys("A")
  at(6, 15) -- "return period|;"
  H.keys(K.cmdW)
  H.expect("insert mode Cmd+W selects the word left of the caret", function() return sel() == "period" end, sel)
  H.keys(ESC)
  -- plain text (no parser): word, line, paragraph, file
  fresh("text.txt")
  H.keys("ö0")
  local t = {}
  for _ = 1, 4 do
    local before = sel()
    H.keys(K.cmdW)
    H.wait_for(function() return sel() ~= before end, 1000)
    t[#t + 1] = sel()
  end
  H.check("plain text Cmd+W: word, line, paragraph, file", vim.deep_equal(t,
    { "beta", "beta two", "alpha one\nbeta two\ngamma three", "alpha one\nbeta two\ngamma three\n\ndelta four" }), vim.inspect(t))
  -- a block bigger than the screen: the view doesn't jump
  fresh("big.ts")
  at(6, 10)
  local top = H.lua("return vim.fn.line('w0')")
  H.keys(K.cmdW .. K.cmdW .. K.cmdW .. K.cmdW)
  H.expect("Cmd+W to a block bigger than the screen: view stays, caret at its start", function()
    return H.lua("return vim.fn.line('w0')") == top and sel():sub(1, 12) == "const v1 = {" and cur()[1] == 2
  end, function() return H.lua("return vim.fn.line('w0')") .. " vs " .. top .. " " .. sel():sub(1, 30) .. " " .. vim.inspect(cur()) end)
  H.keys(ESC)

  -- Cmd keys in insert mode: none types its name ("<D-x>") ------------------------------------------
  -- mapped ones and ones nothing maps (config/app.lua drops those); not here: keys that leave the editor for
  -- good (terminal, Cmd+Q, Find, Find in Files, pickers, Git, the context menu, tool windows)
  local CMD_KEYS = {
    "<D-w>", "<D-S-w>", "<D-c>", "<D-x>", "<D-z>", "<D-S-z>", "<D-a>", "<D-s>", "<D-d>", "<D-/>", "<D-S-7>",
    "<D-->", "<D-S-->", "<D-=>", "<D-S-=>", "<M-D-z>", "<D-b>", "<D-l>", "<M-D-l>", "<D-r>", "<D-ö>", "<D-2>",
    "<D-e>", "<D-n>", "<D-u>", "<D-j>", "<D-p>", "<D-y>", "<D-9>", "<D-Up>", "<D-Down>", "<D-;>",
    "<D-'>", "<D-.>", "<D-,>", "<D-ä>", "<D-å>", "<D-S-+>",
  }
  local typed = {}
  for _, key in ipairs(CMD_KEYS) do
    fresh("text.txt")
    H.keys("ö3|i")
    H.wait_for("vim.api.nvim_get_mode().mode == 'i'", 1000)
    H.keys(key)
    local all = table.concat(H.lua("return vim.api.nvim_buf_get_lines(vim.fn.bufnr('text.txt'), 0, -1, false)") or {}, "|")
    if all:find("<", 1, true) or all:find("[\1-\31]") or all:find("ö", 1, true) then typed[#typed + 1] = key .. " -> " .. all end
  end
  H.check("no Cmd key types its name in insert mode", #typed == 0, #CMD_KEYS .. " keys: " .. table.concat(typed, "; "))

  -- Duplicate (Cmd+D) ----------------------------------------------------------------------------------
  fresh("text.txt")
  H.keys("ö5|" .. K.cmdD)
  H.expect("Cmd+D: line copied below, caret on the copy in the same column", function()
    return text() == "alpha one|beta two|beta two|gamma three||delta four" and cur()[1] == 3 and cur()[2] == 4
  end, function() return text() .. " " .. vim.inspect(cur()) end)
  fresh("text.txt")
  H.keys("ö5|i")
  H.keys(K.cmdD)
  H.expect("Cmd+D in insert mode: line copied, still typing", function()
    return text() == "alpha one|beta two|beta two|gamma three||delta four" and H.mode() == "i"
  end, text)
  fresh("text.txt")
  H.keys("ö0" .. K.cmdW .. K.cmdD)
  H.expect("Cmd+D on a word: copy right after it, the copy selected", function()
    return text() == "alpha one|betabeta two|gamma three||delta four" and sel() == "beta" and cur()[2] == 7
  end, function() return text() .. " " .. sel() end)
  fresh("text.txt")
  H.keys("öVö" .. K.cmdD)
  H.expect("Cmd+D on lines: copied below, the copy selected", function()
    return text() == "alpha one|beta two|gamma three|beta two|gamma three||delta four" and sel() == "beta two\ngamma three" and cur()[1] == 5
  end, function() return text() .. " " .. sel() end)

  fresh("feat.ts")
  H.wait_for("vim.wo.foldmethod == 'expr'", 3000)
  at(5, 4)
  H.keys(K.cmdMinus)
  H.wait_for(function() return closed(5) == 4 end)
  H.keys(K.cmdD)
  H.expect("Cmd+D on a collapsed region: all of it copied below it, caret on the copy", function()
    local l = H.lines(3, 10) or {}
    return l[1] == "  const total = list.map((x) => {" and l[4] == l[1] and l[5] == "    return add(x, 1);" and l[6] == "  });"
      and l[7] == "  return total;" and cur()[1] == 7
  end, function() return vim.inspect({ H.lines(3, 9), cur() }) end)
  H.keys(K.cmdShiftEq)

  -- Whole-line copy / cut / paste (Cmd+V: the app's <D-v> pastes the clipboard) -------------------------
  fresh("text.txt")
  H.keys("ö" .. K.cmdC)
  H.keys("ö5|" .. K.cmdV)
  H.expect("Cmd+C on a line, Cmd+V: the line goes above, caret stays in its text", function()
    return text() == "alpha one|beta two|beta two|gamma three||delta four" and cur()[1] == 4 and cur()[2] == 4
  end, function() return text() .. " " .. vim.inspect(cur()) end)
  fresh("text.txt")
  H.keys("ö" .. K.cmdX)
  H.keys("ö3|i")
  H.keys(K.cmdV)
  H.expect("Cmd+X on a line, Cmd+V in insert mode: the line goes above", function()
    return text() == "alpha one|gamma three|beta two||delta four"
  end, text)
  fresh("text.txt")
  H.keys("ö" .. K.cmdC)
  H.keys("ö5|")
  local picked, labels = context_menu("Paste")
  H.expect("context menu Paste of a copied line: same as Cmd+V", function()
    return picked and text() == "alpha one|beta two|beta two|gamma three||delta four" and cur()[1] == 4 and cur()[2] == 4
  end, function() return text() .. " " .. vim.inspect(cur()) .. " menu: " .. table.concat(labels, ", ") end)
  fresh("text.txt")
  H.keys("ö5|")
  H.paste("other text\n")
  H.expect("Cmd+V of other text: at the caret as usual", function() return text():find("beta other text", 1, true) ~= nil end, text)
  fresh("text.txt")
  H.keys("ö0" .. K.cmdW)
  H.paste("XX")
  H.expect("Cmd+V over a selection replaces it, the clipboard keeps the pasted text", function()
    return H.line(2) == "XX two" and clip() == "XX"
  end, function() return H.line(2) .. " / " .. tostring(clip()) end)
  fresh("text.txt")
  H.keys("ö0" .. K.cmdW .. K.cmdC)
  H.expect("Cmd+C copies the selection and keeps it selected", function()
    return sel() == "beta" and clip() == "beta"
  end, sel)

  -- Deletes and changes keep the clipboard (they go to register z: `,p`) ----------------------------------
  local DEL = "<Del>"
  for _, c in ipairs({
    { "Delete", "ö0" .. DEL, "eta two" },
    { "D", "ö4|D", "bet" },
    { "C", "ö4|Cx" .. ESC, "betx" },
    { "S", "öSx" .. ESC, "x" },
    { "selection + Delete", "ö0vä" .. DEL, "ta two" },
    { "selection + D", "ö0vD", "gamma three" },
    { "selection + X", "ö0vX", "gamma three" },
    { "selection + C", "ö0vCx" .. ESC, "x" },
    { "selection + R", "ö0vRx" .. ESC, "x" },
    { "selection + s", "ö0väsx" .. ESC, "xta two" },
    { "typing over a Select-mode selection", "ö0vä<C-g>x" .. ESC, "xta two" },
  }) do
    fresh("text.txt")
    H.lua("vim.fn.setreg('+', 'KEEP')")
    H.keys(c[2])
    H.expect(c[1] .. ": the clipboard keeps its text", function() return H.line(2) == c[3] and clip() == "KEEP" end,
      function() return { H.line(2), clip(), H.mode() } end)
  end
  fresh("text.txt")
  H.keys("ö4|D")
  H.keys(",p")
  H.expect(",p pastes the last delete (D)", function() return H.line(2) == "beta two" end, function() return H.line(2) end)

  -- Select mode (a snippet's placeholder, a field's preselected text): Cmd+C copies, Cmd+X cuts ----------
  fresh("text.txt")
  H.keys("ö0i")
  H.lua("vim.snippet.expand('foo(${1:arg})')")
  H.wait_for("vim.fn.mode() == 's'")
  H.keys(K.cmdC)
  H.expect("Cmd+C on a snippet placeholder (Select mode): copied, still selected", function()
    return clip() == "arg" and H.mode() == "s" and H.line(2) == "foo(arg)beta two"
  end, function() return { clip(), H.mode(), H.line(2) } end)
  H.lua("vim.fn.setreg('+', 'KEEP')")
  H.keys("x")
  H.expect("typing over it: replaced, the clipboard keeps its text", function()
    return H.line(2) == "foo(x)beta two" and clip() == "KEEP"
  end, function() return { clip(), H.mode(), H.line(2) } end)
  fresh("text.txt")
  H.keys("ö0vä<C-g>")
  H.wait_for("vim.fn.mode() == 's'")
  H.keys(K.cmdX)
  H.expect("Cmd+X on a Select-mode selection: cut into the clipboard, typing goes on", function()
    return clip() == "be" and H.line(2) == "ta two" and H.mode() == "i"
  end, function() return { clip(), H.mode(), H.line(2) } end)
  H.keys(ESC)

  -- Command line: no selection there, Cmd+C / Cmd+X do nothing
  fresh("text.txt")
  H.lua("vim.fn.setreg('+', 'KEEP')")
  H.call("config.app.colon", "cmdline")
  H.keys("echo 1" .. K.cmdC .. K.cmdX)
  H.expect("Cmd+C / Cmd+X in the command line: nothing typed, nothing copied", function()
    return H.lua("return vim.fn.getcmdline()") == "echo 1" and clip() == "KEEP"
  end, function() return { H.lua("return vim.fn.getcmdline()"), clip() } end)
  H.keys(ESC)

  -- Method jumps, comments -----------------------------------------------------------------------------
  fresh("sel.ts")
  at(4, 20)
  local jumps = {}
  for _, k in ipairs({ ",s", ",s", ",s", ",S", ",S" }) do
    H.keys(k)
    local c = cur()
    jumps[#jumps + 1] = c[1] .. ":" .. c[2]
  end
  H.check(",s / ,S: up to to, period, getPeriod, then back down, on the names", table.concat(jumps, " ") == "4:4 2:8 1:6 2:8 3:4", table.concat(jumps, " "))
  at(6, 4)
  H.keys(K.cmdSlash)
  local commented = H.line(6)
  local uncommented = context_menu("Comment with Line Comment")
  H.expect("Cmd+/ comments the line, the context menu item uncomments it", function()
    return commented == "  // return period;" and uncommented and H.line(6) == "  return period;"
  end, function() return commented .. " / " .. H.line(6) end)
  -- the caret stays on its text (WebStorm), in Normal mode and while typing; a selection stays selected
  at(6, 6)
  H.keys(K.cmdSlash)
  H.expect("Cmd+/ in Normal mode: the caret stays on its text", function()
    return H.line(6) == "  // return period;" and cur()[1] == 6 and cur()[2] == 9
  end, function() return H.line(6) .. " " .. vim.inspect(cur()) end)
  H.keys(K.cmdSlash)
  H.expect("Cmd+/ again uncomments, caret back on its text", function()
    return H.line(6) == "  return period;" and cur()[2] == 6
  end, function() return H.line(6) .. " " .. vim.inspect(cur()) end)
  H.keys("i")
  H.keys(K.cmdSlash)
  H.keys("Q")
  H.expect("Cmd+/ while typing: still typing, at the same spot in the text", function()
    return H.line(6) == "  // retuQrn period;" and H.mode() == "i"
  end, function() return H.line(6) .. " " .. H.mode() end)
  fresh("sel.ts")
  at(2, 0)
  H.keys("Vö")
  H.keys(K.cmdSlash)
  H.expect("Cmd+/ on lines: commented, still selected", function()
    return H.line(2) == "  // const period = {" and H.line(3) == "  //   from: format(startDate, 'YYYY-MM-DD'),"
      and H.mode() == "V" and sel():match("^  // const period") ~= nil
  end, function() return H.line(2) .. " " .. H.mode() end)
  H.keys(K.cmdSlash)
  H.expect("Cmd+/ again on the selection uncomments all of it", function()
    return H.line(2) == "  const period = {" and H.line(3) == "    from: format(startDate, 'YYYY-MM-DD')," and H.mode() == "V"
  end, function() return H.line(2) .. " | " .. H.line(3) .. " " .. H.mode() end)
  H.keys(ESC)
  at(3, 4)
  H.keys("vö")
  local chosen = sel()
  H.keys(K.cmdSlash)
  H.expect("Cmd+/ on a character selection: the same text stays selected", function()
    return H.line(3):match("^    // from") and H.mode() == "v" and sel() == chosen:gsub("\n    t$", "\n    // t")
  end, function() return vim.inspect({ chosen, sel(), H.mode() }) end)
  H.keys(ESC)
  fresh("post.ts")
  H.keys("ggO// note" .. ESC .. "oconst x = 1;" .. ESC)
  H.expect("o after a // line starts a plain line", function() return H.line(2) == "const x = 1;" end, function() return H.line(2) end)

  -- Folding (fold state + fold text; drawing them is the grid's) -----------------------------------------
  fresh("feat.ts")
  H.wait_for("vim.wo.foldmethod == 'expr'", 3000)
  H.expect("a file opens with every region expanded", function()
    return H.lua("return vim.wo.foldmethod == 'expr' and vim.fn.foldlevel(5) > 0") and all_open()
  end, folds)
  at(5, 4)
  H.keys(K.cmdMinus)
  H.expect("Cmd+- collapses the region at the caret: first line, {...} and the closing tail", function()
    return closed(5) == 4 and has(ftext(4), "const total = list.map((x) => {...});") and closed(3) == -1
  end, folds)
  H.keys(K.cmdMinus)
  H.expect("Cmd+- again collapses the enclosing function: `outer(...) {...}`", function()
    return closed(4) == 3 and has(ftext(3), "export function outer(list: number[]) {...}")
  end, folds)
  H.keys(K.cmdEq)
  H.expect("Cmd+= expands one level: the function open, the inner region still collapsed", function()
    return closed(3) == -1 and closed(5) == 4 and has(ftext(4), "const total = list.map((x) => {...});")
  end, folds)
  H.keys(K.cmdEq)
  H.expect("Cmd+= again: open", function() return closed(5) == -1 end, folds)
  H.keys(K.cmdShiftMinus)
  H.expect("Cmd+Shift+- collapses all regions", function()
    return closed(4) == 3 and has(ftext(3), "export function outer(list: number[]) {...}")
      and closed(11) == 10 and has(ftext(10), "export const config = {...};")
  end, folds)
  H.keys(K.cmdShiftEq)
  H.expect("Cmd+Shift+= expands all regions", all_open, folds)
  at(11, 2)
  H.keys("i" .. K.cmdMinus)
  H.expect("Cmd+- collapses in insert mode too", function() return closed(11) == 10 end, folds)
  H.keys(ESC)
  -- a left click on the {...} placeholder (its cell in the window's grid)
  local spot = H.lua([[
    local win = vim.api.nvim_get_current_win()
    local info = vim.fn.getwininfo(win)[1]
    local ft = vim.fn.foldtextresult(10)
    local i = ft:find('{...}', 1, true)
    if not i then return nil end
    return { win = win, row = vim.fn.screenpos(win, 10, 1).row - info.winrow, col = info.textoff + vim.fn.strdisplaywidth(ft:sub(1, i - 1)) + 1 }]])
  if spot then H.click(spot.win, spot.row, spot.col) end
  H.expect("click on {...} expands it", function() return spot ~= nil and closed(11) == -1 end, function() return { spot, folds() } end)
  at(11, 4)
  H.keys("i" .. K.cmdMinus)
  H.wait_for(function() return closed(11) == 10 end)
  H.expect("Cmd+- while typing: the caret leaves the collapsed region, to its start", function()
    return H.mode() == "i" and cur()[1] == 10 and cur()[2] == #"export const config = "
  end, function() return H.mode() .. " " .. vim.inspect(cur()) end)
  H.keys("Z")
  H.expect("typing there expands the region, the text lands at the caret", function()
    return H.line(10) == "export const config = Z{" and closed(11) == -1 and H.line(11) == '  name: "alpha",'
  end, function() return { H.line(10), folds() } end)
  H.keys(ESC .. "u")
  H.wait_for("vim.fn.getline(10) == 'export const config = {'")
  at(5, 4)
  H.keys(K.cmdMinus)
  H.wait_for(function() return closed(5) == 4 end)
  H.keys(K.cmdS)
  H.wait_for("not vim.bo.modified")
  H.settle(300)
  H.check("a collapsed region survives Cmd+S (format on save)", closed(5) == 4 and has(ftext(4), "list.map((x) => {...});"), folds())
  H.lua("vim.cmd.edit('text.txt')")
  H.wait_for("vim.fn.expand('%:t') == 'text.txt'")
  H.lua("vim.cmd.edit('feat.ts')")
  H.expect("a collapsed region stays collapsed after switching files", function()
    return H.file() == "feat.ts" and closed(5) == 4
  end, folds)
  H.keys(K.cmdShiftEq)

  -- Autosave: leaving a file writes it --------------------------------------------------------------
  H.keys("ggO// autosaved" .. ESC)
  H.lua("vim.cmd.edit('text.txt')")
  H.expect("leaving a file saves it", function() return (vim.fn.readfile(DIR .. "/feat.ts")[1] or "") == "// autosaved" end,
    function() return vim.fn.readfile(DIR .. "/feat.ts")[1] end)

  -- Autosave formats in the background (WebStorm's Actions on Save), silently: no balloon for code that
  -- doesn't parse (balloons come from the notifier); a split still showing the file keeps its caret and view
  local balloons = H.lua("return #Snacks.notifier.get_history()")
  H.lua("vim.cmd.edit('broken.ts')")
  H.keys("Golet   y=2" .. ESC)
  H.lua("vim.cmd.edit('ugly.ts') vim.fn.winrestview({ topline = 60, lnum = 70, col = 0 })")
  H.keys("O// note" .. ESC)
  local VIEW = [[
    local w = vim.fn.win_findbuf(vim.fn.bufnr('ugly.ts'))[1]
    local l = vim.api.nvim_win_get_cursor(w)[1]
    return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(w), l - 1, l, false)[1] .. ' @row ' .. vim.fn.screenpos(w, l, 1).row]]
  local view = H.lua(VIEW)
  H.lua("vim.cmd('rightbelow vsplit text.txt')")
  H.expect("autosave formats the file in the background (Prettier), on disk", function()
    return (vim.fn.readfile(DIR .. "/ugly.ts")[1] or "") == "const a = { x: 1, y: 2 };"
  end, function() return table.concat(vim.list_slice(vim.fn.readfile(DIR .. "/ugly.ts"), 1, 3), "|") end, 10000)
  H.expect("the split showing it: caret on the same text, same screen row", function() return H.lua(VIEW) == view end,
    function() return H.lua(VIEW) .. " (was " .. tostring(view) .. ")" end)
  H.check("...and the buffer is saved (written again after formatting)",
    H.lua("return not vim.bo[vim.fn.bufnr('ugly.ts')].modified") == true)
  H.check("a file that doesn't parse: saved as typed, no balloon",
    vim.tbl_contains(vim.fn.readfile(DIR .. "/broken.ts"), "let   y=2") and H.lua("return #Snacks.notifier.get_history()") == balloons,
    { vim.fn.readfile(DIR .. "/broken.ts"), H.lua("return Snacks.notifier.get_history()") })
  H.lua("vim.cmd('wincmd p') vim.cmd('undo')")
  H.expect("one undo takes back the last edit with its format", function()
    return H.line(1) == "const   a = {x:1," and H.line(70) == "const k68 = 68;"
  end, function() return H.line(1) .. " | " .. H.line(70) end)
  H.lua("vim.cmd('redo') vim.cmd('silent! update') vim.cmd('wincmd p') vim.cmd('close')")

  -- .log postfix template -------------------------------------------------------------------------------
  fresh("post.ts")
  H.wait_for("vim.bo.filetype == 'typescript'")
  H.keys("Go")
  H.keys("user.name.log")
  H.keys(K.tab)
  H.expect("`user.name.log` Tab -> console.log(user.name), caret after it", function()
    return H.line(3) == "console.log(user.name)" and cur()[2] == #"console.log(user.name)"
  end, function() return H.line(3) end)
  H.keys(ESC .. "o")
  H.keys("log")
  H.keys(K.tab)
  H.keys("1")
  H.expect("`log` Tab -> console.log(|), caret inside", function() return H.line(4) == "console.log(1)" end, function() return H.line(4) end)
  H.keys(ESC .. "o")
  H.keys(K.tab)
  H.expect("plain Tab still indents", function() return (H.line(5) or ""):match("^%s+$") ~= nil end, function() return H.line(5) end)
  H.keys(ESC .. "o")
  -- the completion menu the app draws: blink's items in the floats bridge payload
  H.bridge_clear()
  H.keys("user.lo")
  local function offers_log(p)
    for _, it in ipairs(p.items or {}) do
      local all = (it.label or "") .. " " .. (it.detail or "") .. " " .. (it.description or "")
      if (it.label or ""):match("^log") and all:find("console.log(user)", 1, true) then return true end
    end
    return false
  end
  H.expect("completion list offers log  console.log(user)", function() return H.last("floats", "menu", offers_log) ~= nil end,
    function() return vim.inspect(H.last("floats", "menu", function(p) return p.items ~= nil end)) end)
  H.keys(ESC)

  -- `:` is Command mode (the app opens it); `::` comes back as Neovim's own command line -------------------
  fresh("text.txt")
  H.bridge_clear()
  H.keys(":")
  -- what the app does once Command mode has the keyboard: ends the typeahead hold
  H.call("config.app.typeahead", "focused", "toolbar")
  H.expect("`:` tells the app: Command mode, the `:` key itself", function()
    local p = H.last("toolbar", "colon")
    return p ~= nil and p.key == true
  end, function() return vim.inspect(H.bridge("toolbar")) end)
  H.check("...and Neovim's command line stays shut", H.mode() == "n", H.mode())
  -- `:` then `:w` typed before the app's field had the keyboard: `::` takes what was held along
  H.keys(":")
  H.keys("w")
  H.call("config.app.colon", "cmdline")
  H.expect("`::` is Neovim's command line, the keys typed meanwhile in it", function()
    return H.mode() == "c" and H.lua("return vim.fn.getcmdline()") == "w"
  end, function() return { H.mode(), H.lua("return vim.fn.getcmdline()") } end)
  H.keys(ESC)


  -- Feel vscode: VS Code's macOS chords (config/keymap_vscode.lua); any other Feel: WebStorm's exactly ----------
  local CHORDS = { "<D-p>", "<D-S-p>", "<D-b>", "<D-Bslash>", "<M-Up>", "<M-Down>", "<M-S-Up>",
    "<M-S-Down>", "<D-S-k>", "<D-K>", "<D-d>", "<F12>", "<S-F12>", "<F2>", "<D-.>", "<D-S-o>", "<D-t>", "<C-->",
    "<C-S-->", "<C-`>", "<D-S-e>", "<D-S-g>", "<D-w>", "<D-k>", "<D-S-f>", "<D-G>", "<D-O>", "<D-P>", "<D-E>",
    "<M-D-S-7>", "<C-S-´>", "<C-_>", "<D-F>", "<D-S-m>", "<D-M>", "<C-S-g>", "<M-D-s>", "<M-D-r>", "<M-D-f>",
    "<C-D-S-Right>", "<C-D-S-Left>", "<M-D-Left>", "<M-D-Right>" }
  local SNAPSHOT = [[
    local out = {}
    for _, lhs in ipairs(...) do
      for _, mode in ipairs({ "n", "i", "x", "s", "o" }) do
        local m = vim.fn.maparg(lhs, mode, false, true)
        local keys = vim.tbl_keys(m)
        table.sort(keys)
        local parts = {}
        for _, k in ipairs(keys) do parts[#parts + 1] = k .. "=" .. tostring(m[k]) end
        out[#out + 1] = lhs .. " " .. mode .. " {" .. table.concat(parts, ",") .. "}"
      end
    end
    return table.concat(out, "|")]]
  local function snapshot() return H.lua(SNAPSHOT, { CHORDS }) end
  local function desc(lhs, mode) return H.lua("local l, m = ... return vim.fn.maparg(l, m, false, true).desc", { lhs, mode or "n" }) end
  local webstorm = snapshot()
  H.call("config.feel", "set", { feel = "webstorm" })
  H.check("Feel webstorm keeps the WebStorm keymap as it is", snapshot() == webstorm)
  H.call("config.feel", "set", { feel = "vscode" })
  for lhs, want in pairs({
    ["<D-p>"] = "Go to file", ["<D-S-p>"] = "Command palette", ["<D-b>"] = "Toggle Project tree",
    ["<D-Bslash>"] = "Split right", ["<D-S-k>"] = "Delete line",
    ["<D-d>"] = "Add next occurrence", ["<F12>"] = "Go to definition", ["<S-F12>"] = "Find usages",
    ["<F2>"] = "Rename", ["<D-.>"] = "Quick fix", ["<D-S-o>"] = "Go to symbol in file",
    ["<D-t>"] = "Go to symbol in workspace", ["<C-->"] = "Back", ["<C-S-->"] = "Forward",
    ["<C-`>"] = "Toggle terminal", ["<C-S-g>"] = "Git (focus / hide)",
    ["<D-w>"] = "Close tab", ["<D-k>"] = "⌘K chord (⌘K ⌘S key help, ⌘K ⌘D skip occurrence)", ["<D-S-f>"] = "Find in files",
    ["<M-D-S-7>"] = "Split right", ["<C-S-´>"] = "Toggle terminal",
    ["<D-S-m>"] = "Problems", ["<D-M>"] = "Problems",
    -- VS Code's keys for WebStorm's actions (#129, the menu bar shows them)
    ["<M-D-s>"] = "Save all", ["<M-D-r>"] = "Reveal in Finder", ["<M-D-f>"] = "Replace",
    ["<C-D-S-Right>"] = "Expand selection", ["<C-D-S-Left>"] = "Shrink selection",
    ["<M-D-Left>"] = "Previous tab", ["<M-D-Right>"] = "Next tab",
  }) do
    H.check("Feel vscode: " .. lhs .. " is " .. want, desc(lhs) == want, desc(lhs))
  end
  -- ⌘⇧E (as ⌘1) is the window's pane key (app/src/shell/pane_key.rs): no map of nvim's
  H.check("Feel vscode: <D-S-e> is the window's", desc("<D-S-e>") == nil, desc("<D-S-e>"))
  -- Code's bottom panel (⌘3 / ⌘J are the app's, under every Feel: it calls these): `panel` shows its last tab with
  -- the keys, `hide_panel` hides whichever shows, `restore_panel` puts a workspace's kept panel back without the keys
  local function pane_open() return H.lua("return require('config.app.pane').is_open()") end
  local function term_open() return H.lua("return require('config.app.terminal').is_open()") end
  H.call("config.app.pane", "panel", "problems")
  H.expect("panel: Problems shown", pane_open)
  H.call("config.app.pane", "hide_panel")
  H.expect("hide_panel: hidden", function() return not pane_open() end)
  H.call("config.app.pane", "panel")
  H.expect("panel with no tab: its last one (Problems), no error", pane_open,
    function() return { pane_open(), H.lua("return vim.v.errmsg") } end)
  H.bridge_clear()
  H.call("config.app.pane", "panel", "terminal")
  H.expect("panel: the Terminal in its place, with the keys", function()
    return term_open() and not pane_open() and H.last("terminal", "open") ~= nil and H.last("terminal", "open").enter
  end, function() return vim.inspect(H.bridge("terminal")) end)
  H.call("config.app.pane", "hide_panel")
  H.expect("hide_panel: the Terminal hidden", function() return not term_open() end)
  H.bridge_clear()
  H.call("config.app.pane", "restore_panel", "problems", 0.4)
  H.expect("restore_panel: Problems shown without the keys at 40 % of the rows", function()
    local p = H.last("pane", "open")
    local rows = H.lua("return vim.api.nvim_win_get_height(require('config.app.pane').win())")
    return pane_open() and p ~= nil and p.enter == false and math.abs(rows - 0.4 * H.lua("return vim.o.lines")) <= 1
  end, function() return vim.inspect(H.bridge("pane")) end)
  H.call("config.app.pane", "restore_panel", vim.NIL)
  H.expect("restore_panel with no tab: hidden", function() return not pane_open() and not term_open() end)
  -- ⌘⇧M: the pane on Problems (#128), the workspace's diagnostics by file, errors first; ⏎ opens the spot
  fresh("text.txt")
  H.lua([[
    local ns = vim.api.nvim_create_namespace('editing_problems')
    vim.diagnostic.set(ns, 0, {
      { lnum = 3, col = 2, message = 'a warning', severity = vim.diagnostic.severity.WARN, source = 'lint' },
      { lnum = 1, col = 4, message = 'an error', severity = vim.diagnostic.severity.ERROR, source = 'ts', code = 2304 },
    })]])
  H.bridge_clear()
  H.keys("<D-S-m>")
  local function text_file(p)
    for _, f in ipairs(p.files or {}) do
      if f.name == "text.txt" then return f end
    end
  end
  local listed = H.wait_bridge("pane", "problems", function(p) return text_file(p) ~= nil end)
  local items = listed and text_file(listed).items or {}
  H.check("⌘⇧M shows the Problems tab: text.txt's two, the error first", H.last("pane", "open") ~= nil
    and H.last("pane", "open").tab == "problems" and #items == 2
    and items[1].message == "an error" and items[1].lnum == 2 and items[1].col == 5 and items[1].code == "2304"
    and items[2].severity == "warning", vim.inspect(listed))
  H.call("config.app.pane", "open_problem", listed and text_file(listed).path or "", 3, 3)
  H.expect("open_problem: the file at line 3, column 3, the keyboard in the code", function()
    return cur()[1] == 3 and cur()[2] == 2 and H.focus() == "split"
  end, function() return { cur(), H.focus() } end)
  H.call("config.app.pane", "hide")
  H.lua("vim.diagnostic.reset(vim.api.nvim_create_namespace('editing_problems'))")
  fresh("text.txt")
  at(2, 3)
  H.keys("<M-Down>")
  H.expect("⌥↓ moves the line down, the caret with it", function()
    return text() == "alpha one|gamma three|beta two||delta four" and cur()[1] == 3 and cur()[2] == 3
  end, function() return { text(), cur() } end)
  H.keys("<M-Up><M-Up>")
  H.expect("⌥↑ moves it up, and stops at the top", function()
    return text() == "beta two|alpha one|gamma three||delta four" and cur()[1] == 1
  end, function() return { text(), cur() } end)
  H.keys("<M-Up>")
  H.check("...without an error", text() == "beta two|alpha one|gamma three||delta four", text())
  at(2, 0)
  -- (Feel vscode with Vim mode on here: stock Vim keys, #214)
  H.keys("Vj<M-Down>")
  H.expect("⌥↓ on a selection moves its lines and keeps them selected", function()
    return text() == "beta two||alpha one|gamma three|delta four" and H.mode() == "V" and sel() ~= nil
  end, function() return { text(), H.mode() } end)
  H.keys(ESC)
  fresh("text.txt")
  at(2, 0)
  H.keys("<M-S-Down>")
  H.expect("⌥⇧↓ copies the line down, the caret on the copy", function()
    return text() == "alpha one|beta two|beta two|gamma three||delta four" and cur()[1] == 3
  end, function() return { text(), cur() } end)
  H.keys("<M-S-Up>")
  H.expect("⌥⇧↑ copies it up, the caret stays on the upper one", function()
    return text() == "alpha one|beta two|beta two|beta two|gamma three||delta four" and cur()[1] == 3
  end, function() return { text(), cur() } end)
  fresh("text.txt")
  H.lua("vim.fn.setreg('+', 'kept')")
  at(2, 0)
  H.keys("<D-S-k>")
  H.expect("⌘⇧K deletes the line, the clipboard kept", function()
    return text() == "alpha one|gamma three||delta four" and clip() == "kept"
  end, function() return { text(), clip() } end)
  H.keys("i<D-S-k>" .. ESC)
  H.expect("...while typing too", function() return text() == "alpha one||delta four" end, text)
  fresh("feat.ts")
  at(12, 10)
  H.keys("<D-d>")
  H.expect("⌘D selects the word at the caret (multicursor_test has the rest)", function() return sel() == "alpha" end, sel)
  H.keys("<D-d>")
  H.expect("...⌘D again adds its next occurrence", function()
    return H.lua("return require('multicursor-nvim').numCursors()") == 2
  end, function() return H.lua("return require('multicursor-nvim').numCursors()") end)
  H.keys(ESC .. ESC)
  fresh("text.txt")
  H.keys("G")
  H.keys("<C-->")
  H.expect("⌃- goes back", function() return cur()[1] == 1 end, cur)
  H.keys("<C-S-->")
  H.expect("⌃⇧- goes forward", function() return cur()[1] == 5 end, cur)
  H.bridge_clear()
  H.keys("<D-k>")
  H.settle()
  H.keys("<D-s>")
  H.expect("⌘K, a pause, ⌘S is the key help (no timeout)", function() return H.last("popups", "key_help") ~= nil end)
  H.bridge_clear()
  H.keys("vä<D-k><D-s>")
  H.expect("...from a selection too", function() return H.last("popups", "key_help") ~= nil end)
  H.keys(ESC .. ESC)
  H.bridge_clear()
  H.keys("<D-k>x")
  H.check("⌘K then another key: nothing (no Commit)", H.last("popups", "key_help") == nil and text() == "alpha one|beta two|gamma three||delta four", text())
  H.bridge_clear()
  H.keys("<D-S-p>")
  H.call("config.app.typeahead", "focused", "toolbar")
  H.expect("⌘⇧P is the command palette (Command mode)", function()
    return H.last("toolbar", "colon") ~= nil
  end, function() return vim.inspect(H.bridge("toolbar")) end)
  fresh("sel.ts")
  H.bridge_clear()
  H.keys(K.cmd_enter)
  local menu = H.wait_menu()
  local keys = {}
  for _, it in ipairs(menu and menu.items or {}) do
    if it.label then keys[it.label] = it.key end
  end
  H.check("the menus show the vscode chords", keys["Rename…"] == "F2" and keys["Split Right"] == "⌘\\"
    and keys["Show Context Actions"] == "⌘." and keys["Push…"] == nil and keys["Close Tab"] == "⌘W", keys)
  H.keys(ESC)
  -- the menu bar's items keep their WebStorm action (the app calls webstorm(lhs) for a key vscode took)
  fresh("text.txt")
  H.call("config.keymap_vscode", "webstorm", "<D-d>")
  H.expect("Edit › Duplicate Line under vscode still duplicates", function()
    return text() == "alpha one|alpha one|beta two|gamma three||delta four"
  end, text)
  H.call("config.keymap_vscode", "webstorm", "<D-w>")
  H.expect("...and Extend Selection still selects the word", function() return H.mode() == "v" end, H.mode)
  H.keys(ESC)
  -- VS Code's keys for WebStorm's actions (#129): ⌃⇧⌘→ is Extend Selection, ⌥⌘S saves; ⌘⇧G stays Find Previous
  fresh("text.txt")
  H.keys("<C-D-S-Right>")
  H.expect("⌃⇧⌘→ extends the selection (VS Code's Expand Selection)", function() return H.mode() == "v" end, H.mode)
  H.keys(ESC)
  H.check("⌘⇧G is Find Previous under vscode too", desc("<D-S-g>") ~= "Git (focus / hide)", desc("<D-S-g>"))
  H.lua("vim.api.nvim_buf_set_lines(0, 0, 1, false, { 'saved by ⌥⌘S' })")
  H.keys("<M-D-s>")
  H.expect("⌥⌘S saves (VS Code's Save All)", function() return H.lua("return not vim.bo.modified") end)
  H.call("config.feel", "set", { feel = "vimstorm" })
  H.check("back on VimStorm: the WebStorm keymap exactly as before", snapshot() == webstorm, snapshot())
  fresh("text.txt")
  H.keys("<D-d>")
  H.expect("...⌘D duplicates again", function() return text() == "alpha one|alpha one|beta two|gamma three||delta four" end, text)

  -- Your keys (#129, keys.json with the Feel, config/keys.lua): a key of yours does its action's VimStorm key, over
  -- any Feel (⌘Y Duplicate under vscode, whose ⌘D is Add Next Occurrence); a new set puts back what it covered
  local repo = vim.fn.fnamemodify(os.getenv("NVT_HARNESS"), ":p:h:h")
  local catalogue = table.concat(vim.fn.readfile(repo .. "/abe/packages/core/src/theme/keymap.ts"), "\n")
  local does = {}
  for lhs in catalogue:gmatch("nvim: '([^']+)'") do does[#does + 1] = lhs end
  -- (or is the window's: ⌘1, a pane key; a key of yours for it asks the app)
  local unmapped = H.lua([[local out = {}
    for _, lhs in ipairs(...) do
      if vim.fn.maparg(lhs, "n") == "" and not require("config.keys").app(lhs) then out[#out + 1] = lhs end
    end
    return out]], { does })
  H.check("every Keymap action's VimStorm key has its map (" .. #does .. ")", #does > 20 and #unmapped == 0, unmapped)
  local yours = { { key = "⌘Y", action = "duplicate", lhs = { "<D-y>" }, does = "<D-d>" },
    { key = "⌘U", action = "extendSelection", lhs = { "<D-u>" }, does = "<D-w>" } }
  local mine = snapshot() .. H.lua(SNAPSHOT, { { "<D-y>", "<D-u>" } })
  H.call("config.feel", "set", { feel = "vscode", keys = yours })
  H.check("a key of yours names its action", desc("<D-y>") == "duplicate (yours: ⌘Y)", desc("<D-y>"))
  fresh("text.txt")
  H.keys("<D-y>")
  H.expect("⌘Y of yours duplicates under vscode (WebStorm's ⌘D)", function()
    return text() == "alpha one|alpha one|beta two|gamma three||delta four"
  end, text)
  fresh("text.txt")
  H.keys("<D-u>")
  H.expect("...⌘U of yours extends the selection", function() return H.mode() == "v" end, H.mode)
  H.keys(ESC)
  H.call("config.feel", "set", { feel = "vimstorm" })
  H.check("no keys: every map back as it was", snapshot() .. H.lua(SNAPSHOT, { { "<D-y>", "<D-u>" } }) == mine)

  -- Vim mode off (#131, the Feel's editor.vim false): always typing, arrows, ⇧ arrows select, no modes --------
  local VIM_KEYS = { "<Esc>", "<D-a>", "<Up>", "<Down>", "<Left>", "<Right>", "<D-S-a>", "<D-A>" }
  local function vim_keys() return H.lua(SNAPSHOT, { VIM_KEYS }) .. "|" .. H.lua("return vim.o.keymodel .. '/' .. vim.o.selectmode") end
  fresh("text.txt")
  local vim_on = vim_keys()
  H.call("config.feel", "set", { feel = "webstorm", editor = { vim = false } })
  H.expect("Vim mode off: the file is typing at once", function() return H.mode() == "i" end, H.mode)
  at(1, 0)
  H.keys("Xk")
  H.expect("letters type (k is no move)", function() return text():sub(1, 12) == "Xkalpha one|" end, text)
  H.keys(ESC)
  H.check("Esc stays typing", H.mode() == "i", H.mode())
  H.keys("Y")
  H.expect("...where the caret was", function() return text():sub(1, 13) == "XkYalpha one|" end, text)
  H.keys("<Down><Right><Right>")
  H.expect("arrows move", function() return cur()[1] == 2 and cur()[2] == 5 end, cur)
  H.keys("<S-Right><S-Right><S-Right>")
  H.expect("⇧ arrows select (Select mode)", function() return H.mode() == "s" end, H.mode)
  H.keys("Q")
  H.expect("...typing replaces the selection and goes on typing", function()
    return H.line(2) == "beta Q" and H.mode() == "i"
  end, function() return { H.line(2), H.mode() } end)
  H.lua("vim.cmd.stopinsert()")
  H.expect("something that leaves Insert mode (a picker, a tab click): typing again, the caret kept", function()
    return H.mode() == "i" and cur()[1] == 2 and cur()[2] == 6
  end, function() return { H.mode(), cur() } end)
  -- a multibyte character before the caret: back where typing left it (no drift by a byte)
  at(2, 0)
  H.keys("hä")
  H.lua("vim.cmd.stopinsert()")
  H.expect("after ä the caret comes back after it", function() return H.mode() == "i" and cur()[2] == 3 end,
    function() return { H.mode(), cur() } end)
  H.keys("y")
  H.expect("...typing goes on there", function() return H.line(2):sub(1, 4) == "häy" end, function() return H.line(2) end)
  -- the Visual-mode Cmd keys act on a ⇧ arrow selection: ⌘/ comments its line
  H.lua("vim.bo.filetype = 'typescript'")
  at(1, 0)
  H.keys("<S-Right><S-Right>")
  H.keys("<D-/>")
  H.expect("⌘/ on a ⇧→ selection comments the line", function() return H.line(1):match("^//") ~= nil end,
    function() return { H.line(1), H.mode() } end)
  H.keys(ESC)
  -- ⌘W (Extend Selection) selects as you type over it (Select mode, not Visual)
  at(3, 1)
  H.keys("<D-w>")
  H.expect("⌘W's selection is one to type over", function() return H.mode() == "s" end, H.mode)
  H.keys(ESC)
  H.lua("vim.bo.filetype = 'text'")
  -- undo word by word
  H.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, { '' })")
  at(1, 0)
  H.keys("one two")
  H.keys("<D-z>")
  H.expect("⌘Z undoes the last word, not all the typing", function() return text() == "one" end, text)
  H.keys("<D-a>")
  H.expect("⌘A selects everything to type over", function() return H.mode() == "s" end, H.mode)
  H.keys("z")
  H.expect("...and typing replaces it", function() return text() == "z" and H.mode() == "i" end, function() return { text(), H.mode() } end)
  H.keys(":")
  H.expect("`:` types", function() return text() == "z:" end, text)
  H.bridge_clear()
  H.keys("<D-S-a>")
  H.call("config.app.typeahead", "focused", "toolbar")
  -- not the `:` key: with no `abe` the app types no `:` into the file for it
  H.expect("⌘⇧A (WebStorm's Find Action) opens Command mode", function()
    local p = H.last("toolbar", "colon")
    return p ~= nil and p.key == nil
  end,
    function() return vim.inspect(H.bridge("toolbar")) end)
  H.keys(ESC)
  H.lua("vim.bo.modifiable = false vim.cmd.stopinsert()")
  H.settle()
  H.check("a read-only file stays in Normal mode", H.mode() == "n", H.mode())
  H.lua("vim.bo.modifiable = true")
  H.call("config.feel", "set", { feel = "vscode", editor = { vim = false } })
  H.expect("Feel vscode with Vim mode off: typing too", function() return H.mode() == "i" end, H.mode)
  H.call("config.feel", "set", { feel = "vimstorm" })
  H.expect("Vim mode on again: Normal mode", function() return H.mode() == "n" end, H.mode)
  local function differ(a, b)
    local seen, out = {}, {}
    for part in a:gmatch("[^|]+") do seen[part] = true end
    for part in b:gmatch("[^|]+") do if not seen[part] then out[#out + 1] = part end end
    return out
  end
  H.check("...its keys and options exactly as before", vim_keys() == vim_on, { now = differ(vim_on, vim_keys()), was = differ(vim_keys(), vim_on) })
  fresh("text.txt")
  H.keys("ä")
  H.check("...and ä moves again", cur()[2] == 1, cur())
end)
