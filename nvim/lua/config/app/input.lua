-- The app's native text field popup (app/src/popups) as vim.ui.input (rename, the tree's file names): the prompt
-- as its title, the default text selected (typing replaces it, like WebStorm's fields), below the
-- caret, or at opts.pos (window px) for a native surface. Rust answers done(id, text|nil); Esc / a click outside: nil.
-- opts.dialog = {text?, hints?}: drawn as Abe's prompt instead (a confirm with a body: centred near the top, the
-- prompt as its header, a line of text above the field, the keys below; the PR review's verdict).
-- opts.placeholder: the empty field's grey hint (default "Name", the rename / new file fields').
-- Keys typed right after the shortcut, before the field has the keyboard (`,ic` then the comment at once), are
-- held (config/app/typeahead.lua): not run in the buffer, they go to the field first once Rust calls
-- focused(id).
local M = {}

local bridge = require("config.app.bridge")
local typeahead = require("config.app.typeahead")

local pending = {} ---@type table<integer, fun(text: string?)>
local kinds = {} ---@type table<integer, string> completion kind per open field
local last_id = 0

---@param opts? {prompt?: string, default?: string, completion?: string, pos?: {x: number, y: number}, dialog?: {text?: string, hints?: string}, placeholder?: string}
---@param on_confirm fun(text: string?)
function M.input(opts, on_confirm)
  opts = opts or {}
  -- one field at a time: an open one is cancelled (the app replaces it)
  for id, cb in pairs(pending) do
    pending[id] = nil
    vim.schedule(function() cb(nil) end)
  end
  last_id = last_id + 1
  pending[last_id] = on_confirm
  kinds = { [last_id] = opts.completion }
  typeahead.hold("popups")
  local sent = bridge.notify("popups", {
    event = "input",
    id = last_id,
    title = opts.prompt,
    text = opts.default or "",
    completion = opts.completion, -- Tab completes like input()'s (complete() below)
    dialog = opts.dialog,
    placeholder = opts.placeholder,
    anchor = require("config.app.menu").anchor("cursor", opts.pos),
  })
  if not sent then typeahead.stop("popups") end
end

-- The app gave field `id` the keyboard: the keys held since it was asked for go to it
---@param id integer
function M.focused(id)
  typeahead.focused("popups", id)
end

---@param id integer
---@param text string?
function M.done(id, text)
  if text == vim.NIL then text = nil end -- RPC nil arrives as vim.NIL
  local cb = pending[id]
  pending[id] = nil
  -- answered before it had the keyboard (a test, a lost focus): nothing is held for it any more
  if cb then typeahead.stop("popups") end
  if cb then vim.schedule(function() cb(text) end) end
end

-- Tab in a field with `completion`: input()'s completions of its text ("file", "dir", ...)
---@param id integer
---@param text string
function M.complete(id, text)
  local kind = pending[id] and kinds[id]
  if not kind then return end
  local ok, items = pcall(vim.fn.getcompletion, text, kind)
  bridge.notify("popups", { event = "input_complete", id = id, text = text, items = ok and items or {} })
end

function M.is_open()
  return next(pending) ~= nil
end

return M
