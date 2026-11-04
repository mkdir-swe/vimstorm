-- A Layer's workflow file (config/workflow.lua) against a fake `abe` (VIMSTORM_ABE): canned `workflow read`
-- answers per path. Its problems are diagnostics, ⌥⏎ puts a fix in as one undo step, a farther Layer's file is
-- read-only, the preview gets the readable side, a non-Layer file is left alone.
local H = dofile(os.getenv("NVT_HARNESS"))
local MINE = { "name: mine", "steps: x" }
local DIR = H.project("workflow", {
  ["mine/workflows/mine.yaml"] = MINE,
  ["repo/workflows/shared.yaml"] = { "name: shared" },
  [".github/workflows/ci.yaml"] = { "on: push" },
  ["team/skills/tdd/SKILL.md"] = { "---", "name: tdd", "---", "# TDD" },
  ["team/skills/tdd/fixtures.json"] = { "{", '  "cases": [1, 2]', "}" },
  ["team/skills/tdd/template.sh"] = { "#!/bin/sh", "echo '# not a heading'" },
  -- a card's worktree: its own checkout (.git a file)
  ["card/.git"] = { "gitdir: elsewhere" },
  ["card/abe/skills/tdd/SKILL.md"] = { "---", "name: tdd", "---", "# TDD in the card" },
})
local FAKE = DIR .. "/fake-abe"
local LOG = DIR .. "/abe.log"
local CWDS = DIR .. "/abe-cwd.log"
vim.fn.writefile({
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> ' .. vim.fn.shellescape(LOG),
  "pwd -P >> " .. vim.fn.shellescape(CWDS),
  'case "$1 $2 $3" in',
  "  'workflow read '*/mine/workflows/*)",
  [[    printf '%s\n' '{"ok":true,"data":{"file":"mine.yaml","kind":"workflow","layer":"yours","id":"mine","readOnly":false,"mine":null,"proposeTo":"repo","markdown":"# Mine readable\n","problems":[{"line":2,"code":"unknown-skill","text":"No skill named x: use one of this repo'"'"'s skills or abe'"'"'s","fixes":[{"title":"Use review","text":"name: mine\nsteps: review\n"}]}],"retro":null,"compare":{"layer":"repo","theirs":"'"$ABE_TEST_DIR"'/repo/workflows/shared.yaml","mine":"'"$ABE_TEST_DIR"'/mine/workflows/mine.yaml"}}}' ;;]],
  "  'workflow read '*/repo/workflows/*)",
  [[    printf '%s\n' '{"ok":true,"data":{"file":"shared.yaml","kind":"workflow","layer":"repo","id":"shared","readOnly":true,"mine":null,"proposeTo":null,"markdown":"# Shared\n","problems":[],"retro":null}}' ;;]],
  "  'workflow read '*/skills/*)",
  [[    printf '%s\n' '{"ok":true,"data":{"file":"SKILL.md","kind":"skill","layer":"repo","id":"tdd","readOnly":false,"mine":null,"proposeTo":null,"markdown":"# TDD readable\n","problems":[],"retro":null}}' ;;]],
  "  'workflow tree '*)",
  [[    printf '%s\n' '{"ok":true,"data":{"main":true,"dir":"'"$ABE_TEST_DIR"'/abe","tags":[{"path":"'"$ABE_TEST_DIR"'/abe/workflows/ok.yaml","tag":"Repo’s · on default","bad":false},{"path":"'"$ABE_TEST_DIR"'/abe/workflows/broken.yaml","tag":"Repo’s · 2 problems","bad":true}]}}' ;;]],
  "  'workflow copy '*)",
  [[    printf '%s\n' '{"ok":true,"data":{"from":"shared.yaml","layer":"repo","path":"'"$ABE_TEST_DIR"'/mine/workflows/mine.yaml","existed":false}}' ;;]],
  "  'workflow change '*)",
  [[    printf '%s\n' '{"ok":true,"data":{"summary":"Added a review step","before":"","text":"name: mine\nsteps: x\nreview: true\n","problems":[],"written":null}}' ;;]],
  "  *)",
  [[    printf '%s\n' '{"ok":false,"error":{"code":"not-a-layer-file","message":"not a Layer file"}}' ;;]],
  "esac",
}, FAKE)
vim.fn.setfperm(FAKE, "rwxr-xr-x")

