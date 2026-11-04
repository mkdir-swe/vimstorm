-- The app's native replace bar (Rust: app/src/editor/replace): config/replace.lua keeps the engine (matches, the
-- current one, Match Case / Regex, replacing) and sends the bar's state here; the app draws the bar at the top
-- right of the file's split (search field with its count, Cc / .* toggles, previous / next, ×; the
-- replacement field with Replace / Replace All) and owns its fields and keys.
-- Lua -> Rust: show (a new id opens the bar) / state / focus / hide; keys typed right after Cmd+R come as
-- `typeahead` (config/app/typeahead.lua, surface "replace").
-- Rust -> Lua: fields(id, find, replace), toggle(id, "case"|"regex"), step(id, 1|-1), replace(id),
-- replace_all(id), close(id, inside), find(id) (Cmd+F: Neovim's search instead), focused(id).
local bridge = require("config.app.bridge")

local M = {}

---@param payload table
---@return boolean sent
local function notify(payload) return bridge.notify("replace", payload) end

---@param s {id: integer, win: integer, find: string, replace: string, case: boolean, regex: boolean, count: string, none: boolean, current: boolean, total: integer}
---@return boolean sent
function M.show(s) return notify(vim.tbl_extend("force", { event = "show" }, s)) end

---@param s table the same fields as show
function M.state(s) notify(vim.tbl_extend("force", { event = "state" }, s)) end

-- Cmd+R while the bar is open: its search field takes the keyboard again
---@param id integer
function M.focus(id) notify({ event = "focus", id = id }) end

---@param id integer
function M.hide(id) notify({ event = "hide", id = id }) end

-- Rust -> Lua -------------------------------------------------------------------------------------------------

local function engine() return require("config.replace") end

---@param id integer
---@param find string
---@param rep string
function M.fields(id, find, rep) engine().fields(id, find, rep) end

---@param id integer
---@param name "case"|"regex"
function M.toggle(id, name) engine().toggle(id, name) end

---@param id integer
---@param dir integer
function M.step(id, dir) engine().step(id, dir) end

---@param id integer
function M.replace(id) engine().replace_in(id) end

---@param id integer
function M.replace_all(id) engine().replace_all_in(id) end

---@param id integer
---@param inside boolean Esc / ×: the caret on the current match (false: a click elsewhere)
function M.close(id, inside) engine().close(id, inside) end

---@param id integer
function M.find(id) engine().find(id) end

-- The bar's search field has the keyboard: the keys held since Cmd+R go to it
---@param id integer
function M.focused(id) require("config.app.typeahead").focused("replace", id) end

return M
