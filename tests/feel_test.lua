-- The Feels' editor keys and your own nvim configs (#214, config/feel_keys.lua): Feel vim's stock Vim keys (h j k l,
-- no leader `,`) with your ~/.config/nvim loaded on top, the personal Layer's nvim/ over VimStorm's config under Feel
-- vimstorm and vim, everything back as it was on a switch, and a broken config a balloon, the editor still working.
local H = dofile(os.getenv("NVT_HARNESS"))

local F = H.fixtures
local DIR = H.project("feel-proj", { ["text.txt"] = { "alpha one", "beta two", "gamma three", "abcabcabc" } })

-- A plugin your own Neovim installed (a lazy.nvim spec's `dir`), and one whose config breaks
H.project("feel-plug", {
  ["plugin/feelplug.lua"] = "vim.g.feelplug_plugin = 1",
  ["lua/feelplug/init.lua"] = "return { setup = function(opts) vim.g.feelplug_opts = opts.x end }",
})
H.project("feel-plug2", { ["lua/feelplug2/init.lua"] = "return { setup = function() vim.g.feelplug2 = true end }" })
H.project("feel-broken-plug", { ["lua/brokenplug/init.lua"] = "return {}" })

-- Your ~/.config/nvim (VIMSTORM_USER_XDG_CONFIG_HOME/nvim): no leader of its own, a lua/config/options.lua named as
-- VimStorm's, a WebStorm key overridden, an option, lazy.nvim's setup with what is installed and what is not
H.project("feel-xdg", {
  ["nvim/init.lua"] = {
    "require('config.options')",
    "vim.keymap.set('n', '<leader>x', function() vim.g.user_leader_x = true end, { desc = 'user leader x' })",
    "vim.keymap.set('n', '<D-e>', function() vim.g.user_de = true end, { desc = 'user D-e' })",
    "vim.o.shiftwidth = 7",
    "require('lazy').setup({",
    "  { dir = '" .. F .. "/feel-plug', opts = { x = 7 } },",
    "  { dir = '" .. F .. "/feel-broken-plug', config = function() error('plugin broke') end },",
    "  'someone/not-installed.nvim',",
    "  { import = 'more' },",
    "})",
    "vim.api.nvim_create_autocmd('BufEnter', { callback = function(ev)",
    "  vim.keymap.set('n', 'gz', function() end, { buffer = ev.buf, desc = 'user buffer gz' })",
    "end })",
    "vim.api.nvim_set_hl(0, 'Comment', { fg = '#ff0000' })",
  },
  ["nvim/lua/config/options.lua"] = "vim.g.user_options = true",
  -- a spec module with a plugin's `keys`
  ["nvim/lua/more/p.lua"] = "return { dir = '" .. F .. "/feel-plug2', config = true, keys = { { '<leader>k', function() vim.g.plug_key = true end, desc = 'plug key' } } }",
})

-- The personal Layer's nvim/ (ABE_CONFIG_DIR/nvim): overrides VimStorm's `s` (search) and an option
H.project("feel-abe", {
  ["nvim/init.lua"] = {
    "vim.keymap.set('n', 's', function() vim.g.personal_s = (vim.g.personal_s or 0) + 1 end, { desc = 'personal s' })",
    "vim.o.scrolloff = 13",
    "require('lazy').setup({ { dir = '" .. F .. "/feel-plug-abe' } })",
  },
})
H.project("feel-plug-abe", { ["plugin/abeplug.lua"] = "vim.g.abeplug = (vim.g.abeplug or 0) + 1" })

-- (VIMSTORM_FEEL: the Feel the app starts a project's nvim with)
local ENV = { ABE_CONFIG_DIR = F .. "/feel-abe", VIMSTORM_USER_XDG_CONFIG_HOME = F .. "/feel-xdg", VIMSTORM_FEEL = "vimstorm" }

local function feel(tbl) H.call("config.feel", "set", tbl) end
local function at(row, col) H.lua("vim.api.nvim_win_set_cursor(0, { ... })", { row, col }) end
local function cur() return H.cursor() end
local function map(lhs, mode) return H.lua("return vim.fn.maparg(...)", { lhs, mode or "n" }) end
local function desc(lhs) return H.lua("return vim.fn.maparg(..., 'n', false, true).desc", { lhs }) end
local function loaded() return table.concat(H.call("config.userconfig", "loaded") or {}, ",") end
local function g(name) return H.lua("return vim.g[...]", { name }) end
-- lazy.nvim's change check (a 2 s timer, run here at once) warns "set vim.g.mapleader BEFORE loading lazy" when the
-- leader differs from the one lazy started with: a Feel switch changes it on purpose, so none (#229)
local function lazy_warned()
  H.lua("require('lazy.manage.reloader').check()")
  H.settle(50, 500)
  return H.last("popups", "balloon", function(p)
    return tostring(p.msg):find("leader", 1, true) ~= nil and tostring(p.msg):find("BEFORE", 1, true) ~= nil
  end) ~= nil
end
local function moves(keys, row, col)
  H.keys(keys)
  return H.wait_for(function()
    local c = cur()
    return c[1] == row and c[2] == col
  end, 2000)
end

H.run(function()
  H.start(DIR, { "text.txt" }, { env = ENV })
  H.allow_errors("plugin broke")

  -- Feel vimstorm (VimStorm's own until the app says): the personal Layer's nvim/ over VimStorm's config
  H.expect("Feel vimstorm loads the personal Layer's nvim/", function() return loaded() == "personal" end, loaded)
  H.check("...its s overrides VimStorm's (search)", desc("s") == "personal s", desc("s"))
  H.keys("s")
  H.expect("...and runs", function() return g("personal_s") == 1 end)
  H.check("...its option is in force", H.lua("return vim.o.scrolloff") == 13)
  H.check("your ~/.config/nvim is not (Feel vim's)", g("user_options") == nil)
  at(1, 0)
  H.check("VimStorm's keys: ö moves down", moves("ö", 2, 0), cur)
  H.check("...j is off", (function()
    H.keys("j")
    H.settle(50, 500)
    return cur()[1] == 2
  end)(), cur)
  local webstorm_de = desc("<D-e>")

  -- Feel vim: stock Vim keys, your config on top, the personal Layer's last
  feel({ feel = "vim" })
  H.expect("Feel vim loads your nvim config, then the personal Layer's", function() return loaded() == "user,personal" end, loaded)
  at(1, 0)
  H.check("j moves down", moves("j", 2, 0), cur)
  H.check("l moves right", moves("l", 2, 1), cur)
  H.check("k moves up", moves("k", 1, 1), cur)
  H.check("h moves left", moves("h", 1, 0), cur)
  H.check("the arrows move", moves("<Down>", 2, 0), cur)
  H.check("ö is no move", (function()
    H.keys("ö")
    H.settle(50, 500)
    return cur()[1] == 2
  end)(), cur)
  H.check("no leader , : VimStorm's ,v / ,w / ,ff are off", map(",v") == "" and map(",w") == "" and map(",ff") == "", { map(",v"), map(",w") })
  H.check("...the leader is Vim's own (your config sets none)", g("mapleader") == nil, g("mapleader"))
  H.check("...your <leader>x is \\x", desc("\\x") == "user leader x", desc("\\x"))
  at(4, 0)
  H.keys("fc;")
  H.expect("...so , repeats f backwards", function() return cur()[2] == 5 end, cur)
  H.keys(",")
  H.expect("...at once", function() return cur()[2] == 2 end, cur, 600)
  H.check("your lua/config/options.lua is yours, not VimStorm's", g("user_options") == true)
  H.check("your <D-e> overrides the WebStorm key", desc("<D-e>") == "user D-e", desc("<D-e>"))
  H.check("your option is in force", H.lua("return vim.o.shiftwidth") == 7)
  H.check("your installed plugin loads: plugin/ sourced", g("feelplug_plugin") == 1)
  H.check("...its opts given to its setup", g("feelplug_opts") == 7, g("feelplug_opts"))
  H.check("the personal Layer still overrides s", desc("s") == "personal s", desc("s"))
  H.check("a spec module's plugin loads (import), its keys on your leader", g("feelplug2") == true and desc("\\k") == "plug key" and map(",k") == "", { g("feelplug2"), desc("\\k"), map(",k") })
  H.lua("vim.cmd.doautocmd('BufEnter')")
  H.check("your buffer-local map is there", H.lua("return vim.fn.maparg('gz', 'n', false, true).desc") == "user buffer gz")
  local red = H.lua("return vim.api.nvim_get_hl(0, { name = 'Comment' }).fg")
  H.check("your highlight is in force", red == 0xff0000, red)
  local said = H.wait_bridge("popups", "balloon", function(p) return tostring(p.msg):find("not installed: not-installed.nvim", 1, true) ~= nil end)
  H.check("one balloon names what did not load", said ~= nil
    and tostring(said.msg):find("feel-broken-plug: ", 1, true) ~= nil and said.title == "Your nvim config (~/.config/nvim)", said)
  H.check("no lazy.nvim mapleader warning for Feel vim's leader", not lazy_warned())

  -- Back to vimstorm: no residue
  feel({ feel = "vimstorm" })
  H.expect("back on vimstorm: only the personal Layer's", function() return loaded() == "personal" end, loaded)
  at(1, 0)
  H.check("ö moves down again", moves("ö", 2, 0), cur)
  H.check("VimStorm's ,v is back", map(",v") ~= "", map(",v"))
  H.check("...the leader is , again", g("mapleader") == ",", g("mapleader"))
  H.check("...no lazy.nvim mapleader warning on the way back", not lazy_warned())
  H.check("your \\x is gone", map("\\x") == "", map("\\x"))
  H.check("<D-e> is WebStorm's again", desc("<D-e>") == webstorm_de, desc("<D-e>"))
  H.check("shiftwidth is VimStorm's again", H.lua("return vim.o.shiftwidth") ~= 7)
  H.check("the personal s again", desc("s") == "personal s", desc("s"))
  H.check("your plugin's key is not left on , either", map(",k") == "" and map("\\k") == "", { map(",k"), map("\\k") })
  H.check("your buffer-local map is gone", map("gz") == "", map("gz"))
  H.check("Comment is VimStorm's colour again", H.lua("return vim.api.nvim_get_hl(0, { name = 'Comment' }).fg") ~= 0xff0000)
  local restart = H.wait_bridge("popups", "balloon", function(p) return tostring(p.msg):find("restart", 1, true) ~= nil end)
  H.check("...the plugins it loaded: a balloon says they stay until the project opens again", restart ~= nil
    and restart.title == "Your nvim config (~/.config/nvim)" and tostring(restart.msg):find("feel-plug", 1, true) ~= nil, restart)
  H.check("...none for the personal Layer's, loaded again", H.last("popups", "balloon", function(p)
    return p.title == "Your Abe nvim/ config" and tostring(p.msg):find("restart", 1, true) ~= nil
  end) == nil and g("abeplug") ~= nil)

  -- webstorm (Vim mode off): no config of yours, VimStorm's s
  feel({ feel = "webstorm", editor = { vim = false } })
  H.expect("Feel webstorm loads none", function() return loaded() == "" end, loaded)
  H.check("...VimStorm's s (search) is back", map("s") == "/", map("s"))
  H.check("...the personal option is off", H.lua("return vim.o.scrolloff") ~= 13)
  feel({ feel = "vimstorm" })
  H.expect("vimstorm again: the personal Layer's again", function() return loaded() == "personal" end, loaded)
  H.stop()

  -- A broken personal config: a balloon, the rest of VimStorm working
  H.project("feel-abe-broken", {
    ["nvim/init.lua"] = { "vim.keymap.set('n', 'gX', function() vim.g.before_boom = true end)", "error('boom in my config')" },
  })
  H.start(DIR, { "text.txt" }, { env = { ABE_CONFIG_DIR = F .. "/feel-abe-broken", VIMSTORM_USER_XDG_CONFIG_HOME = F .. "/none", VIMSTORM_FEEL = "vimstorm" } })
  H.allow_errors("boom in my config")
  local boom = H.wait_bridge("popups", "balloon", function(p) return tostring(p.msg):find("boom in my config", 1, true) ~= nil end)
  H.check("a broken config is an error balloon", boom ~= nil and boom.title == "Your Abe nvim/ config", boom)
  H.check("...what it did before the error stays", map("gX") ~= "")
  at(1, 0)
  H.check("...the editor works: ö moves", moves("ö", 2, 0), cur)
  H.keys("iXY<Esc>")
  H.expect("...and typing types", function() return H.line(2):sub(1, 2) == "XY" end, function() return H.line(2) end)
  H.check("...the app's surfaces answer (focus)", H.focus() == "split", H.focus())
  feel({ feel = "vim" })
  H.expect("Feel vim with no ~/.config/nvim: the personal Layer's alone", function() return loaded() == "personal" end, loaded)
  at(1, 0)
  H.check("...stock keys all the same", moves("j", 2, 0), cur)
  H.stop()

  -- An init.vim: its `lua` lines are yours (your leader, the lazy.nvim shim with setup("plugins")); a webstorm start
  -- loads no config of yours at all
  H.project("feel-xdg-vim", {
    ["nvim/init.vim"] = {
      "let mapleader = ' '",
      "lua vim.keymap.set('n', '<leader>y', function() vim.g.vim_y = true end, { desc = 'vim y' })",
      "lua require('lazy').setup('plugins')",
    },
    ["nvim/lua/plugins/one.lua"] = "return { { dir = '" .. F .. "/feel-plug', opts = { x = 9 } } }",
  })
  H.project("feel-abe-flag", { ["nvim/init.lua"] = "vim.g.personal_ran = (vim.g.personal_ran or 0) + 1" })
  H.start(DIR, { "text.txt" }, { env = { ABE_CONFIG_DIR = F .. "/feel-abe-flag", VIMSTORM_USER_XDG_CONFIG_HOME = F .. "/feel-xdg-vim", VIMSTORM_FEEL = "webstorm", VIMSTORM_FEEL_VIM = "0" } })
  H.settle(100, 1000)
  H.check("started as webstorm: the personal Layer's never ran", g("personal_ran") == nil and loaded() == "", { g("personal_ran"), loaded() })
  feel({ feel = "vim" })
  H.expect("Feel vim: your init.vim and the personal Layer's", function() return loaded() == "user,personal" end, loaded)
  H.check("...init.vim's lua map on your leader", desc(" y") == "vim y" and map(",y") == "", { desc(" y"), map(",y") })
  H.check("...setup('plugins') imports lua/plugins/", g("feelplug_opts") == 9, g("feelplug_opts"))
  feel({ feel = "vimstorm" })
  H.expect("back on vimstorm: init.vim's map gone, no , residue", function() return map(" y") == "" and map(",y") == "" end,
    function() return { map(" y"), map(",y") } end)
  H.stop()

  -- A ~/.config/nvim that is VimStorm's own nvim/ (#226): this checkout's (the app's config link target) or another
  -- checkout's is not a config of yours: left out with one quiet line, once; stock Vim keys stay
  local repo = vim.fn.fnamemodify(os.getenv("NVT_HARNESS"), ":p:h:h")
  vim.fn.mkdir(F .. "/feel-xdg-self", "p")
  vim.uv.fs_symlink(repo .. "/nvim", F .. "/feel-xdg-self/nvim")
  H.project("feel-xdg-other", {
    ["nvim/init.lua"] = "vim.g.other_checkout_ran = true",
    ["nvim/lua/config/app.lua"] = "return {}",
    ["nvim/colors/darcula-contrast.lua"] = "",
  })
  for _, home in ipairs({ "feel-xdg-self", "feel-xdg-other" }) do
    H.start(DIR, { "text.txt" }, { env = { ABE_CONFIG_DIR = F .. "/none", VIMSTORM_USER_XDG_CONFIG_HOME = F .. "/" .. home, VIMSTORM_FEEL = "vimstorm" } })
    feel({ feel = "vim" })
    local note = H.wait_bridge("popups", "balloon", function(p) return tostring(p.msg):find("VimStorm's own", 1, true) ~= nil end)
    H.check(home .. ": Feel vim leaves it out, one quiet line", note ~= nil and note.level == "info"
      and select(2, tostring(note.msg):gsub("\n", "")) == 0, note)
    H.check("...nothing of it loaded", loaded() == "" and g("other_checkout_ran") == nil, { loaded(), g("other_checkout_ran") })
    at(1, 0)
    H.check("...stock Vim keys: j moves down", moves("j", 2, 0), cur)
    H.check("...k moves up", moves("k", 1, 0), cur)
    H.check("...no leader , (VimStorm's ,v off)", map(",v") == "", map(",v"))
    feel({ feel = "vimstorm" })
    H.expect("...back on vimstorm: ö moves", function() return moves("ö", 2, 0) end, cur)
    feel({ feel = "vim" })
    H.settle(100, 1000)
    local notes = 0
    for _, p in ipairs(H.bridge("popups")) do
      if p.event == "balloon" and tostring(p.msg):find("VimStorm's own", 1, true) then notes = notes + 1 end
    end
    H.check("...said once, not on every switch", notes == 1, notes)
    H.stop()
  end
end)
