-- Focus state for the focus cues the app draws (WebStorm Islands: the split / tool window with focus shows its
-- "active" colors, everything goes inactive while the window is in the background).
-- vim.g.ws_focus = the focus target (config/focus.lua: "tree" | "split" | "diff" | "merge" | "git" | "terminal" |
-- "other"; popups keep the target under them).
local focus = require("config.focus")
local M = {}

local state = { target = "split", app = true } ---@type {target: FocusTarget, app: boolean}

-- Re-read what has focus (a popup: what's under it)
function M.update()
  local target = focus.target()
  if target == "popup" then target = state.target end
  if target == state.target and vim.g.ws_focus == target then return end
  state.target, vim.g.ws_focus = target, target
end

---@return boolean the app window has focus
function M.app_focused() return state.app end

function M.setup()
  local group = vim.api.nvim_create_augroup("ws_focuscue", { clear = true })
  vim.api.nvim_create_autocmd({ "WinEnter", "BufEnter", "WinClosed", "VimEnter" }, {
    group = group,
    callback = function() vim.schedule(M.update) end,
  })
  vim.api.nvim_create_autocmd({ "FocusGained", "FocusLost" }, {
    group = group,
    callback = function(ev) state.app = ev.event == "FocusGained" end,
  })
end

return M
