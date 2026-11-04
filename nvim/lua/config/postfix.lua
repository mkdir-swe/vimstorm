-- WebStorm's `.log` postfix template and `log` live template in JS / TS:
--   `user.name.log` + Tab  ->  console.log(user.name)|
--   `log` + Tab            ->  console.log(|)
-- The expression is the one ending at `.log`: member chains, calls, indexes, strings, `?.` and `!`
-- (`foo.bar(x)[0]?.baz.log`). Tab runs this first (plugins/lsp.lua blink keymap), before Copilot / the
-- completion / snippet / indent. Also offered in the completion list (blink source "log").
local M = {}

local FT = {
  javascript = true, javascriptreact = true, typescript = true, typescriptreact = true,
  ["javascript.jsx"] = true, ["typescript.tsx"] = true, vue = true, svelte = true,
}

local OPEN = { [")"] = "(", ["]"] = "[", ["}"] = "{" }

-- Start (1-based byte) of the expression that ends at byte `e` of `s`, nil when there is none
---@param s string
---@param e integer
---@return integer?
function M.expr_start(s, e)
  local i = e
  local function unit() -- one identifier / bracket group / string ending at i; returns its kind
    local c = s:sub(i, i)
    if OPEN[c] then
      local depth, quote = 0, nil
      while i >= 1 do
        local ch = s:sub(i, i)
        if quote then
          if ch == quote and s:sub(i - 1, i - 1) ~= "\\" then quote = nil end
        elseif ch == "'" or ch == '"' or ch == "`" then
          quote = ch
        elseif OPEN[ch] then
          depth = depth + 1
        elseif ch == "(" or ch == "[" or ch == "{" then
          depth = depth - 1
          if depth == 0 then
            i = i - 1
            return "group"
          end
        end
        i = i - 1
      end
      return nil -- unbalanced
    elseif c == "'" or c == '"' or c == "`" then
      i = i - 1
      while i >= 1 and not (s:sub(i, i) == c and s:sub(i - 1, i - 1) ~= "\\") do i = i - 1 end
      if i < 1 then return nil end
      i = i - 1
      return "string"
    elseif c:match("[%w_$]") then
      while i >= 1 and s:sub(i, i):match("[%w_$]") do i = i - 1 end
      return "ident"
    end
  end
  local kind = unit()
  if not kind then return end
  while i >= 1 do
    local c = s:sub(i, i)
    if c == "." and s:sub(i - 1, i - 1) ~= "." then -- member access (not a spread `...x`)
      i = i - 1
      if s:sub(i, i) == "?" then i = i - 1 end -- ?.
      if s:sub(i, i) == "!" then i = i - 1 end -- non-null `a!.b`
      kind = unit()
      if not kind then return end
    elseif kind == "group" and (c:match("[%w_$%)%]]") or (c == "." and s:sub(i - 1, i - 1) == "?")) then
      if c == "." then i = i - 2 end -- optional call `f?.()`
      kind = unit() -- call / index: `foo(x)`, `a[0]`, `f()()`
      if not kind then return end
    else
      break
    end
  end
  -- keywords in front aren't part of it (`return x.log`, `await x.log` stop at the space anyway)
  return i + 1
end

---@class PostfixEdit
---@field row integer 0-based
---@field from integer 0-based byte where the replaced text starts
---@field to integer 0-based byte where it ends (the caret)
---@field text string new text
---@field caret integer byte offset of the caret inside `text`
---@field label string