H.run(function()
  H.start(DIR, { "mine/workflows/mine.yaml" }, { env = { VIMSTORM_ABE = FAKE, ABE_TEST_DIR = DIR } })
  local diag = "local ns = vim.api.nvim_get_namespaces().abe_workflow return ns and vim.diagnostic.get(0, { namespace = ns }) or {}"
  H.expect("a Layer's workflow gets abe's problems as errors on their line", function()
    local d = H.lua(diag) or {}
    return #d == 1 and d[1].lnum == 1 and d[1].severity == 1 and d[1].message == "No skill named x: use one of this repo's skills or abe's"
  end, function() return H.lua(diag) end)
  H.check("its tab has the red wave (the problem files' error)", H.lua("return require('config.tabbar').has_errors(0)") == true)
  H.check("each problem's message on a line under it", H.lua("return type(vim.diagnostic.config(nil, vim.api.nvim_get_namespaces().abe_workflow).virtual_lines) == 'table'") == true)
  local vlines = function() return H.lua([[local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_extmarks(0, -1, 0, -1, { details = true })) do
      for _, l in ipairs(m[4].virt_lines or {}) do local s = "" for _, c in ipairs(l) do s = s .. c[1] end out[#out + 1] = s end
    end return out]]) or {} end
  H.check("its words alone, not its code first", vim.tbl_contains(vlines(), "└──── No skill named x: use one of this repo's skills or abe's"), vlines())
  -- the app sizes the window's grid to what shows (left of the preview): the lines wrap at that edge
  H.resize_grid(H.lua("return vim.api.nvim_get_current_win()"), 40, 30)
  local edge = 40 - H.lua("return vim.fn.getwininfo(vim.api.nvim_get_current_win())[1].textoff")
  H.expect("a narrower grid wraps them at its edge", function()
    local l = vlines()
    return #l > 1 and vim.iter(l):all(function(s) return vim.fn.strdisplaywidth(s) < edge end)
  end, vlines)
  local long = H.lua("return require('config.workflow').wrap(...)", { "Unknown key " .. string.rep("k", 47) .. " here", 20 })
  H.check("a word wider than the edge is hard-broken there, not cut", vim.deep_equal(long,
    { "Unknown key", string.rep("k", 20), string.rep("k", 20), string.rep("k", 7) .. " here" }), long)
  -- the preview beside it never a few columns wide (a letter a line): 20 columns at least, so is the YAML
  -- (config/shares.lua; half each of a pair narrower than 40)
  local pair = function() return H.lua([[local s = require('config.markdown').state()[1] or {}
    if not s.preview then return nil end
    return { e = vim.api.nvim_win_get_width(s.win), p = vim.api.nvim_win_get_width(s.preview) }]]) end
  local least = function() local w = pair() return w ~= nil and w.p >= 20 and w.e >= 20 end
  local rows = H.lua([[local s = require('config.shares') return {
    s.least(117, 2), s.least(30, 2), s.least(90, 3),
    s.widths_for({ 0.5, 0.5 }, 101), s.widths_for({ 0.25, 0.75 }, 100), s.widths_for({ 0.1, 0.9 }, 100),
    s.widths_for({ 0.9, 0.1 }, 100), s.widths_for({ 1 / 3, 1 / 3, 1 / 3 }, 91), s.widths_for({ 0.05, 0.05, 0.9 }, 100) }]])
  H.check("the least and the widths of shares (edges rounded, each at least 20 columns)", vim.deep_equal(rows, {
    20, 15, 20, { 51, 50 }, { 25, 75 }, { 20, 80 }, { 80, 20 }, { 30, 31, 30 }, { 20, 20, 60 } }), rows)
  H.lua("vim.api.nvim_win_set_width(require('config.markdown').state()[1].preview, 3)")
  H.expect("a preview dragged to a few columns keeps its least width", least, pair)
  local cols = H.lua("return vim.o.columns")
  H.resize(70, H.lua("return vim.o.lines"))
  H.expect("so does it in a narrower window", least, pair)
  H.resize(cols, H.lua("return vim.o.lines"))
  -- the divider moved to a quarter (:vertical resize, as a drag): the share the pair keeps and the next
  -- preview opens at (Editor Only and back here; another file's)
  local quarter = function() local w = pair() return w ~= nil and math.abs(w.p - (w.e + w.p) / 4) <= 1 end
  local w0 = pair() or { e = 0, p = 0 }
  H.lua("local n, s = ..., require('config.markdown').state()[1] vim.api.nvim_win_call(s.win, function() vim.cmd('vertical resize ' .. n) end)",
    { math.floor((w0.e + w0.p) * 3 / 4 + 0.5) })
  H.expect("the preview a quarter of the pair", quarter, pair)
  H.expect("its share remembered", function() return math.abs(H.lua("return require('config.markdown').preview_share()") - 0.25) < 0.02 end,
    function() return H.lua("return require('config.markdown').preview_share()") end)
  H.resize(cols - 20, H.lua("return vim.o.lines"))
  H.expect("kept in a narrower window", quarter, pair)
  H.resize(cols, H.lua("return vim.o.lines"))
  H.expect("and back", quarter, pair)
  H.lua("require('config.markdown').set('editor')")
  H.expect("Editor Only: no preview", function() return pair() == nil end, pair)
  H.lua("require('config.markdown').set('split')")
  H.expect("Editor and Preview again: the preview opens at the quarter", quarter, pair)
  H.check("⌘-click goes to definition there", H.lua("return vim.fn.maparg('<D-LeftMouse>', 'n', false, true).desc") == "Go to declaration / usages")
  H.check("the abe call never starts a serve", (vim.fn.readfile(LOG)[1] or ""):find("%-%-no%-start") ~= nil, vim.fn.readfile(LOG))
  local text = H.wait_bridge("markdown", "text", function(p) return p.text == "# Mine readable\n" end)
  H.check("the preview shows the readable side, not the YAML", text ~= nil, H.bridge("markdown", "text"))

  H.lua("vim.api.nvim_win_set_cursor(0, { 2, 0 })")
  H.bridge_clear()
  H.call("config.context", "code_actions")
  local menu = H.wait_menu()
  local labels = H.menu_labels(menu)
  H.check("⌥⏎ lists abe's fix first, then More actions…", labels[1] == "Use review" and labels[2] == "More actions…", labels)
  H.menu_choose(menu, "Use review")
  H.check("the fix replaces the text", vim.deep_equal(H.lines(), { "name: mine", "steps: review" }), H.lines())
  local fixed = H.lua([[local ns = vim.api.nvim_get_namespaces().abe_workflow_changed local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_extmarks(0, ns, 0, -1, {})) do out[#out + 1] = m[2] + 1 end return out]])
  H.check("the line the fix changed is lit, as ⌘G's", vim.deep_equal(fixed, { 2 }), fixed)
  H.lua("vim.cmd.undo()")
  H.check("as one undo step", vim.deep_equal(H.lines(), MINE), H.lines())
  H.lua("vim.ui.input = function(_, cb) cb('add a review') end")
  H.keys("<D-g>")
  H.expect("⌘G puts the AI's change in", function() return vim.deep_equal(H.lines(), { "name: mine", "steps: x", "review: true" }) end,
    function() return H.lines() end)
  local lit = H.lua([[local ns = vim.api.nvim_get_namespaces().abe_workflow_changed local out = {}
    for _, m in ipairs(vim.api.nvim_buf_get_extmarks(0, ns, 0, -1, {})) do out[#out + 1] = m[2] + 1 end return out]])
  H.check("its changed line is lit", vim.deep_equal(lit, { 3 }), lit)
  H.lua("vim.cmd.undo()")
  local items = H.lua([[local out = {} for _, i in ipairs(require('config.menu').items() or {}) do
    if type(i) == "table" then out[#out + 1] = i[1] end end return out]]) or {}
  H.check("the menu has Change with AI…, Compare with repo and Propose a Change to repo…",
    vim.tbl_contains(items, "Change with AI…") and vim.tbl_contains(items, "Compare with repo")
      and vim.tbl_contains(items, "Propose a Change to repo…"), items)
  H.keys("<D-d>")
  H.expect("⌘D: your copy beside the repo's in the diff viewer", "require('git.diff').is_active()", "=require('git.diff').state()")
  H.lua("require('git.diff').close()")

  H.lua("vim.cmd.edit(...)", { DIR .. "/repo/workflows/shared.yaml" })
  H.expect("a farther Layer's file is not modifiable", "vim.b.abe_layer == true and not vim.bo.modifiable and vim.bo.readonly",
    "={ vim.b.abe_layer, vim.bo.modifiable }")
  items = H.lua([[local out = {} for _, i in ipairs(require('config.menu').items() or {}) do
    if type(i) == "table" then out[#out + 1] = i[1] end end return out]]) or {}
  H.check("its menu has Edit My Copy", vim.tbl_contains(items, "Edit My Copy"), items)
  local shared = H.lua("return vim.api.nvim_get_current_buf()")
  H.call("config.workflow", "copy")
  H.expect("Edit my copy opens your copy in its place", "vim.api.nvim_buf_get_name(0):find('/mine/workflows/mine.yaml', 1, true) ~= nil",
    "=vim.api.nvim_buf_get_name(0)")
  H.check("the read-only original is gone from the buffer list",
    H.lua("return not (vim.api.nvim_buf_is_valid(...) and vim.bo[...].buflisted)", { shared }) == true)

  H.lua("vim.cmd.edit(...)", { DIR .. "/.github/workflows/ci.yaml" })
  H.settle(400, 2000)
  H.check("a non-Layer workflow file is left alone", H.lua("return vim.b.abe_layer == nil and vim.bo.modifiable") == true)

  -- a skill folder's other files are no Layer's: their own filetype, no preview (abe reads SKILL.md / .md only)
  H.lua("vim.cmd.edit(...)", { DIR .. "/team/skills/tdd/SKILL.md" })
  H.expect("a skill's SKILL.md is a Layer's file with its preview", "vim.b.abe_layer == true", "=vim.b.abe_layer")
  for _, name in ipairs({ "fixtures.json", "template.sh" }) do
    H.lua("vim.cmd.edit(...)", { DIR .. "/team/skills/tdd/" .. name })
    H.settle(600, 2000)
    local seen = H.lua([[local md = require('config.markdown') local buf = vim.api.nvim_get_current_buf()
      local preview = false
      for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
        if vim.b[vim.api.nvim_win_get_buf(w)].ws_md_preview ~= nil then preview = true end
      end
      return { layer = vim.b.abe_layer == true, ft = vim.bo.filetype, md = md.is_md(buf), preview = preview }]])
    H.check("a skill folder's " .. name .. " opens plainly: its own filetype, no Layer, no markdown preview",
      seen and not seen.layer and not seen.md and not seen.preview and seen.ft == (name == "fixtures.json" and "json" or "sh"), seen)
  end
  H.check("abe is never asked about them", #vim.tbl_filter(function(l) return l:find("fixtures.json", 1, true) or l:find("template.sh", 1, true) end,
    vim.fn.readfile(LOG)) == 0, vim.fn.readfile(LOG))
  H.lua("vim.cmd.edit(...)", { DIR .. "/card/abe/skills/tdd/SKILL.md" })
  H.expect("a card worktree's skill file is a Layer's file too", "vim.b.abe_layer == true", "=vim.b.abe_layer")
  local cwds = vim.fn.readfile(CWDS)
  H.check("read in that worktree's checkout, not the project's", cwds[#cwds] == vim.fn.resolve(DIR .. "/card"), cwds[#cwds])

  -- a failing workflow's folders say so too, folded or not
  H.call("config.workflow", "tree")
  local abe = H.wait_bridge("tree", "abe", function(p) return #(p.tags or {}) > 2 end)
  local tag_of = {}
  for _, t in ipairs(abe and abe.tags or {}) do tag_of[t.path:sub(#DIR + 2)] = t.bad and t.tag end
  H.check("abe/ and abe/workflows/ get a red tag with the problems in them",
    tag_of["abe"] == "2 problems" and tag_of["abe/workflows"] == "2 problems" and tag_of["abe/workflows/ok.yaml"] == false,
    abe)

  -- the install or the Abe chat writes abe/ outside the Editor: the tree's Abe node is asked again
  local trees = function()
    return #vim.tbl_filter(function(l) return l:find("^workflow tree") ~= nil end, vim.fn.readfile(LOG))
  end
  local before = trees()
  vim.fn.mkdir(DIR .. "/abe/workflows", "p")
  vim.fn.writefile({ "name: made" }, DIR .. "/abe/workflows/made.yaml")
  H.expect("a workflow file made outside the Editor asks the tree's Abe node again", function() return trees() > before end,
    function() return vim.fn.readfile(LOG) end)
end)
H.done()
