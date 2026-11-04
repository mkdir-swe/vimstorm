-- Headless engine-test harness. Starts this checkout's config (nvim/) the way the VimStorm app does
-- (`nvim --embed`, vim.g.vimstorm_app = 1, NVIM_APPNAME=vimstorm, own XDG dirs) and attaches as its UI over
-- stdio with the app's options, so:
--   - the config sees a UI (session restore, bridge channel) and sends every `vimstorm.<surface>` notification
--     here: H.bridge / H.last / H.wait_bridge read them (what Rust would draw);
--   - keys go in as the app sends them: nvim notation through nvim_input (`<D-w>`, `<C-S-1>`, `<D-CR>`);
--   - Rust's calls into Lua are H.call("config.app.menu", "choose", id, i) (bridge::call);
--   - state is read over RPC (a --listen socket): H.lua, H.cursor, H.lines...
-- Nothing reads the screen: what the user sees is the cargo suite's job (app/tests). Used by tests/*_test.lua
-- via tests/run.sh (each test file gets its own copy of the fixtures).
local H = {}
local uv = vim.uv

local fixtures = assert(os.getenv("NVT_FIXTURES"), "run via tests/run.sh")
local repo = vim.fn.fnamemodify(os.getenv("NVT_HARNESS"), ":p:h:h")
local results = {}
local rpc ---@type integer? request channel (the --listen socket)
local session ---@type { label: string, allow: string[] }?
local started = {} ---@type table<string, integer> sessions per dir, so restart labels stay unique

H.fixtures = fixtures

