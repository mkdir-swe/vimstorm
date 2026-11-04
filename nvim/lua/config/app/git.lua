-- The Git tool window host (Rust side: app/src/git/window, "GitView"; git/init.lua is the facade the keys and
-- menus call): the tool window is ONE placeholder window in the bottom tool window (config/bottom.lua: shares
-- the bottom with the terminal, same height rules, session, Cmd+3, Alt+Cmd+Left/Right, ,w / ,q)
-- showing an empty scratch buffer (b:ws_tool, filetype wsgit). The app doesn't draw that window's grid:
-- config/app/layout.lua reports it with role = "git" and the native GitView is drawn over its island.
-- While it is nvim's current window the GitView has the keyboard (focus.target() == "git").
--
-- Lua -> Rust (`vimstorm.git`): open {tab, enter, root} / hide / focus (the host became the current window) /
-- blur (it stopped being it) / cycle_tab {dir} / changed (the repo changed: git.cli.changed()) and commands
-- for the tabs: file_history {path} / show_commit {hash} / commit / push.
-- Rust -> Lua: tab_changed(tab) (the strip / Alt+Cmd+Left/Right picked a tab: saved per project),
-- enter() (a click into the GitView: the host becomes the current window), leave() (Esc: back to the split).
local bottom = require("config.bottom")
local bridge = require("config.app.bridge")

local M = {}

local TABS = { "changes", "log" } -- the strip's order (no Stash tab; a saved "stash" or the retired "pr_changes" falls back to the default); PR review is the Log filtered to the PR

local S = {
  win = nil, ---@type integer?
  buf = nil, ---@type integer?
  tab = nil, ---@type string?
  log = nil, ---@type table? the Log tab's session state (filters, details_width), kept by Rust (log_state)
}

local function valid(win) return win ~= nil and vim.api.nvim_win_is_valid(win) end

-- Last used tab per project, kept across restarts (the M3 Lua tool window's file and format)
local tab_file = vim.fn.stdpath("state") .. "/git-panel-tabs.json"
local function saved_tabs()
  local ok, data = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(tab_file), "")) end)
  return ok and type(data) == "table" and data or {}
end
local function save_tab(root, tab)
  local data = saved_tabs()
  data[root] = tab
  pcall(vim.fn.writefile, { vim.json.encode(data) }, tab_file)
end

