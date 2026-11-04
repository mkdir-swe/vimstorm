-- Merge conflicts, like WebStorm's merge window: your version | Result | their version.
-- Non-conflicting changes are already merged; each conflict starts as the base text (red).
-- Alt+Enter on a conflict: accept yours / theirs / both. Cmd+Ö / Cmd+L (ö down, l up): next / previous change.
-- Cmd+S saves the result and marks the file resolved once no conflicts are left.
-- The app draws the toolbar (arrows, ignore / highlight modes, Accept Left / Accept Right, conflict count,
-- Apply), the side headers and the gutters from config/app/diff.lua's description of this state.
-- ,w / ,q: close (asks before dropping unsaved work).
local cli = require("git.cli")
local diff = require("git.diff")
local gutter = require("git.gutter")
local scrollsync = require("git.scrollsync")
local shares = require("config.shares")

local M = {}
local NS = vim.api.nvim_create_namespace("git_merge")
local NS_HL = vim.api.nvim_create_namespace("git_merge_hl")

---@class GitConflict
---@field mark integer extmark in the result buffer
---@field yours string[]
---@field theirs string[]
---@field resolved boolean
---@field seq? integer the result's undo state that resolved it (undoing past it brings the conflict back)
---@field base? string[] the base text
---@field magic? string[] what "Resolve simple conflicts" puts there (the sides' changes don't overlap word by word)

