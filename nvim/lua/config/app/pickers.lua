-- The app's native pickers (Rust: app/src/search): Search Everywhere (All / Files / Symbols), Go to File,
-- Find in Files, Recent Files / Open Files / Recent Projects, the usages popup (config/usages.lua) and the
-- Ctrl+Tab switcher (config/switcher.lua). Rust lists / matches files, runs ripgrep and draws everything; Lua
-- gives it what only Neovim knows (open and recent files, LSP symbols / locations) and opens what was picked.
--
-- Lua -> Rust (vimstorm.pickers): open {kind, query?, open?, recent?, dirs?, folder?, history?}, double_shift,
-- symbols {id, items}, usages {title, right, items}, switcher {files, tools, back, wait, recent?}, typeahead
-- {token?, keys}.
-- Rust -> Lua: open_file(path, line?, col?, how?), symbols(id, query), focused(token), usage_pick(token, i),
-- switcher_pick(col, i, token), project_open(path), remember(kind, query).
-- Recent Files ("recent") is the switcher's recent mode (config/switcher.lua M.recent).
local bridge = require("config.app.bridge")
local M = {}

---@alias AppPickerKind "all"|"files"|"symbols"|"grep"|"recent"|"buffers"|"projects"

local function send(payload) return bridge.notify("pickers", payload) end

local function rel_ok(path)
  return path ~= "" and vim.uv.fs_stat(path) ~= nil and vim.fn.isdirectory(path) == 0
end

