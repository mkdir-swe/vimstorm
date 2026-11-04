-- WebStorm's Cmd+B: on a usage -> go to its declaration ("Choose Declaration" popup when there are
-- several); on the declaration -> the Show Usages popup. Both are small lists at the caret, drawn by the app
-- (app/src/search): file icon, the code line with the name in bold, "file.tsx 42" muted on the right
-- ("Password/index.tsx 42" when names clash). One result jumps straight there, like WebStorm.

local M = {}

---@class UsageLoc
---@field uri string
---@field range lsp.Range
---@field enc string client offset encoding
---@field full? lsp.Range the whole declaration (LocationLink targetRange), for the Quick Definition popup

-- Location / LocationLink results of all clients, deduped
---@param results table<integer, {err?: lsp.ResponseError, result?: any}>
---@return UsageLoc[]
local function locations(results)
  local out, seen = {}, {}
  for id, res in pairs(results or {}) do
    local client = vim.lsp.get_client_by_id(id)
    local locs = type(res.result) == "table" and res.result or {}
    if not vim.islist(locs) then locs = { locs } end
    for _, l in ipairs(locs) do
      local uri, range = l.uri or l.targetUri, l.targetSelectionRange or l.range
      local key = uri and range and ("%s:%d:%d"):format(uri, range.start.line, range.start.character)
      if key and not seen[key] then
        seen[key] = true
        out[#out + 1] = { uri = uri, range = range, full = l.targetRange or l.range, enc = client and client.offset_encoding or "utf-16" }
      end
    end
  end
  table.sort(out, function(a, b)
    if a.uri ~= b.uri then return a.uri < b.uri end
    return a.range.start.line < b.range.start.line
      or (a.range.start.line == b.range.start.line and a.range.start.character < b.range.start.character)
  end)
  return out
end

-- `method` at the cursor, from every client that supports it; cb(locations) unless the caret moved
---@param method string
---@param extra? table params merged in
---@param cb fun(locs: UsageLoc[])
function M.request(method, extra, cb)
  local win, buf = vim.api.nvim_get_current_win(), vim.api.nvim_get_current_buf()
  local cur = vim.api.nvim_win_get_cursor(win)
  vim.lsp.buf_request_all(buf, method, function(client)
    return vim.tbl_extend("force", vim.lsp.util.make_position_params(win, client.offset_encoding), extra or {})
  end, function(results)
    vim.schedule(function()
      if vim.api.nvim_get_current_win() ~= win or not vim.deep_equal(vim.api.nvim_win_get_cursor(win), cur) then return end
      cb(locations(results))
    end)
  end)
end

local function supports(method)
  return #vim.lsp.get_clients({ bufnr = 0, method = method }) > 0
end

-- Line `lnum` (0-based) of a file: the buffer when loaded, else read from disk (cached per popup)
---@param cache table<string, string[]>
local function line_of(cache, fname, lnum)
  local b = vim.fn.bufnr(fname)
  if b ~= -1 and vim.api.nvim_buf_is_loaded(b) then
    return vim.api.nvim_buf_get_lines(b, lnum, lnum + 1, false)[1] or ""
  end
  cache[fname] = cache[fname] or (vim.fn.filereadable(fname) == 1 and vim.fn.readfile(fname) or {})
  return cache[fname][lnum + 1] or ""
end

-- Syntax tree of a file: its buffer's parser when loaded, else the text read by line_of (parsed once)
---@return {root: TSNode, src: integer|string}?
local function tree(cache, fname, lang)
  cache.trees = cache.trees or {}
  if cache.trees[fname] == nil then
    local b = vim.fn.bufnr(fname)
    local ok, parser, src
    if b ~= -1 and vim.api.nvim_buf_is_loaded(b) then
      src = b
      ok, parser = pcall(vim.treesitter.get_parser, b, lang)
    else
      src = table.concat(cache[fname] or {}, "\n")
      ok, parser = pcall(vim.treesitter.get_string_parser, src, lang)
    end
    local t = ok and parser and parser:parse()[1]
    cache.trees[fname] = t and { root = t:root(), src = src } or false
  end
  return cache.trees[fname] or nil
end

-- Syntax colors of line `lnum` as label ranges ({ start, end, hl }, bytes after the `lead` indent)
local function syntax(cache, fname, lnum, line, lead)
  local ft = vim.filetype.match({ filename = fname })
  local lang = ft and vim.treesitter.language.get_lang(ft)
  local ok, query = pcall(vim.treesitter.query.get, lang or "", "highlights")
  local t = lang and ok and query and tree(cache, fname, lang)
  if not t then return {} end
  local ret = {}
  for id, node in query:iter_captures(t.root, t.src, lnum, lnum + 1) do
    local name = query.captures[id]
    local sr, sc, er, ec = node:range()
    if not name:match("^_") and name ~= "spell" and name ~= "nospell" and sr <= lnum and er >= lnum then
      local s = math.max((sr < lnum and 0 or sc) - lead, 0)
      local e = math.min(er > lnum and #line or ec, #line) - lead
      if e > s then ret[#ret + 1] = { s, e, "@" .. name .. "." .. lang } end
    end
  end
  return ret
end

---@param loc UsageLoc
local function byte(line, loc, pos)
  return vim.str_byteindex(line, loc.enc, pos.character, false)
end

-- Jump like WebStorm: caret on the name, centered when it was off screen
---@param loc UsageLoc
function M.jump(loc)
  local fname = vim.uri_to_fname(loc.uri)
  local lnum = loc.range.start.line + 1
  local visible = vim.api.nvim_buf_get_name(0) == fname and lnum >= vim.fn.line("w0") and lnum <= vim.fn.line("w$")
  vim.cmd("normal! m'")
  vim.lsp.util.show_document({ uri = loc.uri, range = loc.range }, loc.enc, { focus = true })
  if not visible then vim.cmd("normal! zz") end
end

-- File column names: the file name, plus the shortest parent path that tells apart files with the
-- same name in different folders ("Password/index.tsx", deeper if still ambiguous), like the tab bar
---@param fnames string[]
---@return table<string, string>
local function short_names(fnames)
  local parts, by_tail = {}, {}
  for _, f in ipairs(fnames) do
    if not parts[f] then
      parts[f] = vim.split(f, "/", { plain = true, trimempty = true })
      local t = parts[f][#parts[f]] or f
      by_tail[t] = by_tail[t] or {}
      table.insert(by_tail[t], f)
    end
  end
  local function suffix(f, n) return table.concat(parts[f], "/", math.max(#parts[f] - n + 1, 1)) end
  local res = {}
  for _, group in pairs(by_tail) do
    for _, f in ipairs(group) do
      local n = 1
      while n < #parts[f] do
        local s, clash = suffix(f, n), false
        for _, o in ipairs(group) do
          if o ~= f and suffix(o, n) == s then clash = true break end
        end
        if not clash then break end
        n = n + 1
      end
      res[f] = suffix(f, n)
    end
  end
  return res
end

-- Popup row: the trimmed code line (syntax colored, the usage bold), "file.tsx 42" (the app adds the file icon)
---@param loc UsageLoc
---@param cache table<string, string[]>
---@param names table<string, string> file column names (short_names)
---@return {text: string, key: string, hl: table[], focus?: integer}
local function row(loc, cache, names)
  local fname = vim.uri_to_fname(loc.uri)
  local line = line_of(cache, fname, loc.range.start.line):gsub("\t", " ")
  local lead = #line:match("^%s*")
  local text = vim.trim(line)
  local s = byte(line, loc, loc.range.start) - lead
  local e = loc.range["end"].line == loc.range.start.line and byte(line, loc, loc.range["end"]) - lead or #text
  local hl = syntax(cache, fname, loc.range.start.line, line, lead)
  if e > s and s >= 0 then hl[#hl + 1] = { s, math.min(e, #text), "WsUsageMatch" } end -- last: on top
  return {
    text = text ~= "" and text or vim.fn.fnamemodify(fname, ":t"),
    key = ("%s %d"):format(names[fname] or vim.fn.fnamemodify(fname, ":t"), loc.range.start.line + 1),
    hl = hl,
    focus = s >= 0 and s or nil,
  }
end

-- Colors of highlight groups for the app (resolved links: { fg, bold, italic }), cached per popup
local function hl_color(cache, group)
  cache.hl = cache.hl or {}
  if cache.hl[group] == nil then
    local ok, h = pcall(vim.api.nvim_get_hl, 0, { name = group, link = false })
    cache.hl[group] = ok and h.fg and { h.fg, h.bold == true, h.italic == true } or false
  end
  return cache.hl[group] or nil
end

-- The app's popup: rows as data, Rust draws them; a pick comes back to M.pick(token, i)
local shown = { token = 0, locs = {} } ---@type {token: integer, locs: UsageLoc[]}

-- The popup at the caret; one location jumps straight there
---@param locs UsageLoc[]
---@param header {left: string[][], right?: string[][]}
local function show(locs, header)
  if #locs == 1 then return M.jump(locs[1]) end
  local cache = {}
  local names = short_names(vim.tbl_map(function(l) return vim.uri_to_fname(l.uri) end, locs))
  local items = {}
  -- the usage the caret is on: WS tags it "Current"
  local uri, cur, cur_line = vim.uri_from_bufnr(0), vim.api.nvim_win_get_cursor(0), vim.api.nvim_get_current_line()
  local function is_current(l)
    local r = l.range
    if l.uri ~= uri or r.start.line ~= cur[1] - 1 then return false end
    local e = r["end"].line == r.start.line and byte(cur_line, l, r["end"]) or #cur_line
    return cur[2] >= byte(cur_line, l, r.start) and cur[2] <= e
  end
  for _, l in ipairs(locs) do
    local r = row(l, cache, names)
    local spans = {}
    for _, h in ipairs(r.hl or {}) do
      local c = h[3] == "WsUsageMatch" and "match" or hl_color(cache, h[3])
      if c == "match" then
        spans[#spans + 1] = { h[1], h[2], 0, true, false, true }
      elseif c then
        spans[#spans + 1] = { h[1], h[2], c[1], c[2], c[3], false }
      end
    end
    items[#items + 1] = {
      text = r.text, key = r.key, file = vim.uri_to_fname(l.uri), spans = spans, focus = r.focus, current = is_current(l),
    }
  end
  shown = { token = shown.token + 1, locs = locs }
  local function text(chunks)
    return table.concat(vim.tbl_map(function(c) return c[1] end, chunks or {}))
  end
  require("config.app.bridge").notify("pickers", {
    event = "usages", token = shown.token, title = text(header.left), right = text(header.right), items = items,
  })
end

-- The app's pick in its usages popup (config/app/pickers.lua)
---@param token integer
---@param i integer 1-based
function M.pick(token, i)
  if token ~= shown.token or not shown.locs[i] then return end
  M.jump(shown.locs[i])
end

local function plural(n, word)
  return ("%d %s%s"):format(n, word, n == 1 and "" or "s")
end

-- WebStorm's information hint at the caret (HintManager.showInformationHint: no balloon); it closes when the
-- caret moves, on typing or scrolling
---@param text string
local function info_hint(text)
  if not vim.g.vimstorm_app then return vim.notify(text, vim.log.levels.INFO) end
  local floats = require("config.app.floats")
  floats.show_hover("hover", { { kind = "hint", text = text } }, floats.caret(), vim.api.nvim_get_current_buf())
end

-- Show Usages (Cmd+Alt+F7 in WebStorm; here grr / Find Usages): usages of the name at the caret
function M.usages()
  if not supports("textDocument/references") then return vim.notify("No usages: no language server here", vim.log.levels.WARN) end
  local name = vim.fn.expand("<cword>")
  M.request("textDocument/references", { context = { includeDeclaration = false } }, function(locs)
    -- ShowUsagesAction: cancelAndShowHint -> an information hint at the caret
    if #locs == 0 then return info_hint("No usages found in Project Files") end
    show(locs, {
      left = { { "Usages of ", "WsMenuTitle" }, { name, "WsMenuTitle" } },
      right = { { plural(#locs, "usage") .. " in Project Files", "WsMenuKey" } },
    })
  end)
end

-- Is the caret on one of these (its own declaration)?
---@param locs UsageLoc[]
local function on_declaration(locs)
  local uri = vim.uri_from_bufnr(0)
  local cur = vim.api.nvim_win_get_cursor(0)
  local line = vim.api.nvim_get_current_line()
  for _, l in ipairs(locs) do
    local r = l.range
    if l.uri == uri and r.start.line <= cur[1] - 1 and r["end"].line >= cur[1] - 1 then
      local s = r.start.line == cur[1] - 1 and byte(line, l, r.start) or 0
      local e = r["end"].line == cur[1] - 1 and byte(line, l, r["end"]) or #line
      if cur[2] >= s and cur[2] <= e then return true end
    end
  end
  return false
end

-- Is the caret on a name a destructuring pattern declares (`const { profile } = useProfile()`, `[a, b]`,
-- `{ data: rows }`)? The server's definition of it is the property of the type it comes from (or nothing
-- when that's untyped), but WebStorm treats it as the declaration: Show Usages.
local function on_destructured_name()
  local ok, node = pcall(vim.treesitter.get_node)
  if not ok or not node then return false end
  local t, parent = node:type(), node:parent()
  if t == "shorthand_property_identifier_pattern" then return true end
  if t ~= "identifier" or not parent then return false end
  local pt = parent:type()
  if pt == "array_pattern" or pt == "rest_pattern" then return true end
  if pt == "pair_pattern" then
    local value = parent:field("value")[1]
    return value ~= nil and value:id() == node:id()
  end
  if pt == "object_assignment_pattern" or pt == "assignment_pattern" then
    local left = parent:field("left")[1]
    return left ~= nil and left:id() == node:id()
  end
  return false
end

-- Go to Implementations / Type Declaration (gri / gy; the app's native popup for snacks' LSP pickers): the
-- "Choose ..." popup, one result jumps straight there
---@param method string
---@param title string
---@param word string
function M.choose(method, title, word)
  if not supports(method) then return vim.notify("No " .. word .. "s: no language server here", vim.log.levels.WARN) end
  M.request(method, nil, function(locs)
    if #locs == 0 then return vim.notify("No " .. word .. "s found", vim.log.levels.INFO) end
    show(locs, { left = { { title, "WsMenuTitle" } }, right = { { plural(#locs, word), "WsMenuKey" } } })
  end)
end

-- Locations of another source (a Layer's workflow / skill file, config/workflow.lua) in the same popup
---@param locs UsageLoc[]
---@param header table
function M.show_locations(locs, header) show(locs, header) end

-- Cmd+B / gd
function M.declaration_or_usages()
  if supports("textDocument/references") and on_destructured_name() then return M.usages() end
  if not supports("textDocument/definition") then -- no LSP: Vim's local gd (a message when nothing's found, no traceback)
    local ok, err = pcall(vim.cmd, "normal! gd")
    if not ok then vim.notify(tostring(err):match("E%d+:.*") or tostring(err), vim.log.levels.WARN) end
    return
  end
  M.request("textDocument/definition", nil, function(locs)
    if #locs == 0 then return vim.notify("Cannot find declaration to go to", vim.log.levels.INFO) end
    if on_declaration(locs) then return M.usages() end
    show(locs, { left = { { "Choose Declaration", "WsMenuTitle" } }, right = { { plural(#locs, "declaration"), "WsMenuKey" } } })
  end)
end

return M
