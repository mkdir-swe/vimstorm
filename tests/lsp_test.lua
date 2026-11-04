-- Language server engine like WebStorm (vtsls), headless: context actions (Alt+Enter) without disabled ones;
-- parameter-name inlay hints only (not for callees typed as functions); Quick Definition (Cmd+L) state: open /
-- close, typing back after Esc, its caret moved by keys / wheel and Enter / F4 jumping there; Cmd+B / gd:
-- declaration or the usages popup's data (Choose Declaration, shortest telling paths, destructured names);
-- "Finding usages…" while a usages search is slow; files closed while the server starts.
-- The popups / tooltips / completion as drawn: app/tests/floats.rs, pickers.rs, screen.rs.
local H = dofile(os.getenv("NVT_HARNESS"))
local K = H.KEY

local FILES = {
  ["tsconfig.json"] = '{ "compilerOptions": { "jsx": "react-jsx", "strict": true }, "include": ["**/*.ts", "**/*.tsx"] }',
  ["err.ts"] = {
    "export function period(start: Date) {",
    "  const range = {", -- 2
    "    from: quux(start, 'YYYY'),", -- 3: TS2304 Cannot find name 'quux'
    "  };",
    "  return range;",
    "}",
  },
  ["a.ts"] = { "export const a = 1;", "", "export function add(x: number, y: number) {", "  return x + y;", "}" },
  ["hints.ts"] = {
    'import { add } from "./a";',
    "",
    "export const n = add(1, 2)", -- 3
    "",
    'const containers = [{ id: "a", containerName: "c" as string | undefined, size: 1 }];',
    'export const remainingContainers = containers.filter((container) => container.id !== "b");', -- 6
  },
  -- zod 3 as installed: `z` a module namespace re-exported by name, its functions `static create: (…) => …` typed consts
  ["node_modules/zod/package.json"] = '{ "name": "zod", "types": "./index.d.ts" }',
  ["node_modules/zod/index.d.ts"] = { 'import * as z from "./external";', 'export * from "./external";', "export { z };" },
  ["node_modules/zod/external.d.ts"] = {
    "export declare class ZodLiteral<T> {",
    "  static create: <T extends string>(value: T, params?: { message?: string }) => ZodLiteral<T>;",
    "}",
    "declare const literalType: typeof ZodLiteral.create;",
    "export declare function pick<T>(value: T): T;",
    "export { literalType as literal };",
  },
  ["report.ts"] = {
    "import { z, pick } from 'zod';",
    "import { gone } from 'nowhere';", -- 2: unresolved (error)
    "export const dir = z.literal('ASC');", -- 3
    "export const p = pick('P');", -- 4
    "export const g = gone;",
  },
  ["panel.tsx"] = {
    "export const Panel = ({ name }: { name: string }) => {", -- 1
    "  return <div>{name}</div>;",
    "};",
    "export const usePanel = () => Panel({ name: 'x' });", -- 4
    "function lonely() { return 2; }", -- 5
    "export const z = lonely();", -- 6
    "interface Box { a: number }", -- 7
    "interface Box { b: number }",
    "export const box: Box = { a: 1, b: 2 };", -- 9
    "export const shared = 1;", -- 10: used by three index.tsx files
  },
  ["app.tsx"] = {
    "import { Panel } from './panel';", -- 1
    "",
    "export const App = () => <Panel name=\"a\" />;", -- 3
    "export const all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26].map(() => Panel);",
  },
  -- same-named files in different folders: the file column shows the shortest telling parent path
  ["Email/index.tsx"] = { "import { shared } from '../panel';", "export const v = shared;" },
  ["Login/Password/index.tsx"] = { "import { shared } from '../../panel';", "export const v = shared;" },
  ["Signup/Password/index.tsx"] = { "import { shared } from '../../panel';", "export const v = shared;" },
}

