-- Your own Neovim config on top of VimStorm's (#214). Two overlays, each a Neovim config folder (init.lua or
-- init.vim, lua/, plugin/, after/, colors/ ...), loaded after VimStorm's config when the Feel says
-- (config/feel_keys.lua):
--   user      your own ~/.config/nvim ($XDG_CONFIG_HOME/nvim): Feel vim, over stock Vim keys
--   personal  the personal Layer's nvim/ ($ABE_CONFIG_DIR/nvim, else $XDG_CONFIG_HOME/abe/nvim): Feel vimstorm and
--             vim, last (it is VimStorm's own config of yours)
-- Either may override keys, options, the colorscheme and plugins. An error in one is a balloon, never fatal: the
-- app's own surfaces keep working.
--
-- Loading records what it changed (global maps, also the ones its code maps later; options; autocmds and user
-- commands made while it loads; the leaders; runtimepath; the colorscheme), so unloading (a Feel switch) puts
-- VimStorm's back. Plugins it loaded stay loaded until the project's nvim starts again.
--
-- Its lua/ modules are its own: a require from its files finds them before VimStorm's of the same name (a LazyVim
-- style lua/config/options.lua is not VimStorm's config.options), and stdpath() answers its own folders there
-- (`config` the overlay's; for your ~/.config/nvim `data` / `state` / `cache` your own Neovim's too). Plugins it
-- declares through lazy.nvim (`require("lazy").setup`) or packer (`require("packer").startup`) load at once from
-- where your own Neovim installed them (its lazy/ folder, packer's pack/ folders, or a spec's `dir`); VimStorm
-- installs none (a bootstrap's `git clone` is skipped). One balloon names what did not load: not installed,
-- VimStorm's own plugin (your settings for it left out) or one that draws what the app draws (NOT_HERE).
local M = {}

local uv = vim.uv

-- Plugins VimStorm does not load from your config: the app draws these surfaces natively
local NOT_HERE = {
  ["noice.nvim"] = "the app draws the command line and messages",
  ["nvim-notify"] = "the app's balloons show notifications",
  ["lualine.nvim"] = "the app draws the status bar",
  ["bufferline.nvim"] = "the app draws the editor tabs",
  ["barbar.nvim"] = "the app draws the editor tabs",
  ["neo-tree.nvim"] = "the app draws the Project tree",
  ["nvim-tree.lua"] = "the app draws the Project tree",
  ["which-key.nvim"] = "the app's key help is ,? / ⌘K ⌘S",
  ["nvim-cmp"] = "VimStorm completes with blink.cmp",
  ["lazy.nvim"] = false, -- VimStorm's own lazy.nvim runs (silently left out)
  ["packer.nvim"] = false,
}

---@class UserPlugin
---@field name string
---@field spec table
---@field deps string[]
---@field dir string?
---@field state nil|"loading"|"loaded"
---@field overlay Overlay?

---@class Overlay
---@field name "user"|"personal"
---@field dir string
---@field roots string[] the folder and its plugins' folders: code under one is this overlay's
---@field lua boolean has a lua/ folder
---@field modules table<string, any> its own lua/ modules, by name
---@field maps table<string, {[1]: string, [2]: string, [3]: table|false}> mode .. lhsraw -> { mode, lhs, before }
---@field options table<string, {[1]: any, [2]: any, [3]: string}> name -> { before, after, scope }
---@field autocmds integer[]
---@field commands string[]
---@field rtp string[]
---@field leaders {[1]: string?, [2]: string?}
---@field colors string?
---@field packpath string[]
---@field vimstorm table<string, true> mode .. lhsraw of the maps VimStorm made while it loaded (not its)
---@field lazy_root string?
---@field misses table<string, true> module names not in its lua/
---@field buf_maps {[1]: integer, [2]: string, [3]: string}[] buffer, mode, lhs of its buffer-local maps
---@field hl boolean it changed highlight groups (without a colorscheme of its own)
---@field vimstorm_loaded boolean VimStorm's lazy.nvim loaded plugins while it loaded
---@field plugins table<string, UserPlugin>
---@field order string[]
---@field problems string[]
---@field notes string[]

local loaded = {} ---@type table<string, Overlay>
-- Overlays taken off whose plugins stay loaded (said once the Feel switch is done: M.tell_lingering)
local lingering = {} ---@type table<string, string[]>
-- Overlays left out as VimStorm's own config, already said (once per nvim)
local told = {} ---@type table<string, true>
local order = {} ---@type string[] loaded overlays, in load order
local loading ---@type Overlay?

local raw_require = require
local raw_stdpath = vim.fn.stdpath
local raw_system = vim.fn.system
local raw_exit = os.exit

local function home() return vim.env.HOME or uv.os_homedir() end

-- The user's own XDG_CONFIG_HOME (the app's points Neovim at VimStorm's config: config/app.lua)
local function user_xdg()
  local own = vim.env.VIMSTORM_USER_XDG_CONFIG_HOME
  if own and own ~= "" then return own end
  return home() .. "/.config"
end

local function xdg(var, default)
  local v = vim.env[var]
  if v and v ~= "" then return v end
  return home() .. default
end

-- The personal Layer's nvim/ (the personal Layer is Abe's config folder: abe/packages/ports/src/mac/settings.ts)
function M.personal_dir()
  local abe = vim.env.ABE_CONFIG_DIR
  if abe and abe ~= "" then return abe .. "/nvim" end
  return user_xdg() .. "/abe/nvim"
end

-- Your own Neovim config
function M.user_dir() return user_xdg() .. "/nvim" end

-- Your own Neovim's stdpath() folders
local function user_paths()
  return {
    config = M.user_dir(),
    data = xdg("XDG_DATA_HOME", "/.local/share") .. "/nvim",
    state = xdg("XDG_STATE_HOME", "/.local/state") .. "/nvim",
    cache = xdg("XDG_CACHE_HOME", "/.cache") .. "/nvim",
  }
end

local function is_dir(p)
  local st = uv.fs_stat(p)
  return st ~= nil and st.type == "directory"
end

local function is_file(p)
  local st = uv.fs_stat(p)
  return st ~= nil and st.type == "file"
end

local function norm(p) return vim.fs.normalize(p) end

local function under(path, root) return path == root or path:sub(1, #root + 1) == root .. "/" end

local SELF = debug.getinfo(1, "S").source

-- The overlays loaded and the one loading
local function active()
  local out = {}
  for _, name in ipairs(order) do out[#out + 1] = loaded[name] end
  if loading then out[#out + 1] = loading end
  return out
end

-- The overlay whose code is running: the first Lua file on the stack that is not this module or the keymap wrapper
---@return Overlay?
function M.origin()
  if M.own then return M.own end
  if #order == 0 and not loading then return nil end
  for level = 2, 12 do
    local info = debug.getinfo(level, "S")
    if not info then return nil end
    local src = info.source
    -- Lua with no file while one loads: an init.vim's `:lua` / `lua << EOF`
    if loading and info.what ~= "C" and src:sub(1, 1) ~= "@" then return loading end
    if src:sub(1, 1) == "@" and src ~= SELF and not src:find("config/stockvim%.lua$") then
      local path = norm(src:sub(2))
      for _, o in ipairs(active()) do
        for _, root in ipairs(o.roots) do
          if under(path, root) then return o end
        end
      end
      return nil
    end
  end
end

-- Set while this module makes an overlay's maps for it (a lazy.nvim spec's `keys`)
M.own = nil ---@type Overlay?

-- An overlay is loading (its init, its plugins)
---@return Overlay?
function M.loading() return loading end

-- `require` from an overlay's files: its own lua/ modules first; lazy.nvim / packer as the shims below
local shims = {} ---@type table<string, fun(o: Overlay): table>

local function find_module(dir, name)
  local base = dir .. "/lua/" .. name:gsub("%.", "/")
  if is_file(base .. ".lua") then return base .. ".lua" end
  if is_file(base .. "/init.lua") then return base .. "/init.lua" end
end

local function overlay_require(name)
  local o = type(name) == "string" and M.origin()
  if o then
    if shims[name] then return shims[name](o) end
    local hit = o.modules[name]
    if hit ~= nil then return hit end
    -- (a name not among its modules, once looked for, goes to VimStorm's require at once)
    local path = o.lua and not o.misses[name] and find_module(o.dir, name)
    if o.lua and not path then o.misses[name] = true end
    if path then
      local chunk, err = loadfile(path)
      if not chunk then error(err, 2) end
      local v = chunk(name, path)
      if v == nil then v = true end
      o.modules[name] = v
      return v
    end
  end
  return raw_require(name)
end

local function overlay_stdpath(what)
  local o = M.origin()
  if o and type(what) == "string" then
    if what == "config" then return o.dir end
    if o.name == "user" then
      local p = user_paths()[what]
      if p then return p end
    end
  end
  return raw_stdpath(what)
end

-- A bootstrap's `git clone` (lazy.nvim's, packer's; vim.fn.system or vim.system, a list or a string) is not run:
-- VimStorm installs nothing; v:shell_error 0
local function clone_of(cmd)
  local argv = type(cmd) == "string" and vim.split(vim.trim(cmd), "%s+") or cmd
  if type(argv) ~= "table" or argv[1] ~= "git" or argv[2] ~= "clone" then return nil end
  return (tostring(argv[#argv]):gsub("['\"]", ""):gsub("/+$", ""):gsub("^.*/", ""):gsub("%.git$", ""))
end

local function skipped_clone(cmd)
  local name = loading and clone_of(cmd)
  if not name then return false end
  if NOT_HERE[name] == nil then loading.notes[#loading.notes + 1] = "not installed: " .. name end
  return true
end

local function overlay_system(cmd, ...)
  if skipped_clone(cmd) then
    raw_system({ "true" })
    return ""
  end
  return raw_system(cmd, ...)
end

local raw_vim_system = vim.system

local function overlay_vim_system(cmd, opts, on_exit)
  if skipped_clone(cmd) then
    local done = { code = 0, signal = 0, stdout = "", stderr = "" }
    if type(on_exit) == "function" then vim.schedule(function() on_exit(done) end) end
    return { wait = function() return done end, kill = function() end, is_closing = function() return true end, pid = 0 }
  end
  return raw_vim_system(cmd, opts, on_exit)
end

local function overlay_exit() error("os.exit is not run inside VimStorm", 2) end

-- require / stdpath answer an overlay's code while one loads, and after it while one has modules or plugins of its
-- own (a require or stdpath() from them later on: an autocmd, a plugin's callback)
local function rewrap()
  local on = loading ~= nil
  for _, name in ipairs(order) do
    local o = loaded[name]
    if o.lua or #o.roots > 1 then on = true end
  end
  if on then
    _G.require = overlay_require
    rawset(vim.fn, "stdpath", overlay_stdpath)
  else
    _G.require = raw_require
    rawset(vim.fn, "stdpath", raw_stdpath)
  end
end

-- Snapshots ------------------------------------------------------------------------------------------------------

local MAP_MODES = { "n", "x", "s", "o", "i", "c", "t" }

local function patched(m)
  if m.rhs == "" and not m.callback then m.rhs = "<Nop>" end
  return m
end

local function maps_now()
  local out = {}
  for _, mode in ipairs(MAP_MODES) do
    for _, m in ipairs(vim.api.nvim_get_keymap(mode)) do out[mode .. "\0" .. (m.lhsraw or m.lhs)] = patched(m) end
  end
  return out
end

local function find_global(mode, lhs)
  local raw = vim.api.nvim_replace_termcodes(lhs, true, true, true)
  for _, m in ipairs(vim.api.nvim_get_keymap(mode)) do
    if m.lhsraw == raw or m.lhs == lhs then return patched(m) end
  end
end

local MAP_FIELDS = { "rhs", "callback", "expr", "noremap", "silent", "nowait", "desc", "replace_keycodes" }

local function same_map(a, b)
  for _, f in ipairs(MAP_FIELDS) do
    if a[f] ~= b[f] then return false end
  end
  return true
end

-- (runtimepath / packpath: their entries are recorded one by one, VimStorm's plugins loading meanwhile kept)
local SKIP_OPTIONS = {
  columns = true, lines = true, modified = true, scroll = true, window = true, cmdheight = true, runtimepath = true,
  packpath = true,
}

local function options_now()
  local out = {}
  for name, info in pairs(vim.api.nvim_get_all_options_info()) do
    if not SKIP_OPTIONS[name] then
      local ok, v = pcall(vim.api.nvim_get_option_value, name, { scope = "global" })
      if ok then out[name] = { v, info.scope } end
    end
  end
  return out
end

local function autocmd_ids()
  local out = {}
  for _, a in ipairs(vim.api.nvim_get_autocmds({})) do
    if a.id then out[a.id] = a.callback or false end
  end
  return out
end

local function lazy_loaded()
  local ok, lazy = pcall(raw_require, "lazy")
  return ok and lazy.stats and lazy.stats().loaded or 0
end

local function snapshot()
  return {
    maps = maps_now(),
    options = options_now(),
    autocmds = autocmd_ids(),
    commands = vim.api.nvim_get_commands({}),
    rtp = vim.opt.rtp:get(),
    leaders = { vim.g.mapleader, vim.g.maplocalleader },
    colors = vim.g.colors_name,
    hl = vim.api.nvim_get_hl(0, {}),
    lazy = lazy_loaded(),
  }
end

local function under_roots(o, path)
  path = norm(path)
  for _, root in ipairs(o.roots) do
    if under(path, root) then return true end
  end
  return false
end

-- What changed between two snapshots, into the overlay's record
local function record(o, a, b)
  for key, m in pairs(b.maps) do
    local before = a.maps[key]
    if (not before or not same_map(before, m)) and not o.maps[key] and not o.vimstorm[key] then
      o.maps[key] = { key:match("^(%a)"), m.lhs, before or false, m }
    end
  end
  for key, before in pairs(a.maps) do
    if not b.maps[key] and not o.maps[key] then o.maps[key] = { key:match("^(%a)"), before.lhs, before } end
  end
  -- what is new and not plainly its own (a vimscript autocmd, a command) only while VimStorm loaded nothing meanwhile
  o.vimstorm_loaded = b.lazy ~= a.lazy
  for name, v in pairs(b.options) do
    local was = a.options[name]
    if was and not vim.deep_equal(was[1], v[1]) and not o.options[name] then o.options[name] = { was[1], v[1], v[2] } end
  end
  for id, cb in pairs(b.autocmds) do
    if a.autocmds[id] == nil then
      local src = type(cb) == "function" and debug.getinfo(cb, "S").source or nil
      local own
      if src and src:sub(1, 1) == "@" then
        own = under_roots(o, src:sub(2))
      else
        own = not o.vimstorm_loaded
      end
      if own then o.autocmds[#o.autocmds + 1] = id end
    end
  end
  for name in pairs(b.commands) do
    if not a.commands[name] and not o.vimstorm_loaded then o.commands[#o.commands + 1] = name end
  end
  local had = {}
  for _, p in ipairs(a.rtp) do had[p] = true end
  for _, p in ipairs(b.rtp) do
    if not had[p] then
      -- your own lazy.nvim / packer (a bootstrap's rtp:prepend) never runs here: VimStorm's lazy.nvim does
      if p:find("/lazy%.nvim/?$") or p:find("/packer%.nvim/?$") then
        vim.opt.rtp:remove(p)
      elseif under_roots(o, p) then
        o.rtp[#o.rtp + 1] = p
      end
    end
  end
  if b.colors ~= a.colors then o.colors = b.colors end
  if not o.colors and not vim.deep_equal(a.hl, b.hl) then o.hl = true end
end

-- Plugins --------------------------------------------------------------------------------------------------------

local function plugin_name(s)
  if s.name then return s.name end
  local src = s[1] or s.url or s.dir
  if type(src) ~= "string" then return nil end
  return (src:gsub("/+$", ""):gsub("^.*/", ""):gsub("%.git$", ""))
end

local function vimstorm_has(name)
  local ok, config = pcall(raw_require, "lazy.core.config")
  return ok and config.plugins and config.plugins[name] ~= nil
end

local function is_list(s) return type(s[1]) == "table" or #s > 1 end

local function truthy(v, plugin)
  if type(v) == "function" then
    local ok, r = pcall(v, plugin)
    return not ok or r ~= false
  end
  return v ~= false
end

local add_spec, pack_add

-- `import = "plugins"`: lua/plugins.lua or every lua/plugins/*.lua of the overlay
local function import(o, what)
  local base = o.dir .. "/lua/" .. what:gsub("%.", "/")
  local files = {}
  if is_file(base .. ".lua") then files[#files + 1] = base .. ".lua" end
  if is_dir(base) then
    for name, kind in vim.fs.dir(base) do
      if kind == "file" and name:match("%.lua$") then files[#files + 1] = base .. "/" .. name end
    end
    table.sort(files)
  end
  for _, f in ipairs(files) do
    local chunk, err = loadfile(f)
    local ok, spec = false, err
    if chunk then ok, spec = pcall(chunk) end
    if ok then add_spec(o, spec) else o.problems[#o.problems + 1] = tostring(spec) end
  end
end

---@param o Overlay
---@param s any a lazy.nvim spec: a plugin, a list of them, an import
---@return string? the plugin's name
function add_spec(o, s)
  if type(s) == "string" then s = { s } end
  if type(s) ~= "table" then return nil end
  if type(s.import) == "string" then
    import(o, s.import)
    return nil
  end
  if is_list(s) or (s[1] == nil and not (s.dir or s.url or s.name)) then
    for _, one in ipairs(s) do add_spec(o, one) end
    return nil
  end
  local name = plugin_name(s)
  if not name then return nil end
  local p = o.plugins[name]
  if not p then
    p = { name = name, spec = {}, deps = {} }
    o.plugins[name] = p
    o.order[#o.order + 1] = name
  end
  for k, v in pairs(s) do
    if k == "opts" and type(v) == "table" and type(p.spec.opts) == "table" then
      p.spec.opts = vim.tbl_deep_extend("force", p.spec.opts, v)
    elseif k ~= "dependencies" then
      p.spec[k] = v
    end
  end
  local deps = s.dependencies
  if type(deps) == "string" then deps = { deps } end
  for _, d in ipairs(type(deps) == "table" and deps or {}) do
    local dn = add_spec(o, d)
    if dn then p.deps[#p.deps + 1] = dn end
  end
  return name
end

-- packer's `use` spec as lazy.nvim's
local function packer_spec(s)
  if type(s) == "string" then return { s } end
  if type(s) ~= "table" then return nil end
  if type(s[1]) == "table" then
    local list = {}
    for _, one in ipairs(s) do list[#list + 1] = packer_spec(one) end
    return list
  end
  local function code(v)
    if type(v) == "string" then return function() assert(loadstring(v))() end end
    return v
  end
  local requires = s.requires
  if type(requires) == "string" then requires = { requires } end
  local deps = {}
  for _, r in ipairs(type(requires) == "table" and requires or {}) do deps[#deps + 1] = packer_spec(r) end
  return {
    s[1],
    name = s.as,
    init = code(s.setup),
    config = code(s.config),
    dependencies = deps,
    enabled = not s.disable,
    cond = s.cond,
  }
end

shims.lazy = function(o)
  local real = raw_require("lazy")
  return setmetatable({
    setup = function(spec, opts)
      -- setup("plugins"): every lua/plugins/*.lua of yours
      if type(spec) == "string" then spec = { import = spec } end
      if type(spec) == "table" and spec.spec and opts == nil then spec, opts = spec.spec, spec end
      if type(opts) == "table" and opts.spec and spec == nil then spec = opts.spec end
      if type(spec) == "string" then spec = { import = spec } end
      if type(opts) == "table" and type(opts.root) == "string" then o.lazy_root = opts.root end
      add_spec(o, spec)
    end,
  }, { __index = real })
end

shims.packer = function(o)
  local packer = {}
  local function use(s) add_spec(o, packer_spec(s)) end
  function packer.startup(spec)
    local fn = type(spec) == "function" and spec or (type(spec) == "table" and spec[1])
    if type(fn) == "function" then
      local before = rawget(_G, "use")
      rawset(_G, "use", use)
      local ok, err = pcall(fn, use, function() end)
      rawset(_G, "use", before)
      if not ok then o.problems[#o.problems + 1] = tostring(err) end
    end
    return packer
  end
  packer.use = use
  for _, f in ipairs({ "init", "reset", "sync", "install", "update", "compile", "clean", "status" }) do
    packer[f] = function() end
  end
  return packer
end

-- Where your own Neovim installed a plugin
local function plugin_dir(o, p)
  if type(p.spec.dir) == "string" then
    local d = vim.fn.expand(p.spec.dir)
    return is_dir(d) and d or nil
  end
  local data = o.name == "user" and user_paths().data or raw_stdpath("data")
  local dirs = { (o.lazy_root and vim.fn.expand(o.lazy_root) or data .. "/lazy") .. "/" .. p.name }
  for _, kind in ipairs({ "start", "opt" }) do
    for _, d in ipairs(vim.fn.glob(data .. "/site/pack/*/" .. kind .. "/" .. p.name, false, true)) do dirs[#dirs + 1] = d end
  end
  for _, d in ipairs(dirs) do
    if is_dir(d) then return d end
  end
end

local function source_all(dir, sub)
  for _, kind in ipairs({ "vim", "lua" }) do
    for _, f in ipairs(vim.fn.glob(dir .. "/" .. sub .. "/**/*." .. kind, false, true)) do vim.cmd.source(f) end
  end
end

local function guess_main(p)
  if type(p.spec.main) == "string" then return p.spec.main end
  local mods = {}
  if p.dir and is_dir(p.dir .. "/lua") then
    for name in vim.fs.dir(p.dir .. "/lua") do mods[#mods + 1] = (name:gsub("%.lua$", "")) end
  end
  if #mods == 1 then return mods[1] end
  local want = p.name:lower():gsub("^n?vim%-", ""):gsub("%.n?vim$", ""):gsub("[%.%-]lua$", ""):gsub("%.", "-")
  for _, m in ipairs(mods) do
    if m:lower():gsub("%.", "-") == want then return m end
  end
  return want
end

local function key_maps(p)
  local keys = p.spec.keys
  if type(keys) == "function" then
    local ok, k = pcall(keys, p, {})
    keys = ok and k or nil
  end
  if type(keys) ~= "table" then return end
  -- (made from here, they are still the overlay's: its leader, taken off with it)
  M.own = p.overlay
  for _, k in ipairs(keys) do
    if type(k) == "table" and type(k[1]) == "string" and k[2] ~= nil and not k.ft then
      vim.keymap.set(k.mode or "n", k[1], k[2], {
        desc = k.desc,
        silent = k.silent,
        expr = k.expr,
        nowait = k.nowait,
        remap = k.remap,
        noremap = k.noremap,
      })
    end
  end
  M.own = nil
end

---@param o Overlay
---@param p UserPlugin
local function load_plugin(o, p)
  if p.state then return end
  p.state = "loading"
  for _, d in ipairs(p.deps) do
    if o.plugins[d] then load_plugin(o, o.plugins[d]) end
  end
  if not truthy(p.spec.enabled, p) or not truthy(p.spec.cond, p) then return end
  if NOT_HERE[p.name] ~= nil then
    if NOT_HERE[p.name] then o.notes[#o.notes + 1] = p.name .. ": left out, " .. NOT_HERE[p.name] end
    return
  end
  if vimstorm_has(p.name) then
    o.notes[#o.notes + 1] = p.name .. ": VimStorm's own (your settings for it left out)"
    return
  end
  p.dir = plugin_dir(o, p)
  if not p.dir then
    o.notes[#o.notes + 1] = "not installed: " .. p.name
    return
  end
  o.roots[#o.roots + 1] = norm(p.dir)
  p.overlay = o
  local ok, err = pcall(function()
    if type(p.spec.init) == "function" then p.spec.init(p) end
    vim.opt.rtp:append(p.dir)
    if is_dir(p.dir .. "/after") then vim.opt.rtp:append(p.dir .. "/after") end
    source_all(p.dir, "ftdetect")
    source_all(p.dir, "plugin")
    source_all(p.dir, "after/plugin")
    local opts = p.spec.opts
    if type(opts) == "function" then
      local t = {}
      opts = opts(p, t) or t
    end
    if type(p.spec.config) == "function" then
      p.spec.config(p, opts or {})
    elseif p.spec.config == true or opts ~= nil then
      raw_require(guess_main(p)).setup(opts or {})
    end
    key_maps(p)
  end)
  M.own = nil
  if not ok then o.problems[#o.problems + 1] = p.name .. ": " .. tostring(err) end
  p.state = "loaded"
end

local function load_plugins(o)
  local names = vim.list_extend({}, o.order)
  local at = {}
  for i, n in ipairs(names) do at[n] = i end
  -- higher priority first, else as declared
  table.sort(names, function(a, b)
    local pa, pb = o.plugins[a].spec.priority or 50, o.plugins[b].spec.priority or 50
    if pa ~= pb then return pa > pb end
    return at[a] < at[b]
  end)
  for _, name in ipairs(names) do load_plugin(o, o.plugins[name]) end
end

-- Loading --------------------------------------------------------------------------------------------------------

local TITLES = { user = "Your nvim config (~/.config/nvim)", personal = "Your Abe nvim/ config" }

local function short(err)
  err = tostring(err)
  return (err:gsub("\nstack traceback:.*$", ""))
end

local function report(o)
  if #o.problems == 0 and #o.notes == 0 then return end
  local lines = {}
  for _, p in ipairs(o.problems) do lines[#lines + 1] = short(p) end
  for _, n in ipairs(o.notes) do lines[#lines + 1] = n end
  local level = #o.problems > 0 and vim.log.levels.ERROR or vim.log.levels.WARN
  local msg = table.concat(lines, "\n")
  vim.schedule(function() vim.notify(msg, level, { title = TITLES[o.name] }) end)
end

-- vim.pack.add (Neovim 0.12's own manager) while one loads: what your Neovim installed (its site/pack/core/opt/)
-- loads at once, nothing is installed
function pack_add(o, specs)
  for _, spec in ipairs(type(specs) == "table" and specs or {}) do
    local src = type(spec) == "string" and spec or type(spec) == "table" and (spec.src or spec[1]) or nil
    local name = type(spec) == "table" and spec.name or (type(src) == "string" and src:gsub("/+$", ""):gsub("^.*/", ""):gsub("%.git$", ""))
    if type(name) == "string" then
      local dir = (o.name == "user" and user_paths().data or raw_stdpath("data")) .. "/site/pack/core/opt/" .. name
      local pname = add_spec(o, is_dir(dir) and { dir = dir, name = name } or { name = name })
      if pname then load_plugin(o, o.plugins[pname]) end
    end
  end
end

-- VimStorm's own nvim/ (#226): the app's config (its link's target) or another checkout of this repo, by the files
-- only VimStorm's config has. Loading it on top would run VimStorm's modules a second time (its keys, its surfaces'
-- bridges), so it is never a config of yours.
---@param dir string
---@return boolean
local function vimstorms_own(dir)
  local real, own = uv.fs_realpath(dir), uv.fs_realpath(raw_stdpath("config"))
  if real and own and real == own then return true end
  return is_file(dir .. "/lua/config/app.lua") and is_file(dir .. "/colors/darcula-contrast.lua")
end

local function entry(dir)
  for _, f in ipairs({ "init.lua", "init.vim" }) do
    if is_file(dir .. "/" .. f) then return dir .. "/" .. f end
  end
end

-- Loads an overlay ("user" | "personal") if its folder has anything; once (unload first to load again)
---@param name "user"|"personal"
---@return Overlay?
function M.load(name)
  if loaded[name] then return loaded[name] end
  local dir = name == "user" and M.user_dir() or M.personal_dir()
  if not is_dir(dir) then return nil end
  dir = norm(dir)
  if vimstorms_own(dir) then
    if not told[name] then
      told[name] = true
      vim.schedule(function()
        vim.notify("It is VimStorm's own nvim/ config: left out", vim.log.levels.INFO, { title = TITLES[name] })
      end)
    end
    return nil
  end
  local init = entry(dir)
  local has_plugin = is_dir(dir .. "/plugin") or is_dir(dir .. "/after")
  if not init and not has_plugin and not is_dir(dir .. "/lua") then return nil end
  ---@type Overlay
  local o = {
    name = name, dir = dir, roots = { dir }, lua = is_dir(dir .. "/lua"), modules = {}, maps = {}, options = {},
    autocmds = {}, commands = {}, rtp = {}, packpath = {}, leaders = { vim.g.mapleader, vim.g.maplocalleader },
    plugins = {}, order = {}, problems = {}, notes = {}, vimstorm = {}, misses = {}, buf_maps = {}, hl = false,
    vimstorm_loaded = false,
  }
  local a = snapshot()
  loading = o
  rewrap()
  rawset(vim.fn, "system", overlay_system)
  vim.system = overlay_vim_system
  os.exit = overlay_exit
  local pack = vim.pack and vim.pack.add
  if pack then vim.pack.add = function(specs) pack_add(o, specs) end end
  -- `packadd` finds your own Neovim's packages; packer's own (a bootstrap's `packadd packer.nvim`) is the shim's
  if name == "user" then
    local shim = raw_stdpath("cache") .. "/userconfig/pack/shim/opt/packer.nvim"
    vim.fn.mkdir(shim, "p")
    for _, p in ipairs({ user_paths().data .. "/site", raw_stdpath("cache") .. "/userconfig" }) do
      vim.opt.packpath:prepend(p)
      o.packpath[#o.packpath + 1] = p
    end
  end
  vim.opt.rtp:append(dir)
  if is_dir(dir .. "/after") then vim.opt.rtp:append(dir .. "/after") end
  if init then
    local ok, err
    if init:match("%.lua$") then
      local chunk, lerr = loadfile(init)
      if chunk then
        ok, err = xpcall(chunk, debug.traceback)
      else
        ok, err = false, lerr
      end
    else
      ok, err = pcall(vim.cmd.source, init)
    end
    if not ok then o.problems[#o.problems + 1] = err end
  end
  load_plugins(o)
  for _, sub in ipairs({ "plugin", "after/plugin" }) do
    local ok, err = pcall(source_all, dir, sub)
    if not ok then o.problems[#o.problems + 1] = err end
  end
  os.exit = raw_exit
  vim.system = raw_vim_system
  rawset(vim.fn, "system", raw_system)
  if pack then vim.pack.add = pack end
  loading = nil
  record(o, a, snapshot())
  loaded[name] = o
  order[#order + 1] = name
  lingering[name] = nil
  rewrap()
  report(o)
  return o
end

local function raw_keys(mode, lhs, leader)
  local expanded = lhs:gsub("<[Ll][Ee][Aa][Dd][Ee][Rr]>", leader)
  local raw = vim.api.nvim_replace_termcodes(expanded, true, true, true)
  local modes = type(mode) == "table" and mode or { mode }
  local out = {}
  for _, m in ipairs(modes) do
    local list = m == "" and { "n", "x", "o" } or m == "v" and { "x", "s" } or { m }
    for _, one in ipairs(list) do out[#out + 1] = { one, raw, expanded } end
  end
  return out
end

-- A map VimStorm makes while an overlay loads (a VimStorm plugin your config's require loaded): not the overlay's
function M.vimstorm_made(mode, lhs)
  if not loading then return end
  for _, k in ipairs(raw_keys(mode, lhs, ",")) do loading.vimstorm[k[1] .. "\0" .. k[2]] = true end
end

-- A map the overlay's code makes (also after it loaded: an LspAttach callback's): taken off with it
function M.track(o, mode, lhs, opts)
  local buf = opts and opts.buffer
  if buf ~= nil and buf ~= false then
    buf = (buf == true or buf == 0) and vim.api.nvim_get_current_buf() or buf
    for _, k in ipairs(raw_keys(mode, lhs, vim.g.mapleader or "\\")) do o.buf_maps[#o.buf_maps + 1] = { buf, k[1], k[3] } end
    return
  end
  for _, k in ipairs(raw_keys(mode, lhs, vim.g.mapleader or "\\")) do
    local key = k[1] .. "\0" .. k[2]
    if not o.maps[key] then
      local before = false
      for _, g in ipairs(vim.api.nvim_get_keymap(k[1])) do
        if g.lhsraw == k[2] then before = patched(g) end
      end
      o.maps[key] = { k[1], k[3], before }
    end
  end
end

---@param name "user"|"personal"
function M.unload(name)
  local o = loaded[name]
  if not o then return end
  loaded[name] = nil
  for i, n in ipairs(order) do
    if n == name then table.remove(order, i) break end
  end
  local plugins = {}
  for _, pname in ipairs(o.order) do
    if o.plugins[pname].dir then plugins[#plugins + 1] = pname end
  end
  if #plugins > 0 then lingering[name] = plugins end
  for _, e in pairs(o.maps) do
    -- (a map made over its own since, VimStorm's InsertEnter plugin's, stays)
    local now = e[4] and find_global(e[1], e[2])
    if not e[4] or (now and same_map(now, e[4])) then
      pcall(vim.api.nvim_del_keymap, e[1], e[2])
      if e[3] then pcall(vim.fn.mapset, e[1], false, e[3]) end
    end
  end
  for _, b in ipairs(o.buf_maps) do
    if vim.api.nvim_buf_is_valid(b[1]) then pcall(vim.api.nvim_buf_del_keymap, b[1], b[2], b[3]) end
  end
  for oname, e in pairs(o.options) do
    local before, after, scope = e[1], e[2], e[3]
    local ok, now = pcall(vim.api.nvim_get_option_value, oname, { scope = "global" })
    if ok and vim.deep_equal(now, after) then
      pcall(vim.api.nvim_set_option_value, oname, before, { scope = "global" })
    end
    -- a window's / buffer's own value the overlay set (vim.o sets the current one's too)
    if scope == "win" then
      for _, win in ipairs(vim.api.nvim_list_wins()) do
        local wok, v = pcall(vim.api.nvim_get_option_value, oname, { win = win })
        if wok and vim.deep_equal(v, after) then pcall(vim.api.nvim_set_option_value, oname, before, { win = win }) end
      end
    elseif scope == "buf" then
      for _, buf in ipairs(vim.api.nvim_list_bufs()) do
        local bok, v = pcall(vim.api.nvim_get_option_value, oname, { buf = buf })
        if bok and vim.deep_equal(v, after) then pcall(vim.api.nvim_set_option_value, oname, before, { buf = buf }) end
      end
    end
  end
  for _, id in ipairs(o.autocmds) do pcall(vim.api.nvim_del_autocmd, id) end
  for _, c in ipairs(o.commands) do pcall(vim.api.nvim_del_user_command, c) end
  for _, p in ipairs(o.rtp) do vim.opt.rtp:remove(p) end
  for _, p in ipairs(o.packpath) do vim.opt.packpath:remove(p) end
  vim.g.mapleader, vim.g.maplocalleader = o.leaders[1], o.leaders[2]
  if (o.colors and vim.g.colors_name == o.colors) or (o.hl and vim.g.colors_name == "darcula-contrast") then
    pcall(vim.cmd.colorscheme, "darcula-contrast")
  end
  rewrap()
end

-- Every overlay off, the last loaded first
function M.unload_all()
  for i = #order, 1, -1 do M.unload(order[i]) end
end

-- After a Feel switch: the overlays it took off for good whose plugins stay loaded (Lua modules, their autocmds
-- and setup cannot be undone) say a restart clears them, one balloon each
function M.tell_lingering()
  for name, plugins in pairs(lingering) do
    local msg = "Its plugins stay loaded until you restart the project (Close Project, open it again): "
      .. table.concat(plugins, ", ")
    vim.schedule(function() vim.notify(msg, vim.log.levels.INFO, { title = TITLES[name] }) end)
  end
  lingering = {}
end

---@return string[] the overlays loaded, in load order
function M.loaded() return vim.list_extend({}, order) end

return M
