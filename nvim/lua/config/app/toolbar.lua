-- The VimStorm app's main toolbar (app/src/shell/toolbar): window title, the Recent Projects… / Branches… popups.
-- Lua -> Rust: menu items that open the toolbar's popups (the branch popups have no widget: Branches… / New
-- Branch… open them under the toolbar), opening / closing / cycling the window's open projects (each has its own
-- Neovim; app/src/shell/projects/mod.rs).
-- Rust -> Lua: git_done() after a checkout / new branch made from the toolbar, switch_check() before it closes
-- this project.
local M = {}

local function notify(payload) require("config.app.bridge").notify("toolbar", payload) end

---@param what "branches"|"new_branch"|"projects"
function M.open(what) notify({ event = "open", what = what }) end

-- Show a project in this window alongside this one: an open one at once, else the app starts its Neovim (this one
-- keeps running)
---@param path string
function M.open_project(path) notify({ event = "open_project", path = path }) end

-- Close Project (Cmd+Q): this one (the app asks first when work would be lost, then shows the next open project in
-- the rail's order; closing the last one quits the app)
function M.close_project() notify({ event = "close_project" }) end

-- Down (1) / Up (-1) the Rail: the workspace below / above, round again (Cmd+Down / Cmd+Up, handled in
-- Rust before Neovim sees them)
---@param by 1|-1
function M.cycle_project(by) notify({ event = "cycle_project", by = by }) end

-- The toolbar checked out / created a branch (it shows the result itself): reload changed buffers and the git views
---@param ok boolean
function M.git_done(ok)
  vim.cmd("silent! checktime")
  if ok then require("git.cli").changed() end
  require("git.status").refresh()
end

---@class ToolbarSwitchCheck
---@field jobs integer terminals running something besides their idle shell
---@field unsaved integer modified buffers that couldn't be written (no name, readonly, write error)

-- Before the app closes this project (this Neovim quits): save what can be saved, say what would be lost
---@return ToolbarSwitchCheck
function M.switch_check()
  require("config.app.agent_files").save_all()
  local unsaved = 0
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].modified and vim.bo[b].buftype == "" then
      unsaved = unsaved + 1
    end
  end
  -- jobs: the native terminal's shells (app/src/terminal) running something
  return { jobs = require("config.app.terminal").busy(), unsaved = unsaved }
end

-- Editor menu entries for the toolbar's actions (config/context.lua adds them after Commit / Push)
---@return MenuEntry[]
function M.menu_items()
  return {
    { "Branches…", function() M.open("branches") end },
    { "New Branch…", function() M.open("new_branch") end },
    { "Recent Projects…", function() M.open("projects") end },
    { "Close Project", M.close_project, key = "⌘Q" },
    { "Down the Rail", function() M.cycle_project(1) end, key = "⌘↓" },
    { "Up the Rail", function() M.cycle_project(-1) end, key = "⌘↑" },
  }
end

return M
