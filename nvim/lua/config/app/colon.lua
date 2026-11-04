-- `:` (app/src/shell/projects/mod.rs `colon_at`): `:` in the editor opens Abe's Command mode, not Neovim's
-- command line; with no `abe` (or one that doesn't answer) a line says so and the `:` key is Neovim's command
-- line after all. `::` comes back here as cmdline().
--
-- Keys typed right after `:` (`:w⏎` typed fast) are held (config/app/typeahead.lua, surface "toolbar") until
-- Command mode has the keyboard, then typed into it (or into Neovim's command line).
--
-- Lua -> Rust (`vimstorm.toolbar`): {event = "colon", key?, here}, then the typeahead answer. `here` (#346)
-- is where the keys are: Neovim's Ex command names (`Run in Neovim`), the file at the caret with its line and
-- selection (`Ask about cart.ts:42`), and the caret's context menu items (what ⌘⏎ shows there), `:`'s rows.
-- Rust -> Lua: cmdline() (Neovim's own command line), ex(text) (Command mode's Run in Neovim, #346),
-- item(index) (one of those items chosen in `:`), workflows() (`:workflows`: the tree's abe/workflows).
local M = {}

--- The context menu's actions as last sent, by their 0-based index in `here.items`.
local actions = {} ---@type fun()[]

--- The file at the caret, relative to Neovim's folder (the shown project's), its line and selection.
---@return {file: string, line: integer, selection?: {from: integer, to: integer}}?
local function caret()
  local buf = vim.api.nvim_get_current_buf()
  local name = vim.api.nvim_buf_get_name(buf)
  if vim.bo[buf].buftype ~= "" or name == "" then return nil end
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local at = { file = vim.fn.fnamemodify(name, ":."), line = line }
  if vim.api.nvim_get_mode().mode:match("^[vV\22]") then
    local from, to = vim.fn.line("v"), line
    if from > to then from, to = to, from end
    at.selection = { from = from, to = to }
  end
  return at
end

--- What `:` is told of the Editor: Ex names, the caret, the context menu's items (grey ones with
--- `enabled = false`; separators, info lines and the ones that open a menu of their own (`›`) left out),
--- their shortcuts as the menu shows them (Feel vscode's chords too).
local function here()
  local visual = vim.api.nvim_get_mode().mode:match("^[vV\22]") ~= nil
  local vscode = package.loaded["config.keymap_vscode"]
  local items = {}
  actions = {}
  for _, item in ipairs(require("config.menu").items(visual) or {}) do
    if type(item) == "table" and type(item[1]) == "string" and type(item[2]) == "function" and item.key ~= "›" then
      -- as the menu shows it: Feel vscode's chord, none where VS Code has none
      local key = item.key
      if vscode then key = vscode.key_label(item[1], item.key) end
      items[#items + 1] = { text = item[1], key = key }
      if item.enabled == false then items[#items].enabled = false end
      actions[#items] = item[2]
    end
  end
  return { ex = vim.fn.getcompletion("", "command"), caret = caret(), items = items }
end

--- `:` (`key`: the `:` key itself; ⌘⇧A / ⌘⇧P call it without): Command mode.
--- With no `abe` only the `:` key falls back to Neovim's command line (from Insert or Select mode a
--- literal `:` would be typed into the file).
---@param key boolean?
function M.open(key)
  require("config.app.typeahead").hold("toolbar")
  require("config.app.bridge").notify("toolbar", { event = "colon", key = key == true or nil, here = here() })
end

--- One of the context menu's items chosen in `:` (#346), by its index in the `here` last sent: run as
--- the menu would run it (Visual mode left first, so its '< '> marks are set).
---@param index integer
function M.item(index)
  local fn = actions[index + 1]
  if not fn then return end
  if vim.api.nvim_get_mode().mode:match("^[vV\22]") then vim.cmd("normal! \27") end
  vim.schedule(fn)
end

--- `::`: Neovim's own command line (in Visual mode with its `'<,'>` range), past the `:` mapping.
function M.cmdline()
  local held = require("config.app.typeahead").take("toolbar")
  vim.api.nvim_feedkeys(":", "n", false)
  if #held > 0 then vim.api.nvim_feedkeys(vim.keycode(table.concat(held)), "n", false) end
end

--- Command mode's `Run in Neovim` (#346): `text` on Neovim's own command line as if typed after its `:`
--- (past the `:` map), then Enter: `w` saves, `%s/a/b/g` replaces, `42` goes to the line, a message as usual.
---@param text string
function M.ex(text)
  vim.api.nvim_feedkeys(":" .. text .. "\r", "n", false)
end

-- `:workflows` (Command mode's Anywhere row): the Project tree on the repo's abe/workflows/, open and selected
-- (ADR 0033: the workflows are files, read in the Editor); none yet: the install's Workflows part copies them in
function M.workflows()
  local dir = vim.fn.getcwd() .. "/abe/workflows"
  require("config.workflow").tree()
  if vim.fn.isdirectory(dir) ~= 1 then
    return vim.notify("No abe/workflows here yet: :install copies Abe's in (its Workflows part)", vim.log.levels.WARN)
  end
  require("config.tree").reveal_file(dir, true, true)
end

function M.setup()
  vim.keymap.set({ "n", "x" }, ":", function() M.open(true) end, { desc = "Command mode (:: Neovim's command line)" })
end

return M
