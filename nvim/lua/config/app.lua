-- Bridge to the VimStorm app (the GPUI window embedding this Neovim; vim.g.vimstorm_app set with --cmd).
-- The app calls these over RPC (nvim_exec_lua notifications):
--   double_shift()   Shift tapped twice (config/doubleshift.lua)
--   native_focus(name|nil)  a native surface ("tree", "popup", ...) has the keyboard / gave it back (focus.target())
-- setup() (from init.lua) adds Cmd+V paste and the macOS text keys, and swallows unmapped Cmd keys.
-- Native surfaces: config/app/bridge.lua (Lua -> Rust), config/app/layout.lua (window kinds for the layout).
local M = {}

local native ---@type string?

-- Focus changes this side asked the app for (M.focus / M.expect), numbered: keys typed right after one
-- (Cmd+1 Cmd+T) are already in nvim's typeahead, and nvim reads typeahead before the app's queued
-- native_focus notifications, so they must see the focus asked for, not the one the app last reported
local asked = 0

local function changed()
  pcall(function() require("config.focuscue").update() end)
  pcall(function() require("config.app.tabs").changed() end) -- the selected tab's box: blue / gray
  -- another native surface took the keyboard (no WinLeave here): the hover / Quick Definition popups close
  if native and native ~= "floats" then pcall(function() require("config.app.floats").focus_left(native) end) end
end

-- The app says which native surface has the keyboard (nil: Neovim has it). focus.target() answers from it.
-- seq: the app holds keys for nvim until this is acked, so a key typed after a focus change the app made
-- (a click, Esc in a popup) acts on the new focus; answered: the last focus request (asked) the app had
-- handled when it sent this (older than ours: stale, ours stands until the app's answer comes)
---@param name string|nil
---@param seq? integer
---@param answered? integer
function M.native_focus(name, seq, answered)
  -- (scheduled: after what the app's notifications before this scheduled, e.g. the switcher's pick)
  if seq then
    vim.schedule(function() pcall(vim.rpcnotify, require("config.app.bridge").channel() or 0, "vimstorm.input_ack", seq) end)
  end
  if answered and answered < asked then return end
  native = type(name) == "string" and name or nil
  changed()
end

-- The native surface with the keyboard, if any
---@return string?
function M.native() return native end

-- A surface takes the keyboard because of something this side sent (terminal / Git `open {enter}`):
-- focus.target() answers it at once (see `asked`); the app's native_focus confirms it
---@param name? string
function M.expect(name)
  asked = asked + 1
  native = name
  require("config.app.bridge").notify("focus", { event = "expect", asked = asked })
  changed()
end

-- Ask the app to give the keyboard to a native surface (name) or back to Neovim (nil)
---@param name? string
function M.focus(name)
  asked = asked + 1
  native = name
  if name then
    require("config.app.bridge").notify("focus", { event = "surface", name = name, asked = asked })
  else
    require("config.app.bridge").notify("focus", { event = "editor", asked = asked })
  end
  changed()
end

-- Shift Shift: Search Everywhere
function M.double_shift()
  vim.schedule(require("config.doubleshift").trigger)
end

-- macOS keys the app sends as plain <D-…> / <M-…> keys
local function keys()
  local map = vim.keymap.set
  local all = { "n", "i", "x", "s", "c" }
  -- Cmd+V: through vim.paste, like a terminal's bracketed paste (config/editing.lua's whole-line paste)
  map(all, "<D-v>", function() vim.api.nvim_paste(vim.fn.getreg("+"), true, -1) end, { desc = "Paste" })
  -- macOS text keys: in Insert / Command-line mode Cmd+Left / Right go to the line's start / end, Cmd+Backspace
  -- deletes to it, Alt+Left / Right move by word
  map({ "i", "s", "c" }, "<D-BS>", "<C-u>", { remap = true })
  map({ "i", "c" }, "<D-Left>", "<Home>")
  map({ "i", "c" }, "<D-Right>", "<End>")
  map(all, "<M-Left>", "<M-b>", { remap = true })
  map(all, "<M-Right>", "<M-f>", { remap = true })
  -- the physical keys: Cmd+Shift+7 (Swedish /) is Cmd+/, Cmd+Shift++ is Cmd+Shift+=, Cmd+Shift+0 (Swedish =) is Cmd+=
  map(all, "<D-S-7>", "<D-/>", { remap = true })
  map(all, "<D-S-+>", "<S-D-=>", { remap = true })
  map(all, "<D-S-0>", "<D-=>", { remap = true })
  -- A Cmd key no mapping took (Cmd+E, Cmd+N, Cmd+Up, Cmd+8, Cmd+9) does nothing, instead of typing "<D-n>".
  -- on_key sees keys after mappings: K_SPECIAL KS_MODIFIER with the Cmd bit (0x80).
  -- In Visual mode on_key also sees a mapped key before its mapping (the diff's buffer-local Cmd+L / Cmd+Ö
  -- were dropped there): a key with a mapping in the current mode is kept.
  local MAP_MODE = { v = "x", V = "x", ["\22"] = "x", s = "s", S = "s", ["\19"] = "s", o = "o" }
  vim.on_key(function(key)
    -- a chord's second key read with getcharstr (Feel vscode's ⌘K ⌘S): the chord's
    if M.chord_waiting then return end
    if key:byte(1) == 0x80 and key:byte(2) == 0xfc and (key:byte(3) or 0) >= 0x80 then
      local m = vim.api.nvim_get_mode().mode:sub(1, 1)
      -- at a prompt (hit-enter, -- More --) the key answers it and runs as typed after it (⌘O there opens Go to File)
      if m == "r" then return end
      if MAP_MODE[m] and vim.fn.maparg(vim.fn.keytrans(key), MAP_MODE[m]) ~= "" then return end
      return ""
    end
  end, vim.api.nvim_create_namespace("ws_app_cmd_keys"))
end

-- The app's XDG_CONFIG_HOME only points Neovim at this config (config/vimstorm -> the repo's nvim/). Plugins
-- (Copilot's login in github-copilot/), git (git/ignore) and terminal tabs must see the user's own: restored
-- once Neovim is up (lazy has its lockfile path; later stdpath("config") calls aren't used in the app).
-- VIMSTORM_USER_XDG_CONFIG_HOME: the user's own value, if the app passes one (unset: ~/.config).
local function user_config_home()
  local own = vim.env.VIMSTORM_USER_XDG_CONFIG_HOME
  vim.env.XDG_CONFIG_HOME = own ~= "" and own or nil
end

function M.setup()
  keys()
  user_config_home()
  require("config.app.agent_files").setup()
  require("config.app.layout").setup()
  require("config.app.git").setup() -- the Git tool window's host window (native GitView over it)
  require("config.app.git_changes").setup() -- Local Changes tab: diffs, saves, reloads
  require("config.app.review").setup() -- the PR diff's `,i` review keys
  require("config.app.terminal").setup() -- the terminal tool window's host window (native TerminalView)
  require("config.app.pane").setup() -- the bottom pane's host window (native PaneHost: Sessions, Boxes, Pipelines)
  require("config.app.colon").setup() -- `:` opens Command mode, `::` Neovim's command line
  require("config.markdown").setup() -- markdown modes / preview panes (the app draws the preview)
  require("config.workflow").setup() -- a Layer's workflow / skill file: readable side, problems, Edit my copy, ⌘G
  -- The app turns trackpad pixels into one wheel step per row (and draws the rest as a pixel offset); a mouse
  -- wheel line is 3 steps there, like the default here
  vim.o.mousescroll = "ver:1,hor:1"
end

return M
