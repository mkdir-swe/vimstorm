-- The app's native LSP floats (Rust side: app/src/editor/floats): the completion menu with its documentation panel
-- and signature help (blink.cmp stays the engine: its windows become virtual here and their content goes to
-- the app), the hover / error popup (config/gutter.lua: gh, ,e, mouse tooltip) and the Quick Definition
-- popup's chrome (config/peek.lua keeps its Neovim window; the app draws the frame and header around it).
-- Lua -> Rust: notify("floats", { event = ... }); Rust -> Lua: accept(index), closed(kind), copy(text),
-- edit_source / fix / more_actions(id) (the hover's buttons), docs_auto(on), own_menu(open).
-- Plain `nvim` (init.lua guard) never loads this.
local bridge = require("config.app.bridge")

local M = {}

---@param payload table
local function notify(payload) return bridge.notify("floats", payload) end

-- One LSP answer per element, like WebStorm: the hover popup's requests (docs, definition, quick fix) for the
-- same element of an unchanged buffer reuse the last answer, or join the request still on its way, instead of
-- asking the server again (a tooltip shown again, gh before the answer came)
local answers = {} ---@type table<string, {key: string, done?: boolean, result?: any, waiting: fun(result: any)[]}>

-- The element at a position: buffer, its changedtick, line and the identifier's first byte
---@param buf integer
---@param lnum integer
---@param col integer 0-based byte
---@return string
function M.element_key(buf, lnum, col)
  local text = vim.api.nvim_buf_get_lines(buf, lnum - 1, lnum, false)[1] or ""
  local start = math.min(col, #text)
  while start > 0 and text:sub(start, start):match("[%w_$]") do start = start - 1 end
  return table.concat({ buf, vim.b[buf].changedtick, lnum, start }, ":")
end

-- `use(result)` with the answer for `key` in `slot` ("hover", "definition", "fix"): the last one when it's for
-- the same key, else `ask(done)` sends the request and calls done(result) once. An empty answer (false / {}) isn't
-- kept: a server still starting answers empty, the next popup asks again
---@param slot string
---@param key string
---@param ask fun(done: fun(result: any))
---@param use fun(result: any)
function M.once(slot, key, ask, use)
  local c = answers[slot]
  if c and c.key == key then
    if c.done then return use(c.result) end
    c.waiting[#c.waiting + 1] = use
    return
  end
  c = { key = key, waiting = { use } }
  answers[slot] = c
  ask(function(result)
    c.done, c.result = true, result
    if not result or (type(result) == "table" and next(result) == nil) then
      if answers[slot] == c then answers[slot] = nil end
    end
    local waiting = c.waiting
    c.waiting = {}
    for _, f in ipairs(waiting) do f(result) end
  end)
end

---@class FloatsAnchor
---@field win integer window handle (the app maps it to its grid); -1: the command line
---@field row integer window grid row of the anchor cell (0-based, winbar included)
---@field col integer window grid column (0-based, inline virtual text included)

-- Where buffer position (lnum 1-based, col0 0-based byte) is drawn in its window's grid
---@param win integer
---@param lnum integer
---@param col0 integer
---@return FloatsAnchor?
function M.anchor(win, lnum, col0)
  if not vim.api.nvim_win_is_valid(win) then return end
  local p = vim.fn.screenpos(win, lnum, col0 + 1)
  if p.row == 0 then return end
  local wp = vim.fn.win_screenpos(win)
  return { win = win, row = p.row - wp[1], col = p.col - wp[2] }
end

-- The caret of the current window
---@return FloatsAnchor?
function M.caret()
  local win = vim.api.nvim_get_current_win()
  local cur = vim.api.nvim_win_get_cursor(win)
  return M.anchor(win, cur[1], cur[2])
end

-- Code highlighting -------------------------------------------------------------------------------------

local colors = {} ---@type table<string, {fg?: integer, bold?: boolean, italic?: boolean}|false>
-- a look (config/app/look.lua) applies the colorscheme again: read the captures anew
vim.api.nvim_create_autocmd("ColorScheme", { callback = function() colors = {} end })

-- A capture's look as the editor draws it: its @capture.lang group, else the shorter ones (@a.b.c -> @a.b -> @a)
---@param capture string
---@param lang string
local function look(capture, lang)
  local key = capture .. "." .. lang
  if colors[key] ~= nil then return colors[key] or nil end
  local name = "@" .. key
  local found
  while name do
    local hl = vim.api.nvim_get_hl(0, { name = name, link = false })
    if next(hl) then
      found = { fg = hl.fg, bold = hl.bold or nil, italic = hl.italic or nil }
      break
    end
    name = name:match("^(.*)%.[^.]*$")
  end
  colors[key] = found or false
  return found
end

---@alias FloatsSpan integer[] { start byte (0-based), end byte (exclusive), fg 0xRRGGBB or -1, 1 bold + 2 italic }

-- Treesitter colors of a code snippet as the editor's color scheme draws them: sorted, non-overlapping spans
-- (the innermost capture wins, like the highlighter's priority by depth)
---@param code string
---@param ft string filetype
---@param keep? fun(capture: string, text: string, lang: string): boolean only these captures (the markdown preview's lexer-like colours)
---@return FloatsSpan[]
function M.highlight(code, ft, keep)
  local lang = vim.treesitter.language.get_lang(ft ~= "" and ft or "text") or ft
  local ok, parser = pcall(vim.treesitter.get_string_parser, code, lang)
  if not ok or not parser then return {} end
  local query = vim.treesitter.query.get(lang, "highlights")
  local trees = parser:parse()
  if not (query and trees and trees[1]) then return {} end
  -- byte -> look of the last (innermost / later) capture covering it
  local by_byte = {} ---@type table<integer, table>
  for id, node in query:iter_captures(trees[1]:root(), code, 0, -1) do
    local _, _, s = node:start()
    local _, _, e = node:end_()
    local l = (keep == nil or keep(query.captures[id], code:sub(s + 1, e), lang)) and look(query.captures[id], lang)
    if l then
      for b = s, e - 1 do by_byte[b] = l end
    end
  end
  local spans, cur = {}, nil ---@type FloatsSpan[], FloatsSpan?
  for b = 0, #code - 1 do
    local l = by_byte[b]
    if cur and cur.look == l then
      cur[2] = b + 1
    else
      if cur and cur.look then spans[#spans + 1] = cur end
      cur = l and { b, b + 1, fg = l.fg, bold = l.bold, italic = l.italic, look = l } or { look = false }
    end
  end
  if cur and cur.look then spans[#spans + 1] = cur end
  -- as plain arrays (a mixed table doesn't cross RPC): { start, end, fg or -1, 1 bold + 2 italic }
  for i, s in ipairs(spans) do
    spans[i] = { s[1], s[2], s.fg or -1, (s.bold and 1 or 0) + (s.italic and 2 or 0) }
  end
  return spans
end

-- The fenced code blocks of a markdown text, each with its colors (in order; the app pairs them by index)
---@param text string
---@return FloatsSpan[][]
local function code_colors(text)
  local out = {}
  local lines = vim.split(text, "\n", { plain = true })
  local i = 1
  while i <= #lines do
    local indent, fence, ft = lines[i]:match("^(%s*)(```+)%s*([%w_+-]*)")
    if fence then
      local body, j = {}, i + 1
      while j <= #lines and not lines[j]:match("^%s*" .. fence) do
        body[#body + 1] = lines[j]:sub(#indent + 1)
        j = j + 1
      end
      out[#out + 1] = M.highlight(table.concat(body, "\n"), ft)
      i = j + 1
    else
      i = i + 1
    end
  end
  return out
end

---@class FloatsSection
---@field kind "error"|"warning"|"info"|"markdown"
---@field text string
---@field code? FloatsSpan[][] colors of the markdown's code blocks

-- A markdown section with its code colored
---@param text string
---@return FloatsSection
function M.markdown(text)
  return { kind = "markdown", text = text, code = code_colors(text) }
end

-- Hover / error popup (config/gutter.lua) -----------------------------------------------------------------

---@class FloatsHoverOpen
---@field kind string
---@field buf integer
---@field pos? {win: integer, lnum: integer, col: integer} what it's about (caret / mouse; col 0-based byte)
---@field loc? {uri: string, range: lsp.Range, enc: string} the definition (location label, Edit Source)
---@field fix? {action: table, client: integer} the first quick fix
---@field diag? vim.Diagnostic the problem shown first

local hover = { id = 0, group = vim.api.nvim_create_augroup("ws_app_hover", { clear = true }) } ---@type {id: integer, group: integer, open?: FloatsHoverOpen}

-- The code position a popup is about: gh / ,e the caret, the tooltip the mouse
---@param kind string
---@param buf integer
local function hover_pos(kind, buf)
  if kind == "tooltip" then
    local m = vim.fn.getmousepos()
    if m.winid ~= 0 and vim.api.nvim_win_is_valid(m.winid) and vim.api.nvim_win_get_buf(m.winid) == buf and m.line > 0 then
      return { win = m.winid, lnum = m.line, col = math.max(m.column - 1, 0) }
    end
    return
  end
  local win = vim.api.nvim_get_current_win()
  if vim.api.nvim_win_get_buf(win) ~= buf then return end
  local cur = vim.api.nvim_win_get_cursor(win)
  return { win = win, lnum = cur[1], col = cur[2] }
end

-- The definition under the popup's position: the location label ("cart.ts" + its icon), Edit Source's target
---@param id integer
---@param buf integer
local function request_location(id, buf)
  local pos = hover.open.pos
  if not pos or #vim.lsp.get_clients({ bufnr = buf, method = "textDocument/definition" }) == 0 then
    return notify({ event = "hover_location", id = id, file = "", text = "" })
  end
  local text = vim.api.nvim_buf_get_lines(buf, pos.lnum - 1, pos.lnum, false)[1] or ""
  M.once("definition", M.element_key(buf, pos.lnum, pos.col), function(done)
    vim.lsp.buf_request_all(buf, "textDocument/definition", function(client)
      return {
        textDocument = { uri = vim.uri_from_bufnr(buf) },
        position = { line = pos.lnum - 1, character = vim.str_utfindex(text, client.offset_encoding, math.min(pos.col, #text), false) },
      }
    end, function(results)
      for cid, res in pairs(results or {}) do
        local r = res.result
        if type(r) == "table" and r[1] then r = r[1] end
        local uri = type(r) == "table" and (r.targetUri or r.uri)
        if uri then
          local client = vim.lsp.get_client_by_id(cid)
          return done({ uri = uri, range = r.targetSelectionRange or r.range, enc = client and client.offset_encoding or "utf-16" })
        end
      end
      done(false)
    end)
  end, function(loc)
    if hover.id ~= id or not hover.open then return end
    if not loc then
      return notify({ event = "hover_location", id = id, file = "", text = "" }) -- none: the popup drops the label row
    end
    hover.open.loc = loc
    local fname = vim.uri_to_fname(loc.uri)
    notify({ event = "hover_location", id = id, file = fname, text = vim.fn.fnamemodify(fname, ":t") })
  end)
end

-- The first quick fix for the popup's first problem (WebStorm's "<fix>  More actions… ⌥⏎" row)
---@param id integer
---@param buf integer
---@param text string the problem as shown (config/gutter.lua format)
local function request_fix(id, buf, text)
  local pos = hover.open.pos
  local diag ---@type vim.Diagnostic?
  local ok, gutter = pcall(require, "config.gutter")
  for _, d in ipairs(vim.diagnostic.get(buf)) do
    if ok and gutter.format(d) == text and (not diag or (pos and math.abs(d.lnum - (pos.lnum - 1)) < math.abs(diag.lnum - (pos.lnum - 1)))) then
      diag = d
    end
  end
  if not diag then return end
  hover.open.diag = diag
  local lsp_diag = type(diag.user_data) == "table" and diag.user_data.lsp or nil
  if not lsp_diag or #vim.lsp.get_clients({ bufnr = buf, method = "textDocument/codeAction" }) == 0 then return end
  local r = lsp_diag.range
  local key = table.concat({ buf, vim.b[buf].changedtick, r.start.line, r.start.character, r["end"].line, r["end"].character, text }, ":")
  M.once("fix", key, function(done)
    vim.lsp.buf_request_all(buf, "textDocument/codeAction", {
      textDocument = { uri = vim.uri_from_bufnr(buf) },
      range = lsp_diag.range,
      context = { diagnostics = { lsp_diag }, only = { "quickfix" }, triggerKind = 1 },
    }, function(results)
      local first ---@type {action: table, client: integer}?
      for cid, res in pairs(results or {}) do
        for _, a in ipairs(type(res.result) == "table" and res.result or {}) do
          if not a.disabled and (not first or (a.isPreferred and not first.action.isPreferred)) then
            first = { action = a, client = cid }
          end
        end
      end
      done(first or false)
    end)
  end, function(first)
    if hover.id ~= id or not hover.open or not first then return end
    hover.open.fix = first
    notify({ event = "hover_fix", id = id, title = first.action.title })
  end)
end

-- Show the hover popup: kind "hover" (gh, ,e: at the caret, can take focus) or "tooltip" (mouse, never)
---@param kind "hover"|"tooltip"
---@param sections FloatsSection[]
---@param anchor FloatsAnchor
---@param buf integer the code buffer (leaving it closes the popup)
function M.show_hover(kind, sections, anchor, buf)
  hover.id = hover.id + 1
  hover.open = { kind = kind, buf = buf, pos = hover_pos(kind, buf) }
  vim.api.nvim_clear_autocmds({ group = hover.group })
  -- like open_floating_preview's close_events: the caret moving, typing, scrolling or leaving the buffer
  local id = hover.id
  vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI", "InsertEnter", "WinScrolled", "BufLeave" }, {
    group = hover.group,
    buffer = buf,
    callback = function()
      -- (the autocmd fires for this event even when gh reopened it in the same step: only the current one)
      vim.schedule(function() if hover.id == id then M.close_hover() end end)
    end,
  })
  notify({ event = "hover", id = hover.id, kind = kind, sections = sections, anchor = anchor })
  -- the popup's extras arrive after it (the language server answers)
  local problem, docs
  for _, s in ipairs(sections) do
    if s.kind == "markdown" then docs = true elseif not problem then problem = s.text end
  end
  if docs then request_location(id, buf) end
  if problem then request_fix(id, buf, problem) end
end

-- Rust: the doc popup's ✏ (Edit Source): to the definition (gh's own target when the server had none)
---@param id integer
function M.edit_source(id)
  local open = hover.open
  if id ~= hover.id or not open then return end
  M.close_hover()
  require("config.gutter").tooltip_closed()
  vim.schedule(function()
    if open.pos and vim.api.nvim_win_is_valid(open.pos.win) then vim.api.nvim_set_current_win(open.pos.win) end
    if open.loc then return require("config.usages").jump(open.loc) end
    if open.pos then pcall(vim.api.nvim_win_set_cursor, open.pos.win, { open.pos.lnum, open.pos.col }) end
    vim.lsp.buf.definition()
  end)
end

-- Rust: the quick fix link: applies it (resolved first when the server sends it bare)
---@param id integer
function M.fix(id)
  local open = hover.open
  if id ~= hover.id or not (open and open.fix) then return end
  M.close_hover()
  require("config.gutter").tooltip_closed()
  local client = vim.lsp.get_client_by_id(open.fix.client)
  if not client then return end
  local function apply(a)
    if a.edit then vim.lsp.util.apply_workspace_edit(a.edit, client.offset_encoding) end
    local cmd = type(a.command) == "table" and a.command or (type(a.command) == "string" and a or nil)
    if cmd then client:exec_cmd(cmd, { bufnr = open.buf }) end
  end
  local a = open.fix.action
  if not a.edit and a.data ~= nil and client:supports_method("codeAction/resolve") then
    client:request("codeAction/resolve", a, function(err, res) vim.schedule(function() apply(not err and res or a) end) end, open.buf)
  else
    apply(a)
  end
end

-- Rust: "More actions…": the caret on the problem, then the context actions (⌥⏎)
---@param id integer
function M.more_actions(id)
  local open = hover.open
  if id ~= hover.id or not open then return end
  M.close_hover()
  require("config.gutter").tooltip_closed()
  vim.schedule(function()
    local win = open.pos and open.pos.win
    if win and vim.api.nvim_win_is_valid(win) then
      vim.api.nvim_set_current_win(win)
      if open.diag then pcall(vim.api.nvim_win_set_cursor, win, { open.diag.lnum + 1, open.diag.col }) end
    end
    require("config.context").code_actions()
  end)
end

-- Rust: one of the floats' ⋮ menus is open (the keyboard went to it: the popups stay)
local own_menu = false
---@param open boolean
function M.own_menu(open) own_menu = open end

---@return "hover"|"tooltip"|nil
function M.hover_kind() return hover.open and hover.open.kind or nil end

-- gh / ,e twice: into the popup (scroll, select, copy); Esc closes it
---@return boolean entered
function M.enter_hover()
  -- (only this buffer's popup, like vim.b.lsp_floating_preview)
  if not hover.open or hover.open.buf ~= vim.api.nvim_get_current_buf() then return false end
  notify({ event = "hover_focus", id = hover.id })
  return true
end

function M.close_hover()
  if not hover.open then return false end
  hover.open = nil
  vim.api.nvim_clear_autocmds({ group = hover.group })
  notify({ event = "hover_close", id = hover.id })
  return true
end

-- Rust: the popup closed itself (Esc / q in it, focus left it)
---@param id integer
function M.closed(id)
  if id == hover.id and hover.open then
    hover.open = nil
    vim.api.nvim_clear_autocmds({ group = hover.group })
    require("config.gutter").tooltip_closed()
  end
end

-- Rust: the mouse left the code for the app's own chrome (tree, toolbar, status bar, gaps: not nvim cells, so
-- no <MouseMove> says so): the tooltip closes, a pending one doesn't open
function M.mouse_left() require("config.gutter").mouse_left() end

-- config/app.lua: a native surface (tree, picker, ...) took the keyboard: the popups close like on WinLeave
---@param _ string the surface
function M.focus_left(_)
  if own_menu then return end
  M.close_hover()
  require("config.gutter").tooltip_closed()
  if package.loaded["config.peek"] then require("config.peek").close() end
end

-- Rust: Cmd+C in a native popup (the selection as shown); through the clipboard provider like the editor's copy
---@param text string
function M.copy(text) vim.fn.setreg("+", text) end

-- Quick Definition chrome (config/peek.lua) ---------------------------------------------------------------

---@class FloatsPeekHeader
---@field file string absolute path (the app picks its icon)
---@field path string relative to the project (the app shortens it from the left to fit)
---@field right string "2 of 3   line 14"
---@field bg integer the popup body color (WsPeek)

---@param win integer the popup's Neovim window
---@param header FloatsPeekHeader
---@param above boolean popup above the caret line (header still on top)
function M.peek(win, header, above)
  notify({ event = "peek", win = win, header = header, above = above })
end

function M.peek_close() notify({ event = "peek_close" }) end

-- Completion (blink.cmp) ---------------------------------------------------------------------------------

-- A stand-in for blink's window objects (blink.cmp.lib.window): never a Neovim window, only open or not.
-- blink's own code still asks it (is_open, sizes) through menu.win / docs.win / signature.win.
---@param height fun(): integer
local function virtual_win(height)
  local w = { opened = false }
  local none = { vertical = 0, horizontal = 0, left = 0, right = 0, top = 0, bottom = 0 }
  function w:is_open() return self.opened end
  function w:open() self.opened = true end
  function w:close() self.opened = false end
  function w:get_win() return nil end
  function w:get_buf() return -1 end
  function w:get_height() return height() end
  function w:get_width() return 0 end
  function w:get_border_size() return none end
  function w:get_vertical_direction_and_height() return { direction = "s", height = height() } end
  function w:get_direction_with_window_constraints() return nil end
  function w:update_size() end
  function w:set_option_value() end
  function w:set_cursor() end
  function w:set_height() end
  function w:set_width() end
  function w:set_win_config() end
  function w:get_cursor() return { 1, 0 } end
  function w:get_content_height() return height() end
  return w
end

local snippet_mark = "~"
local cmp = { dirty = {}, scheduled = false } ---@type {dirty: table<string, boolean>, scheduled: boolean, sent_items?: table, focused?: boolean, shown?: boolean}

-- Menu state -> app, once per event-loop turn whatever changed in it (typing changes items, selection and
-- the anchor several times per key); items only when they changed (the selection alone is a small message)
local function flush()
  cmp.scheduled = false
  local menu = require("blink.cmp.completion.windows.menu")
  local d = cmp.dirty
  cmp.dirty = {}
  if not menu.win:is_open() then
    cmp.focused = false
    if cmp.shown then
      cmp.shown = false
      notify({ event = "menu_close" })
    end
    return
  end
  -- WebStorm's lookup is gray (semi-focused) until the user moves the selection, then blue until it closes
  cmp.focused = cmp.focused or require("blink.cmp.completion.list").is_explicitly_selected == true
  local p = { event = "menu", selected = menu.selected_item_idx or 0, focused = cmp.focused }
  if d.items or not cmp.shown then
    local items, out = menu.items or {}, {}
    local ctx = menu.context
    local matched = {}
    if ctx and #items > 0 then
      local labels = {}
      for i, it in ipairs(items) do labels[i] = it.label end
      local ok, m = pcall(require("blink.cmp.fuzzy").fuzzy_matched_indices, ctx.get_line(), ctx.get_cursor()[2], labels,
        require("blink.cmp.config").completion.keyword.range)
      if ok then matched = m end
    end
    for i, it in ipairs(items) do
      local det = type(it.labelDetails) == "table" and it.labelDetails or {}
      local label = (it.label or ""):gsub("\n", " ")
      if it.kind == 15 then label = label .. snippet_mark end -- blink's snippet indicator
      out[i] = {
        label = label,
        detail = type(det.detail) == "string" and det.detail:gsub("\n", " ") or "",
        description = type(det.description) == "string" and det.description:gsub("\n", " ") or "",
        kind = it.kind or 0,
        deprecated = it.deprecated == true or (type(it.tags) == "table" and vim.tbl_contains(it.tags, 1)),
        matched = matched[i] or {},
      }
    end
    p.items = out
  end
  if d.anchor or d.items or not cmp.shown then
    local ctx = menu.context
    if ctx and vim.api.nvim_get_mode().mode == "c" then
      -- the command line (win -1: the app's message grid): the word's cell after the 1-cell prompt
      p.anchor = { win = -1, row = 0, col = ctx.bounds.start_col }
    elseif ctx then
      local win = vim.api.nvim_get_current_win()
      p.anchor = M.anchor(win, ctx.get_cursor()[1], ctx.bounds.start_col - 1)
    end
  end
  cmp.shown = true
  notify(p)
end

---@param what "items"|"select"|"anchor"|"open"
local function changed(what)
  cmp.dirty[what] = true
  if cmp.scheduled then return end
  cmp.scheduled = true
  -- a timer, not vim.schedule: that can run before the redraw of the key just typed (measured: +0.4 ms
  -- key -> frame); the timer runs once the screen is out
  vim.defer_fn(flush, 0)
end

-- WebStorm's JS/TS parameter info shows only the parameter list: the text between a signature label's outer
-- parens ("<no parameters>" when empty) and the byte offset it starts at in the label (to shift the active
-- parameter's range); a label without parens stays whole.
---@param label string
---@return string text, integer offset
function M.signature_params(label)
  local open = label:find("(", 1, true)
  if not open then return label, 0 end
  local depth = 0
  for i = open, #label do
    local ch = label:sub(i, i)
    if ch == "(" then
      depth = depth + 1
    elseif ch == ")" then
      depth = depth - 1
      if depth == 0 then
        local text = label:sub(open + 1, i - 1)
        if vim.trim(text) == "" then return "<no parameters>", open end
        return text, open
      end
    end
  end
  return label, 0
end

-- Takes over blink's menu, documentation and signature windows (from plugins/lsp.lua once blink is set up)
function M.blink()
  local menu = require("blink.cmp.completion.windows.menu")
  local docs = require("blink.cmp.completion.windows.documentation")
  local signature = require("blink.cmp.signature.window")
  local utils = require("blink.cmp.lib.utils")
  local sources = require("blink.cmp.sources.lib")
  local max = require("blink.cmp.config").completion.menu.max_height
  snippet_mark = require("blink.cmp.config").completion.menu.draw.snippet_indicator or "~"
  -- insert-mode Ctrl+S (Neovim's default: vim.lsp.buf.signature_help, a Neovim float): blink's, drawn here
  vim.keymap.set({ "i", "s" }, "<C-s>", function() require("blink.cmp").show_signature() end, { desc = "Signature help" })

  menu.win = virtual_win(function() return math.min(#(menu.items or {}), max) end)
  function menu.open_with_items(context, items)
    menu.context = context
    menu.items = items
    menu.set_selected_item_idx(menu.selected_item_idx ~= nil and math.min(menu.selected_item_idx, #items) or nil)
    changed("items")
    menu.queue_auto_show(context, items)
  end
  function menu.open_loading(context)
    menu.context = context
    menu.items = {}
    menu.set_selected_item_idx(nil)
    changed("items")
  end
  function menu.open()
    if menu.win:is_open() then return end
    utils.disable_auto_wrap()
    menu.win:open()
    changed("open")
    menu.open_emitter:emit()
  end
  function menu.close()
    menu.reset_auto_show()
    if not menu.win:is_open() then return end
    menu.win:close()
    utils.restore_auto_wrap()
    changed("open")
    menu.close_emitter:emit()
  end
  function menu.set_selected_item_idx(idx)
    menu.selected_item_idx = idx
    changed("select")
  end
  function menu.update_position()
    if not menu.win:is_open() then return end
    changed("anchor")
    menu.position_update_emitter:emit()
  end
  function menu.redraw_if_needed() end

  -- documentation panel next to the menu: the selected item's detail (code) + docs (markdown)
  local docs_open = false
  docs.win = virtual_win(function() return 0 end)
  function docs.show_item(context, item)
    docs.auto_show_timer:stop()
    if item == nil or not menu.win:is_open() then return docs.close() end
    sources.resolve(context, item):map(function(resolved)
      if not menu.win:is_open() then return end
      local text = {}
      if type(resolved.detail) == "string" and vim.trim(resolved.detail) ~= "" then
        text[#text + 1] = "```" .. vim.bo.filetype .. "\n" .. vim.trim(resolved.detail) .. "\n```"
      end
      local doc = resolved.documentation
      if type(doc) == "table" then doc = doc.value end
      if type(doc) == "string" and vim.trim(doc) ~= "" then text[#text + 1] = doc end
      if #text == 0 then return docs.close() end
      docs.shown_item = item
      docs.win:open()
      docs_open = true
      notify({ event = "menu_doc", section = M.markdown(table.concat(text, "\n\n")) })
    end):catch(function(err) vim.notify(err, vim.log.levels.ERROR, { title = "blink.cmp" }) end)
  end
  function docs.close()
    docs.auto_show_timer:stop()
    docs.shown_item = nil
    docs.win:close()
    if docs_open then
      docs_open = false
      notify({ event = "menu_doc_close" })
    end
  end
  function docs.update_position() end
  function docs.scroll_up(n) notify({ event = "menu_doc_scroll", rows = -n }) end
  function docs.scroll_down(n) notify({ event = "menu_doc_scroll", rows = n }) end

  -- signature help (WebStorm's parameter info): the signatures, the active parameter bold; ⌃↑ / ⌃↓ switch the
  -- overload ("Switch with ⌃↑ or ⌃↓" under several), the choice kept while the call's overloads stay the same
  local sig = {} ---@type {help?: table, pick?: integer}
  signature.win = virtual_win(function() return 1 end)
  function signature.open_with_signature_help(context, help)
    signature.context = context
    local sigs = help and help.signatures or {}
    local prev = sig.help and sig.help.signatures or {}
    if not (#sigs == #prev and sigs[1] and prev[1] and sigs[1].label == prev[1].label) then sig.pick = nil end
    sig.help = help
    local ix = sig.pick or (help and help.activeSignature or 0) + 1
    local active = sigs[ix]
    if not active then return signature.close() end
    local labels, offset = {}, 0
    for i, s in ipairs(help.signatures) do
      local text, off = M.signature_params(s.label)
      labels[i] = text
      if i == ix then offset = off end
    end
    local param = active.parameters and active.parameters[(active.activeParameter or help.activeParameter or 0) + 1]
    local range ---@type integer[]?
    if param then
      local l = param.label
      if type(l) == "table" then
        range = { vim.str_byteindex(active.label, "utf-16", l[1], false), vim.str_byteindex(active.label, "utf-16", l[2], false) }
      elseif type(l) == "string" and l ~= "" then
        local s = active.label:find(l, offset + 1, true)
        if s then range = { s - 1, s - 1 + #l } end
      end
    end
    -- into the shown parameter list (none when it lies outside it)
    if range then
      range = { range[1] - offset, range[2] - offset }
      if range[1] < 0 or range[2] > #labels[ix] then range = nil end
    end
    signature.win:open()
    notify({
      event = "signature",
      labels = labels,
      active = ix,
      param = range or {},
      anchor = M.caret(),
    })
  end
  -- ⌃↑ / ⌃↓ (WebStorm's MethodOverloadSwitchUp / Down) while several signatures show
  for key, step in pairs({ ["<C-Up>"] = -1, ["<C-Down>"] = 1 }) do
    vim.keymap.set("i", key, function()
      local n = sig.help and sig.help.signatures and #sig.help.signatures or 0
      if not signature.win:is_open() or n < 2 then return vim.keycode(key) end
      local cur = sig.pick or (sig.help.activeSignature or 0) + 1
      vim.schedule(function()
        sig.pick = (cur - 1 + step) % n + 1
        signature.open_with_signature_help(signature.context, sig.help)
      end)
      return ""
    end, { expr = true, desc = step < 0 and "Previous overload" or "Next overload" })
  end
  function signature.close()
    sig.help, sig.pick = nil, nil
    if not signature.win:is_open() then return end
    signature.win:close()
    notify({ event = "signature_close" })
  end
  function signature.update_position() end
  function signature.scroll_up() end
  function signature.scroll_down() end
end

-- Rust: the completion ⋮ "Show Documentation Popup": blink's documentation auto-show on / off
---@param on boolean
function M.docs_auto(on)
  require("blink.cmp.config").completion.documentation.auto_show = on
  local cmp = require("blink.cmp")
  if on then cmp.show_documentation() else cmp.hide_documentation() end
end

-- Rust: a click on menu item `index` (1-based) accepts it
---@param index integer
function M.accept(index)
  vim.schedule(function() require("blink.cmp").accept({ index = index }) end)
end

return M
