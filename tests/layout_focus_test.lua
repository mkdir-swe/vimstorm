-- Layout: the IDE window (the app's UI) resized, the editor splits and the bottom tool window keep their
-- proportions (config/bottom.lua, VimResized) and come back as they were. Focus routing, cues and the tool
-- windows as drawn are cargo tests (workspace.rs, terminal.rs, gitwin.rs).
local H = dofile(os.getenv("NVT_HARNESS"))

H.run(function()
  H.start("grepo", { "long.ts" })
  H.wait_focus("split")
  -- (the bottom tool window: Git; the Terminal shares it, terminal.rs)
  H.call("config.app.git", "open")
  H.wait_focus("git")
  H.call("config.focus", "editor") -- (back to the editor; Git stays open)
  H.wait_focus("split")

  -- IDE window resized: splits and the bottom tool window keep their proportions, and come back as they were
  H.keys(",v")
  H.wait_for(function() return H.tab_bars():find(" | ", 1, true) ~= nil end)
  local function sizes()
    return H.lua([[
      local f, out = require('config.focus'), { splits = {}, rows = 0 }
      for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
        if f.is_split(w) then out.splits[#out.splits + 1] = vim.api.nvim_win_get_width(w) end
      end
      local t = require('config.app.git').win()
      out.term = t and vim.api.nvim_win_get_height(t) or nil
      out.rows = vim.o.lines
      return out]]) or {}
  end
  local before = sizes()
  H.resize(120, 35)
  H.expect("IDE window shrinks: both splits keep half the editor each, Git shrinks with it", function()
    local s = sizes()
    return #s.splits == 2 and math.abs(s.splits[1] - s.splits[2]) <= 2 and s.term ~= nil and before.term ~= nil
      and s.term < before.term and math.abs(s.term / s.rows - before.term / before.rows) < 0.08
  end, function() return vim.inspect({ before, sizes() }) end)
  H.resize(200, 50)
  local resized = H.lua("return vim.uv.hrtime()")
  H.expect("IDE window back to its size: the same layout as before", function() return vim.deep_equal(sizes(), before) end,
    function() return vim.inspect({ before, sizes() }) end)
  H.keys(",q")

  -- The bottom pane: toggle(tab) shows it on Sessions / Boxes / Pipelines with the keys (the app draws them over
  -- the `pane` window), the same tab again hides it, another switches; toggle_last() is the last one used; Git takes
  -- the bottom at the pane's height; Esc (Rust's leave()) gives the keys back, the pane stays; Cmd+9 opens nothing
  local function toggle(tab) H.lua("require('config.app.pane').toggle(...) return true", { tab }) end
  local function shown() return H.lua("return require('config.app.pane').shown()") end
  local function rows()
    return H.lua([[local p, g = require('config.app.pane').win(), require('config.app.git').win()
      local w = p or g return w and vim.api.nvim_win_get_height(w) or -1]])
  end
  -- (half a second after the resize: bottom.lua scales windows opened right after one to the layout noted before)
  H.wait_for(function() return (H.lua("return vim.uv.hrtime()") - resized) / 1e6 > 600 end, 3000)
  H.bridge_clear()
  toggle("sessions")
  H.wait_focus("pane")
  H.expect("the app told: the pane on Sessions with the keys", function()
    return H.wait_bridge("pane", "open", function(p) return p.tab == "sessions" and p.enter == true end) ~= nil
  end)
  H.expect("its window's role is the pane's", function()
    return H.wait_bridge("layout", "windows", function(p)
      for _, w in ipairs(p.wins or {}) do
        if w.role == "pane" then return true end
      end
      return false
    end) ~= nil
  end)
  toggle("boxes")
  H.expect("Boxes on Sessions: Boxes, keys kept", function() return shown() == "boxes" and H.focus() == "pane" end)
  -- (10: above bottom.lua's 8-row floor, #156)
  H.lua("vim.api.nvim_win_set_height(require('config.app.pane').win(), 10) return true")
  toggle("boxes")
  H.expect("Boxes again: hidden, the keys in the code", function() return shown() == nil and H.focus() == "split" end)
  -- the last one used (Boxes); then Git
  H.lua("require('config.app.pane').toggle_last() return true")
  H.wait_focus("pane")
  H.expect("the last one: Boxes", function() return shown() == "boxes" end)
  H.lua("require('config.app.pane').show('git') return true")
  H.wait_focus("git")
  H.expect("Git in the pane at its height", function() return shown() == "git" and rows() == 10 end,
    function() return vim.inspect({ shown(), rows() }) end)
  toggle("pipelines")
  H.wait_focus("pane")
  H.expect("Pipelines takes the bottom from Git", function()
    return shown() == "pipelines" and H.lua("return require('config.app.git').is_open()") == false and rows() == 10
  end)
  H.call("config.app.pane", "leave")
  H.wait_focus("split")
  H.expect("Esc: the pane stays", function() return shown() == "pipelines" end)
  toggle("pipelines")
  H.wait_focus("pane")
  H.expect("Pipelines with the pane shown but the keys elsewhere: the keys back, not hidden", function()
    return shown() == "pipelines"
  end)
  H.keys("<D-9>")
  H.settle()
  H.expect("Cmd+9 opens nothing", function() return shown() == "pipelines" and H.focus() == "pane" end)
  H.lua("require('config.app.pane').hide() return true")
  H.wait_focus("split")

  -- ⌥⌘⏎ (#102): the app gives one split's grid the body's cells (wider and taller than its window) and leaves
  -- the others' as they are; nvim gives that window the text area (winwidth / winheight), the other split and the
  -- logical layout stay
  H.keys(",v")
  H.wait_for(function() return H.tab_bars():find(" | ", 1, true) ~= nil end)
  local function split_sizes()
    return H.lua([[local f, out = require('config.focus'), {}
      for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
        if f.is_split(w) then
          out[#out + 1] = { win = w, w = vim.fn.winwidth(w), h = vim.fn.winheight(w), lw = vim.api.nvim_win_get_width(w) }
        end
      end
      return out]]) or {}
  end
  local two = split_sizes()
  local body = { cols = H.lua("return vim.o.columns"), rows = H.lua("return vim.o.lines") - 3 }
  local big, other = two[1], two[2]
  H.resize_grid(big.win, body.cols, body.rows)
  H.expect("the maximized split's grid is the body's cells", function()
    local s = split_sizes()
    return s[1].w == body.cols and s[1].h == body.rows and s[1].lw == big.lw
  end, function() return vim.inspect({ body, split_sizes() }) end)
  H.expect("the other split untouched", function()
    local s = split_sizes()
    return #s == 2 and s[2].w == other.w and s[2].h == other.h
  end, function() return vim.inspect({ other, split_sizes() }) end)
  -- restored: its grid back to its island's size
  H.resize_grid(big.win, big.w, big.h)
  H.expect("restored: both splits as they were", function() return vim.deep_equal(split_sizes(), two) end,
    function() return vim.inspect({ two, split_sizes() }) end)
  H.keys(",q")
  H.wait_for(function() return H.tab_bars():find(" | ", 1, true) == nil end)
  -- Normal mode's Esc tells the app when it had nothing to do (a maximized split restores then); a count, a search
  -- highlight or an operator pending keep it nvim's alone
  H.bridge_clear()
  H.keys("5<Esc>")
  H.lua("vim.fn.setreg('/', 'a') vim.cmd('set hlsearch') vim.cmd('let v:hlsearch = 1') return true")
  H.keys("<Esc>")
  H.keys("d<Esc>")
  H.settle()
  H.expect("a count, the highlight, an operator: no esc_idle", function() return #H.bridge("maximize") == 0 end)
  H.keys("<Esc>")
  H.expect("nothing to do: esc_idle", function() return H.wait_bridge("maximize", "esc_idle") ~= nil end)

  -- the jumps (2.1 #106): in a split ⌃W stays Vim's window prefix and ⌃I its jump forward; ⌃⌥L is the app's (Rust
  -- takes it before nvim), ⌃⌥W ⌃⌥I no one's, so no map here takes them
  local function splits()
    return H.lua([[local f, n = require('config.focus'), 0
      for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do if f.is_split(w) then n = n + 1 end end
      return n]])
  end
  local n = splits()
  H.keys("<C-w>s")
  H.expect("⌃W s splits", function() return splits() == n + 1 end)
  H.keys("<C-w>c")
  H.expect("⌃W c closes it", function() return splits() == n end)
  H.expect("⌃I is Vim's jump forward (its own map, apart from Tab's indent)", function()
    return H.lua([[for _, m in ipairs(vim.api.nvim_get_keymap('n')) do
        if m.lhs == '<C-I>' then return m.rhs == '<Tab>' end
      end
      return false]])
  end)
  H.expect("no map takes ⌃⌥W ⌃⌥I ⌃⌥L", function()
    return H.lua([[for _, k in ipairs({ '<C-M-w>', '<C-M-i>', '<C-M-l>' }) do
        for _, m in ipairs({ 'n', 'i', 'v', 't' }) do if vim.fn.maparg(k, m) ~= '' then return false end end
      end
      return true]])
  end)

  -- the Chat column (2.1 #119, #213): layout beside nvim's screen, never an nvim window. With the keyboard it is a
  -- native surface (Rust's native_focus "chat", its keys never typed into nvim); given back, the split as it was
  local wins = H.lua("return #vim.api.nvim_tabpage_list_wins(0)")
  local caret = H.cursor()
  H.native_focus("chat")
  H.wait_focus("popup")
  H.check("the Chat column has no nvim window", H.lua("return #vim.api.nvim_tabpage_list_wins(0)") == wins)
  H.native_focus(nil)
  H.wait_focus("split")
  H.check("given back: the split, its caret where it was", vim.deep_equal(H.cursor(), caret), vim.inspect(H.cursor()))
end)
