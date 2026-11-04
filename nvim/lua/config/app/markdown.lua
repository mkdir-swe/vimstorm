-- The app's markdown preview (Rust side: app/src/editor/markdown, "MarkdownView"). config/markdown.lua keeps the modes per
-- file, the preview split (Editor and Preview: an empty placeholder window right of the editor, ratio rules, closed
-- by hand -> Editor Only) and the read-only rule; those windows get role "markdown" (their grids aren't
-- drawn) and the native view renders the source text over them: the placeholder, or in Preview Only the file's own
-- window. The mode toolbar is native too (no float).
--
-- Lua -> Rust (`vimstorm.markdown`):
--   state {wins = {{win, buf, mode, preview?, bar, host}}}  the current tab's markdown editors, when that changes
--   text {buf, tick, path, text}   a source buffer's text (on first need, then coalesced to 40 ms while typing)
--   abe {buf, preview?}            a Layer's workflow file's preview (config/workflow.lua), drawn in place of the text
--   caret {buf, line}              its caret's line: the preview rings that step's card
--   code {id, colors}              treesitter colors of code blocks Rust asked for (`highlight`)
--   top {win, top}                 the editor's topline after set_top (Rust ignores that scroll)
--   scroll {win, by, n}            a scroll key in a preview (by: "line" | "half" | "page" | "top" | "bottom" | "goto" line n)
--   copy {win} / select_all {win}  Cmd+C / Cmd+A in a preview
-- Rust -> Lua: set_top(win, line), set_mode(win, mode), enter(win), open_link(win, target),
--   context(win, x, y, selection), highlight(id, blocks), copy(text).
local bridge = require("config.app.bridge")
local M = {}

local function md() return require("config.markdown") end
local function valid_win(w) return w ~= nil and vim.api.nvim_win_is_valid(w) end

local wins = {} ---@type table[] last state sent
local last_state = ""
local sent = {} ---@type table<integer, string> buf -> what was sent ("<changedtick>:<readable side's length+hash>")
local pending = {} ---@type table<integer, true> buf -> a send is due

-- A source buffer's text to Rust; a Layer's workflow / skill file sends its readable side (config/workflow.lua)
---@param buf integer
function M.send_text(buf)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  local layer = vim.b[buf].abe_layer and require("config.workflow") or nil
  local readable = layer and layer.markdown(buf) or nil
  local key = tick .. ":" .. (readable and vim.fn.sha256(readable) or "")
  if sent[buf] == key then return end
  sent[buf] = key
  local text = readable or table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
  -- a workflow's preview first: the app draws it in place of the text (none clears it)
  bridge.notify("markdown", { event = "abe", buf = buf, preview = layer and layer.preview(buf) or nil })
  bridge.notify("markdown", { event = "text", buf = buf, tick = tick, path = vim.api.nvim_buf_get_name(buf), text = text })
end

-- Buffers whose text the app renders
local function rendered(buf)
  for _, w in ipairs(wins) do
    if w.buf == buf and (w.preview or w.mode == "preview") then return true end
  end
  return false
end

local carets = {} ---@type table<integer, integer> buf -> caret line last sent
-- The caret's line of a workflow file shown with its preview, when it moved to another line
---@param buf integer
function M.caret(buf)
  if not rendered(buf) or vim.api.nvim_get_current_buf() ~= buf then return end
  local line = vim.api.nvim_win_get_cursor(0)[1]
  if carets[buf] == line then return end
  carets[buf] = line
  bridge.notify("markdown", { event = "caret", buf = buf, line = line })
end

-- A new readable side of a Layer's file (config/workflow.lua): to Rust when it's shown
---@param buf integer
function M.resend(buf)
  if rendered(buf) then M.send_text(buf) end
end

