-- Shift Shift (tap Shift twice quickly): Search Everywhere, like WebStorm. Works from anywhere, also while
-- typing. The app detects the double tap and calls config/app.lua's double_shift(); on a Search Everywhere tab
-- other than All the native picker switches to All (keeping the typed text).
local M = {}

-- Open Search Everywhere (the action behind Shift Shift)
function M.trigger()
  if vim.api.nvim_get_mode().mode:match("^[cr]") then return end -- command line / prompt: leave it alone
  require("config.app.pickers").double_shift()
end

return M
