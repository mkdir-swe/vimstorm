-- `git status` of the cwd's repo, read once for everyone: the editor tabs' colors and the status bar's
-- branch (config/tabbar.lua, config/statusline.lua, config/app/{tabs,status,toolbar}.lua) and the Git tool
-- window's first tab (config/app/git.lua). Also the one rule from porcelain XY codes to what they show.
-- Re-read in the background after saves, focus, shell commands and index / HEAD changes.
local cli = require("git.cli")

local M = {}

---@class GitStatusEntry
---@field xy string porcelain v1 XY
---@field path string repo-relative
---@field old_path? string renames / copies: where it came from

---@class GitStatus
---@field root? string
---@field out? string raw output of the last read
---@field entries GitStatusEntry[] changed + unversioned files (no ignored ones)
---@field files table<string, string> path -> M.file_status
---@field ignored string[] ignored paths (folders end in "/")
---@field branch? string the branch, or HEAD's 8-char hash when detached (like WebStorm)
---@field detached? boolean
local state = { entries = {}, files = {}, ignored = {} } ---@type GitStatus
local memo = {} ---@type table<string, string|false> absolute path -> status (false: none)

-- Both sides changed it, or one deleted what the other changed / both added it: a merge conflict
---@param xy string
function M.is_conflict(xy)
  local x, y = xy:sub(1, 1), xy:sub(2, 2)
  return x == "U" or y == "U" or xy == "AA" or xy == "DD"
end

local WORDS = { A = "Added", M = "Modified", R = "Modified", C = "Modified", T = "Modified", D = "Deleted" }

-- Editor tab / Project tool window color: "Modified" / "Added" / "Unversioned" / "Ignored" / "Deleted" /
-- "Conflict" / nil
---@param xy string
---@return string?
function M.file_status(xy)
  if xy == "??" then return "Unversioned" end
  if xy == "!!" then return "Ignored" end
  if M.is_conflict(xy) then return "Conflict" end
  local x, y = xy:sub(1, 1), xy:sub(2, 2)
  if x == "A" then return "Added" end
  return WORDS[x ~= " " and x or y]
end

