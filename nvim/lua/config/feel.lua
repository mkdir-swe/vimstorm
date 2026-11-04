-- The Feel (Settings › `ui.feel`: vimstorm | webstorm | vscode | vim): a bundle of behaviour switches the app sends
-- (Rust: `require("config.feel").set(tbl)` when it changes and when a project's nvim starts). Until then, and in
-- plain nvim, VimStorm's defaults = how the editor always behaved: 10 tabs per split (WebStorm's limit), no
-- dirty dot, no preview tabs, autosave on leaving a file / the app, tree switches off, git colors in the tree,
-- Vim mode on.
-- No requires at load time: editor_tabs / autocmds read it in plain nvim too.
local M = {}

---@alias FeelAutoSave "off"|"onFocusChange"|"afterDelay"

---@class FeelTree
---@field autoReveal boolean the tree follows the editor's file (VS Code's explorer.autoReveal)
---@field singleClick boolean a click opens (as a preview tab when tabs.preview)
---@field decorations "colors"|"letters" git status as colors only, or VS Code's M / U letters too
---@field compactFolders boolean single-child folders on one row (VS Code's explorer.compactFolders)

---@class FeelTabs
---@field limit integer? tabs per split, nil = no limit (VS Code)
---@field dirtyDot boolean an unsaved tab shows ● (VS Code)
---@field preview boolean single click opens a preview tab (VS Code's workbench.editor.enablePreview)

---@class FeelFiles
---@field autoSave FeelAutoSave

---@class FeelEditor
---@field vim boolean Vim mode (#131); off: always typing, arrows, the Feel's keymap, no modes (config/vimmode.lua)

---@class FeelKey
---@field key string as keys.json writes it, "⌘Y"
---@field action string the Keymap action
---@field lhs string[] the key as the app sends it
---@field does string VimStorm's key for the action (its map does it)

---@class Feel
---@field feel string
---@field tree FeelTree
---@field tabs FeelTabs
---@field files FeelFiles
---@field editor FeelEditor
---@field keys FeelKey[] your keys (#129, config/keys.lua)

---@return Feel
local function defaults()
  return {
    feel = "vimstorm",
    tree = { autoReveal = false, singleClick = false, decorations = "colors", compactFolders = false },
    tabs = { limit = 10, dirtyDot = false, preview = false },
    files = { autoSave = "onFocusChange" },
    editor = { vim = true },
    keys = {},
  }
end

local current = defaults()
local listeners = {} ---@type fun(feel: Feel, before: Feel)[]
-- Run before / after every listener (config/feel_keys.lua: your nvim configs come off first, go on last)
local first, last = {}, {} ---@type fun(feel: Feel, before: Feel)[], fun(feel: Feel, before: Feel)[]

local AUTOSAVE = { off = true, onFocusChange = true, afterDelay = true }
local DECORATIONS = { colors = true, letters = true }

local function bool(v, default)
  if type(v) == "boolean" then return v end
  return default
end

-- Merges what the app sent over the defaults (a partial table keeps the rest at VimStorm's; a msgpack nil
-- `limit`, vim.NIL or absent, is no limit once `tabs` is given)
---@param tbl table?
function M.set(tbl)
  if type(tbl) ~= "table" then tbl = {} end
  local d = defaults()
  local tree = type(tbl.tree) == "table" and tbl.tree or {}
  local tabs = type(tbl.tabs) == "table" and tbl.tabs or nil
  local files = type(tbl.files) == "table" and tbl.files or {}
  local editor = type(tbl.editor) == "table" and tbl.editor or {}
  local limit = d.tabs.limit
  if tabs then
    local l = tabs.limit
    limit = (type(l) == "number" and l >= 1) and math.floor(l) or nil
  end
  local before = current
  local incoming = {
    feel = type(tbl.feel) == "string" and tbl.feel or d.feel,
    tree = {
      autoReveal = bool(tree.autoReveal, d.tree.autoReveal),
      singleClick = bool(tree.singleClick, d.tree.singleClick),
      decorations = DECORATIONS[tree.decorations] and tree.decorations or d.tree.decorations,
      compactFolders = bool(tree.compactFolders, d.tree.compactFolders),
    },
    tabs = {
      limit = limit,
      dirtyDot = bool(tabs and tabs.dirtyDot, d.tabs.dirtyDot),
      preview = bool(tabs and tabs.preview, d.tabs.preview),
    },
    files = { autoSave = AUTOSAVE[files.autoSave] and files.autoSave or d.files.autoSave },
    editor = { vim = bool(editor.vim, d.editor.vim) },
    keys = type(tbl.keys) == "table" and tbl.keys or {},
  }
  for _, fn in ipairs(first) do pcall(fn, incoming, before) end
  current = incoming
  for _, fn in ipairs(listeners) do pcall(fn, current, before) end
  for _, fn in ipairs(last) do pcall(fn, current, before) end
end

-- Back to VimStorm's (tests)
function M.reset() M.set(nil) end

---@return Feel
function M.get() return vim.deepcopy(current) end

-- The pick ("vimstorm" | "webstorm" | "vscode" | "vim"), no copy (per keystroke callers)
---@return string
function M.name() return current.feel end

-- Tabs per split; nil = no limit
---@return integer?
function M.tabs_limit() return current.tabs.limit end

---@return FeelAutoSave
function M.auto_save() return current.files.autoSave end

-- Single click opens a preview tab
---@return boolean
function M.preview() return current.tabs.preview end

---@return boolean
function M.auto_reveal() return current.tree.autoReveal end

-- Vim mode (editor.vim); off: config/vimmode.lua keeps the editor typing
---@return boolean
function M.vim() return current.editor.vim end

-- Stock Vim's keys (#214): Vim mode on under any Feel but vimstorm (Feel vim's; webstorm / vscode with Vim
-- mode turned on too). VimStorm's own (k l ö ä, leader `,`) are Feel vimstorm's.
---@param f Feel?
---@return boolean
function M.stock_keys(f)
  f = f or current
  return f.editor.vim and f.feel ~= "vimstorm"
end

-- Called after every set() with the new and the previous Feel. `when`: "first" runs before every other listener
-- (the new Feel not yet in force: M.get() is still the previous one), "last" after them.
---@param fn fun(feel: Feel, before: Feel)
---@param when? "first"|"last"
function M.on_change(fn, when)
  local list = when == "first" and first or when == "last" and last or listeners
  list[#list + 1] = fn
end

return M
