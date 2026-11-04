-- A file whose swap file is already there never stops the editor at Vim's ATTENTION prompt ("Press ENTER or type
-- command to continue"): on startup, a session restore or a tab opened later, SwapExists picks the answer.
--   - its nvim is gone and the file on disk is newer than the swap, or the swap holds no unsaved change: the swap is
--     stale (an nvim killed as it quit). Deleted, the file opens as it is, nothing said.
--   - its nvim is gone and the swap is newer, with unsaved changes (a crash): the file opens as it is, the swap
--     stays, and one balloon says how to get the changes back (:recover).
--   - its nvim still runs (another project's window has the file open): opened editable all the same, a short balloon
--     says so. A file is never locked in VimStorm: the other window takes this one's writes as an agent's (reloaded).
local M = {}

-- Whether the nvim that wrote the swap still runs. swapinfo's pid is 0 once that process is gone; a pid the system
-- gave to another program since (a reboot) is not an nvim. The host is not compared: the swap folder is this
-- machine's own state, and macOS renames the host with the network.
---@param pid integer
local function owner_runs(pid)
  if pid <= 0 or pid == vim.fn.getpid() then return false end
  local ok, proc = pcall(vim.api.nvim_get_proc, pid)
  return ok and type(proc) == "table" and type(proc.name) == "string" and proc.name:find("nvim", 1, true) ~= nil
end

---@param path string
---@return number?
local function mtime(path)
  local st = vim.uv.fs_stat(path)
  return st and st.mtime.sec + st.mtime.nsec / 1e9 or nil
end

-- What to do with the swap file `swap` of `file`: the v:swapchoice letter and the balloon to show (none: nil)
---@param file string
---@param swap string
---@return "d"|"e" choice, string? msg, integer? level
function M.decide(file, swap)
  local info = vim.fn.swapinfo(swap)
  local name = vim.fn.fnamemodify(file, ":t")
  if info.error then
    return "e", ("%s: its swap file can't be read (%s), so it was left in place: %s"):format(name, info.error, swap),
      vim.log.levels.WARN
  end
  if owner_runs(info.pid) then
    return "e", ("%s is open in another Neovim too (pid %d): saving here reloads it there"):format(name, info.pid),
      vim.log.levels.INFO
  end
  local on_disk, swapped = mtime(file), mtime(swap)
  if info.dirty == 0 or (on_disk and swapped and on_disk > swapped) then return "d" end
  return "e",
    ("%s has unsaved changes from an editor that did not quit cleanly. To get them back: `:recover` in that file, then"
      .. " save (its swap file stays until then: %s)"):format(name, swap),
    vim.log.levels.WARN
end

local told = {} ---@type table<string, true> swap files a balloon named already

-- After startup (the notifier and the app's balloons are set up by then); right away later
---@param fn fun()
local function later(fn)
  if vim.v.vim_did_enter == 1 then return vim.schedule(fn) end
  vim.api.nvim_create_autocmd("VimEnter", { once = true, callback = function() vim.schedule(fn) end })
end

function M.setup()
  -- Nvim's own handler (`nvim.swapfile`) answers a live owner's swap too, with a raw "W325: Ignoring swapfile" warning
  -- beside this balloon: this one says it
  pcall(vim.api.nvim_del_augroup_by_name, "nvim.swapfile")
  vim.api.nvim_create_autocmd("SwapExists", {
    group = vim.api.nvim_create_augroup("vimstorm_swap", { clear = true }),
    callback = function(args)
      local swap = vim.v.swapname
      local ok, choice, msg, level = pcall(M.decide, vim.fn.fnamemodify(args.file, ":p"), swap)
      -- (whatever went wrong: open it and keep the swap, never the prompt)
      if not ok then choice, msg, level = "e", nil, nil end
      vim.v.swapchoice = choice
      if msg and not told[swap] then
        told[swap] = true
        later(function() vim.notify(msg, level, { title = "Swap file" }) end)
      end
    end,
  })
end

return M
