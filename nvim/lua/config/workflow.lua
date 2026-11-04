-- A Layer's workflow or skill file in the Editor (#19 stories 24, 26, 27, 28, 36): `abe workflow read` says what it
-- is (abe/packages/core/src/skills/workflow/edit.ts). Its readable side is the preview beside the source
-- (config/markdown.lua, config/app/markdown.lua send `markdown` instead of the file's text; a workflow's `preview`
-- too, which the app's workflow preview draws in its place, ADR 0033), its problems are
-- red-wave diagnostics with their fixes first on ⌥⏎ (config/context.lua), a farther Layer's file is read-only
-- (Edit my copy), ⌘G changes it with AI, the menu adds Change / Edit or Open My Copy / Propose / Retro. The
-- preview's `abe:` links run the same actions. The Project tree's Abe node (the workflows and skills in force) is
-- `abe workflow tree`, sent to the tree (`M.tree`). Every abe call is async (vim.system), `--no-start`, in the
-- project's folder; the abe is VIMSTORM_ABE (the app's: app/src/nvim/process.rs), else ABE_BIN, else `abe` on PATH;
-- none: nothing happens.
local M = {}

local NS = vim.api.nvim_create_namespace("abe_workflow") -- the read's problems
local CHANGED = vim.api.nvim_create_namespace("abe_workflow_changed") -- lines a change / fix put in
local DEBOUNCE = 300

---@class AbeFix
---@field title string
---@field text string the whole file after it

---@class AbeLayerFile
---@field file string
---@field kind "workflow"|"skill"
---@field layer string
---@field id string
---@field readOnly boolean
---@field mine? string
---@field proposeTo? string
---@field markdown string
---@field preview? table a workflow's preview (core's WorkflowPreview), drawn by the app
---@field defs? {line: integer, name: string, path: string}[] each step's skill's SKILL.md (⌘B / gd)
---@field refs? {path: string, line: integer, text: string}[] the steps running a skill (its usages)
---@field problems {line?: integer, code: string, text: string, fixes: AbeFix[]}[]
---@field compare? {layer: string, theirs: string, mine: string}
---@field retro? {findings: {severity: string, title: string, what: string, fix?: {summary: string, text: string}}[]}

