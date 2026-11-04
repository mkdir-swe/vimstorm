-- What each split's tab bar shows beyond its tab list (config/editor_tabs.lua): names, compiler errors, git status
-- colors (git/status.lua). The app draws the bars (app/src/editor/tabs) from what config/app/tabs.lua sends; the events
-- here tell it when they changed.
local status = require("git.status")
local M = {}

-- Tab names: file name, "parent/name" when two tabs share a name (WebStorm does the same)
---@param bufs integer[]
---@return table<integer, string>
function M.names(bufs)
  local tails, res = {}, {}
  for _, b in ipairs(bufs) do
    local t = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(b), ":t")
    tails[t] = (tails[t] or 0) + 1
  end
  for _, b in ipairs(bufs) do
    local path = vim.api.nvim_buf_get_name(b)
    local t = vim.fn.fnamemodify(path, ":t")
    if t == "" then
      res[b] = "untitled"
    elseif tails[t] > 1 then
      res[b] = vim.fn.fnamemodify(path, ":h:t") .. "/" .. t
    else
      res[b] = t
    end
  end
  return res
end

-- Same rule as the tree (config/problems.lua): compiler errors, not linter findings. Cached per buffer until its
-- diagnostics change (perf: vim.diagnostic.get copies them all, ~80 µs for 90 diagnostics)
local err_cache = {} ---@type table<integer, boolean>
---@param b integer
---@return boolean
function M.has_errors(b)
  if err_cache[b] == nil then
    local ERROR = vim.diagnostic.severity.ERROR
    err_cache[b] = (vim.diagnostic.count(b, { severity = ERROR })[ERROR] or 0) > 0 and require("config.problems").has_error(b)
  end
  return err_cache[b]
end

-- Something the tab bars show changed (names, git status, errors, which buffers get a tab)
function M.invalidate() require("config.app.tabs").changed() end

function M.setup()
  vim.o.showtabline = 0 -- no global tabline: the app draws a tab bar per split
  require("config.app.tabs").setup()
  local group = vim.api.nvim_create_augroup("ws_tabbar", { clear = true })
  status.on_change(M.invalidate) -- git status re-read: names recolor
  vim.api.nvim_create_autocmd({ "BufFilePost", "BufModifiedSet", "BufAdd", "BufDelete", "BufWipeout" }, {
    group = group,
    callback = function(ev)
      if ev.event ~= "BufModifiedSet" and ev.event ~= "BufAdd" then err_cache[ev.buf] = nil end
      M.invalidate()
    end,
  })
  vim.api.nvim_create_autocmd("OptionSet", {
    group = group,
    pattern = { "buflisted", "buftype" },
    callback = M.invalidate,
  })
  -- DiagnosticChanged fires on every LSP publish (while typing): only a flipped error underline matters
  vim.api.nvim_create_autocmd("DiagnosticChanged", {
    group = group,
    callback = function(ev)
      local was = err_cache[ev.buf]
      err_cache[ev.buf] = nil
      if was == nil or M.has_errors(ev.buf) ~= was then M.invalidate() end
    end,
  })
end

return M
