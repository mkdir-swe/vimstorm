-- Speed budgets of the Lua engine (the app's own budgets: app/tests/perf.rs, git_log_perf.rs): headless
-- startup, hot paths the app calls on every redraw / drawn line (status bar data, bookmark gutter cell), key ->
-- frame latency of Lua-heavy keys in a big TSX file (caret, Cmd+W, ,s / ,S, a 19k-line selection), opening
-- files, the diff viewer on a big file and the terminal session layout.
-- Budgets are checked on the median of several samples (H.samples / H.budget) and are generous: the suite runs
-- next to other nvims on a loaded machine, so they catch 3-10x regressions, not milliseconds. Each budget says
-- what it guards and the medians measured when it was set (idle machine / loaded by parallel test runs).
-- Key-to-frame latency = from nvim reading the key (vim.on_key) to the end of the first redraw that shows its
-- effect (decoration provider on_end), measured inside the nested nvim (the harness is its UI, as the app is),
-- so RPC lag doesn't count.
local H = dofile(os.getenv("NVT_HARNESS"))
local K = H.KEY

-- Project ----------------------------------------------------------------------------------------------------
-- A big realistic TSX file (types, hooks, JSX, JSDoc, regex): ~3000 lines
local BLOCK = [[
/**
 * Props of the row %d.
 * @see Details
 */
export interface RowProps%d {
  id: string;
  label?: string;
  onSelect: (id: string, index: number) => void;
}

const pattern%d = /^[a-z]+-%d$/i;

export function useRow%d({ id, label, onSelect }: RowProps%d) {
  const [open, setOpen] = useState<boolean>(false);
  const name = useMemo(() => (label ?? id).trim().replace(pattern%d, ""), [label, id]);
  useEffect(() => {
    if (!open) return;
    console.log(`row ${name} opened`, { id, index: %d });
  }, [open, name, id]);
  return { open, toggle: () => setOpen((o) => !o), name, select: () => onSelect(id, %d) };
}

export const Row%d = (props: RowProps%d) => {
  const { open, toggle, name } = useRow%d(props);
  return (
    <div className="row" data-open={open} onClick={toggle}>
      <span title={name}>{name}</span>
      {open && <Details id={props.id} />}
    </div>
  );
};
]]
local function tsx(blocks)
  local out = { 'import { useEffect, useMemo, useState } from "react";', 'import { Details } from "./Details";', "" }
  for i = 1, blocks do vim.list_extend(out, vim.split((BLOCK:gsub("%%d", tostring(i))), "\n")) end
  return out
end
-- n lines of code; with `changed`, every `every`-th line differs (the working tree version)
local function code(n, every, changed)
  local out = {}
  for i = 1, n do
    out[i] = (changed and i % every == 0) and ("export const v%d = %d * 2; // changed"):format(i, i)
      or ("export const v%d = %d;"):format(i, i)
  end
  return out
end

local files = {
  ["src/Big.tsx"] = tsx(100),
  ["src/diff.ts"] = code(2000, 50),
  ["src/long.ts"] = code(20000, 100),
  ["src/huge.txt"] = code(100000, 100),
  ["a.ts"] = { "export const a = 1;", "export function add(x: number, y: number): number {", "  return x + y;", "}" },
  ["b.ts"] = { "export const b = 2;" },
  ["package.json"] = '{ "name": "perf" }',
}
for i = 1, 10 do -- (10 Small files: a resampled "open another TSX file" opens new ones too)
  files[("src/Small%d.tsx"):format(i)] = tsx(3)
  files[("doc%d.md"):format(i)] = { "# Doc " .. i, "", "Some *text* with `code`.", "", "- one", "- two", "",
    "```ts", "const x = 1;", "```" }
end
local DIR = H.project("perf", files, { git = true })
-- the diff viewer's files: changed in the working tree
vim.fn.writefile(code(2000, 50, true), DIR .. "/src/diff.ts")
vim.fn.writefile(code(20000, 100, true), DIR .. "/src/long.ts")
vim.fn.writefile(code(100000, 100, true), DIR .. "/src/huge.txt")

-- Helpers ----------------------------------------------------------------------------------------------------

-- Nested nvim: key -> end of the first redraw that shows its effect. perf_lat.arm(before, done): the next key
-- starts the clock (before() snapshots state then), the first redraw end where done(snapshot) holds stops it.
local LATENCY = [[
  local L = { wall = {}, cpu = {} }
  _G.perf_lat = L
  local ns = vim.api.nvim_create_namespace('perf_test_latency')
  function L.arm(before, done) L.before, L.done, L.t, L.armed = before, done, nil, true end
  vim.on_key(function()
    if L.armed and not L.t then
      L.t, L.c = vim.uv.hrtime(), os.clock()
      local ok, s = pcall(L.before or function() end)
      L.snap = ok and s or nil
    end
  end, ns)
  vim.api.nvim_set_decoration_provider(ns, { on_end = function()
    if not L.t then return end
    local ok, done = pcall(L.done or function() return true end, L.snap)
    if ok and done then
      L.wall[#L.wall + 1] = (vim.uv.hrtime() - L.t) / 1e6
      L.cpu[#L.cpu + 1] = (os.clock() - L.c) * 1e3 -- CPU time of nvim: no waiting for a loaded machine's cores
      L.t, L.armed = nil, false
    end
  end })
]]

-- Key-to-frame latency of n presses (ms): wall and CPU sample lists. o.key: nvim notation or fn(i) (a whole
-- mapping, e.g. ",s": the clock starts at its first key); o.before / o.done: Lua bodies run in the nested nvim
-- (done gets the before value as s); o.prep(i) / o.after(i): before each press / after its frame; o.warm:
-- presses not counted (default 1).
local function latency(n, o)
  local warm = o.warm or 1
  H.lua("perf_lat.wall, perf_lat.cpu = {}, {}")
  for i = 1, n + warm do
    if o.prep then o.prep(i) end
    H.lua(("perf_lat.arm(function() %s end, function(s) %s end)"):format(o.before or "", o.done or "return true"))
    H.keys(type(o.key) == "function" and o.key(i) or o.key, 1) -- no settle: the clock runs in nvim
    if not H.wait_for("perf_lat.armed == false", 3000) then H.lua("perf_lat.armed, perf_lat.t = false, nil") end
    if o.after then o.after(i) end
    H.settle(o.gap or 40, 1500) -- the key's late work (async renders, LSP) done before the next one
  end
  local r = H.lua("return { perf_lat.wall, perf_lat.cpu }") or { {}, {} }
  local s = math.min(warm, #r[1]) + 1
  return vim.list_slice(r[1], s), vim.list_slice(r[2], s)
end

-- Median µs of a Lua body run n times in the nested nvim (after one warm-up run)
local function us(body, n)
  return H.lua(([[
    local f = function() %s end
    f()
    local s = {}
    for i = 1, %d do
      local t = vim.uv.hrtime()
      f()
      s[i] = (vim.uv.hrtime() - t) / 1e3
    end
    table.sort(s)
    return s[math.ceil(#s / 2)] ]]):format(body, n or 200)) or math.huge
end
-- H.budget prints whole ms: µs budgets get their own line format
local function us_budget(name, value, limit)
  return H.check(("%s: median %.1fµs (budget %dµs)"):format(name, value, limit), value <= limit)
end

-- ms of a Lua body in the nested nvim, redraw included
local function timed(body)
  return H.lua("local t = vim.uv.hrtime() " .. body .. " vim.cmd.redraw() return (vim.uv.hrtime() - t) / 1e6") or math.huge
end

local function median(list)
  local s = vim.deepcopy(list)
  table.sort(s)
  return s[math.ceil(#s / 2)] or math.huge
end

-- H.budget on sample(), measured again after a cooldown when it misses (a loaded / throttled machine)
local function budget(name, limit, sample)
  return H.budget(name, sample(), limit, sample)
end

H.run(function()
  -- a heavy run just before (cargo, another suite) throttles the wall-time budgets: wait for the load to drop
  H.cooldown()
  -- Startup ---------------------------------------------------------------------------------------------------
  -- Without a UI (everything before the first screen), app mode, with the big TSX file: ~90 ms idle, ~100 loaded.
  -- (Startup with the UI to the first editor frame: app/tests/perf.rs::frames::startup_to_first_editor_frame.)
  local log = H.fixtures .. "/perf-startup.log"
  budget("startup with a big TSX file (headless)", 250, function()
    return H.samples(function()
      os.remove(log)
      vim.system({ "nvim", "--headless", "--cmd", "let g:vimstorm_app = 1", "--startuptime", log, "src/Big.tsx", "+qa" },
        { cwd = DIR, env = H.env(H.fixtures .. "/state-perf") }):wait(10000)
      if vim.fn.filereadable(log) == 0 then return math.huge end
      return tonumber(table.concat(vim.fn.readfile(log), "\n"):match("([%d.]+)%s+[%d.]+: %-%-%- NVIM STARTED")) or math.huge
    end, 5)
  end)

  H.start(DIR, { "src/Big.tsx" }, { size = { 255, 65 } })
  H.lua(LATENCY)
  H.wait_for("package.loaded.gitsigns ~= nil", 5000)

  -- Hot paths (run on every redraw / drawn line) ---------------------------------------------------------------
  -- status bar data (config/app/status.lua sends statusline.parts()) ~5 µs; counting a whole-file selection
  -- ~10-20 µs; bookmark number cell (statuscolumn) ~1 µs per drawn line
  H.keys("150G")
  us_budget("status bar render", us("require('config.statusline').parts()"), 150)
  H.keys("ggVG")
  us_budget("status bar with a whole-file selection", us("require('config.statusline').parts()", 20), 300)
  H.keys(K.esc)
  H.keys("2G" .. K.ctrl_shift_digit(1))
  H.expect("Ctrl+Shift+1 sets bookmark 1 (for the gutter budget)", "#require('config.bookmarks').list() > 0")
  us_budget("bookmark gutter cell", us("for i = 1, 100 do vim.v.lnum = i % 3 + 1 require('config.bookmarks').cell() end") / 100, 5)
  H.keys("2G" .. K.ctrl_shift_digit(1))

  -- Key -> frame in the big TSX file --------------------------------------------------------------------------
  -- caret ~1.7 ms (all CursorMoved handlers included), Cmd+W ~5 ms per step (treesitter nodes), ,s / ,S ~1 ms
  -- (cached function list). (Scroll / typing key -> frame through the app: perf.rs::frames::key_to_frame_in_a_big_tsx_file.)
  H.keys("100G")
  budget("caret down (ö)", 8, function() return (latency(20, { key = "ö" })) end)
  H.lua("vim.cmd('silent! e!')")
  -- (CPU time: the wall time of a treesitter-heavy key is scheduler-bound on a loaded machine)
  budget("Cmd+W per step on 3000 lines (CPU)", 20, function()
    local _, cpu = latency(12, {
      key = K.cmdW,
      prep = function(i) if i % 6 == 1 then H.keys(K.esc .. "2000G10|") end end,
      done = "return vim.api.nvim_get_mode().mode ~= 'n'",
    })
    return cpu
  end)
  H.keys(K.esc .. "2000G")
  budget(",s / ,S method up / down on 3000 lines", 10, function()
    return (latency(10, { key = function(i) return i % 2 == 0 and ",s" or ",S" end }))
  end)

  -- Minimap (#122, Feel vscode): config/app/minimap.lua makes the lines a window's minimap shows (the app asks
  -- for the span its layout shows; treesitter's colours per column). A 450-line span from scratch (a file opened,
  -- typing rested after an edit): ~17 ms of work, made 100 lines a main-loop turn, so the longest stall a key
  -- could wait for is one chunk: ~8 ms; scrolled on 40 lines, the kept lines reused: ~0.1 ms.
  H.call("config.app.minimap", "enable", true)
  budget("minimap: a 450-line span of the big TSX file made", 60, function()
    return us([[local m = require('config.app.minimap') local w = vim.api.nvim_get_current_win()
      m.enable(true) m.want(w, 1700, 2150) m.report(w)]], 7) / 1000
  end)
  H.budget("minimap: the longest main-loop stall while it makes them", H.samples(function(i)
    H.bridge_clear()
    H.lua(([[local m = require('config.app.minimap') m.enable(true)
      _G.perf_gap = { max = 0, last = vim.uv.hrtime(), t = vim.uv.new_timer() }
      _G.perf_gap.t:start(1, 1, function()
        local now = vim.uv.hrtime()
        _G.perf_gap.max = math.max(_G.perf_gap.max, (now - _G.perf_gap.last) / 1e6)
        _G.perf_gap.last = now
      end)
      m.want(vim.api.nvim_get_current_win(), %d, %d)]]):format(1500 + i, 1950 + i))
    local done = H.wait_for(function() return #H.bridge("minimap", "lines") > 0 end, 5000)
    local gap = H.lua("_G.perf_gap.t:stop() _G.perf_gap.t:close() return _G.perf_gap.max")
    return done and gap or math.huge
  end, 5), 20)
  budget("minimap: the span scrolled 40 lines on", 8, function()
    return us([[local m = require('config.app.minimap') local w = vim.api.nvim_get_current_win()
      _G.minimap_at = ((_G.minimap_at or 0) + 40) % 800
      m.want(w, 1000 + _G.minimap_at, 1450 + _G.minimap_at) m.report(w)]], 20) / 1000
  end)
  H.call("config.app.minimap", "enable", false)

  -- 19k-line linewise selection: only the visible rows get selection marks, so moving the caret costs the
  -- same as in a small one (~2 ms; marks for every selected row took ~40 ms)
  H.lua([[local lines = {}
    for i = 1, 20000 do lines[i] = ('  const v%d = %d;'):format(i, i) end
    vim.cmd('enew') vim.bo.filetype = 'typescript'
    vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)]])
  H.keys("1GV19000G")
  budget("caret move in a 19k-line selection", 15, function()
    return (latency(10, { key = function(i) return i % 2 == 0 and "ö" or "l" end }))
  end)
  H.keys(K.esc)
  H.lua("vim.cmd('bwipeout!')")

  -- Opening files -----------------------------------------------------------------------------------------
  -- a tsx file after a GC: ~20-30 ms (vtsls didOpen included). nvim keeps compiled queries weakly; the tsx
  -- highlights query takes ~55 ms to compile, so a lost cache shows here.
  local small = 0 -- each sample opens a file not opened yet (a resample too)
  budget("open another TSX file after a GC", 60, function()
    return H.samples(function()
      small = small % 10 + 1
      return timed(("collectgarbage('collect') vim.cmd.edit('src/Small%d.tsx')"):format(small))
    end, 5)
  end)
  -- switching editor tabs after an edit autosaves the file: a plain write without fsync (~13 ms with it) or
  -- nested BufWritePost work (prettier): ~3 ms, tab state rebuilt
  H.lua("vim.cmd.edit('b.ts') vim.cmd.edit('a.ts')")
  H.budget("switch editor tabs after an edit (autosave)", H.samples(function(i)
    local from, to = i % 2 == 1 and "a.ts" or "b.ts", i % 2 == 1 and "b.ts" or "a.ts"
    H.lua(("vim.cmd.buffer(%q) vim.api.nvim_buf_set_lines(0, 0, 0, false, { '// %d' })"):format(from, i))
    return timed(("vim.cmd.buffer(%q)"):format(to))
  end, 7), 30)
  -- ...then formats the file it left in the background (Prettier in its own process): the longest main-loop
  -- stall while that runs (a 1 ms timer's longest gap, from the switch until the formatted file is on disk)
  -- is the format's kick-off / apply / write: ~3-8 ms. Blocking for it would show the formatter's whole run.
  H.budget("background format after autosave: longest main-loop stall", H.samples(function(i)
    local from, to = i % 2 == 1 and "a.ts" or "b.ts", i % 2 == 1 and "b.ts" or "a.ts"
    H.lua(("vim.cmd.buffer(%q) vim.api.nvim_buf_set_lines(0, 0, 0, false, { 'const   f%d={a:%d}' })"):format(from, i, i))
    H.settle(40, 1000)
    H.lua(([[
      _G.perf_gap = { max = 0, last = vim.uv.hrtime(), t = vim.uv.new_timer() }
      _G.perf_gap.t:start(1, 1, function()
        local now = vim.uv.hrtime()
        _G.perf_gap.max = math.max(_G.perf_gap.max, (now - _G.perf_gap.last) / 1e6)
        _G.perf_gap.last = now
      end)
      vim.cmd.buffer(%q)]]):format(to))
    local done = H.wait_for(("(vim.fn.readfile(%q)[1] or '') == %q"):format(DIR .. "/" .. from, ("const f%d = { a: %d };"):format(i, i)), 10000)
    local gap = H.lua("_G.perf_gap.t:stop() _G.perf_gap.t:close() return _G.perf_gap.max")
    return done and gap or math.huge
  end, 5), 30)
  -- another markdown file opens in the default mode (editor + preview, the preview native): ~30 ms
  H.budget("open a markdown file with its preview", H.samples(function(i)
    return timed(("vim.cmd.edit('doc%d.md') require('config.markdown').sync()"):format(i))
  end, 5), 150)
  H.expect("markdown file shows its preview (for the budget above)", "(require('config.markdown').state()[1] or {}).preview ~= nil",
    "=require('config.markdown').state()")
  H.lua("vim.cmd.edit('a.ts')")
  H.settle()

  -- Diff viewer on big files (git/diff.lua: two nvim panes, native chrome) ------------------------------------
  H.lua([[require('git.cli').find_root()
    _G.T_FILES = { { path = 'src/diff.ts', status = 'M' }, { path = 'src/long.ts', status = 'M' },
      { path = 'src/huge.txt', status = 'M' } }
    _G.T_DIFF = require('git.diff')]])
  local function diff_at(i) return ("T_DIFF.is_active() and T_DIFF.state().index == %d"):format(i) end
  -- open (2000 lines, 40 changes): ~35-50 ms, up to ~95 under heavy load, everything drawn in that frame
  H.budget("diff viewer opens", H.samples(function()
    local ms = timed("T_DIFF.open(T_FILES, T_FILES[1], { old = 'HEAD' })")
    if not H.wait_for(diff_at(1), 3000) then ms = math.huge end
    H.lua("T_DIFF.close()")
    H.settle(60)
    return ms
  end, 5), 150)
  H.lua("T_DIFF.open(T_FILES, T_FILES[1], { old = 'HEAD' })")
  H.wait_for(diff_at(1), 3000)
  -- next file, the 20000-line one (200 changes): ~70-85 ms
  H.budget("diff viewer: next file (20000 lines)", H.samples(function()
    local ms = timed("T_DIFF.cycle(1)")
    if not H.wait_for(diff_at(2), 3000) then ms = math.huge end
    H.lua("T_DIFF.cycle(-1)")
    H.settle(60)
    return ms
  end, 5), 200)
  -- Scrolling maps lines through cached hunks: a step (both panes moved) ~2 ms. In a 100k-line file a
  -- re-diff per step (text of both panes + vim.text.diff, measured below) costs ~20 ms of CPU: the step's CPU
  -- time staying under half of that means it doesn't diff again.
  H.lua("T_DIFF.open(T_FILES, T_FILES[3], { old = 'HEAD' })")
  H.wait_for(diff_at(3), 3000)
  H.lua("local w = T_DIFF.wins() _G.T_NEW, _G.T_OLD = w[1], w[2] vim.api.nvim_set_current_win(T_NEW)")
  H.keys("50000Gzt")
  local rediff = H.samples(function()
    return H.lua([[local c = os.clock()
      local function text(w) return table.concat(vim.api.nvim_buf_get_lines(vim.api.nvim_win_get_buf(w), 0, -1, false), '\n') .. '\n' end
      vim.text.diff(text(T_OLD), text(T_NEW), { result_type = 'indices' })
      return (os.clock() - c) * 1e3]])
  end, 3)
  local wall, cpu = latency(10, {
    key = function(i) return i % 2 == 1 and K.ctrl_e or K.ctrl_y end,
    before = "return { vim.fn.line('w0', T_NEW), vim.fn.line('w0', T_OLD) }",
    done = "return vim.fn.line('w0', T_NEW) ~= s[1] and vim.fn.line('w0', T_OLD) ~= s[2]",
  })
  H.budget("diff viewer: scroll step, both panes", wall, 15)
  H.check(("diff viewer: a scroll step doesn't diff again: CPU median %.1fms, a re-diff %.1fms")
    :format(median(cpu), median(rediff)), #cpu >= 5 and median(cpu) < median(rediff) / 2, vim.inspect(cpu))
  H.lua("T_DIFF.close()")
  H.settle()

  -- Terminal ---------------------------------------------------------------------------------------------
  -- session layout reads each shell's folder from the kernel (lsof per tab took ~100 ms): ~1 ms. The shells
  -- are the app's PTYs: here two stand-in processes in the project and in src/, their pids reported as Rust
  -- does (config.app.terminal.tabs). A sample with the wrong folders counts as a miss.
  local shells = {}
  for _, cwd in ipairs({ DIR, DIR .. "/src" }) do
    shells[#shells + 1] = vim.system({ "sh", "-c", "sleep 120" }, { cwd = cwd })
  end
  H.call("config.app.terminal", "toggle")
  H.call("config.app.terminal", "tabs", { shells[1].pid, shells[2].pid }, 1)
  H.wait_for("require('config.app.terminal').is_open()", 3000)
  local src = vim.uv.fs_realpath(DIR .. "/src")
  H.budget("terminal session layout with two tabs", H.samples(function()
    local r = H.lua([[local t = vim.uv.hrtime()
      local l = require('config.app.terminal').layout()
      return { (vim.uv.hrtime() - t) / 1e6, l and l.tabs or {} }]]) or { math.huge, {} }
    local tabs = r[2]
    local ok = #tabs == 2 and vim.uv.fs_realpath(tabs[2] or "") == src
    return ok and r[1] or math.huge
  end, 5), 20)
  for _, s in ipairs(shells) do s:kill("sigkill") end
end)
