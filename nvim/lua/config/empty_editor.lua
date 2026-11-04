-- Empty editor (no file open, e.g. after closing the last tab): no line number / caret row / gutter; the app draws
-- Abe's face in the middle while config/app/layout.lua says the split is empty (#110: no key tips). It can't be edited:
-- typing / pasting do nothing.
local focus = require("config.focus")
local M = {}

local EMPTY_WO = { number = false, relativenumber = false, cursorline = false, signcolumn = "no", statuscolumn = "", foldcolumn = "0" }

---@param buf integer
function M.is_empty(buf)
  return vim.api.nvim_buf_get_name(buf) == "" and vim.bo[buf].buftype == "" and vim.bo[buf].filetype == ""
    and not vim.bo[buf].modified and vim.api.nvim_buf_line_count(buf) == 1
    and vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1] == ""
end

-- Reusable empty [No Name] buffer for an empty editor
function M.buf()
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[b].buflisted and M.is_empty(b) and #vim.fn.win_findbuf(b) == 0 then return b end
  end
  return vim.api.nvim_create_buf(true, false)
end

-- Keys that would edit do nothing (no E21 messages); the buffer is also not 'modifiable' while it is the
-- empty editor. (Opening a file in the window reuses the buffer: Vim resets its options and maps.)
local EDIT_KEYS = { "i", "a", "o", "O", "I", "A", "s", "S", "c", "C", "x", "X", "d", "D", "p", "P", "r", "R", "u", "J",
  "<C-r>", ".", "<Del>", "gi", "gI", "gp", "gP" }
local locked = {} ---@type table<integer, true>

---@param buf integer
---@param on boolean
local function lock(buf, on)
  if (locked[buf] == true) == on then return end
  locked[buf] = on or nil
  if not vim.api.nvim_buf_is_valid(buf) or vim.api.nvim_buf_get_name(buf) ~= "" then return end -- reused for a file
  vim.bo[buf].modifiable = not on
  for _, k in ipairs(EDIT_KEYS) do
    if on then
      vim.keymap.set("n", k, "<Nop>", { buffer = buf, nowait = true })
    else
      pcall(vim.keymap.del, "n", k, { buffer = buf })
    end
  end
end

-- Cmd+V (a terminal paste) / the context menu's Paste into the empty editor: nothing
local function hook_paste()
  local paste = vim.paste
  ---@diagnostic disable-next-line: duplicate-set-field
  vim.paste = function(lines, phase)
    local buf = vim.api.nvim_get_current_buf()
    if locked[buf] and vim.api.nvim_buf_get_name(buf) == "" and vim.fn.getcmdtype() == "" then return true end
    return paste(lines, phase)
  end
end

-- Text put into the buffer by a script (no TextChanged when it isn't current) must end the empty look (the native
-- hints) right away: watch its lines.
local watched = {} ---@type table<integer, true>
local sync_all
local function watch(buf)
  if watched[buf] then return end
  watched[buf] = true
  vim.api.nvim_buf_attach(buf, false, {
    on_lines = function()
      watched[buf] = nil
      vim.schedule(function()
        pcall(function() require("config.app.layout").sync() end)
        sync_all()
      end)
      return true -- detach: watched again if it becomes the empty editor again
    end,
    on_detach = function() watched[buf] = nil end,
  })
end

-- Switch a split into / out of the empty look
local function sync(win)
  if not vim.api.nvim_win_is_valid(win) or not focus.is_split(win, true) then return end
  local buf = vim.api.nvim_win_get_buf(win)
  local was = vim.w[win].ws_empty ---@type integer? the empty buffer it shows
  if M.is_empty(buf) then
    for k, v in pairs(EMPTY_WO) do vim.api.nvim_set_option_value(k, v, { win = win, scope = "local" }) end
    vim.w[win].ws_empty = buf
    watch(buf)
  elseif was then
    vim.w[win].ws_empty = nil
    vim.api.nvim_win_call(win, function() vim.cmd("setlocal " .. table.concat(vim.tbl_map(function(k) return k .. "<" end, vim.tbl_keys(EMPTY_WO)), " ")) end)
    require("config.gutter").sync_all()
  end
end

local pending = false
function sync_all()
  if pending then return end
  pending = true
  vim.schedule(function()
    pending = false
    local shown = {} ---@type table<integer, true> buffers an empty editor shows
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      sync(win)
      if vim.api.nvim_win_is_valid(win) and vim.w[win].ws_empty then shown[vim.w[win].ws_empty] = true end
    end
    for buf in pairs(locked) do
      if not shown[buf] then lock(buf, false) end
    end
    for buf in pairs(shown) do lock(buf, true) end
  end)
end

function M.setup()
  vim.api.nvim_create_autocmd({ "VimEnter", "BufWinEnter", "BufEnter", "BufModifiedSet", "BufReadPost", "BufFilePost",
    "FileType", "TextChanged", "TextChangedI", "WinResized", "VimResized", "WinNew", "WinClosed" }, {
    group = vim.api.nvim_create_augroup("ws_empty_editor", { clear = true }),
    callback = sync_all,
  })
  hook_paste()
end

return M