local function where() return H.lua("return { vim.fn.expand('%:t'), vim.fn.line('.'), vim.fn.col('.') }") or {} end
local function at(line, col) H.lua(("vim.api.nvim_win_set_cursor(0, { %d, %d })"):format(line, col)) end
local function edit(file) H.lua(("vim.cmd.edit(%q)"):format(file)) end
local function peek_open() return H.lua("return require('config.peek').is_open()") == true end
-- Press keys until Quick Definition is open (the server may still be loading the project), at most timeout ms
local function until_peek(keys, timeout)
  local t = vim.uv.hrtime()
  repeat
    H.keys(keys)
    if H.wait_for(peek_open, 2000) then return true end
    H.keys(K.esc)
  until (vim.uv.hrtime() - t) / 1e6 > (timeout or 15000)
  return false
end
-- Press keys until the usages popup's payload (pickers `usages`) matching pred comes, at most timeout ms
local function until_usages(keys, pred, timeout)
  local t = vim.uv.hrtime()
  repeat
    H.bridge_clear()
    H.keys(keys)
    local u = H.wait_bridge("pickers", "usages", pred, 2000)
    if u then return u end
    H.keys(K.esc)
  until (vim.uv.hrtime() - t) / 1e6 > (timeout or 15000)
end
local function keys_of(u) return vim.tbl_map(function(it) return it.key end, u and u.items or {}) end
-- Inlay hints on a line (1-based) as nvim has them (after the config's WebStorm filter): { label, kind }
local HINTS = [[local l = ... local out = {}
  for _, h in ipairs(vim.lsp.inlay_hint.get({ bufnr = 0 })) do
    local ih = h.inlay_hint
    if ih.position.line == l - 1 then
      local t = type(ih.label) == 'string' and ih.label or table.concat(vim.tbl_map(function(p) return p.value end, ih.label))
      out[#out + 1] = { label = vim.trim(t), kind = ih.kind or 0 }
    end
  end
  return out]]
local function hints(line) return H.lua(HINTS, { line }) or {} end
local function has_label(line, label)
  for _, h in ipairs(hints(line)) do
    if h.label == label then return true end
  end
  return false
end

H.run(function()
  local dir = H.project("lsp", FILES)
  H.start(dir, { "err.ts" })
  H.expect("vtsls attached and reports the error in err.ts", "#vim.lsp.get_clients({ bufnr = 0, name = 'vtsls' }) > 0"
    .. " and #vim.diagnostic.get(0, { lnum = 2 }) > 0", "=vim.tbl_map(function(c) return c.name end, vim.lsp.get_clients())", 30000)

  -- parameter info: WebStorm's JS/TS popup shows the parameter list only
  local params = H.lua([[local f = require('config.app.floats').signature_params
    local out = {}
    for _, l in ipairs({ 'withVat(amount: number): number', 'now(): Date', 'on(cb: (e: Event) => void, x?: string): void', 'Foo' }) do
      local text, off = f(l)
      out[#out + 1] = { text, off }
    end
    return out]])
  H.check("parameter info: the parameter list only, '<no parameters>', offsets for the active range", vim.deep_equal(params, {
    { "amount: number", 8 }, { "<no parameters>", 4 }, { "cb: (e: Event) => void, x?: string", 3 }, { "Foo", 0 },
  }), params)

  -- Context actions: only the ones that apply (vim.ui.select -> the native menu's payload)
  at(2, 8)
  local menu
  local t = vim.uv.hrtime()
  repeat -- the server may still be loading the project
    H.bridge_clear()
    H.keys(K.alt_enter)
    menu = H.wait_menu(3000)
    local ok = menu and vim.tbl_contains(H.menu_labels(menu), "Move to a new file")
    if not ok and menu then H.call("config.app.menu", "cancel", menu.id, true) end
  until (menu and vim.tbl_contains(H.menu_labels(menu), "Move to a new file")) or (vim.uv.hrtime() - t) / 1e6 > 15000
  H.check("Alt+Enter lists context actions, none disabled", menu ~= nil and vim.tbl_contains(H.menu_labels(menu), "Move to a new file")
    and not table.concat(H.menu_labels(menu), "\n"):lower():find("disabled", 1, true), H.menu_labels(menu))
  if menu then H.call("config.app.menu", "cancel", menu.id, true) end

  -- Inlay hints: parameter names in front of literals only, never types -------------------------------------
  edit("hints.ts")
  H.expect("inlay hints: parameter names in front of literal arguments", function()
    return has_label(3, "x:") and has_label(3, "y:")
  end, function() return hints(3) end, 15000)
  H.check("inlay hints: no type hints (inferred variable / parameter types)", (function()
    for _, l in ipairs({ 5, 6 }) do
      for _, h in ipairs(hints(l)) do
        if h.kind == 1 or h.label:sub(1, 1) == ":" then return false end
      end
    end
    return true
  end)(), { hints(5), hints(6) })

  -- Quick Definition (Cmd+L): Cmd+L again closes it -----------------------------------------------------------
  at(3, 17) -- on add
  until_peek(K.cmdL)
  H.keys(K.cmdL)
  H.expect("Cmd+L again closes it", function() return not peek_open() end)
  -- in a split narrower than the popup (the Chat column beside the editor): the popup stays inside its split,
  -- the islands beside it would cover what pokes out (#211)
  H.lua("vim.cmd('rightbelow vsplit') vim.cmd('vertical resize 40')")
  at(3, 17)
  until_peek(K.cmdL)
  local fit = H.lua([[local s = require('config.peek').state()
    local from = s.from
    local fp, sp = vim.api.nvim_win_get_position(s.win), vim.api.nvim_win_get_position(from)
    return { left = fp[2], right = fp[2] + vim.api.nvim_win_get_width(s.win), split = { sp[2], sp[2] + vim.api.nvim_win_get_width(from) } }]])
  H.check("Quick Definition in a 40-column split: inside it", fit ~= nil and fit.left >= fit.split[1]
    and fit.right <= fit.split[2], fit)
  H.keys(K.esc)
  H.expect("closed", function() return not peek_open() end)
  H.lua("vim.cmd('close')")
  -- the app's grid narrower than the split's logical width (the Chat column takes its pixels off the island,
  -- nvim_win_get_width stays logical): the popup fits the grid nvim draws, winwidth / winheight (#216)
  local split = H.lua("return { win = vim.api.nvim_get_current_win(), w = vim.api.nvim_win_get_width(0), h = vim.api.nvim_win_get_height(0) }")
  H.resize_grid(split.win, 50, split.h - 4)
  at(3, 17)
  until_peek(K.cmdL)
  local grid = H.lua([[local s = require('config.peek').state()
    local c = vim.api.nvim_win_get_config(s.win)
    local caret = vim.api.nvim_win_call(s.from, vim.fn.wincol) - 1
    return { left = caret + c.col, right = caret + c.col + c.width, cols = vim.fn.winwidth(s.from) }]])
  H.check("Quick Definition on a grid narrower than its split: inside the grid", grid ~= nil and grid.left >= 0
    and grid.right <= grid.cols - 1, grid)
  H.keys(K.esc)
  H.expect("closed", function() return not peek_open() end)
  H.resize_grid(split.win, split.w, split.h)

  -- Cmd+B / gd: the declaration, or the usages popup's data ----------------------------------------------------
  edit("panel.tsx")
  -- the project loaded (app.tsx's usages found)
  H.wait_for([[(function()
    local r = vim.lsp.buf_request_sync(0, 'textDocument/references', function(c)
      local p = vim.lsp.util.make_position_params(0, c.offset_encoding)
      p.position = { line = 0, character = 14 }
      p.context = { includeDeclaration = false }
      return p
    end, 2000)
    for _, res in pairs(r or {}) do if res.result and #res.result >= 4 then return true end end
  end)()]], 30000)
  edit("app.tsx")
  H.wait_for("vim.fn.expand('%:t') == 'app.tsx'")
  at(3, 26) -- the Panel of <Panel
  H.keys("gd")
  H.expect("gd on a usage jumps to the declaration", function()
    local w = where()
    return w[1] == "panel.tsx" and w[2] == 1 and w[3] == 14
  end, where, 10000)
  at(5, 10)
  H.bridge_clear()
  H.keys("gd")
  H.expect("gd on a declaration with one usage jumps straight there (no popup)", function()
    local w = where()
    return w[2] == 6 and w[3] == 18 and #H.bridge("pickers", "usages") == 0
  end, function() return { where(), H.bridge("pickers", "usages") } end)
  at(9, 19)
  local choose = until_usages("gd", function(u) return (u.title or ""):find("Choose Declaration", 1, true) ~= nil end)
  H.check("several declarations: Choose Declaration popup", choose ~= nil
    and vim.tbl_contains(keys_of(choose), "panel.tsx 7") and vim.tbl_contains(keys_of(choose), "panel.tsx 8"),
    choose and { choose.title, keys_of(choose) })
  at(10, 14)
  local names = { "Email/index.tsx 1", "Email/index.tsx 2", "Login/Password/index.tsx 1", "Login/Password/index.tsx 2",
    "Signup/Password/index.tsx 1", "Signup/Password/index.tsx 2" }
  local same = until_usages("gd", function(u) return #(u.items or {}) >= #names end)
  H.check("same-named files: shortest telling parent path, right-aligned", same ~= nil and vim.deep_equal(keys_of(same), names),
    keys_of(same))
  -- no usages: WebStorm's information hint at the caret (a hover popup), not a balloon
  edit("app.tsx")
  H.wait_for("vim.fn.expand('%:t') == 'app.tsx'")
  at(4, 13) -- `all`, used nowhere
  H.bridge_clear()
  H.keys("gd")
  local none = H.wait_bridge("floats", "hover", function(p)
    return p.sections and p.sections[1] and p.sections[1].text == "No usages found in Project Files"
  end, 10000)
  H.check("no usages: an information hint at the caret", none ~= nil and none.anchor ~= nil and none.kind == "hover",
    H.bridge("floats"))
  H.keys(K.esc)

  -- The hover popup asks the server once per element (docs, definition): shown again for the same element of an
  -- unchanged buffer (gh again, the tooltip again), it reuses the answers
  edit("panel.tsx")
  H.wait_for("vim.fn.expand('%:t') == 'panel.tsx'")
  at(4, (H.lua("return vim.fn.getline(4):find('Panel%(') - 1")))
  H.lua([[
    _G.__reqs = {}
    local orig = vim.lsp.buf_request_all
    _G.__orig_request_all = orig
    vim.lsp.buf_request_all = function(buf, method, ...)
      _G.__reqs[method] = (_G.__reqs[method] or 0) + 1
      return orig(buf, method, ...)
    end
  ]])
  local function hover_twice()
    H.bridge_clear()
    H.call("config.gutter", "hover_cursor")
    return H.wait_bridge("floats", "hover_location", function(p) return p.text ~= "" end, 15000)
  end
  local first = hover_twice()
  H.call("config.app.floats", "close_hover")
  local second = hover_twice()
  local reqs = H.lua("local r = _G.__reqs vim.lsp.buf_request_all = _G.__orig_request_all return r") or {}
  H.check("hover again on the same element: no new LSP requests (docs + definition asked once)",
    first ~= nil and second ~= nil and reqs["textDocument/hover"] == 1 and reqs["textDocument/definition"] == 1, reqs)
  H.call("config.app.floats", "close_hover")

  -- Inlay hints in zod: parameter names for declared functions (pick), none for a const typed as a function
  edit("report.ts")
  H.expect("inlay hints: function declarations keep parameter names (pick(value: 'P'))",
    function() return has_label(4, "value:") end, function() return hints(4) end, 15000)
  H.check("inlay hints: none in z.literal('ASC') (callee typed as a function, like WebStorm)", #hints(3) == 0, hints(3))

  -- A slow usages search says so ("Finding usages…" balloon after a moment), hidden once the answer is there
  H.bridge_clear()
  H.lua([[
    local function req(type) vim.api.nvim_exec_autocmds("LspRequest", { buffer = 0, modeline = false,
      data = { client_id = 999, request_id = 1, request = { type = type, bufnr = 0, method = "textDocument/references" } } }) end
    _G.lsp_test_req = req
    req("pending")]])
  local shown = H.wait_bridge("popups", "balloon", function(b) return (b.msg or ""):find("Finding usages", 1, true) ~= nil end, 2000)
  H.lua("lsp_test_req('complete')")
  local hidden = H.wait_bridge("popups", "balloon_hide", function(b) return b.id == "ws_usages" end, 3000)
  H.check("slow usages search shows Finding usages…, hides it when done", shown ~= nil and hidden ~= nil,
    H.bridge("popups"))

  -- Popups and modes: WebStorm has no modes. Quick Definition opened while typing gives typing back on Esc, at
  -- the same spot
  local function state() return { H.mode(), H.focus(), H.cursor(), H.file() } end
  local function back_at(mode, file, l, c)
    return function()
      local s = state()
      return s[1] == mode and s[2] == "split" and s[4] == file and s[3] and s[3][1] == l and s[3][2] == c
    end
  end
  edit("hints.ts")
  H.wait_for("vim.fn.expand('%:t') == 'hints.ts'")
  at(3, 18)
  H.keys("i")
  H.keys(K.cmdL)
  H.wait_for(peek_open, 8000)
  H.keys(K.esc)
  H.expect("Cmd+L while typing, Esc: typing again at the same spot", function()
    return not peek_open() and back_at("i", "hints.ts", 3, 18)()
  end, function() return vim.inspect(state()) end)
  H.keys(K.esc)

  -- Cmd+B on a name a destructuring pattern declares: it's the declaration, so Show Usages (the server's
  -- definition is the property it comes from)
  vim.fn.writefile({
    "const useThing = () => ({ profile: 1 });",
    "export function f() {",
    "  const { profile } = useThing();", -- 3
    "  return profile + profile * profile;",
    "}",
  }, dir .. "/destr.ts")
  edit("destr.ts")
  H.wait_for("#vim.lsp.get_clients({ bufnr = 0, method = 'textDocument/references' }) > 0", 15000)
  at(3, 10)
  local destr = until_usages(K.cmdB, function(u) return (u.title or ""):find("Usages of profile", 1, true) ~= nil end)
  H.check("Cmd+B on a destructured name: Show Usages", destr ~= nil and vim.tbl_contains(keys_of(destr), "destr.ts 4"),
    destr and { destr.title, keys_of(destr) })

  -- Quick Definition: Enter / F4 open the file at the caret moved in the popup (keys, wheel), not at the name
  vim.fn.writefile({
    "export function longFn(a: number) {", -- 1
    "  const first = a + 1;",
    "  const second = first * 2;",
    "  const third = second - 3;", -- 4
    "  const fourth = third / 4;",
    "  const fifth = fourth % 5;",
    "  const sixth = fifth + 6;",
    "  const seventh = sixth * 7;",
    "  const eighth = seventh - 8;",
    "  return eighth;",
    "}",
  }, dir .. "/long.ts")
  vim.fn.writefile({ "import { longFn } from './long';", "export const r = longFn(1);" }, dir .. "/uselong.ts")
  edit("uselong.ts")
  H.wait_for("#vim.lsp.get_clients({ bufnr = 0, method = 'textDocument/definition' }) > 0", 15000)
  at(2, 18)
  until_peek(K.cmdL)
  H.keys("ööö" .. "ää")
  local pk = H.lua([[local s = require('config.peek').state()
    return s and { cursorline = vim.wo[s.win].cursorline, cursor = s.cursor, current = vim.api.nvim_get_current_win() == s.win }]])
  H.check("Quick Definition: the row moved to is marked (caret row color)", pk ~= nil and pk.cursorline == true
    and pk.current == true and pk.cursor[1] == 4, pk)
  H.keys(K.enter)
  H.expect("Cmd+L, 3 down + 2 right, Enter: long.ts at that exact line / column", function()
    local w = where()
    return w[1] == "long.ts" and w[2] == 4 and w[3] == 19 and H.focus() == "split"
  end, function() return vim.inspect(where()) end)

  edit("uselong.ts")
  H.wait_for("vim.fn.expand('%:t') == 'uselong.ts'")
  at(2, 18)
  until_peek(K.cmdL)
  local pwin = H.lua("return require('config.peek').state().win")
  H.mouse("wheel", "down", pwin, 2, 4)
  H.mouse("wheel", "down", pwin, 2, 4)
  local pc = H.lua("local s = require('config.peek').state() return s and s.cursor")
  H.check("wheel in Quick Definition moves its caret with the view", pc ~= nil and pc[1] > 1, vim.inspect(pc))
  H.keys(K.f4)
  H.expect("wheel, then F4: long.ts at the popup's caret line", function()
    local w = where()
    return pc ~= nil and w[1] == "long.ts" and w[2] == pc[1] and w[3] == pc[2] + 1
  end, function() return vim.inspect({ where(), pc }) end)

  edit("uselong.ts")
  H.wait_for("vim.fn.expand('%:t') == 'uselong.ts'")
  at(2, 18)
  H.keys("i")
  until_peek(K.cmdL)
  -- opened from Insert mode, the popup puts its caret back on the name in scheduled code (peek.lua ModeChanged):
  -- one marker round trip lets that run first (keys are read before scheduled code)
  H.keys("")
  H.keys("öö" .. "ää")
  H.keys(K.enter)
  H.expect("Cmd+L while typing, 2 down + 2 right, Enter: typing in long.ts at that line / column", back_at("i", "long.ts", 3, 18),
    function() return vim.inspect(state()) end)
  H.keys(K.esc)
  H.stop()

  -- Files closed (,w) right after opening while the server is still starting: no "No Project" error balloon
  -- (vtsls closed the file before answering the inlay hints asked for on open). Own tsconfig per folder, so
  -- each file loads a project.
  local projects = {}
  for p = 1, 8 do
    projects[("p%d/tsconfig.json"):format(p)] = '{ "compilerOptions": { "strict": true }, "include": ["*.ts"] }'
    for i = 1, 30 do
      projects[("p%d/m%d.ts"):format(p, i)] = ("export function f%d(a: number, b: string) { return a + b.length; }"):format(i)
    end
    projects[("p%d/main.ts"):format(p)] = { "import { f1 } from './m1';", "export const x = f1(2, 'y');" }
  end
  H.start(H.project("lsp_close", projects))
  for p = 1, 8 do
    edit(("p%d/main.ts"):format(p))
    H.wait_for("#vim.lsp.get_clients({ bufnr = 0, name = 'vtsls' }) > 0", 15000)
    H.keys(",w")
  end
  -- every answer in (an error would show now)
  H.wait_for("(function() local c = vim.lsp.get_clients({ name = 'vtsls' })[1] return c and next(c.requests) == nil end)()", 15000)
  H.expect("files closed right after opening (server starting): all closed, no error balloon", function()
    H.settle(300, 2000)
    return #H.errors() == 0 and H.lua("return #vim.fn.getbufinfo({ buflisted = 1 })") <= 1
  end, function() return table.concat(H.errors(), " | ") end)
end)