-- The current tab's markdown editors (config/markdown.lua's sync): to Rust when changed, text for new ones
---@param list table[] {win, buf, mode, preview?, bar, host}
function M.changed(list)
  wins = list
  local parts = {}
  for _, w in ipairs(list) do
    parts[#parts + 1] = table.concat({ w.win, w.buf, w.mode, w.preview or "", tostring(w.bar), w.host }, ":")
  end
  local key = table.concat(parts, ",")
  for _, w in ipairs(list) do
    if w.preview or w.mode == "preview" then M.send_text(w.buf) end
  end
  if key ~= last_state then
    last_state = key
    bridge.notify("markdown", { event = "state", wins = list })
    require("config.app.layout").sync()
  end
  -- forget buffers no longer shown (a later preview sends their text again)
  for buf in pairs(sent) do
    if not rendered(buf) then sent[buf] = nil end
  end
end

-- Role of a window: the preview placeholder, or a split showing its file in Preview Only
---@param win integer
---@return "markdown"|nil
function M.role(win)
  local buf = vim.api.nvim_win_get_buf(win)
  if vim.b[buf].ws_md_preview then return "markdown" end
  for _, w in ipairs(wins) do
    if w.win == win and w.mode == "preview" and w.buf == buf then return "markdown" end
  end
end

-- Keys of a preview (the placeholder buffer, a file in Preview Only): they scroll the native view, like the arrow /
-- page keys in WebStorm's preview; Cmd+C / Cmd+A copy / select its text
local SCROLL = {
  ["ö"] = { "line", 1 }, ["<Down>"] = { "line", 1 }, ["<C-e>"] = { "line", 1 }, ["<C-S-ö>"] = { "line", 3 },
  ["l"] = { "line", -1 }, ["<Up>"] = { "line", -1 }, ["<C-y>"] = { "line", -1 }, ["<C-S-l>"] = { "line", -3 },
  ["Ö"] = { "line", 5 }, ["J"] = { "line", 5 }, ["L"] = { "line", -5 },
  ["<C-d>"] = { "half", 1 }, ["<C-u>"] = { "half", -1 },
  ["<C-f>"] = { "page", 1 }, ["<PageDown>"] = { "page", 1 }, ["<Space>"] = { "page", 1 },
  ["<C-b>"] = { "page", -1 }, ["<PageUp>"] = { "page", -1 }, ["<S-Space>"] = { "page", -1 },
  ["gg"] = { "top", -1 }, ["<Home>"] = { "top", -1 }, ["G"] = { "bottom", 1 }, ["<End>"] = { "bottom", 1 },
}

---@param buf integer
---@param on boolean
function M.preview_keys(buf, on)
  local opts = { buffer = buf, nowait = true }
  for lhs, s in pairs(SCROLL) do
    if on then
      vim.keymap.set("n", lhs, function()
        local by, n = s[1], s[2] * vim.v.count1
        -- 5G / 3gg: that line at the top (Lua's mirror buffer jumped there)
        if (by == "top" or by == "bottom") and vim.v.count > 0 and (lhs == "gg" or lhs == "G") then by, n = "goto", vim.v.count end
        bridge.notify("markdown", { event = "scroll", win = vim.api.nvim_get_current_win(), by = by, n = n })
      end, opts)
    else
      pcall(vim.keymap.del, "n", lhs, { buffer = buf })
    end
  end
  for lhs, ev in pairs({ ["<D-c>"] = "copy", ["<D-a>"] = "select_all" }) do
    if on then
      vim.keymap.set("n", lhs, function() bridge.notify("markdown", { event = ev, win = vim.api.nvim_get_current_win() }) end, opts)
    else
      pcall(vim.keymap.del, "n", lhs, { buffer = buf })
    end
  end
end

-- Rust -> Lua ---------------------------------------------------------------------------------------------

-- The preview scrolled (wheel / keys): the editor's topline follows (1-based line); in Preview Only `win` is the
-- file's own window. The caret stays inside the view without moving it (scrolloff kept).
---@param win integer
---@param line integer
function M.set_top(win, line)
  if not valid_win(win) then return end
  local buf = vim.api.nvim_win_get_buf(win)
  local last = vim.api.nvim_buf_line_count(buf)
  line = math.max(1, math.min(line, last))
  vim.api.nvim_win_call(win, function()
    local view = vim.fn.winsaveview()
    local so = vim.wo[win].scrolloff
    if so < 0 then so = vim.o.scrolloff end
    local height = vim.api.nvim_win_get_height(win)
    local lnum = view.lnum
    -- keep the caret where it is when it stays visible, else at the nearest line inside the view
    local lo, hi = line + so, line + height - 1 - so
    if lnum < lo then lnum = lo elseif lnum > hi then lnum = hi end
    lnum = math.max(1, math.min(lnum, last))
    vim.fn.winrestview({ topline = line, lnum = lnum, col = lnum == view.lnum and view.col or 0 })
  end)
  bridge.notify("markdown", { event = "top", win = win, top = vim.fn.line("w0", win) })
end

-- Toolbar click: mode for the file of source window `win`
---@param win integer
---@param mode "editor"|"split"|"preview"
function M.set_mode(win, mode)
  if not valid_win(win) then return end
  md().set(mode, vim.api.nvim_win_get_buf(win), win)
end

-- A click into a preview: its window becomes the current one (keys scroll it, ,m / Cmd+C act on it)
---@param win integer
function M.enter(win)
  if valid_win(win) and vim.api.nvim_get_current_win() ~= win then
    vim.cmd.stopinsert()
    vim.api.nvim_set_current_win(win)
  end
end

-- A link to a file (relative to the markdown file, or absolute): opened in the editor split of the pair
---@param win integer source window
---@param target string
function M.open_link(win, target)
  if not valid_win(win) then return end
  -- a Layer's file's actions (Edit my copy, Propose…, Retro…, a finding's fix)
  if require("config.workflow").open_link(win, target) then return end
  local buf = vim.api.nvim_win_get_buf(win)
  local path, frag = target:match("^([^#]*)#?(.*)$")
  path = vim.uri_decode and vim.uri_decode(path) or path
  if path:match("^file://") then path = vim.uri_to_fname(path) end
  if path ~= "" and not path:match("^/") then
    path = vim.fs.normalize(vim.fs.dirname(vim.api.nvim_buf_get_name(buf)) .. "/" .. path)
  end
  if path == "" or vim.fn.filereadable(path) == 0 then
    vim.notify("Cannot find file " .. target, vim.log.levels.WARN)
    return
  end
  vim.api.nvim_set_current_win(win)
  vim.cmd.edit(vim.fn.fnameescape(path))
  local line = tonumber(frag:match("^L(%d+)") or "")
  if line then pcall(vim.api.nvim_win_set_cursor, 0, { line, 0 }) end
end

-- Right-click in a preview (window px): Copy (a selection) and the three layouts
---@param win integer
---@param x number
---@param y number
---@param selection boolean
function M.context(win, x, y, selection)
  if not valid_win(win) then return end
  M.enter(win)
  local items = md().menu_items(vim.api.nvim_win_get_buf(win))
  table.remove(items, 1) -- (its leading separator)
  -- Copy first, like WebStorm's preview menu (disabled without a selection)
  table.insert(items, 1, "-")
  table.insert(items, 1, { "Copy", function() bridge.notify("markdown", { event = "copy", win = win }) end, key = "⌘C",
    enabled = selection })
  require("config.menu").open(items, { pos = { x = x, y = y } })
end

-- WebStorm colours a fence with the language's lexer, not its semantic highlighter: keywords, strings, numbers,
-- comments and the `;` / `,` delimiters; identifiers, calls, properties, types and operators stay the text colour
local function lexical(capture, text, lang)
  local root = capture:match("^[^.]+")
  if root == "keyword" or root == "number" or root == "comment" or root == "boolean" then return true end
  if root == "string" then return not capture:match("^string%.special") end
  if capture == "punctuation.delimiter" then
    return (text == ";" or text == ",") and lang ~= "bash"
  end
  -- (TS's primitive types are keywords to WS's lexer; builtin classes like Error aren't)
  if capture == "type.builtin" then return text:match("^%l") ~= nil end
  return capture == "float" or capture == "constant.builtin" or capture == "character"
end

-- Treesitter colors of code blocks ({lang, text} each), in the editor's colour scheme (config/app/floats.lua)
local cache = {} ---@type table<string, table>
local cached = 0
-- a look (config/app/look.lua) applies the colorscheme again: colour the blocks anew
vim.api.nvim_create_autocmd("ColorScheme", { callback = function() cache, cached = {}, 0 end })
---@param id integer
---@param blocks {[1]: string, [2]: string}[]
function M.highlight(id, blocks)
  local floats = require("config.app.floats")
  local out = {}
  for i, b in ipairs(blocks) do
    local key = b[1] .. "\0" .. b[2]
    local spans = cache[key]
    if not spans then
      local ok, s = pcall(floats.highlight, b[2], b[1], lexical)
      spans = ok and s or {}
      if cached > 500 then cache, cached = {}, 0 end
      cache[key], cached = spans, cached + 1
    end
    out[i] = spans
  end
  bridge.notify("markdown", { event = "code", id = id, colors = out })
end

-- Cmd+C in a preview: its selected text to the clipboard
---@param text string
function M.copy(text)
  vim.fn.setreg("+", text)
end

function M.setup()
  require("config.app.layout").role_provider("markdown", M.role)
  local group = vim.api.nvim_create_augroup("ws_app_markdown", { clear = true })
  -- live preview while typing: at most every 40 ms (Lua's rate)
  vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI" }, {
    group = group,
    callback = function(ev)
      local buf = ev.buf
      if pending[buf] or not rendered(buf) then return end
      pending[buf] = true
      vim.defer_fn(function()
        pending[buf] = nil
        if rendered(buf) then M.send_text(buf) end
      end, 40)
    end,
  })
end

return M
