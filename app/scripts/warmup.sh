#!/usr/bin/env bash
# The app nvim's warm-up (network, a few minutes the first time): installs its plugins, treesitter parsers and
# Mason packages (nvim/lua/config/warmup.lua) into its data dir (stdpath("data"): $XDG_DATA_HOME/vimstorm,
# default ~/.local/share/vimstorm) with the app's NVIM_APPNAME, so the first app start / test run doesn't race
# the background installs. Only what is missing is installed: a re-run retries what failed. Exits non-zero,
# naming what is missing, when anything didn't install.
# The config is read through a link of its own in a temp dir: the installed app's config link
# (~/Library/Application Support/VimStorm/config/vimstorm) is left alone. nvim/lazy-lock.json is what the
# plugins are installed at, never written: lazy's own install rewrites it from what it cloned (lazy.nvim
# itself at its stable branch), so the warm-up gets the repo's (VIMSTORM_WARMUP_LOCK) and it is put back after.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="${VIMSTORM_REPO:-$(cd "$here/../.." && pwd)}"
cfg="$(mktemp -d "${TMPDIR:-/tmp}/vimstorm-warmup.XXXXXX")"
lock="$repo/nvim/lazy-lock.json"
trap 'cmp -s "$cfg/lazy-lock.json" "$lock" || cp "$cfg/lazy-lock.json" "$lock"; rm -rf "$cfg"' EXIT
cp "$lock" "$cfg/lazy-lock.json"
ln -s "$repo/nvim" "$cfg/vimstorm"
cd "$repo"
NVIM_APPNAME=vimstorm XDG_CONFIG_HOME="$cfg" VIMSTORM_WARMUP_LOCK="$cfg/lazy-lock.json" \
  nvim --headless --cmd "let g:vimstorm_app = 1" -c "lua require('config.warmup').run()"
