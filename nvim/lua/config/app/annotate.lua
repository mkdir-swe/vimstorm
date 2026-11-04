-- The app's Annotate (git blame) and change gutter (Rust: app/src/git/annotate). git/blame.lua sends the buffer
-- to annotate (its unsaved text when modified); Rust blames it off the UI thread, lays the WebStorm texts out
-- in Inter and answers loaded(): Lua reserves that many blank cells in the statuscolumn (hl WsAnnotate<buf>,
-- which tells Rust whose annotation a row shows) and keeps the line -> commit table (Enter, menus). Rust paints
-- the column, the hover and the commit tooltip; clicks come back here. The change bars: gitsigns' signs are
-- blank (plugins/ui.lua), Rust paints WebStorm's bars from their hl groups.
local M = {}

local bridge = require("config.app.bridge")

---@param payload table
function M.notify(payload) return bridge.notify("annotate", payload) end

-- Rust: buf's blame is in. cells: the column's width; lines: per line the 1-based index into commits
---@param buf integer
---@param cells integer
---@param commits {hash: string, file: string, prev?: string}[] file: the path in that commit; prev: its parent's
---@param lines integer[]
function M.loaded(buf, cells, commits, lines)
  require("git.blame").app_loaded(buf, cells, commits, lines)
end

-- Rust: git blame failed (not tracked, not a repo...): off, with git's message, as the Lua did
---@param buf integer
---@param msg string
function M.failed(buf, msg)
  local blame = require("git.blame")
  if not blame.is_enabled(buf) then return end
  blame.disable(buf)
  vim.notify(vim.trim(msg), vim.log.levels.WARN, { title = "Annotate" })
end

-- Rust: a click on a line's annotation: its commit in the Git log
---@param buf integer
---@param lnum integer
function M.click(buf, lnum)
  require("git.blame").show_line(buf, lnum)
end

-- Rust: a click on a change marker: that hunk's popup (gitsigns preview, as a click on the terminal's sign; the
-- app's marker is clickable with annotations on and on both halves of a deleted-lines marker)
---@param win integer
---@param lnum integer the marker's line (deleted lines: the line above them, 1 for lines deleted above line 1)
function M.marker_click(win, lnum)
  if not vim.api.nvim_win_is_valid(win) then return end
  vim.api.nvim_set_current_win(win)
  vim.api.nvim_win_set_cursor(win, { math.min(lnum, vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))), 0 })
  require("gitsigns").preview_hunk()
end

-- Rust: right-click on a line's annotation: WebStorm's annotation menu
---@param buf integer
---@param lnum integer
---@param x number window px
---@param y number
function M.menu(buf, lnum, x, y)
  local blame = require("git.blame")
  local l = blame.line(buf, lnum)
  local committed = l ~= nil and not l.sha:match("^0+$")
  local sha = l and l.sha or ""
  local items = {
    { "Show Diff", function() blame.show_diff(buf, lnum) end, enabled = committed },
    { "Copy Revision Number", function()
      vim.fn.setreg("+", sha)
      vim.notify("Copied " .. sha, vim.log.levels.INFO, { title = "Annotate" })
    end, enabled = committed },
    { "Select in Git Log", function() blame.show_line(buf, lnum) end, enabled = committed },
    "-",
    { "Close Annotations", function() blame.disable(buf) end, key = ",å" },
  }
  require("config.menu").open(items, { at = "mouse", pos = { x = x, y = y } })
end

return M
