-- Feel vscode (#121): VS Code's macOS chords over the WebStorm keymap (config/webstorm.lua), each bound to the
-- VimStorm action that does it. Applied when `config.feel` turns vscode, taken off again (the WebStorm maps it
-- covered put back exactly) under any other Feel. Vim mode stays on: only Cmd / Ctrl / Alt / F-key chords
-- change. Which of them reach nvim from a native surface is Rust's (app/src/editor/input/keymap.rs `VSCODE`).
-- Swedish layout: ⌘\ is ⌘⌥⇧7 (sent as <M-D-S-7>), ⌃` is ⌃⇧´ (<C-S-´>); the US names are mapped too.
local M = {}

local all = { "n", "i", "x" }

-- The lines a key acts on: the selection's, else the caret's
local function lines()
  local s, e = vim.fn.line("."), vim.fn.line(".")
  local visual = vim.api.nvim_get_mode().mode:match("^[vV\22]") ~= nil
  if visual then
    s = vim.fn.line("v")
    if s > e then s, e = e, s end
  end
  return s, e, visual
end

local function leave_visual(visual)
  if visual then vim.cmd("normal! \27") end
end

-- A read-only buffer (the diff's old side, a view) is left alone, as VS Code does
local function editable() return vim.bo.modifiable and not vim.bo.readonly end

-- ⌥↑ / ⌥↓: the line or the selection's lines one up / down; the caret / selection goes along
local function move(dir)
  if not editable() then return end
  local s, e, visual = lines()
  if (dir < 0 and s == 1) or (dir > 0 and e == vim.api.nvim_buf_line_count(0)) then return end
  local col = vim.api.nvim_win_get_cursor(0)[2]
  leave_visual(visual)
  vim.cmd(("silent keepjumps %d,%dmove %d"):format(s, e, dir < 0 and s - 2 or e + 1))
  if visual then return vim.cmd("normal! gv") end
  vim.api.nvim_win_set_cursor(0, { s + dir, col })
end

-- ⌥⇧↑ / ⌥⇧↓: a copy of the lines below them; ↓ the caret / selection on the copy, ↑ on the upper ones
local function copy(dir)
  if not editable() then return end
  local s, e, visual = lines()
  local row, col = unpack(vim.api.nvim_win_get_cursor(0))
  leave_visual(visual)
  vim.api.nvim_buf_set_lines(0, e, e, false, vim.api.nvim_buf_get_lines(0, s - 1, e, false))
  local n = dir > 0 and e - s + 1 or 0
  if visual then
    for _, mark in ipairs({ "'<", "'>" }) do
      local p = vim.fn.getpos(mark)
      p[2] = p[2] + n
      vim.fn.setpos(mark, p)
    end
    return vim.cmd("normal! gv")
  end
  vim.api.nvim_win_set_cursor(0, { row + n, col })
end

-- ⌘⇧K: the lines gone, no register touched (VS Code's Delete Line)
local function delete()
  if not editable() then return end
  local s, e, visual = lines()
  leave_visual(visual)
  vim.api.nvim_buf_set_lines(0, s - 1, e, false, {})
  local last = vim.api.nvim_buf_line_count(0)
  vim.api.nvim_win_set_cursor(0, { math.min(s, last), 0 })
end

-- ⌘⇧O: Go to Symbol in File, the file's LSP symbols in the native popup (filters as you type)
local function file_symbols()
  local KINDS = vim.lsp.protocol.SymbolKind
  local buf = vim.api.nvim_get_current_buf()
  local client = vim.lsp.get_clients({ bufnr = buf, method = "textDocument/documentSymbol" })[1]
  if not client then return vim.notify("No symbols in this file", vim.log.levels.WARN) end
  local params = { textDocument = vim.lsp.util.make_text_document_params(buf) }
  client:request("textDocument/documentSymbol", params, function(err, result)
    if err or not result then return end
    local items = {}
    local function walk(list, depth)
      for _, sym in ipairs(list) do
        local range = sym.selectionRange or sym.range or (sym.location and sym.location.range)
        if range then
          items[#items + 1] = { name = ("  "):rep(depth) .. sym.name, kind = KINDS[sym.kind] or "", pos = range.start }
        end
        if sym.children then walk(sym.children, depth + 1) end
      end
    end
    walk(result, 0)
    vim.ui.select(items, {
      prompt = "Go to Symbol in File",
      format_item = function(it) return it.name .. "  " .. it.kind end,
    }, function(it)
      if not it then return end
      local line = vim.api.nvim_buf_get_lines(buf, it.pos.line, it.pos.line + 1, false)[1] or ""
      vim.cmd("normal! m'")
      vim.api.nvim_win_set_cursor(0, { it.pos.line + 1, vim.str_byteindex(line, client.offset_encoding, it.pos.character, false) })
    end)
  end, buf)
end

-- ⌘K: the first key of a VS Code chord; waits for the second as long as it takes (no 'timeoutlen'):
-- ⌘S the key help (`,?`), ⌘D skips the newest selection's occurrence (multi-cursor), anything else nothing
local function chord_k()
  local app = require("config.app")
  app.chord_waiting = true -- (its Cmd key swallow would drop the second key)
  local ok, key = pcall(vim.fn.getcharstr)
  app.chord_waiting = false
  if ok and key == vim.keycode("<D-s>") then
    vim.cmd.stopinsert()
    vim.schedule(function() require("config.app.keyhelp").show() end)
  elseif ok and key == vim.keycode("<D-d>") then
    require("config.multicursor").soon("skip_next")
  end
end

local ALT_CLICKS = { "<M-LeftMouse>", "<M-2-LeftMouse>", "<M-3-LeftMouse>", "<M-4-LeftMouse>" }

local function insert_too(fn)
  return function()
    vim.cmd.stopinsert()
    vim.schedule(fn)
  end
end

-- What a WebStorm key does (M.webstorm), as a map's action
local function as(lhs) return function() M.webstorm(lhs) end end

-- { modes, lhs (or a list of the same key's names), action, desc }
local function chords()
  local focus = require("config.focus")
  local context = require("config.context")
  local tree = function() require("config.tree").toggle() end
  local git = function() require("git").toggle() end
  local mc = function(name) return function() require("config.multicursor").soon(name) end end
  -- (while typing they leave Insert mode first and act on the next tick themselves)
  local typing = function(name) return function() require("config.multicursor")[name]() end end
  return {
    -- tool windows / layout
    { all, "<D-p>", function() Snacks.picker.files() end, "Go to file" },
    { all, { "<D-S-p>", "<D-P>" }, function() require("config.app.colon").open() end, "Command palette" },
    { all, "<D-b>", tree, "Toggle Project tree" },
    { all, { "<D-S-m>", "<D-M>" }, function() require("config.app.pane").toggle("problems") end, "Problems" },
    { all, { "<D-Bslash>", "<M-D-S-7>" }, function() require("config.editor_tabs").split("right") end, "Split right" },
    -- (⌃⇧G is VS Code's Source Control; ⌘⇧G stays Find Previous, VS Code's too)
    { all, "<C-S-g>", git, "Git (focus / hide)" },
    { all, { "<C-`>", "<C-S-´>" }, function() require("config.app.terminal").toggle() end, "Toggle terminal" },
    { all, "<D-w>", function()
      vim.cmd.stopinsert()
      focus.close_file()
    end, "Close tab" },
    { { "n", "i", "x", "s" }, "<D-k>", chord_k, "⌘K chord (⌘K ⌘S key help, ⌘K ⌘D skip occurrence)" },
    -- editing
    { all, "<M-Up>", function() move(-1) end, "Move line up" },
    { all, "<M-Down>", function() move(1) end, "Move line down" },
    { all, "<M-S-Up>", function() copy(-1) end, "Copy line up" },
    { all, "<M-S-Down>", function() copy(1) end, "Copy line down" },
    { all, { "<D-S-k>", "<D-K>" }, delete, "Delete line" },
    -- multi-cursor (#123, config/multicursor.lua "VS Code"): ⌘D the word, then its next occurrence; ⌥click a caret
    { { "n", "x", "s" }, "<D-d>", mc("add_next"), "Add next occurrence" },
    { "i", "<D-d>", typing("add_next_typing"), "Add next occurrence" },
    -- (a quick second ⌥click on the same spot is a double click: the same)
    { { "n", "x", "s" }, ALT_CLICKS, mc("alt_click"), "Add caret" },
    { "i", ALT_CLICKS, typing("alt_click_typing"), "Add caret" },
    { { "n", "x", "s", "i" }, { "<M-LeftDrag>", "<M-LeftRelease>" }, "<Nop>", "Add caret" },
    -- search / navigation
    -- (⌘⇧F Find in Files is WebStorm's key too)
    { { "n", "x" }, { "<D-S-o>", "<D-O>" }, file_symbols, "Go to symbol in file" },
    { "i", { "<D-S-o>", "<D-O>" }, insert_too(file_symbols), "Go to symbol in file" },
    { all, "<D-t>", function() Snacks.picker.lsp_workspace_symbols() end, "Go to symbol in workspace" },
    { { "n", "x" }, "<C-->", "<Esc><C-o>", "Back" },
    { "i", "<C-->", "<Esc><C-o>", "Back" },
    { { "n", "x" }, { "<C-S-->", "<C-_>" }, "<Esc><C-i>", "Forward" },
    { "i", { "<C-S-->", "<C-_>" }, "<Esc><C-i>", "Forward" },
    -- code
    { { "n", "i" }, "<F12>", function() Snacks.picker.lsp_definitions() end, "Go to definition" },
    { { "n", "i" }, "<S-F12>", function() Snacks.picker.lsp_references() end, "Find usages" },
    { "n", "<F2>", function() vim.lsp.buf.rename() end, "Rename" },
    { "i", "<F2>", insert_too(function() vim.lsp.buf.rename() end), "Rename" },
    { all, "<D-.>", context.code_actions, "Quick fix" },
    -- VS Code's keys for what VimStorm does on a WebStorm key (#129; the menu bar shows them): that key's action
    { all, "<M-D-s>", as("<D-s>"), "Save all" },
    { all, "<M-D-r>", as("<C-D-S-o>"), "Reveal in Finder" },
    { all, "<M-D-f>", as("<D-r>"), "Replace" },
    { all, "<C-D-S-Right>", as("<D-w>"), "Expand selection" },
    { all, "<C-D-S-Left>", as("<D-S-w>"), "Shrink selection" },
    -- the focused pane's tabs (the editor's, the Terminal's shells, Git's), as under every Feel
    { all, "<M-D-Left>", function() focus.cycle_tabs(-1) end, "Previous tab" },
    { all, "<M-D-Right>", function() focus.cycle_tabs(1) end, "Next tab" },
  }
end

-- What was mapped before: { mode, lhs, maparg dict or false }
local saved ---@type {[1]: string, [2]: string, [3]: table|false}[]?

-- The global map only (a buffer-local one on the same key, peek.lua's ⌘B, stays the buffer's)
local function global_map(mode, lhs)
  local raw = vim.api.nvim_replace_termcodes(lhs, true, true, true)
  for _, m in ipairs(vim.api.nvim_get_keymap(mode)) do
    if m.lhsraw == raw then
      -- (nvim_get_keymap says a <Nop> map's rhs is "": mapset would restore a map that does what the key does)
      if m.rhs == "" and not m.callback then m.rhs = "<Nop>" end
      return m
    end
  end
  return false
end

local function remember(mode, lhs)
  saved[#saved + 1] = { mode, lhs, global_map(mode, lhs) }
end

function M.apply()
  if saved then return end
  saved = {}
  for _, c in ipairs(chords()) do
    local modes = type(c[1]) == "table" and c[1] or { c[1] }
    local names = type(c[2]) == "table" and c[2] or { c[2] }
    for _, mode in ipairs(modes) do
      for _, lhs in ipairs(names) do
        remember(mode, lhs)
        vim.keymap.set(mode, lhs, c[3], { desc = c[4], buffer = false })
      end
    end
  end
end

function M.remove()
  if not saved then return end
  for i = #saved, 1, -1 do
    local mode, lhs, before = saved[i][1], saved[i][2], saved[i][3]
    pcall(vim.keymap.del, mode, lhs, { buffer = false })
    if before then vim.fn.mapset(before) end
  end
  saved = nil
end

function M.active() return saved ~= nil end

-- The menu bar's items type their WebStorm shortcut (app/src/app/menu.rs); for a key the Feel vscode took
-- over the app calls this instead: what that key did under WebStorm, in the current mode (VS Code's own keys for
-- WebStorm's actions and your keys, config/keys.lua, do the same)
---@param lhs string
function M.webstorm(lhs)
  local mode = vim.api.nvim_get_mode().mode
  mode = mode:match("^[vV\22]") and "x" or mode:sub(1, 1) == "i" and "i" or "n"
  -- the map this Feel covered, else the one a key of yours covered (config/keys.lua), else the one in force
  local before
  for _, s in ipairs(saved or {}) do
    if s[1] == mode and s[2] == lhs then before = s[3] end
  end
  if before == nil then before = require("config.keys").before(mode, lhs) end
  if before == nil then before = global_map(mode, lhs) end
  if not before then return end
  local keys
  if before.callback then
    keys = before.callback()
    if before.expr ~= 1 then return end
  elseif before.expr == 1 then
    keys = vim.api.nvim_eval(before.rhs)
  else
    keys = before.rhs
  end
  if type(keys) == "string" and keys ~= "" then
    vim.api.nvim_feedkeys(vim.keycode(keys), before.noremap == 1 and "n" or "m", false)
  end
end

-- The menus' shortcut column under Feel vscode: by item label; "" = no key there
local LABELS = {
  ["Go to Declaration or Usages"] = "F12",
  ["Find Usages"] = "⇧F12",
  ["Rename…"] = "F2",
  ["Show Context Actions"] = "⌘.",
  ["Split Right"] = "⌘\\",
  ["Close Tab"] = "⌘W",
  ["Commit…"] = "",
  ["Push…"] = "",
}

---@param label string
---@param key string?
---@return string?
function M.key_label(label, key)
  -- the editor's menus (the tree's own Rename… and Close are its keys)
  if not saved or require("config.focus").target() == "tree" then return key end
  local k = LABELS[label]
  if k == nil then return key end
  return k ~= "" and k or nil
end

-- The Activity bar's items (#131, app/src/shell/activity.rs): Explorer the Project tree shown / hidden (VS Code's
-- side bar), Search Find in Files (⌘⇧F's popup), Source Control the Git tool window (⌘⇧G)
---@param item "explorer"|"search"|"scm"
function M.activity(item)
  vim.cmd.stopinsert()
  if item == "explorer" then return require("config.tree").toggle() end
  if item == "search" then return Snacks.picker.grep() end
  if item == "scm" then return require("git").toggle() end
end

-- From init.lua once the WebStorm keys (config/webstorm.lua, config/app.lua) are mapped. Your keys (config/keys.lua)
-- go over the Feel's: taken off first, so this Feel's maps come off exactly, then put on again.
function M.setup()
  local feel = require("config.feel")
  local keys = require("config.keys")
  local function follow(f)
    keys.remove()
    if f.feel == "vscode" then M.apply() else M.remove() end
    keys.apply(f.keys)
  end
  feel.on_change(follow)
  follow(feel.get())
end

return M
