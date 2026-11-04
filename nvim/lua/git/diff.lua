-- Side-by-side diff in the code area, like WebStorm's diff tab: two nvim panes (old revision | current
-- version), changed words highlighted inside changed lines. The app draws the toolbar, pane headers,
-- gutters and scrollbar marks from config/app/diff.lua's description of this state.
-- Cmd+Ö / Cmd+L (ö down, l up): next / previous change. Alt+Cmd+Left/Right: previous / next file.
-- F4: open the file in the editor. Cmd+R: revert the change under the cursor
-- (local changes only). ,w / ,q: close. Right-click: menu.
local cli = require("git.cli")
local focus = require("config.focus")
local menu = require("config.menu")
local gutter = require("git.gutter")
local scrollsync = require("git.scrollsync")
local shares = require("config.shares")

local M = {}

---@class GitDiffState
---@field files GitFile[]
---@field index integer
---@field revs {old: string, new?: string} new = nil means the working tree
---@field old_win integer
---@field new_win integer
---@field prev_buf integer buffer the code window showed before
---@field new_buf? integer
---@field saved_wo table<string, any> code window options before the diff
---@field sync integer[] windows scrolling together
---@field count? integer differences in the current file
---@field short table<string, string> rev -> 8-char hash (headers), per open
---@field mapped table<integer, boolean> buffers with the Cmd+L / Cmd+Ö maps
---@field review? {pr: integer} a PR under review (the Git Log's PR filter): the `,i` keys (config/app/review.lua) work
---@field shares Shares the panes' shares of their width (config/shares.lua)
local state = nil ---@type GitDiffState?
-- The panes' shares the last viewer was left at (its divider dragged; this Neovim session): the next one opens so
local last_shares = nil ---@type number[]?

-- WebStorm colors: lines only on the old side are deleted (grey), only on the new side
-- inserted (green); filler rows stay blank
local OLD_HL = "Folded:GitDiffFolded,DiffAdd:GitDiffDeleted,DiffDelete:GitDiffFiller,DiffChange:GitDiffChanged,DiffText:GitDiffText,DiffTextAdd:GitDiffDeleted,WinSeparator:GitDiffSep"
local NEW_HL = "Folded:GitDiffFolded,DiffAdd:GitDiffInserted,DiffDelete:GitDiffFiller,DiffChange:GitDiffChanged,DiffText:GitDiffText,DiffTextAdd:GitDiffInserted,WinSeparator:GitDiffSep"
-- blank pane separator, so no junctions on it either
local FILL = "diff: ,eob: ,vert: ,fold: ,horiz:▁,horizdown: ,horizup:▁,vertleft: ,vertright: ,verthoriz:▁"
local SAVED = { "statuscolumn", "number", "signcolumn", "foldcolumn", "fillchars", "winhighlight", "winbar", "foldenable", "foldmethod", "foldtext", "foldlevel", "cursorline", "scrollbind", "cursorbind" }
M.OLD_HL, M.NEW_HL, M.FILL = OLD_HL, NEW_HL, FILL

-- The app's description of the viewer (toolbar, headers, gutters) is out of date
local function changed() require("config.app.diff").changed() end

-- Toolbar dropdowns: WebStorm's whitespace / highlighting modes, as 'diffopt' flags
local IGNORE = {
  { "Do not ignore", {} },
  { "Trim whitespaces", { "iwhiteeol" } },
  { "Ignore whitespaces", { "iwhiteall" } },
  { "Ignore whitespaces and empty lines", { "iwhiteall", "iblank" } },
}
local HIGHLIGHT = {
  { "Highlight lines", "inline:none" },
  { "Highlight words", "inline:word" },
  { "Highlight characters", "inline:char" },
}
M.IGNORE, M.HIGHLIGHT = IGNORE, HIGHLIGHT
-- WebStorm's default: changed words inside changed lines
vim.opt.diffopt:remove({ "inline:none", "inline:simple", "inline:char" })
vim.opt.diffopt:append("inline:word")

local function has(flag) return vim.tbl_contains(vim.opt.diffopt:get(), flag) end

function M.ignore_mode()
  for i = #IGNORE, 2, -1 do
    if vim.iter(IGNORE[i][2]):all(has) then return IGNORE[i][1] end
  end
  return IGNORE[1][1]
end

function M.highlight_mode()
  for _, h in ipairs(HIGHLIGHT) do
    if has(h[2]) then return h[1] end
  end
  return "Highlight words"
end

---@param name string
function M.set_ignore(name)
  vim.opt.diffopt:remove({ "iwhite", "iwhiteall", "iwhiteeol", "iblank" })
  for _, m in ipairs(IGNORE) do
    if m[1] == name then vim.opt.diffopt:append(m[2]) end
  end
  M.refresh()
end

---@param name string
function M.set_highlight(name)
  vim.opt.diffopt:remove({ "inline:none", "inline:simple", "inline:char", "inline:word" })
  for _, m in ipairs(HIGHLIGHT) do
    if m[1] == name then vim.opt.diffopt:append(m[2]) end
  end
  M.refresh()
end

-- Menu of choices with a check on the current one
---@param choices {[1]: string}[]
---@param current string
---@param pick fun(name: string)
---@param pos? {x: number, y: number} app: below the native toolbar's dropdown (window px)
function M.choose(choices, current, pick, pos)
  local items = {}
  for _, ch in ipairs(choices) do
    items[#items + 1] = { (ch[1] == current and "\u{2713} " or "   ") .. ch[1], function() pick(ch[1]) end }
  end
  menu.open(items, { at = "mouse", pos = pos })
end

-- Cmd+L / Cmd+Ö: previous / next difference (l up, ö down), in normal and visual mode. Buffer-local, so
-- they win over the editor's own Cmd+L; the current version is the real file, so they come off again
-- when a buffer leaves the diff (unmap_jumps).
local JUMP_KEYS = { ["<D-l>"] = -1, ["<D-ö>"] = 1 }

---@param buf integer
---@param fn fun(dir: integer) -1 previous, 1 next
function M.map_jumps(buf, fn)
  for lhs, dir in pairs(JUMP_KEYS) do
    vim.keymap.set({ "n", "x" }, lhs, function()
      if vim.fn.mode():match("^[vV\22]") then vim.cmd("normal! \27") end
      fn(dir)
    end, { buffer = buf, nowait = true, desc = dir > 0 and "Next difference" or "Previous difference" })
  end
end

---@param buf integer
function M.unmap_jumps(buf)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  for lhs in pairs(JUMP_KEYS) do
    for _, mode in ipairs({ "n", "x" }) do pcall(vim.keymap.del, mode, lhs, { buffer = buf }) end
  end
end

---@param s GitDiffState
---@param keep? table<integer, boolean>
local function unmap_all(s, keep)
  for b in pairs(s.mapped or {}) do
    if not (keep and keep[b]) then
      M.unmap_jumps(b)
      s.mapped[b] = nil
    end
  end
end

local function scratch_name(rev, path)
  return ("gitdiff://%s/%s"):format(rev, path)
end

local function existing(rev, path)
  local b = vim.fn.bufnr("^" .. vim.fn.escape(scratch_name(rev, path), "\\.*$^~[]") .. "$")
  return b ~= -1 and b or nil
end

---@param buf integer
---@param text string
local function fill(buf, text)
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(text:gsub("\n$", ""), "\n", { plain = true }))
  vim.bo[buf].modifiable = false
end

-- Read-only buffer with a file's text at a revision (text: prefetched `git show` output)
local function scratch(rev, path, text)
  local buf = existing(rev, path)
  if buf then return buf end
  buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(buf, scratch_name(rev, path))
  fill(buf, text or (rev ~= "" and cli.show(rev, path) or ""))
  vim.bo[buf].bufhidden = "wipe"
  -- Highlight without setting filetype (keeps LSP away from these buffers)
  local ft = vim.filetype.match({ filename = path })
  local lang = ft and vim.treesitter.language.get_lang(ft)
  if lang then pcall(vim.treesitter.start, buf, lang) end
  return buf
end

-- Several git commands at once (in parallel, ~10 ms each when run one after the other);
-- stdout of each, nil when it failed
---@param cmds table<string, string[]>
---@return table<string, string?>
function M.git_all(cmds)
  local jobs, out = {}, {}
  for k, args in pairs(cmds) do
    jobs[k] = vim.system(vim.list_extend({ "git" }, args), { cwd = cli.root, text = true })
  end
  for k, job in pairs(jobs) do
    local r = job:wait()
    out[k] = r.code == 0 and r.stdout or nil
  end
  return out
end

-- Number of changes: diff mode's, counted from the same diff (xdiff with 'diffopt''s flags)
-- instead of walking them with ]c (cursor moves in the pane, and it ran on every change)
-- (the ]c walk also counted a lone change on line 1 twice: "2 differences" for every added file)
local function differences(s)
  if not (vim.api.nvim_win_is_valid(s.old_win) and vim.api.nvim_win_is_valid(s.new_win)) then return 0 end
  local status = s.files[s.index].status
  if status == "A" or status == "?" or status == "D" then return 1 end -- one side empty: one change
  local old_buf, new_buf = vim.api.nvim_win_get_buf(s.old_win), vim.api.nvim_win_get_buf(s.new_win)
  return #scrollsync.changes(old_buf, new_buf, scrollsync.diffopt())
