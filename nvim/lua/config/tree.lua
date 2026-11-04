-- Project tree: the app draws it natively (app/src/shell/tree, bridge config/app/tree.lua). These entry points tell it,
-- and so does every Snacks.explorer() / Snacks.explorer.reveal() call (VimEnter's auto-open, ,g, ,E, Select in
-- Project View): Snacks.explorer resolves to `app_explorer`. Also Reveal in Finder (Ctrl+Cmd+Shift+O) and the
-- LSP-aware rename hook the native tree's renames / moves use.
local M = {}

-- Reveal in Finder (Ctrl+Cmd+Shift+O): paths (the tree sends its selected rows, the key the current file).
-- M.run starts the command (async; tests replace it with a recorder)
function M.run(cmd)
  local ok, err = pcall(vim.system, cmd, {}, function(r)
    if r.code ~= 0 then vim.schedule(function() Snacks.notify.error("Reveal in Finder failed:\n" .. (r.stderr or "")) end) end
  end)
  if not ok then Snacks.notify.error("Reveal in Finder failed:\n" .. tostring(err)) end
end

---@param paths string[]
function M.reveal(paths)
  paths = vim.tbl_filter(function(p) return p ~= "" and vim.uv.fs_stat(p) ~= nil end, paths)
  if #paths == 0 then return end
  M.run(vim.list_extend({ "open", "-R" }, paths))
end

-- Renames / moves from the native tree (config/app/tree.lua: Shift+F6, F6) tell LSP servers so imports get
-- updated. Same as snacks' on_rename_file, with method calls (snacks' client.supports_method() prints a
-- deprecation warning)
function M.hook_rename()
  require("snacks.rename").on_rename_file = function(from, to, rename)
    local changes = { files = { { oldUri = vim.uri_from_fname(from), newUri = vim.uri_from_fname(to) } } }
    local clients = vim.lsp.get_clients()
    for _, client in ipairs(clients) do
      if client:supports_method("workspace/willRenameFiles") then
        local resp = client:request_sync("workspace/willRenameFiles", changes, 1000, 0)
        if resp and resp.result ~= nil then
          vim.lsp.util.apply_workspace_edit(resp.result, client.offset_encoding)
        end
      end
    end
    if rename then rename() end
    for _, client in ipairs(clients) do
      if client:supports_method("workspace/didRenameFiles") then
        client:notify("workspace/didRenameFiles", changes)
      end
    end
  end
end

---@param payload table
local function tell(payload) require("config.app.bridge").notify("tree", payload) end
-- the tree takes the keyboard: focus.target() says so at once (keys already typed act on it)
local function expect() require("config.app").expect("tree") end
-- show the panel; focus: and give it the keyboard
---@param focus? boolean
function M.open(focus)
  tell({ event = "open", focus = focus == true })
  if focus == true then expect() end
end
function M.close()
  local had = require("config.app").native() == "tree"
  tell({ event = "close" })
  if had then require("config.app").expect(nil) end
end
function M.toggle() tell({ event = "toggle" }) end
function M.focus()
  tell({ event = "focus" })
  expect()
end

-- show `file` (default: the current buffer's) selected
---@param file? string
---@param focus? boolean default true
---@param expand? boolean a folder: expanded too
function M.reveal_file(file, focus, expand)
  file = file or vim.api.nvim_buf_get_name(0)
  tell({ event = "reveal", file = file ~= "" and file or nil, focus = focus ~= false, expand = expand == true })
  if focus ~= false then expect() end
end

-- Snacks.explorer(opts): opens (enter = false: without focus) or toggles; .reveal({ file }) shows a file
M.app_explorer = setmetatable({
  open = function(opts) M.open(not (opts and opts.enter == false)) end,
  reveal = function(opts) M.reveal_file(opts and opts.file or nil) end,
}, {
  __call = function(_, opts)
    if opts and opts.enter == false then return M.open(false) end
    M.toggle()
  end,
})
-- before snacks loads it (init.lua requires this file before lazy.nvim)
package.loaded["snacks.explorer"] = M.app_explorer

require("config.app.tree").setup()

return M
