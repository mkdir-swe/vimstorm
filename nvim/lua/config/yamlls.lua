-- yaml-language-server's settings: workflow files (`workflows/*.yaml` of every Layer: built-in, repo, yours)
-- get completion and checks from Abe's JSON Schema (abe/packages/core/schema/workflow.schema.json, generated
-- from the zod schemas). The schema sits in the repo checkout beside nvim/; the config is read from there (the
-- app's VIMSTORM_REPO, a dev checkout). ABE_WORKFLOW_SCHEMA overrides; no file (a config copied without abe/): no schema.
local M = {}

M.GLOBS = { "**/workflows/*.yaml", "**/workflows/*.yml" }

---@return string? path of the schema file, nil when there is none
function M.schema_path()
  local env = vim.env.ABE_WORKFLOW_SCHEMA
  if env and env ~= "" then return vim.uv.fs_stat(env) and env or nil end
  local here = vim.uv.fs_realpath(debug.getinfo(1, "S").source:sub(2)) -- <repo>/nvim/lua/config/yamlls.lua
  if not here then return nil end
  local path = vim.fs.normalize(vim.fs.dirname(here) .. "/../../../abe/packages/core/schema/workflow.schema.json")
  return vim.uv.fs_stat(path) and path or nil
end

---@return table settings for vim.lsp.config("yamlls")
function M.settings()
  local path = M.schema_path()
  return {
    yaml = {
      schemas = path and { [vim.uri_from_fname(path)] = M.GLOBS } or {},
      schemaStore = { enable = false, url = "" }, -- only Abe's schema; no catalog fetch
    },
  }
end

return M