local files = {} ---@type table<integer, AbeLayerFile> buf -> its last read
local seq = {} ---@type table<integer, integer> buf -> number of the read asked last
local read_tick = {} ---@type table<integer, integer> buf -> changedtick its last read answered
local not_layer = {} ---@type table<integer, string> buf -> path abe refused (not a Layer's file)
local timers = {} ---@type table<integer, integer> buf -> debounce generation

-- The abe Lua runs, or nil (the feature is off)
---@return string?
function M.bin()
  for _, v in ipairs({ vim.env.VIMSTORM_ABE, vim.env.ABE_BIN }) do
    if v and v ~= "" then return v end
  end
  local p = vim.fn.exepath("abe")
  return p ~= "" and p or nil
end

-- A path a Layer's file can have (abe decides: `not-a-layer-file` otherwise): a workflow's YAML, a skill's markdown
-- (its SKILL.md, another .md of its folder). A skill's other files (JSON, scripts) open as themselves.
---@param path string
function M.looks_like(path)
  if path == "" or path:find("/%.github/workflows/") then return false end
  return path:match("/workflows/[^/]+%.ya?ml$") ~= nil or path:lower():match("/skills/[^/]+/.+%.md$") ~= nil
end

-- The folder abe runs in for `path`: the project's, or the checkout the file is in when that's another (a card's
-- worktree: its repo Layer is the worktree's own), else the file's
---@param path string
---@return string?
local function folder_for(path)
  local cwd = vim.fn.getcwd()
  local root, here = vim.fs.root(path, ".git"), vim.fs.root(cwd, ".git")
  if root and (not here or vim.fn.resolve(root) ~= vim.fn.resolve(here)) then return root end
  if vim.fn.isdirectory(cwd) == 1 then return cwd end
  local dir = vim.fs.dirname(path)
  return vim.fn.isdirectory(dir) == 1 and dir or nil
end

---@param buf integer
local function candidate(buf)
  if not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].buftype ~= "" then return false end
  local path = vim.api.nvim_buf_get_name(buf)
  return M.looks_like(path) and not_layer[buf] ~= path
end

---@param msg string
---@param level? integer
local function say(msg, level) vim.notify(msg, level or vim.log.levels.INFO) end

---@param buf integer
local function text_of(buf) return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n") .. "\n" end

-- `abe <args…> --json --no-start` in path's folder; cb({ok, data?, error?}) on the main loop
---@param path string
---@param args string[]
---@param cb fun(res: {ok: boolean, data?: table, error?: {code: string, message: string}})
local function run(path, args, cb)
  local bin = M.bin()
  if not bin then return false end
  local cmd = { bin }
  vim.list_extend(cmd, args)
  vim.list_extend(cmd, { "--json", "--no-start" })
  -- the project's folder (or the file's checkout): its repo Layer is read (and local mode is its)
  local ok = pcall(vim.system, cmd, { cwd = folder_for(path), text = true }, function(r)
    local res
    local out = vim.trim(r.stdout or "")
    local line = out:match("([^\n]*)$") or ""
    local dok, decoded = pcall(vim.json.decode, line, { luanil = { object = true, array = true } })
    if dok and type(decoded) == "table" and type(decoded.ok) == "boolean" then
      res = decoded
    else
      local why = r.code == 3 and "Abe isn't running" or vim.trim(r.stderr or "")
      res = { ok = false, error = { code = r.code == 3 and "unreachable" or "failed", message = why ~= "" and why or "abe failed" } }
    end
    vim.schedule(function() cb(res) end)
  end)
  return ok
end

-- The read's answer on the buffer ---------------------------------------------------------------------------------

