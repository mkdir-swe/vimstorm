-- WebStorm's problem files: red wavy underline on a file's tree row (and its folders) and its tab.
-- Only errors in the code itself count (TypeScript, syntax). Linter results (ESLint) show in the
-- editor only: WebStorm's project-wide problem highlighting doesn't include them.
local M = {}
local ERROR = vim.diagnostic.severity.ERROR
local LINTERS = { "eslint", "biome", "oxlint", "stylelint" }

local function is_lint(d)
  local src = (d.source or ""):lower()
  local ns = vim.diagnostic.get_namespace(d.namespace)
  local name = (ns and ns.name or ""):lower()
  for _, l in ipairs(LINTERS) do
    if src:find(l, 1, true) or name:find(l, 1, true) then return true end
  end
  return false
end

-- Does the buffer get the red wavy underline (tab, tree row)?
function M.has_error(buf)
  for _, d in ipairs(vim.diagnostic.get(buf, { severity = ERROR })) do
    if not is_lint(d) then return true end
  end
  return false
end

local paths ---@type table<string, true>?
vim.api.nvim_create_autocmd({ "DiagnosticChanged", "BufFilePost" }, {
  group = vim.api.nvim_create_augroup("ws_problems", { clear = true }),
  callback = function() paths = nil end,
})

-- Files with errors and all their folders, by absolute path
---@return table<string, true>
function M.paths()
  if paths then return paths end
  paths = {}
  for _, d in ipairs(vim.diagnostic.get(nil, { severity = ERROR })) do
    if not is_lint(d) and vim.api.nvim_buf_is_valid(d.bufnr) then
      local f = vim.api.nvim_buf_get_name(d.bufnr)
      while f ~= "" and not paths[f] do
        paths[f] = true
        local parent = vim.fs.dirname(f)
        if parent == f then break end
        f = parent
      end
    end
  end
  return paths
end

-- Each file's errors and warnings, every source (linters too, as VS Code's problem badge counts them): the tree
-- shows them under the Feel's tree.decorations = letters. Files with none are left out.
---@return {path: string, errors: integer, warnings: integer}[]
function M.counts()
  local by = {} ---@type table<string, {path: string, errors: integer, warnings: integer}>
  local WARN = vim.diagnostic.severity.WARN
  for _, d in ipairs(vim.diagnostic.get(nil, { severity = { min = WARN } })) do
    if vim.api.nvim_buf_is_valid(d.bufnr) then
      local f = vim.api.nvim_buf_get_name(d.bufnr)
      if f ~= "" then
        local c = by[f] or { path = f, errors = 0, warnings = 0 }
        by[f] = c
        if d.severity == ERROR then c.errors = c.errors + 1 else c.warnings = c.warnings + 1 end
      end
    end
  end
  local out = vim.tbl_values(by)
  table.sort(out, function(a, b) return a.path < b.path end)
  return out
end

return M
