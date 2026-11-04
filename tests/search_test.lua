-- Search: the Replace bar's engine (Cmd+R, config/replace.lua; the app draws the bar: app/src/editor/replace): what it
-- sends the app, count, next / previous, replace / replace all, undo, Cc / .*, key bursts typed right after Cmd+R. The native pickers (Search
-- Everywhere, Go to File, Find in Files) and Shift Shift are cargo tests (pickers.rs, input.rs).
local H = dofile(os.getenv("NVT_HARNESS"))
local K = H.KEY

local PROJ = H.fixtures .. "/proj"
vim.fn.writefile({ "alpha beta alpha", "Alpha gamma", "nothing here", "alpha" }, PROJ .. "/repl.txt")

H.run(function()
  H.start("proj", { "a.ts" })
  H.wait_focus("split")

  -- Replace bar (Cmd+R) -----------------------------------------------------------------------------
  -- The app draws the bar and owns its fields (app/src/editor/replace); here the engine: what it sends the app
  -- (`vimstorm.replace`) and what the app's calls into config.app.replace do to the file.
  local R = "config.app.replace"
  local function rs() return H.lua("return require('config.replace').state()") or {} end
  local function bar_open() return H.lua("return require('config.replace').is_open()") == true end
  local function text() return table.concat(H.lua("return vim.api.nvim_buf_get_lines(vim.fn.bufnr('repl.txt'), 0, -1, false)") or {}, "|") end
  local function state(id) return H.last("replace", nil, function(p) return p.id == id and (p.event == "state" or p.event == "show") end) or {} end
  H.lua("vim.cmd.edit('repl.txt') vim.api.nvim_win_set_cursor(0, { 1, 1 })")
  H.wait_for(function() return H.file() == "repl.txt" end)
  H.bridge_clear()
  H.keys(K.cmdR)
  local show = H.wait_bridge("replace", "show") or {}
  local id = show.id
  H.check("Cmd+R opens the bar with the word at the caret: 1/4, Replace and Replace All enabled, no nvim float",
    show.find == "alpha" and show.count == "1/4" and show.current == true and show.total == 4 and show.none == false
      and H.lua("for _, w in ipairs(vim.api.nvim_list_wins()) do if vim.api.nvim_win_get_config(w).relative ~= '' then return false end end return true") == true,
    show)
  H.check("the file's window stays nvim's current one, in normal mode", H.file() == "repl.txt" and H.mode() == "n", { H.file(), H.mode() })
  H.call(R, "focused", id)
  H.expect("the app took the keyboard: the hold ends, nothing was typed meanwhile", function()
    local t = H.last("replace", "typeahead")
    return t ~= nil and t.token == id and #t.keys == 0
  end, function() return H.bridge("replace") end)
  H.call(R, "fields", id, "alp", "")
  H.expect("typing in the search field: live count", function() return rs().find == "alp" and state(id).count == "1/4" end, rs)
  H.call(R, "fields", id, "alpha", "omega")
  H.call(R, "replace", id)
  H.expect("Replace in the replacement field: the current match replaced, the next one current", function()
    return text() == "omega beta alpha|Alpha gamma|nothing here|alpha" and state(id).count == "1/3"
  end, function() return { text(), state(id) } end)
  H.call(R, "step", id, 1)
  H.expect("next match", function() return state(id).count == "2/3" end, function() return state(id) end)
  H.call(R, "step", id, -1)
  H.call(R, "step", id, -1)
  H.expect("previous match wraps", function() return state(id).count == "3/3" end, function() return state(id) end)
  H.call(R, "replace_all", id)
  H.expect("Replace All (ignoring case): 0 results, in red", function()
    local st = state(id)
    return text() == "omega beta omega|omega gamma|nothing here|omega" and st.count == "0 results" and st.none == true and st.total == 0
  end, function() return { text(), state(id) } end)
  H.call(R, "close", id, true)
  H.expect("Esc closes the bar: hidden in the app, back in the file in normal mode, no highlights left", function()
    return not bar_open() and H.last("replace", "hide") ~= nil and H.file() == "repl.txt" and H.mode() == "n"
      and H.lua("return vim.v.hlsearch") == 0
      and #H.lua("return vim.api.nvim_buf_get_extmarks(0, vim.api.nvim_get_namespaces().ws_replace, 0, -1, {})") == 0
  end, function() return { bar_open(), H.file(), H.mode() } end)
  H.keys("u")
  H.expect("one undo reverts Replace All", function() return text() == "omega beta alpha|Alpha gamma|nothing here|alpha" end, text)
  H.keys("u")
  H.expect("the next undo reverts the single replace", function() return text() == "alpha beta alpha|Alpha gamma|nothing here|alpha" end, text)
  H.lua("vim.api.nvim_win_set_cursor(0, { 1, 0 })")
  H.keys("n")
  H.expect("n goes on searching the replaced text", function()
    local c = H.cursor()
    return c[1] == 1 and c[2] == 11
  end, H.cursor)
  -- from insert mode: the bar has the keyboard, the file is back in normal mode with its caret kept
  H.lua("vim.api.nvim_win_set_cursor(0, { 2, 0 })")
  H.bridge_clear()
  H.keys("i" .. K.cmdR)
  show = H.wait_bridge("replace", "show") or {}
  id = show.id
  H.call(R, "focused", id)
  H.expect("Cmd+R from insert mode: the word at the caret, the file in normal mode", function()
    return show.find == "Alpha" and (show.count or ""):match("/4$") and H.mode() == "n"
  end, function() return { show, H.mode() } end)
  H.call(R, "toggle", id, "case")
  H.expect("Cc matches case: 1/1", function() return rs().case == true and state(id).count == "1/1" and state(id).case == true end, rs)
  H.call(R, "toggle", id, "regex")
  H.call(R, "fields", id, "Al(", "")
  H.expect(".* with a bad pattern: Bad pattern, in red", function()
    return state(id).count == "Bad pattern" and state(id).none == true and state(id).regex == true
  end, function() return state(id) end)
  H.call(R, "fields", id, "(A)lpha", "$1x")
  H.call(R, "replace", id)
  H.expect("a regex replacement takes the groups ($1)", function() return text():match("|Ax gamma|") ~= nil end, text)
  H.keys("u")
  H.bridge_clear()
  H.keys(K.cmdR)
  H.expect("Cmd+R while the bar is open: its search field takes the keyboard again", function()
    return H.last("replace", "focus", function(p) return p.id == id end) ~= nil and H.last("replace", "show") == nil
  end, function() return H.bridge("replace") end)
  H.call(R, "close", id, true)
  H.wait_for(function() return not bar_open() end)
  -- a burst typed right after Cmd+R (one write, like fast typing): held for the bar, never run in the file
  local before = text()
  H.lua("vim.api.nvim_win_set_cursor(0, { 1, 6 })")
  H.bridge_clear()
  H.keys(K.cmdR .. "gam<Tab>zeta" .. K.esc .. "x")
  show = H.wait_bridge("replace", "show") or {}
  H.call(R, "focused", show.id)
  H.expect("the keys after Cmd+R go to the bar, in order", function()
    local t = H.last("replace", "typeahead", function(p) return p.token == show.id end)
    return t ~= nil and table.concat(t.keys, "") == "gam<Tab>zeta<Esc>x"
  end, function() return H.bridge("replace") end)
  H.check("the file untouched by the burst", text() == before, text())
  H.call(R, "close", show.id, true)
  H.wait_for(function() return not bar_open() and H.mode() == "n" end)
  -- another window closing keeps the bar; the file's window closing takes it with it
  H.bridge_clear()
  H.keys(K.cmdR)
  show = H.wait_bridge("replace", "show") or {}
  H.call(R, "focused", show.id)
  local file_win = H.lua("return vim.api.nvim_get_current_win()")
  H.lua("vim.cmd('split') local w = vim.api.nvim_get_current_win() vim.api.nvim_win_close(w, true) vim.api.nvim_set_current_win(...)", { file_win })
  H.check("a window closing elsewhere keeps the bar", bar_open())
  H.lua("vim.cmd('split') vim.api.nvim_win_close(..., true)", { file_win })
  H.expect("the file's window closing closes the bar", function()
    return not bar_open() and H.last("replace", "hide", function(p) return p.id == show.id end) ~= nil
  end)
end)
