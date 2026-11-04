-- The editor and an agent may edit the same file. A clean buffer reloads; one whose file is deleted (or moved) on
-- disk closes its tabs quietly, as WebStorm's do, once the file is still missing a check later (~1 s: a rewrite,
-- git checkout / stash, a formatter may delete and recreate it; back by then, it just reloads). A buffer marked
-- modified whose text is still the file it read (a formatter's no-op, an edit typed and taken back) counts as clean.
-- The same text written again (or the edits' own) is read again too, unsaved edits kept: no later save gets Vim's
-- "changed since reading it" prompt. One with unsaved edits keeps them and stays
-- editable (never 'readonly': no W10, no "write anyway?" prompt): its saves (⌘S, :w, autosave, the quit) are held,
-- without a prompt, until a choice is made (Keep editor version / Use disk version / Compare with disk: the
-- balloon's Resolve…, the editor's menu, the diff viewer's). Both versions are kept meanwhile in a conflict record
-- (state/abe-conflicts/<file>/<n>/: disk, editor, metadata.json). A quit carries a record into the project's next
-- start (the unsaved edits come back in the file's tab); a record never replays anywhere else: it is stale once
-- the file matches the edits, its buffer is closed, or a later run of the project no longer has the file open. A
-- conflict whose file comes back to the text the edits started from (deleted, then recreated as it was) is over.
local M = {}
local records, conflicts = {}, {}
local checking = {}
local serial = 0
local guard_group
local recover

local function ordinary(buf)
  return vim.api.nvim_buf_is_valid(buf) and vim.api.nvim_buf_is_loaded(buf)
    and vim.bo[buf].buftype == "" and vim.api.nvim_buf_get_name(buf) ~= ""
    and not vim.b[buf].abe_external_snapshot
end
local function read(path)
  local file = io.open(path, "rb")
  if not file then return nil end
  local text = file:read("*a")
  file:close()
  return text
end
local function signature(path)
  local s = vim.uv.fs_stat(path)
  if not s then return "missing" end
  return table.concat({s.ino, s.size, s.mtime.sec, s.mtime.nsec}, ":")
end
local function editor_text(buf)
  return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
    .. (vim.bo[buf].endofline and "\n" or "")
end
-- Whether the buffer holds exactly `text` (a file's bytes): its lines in its fileformat, the BOM; the final
-- newline either way ('fixeol' adds it on write)
---@param text string?
local function holds(buf, text)
  if not text then return false end
  local fenc = vim.bo[buf].fileencoding
  if fenc ~= "" and fenc ~= "utf-8" then return false end
  local sep = ({ dos = "\r\n", mac = "\r" })[vim.bo[buf].fileformat] or "\n"
  local mine = (vim.bo[buf].bomb and "\239\187\191" or "")
    .. table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), sep)
  if text:sub(-#sep) == sep then text = text:sub(1, -#sep - 1) end
  return mine == text
end
local function write(path, text)
  local file = assert(io.open(path, "wb"))
  file:write(text or "")
  file:close()
  vim.uv.fs_chmod(path, 384) -- 0600
end
-- (/tmp and /private/tmp are one file: one record folder)
local function key(path) return vim.fn.resolve(vim.fn.fnamemodify(path, ":p")) end
local function base() return vim.fn.stdpath("state") .. "/abe-conflicts" end
local function folder_of(path) return base() .. "/" .. vim.fn.sha256(key(path)) end
local function quitting() return vim.v.exiting ~= nil and vim.v.exiting ~= vim.NIL end
-- The file read again (:edit!): a filetype's undo_ftplugin (`sil! nunmap <buffer> …`, markdown's) leaves no
-- "E31: No such mapping" in v:errmsg
local function reload(buf)
  local errmsg = vim.v.errmsg
  vim.api.nvim_buf_call(buf, function() vim.cmd("silent keepalt edit!") end)
  vim.v.errmsg = errmsg
end

-- Whether another running nvim (another project's window) wrote the record
---@param pid any
local function other_owner(pid)
  if type(pid) ~= "number" or pid <= 0 or pid == vim.fn.getpid() then return false end
  local ok, proc = pcall(vim.api.nvim_get_proc, pid)
  return ok and type(proc) == "table" and type(proc.name) == "string" and proc.name:find("nvim", 1, true) ~= nil
end

-- A file missing on two checks this far apart is gone (not mid-rewrite): ns
local GRACE = 0.9e9
local function remember(buf)
  if not ordinary(buf) then return end
  local path = vim.api.nvim_buf_get_name(buf)
  records[buf] = { path = path, stamp = signature(path), text = read(path) }
  if recover and not conflicts[buf] then recover(buf) end
end
local function metadata(c)
  write(c.metadata, vim.json.encode({ path = c.path, disk = c.disk, editor = c.editor, versions = c.versions,
    deleted = c.deleted, resolved = c.resolved or false, pid = c.pid, cwd = c.cwd, carried = c.carried or false }))
end
-- The newest record of `path` (its metadata decoded, `metadata` its file), or nil
---@param path string
local function latest(path)
  local function stamp(f)
    local s = vim.uv.fs_stat(f)
    return s and s.mtime.sec + s.mtime.nsec / 1e9 or 0
  end
  local candidates = vim.fn.globpath(folder_of(path), "*/metadata.json", false, true)
  table.sort(candidates, function(a, b) return stamp(a) < stamp(b) end)
  local file = candidates[#candidates]
  if not file then return nil end
  local ok, c = pcall(vim.json.decode, read(file) or "")
  if not ok or type(c) ~= "table" then return nil end
  c.metadata = file
  return c
end
-- A record no longer in force: kept on disk (its versions stay available), never replayed
local function stale(c)
  c.resolved = true
  pcall(metadata, c)
end

-- The balloon: one per buffer, replaced in place, staying until the conflict is resolved
local function balloon_id(buf) return "abe-conflict-" .. buf end
---@param buf integer
---@param first string? its first sentence (default: what happened)
local function tell(buf, first)
  local c = conflicts[buf]
  if not c or quitting() then return end
  local name = vim.fn.fnamemodify(c.path, ":t")
  first = first or (name .. (c.deleted and " was deleted" or " changed") .. " on disk while you had unsaved edits.")
  vim.notify(first .. " Both versions are kept, and saving it waits for your choice: Keep editor version,"
    .. " Use disk version or Compare with disk.", vim.log.levels.WARN, {
    id = balloon_id(buf), title = "Changed outside the editor", timeout = 0,
    action = { label = "Resolve…", run = function() M.choose(buf) end },
  })
end
local function untell(buf)
  local snacks = package.loaded["snacks"]
  if snacks and snacks.notifier then pcall(snacks.notifier.hide, balloon_id(buf)) end
end

-- Every write of a conflicted buffer (⌘S's wall, :w, the quit's wall) lands here instead: nothing is written and
-- nothing asks; its text goes to the record and the balloon says why. A write to another file (:w other) is done.
local function guard(buf)
  vim.api.nvim_clear_autocmds({ group = guard_group, buffer = buf })
  vim.api.nvim_create_autocmd("BufWriteCmd", { group = guard_group, buffer = buf, callback = function(ev)
    local c = conflicts[ev.buf]
    if not c or key(ev.match) ~= c.path then
      vim.fn.writefile(vim.api.nvim_buf_get_lines(ev.buf, 0, -1, false), ev.match, vim.bo[ev.buf].endofline and "" or "b")
      if not c then vim.bo[ev.buf].modified = false end
      return
    end
    write(c.editor, editor_text(ev.buf))
    tell(ev.buf, vim.fn.fnamemodify(c.path, ":t") .. " is not saved: it changed on disk while you had unsaved edits.")
  end })
end
local function unguard(buf)
  vim.b[buf].abe_external_conflict = nil
  conflicts[buf] = nil
  vim.api.nvim_clear_autocmds({ group = guard_group, buffer = buf })
  untell(buf)
end

local function snapshot(buf, disk)
  local previous = conflicts[buf]
  if not previous then
    serial = serial + 1
    local folder = ("%s/%d-%d"):format(folder_of(vim.api.nvim_buf_get_name(buf)), vim.uv.hrtime(), serial)
    vim.fn.mkdir(folder, "p", 448) -- 0700
    previous = { path = key(vim.api.nvim_buf_get_name(buf)), editor = folder .. "/editor", disk = folder .. "/disk",
      versions = 0, metadata = folder .. "/metadata.json", pid = vim.fn.getpid(), cwd = vim.fn.getcwd(),
      base = records[buf] and records[buf].text } -- (the file the edits started from: this run's only)
    conflicts[buf] = previous
    vim.b[buf].abe_external_conflict = true
    guard(buf)
  end
  previous.versions = previous.versions + 1
  if previous.versions > 1 then
    local old = read(previous.disk)
    if old then write(previous.disk .. "." .. (previous.versions - 1), old) end
  end
  write(previous.disk, disk)
  write(previous.editor, editor_text(buf))
  previous.stamp = signature(previous.path)
  previous.deleted = disk == nil
  metadata(previous)
  tell(buf)
  return previous
end

-- The unsaved edits a quit carried (this project's last run had the file open, unresolved): back in the buffer,
-- editable and modified, the conflict on again. Any other record of the file is stale (and left alone).
recover = function(buf)
  local path = key(vim.api.nvim_buf_get_name(buf))
  local c = latest(path)
  if not c or c.resolved or c.path ~= path or other_owner(c.pid) then return end
  local text, disk = read(c.editor), read(path)
  if not (c.carried and c.pid ~= vim.fn.getpid() and c.cwd == vim.fn.getcwd() and text and text ~= disk) then
    return stale(c)
  end
  local lines = vim.split(text, "\n", { plain = true })
  local newline = text:sub(-1) == "\n"
  if newline then table.remove(lines) end
  if #lines == 0 then lines = { "" } end
  c.pid, c.carried, c.stamp = vim.fn.getpid(), false, signature(path)
  conflicts[buf] = c
  vim.b[buf].abe_external_conflict = true
  guard(buf)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].endofline = newline
  vim.bo[buf].modified = true
  if disk ~= read(c.disk) then return snapshot(buf, disk) end
  metadata(c)
  local name = vim.fn.fnamemodify(path, ":t")
  vim.schedule(function() tell(buf, name .. ": your unsaved edits are back; the file on disk was changed outside the editor.") end)
end

local clear
-- A clean buffer's file is gone: its tabs close (the tab's ×: config/editor_tabs.lua), after this check
local function close_gone(buf)
  local record = records[buf]
  vim.schedule(function()
    if not ordinary(buf) or conflicts[buf] or records[buf] ~= record or signature(record.path) ~= "missing"
      or vim.bo[buf].modified and not holds(buf, record.text) then return end
    vim.bo[buf].modified = false -- (no edits: never written back)
    require("config.editor_tabs").close_everywhere(buf)
    -- still shown (the viewer's window): left alone
    if vim.api.nvim_buf_is_valid(buf) and records[buf] == record then record.stamp, record.gone = "missing", nil end
  end)
end

-- The file read again, what it holds kept: nvim's own "changed since reading it" (a later save's prompt, which even
-- `silent!` gives) starts from disk again. Unsaved edits are put back, one undo step with the reload; while they
-- are being typed (insert mode) it waits (false)
---@return boolean done
local function reread(buf)
  local edits = vim.bo[buf].modified and vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  if edits and buf == vim.api.nvim_get_current_buf() and vim.api.nvim_get_mode().mode:find("^[iR]") then
    return false
  end
  local eol = vim.bo[buf].endofline
  checking[buf] = true
  local views = {}
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do views[win] = vim.api.nvim_win_call(win, vim.fn.winsaveview) end
  reload(buf)
  if edits and not (vim.deep_equal(edits, vim.api.nvim_buf_get_lines(buf, 0, -1, false)) and eol == vim.bo[buf].endofline) then
    vim.api.nvim_buf_call(buf, function() pcall(vim.cmd.undojoin) end)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, edits)
    vim.bo[buf].endofline = eol
  end
  for win, view in pairs(views) do
    if vim.api.nvim_win_is_valid(win) then vim.api.nvim_win_call(win, function() vim.fn.winrestview(view) end) end
  end
  checking[buf] = nil
  remember(buf)
  return true
end

---@param writing boolean? (its BufWritePre: no reload of the same text there)
local function check(buf, writing)
  if not ordinary(buf) or checking[buf] then return end
  local record = records[buf]
  if not record or record.path ~= vim.api.nvim_buf_get_name(buf) then remember(buf) return end
  local stamp = signature(record.path)
  if stamp == record.stamp then return end
  local disk = read(record.path)
  local conflict = conflicts[buf]
  if conflict then
    if conflict.stamp == stamp then return end
    -- back to what the edits started from (deleted, then recreated as it was): nothing changed outside the editor
    if conflict.base and disk == conflict.base and not writing then
      if buf == vim.api.nvim_get_current_buf() and vim.api.nvim_get_mode().mode:find("^[iR]") then return end
      clear(buf)
      reread(buf)
      return
    end
    snapshot(buf, disk)
    return
  end
  -- the same text on disk as read (touched, rewritten, deleted and back), or as the buffer holds (the same edit)
  if disk and (disk == record.text or holds(buf, disk)) then
    if writing then record.stamp = stamp else reread(buf) end
    return
  end
  if vim.bo[buf].modified and not holds(buf, record.text) then return snapshot(buf, disk) end
  vim.bo[buf].modified = false -- no unsaved edits (and autosave never writes a deleted file back meanwhile)
  if stamp == "missing" then
    local now = vim.uv.hrtime()
    if not record.gone then record.gone = now
    elseif now - record.gone >= GRACE then close_gone(buf) end
    return
  end
  if disk then reread(buf) end -- (unreadable for a moment: next check)
end

-- Called before every save of all (native autosave, ⌘S, the quit, queue delivery's save): an agent's change on
-- disk is found first, so a conflicting buffer is held (never written, never a prompt).
function M.before_save_all()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    check(buf)
    local conflict = conflicts[buf]
    if conflict and ordinary(buf) then write(conflict.editor, editor_text(buf)) end
  end
end
-- Save all (⌘S, a commit's save, a project's close): never a prompt; a held buffer stays unsaved (its guard)
function M.save_all()
  M.before_save_all()
  local confirm = vim.o.confirm
  vim.o.confirm = false
  pcall(vim.cmd, "silent! wall")
  vim.o.confirm = confirm
end
-- Whether a save of `buf` waits for a choice (autosave, which skips BufWriteCmd, leaves it alone)
---@param buf integer
function M.held(buf) return conflicts[buf] ~= nil end
function M.conflict(buf)
  local c = conflicts[buf or vim.api.nvim_get_current_buf()]
  if not c then return nil end
  return { path = c.path, disk = c.disk, editor = c.editor, deleted = c.deleted, versions = c.versions }
end
clear = function(buf)
  local c = conflicts[buf]
  if not c then return end
  c.resolved = true
  metadata(c)
  unguard(buf)
  remember(buf)
end
-- Compare with disk: the native diff viewer (git/diff.lua) with the agent's version on disk left
-- (read-only) and the editor's unsaved buffer right (editable; Revert Change takes a disk change in),
-- its menu leading with the resolutions. Neither version is written until one is chosen.
function M.compare(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  check(buf)
  local c = conflicts[buf]
  if not c then return end
  write(c.editor, editor_text(buf))
  local wins = vim.fn.win_findbuf(buf)
  if wins[1] then vim.api.nvim_set_current_win(wins[1]) else vim.cmd.buffer(buf) end
  local name = vim.fn.fnamemodify(c.path, ":t")
  local file = { path = name, abs = c.path, status = "M", snapshot = c.disk, conflict_buf = buf }
  require("git.diff").open({ file }, file, { old = "disk" })
end
function M.keep_editor(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  check(buf) -- retain a newer disk version if it changed again while comparing
  local c = conflicts[buf]
  if not c then return end
  write(c.editor, editor_text(buf))
  clear(buf)
  -- The explicit action authorizes this write; the former external version remains in the record.
  local confirm = vim.o.confirm
  vim.o.confirm = false
  pcall(vim.api.nvim_buf_call, buf, function() vim.cmd("silent write!") end)
  vim.o.confirm = confirm
end
function M.use_disk(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  check(buf)
  local c = conflicts[buf]
  if not c or c.deleted then return end
  write(c.editor, editor_text(buf))
  clear(buf)
  reload(buf)
end
-- The two resolutions (the editor's menu, the diff viewer's): each closes the comparison
function M.resolutions(buf)
  if not conflicts[buf] then return {} end
  local function close_then(f)
    return function()
      local diff = require("git.diff")
      if diff.is_active() then diff.close() end
      f(buf)
    end
  end
  return {
    { "Keep editor version (overwrite disk)", close_then(M.keep_editor) },
    { "Use disk version", close_then(M.use_disk), enabled = not conflicts[buf].deleted },
  }
end
function M.menu_items(buf)
  if not conflicts[buf] then return {} end
  return vim.list_extend({ "-", { "Compare with disk", function() M.compare(buf) end } }, M.resolutions(buf))
end
-- The balloon's Resolve…: the three choices in a popup at the file's caret
---@param buf integer
function M.choose(buf)
  local c = conflicts[buf]
  if not c or not vim.api.nvim_buf_is_valid(buf) then return end
  local wins = vim.fn.win_findbuf(buf)
  if wins[1] then vim.api.nvim_set_current_win(wins[1]) else require("config.editor_tabs").open(c.path) end
  local items = M.menu_items(buf)
  table.remove(items, 1) -- (its separator)
  require("config.menu").open(items, { title = vim.fn.fnamemodify(c.path, ":t") .. " changed outside the editor", at = "cursor" })
end
-- A conflicted file's tab is being closed: it stays (its edits would go) and the balloon says why
---@param buf integer
---@return boolean held
function M.closing(buf)
  local c = conflicts[buf]
  if not c then return false end
  tell(buf, vim.fn.fnamemodify(c.path, ":t") .. " stays open: it changed on disk while you had unsaved edits.")
  return true
end

-- The quit: every conflicted buffer's edits are carried into the project's next start. The project's other
-- records whose file this run no longer has open are stale; resolved ones older than a week are deleted.
local WEEK = 7 * 24 * 3600
local function carry()
  local open = {}
  for buf, c in pairs(conflicts) do
    if ordinary(buf) then write(c.editor, editor_text(buf)) end
    c.carried = true
    pcall(metadata, c)
    open[c.metadata] = true
  end
  local now, cwd = os.time(), vim.fn.getcwd()
  for _, file in ipairs(vim.fn.globpath(base(), "*/*/metadata.json", false, true)) do
    local ok, c = pcall(vim.json.decode, read(file) or "")
    if ok and type(c) == "table" and not open[file] then
      c.metadata = file
      local s = vim.uv.fs_stat(file)
      if c.resolved then
        if s and now - s.mtime.sec > WEEK then vim.fn.delete(vim.fs.dirname(file), "rf") end
      elseif c.cwd == cwd and not other_owner(c.pid) and type(c.path) == "string" and vim.fn.bufnr(c.path) == -1 then
        stale(c)
      end
    end
  end
end

function M.setup()
  local group = vim.api.nvim_create_augroup("abe_external_files", { clear = true })
  guard_group = vim.api.nvim_create_augroup("abe_external_guard", { clear = true })
  vim.api.nvim_create_autocmd({ "BufReadPost", "BufNewFile", "BufWritePost" }, { group = group, callback = function(ev)
    if not conflicts[ev.buf] then remember(ev.buf) end
  end })
  -- a write typed on the : line finds an agent's change first: held, not Vim's "changed since reading" prompt
  vim.api.nvim_create_autocmd("CmdlineEnter", { group = group, callback = function() pcall(M.before_save_all) end })
  vim.api.nvim_create_autocmd("BufWritePre", { group = group, callback = function(ev) check(ev.buf, true) end })
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, { group = group, callback = function(ev)
    if conflicts[ev.buf] then write(conflicts[ev.buf].editor, editor_text(ev.buf)) end
  end })
  -- nvim's own check (focus, :checktime) never asks (W11 / W12): this module decides
  vim.api.nvim_create_autocmd("FileChangedShell", { group = group, callback = function(ev)
    vim.v.fcs_choice = ""
    local buf = ev.buf
    vim.schedule(function() if vim.api.nvim_buf_is_valid(buf) then check(buf) end end)
  end })
  vim.api.nvim_create_autocmd({ "FocusGained", "CursorHold" }, { group = group, callback = M.before_save_all })
  -- its buffer gone (closed, :e!): the record is stale; the quit's unload keeps it (carried)
  vim.api.nvim_create_autocmd("BufUnload", { group = group, callback = function(ev)
    local c = conflicts[ev.buf]
    if not c or quitting() then return end
    records[ev.buf] = nil
    unguard(ev.buf)
    stale(c)
  end })
  -- a carried file's tab closed before it was opened: its record is stale too
  vim.api.nvim_create_autocmd("BufDelete", { group = group, callback = function(ev)
    if quitting() or vim.api.nvim_buf_is_loaded(ev.buf) or ev.file == "" then return end
    local c = latest(ev.file)
    if c and not c.resolved and c.carried and not other_owner(c.pid) then stale(c) end
  end })
  vim.api.nvim_create_autocmd("BufWipeout", { group = group, callback = function(ev) records[ev.buf], conflicts[ev.buf] = nil, nil end })
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do remember(buf) end
  local timer = vim.uv.new_timer()
  timer:start(300, 1000, vim.schedule_wrap(function()
    if not quitting() and vim.api.nvim_get_mode().mode:sub(1, 1) ~= "c" then pcall(M.before_save_all) end
  end))
  vim.api.nvim_create_autocmd("VimLeavePre", { group = group, once = true, callback = function()
    timer:stop()
    timer:close()
    pcall(carry)
  end })
end
return M
