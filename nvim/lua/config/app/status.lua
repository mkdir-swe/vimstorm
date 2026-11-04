-- The app's status bar (Rust: app/src/editor/statusbar): config/statusline.lua's parts (mode badge, navigation path,
-- line:col, line ending, encoding, indent, branch; always about the last focused split) sent to the app when they
-- change. Cursor moves are the only per-keystroke trigger: building the parts is a few API calls, and an
-- unchanged status isn't sent again.
local bridge = require("config.app.bridge")
local M = {}

local last = ""

-- Sends the status when it changed (force: anyway)
---@param force? boolean
function M.sync(force)
  local ok, parts = pcall(require("config.statusline").parts)
  if not ok then return end
  local syms = {}
  for _, sy in ipairs(parts.symbols or {}) do syms[#syms + 1] = sy.kind .. ":" .. sy.name end
  local c = parts.caret
  local at = c and (c.file .. ":" .. c.line .. ":" .. (c.from or "") .. "-" .. (c.to or "")) or ""
  local key = table.concat({ parts.mode, parts.recording, parts.file, parts.branch, tostring(parts.readonly),
    table.concat(parts.crumbs, "/"), table.concat(parts.right, "\0"), table.concat(syms, "/"), at }, "\1")
  if key == last and not force then return end
  last = key
  parts.event = "status"
  bridge.notify("statusbar", parts)
end

local pending = false
-- After the event's other handlers ran (git status read, buffer options set), coalesced
local function later()
  if pending then return end
  pending = true
  vim.schedule(function()
    pending = false
    M.sync()
  end)
end

function M.setup()
  local group = vim.api.nvim_create_augroup("ws_app_status", { clear = true })
  -- now: it reaches the app with the redraw of the same key
  vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI", "ModeChanged", "RecordingEnter" }, {
    group = group,
    callback = function() M.sync() end,
  })
  -- the last focused split changed while something else is current (a tab closed / switched by mouse from a tool
  -- window, a split scrolled under the mouse: its caret moved without CursorMoved), anything Lua's per-redraw
  -- status line picked up
  vim.api.nvim_create_autocmd({ "RecordingLeave", "BufEnter", "WinEnter", "WinClosed", "WinNew", "BufWinEnter",
    "BufWinLeave", "BufDelete", "BufFilePost", "WinScrolled", "WinResized", "TermEnter", "TermLeave", "DirChanged",
    "BufWritePost", "BufModifiedSet", "FileType", "TabEnter", "VimEnter", "UIEnter" }, {
    group = group,
    callback = later,
  })
  vim.api.nvim_create_autocmd("OptionSet", {
    group = group,
    pattern = { "fileformat", "fileencoding", "shiftwidth", "tabstop", "expandtab", "readonly", "modifiable" },
    callback = later,
  })
  require("git.status").on_change(later) -- the branch
  M.sync(true)
end

return M
