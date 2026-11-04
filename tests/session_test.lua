-- Reopening a project restores it like WebStorm (config/session.lua): the Project tool window closed / open, the
-- Terminal's height and focus, every split with its tabs, active tab and caret. The native halves (tree folders,
-- terminal tabs / cwds, Git Log filter) are cargo tests (tree.rs, terminal.rs, git_log.rs); here the Lua
-- session file round trip and what it sends to the app.
local H = dofile(os.getenv("NVT_HARNESS"))
local K = H.KEY

-- Carets of the editor splits, left to right
local function carets()
  return H.lua([[
    local wins = require('config.editor_tabs').splits()
    table.sort(wins, function(a, b) return vim.api.nvim_win_get_position(a)[2] < vim.api.nvim_win_get_position(b)[2] end)
    return vim.tbl_map(vim.api.nvim_win_get_cursor, wins)]])
end

-- Swap files another nvim left: owner(file, dirty) starts a plain headless nvim (no config, its own XDG dirs) on
-- `file` with its swap in the folder VimStorm's nvim uses (state/vimstorm/swap), `dirty`: an unsaved change in it
-- (:preserve writes it out). Returns the process (vim.system) and the swap file, once that is written.
local function swap_fixtures()
  local dir = H.project("swaps")
  local swapdir = H.env().XDG_STATE_HOME .. "/vimstorm/swap"
  vim.fn.mkdir(swapdir, "p")
  local own = H.fixtures .. "/swap-owner"
  local env = { XDG_STATE_HOME = own .. "/state", XDG_CONFIG_HOME = own .. "/config", XDG_DATA_HOME = own .. "/data",
    XDG_CACHE_HOME = own .. "/cache" }
  local function owner(file, dirty)
    local proc = vim.system({ "nvim", "--headless", "-u", "NONE", "-i", "NONE", "--cmd", "set directory=" .. swapdir .. "//",
      file, "-c", dirty and "call setline(1, 'unsaved') | preserve" or "preserve" }, { env = env })
    local swap
    vim.wait(5000, function()
      swap = vim.fn.glob(swapdir .. "/*" .. vim.fn.fnamemodify(file, ":t") .. ".swp")
      return swap ~= "" and vim.fn.swapinfo(swap).dirty == (dirty and 1 or 0)
    end, 20)
    return proc, swap
  end
  return { dir = dir, owner = owner }
end

