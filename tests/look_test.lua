-- Look like WebStorm (Darcula Contrast): the editor palette nvim draws into the grid the app renders. Everything
-- drawn natively (syntax colors on screen, chrome, icons, status bar, selected rows) is a cargo test
-- (screen.rs, tabs.rs, statusbar.rs ...); here the highlight groups and options.
local H = dofile(os.getenv("NVT_HARNESS"))

-- Wrong entries of { name = { got, want } }
local function diff(t)
  local bad = {}
  for name, v in pairs(t) do
    if v[1] ~= v[2] then bad[#bad + 1] = ("%s: %s (want %s)"):format(name, tostring(v[1]), tostring(v[2])) end
  end
  table.sort(bad)
  return bad
end

H.run(function()
  local dir = H.project("look", { ["sample.ts"] = { "export const LIMIT = 10;", "export const other = LIMIT + 1;" } })
  H.start(dir, { "sample.ts" })

  -- Colors only seen in passing (search, matching bracket, word under caret, warning): the palette
  local bad = diff(H.lua([[local function hex(name, k)
      local v = vim.api.nvim_get_hl(0, { name = name, link = false })[k]
      return v and ('#%06x'):format(v) or 'none'
    end
    return {
      ['search match'] = { hex('Search', 'bg'), '#32593d' }, ['current search match'] = { hex('CurSearch', 'bg'), '#214283' },
      ['matching bracket'] = { hex('MatchParen', 'bg'), '#326146' },
      ['word under caret (read)'] = { hex('LspReferenceText', 'bg'), '#344134' },
      ['word under caret (write)'] = { hex('LspReferenceWrite', 'bg'), '#40332b' },
      ['warning'] = { hex('DiagnosticUnderlineWarn', 'bg'), '#3d3322' },
    }]]) or { lua = { "failed", "table" } })
  H.check("palette: search, matching bracket, word under caret, warning backgrounds", #bad == 0, table.concat(bad, ", "))

  -- selecting: nothing under the status bar (no showcmd), the selection color
  H.keys("1G14|vll")
  H.check("nothing under the status bar while selecting (no showcmd)", H.lua("return vim.o.showcmd") == false and H.mode() == "v",
    { H.lua("return vim.o.showcmd"), H.mode() })
  local visual = H.lua("return vim.api.nvim_get_hl(0, { name = 'Visual', link = false }).bg")
  H.check("selection drawn in the selection color", visual == 0x214283, visual and ("#%06x"):format(visual))
  H.keys("<Esc>")

  -- unused code (TS 6133 / 7027: Hint + Unnecessary tag): gray text only, no underline (WS
  -- NOT_USED_ELEMENT_ATTRIBUTES has no effect)
  local looks = H.lua([[local ns = vim.api.nvim_create_namespace('look_unused')
    vim.diagnostic.set(ns, 0, { { lnum = 0, col = 13, end_col = 18, severity = vim.diagnostic.severity.HINT,
      message = "'LIMIT' is declared but its value is never read.", _tags = { unnecessary = true } } })
    local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_extmarks(0, -1, { 0, 13 }, { 0, 13 }, { details = true, overlap = true })) do
      local g = m[4].hl_group
      if g then
        local h = vim.api.nvim_get_hl(0, { name = g, link = false })
        out[#out + 1] = { g, h.fg and ('#%06x'):format(h.fg) or '', (h.underline or h.underdotted or h.undercurl
          or h.underdashed or h.underdouble) and 'line' or '' }
      end
    end
    vim.diagnostic.reset(ns, 0)
    return out]])
  local gray, line = false, {}
  for _, l in ipairs(looks or {}) do
    if l[1] == "DiagnosticUnnecessary" and l[2] == "#72737a" then gray = true end
    if l[3] ~= "" then line[#line + 1] = l[1] end
  end
  H.check("unused code: gray, no underline", gray and #line == 0, vim.inspect(looks))

  -- a look (#108 S4, config/app/look.lua): Islands Dark's tokens leave every group as it is, Islands
  -- Light's turn the editor light, Islands Dark again puts every group back
  local repo = vim.fn.fnamemodify(os.getenv("NVT_HARNESS"), ":p:h:h")
  -- as app/src/look/mod.rs `tell_nvim` sends it: the editor scheme's background and mapping (#345)
  local function look(name)
    local f = vim.json.decode(table.concat(vim.fn.readfile(repo .. "/abe/packages/ui/contract/frames/" .. name), "\n"))
    local editor = f.effect.look.scheme or f.effect.look.theme
    return { dark = editor.dark, syntax = editor.syntax, tokens = f.effect.look.tokens }
  end
  -- each group's colours and attributes (gitsigns defines its own again without `default`)
  local groups = [[local out = {}
    for name, h in pairs(vim.api.nvim_get_hl(0, {})) do
      h.default = nil
      out[name] = vim.inspect(h)
    end
    return { groups = out, background = vim.o.background }]]
  local before = H.lua(groups)
  local function changed(now)
    local bad = {}
    for name, h in pairs(before.groups) do
      if now.groups[name] ~= h then bad[#bad + 1] = name end
    end
    table.sort(bad)
    return bad
  end
  local dark, light = look("bridge-shell-look-dark.json"), look("bridge-shell-look.json")
  H.call("config.app.look", "apply", dark)
  local same
  H.expect("Islands Dark's look changes no highlight group", function()
    same = changed(H.lua(groups))
    return #same == 0
  end, function() return table.concat(same, ", ") end)
  H.call("config.app.look", "apply", light)
  local function hl(name, k)
    return H.lua(("local v = vim.api.nvim_get_hl(0, { name = %q, link = false })[%q] return v and ('#%%06x'):format(v)"):format(name, k))
  end
  H.expect("Islands Light: the editor's ground", function() return hl("Normal", "bg") == light.tokens["editor-bg"] end)
  local got = {
    text = { hl("Normal", "fg"), light.tokens["editor-fg"] },
    keyword = { hl("@keyword", "fg"), light.tokens["syntax-keyword"] },
    string = { hl("@string", "fg"), light.tokens["syntax-string"] },
    ["caret row"] = { hl("CursorLine", "bg"), light.tokens["syntax-bg-alt"] },
    selection = { hl("Visual", "bg"), light.tokens["syntax-selection"] },
    ["ts icon"] = { hl("WsIconBlue", "fg"), light.tokens["icon-blue"] },
    background = { H.lua("return vim.o.background"), "light" },
  }
  bad = diff(got)
  H.check("Islands Light: syntax, selection, icons and 'background' follow its tokens", #bad == 0, table.concat(bad, ", "))
  -- #345: Islands Dark as the editor scheme under Islands Light: the editor stays Darcula's, dark
  local mixed = look("bridge-shell-look-light-scheme-dark.json")
  H.call("config.app.look", "apply", mixed)
  H.expect("a named scheme under a light theme: the editor's ground dark", function()
    return hl("Normal", "bg") == dark.tokens["editor-bg"]
  end)
  got = {
    keyword = { hl("@keyword", "fg"), dark.tokens["syntax-keyword"] },
    string = { hl("@string", "fg"), dark.tokens["syntax-string"] },
    selection = { hl("Visual", "bg"), dark.tokens["syntax-selection"] },
    background = { H.lua("return vim.o.background"), "dark" },
  }
  bad = diff(got)
  H.check("a named scheme: syntax and 'background' are the scheme's, not the theme's", #bad == 0, table.concat(bad, ", "))
  -- Dark Modern (#129): VS Code's capture mapping, not Darcula's: function calls and methods in the function
  -- colour, primitive and other type names in the type colour; Islands Dark's keeps calls plain, primitives keywords
  local modern = look("bridge-shell-look-dark-modern.json")
  H.check("Dark Modern's look names VS Code's mapping", modern.syntax == "vscode" and dark.syntax == "darcula")
  H.call("config.app.look", "apply", modern)
  local fn, ty = modern.tokens["syntax-func"], modern.tokens["syntax-type-param"]
  H.expect("Dark Modern: the editor's ground", function() return hl("Normal", "bg") == modern.tokens["editor-bg"] end)
  got = {
    ["function call"] = { hl("@function.call", "fg"), fn },
    ["method call"] = { hl("@function.method.call", "fg"), fn },
    ["lsp function"] = { hl("@lsp.type.function", "fg"), fn },
    ["static method"] = { tostring(H.lua("return vim.api.nvim_get_hl(0, { name = '@function.method.static' }).italic")), "nil" },
    ["primitive type"] = { hl("@type.builtin", "fg"), ty },
    ["type name"] = { hl("@type", "fg"), ty },
    ["lsp interface"] = { hl("@lsp.type.interface", "fg"), ty },
    keyword = { hl("@keyword", "fg"), modern.tokens["syntax-keyword"] },
  }
  bad = diff(got)
  H.check("Dark Modern: functions and types follow VS Code's mapping", #bad == 0, table.concat(bad, ", "))
  H.call("config.app.look", "apply", dark)
  H.expect("Islands Dark: calls plain, primitives keywords again", function()
    return hl("@function.call", "fg") == dark.tokens["editor-fg"] and hl("@type.builtin", "fg") == dark.tokens["syntax-keyword"]
  end)
  local moved, back
  H.expect("Islands Dark again: every group back", function()
    back = H.lua(groups)
    moved = changed(back)
    return #moved == 0 and back.background == "dark"
  end, function() return table.concat(moved, ", ") end)

  -- the minimap (#122, config/app/minimap.lua): a window's lines as the app draws them, one byte a column
  -- coloured as treesitter colours the text (Normal elsewhere), tabs to their tabstop, a multibyte char one
  -- column; a scroll keeps the cursor in view; a look's colours once it's in force
  H.lua([[vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'export const LIMIT = 10;', '', '\tconst å = "x";' })
    vim.bo.tabstop = 4 vim.treesitter.start()]])
  H.call("config.app.minimap", "enable", true)
  H.lua("require('config.app.minimap').want(vim.api.nvim_get_current_win(), 0, 3)")
  local function report()
    return H.lua("return require('config.app.minimap').report(vim.api.nvim_get_current_win())")
  end
  local r = report()
  local function col_color(p, line, col)
    local b = p.lines[line]:byte(col)
    return b ~= 32 and p.palette[b - 33 + 1] or nil
  end
  local keyword = H.lua("return vim.api.nvim_get_hl(0, { name = '@keyword.typescript', link = false }).fg")
    or H.lua("return vim.api.nvim_get_hl(0, { name = '@keyword', link = false }).fg")
  local normal = H.lua("return vim.api.nvim_get_hl(0, { name = 'Normal', link = false }).fg")
  local strfg = H.lua("return vim.api.nvim_get_hl(0, { name = '@string', link = false }).fg")
  H.check("minimap: a line a payload line, from the top", r and r.from == 0 and r.total == 3 and #r.lines == 3, r)
  H.check("minimap: `export` in the keyword's colour, not Normal's", r and col_color(r, 1, 1) == keyword and keyword ~= normal,
    r and { col_color(r, 1, 1), keyword, normal })
  H.check("minimap: blanks are spaces, a blank line empty", r and r.lines[1]:sub(7, 7) == " " and r.lines[2] == "", r)
  -- `\tconst å = "x";`: the tab is 4 columns, å one, the string's quote at column 15
  H.check("minimap: tabs to the tabstop, a multibyte char one column",
    r and #r.lines[3] == 18 and r.lines[3]:sub(1, 4) == "    " and col_color(r, 3, 16) == strfg, r and r.lines[3])
  H.expect("minimap: sent to the app as asked", function()
    local got = H.bridge("minimap")
    local last = got[#got]
    return last and last.event == "lines" and last.from == 0 and #last.lines == 3
  end)
  H.call("config.app.look", "apply", light)
  H.expect("minimap: a look's colours once in force", function()
    local now = report()
    return now and col_color(now, 1, 1) == H.lua("return vim.api.nvim_get_hl(0, { name = '@keyword', link = false }).fg")
      and col_color(now, 1, 1) ~= keyword
  end)
  H.call("config.app.look", "apply", dark)
  -- scrolling a long file from the minimap: the top line moves, the cursor stays in view
  H.lua("vim.api.nvim_buf_set_lines(0, 0, -1, false, vim.fn.map(vim.fn.range(1, 500), '\"line \" .. v:val'))")
  H.keys("gg")
  H.call("config.app.minimap", "scroll", H.lua("return vim.api.nvim_get_current_win()"), 200)
  H.expect("minimap scroll: line 201 on top, the cursor moved into view", function()
    local top, cur = H.lua("return vim.fn.line('w0')"), H.cursor()[1]
    return top == 201 and cur >= 201
  end, function() return { H.lua("return vim.fn.line('w0')"), H.cursor() } end)
  H.call("config.app.minimap", "enable", false)
  H.check("minimap: off", H.lua("return require('config.app.minimap').state().on") == false)
end)
