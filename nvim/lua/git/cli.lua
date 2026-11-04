-- Thin wrapper around the git CLI, run in the repo root (found once per cwd, for every git module).
local M = {}

M.root = nil ---@type string?

local roots = {} ---@type table<string, string> cwd -> repo root (a found repo stays one)

---@return string? root cached for the cwd while it's still a repo
local function cached(cwd)
  if roots[cwd] and vim.uv.fs_stat(roots[cwd] .. "/.git") then return roots[cwd] end
end

---@param cwd string
---@param r vim.SystemCompleted rev-parse --show-toplevel
local function found(cwd, r)
  M.root = r.code == 0 and vim.trim(r.stdout) or nil
  roots[cwd] = M.root
  return M.root
end

-- Find the repo for the current directory; returns its root or nil
function M.find_root()
  local cwd = vim.fn.getcwd()
  M.root = cached(cwd)
  if M.root then return M.root end
  return found(cwd, vim.system({ "git", "rev-parse", "--show-toplevel" }, { cwd = cwd, text = true }):wait())
end

-- Like find_root, without blocking (git status at startup)
---@param cb fun(root: string?)
function M.find_root_async(cb)
  local cwd = vim.fn.getcwd()
  M.root = cached(cwd)
  if M.root then return cb(M.root) end
  vim.system({ "git", "rev-parse", "--show-toplevel" }, { cwd = cwd, text = true }, vim.schedule_wrap(function(r)
    cb(found(cwd, r))
  end))
end

local on_change = {} ---@type fun()[]

-- The repo changed (commit, checkout, push, ...): fn reloads what shows it (the Git tool window)
---@param fn fun()
function M.on_change(fn)
  on_change[#on_change + 1] = fn
end

function M.changed()
  for _, fn in ipairs(on_change) do fn() end
end

---@param args string[]
---@param opts? {env?: table<string,string>, stdin?: string}
---@return boolean ok, string stdout, string stderr
function M.run(args, opts)
  opts = opts or {}
  local r = vim.system(vim.list_extend({ "git" }, args), { cwd = M.root, text = true, env = opts.env, stdin = opts.stdin })
    :wait()
  return r.code == 0, r.stdout or "", r.stderr or ""
end

---@param args string[]
---@param cb fun(ok: boolean, stdout: string, stderr: string)
---@param opts? {env?: table<string,string>}
function M.async(args, cb, opts)
  opts = opts or {}
  vim.system(vim.list_extend({ "git" }, args), { cwd = M.root, text = true, env = opts.env }, vim.schedule_wrap(function(r)
    cb(r.code == 0, r.stdout or "", r.stderr or "")
  end))
end

-- Run a command that changes the repo; notify on failure, reload buffers + the Git tool window after
---@param args string[]
---@param msg? string success message
function M.act(args, msg, opts)
  local ok, out, err = M.run(args, opts)
  if ok then
    if msg then vim.notify(msg, vim.log.levels.INFO, { title = "Git" }) end
  else
    vim.notify(vim.trim(err ~= "" and err or out), vim.log.levels.ERROR, { title = "git " .. args[1] })
  end
  vim.cmd("silent! checktime")
  M.changed()
  return ok
end

-- File content at a revision ("" for a missing file)
function M.show(rev, path)
  local ok, out = M.run({ "show", rev .. ":" .. path })
  return ok and out or ""
end

return M
