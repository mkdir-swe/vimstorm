-- PR review in VimStorm's diff (ticket 24, decision 13, B1; 1.0: the PR is reviewed in the Git Log's PR
-- filter): the `,i` (inspect) maps, active only in a PR diff (git/diff.lua's state has `review`). `,ic` opens
-- the writing card under the caret's line (G21: the app draws it in the blank rows kept here, its field takes
-- the keyboard; ⏎ keeps a draft with the caret's line (or the selected lines) on its side, ⌘⏎ posts it now),
-- `,ip` the same card posting on ⏎; `,ia` / `,ir` / `,is` open the app's Submit review dialog
-- with Approve / Request changes / Comment picked (G19: the verdict, the summary, the drafts that go with it);
-- `,it` / `,iu` the discussions; `,in` the next file by heat. Each is also in the diff's context menu with its
-- key (git/diff.lua). Elsewhere they do nothing. Lines with a draft waiting get a comment mark in the diff's
-- native gutter (config/app/diff.lua puts them in the panes' description).
-- Keys typed right after `,ic` (before the card's field has the keyboard) are held (config/app/typeahead.lua,
-- surface "git_review"): never run in the diff, they go to the card once the app calls focused(token).
--
-- Lua -> Rust (`vimstorm.git_review`, app/src/git/window/review.rs): write {token, path, side, line, start_line?,
-- body, new, post_now, edit?} (the writing card opened), write_cancel {token} (its file left the diff), then
-- once the card is answered comment / post_now {path, side, line, start_line?, body, old, new} (old / new:
-- the diff's revisions) or edit {seq, body}; reply {thread, body}, resolve {thread, resolved}, submit
-- {verdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT"}, next, typeahead {token, keys}. Rust -> Lua:
-- focused(token) / done(token, text|nil, "draft" | "post") for the card, said(text, tone) once the review
-- core answered (a balloon), drafts(list) whenever the drafts waiting change ({path, side = "LEFT" |
-- "RIGHT", line, body}), threads(list, note), summary(saved review).
local bridge = require("config.app.bridge")

local M = {}

local function notify(payload) return bridge.notify("git_review", payload) end

-- The open PR diff's state, or nil
local function pr_diff()
  local s = require("git.diff").state()
  if s and s.review and vim.api.nvim_win_is_valid(s.new_win) and vim.api.nvim_win_is_valid(s.old_win) then
    return s
  end
end

M.pr_diff = pr_diff

local drafted = {} ---@type {seq: integer, path: string, side: "LEFT"|"RIGHT", line: integer, body: string, head?: string, outdated?: boolean}[]

local rows_told = {} ---@type table<string, integer> the rows the app measured a card needs, by its key

-- The writing card open (G21): where it writes and what ⏎ does with it; nil while none is
local writing = nil ---@type {token: integer, path: string, side: "LEFT"|"RIGHT", line: integer, start_line?: integer, old: string, new: string, post_now?: boolean, replaces?: integer, edit?: integer}?
local last_token = 0
local typeahead = require("config.app.typeahead")

-- Opens the writing card `w` under its line (one at a time: an open one is replaced)
local function start_writing(w, body)
  last_token = last_token + 1
  w.token = last_token
  writing = w
  rows_told.w = nil
  typeahead.hold("git_review")
  M.render_threads()
  pcall(function() require("config.app.diff").changed() end)
  local sent = notify({
    event = "write",
    token = w.token,
    path = w.path,
    side = w.side,
    line = w.line,
    start_line = w.start_line,
    body = body or "",
    new = w.new,
    post_now = w.post_now or false,
    edit = w.edit,
  })
  if not sent then typeahead.stop("git_review") end
end

-- `,ic` (normal / visual): the comment on the caret's line, or the lines selected, of the side it is on.
-- `opts` (an outdated draft card's Rewrite): its text to start from and the draft it replaces.
---@param post_now? boolean
---@param opts? {default?: string, replaces?: integer}
function M.comment(post_now, opts)
  opts = opts or {}
  local s = pr_diff()
  if not s then return end
  local win = vim.api.nvim_get_current_win()
  if win ~= s.old_win and win ~= s.new_win then return end
  local first, last = vim.fn.line("."), vim.fn.line(".")
  if vim.fn.mode():match("^[vV\22]") then
    first = vim.fn.line("v")
    first, last = math.min(first, last), math.max(first, last)
    vim.cmd("normal! \27")
  end
  local f = s.files[s.index]
  start_writing({
    path = f.path,
    side = win == s.old_win and "LEFT" or "RIGHT",
    line = last,
    start_line = first ~= last and first or nil,
    old = s.revs.old,
    new = s.revs.new,
    post_now = post_now,
    replaces = opts.replaces,
  }, opts.default)
end

-- The app gave the writing card's field the keyboard: the keys held since `,ic` go to it
---@param token integer
function M.focused(token)
  if writing and writing.token == token then typeahead.focused("git_review", token) end
end

-- The writing card answered: `text` kept as a draft ("draft"), posted now ("post"), or nil (Cancel / Esc)
---@param token integer
---@param text string|nil
---@param how? "draft"|"post"
function M.done(token, text, how)
  if text == vim.NIL then text = nil end
  local w = writing
  if not w or w.token ~= token then return end
  writing = nil
  typeahead.stop("git_review")
  M.render_threads()
  pcall(function() require("config.app.diff").changed() end)
  if not text or vim.trim(text) == "" then return end
  if w.edit then
    notify({ event = "edit", seq = w.edit, body = text })
    return
  end
  notify({
    event = how == "post" and "post_now" or "comment",
    path = w.path,
    side = w.side,
    line = w.line,
    start_line = w.start_line,
    body = text,
    old = w.old,
    new = w.new,
    replaces = how ~= "post" and w.replaces or nil,
  })
end

-- The writing card open, if any (tests)
function M.writing() return writing end

-- The caret on `line` of `side`'s pane (a card's action writes there)
local function to_line(s, side, line)
  local win = side == "LEFT" and s.old_win or s.new_win
  vim.api.nvim_set_current_win(win)
  local last = vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))
  vim.api.nvim_win_set_cursor(win, { math.max(1, math.min(line, last)), 0 })
end

-- A draft card's Edit draft: the writing card in its place with its text, the anchor kept
---@param seq integer
---@param body string
function M.edit(seq, body)
  local s = pr_diff()
  if not s then return end
  for _, d in ipairs(drafted) do
    if d.seq == seq then
      to_line(s, d.side, d.line)
      start_writing({ path = d.path, side = d.side, line = d.line, old = s.revs.old, new = s.revs.new, edit = seq }, body)
      return
    end
  end
end

-- An outdated draft card's Rewrite on line N: a new draft there from its text; the old one goes once the
-- new one is kept
---@param seq integer
---@param side "LEFT"|"RIGHT"
---@param line integer
---@param body string
function M.rewrite(seq, side, line, body)
  local s = pr_diff()
  if not s then return end
  to_line(s, side, line)
  M.comment(false, { default = body, replaces = seq })
end

-- A thread card's Reply…: the reply typed in the field
---@param id string
function M.reply(id)
  if not pr_diff() then return end
  vim.ui.input({ prompt = "Reply to discussion", placeholder = "⏎ posts your reply" }, function(text)
    if text and vim.trim(text) ~= "" then notify({ event = "reply", thread = id, body = text }) end
  end)
end

local saved_review = nil
function M.summary(value) saved_review = type(value) == "table" and value or nil end


-- `,ia` / `,ir` / `,is`: the app's Submit review dialog with that verdict picked (it holds the summary)
---@param verdict "APPROVE"|"REQUEST_CHANGES"|"COMMENT"
function M.verdict(verdict)
  if not pr_diff() then return end
  notify({ event = "submit", verdict = verdict })
end

-- The drafts waiting (Rust, whenever they change): their lines get the gutter's comment mark
---@param list {path: string, side: "LEFT"|"RIGHT", line: integer, body: string}[]
function M.drafts(list)
  drafted = type(list) == "table" and list or {}
  M.render_threads()
  pcall(function() require("config.app.diff").changed() end)
end

-- The drafted lines of `path` on `side`, as the diff's panes describe them
---@param path string
---@param side "LEFT"|"RIGHT"
---@return {line: integer, body: string}[]
function M.drafted(path, side)
  local out = {}
  for _, d in ipairs(drafted) do
    local s = pr_diff()
    if d.path == path and d.side == side and not d.outdated and s and d.head == s.revs.new then out[#out + 1] = { line = d.line, body = d.body } end
  end
  table.sort(out, function(a, b) return a.line < b.line end)
  return out
end

-- `,in`: the next file not reviewed, by heat (the Log's PR files open it here)
function M.next()
  if pr_diff() then notify({ event = "next" }) end
end

-- What the review core said about a draft or a review: a balloon
---@param text string
---@param tone "info"|"ok"|"warn"|"error"
function M.said(text, tone)
  local level = ({ warn = vim.log.levels.WARN, error = vim.log.levels.ERROR })[tone] or vim.log.levels.INFO
  local s = pr_diff()
  vim.notify(text, level, { title = s and ("PR #%d"):format(s.review.pr) or "PR review" })
end


-- Posted threads are separate from pending local review comments. Keep provider anchors intact.
local posted, threads_note = {}, "Loading discussions…"
local thread_ns = vim.api.nvim_create_namespace("vimstorm.pr.discussions")

-- Only Abe's exact trailing receipt paragraphs are hidden. Keep provider bodies untouched.
local function display_body(body)
  local hash = string.rep("%x", 14)
  for _, marker in ipairs({
    "<!%-%- vimstorm:comment:" .. hash .. " %-%->",
    "<!%-%- vimstorm:reply:" .. hash .. " %-%->",
    "<!%-%- vimstorm%-review%-v1:" .. hash .. ":" .. hash .. " %-%->",
  }) do
    body = body:gsub("\n\n" .. marker .. "$", ""):gsub("^" .. marker .. "$", "")
  end
  return body
end

-- Rows a card needs at `width` cells: its head, each text line wrapped (+ a byline per comment), its actions
local function card_rows(texts, width, bylines)
  -- head and insets, then the actions row (its buttons wrap in a narrow pane: ~42 cells of them)
  local rows = 2 + math.ceil(42 / math.max(20, width)) + (bylines and #texts or 0)
  for _, t in ipairs(texts) do
    for _, l in ipairs(vim.split(t, "\n", { plain = true })) do
      rows = rows + math.max(1, math.ceil(vim.fn.strdisplaywidth(l) / math.max(20, width)))
    end
  end
  return rows
end

local cards = { LEFT = {}, RIGHT = {} } ---@type table<string, table[]>

-- The app measured a card (its text wrapped at the pane's width): it needs `rows` rows
---@param key string `t:<thread id>` / `d:<draft seq>`
---@param rows integer
function M.card_rows(key, rows)
  if rows_told[key] == rows then return end
  rows_told[key] = rows
  M.render_threads()
  pcall(function() require("config.app.diff").changed() end)
end

-- The cards of the file shown (G15 / G22): each posted thread and each draft gets blank rows under its line
-- (and as many under the line it maps to in the other pane, so the panes stay level); the app draws the card
-- there. Threads anchored on another revision and resolved ones keep only their gutter mark.
function M.render_threads()
  local s = pr_diff()
  if not s then return end
  local f = s.files[s.index]
  cards = { LEFT = {}, RIGHT = {} }
  for _, t in ipairs(posted) do
    if t.path == f.path and t.line and not t.outdated and t.head == s.revs.new then
      local texts = vim.tbl_map(function(c) return display_body(c.body) end, t.comments)
      table.insert(cards[t.side], { kind = "thread", id = t.id, key = "t:" .. t.id, line = t.line, texts = texts,
        bylines = true, resolved = t.resolved })
    end
  end
  -- drafts are on the PR's head: shown in its diff (all changes), not in one commit's
  local on_head = s.review.head == nil or s.review.head == s.revs.new
  for _, d in ipairs(drafted) do
    -- a draft being edited: the writing card takes its place
    local editing = writing and writing.edit == d.seq
    if on_head and d.path == f.path and d.seq and not editing then
      table.insert(cards[d.side], { kind = d.outdated and "outdated" or "draft", seq = d.seq, key = "d:" .. d.seq,
        line = d.line, texts = { d.body } })
    end
  end
  -- the writing card (G21) under its line; it left the diff with its file: cancelled
  if writing and (writing.path ~= f.path or writing.new ~= s.revs.new) then
    local token = writing.token
    writing = nil
    typeahead.stop("git_review")
    notify({ event = "write_cancel", token = token })
  end
  if writing then
    table.insert(cards[writing.side], { kind = "writing", key = "w", token = writing.token, line = writing.line,
      rows = rows_told.w or 7 })
  end
  local wins = { LEFT = s.old_win, RIGHT = s.new_win }
  for _, side in ipairs({ "LEFT", "RIGHT" }) do
    vim.api.nvim_buf_clear_namespace(vim.api.nvim_win_get_buf(wins[side]), thread_ns, 0, -1)
  end
  local scrollsync = require("git.scrollsync")
  for _, side in ipairs({ "LEFT", "RIGHT" }) do
    local list = cards[side]
    local win, other = wins[side], wins[side == "LEFT" and "RIGHT" or "LEFT"]
    local buf, obuf = vim.api.nvim_win_get_buf(win), vim.api.nvim_win_get_buf(other)
    -- winwidth: the grid the app drew the pane at (narrower with the Chat column, #213); nvim_win_get_width stays
    -- the window's logical width
    local width = vim.fn.winwidth(win) - 10
    local changes = scrollsync.win_changes(win, other)
    for _, c in ipairs(list) do
      c.rows = rows_told[c.key] or c.rows or card_rows(c.texts, width, c.bylines)
      local blank = {}
      for i = 1, c.rows do blank[i] = { { "", "" } } end
      if c.line >= 1 and c.line <= vim.api.nvim_buf_line_count(buf) then
        vim.api.nvim_buf_set_extmark(buf, thread_ns, c.line - 1, 0, { virt_lines = blank })
        local mapped = math.min(scrollsync.map(c.line, changes), vim.api.nvim_buf_line_count(obuf))
        vim.api.nvim_buf_set_extmark(obuf, thread_ns, mapped - 1, 0, { virt_lines = blank })
      end
    end
  end
end

-- The cards on `side` of the file shown, for the diff's description: {kind, line, rows, id? | seq?}
---@param side "LEFT"|"RIGHT"
function M.cards(side)
  local out = {}
  for _, c in ipairs(cards[side] or {}) do
    out[#out + 1] = { kind = c.kind, line = c.line, rows = c.rows, id = c.id, seq = c.seq, token = c.token }
  end
  return out
end

function M.threads(list, note)
  posted = type(list) == "table" and list or {}
  threads_note = type(note) == "string" and note or nil
  M.render_threads()
  pcall(function() require("config.app.diff").changed() end)
end

local function show_thread(t)
  local s = pr_diff()
  if not s then return end
  if t.line and not t.outdated and t.head == s.revs.new then
    local file = vim.iter(s.files):find(function(f) return f.path == t.path end)
    if file then require("git.diff").open(s.files, file, s.revs, s.review) end
    s = pr_diff()
    local win = t.side == "LEFT" and s.old_win or s.new_win
    vim.api.nvim_set_current_win(win)
    local last = vim.api.nvim_buf_line_count(vim.api.nvim_win_get_buf(win))
    vim.api.nvim_win_set_cursor(win, { math.min(t.line, last), 0 })
    M.render_threads()
  end
  local actions = { "Read discussion" }
  local reply_action = t.reply_unconfirmed and "Reconcile reply…" or t.reply_body and "Retry reply…" or "Reply…"
  if t.can_reply or t.reply_body then actions[#actions + 1] = reply_action end
  if t.can_resolve then actions[#actions + 1] = t.resolved and "Reopen discussion" or "Resolve discussion" end
  vim.ui.select(actions, { prompt = t.path .. (t.line and (":" .. t.line) or "") .. (t.outdated and " · outdated anchor" or "") }, function(action)
    if action == "Read discussion" then
      local lines = {}
      for _, c in ipairs(t.comments) do lines[#lines + 1] = c.author .. ": " .. display_body(c.body) end
      vim.notify(table.concat(lines, "\n\n"), vim.log.levels.INFO, { title = "PR discussion" })
    elseif action == reply_action then
      vim.ui.input({
        prompt = t.reply_unconfirmed and "Reconcile unconfirmed reply" or "Reply to discussion",
        default = t.reply_body,
        placeholder = "⏎ posts your reply",
        dialog = t.reply_body and {
          text = t.reply_error or (t.reply_unconfirmed and "Retained reply: retry only checks GitHub for its receipt" or "Retained reply: edit it or retry"),
          hints = t.reply_unconfirmed and "⏎ reconcile original text · Esc cancel" or "⏎ post · Esc cancel",
        } or nil,
      }, function(text)
        if text and vim.trim(text) ~= "" then notify({ event = "reply", thread = t.id, body = text }) end
      end)
    elseif action then notify({ event = "resolve", thread = t.id, resolved = not t.resolved }) end
  end)
end

function M.discussions()
  if not pr_diff() then return end
  if threads_note then vim.notify(threads_note, vim.log.levels.WARN); return end
  if #posted == 0 then vim.notify("No posted discussions"); return end
  vim.ui.select(posted, { prompt = "PR discussions", format_item = function(t)
    return (t.resolved and "✓ " or "● ") .. t.path .. (t.line and (":" .. t.line) or "") .. (t.outdated and " · outdated" or "")
  end }, function(t) if t then show_thread(t) end end)
end

local unresolved_at = 0
function M.next_unresolved()
  if not pr_diff() then return end
  if threads_note then vim.notify(threads_note, vim.log.levels.WARN); return end
  local unresolved = vim.tbl_filter(function(t) return not t.resolved end, posted)
  if #unresolved == 0 then vim.notify("No unresolved discussions"); return end
  unresolved_at = unresolved_at % #unresolved + 1
  show_thread(unresolved[unresolved_at])
end

-- Submit review from the diff: the dialog with the verdict saved before (else Comment)
function M.submit()
  if pr_diff() then notify({ event = "submit" }) end
end

-- The PR diff's context menu rows (git/diff.lua puts them first)
---@return MenuEntry[]
function M.menu_items()
  return {
    { "Add Review Comment…", function() M.comment(false) end, key = ",ic" },
    { "Post Comment Now…", function() M.comment(true) end, key = ",ip" },
    { "Discussions…", M.discussions, key = ",it" },
    { "Next Unresolved Discussion", M.next_unresolved, key = ",iu" },
    { "Approve…", function() M.verdict("APPROVE") end, key = ",ia" },
    { "Request Changes…", function() M.verdict("REQUEST_CHANGES") end, key = ",ir" },
    { "Comment…", function() M.verdict("COMMENT") end, key = ",is" },
    { "Submit Review…", M.submit },
    { "Next File by Heat", M.next, key = ",in" },
  }
end

function M.setup()
  local map = vim.keymap.set
  map({ "n", "x" }, "<leader>ic", function() M.comment(false) end, { desc = "PR review: comment on the line" })
  map({ "n", "x" }, "<leader>ip", function() M.comment(true) end, { desc = "PR review: post comment now" })
  map("n", "<leader>it", M.discussions, { desc = "PR review: discussions" })
  map("n", "<leader>iu", M.next_unresolved, { desc = "PR review: next unresolved discussion" })
  map("n", "<leader>ia", function() M.verdict("APPROVE") end, { desc = "PR review: approve" })
  map("n", "<leader>ir", function() M.verdict("REQUEST_CHANGES") end, { desc = "PR review: request changes" })
  map("n", "<leader>is", function() M.verdict("COMMENT") end, { desc = "PR review: send as a comment" })
  map("n", "<leader>in", M.next, { desc = "PR review: next file by heat" })
end

return M
