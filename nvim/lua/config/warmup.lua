-- The editor's one-time install into stdpath("data"), headless: plugins at lazy-lock.json, the treesitter
-- parsers and Mason's packages (config/tools.lua), which the config otherwise installs in the background on a
-- first start (network). Run by app/scripts/warmup.sh on a Mac and the workspace image's build
-- (abe/images/base/vimstorm-warmup.lua). Only what is missing is installed, so a re-run retries what failed.
-- Mason's packages go straight through its registry: mason-lspconfig's ensure_installed (plugins/lsp.lua's
-- path) does nothing while no UI is attached (#163).
local M = {}

---@param msg string
local function say(msg)
  io.stdout:write(msg .. "\n")
  io.stdout:flush()
end

---@class WarmupPackage
---@field name string
---@field is_installed fun(self: WarmupPackage): boolean
---@field is_installing fun(self: WarmupPackage): boolean
---@field install fun(self: WarmupPackage, opts: table, cb: fun(success: boolean, result: any))

---@class WarmupRegistry
---@field refresh fun(cb: fun(success: boolean, updated: table))
---@field get_package fun(name: string): WarmupPackage

---@class WarmupMasonOpts
---@field packages {package: string, bin: string}[]
---@field registry WarmupRegistry mason-registry (a fake in tests)
---@field bin string mason's bin dir, ending in /
---@field say? fun(msg: string)
---@field timeout? integer ms for the registry and for the installs each (default 10 min)
---@field every? integer ms between "still installing" lines (default 30 s)

--- Installs the packages whose command isn't in `bin` yet, each line saying what it does; returns the
--- packages still missing after (empty: all there).
---@param o WarmupMasonOpts
---@return string[]
function M.mason(o)
  local log, timeout, every = o.say or say, o.timeout or 600000, o.every or 30000
  local function todo()
    local out = {} ---@type {package: string, bin: string}[]
    for _, t in ipairs(o.packages) do
      if not vim.uv.fs_stat(o.bin .. t.bin) then out[#out + 1] = t end
    end
    return out
  end
  local wanted = todo()
  if #wanted == 0 then
    log("language servers: all " .. #o.packages .. " installed")
    return {}
  end
  log("language servers: refreshing Mason's registry (network)")
  local refreshed, fresh = false, false
  o.registry.refresh(function(success) refreshed, fresh = true, success end)
  vim.wait(timeout, function() return refreshed end, 100)
  if not fresh then log("  Mason's registry: " .. (refreshed and "refresh failed" or "no answer") .. ", trying the cached one") end

  local running = {} ---@type table<string, WarmupPackage>
  local pending = 0 -- install callbacks still to come (each says its package's end)
  for i, t in ipairs(wanted) do
    local ok, pkg = pcall(o.registry.get_package, t.package)
    if not ok then
      log("  " .. t.package .. ": not in Mason's registry")
    elseif pkg:is_installing() then -- the config's own background install got there first
      running[t.package] = pkg
    else
      log(("  installing %s (%d of %d)"):format(t.package, i, #wanted))
      running[t.package] = pkg
      pending = pending + 1
      local started = pcall(pkg.install, pkg, {}, function(success, result)
        vim.schedule(function()
          pending = pending - 1
          log(("  %s %s"):format(t.package, success and "installed" or ("failed: " .. vim.trim(tostring(result)))))
        end)
      end)
      if not started then
        pending = pending - 1
        log("  " .. t.package .. ": couldn't start its install")
      end
    end
  end
  -- every install's own end, not its bin link (which comes before the package is done)
  local function busy()
    local out = {} ---@type string[]
    for name, pkg in pairs(running) do
      if pkg:is_installing() then out[#out + 1] = name end
    end
    table.sort(out)
    return out
  end
  local deadline = vim.uv.now() + timeout
  local function done() return #busy() == 0 and pending == 0 end
  while not done() and vim.uv.now() < deadline do
    if not vim.wait(math.min(every, deadline - vim.uv.now()), done, 200) and #busy() > 0 then
      log("  still installing: " .. table.concat(busy(), ", "))
    end
  end
  local left = vim.tbl_map(function(t) return t.package end, todo())
  log(#left == 0 and "language servers: installed" or ("language servers: missing " .. table.concat(left, ", ")))
  return left
end

--- Plugins, parsers, Mason's packages; the parts still missing after (empty: all there).
---@return string[]
local function warm()
  local failed = {} ---@type string[]
  -- lazy's install at startup wrote lazy-lock.json from what it cloned (lazy.nvim's bootstrap at its stable
  -- branch): the repo's file again, as warmup.sh kept it, is what the plugins are put at
  local kept = vim.env.VIMSTORM_WARMUP_LOCK
  if kept and vim.uv.fs_stat(kept) then
    vim.fn.writefile(vim.fn.readfile(kept, "b"), require("lazy.core.config").options.lockfile, "b")
    local lock = require("lazy.manage.lock")
    lock._loaded = false
    lock.load()
  end
  -- the plugins not there or not at lazy-lock.json's commit (a restore of all fetches every one: network, noise)
  local function off()
    local out = {} ---@type string[]
    local git, lock = require("lazy.manage.git"), require("lazy.manage.lock")
    for name, p in pairs(require("lazy.core.config").plugins) do
      local want, have = lock.get(p), vim.uv.fs_stat(p.dir) and git.info(p.dir)
      if not have or (want and not git.eq(have, want)) then out[#out + 1] = name end
    end
    table.sort(out)
    return out
  end
  local plugins = off()
  if #plugins > 0 then
    say("plugins: installing " .. table.concat(plugins, ", ") .. " at lazy-lock.json's versions")
    require("lazy").restore({ plugins = plugins, wait = true, show = false })
    io.stderr:write("\n") -- (its progress, on stderr, ends without one)
    plugins = off()
  end
  say(#plugins == 0 and "plugins: installed" or ("plugins: missing " .. table.concat(plugins, ", ")))
  if #plugins > 0 then failed[#failed + 1] = "plugins" end

  local tools = require("config.tools")
  local ok_ts, ts = pcall(require, "nvim-treesitter")
  if ok_ts then
    -- by the parser itself: its install skips a language whose queries are there without it
    local function left()
      local have = {} ---@type table<string, boolean>
      for _, p in ipairs(ts.get_installed("parsers")) do have[p] = true end
      return vim.tbl_filter(function(p) return not have[p] end, tools.parsers)
    end
    local missing = left()
    if #missing > 0 then
      say("treesitter parsers: installing " .. table.concat(missing, ", "))
      ts.install(missing, { force = true }):pwait(600000)
      io.stderr:write("\n") -- (its progress, on stderr, ends without one)
      missing = left()
    end
    say(#missing == 0 and "treesitter parsers: installed" or ("treesitter parsers: missing " .. table.concat(missing, ", ")))
    if #missing > 0 then failed[#failed + 1] = "parsers" end
  else
    say("treesitter parsers: nvim-treesitter didn't load")
    failed[#failed + 1] = "parsers"
  end

  local ok_mason = pcall(require("lazy").load, { plugins = { "mason.nvim" } })
  local left = ok_mason
      and M.mason({
        packages = tools.mason,
        registry = require("mason-registry"),
        bin = vim.fn.stdpath("data") .. "/mason/bin/",
      })
    or { "mason.nvim" }
  if #left > 0 then failed[#failed + 1] = "language servers" end

  return failed
end

--- The warm-up; exits nvim, non-zero (`cq`) when anything is missing after or it threw (headless nvim
--- would otherwise stay up after the error: an offline first start without lazy.nvim, say).
function M.run()
  local ok, failed = xpcall(warm, debug.traceback)
  if not ok then
    io.stderr:write("warm-up failed: " .. tostring(failed) .. "\n")
    vim.cmd("cq!")
    return
  end
  if #failed > 0 then say("warm-up failed: " .. table.concat(failed, ", ") .. " (run it again to retry)") end
  vim.cmd(#failed == 0 and "qa!" or "cq!")
end

return M
