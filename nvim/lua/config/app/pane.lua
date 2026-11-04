-- The bottom pane (2.1 #116; Rust side: app/src/shell/pane.rs, "PaneHost"). 3.5: Code's bottom panel is
-- Terminal · Git · Problems (app/src/shell/panel.rs): this window draws Problems; `show`, `panel` and
-- `restore_panel` reach the three. Sessions, Boxes and Pipelines draw over ONE placeholder window in the bottom tool window (config/bottom.lua:
-- shares the bottom with Git, one height, a third of the body by default), an empty scratch buffer (b:ws_tool,
-- filetype wspane), reported by config/app/layout.lua with role = "pane"; Git is the Git tool window's own host
-- (config/app/git.lua), drawing the same four tabs before its own. While the pane's window is nvim's current window
-- the PaneHost has the keyboard (focus.target() == "pane"). Hidden by default and not kept in the session.
--
-- Keys (config/webstorm.lua): Cmd+5 Sessions, Cmd+6 Boxes, Cmd+7 Pipelines: `toggle(tab)` shows the pane on that tab
-- with the keyboard; the same key while that tab has the keyboard hides it. Cmd+3 (3.0 #20): `toggle_last()`, the
-- last tool window shown (Git too, which has no key of its own), Sessions before any was. Esc gives the keys back.
--
-- Feel vscode (#128): Problems first, VS Code's Problems panel (Cmd+Shift+M): the workspace's diagnostics by file,
-- sent while the pane is open on it and whenever they change; ⏎ / a click opens the file at the problem.
--
-- Lua -> Rust (`vimstorm.pane`): open {tab, enter} / hide / focus / blur / problems {files}.
-- Rust -> Lua: show(tab) (a header tab, Options), hide(), enter() (a click into it), leave() (Esc),
-- open_problem(path, lnum, col).
local bottom = require("config.bottom")
local bridge = require("config.app.bridge")

local M = {}

local NATIVE = "pane" -- the host's native surface name (config/app.lua native())
local TABS = { problems = true, sessions = true, boxes = true, pipelines = true } -- the pane window's (Git is git.lua's)

local S = {
  win = nil, ---@type integer?
  buf = nil, ---@type integer?
  tab = "problems", -- the pane window's tab, kept while hidden
  last = "terminal", -- the panel's last tab shown, Git and the Terminal too (Cmd+J's; the Terminal until another)
}

local function valid(win) return win ~= nil and vim.api.nvim_win_is_valid(win) end

local function notify(payload) return bridge.notify(NATIVE, payload) end

local function git() return require("config.app.git") end

function M.is_open() return valid(S.win) end

local function current() return valid(S.win) and vim.api.nvim_get_current_win() == S.win end

-- The pane window has the keyboard: it is current and no other native surface took it meanwhile
function M.is_focused()
  if not current() then return false end
  local native = require("config.app").native()
  return native == nil or native == NATIVE
end

-- The host window (tests, layout.lua)
function M.win() return valid(S.win) and S.win or nil end

-- The tab the pane shows: "git" while the Git tool window is open, else the pane window's (nil: hidden)
---@return string?
function M.shown()
  if git().is_open() then return "git" end
  if M.is_open() then return S.tab end
end

local function host_buf()
  if S.buf and vim.api.nvim_buf_is_valid(S.buf) then return S.buf end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.b[buf].ws_tool = true -- a tool window's own buffer (focus.lua's guard, layout.lua's kind)
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].filetype = "wspane"
  vim.bo[buf].modifiable = false
  S.buf = buf
  return buf
end

local function win_opts(win)
  local wo = vim.wo[win]
  wo.number, wo.relativenumber, wo.signcolumn, wo.foldcolumn, wo.statuscolumn = false, false, "no", "0", ""
  wo.wrap, wo.cursorline, wo.list, wo.spell, wo.winfixheight = false, false, false, false, true
  wo.winbar = "" -- the host draws the header
  wo.fillchars = "eob: "
end

local SEVERITY = { "error", "warning", "info", "hint" } -- by vim.diagnostic.severity

