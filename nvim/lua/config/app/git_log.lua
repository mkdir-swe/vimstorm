-- The app's native Log tab (Rust: app/src/git/window/log) asks Lua for what needs buffers / windows: the diff
-- viewer (git.diff) for a commit's file or a commit's change to selected lines (Show History for Selection),
-- closing that history, opening a file in the editor (F4), commit actions that need Lua (reword's editor).
--
-- Rust -> Lua: open_diff(files, index, old, new, enter), show_change(change, enter), close_history(tab, diff),
-- jump_to_source(path).
-- Lua -> Rust (vimstorm.git_log): change_shown (the lines' diff opened).
local bridge = require("config.app.bridge")

local M = {}

-- A commit's file in the diff viewer (details pane: Enter / double-click). files: {status, path, old_path?}[]
-- in tree order (next / previous file in the diff); the keyboard stays in the Git tool window unless enter.
---@param files {status: string, path: string, old_path?: string}[]
---@param index integer 1-based
---@param old string
---@param new string
---@param enter? boolean
function M.open_diff(files, index, old, new, enter)
  local file = files[index]
  if not file then return end
  local from = vim.api.nvim_get_current_win()
  require("git.diff").open(files, file, { old = old, new = new })
  if enter then
    local w = require("git.diff").wins()
    if w[1] and vim.api.nvim_win_is_valid(w[1]) then vim.api.nvim_set_current_win(w[1]) end
  elseif vim.api.nvim_win_is_valid(from) and vim.api.nvim_get_current_win() ~= from then
    vim.api.nvim_set_current_win(from)
  end
end

-- Show History for Selection: the commit's change to the lines (was M4 Lua git/init.lua show_change)
---@param c {hash: string, path: string, old_path?: string, added: boolean, line: integer}
---@param enter? boolean focus the diff
function M.show_change(c, enter)
  if not (c and c.path and c.path ~= "") then return end
  local file = { path = c.path, old_path = c.old_path, status = c.added and "A" or (c.old_path and "R" or "M") }
  local diff = require("git.diff")
  local from = vim.api.nvim_get_current_win()
  diff.open({ file }, file, { old = c.hash .. "^", new = c.hash })
  if not diff.is_active() then return end
  bridge.notify("git_log", { event = "change_shown" })
  diff.reveal(c.line, enter)
  if not enter and vim.api.nvim_win_is_valid(from) and vim.api.nvim_get_current_win() ~= from then
    vim.api.nvim_set_current_win(from)
  end
end

-- Esc / ,q / the Lines chip's ×: the lines' diff closed, the tool window as it was (hidden again, or Local
-- Changes), back in the editor (was M4 Lua git/init.lua close_selection_history)
---@param tab? string the tab shown before ("log" / "changes"; nil: the tool window was hidden)
---@param diff boolean the history opened the lines' diff
function M.close_history(tab, diff)
  local focus = require("config.focus")
  if diff and focus.viewer() == "diff" then require("git.diff").close() end
  local git = require("config.app.git")
  if tab == nil or tab == vim.NIL then return git.hide() end
  if tab ~= "log" then git.open(tab, false) end
  focus.editor()
end

-- F4: the working-tree file in the editor
---@param path string repo-relative
function M.jump_to_source(path)
  local root = require("git.cli").root
  if not root then return end
  local abs = root .. "/" .. path
  if not vim.uv.fs_stat(abs) then
    return vim.notify(path .. " doesn't exist anymore", vim.log.levels.INFO, { title = "Git" })
  end
  require("config.focus").edit()
  vim.cmd.edit(vim.fn.fnameescape(abs))
end

return M
