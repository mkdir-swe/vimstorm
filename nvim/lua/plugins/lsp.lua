-- Servers (lspconfig names) with the binary their Mason package puts in mason/bin; prettierd is installed too
local SERVERS = {
  vtsls = "vtsls",
  eslint = "vscode-eslint-language-server",
  jsonls = "vscode-json-language-server",
  html = "vscode-html-language-server",
  cssls = "vscode-css-language-server",
  lua_ls = "lua-language-server",
  yamlls = "yaml-language-server",
}
local MASON = vim.fn.stdpath("data") .. "/mason"
local function installed(bin) return vim.uv.fs_stat(MASON .. "/bin/" .. bin) ~= nil end

-- Lines of a file a server location points at: the loaded buffer, else the file. Cached per file until it
-- changes (buffer changedtick / file mtime + size): every inlay-hint reply asks for each hint's callee file.
local file_cache = {} ---@type table<string, {key: string, lines: string[]}>
---@param uri string
---@return string[]
local function file_lines(uri)
  local path = vim.uri_to_fname(uri)
  local buf = vim.fn.bufnr(path) -- (not uri_to_bufnr: that adds a buffer per library file)
  local key, read
  if buf > 0 and vim.api.nvim_buf_get_name(buf) == path and vim.api.nvim_buf_is_loaded(buf) then
    key = "b" .. buf .. ":" .. vim.api.nvim_buf_get_changedtick(buf)
    read = function() return vim.api.nvim_buf_get_lines(buf, 0, -1, false) end
  else
    local st = vim.uv.fs_stat(path)
    if not st then return {} end
    key = ("f%d.%d:%d"):format(st.mtime.sec, st.mtime.nsec, st.size)
    read = function()
      local ok, lines = pcall(vim.fn.readfile, path)
      return ok and lines or {}
    end
  end
  local hit = file_cache[path]
  if hit and hit.key == key then return hit.lines end
  local lines = read()
  file_cache[path] = { key = key, lines = lines }
  return lines
end

-- Is the parameter at `loc` declared in a function type held by a property / const (`create: <T>(value: T) =>`)
-- rather than by a function or method declaration (`literal<T>(value: T)`) or a function value (`= (x) =>`)?
-- WebStorm names no arguments of such callees: zod 3's `z.literal('ASC')`, `z.object({…})` (all
-- `static create: (…) => …`) show no hints there, while tsserver (vtsls) names them.
---@param loc lsp.Location
local function typed_callee(loc)
  local lines = file_lines(loc.uri)
  local l, c = loc.range.start.line + 1, loc.range.start.character
  if not lines[l] then return false end
  local text = table.concat(lines, "\n", math.max(1, l - 8), l - 1)
  text = (l > 1 and text .. "\n" or "") .. lines[l]:sub(1, c)
  -- back to the "(" opening this parameter list
  local depth, i = 0, #text
  while i > 0 do
    local ch = text:sub(i, i)
    if ch == ")" or ch == "]" or ch == "}" then
      depth = depth + 1
    elseif ch == "(" or ch == "[" or ch == "{" then
      if depth == 0 then break end
      depth = depth - 1
    end
    i = i - 1
  end
  if i == 0 or text:sub(i, i) ~= "(" then return false end
  local before = text:sub(1, i - 1):gsub("%s+$", "")
  if before:sub(-1) == ">" then -- type parameters: <T extends X<Y>>
    local d, j = 0, #before
    while j > 0 do
      local ch = before:sub(j, j)
      if ch == ">" then d = d + 1 elseif ch == "<" then d = d - 1 end
      if d == 0 then break end
      j = j - 1
    end
    before = before:sub(1, j - 1):gsub("%s+$", "")
  end
  return before:match("[%w_$]%??%s*:$") ~= nil
end

-- vtsls' inlay hints without the parameter names WebStorm doesn't show (typed_callee)
---@param result lsp.InlayHint[]?
local function webstorm_hints(result)
  if not result then return result end
  return vim.tbl_filter(function(h)
    local part = h.kind == 2 and type(h.label) == "table" and h.label[1] or nil
    return not (part and part.location and typed_callee(part.location))
  end, result)
end

