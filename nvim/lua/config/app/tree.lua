-- The app's Project tree (Rust: app/src/shell/tree). Rust owns the tree (rows, selection, keys, mouse, search, git
-- colors) and does new / copy / paste / delete itself; it calls these for what lives in Lua:
--   open_files(paths, opts)         Enter / double-click: open in the editor; a single click (the Feel's
--                                   tree.singleClick) sends opts = { preview = true }: a preview tab (tabs.preview)
--   menu(ctx)                       right-click / Cmd+Enter: the context menu (items like config/tree.lua's)
--   new_entry(dir) rename(path) copy_one(path) to_folder(verb, paths, dir) move_into(paths, dir)
--                                   ask (vim.ui.input) / rename + move with LSP import updates (Snacks.rename), then
--                                   tell Rust what changed
--   confirm_delete(paths) deleted(paths)   WebStorm's confirmation; tabs of deleted files close
--   clip(paths, cut) paste(dir) copy_text(text)   the clipboard ("+" register: the system's in the app)
--   select_opened() keys_help() info(msg) warn(msg) state(tbl)
-- and setup() sends Rust what it can't see: saves / shell commands (git status), diagnostics (error underlines),
-- the working directory, the editor's file while the Feel's tree.autoReveal is on (`follow`: Rust selects it). state() keeps the tree's open / width / expanded folders for config/session.lua.
local bridge = require("config.app.bridge")
local M = {}

---@param payload table
local function tell(payload) bridge.notify("tree", payload) end

---@class AppTreeState
---@field open boolean
---@field width integer
---@field dirs string[] expanded folders, relative to the project

local current = nil ---@type AppTreeState?

-- Rust: the tree's open state, width and expanded folders changed
---@param s AppTreeState
function M.state(s) current = s end

-- What the session saves (nil before the app said)
---@return AppTreeState?
function M.get_state() return current end

---@param msg string
function M.info(msg) vim.notify(msg, vim.log.levels.INFO) end
---@param msg string
function M.warn(msg) vim.notify(msg, vim.log.levels.WARN) end

---@param paths string[]
---@param opts {preview: boolean?}?
function M.open_files(paths, opts)
  local editor_tabs = require("config.editor_tabs")
  if opts and opts.preview and #paths == 1 then return editor_tabs.open(paths[1], opts) end
  for _, p in ipairs(paths) do editor_tabs.open(p) end
end

-- The file in the editor (the last focused split), nil when it shows none
local function opened_file()
  local win = require("config.focus").split_win()
  local buf = win and vim.api.nvim_win_get_buf(win)
  local name = buf and vim.bo[buf].buftype == "" and vim.api.nvim_buf_get_name(buf) or ""
  return name ~= "" and name or nil
end

-- ,g / Select Opened File: the editor's file selected in the tree, its folders opened, tree focused
function M.select_opened()
  local file = opened_file()
  if file then require("config.tree").reveal_file(file, true) end
end

---@param name string tree action (app/src/shell/tree/mod.rs `action`)
local function act(name) return function() tell({ event = "action", name = name }) end end

-- ,n: new file (opens in the editor, like WebStorm) or folder (ends with "/", gets selected)
---@param dir string
function M.new_entry(dir)
  vim.ui.input({ prompt = 'New file or directory (directories end with "/")' }, function(value)
    if not value or vim.trim(value) == "" then return end
    tell({ event = "create", dir = dir, name = value })
  end)
end

-- Rename / move one path, LSP-aware (imports follow; open buffers get the new name): Snacks.rename, through
-- config/tree.lua's hook (workspace/willRenameFiles, method calls)
---@param from string
---@param to string
---@return boolean ok
local function lsp_rename(from, to)
  require("config.tree").hook_rename()
  local ok = false
  Snacks.rename.rename_file({ from = from, to = to, on_rename = function(_, _, done) ok = done ~= false end })
  return ok
end

-- Shift+F6 (F6 on one row): the field with the path relative to the project (like snacks' rename: edit the
-- folders to move it too), Enter renames
---@param path string
function M.rename(path)
  local root = vim.fs.normalize(vim.fn.getcwd())
  if path:sub(1, #root + 1) ~= root .. "/" then root = vim.fs.dirname(path) end -- outside the project
  local rel = path:sub(#root + 2)
  vim.ui.input({ prompt = "Rename", default = rel }, function(value)
    value = value and vim.trim(value) or ""
    if value == "" or value == rel then return end
    local to = vim.fs.normalize(root .. "/" .. value)
    if vim.uv.fs_stat(to) then return M.warn("Already exists:\n- `" .. to .. "`") end
    if lsp_rename(path, to) then tell({ event = "renamed", from = path, to = to }) end
  end)
end

-- F5 on one row: a copy under a new name (snacks' explorer_copy)
---@param path string
function M.copy_one(path)
  vim.ui.input({ prompt = "Copy to", default = vim.fs.basename(path) }, function(value)
    value = value and vim.trim(value) or ""
    if value == "" then return end
    local to = vim.fs.normalize(vim.fs.dirname(path) .. "/" .. value)
    if vim.uv.fs_stat(to) then return M.warn("File already exists:\n- `" .. to .. "`") end
    tell({ event = "copy", from = path, to = to })
  end)
end

-- Move paths into dir (LSP-aware renames, open tabs follow), then Rust selects dir
---@param paths string[]
---@param dir string
function M.move_into(paths, dir)
  vim.fn.mkdir(dir, "p")
  for _, from in ipairs(paths) do
    local to = dir .. "/" .. vim.fs.basename(from)
    if vim.fs.dirname(from) ~= dir and from ~= dir and dir:sub(1, #from + 1) ~= from .. "/" then
      if vim.uv.fs_stat(to) then
        M.warn("Already exists:\n- `" .. to .. "`")
      else
        lsp_rename(from, to)
      end
    end
  end
  tell({ event = "moved", dir = dir })
end

-- F5 / F6 on a multi-selection: copy / move them all to a folder (asked, like WebStorm's dialog)
---@param verb "Copy"|"Move"
---@param paths string[]
---@param dir string
function M.to_folder(verb, paths, dir)
  local start = vim.fn.fnamemodify(dir, ":.")
  local what = #paths == 1 and ('"%s"'):format(vim.fs.basename(paths[1])) or (#paths .. " items")
  vim.ui.input({ prompt = ("%s %s to directory"):format(verb, what), default = start == "" and "." or start },
    function(value)
      if not value or vim.trim(value) == "" then return end
      local target = vim.fs.normalize(vim.fn.fnamemodify(vim.trim(value), ":p")):gsub("/$", "")
      if verb == "Move" then return M.move_into(paths, target) end
      tell({ event = "copy_into", paths = paths, dir = target })
    end)
end

-- Backspace / Delete: WebStorm's confirmation (Enter deletes)
---@param paths string[]
function M.confirm_delete(paths)
  if #paths == 0 then return end
  local what = #paths > 1 and (#paths .. " items")
    or ('%s "%s"'):format(vim.fn.isdirectory(paths[1]) == 1 and "directory" or "file", vim.fs.basename(paths[1]))
  vim.ui.select({ "Delete", "Cancel" }, { prompt = "Delete " .. what .. "?" }, function(choice)
    if choice == "Delete" then tell({ event = "delete", paths = paths }) end
  end)
end

-- Rust deleted them: their buffers (tabs) close
---@param paths string[]
function M.deleted(paths)
  for _, path in ipairs(paths) do
    for _, b in ipairs(vim.api.nvim_list_bufs()) do
      local name = vim.api.nvim_buf_get_name(b)
      if name == path or name:sub(1, #path + 1) == path .. "/" then Snacks.bufdelete({ buf = b, force = true }) end
    end
  end
end

-- Cmd+C / Cmd+X: the rows' paths to the clipboard, one per line; Cmd+V (paste) copies them, or moves them after
-- a cut, into the folder at the cursor
local cut ---@type string?
---@param paths string[]
---@param is_cut boolean
function M.clip(paths, is_cut)
  if #paths == 0 then return end
  local text = table.concat(paths, "\n")
  cut = is_cut and text or nil
  vim.fn.setreg("+", text, "l")
  M.info(("%s %d %s"):format(is_cut and "Cut" or "Copied", #paths, #paths == 1 and "file" or "files"))
end

---@param dir string
function M.paste(dir)
  local reg = vim.fn.getreg("+"):gsub("\n$", "")
  if cut and reg == cut then
    local paths = vim.split(cut, "\n", { plain = true })
    cut = nil
    return M.move_into(paths, dir)
  end
  local files = vim.tbl_filter(function(f) return f ~= "" and vim.uv.fs_stat(f) ~= nil end,
    vim.split(reg, "\n", { plain = true }))
  if #files == 0 then return M.warn("The `+` register does not contain any files") end
  tell({ event = "copy_into", paths = files, dir = dir })
end

-- Copy Path / Copy Reference (Cmd+Shift+C / Cmd+Alt+Shift+C)
---@param text string
function M.copy_text(text)
  vim.fn.setreg("+", text)
  M.info("Copied " .. text)
end

-- `?`: the tree's keys
function M.keys_help()
  local menu = require("config.menu")
  local function row(label, key) return { label, function() end, key = key } end
  menu.open({
    row("Collapse / parent folder", "← k"), row("Expand / first child", "→ ä"), row("Up / down", "↑↓ l ö"),
    row("5 rows / a count first (3ö, 3Ö = 15)", "L Ö"), row("First / last row", "gg G"),
    row("Open file / toggle folder", "⏎"), row("Search in tree", "/"), row("Back to the editor", "Esc"),
    "-",
    row("New file or directory…", ",n o"), row("Rename…", "⇧F6 rr"), row("Copy to…", "F5"), row("Move…", "F6"),
    row("Delete", "⌫ dd"), row("Cut / Copy / Paste", "⌘X ⌘C ⌘V · x yy P"), row("Copy Path", "⇧⌘C"),
    row("Select range / toggle row", "⇧↑↓ ⌥click"), row("Select Opened File", ",g"),
    row("Reveal in Finder", "⌃⇧⌘O"), row("Collapse All / Expand All", "⇧⌘- ⇧⌘="), row("Menu", "⌘⏎"),
  }, { title = "Project Tree Keys" })
end

---@class AppTreeMenuCtx
---@field paths string[] the selection (the multi-selection, else the row)
---@field multi integer rows selected (0: one row)
---@field files integer files among them
---@field dir boolean the row is a folder
---@field open boolean an open folder
---@field root boolean the project root row
---@field x number window px
---@field y number

-- Right-click / Cmd+Enter on the tree (config/tree.lua's menu: same items and keys)
---@param ctx AppTreeMenuCtx
function M.menu(ctx)
  local menu = require("config.menu")
  local opts = { at = "mouse", pos = { x = ctx.x, y = ctx.y } }
  if ctx.multi > 1 then
    local n = ctx.multi
    return menu.open({
      { ("Open %d Files"):format(ctx.files), act("confirm"), key = "⏎", enabled = ctx.files > 0 },
      "-",
      { "Cut", act("cut"), key = "⌘X" },
      { "Copy", act("copy"), key = "⌘C" },
      { "Paste", act("paste"), key = "⌘V" },
      { "Copy Paths", act("copy_path"), key = "⇧⌘C" },
      "-",
      { ("Copy %d Items to…"):format(n), act("copy_to"), key = "F5" },
      { ("Move %d Items…"):format(n), act("move"), key = "F6" },
      { ("Delete %d Items"):format(n), act("delete"), key = "⌫" },
      "-",
      { "Reveal in Finder", act("reveal"), key = "⌃⇧⌘O" },
      "-",
      { "Clear Selection", act("clear_selection"), key = "Esc" },
    }, opts)
  end
  local path = ctx.paths[1]
  if not path then return end
  local dir = ctx.dir and path or vim.fs.dirname(path)
  local items = {
    { "New File or Directory…", act("new"), key = ",n" },
    "-",
    { ctx.dir and (ctx.open and "Collapse" or "Expand") or "Open", act("confirm"), key = "⏎" },
    { "Cut", act("cut"), key = "⌘X", enabled = not ctx.root },
    { "Copy", act("copy"), key = "⌘C" },
    { "Paste", act("paste"), key = "⌘V" },
    { "Copy Path", act("copy_path"), key = "⇧⌘C" },
    { "Copy Relative Path", act("copy_reference"), key = "⌥⇧⌘C" },
    "-",
    { "Rename…", act("rename"), key = "⇧F6", enabled = not ctx.root },
    { "Copy to…", act("copy_to"), key = "F5", enabled = not ctx.root },
    { "Move…", act("move"), key = "F6", enabled = not ctx.root },
    { "Delete", act("delete"), key = "⌫", enabled = not ctx.root },
    "-",
    { "Search in Tree…", act("search"), key = "/" },
    { "Find in Folder…", function() Snacks.picker.grep({ dirs = { dir } }) end, key = "⌘⇧F" },
    { "Open in Terminal", function() require("config.app.terminal").new(dir) end },
    { "Reveal in Finder", act("reveal"), key = "⌃⇧⌘O" },
    { "Show History", function() require("git").file_history(path) end },
    "-",
    { "Select Opened File", act("select_opened"), key = ",g", enabled = opened_file() ~= nil },
    { "Collapse All", act("collapse_all"), key = "⇧⌘-" },
    { "Expand All", act("expand_all"), key = "⇧⌘=" },
  }
  menu.open(items, opts)
end

-- Alt+F1: WebStorm's "Select In" popup (Project View, Finder) for the current file
local function select_in()
  local file = vim.api.nvim_buf_get_name(0)
  if file == "" or vim.bo.buftype ~= "" then return end
  require("config.menu").open({
    { "Project View", function() require("config.tree").reveal_file(file, true) end, key = "1" },
    { "Finder", function() require("config.tree").reveal({ file }) end, key = "2" },
  }, { title = "Select In" })
end

-- tree.autoReveal (VS Code's explorer.autoReveal): the file in the editor's last focused split, once per file
local followed = nil ---@type string?
local function follow()
  if not require("config.feel").auto_reveal() then
    followed = nil
    return
  end
  local win = require("config.focus").split_win()
  local buf = win and vim.api.nvim_win_get_buf(win)
  if not buf or vim.bo[buf].buftype ~= "" then return end
  local file = vim.api.nvim_buf_get_name(buf)
  if file == "" or file == followed or vim.fn.filereadable(file) ~= 1 then return end
  followed = file
  tell({ event = "follow", file = file })
end

local feel_hooked = false

function M.setup()
  local group = vim.api.nvim_create_augroup("ws_app_tree", { clear = true })
  vim.api.nvim_create_autocmd({ "BufEnter", "WinEnter" }, {
    group = group,
    callback = function() vim.schedule(follow) end,
  })
  if not feel_hooked then
    feel_hooked = true
    require("config.feel").on_change(function(now, before)
      if now.tree.autoReveal and not before.tree.autoReveal then followed = nil end
      follow()
    end)
  end
  -- git status may have changed (the tree colors names by it; Rust also re-reads on index / HEAD changes)
  vim.api.nvim_create_autocmd({ "BufWritePost", "ShellCmdPost", "TermLeave", "FocusGained" }, {
    group = group,
    callback = function() tell({ event = "git" }) end,
  })
  -- error underlines (config/problems.lua: compiler errors, not ESLint) and each file's problem counts (Feel
  -- vscode's badge), coalesced
  local timer = assert(vim.uv.new_timer())
  local last = nil ---@type string?
  vim.api.nvim_create_autocmd("DiagnosticChanged", {
    group = group,
    callback = function()
      timer:start(200, 0, vim.schedule_wrap(function()
        local problems = require("config.problems")
        local paths = vim.tbl_keys(problems.paths())
        table.sort(paths)
        local counts = problems.counts()
        local parts = { table.concat(paths, "\n") }
        for _, c in ipairs(counts) do parts[#parts + 1] = c.path .. ":" .. c.errors .. ":" .. c.warnings end
        local key = table.concat(parts, "\1")
        if key == last then return end
        last = key
        tell({ event = "problems", paths = paths, counts = counts })
      end))
    end,
  })
  vim.api.nvim_create_autocmd("DirChanged", {
    group = group,
    pattern = "global",
    callback = function() tell({ event = "root", dir = vim.fn.getcwd() }) end,
  })
  vim.keymap.set({ "n", "i", "x" }, "<M-F1>", select_in, { desc = "Select In…" })
  -- `:e <dir>` / a folder argument: the folder in the tree (snacks' netrw replacement did this), no
  -- directory buffer left behind
  vim.api.nvim_create_autocmd("BufEnter", {
    group = group,
    callback = function(ev)
      if ev.file == "" or vim.fn.isdirectory(ev.file) ~= 1 then return end
      local dir = vim.fs.normalize(vim.fn.fnamemodify(ev.file, ":p")):gsub("/$", "")
      vim.schedule(function()
        if not vim.api.nvim_buf_is_valid(ev.buf) then return end
        if vim.v.vim_did_enter == 0 then
          vim.api.nvim_buf_set_name(ev.buf, "") -- (don't load it again)
        else
          Snacks.bufdelete.delete(ev.buf)
        end
        require("config.tree").reveal_file(dir, true, true)
      end)
    end,
  })
end

return M
