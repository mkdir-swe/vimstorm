-- Editor tabs per split: which files are tabs of which split, the active one, and the tab actions (close,
-- close others / left / right / all, split, Move to Opposite Group, cycle). The app draws the tab bars
-- (config/app/tabs.lua sends them; names / errors from config/tabbar.lua); the empty editor is config/empty_editor.lua.
-- Every editor split has its own tabs (WebStorm's editor groups).
-- Whatever shows a file in a split (tree, pickers, gd, Git tool window F4, Ctrl+Tab / Cmd+E, :edit)
-- makes it a tab of that split, right of the active one. Split Right / Down start with the current
-- file only. Closing a tab only touches its split; the buffer goes once no split has it as a tab, and
-- a split whose last tab closes goes too (unless it's the only one: empty editor).
-- WebStorm defaults (his options don't change them): new tabs open right of the active one, at most
-- 10 per split (the least recently used goes; the Feel's tabs.limit, none in VS Code's), closing the active tab
-- activates its left neighbour. VS Code's Feel adds preview tabs (tabs.preview: M.open).
local focus = require("config.focus")
local empty = require("config.empty_editor")
local feel = require("config.feel")
local M = {}

---@class WsSplitTabs
---@field bufs integer[] tab order
---@field mru integer[] most recently active first
---@field active integer?
---@field last {from: integer?, to: integer, inserted: boolean}? the switch just made (this tick)
---@field fix integer|"empty"|nil to do after another module deleted the active tab's buffer
---@field fresh boolean? split just made: `:vsplit file` gives it only that file
---@field views table<integer, vim.fn.winsaveview.ret>? buffer -> its view (scroll, caret) when it last left the split
---@field preview integer? its preview tab (VS Code: italic, replaced by the next preview open; at most one)
local tabs = {} ---@type table<integer, WsSplitTabs> by window

-- Called whenever any split's tabs / active tab may have changed (the app's tab bars: config/app/tabs.lua)
local on_change = function() end ---@type fun()
---@param fn fun()
function M.on_change(fn) on_change = fn end

-- The app's tab bars redraw
local function changed() on_change() end

local function index(list, x)
  for i, v in ipairs(list) do
    if v == x then return i end
  end
end
local function drop(list, x)
  local i = index(list, x)
  if i then table.remove(list, i) end
  return i
end

-- Files that get a tab: listed, real files (no terminals, diff/merge scratch buffers, empty [No Name])
local function tabbable(b)
  if not vim.api.nvim_buf_is_valid(b) or not vim.bo[b].buflisted or vim.bo[b].buftype ~= "" then return false end
  return vim.api.nvim_buf_get_name(b) ~= "" or vim.bo[b].modified
end

-- A split with its own tabs (not the viewer's windows: they draw their own headers)
local function tracked(win)
  return vim.api.nvim_win_is_valid(win) and focus.is_split(win)
end

-- Window that has (or keeps) tabs: a tracked one, or the split the viewer took over (its first window;
-- the viewer's other windows aren't splits)
local function keeps_tabs(win)
  if not vim.api.nvim_win_is_valid(win) then return false end
  local i = index(focus.viewer_wins(), win)
  if i then return i == 1 end
  return tracked(win)
end

-- All listed files (the first split starts with them: `nvim a.ts b.ts`)
local function listed()
  return vim.tbl_filter(tabbable, vim.api.nvim_list_bufs())
end

-- Splits with tabs, in window order
function M.splits()
  return vim.tbl_filter(function(w) return tabs[w] ~= nil and keeps_tabs(w) end, vim.api.nvim_tabpage_list_wins(0))
end

-- Tabs of a split (default: the focused / last focused one)
---@param win integer?
---@return integer[]
function M.tabs(win)
  win = win or focus.split_win()
  local st = win and tabs[win]
  return st and vim.tbl_filter(tabbable, st.bufs) or {}
end

-- Set a split's tabs (session restore)
---@param win integer
---@param bufs integer[]
---@param active integer?
function M.set_tabs(win, bufs, active)
  tabs[win] = { bufs = vim.list_slice(bufs), mru = { active }, active = active }
  on_change()
end

-- Session: each split's tabs (paths) and active tab, by window
---@return table<integer, {tabs: string[], active: string?}>
function M.snapshot()
  local out = {}
  for _, w in ipairs(M.splits()) do
    local st = tabs[w]
    local paths = {}
    for _, b in ipairs(vim.tbl_filter(tabbable, st.bufs)) do paths[#paths + 1] = vim.api.nvim_buf_get_name(b) end
    local active = st.active and tabbable(st.active) and vim.api.nvim_buf_get_name(st.active) or nil
    out[w] = { tabs = paths, active = active }
  end
  return out
end

---@param win integer
---@return WsSplitTabs
local function state(win)
  local st = tabs[win]
  if not st then
    st = { bufs = {}, mru = {} }
    if not next(tabs) then
      st.bufs = listed()
      st.mru = vim.list_slice(st.bufs)
    end
    tabs[win] = st
  end
  return st
end

local function referenced(b)
  for w, st in pairs(tabs) do
    if keeps_tabs(w) and index(st.bufs, b) then return true end
  end
  return #vim.fn.win_findbuf(b) > 0
end

-- Back as a tab of the focused split (a close's Cancel)
local function restore(b)
  local win = focus.split_win()
  if win then vim.api.nvim_win_set_buf(win, b) end
end

-- A tab closed: drop the buffer once no split has it (saved first: WebStorm autosaves). Unsaved text that
-- has no file (:enew) asks first, in the popup (Discard / Cancel: the tab comes back), never Vim's prompt.
-- With the Feel's autoSave off an unsaved file asks too, as VS Code: Save / Don't Save / Cancel.
local function release(b)
  if not vim.api.nvim_buf_is_valid(b) or not vim.bo[b].buflisted or referenced(b) then return end
  if vim.bo[b].modified and vim.api.nvim_buf_get_name(b) ~= "" and feel.auto_save() == "off" then
    -- back as a tab before asking: several closed at once (Close All) each come back and one asks at a time
    -- (a menu opened over the ask replaces it); whatever goes unanswered stays a tab, never a hidden buffer
    return vim.schedule(function() -- (once the closing is done)
      if not vim.api.nvim_buf_is_valid(b) or referenced(b) then return end
      restore(b)
      local name = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(b), ":t")
      vim.ui.select({ "Save", "Don't Save", "Cancel" }, { prompt = "Save changes to " .. name .. "?" }, function(choice)
        if not vim.api.nvim_buf_is_valid(b) then return end
        if choice == "Save" then
          pcall(vim.api.nvim_buf_call, b, function() vim.cmd("silent! write") end)
          if vim.bo[b].modified then return end -- not written (read-only, error): it stays
          for _, win in ipairs(vim.fn.win_findbuf(b)) do
            if tabs[win] then M.close(b, win) end
          end
        elseif choice == "Don't Save" then
          for _, st in pairs(tabs) do st.last = nil end
          Snacks.bufdelete({ buf = b, force = true })
        end
      end)
    end)
  end
  if vim.bo[b].modified and vim.api.nvim_buf_get_name(b) == "" then
    return vim.schedule(function() -- (once the closing is done)
      if not vim.api.nvim_buf_is_valid(b) or referenced(b) then return end
      vim.ui.select({ "Discard", "Cancel" }, { prompt = "Close untitled? Its text was never saved" }, function(choice)
        if not vim.api.nvim_buf_is_valid(b) or referenced(b) then return end
        if choice == "Discard" then
          for _, st in pairs(tabs) do st.last = nil end
          return Snacks.bufdelete({ buf = b, force = true })
        end
        restore(b) -- back as a tab
      end)
    end)
  end
  if vim.bo[b].modified and vim.api.nvim_buf_get_name(b) ~= "" then
    -- never a prompt (a 'readonly' file's "write anyway?" took every key): one that can't be written stays a tab
    local confirm = vim.o.confirm
    vim.o.confirm = false
    pcall(vim.api.nvim_buf_call, b, function() vim.cmd("silent! write") end)
    vim.o.confirm = confirm
    if vim.bo[b].modified then
      return vim.schedule(function() -- (once the closing is done)
        if vim.api.nvim_buf_is_valid(b) and not referenced(b) then restore(b) end
      end)
    end
  end
  for _, st in pairs(tabs) do st.last = nil end -- shown nowhere: no switch for BufDelete to undo
  Snacks.bufdelete({ buf = b })
end

-- Over the tab limit: close the least recently used (never the active or an unsaved one)
local function trim(st)
  local limit = feel.tabs_limit()
  while limit and #st.bufs > limit do
    local function closable(b) return b ~= st.active and not (vim.api.nvim_buf_is_valid(b) and vim.bo[b].modified) end
    local victim
    for _, b in ipairs(st.bufs) do -- never active here (restored / listed at startup): oldest
      if not index(st.mru, b) and closable(b) then victim = b break end
    end
    for i = #st.mru, 1, -1 do
      if victim then break end
      local b = st.mru[i]
      if index(st.bufs, b) and closable(b) then victim = b end
    end
    if not victim then return end
    drop(st.bufs, victim)
    drop(st.mru, victim)
    if st.preview == victim then st.preview = nil end
    vim.schedule(function() release(victim) end)
  end
end

local previewing ---@type integer? the split a preview open (M.open) is showing a file in, this moment

-- `b` is shown in `win`: activate its tab, or add one right of the active tab. A preview open's new tab takes
-- the split's preview tab's place (that one closes), unless it was edited meanwhile
local function add(win, b)
  local st = state(win)
  if not tabbable(b) or st.active == b and index(st.bufs, b) then return end
  if st.fresh then st.bufs, st.mru, st.active = {}, {}, nil end
  local inserted = not index(st.bufs, b)
  if inserted then
    local old = previewing == win and st.preview
    local at = old and index(st.bufs, old)
    if at and old and vim.api.nvim_buf_is_valid(old) and not vim.bo[old].modified then
      st.bufs[at] = b
      drop(st.mru, old)
      vim.schedule(function() release(old) end)
    else
      at = st.active and index(st.bufs, st.active)
      table.insert(st.bufs, at and at + 1 or #st.bufs + 1, b)
    end
    if previewing == win then st.preview = b end
  end
  -- remembered for this tick: Snacks.bufdelete shows another buffer before deleting (see BufDelete)
  st.last = { from = st.active, to = b, inserted = inserted }
  vim.schedule(function() st.last = nil end)
  st.active = b
  drop(st.mru, b)
  table.insert(st.mru, 1, b)
  trim(st)
end

-- No tabs left in a split: close it, or show the empty editor when it's the only one
local function emptied(win)
  if #vim.tbl_filter(tracked, M.splits()) > 1 then
    if pcall(vim.api.nvim_win_close, win, false) then return end
  end
  if not empty.is_empty(vim.api.nvim_win_get_buf(win)) then vim.api.nvim_win_set_buf(win, empty.buf()) end
end

-- Catch up: new splits, files shown without BufWinEnter (or listed after it), deleted active tabs
local function sync()
  for w, st in pairs(tabs) do
    -- not a split (any more): e.g. a window snacks made for the tree, which showed a file for a moment
    if not keeps_tabs(w) then tabs[w] = nil end
    local fix = st.fix
    if fix and vim.api.nvim_win_is_valid(w) and tracked(w) then
      st.fix = nil
      if fix == "empty" then
        emptied(w)
      elseif vim.api.nvim_buf_is_valid(fix) and vim.api.nvim_win_get_buf(w) ~= fix then
        vim.api.nvim_win_set_buf(w, fix)
      end
    end
  end
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if tracked(w) then add(w, vim.api.nvim_win_get_buf(w)) end
  end
  changed()
end
local sync_pending = false
local function sync_later()
  if sync_pending then return end
  sync_pending = true
  vim.schedule(function()
    sync_pending = false
    sync()
  end)
end

-- Is `b` the preview tab of `win` (the tab payload's `preview`)
---@param win integer
---@param b integer
function M.is_preview(win, b)
  local st = tabs[win]
  return st ~= nil and st.preview == b
end

-- A preview tab becomes a normal one (edited, saved, opened again without preview), in every split
---@param b integer
function M.pin(b)
  local any = false
  for _, st in pairs(tabs) do
    if st.preview == b then st.preview, any = nil, true end
  end
  if any then changed() end
end

-- Opens a file in the focused / last focused split as its tab. preview (the tree's single
-- click, VS Code's preview tabs, only while the Feel's tabs.preview): a new tab is the split's preview tab,
-- replacing the one before; shown without making that split the current window (the tree keeps the keyboard).
-- Otherwise (Enter / double-click) the split gets focus and an open preview tab of the file is pinned.
---@param path string
---@param opts {preview: boolean?}?
function M.open(path, opts)
  local preview = opts and opts.preview and feel.preview()
  local win = focus.split_win()
  if not preview then focus.edit() end
  -- already shown there: no :edit (it would read the file again, or refuse an unsaved one)
  local shown = win and vim.api.nvim_win_get_buf(win)
  local same = shown and vim.fn.resolve(vim.api.nvim_buf_get_name(shown)) == vim.fn.resolve(vim.fn.fnamemodify(path, ":p"))
  local cmd = "edit " .. vim.fn.fnameescape(path)
  if not preview or not win then
    if not same then vim.cmd(cmd) end
    return M.pin(vim.api.nvim_get_current_buf())
  end
  if same then return end
  previewing = win
  local ok, err = pcall(vim.api.nvim_win_call, win, function() vim.cmd(cmd) end)
  previewing = nil
  if not ok then vim.notify(tostring(err), vim.log.levels.ERROR) end
end

-- A file an agent changed under unsaved edits (config/app/agent_files.lua): its tab stays where it is, a balloon
-- says why (closing would lose the edits; saving waits for a choice)
---@param b integer
local function held(b)
  local files = package.loaded["config.app.agent_files"]
  return files ~= nil and files.closing(b)
end

-- Close a tab of a split (default: the active tab of the focused / last focused split)
---@param b integer?
---@param win integer?
function M.close(b, win)
  win = win or focus.split_win()
  if not win then return end
  b = b or vim.api.nvim_win_get_buf(win)
  if held(b) then return end
  local st = tabs[win]
  if not st then return Snacks.bufdelete(b) end -- not a split with tabs (diff)
  local i = drop(st.bufs, b)
  drop(st.mru, b)
  if st.preview == b then st.preview = nil end
  if vim.api.nvim_win_get_buf(win) == b then
    local list = vim.tbl_filter(tabbable, st.bufs)
    local nb = i and (st.bufs[i - 1] or st.bufs[i])
    if nb and not tabbable(nb) then nb = list[1] end
    st.active = nil
    if nb then
      vim.api.nvim_win_set_buf(win, nb)
    else
      emptied(win)
    end
    st.last = nil
  end
  release(b)
  changed()
end

-- Close a file's tab in every split, each as its ×, and the buffer (its file deleted on disk:
-- config/app/agent_files.lua); one also shown outside the splits (the viewer) stays
---@param b integer
function M.close_everywhere(b)
  for _, w in ipairs(M.splits()) do
    if index(tabs[w].bufs, b) then M.close(b, w) end
  end
  if vim.api.nvim_buf_is_valid(b) and vim.bo[b].buflisted then release(b) end
end

-- Close several tabs of a split; the window shows `keep` if its tab was among them
local function close_many(win, list, keep)
  local st = tabs[win]
  if not st then return end
  list = vim.tbl_filter(function(b) return not held(b) end, list)
  for _, b in ipairs(list) do
    drop(st.bufs, b)
    drop(st.mru, b)
    if st.preview == b then st.preview = nil end
  end
  if index(list, vim.api.nvim_win_get_buf(win)) and keep then
    vim.api.nvim_win_set_buf(win, keep)
    st.last = nil
  end
  for _, b in ipairs(list) do release(b) end
  changed()
end

local function args(b, win)
  win = win or focus.split_win()
  return b or (win and vim.api.nvim_win_get_buf(win)), win
end

-- Tab menu: Close Other Tabs / Close Tabs to the Left / Right / Close All Tabs (that split only)
function M.close_others(b, win)
  b, win = args(b, win)
  if not win then return end
  close_many(win, vim.tbl_filter(function(x) return x ~= b end, M.tabs(win)), b)
end
local function close_side(side, b, win)
  b, win = args(b, win)
  if not win then return end
  local list, i = M.tabs(win), nil
  i = index(list, b)
  if not i then return end
  close_many(win, side < 0 and vim.list_slice(list, 1, i - 1) or vim.list_slice(list, i + 1), b)
end
function M.close_left(b, win) close_side(-1, b, win) end
function M.close_right(b, win) close_side(1, b, win) end
function M.close_all(win)
  local _, w = args(nil, win)
  if not w then return end
  local list = M.tabs(w)
  local cur = vim.api.nvim_win_get_buf(w)
  close_many(w, vim.tbl_filter(function(x) return x ~= cur end, list), nil)
  M.close(cur, w)
end

-- Split Right / Down: the new split starts with the current file as its only tab (WebStorm);
-- move = "Split and Move Right / Down": the file leaves the old split
---@param dir "right"|"down"
---@param move boolean?
function M.split(dir, move)
  local win = focus.split_win()
  if not win then return end
  vim.api.nvim_set_current_win(win)
  local b = vim.api.nvim_get_current_buf()
  vim.cmd(dir == "down" and "rightbelow split" or "rightbelow vsplit")
  local new = vim.api.nvim_get_current_win()
  M.set_tabs(new, tabbable(b) and { b } or {}, tabbable(b) and b or nil)
  if move and tabbable(b) then M.close(b, win) end
end

-- The other split when there are exactly two
function M.opposite(win)
  win = win or focus.split_win()
  local splits = vim.tbl_filter(tracked, M.splits())
  if #splits ~= 2 or not index(splits, win) then return nil end
  return splits[1] == win and splits[2] or splits[1]
end

-- Move to Opposite Group: the tab moves to the other split (and gets focus there)
function M.move_to_opposite(b, win)
  b, win = args(b, win)
  local other = win and M.opposite(win)
  if not other or not b then return end
  vim.api.nvim_set_current_win(other)
  vim.api.nvim_win_set_buf(other, b)
  M.close(b, win)
end

-- Alt+Cmd+Left/Right: previous / next tab (wraps) of a split (default: focused / last focused)
---@param dir integer 1 or -1
---@param win integer?
function M.cycle(dir, win)
  win = win or focus.split_win()
  if not win then return end
  local bufs = M.tabs(win)
  if #bufs == 0 then return end
  local i = index(bufs, vim.api.nvim_win_get_buf(win)) or (dir > 0 and 0 or 1)
  vim.api.nvim_win_set_buf(win, bufs[(i - 1 + dir) % #bufs + 1])
end

function M.setup()
  local group = vim.api.nvim_create_augroup("ws_editor_tabs", { clear = true })
  -- A file shown in a split becomes its tab (now, so a loop of :edit gets them all). Back on a tab: the
  -- view it had in this split (Neovim keeps only the caret and re-centres it)
  vim.api.nvim_create_autocmd("BufWinEnter", {
    group = group,
    callback = function(ev)
      local win = vim.api.nvim_get_current_win()
      if vim.api.nvim_win_get_buf(win) == ev.buf and tracked(win) then
        add(win, ev.buf)
        local view = tabs[win] and tabs[win].views and tabs[win].views[ev.buf]
        if view then vim.fn.winrestview(view) end
      end
      sync_later()
      on_change()
    end,
  })
  vim.api.nvim_create_autocmd("BufLeave", {
    group = group,
    callback = function(ev)
      local win = vim.api.nvim_get_current_win()
      local st = tabs[win]
      if st and vim.api.nvim_win_get_buf(win) == ev.buf then
        st.views = st.views or {}
        st.views[ev.buf] = vim.fn.winsaveview()
      end
    end,
  })
  -- :split / :vsplit: the new split starts with the current file only
  vim.api.nvim_create_autocmd("WinNew", {
    group = group,
    callback = function()
      local win = vim.api.nvim_get_current_win()
      if not tabs[win] and next(tabs) and tracked(win) then
        local b = vim.api.nvim_win_get_buf(win)
        M.set_tabs(win, tabbable(b) and { b } or {}, tabbable(b) and b or nil)
        local st = tabs[win]
        st.fresh = true
        vim.schedule(function() st.fresh = nil end)
      end
      sync_later()
      on_change()
    end,
  })
  -- A split closed (,q): its tabs go with it
  vim.api.nvim_create_autocmd("WinClosed", {
    group = group,
    callback = function(ev)
      local win = tonumber(ev.match)
      local st = win and tabs[win]
      if not st then return end
      tabs[win] = nil
      vim.schedule(function()
        for _, b in ipairs(st.bufs) do release(b) end
      end)
      on_change()
    end,
  })
  -- Buffer deleted elsewhere (tree delete, :bd): its tabs go; where it was active, the left
  -- neighbour takes over (Snacks.bufdelete already showed some other buffer there: undo that tab)
  vim.api.nvim_create_autocmd("BufDelete", {
    group = group,
    callback = function(ev)
      local b = ev.buf
      for _, st in pairs(tabs) do
        if st.views then st.views[b] = nil end
        if st.preview == b then st.preview = nil end
        local switched = st.last and st.last.from == b and st.active == st.last.to
        local i = index(st.bufs, b)
        if i or switched then
          if switched and st.last.inserted then
            drop(st.bufs, st.last.to)
            drop(st.mru, st.last.to)
          end
          i = index(st.bufs, b) or i
          drop(st.bufs, b)
          drop(st.mru, b)
          if st.active == b or switched then
            i = math.min(i or 1, #st.bufs + 1)
            st.active = nil
            st.fix = st.bufs[i - 1] or st.bufs[i] or "empty"
          end
          st.last = nil
        end
      end
      sync_later()
      on_change()
    end,
  })
  -- tabs.preview turned off: the preview tabs are normal ones
  feel.on_change(function(now)
    if now.tabs.preview then return end
    local any = false
    for _, st in pairs(tabs) do
      if st.preview then st.preview, any = nil, true end
    end
    if any then changed() end
  end)
  -- A preview tab edited or saved: a normal tab (VS Code)
  vim.api.nvim_create_autocmd({ "BufModifiedSet", "BufWritePost" }, {
    group = group,
    callback = function(ev)
      if ev.event == "BufWritePost" or vim.bo[ev.buf].modified then M.pin(ev.buf) end
    end,
  })
  vim.api.nvim_create_autocmd({ "VimEnter", "OptionSet" }, {
    group = group,
    pattern = { "*" },
    callback = function(ev)
      if ev.event == "OptionSet" and ev.match ~= "buflisted" then return end
      sync_later()
    end,
  })
end

return M
