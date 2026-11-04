-- Annotate (blame) like WebStorm: date + author on every line in the gutter. Enter on a line: show the commit
-- in the Git log. ,å toggles. Rust blames and paints the column (config/app/annotate.lua: WebStorm's colors
-- by revision order, Inter, hover + commit tooltip, menu); here only blank cells of the width it asks for, and
-- the line table.
local M = {}

---@class GitBlameLine
---@field sha string
---@field file? string the file's path in that commit
---@field prev? string the path in its parent commit (nil: added there)

---@class GitBlameState
---@field lines GitBlameLine[]
---@field cell string the reserved cells (statuscolumn), "" until Rust's layout is in

local active = {} ---@type table<integer, GitBlameState>

-- Cached annotation for a line (tests)
function M.line(buf, lnum)
  return active[buf] and active[buf].lines[lnum]
end

local function redraw(buf)
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    vim.api.nvim__redraw({ win = win, statuscolumn = true })
  end
end

-- Blame the buffer's current text (unsaved edits show as "not committed"); Rust blames the file on disk
-- when there's nothing unsaved
local function load(buf)
  local text = vim.bo[buf].modified
    and table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n") .. "\n" or nil
  require("config.app.annotate").notify({ event = "load", buf = buf, path = vim.api.nvim_buf_get_name(buf), text = text })
end

-- statuscolumn: blame, then the usual line number + change bar (config/gutter.lua)
function M.column()
  local buf = vim.api.nvim_get_current_buf() -- the window being drawn
  local a = active[buf]
  return a and a.cell or ""
end

local COLUMN = "%{%v:lua.require'git.blame'.column()%}" .. require("config.gutter").COLUMN

-- The reserved cells' group, one per buffer (the name tells Rust whose annotation a row shows); text-less
-- cells, so only its existence matters (no bg: the caret row's band runs through it until Rust paints over)
local function define_hl(buf)
  vim.api.nvim_set_hl(0, "WsAnnotate" .. buf, { fg = vim.api.nvim_get_hl(0, { name = "Normal" }).bg })
end

-- Its commit in the Git log (Enter, a click on the annotation)
---@param buf integer
---@param lnum integer
function M.show_line(buf, lnum)
  local l = active[buf] and active[buf].lines[lnum]
  if not l or l.sha:match("^0+$") then
    return vim.notify("Not committed yet", vim.log.levels.INFO, { title = "Annotate" })
  end
  require("git").show_commit(l.sha)
end

-- The line's commit as a diff of the file (WebStorm's Show Diff on an annotation)
---@param buf integer
---@param lnum integer
function M.show_diff(buf, lnum)
  local l = active[buf] and active[buf].lines[lnum]
  if not (l and l.file) or l.sha:match("^0+$") then return end
  local f = { path = l.file, status = l.prev and "M" or "A", old_path = l.prev ~= l.file and l.prev or nil }
  if f.old_path then f.status = "R" end
  require("git.diff").open({ f }, f, { old = l.sha .. "^", new = l.sha })
end

-- Rust's blame of buf (config/app/annotate.lua)
---@param buf integer
---@param cells integer
---@param commits {hash: string, file: string, prev?: string}[]
---@param lines integer[]
function M.app_loaded(buf, cells, commits, lines)
  local a = active[buf]
  if not a then return end
  local by = {}
  for i, c in ipairs(commits) do
    by[i] = { sha = c.hash, file = c.file, prev = c.prev ~= vim.NIL and c.prev or nil }
  end
  a.lines = {}
  for lnum, i in ipairs(lines) do a.lines[lnum] = by[i] end
  local cell = ("%%#WsAnnotate%d#%s%%*"):format(buf, string.rep(" ", cells))
  if cell ~= a.cell then
    a.cell = cell
    redraw(buf)
  end
end

function M.enable(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  if active[buf] then return end
  active[buf] = { lines = {}, cell = "" }
  define_hl(buf)
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do vim.wo[win].statuscolumn = COLUMN end
  vim.keymap.set("n", "<CR>", function() M.show_line(buf, vim.api.nvim_win_get_cursor(0)[1]) end,
    { buffer = buf, desc = "Show commit in Git log" })
  local group = vim.api.nvim_create_augroup("git_blame_" .. buf, { clear = true })
  local pending = false
  local function refresh()
    if pending then return end
    pending = true
    vim.defer_fn(function()
      pending = false
      if active[buf] then load(buf) end
    end, 300)
  end
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "BufWritePost", "FocusGained" }, {
    group = group,
    buffer = buf,
    callback = refresh,
  })
  -- a commit / checkout / rollback (gitsigns sees HEAD and the index move); the colorscheme reset the group
  vim.api.nvim_create_autocmd("User", {
    group = group,
    pattern = "GitSignsUpdate",
    callback = function(args)
      if args.data and args.data.buffer == buf then refresh() end
    end,
  })
  vim.api.nvim_create_autocmd("ColorScheme", { group = group, callback = function() define_hl(buf) end })
  load(buf)
end

function M.disable(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  if not active[buf] then return end
  active[buf] = nil
  require("config.app.annotate").notify({ event = "close", buf = buf })
  pcall(vim.api.nvim_del_augroup_by_name, "git_blame_" .. buf)
  pcall(vim.keymap.del, "n", "<CR>", { buffer = buf })
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do vim.wo[win].statuscolumn = "" end
  require("config.gutter").sync_all()
end

function M.is_enabled(buf)
  return active[buf] ~= nil
end

-- ,å
function M.toggle()
  local buf = vim.api.nvim_get_current_buf()
  if active[buf] then M.disable(buf) else M.enable(buf) end
end

-- Keep the gutter when the buffer is shown in another window
vim.api.nvim_create_autocmd("BufWinEnter", {
  callback = function(args)
    local win = vim.api.nvim_get_current_win()
    if active[args.buf] then
      vim.wo[win].statuscolumn = COLUMN
    elseif vim.wo[win].statuscolumn == COLUMN then
      vim.wo[win].statuscolumn = ""
    end
  end,
})

return M