-- Open file buffers, most recently used first, without the current one (Go to File lists them first)
---@return string[]
local function open_files()
  local cur = vim.api.nvim_buf_get_name(0)
  local ret = {}
  for _, path in ipairs(require("config.switcher").recent_paths()) do
    if path ~= cur then ret[#ret + 1] = path end
  end
  return ret
end

-- Recently opened files (vim.v.oldfiles, existing), like snacks' recent source: open buffers first, the
-- current file left out; with `cwd` (filter.cwd) only this project's
---@param cwd? boolean default true (Go to File); false: all of them (`,fr`)
---@return string[]
local function recent_files(cwd)
  cwd = cwd ~= false and (vim.fs.normalize(vim.fn.getcwd()) .. "/") or nil
  local skip = { vim.fn.stdpath("data"), vim.fn.stdpath("cache"), vim.fn.stdpath("state") }
  local cur = vim.api.nvim_buf_get_name(0)
  local seen, ret = {}, {}
  local function add(f)
    f = vim.fs.normalize(vim.fn.fnamemodify(f, ":p"))
    if seen[f] or f == cur then return end
    seen[f] = true
    if cwd and f:sub(1, #cwd) ~= cwd then return end
    for _, s in ipairs(skip) do
      if f:sub(1, #s + 1) == s .. "/" then return end
    end
    if rel_ok(f) then ret[#ret + 1] = f end
  end
  for _, f in ipairs(require("config.switcher").recent_paths()) do add(f) end
  for _, f in ipairs(vim.v.oldfiles) do add(f) end
  return ret
end

-- Typeahead (config/app/typeahead.lua): keys typed right after a picker shortcut are held until the picker
-- has the keyboard, then put before anything typed into it.
local typeahead = require("config.app.typeahead")

local function hold() typeahead.hold("pickers") end
local function stop_hold() typeahead.stop() end

-- The app gave the picker the keyboard: once the keys queued before that are read, what was held goes to it
---@param token? integer
function M.focused(token) typeahead.focused("pickers", token) end

-- Query history (Ctrl+Up / Ctrl+Down in the pickers), per picker kind, oldest first, shared by every project
-- (snacks kept it in stdpath("data")/snacks/picker_*.history): stdpath("state")/picker-history.json, read again
-- when another nvim wrote it
local HISTORY_MAX = 100
local history_file = vim.fn.stdpath("state") .. "/picker-history.json"
local history, history_mtime = {}, nil ---@type table<string, string[]>, integer?

---@return table<string, string[]>
local function load_history()
  local st = vim.uv.fs_stat(history_file)
  local mtime = st and st.mtime.sec * 1e9 + st.mtime.nsec or nil
  if mtime ~= history_mtime then
    history_mtime = mtime
    local ok, data = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(history_file), "\n")) end)
    history = ok and type(data) == "table" and data or {}
  end
  return history
end

-- The history for an open payload (nil when empty: an empty table would go as an array)
local function history_payload()
  local h = load_history()
  return next(h) ~= nil and h or nil
end

-- A picker's query was confirmed (a pick): kept on disk, newest last
---@param kind string
---@param query string
function M.remember(kind, query)
  if type(kind) ~= "string" or type(query) ~= "string" or query == "" then return end
  local h = load_history()
  local list = vim.tbl_filter(function(q) return q ~= query end, h[kind] or {})
  list[#list + 1] = query
  while #list > HISTORY_MAX do table.remove(list, 1) end
  h[kind] = list
  vim.fn.mkdir(vim.fs.dirname(history_file), "p")
  if vim.fn.writefile({ vim.json.encode(h) }, history_file) == 0 then
    local st = vim.uv.fs_stat(history_file)
    history_mtime = st and st.mtime.sec * 1e9 + st.mtime.nsec or nil
  end
end

-- Opens a native picker
---@param kind AppPickerKind
---@param opts? {query?: string, dirs?: string[], cwd?: boolean}
function M.open(kind, opts)
  opts = opts or {}
  local mode = vim.api.nvim_get_mode().mode
  if mode:match("^[cr]") then return end
  if mode ~= "n" then vim.cmd.stopinsert() end
  -- Recent Files: WebStorm's is the switcher in its recent mode
  if kind == "recent" then return require("config.switcher").recent({ all = opts.cwd ~= true }) end
  local payload = { event = "open", kind = kind, query = opts.query, history = history_payload() }
  if kind == "all" or kind == "files" then
    payload.open, payload.recent = open_files(), recent_files()
  elseif kind == "grep" then
    if opts.dirs and #opts.dirs > 0 then
      payload.dirs = vim.tbl_map(function(d) return vim.fs.normalize(vim.fn.fnamemodify(d, ":p")) end, opts.dirs)
    end
    -- the Directory scope's folder: the current file's
    local name = vim.bo.buftype == "" and vim.api.nvim_buf_get_name(0) or ""
    if name ~= "" then payload.folder = vim.fs.dirname(vim.fs.normalize(name)) end
  elseif kind == "buffers" then
    payload.recent = require("config.switcher").recent_paths()
  end
  hold()
  if not send(payload) then stop_hold() end
end

-- Shift Shift: Search Everywhere's All tab (switches an open Search Everywhere to it, keeping the text)
function M.double_shift()
  local mode = vim.api.nvim_get_mode().mode
  if mode:match("^[cr]") then return end
  if mode ~= "n" then vim.cmd.stopinsert() end
  hold()
  local payload = { event = "double_shift", open = open_files(), recent = recent_files(), history = history_payload() }
  if not send(payload) then stop_hold() end
end

-- Snacks picker sources the app draws natively, and how
local NATIVE = {
  smart = "all",
  files = "files",
  lsp_workspace_symbols = "symbols",
  grep = "grep",
  recent = "recent",
  buffers = "buffers",
  projects = "projects",
}

-- LSP location pickers: the usages popup (WebStorm's Choose Declaration / Implementation popups)
local LOCATIONS = {
  lsp_references = "usages",
  lsp_definitions = { "textDocument/definition", "Choose Declaration", "declaration" },
  lsp_implementations = { "textDocument/implementation", "Choose Implementation", "implementation" },
  lsp_type_definitions = { "textDocument/typeDefinition", "Choose Type Declaration", "type declaration" },
}

-- Snacks bug: text typed into a picker's input schedules a search (throttled); when the picker closes before
-- it runs (Esc right after typing, on a busy machine), the cleanup has dropped input.picker and the search
-- threw a traceback (hit-enter prompt). A closed input keeps a stand-in whose search does nothing (it holds
-- no reference to the picker, which is still garbage collected). Still needed by the snacks fallback pickers
-- (`,fd ,fk ,fh`).
local CLOSED = { find = function() end }
local patched = false

-- Snacks.picker.<source>() of the sources above opens the native view instead (keymaps / menus keep calling
-- snacks; returns nil: there's no snacks picker object); the rest stay snacks pickers.
function M.setup()
  if patched then return end
  patched = true
  local Input = require("snacks.picker.core.input")
  local close = Input.close
  function Input:close()
    close(self)
    rawset(self, "picker", CLOSED)
  end
  local P = require("snacks.picker")
  local pick = P.pick
  P.pick = function(source, opts)
    if not opts and type(source) == "table" then opts, source = source, nil end
    local src = source or (opts or {}).source
    local kind = NATIVE[src]
    if kind then
      opts = opts or {}
      local query = opts.pattern or opts.search
      local cwd = type(opts.filter) == "table" and opts.filter.cwd == true
      return M.open(kind, { query = query ~= "" and query or nil, dirs = opts.dirs, cwd = cwd })
    end
    local loc = LOCATIONS[src]
    if loc == "usages" then return require("config.usages").usages() end
    if loc then return require("config.usages").choose(loc[1], loc[2], loc[3]) end
    return pick(source, opts)
  end
end

-- Rust -> Lua --------------------------------------------------------------------------------------------

-- Puts the caret on line / col (1-based; col in `enc` units (LSP) or bytes), centered when it was off screen
local function place(line, col, enc)
  if type(line) ~= "number" or line <= 0 then return end
  local lnum = math.min(line, vim.api.nvim_buf_line_count(0))
  local visible = lnum >= vim.fn.line("w0") and lnum <= vim.fn.line("w$")
  local c = math.max((col or 1) - 1, 0)
  if type(enc) == "string" and enc ~= "utf-8" then
    local text = vim.api.nvim_buf_get_lines(0, lnum - 1, lnum, false)[1] or ""
    local ok, b = pcall(vim.str_byteindex, text, enc, c, false)
    c = ok and b or c
  end
  pcall(vim.api.nvim_win_set_cursor, 0, { lnum, c })
  if not visible then vim.cmd("normal! zz") end
end

-- Edits `path` in the current window (its loaded buffer when there is one)
local function edit(path)
  local buf = vim.fn.bufnr(path)
  if buf ~= -1 and vim.api.nvim_buf_is_loaded(buf) then return vim.api.nvim_set_current_buf(buf) end
  vim.cmd.edit(vim.fn.fnameescape(path))
end

-- The window a pick goes to: the last focused split; "pick" (Shift+Enter): snacks' window picker
---@param how? string
---@return boolean ok
local function target_win(how)
  local focus = require("config.focus")
  if require("config.app").native() then require("config.app").focus(nil) end
  focus.edit()
  if how == "pick" then
    local win = Snacks.picker.util.pick_win({ main = vim.api.nvim_get_current_win() })
    if not win then return false end
    vim.api.nvim_set_current_win(win)
  end
  return true
end

-- Open a picked file in the last focused split (like snacks' jump): `how` "vsplit" / "split" opens it in a
-- new split, "pick" in a window chosen with snacks' window picker; line / col (1-based) put the caret there
-- (col in `enc` units for LSP positions, else bytes)
---@param path string
---@param line? integer
---@param col? integer
---@param how? "edit"|"vsplit"|"split"|"pick"
---@param enc? string
function M.open_file(path, line, col, how, enc)
  vim.schedule(function()
    if not target_win(how) then return end
    vim.cmd("normal! m'")
    if how == "vsplit" or how == "split" then
      vim.cmd[how](vim.fn.fnameescape(path))
    else
      edit(path)
    end
    place(line, col, enc)
  end)
end

-- Several picks (snacks' Tab selection): each opened, the last one shown
---@param items {path: string, line?: integer, col?: integer, enc?: string}[]
---@param how? string
function M.open_files(items, how)
  vim.schedule(function()
    if not target_win(how) then return end
    vim.cmd("normal! m'")
    for i, it in ipairs(items) do
      if (how == "vsplit" or how == "split") then
        vim.cmd[how](vim.fn.fnameescape(it.path))
      else
        edit(it.path)
      end
      if i == #items or how == "vsplit" or how == "split" then place(it.line, it.col, it.enc) end
    end
  end)
end

-- Ctrl+Q: the picks into the quickfix list, opened (snacks' qflist)
---@param title string
---@param items {path: string, line?: integer, col?: integer, text?: string}[]
function M.qflist(title, items)
  vim.schedule(function()
    local qf = vim.tbl_map(function(it)
      return { filename = it.path, lnum = it.line or 1, col = it.col or 1, text = it.text or "" }
    end, items)
    vim.fn.setqflist({}, " ", { title = title, items = qf })
    require("config.focus").edit()
    vim.cmd("botright copen")
  end)
end

-- Ctrl+X in Open Files: close that buffer (snacks' bufdelete)
---@param path string
function M.bufdelete(path)
  vim.schedule(function()
    local buf = vim.fn.bufnr(path)
    if buf ~= -1 then Snacks.bufdelete({ buf = buf }) end
  end)
end

local KINDS = vim.lsp.protocol.SymbolKind

-- Workspace symbols for Search Everywhere's Symbols tab: every client that has them, answered as
-- {event = "symbols", id, items}. The app drops answers to older ids.
---@param id integer
---@param query string
function M.symbols(id, query)
  local clients = vim.lsp.get_clients({ method = "workspace/symbol" })
  if #clients == 0 then return send({ event = "symbols", id = id, items = {}, done = true }) end
  local items, left = {}, #clients
  local cwd = vim.fs.normalize(vim.fn.getcwd()) .. "/"
  for _, client in ipairs(clients) do
    local ok = client:request("workspace/symbol", { query = query }, function(_, result)
      for _, s in ipairs(type(result) == "table" and result or {}) do
        local loc = s.location or {}
        local file = loc.uri and vim.uri_to_fname(loc.uri) or nil
        if file and #items < 500 then
          local start = loc.range and loc.range.start or { line = 0, character = 0 }
          items[#items + 1] = {
            name = s.name,
            kind = KINDS[s.kind] or "",
            container = s.containerName or "",
            file = file,
            rel = file:sub(1, #cwd) == cwd and file:sub(#cwd + 1) or vim.fn.fnamemodify(file, ":~"),
            line = start.line + 1,
            col = start.character + 1, -- in `enc` units: open_file converts
            enc = client.offset_encoding,
          }
        end
      end
      left = left - 1
      if left == 0 then vim.schedule(function() send({ event = "symbols", id = id, items = items, done = true }) end) end
    end)
    if not ok then
      left = left - 1
      if left == 0 then send({ event = "symbols", id = id, items = items, done = true }) end
    end
  end
end

-- Syntax colors of a file for the pickers' preview (treesitter, like config/usages.lua's rows): answered as
-- {event = "highlights", id, spans = {{ line, start byte, end byte, rgb, bold, italic }, ...}}. Big files: none.
local MAX_HL_LINES = 5000
local hl_cache = {} ---@type table<string, table|false>
local function color(group)
  if hl_cache[group] == nil then
    local ok, h = pcall(vim.api.nvim_get_hl, 0, { name = group, link = false })
    hl_cache[group] = ok and h.fg and { h.fg, h.bold == true, h.italic == true } or false
  end
  return hl_cache[group] or nil
end

---@param id integer
---@param path string
function M.highlights(id, path)
  vim.schedule(function()
    local spans = {}
    local function done() send({ event = "highlights", id = id, spans = spans }) end
    local ft = vim.filetype.match({ filename = path })
    local lang = ft and vim.treesitter.language.get_lang(ft)
    local okq, query = pcall(vim.treesitter.query.get, lang or "", "highlights")
    if not (lang and okq and query) then return done() end
    local buf = vim.fn.bufnr(path)
    local src, lines, okp, parser
    if buf ~= -1 and vim.api.nvim_buf_is_loaded(buf) then
      src, lines = buf, vim.api.nvim_buf_get_lines(buf, 0, -1, false)
      okp, parser = pcall(vim.treesitter.get_parser, buf, lang)
    else
      lines = vim.fn.filereadable(path) == 1 and vim.fn.readfile(path, "", MAX_HL_LINES + 1) or {}
      src = table.concat(lines, "\n")
      okp, parser = pcall(vim.treesitter.get_string_parser, src, lang)
    end
    if not okp or not parser or #lines > MAX_HL_LINES then return done() end
    local tree = parser:parse()[1]
    if not tree then return done() end
    for cid, node in query:iter_captures(tree:root(), src, 0, #lines) do
      local name = query.captures[cid]
      if not name:match("^_") and name ~= "spell" and name ~= "nospell" then
        local c = color("@" .. name .. "." .. lang) or color("@" .. name)
        if c then
          local sr, sc, er, ec = node:range()
          for r = sr, math.min(er, #lines - 1) do
            local s = r == sr and sc or 0
            local e = r == er and ec or #(lines[r + 1] or "")
            if e > s then spans[#spans + 1] = { r + 1, s, e, c[1], c[2], c[3] } end
          end
        end
      end
    end
    done()
  end)
end

-- The usages popup's pick: config/usages.lua keeps its locations per popup (token)
---@param token integer
---@param i integer 1-based
function M.usage_pick(token, i)
  vim.schedule(function() require("config.usages").pick(token, i) end)
end

-- Switcher: the app saw Ctrl released. It opens the selection once Neovim has read the keys sent before
-- (a Ctrl+Tab typed before the switcher had the keyboard still moves it): a marker key queued behind them
-- answers (`switcher_sync`).
local SYNC = "<F36>" -- a key nobody types
local SYNC_KEY = vim.keycode(SYNC)
local syncing = {} ---@type integer[] tokens waiting for the marker
vim.on_key(function(_, typed)
  if typed ~= SYNC_KEY then return end
  local tokens = syncing
  syncing = {}
  vim.schedule(function()
    for _, t in ipairs(tokens) do send({ event = "switcher_sync", token = t }) end
  end)
  return ""
end, vim.api.nvim_create_namespace("ws_app_switcher_sync"))

---@param token integer
function M.switcher_sync(token)
  syncing[#syncing + 1] = token
  vim.api.nvim_input(SYNC)
end

-- The app's switcher closed (picked or not)
---@param token integer
function M.switcher_done(token)
  require("config.switcher").done(token)
end

-- A Ctrl+Tab reached Lua before the app's pick / close of the switcher it had open (keys overtake queued
-- notifications): a new switcher once that pick ran (scheduled behind it), like a Ctrl+Tab after it
---@param back boolean
function M.switcher_reopen(back)
  vim.schedule(function() require("config.switcher").open({ back = back }) end)
end

-- The switcher's pick ("tools" / "files", 1-based row; token: the popup it was opened as)
function M.switcher_pick(col, i, token)
  vim.schedule(function() require("config.switcher").pick(col, i, token) end)
end

return M
