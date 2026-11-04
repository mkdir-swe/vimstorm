-- File icons like WebStorm's New UI set, served through mini.icons so every list uses the same ones:
-- tree, tabs, status bar, pickers, switcher, git changes, usages popup. Most are WebStorm's own icons
-- (intellij-community expui/*_dark.svg) in the "WebStorm Icons" font (WebStormIcons.otf, bundled with the app),
-- code point U+10F000 + the icon's index; the app maps glyphs back to icon names (config/app/menu.lua). Icons only in WebStorm's own plugins (React tsx / jsx, less, sass, eslint, prettier)
-- stay the closest Nerd Font glyph. Colored with the SVG's main fill (WsIcon* groups,
-- colors/darcula-contrast.lua "File icons").
-- Which icon a file gets follows his WebStorm (options/filetypes.xml, disabled_plugins.txt):
-- * types WebStorm only knows through TextMate bundles (lua, python, go, Dockerfile with the Docker
--   plugin off...) or not at all get its plain text icon, so does every other mini.icons built-in
-- * .env / .env.local / *.properties are YAML; csv / tsv / log plain text
-- * folders: one plain outline folder, whatever the name (WebStorm has no per-name folder icons)
-- A glyph has one color, so two-tone icons keep their main shape and color: the TS / JS / CSS badges'
-- letters are cut out (background shows instead of white / dark), dark fills under outlines are left
-- out, *Test icons are the language icon without the red/green run mark.
local M = {}

-- glyph, highlight group per WebStorm icon (comment: the WebStorm SVG it stands for).
-- U+10F0xx: the icon font; others: Nerd Font glyphs.
local I = {
  folder = { glyph = "\u{10f000}", hl = "WsIconFolder" }, -- nodes/folder (config/tree.lua, native changes trees)
  folder_link = { glyph = "\u{10f001}", hl = "WsIconFolder" }, -- nodes/folder + symlink arrow (tree: symlinked dirs)
  file = { glyph = "\u{10f002}", hl = "WsIconGray" }, -- anyType: page outline
  text = { glyph = "\u{10f003}", hl = "WsIconGray" }, -- text: thin left-aligned lines
  ts = { glyph = "\u{10f004}", hl = "WsIconBlue" }, -- typeScript: blue rounded badge, "TS" cut out
  js = { glyph = "\u{10f005}", hl = "WsIconYellow" }, -- javaScript: yellow badge, "JS" cut out
  json = { glyph = "\u{10f006}", hl = "WsIconPurple" }, -- json (package.json, tsconfig.json too): braces
  md = { glyph = "\u{10f007}", hl = "WsIconBlue" }, -- markdown: "M↓"
  css = { glyph = "\u{10f008}", hl = "WsIconBlue" }, -- css: CSS3 shield, "3" cut out
  html = { glyph = "\u{10f009}", hl = "WsIconGreen" }, -- html: green "<>"
  xhtml = { glyph = "\u{10f00a}", hl = "WsIconBlue" }, -- xhtml: blue "<>"
  xml = { glyph = "\u{10f00b}", hl = "WsIconOrange" }, -- xml: orange "</>"
  yaml = { glyph = "\u{10f00c}", hl = "WsIconRed" }, -- yaml: red page outline, "Y" in a corner (gray in WebStorm)
  image = { glyph = "\u{10f00d}", hl = "WsIconBlue" }, -- image (png, svg, ico...): picture frame outline
  font = { glyph = "\u{10f00e}", hl = "WsIconGray" }, -- font: "Aa"
  ignored = { glyph = "\u{10f00f}", hl = "WsIconGray" }, -- ignored (.gitignore...): circle with slash
  shell = { glyph = "\u{10f010}", hl = "WsIconGray" }, -- shell: terminal box ">_"
  sql = { glyph = "\u{10f011}", hl = "WsIconPurple" }, -- sql: database stack outline
  archive = { glyph = "\u{10f012}", hl = "WsIconBlue" }, -- archive: rounded box with zipper
  gear = { glyph = "\u{10f013}", hl = "WsIconGray" }, -- editorConfig: gear outline
  sourcemap = { glyph = "\u{10f014}", hl = "WsIconPurple" }, -- sourceMap: braces
  -- not in intellij-community (WebStorm plugins): Nerd Font glyphs
  tsx = { glyph = "\u{e7ba}", hl = "WsIconBlue" }, -- tsx: blue React atom
  jsx = { glyph = "\u{e7ba}", hl = "WsIconGold" }, -- jsx: gold React atom
  less = { glyph = "\u{eb0f}", hl = "WsIconBlue" }, -- less: blue braces
  sass = { glyph = "\u{f07ec}", hl = "WsIconPink" }, -- sass (scss too): pink disc with white "S"
  eslint = { glyph = "\u{e667}", hl = "WsIconWhite" }, -- eslint: white hexagon, hexagon hole (gray core)
  prettier = { glyph = "\u{e6b4}", hl = "WsIconBlue" }, -- prettier: stacked bars (mostly blue)
}
M.I = I

-- *.test.ts etc. fall through to their language ("ts"), like WebStorm's *Test icons minus the run mark
local extension = {
  ts = I.ts, mts = I.ts, cts = I.ts, ["d.ts"] = I.ts,
  tsx = I.tsx,
  js = I.js, mjs = I.js, cjs = I.js,
  jsx = I.jsx,
  json = I.json, jsonc = I.json, json5 = I.json, map = I.sourcemap,
  md = I.md, mdx = I.md, markdown = I.md,
  css = I.css, less = I.less, scss = I.sass, sass = I.sass,
  html = I.html, htm = I.html, xhtml = I.xhtml,
  xml = I.xml, xsd = I.xml,
  yml = I.yaml, yaml = I.yaml, properties = I.yaml,
  png = I.image, jpg = I.image, jpeg = I.image, gif = I.image, webp = I.image, svg = I.image, ico = I.image,
  bmp = I.image, avif = I.image,
  ttf = I.font, otf = I.font, woff = I.font, woff2 = I.font, eot = I.font,
  txt = I.text, log = I.text, lock = I.text, csv = I.text, tsv = I.text,
  sh = I.shell, bash = I.shell, zsh = I.shell,
  sql = I.sql,
  zip = I.archive, tar = I.archive, gz = I.archive, tgz = I.archive, jar = I.archive,
}

local file = {
  Dockerfile = I.text, ["docker-compose.yml"] = I.yaml, ["docker-compose.yaml"] = I.yaml,
  ["package.json"] = I.json, ["package-lock.json"] = I.json, ["tsconfig.json"] = I.json,
  ["README.md"] = I.md, README = I.text, LICENSE = I.text, ["LICENSE.md"] = I.md,
  [".gitignore"] = I.ignored, [".prettierignore"] = I.ignored, [".dockerignore"] = I.ignored,
  [".npmignore"] = I.ignored, [".eslintignore"] = I.ignored, [".stylelintignore"] = I.ignored,
  [".gitattributes"] = I.text, [".gitmodules"] = I.text, [".gitkeep"] = I.text, [".mailmap"] = I.text,
  [".npmrc"] = I.text, [".nvmrc"] = I.text, [".node-version"] = I.text, [".prototools"] = I.text,
  [".editorconfig"] = I.gear,
  -- .env / .env.local are YAML in his WebStorm (filetypes.xml); other .env.* plain text
  [".env"] = I.yaml, [".env.local"] = I.yaml, [".env.example"] = I.text, [".env.unittest"] = I.text,
  [".env.development"] = I.text, [".env.production"] = I.text, [".env.test"] = I.text,
  ["eslint.config.js"] = I.eslint, ["eslint.config.mjs"] = I.eslint, ["eslint.config.cjs"] = I.eslint,
  ["eslint.config.ts"] = I.eslint, [".eslintrc"] = I.eslint, [".eslintrc.js"] = I.eslint,
  [".eslintrc.cjs"] = I.eslint, [".eslintrc.json"] = I.eslint,
  ["prettier.config.js"] = I.prettier, ["prettier.config.mjs"] = I.prettier, ["prettier.config.cjs"] = I.prettier,
  [".prettierrc"] = I.prettier, [".prettierrc.json"] = I.prettier, [".prettierrc.js"] = I.prettier,
  [".prettierrc.cjs"] = I.prettier, [".prettierrc.mjs"] = I.prettier,
}

local filetype = {
  typescript = I.ts, typescriptreact = I.tsx, javascript = I.js, javascriptreact = I.jsx,
  json = I.json, jsonc = I.json, json5 = I.json,
  markdown = I.md, css = I.css, less = I.less, scss = I.sass, sass = I.sass,
  html = I.html, xhtml = I.xhtml, xml = I.xml, yaml = I.yaml, svg = I.image,
  sh = I.shell, bash = I.shell, zsh = I.shell, sql = I.sql,
  gitignore = I.ignored, editorconfig = I.gear, text = I.text,
}

-- mini.icons opts (plugins/ui.lua). Anything else is plain text, like an unknown text file in WebStorm.
function M.opts()
  return {
    default = { file = I.text, extension = I.text, filetype = I.text, directory = I.folder },
    extension = extension,
    file = file,
    filetype = filetype,
  }
end

-- mini.icons setup, then its built-in icons (per-name folders like .git / src, python, lua, Makefile...)
-- that don't resolve to one of ours become the plain folder / text icon. Filetypes first: built-in
-- extensions and file names often point at a filetype.
function M.setup(opts)
  local icons = require("mini.icons")
  icons.setup(opts)
  opts = vim.deepcopy(opts)
  for _, cat in ipairs({ "filetype", "extension", "file", "directory" }) do
    local fallback = cat == "directory" and I.folder or I.text
    opts[cat] = opts[cat] or {}
    for _, name in ipairs(icons.list(cat)) do
      if not opts[cat][name] then
        local _, hl = icons.get(cat, name)
        if cat == "directory" or not tostring(hl):find("^WsIcon") then opts[cat][name] = fallback end
      end
    end
    icons.setup(opts)
  end
end

return M