-- Last used tab, but Log when there's nothing in Local Changes (WebStorm's rule; the status already read
-- for the tabs / status bar when there is one, so opening doesn't wait for git)
local function default_tab(root)
  local tab = saved_tabs()[root] or "changes"
  if not vim.tbl_contains(TABS, tab) then tab = "changes" end
  if tab == "changes" then
    local status = require("git.status")
    local st = status.last() or status.load_sync()
    if not (st and #st.entries > 0) then tab = "log" end
  end
  return tab
end

local function root()
  return require("git.cli").find_root()
end

function M.is_open() return valid(S.win) end

-- Git has the keyboard: its host is current and no other native surface (the Chat column,
-- the tree, a picker) took the keyboard meanwhile (nvim's current window stays the host then)
local function current() return valid(S.win) and vim.api.nvim_get_current_win() == S.win end

function M.is_focused()
  if not current() then return false end
  local native = require("config.app").native()
  return native == nil or native == "git" or native == "git_log" or native == "git_changes"
end

-- The host window (tests, layout.lua)
function M.win() return valid(S.win) and S.win or nil end

function M.tab() return S.tab end

local function host_buf()
  if S.buf and vim.api.nvim_buf_is_valid(S.buf) then return S.buf end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.b[buf].ws_tool = true -- a tool window's own buffer (focus.lua's guard, layout.lua's kind)
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].filetype = "wsgit"
  vim.bo[buf].modifiable = false
  S.buf = buf
  return buf
end

local function win_opts(win)
  local wo = vim.wo[win]
  wo.number, wo.relativenumber, wo.signcolumn, wo.foldcolumn, wo.statuscolumn = false, false, "no", "0", ""
  wo.wrap, wo.cursorline, wo.list, wo.spell, wo.winfixheight = false, false, false, false, true
  wo.winbar = "" -- the GitView draws the header
  wo.fillchars = "eob: "
end

local function notify(payload) return bridge.notify("git", payload) end

---@param tab? string "changes" | "log"
---@param enter? boolean focus it (default true)
function M.open(tab, enter)
  local r = root()
  if not r then return vim.notify("Not a git repository", vim.log.levels.WARN, { title = "Git" }) end
  if tab and not vim.tbl_contains(TABS, tab) then tab = nil end
  if not tab and not M.is_open() then tab = default_tab(r) end
  S.tab = tab or S.tab or default_tab(r)
  save_tab(r, S.tab)
  if not M.is_open() then
    bottom.claim("git")
    -- full width, under the tree too
    S.win = vim.api.nvim_open_win(host_buf(), false, { split = "below", win = -1, height = bottom.height() })
    win_opts(S.win)
    require("config.app.layout").sync()
  end
  notify({ event = "open", tab = S.tab, enter = enter ~= false, root = r, log = S.log })
  if enter ~= false then
    vim.api.nvim_set_current_win(S.win)
    require("config.app").expect("git") -- (also when the host was current already)
  end
end

---@param keep_focus? boolean another bottom tool window is taking over
function M.hide(keep_focus)
  if not M.is_open() then return end
  bottom.save_height(S.win)
  local win = S.win
  S.win = nil
  notify({ event = "hide" })
  -- back to the editor first: closing the current window would pick any window
  if not keep_focus and vim.api.nvim_get_current_win() == win then require("config.focus").editor() end
  pcall(vim.api.nvim_win_close, win, true)
end

-- Cmd+3: open / focus, hide when focused
function M.toggle()
  if M.is_focused() then return M.hide() end
  if M.is_open() then
    if not current() then return vim.api.nvim_set_current_win(S.win) end
    -- current already, another native surface (the Chat column) has the keyboard: back to Git
    notify({ event = "focus" })
    return require("config.app").expect("git")
  end
  M.open()
end

-- Alt+Cmd+Left/Right while focused (the GitView handles them itself; this is for keys nvim got first)
---@param dir integer
function M.cycle_tab(dir)
  notify({ event = "cycle_tab", dir = dir or 1 })
end

-- Rust: the strip / Alt+Cmd+Left/Right picked a tab
---@param tab string
function M.tab_changed(tab)
  if not vim.tbl_contains(TABS, tab) then return end
  S.tab = tab
  local r = require("git.cli").root or root()
  if r then save_tab(r, tab) end
end

-- Rust: a click into the GitView (it took the keyboard): the host becomes the current window
function M.enter()
  if M.is_open() and vim.api.nvim_get_current_win() ~= S.win then
    vim.cmd.stopinsert()
    vim.api.nvim_set_current_win(S.win)
  end
end

-- Rust: Esc in the GitView: back to the last split (or the viewer)
function M.leave()
  if M.is_focused() then require("config.focus").editor() end
end

-- Log filtered to one file (,H); a diff viewer / merge side stands for its file
---@param path string
function M.file_history(path)
  path = path:gsub("^gitdiff://[^/]*/", ""):gsub("^gitmerge://%a+/", "")
  local r = root()
  if not r then return end
  local rel = path ~= "" and (path:sub(1, 1) == "/" and vim.fs.relpath(r, path) or path) or nil
  if not rel or rel == "." or path:match("^%a+://") then
    return vim.notify("No file to show history for", vim.log.levels.INFO, { title = "Git" })
  end
  M.open("log")
  notify({ event = "file_history", path = rel })
end

-- The log with a commit selected (from blame)
---@param hash string
function M.show_commit(hash)
  if not root() then return end
  M.open("log")
  notify({ event = "show_commit", hash = hash })
end

-- The log filtered to a revision range (the Branches… popup's Compare with Current: `main..feat`)
---@param rev string
function M.show_range(rev)
  if not root() then return end
  M.open("log")
  notify({ event = "show_range", rev = rev })
end

-- Cmd+K from anywhere: Local Changes' commit message
function M.commit()
  if not root() then return vim.notify("Not a git repository", vim.log.levels.WARN, { title = "Git" }) end
  M.open("changes")
  notify({ event = "commit" })
end

-- Cmd+Alt+K uses the native Commit and Push continuation; failures never push.
function M.commit_push()
  if not root() then return vim.notify("Not a git repository", vim.log.levels.WARN, { title = "Git" }) end
  M.open("changes")
  notify({ event = "commit_push" })
end

-- Create a draft PR from the current branch without changing the active Git tab.
function M.create_draft_pr()
  if not root() then return vim.notify("Not a git repository", vim.log.levels.WARN, { title = "Git" }) end
  notify({ event = "create_draft_pr" })
end

-- Cmd+Shift+K from anywhere
function M.push()
  if not root() then return vim.notify("Not a git repository", vim.log.levels.WARN, { title = "Git" }) end
  notify({ event = "push" })
end

-- Rust: the Log tab's filters / details width changed (kept for the session; given back in `open`)
---@param state table {filters, details_width}
function M.log_state(state)
  S.log = state
end

-- The Log's filters as the session keeps them (tests; outside a history for a selection)
function M.log_filters()
  return S.log and S.log.filters or nil
end

-- The Log's recent text filters as the session keeps them (tests)
function M.log_text_history()
  return S.log and S.log.text_history or {}
end

-- Show History for Selection (git/init.lua computed the lines at HEAD): the Log lists the commits that
-- touched them; closing it goes back to the tab shown before (nil: hidden again)
---@param lines {path: string, from: integer, to: integer, label: string}
function M.selection_history(lines)
  local before = M.is_open() and S.tab or nil
  M.open("log")
  notify({ event = "selection_history", path = lines.path, from = lines.from, to = lines.to,
    label = lines.label, tab = before })
end

-- Session: the open tab, the height and the Log's state (restore takes the Log's state back)
function M.layout()
  if not M.is_open() then return end
  return { tab = S.tab, height = vim.api.nvim_win_get_height(S.win), log = S.log }
end

---@param l {tab?: string, log?: table}
function M.restore(l)
  if type(l) == "table" and type(l.log) == "table" then S.log = l.log end
  -- sessions of the M2 app (the Lua Git window): its filters / details width at the top level
  if type(l) == "table" and not l.log and (type(l.filters) == "table" or l.details_width) then
    S.log = { filters = type(l.filters) == "table" and l.filters or nil, details_width = l.details_width }
  end
  -- shown or not is the app's (each workspace's bottom panel, kept with its page); an open picks the tab used last
  -- (git-panel-tabs.json)
end

function M.setup()
  bottom.register("git", M.hide, M.is_open, function() M.open() end, M.win)
  require("config.focus").register("git", {
    is_focused = M.is_focused,
    owns = function(win) return valid(S.win) and win == S.win end,
    close = function() M.hide() end,
    cycle = M.cycle_tab,
  })
  local group = vim.api.nvim_create_augroup("ws_app_git", { clear = true })
  -- the GitView takes / gives back the keyboard with nvim's current window
  vim.api.nvim_create_autocmd("WinEnter", {
    group = group,
    callback = function()
      if current() then
        notify({ event = "focus" })
        require("config.app").expect("git") -- keys already typed act on it (config/app.lua `asked`)
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
      -- closed some other way (:only, :close): hidden
      if S.win and tonumber(ev.match) == S.win then
        S.win = nil
        notify({ event = "hide" })
      end
    end,
  })
  -- a commit, checkout, push, ... (git.cli.changed()): the tabs reload
  require("git.cli").on_change(function() notify({ event = "changed" }) end)
end

return M
