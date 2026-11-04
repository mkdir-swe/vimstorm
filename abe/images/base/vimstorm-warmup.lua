-- The workspace image's warm-up of VimStorm's nvim (#89): plugins at lazy-lock.json, treesitter parsers and
-- Mason's packages into ~/.local/share/vimstorm, so a cloud workspace's `g w` opens without the network. The
-- config's own warm-up (nvim/lua/config/warmup.lua, app/scripts/warmup.sh's on a Mac) exits non-zero when any
-- is missing: the image build fails rather than ship a half-installed editor.
require("config.warmup").run()