end

-- Recount after diffopt changes
function M.refresh()
  local s = state
  if not s then return end
  pcall(vim.cmd, "diffupdate")
  s.count = differences(s)
  if s.review then require("config.app.review").render_threads() end
  changed()
  gutter.update_all()
end

-- After moving the current version programmatically: the old pane follows now, not on the WinScrolled
-- that comes after the next screen update (one frame with the panes apart)
local function follow()
  scrollsync.sync(assert(state).new_win)
end

-- Cmd+R / » put the old text back: only into the working tree, and only when git has an old text (an
-- unversioned or added file's old side is empty: reverting would empty the file)
---@param s GitDiffState
local function revertable(s)
  local st = s.files[s.index].status
  return not s.revs.new and st ~= "?" and st ~= "A" and st ~= "D"
end

M.revertable = revertable

-- The open diff's state (config/app/diff.lua describes it to the app)
---@return GitDiffState?
function M.state()
  return state
end

-- The app's » on change i (config/app/diff.lua): the current version's lines of that change get the old
-- text (any kind of change, also a pure insertion, which diffput can't reach without a filler row)
---@param i integer index into scrollsync.changes(old buffer, new buffer, diffopt)
function M.revert_hunk(i)
  local s = state
  if not (s and revertable(s) and vim.api.nvim_win_is_valid(s.old_win) and vim.api.nvim_win_is_valid(s.new_win)) then return end
  local old_buf, new_buf = vim.api.nvim_win_get_buf(s.old_win), vim.api.nvim_win_get_buf(s.new_win)
  local h = scrollsync.changes(old_buf, new_buf, scrollsync.diffopt())[i]
  if not h then return end
  local as, ac, bs, bc = h[1], h[2], h[3], h[4]
  local old = ac > 0 and vim.api.nvim_buf_get_lines(old_buf, as - 1, as - 1 + ac, false) or {}
  local first = bc == 0 and bs or bs - 1 -- 0-based: an insertion point is after line bs
  vim.api.nvim_buf_set_lines(new_buf, first, first + bc, false, old)
end

-- Fills the diff windows; focus stays where it was (Git tool window or diff). All git output is
-- fetched first, so the screen never shows a half-switched diff (old header hashes, top of the file)
-- while git runs.
local function show()
  local s = assert(state)
  local out_snapshot
  local from = vim.api.nvim_get_current_win()
  local f = s.files[s.index]
  local abs = f.abs or (cli.root .. "/" .. f.path)
  local old_path = f.old_path or f.path
  local missing_old = f.status == "A" or f.status == "?"
  local old_rev = missing_old and "" or s.revs.old
  local new_rev = f.status == "D" and "" or s.revs.new
  -- what git has to tell first: file texts not in a buffer yet, 8-char hashes for the headers
  -- (an agent's version on disk, `disk`, is a snapshot file instead: W-25)
  local cmds = {}
  if f.snapshot then
    s.short[old_rev] = old_rev
  elseif old_rev ~= "" and not existing(old_rev, old_path) then
    cmds.old = { "show", old_rev .. ":" .. old_path }
  end
  if new_rev and new_rev ~= "" and not existing(new_rev, f.path) then cmds.new = { "show", new_rev .. ":" .. f.path } end
  for _, rev in ipairs({ s.revs.old, s.revs.new }) do
    if not s.short[rev] then cmds["short " .. rev] = { "rev-parse", "--short=8", rev } end
  end
  if f.snapshot then
    local file = io.open(f.snapshot, "rb")
    cmds, out_snapshot = {}, file and file:read("*a") or ""
    if file then file:close() end
  end
  local out = M.git_all(cmds)
  for _, rev in ipairs({ s.revs.old, s.revs.new }) do
    if cmds["short " .. rev] then s.short[rev] = out["short " .. rev] and vim.trim(out["short " .. rev]) or rev end
  end
  if f.snapshot then
    -- a new snapshot each time (the agent may write again): the old scratch goes
    local stale = existing(old_rev, old_path)
    if stale then pcall(vim.api.nvim_buf_delete, stale, { force = true }) end
    out.old = out_snapshot
  end
  local old_buf = scratch(old_rev, old_path, out.old or "")
  local new_buf
  if new_rev then
    new_buf = scratch(new_rev, f.path, out.new or "")
  else
    new_buf = vim.fn.bufadd(abs) -- the real file, editable
    vim.fn.bufload(new_buf)
    vim.bo[new_buf].buflisted = true
  end
  vim.cmd("diffoff!")
  s.new_buf = new_buf
  -- a revision buffer can move from one pane to the other (HEAD was new, now old): don't let
  -- bufhidden=wipe drop it in between
  local hidden = {}
  for _, b in ipairs({ old_buf, new_buf }) do hidden[b] = vim.bo[b].bufhidden; vim.bo[b].bufhidden = "hide" end
  vim.api.nvim_win_set_buf(s.old_win, old_buf)
  -- no winbar (native headers), right away: a buffer brings back its own window options
  vim.wo[s.old_win].winbar = ""
  vim.api.nvim_win_set_buf(s.new_win, new_buf)
  vim.wo[s.new_win].winbar = ""
  for b, v in pairs(hidden) do vim.bo[b].bufhidden = v end
  local keep = { [old_buf] = true, [new_buf] = true }
  unmap_all(s, keep)
  for b in pairs(keep) do
    M.map_jumps(b, M.jump)
    s.mapped[b] = true
  end
  for _, w in ipairs({ s.old_win, s.new_win }) do
    vim.api.nvim_win_call(w, function() vim.cmd("diffthis") end)
    local wo = vim.wo[w]
    wo.number, wo.signcolumn, wo.foldcolumn, wo.cursorline = false, "no", "0", false
    wo.scrollbind, wo.cursorbind = false, false -- git/scrollsync.lua scrolls the panes together
    -- whole file shown; zM / the menu folds unchanged code to a wavy line
    wo.foldenable, wo.foldlevel, wo.foldtext = false, 0, "v:lua.require'git.diff'.foldtext()"
    wo.fillchars = FILL
  end
  vim.wo[s.old_win].winhighlight = OLD_HL
  vim.wo[s.new_win].winhighlight = NEW_HL
  gutter.attach(s.old_win, { only_hl = "GitDiffDeletedNr" })
  gutter.attach(s.new_win, { only_hl = "GitDiffInsertedNr" })
  s.count = differences(s)
  -- a PR diff: the file's cards get their rows in its new buffers (threads read before it opened too)
  if s.review then require("config.app.review").render_threads() end
  changed()
  vim.api.nvim_win_set_cursor(s.new_win, { 1, 0 })
  vim.api.nvim_win_call(s.new_win, function() pcall(vim.cmd, "normal! ]c") end) -- first change
  follow()
  if vim.api.nvim_win_is_valid(from) then vim.api.nvim_set_current_win(from) end
end

-- Cursor to the last difference: ]c until it stops (where diff mode itself lands; changes from
-- vim.text.diff don't always match its own)
local function to_last_change(s)
  vim.api.nvim_win_call(s.new_win, function()
    for _ = 1, (s.count or 0) + 1 do
      local l = vim.fn.line(".")
      pcall(vim.cmd, "normal! ]c")
      if vim.fn.line(".") == l then break end
    end
  end)
end

-- Next / previous difference (toolbar arrows, Cmd+Ö / Cmd+L). Past the last
-- one: the first difference of the next file in the list (the commit's files, Local Changes), before
-- the first: the last one of the previous file, like WebStorm. The first / last file stop there.
function M.jump(dir)
  local s = state
  if not (s and vim.api.nvim_win_is_valid(s.new_win)) then return end
  local before = vim.api.nvim_win_get_cursor(s.new_win)[1]
  vim.api.nvim_win_call(s.new_win, function() pcall(vim.cmd, "normal! " .. (dir > 0 and "]c" or "[c")) end)
  local moved = vim.api.nvim_win_get_cursor(s.new_win)[1] ~= before
  local next_index = s.index + dir
  if not moved and next_index >= 1 and next_index <= #s.files then
    s.index = next_index
    show() -- the cursor lands on the first difference
    if dir < 0 then to_last_change(s) end
  end
  follow()
end

-- Current version's line l at the top third, the old pane following (Show History for Selection)
---@param l integer
---@param enter? boolean focus the current version
function M.reveal(l, enter)
  local s = state
  if not (s and vim.api.nvim_win_is_valid(s.new_win)) then return end
  local buf = vim.api.nvim_win_get_buf(s.new_win)
  l = math.max(1, math.min(l, vim.api.nvim_buf_line_count(buf)))
  vim.api.nvim_win_set_cursor(s.new_win, { l, 0 })
  vim.api.nvim_win_call(s.new_win, function()
    local view = vim.fn.winsaveview()
    view.topline = math.max(1, l - math.floor(vim.api.nvim_win_get_height(0) / 3))
    vim.fn.winrestview(view)
  end)
  follow()
  if enter then vim.api.nvim_set_current_win(s.new_win) end
end

---@param files GitFile[]
---@param file GitFile
---@param revs {old: string, new?: string}
---@param review? {pr: integer} a PR's diff (PR review in the Git Log), else nil
function M.open(files, file, revs, review)
  if focus.viewer() == "merge" then
    local merge = require("git.merge")
    merge.close() -- asks first when the result has unsaved work
    if merge.is_active() then return end
  end
  local index = 1
  for i, f in ipairs(files) do
    if f.path == file.path then index = i end
  end
  if not (state and vim.api.nvim_win_is_valid(state.old_win) and vim.api.nvim_win_is_valid(state.new_win)) then
    local code = focus.split_win()
    if not code then return end
    local old_win = vim.api.nvim_open_win(0, false, { split = "left", win = code })
    local saved = {}
    for _, o in ipairs(SAVED) do saved[o] = vim.wo[code][o] end
    state = { old_win = old_win, new_win = code, prev_buf = vim.api.nvim_win_get_buf(code), saved_wo = saved, sync = { old_win, code }, mapped = {},
      shares = shares.new({ old_win, code }, last_shares) }
    scrollsync.add(state.sync)
  end
  state.files, state.index, state.revs, state.short, state.review = files, index, revs, {}, review
  show()
end

local function restore(s)
  unmap_all(s)
  changed()
  scrollsync.remove(s.sync)
  gutter.detach(s.new_win)
  gutter.detach(s.old_win)
  for o, v in pairs(s.saved_wo) do vim.wo[s.new_win][o] = v end
end

-- Cmd+R: put the old text back for the change under the cursor
function M.revert_change()
  local s = state
  if not s or s.revs.new then return end
  if not revertable(s) then
    return vim.notify("Nothing to revert: git has no old version", vim.log.levels.INFO, { title = "Git" })
  end
  local win = vim.api.nvim_get_current_win()
  if win == s.old_win then
    vim.cmd("diffput")
  elseif win == s.new_win then
    vim.cmd("diffget")
  end
end

-- Folded unchanged code: just the wavy line (Folded highlight), no text
function M.foldtext()
  return ""
end

function M.is_active()
  return state ~= nil
end

-- Diff windows, the current version first
function M.wins()
  return state and { state.new_win, state.old_win } or {}
end

-- Current window is one of the diff windows?
function M.is_focused()
  if not state then return false end
  local w = vim.api.nvim_get_current_win()
  return w == state.old_win or w == state.new_win
end

-- The divider double-clicked: both panes equally wide again
function M.equal_widths()
  local s = state
  if not s then return end
  shares.reset(s.shares)
  last_shares = nil
end

function M.cycle(dir)
  if not state then return end
  state.index = (state.index - 1 + dir) % #state.files + 1
  show()
end

function M.close()
  local s = state
  if not s then return end
  local was_in_diff = M.is_focused()
  state = nil
  unmap_all(s)
  pcall(vim.cmd, "diffoff!")
  changed()
  -- the split gets the old pane's width back (else the split left of it took it)
  local width = vim.api.nvim_win_is_valid(s.old_win) and vim.api.nvim_win_is_valid(s.new_win)
    and vim.api.nvim_win_get_width(s.old_win) + vim.api.nvim_win_get_width(s.new_win) + 1
  if vim.api.nvim_win_is_valid(s.old_win) then vim.api.nvim_win_close(s.old_win, true) end
  if width then vim.api.nvim_win_set_width(s.new_win, width) end
  if vim.api.nvim_win_is_valid(s.new_win) then
    restore(s)
    -- back to the file shown before the diff
    if vim.api.nvim_buf_is_valid(s.prev_buf) then
      vim.api.nvim_win_set_buf(s.new_win, s.prev_buf)
    elseif vim.bo[vim.api.nvim_win_get_buf(s.new_win)].buftype ~= "" then
      vim.api.nvim_win_set_buf(s.new_win, vim.api.nvim_create_buf(true, false))
    end
    if was_in_diff then vim.api.nvim_set_current_win(s.new_win) end
  end
end

-- F4 / the toolbar's ✎: open the file in the editor at the diff caret's line (from the old pane: its line
-- mapped through the diff; from the Git tool window: the current version's caret)
function M.open_in_editor()
  local s = state
  if not s then return end
  local f = s.files[s.index]
  local line
  if vim.api.nvim_get_current_win() == s.old_win then
    line = scrollsync.map(vim.api.nvim_win_get_cursor(s.old_win)[1], scrollsync.win_changes(s.old_win, s.new_win))
  else
    line = vim.api.nvim_win_get_cursor(s.new_win)[1]
  end
  M.close()
  -- in the code window (✎ / the menu work with the Git tool window focused too)
  if vim.api.nvim_win_is_valid(s.new_win) then vim.api.nvim_set_current_win(s.new_win) end
  vim.cmd.edit(vim.fn.fnameescape(cli.root .. "/" .. f.path))
  pcall(vim.api.nvim_win_set_cursor, 0, { line, 0 })
end

-- Right-click / Cmd+Enter in the diff
---@param win integer
---@return MenuEntry[]?
function M.menu_items(win)
  local s = state
  if not (s and (win == s.old_win or win == s.new_win)) then return end
  local on_change = vim.fn.diff_hlID(vim.fn.line("."), 1) ~= 0
  local review = s.review and vim.list_extend(require("config.app.review").menu_items(), { "-" }) or {}
  -- the editor and the agent changed the same file (W-25): its resolutions first
  local conflict = s.files[s.index].conflict_buf
  if conflict then
    for _, item in ipairs(require("config.app.agent_files").resolutions(conflict)) do
      review[#review + 1] = item
    end
    review[#review + 1] = "-"
  end
  return vim.list_extend(review, {
    { "Next Difference", function() M.jump(1) end, key = "⌘Ö" },
    { "Previous Difference", function() M.jump(-1) end, key = "⌘L" },
    { "Revert Change", M.revert_change, key = "⌘R", enabled = revertable(s) and on_change },
    "-",
    { "Next File", function() M.cycle(1) end, key = "⌥⌘→", enabled = #s.files > 1 },
    { "Previous File", function() M.cycle(-1) end, key = "⌥⌘←", enabled = #s.files > 1 },
    { "Open in Editor", M.open_in_editor, key = "F4" },
    "-",
    { "Whitespace: " .. M.ignore_mode() .. "…", function() M.choose(IGNORE, M.ignore_mode(), M.set_ignore) end },
    { M.highlight_mode() .. "…", function() M.choose(HIGHLIGHT, M.highlight_mode(), M.set_highlight) end },
    vim.wo[win].foldenable
      and { "Show Whole File", function() for _, w in ipairs(s.sync) do vim.wo[w].foldenable = false end end, key = "zR" }
      or { "Collapse Unchanged", function() for _, w in ipairs(s.sync) do vim.wo[w].foldenable, vim.wo[w].foldlevel = true, 0 end end, key = "zM" },
    "-",
    { "Copy", function() vim.api.nvim_feedkeys(vim.keycode('"+yy'), "n", false) end, key = "⌘C" },
    { "Close", M.close, key = ",w" },
  })
end
menu.provider(20, function(win) return M.menu_items(win) end)

-- Leave diff mode when the code window switches to another file or a diff window closes
vim.api.nvim_create_autocmd("BufWinEnter", {
  callback = function()
    vim.schedule(function()
      local s = state
      if not s or not vim.api.nvim_win_is_valid(s.new_win) then return end
      if vim.api.nvim_win_get_buf(s.new_win) ~= s.new_buf then
        state = nil
        vim.api.nvim_win_call(s.new_win, function() vim.cmd("diffoff") end)
        if vim.api.nvim_win_is_valid(s.old_win) then vim.api.nvim_win_close(s.old_win, true) end
        restore(s)
      end
    end)
  end,
})
vim.api.nvim_create_autocmd("WinClosed", {
  callback = function(args)
    local s = state
    local win = tonumber(args.match)
    if s and (win == s.old_win or win == s.new_win) then vim.schedule(M.close) end
  end,
})
-- The diff changed (Cmd+R, », edits in the current version): recount for the toolbar's "N differences"
local recount = false
vim.api.nvim_create_autocmd("DiffUpdated", {
  callback = function()
    if recount or not state then return end
    recount = true
    vim.schedule(function()
      recount = false
      local s = state
      if not s then return end
      local n = differences(s)
      if n ~= s.count then
        s.count = n
        changed()
      end
    end)
  end,
})
-- The panes keep their shares (window resized, tree opened / closed), like WebStorm's splitter; the divider
-- dragged (or <C-w>< / >, :vertical resize) sets new ones
vim.api.nvim_create_autocmd("WinResized", {
  callback = function()
    local s = state
    if s and shares.update(s.shares) then last_shares = s.shares.shares end
  end,
})

-- The repo changed (commit, rollback, checkout, ...): the working file is already reloaded (checktime); a
-- revision that moved (HEAD after a commit) gets its new text and header hash, then the count, colors
-- and » are redone. The caret and scroll stay.
cli.on_change(function()
  local s = state
  if not (s and vim.api.nvim_win_is_valid(s.old_win) and vim.api.nvim_win_is_valid(s.new_win)) then return end
  local cmds = {}
  for rev in pairs(s.short) do cmds[rev] = { "rev-parse", "--short=8", rev } end
  local out = M.git_all(cmds)
  local moved = {}
  for rev, short in pairs(s.short) do
    local now = out[rev] and vim.trim(out[rev]) or rev
    if now ~= short then moved[#moved + 1] = rev end
  end
  if #moved == 0 then return M.refresh() end
  for _, rev in ipairs(moved) do
    s.short[rev] = nil
    for _, f in ipairs(s.files) do
      for _, path in ipairs({ f.path, f.old_path }) do
        local buf = existing(rev, path)
        if buf then fill(buf, cli.show(rev, path)) end
      end
    end
  end
  local view = vim.api.nvim_win_call(s.new_win, vim.fn.winsaveview)
  show()
  if state == s and vim.api.nvim_win_is_valid(s.new_win) then
    vim.api.nvim_win_call(s.new_win, function() vim.fn.winrestview(view) end)
    follow()
  end
end)

focus.register("diff", { is_focused = M.is_focused, close = M.close, cycle = M.cycle, is_active = M.is_active, wins = M.wins })

return M