-- The workspace's errors, warnings and infos (no hints, as VS Code) as the Problems tab lists them: files by path, each file's problems errors first,
-- then by line and column (VS Code's order); 1-based line and column
---@return {path: string, name: string, dir: string, items: table[]}[]
function M.problems()
  local by = {} ---@type table<string, {path: string, name: string, dir: string, items: table[]}>
  for _, d in ipairs(vim.diagnostic.get(nil, { severity = { min = vim.diagnostic.severity.INFO } })) do
    local path = vim.api.nvim_buf_is_valid(d.bufnr) and vim.api.nvim_buf_get_name(d.bufnr) or ""
    if path ~= "" then
      local f = by[path]
      if not f then
        local rel = vim.fn.fnamemodify(path, ":~:.")
        local dir = vim.fs.dirname(rel)
        f = { path = path, name = vim.fs.basename(path), dir = dir == "." and "" or dir, items = {} }
        by[path] = f
      end
      f.items[#f.items + 1] = {
        lnum = d.lnum + 1, col = d.col + 1, severity = SEVERITY[d.severity] or "info", message = d.message or "",
        source = d.source or "", code = d.code ~= nil and tostring(d.code) or "", rank = d.severity or 4,
      }
    end
  end
  local out = vim.tbl_values(by)
  table.sort(out, function(a, b) return a.path < b.path end)
  for _, f in ipairs(out) do
    table.sort(f.items, function(a, b)
      if a.rank ~= b.rank then return a.rank < b.rank end
      if a.lnum ~= b.lnum then return a.lnum < b.lnum end
      return a.col < b.col
    end)
    for _, it in ipairs(f.items) do it.rank = nil end
  end
  return out
end

local sent_problems ---@type string?
-- The Problems tab's rows to the app (force: even when unchanged)
---@param force? boolean
local function send_problems(force)
  local files = M.problems()
  local key = vim.json.encode(files)
  if key == sent_problems and not force then return end
  sent_problems = key
  notify({ event = "problems", files = files })
end

-- Rust: ⏎ / a click on a problem: its file at the line and column, the keyboard in the code
---@param path string
---@param lnum integer
---@param col integer
function M.open_problem(path, lnum, col)
  require("config.focus").editor()
  if vim.api.nvim_buf_get_name(0) ~= path then vim.cmd.edit(vim.fn.fnameescape(path)) end
  local line = vim.api.nvim_buf_get_lines(0, lnum - 1, lnum, false)[1]
  if line then pcall(vim.api.nvim_win_set_cursor, 0, { lnum, math.min(col - 1, math.max(#line - 1, 0)) }) end
end

---@param tab string problems | sessions | boxes | pipelines
---@param enter? boolean take the keyboard (default true)
local function open(tab, enter)
  S.tab = tab
  if not M.is_open() then
    bottom.claim("pane")
    -- full width, under the tree too
    S.win = vim.api.nvim_open_win(host_buf(), false, { split = "below", win = -1, height = bottom.height() })
    win_opts(S.win)
    require("config.app.layout").sync()
  end
  if tab == "problems" then send_problems(true) end
  notify({ event = "open", tab = tab, enter = enter ~= false })
  if enter == false then return end
  vim.cmd.stopinsert()
  vim.api.nvim_set_current_win(S.win)
  require("config.app").expect(NATIVE) -- (also when the host was current already)
end

-- Shows the pane on `tab` with the keyboard, never hiding it (a header tab, Options, the app)
---@param tab string problems | sessions | boxes | pipelines | git | terminal
function M.show(tab)
  if tab == "terminal" then
    S.last = "terminal"
    return require("config.app.terminal").show()
  end
  if tab == "git" then
    S.last = "git"
    return git().open(nil, true)
  end
  if not TABS[tab] then return end
  S.last = tab
  open(tab)
end

-- The last bottom tool window shown (Cmd+J's)
function M.last() return S.last end

local PANEL = { terminal = true, git = true, problems = true }

-- Cmd+3 (Git) / Cmd+T (the Terminal) / Cmd+J (nil: its last one), the app's (app/src/shell/panel.rs): Code's
-- bottom panel on `tab` with the keyboard, never hiding it. Outside a git repository Git is passed over (Problems
-- instead)
---@param tab? string terminal | git | problems
function M.panel(tab)
  if not PANEL[tab] then tab = PANEL[S.last] and S.last or "terminal" end
  if tab == "git" and not require("git.cli").find_root() then tab = "problems" end
  M.show(tab)
end

-- Cmd+J (the app): the panel's shown tool window hidden (the keyboard back to the code when it had it)
function M.hide_panel()
  if require("config.app.terminal").is_open() then
    S.last = "terminal"
    return require("config.app.terminal").hide()
  end
  if git().is_open() then
    S.last = "git"
    return git().hide()
  end
  if M.is_open() then
    S.last = "problems"
    return M.hide()
  end
end

-- The app's memory of the workspace's panel (first shown after a launch): shown on `tab` without the keyboard
-- at `share` of the rows, or (no tab) hidden
---@param tab? string terminal | git | problems
---@param share? number
function M.restore_panel(tab, share)
  if type(share) == "number" then bottom.restore({ share = share }) end
  if not PANEL[tab] then
    require("config.app.terminal").hide()
    git().hide()
    return M.hide()
  end
  S.last = tab
  if tab == "terminal" then return require("config.app.terminal").open_quietly() end
  if tab == "git" then return git().open(nil, false) end
  open(tab, false)
end

-- Another bottom tool window shown by its own module (the Terminal's): Cmd+J's last one
---@param tab string
function M.note_last(tab) S.last = tab end

-- Cmd+3: the bottom pane on the last tool window shown, with the keyboard; again (it has the keyboard) hides it.
-- `no_git` (the app: a role hides Git): nothing while Git was the last one
---@param no_git? boolean
function M.toggle_last(no_git)
  if S.last == "terminal" then return require("config.app.terminal").toggle() end
  if S.last == "git" then
    if no_git then return end
    if git().is_focused() then return git().hide() end
    return M.show("git")
  end
  if M.is_focused() then return M.hide() end
  M.show(S.last)
end

-- Cmd+5 / Cmd+6 / Cmd+7 / Cmd+3: the pane on `tab` with the keyboard; again (that tab has the keyboard) hides it
---@param tab string
function M.toggle(tab)
  if tab == "git" then
    if git().is_focused() then return git().hide() end
    return M.show("git")
  end
  if M.is_focused() and S.tab == tab then return M.hide() end
  M.show(tab)
end

---@param keep_focus? boolean another bottom tool window is taking over
function M.hide(keep_focus)
  if not M.is_open() then return end
  bottom.save_height(S.win)
  local win = S.win
  S.win = nil
  notify({ event = "hide" })
  if not keep_focus and vim.api.nvim_get_current_win() == win then require("config.focus").editor() end
  pcall(vim.api.nvim_win_close, win, true)
end

-- Rust: a click into it (it took the keyboard): the host becomes the current window
function M.enter()
  if M.is_open() and not current() then
    vim.cmd.stopinsert()
    vim.api.nvim_set_current_win(S.win)
  end
end

-- Rust: Esc in a pane tab: the keys back to the last split, the pane stays
function M.leave()
  if current() then require("config.focus").editor() end
end

function M.setup()
  bottom.register("pane", M.hide, M.is_open, function() M.show(S.tab) end, M.win)
  require("config.focus").register("pane", {
    is_focused = M.is_focused,
    owns = function(win) return valid(S.win) and win == S.win end,
    close = function() M.hide() end,
  })
  require("config.app.layout").role_provider("pane", function(win)
    return valid(S.win) and win == S.win and "pane" or nil
  end)
  local group = vim.api.nvim_create_augroup("ws_app_pane", { clear = true })
  -- the Problems tab follows the diagnostics while it shows (coalesced)
  local timer = assert(vim.uv.new_timer())
  vim.api.nvim_create_autocmd({ "DiagnosticChanged", "BufFilePost" }, {
    group = group,
    callback = function()
      if not (M.is_open() and S.tab == "problems") then return end
      timer:start(150, 0, vim.schedule_wrap(function()
        if M.is_open() and S.tab == "problems" then send_problems() end
      end))
    end,
  })
  -- the host takes / gives back the keyboard with nvim's current window
  vim.api.nvim_create_autocmd("WinEnter", {
    group = group,
    callback = function()
      if current() then
        notify({ event = "focus" })
        require("config.app").expect(NATIVE)
      end
    end,
  })
  vim.api.nvim_create_autocmd("WinLeave", {
    group = group,
    callback = function()
      if current() then
        notify({ event = "blur" })
        require("config.app").expect(nil)
      end
    end,
  })
  vim.api.nvim_create_autocmd("WinClosed", {
    group = group,
    callback = function(ev)
      if S.win and tonumber(ev.match) == S.win then
        S.win = nil
        notify({ event = "hide" })
      end
    end,
  })
end

return M
