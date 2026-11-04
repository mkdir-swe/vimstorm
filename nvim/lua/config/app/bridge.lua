-- Lua -> app bridge (the VimStorm app's native surfaces; Rust side: app/src/nvim/lua, app/src/shell).
-- notify(surface, payload) sends the RPC notification "vimstorm.<surface>" with one table to the app's UI
-- channel; payload = { event = "<name>", ...typed fields }. Rust routes it to that surface's on_bridge.
-- Rust -> Lua goes the other way as nvim_exec_lua notifications: require("config.app.<surface>").<fn>(...).
local M = {}

local chan ---@type integer?

-- The app's UI channel (the first remote UI); nil without one (terminal nvim, headless)
---@return integer?
function M.channel()
  if chan and vim.api.nvim_get_chan_info(chan).id then return chan end
  chan = nil
  for _, ui in ipairs(vim.api.nvim_list_uis()) do
    if (ui.chan or 0) > 0 then
      chan = ui.chan
      break
    end
  end
  return chan
end

---@param surface string e.g. "tree", "layout"
---@param payload table { event = string, ... }
---@return boolean sent
function M.notify(surface, payload)
  local c = M.channel()
  if not c then return false end
  return pcall(vim.rpcnotify, c, "vimstorm." .. surface, payload)
end

return M
