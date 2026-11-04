-- The Git tool window's entry points (keys, menus, session, blame). The tool window itself is native
-- (app/src/git/window behind config/app/git.lua); this facade keeps `require("git")` callers working and
-- computes Show History for Selection's lines at HEAD.
local app = require("config.app.git")
local cli = require("git.cli")

local M = {}

M.is_open = app.is_open
M.is_focused = app.is_focused
M.open = app.open -- (tab?, enter?)
M.hide = app.hide
M.toggle = app.toggle -- Cmd+3
M.commit = app.commit -- Cmd+K
M.commit_push = app.commit_push -- Cmd+Alt+K
M.push = app.push -- Cmd+Shift+K
M.file_history = app.file_history -- ,H: the Log filtered to one file
M.show_commit = app.show_commit -- blame: the Log with a commit selected
M.layout = app.layout -- session
M.restore = app.restore

-- Alt+Cmd+Left/Right inside the tool window: Log <-> Local Changes
function M.cycle_tab() app.cycle_tab(1) end

-- Show History for Selection -------------------------------------------------------------------
-- WebStorm's Vcs.ShowHistoryForBlock: the native Log lists the commits that touched the selected lines
-- (git log -L); Lua finds the selected lines in HEAD.

-- Line l of the buffer at HEAD (diff: its changes HEAD -> buffer, vim.text.diff indices). A line that
-- isn't in HEAD: the next one (first) / the one before (last).
---@param diff integer[][]
---@param l integer
---@param first boolean
local function head_line(diff, l, first)
  local delta = 0
  for _, h in ipairs(diff) do
    local sa, ca, sb, cb = h[1], h[2], h[3], h[4]
    if cb > 0 and l >= sb and l < sb + cb then -- changed / added line
      if ca == 0 then return first and sa + 1 or sa end
      return first and sa or sa + ca - 1
    end
    if (cb > 0 and sb + cb - 1 < l) or (cb == 0 and sb < l) then
      delta = delta + ca - cb
    else
      break
    end
  end
  return l + delta
end
M.head_line = head_line -- test hook

---@param buf integer
---@param from integer first line (1-based, the buffer's)
---@param to integer last line
function M.selection_history(buf, from, to)
  local path = vim.api.nvim_buf_get_name(buf)
  if not cli.find_root() then
    return vim.notify("Not a git repository", vim.log.levels.WARN, { title = "Git" })
  end
  local root = assert(cli.root)
  local rel = path ~= "" and not path:match("^%a+://") and vim.bo[buf].buftype == ""
    and (vim.fs.relpath(root, path) or vim.fs.relpath(root, vim.uv.fs_realpath(path) or path)) or nil
  if not rel or rel == "." then
    return vim.notify("No file to show history for", vim.log.levels.INFO, { title = "Git" })
  end
  from, to = math.min(from, to), math.max(from, to)
  local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  cli.async({ "show", "HEAD:" .. rel }, function(ok, head)
    if not ok then
      return vim.notify(rel .. " isn't committed yet", vim.log.levels.INFO, { title = "Git" })
    end
    -- the lines where they are at HEAD (edits since then move them)
    local text = table.concat(lines, "\n") .. "\n"
    ---@type integer[][]
    local diff = text == head and {} or vim.text.diff(head, text, { result_type = "indices" })
    local a, b = head_line(diff, from, true), head_line(diff, to, false)
    if a > b then
      return vim.notify("The selected lines aren't committed yet", vim.log.levels.INFO, { title = "Git" })
    end
    local name = vim.fs.basename(rel)
    local label = from == to and ("%s:%d"):format(name, from) or ("%s:%d-%d"):format(name, from, to)
    app.selection_history({ path = rel, from = a, to = b, label = label })
  end)
end

-- ,H in visual mode (the selection), else the line under the cursor
function M.history_for_selection()
  local a, b = vim.fn.line("."), vim.fn.line(".")
  if vim.fn.mode():match("^[vV\22]") then
    a = vim.fn.line("v")
    vim.cmd("normal! \27")
  end
  M.selection_history(vim.api.nvim_get_current_buf(), a, b)
end

return M
