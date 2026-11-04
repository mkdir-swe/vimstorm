-- Typeahead: keys typed right after a shortcut that opens a native field (a picker, the text field of
-- vim.ui.input) reach Neovim before the app has given that field the keyboard. They're held back here (not
-- run in the editor: `u` would undo, `x` would delete) and handed to the field, which puts them before
-- anything typed into it directly. focused(surface, token) (from the app, once the field has the keyboard)
-- queues a marker key behind the keys still waiting in the input buffer (the app sent them before it took
-- the keyboard; Neovim runs the call before reading them): the marker ends the hold. Every marker is answered
-- to its surface with {event = "typeahead", token, keys} (keys may be empty): the app keeps keys typed into
-- the field until then, so they come after the held ones (an early Enter doesn't take half the text).
-- The hold ends right at the marker, not in scheduled code: a key queued behind it (Cmd+O again after Esc) is
-- read before scheduled code runs and must reach its mapping.
local bridge = require("config.app.bridge")
local M = {}

local TYPEAHEAD = vim.api.nvim_create_namespace("ws_app_picker_typeahead")
local holding = false
local held = {} ---@type string[]
local hold_surface = "pickers" -- who gets what a hold ended by its fallback timer held
local hold_gen = 0 -- which hold a fallback timer belongs to
local MARKER = "<F37>" -- a key nobody types
local MARKER_KEY = vim.keycode(MARKER)
local waiting = {} ---@type {surface: string, token: integer}[] one per marker in flight

-- Ends the hold; returns what it held
---@return string[]
local function end_hold()
  local keys = held
  holding, held = false, {}
  return keys
end

vim.on_key(function(_, typed)
  if typed ~= MARKER_KEY then return end
  local w = table.remove(waiting, 1) or { surface = hold_surface, token = 0 }
  local keys = end_hold()
  vim.schedule(function() bridge.notify(w.surface, { event = "typeahead", token = w.token, keys = keys }) end)
  return ""
end, vim.api.nvim_create_namespace("ws_app_picker_marker"))

vim.on_key(function(_, typed)
  if not holding or typed == MARKER_KEY then return end
  -- keys a mapping of a held key expands to (typed = ""): dropped too (`d` -> `"zd` ran zd)
  if typed == nil or typed == "" then return "" end
  held[#held + 1] = vim.fn.keytrans(typed)
  return ""
end, TYPEAHEAD)

-- Ends a hold the app never answered (only `surface`'s, when given): what it held goes to its surface
-- without a token
---@param surface? string
function M.stop(surface)
  if not holding or (surface and surface ~= hold_surface) then return end
  local surface = hold_surface
  local keys = end_hold()
  if #keys > 0 then bridge.notify(surface, { event = "typeahead", keys = keys }) end
end

-- Ends `surface`'s hold here and returns what it held (nothing is sent: the caller types it itself)
---@param surface string
---@return string[]
function M.take(surface)
  if not holding or surface ~= hold_surface then return {} end
  return end_hold()
end

-- Holds the keys typed from now until `surface`'s field has the keyboard
---@param surface string the bridge surface the keys go to ("pickers", "popups")
function M.hold(surface)
  if holding then return end
  holding, held, hold_surface = true, {}, surface
  hold_gen = hold_gen + 1
  local gen = hold_gen
  -- the app answers at once; never hold keys forever (no app UI, a lost message). Only this hold: an older
  -- hold's timer ended a later one halfway (the rest of the text ran in the editor)
  vim.defer_fn(function()
    if gen == hold_gen then M.stop() end
  end, 3000)
end

-- The app gave `surface`'s field the keyboard: once the keys queued before that are read, what was held
-- goes to it
---@param surface string
---@param token? integer
function M.focused(surface, token)
  waiting[#waiting + 1] = { surface = surface, token = token or 0 }
  vim.api.nvim_input(MARKER)
end

return M
