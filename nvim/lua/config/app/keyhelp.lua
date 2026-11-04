-- ,?: the native key help (app/src/popups), WebStorm-like list of the leader keys. Sends the leader mappings
-- (normal mode, buffer-local first) with their descriptions and the group names; Rust lets the user go on with
-- the sequence and calls run(keys) for the mapping picked (keys after the leader).
local M = {}

-- group names of leader prefixes
local GROUPS = { c = "code", f = "find", i = "review", r = "refactor", t = "test" }

local function leader()
  local l = vim.g.mapleader
  return (l == nil or l == "") and "\\" or l
end

function M.show()
  local lead = leader()
  local seen, entries = {}, {}
  local function add(maps)
    for _, m in ipairs(maps) do
      local lhs = m.lhs or ""
      if vim.startswith(lhs, lead) and #lhs > #lead and not seen[lhs] and not lhs:find("<Plug>", 1, true) then
        seen[lhs] = true
        local desc = m.desc
        if not desc and type(m.rhs) == "string" and m.rhs ~= "" then desc = m.rhs end
        if desc then
          entries[#entries + 1] = { keys = lhs:sub(#lead + 1), desc = desc }
        end
      end
    end
  end
  add(vim.api.nvim_buf_get_keymap(0, "n"))
  add(vim.api.nvim_get_keymap("n"))
  local groups = {}
  for k, name in pairs(GROUPS) do groups[#groups + 1] = { keys = k, desc = name } end
  require("config.app.bridge").notify("popups", { event = "key_help", leader = lead, entries = entries, groups = groups })
end

-- The mapping picked in the key help: as if typed
---@param keys string after the leader
function M.run(keys)
  vim.api.nvim_feedkeys(vim.keycode(leader() .. keys), "m", false)
end

return M
