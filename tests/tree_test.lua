-- Project tool window: the Lua halves of the native tree (app/src/shell/tree draws it; config/app/tree.lua feeds it).
-- The files with compiler errors it underlines (config/problems.lua: not ESLint's) and the multi-selection menu's
-- items. Rows, keys, mouse, file actions and speed search are cargo tests (tree.rs).
local H = dofile(os.getenv("NVT_HARNESS"))

H.run(function()
  local dir = H.project("tproj", {
    ["a.ts"] = { "export const a = 1;" },
    ["b.ts"] = { "export const b = 2;" },
    ["backend/server.ts"] = { "export const s = 1;" },
    ["multi/a.ts"] = "x", ["multi/b.ts"] = "x", ["multi/c.ts"] = "x", ["multi/d.ts"] = "x",
  }, { git = true })
  H.start(dir, { "a.ts" })

  -- An error in a file underlines it and its folders; ESLint errors stay in the editor (WebStorm): the
  -- problems payload the tree gets leaves them out
  H.bridge_clear()
  H.lua([[
    vim.diagnostic.set(vim.api.nvim_create_namespace('tree_test'), vim.fn.bufadd('b.ts'),
      { { lnum = 0, col = 0, message = 'boom', severity = vim.diagnostic.severity.ERROR } })
    vim.diagnostic.set(vim.api.nvim_create_namespace('tree_test_lint'), vim.fn.bufadd('backend/server.ts'),
      { { lnum = 0, col = 0, message = 'Parsing error', severity = vim.diagnostic.severity.ERROR, source = 'eslint' } })
  ]])
  -- (paths are absolute: /tmp is /private/tmp there, so matched by their end)
  local function has(list, tail)
    for _, p in ipairs(list or {}) do
      if p:sub(-#tail) == tail then return true end
    end
    return false
  end
  local sent = H.wait_bridge("tree", "problems", function(p) return has(p.paths, "/tproj/b.ts") end)
  local paths = H.lua("return vim.tbl_keys(require('config.problems').paths())") or {}
  H.check("ESLint error: no underline on its folder", sent ~= nil and has(sent.paths, "/tproj")
    and not has(sent.paths, "/tproj/backend") and not has(sent.paths, "/backend/server.ts") and not has(paths, "/tproj/backend"),
    vim.inspect({ sent, paths }))
  -- each file's problem counts, every source (Feel vscode's tree badge `2`): the ESLint one counts there
  local function count(p, tail)
    for _, c in ipairs(p.counts or {}) do
      if c.path:sub(-#tail) == tail then return c.errors .. "/" .. c.warnings end
    end
  end
  H.lua([[
    vim.diagnostic.set(vim.api.nvim_create_namespace('tree_test_warn'), vim.fn.bufadd('b.ts'),
      { { lnum = 0, col = 0, message = 'unused', severity = vim.diagnostic.severity.WARN },
        { lnum = 0, col = 1, message = 'hint', severity = vim.diagnostic.severity.HINT } })
  ]])
  local counted = H.wait_bridge("tree", "problems", function(p) return count(p, "/tproj/b.ts") == "1/1" end)
  H.check("problem counts: b.ts 1 error 1 warning (no hint), server.ts's ESLint error",
    counted ~= nil and count(counted, "/backend/server.ts") == "1/0" and count(counted, "/tproj/a.ts") == nil,
    vim.inspect(H.last("tree", "problems")))

  -- the menu on a multi-selection: the multi-item actions with their keys (Rust calls menu(ctx) on Cmd+Enter)
  H.bridge_clear()
  local sel = vim.tbl_map(function(f) return dir .. "/multi/" .. f end, { "a.ts", "b.ts", "c.ts", "d.ts" })
  H.call("config.app.tree", "menu", { paths = sel, multi = 4, files = 4, dir = false, open = false, root = false, x = 10, y = 10 })
  local menu = H.wait_menu()
  local labels, reveal = H.menu_labels(menu), nil
  for _, it in ipairs(menu and menu.items or {}) do
    if it.label == "Reveal in Finder" then reveal = it.key end
  end
  H.check("menu on a multi-selection: actions for all of them", vim.tbl_contains(labels, "Delete 4 Items")
    and vim.tbl_contains(labels, "Open 4 Files") and vim.tbl_contains(labels, "Move 4 Items…") and reveal == "⌃⇧⌘O",
    vim.inspect(labels))
  if menu then H.call("config.app.menu", "cancel", menu.id, true) end
end)