-- Environment ---------------------------------------------------------------------------------------------
-- Own state / cache per test file (sessions, shada, swap, undo), the app's NVIM_APPNAME / config link
-- (config/vimstorm -> this checkout's nvim/), data = links to the app's warmed plugins, Mason tools and parsers
-- (~/.local/share/vimstorm) minus snacks/ (picker history / frecency stay out of the real one).
-- state: another state dir (a nvim that must not share the test file's sessions)
local data_home = fixtures .. "/data"
local config_home = fixtures .. "/config"
function H.env(state)
  if not uv.fs_stat(data_home) then
    local real = vim.env.HOME .. "/.local/share/vimstorm"
    assert(uv.fs_stat(real .. "/lazy/lazy.nvim"), real .. " has no plugins: run app/scripts/warmup.sh once")
    vim.fn.mkdir(data_home .. "/vimstorm", "p")
    for name in vim.fs.dir(real) do
      if name ~= "snacks" then uv.fs_symlink(real .. "/" .. name, data_home .. "/vimstorm/" .. name) end
    end
  end
  if not uv.fs_stat(config_home) then
    vim.fn.mkdir(config_home, "p")
    uv.fs_symlink(repo .. "/nvim", config_home .. "/vimstorm")
  end
  local env = {
    NVIM_APPNAME = "vimstorm",
    XDG_CONFIG_HOME = config_home,
    XDG_STATE_HOME = state or fixtures .. "/state",
    XDG_CACHE_HOME = fixtures .. "/cache",
    XDG_DATA_HOME = data_home,
    -- the personal Layer (its nvim/ loads over VimStorm's config: config/userconfig.lua): this file's own
    ABE_CONFIG_DIR = fixtures .. "/abe-config",
  }
  -- the user's own config home (git ignore, Copilot login): config/app.lua restores it, like in the app
  if vim.env.XDG_CONFIG_HOME and vim.env.XDG_CONFIG_HOME ~= "" then
    env.VIMSTORM_USER_XDG_CONFIG_HOME = vim.env.XDG_CONFIG_HOME
  end
  return env
end

-- Keys -----------------------------------------------------------------------------------------------------
-- nvim notation as app/src/editor/input/keys.rs builds it (modifiers in the order C-M-D-S). H.gkey turns a trigger
-- name ("super+shift+t", "ctrl+digit_3", "super+ctrl+arrow_left") into it.
local KEY_NAMES = {
  enter = "CR", tab = "Tab", escape = "Esc", space = "Space", backspace = "BS", delete = "Del",
  arrow_left = "Left", arrow_right = "Right", arrow_up = "Up", arrow_down = "Down",
  home = "Home", ["end"] = "End", page_up = "PageUp", page_down = "PageDown",
}
function H.gkey(trigger)
  local parts = vim.split(trigger, "+", { plain = true })
  local key = table.remove(parts)
  if key == "" then key = "+" end -- "super+shift++"
  local mods = {}
  for _, p in ipairs(parts) do mods[p] = true end
  key = KEY_NAMES[key] or key:match("^digit_(%d)$") or (key:match("^f%d+$") and ("F" .. key:sub(2))) or key
  if key == "<" then key = "lt" end
  local prefix = (mods.ctrl and "C-" or "") .. (mods.alt and "M-" or "") .. (mods.super and "D-" or "")
    .. (mods.shift and "S-" or "")
  if prefix == "" and #key == 1 then return key end
  return "<" .. prefix .. key .. ">"
end

H.KEY = {
  -- tool windows / splits
  cmd1 = "<D-1>", cmd2 = "<D-2>", cmd3 = "<D-3>", cmdT = "<D-t>", cmdShiftT = "<D-S-t>",
  ctrl_cmd_left = "<C-D-Left>", ctrl_cmd_right = "<C-D-Right>",
  ctrl_tab = "<C-Tab>", ctrl_shift_tab = "<C-S-Tab>",
  -- editing
  cmdC = "<D-c>", cmdX = "<D-x>", cmdZ = "<D-z>", cmdShiftZ = "<D-S-z>", cmdA = "<D-a>", cmdS = "<D-s>",
  cmdW = "<D-w>", cmdShiftW = "<D-S-w>", cmdD = "<D-d>", cmdSlash = "<D-/>", cmdV = "<D-v>",
  ctrlShiftL = "<C-S-l>", ctrlOe = "<C-ö>", ctrlShiftOe = "<C-S-ö>",
  cmdMinus = "<D-->", cmdShiftMinus = "<D-S-->", cmdEq = "<D-=>", cmdShiftEq = "<D-S-=>",
  cmdAltZ = "<M-D-z>",
  -- search / code
  cmdO = "<D-o>", cmdShiftO = "<D-S-o>", cmdCtrlShiftO = "<C-D-S-o>",
  cmdF = "<D-f>", cmdShiftF = "<D-S-f>", cmdG = "<D-g>", cmdShiftG = "<D-S-g>",
  cmdB = "<D-b>", alt_enter = "<M-CR>", cmd_enter = "<D-CR>", cmdAltL = "<M-D-l>",
  -- git / diff
  cmdK = "<D-k>", cmdShiftK = "<D-S-k>", cmdR = "<D-r>", cmdL = "<D-l>", cmdOe = "<D-ö>",
  -- plain keys
  up = "<Up>", down = "<Down>", right = "<Right>", left = "<Left>",
  shift_up = "<S-Up>", shift_down = "<S-Down>", shift_enter = "<S-CR>", shift_space = "<S-Space>",
  enter = "<CR>", esc = "<Esc>", tab = "<Tab>", bs = "<BS>",
  f4 = "<F4>", f5 = "<F5>", shift_f6 = "<S-F6>",
  ctrl_e = "<C-e>", ctrl_y = "<C-y>", ctrl_d = "<C-d>", ctrl_u = "<C-u>", ctrl_l = "<C-l>", ctrl_v = "<C-v>",
}
-- Ctrl+N (bookmark jump) / Ctrl+Shift+N (toggle bookmark N)
function H.KEY.ctrl_digit(n) return ("<C-%d>"):format(n) end
function H.KEY.ctrl_shift_digit(n) return ("<C-S-%d>"):format(n) end

-- The app stand-in UI (stdio of `nvim --embed`) ---------------------------------------------------------------
-- Raw msgpack over libuv pipes (a jobstart rpc channel errors on the incoming `redraw` / `vimstorm.*` methods).
-- Grid contents are thrown away; kept: bridge notifications, flush times, window -> grid ids (mouse).
local proc ---@type table?

-- in-memory clipboard, so Cmd+C / X in tests never touch the macOS one
local CLIP = "lua local s = {} vim.g.clipboard = { name = 'test',"
  .. " copy = { ['+'] = function(l, t) s['+'] = { l, t } end, ['*'] = function(l, t) s['*'] = { l, t } end },"
  .. " paste = { ['+'] = function() return s['+'] or { { '' }, 'v' } end, ['*'] = function() return s['*'] or { { '' }, 'v' } end } }"

-- msgpack ext types Buffer / Window / Tabpage: their handle
local function handle(_, data) return vim.mpack.decode(data) end

local function ui_send(method, args)
  if proc and not proc.exited then proc.stdin:write(vim.mpack.encode({ 2, method, args })) end
end

local function on_message(p, msg)
  if type(msg) ~= "table" or msg[1] ~= 2 then return end
  local method, args = msg[2], msg[3]
  if method == "redraw" then
    for _, ev in ipairs(args) do
      if ev[1] == "flush" then
        p.flushes = p.flushes + 1
        p.last_flush = uv.hrtime()
      elseif ev[1] == "win_pos" or ev[1] == "win_float_pos" or ev[1] == "win_external_pos" then
        for i = 2, #ev do p.grids[ev[i][2]] = ev[i][1] end -- window -> its grid
      end
    end
  elseif type(method) == "string" and method:sub(1, 9) == "vimstorm." then
    local payload = type(args) == "table" and args[1] or {}
    p.bridge[#p.bridge + 1] = { surface = method:sub(10), payload = type(payload) == "table" and payload or {} }
  end
end

local function spawn(cwd, args, size, extra)
  local env = vim.fn.environ()
  env.NVIM, env.NVIM_LISTEN_ADDRESS, env.VIMRUNTIME, env.MYVIMRC = nil, nil, nil, nil
  for k, v in pairs(H.env()) do env[k] = v end
  for k, v in pairs(extra or {}) do env[k] = v end
  local env_list = {}
  for k, v in pairs(env) do env_list[#env_list + 1] = k .. "=" .. v end
  local p = {
    stdin = assert(uv.new_pipe(false)), stdout = assert(uv.new_pipe(false)), stderr = assert(uv.new_pipe(false)),
    bridge = {}, grids = {}, flushes = 0, last_flush = uv.hrtime(), err = {}, exited = false, keys = 0,
  }
  local argv = {
    "--embed", "--listen", os.getenv("NVT_SOCK"),
    "--cmd", "let g:vimstorm_app = 1 | set shortmess+=I", -- what the app passes (app/src/nvim/process.rs)
    "--cmd", CLIP,
    "--cmd", "autocmd User VeryLazy ++once let g:nvt_lazy = 1",
  }
  vim.list_extend(argv, args or {})
  local unpacker = vim.mpack.Unpacker({ ext = { [0] = handle, [1] = handle, [2] = handle } })
  p.handle, p.pid = uv.spawn("nvim", { args = argv, cwd = cwd, env = env_list, stdio = { p.stdin, p.stdout, p.stderr } },
    function() p.exited = true end)
  assert(p.handle, "spawning nvim failed: " .. tostring(p.pid))
  p.stdout:read_start(function(_, chunk)
    if not chunk then return end
    -- the unpacker is stateful: every byte fed exactly once, a partial message waits for the next chunk
    local pos = 1
    while pos <= #chunk do
      local ok, msg, next_pos = pcall(unpacker, chunk, pos)
      if not ok then
        p.err[#p.err + 1] = "msgpack: " .. tostring(msg)
        return
      end
      if next_pos == nil or next_pos <= pos then break end
      pos = next_pos
      if msg ~= nil then on_message(p, msg) end
    end
  end)
  p.stderr:read_start(function(_, chunk)
    if chunk then p.err[#p.err + 1] = chunk end
  end)
  proc = p
  -- the app's attach options (app/src/nvim/mod.rs attach_args); --embed sources the config only after this
  ui_send("nvim_ui_attach", { size[1], size[2], { rgb = true, ext_linegrid = true, ext_multigrid = true, ext_hlstate = true } })
end

local function stderr_tail(n) return proc and table.concat(proc.err):sub(-(n or 400)) or "" end

-- Session ----------------------------------------------------------------------------------------------------

-- Lines in :messages / error balloons that count as errors (H.stop fails the file on any)
local ERROR_SCAN = [[
  local out = {}
  for _, l in ipairs(vim.split(vim.fn.execute('messages'), '\n')) do
    if l:match('E%d+:') or l:match('Error') or l:match('stack traceback') then out[#out + 1] = l end
  end
  local ok, hist = pcall(function() return Snacks.notifier.get_history() end)
  for _, n in ipairs(ok and hist or {}) do
    if n.level == 'error' or n.level == vim.log.levels.ERROR then out[#out + 1] = 'balloon: ' .. tostring(n.msg) end
  end
  return out]]

-- Start nvim in a fixture dir (e.g. "proj", "grepo") or an absolute path, with optional file args.
-- opts.size = { cols, lines } of the UI (default 200x50). Returns once the config is up (VimEnter +
-- VeryLazy) and nvim stopped redrawing. opts.ready: extra Lua expression to wait for. opts.env: env vars over H.env().
function H.start(dir, args, opts)
  opts = opts or {}
  local sock = os.getenv("NVT_SOCK")
  os.remove(sock)
  local cwd = dir:sub(1, 1) == "/" and dir or fixtures .. "/" .. dir
  spawn(cwd, args, opts.size or { 200, 50 }, opts.env)
  local label = vim.fn.fnamemodify(cwd, ":t")
  started[label] = (started[label] or 0) + 1
  if started[label] > 1 then label = label .. " #" .. started[label] end
  session = { label = label, allow = {} }
  local p = proc
  local up = vim.wait(20000, function()
    if p.exited then return true end
    if not rpc then
      local ok, ch = pcall(vim.fn.sockconnect, "pipe", sock, { rpc = true })
      if ok and ch > 0 then rpc = ch end
    end
    return rpc ~= nil and H.lua("return vim.v.vim_did_enter == 1 and vim.g.nvt_lazy == 1") == true
  end, 20) and not p.exited
  local ready = up and (not opts.ready or H.wait_for(opts.ready, 10000))
  if not ready then H.check("nvim started in " .. session.label, false, stderr_tail()) end
  H.settle(100, 2000)
end

-- Errors in :messages matching pattern are expected in this session (the check in H.stop skips them)
function H.allow_errors(pattern) table.insert(session.allow, pattern) end

-- Error lines in :messages / error balloons so far (minus H.allow_errors patterns)
function H.errors()
  local out = {}
  for _, l in ipairs(H.lua(ERROR_SCAN) or {}) do
    local allowed = false
    for _, p in ipairs(session and session.allow or {}) do
      if l:find(p) then allowed = true end
    end
    if not allowed then out[#out + 1] = l end
  end
  return out
end

-- Quit the nested nvim with :qa! (VimLeavePre runs: session saved, swap files deleted). Checks once per
-- session that nothing reported an error.
function H.stop()
  if rpc and session then
    local errs = H.errors()
    H.check("no errors in :messages (" .. session.label .. ")", #errs == 0, table.concat(errs, " | "))
  end
  session = nil
  if rpc then pcall(vim.rpcnotify, rpc, "nvim_command", "qa!") end
  if proc then
    local p = proc
    vim.wait(3000, function() return p.exited end, 10)
    if not p.exited then p.handle:kill("sigkill") end
    vim.wait(1000, function() return p.exited end, 10)
    for _, pipe in ipairs({ p.stdin, p.stdout, p.stderr }) do
      if not pipe:is_closing() then pipe:close() end
    end
    if not p.handle:is_closing() then p.handle:close() end
  end
  if rpc then pcall(vim.fn.chanclose, rpc) end
  rpc, proc = nil, nil
end

-- Quit and start again (session restore, bookmarks across restarts)
function H.restart(dir, args, opts)
  H.stop()
  H.start(dir, args, opts)
end

-- A fresh project dir under this file's fixtures: files = { ["a.ts"] = { "line", ... } | "text" }.
-- opts.git: git init + commit everything. Returns its absolute path.
function H.project(name, files, opts)
  local dir = fixtures .. "/" .. name
  vim.fn.delete(dir, "rf")
  vim.fn.mkdir(dir, "p")
  for path, content in pairs(files or {}) do
    vim.fn.mkdir(vim.fs.dirname(dir .. "/" .. path), "p")
    vim.fn.writefile(type(content) == "table" and content or vim.split(content, "\n"), dir .. "/" .. path)
  end
  if opts and opts.git then
    vim.system({ "sh", "-c", "git init -q -b main && git -c user.name=T -c user.email=t@x add -A"
      .. " && git -c user.name=T -c user.email=t@x commit -q -m init" }, { cwd = dir }):wait()
  end
  return dir
end

-- RPC / input ------------------------------------------------------------------------------------------------

-- Run Lua in the nested nvim, return its value (nil + error on failure). args: the chunk's `...`
function H.lua(code, args)
  if not rpc then return nil, "not connected" end
  -- a hit-enter / confirm prompt would block nvim_exec_lua forever (get_mode and input still answer): fail and dismiss it
  local mok, mode = pcall(vim.rpcrequest, rpc, "nvim_get_mode")
  if mok and mode.blocking then
    H.check("no blocking prompt", false, vim.inspect(mode))
    pcall(vim.rpcrequest, rpc, "nvim_input", "<CR>")
    vim.wait(200)
  end
  local ok, res = pcall(vim.rpcrequest, rpc, "nvim_exec_lua", code, args or {})
  if not ok then return nil, res end
  if res == vim.NIL then return nil end -- the code returned nothing / nil
  return res
end

-- What Rust's bridge::call does: require(module)[fn](...) in the nested nvim, e.g.
-- H.call("config.app.menu", "choose", id, 2), H.call("config.app", "native_focus", "tree").
-- A nil argument before others: pass vim.NIL.
function H.call(module, fn, ...)
  return H.lua("local m, f = ... return require(m)[f](select(3, ...))", { module, fn, ... })
end

-- Wait until nvim has run every key sent so far and what they scheduled. Keys and requests go over the same
-- channel (in order); nvim reads pending input before it handles a request (and fires TextChangedI and the like
-- on the way, as after real typing), and the request's own vim.schedule runs after what the keys scheduled.
local function sync(timeout)
  proc.keys = proc.keys + 1
  local n = proc.keys
  H.lua("local n = ... vim.schedule(function() vim.g.nvt_keys = n end)", { n })
  return vim.wait(timeout or 3000, function() return H.lua("return vim.g.nvt_keys") == n end, 5)
end

-- Keys in nvim notation as the app sends them (nvim_input). Default: wait until they ran and nvim stopped
-- redrawing (40ms without a flush, at most 1s). A number waits that long instead (only for things with no
-- state to wait on, or timing loops; prefer H.expect / H.wait_for).
function H.keys(notation, wait)
  if not rpc then return end
  pcall(vim.rpcnotify, rpc, "nvim_input", notation)
  if wait then
    vim.wait(wait)
  else
    sync()
    H.settle(40, 1000)
  end
end

-- Cmd+V of text: the app's <D-v> pastes the clipboard (config/app.lua)
function H.paste(text)
  H.lua("vim.fn.setreg('+', ...)", { text })
  H.keys("<D-v>")
end

-- Shift Shift / the app window gaining or losing focus, as the app reports them
function H.double_shift()
  H.call("config.app", "double_shift")
  H.settle(40, 1000)
end
function H.app_focus(on)
  ui_send("nvim_ui_set_focus", { on })
  H.settle(40, 1000)
end
-- A native surface ("tree", "popup", "git", ...) takes the keyboard (nil: back to Neovim)
function H.native_focus(name) H.call("config.app", "native_focus", name or vim.NIL) end

-- Mouse via nvim_input_mouse (the app's editor mouse path). win: a window handle (row / col 0-based in its
-- text area: a float's grid also holds its border, added here), or nil for screen coordinates on the default
-- grid. button "left" | "right" | "middle" | "wheel"; action "press" | "release" | "drag" | "up" | "down";
-- mods e.g. "S".
local BORDER = [[
  local b = vim.api.nvim_win_get_config(...).border
  if type(b) ~= 'table' or #b == 0 then return { 0, 0 } end
  local function on(i)
    local x = b[(i - 1) % #b + 1]
    x = type(x) == 'table' and x[1] or x
    return (x ~= nil and x ~= '') and 1 or 0
  end
  return { on(2), on(8) }]]
function H.mouse(button, action, win, row, col, mods)
  local grid = 1
  if win then
    vim.wait(1000, function() return proc.grids[win] ~= nil end, 10)
    grid = proc.grids[win] or 1
    local off = H.lua(BORDER, { win }) or { 0, 0 }
    row, col = row + off[1], col + off[2]
  end
  pcall(vim.rpcnotify, rpc, "nvim_input_mouse", button, action, mods or "", grid, row, col)
  sync()
  H.settle(40, 1000)
end
-- A left click (press + release) at a cell of win
function H.click(win, row, col, mods)
  H.mouse("left", "press", win, row, col, mods)
  H.mouse("left", "release", win, row, col, mods)
end

-- Resize one window's grid as the app's layout does (nvim_ui_try_resize_grid: a maximized island, #102); waits
-- until nvim gives the window that text area (winwidth / winheight: the grid's; nvim_win_get_width stays the
-- window's logical width)
function H.resize_grid(win, cols, rows)
  vim.wait(1000, function() return proc.grids[win] ~= nil end, 10)
  ui_send("nvim_ui_try_resize_grid", { proc.grids[win], cols, rows })
  H.wait_for(function()
    local size = H.lua("local w = ... return { vim.fn.winwidth(w), vim.fn.winheight(w) }", { win })
    return size ~= nil and size[1] == cols and size[2] == rows
  end)
end

-- Resize the UI (the app window): nvim_ui_try_resize, then wait for the new size
function H.resize(cols, lines)
  ui_send("nvim_ui_try_resize", { cols, lines })
  H.wait_for(("vim.o.columns == %d and vim.o.lines == %d"):format(cols, lines), 3000)
  H.settle(60, 2000)
end

-- Wait until a condition holds (default 5s); true if it did. expr: Lua expression run in the nested
-- nvim ("vim.bo.filetype == 'git'"), or a local function.
function H.wait_for(expr, timeout)
  local cond = type(expr) == "function" and expr or function() return H.lua("return " .. expr) end
  return vim.wait(timeout or 5000, function() return cond() and true or false end, 20)
end

-- Wait until nvim stopped redrawing: quiet_ms (default 300) without a flush, at most timeout (default 3s)
function H.settle(quiet_ms, timeout)
  if not proc then return false end
  local p = proc
  quiet_ms = quiet_ms or 300
  return vim.wait(timeout or 3000, function() return (uv.hrtime() - p.last_flush) / 1e6 >= quiet_ms end, 5)
end

-- Bridge (what the app would draw) -----------------------------------------------------------------------------

-- Payloads of `vimstorm.<surface>` notifications so far (oldest first), optionally only one event
function H.bridge(surface, event)
  local out = {}
  for _, b in ipairs(proc and proc.bridge or {}) do
    if b.surface == surface and (event == nil or b.payload.event == event) then out[#out + 1] = b.payload end
  end
  return out
end

-- The newest payload of a surface (/ event) matching pred, or nil
function H.last(surface, event, pred)
  local list = H.bridge(surface, event)
  for i = #list, 1, -1 do
    if not pred or pred(list[i]) then return list[i] end
  end
end

-- Wait (default 5s) for a payload of surface (/ event) matching pred; returns it (newest first)
function H.wait_bridge(surface, event, pred, timeout)
  local found
  vim.wait(timeout or 5000, function()
    found = H.last(surface, event, pred)
    return found ~= nil
  end, 10)
  return found
end

-- Forget the payloads so far (a following wait_bridge sees only new ones)
function H.bridge_clear()
  if proc then proc.bridge = {} end
end

-- Native menus (config/app/menu.lua -> app/src/popups) ------------------------------------------------------------

-- Wait for a menu payload (H.bridge_clear() before the action that opens it); items: payload.items[i].label
-- (separators: { sep = true })
function H.wait_menu(timeout) return H.wait_bridge("popups", "menu", nil, timeout) end

-- Labels of a menu payload's items
function H.menu_labels(menu)
  local out = {}
  for _, it in ipairs(menu and menu.items or {}) do
    if not it.sep then out[#out + 1] = it.label end
  end
  return out
end

-- Pick the item of a menu payload whose label starts with `label` (what a click / Enter in the native menu
-- does). False if there's none.
function H.menu_choose(menu, label)
  for i, it in ipairs(menu and menu.items or {}) do
    if not it.sep and it.label and it.label:sub(1, #label) == label then
      H.call("config.app.menu", "choose", menu.id, i)
      H.settle(40, 1000)
      return true
    end
  end
  return false
end

-- Reads ------------------------------------------------------------------------------------------------------

-- Common state of the nested nvim
function H.focus() return H.lua("return require('config.focus').target()") end -- tree | split | diff | merge | git | terminal | popup | other
function H.cursor() return H.lua("return vim.api.nvim_win_get_cursor(0)") end -- { line, col0 }
function H.mode() return H.lua("return vim.api.nvim_get_mode().mode") end
function H.file() return H.lua("return vim.fn.expand('%:t')") end -- tail of the current buffer's name
function H.lines(a, b) return H.lua(("return vim.api.nvim_buf_get_lines(0, %d, %d, false)"):format(a or 0, b or -1)) end
function H.line(n) return H.lua(n and ("return vim.fn.getline(%d)"):format(n) or "return vim.fn.getline('.')") end
function H.clipboard() return H.lua("return vim.fn.getreg('+')") end
-- The editor tab bars as the app gets them (config.app.tabs.bars()), splits top-left to bottom-right:
-- "tab,tab[active]" per split, "*" after the focused one, e.g. "a.ts[a.ts] | a.ts,b.ts[b.ts]*"
function H.tab_bars()
  return H.lua([[
    local bars = require('config.app.tabs').bars()
    local pos = vim.api.nvim_win_get_position
    table.sort(bars, function(a, b)
      local pa, pb = pos(a.win), pos(b.win)
      return pa[1] < pb[1] or pa[1] == pb[1] and pa[2] < pb[2]
    end)
    local out = {}
    for _, b in ipairs(bars) do
      local names, active = {}, ''
      for _, t in ipairs(b.tabs) do
        names[#names + 1] = t.name
        if t.buf == b.active then active = t.name end
      end
      out[#out + 1] = table.concat(names, ',') .. '[' .. active .. ']' .. (b.focused and '*' or '')
    end
    return table.concat(out, ' | ')]]) or ""
end
-- Wait until the focus target is `target`
function H.wait_focus(target, timeout)
  return H.wait_for(("require('config.focus').target() == %q"):format(target), timeout)
end

-- Results ----------------------------------------------------------------------------------------------------

function H.check(name, ok, detail)
  ok = ok and true or false
  -- one line per result (writefile would turn a newline in the detail into a NUL)
  local d = (not ok and detail ~= nil) and ("  -- " .. (type(detail) == "table" and vim.inspect(detail) or tostring(detail)):gsub("\n", " ⏎ ")) or ""
  results[#results + 1] = (ok and "PASS " or "FAIL ") .. name:gsub("\n", " ") .. d
  return ok
end

-- Check that a condition becomes true (expr or function, like H.wait_for; default 5s). detail: value, or a
-- function / Lua expression string (prefix "=") evaluated only on failure.
function H.expect(name, cond, detail, timeout)
  local ok = H.wait_for(cond, timeout)
  if not ok and type(detail) == "function" then
    detail = detail()
  elseif not ok and type(detail) == "string" and detail:sub(1, 1) == "=" then
    detail = vim.inspect(H.lua("return " .. detail:sub(2)))
  end
  return H.check(name, ok, detail)
end

-- Waits (at most max_ms, default 30 s) until the machine's 1-minute load average is under half its cores: wall-time
-- budgets right after a heavy build (thermal throttling, leftover load) miss for reasons that aren't ours.
-- Returns the ms waited.
function H.cooldown(max_ms)
  local t, cores = uv.hrtime(), #uv.cpu_info()
  vim.wait(max_ms or 30000, function() return (uv.loadavg()) < cores * 0.5 end, 500)
  return (uv.hrtime() - t) / 1e6
end

local function sorted_median(samples)
  local s = vim.deepcopy(type(samples) == "table" and samples or { samples })
  table.sort(s)
  return s[math.ceil(#s / 2)] or math.huge, s
end

-- Check a timing budget on the median of samples (ms): PASS line shows median / max / budget. resample (a function
-- returning a new sample list): on a miss, cool down and measure once more, judged on the lower median (the line
-- says so; limits stay as they are)
function H.budget(name, samples, limit, resample)
  local med, s = sorted_median(samples)
  local note = ""
  if med > limit and resample then
    local first = med
    local waited = H.cooldown(20000)
    local med2, s2 = sorted_median(resample())
    if med2 < med then med, s = med2, s2 end
    note = (", after a %.0fs cooldown, first median %.1fms"):format(waited / 1000, first)
  end
  return H.check(("%s: median %.1fms max %.1fms (n=%d, budget %gms%s)"):format(name, med, s[#s] or -1, #s, limit, note),
    med <= limit)
end

-- Run fn n times (default 5), return the ms each run took (fn may return its own ms instead)
function H.samples(fn, n)
  local out = {}
  for i = 1, n or 5 do
    local t = uv.hrtime()
    local ms = fn(i)
    out[#out + 1] = type(ms) == "number" and ms or (uv.hrtime() - t) / 1e6
  end
  return out
end

-- Done -------------------------------------------------------------------------------------------------------

function H.done()
  H.stop()
  vim.fn.writefile(results, os.getenv("NVT_OUT"), "a")
  vim.cmd("qa!")
end

-- Run a test body; errors become a FAIL instead of hanging the run
function H.run(fn)
  local ok, err = xpcall(fn, debug.traceback)
  if not ok then H.check("test crashed", false, err) end
  H.done()
end

return H
