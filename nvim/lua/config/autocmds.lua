-- Highlight yanked text (replaces vim-highlightedyank)
vim.api.nvim_create_autocmd("TextYankPost", {
  callback = function() vim.hl.on_yank() end,
})

-- Autosave like WebStorm: when switching files/windows or leaving the app (the Feel's files.autoSave
-- onFocusChange, the default; afterDelay too, plus a write 1 s after the last change; off: only Cmd+S). nested: BufWritePost runs
-- (git status, Local Changes, tab colors); BufWritePre doesn't: the sync format on save (~40 ms per switch)
-- stays on Cmd+S. Nor BufWriteCmd: the merge result is saved only by Cmd+S / Apply (saving it marks the file
-- resolved). Then the written files are formatted in the background, like WebStorm's Actions on Save: conform
-- async (Prettier in its own process), silent (code left mid-edit doesn't parse: no balloon), written again
-- only if that changed them; typed into meanwhile: conform drops the result.
local feel = require("config.feel")

-- cmd: "silent! wall", or "silent! lockmarks update" in a buffer. A file an agent changed under unsaved edits is
-- held (config/app/agent_files.lua: its guard is a BufWriteCmd, which autosave skips): never written here.
local function write_quietly(cmd)
  local files = vim.g.vimstorm_app and require("config.app.agent_files") or nil
  if files then files.before_save_all() end
  local ei, confirm = vim.o.eventignore, vim.o.confirm
  vim.o.confirm = false -- autosave never opens a prompt
  vim.o.eventignore = (ei == "" and "" or ei .. ",") .. "BufWritePre,BufWriteCmd"
  if not files then
    pcall(vim.cmd, cmd)
  elseif cmd == "silent! wall" then
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
      if vim.bo[buf].modified and vim.bo[buf].buftype == "" and vim.api.nvim_buf_get_name(buf) ~= ""
        and not files.held(buf) then
        pcall(vim.api.nvim_buf_call, buf, function() vim.cmd("silent! update") end)
      end
    end
  elseif not files.held(vim.api.nvim_get_current_buf()) then
    pcall(vim.cmd, cmd)
  end
  vim.o.eventignore, vim.o.confirm = ei, confirm
end

local function format_saved(buf)
  -- windows showing it keep the caret on its text and on its screen row (nvim shifts both for edits above;
  -- an edit around the caret line could scroll otherwise)
  local before = {} ---@type table<integer, vim.fn.winsaveview.ret>
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    before[win] = vim.api.nvim_win_call(win, vim.fn.winsaveview)
  end
  -- one Cmd+Z takes back the last edit with its format (the file as it was), not just the format. Joined here,
  -- in the buffer: conform's undojoin runs in whatever buffer is current when the result comes in; nothing
  -- syncs a buffer's undo but typing in it, and that drops the result anyway
  vim.api.nvim_buf_call(buf, function() pcall(vim.cmd.undojoin) end)
  require("conform").format({ bufnr = buf, async = true, quiet = true, lsp_format = "fallback" }, function(err, did_edit)
    if err or not did_edit or not vim.api.nvim_buf_is_valid(buf) then return end
    for win, view in pairs(before) do
      if vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_get_buf(win) == buf then
        vim.api.nvim_win_call(win, function()
          local now = vim.fn.winsaveview()
          if now.lnum - now.topline ~= view.lnum - view.topline then
            vim.fn.winrestview({ topline = math.max(1, now.lnum - (view.lnum - view.topline)) })
          end
        end)
      end
    end
    if vim.bo[buf].modified and feel.auto_save() ~= "off" then
      vim.api.nvim_buf_call(buf, function() write_quietly("silent! lockmarks update") end)
    end
  end)
end

-- Not formatted: a file saved right after Cmd+Z (an undone format stays undone, an undone edit leaves the file
-- as it was), or saved as committed (changes rolled back): only files git has a change for (or untracked,
-- ignored, outside a repo). git in its own process, no optional locks (never races a commit's index).
local function format_if_changed(buf)
  local undo = vim.fn.undotree(buf)
  if undo.seq_cur < undo.seq_last then return end
  local file = vim.api.nvim_buf_get_name(buf)
  local ok = pcall(vim.system, { "git", "--no-optional-locks", "-C", vim.fs.dirname(file), "status", "--porcelain",
    "--ignored=matching", "--", file }, { text = true }, vim.schedule_wrap(function(r)
    if r.code == 0 and vim.trim(r.stdout or "") == "" then return end
    if vim.api.nvim_buf_is_valid(buf) and not vim.bo[buf].modified then format_saved(buf) end
  end))
  if not ok then format_saved(buf) end -- no git
end

-- Saved for a popup (menu, toolbar dropdown, picker: a floating window): formatted at the next real switch
-- (or leaving the app), not under the popup: the file it goes back to keeps its text (a diff's whitespace-only
-- change is still there for the Ignore whitespaces dropdown). The save itself stays: menu actions read the disk.
local held = {} ---@type table<integer, true>
local function in_float() return vim.api.nvim_win_get_config(0).relative ~= "" end

vim.api.nvim_create_autocmd({ "BufLeave", "FocusLost" }, {
  nested = true,
  callback = function(args)
    if feel.auto_save() == "off" then return end
    local leave = args.event == "BufLeave"
    local from_float = leave and in_float()
    local saving = {} ---@type table<integer, true>
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
      if vim.bo[buf].modified and vim.bo[buf].buftype == "" and vim.api.nvim_buf_get_name(buf) ~= "" then
        saving[buf] = true
      end
    end
    if next(saving) then
      write_quietly("silent! wall")
    elseif from_float or not next(held) then
      return
    end
    -- on the main loop, after the switch is drawn: costs the switch nothing
    vim.schedule(function()
      if from_float or (leave and in_float()) then -- out of a popup / into one
        held = vim.tbl_extend("force", held, saving)
        return
      end
      saving, held = vim.tbl_extend("force", held, saving), {}
      for buf in pairs(saving) do
        if vim.api.nvim_buf_is_valid(buf) and not vim.bo[buf].modified then format_if_changed(buf) end
      end
    end)
  end,
})

-- files.autoSave afterDelay (VS Code's, files.autoSaveDelay 1000): a real file is written 1 s after its last
-- change, never formatted (formatting under the caret while typing would move the text; Cmd+S formats)
local DELAY = 1000
local delay_timer = nil ---@type uv.uv_timer_t?
vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
  group = vim.api.nvim_create_augroup("ws_autosave_delay", { clear = true }),
  callback = function(args)
    if feel.auto_save() ~= "afterDelay" then return end
    local buf = args.buf
    if vim.bo[buf].buftype ~= "" or vim.api.nvim_buf_get_name(buf) == "" then return end
    delay_timer = delay_timer or assert(vim.uv.new_timer())
    delay_timer:start(DELAY, 0, vim.schedule_wrap(function()
      if feel.auto_save() ~= "afterDelay" or not vim.api.nvim_buf_is_valid(buf) or not vim.bo[buf].modified then return end
      vim.api.nvim_buf_call(buf, function() write_quietly("silent! lockmarks update") end)
    end))
  end,
})

-- o / O after a `// comment` line start a plain line, like IdeaVim (Enter in /** */ still adds " * ")
vim.api.nvim_create_autocmd("FileType", {
  callback = function(args)
    vim.schedule(function() -- after the ftplugin added it
      if vim.api.nvim_buf_is_valid(args.buf) then
        vim.api.nvim_buf_call(args.buf, function() vim.opt_local.formatoptions:remove("o") end)
      end
    end)
  end,
})

-- vtsls tokens whose TS server kind isn't WebStorm's keep the treesitter color drawn before the server
-- answered (after/queries capture the same): `{ fieldName }` shorthand is the variable it names, a key holding
-- a function-typed value (`{ resolver: zodResolver(x) }`) a property, a method imported by name a plain
-- function, `get size()` a method, `as const` a keyword, a local named like a lib global (`location`) plain.
local shorthand = { shorthand_property_identifier = true, shorthand_property_identifier_pattern = true }
local lib_globals = {} -- the names after/queries capture as @variable.global
for _, n in ipairs({ "console", "window", "document", "globalThis", "process", "JSON", "Math", "Reflect", "Intl",
  "localStorage", "sessionStorage", "navigator", "location" }) do
  lib_globals[n] = true
end
local method_parents = { member_expression = true, method_definition = true, method_signature = true,
  abstract_method_signature = true, property_signature = true }
local field_parents = { pair = true, public_field_definition = true, field_definition = true }
local function node_at(buf, token)
  local ok, node = pcall(vim.treesitter.get_node, { bufnr = buf, pos = { token.line, token.start_col } })
  return ok and node or nil
end
vim.api.nvim_create_autocmd("LspTokenUpdate", {
  callback = function(args)
    local token, buf = args.data.token, args.buf
    local t, hl = token.type, nil
    if t == "parameter" or (t == "variable" and token.modifiers["local"]) then -- @types/node's process: no modifier
      local ok, text = pcall(vim.api.nvim_buf_get_text, buf, token.line, token.start_col, token.line, token.end_col, {})
      if ok and lib_globals[text[1]] then hl = "@variable.plain" end
    elseif t == "type" then
      if token.end_col - token.start_col ~= 5 then return end
      local node = node_at(buf, token)
      if node and node:type() == "as_expression" then hl = "@keyword" end -- `const` itself is an unnamed node
    elseif t == "property" or t == "method" then
      if t == "method" and token.start_col > 0 then -- `a.b`: a member function, gold (most method tokens)
        local ok, prev = pcall(vim.api.nvim_buf_get_text, buf, token.line, token.start_col - 1, token.line, token.start_col, {})
        if ok and prev[1] == "." then return end
      end
      local node = node_at(buf, token)
      local parent = node and node:parent()
      if not node or not parent then return end
      local pt = parent:type()
      if shorthand[node:type()] then
        hl = "@variable"
      elseif t == "property" then
        if pt == "method_definition" then hl = "@function.method" end -- get size()
      elseif field_parents[pt] then -- `{ resolver: zodResolver(x) }`: a property, unless its value is a function
        local value = parent:field("value")[1]
        local fn = value and (value:type() == "arrow_function" or value:type() == "function_expression")
        if not fn then hl = "@variable.member" end
      elseif not method_parents[pt] then
        hl = "@function.call" -- a method bound to a name (`import { resolve } from 'path'`): a plain function
      end
    end
    if hl then vim.lsp.semantic_tokens.highlight_token(token, buf, args.data.client_id, hl) end
  end,
})

-- No cursor in the snacks fallback pickers' lists (,fd ,fk ,fh), only the selected row, nor in the empty editor
-- (hints only, until something is typed)
local no_cursor = { snacks_picker_list = true }
local saved_cursor ---@type string?
vim.api.nvim_create_autocmd({ "WinEnter", "BufEnter", "WinLeave", "TextChanged", "TextChangedI" }, {
  callback = function(args)
    local hide = args.event ~= "WinLeave"
      and (no_cursor[vim.bo.filetype] or require("config.empty_editor").is_empty(vim.api.nvim_get_current_buf()))
    if hide and not saved_cursor then
      saved_cursor = vim.o.guicursor
      vim.o.guicursor = "a:GitHiddenCursor"
    elseif not hide and saved_cursor then
      vim.o.guicursor, saved_cursor = saved_cursor, nil
    end
  end,
})

-- The matching bracket (Vim's matchparen plugin) gets highlighted right after the frame instead of before it.
-- Its search asks treesitter at every bracket it passes whether that one is in a string / comment: 2-14 ms in a
-- TSX file per caret move or scroll, and nvim sends a frame only once idle, so every Ctrl+D / Ctrl+U / typed key
-- waited for it (app/tests/perf.rs). A 0 ms timer fires after nvim flushed (it blocks for input first);
-- one run for a burst of moves (key repeat).
vim.api.nvim_create_autocmd("VimEnter", {
  once = true,
  callback = function()
    local info = vim.fn.getscriptinfo({ name = "plugin/matchparen.vim" })[1]
    local fn = info and ("<SNR>%d_Highlight_Matching_Pair"):format(info.sid)
    if not fn or vim.fn.exists("*" .. fn) == 0 or vim.fn.exists("#matchparen") == 0 then return end
    local pending = false
    local events = { "CursorMoved", "CursorMovedI", "WinEnter", "WinScrolled", "TextChanged", "TextChangedI" }
    vim.api.nvim_clear_autocmds({ group = "matchparen", event = events })
    vim.api.nvim_create_autocmd(events, {
      group = "matchparen",
      callback = function()
        if pending then return end
        pending = true
        vim.defer_fn(function()
          pending = false
          pcall(vim.fn[fn])
        end, 0)
      end,
    })
  end,
})