-- Read-only here (a farther Layer's): not modifiable, an edit says how to change it
---@param buf integer
---@param on boolean
local function read_only(buf, on)
  if (vim.b[buf].abe_read_only == true) == on then return end
  vim.b[buf].abe_read_only = on or nil
  vim.bo[buf].modifiable = not on
  vim.bo[buf].readonly = on
  local keys = { "x", "X", "d", "D", "p", "P", "J", "r", "R", "s", "S", "c", "C", "<Del>" }
  for _, k in ipairs(keys) do
    if on then
      vim.keymap.set("n", k, function() M.tell_read_only() end, { buffer = buf, nowait = true })
    else
      pcall(vim.keymap.del, "n", k, { buffer = buf })
    end
  end
end

local told = 0
function M.tell_read_only()
  local now = vim.uv.now()
  if now - told < 1500 then return end
  told = now
  say("Read-only here: Edit my copy", vim.log.levels.WARN)
end

local wrapped_at = {} ---@type table<integer, integer> buf -> the grid width its problems were wrapped at

-- `text` wrapped between its words at `width` display cells; a word wider than that (a long key) hard-broken at
-- the edge, not cut there
---@param text string
---@param width integer
---@return string[]
function M.wrap(text, width)
  local lines, line = {}, ""
  for word in text:gmatch("%S+") do
    if line ~= "" and vim.fn.strdisplaywidth(line .. " " .. word) > width then
      lines[#lines + 1], line = line, ""
    end
    if line == "" then
      while vim.fn.strdisplaywidth(word) > width do
        local n = 1 -- the most characters that fit (one at least)
        while vim.fn.strdisplaywidth(vim.fn.strcharpart(word, 0, n + 1)) <= width do n = n + 1 end
        lines[#lines + 1], word = vim.fn.strcharpart(word, 0, n), vim.fn.strcharpart(word, n)
      end
      line = word
    else
      line = line .. " " .. word
    end
  end
  lines[#lines + 1] = line
  return lines
end

-- A problem's message for its virtual lines: no code before it (`schema: …`), wrapped at its window's edge (the
-- lines don't wrap themselves: past the edge they were cut). The edge is the grid the app sized to what shows
-- (winwidth: left of an Editor and Preview pair's preview); nvim_win_get_width stays the logical width.
-- 6 is the `└──── ` the lines start with.
---@param diag vim.Diagnostic
---@return string
local function wrapped(diag)
  local buf = diag.bufnr or vim.api.nvim_get_current_buf()
  local win = vim.fn.bufwinid(buf)
  wrapped_at[buf] = win == -1 and -1 or vim.fn.winwidth(win) -- (-1: wrapped anew once it shows)
  if win == -1 then return diag.message end
  local width = wrapped_at[buf] - vim.fn.getwininfo(win)[1].textoff - 6 - 1
  if width < 20 then return diag.message end
  return table.concat(M.wrap(diag.message, width), "\n")
end

---@param buf integer
---@param d AbeLayerFile
local function diagnostics(buf, d)
  local n = vim.api.nvim_buf_line_count(buf)
  local list = {}
  for _, p in ipairs(d.problems or {}) do
    local lnum = math.max(0, math.min((p.line or 1) - 1, n - 1))
    local text = vim.api.nvim_buf_get_lines(buf, lnum, lnum + 1, false)[1] or ""
    list[#list + 1] = {
      lnum = lnum, col = 0, end_lnum = lnum, end_col = #text, severity = vim.diagnostic.severity.ERROR,
      message = p.text, source = "abe", code = p.code, user_data = { fixes = p.fixes or {} },
    }
  end
  vim.diagnostic.set(NS, buf, list)
end

---@param buf integer
---@param d AbeLayerFile
local function landed(buf, d)
  local first = files[buf] == nil
  files[buf] = d
  vim.b[buf].abe_layer = true
  vim.b[buf].abe_layer_file = d
  diagnostics(buf, d)
  read_only(buf, d.readOnly == true)
  if vim.b[buf].abe_cmd_g == nil then
    vim.b[buf].abe_cmd_g = true
    vim.keymap.set({ "n", "i" }, "<D-g>", function() M.change(buf) end, { buffer = buf, desc = "Change with AI" })
    -- ⌘-click: the caret there, then go to definition like code (a step's skill, a skill's steps)
    vim.keymap.set({ "n", "i" }, "<D-LeftMouse>", function()
      local at = vim.fn.getmousepos()
      if at.winid == 0 or not vim.api.nvim_win_is_valid(at.winid) then return end
      vim.api.nvim_set_current_win(at.winid)
      pcall(vim.api.nvim_win_set_cursor, at.winid, { math.max(1, at.line), math.max(0, at.column - 1) })
      if not M.declaration_or_usages() then require("config.context").declaration_or_usages() end
    end, { buffer = buf, desc = "Go to declaration / usages" })
  end
  -- ⌘D compares only while there is another side (else the Feel's own ⌘D)
  if d.compare and not vim.b[buf].abe_cmd_d then
    vim.b[buf].abe_cmd_d = true
    vim.keymap.set("n", "<D-d>", function() M.compare(buf) end, { buffer = buf, desc = "Compare with the other Layer's" })
  elseif not d.compare and vim.b[buf].abe_cmd_d then
    vim.b[buf].abe_cmd_d = nil
    pcall(vim.keymap.del, "n", "<D-d>", { buffer = buf })
  end
  local md = package.loaded["config.markdown"]
  if md and first then md.refresh() end
  local app = package.loaded["config.app.markdown"]
  if app then app.resend(buf) end
end

---@param buf integer
local function forget(buf)
  files[buf] = nil
  if vim.api.nvim_buf_is_valid(buf) then
    vim.b[buf].abe_layer, vim.b[buf].abe_layer_file = nil, nil
    vim.diagnostic.reset(NS, buf)
    read_only(buf, false)
    local md = package.loaded["config.markdown"]
    if md then md.refresh() end
  end
end

-- `abe workflow read` of the buffer (its text when it's changed); a stale answer (the text changed since) is dropped
---@param buf integer
---@param force? boolean also when the last answer is for this text
function M.read(buf, force)
  if not candidate(buf) then return end
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  if not force and files[buf] and read_tick[buf] == tick then return end
  local path = vim.api.nvim_buf_get_name(buf)
  local n = (seq[buf] or 0) + 1
  seq[buf] = n
  local args = { "workflow", "read", path }
  if vim.bo[buf].modified then vim.list_extend(args, { "--text", text_of(buf) }) end
  run(path, args, function(res)
    if seq[buf] ~= n or not vim.api.nvim_buf_is_valid(buf) or vim.api.nvim_buf_get_changedtick(buf) ~= tick then return end
    if res.ok and type(res.data) == "table" then
      read_tick[buf] = tick
      landed(buf, res.data --[[@as AbeLayerFile]])
    elseif res.error and res.error.code ~= "unreachable" and res.error.code ~= "failed" then
      -- not a Layer's file (or one abe can't place): left alone until it's renamed
      not_layer[buf] = path
      forget(buf)
    end
  end)
end

---@param buf integer
local function read_later(buf)
  if not candidate(buf) then return end
  local g = (timers[buf] or 0) + 1
  timers[buf] = g
  vim.defer_fn(function()
    if timers[buf] == g and vim.api.nvim_buf_is_valid(buf) then M.read(buf) end
  end, DEBOUNCE)
end

-- What other modules ask -------------------------------------------------------------------------------------

---@param buf integer
---@return AbeLayerFile?
function M.get(buf) return files[buf] end

-- The readable side (the preview's text), nil for any other buffer
---@param buf integer
---@return string?
function M.markdown(buf) return files[buf] and files[buf].markdown end

-- A workflow's preview (the app draws it beside the source), nil for a skill's file or any other buffer
---@param buf integer
---@return table?
function M.preview(buf) return files[buf] and files[buf].preview end

-- ⌘B / gd in a Layer's file: on a workflow's step, its skill's SKILL.md; in a skill's file, the steps running it
-- (Show Usages). false: not one (the LSP's own then)
---@return boolean
function M.declaration_or_usages()
  local buf = vim.api.nvim_get_current_buf()
  local d = files[buf]
  if not d then return false end
  local usages = require("config.usages")
  local function loc(path, line)
    local at = { line = math.max(0, line - 1), character = 0 }
    return { uri = vim.uri_from_fname(path), range = { start = at, ["end"] = at }, enc = "utf-8" }
  end
  if d.kind == "workflow" then
    -- the step the caret is in: the last one starting at or above it
    local lnum, def = vim.api.nvim_win_get_cursor(0)[1], nil
    for _, x in ipairs(d.defs or {}) do
      if x.line <= lnum then def = x end
    end
    if not def then return false end
    usages.jump(loc(def.path, 1))
    return true
  end
  local refs = d.refs or {}
  if #refs == 0 then
    say("No workflow step runs " .. d.id)
    return true
  end
  local locs = vim.tbl_map(function(r) return loc(r.path, r.line) end, refs)
  usages.show_locations(locs, {
    left = { { "Usages of ", "WsMenuTitle" }, { d.id, "WsMenuTitle" } },
    right = { { #locs .. (#locs == 1 and " step" or " steps"), "WsMenuKey" } },
  })
  return true
end

-- Abe's fixes on a line (1-based)
---@param buf integer
---@param lnum integer
---@return AbeFix[]
function M.fixes_at(buf, lnum)
  local out = {}
  for _, d in ipairs(vim.diagnostic.get(buf, { namespace = NS, lnum = lnum - 1 })) do
    for _, f in ipairs(d.user_data and d.user_data.fixes or {}) do out[#out + 1] = f end
  end
  return out
end

-- Changing the text ----------------------------------------------------------------------------------------------

---@param buf integer
local function clear_changed(buf) vim.api.nvim_buf_clear_namespace(buf, CHANGED, 0, -1) end

-- The whole file as text, one undo step; mark: highlight the lines that changed (until the next save or change)
---@param buf integer
---@param text string
---@param mark? boolean
function M.put_text(buf, text, mark)
  local old = text_of(buf)
  local lines = vim.split(text, "\n", { plain = true })
  if lines[#lines] == "" and #lines > 1 then table.remove(lines) end
  clear_changed(buf)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  if not mark then return end
  local hunks = vim.diff(old, table.concat(lines, "\n") .. "\n", { result_type = "indices" }) --[[@as integer[][] ]]
  for _, h in ipairs(hunks) do
    local start, count = h[3], h[4]
    for l = start, start + count - 1 do
      pcall(vim.api.nvim_buf_set_extmark, buf, CHANGED, l - 1, 0, { line_hl_group = "DiffAdd" })
    end
  end
end

---@param path string
local function open_here(path)
  vim.cmd.edit(vim.fn.fnameescape(path))
  return vim.api.nvim_get_current_buf()
end

-- Run fn on a buffer you can change: this one, else your copy (opened; made first when there's none)
---@param buf integer
---@param fn fun(target: integer)
-- The read-only original goes from the buffer list (its tab too) once your copy is open in its place; one still shown
-- in another split or changed stays
---@param buf integer
local function drop(buf)
  if not vim.api.nvim_buf_is_valid(buf) or buf == vim.api.nvim_get_current_buf() then return end
  if vim.bo[buf].modified or #vim.fn.win_findbuf(buf) > 0 then return end
  pcall(vim.api.nvim_buf_delete, buf, {})
end

function M.with_copy(buf, fn)
  local d = files[buf]
  if not d or not d.readOnly then return fn(buf) end
  if d.mine then
    local target = open_here(d.mine)
    drop(buf)
    return fn(target)
  end
  local path = vim.api.nvim_buf_get_name(buf)
  run(path, { "workflow", "copy", path }, function(res)
    if not res.ok or type(res.data) ~= "table" then
      return say(res.error and res.error.message or "Couldn't make your copy", vim.log.levels.WARN)
    end
    local target = open_here(res.data.path)
    drop(buf)
    say("Your copy in " .. tostring(res.data.layer) .. ": " .. vim.fn.fnamemodify(res.data.path, ":~:."))
    fn(target)
  end)
end

-- Actions ----------------------------------------------------------------------------------------------------

---@param buf? integer
function M.copy(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  M.with_copy(buf, function() end)
end

---@param buf? integer
function M.open_mine(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  local d = files[buf]
  if d and d.mine then
    open_here(d.mine)
    drop(buf)
  end
end

-- ⌘D: Compare with the other side (your copy beside the Layer's file it shadows) in the diff viewer, theirs left
---@param buf? integer
function M.compare(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  local c = files[buf] and files[buf].compare
  if not c then return say("Nothing to compare: no other Layer has it", vim.log.levels.WARN) end
  local file = { path = vim.fn.fnamemodify(c.mine, ":t"), abs = c.mine, status = "M", snapshot = c.theirs }
  require("git.diff").open({ file }, file, { old = c.layer == "yours" and "this Layer" or c.layer })
end

-- ⌘G: Change with AI (a farther Layer's file: into your copy)
---@param buf? integer
function M.change(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  if not files[buf] then return end
  local name = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ":t")
  vim.ui.input({ prompt = "Change " .. name .. " with AI" }, function(wish)
    if not wish or vim.trim(wish) == "" then return end
    M.with_copy(buf, function(target)
      local path = vim.api.nvim_buf_get_name(target)
      say("Changing " .. name .. "…")
      run(path, { "workflow", "change", path, wish, "--text", text_of(target) }, function(res)
        if not res.ok or type(res.data) ~= "table" then
          return say(res.error and res.error.message or "Nothing changed", vim.log.levels.WARN)
        end
        if not vim.api.nvim_buf_is_valid(target) then return end
        M.put_text(target, res.data.text, true)
        say(tostring(res.data.summary) .. " · ⌘S keeps · u undoes")
      end)
    end)
  end)
end

---@param buf? integer
function M.propose(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  local d = files[buf]
  if not d or not d.proposeTo then return end
  vim.ui.input({ prompt = "Why" }, function(why)
    if not why or vim.trim(why) == "" then return end
    local path = vim.api.nvim_buf_get_name(buf)
    run(path, { "workflow", "propose", path, "--why", why }, function(res)
      if not res.ok or type(res.data) ~= "table" then
        return say(res.error and res.error.message or "Couldn't propose it", vim.log.levels.WARN)
      end
      local pr = res.data.pr or {}
      if res.data.held then
        say(("Held on this machine (local mode): a proposal to %s"):format(tostring(res.data.where)))
      else
        say(("Proposed to %s: #%s %s"):format(tostring(res.data.where), tostring(pr.number), tostring(pr.url)))
      end
    end)
  end)
end

---@param buf? integer
function M.retro(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  if not files[buf] then return end
  local path = vim.api.nvim_buf_get_name(buf)
  say("Retro…")
  run(path, { "workflow", "retro", path }, function(res)
    if not res.ok then return say(res.error and res.error.message or "Retro failed", vim.log.levels.WARN) end
    local n = type(res.data) == "table" and res.data.findings and #res.data.findings or 0
    say(("Retro: %d finding%s"):format(n, n == 1 and "" or "s"))
    if vim.api.nvim_buf_is_valid(buf) then M.read(buf, true) end
  end)
end

-- A retro finding's fix (1-based) into the file (your copy)
---@param buf integer
---@param n integer
function M.retro_fix(buf, n)
  local d = files[buf]
  local f = d and d.retro and d.retro.findings and d.retro.findings[n]
  if not (f and f.fix and f.fix.text) then return say("That finding has no fix in the file", vim.log.levels.WARN) end
  M.with_copy(buf, function(target)
    M.put_text(target, f.fix.text, true)
    say(f.fix.summary .. " · ⌘S keeps · u undoes")
  end)
end

-- A preview link `abe:<action>` (config/app/markdown.lua's open_link); win: the source window
---@param win integer
---@param target string
---@return boolean handled
function M.open_link(win, target)
  local action = target:match("^abe:(.*)$")
  if not action then return false end
  if vim.api.nvim_win_is_valid(win) then vim.api.nvim_set_current_win(win) end
  local buf = vim.api.nvim_get_current_buf()
  local fix = action:match("^fix/(%d+)$")
  local line = action:match("^line/(%d+)$")
  if line then
    -- a step or a problem of the preview: the caret at its line in the source
    pcall(vim.api.nvim_win_set_cursor, 0, { tonumber(line) --[[@as integer]], 0 })
    vim.cmd.normal({ "zz", bang = true })
  elseif fix then
    M.retro_fix(buf, tonumber(fix) --[[@as integer]])
  elseif action == "copy" then
    M.copy(buf)
  elseif action == "mine" then
    M.open_mine(buf)
  elseif action == "change" then
    M.change(buf)
  elseif action == "propose" then
    M.propose(buf)
  elseif action == "retro" then
    M.retro(buf)
  elseif action == "compare" then
    M.compare(buf)
  end
  return true
end

-- ⌥⏎ on a line with Abe's fixes: them first, then More actions… (the LSP's). false: none here
---@return boolean
function M.code_actions()
  local buf = vim.api.nvim_get_current_buf()
  if not files[buf] then return false end
  local fixes = M.fixes_at(buf, vim.api.nvim_win_get_cursor(0)[1])
  if #fixes == 0 then return false end
  local items = {} ---@type MenuEntry[]
  for _, f in ipairs(fixes) do
    items[#items + 1] = { f.title, function()
      M.with_copy(buf, function(target)
        M.put_text(target, f.text, true)
        say(f.title .. " · ⌘S keeps · u undoes")
      end)
    end }
  end
  items[#items + 1] = "-"
  items[#items + 1] = { "More actions…", function()
    vim.lsp.buf.code_action({ filter = function(action) return not action.disabled end })
  end, enabled = #vim.lsp.get_clients({ bufnr = buf }) > 0 }
  require("config.menu").open(items, { icons = false })
  return true
end

-- The editor menu's items on a Layer's file (right-click, ⌘⏎, `:`)
---@param buf integer
---@return MenuEntry[]
function M.menu_items(buf)
  local d = files[buf]
  if not d then return {} end
  local items = { "-", { "Change with AI…", function() M.change(buf) end, key = "⌘G" } } ---@type MenuEntry[]
  if d.mine then
    items[#items + 1] = { "Open My Copy", function() M.open_mine(buf) end }
  elseif d.readOnly then
    items[#items + 1] = { "Edit My Copy", function() M.copy(buf) end }
  end
  if d.compare then
    local other = d.compare.layer == "yours" and "Mine" or d.compare.layer
    items[#items + 1] = { "Compare with " .. other, function() M.compare(buf) end, key = "⌘D" }
  end
  if d.proposeTo then
    items[#items + 1] = { "Propose a Change to " .. d.proposeTo .. "…", function() M.propose(buf) end }
  end
  items[#items + 1] = { "Retro…", function() M.retro(buf) end }
  return items
end

-- The tree's Abe node -------------------------------------------------------------------------------------------

local tree_seq = 0

---@class AbeTreeTag
---@field path string
---@field tag string
---@field bad boolean

-- The folders holding failing workflow files (`abe/`, `abe/workflows/`, `.abe/…`) tagged too, red with the
-- problems under them: a folded folder still says a file in it fails (abe tags a failing file `Repo’s · 2 problems`)
---@param tags AbeTreeTag[]
---@param root string
---@return AbeTreeTag[]
local function with_folders(tags, root)
  local under = {} ---@type table<string, integer>
  for _, t in ipairs(tags) do
    if t.bad and type(t.path) == "string" then
      local n = tonumber((t.tag or ""):match("(%d+) problems?$")) or 1
      local dir = vim.fs.dirname(t.path)
      while dir and #dir > #root and vim.startswith(dir, root .. "/") do
        under[dir] = (under[dir] or 0) + n
        dir = vim.fs.dirname(dir)
      end
    end
  end
  local out = vim.list_extend({}, tags)
  for dir, n in vim.spairs(under) do
    out[#out + 1] = { path = dir, tag = n .. (n == 1 and " problem" or " problems"), bad = true }
  end
  return out
end

-- `abe workflow tree` of the project to the Project tree: its `abe/` folder shown first, the workflow files' tags
-- (none outside a repo's main checkout)
function M.tree()
  tree_seq = tree_seq + 1
  local n = tree_seq
  local dir = vim.fn.getcwd()
  run(dir .. "/.", { "workflow", "tree" }, function(res)
    if n ~= tree_seq then return end
    local d = res.ok and type(res.data) == "table" and res.data or {}
    local tags = type(d.tags) == "table" and d.tags or {}
    local root = type(d.dir) == "string" and vim.fs.dirname(d.dir) or dir
    require("config.app.bridge").notify("tree", { event = "abe", dir = d.main == true and d.dir or nil,
      tags = with_folders(tags, root) })
  end)
end

local tree_timer = 0
-- The node again soon: a workflow or skill file was saved, made or removed
local function tree_later()
  tree_timer = tree_timer + 1
  local g = tree_timer
  vim.defer_fn(function() if g == tree_timer then M.tree() end end, DEBOUNCE)
end

-- The project's folder watched for what changes the node from outside the Editor: `abe/` made (the install's
-- Workflows part), a workflow or skill file written, made or removed by the Abe chat or a shell, `abe.yaml`
local watcher = nil ---@type uv.uv_fs_event_t?
local function watch()
  if watcher then watcher:stop() end
  watcher = vim.uv.new_fs_event()
  if not watcher then return end
  pcall(watcher.start, watcher, vim.fn.getcwd(), { recursive = true }, function(err, name)
    if err or not name then return end
    if name == "abe" or name == "abe.yaml" or name:find("^abe/workflows") or name:find("^abe/skills")
      or name:find("^%.abe/workflows") then
      vim.schedule(tree_later)
    end
  end)
end

function M.setup()
  -- a problem's message on a line of its own under the line it is at (not only the red wave)
  vim.diagnostic.config({ virtual_lines = { format = wrapped }, virtual_text = false }, NS)
  local group = vim.api.nvim_create_augroup("abe_workflow", { clear = true })
  -- a window's new width wraps its problems anew: checked as it draws, since the app resizing its grid (the
  -- preview opening beside it, the Chat column) fires no WinResized
  vim.api.nvim_set_decoration_provider(vim.api.nvim_create_namespace("abe_workflow_wrap"), {
    on_win = function(_, win, buf)
      if files[buf] and wrapped_at[buf] and wrapped_at[buf] ~= vim.fn.winwidth(win) and vim.fn.bufwinid(buf) == win then
        wrapped_at[buf] = nil
        vim.schedule(function()
          if vim.api.nvim_buf_is_valid(buf) and vim.fn.bufwinid(buf) ~= -1 then vim.diagnostic.show(NS, buf) end
        end)
      end
      return false
    end,
  })
  vim.api.nvim_create_autocmd({ "VimEnter", "DirChanged" }, {
    group = group,
    callback = function()
      M.tree()
      watch()
    end,
  })
  vim.api.nvim_create_autocmd("VimLeavePre", { group = group, callback = function() if watcher then watcher:stop() end end })
  vim.api.nvim_create_autocmd("BufWritePost", {
    group = group,
    callback = function(ev)
      local path = vim.api.nvim_buf_get_name(ev.buf)
      if M.looks_like(path) or path:match("/abe%.yaml$") then tree_later() end
    end,
  })
  -- the caret's step rings its card in the preview (config/app/markdown.lua)
  vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI", "BufEnter" }, {
    group = group,
    callback = function(ev)
      if files[ev.buf] and files[ev.buf].preview then require("config.app.markdown").caret(ev.buf) end
    end,
  })
  vim.api.nvim_create_autocmd({ "BufReadPost", "BufEnter", "BufWritePost" }, {
    group = group,
    callback = function(ev)
      if ev.event == "BufWritePost" then clear_changed(ev.buf) end
      if not_layer[ev.buf] and not_layer[ev.buf] ~= vim.api.nvim_buf_get_name(ev.buf) then not_layer[ev.buf] = nil end
      M.read(ev.buf, ev.event ~= "BufEnter")
    end,
  })
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = group,
    callback = function(ev) if files[ev.buf] then read_later(ev.buf) end end,
  })
  vim.api.nvim_create_autocmd("InsertEnter", {
    group = group,
    callback = function(ev)
      if vim.b[ev.buf].abe_read_only then
        M.tell_read_only()
        vim.schedule(function() vim.cmd.stopinsert() end)
      end
    end,
  })
  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group,
    callback = function(ev)
      files[ev.buf], seq[ev.buf], read_tick[ev.buf], not_layer[ev.buf], timers[ev.buf], wrapped_at[ev.buf] = nil, nil, nil, nil, nil, nil
    end,
  })
end

return M
