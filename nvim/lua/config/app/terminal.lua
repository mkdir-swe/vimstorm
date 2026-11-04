-- The Terminal tool window's Lua side (Rust: app/src/terminal "TerminalView"; 3.0 #20 / #17): ONE placeholder
-- window in the bottom tool window (config/bottom.lua: shares the bottom with the pane and Git, one height, the
-- session) showing an empty scratch buffer (b:ws_tool, filetype wsterminal). config/app/layout.lua reports it with
-- role = "terminal" (role_provider below) and the native TerminalView is drawn over its island. Rust owns the
-- shells (PTYs), tabs, drawing, selection, find, scrollback. While the host is nvim's current window the view has
-- the keyboard (focus.target() == "terminal"). Shells only: the Chat column is the AI chat.
--
-- Lua -> Rust (`vimstorm.terminal`): open {enter, show, root, cwd, env, tabs, cur} / new {cwd} / hide / focus /
-- blur / close / cycle {dir} / find / send / lazygit {cmd, cwd, env}.
-- Rust -> Lua: tabs(pids, cur, has_tabs), enter() (a click into the view), hide() (the last tab went, the
-- header's Hide, menu Hide), float(open) (the lazygit float is up), show() (open and focus, never hide),
-- toggle(), activate().
local bottom = require("config.bottom")
local bridge = require("config.app.bridge")

local M = {}

local S = {
  win = nil, ---@type integer?
  buf = nil, ---@type integer?
  pids = {}, ---@type integer[] the tabs' shell pids, in tab order (Rust reports them)
  has_tabs = false, -- the view has a tab (Rust reports them)
  cur = 1,
  float = false, -- the lazygit float is up
}

-- macOS: a process's cwd straight from the kernel (proc_pidinfo PROC_PIDVNODEPATHINFO), ~0.05 ms
-- instead of ~35 ms per `lsof` run. struct proc_vnodepathinfo = 2 x (vnode_info 152 + path 1024);
-- the size check makes a layout mismatch return nil (then lsof) instead of garbage.
local pidinfo ---@type (fun(pid: integer): string?)|false|nil
local function kernel_cwd(pid)
  if pidinfo == nil then
    pidinfo = false
    local ok, ffi = pcall(require, "ffi")
    if ok and vim.fn.has("mac") == 1 then
      pcall(ffi.cdef, "int proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int buffersize);")
      local size, buf = 2352, ffi.new("char[?]", 2352)
      pidinfo = function(p)
        local okc, n = pcall(ffi.C.proc_pidinfo, p, 9, 0, buf, size)
        if okc and n == size then return ffi.string(buf + 152) end
      end
    end
  end
  if pidinfo then return pidinfo(pid) end
  return vim.uv.fs_readlink("/proc/" .. pid .. "/cwd") or nil -- Linux
end

-- Folders the tabs' shells are in now (for reopening them there next time): pid -> cwd.
-- What the kernel can't answer goes to one `lsof` for all of them.
---@param pids integer[]
---@return table<integer, string>
function M.shell_cwds(pids)
  local out, rest = {}, {}
  for _, pid in ipairs(pids) do
    local cwd = kernel_cwd(pid)
    if cwd and cwd ~= "" then out[pid] = cwd else rest[#rest + 1] = tostring(pid) end
  end
  if #rest > 0 then
    local ok, res = pcall(function()
      return vim.system({ "lsof", "-a", "-p", table.concat(rest, ","), "-d", "cwd", "-Fpn" }, { text = true }):wait(2000).stdout
    end)
    local pid ---@type integer?
    for line in ((ok and res) or ""):gmatch("[^\n]+") do
      if line:sub(1, 1) == "p" then pid = tonumber(line:sub(2)) end
      if line:sub(1, 1) == "n" and pid then out[pid] = line:sub(2) end
    end
  end
  return out
end

local function notify(payload) return bridge.notify("terminal", payload) end

-- What the shells need from nvim: the user's own XDG_CONFIG_HOME (config/app.lua restored it; unset ->
-- the shells don't get the app's), and NVIM like :terminal jobs (lazygit's nvim-remote edits here)
local function env()
  local e = { NVIM = vim.v.servername }
  if vim.env.XDG_CONFIG_HOME and vim.env.XDG_CONFIG_HOME ~= "" then e.XDG_CONFIG_HOME = vim.env.XDG_CONFIG_HOME end
  return e
end

local function valid(win) return win ~= nil and vim.api.nvim_win_is_valid(win) end

-- The host window is open (the Terminal shows in the bottom pane)
function M.is_open() return valid(S.win) end

-- The host is nvim's current window
local function current() return valid(S.win) and vim.api.nvim_get_current_win() == S.win end

-- The terminal has the keyboard: its host is current and no other native surface (the tree, a picker, the
-- Chat column) took the keyboard meanwhile (nvim's current window stays the host then)
function M.is_focused()
  if not current() then return false end
  local native = require("config.app").native()
  return native == nil or native == "terminal"
end

-- The host window (tests, layout.lua)
function M.win() return valid(S.win) and S.win or nil end

local function host_buf()
  if S.buf and vim.api.nvim_buf_is_valid(S.buf) then return S.buf end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.b[buf].ws_tool = true -- a tool window's own buffer (focus.lua's guard, layout.lua's kind)
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].filetype = "wsterminal"
  vim.bo[buf].modifiable = false
  S.buf = buf
  return buf
end

local function win_opts(win)
  local wo = vim.wo[win]
  wo.number, wo.relativenumber, wo.signcolumn, wo.foldcolumn, wo.statuscolumn = false, false, "no", "0", ""
  wo.wrap, wo.cursorline, wo.list, wo.spell, wo.winfixheight = false, false, false, false, true
  wo.winbar = "" -- the TerminalView draws the header
  wo.fillchars = "eob: "
end

---@param enter? boolean focus it (default true)
---@param cwd? string the first tab's folder (when there's no tab yet; default: the project)
local function open(enter, cwd)
  if not M.is_open() then
    bottom.claim("terminal")
    -- full width, under the tree too
    S.win = vim.api.nvim_open_win(host_buf(), false, { split = "below", win = -1, height = bottom.height() })
    win_opts(S.win)
    require("config.app.layout").sync()
  end
  notify({ event = "open", enter = enter ~= false, root = vim.fn.getcwd(), cwd = cwd, env = env() })
  if enter ~= false then
    vim.cmd.stopinsert()
    vim.api.nvim_set_current_win(S.win)
    require("config.app").expect("terminal") -- (also when the host was current already)
  end
end

-- Hidden (the header's Hide, menu Hide, the last tab gone, another bottom tool window opening); the shells
-- keep running
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

-- The stripe's Terminal, ⌃` (Feel vscode): open with the keyboard; again while it has the keyboard hides it
function M.toggle()
  if M.is_focused() then return M.hide() end
  -- Cmd+J's last bottom tool window (opened from the stripe or Ctrl+`; ⌘T is its own key)
  require("config.app.pane").note_last("terminal")
  open(true)
end

-- Cmd+Shift+T / Open in Terminal: a new tab (opens the tool window if needed)
---@param cwd? string
function M.new(cwd)
  cwd = type(cwd) == "string" and cwd or nil
  -- (opening makes the first tab, there)
  if not S.has_tabs then return open(true, cwd) end
  if not M.is_focused() then open(true) end
  notify({ event = "new", cwd = cwd })
end

-- Close Tab (menu, focus.close): the current tab
function M.close() notify({ event = "close" }) end

-- Alt+Cmd+Left/Right inside the terminal (keys nvim got first; the view handles its own)
function M.cycle(dir)
  if not M.is_focused() then return end
  notify({ event = "cycle", dir = dir or 1 })
end

-- Focus the terminal when it has tabs or a session just restored them (no toggling)
function M.focus()
  if S.has_tabs or S.restored then open(true) end
end

-- Open and focus it, never hiding
function M.show() open(true) end

-- Shown without the keyboard
function M.open_quietly() open(false) end

-- Cmd+F from Lua (the view maps it itself); query: typed into the field (scripts, screenshots)
---@param query? string
function M.find(query)
  if S.has_tabs then notify({ event = "find", query = type(query) == "string" and query or nil }) end
end

-- Text into the shown tab's shell (scripts, screenshots)
---@param text string
function M.send(text) notify({ event = "send", text = text }) end

-- Rust: a click into the view (it took the keyboard): the host becomes the current window
function M.enter()
  if M.is_open() and not current() then
    vim.cmd.stopinsert()
    vim.api.nvim_set_current_win(S.win)
  end
end

-- Session: open tabs (their folders) and the current one
function M.layout()
  if #S.pids == 0 then return end
  local found = M.shell_cwds(vim.tbl_filter(function(p) return p > 0 end, S.pids))
  local cwds = {}
  for i, pid in ipairs(S.pids) do cwds[i] = found[pid] or vim.fn.getcwd() end
  return { tabs = cwds, cur = S.cur }
end

---@param l {tabs: string[], cur: integer}
function M.restore(l)
  if #S.pids > 0 or type(l) ~= "table" or #(l.tabs or {}) == 0 then return end
  local tabs = {}
  for i, cwd in ipairs(l.tabs) do tabs[i] = vim.uv.fs_stat(cwd) and cwd or vim.fn.getcwd() end
  S.restored = true -- (Rust reports the tabs a moment later)
  -- the shells start; the Terminal stays hidden until asked for (⌘T, the stripe, a session that had the keys)
  notify({ event = "open", enter = false, show = false, root = vim.fn.getcwd(), env = env(), tabs = tabs, cur = l.cur or 1 })
end

-- Shells busy with something besides their prompt (the toolbar's project switch warns about them)
function M.busy()
  local n = 0
  for _, pid in ipairs(S.pids) do
    local ok, kids = pcall(vim.api.nvim_get_proc_children, pid)
    if ok and #kids > 0 then n = n + 1 end
  end
  return n
end

-- Rust: the shells' pids, the current tab, and whether the view has a tab.
---@param pids integer[]
---@param cur integer
---@param has_tabs? boolean
function M.tabs(pids, cur, has_tabs)
  S.pids = type(pids) == "table" and pids or {}
  S.cur = tonumber(cur) or 1
  S.has_tabs = has_tabs == true or (has_tabs == nil and #S.pids > 0)
  if S.has_tabs then S.restored = false end -- (the restored tabs arrived)
end


-- lazygit's nvim-remote edit (`e`, snacks' editPreset) runs `nvim --server $NVIM --remote-send q`, then
-- `--remote-tab <file>`: in Lua's float the `q` was typed into the terminal job (lazygit quit); here nvim is in
-- Normal mode behind the native float, where `q` would start a macro (and the next key would be eaten as its
-- register). While the float is up, Normal-mode `q` goes to the float's program instead.
local saved_q ---@type table?

local function float_q(on)
  if on then
    local m = vim.fn.maparg("q", "n", false, true)
    saved_q = (type(m) == "table" and next(m)) and m or nil
    vim.keymap.set("n", "q", function() notify({ event = "float_send", text = "q" }) end,
      { nowait = true, desc = "q to lazygit (its nvim-remote edit)" })
  else
    pcall(vim.keymap.del, "n", "q")
    if saved_q then pcall(vim.fn.mapset, "n", false, saved_q) end
    saved_q = nil
  end
end

-- Rust: the lazygit float is up / gone
function M.float(open_)
  local was = S.float
  S.float = open_ == true
  if S.float ~= was then float_q(S.float) end
  pcall(function() require("config.focuscue").update() end)
end

-- The lazygit float has the keyboard (focus.target() says "popup", like snacks' float)
function M.float_focused() return S.float end

-- ,G: lazygit in the native float, configured by snacks (theme file, LG_CONFIG_FILE, nvim-remote edits):
-- Snacks.lazygit builds the command, which goes to the app instead of Snacks.terminal
function M.lazygit()
  local captured
  local term = rawget(Snacks, "terminal")
  rawset(Snacks, "terminal", function(cmd, opts) captured = { cmd = cmd, opts = opts or {} } end)
  -- snacks sets lazygit's color 241 with an OSC 4 written to nvim's stdout: the app's RPC channel
  -- here. Kept for the float's terminal instead.
  local osc, write = {}, io.write
  io.write = function(...) ---@diagnostic disable-line: duplicate-set-field
    for _, a in ipairs({ ... }) do osc[#osc + 1] = tostring(a) end
  end
  local ok, err = pcall(Snacks.lazygit)
  io.write = write
  rawset(Snacks, "terminal", term)
  if not ok then return vim.notify(tostring(err), vim.log.levels.ERROR, { title = "lazygit" }) end
  if not captured then return end
  local cmd = type(captured.cmd) == "table" and captured.cmd or { tostring(captured.cmd) }
  local e = env()
  e.LG_CONFIG_FILE = vim.env.LG_CONFIG_FILE
  for k, v in pairs(captured.opts.env or {}) do e[k] = tostring(v) end
  notify({ event = "lazygit", cmd = cmd, cwd = captured.opts.cwd or vim.fn.getcwd(), env = e, osc = table.concat(osc) })
end

function M.setup()
  bottom.register("terminal", M.hide, M.is_open, M.show, M.win)
  require("config.focus").register("terminal", {
    is_focused = M.is_focused,
    owns = function(win) return valid(S.win) and win == S.win end,
    close = M.close,
    cycle = M.cycle,
  })
  require("config.app.layout").role_provider("terminal", function(win)
    return valid(S.win) and win == S.win and "terminal" or nil
  end)
  local group = vim.api.nvim_create_augroup("ws_app_terminal", { clear = true })
  -- the TerminalView takes / gives back the keyboard with nvim's current window
  vim.api.nvim_create_autocmd("WinEnter", {
    group = group,
    callback = function()
      if current() then
        notify({ event = "focus" })
        require("config.app").expect("terminal") -- keys already typed act on it (config/app.lua `asked`)
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
end

return M
