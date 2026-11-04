-- The app's native Local Changes tab (Rust: app/src/git/window/changes): the
-- parts that need nvim. Rust runs git itself; it calls here to open a diff / the merge window (git/diff.lua,
-- git/merge.lua keep the buffers), to open a file in the editor, to save the buffers before a commit and to
-- reload buffers + every git listener after it changed the repo.
--
-- Lua -> Rust (`vimstorm.git_changes`): saved (a buffer was written: Local Changes reloads), saved_all
-- {token} (the buffers are written: the commit can run).
local bridge = require("config.app.bridge")
local cli = require("git.cli")

local M = {}

local function notify(payload) return bridge.notify("git_changes", payload) end

local function with_root(root)
  if root and root ~= "" then cli.root = root end
  return cli.root or cli.find_root()
end

-- A diff of files[index] against revs (Enter / double-click in Local Changes; a change of a PR under
-- review (the Git Log's PR filter): `old` the merge base, `new` the PR head, `line` the change's line on the new
-- side, `review` the PR). Alt+Cmd+arrows in the diff step through `files` (git/diff.lua). files: { path, old_path?,
-- status } (GitFile).
---@param root string
---@param files GitFile[]
---@param index integer
---@param old string
---@param new? string nil: the work tree (editable)
---@param line? integer the current version's line to land on (else the first change)
---@param review? {pr: integer} a PR's diff: the `,i` review keys work in it (config/app/review.lua)
function M.diff(root, files, index, old, new, line, review)
  if not with_root(root) or not files[index] then return end
  for _, f in ipairs(files) do
    if f.old_path == vim.NIL then f.old_path = nil end
  end
  local diff = require("git.diff")
  diff.open(files, files[index], { old = old, new = new ~= vim.NIL and new or nil },
    type(review) == "table" and review or nil)
  if type(line) == "number" and line > 0 then diff.reveal(line) end
end

-- A conflicted file: the merge window
---@param root string
---@param path string repo-relative
function M.merge(root, path)
  if not with_root(root) then return end
  require("git.merge").open({ path = path, status = "U" })
end

-- F4: the file in the editor
---@param path string absolute
function M.jump(path)
  require("config.focus").edit()
  vim.cmd.edit(vim.fn.fnameescape(path))
end

-- Before a commit (changes.lua's `silent! wall`): Rust commits once this answers
---@param token integer
function M.save_all(token)
  require("config.app.agent_files").save_all()
  notify({ event = "saved_all", token = token })
end

-- Rust changed the repo (commit, rollback, push, ...): buffers reload, the status bar / gutters /
-- Git tool window hear it (git/cli.lua act's tail)
function M.changed()
  vim.cmd("silent! checktime")
  cli.changed()
end

-- Show History for File
---@param path string absolute
function M.file_history(path)
  require("config.app.git").file_history(path)
end

function M.setup()
  -- autosave / :w: Local Changes shows it (like the M4 Lua git/init.lua's BufWritePost reload)
  vim.api.nvim_create_autocmd("BufWritePost", {
    group = vim.api.nvim_create_augroup("ws_app_git_changes", { clear = true }),
    callback = function()
      if require("config.app.git").is_open() then notify({ event = "saved" }) end
    end,
  })
end

return M
