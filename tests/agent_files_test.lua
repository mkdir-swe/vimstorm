-- Real files changed by another process while the native editor owns clean/dirty buffers. Never locked: the buffer
-- stays editable, a save waits for a choice without a prompt, and a conflict record never breaks opening a file.
local H = dofile(os.getenv("NVT_HARNESS"))
local DIR = H.project("agent-files", { ["race.txt"] = { "original" }, ["other.txt"] = { "other" }, ["gone.txt"] = { "gone" }, ["notes.md"] = { "# Notes" },
  ["deleted.txt"] = { "deleted" }, ["only.txt"] = { "only" }, ["back.txt"] = { "back" }, ["same.txt"] = { "same" },
  ["undone.txt"] = { "undone" }, ["dirty-deleted.txt"] = { "dirty" } })
local function ro(b) return H.lua(("return vim.bo[%d].readonly"):format(b)) end
local function prompt_free()
  local m = H.lua("return vim.api.nvim_get_mode()")
  return m ~= nil and m.blocking == false and m.mode == "n"
end
local function disk(name) return vim.fn.readfile(DIR .. "/" .. name)[1] end
H.run(function()
  H.start(DIR, { "race.txt" })
  vim.fn.writefile({ "clean external change" }, DIR .. "/race.txt")
  H.expect("clean agent changes reload without discarding editor work", function()
    return H.line(1) == "clean external change"
  end, function() return H.line(1) end)
  H.lua("vim.cmd.edit(...)", { DIR .. "/notes.md" })
  H.settle(200, 2000)
  H.lua("vim.v.errmsg = ''")
  vim.fn.writefile({ "# Notes changed" }, DIR .. "/notes.md")
  H.expect("a markdown file reloads too", function() return H.line(1) == "# Notes changed" end)
  H.check("its reload leaves no E31 behind (markdown's undo_ftplugin)", H.lua("return vim.v.errmsg") == "", H.lua("return vim.v.errmsg"))
  H.lua("vim.cmd.edit(...)", { DIR .. "/race.txt" })

  H.lua("vim.api.nvim_buf_set_lines(0,0,-1,false,{'unsaved editor version'})")
  local buffer = H.lua("return vim.api.nvim_get_current_buf()")
  H.bridge_clear()
  vim.fn.writefile({ "agent wrote a different version" }, DIR .. "/race.txt")
  -- This is the same public save path the instruction queue invokes before delivery.
  local unsaved = H.call("config.app.toolbar", "switch_check")
  H.check("failed save reports an unsaved buffer to the instruction queue", unsaved and unsaved.unsaved == 1, unsaved)
  H.check("dirty editor version is preserved", H.line(1) == "unsaved editor version", H.line(1))
  H.check("external disk version is preserved", disk("race.txt") == "agent wrote a different version")
  local conflict = H.call("config.app.agent_files", "conflict", buffer)
  H.check("both conflict versions have retained snapshots", conflict and vim.fn.filereadable(conflict.disk) == 1 and vim.fn.filereadable(conflict.editor) == 1, conflict)
  H.check("the conflicted buffer is never readonly", ro(buffer) == false and H.lua("return vim.bo.modifiable") == true)
  local said = H.wait_bridge("popups", "balloon", function(p) return p.id == "abe-conflict-" .. buffer end, 3000)
  H.check("a balloon names the choices, with a Resolve… link, until resolved",
    said and said.msg:find("Keep editor version", 1, true) and said.msg:find("Use disk version", 1, true)
      and said.msg:find("Compare with disk", 1, true) and said.action == "Resolve…" and said.timeout == 0, said)
  H.keys("A typed<Esc>")
  H.check("typing in it works: no W10, no prompt", prompt_free() and H.line(1) == "unsaved editor version typed"
    and (H.lua("return vim.v.warningmsg") or ""):find("W10") == nil, { H.line(1), H.lua("return vim.v.warningmsg") })
  H.keys("<D-s>")
  H.check("⌘S never prompts", prompt_free(), H.lua("return vim.api.nvim_get_mode()"))
  H.check("⌘S never overwrites the agent's version", disk("race.txt") == "agent wrote a different version", disk("race.txt"))
  H.check("the edits stay unsaved in the buffer", H.lua("return vim.bo.modified") == true)
  H.lua("vim.cmd('silent! write')")
  H.check(":w is held too, without a prompt", prompt_free() and disk("race.txt") == "agent wrote a different version")
  H.app_focus(false)
  H.app_focus(true)
  H.lua("vim.cmd('silent! checktime')")
  H.check("autosave and nvim's own file check leave it as it is, no prompt", prompt_free()
    and disk("race.txt") == "agent wrote a different version" and H.lua("return vim.bo.modified") == true)
  H.check("the record holds the newest edits", vim.fn.readfile(conflict.editor)[1] == "unsaved editor version typed")
  H.call("config.editor_tabs", "close", buffer)
  H.settle(100, 1000)
  local tabs = H.lua("return require('config.editor_tabs').tabs()") or {}
  H.check("closing its tab keeps it open, where it was", H.lua("return vim.api.nvim_get_current_buf()") == buffer
    and tabs[1] == buffer, tabs)

  H.restart(DIR, { "race.txt" })
  buffer = H.lua("return vim.api.nvim_get_current_buf()")
  H.check("restart opens it without a prompt", prompt_free(), H.lua("return vim.api.nvim_get_mode()"))
  H.check("restart recovers the unsaved editor version alongside external disk", H.line(1) == "unsaved editor version typed", H.line(1))
  H.check("restart retains the disk version untouched", disk("race.txt") == "agent wrote a different version")
  H.check("the recovered buffer is editable, not readonly", ro(buffer) == false and H.lua("return vim.bo.modified") == true)
  conflict = H.call("config.app.agent_files", "conflict", buffer)
  H.call("config.app.agent_files", "compare", buffer)
  H.expect("Compare opens the native editor diff without changing either version", function()
    return H.lua("local n=0 for _,w in ipairs(vim.api.nvim_list_wins()) do if vim.wo[w].diff then n=n+1 end end return n") == 2
  end)
  -- W-25: the native diff viewer (git/diff.lua), the disk version left, the editor's right
  H.check("the native diff viewer shows the conflict", H.lua("return require('git.diff').is_active()") == true)
  local described = H.wait_bridge("diff", nil, function(p) return p.panes ~= nil end)
  local panes = described and { described.panes[1].title.text, described.panes[2].title.text }
  H.check("its panes name the disk and the editor version",
    panes and panes[1] == "On disk (changed outside the editor)" and panes[2] == "Editor (unsaved)", panes)
  H.check("the left pane is the agent's disk version", H.lua([[local s = require('git.diff').state()
    return vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(s.old_win), 0, 1, false)[1] ]]) == "agent wrote a different version")
  local items = H.lua([[local s = require('git.diff').state() local out = {}
    for _, i in ipairs(require('git.diff').menu_items(s.new_win) or {}) do if type(i) == "table" then out[#out+1] = i[1] end end
    return out]])
  H.check("its menu leads with the resolutions", type(items) == "table" and items[1] == "Keep editor version (overwrite disk)" and items[2] == "Use disk version", items)
  H.check("the comparison still retains editor text", H.lua(("return vim.api.nvim_buf_get_lines(%d,0,1,false)[1]"):format(buffer)) == "unsaved editor version typed")
  H.call("config.app.agent_files", "keep_editor", buffer)
  H.expect("explicit Keep editor version writes the user's chosen resolution", function()
    return disk("race.txt") == "unsaved editor version typed"
  end)
  H.check("the external version stays available after resolution", conflict and vim.fn.readfile(conflict.disk)[1] == "agent wrote a different version")
  H.check("resolved buffer can save normally again", H.lua(("return not vim.bo[%d].modified and not vim.bo[%d].readonly"):format(buffer,buffer)) == true)
  H.check("its balloon is gone", H.last("popups", "balloon_hide", function(p) return p.id == "abe-conflict-" .. buffer end) ~= nil)

  -- stale records never replay: its buffer closed, or a later run of the project without the file open
  local function conflicted() return H.lua("return require('config.app.agent_files').conflict() ~= nil") end
  H.lua("vim.cmd.edit(...)", { DIR .. "/other.txt" })
  H.lua("vim.api.nvim_buf_set_lines(0,0,-1,false,{'my other'})")
  vim.fn.writefile({ "agent other" }, DIR .. "/other.txt")
  H.expect("a second conflict", conflicted)
  H.lua("vim.cmd('bwipeout!')")
  H.lua("vim.cmd.edit(...)", { DIR .. "/gone.txt" })
  H.lua("vim.api.nvim_buf_set_lines(0,0,-1,false,{'my gone'})")
  vim.fn.writefile({ "agent gone" }, DIR .. "/gone.txt")
  H.expect("a third conflict", conflicted)
  H.restart(DIR, { "race.txt" }) -- gone.txt's edits carried, but this run never opens it
  H.restart(DIR, { "race.txt" })
  H.lua("vim.cmd.edit(...)", { DIR .. "/other.txt" })
  H.check("a closed conflicted buffer's record never comes back", prompt_free() and H.line(1) == "agent other"
    and H.lua("return not vim.bo.modified and not vim.bo.readonly") == true, H.line(1))
  H.lua("vim.cmd.edit(...)", { DIR .. "/gone.txt" })
  H.check("nor one older than the project's last run", prompt_free() and H.line(1) == "agent gone"
    and H.lua("return not vim.bo.modified and not vim.bo.readonly") == true, H.line(1))

  -- deleted on disk (WebStorm): a clean buffer's tab just closes, once still missing a check later; back by
  -- then (a rewrite, git checkout), it reloads; one with unsaved edits is a conflict
  local function buf_of(name) return H.lua("return vim.fn.bufnr(...)", { DIR .. "/" .. name }) end
  local function listed(b) return H.lua("return vim.fn.buflisted(...) == 1", { b }) end
  local function conflict_balloon(b)
    return H.last("popups", "balloon", function(p) return p.id == "abe-conflict-" .. b end)
  end
  H.lua("vim.cmd.edit(...)", { DIR .. "/race.txt" })
  H.lua("vim.cmd.edit(...)", { DIR .. "/deleted.txt" })
  local race, deleted = buf_of("race.txt"), buf_of("deleted.txt")
  H.bridge_clear()
  os.remove(DIR .. "/deleted.txt")
  H.expect("a clean file deleted on disk: its tab closes", function() return not listed(deleted) end, nil, 5000)
  H.check("its left neighbour is the active tab", H.lua("return vim.api.nvim_get_current_buf()") == race
    and not vim.tbl_contains(H.lua("return require('config.editor_tabs').tabs()") or {}, deleted),
    H.lua("return require('config.editor_tabs').tabs()"))
  H.check("no balloon, no conflict, no prompt", conflict_balloon(deleted) == nil and prompt_free()
    and H.call("config.app.agent_files", "conflict", deleted) == nil, conflict_balloon(deleted))

  H.lua("vim.cmd.edit(...)", { DIR .. "/only.txt" })
  local only = buf_of("only.txt")
  H.call("config.editor_tabs", "close_others", only)
  H.settle(100, 1000)
  os.remove(DIR .. "/only.txt")
  H.expect("the last tab's file deleted: the empty editor, as closing the last tab", function()
    return not listed(only) and H.lua("return require('config.empty_editor').is_empty(vim.api.nvim_get_current_buf())") == true
  end, function() return H.lua("return require('config.editor_tabs').tabs()") end, 5000)

  H.lua("vim.cmd.edit(...)", { DIR .. "/back.txt" })
  local back = buf_of("back.txt")
  H.bridge_clear()
  os.remove(DIR .. "/back.txt")
  H.call("config.app.agent_files", "before_save_all") -- (a check sees it missing)
  vim.fn.writefile({ "back again" }, DIR .. "/back.txt")
  H.expect("deleted and recreated within the grace: it reloads", function() return H.line(1) == "back again" end)
  H.settle(1500, 3000)
  H.check("and its tab stays, no balloon", listed(back) and H.lua("return vim.api.nvim_get_current_buf()") == back
    and conflict_balloon(back) == nil and H.lua("return vim.bo.modified") == false)

  -- modified without an edit (a formatter's no-op, a change typed back): an agent's change reloads it
  H.lua("vim.cmd.edit(...)", { DIR .. "/same.txt" })
  local same = buf_of("same.txt")
  H.lua("vim.api.nvim_buf_set_lines(0,0,-1,false,{'same'})")
  H.check("(marked modified)", H.lua("return vim.bo.modified") == true)
  vim.fn.writefile({ "agent same" }, DIR .. "/same.txt")
  H.expect("modified, the text as read: an agent's change reloads, no conflict", function()
    return H.line(1) == "agent same" and H.lua("return vim.bo.modified") == false
  end, function() return { H.line(1), H.call("config.app.agent_files", "conflict", same) } end)
  H.check("no conflict record", H.call("config.app.agent_files", "conflict", same) == nil)
  -- (a save that would prompt runs later, so a prompt fails the check instead of blocking the test)
  local function save_later() H.lua("vim.schedule(function() pcall(vim.cmd, 'silent write') end)") H.settle(200, 2000) end
  vim.fn.writefile({ "agent same" }, DIR .. "/same.txt") -- the same text written again
  H.call("config.app.agent_files", "before_save_all")
  H.lua("vim.api.nvim_buf_set_lines(0,0,-1,false,{'my same'})")
  save_later()
  H.check("the same text written again on disk: a later save asks nothing (Vim's changed-since-reading)",
    prompt_free() and disk("same.txt") == "my same", { H.lua("return vim.api.nvim_get_mode()"), disk("same.txt") })

  -- a conflict whose file comes back as the edits' start is over (the edits stay unsaved)
  H.lua("vim.cmd.edit(...)", { DIR .. "/undone.txt" })
  local undone = buf_of("undone.txt")
  H.lua("vim.api.nvim_buf_set_lines(0,0,-1,false,{'my undone'})")
  vim.fn.writefile({ "agent undone" }, DIR .. "/undone.txt")
  H.expect("(a conflict)", function() return H.call("config.app.agent_files", "conflict", undone) ~= nil end)
  vim.fn.writefile({ "undone" }, DIR .. "/undone.txt")
  H.expect("the file back as it was: the conflict is over", function()
    return H.call("config.app.agent_files", "conflict", undone) == nil
  end)
  H.check("its edits stay, unsaved", H.line(1) == "my undone" and H.lua("return vim.bo.modified") == true)
  save_later()
  H.check("and save normally, no prompt", prompt_free() and disk("undone.txt") == "my undone")

  H.lua("vim.cmd.edit(...)", { DIR .. "/dirty-deleted.txt" })
  local dirty = buf_of("dirty-deleted.txt")
  H.lua("vim.api.nvim_buf_set_lines(0,0,-1,false,{'my dirty'})")
  H.bridge_clear()
  os.remove(DIR .. "/dirty-deleted.txt")
  local warned = H.wait_bridge("popups", "balloon", function(p) return p.id == "abe-conflict-" .. dirty end, 3000)
  H.check("unsaved edits and the file deleted: a conflict, its balloon says so",
    warned and warned.msg:find("was deleted on disk while you had unsaved edits", 1, true), warned)
  local held = H.call("config.app.agent_files", "conflict", dirty)
  H.check("the record knows it was deleted", held and held.deleted == true, held)
  H.settle(1500, 3000)
  H.check("its tab stays, the edits too", listed(dirty) and H.line(1) == "my dirty"
    and vim.fn.filereadable(DIR .. "/dirty-deleted.txt") == 0)
  H.call("config.app.agent_files", "keep_editor", dirty)
  H.expect("Keep editor version writes it back", function() return vim.fn.filereadable(DIR .. "/dirty-deleted.txt") == 1
    and disk("dirty-deleted.txt") == "my dirty" end)
end)