-- The expansion for the text before the caret, nil when it doesn't end in `<expr>.log` / `log`
---@return PostfixEdit?
function M.at_cursor()
  if not FT[vim.bo.filetype] then return end
  local row, col = unpack(vim.api.nvim_win_get_cursor(0))
  local line = vim.api.nvim_get_current_line()
  local before = line:sub(1, col)
  if line:sub(col + 1, col + 1):match("[%w_$]") then return end -- in the middle of a word
  if before:sub(-4) == ".log" then
    local e = #before - 4
    local s = M.expr_start(before, e)
    if not s or s > e then return end
    local expr = before:sub(s, e)
    if expr:match("^%((.*)%)$") and M.expr_start(expr, #expr) == 1 then expr = expr:sub(2, -2) end -- (a + b).log
    local text = "console.log(" .. expr .. ")"
    return { row = row - 1, from = s - 1, to = col, text = text, caret = #text, label = text }
  end
  if before:match("log$") and not before:sub(1, -4):match("[%w_$%.]$") then
    return { row = row - 1, from = col - 3, to = col, text = "console.log()", caret = #"console.log(", label = "console.log()" }
  end
end

-- Expand at the caret (insert mode), true when there was something to expand
function M.expand()
  local edit = M.at_cursor()
  if not edit then return false end
  local ok, cmp = pcall(require, "blink.cmp")
  if ok and cmp.is_visible() then cmp.hide() end
  local sok, sug = pcall(require, "copilot.suggestion")
  if sok and sug.is_visible() then sug.dismiss() end
  vim.api.nvim_buf_set_text(0, edit.row, edit.from, edit.row, edit.to, { edit.text })
  vim.api.nvim_win_set_cursor(0, { edit.row + 1, edit.from + edit.caret })
  return true
end

-- Tab (first in blink's Tab chain, an expr mapping: no text changes there): the keys that expand, or false
---@return string|false
function M.tab()
  if not (vim.api.nvim_get_mode().mode:match("^i") and M.at_cursor()) then return false end
  return vim.keycode("<Cmd>lua require('config.postfix').expand()<CR>")
end

-- blink.cmp source --------------------------------------------------------------------------------

function M.new() return setmetatable({}, { __index = M }) end

function M:enabled() return FT[vim.bo.filetype] == true end

function M:get_trigger_characters() return { "." } end

function M:get_completions(ctx, callback)
  local items = {}
  local line = ctx.line
  local col = ctx.cursor[2]
  local before = line:sub(1, col)
  local typed = before:match("([%a]*)$") or ""
  -- after `l` / `lo` / `log` (not right after a dot: the members come first there)
  if typed ~= "" and ("log"):sub(1, #typed) == typed then
    local dot = #before - #typed -- byte of the "." in `expr.lo`
    local s = before:sub(dot, dot) == "." and M.expr_start(before, dot - 1)
    local kind = require("blink.cmp.types").CompletionItemKind.Snippet
    if s and s <= dot - 1 then
      local expr = before:sub(s, dot - 1)
      local text = "console.log(" .. expr .. ")"
      items[#items + 1] = {
        label = "log", filterText = "log", kind = kind, score_offset = typed == "log" and 100 or -5,
        labelDetails = { description = text },
        textEdit = {
          newText = text,
          range = { start = { line = ctx.cursor[1] - 1, character = s - 1 }, ["end"] = { line = ctx.cursor[1] - 1, character = col } },
        },
        insertTextFormat = vim.lsp.protocol.InsertTextFormat.PlainText,
      }
    elseif typed ~= "" and not before:sub(1, dot):match("[%w_$%.]$") then
      items[#items + 1] = {
        label = "log", filterText = "log", kind = kind,
        labelDetails = { description = "console.log()" },
        insertText = "console.log($0)",
        insertTextFormat = vim.lsp.protocol.InsertTextFormat.Snippet,
      }
    end
  end
  callback({ items = items, is_incomplete_forward = true, is_incomplete_backward = true })
end

-- Register the blink source (blink loads at VeryLazy)
function M.setup()
  local function add()
    local ok, cmp = pcall(require, "blink.cmp")
    if not ok then return false end
    local config = require("blink.cmp.config")
    if config.sources.providers.postfix then return true end
    cmp.add_source_provider("postfix", { name = "Postfix", module = "config.postfix", score_offset = 0 })
    for ft in pairs(FT) do cmp.add_filetype_source(ft, "postfix") end
    return true
  end
  if package.loaded["blink.cmp"] and add() then return end
  vim.api.nvim_create_autocmd("User", {
    pattern = "LazyLoad",
    callback = function(ev)
      if ev.data == "blink.cmp" then
        add()
        return true
      end
    end,
  })
end

return M