-- Module namespace objects (`import { z } from 'zod'`, `import * as ns`, a default import of `export * as`) are
-- JS.GLOBAL_VARIABLE in WebStorm (purple bold italic); tsserver gives them no semantic token, so they are found
-- here: `import * as` by syntax, other imports by their hover ("import z", where a function says "(alias)
-- function …") plus a type (an unresolved import says "import x" too). Answers are cached per module + name;
-- the marks are redrawn after edits (debounced).
local NS = vim.api.nvim_create_namespace("ws_namespace_imports")
local is_namespace = {} ---@type table<string, boolean>
local ns_timers = {} ---@type table<integer, uv.uv_timer_t>
local schedule_namespaces ---@type fun(buf: integer, delay?: integer)
local id_query = {} ---@type table<string, vim.treesitter.Query>

---@param buf integer
local function mark_namespaces(buf)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  local ok, parser = pcall(vim.treesitter.get_parser, buf)
  if not ok or not parser then return end
  local tree = parser:parse()[1]
  if not tree then return end
  local root = tree:root()
  local dir = vim.fs.dirname(vim.api.nvim_buf_get_name(buf))
  local names, ask = {}, {} ---@type table<string, boolean>, {node: TSNode, key: string, name: string}[]
  for imp in root:iter_children() do
    if imp:type() == "import_statement" then
      local src = imp:field("source")[1]
      local spec = src and vim.treesitter.get_node_text(src, buf):sub(2, -2) or ""
      if spec:sub(1, 1) == "." then spec = vim.fs.normalize(dir .. "/" .. spec) end
      local function local_name(node)
        local name = vim.treesitter.get_node_text(node, buf)
        local key = spec .. "#" .. name
        if is_namespace[key] then
          names[name] = true
        elseif is_namespace[key] == nil then
          ask[#ask + 1] = { node = node, key = key, name = name }
        end
      end
      for clause in imp:iter_children() do
        if clause:type() == "import_clause" then
          for part in clause:iter_children() do
            local t = part:type()
            if t == "namespace_import" then
              for id in part:iter_children() do
                if id:type() == "identifier" then names[vim.treesitter.get_node_text(id, buf)] = true end
              end
            elseif t == "identifier" then
              local_name(part)
            elseif t == "named_imports" then
              for s in part:iter_children() do
                if s:type() == "import_specifier" then
                  local id = s:field("alias")[1] or s:field("name")[1]
                  if id and id:type() == "identifier" then local_name(id) end
                end
              end
            end
          end
        end
      end
    end
  end
  vim.api.nvim_buf_clear_namespace(buf, NS, 0, -1)
  if next(names) then
    local lang = parser:lang()
    id_query[lang] = id_query[lang] or vim.treesitter.query.parse(lang, "(identifier) @id")
    local q = id_query[lang]
    for _, node in q:iter_captures(root, buf) do
      if names[vim.treesitter.get_node_text(node, buf)] then
        local sr, sc, er, ec = node:range()
        vim.api.nvim_buf_set_extmark(buf, NS, sr, sc,
          { end_row = er, end_col = ec, hl_group = "WsNamespaceImport", priority = 127 })
      end
    end
  end
  local client = vim.lsp.get_clients({ bufnr = buf, name = "vtsls" })[1]
  if not client or #ask == 0 then return end
  local pending = #ask
  local function answered()
    pending = pending - 1
    if pending > 0 or not vim.api.nvim_buf_is_valid(buf) then return end
    -- all answered: draw the namespaces found; no answer yet (server still loading): ask again later
    local found, unknown = false, false
    for _, b in ipairs(ask) do
      if is_namespace[b.key] then found = true elseif is_namespace[b.key] == nil then unknown = true end
    end
    if found then mark_namespaces(buf) end
    if unknown and (vim.b[buf].ws_namespace_retries or 0) < 15 then
      vim.b[buf].ws_namespace_retries = (vim.b[buf].ws_namespace_retries or 0) + 1
      schedule_namespaces(buf, 2000)
    end
  end
  for _, a in ipairs(ask) do
    local row, col = a.node:start()
    local params = { textDocument = { uri = vim.uri_from_bufnr(buf) }, position = { line = row, character = col } }
    client:request("textDocument/hover", params, function(err, res)
      if err then return answered() end -- (the server is still loading the project)
      local value = res and res.contents and (res.contents.value or res.contents)
      local first = type(value) == "string" and value:match("```%w*\n(.-)\n") or "" -- the signature line
      if first ~= "import " .. a.name then
        is_namespace[a.key] = false
        return answered()
      end
      -- "import z" is also what an unresolved import says: a namespace has a type (the module)
      client:request("textDocument/typeDefinition", params, function(err2, defs)
        if not err2 then is_namespace[a.key] = type(defs) == "table" and #defs > 0 end
        answered()
      end, buf)
    end, buf)
  end
end

---@param buf integer
---@param delay? integer ms
function schedule_namespaces(buf, delay)
  local t = ns_timers[buf] or vim.uv.new_timer()
  ns_timers[buf] = t
  t:start(delay or 300, 0, vim.schedule_wrap(function()
    if not vim.api.nvim_buf_is_valid(buf) then
      t:close()
      ns_timers[buf] = nil
      return
    end
    mark_namespaces(buf)
  end))
end

return {
  -- LSP servers installed via :Mason, enabled directly (perf: mason / mason-lspconfig cost ~20 ms to load; they
  -- only load when a package is missing, or for :Mason). Loaded right after the first screen is drawn.
  {
    "neovim/nvim-lspconfig", -- server configs (lsp/*.lua)
    event = "VeryLazy",
    init = function()
      -- what mason's setup does (PATH = "prepend"), without loading it: servers and prettierd from mason/bin
      vim.env.MASON = MASON
      if not (vim.env.PATH or ""):find(MASON .. "/bin", 1, true) then
        vim.env.PATH = MASON .. "/bin:" .. (vim.env.PATH or "")
      end
    end,
    config = function()
      -- Inlay hints as WebStorm shows them: parameter names for literal arguments (`add(x: 1, y: 2)`) and enum
      -- values. No type hints (variables, fields, parameters, return types): WebStorm draws none on e.g.
      -- `const rest = list.filter(…)`, while tsserver prints the whole inferred object type there.
      local hints = {
        parameterNames = { enabled = "literals" },
        parameterTypes = { enabled = false },
        variableTypes = { enabled = false },
        propertyDeclarationTypes = { enabled = false },
        functionLikeReturnTypes = { enabled = false },
        enumMemberValues = { enabled = true },
      }
      vim.lsp.config("vtsls", {
        settings = { typescript = { inlayHints = hints }, javascript = { inlayHints = hints } },
        handlers = {
          ["textDocument/inlayHint"] = function(err, result, ctx, config)
            return vim.lsp.handlers["textDocument/inlayHint"](err, webstorm_hints(result), ctx, config)
          end,
        },
      })
      vim.api.nvim_create_autocmd("LspAttach", {
        group = vim.api.nvim_create_augroup("ws_namespace_imports", { clear = true }),
        callback = function(ev)
          local client = vim.lsp.get_client_by_id(ev.data.client_id)
          if not (client and client.name == "vtsls") then return end
          schedule_namespaces(ev.buf)
          if vim.b[ev.buf].ws_namespace_imports then return end
          vim.b[ev.buf].ws_namespace_imports = true
          vim.api.nvim_create_autocmd({ "TextChanged", "InsertLeave" }, {
            group = "ws_namespace_imports",
            buffer = ev.buf,
            callback = function() schedule_namespaces(ev.buf) end,
          })
        end,
      })
      -- Repos without eslint in node_modules: stay quiet like WebStorm (no "Unable to find ESLint library")
      vim.lsp.config("yamlls", { settings = require("config.yamlls").settings() }) -- workflow YAML: Abe's schema
      vim.lsp.config("eslint", { handlers = { ["eslint/noLibrary"] = function() return {} end } })
      vim.lsp.inlay_hint.enable(true)
      -- A file closed right after opening (,w, tab limit) while the server is busy (starting, loading a project):
      -- the inlay hints asked for on open are still out, vtsls closes the file first and then answers "No
      -- Project" as an error balloon. Cancel what's still out for the file; LspDetach comes before the didClose.
      vim.api.nvim_create_autocmd("LspDetach", {
        group = vim.api.nvim_create_augroup("ws_lsp_detach_cancel", { clear = true }),
        callback = function(ev)
          local client = vim.lsp.get_client_by_id(ev.data.client_id)
          if not client then return end
          for id, req in pairs(client.requests) do
            if req.bufnr == ev.buf and req.type == "pending" then client:cancel_request(id) end
          end
        end,
      })
      -- Find usages (grr, Cmd+B on a declaration, menu): the first search after the server started can take
      -- seconds (tsserver loads the whole project); say so when it takes longer than a moment
      local searching = {} ---@type table<string, uv.uv_timer_t>
      vim.api.nvim_create_autocmd("LspRequest", {
        group = vim.api.nvim_create_augroup("ws_usages_progress", { clear = true }),
        callback = function(ev)
          local req = ev.data.request
          if req.method ~= "textDocument/references" then return end
          local key = ev.data.client_id .. ":" .. ev.data.request_id
          if req.type == "pending" then
            searching[key] = vim.defer_fn(function()
              if searching[key] then vim.notify("Finding usages…", vim.log.levels.INFO, { id = "ws_usages", timeout = false }) end
            end, 400)
          elseif searching[key] then
            searching[key]:stop()
            searching[key] = nil
            if not next(searching) and rawget(_G, "Snacks") then Snacks.notifier.hide("ws_usages") end
          end
        end,
      })
      local ready, missing = {}, false
      for name, bin in pairs(SERVERS) do
        if installed(bin) then ready[#ready + 1] = name else missing = true end
      end
      vim.lsp.enable(ready) -- also starts them for the files already open
      -- New machine / missing package: mason-lspconfig installs (and enables) it, registry refresh needs the network
      if not missing and installed("prettierd") then return end
      vim.schedule(function()
        require("mason-lspconfig").setup({ ensure_installed = vim.tbl_keys(SERVERS) })
        if installed("prettierd") then return end
        local registry = require("mason-registry") -- prettierd (format on save) isn't an LSP: install it here
        registry.refresh(function()
          local ok, pkg = pcall(registry.get_package, "prettierd")
          if ok and not pkg:is_installed() then pkg:install() end
        end)
      end)
    end,
  },
  -- Package manager (:Mason); loads on its own only when something has to be installed
  { "mason-org/mason.nvim", cmd = { "Mason", "MasonInstall", "MasonUpdate", "MasonLog" }, opts = { PATH = "skip" } },
  { "mason-org/mason-lspconfig.nvim", lazy = true, dependencies = { "mason-org/mason.nvim" } },

  -- Makes lua_ls understand the nvim config
  { "folke/lazydev.nvim", ft = "lua", opts = {} },

  -- Completion
  {
    "saghen/blink.cmp",
    version = "1.*",
    event = "VeryLazy", -- loaded before the first keystroke, so the very first word gets the popup too
    config = function(_, opts)
      require("blink.cmp").setup(opts)
      -- the app draws the menu, its documentation and signature help natively (blink stays the engine)
      require("config.app.floats").blink()
      -- Inlay hints in front of the caret come and go while typing (the server re-sends them), which moves the
      -- text sideways; the menu (placed relative to the caret) follows when the caret's screen column changed
      -- after it was placed (it sat a few columns off). Checked after each redraw, only while the menu is open.
      local menu = require("blink.cmp.completion.windows.menu")
      local placed, pending ---@type integer?, boolean?
      vim.api.nvim_set_decoration_provider(vim.api.nvim_create_namespace("ws_cmp_follow"), {
        on_end = function()
          if pending then return end
          if not (menu.win and menu.win:is_open()) then
            placed = nil
            return
          end
          pending = true
          vim.schedule(function()
            pending = false
            if not menu.win:is_open() then return end
            local col = vim.fn.wincol()
            if col ~= placed then
              placed = col
              menu.update_position()
            end
          end)
        end,
      })
    end,
    opts = {
      keymap = {
        preset = "enter", -- Enter accepts, like WebStorm
        -- Tab accepts the Copilot suggestion when one is showing, else the selected completion (WebStorm: Tab
        -- replaces), else a tab
        ["<Tab>"] = {
          function() return require("config.postfix").tab() end, -- `expr.log` / `log` (config/postfix.lua)
          function()
            local ok, sug = pcall(require, "copilot.suggestion")
            if ok and sug.is_visible() then
              sug.accept()
              return true
            end
          end,
          "accept",
          "snippet_forward",
          "fallback",
        },
      },
      completion = {
        -- WebStorm lookup: moving through the list doesn't touch the text, Enter inserts
        list = { selection = { preselect = true, auto_insert = false } },
        menu = { max_height = 12 },
        documentation = { auto_show = true, auto_show_delay_ms = 300 },
      },
      signature = { enabled = true },
      sources = {
        default = { "lazydev", "lsp", "path", "snippets", "buffer" },
        providers = { lazydev = { name = "LazyDev", module = "lazydev.integrations.blink", score_offset = 100 } },
      },
    },
  },

  -- Prettier on save
  {
    "stevearc/conform.nvim",
    event = "BufWritePre",
    cmd = "ConformInfo",
    keys = {
      { "<leader>cf", function() require("conform").format({ async = true }) end, desc = "Reformat code" },
    },
    opts = {
      formatters_by_ft = (function()
        local prettier = { "prettierd", "prettier", stop_after_first = true }
        local t = {}
        for _, ft in ipairs({ "javascript", "javascriptreact", "typescript", "typescriptreact", "json", "jsonc", "css", "scss", "html", "markdown", "yaml" }) do
          t[ft] = prettier
        end
        return t
      end)(),
      format_on_save = { timeout_ms = 1000, lsp_format = "fallback" },
    },
  },
}