H.run(function()
  -- Terminal with two tabs, the tree closed, focus in the Terminal
  H.start("proj", { "a.ts" })
  -- (Rust reports the native tree's state; Cmd+1 twice there)
  H.call("config.app.tree", "state", { open = false, width = 300, dirs = {} })
  -- (the app's ⌘T: the bottom pane's Terminal, its host window current)
  H.call("config.app.terminal", "show")
  -- (Rust reports its tabs' shells: two tabs, the second one current)
  H.call("config.app.terminal", "tabs", { -1, -2 }, 2)
  H.native_focus("terminal")
  H.wait_focus("terminal")
  H.restart("proj", {}, { ready = "require('config.app.bridge') ~= nil" })

  local tree = H.wait_bridge("tree", "restore")
  H.check("Project tool window stays closed", tree ~= nil and tree.open == false, vim.inspect(tree))
  -- the restore opens the terminal with its tabs, then asks for the keyboard there
  local open = H.wait_bridge("terminal", "open", function(p) return p.tabs ~= nil end)
  H.check("the Terminal's tabs restored, the pane hidden until asked for",
    open ~= nil and #(open.tabs or {}) == 2 and open.show == false, vim.inspect(open))
  H.expect("then focused (the app gives it the keyboard)",
    function() return H.last("terminal", "open", function(p) return p.enter == true and p.tabs == nil end) ~= nil end)
  -- a move to the tile gave Chat the keys as this nvim started (the app's native_focus before the restore):
  -- Chat keeps them
  H.restart("proj", { "--cmd", "autocmd VimEnter * ++once lua require('config.app').native_focus('chat')" },
    { ready = "require('config.app.bridge') ~= nil" })
  H.wait_bridge("tree", "restore")
  H.settle(200, 2000)
  H.check("Chat keeps the keys: nvim asks for none of them",
    H.last("focus") == nil and H.last("terminal", "open") == nil, vim.inspect({ H.bridge("focus"), H.bridge("terminal") }))
  H.stop()

  -- Two splits with tabs and carets, focus in the right split
  H.start("grepo", { "long.ts" })
  H.keys("<Cmd>e diff.ts<CR>")
  H.keys("<Cmd>e long.ts<CR>")
  H.keys("120G4|")
  H.keys(",v")
  H.keys("<Cmd>e diff.ts<CR>")
  H.keys("4G2|")
  H.wait_for(function() return H.tab_bars() == "long.ts,diff.ts[long.ts] | long.ts,diff.ts[diff.ts]*" end)
  H.restart("grepo", {}, { ready = "require('config.focus').target() == 'split'" })

  H.expect("each split's tabs and active tab restored, focus in the same split",
    function() return H.tab_bars() == "long.ts,diff.ts[long.ts] | long.ts,diff.ts[diff.ts]*" end, H.tab_bars)
  H.expect("each split's caret restored", function() return vim.deep_equal(carets(), { { 120, 3 }, { 4, 1 } }) end,
    function() return vim.inspect(carets()) end)
  H.stop()

  -- The bottom tool window's height is the project's (#156): the pane dragged to 14 rows and left open, the
  -- project opens again with the pane hidden (hidden by default) and it comes back 14 rows tall; a project
  -- whose session kept a 2-row Git window opens its pane 8 rows tall
  H.start("proj", { "a.ts" })
  H.call("config.app.pane", "show", "sessions")
  H.expect("the pane open", "require('config.app.pane').win() ~= nil")
  H.lua("vim.api.nvim_win_set_height(require('config.app.pane').win(), 14)")
  H.restart("proj", {}, { ready = "require('config.app.bridge') ~= nil" })
  H.expect("the pane hidden after the restart", "require('config.app.pane').win() == nil")
  H.expect("its height kept", "require('config.bottom').height() == 14",
    function() return tostring(H.lua("return require('config.bottom').height()")) end)
  H.call("config.app.pane", "show", "boxes")
  H.expect("it opens 14 rows tall", "vim.api.nvim_win_get_height(require('config.app.pane').win()) == 14")
  H.stop()
  H.start("grepo", {})
  H.lua("require('config.bottom').restore({ share = 2 / vim.o.lines })")
  H.call("config.app.pane", "show", "sessions")
  H.expect("a 2-row height kept opens 8 rows", "vim.api.nvim_win_get_height(require('config.app.pane').win()) == 8",
    function() return tostring(H.lua("return vim.api.nvim_win_get_height(require('config.app.pane').win())")) end)
  H.stop()

  -- A swap file left behind (config/swap.lua) never stops the start at Vim's ATTENTION prompt. Each row's swap is a
  -- real one (swap_fixtures): its owner killed (dead) or still running (live); newer: which of the file and the
  -- swap was written last.
  local swaps = swap_fixtures()
  for _, row in ipairs({
    { name = "dead owner, file newer than its unsaved swap", live = false, dirty = true, newer = "file",
      swap_kept = false, readonly = false },
    { name = "dead owner, swap without unsaved changes", live = false, dirty = false, newer = "swap",
      swap_kept = false, readonly = false },
    { name = "dead owner, swap newer with unsaved changes", live = false, dirty = true, newer = "swap",
      swap_kept = true, readonly = false, says = ":recover" },
    { name = "live owner", live = true, dirty = true, newer = "swap", swap_kept = true, readonly = false, says = "open in another Neovim" },
  }) do
    local file = ("%s/%s.txt"):format(swaps.dir, (row.name:gsub("%W+", "-")))
    vim.fn.writefile({ "on disk" }, file)
    local owner, swap = swaps.owner(file, row.dirty)
    if not row.live then
      owner:kill(9)
      owner:wait(2000)
    end
    local now = os.time()
    vim.uv.fs_utime(row.newer == "file" and swap or file, now - 100, now - 100)

    H.start(swaps.dir, { file })
    local tail = vim.fn.fnamemodify(file, ":t")
    H.check(row.name .. ": no prompt, the file open as on disk", H.file() == tail and (H.lines() or {})[1] == "on disk",
      vim.inspect({ H.lua("return vim.api.nvim_get_mode()"), H.file(), H.lines() }))
    H.check(row.name .. ": " .. (row.readonly and "read-only" or "editable"), H.lua("return vim.bo.readonly") == row.readonly)
    local function said()
      return vim.tbl_filter(function(b) return type(b.msg) == "string" and b.msg:find(tail, 1, true) ~= nil end,
        H.bridge("popups", "balloon"))
    end
    if row.says then
      H.expect(row.name .. ": one balloon names the file and says " .. row.says,
        function() return #said() == 1 and said()[1].msg:find(row.says) ~= nil end, function() return vim.inspect(said()) end)
    else
      H.settle(200, 2000)
      H.check(row.name .. ": nothing said", #said() == 0, vim.inspect(said()))
    end
    -- (Nvim's own handler's raw warning: never beside it)
    local raw = vim.tbl_filter(function(b) return type(b.msg) == "string" and b.msg:find("W325", 1, true) ~= nil end,
      H.bridge("popups", "balloon"))
    H.check(row.name .. ": no raw W325 warning", #raw == 0, vim.inspect(raw))
    H.stop()
    -- (deleted, the swap's name went to VimStorm's nvim, which removed it on quitting)
    H.check(row.name .. ": swap file " .. (row.swap_kept and "kept" or "deleted"),
      (vim.uv.fs_stat(swap) ~= nil) == row.swap_kept, swap)
    if row.live then
      owner:kill(9)
      owner:wait(2000)
    end
  end
end)
