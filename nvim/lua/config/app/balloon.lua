-- The app's native notification balloons (app/src/popups): snacks' notifier keeps levels, ids, history and the
-- timeout (wired up in plugins/ui.lua); its filter hands every notification here instead of drawing a float, and
-- hiding one (Snacks.notifier.hide) hides its native balloon.
local M = {}

local bridge = require("config.app.bridge")

---@class BalloonAction
---@field label string the link under the text
---@field run fun()

local actions = {} ---@type table<string, fun()> balloon id -> its action (vim.notify's opts.action)

---@param notif snacks.notifier.Notif
function M.show(notif)
  local timeout = notif.timeout
  local action = notif.action --[[@as BalloonAction?]]
  actions[tostring(notif.id)] = action and action.run or nil
  bridge.notify("popups", {
    event = "balloon",
    id = tostring(notif.id),
    level = notif.level,
    title = notif.title ~= "" and notif.title or nil,
    msg = notif.msg,
    timeout = type(timeout) == "number" and math.floor(timeout) or nil,
    action = action and action.label or nil,
  })
end

-- Its action link clicked (app/src/popups)
---@param id string
function M.act(id)
  local run = actions[id]
  if run then run() end
end

---@param id? number|string nil: all
function M.hide(id)
  if id ~= nil then actions[tostring(id)] = nil else actions = {} end
  bridge.notify("popups", { event = "balloon_hide", id = id ~= nil and tostring(id) or nil })
end

-- Lines nothing can be done about, shown on every cloud workspace's attach (#320): no balloon
local QUIET = {
  "^%[Copilot%.lua%] Downloading Copilot server ",
  "^%[Copilot%.lua%] Copilot server %S+ ready",
}

---@param msg any
local function quiet(msg)
  if type(msg) ~= "string" then return false end
  for _, pattern in ipairs(QUIET) do
    if msg:find(pattern) then return true end
  end
  return false
end

-- Notifier filter: snacks never draws a balloon, the app shows it
---@param notif snacks.notifier.Notif
function M.filter(notif)
  if not quiet(notif.msg) then M.show(notif) end
  return false
end

-- After snacks is set up: Snacks.notifier.hide also hides the native balloon
function M.setup()
  local hide = Snacks.notifier.hide
  Snacks.notifier.hide = function(id)
    M.hide(id)
    return hide(id)
  end
end

return M
