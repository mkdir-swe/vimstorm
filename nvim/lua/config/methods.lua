-- MethodUp / MethodDown, like WebStorm:
-- ,s inside a function/object/class/variable jumps to its name; on the name, to the previous one.
-- ,S jumps to the next name. Prev/next skip things nested inside other declarations.
-- JS/TS via treesitter name captures; other languages fall back to function starts.
local M = {}

-- Each pattern is tried separately so node types missing in a language are skipped
local patterns = {
  "(function_declaration name: (identifier) @name)",
  "(generator_function_declaration name: (identifier) @name)",
  "(method_definition name: (_) @name)",
  "(method_signature name: (_) @name)",
  "(abstract_method_signature name: (_) @name)",
  "(variable_declarator name: (identifier) @name)",
  "(public_field_definition name: (_) @name)",
  "(field_definition property: (_) @name)",
  "(pair key: (_) @name)",
  "(class_declaration name: (_) @name)",
  "(abstract_class_declaration name: (_) @name)",
  "(interface_declaration name: (_) @name)",
  "(type_alias_declaration name: (_) @name)",
  "(enum_declaration name: (_) @name)",
  "(property_signature name: (_) @name)",
  "(function_declaration name: (_) @name)", -- lua
}

local queries = {} ---@type table<string, vim.treesitter.Query|false>

local function get_query(lang)
  if queries[lang] == nil then
    local valid = {}
    for _, p in ipairs(patterns) do
      if pcall(vim.treesitter.query.parse, lang, p) then table.insert(valid, p) end
    end
    queries[lang] = #valid > 0 and vim.treesitter.query.parse(lang, table.concat(valid, "\n")) or false
  end
  return queries[lang]
end

---@class FnName
---@field pos {[1]: integer, [2]: integer} 0-based {row, col} of the name
---@field range {[1]: integer, [2]: integer, [3]: integer, [4]: integer} whole declaration
---@field parent? FnName nearest declaration around this one

local function before(a, row, col) return a[1] < row or (a[1] == row and a[2] < col) end
local function after(a, row, col) return a[1] > row or (a[1] == row and a[2] > col) end
local function contains(r, row, col)
  return (r[1] < row or (r[1] == row and r[2] <= col)) and (r[3] > row or (r[3] == row and r[4] >= col))
end

local cache = {} ---@type table<integer, {tick: integer, fns: FnName[]}>
vim.api.nvim_create_autocmd({ "BufWipeout", "BufDelete" }, {
  group = vim.api.nvim_create_augroup("ws_methods", { clear = true }),
  callback = function(args) cache[args.buf] = nil end,
})

---@return FnName[]|nil sorted by name position (cached until the buffer changes)
local function names(buf)
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  if cache[buf] and cache[buf].tick == tick then return cache[buf].fns end
  local ok, parser = pcall(vim.treesitter.get_parser, buf, nil, { error = false })
  if not ok or not parser then return end
  local query = get_query(parser:lang())
  if not query then return end
  local root = parser:parse()[1]:root()
  local seen, ret = {}, {} ---@type table<string, true>, FnName[]
  for _, node in query:iter_captures(root, buf) do
    local r, c = node:start()
    local key = r .. ":" .. c
    if not seen[key] then
      seen[key] = true
      local decl = node:parent() or node
      table.insert(ret, { pos = { r, c }, range = { decl:range() } })
    end
  end
  table.sort(ret, function(a, b) return a.pos[1] < b.pos[1] or (a.pos[1] == b.pos[1] and a.pos[2] < b.pos[2]) end)
  -- nearest enclosing declaration of each: one sweep with a stack of the open ones (big data files have
  -- thousands of names, so no scan of all of them per name)
  local open = {} ---@type FnName[]
  for _, f in ipairs(ret) do
    while #open > 0 and not contains(open[#open].range, f.pos[1], f.pos[2]) do open[#open] = nil end
    f.parent = open[#open]
    open[#open + 1] = f
  end
  cache[buf] = { tick = tick, fns = ret }
  return ret
end

local function fallback(dir)
  local move = require("nvim-treesitter-textobjects.move")
  if dir < 0 then
    move.goto_previous_start("@function.outer", "textobjects")
  else
    move.goto_next_start("@function.outer", "textobjects")
  end
end

-- Inside another declaration that doesn't contain the cursor (e.g. a local in some other function)?
-- Enclosing declarations nest, so the nearest one decides.
local function hidden(f, row, col)
  return f.parent ~= nil and not contains(f.parent.range, row, col)
end

---@param dir -1|1
function M.jump(dir)
  local fns = names(vim.api.nvim_get_current_buf())
  if not fns then return fallback(dir) end
  local cur = vim.api.nvim_win_get_cursor(0)
  local row, col = cur[1] - 1, cur[2]
  local target
  if dir < 0 then
    -- innermost function around the cursor whose name is before the cursor
    for i = #fns, 1, -1 do
      local f = fns[i]
      if contains(f.range, row, col) and before(f.pos, row, col) then target = f.pos break end
    end
    -- not inside one (or already on its name): previous function name
    if not target then
      for i = #fns, 1, -1 do
        local f = fns[i]
        if before(f.pos, row, col) and not hidden(f, row, col) then target = f.pos break end
      end
    end
  else
    for _, f in ipairs(fns) do
      if after(f.pos, row, col) and not hidden(f, row, col) then target = f.pos break end
    end
  end
  if not target then return end
  vim.cmd("normal! m'") -- keep jumplist, like WebStorm's back navigation
  vim.api.nvim_win_set_cursor(0, { target[1] + 1, target[2] })
end

return M
