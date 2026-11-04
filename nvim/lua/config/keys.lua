-- Your keys (#129): your Layer's keys.json (`abe settings import` writes it, Keymap later), sent with the Feel as
-- `keys` = { {key = "⌘Y", action = "goToFile", lhs = {"<D-y>"}, does = "<D-o>"}, ... }. Each key does what VimStorm's
-- key for its action does (`does`: that key's map before any key of yours or the Feel vscode covered it), in Normal,
-- Insert and Visual mode, over the Feel's keys. A new set takes the last one off first, the maps it covered put back
-- exactly. Applied by config/keymap_vscode.lua's Feel listener, after the Feel's own chords.
local M = {}

local MODES = { "n", "i", "x" }

-- VimStorm keys the window owns, never nvim's maps (the pane keys, app/src/shell/pane_key.rs): a key of yours for
-- their action asks the app, as the key would
local APP = { ["<D-1>"] = "project" }

--- The pane `lhs` (a VimStorm key) is the window's key for, if it is one
---@param lhs string
---@return string?
function M.app(lhs) return APP[lhs] end

local function does(lhs)
  if APP[lhs] then return require("config.app.bridge").notify("pane_key", APP[lhs]) end
  require("config.keymap_vscode").webstorm(lhs)
end

-- What was mapped before: { mode, lhs, maparg dict or false }
local saved ---@type {[1]: string, [2]: string, [3]: table|false}[]?

-- The global map only (a buffer-local one on the same key stays the buffer's)
local function global_map(mode, lhs)
  local raw = vim.api.nvim_replace_termcodes(lhs, true, true, true)
  for _, m in ipairs(vim.api.nvim_get_keymap(mode)) do
    if m.lhsraw == raw then
      -- (nvim_get_keymap says a <Nop> map's rhs is "": mapset would restore a map that does what the key does)
      if m.rhs == "" and not m.callback then m.rhs = "<Nop>" end
      return m
    end
  end
  return false
end

--- The map `lhs` had in `mode` before a key of yours covered it: the dict, false (none), nil (not one of yours)
---@return table|false|nil
function M.before(mode, lhs)
  for _, s in ipairs(saved or {}) do
    if s[1] == mode and s[2] == lhs then return s[3] end
  end
end

---@param keys {key: string, action: string, lhs: string[], does: string}[]?
function M.apply(keys)
  M.remove()
  saved = {}
  for _, k in ipairs(type(keys) == "table" and keys or {}) do
    if type(k.lhs) == "table" and type(k.does) == "string" then
      for _, lhs in ipairs(k.lhs) do
        for _, mode in ipairs(MODES) do
          saved[#saved + 1] = { mode, lhs, global_map(mode, lhs) }
          vim.keymap.set(mode, lhs, function() does(k.does) end,
            { desc = ("%s (yours: %s)"):format(k.action, k.key) })
        end
      end
    end
  end
end

function M.remove()
  if not saved then return end
  for i = #saved, 1, -1 do
    local mode, lhs, before = saved[i][1], saved[i][2], saved[i][3]
    pcall(vim.keymap.del, mode, lhs)
    if before then vim.fn.mapset(before) end
  end
  saved = nil
end

return M