---@class GitMergeState
---@field path string
---@field wins {yours: integer, result: integer, theirs: integer}
---@field bufs {yours: integer, result: integer, theirs: integer}
---@field conflicts GitConflict[]
---@field lines table<string, table<integer, integer>> side -> line -> conflict index
---@field prev_buf integer
---@field saved_wo table<string, any>
---@field sync? integer[] windows scrolling together
---@field texts {yours: string[], theirs: string[], base: string[]} whole sides (Accept Left / Right), the base (the app's chrome)
---@field names {yours: string, theirs: string} branch names (headers)
---@field shares? Shares the sides' shares of their width, left to right (config/shares.lua)
local state = nil ---@type GitMergeState?
-- The sides' shares the last merge window was left at (a divider dragged; this Neovim session)
local last_shares = nil ---@type number[]?

local SAVED = { "statuscolumn", "number", "signcolumn", "foldcolumn", "fillchars", "winhighlight", "winbar", "foldenable", "foldmethod", "foldtext", "foldlevel", "cursorline", "scrollbind", "cursorbind" }

local function split(text)
  return vim.split((text or ""):gsub("\n$", ""), "\n", { plain = true })
end

local HEADS = { "MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD" }

-- git output open() needs, fetched in parallel (one after the other it was ~60 ms): the three
-- stages of the file and the branch names for the headers
---@return string? yours, string? base, string? theirs, string yours_name, string theirs_name
local function fetch(path)
  local cmds = {
    yours = { "show", ":2:" .. path }, base = { "show", ":1:" .. path }, theirs = { "show", ":3:" .. path },
    branch = { "branch", "--show-current" },
  }
  for _, head in ipairs(HEADS) do cmds[head] = { "name-rev", "--name-only", "--exclude=tags/*", head } end
  local out = diff.git_all(cmds)
  local yours_name = vim.trim(out.branch or "")
  local theirs_name = "theirs"
  for _, head in ipairs(HEADS) do
    if out[head] then
      theirs_name = vim.trim(out[head])
      break
    end
  end
  return out.yours, out.base, out.theirs, yours_name ~= "" and yours_name or "HEAD", theirs_name
end

-- Result text: git's merge with each conflict replaced by the base text
---@return string[] lines, {start: integer, count: integer, yours: string[], theirs: string[]}[] conflicts
local function build(yours, base, theirs)
  local dir = vim.fn.tempname()
  vim.fn.mkdir(dir, "p")
  local files = {}
  for name, text in pairs({ yours = yours, base = base, theirs = theirs }) do
    files[name] = dir .. "/" .. name
    vim.fn.writefile(split(text), files[name])
  end
  local r = vim.system({ "git", "merge-file", "-p", "--diff3", "-L", "yours", "-L", "base", "-L", "theirs", files.yours, files.base, files.theirs }, { text = true }):wait()
  vim.fn.delete(dir, "rf")
  local lines, conflicts = {}, {}
  local cur, section
  for _, l in ipairs(split(r.stdout)) do
    if l == "<<<<<<< yours" then
      cur, section = { yours = {}, base = {}, theirs = {} }, "yours"
    elseif cur and l == "||||||| base" then
      section = "base"
    elseif cur and l == "=======" then
      section = "theirs"
    elseif cur and l == ">>>>>>> theirs" then
      conflicts[#conflicts + 1] = { start = #lines, count = #cur.base, yours = cur.yours, theirs = cur.theirs, base = cur.base }
      vim.list_extend(lines, cur.base)
      cur = nil
    elseif cur then
      table.insert(cur[section], l)
    else
      lines[#lines + 1] = l
    end
  end
  return lines, conflicts
end

-- Words, runs of blanks, line ends and single other characters: the units "Resolve simple conflicts" merges
---@param lines string[]
---@return string[]
local function split_tokens(lines)
  local out = {}
  for i, l in ipairs(lines) do
    local pos = 1
    while pos <= #l do
      local a, b = l:find("^[%w_]+", pos)
      if not a then a, b = l:find("^[ \t]+", pos) end
      if not a then
        -- one UTF-8 character
        local c = l:byte(pos)
        local n = c >= 0xF0 and 4 or c >= 0xE0 and 3 or c >= 0xC0 and 2 or 1
        a, b = pos, pos + n - 1
      end
      out[#out + 1] = l:sub(a, b)
      pos = b + 1
    end
    if i < #lines then out[#out + 1] = "\1" end -- the line end, a token of its own
  end
  return out
end

-- WebStorm's "Resolve simple conflicts" (magic wand): each conflict merged again token by token (git
-- merge-file with one token per line); where both sides' changes don't touch the same tokens it merges
-- cleanly and that's the conflict's resolution. All conflicts' merges run at once.
---@param list {yours: string[], base: string[], theirs: string[]}[]
---@return (string[]|false)[] resolution per conflict
local function simple_resolutions(list)
  local dir = vim.fn.tempname()
  vim.fn.mkdir(dir, "p")
  local jobs = {}
  for i, c in ipairs(list) do
    local files = {}
    for _, side in ipairs({ "yours", "base", "theirs" }) do
      files[side] = ("%s/%d.%s"):format(dir, i, side)
      vim.fn.writefile(split_tokens(c[side]), files[side])
    end
    jobs[i] = vim.system({ "git", "merge-file", "-p", files.yours, files.base, files.theirs }, { text = true })
  end
  local out = {}
  for i, job in ipairs(jobs) do
    local r = job:wait()
    if r.code == 0 then
      local text = table.concat(split(r.stdout), "")
      out[i] = vim.split(text, "\1", { plain = true })
    else
      out[i] = false
    end
  end
  vim.fn.delete(dir, "rf")
  return out
end

local function scratch(name, lines, path, modifiable)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, name)
  vim.bo[buf].undolevels = -1 -- the starting text isn't a change: Cmd+Z can't empty the result
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].undolevels = -123456 -- the global value again
  vim.bo[buf].modifiable = modifiable
  vim.bo[buf].bufhidden = "wipe"
  local ft = vim.filetype.match({ filename = path })
  local lang = ft and vim.treesitter.language.get_lang(ft)
  if lang then pcall(vim.treesitter.start, buf, lang) end
  return buf
end

---@return integer start, integer end_ 0-based [start, end_)
local function range(c)
  local s = assert(state)
  local m = vim.api.nvim_buf_get_extmark_by_id(s.bufs.result, NS, c.mark, { details = true })
  return m[1], m[3].end_row or m[1]
end

-- Undo states in effect in buf: the current one and everything before it on its branch of the undo tree
---@return table<integer, boolean>
local function applied(buf)
  local tree = vim.fn.undotree(buf)
  local cur, found = tree.seq_cur, nil
  local function walk(entries, before)
    for i, e in ipairs(entries) do
      if e.seq == cur then
        found = vim.deepcopy(before)
        found[e.seq] = true
        return true
      end
      if e.alt and walk(e.alt, before) then return true end
      before[e.seq] = true
    end
    for _, e in ipairs(entries) do before[e.seq] = nil end
  end
  walk(tree.entries, {})
  return found or {}
end

-- Undo / redo in the result: a conflict is resolved while the change that resolved it is in effect
local function sync_resolved()
  local s = state
  if not (s and vim.api.nvim_buf_is_valid(s.bufs.result)) then return end
  local done
  for _, c in ipairs(s.conflicts) do
    if c.seq and c.seq > 0 then
      done = done or applied(s.bufs.result)
      c.resolved = done[c.seq] == true
    end
  end
end

local function unresolved()
  sync_resolved()
  return vim.tbl_filter(function(c) return not c.resolved end, state and state.conflicts or {})
end

-- Does a change at [hs, he) touch the range [a, b)? (0-based, either may be empty)
local function touches(hs, he, a, b)
  if hs == he then return hs >= a and hs <= b end
  if a == b then return a >= hs and a <= he end
  return hs < b and he > a
end

-- Conflict lines of a side: the side's part of each change touching a conflict
---@param ranges table<integer, integer[]> conflict index -> {first, last} in the result
local function side_lines(buf, ranges)
  local s = assert(state)
  local changes = scrollsync.changes(s.bufs.result, buf)
  local out = {}
  for i, r in pairs(ranges) do
    for _, h in ipairs(changes) do
      local hs = h[2] == 0 and h[1] or h[1] - 1
      if touches(hs, hs + h[2], r[1], r[2]) then
        for l = h[3], h[3] + h[4] - 1 do out[l] = i end
      end
    end
  end
  return out
end

-- gutter number highlight -> line color
local LINE_HL = { GitDiffConflictNr = "GitDiffConflict", GitDiffChangedNr = "GitDiffChanged", GitDiffInsertedNr = "GitDiffInserted" }
-- diff mode's line colors off: paint() colors the lines
local WINHL = "Folded:GitDiffFolded,DiffDelete:GitDiffFiller,DiffAdd:GitMergeLine,DiffChange:GitMergeLine,DiffText:GitMergeLine,DiffTextAdd:GitMergeLine,WinSeparator:GitDiffSep"

-- Conflict lines on every side (red), gutters, header
local function paint()
  local s = state
  if not s then return end
  for _, w in pairs(s.wins) do
    if not vim.api.nvim_win_is_valid(w) then return end
  end
  sync_resolved() -- undo / redo
  local ranges, result = {}, {}
  for i, c in ipairs(s.conflicts) do
    if not c.resolved then
      local first, last = range(c)
      ranges[i] = { first, last }
      for l = first + 1, last do result[l] = i end
    end
  end
  s.lines = { yours = side_lines(s.bufs.yours, ranges), result = result, theirs = side_lines(s.bufs.theirs, ranges) }
  for name, w in pairs(s.wins) do
    gutter.update(w)
    -- line colors from the gutter's kinds (conflicts red): diff mode's own colors are off in these
    -- windows (winhighlight), they'd win over any extmark on the text and leave conflicts red only
    -- after the end of the line
    local buf = s.bufs[name]
    vim.api.nvim_buf_clear_namespace(buf, NS_HL, 0, -1)
    local g = gutter.wins[w]
    for l, li in pairs(g and g.lines or {}) do
      local hl = LINE_HL[li.hl]
      if hl then
        vim.api.nvim_buf_set_extmark(buf, NS_HL, l - 1, 0, {
          end_row = l, end_col = 0, hl_group = hl, hl_eol = true, priority = 150, strict = false,
        })
      end
    end
  end
  require("config.app.diff").changed()
end

-- paint() once after a burst of changes (TextChanged + DiffUpdated come together)
local paint_queued = false
local function paint_later()
  if paint_queued then return end
  paint_queued = true
  vim.schedule(function()
    paint_queued = false
    paint()
  end)
end

-- Accept Left / Accept Right: the whole file from that side, saved and resolved
---@param side "yours"|"theirs"
function M.accept_all(side)
  local s = state
  if not s then return end
  vim.api.nvim_buf_set_lines(s.bufs.result, 0, -1, false, s.texts[side])
  local seq = vim.fn.undotree(s.bufs.result).seq_cur
  for _, c in ipairs(s.conflicts) do c.resolved, c.seq = true, seq end
  M.save(true)
end

local function jump(keys)
  return function()
    local s = state
    if not s then return end
    local win = M.is_focused() and vim.api.nvim_get_current_win() or s.wins.result
    vim.api.nvim_win_call(win, function() pcall(vim.cmd, "normal! " .. keys) end)
    -- the other sides follow now, not after the next screen update
    scrollsync.sync(win)
  end
end

-- Toolbar arrows, Cmd+L / Cmd+Ö, the menu: -1 previous, 1 next change
---@param dir integer
function M.jump(dir)
  jump(dir > 0 and "]c" or "[c")()
end

-- Conflict under the cursor on any side
---@return integer?
local function current()
  local s = state
  if not s then return end
  local win = vim.api.nvim_get_current_win()
  local lnum = vim.api.nvim_win_get_cursor(win)[1]
  for name, w in pairs(s.wins) do
    if w == win and s.lines[name][lnum] then return s.lines[name][lnum] end
  end
  if win ~= s.wins.result then return end
  -- an empty conflict sits between two lines
  for i, c in ipairs(s.conflicts) do
    local first, last = range(c)
    if not c.resolved and first == last and (lnum == first or lnum == first + 1) then return i end
  end
end

-- Conflict i resolved (lines: its new text; nil: Mark as Resolved keeps the result's text). The last one
-- offers Save and finish.
---@param i integer
---@param lines? string[]
---@param more? boolean more resolutions follow (one prompt after the last)
local function resolve(i, lines, more)
  local s = assert(state)
  local c = s.conflicts[i]
  if lines then
    local first, last = range(c)
    vim.api.nvim_buf_set_lines(s.bufs.result, first, last, false, lines)
  end
  c.resolved, c.seq = true, vim.fn.undotree(s.bufs.result).seq_cur
  if more then return end
  vim.schedule(function()
    paint()
    if #unresolved() == 0 then
      vim.ui.select({ "Save and finish", "Keep editing" }, { prompt = "All conflicts resolved" }, function(choice)
        if choice == "Save and finish" then M.save(true) end
      end)
    end
  end)
end

M.resolve = resolve

-- Line colors, gutters, toolbar again (after an ignore / highlight mode change)
function M.repaint()
  pcall(vim.cmd, "diffupdate")
  paint()
end

-- The open merge's state (config/app/diff.lua describes it to the app)
---@return GitMergeState?
function M.state()
  return state
end

-- Conflict's lines in the result, 0-based [start, end)
M.range = range

-- Accept a side for conflict i (the app's » / « in the gutter)
---@param i integer
---@param side "yours"|"theirs"
function M.accept(i, side)
  local c = state and state.conflicts[i]
  if c and not c.resolved then resolve(i, c[side]) end
end

-- Ignore both sides of conflict i: resolved, the result keeps its text (the app's × in the gutter)
---@param i integer
function M.ignore(i)
  local c = state and state.conflicts[i]
  if c and not c.resolved then resolve(i) end
end

-- Resolve conflict i automatically (its sides' changes don't overlap word by word)
---@param i integer
function M.magic(i)
  local c = state and state.conflicts[i]
  if c and not c.resolved and c.magic then resolve(i, c.magic) end
end

-- Resolve simple conflicts: every one that can be merged word by word
function M.magic_all()
  local s = state
  if not s then return end
  local todo = vim.tbl_filter(function(i) return not s.conflicts[i].resolved and s.conflicts[i].magic end, vim.tbl_keys(s.conflicts))
  table.sort(todo)
  if #todo == 0 then return vim.notify("No simple conflicts", vim.log.levels.INFO, { title = "Merge" }) end
  for n, i in ipairs(todo) do resolve(i, s.conflicts[i].magic, n < #todo) end
end

-- Conflicts "Resolve simple conflicts" can do
function M.simple()
  return vim.tbl_filter(function(c) return not c.resolved and c.magic end, state and state.conflicts or {})
end

-- How to resolve conflict i (theirs first on their side)
---@return MenuEntry[]
local function conflict_items(i)
  local s = assert(state)
  local c = s.conflicts[i]
  local items = {
    { "Accept Yours", function() resolve(i, c.yours) end },
    { "Accept Theirs", function() resolve(i, c.theirs) end },
    { "Accept Yours, then Theirs", function() resolve(i, vim.list_extend(vim.deepcopy(c.yours), c.theirs)) end },
    { "Accept Theirs, then Yours", function() resolve(i, vim.list_extend(vim.deepcopy(c.theirs), c.yours)) end },
    { "Mark as Resolved (keep Result)", function() resolve(i) end },
  }
  if c.magic then table.insert(items, 5, { "Resolve Automatically", function() resolve(i, c.magic) end }) end
  if vim.api.nvim_get_current_win() == s.wins.theirs then items[1], items[2] = items[2], items[1] end
  return items
end

-- Alt+Enter: how to resolve the conflict under the cursor
function M.menu()
  local i = current()
  if not (state and i) then return vim.notify("No conflict here", vim.log.levels.INFO, { title = "Merge" }) end
  require("config.menu").open(conflict_items(i), { title = "Conflict" })
end

-- Right-click / Cmd+Enter in the merge window
---@param win integer
---@return MenuEntry[]?
function M.menu_items(win)
  local s = state
  if not (s and (win == s.wins.yours or win == s.wins.result or win == s.wins.theirs)) then return end
  local i = current()
  local items = i and conflict_items(i) or {}
  if i then items[#items + 1] = "-" end
  vim.list_extend(items, {
    { "Next Change", function() M.jump(1) end, key = "⌘Ö" },
    { "Previous Change", function() M.jump(-1) end, key = "⌘L" },
    "-",
    { "Save", function() M.save(false) end, key = "⌘S", enabled = #unresolved() == 0 },
    { "Save and Finish", function() M.save(true) end, enabled = #unresolved() == 0 },
    { "Resolve Simple Conflicts", M.magic_all, enabled = #M.simple() > 0 },
    { "Accept Left (Whole File)", function() M.accept_all("yours") end },
    { "Accept Right (Whole File)", function() M.accept_all("theirs") end },
    { "Open in Editor", M.open_in_editor, key = "F4" },
    { "Close", function() M.close() end, key = ",w" },
  })
  return items
end
require("config.menu").provider(20, function(win) return M.menu_items(win) end)

-- Write the result; with no conflicts left the file is marked resolved (git add)
function M.save(finish)
  local s = state
  if not s then return end
  local n = #unresolved()
  if n > 0 then
    return vim.notify(n .. " conflict(s) left", vim.log.levels.WARN, { title = "Merge" })
  end
  vim.fn.writefile(vim.api.nvim_buf_get_lines(s.bufs.result, 0, -1, false), cli.root .. "/" .. s.path)
  vim.bo[s.bufs.result].modified = false
  cli.act({ "add", "--", s.path }, "Resolved " .. s.path)
  if finish then M.close(true) end
end

function M.is_active()
  return state ~= nil
end

-- Merge windows, the result first
function M.wins()
  return state and { state.wins.result, state.wins.yours, state.wins.theirs } or {}
end

function M.is_focused()
  if not state then return false end
  local w = vim.api.nvim_get_current_win()
  return w == state.wins.yours or w == state.wins.result or w == state.wins.theirs
end

-- Test hook: conflict index under the cursor
M.current = current

-- The divider double-clicked: three equally wide sides again
function M.equal_widths()
  local s = state
  if not (s and s.shares) then return end
  shares.reset(s.shares)
  last_shares = nil
end

---@param file GitFile
function M.open(file)
  local path = file.path
  local yours, base, theirs, yours_name, theirs_name = fetch(path)
  if not (yours and theirs) then
    -- deleted on one side: keep a whole version
    return vim.ui.select({ "Keep Yours", "Keep Theirs" }, { prompt = path .. " was deleted on one side" }, function(choice)
      if not choice then return end
      local keep_yours = choice == "Keep Yours"
      if (keep_yours and yours) or (not keep_yours and theirs) then
        cli.run({ "checkout", keep_yours and "--ours" or "--theirs", "--", path })
        cli.act({ "add", "--", path }, "Resolved " .. path)
      else
        cli.act({ "rm", "-q", "--", path }, "Resolved " .. path)
      end
    end)
  end
  if state then M.close(true) end
  if diff.is_active() then diff.close() end
  local code = require("config.focus").split_win()
  if not code then return end

  local work = table.concat(vim.fn.readfile(cli.root .. "/" .. path), "\n")
  local lines, conflicts
  if work:find("^<<<<<<< ") or work:find("\n<<<<<<< ") then
    lines, conflicts = build(yours, base or "", theirs)
  else
    lines, conflicts = split(work), {} -- already edited by hand: review and save
  end
  local names = { yours = yours_name, theirs = theirs_name }

  local saved = {}
  for _, o in ipairs(SAVED) do saved[o] = vim.wo[code][o] end
  local bufs = {
    yours = scratch("gitmerge://yours/" .. path, split(yours), path, false),
    result = scratch("gitmerge://result/" .. path, lines, path, true),
    theirs = scratch("gitmerge://theirs/" .. path, split(theirs), path, false),
  }
  local result = bufs.result
  vim.bo[result].buftype = "acwrite"
  vim.bo[result].modified = false
  vim.api.nvim_create_autocmd("BufWriteCmd", { buffer = result, callback = function() M.save(false) end })
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    buffer = result,
    callback = paint_later,
  })

  local prev_buf = vim.api.nvim_win_get_buf(code)
  local yours_win = vim.api.nvim_open_win(bufs.yours, false, { split = "left", win = code })
  local theirs_win = vim.api.nvim_open_win(bufs.theirs, false, { split = "right", win = code })
  vim.api.nvim_win_set_buf(code, result)
  local s = {
    path = path,
    wins = { yours = yours_win, result = code, theirs = theirs_win },
    bufs = bufs,
    conflicts = {},
    lines = { yours = {}, result = {}, theirs = {} },
    prev_buf = prev_buf,
    saved_wo = saved,
    texts = { yours = split(yours), theirs = split(theirs), base = split(base or "") },
    names = names,
  }
  state = s
  local magic = #conflicts > 0 and simple_resolutions(conflicts) or {}
  for i, c in ipairs(conflicts) do
    local mark = vim.api.nvim_buf_set_extmark(result, NS, c.start, 0, {
      end_row = c.start + c.count, end_col = 0, right_gravity = false, end_right_gravity = true,
    })
    table.insert(s.conflicts, { mark = mark, yours = c.yours, theirs = c.theirs, base = c.base, resolved = false, magic = magic[i] or nil })
  end
  s.shares = shares.new({ yours_win, code, theirs_win }, last_shares)

  s.sync = { yours_win, code, theirs_win }
  scrollsync.add(s.sync)
  for name, w in pairs(s.wins) do
    vim.api.nvim_win_call(w, function() vim.cmd("diffthis") end)
    local wo = vim.wo[w]
    wo.number, wo.signcolumn, wo.foldcolumn, wo.cursorline = false, "no", "0", false
    wo.scrollbind, wo.cursorbind = false, false -- git/scrollsync.lua scrolls the sides together
    -- whole file shown; zM / the menu folds unchanged code to a wavy line
    wo.foldenable, wo.foldlevel, wo.foldtext = false, 0, "v:lua.require'git.diff'.foldtext()"
    wo.fillchars = diff.FILL
    wo.winhighlight = WINHL
    vim.keymap.set("n", "<M-CR>", M.menu, { buffer = bufs[name], desc = "Resolve conflict" })
    -- Cmd+S saves the result also when it has no edits (conflicts only marked resolved): `wall` skips an
    -- unmodified buffer
    vim.keymap.set({ "n", "i", "x" }, "<D-s>", function()
      local edited = vim.bo[result].modified
      require("config.app.agent_files").save_all() -- other files, and an edited result (BufWriteCmd)
      if not edited then M.save(false) end
    end, { buffer = bufs[name], desc = "Save the result" })
    diff.map_jumps(bufs[name], M.jump) -- scratch buffers: gone with the merge window
  end
  local function conflict(name)
    return function(l) return state ~= nil and state.lines[name][l] ~= nil end
  end
  gutter.attach(yours_win, { only_hl = "GitDiffInsertedNr", conflict = conflict("yours") })
  gutter.attach(code, { only_hl = "GitDiffInsertedNr", conflict = conflict("result") })
  gutter.attach(theirs_win, { only_hl = "GitDiffInsertedNr", conflict = conflict("theirs") })
  for _, w in ipairs({ yours_win, code, theirs_win }) do vim.wo[w].winbar = "" end -- native headers
  vim.api.nvim_set_current_win(code)
  paint()
  local first = s.conflicts[1]
  if first then
    pcall(vim.api.nvim_win_set_cursor, code, { range(first) + 1, 0 })
    -- the sides follow now, not on the WinScrolled after the first screen update (a frame apart)
    scrollsync.sync(code)
  end
end

---@param force? boolean close without asking about unsaved changes
function M.close(force)
  local s = state
  if not s then return end
  if not force and vim.api.nvim_buf_is_valid(s.bufs.result) and vim.bo[s.bufs.result].modified then
    return vim.ui.select({ "Discard", "Cancel" }, { prompt = "Discard the merge result?" }, function(choice)
      if choice == "Discard" then M.close(true) end
    end)
  end
  local was_in = M.is_focused()
  state = nil
  -- discarding: else hiding the modified result (bufhidden=wipe) asks "Save changes?" on top
  if vim.api.nvim_buf_is_valid(s.bufs.result) then vim.bo[s.bufs.result].modified = false end
  if s.sync then scrollsync.remove(s.sync) end
  require("config.app.diff").changed()
  pcall(vim.cmd, "diffoff!")
  for _, w in ipairs({ s.wins.yours, s.wins.theirs }) do
    if vim.api.nvim_win_is_valid(w) then vim.api.nvim_win_close(w, true) end
  end
  local code = s.wins.result
  if vim.api.nvim_win_is_valid(code) then
    gutter.detach(code)
    gutter.detach(s.wins.yours)
    gutter.detach(s.wins.theirs)
    for o, v in pairs(s.saved_wo) do vim.wo[code][o] = v end
    if vim.api.nvim_buf_is_valid(s.prev_buf) then
      vim.api.nvim_win_set_buf(code, s.prev_buf)
    else
      vim.api.nvim_win_set_buf(code, vim.api.nvim_create_buf(true, false))
    end
    if was_in then vim.api.nvim_set_current_win(code) end
  end
  if vim.api.nvim_buf_is_valid(s.bufs.result) then vim.api.nvim_buf_delete(s.bufs.result, { force = true }) end
end

-- F4: open the file itself
function M.open_in_editor()
  local s = state
  if not s then return end
  if vim.bo[s.bufs.result].modified then
    return vim.notify("Save the result first (Cmd+S)", vim.log.levels.INFO, { title = "Merge" })
  end
  M.close(true)
  vim.cmd.edit(vim.fn.fnameescape(cli.root .. "/" .. s.path))
end

vim.api.nvim_create_autocmd("DiffUpdated", {
  callback = function()
    if state then paint_later() end
  end,
})
-- window resized, tree opened / closed: the sides keep their shares; a divider dragged (or <C-w>< / >,
-- :vertical resize) sets new ones
vim.api.nvim_create_autocmd("WinResized", {
  callback = function()
    local s = state
    if s and s.shares and shares.update(s.shares) then last_shares = s.shares.shares end
  end,
})
vim.api.nvim_create_autocmd("WinClosed", {
  callback = function(args)
    local s = state
    local win = tonumber(args.match)
    if s and (win == s.wins.yours or win == s.wins.theirs) then
      vim.schedule(function() M.close(true) end)
    end
  end,
})

-- no tabs of its own: Alt+Cmd+Left/Right goes on to the editor tabs
require("config.focus").register("merge", { is_focused = M.is_focused, close = M.close, is_active = M.is_active, wins = M.wins })

return M
