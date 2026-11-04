-- Context menus of the editor and its tabs (right-click / Cmd+Enter), WebStorm's items trimmed
-- to what's set up here. Each item shows its shortcut. Tool windows add theirs in their own
-- module (tree, terminal, Git tool window, diff, merge).
local menu = require("config.menu")
local tabs = require("config.editor_tabs")

local M = {}

local function feed(keys)
  vim.api.nvim_feedkeys(vim.keycode(keys), "m", false)
end

-- Same as Cmd+V (the app's paste, config/app.lua): a copied whole line goes above the caret's line
local function paste()
  local lines = vim.fn.getreg("+", 1, true) --[[@as string[] ]]
  if vim.fn.getregtype("+") == "V" then lines[#lines + 1] = "" end
  vim.paste(lines, -1)
end

local function notify(msg)
  vim.notify(msg, vim.log.levels.INFO)
end

-- Alt+Enter: WebStorm's intentions popup lists only what can be applied here, not the refactorings
-- the server reports as disabled ("Extract function (disabled)")
function M.code_actions()
  -- a Layer's workflow / skill file: Abe's fixes on the line first (config/workflow.lua)
  if require("config.workflow").code_actions() then return end
  vim.lsp.buf.code_action({ filter = function(action) return not action.disabled end })
end

-- Cmd+B / gd: on a usage -> go to declaration; on the declaration -> Show Usages popup (config/usages.lua)
function M.declaration_or_usages()
  -- a Layer's workflow / skill file: a step's skill, or a skill's steps (config/workflow.lua)
  if require("config.workflow").declaration_or_usages() then return end
  require("config.usages").declaration_or_usages()
end

-- ,g: show the file in the tree (default: the current buffer's), focused
---@param file? string
function M.select_in_tree(file)
  require("config.tree").reveal_file(file)
end

-- Copy Path / Copy Relative Path
---@param path string absolute
---@return MenuEntry[]
function M.path_items(path)
  return {
    { "Copy Path", function()
      vim.fn.setreg("+", path)
      notify("Copied " .. path)
    end },
    { "Copy Relative Path", function()
      local rel = vim.fn.fnamemodify(path, ":.")
      vim.fn.setreg("+", rel)
      notify("Copied " .. rel)
    end },
  }
end

-- A change (gitsigns hunk) on the line?
local function on_change(buf, lnum)
  local ok, changes = pcall(function() return require("gitsigns").get_hunks(buf) end)
  for _, h in ipairs(ok and changes or {}) do
    local first = h.added.start
    if lnum >= first and lnum <= first + math.max(h.added.count, 1) - 1 then return true end
  end
  return false
end

---@param buf integer
---@param ctx {visual: boolean}
---@return MenuEntry[]
local function editor_items(buf, ctx)
  local lsp = #vim.lsp.get_clients({ bufnr = buf }) > 0
  local vis = ctx.visual
  local path = vim.api.nvim_buf_get_name(buf)
  local file = path ~= "" and vim.bo[buf].buftype == ""
  local change = file and on_change(buf, vim.api.nvim_win_get_cursor(0)[1])
  local blame = require("git.blame")
  local workflow = require("config.workflow")
  local items = {
    { "Show Context Actions", function() if vis then feed("gv<M-CR>") else M.code_actions() end end, key = "⌥⏎",
      enabled = lsp or #workflow.fixes_at(buf, vim.api.nvim_win_get_cursor(0)[1]) > 0 },
    "-",
    { "Search Everywhere", function() require("config.doubleshift").trigger() end, key = "⇧⇧" }, -- config/doubleshift.lua
    { "Go to Declaration or Usages", M.declaration_or_usages, key = "⌘B", enabled = lsp },
    { "Quick Definition", function() require("config.peek").open() end, key = "⌘L", enabled = lsp },
    { "Find Usages", function() require("config.usages").usages() end, key = "grr", enabled = lsp },
    { "Go to Type Declaration", function() Snacks.picker.lsp_type_definitions() end, key = "gy", enabled = lsp },
    { "Go to Implementations", function() Snacks.picker.lsp_implementations() end, key = "gri", enabled = lsp },
    { "Rename…", vim.lsp.buf.rename, key = "⇧F6", enabled = lsp },
    { "Reformat Code", function() if vis then feed("gv<D-M-l>") else require("conform").format({ async = true }) end end, key = "⌘⌥L" },
    "-",
    { "Cut", function() feed(vis and 'gv"+d' or '"+dd') end, key = "⌘X" },
    { "Copy", function() feed(vis and 'gv"+ygv' or '"+yy') end, key = "⌘C" },
    { "Paste", function() if vis then feed('gv"+P') else paste() end end, key = "⌘V" },
    { "Select All", function() feed("ggVG") end, key = "⌘A" },
    { "Comment with Line Comment", function() feed(vis and "gvgc" or "gcc") end, key = "⌘/" },
    { "Replace…", function() if vis then feed("gv<D-r>") else require("config.replace").open() end end, key = "⌘R", enabled = file },
    { "Folding", function() menu.open(require("config.fold").menu_items(), { title = "Folding" }) end, key = "›" }, -- config/fold.lua
    "-",
    { "Rollback Lines", function() require("gitsigns").reset_hunk() end, key = "⌘⌥Z", enabled = change },
    { "Show Diff for Lines", function() require("gitsigns").preview_hunk() end, key = ",cp", enabled = change },
    { blame.is_enabled(buf) and "Close Annotations" or "Annotate with Git Blame", blame.toggle, key = ",å", enabled = file },
    { "Show History for File", function() require("git").file_history(path) end, key = ",H", enabled = file },
    { "Commit…", function() require("git").commit() end, key = "⌘K" },
    { "Push…", function() require("git").push() end, key = "⌘⇧K" },
    "-",
    { "Select in Project View", function() M.select_in_tree() end, key = ",g", enabled = file },
    { "Reveal in Finder", function() require("config.tree").reveal({ path }) end, key = "⌃⇧⌘O", enabled = file },
    { "Bookmarks ›", function() require("config.bookmarks").menu() end, key = "›", enabled = file },
  }
  if vis then -- git: Show History for Selection (the lines selected, '< '>), after the file's history
    for i, it in ipairs(items) do
      if type(it) == "table" and it[1] == "Show History for File" then
        table.insert(items, i + 1, { "Show History for Selection", function() require("git").selection_history(buf, vim.fn.line("'<"), vim.fn.line("'>")) end, key = ",H", enabled = file })
        break
      end
    end
  end
  -- the app's toolbar: Branches… / New Branch… / Recent Projects… / Close Project / Down / Up the Rail, after Push…
  for i, it in ipairs(items) do
    if type(it) == "table" and it[1] == "Push…" then
      for j, entry in ipairs(require("config.app.toolbar").menu_items()) do table.insert(items, i + j, entry) end
      break
    end
  end
  if file then vim.list_extend(items, M.path_items(path)) end
  if vim.g.vimstorm_app and file then vim.list_extend(items, require("config.app.agent_files").menu_items(buf)) end
  -- a Layer's workflow / skill file: Change with AI…, Edit / Open My Copy, Propose…, Retro… (config/workflow.lua)
  if file then
    for j, entry in ipairs(workflow.menu_items(buf)) do table.insert(items, 1 + j, entry) end
  end
  if file then vim.list_extend(items, require("config.markdown").menu_items(buf)) end -- Editor Only / Editor and Preview / Preview Only
  vim.list_extend(items, {
    "-",
    { "Split Right", function() tabs.split("right") end, key = ",v" },
    { "Split Down", function() tabs.split("down") end, key = ",h" },
    { "Split and Move Right", function() tabs.split("right", true) end },
    { "Move to Opposite Group", function() tabs.move_to_opposite() end, enabled = tabs.opposite() ~= nil },
    { "Close Split", function() require("config.focus").close_split() end, enabled = #vim.tbl_filter(function(w) return require("config.focus").is_split(w, true) end, vim.api.nvim_tabpage_list_wins(0)) > 1 },
    { "Close Tab", function() require("config.focus").close_file() end, key = ",w" },
  })
  return items
end

-- Right-click on a tab (of split `win`: everything acts on that split's tabs, config/editor_tabs.lua)
---@param buf integer
---@param win integer?
---@param pos? {x: number, y: number} the app's native tab bar: where the menu goes (window px)
function M.tab_menu(buf, win, pos)
  win = win or require("config.focus").split_win()
  local function on_tab(fn)
    return function()
      if win and vim.api.nvim_win_is_valid(win) then
        vim.api.nvim_set_current_win(win)
        if vim.api.nvim_buf_is_valid(buf) then vim.api.nvim_win_set_buf(win, buf) end
      end
      fn()
    end
  end
  local path = vim.api.nvim_buf_get_name(buf)
  local items = {
    { "Close Tab", function() tabs.close(buf, win) end, key = ",w" },
    { "Close Other Tabs", function() tabs.close_others(buf, win) end, key = ",o" },
    { "Close Tabs to the Left", function() tabs.close_left(buf, win) end },
    { "Close Tabs to the Right", function() tabs.close_right(buf, win) end },
    { "Close All Tabs", function() tabs.close_all(win) end },
    "-",
    { "Split Right", on_tab(function() tabs.split("right") end), key = ",v" },
    { "Split Down", on_tab(function() tabs.split("down") end), key = ",h" },
    { "Split and Move Right", on_tab(function() tabs.split("right", true) end) },
    { "Split and Move Down", on_tab(function() tabs.split("down", true) end) },
    { "Move to Opposite Group", function() tabs.move_to_opposite(buf, win) end, enabled = tabs.opposite(win) ~= nil },
    "-",
    { "Select in Project View", function() M.select_in_tree(path) end, key = ",g" },
    { "Reveal in Finder", function() require("config.tree").reveal({ path }) end, key = "⌃⇧⌘O" },
    { "Show History for File", function() require("git").file_history(path) end, key = ",H" },
  }
  vim.list_extend(items, M.path_items(path))
  menu.open(items, { at = "mouse", pos = pos })
end

menu.provider(0, function(win, buf, ctx)
  if not require("config.focus").is_split(win, true) then return end
  return editor_items(buf, ctx)
end)

return M
