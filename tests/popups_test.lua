-- Popups: the editor context menu's items and keys for a code file (config/menu.lua providers, sent to the app's
-- native menu as a payload). The menus, vim.ui.select / input, the `,?` key list, the Ctrl+Tab switcher and
-- balloons as drawn and driven are cargo tests (popups.rs, pickers.rs, floats.rs).
local H = dofile(os.getenv("NVT_HARNESS"))
local K = H.KEY

H.run(function()
  H.start("proj", { "a.ts" })
  H.wait_focus("split")

  -- items of the editor menu (a code file)
  H.bridge_clear()
  H.keys(K.cmd_enter)
  local menu = H.wait_menu()
  local keys = {}
  for _, it in ipairs(menu and menu.items or {}) do
    if it.label then keys[it.label] = it.key or "" end
  end
  H.check("editor menu: Folding, Quick Definition, Replace…, Rollback Lines ⌘⌥Z, Search Everywhere ⇧⇧",
    keys["Folding"] ~= nil and keys["Quick Definition"] ~= nil and keys["Replace…"] ~= nil
      and keys["Rollback Lines"] == "⌘⌥Z" and keys["Search Everywhere"] == "⇧⇧", vim.inspect(keys))
  if menu then H.call("config.app.menu", "cancel", menu.id, true) end

  -- a right-click outside the open menu reaches nvim before the app's cancel (no restore) for that menu: the new
  -- menu opens on the clicked line, never back at the dismissed one's origin; the late cancel changes nothing
  H.lua("vim.api.nvim_win_set_cursor(0, { 1, 0 })")
  H.bridge_clear()
  H.keys(K.cmd_enter)
  local first = H.wait_menu()
  H.bridge_clear()
  local win = H.lua("return vim.api.nvim_get_current_win()")
  local top = H.lua("return vim.fn.getwininfo(...)[1].winbar", { win })
  H.mouse("right", "press", win, top + 3, 4)
  H.mouse("right", "release", win, top + 3, 4)
  local second = H.wait_menu()
  H.check("right-click before the app's cancel: a new menu, the caret on line 4",
    second ~= nil and H.cursor()[1] == 4, H.cursor())
  if first then H.call("config.app.menu", "cancel", first.id, false) end
  H.check("the late cancel leaves the caret on line 4", H.cursor()[1] == 4, H.cursor())
  if second then H.call("config.app.menu", "cancel", second.id, true) end
  H.lua("vim.api.nvim_win_set_cursor(0, { 1, 0 })")

  -- `:` in the Editor (#346): Neovim's Ex names, the caret, the context menu's runnable items go with the colon;
  -- choosing one in Command mode runs it here
  H.lua([[vim.g.colon_probe_on = true require('config.menu').provider(10000, function()
    if not vim.g.colon_probe_on then return nil end
    return { { 'Probe', function() vim.g.colon_probe = 1 end, key = '⌘P' }, '-',
      { 'Grey', function() vim.g.colon_probe = 2 end, enabled = false }, { 'Two', function() vim.g.colon_probe = 3 end } }
  end)]])
  H.bridge_clear()
  H.keys(":")
  local colon = H.wait_bridge("toolbar", "colon")
  local here = colon and colon.here or {}
  H.check("colon: Ex names (write, quit), the caret a.ts:1",
    vim.tbl_contains(here.ex or {}, "write") and vim.tbl_contains(here.ex or {}, "quit")
      and here.caret ~= nil and here.caret.file == "a.ts" and here.caret.line == 1, vim.inspect(here.caret))
  local items = vim.tbl_map(function(i)
    return i.text .. (i.key and (" " .. i.key) or "") .. (i.enabled == false and " (grey)" or "")
  end, here.items or {})
  H.check("colon items: no separator, the grey one grey", vim.deep_equal(items, { "Probe ⌘P", "Grey (grey)", "Two" }), items)
  H.call("config.app.typeahead", "take", "toolbar")
  H.call("config.app.colon", "item", 2)
  H.expect("item 2 ran: Two", "vim.g.colon_probe == 3")
  -- the test's provider off again: the editor's own menu for what follows
  H.lua("vim.g.colon_probe_on = nil")

  -- balloons: Copilot's server download and ready lines are no balloon (#320: two on every cloud attach); others are
  H.bridge_clear()
  H.lua([[vim.notify("[Copilot.lua] Downloading Copilot server 1.552.0 (linux-arm64)", vim.log.levels.INFO)]])
  H.lua([[vim.notify("[Copilot.lua] Copilot server 1.552.0 ready", vim.log.levels.INFO)]])
  H.lua([[vim.notify("Saved a.ts", vim.log.levels.INFO)]])
  H.wait_bridge("popups", "balloon", function(p) return p.msg == "Saved a.ts" end)
  local said = vim.tbl_map(function(p) return p.msg end, H.bridge("popups", "balloon"))
  H.check("balloons: only Saved a.ts, no Copilot server lines", vim.deep_equal(said, { "Saved a.ts" }), said)

  -- `,?`: every leader group is named (design P-16: ,c code and ,i review, never "+N keys")
  H.bridge_clear()
  H.call("config.app.keyhelp", "show")
  H.expect("key help names the c and i groups", function()
    local p = H.last("popups", "key_help")
    if not p then return false end
    local names = {}
    for _, g in ipairs(p.groups or {}) do names[g.keys] = g.desc end
    return names.c == "code" and names.i == "review" and names.f == "find"
  end, function() return vim.inspect(H.last("popups", "key_help")) end)

  -- Ctrl+Tab switcher's tool windows: Project, Chat (a pick is the app's: Lua opens nothing), and the bottom panel's
  -- Terminal and Git (Lua opens them)
  H.bridge_clear()
  H.lua("require('config.switcher').open({ wait = false })")
  local sw = H.wait_bridge("pickers", "switcher")
  local tools = vim.tbl_map(function(t) return t.key .. " " .. t.name .. (t.column and " column=" .. t.column or "") end,
    sw and sw.tools or {})
  H.check("switcher tools: ⌘1 Project · ⌘4 Chat · ⌘T Terminal · ⌘3 Git",
    vim.deep_equal(tools, { "⌘1 Project", "⌘4 Chat column=chat", "⌘T Terminal", "⌘3 Git" }), tools)
  H.call("config.switcher", "pick", "tools", 3, sw and sw.token or 0)
  H.settle()
  H.check("switcher Terminal: the bottom panel on its Terminal",
    H.lua("return require('config.app.terminal').is_open()") == true)
  H.lua("require('config.app.terminal').hide()")
end)