---@param out string git status --porcelain=v1 -b -z output
---@param root string
local function parse(out, root)
  local s = { root = root, out = out, entries = {}, files = {}, ignored = {} } ---@type GitStatus
  local parts = vim.split(out, "\0", { plain = true })
  local i = 1
  while i <= #parts do
    local e = parts[i]
    if e:sub(1, 3) == "## " then
      local head = e:sub(4)
      if head:match("^HEAD %(no branch%)") then
        s.detached = true -- the hash comes from rev-parse
      else
        s.branch = head:match("^No commits yet on (%S+)") or head:match("^(.-)%.%.%.") or head:match("^(%S+)")
      end
    elseif #e > 3 then
      local xy, path = e:sub(1, 2), e:sub(4)
      if xy == "!!" then
        s.ignored[#s.ignored + 1] = path
      else
        local entry = { xy = xy, path = path }
        if xy:find("[RC]") then -- renames: the old path follows
          i = i + 1
          entry.old_path = parts[i]
        end
        s.entries[#s.entries + 1] = entry
        s.files[path] = M.file_status(xy)
      end
    end
    i = i + 1
  end
  return s
end

local CMD = { "git", "--no-optional-locks", "status", "--porcelain=v1", "-b", "-z", "-uall", "--ignored=matching" }
local HASH = { "git", "rev-parse", "--short=8", "HEAD" }
local listeners = {} ---@type fun()[]

-- fn after every read (the tab bars redraw)
---@param fn fun()
function M.on_change(fn)
  listeners[#listeners + 1] = fn
end

---@param s GitStatus
local function set(s)
  state, memo = s, {}
  for _, fn in ipairs(listeners) do fn() end
end

local running, queued = nil, nil ---@type fun(s: GitStatus)[]?, fun(s: GitStatus)[]?

---@param cbs fun(s: GitStatus)[]
local function read(cbs)
  running = cbs
  local function done(s)
    if s then set(s) end
    running = nil
    for _, cb in ipairs(cbs) do cb(state) end
    if queued then -- asked again while this read ran: things may have changed since it started
      local q = queued
      queued = nil
      read(q)
    end
  end
  cli.find_root_async(function(root)
    if not root then return done({ entries = {}, files = {}, ignored = {} }) end
    vim.system(CMD, { cwd = root, text = true }, vim.schedule_wrap(function(r)
      local s = r.code == 0 and parse(r.stdout or "", root) or nil
      if not (s and s.detached) then return done(s) end
      vim.system(HASH, { cwd = root, text = true }, vim.schedule_wrap(function(h)
        s.branch = h.code == 0 and vim.trim(h.stdout or "") or "HEAD"
        done(s)
      end))
    end))
  end)
end

-- Read it in the background; cb gets the result (a read already running: the one after it)
---@param cb? fun(s: GitStatus)
function M.load(cb)
  if running then
    queued = queued or {}
    if cb then queued[#queued + 1] = cb end
    return
  end
  read(cb and { cb } or {})
end

-- Read it now (the Git tool window picking its first tab), in the repo cli.find_root found; nil when
-- git failed
---@return GitStatus?
function M.load_sync()
  local r = cli.root and vim.system(CMD, { cwd = cli.root, text = true }):wait()
  if not (r and r.code == 0) then return nil end
  local s = parse(r.stdout or "", assert(cli.root))
  if s.detached then
    local h = vim.system(HASH, { cwd = cli.root, text = true }):wait()
    s.branch = h.code == 0 and vim.trim(h.stdout or "") or "HEAD"
  end
  set(s)
  return state
end

local pending = false
-- Re-read soon (coalesced: saves, focus and shell commands come in bursts)
function M.refresh()
  if pending then return end
  pending = true
  vim.defer_fn(function()
    M.load(function() pending = false end)
  end, 150)
end

---@param path string absolute
---@return string? status M.file_status, nil when unchanged or not in the repo
function M.of(path)
  local root = state.root
  if not root or path == "" then return nil end
  if memo[path] ~= nil then return memo[path] or nil end
  local res = false ---@type string|false
  root = vim.fs.normalize(vim.uv.fs_realpath(root) or root) .. "/"
  local real = vim.fs.normalize(vim.uv.fs_realpath(path) or path)
  if real:sub(1, #root) == root then
    local rel = real:sub(#root + 1)
    res = state.files[rel] or false
    if not res then
      for _, ig in ipairs(state.ignored) do
        if rel == ig or (ig:sub(-1) == "/" and rel:sub(1, #ig) == ig) then
          res = "Ignored"
          break
        end
      end
    end
  end
  memo[path] = res
  return res or nil
end

---@return string? current branch of the cwd's repo
function M.branch() return state.branch end

---@return GitStatus? the last read, nil before the first one
function M.last() return state.out and state or nil end

local group = vim.api.nvim_create_augroup("git_status", { clear = true })
vim.api.nvim_create_autocmd({ "VimEnter", "BufWritePost", "FocusGained", "DirChanged", "TermLeave", "ShellCmdPost" }, {
  group = group,
  callback = M.refresh,
})
-- gitsigns notices index / HEAD changes (commit, rollback, checkout from the Git tool window or a terminal)
-- (it fires after edits too: only re-read when .git/index or HEAD changed)
local stamp = ""
vim.api.nvim_create_autocmd("User", {
  group = group,
  pattern = "GitSignsUpdate",
  callback = function()
    if not state.root then return end
    local s = ""
    for _, f in ipairs({ "index", "HEAD" }) do
      local st = vim.uv.fs_stat(state.root .. "/.git/" .. f)
      s = s .. (st and (st.mtime.sec .. "." .. st.mtime.nsec) or "-") .. ";"
    end
    if s ~= stamp then
      stamp = s
      M.refresh()
    end
  end,
})

return M
