-- PR review in VimStorm's diff (ticket 23; 1.0: the Git Log's PR filter): the diff entry the PR review uses
-- (config/app/git_changes.lua `diff` with two revisions and a line): base..head of a file opens in the diff
-- viewer with the merge base on the left and the PR head on the right, the current version's cursor on the
-- change's line, the keyboard left where it was. The pane itself, `C`, the heat order and ⏎ are cargo tests
-- (app/tests/abe_review.rs).
-- Review comments and the verdict (ticket 24, config/app/review.lua): in a PR diff `,ic` asks for a comment
-- in the native field and sends it with the caret's line (or the selected lines) on its side, `,ia` / `,ir` /
-- `,is` open the app's Submit review dialog with that verdict picked (G19), `,in` the next file by heat, all to
-- the review bridge (`vimstorm.git_review`);
-- the diff's context menu lists them with their keys. Elsewhere (a split, a Local Changes diff) they do
-- nothing, and `,rr` / `,re` still rename / move.
-- Ticket 37: the drafts Rust reports get their lines into the diff's description (the gutter's comment mark).
local H = dofile(os.getenv("NVT_HARNESS"))

H.run(function()
  H.start("grepo", { "long.ts" })
  H.wait_focus("split")
  local root = H.lua("return require('git.cli').find_root()")
  local base = H.lua("return vim.trim(vim.fn.system({ 'git', '-C', ... , 'rev-parse', 'v1.0' }))", { root })
  local head = H.lua("return vim.trim(vim.fn.system({ 'git', '-C', ... , 'rev-parse', 'HEAD' }))", { root })
  H.check("fixture revisions read", type(base) == "string" and #base == 40 and type(head) == "string" and #head == 40,
    vim.inspect({ base, head }))

  local files = { { path = "blame.ts", status = "M" }, { path = "backend/scripts/sv.json", status = "A" } }
  -- the base..head diff entry, opened at line 3 (the line the PR changed)
  H.call("config.app.git_changes", "diff", root, files, 1, base, head, 3)
  H.wait_for(function() return H.lua("return require('git.diff').is_active()") == true end)
  local state = H.lua([[
    local s = require('git.diff').state()
    return { line = vim.api.nvim_win_get_cursor(s.new_win)[1], old = s.revs.old, new = s.revs.new,
      index = s.index, count = #s.files,
      new_name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(s.new_win)),
      text = vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(s.new_win), 2, 3, false)[1] }]])
  H.check("base..head: the merge base left, the PR head right (a revision buffer, not the work tree)",
    state.old == base and state.new == head and state.new_name:find("^gitdiff://") ~= nil, vim.inspect(state))
  H.check("the current version's cursor lands on the change's line", state.line == 3 and state.text == "line 3 recent",
    vim.inspect(state))
  H.check("the PR's files are the viewer's: file 1 of 2", state.index == 1 and state.count == 2, vim.inspect(state))

  -- without a line: the first change, as Local Changes opens a diff
  H.call("config.app.git_changes", "diff", root, files, 1, base, head)
  H.wait_for(function()
    return H.lua("local s = require('git.diff').state(); return s and vim.api.nvim_win_get_cursor(s.new_win)[1]") == 3
  end)
  H.check("no line given: the first change", true)

  -- ---- review comments and the verdict (ticket 24) ----
  local function review() return H.bridge("git_review") end
  local function field() -- the native field's payload, newest
    return H.wait_bridge("popups", "input")
  end
  local function answer(text)
    local f = field()
    H.call("config.app.input", "done", f.id, text == nil and vim.NIL or text)
    H.settle(40, 1000)
    return f
  end
  local function in_win(which)
    H.lua(("local s = require('git.diff').state(); vim.api.nvim_set_current_win(s.%s_win)"):format(which))
  end

  -- a Local Changes diff (no PR): the keys do nothing
  H.call("config.app.git_changes", "diff", root, files, 1, base, head, 3)
  H.wait_for(function() return H.lua("return require('git.diff').is_active()") == true end)
  in_win("new")
  H.bridge_clear()
  H.keys(",ic")
  H.keys(",ia")
  H.keys(",in")
  H.settle(80, 1000)
  H.check("outside a PR diff the review keys send nothing and open no field",
    #review() == 0 and #H.bridge("popups", "input") == 0, vim.inspect(H.bridge("popups")))
  H.check("and leave the buffer as it was (no insert, no edit)", H.mode() == "n", H.mode())

  -- the PR diff
  H.call("config.app.git_changes", "diff", root, files, 1, base, head, 3, { pr = 7 })
  H.wait_for(function() return H.lua("local s = require('git.diff').state(); return s and s.review and s.review.pr") == 7 end)
  in_win("new")
  -- the writing card (G21): `,ic` opens it under the line (the app draws it and answers `done`)
  local function card() return H.wait_bridge("git_review", "write") end
  local function write(text, how)
    local w = card()
    H.call("config.app.review", "done", w.token, text == nil and vim.NIL or text, how or "draft")
    H.settle(40, 1000)
    return w
  end
  H.bridge_clear()
  H.keys(",ic")
  local w = card()
  H.check("`,ic`: the writing card on the caret's line of the PR head's side, no native field",
    w and w.path == "blame.ts" and w.side == "RIGHT" and w.line == 3 and w.new == head and not w.post_now
      and #H.bridge("popups", "input") == 0, vim.inspect(w))
  local slots = H.lua("return require('config.app.review').cards('RIGHT')")
  H.check("its blank rows are kept under the line for the app to draw it in",
    #slots == 1 and slots[1].kind == "writing" and slots[1].token == w.token and slots[1].line == 3 and slots[1].rows >= 5,
    vim.inspect(slots))
  H.call("config.app.review", "card_rows", "w", 9)
  slots = H.lua("return require('config.app.review').cards('RIGHT')")
  H.check("the card asks for more rows as its text grows", slots[1] and slots[1].rows == 9, vim.inspect(slots))
  H.call("config.app.review", "done", w.token, "Guard this?", "draft")
  local c = H.wait_bridge("git_review", "comment")
  H.check("⏎ in the card sends the comment with its line on the PR head's side and the diff's revisions",
    c and c.path == "blame.ts" and c.side == "RIGHT" and c.line == 3 and c.body == "Guard this?"
      and c.old == base and c.new == head and c.start_line == nil, vim.inspect(c))
  H.check("answered: the card's rows go", #H.lua("return require('config.app.review').cards('RIGHT')") == 0)

  -- typed fast: the comment's first keys come before the card's field has the keyboard. They are held (not
  -- run in the diff: `x` `d` `u` would edit or undo) and go to the card, in order, once it has the keyboard
  local before = H.lua("return vim.api.nvim_buf_get_lines(0, 0, -1, false)")
  local tick = H.lua("return vim.b.changedtick")
  H.bridge_clear()
  H.keys(",icxdu ok")
  w = card()
  H.check("keys typed right after `,ic` don't run in the diff",
    H.mode() == "n" and vim.deep_equal(H.lua("return vim.api.nvim_buf_get_lines(0, 0, -1, false)"), before)
      and H.lua("return vim.b.changedtick") == tick,
    vim.inspect({ H.mode(), H.lua("return vim.b.changedtick"), tick }))
  H.call("config.app.review", "focused", w.token)
  local t = H.wait_bridge("git_review", "typeahead")
  H.check("once the card has the keyboard they go to it in the order typed",
    t and t.token == w.token and table.concat(t.keys) == "xdu<Space>ok", vim.inspect(t))
  write("xdu ok")
  c = H.wait_bridge("git_review", "comment")
  H.check("and the comment is sent as typed", c and c.body == "xdu ok", vim.inspect(c))
  H.keys("ö")
  H.check("the keys after the card go to the diff again", H.cursor()[1] == 4, vim.inspect(H.cursor()))

  H.bridge_clear()
  H.keys(",ip")
  w = card()
  H.check("`,ip`: the card posts on ⏎", w and w.post_now == true, vim.inspect(w))
  H.call("config.app.review", "done", w.token, "Post this immediately", "post")
  local immediate = H.wait_bridge("git_review", "post_now")
  H.check("Post comment now is a distinct explicit request with exact anchor", immediate and immediate.new == head and immediate.side == "RIGHT" and immediate.body == "Post this immediately", vim.inspect(immediate))

  -- the base's side, a range in visual mode
  in_win("old")
  H.lua("vim.api.nvim_win_set_cursor(0, { 2, 0 })")
  H.bridge_clear()
  H.keys("Vö,ic")
  write("These two")
  c = H.wait_bridge("git_review", "comment")
  H.check("`,ic` on the merge base's side with lines selected: LEFT, from the first to the last",
    c and c.side == "LEFT" and c.start_line == 2 and c.line == 3, vim.inspect(c))
  H.check("visual mode is left", H.mode() == "n", H.mode())

  -- Esc / Cancel in the card: nothing sent
  in_win("new")
  H.bridge_clear()
  H.keys(",ic")
  write(nil)
  H.settle(80, 1000)
  H.check("a comment cancelled sends nothing", #vim.tbl_filter(function(e) return e.event ~= "write" end, review()) == 0,
    vim.inspect(review()))

  -- a draft's Edit draft: the card in its place with its text
  H.call("config.app.review", "drafts", { { seq = 5, path = "blame.ts", side = "RIGHT", line = 3, body = "Old words", head = head } })
  H.bridge_clear()
  H.call("config.app.review", "edit", 5, "Old words")
  w = card()
  slots = H.lua("return require('config.app.review').cards('RIGHT')")
  H.check("Edit draft: the writing card with the draft's text replaces its card",
    w and w.edit == 5 and w.body == "Old words" and #slots == 1 and slots[1].kind == "writing", vim.inspect({ w, slots }))
  write("New words")
  local e = H.wait_bridge("git_review", "edit")
  H.check("its ⏎ saves the draft's new text", e and e.seq == 5 and e.body == "New words", vim.inspect(e))
  H.call("config.app.review", "drafts", {})

  -- a card's rows follow the grid the app drew the pane at (#213: nvim_ui_try_resize_grid narrows it when the
  -- Chat column takes pixels; nvim_win_get_width stays the window's logical width)
  local long = string.rep("words that wrap ", 14)
  local function draft_rows()
    H.call("config.app.review", "drafts", { { seq = 8, path = "blame.ts", side = "RIGHT", line = 3, body = long, head = head } })
    local got = H.lua("return require('config.app.review').cards('RIGHT')")
    return got[1] and got[1].rows
  end
  local new_win = H.lua("return require('git.diff').state().new_win")
  local wide = draft_rows()
  local full = H.lua("local w = ... return { vim.fn.winwidth(w), vim.fn.winheight(w) }", { new_win })
  H.resize_grid(new_win, 30, full[2])
  local narrow = draft_rows()
  H.check("a narrower drawn grid: the card wraps to more rows", wide and narrow and narrow > wide,
    vim.inspect({ wide = wide, narrow = narrow, full = full }))
  H.resize_grid(new_win, full[1], full[2])
  H.call("config.app.review", "drafts", {})

  for _, case in ipairs({ { ",ia", "APPROVE" }, { ",ir", "REQUEST_CHANGES" }, { ",is", "COMMENT" } }) do
    H.bridge_clear()
    H.keys(case[1])
    local v = H.wait_bridge("git_review", "submit")
    H.check(case[1] .. ": the Submit review dialog with " .. case[2] .. " picked (no field of Lua's)",
      v and v.verdict == case[2] and #H.bridge("popups", "input") == 0, vim.inspect(v))
  end

  H.bridge_clear()
  H.call("config.app.review", "threads", { { id = "T1", path = "blame.ts", side = "LEFT", line = 3, start = 2, head = head, resolved = false, outdated = false, can_reply = true, can_resolve = true, comments = { { author = "ada", body = "Old side discussion\n\n<!-- ordinary note -->\n\n<!-- vimstorm:reply:0123456789abcd -->" } } } })
  local anchors = H.lua([[local s = require('git.diff').state(); local ns = vim.api.nvim_get_namespaces()['vimstorm.pr.discussions']; return { old = vim.api.nvim_buf_get_extmarks(vim.api.nvim_win_get_buf(s.old_win), ns, 0, -1, {details=true}), new = vim.api.nvim_buf_get_extmarks(vim.api.nvim_win_get_buf(s.new_win), ns, 0, -1, {details=true}) }]])
  local cards = H.lua("return require('config.app.review').cards('LEFT')")
  H.check("a posted discussion's card sits on its original side under its line", #cards == 1
    and cards[1].kind == "thread" and cards[1].id == "T1" and cards[1].line == 3 and cards[1].rows >= 4, vim.inspect(cards))
  H.check("its rows are kept blank under the line, and as many in the other pane (the panes stay level)",
    #anchors.old == 1 and anchors.old[1][2] == 2 and #anchors.old[1][4].virt_lines == cards[1].rows
      and #anchors.new == 1 and #anchors.new[1][4].virt_lines == cards[1].rows, vim.inspect(anchors))
  local desc = H.wait_bridge("diff", "viewer")
  H.check("the diff's description carries the card for the app to draw",
    desc and desc.panes[1].cards and desc.panes[1].cards[1] and desc.panes[1].cards[1].id == "T1", vim.inspect(desc and desc.panes))
  -- the next file and back: the file's buffers get its cards' rows again (none float over its lines)
  H.lua("require('git.diff').cycle(1)")
  H.wait_for(function() return H.lua("return require('git.diff').state().index") == 2 end)
  H.check("another file: none of the first file's cards", #H.lua("return require('config.app.review').cards('LEFT')") == 0)
  H.lua("require('git.diff').cycle(-1)")
  H.wait_for(function() return H.lua("return require('git.diff').state().index") == 1 end)
  local back = H.lua([[local s = require('git.diff').state(); local ns = vim.api.nvim_get_namespaces()['vimstorm.pr.discussions']; return { cards = require('config.app.review').cards('LEFT'), old = #vim.api.nvim_buf_get_extmarks(vim.api.nvim_win_get_buf(s.old_win), ns, 0, -1, {}) }]])
  H.check("back on it: its card and its blank rows again", #back.cards == 1 and back.cards[1].id == "T1" and back.old == 1,
    vim.inspect(back))
  local read = H.lua([[
    local select, notify = vim.ui.select, vim.notify
    local shown
    vim.ui.select = function(items, _, callback) callback(items[1]) end
    vim.notify = function(text) shown = text end
    local ok, err = pcall(require('config.app.review').next_unresolved)
    vim.ui.select, vim.notify = select, notify
    assert(ok, err)
    return shown
  ]])
  H.check("Read discussion hides only the receipt paragraph", read == "ada: Old side discussion\n\n<!-- ordinary note -->", read)
  H.call("config.app.review", "threads", { { id = "T1", path = "blame.ts", side = "LEFT", line = 3, head = "old-head", outdated = true, resolved = false, comments = { { author = "ada", body = "Old anchor retained" } } } })
  H.check("outdated discussions are retained without painting their anchor on new code", H.lua([[local s = require('git.diff').state(); local ns = vim.api.nvim_get_namespaces()['vimstorm.pr.discussions']; return #vim.api.nvim_buf_get_extmarks(vim.api.nvim_win_get_buf(s.old_win), ns, 0, -1, {})]]) == 0)
  H.call("config.app.review", "threads", { { id = "T1", path = "blame.ts", side = "LEFT", line = 3, head = head,
    resolved = false, outdated = false, can_reply = false, can_resolve = true,
    reply_body = "Retained reply text", reply_unconfirmed = true, reply_error = "Response lost",
    comments = { { author = "ada", body = "Existing discussion" } } } })
  H.bridge_clear()
  local reply_action = H.lua([[
    local previous = vim.ui.select
    local selected
    vim.ui.select = function(items, _, callback) selected = items[2]; callback(items[2]) end
    local ok, err = pcall(require('config.app.review').next_unresolved)
    vim.ui.select = previous
    assert(ok, err)
    return selected
  ]])
  local f = answer("Retained reply text")
  local reply = H.wait_bridge("git_review", "reply")
  H.check("an unconfirmed reply reopens with retained text and its actual error", f.title == "Reconcile unconfirmed reply"
    and f.text == "Retained reply text" and f.dialog.text == "Response lost", vim.inspect(f))
  H.check("the original reply can be reconciled even after reply permission expires", reply_action == "Reconcile reply…"
    and reply and reply.thread == "T1" and reply.body == "Retained reply text", vim.inspect({ reply_action, reply }))
  H.call("config.app.review", "threads", {}, vim.NIL)

  -- the drafts waiting: their lines in the diff's description, on their side
  H.bridge_clear()
  H.call("config.app.review", "drafts", { { path = "blame.ts", side = "RIGHT", line = 3, body = "Guard this?", head = head },
    { path = "other.ts", side = "RIGHT", line = 1, body = "elsewhere" } })
  local desc = H.wait_bridge("diff", "viewer")
  H.check("a drafted line of the file shown is in its pane's description, the other file's not",
    desc and #desc.panes[2].drafts == 1 and desc.panes[2].drafts[1].line == 3
      and desc.panes[2].drafts[1].body == "Guard this?" and #desc.panes[1].drafts == 0, vim.inspect(desc and desc.panes))
  H.bridge_clear()
  H.call("config.app.review", "drafts", {})
  desc = H.wait_bridge("diff", "viewer")
  H.check("drafts gone: no mark", desc and #desc.panes[2].drafts == 0, vim.inspect(desc and desc.panes))

  H.bridge_clear()
  H.keys(",in")
  local n = H.wait_bridge("git_review", "next")
  H.check("`,in`: the next file by heat", n ~= nil, vim.inspect(review()))

  -- the diff's context menu lists the four with their keys
  H.bridge_clear()
  H.keys(H.KEY.cmd_enter)
  local menu = H.wait_menu()
  local keys = {}
  for _, it in ipairs(menu and menu.items or {}) do
    if it.label then keys[it.label] = it.key end
  end
  H.check("the PR diff's menu: comment, approve, request changes, comment review, next file by heat with keys",
    keys["Add Review Comment…"] == ",ic" and keys["Approve…"] == ",ia" and keys["Request Changes…"] == ",ir"
      and keys["Comment…"] == ",is" and keys["Next File by Heat"] == ",in", vim.inspect(keys))
  H.bridge_clear()
  H.menu_choose(menu, "Next File by Heat")
  H.check("a menu row does what its key does", H.wait_bridge("git_review", "next") ~= nil, vim.inspect(review()))

  -- closed: a split again, nothing
  H.call("git.diff", "close")
  H.wait_for(function() return H.lua("return require('git.diff').is_active()") ~= true end)
  H.bridge_clear()
  H.keys(",ia")
  H.keys(",in")
  H.settle(80, 1000)
  H.check("in a split the review keys send nothing", #review() == 0 and #H.bridge("popups", "input") == 0,
    vim.inspect(review()))
  H.check("`,rr` and `,re` still rename and move",
    H.lua("return vim.fn.maparg(',rr', 'n', false, true).desc") == "Rename symbol"
      and H.lua("return vim.fn.maparg(',re', 'n') ~= ''"),
    vim.inspect({ H.lua("return vim.fn.maparg(',rr', 'n', false, true).desc"), H.lua("return vim.fn.maparg(',re', 'n')") }))
end)
