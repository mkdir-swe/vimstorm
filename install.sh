#!/usr/bin/env bash
# Sets up VimStorm (a native macOS editor around Neovim, WebStorm-style) with Abe 3.x, its agent sessions
# and Factory, on a Mac:
#   - installs missing tools with Homebrew (neovim, ripgrep, fd, lazygit, node, tree-sitter-cli; for Abe:
#     bun, gh, tmux, jq, ffmpeg; awscli only with --cloud) and Claude Code with its own installer
#   - builds the app (app/) with Abe 3.x (abe/) inside it into /Applications (else ~/Applications)
#   - installs the `vimstorm [path]` command to ~/.local/bin (hands the path to the running app, else starts it)
#     and links `abe` there to the bundle's Abe 3.x, the command line Abe's screens, agents and you use;
#     drops 1.x's links
#   - installs the app's plugins, treesitter parsers and language servers (versions from nvim/lazy-lock.json):
#     what is missing, so a re-run retries what failed; exits 1 naming what is still missing
# Runs unattended (no prompts): anything it can't do itself (Xcode Command Line Tools, Homebrew, Rust) stops it
# with a message and a non-zero exit. Safe to re-run: the app and the command are replaced.
# Then, once: the logins, where sessions run and a check (README.md › Install › Abe on a new Mac).
#   ./install.sh            (--app-only is accepted for old instructions; it's what the script does anyway)
#   ./install.sh --cloud    also installs awscli, for sessions on your own boxes (serve.target: cloud)
# No az: an Azure Boards board needs it (brew install azure-cli); abe tools check says so.
# Env overrides (tests install into a temp prefix with them):
#   VIMSTORM_APPS_DIR=<dir>   where VimStorm.app goes (default /Applications, else ~/Applications)
#   VIMSTORM_BIN_DIR=<dir>    where the vimstorm command goes (default ~/.local/bin)
#   XDG_DATA_HOME=<dir>       where the warm-up installs the plugins, parsers and language servers (<dir>/vimstorm,
#                             default ~/.local/share/vimstorm; an app reads it only when started with it)
#   VIMSTORM_SKIP_TOOLS=1     skip the Xcode / Homebrew / Neovim / Rust checks and the tools' installs
#   VIMSTORM_SKIP_WARMUP=1    skip installing the app's plugins, parsers and language servers
#   VIMSTORM_SKIP_APP=1       skip building and installing VimStorm.app (the commands are still installed)
#   VIMSTORM_LSREGISTER=0     don't register the bundle with LaunchServices
set -euo pipefail

cloud=0
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed -E 's/^# ?//'; }
for arg in "$@"; do
  case "$arg" in
    --app-only) ;;
    --cloud) cloud=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "install.sh: unknown option $arg" >&2; usage >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "$0")" && pwd -P)"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# Homebrew without questions, auto-update or cleanup runs
brew_q() { NONINTERACTIVE=1 HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1 brew "$@" </dev/null; }

nvim_minor() { nvim --version | head -1 | sed -E 's/NVIM v0\.([0-9]+).*/\1/'; }

# 1. Tools ----------------------------------------------------------------------
check_tools() {
  say "Checking tools"
  # git, clang and the Metal shader compiler GPUI uses at runtime; their installer is a GUI dialog
  xcode-select -p >/dev/null 2>&1 ||
    die "Xcode Command Line Tools are missing: run 'xcode-select --install', then this script again"
  command -v brew >/dev/null || die "Homebrew is required: https://brew.sh, then run this script again"
  local missing=() pair cmd pkg
  # the editor's, then Abe 3.x's (`abe tools check`; bun builds it, jq the box image build, ffmpeg
  # Verify's recordings as GIFs the Run page plays); awscli for your boxes only with --cloud, az never
  # (an Azure board's: abe tools check says how)
  local pairs=(nvim:neovim rg:ripgrep fd:fd lazygit:lazygit node:node tree-sitter:tree-sitter-cli
    bun:oven-sh/bun/bun gh:gh tmux:tmux jq:jq ffmpeg:ffmpeg)
  if [ "$cloud" = 1 ]; then pairs+=(aws:awscli); fi
  for pair in "${pairs[@]}"; do
    cmd="${pair%%:*}" pkg="${pair##*:}"
    command -v "$cmd" >/dev/null || missing+=("$pkg")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "  brew install ${missing[*]}"
    brew_q install "${missing[@]}"
  fi
  if [ "$(nvim_minor)" -lt 12 ]; then
    echo "  Neovim 0.12+ needed (have $(nvim --version | head -1)): brew upgrade neovim"
    brew_q upgrade neovim || true
    [ "$(nvim_minor)" -ge 12 ] || die "Neovim 0.12+ needed (have $(nvim --version | head -1))"
  fi
  if ! [ -x "$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo" ] && ! [ -x "$HOME/.cargo/bin/cargo" ] &&
    ! command -v cargo >/dev/null; then
    die "Rust is required to build the app: install it from https://rustup.rs, then run this script again"
  fi
  # Claude Code, Abe's agent: its own installer (~/.local/bin/claude, updates itself)
  if ! command -v claude >/dev/null && ! [ -x "$HOME/.local/bin/claude" ]; then
    echo "  Claude Code: curl -fsSL https://claude.ai/install.sh | bash"
    if ! curl -fsSL https://claude.ai/install.sh | bash; then
      echo "  note: Claude Code didn't install; run 'curl -fsSL https://claude.ai/install.sh | bash' yourself"
    fi
  fi
  command -v docker >/dev/null ||
    echo "  note: no Docker: a repo with a database needs it for its prototypes and local sessions (Abe's Mac database, abe-pg), as do the fake box and image builds (brew install --cask docker, OrbStack or colima)"
}
if [ "${VIMSTORM_SKIP_TOOLS:-0}" != 1 ]; then check_tools; fi

bin_dir="${VIMSTORM_BIN_DIR:-$HOME/.local/bin}"
user_path="$PATH"

# 2. The app with Abe 3.x inside (app/README.md, abe/README.md) --------------------------------
apps="${VIMSTORM_APPS_DIR:-/Applications}"
if [ -z "${VIMSTORM_APPS_DIR:-}" ] && ! [ -w "$apps" ]; then apps="$HOME/Applications"; fi
mkdir -p "$apps"
# (a relative VIMSTORM_APPS_DIR: the command below needs the absolute path)
apps="$(cd -- "$apps" && pwd -P)"
if [ "${VIMSTORM_SKIP_APP:-0}" != 1 ]; then
  say "Building the VimStorm app with Abe 3.x (release build, a few minutes the first time)"
  # the bundle keeps this PATH for Dock / Finder launches: with the commands' dir and Claude Code's (last:
  # they never shadow Homebrew's)
  path_for_app="$PATH"
  for d in "$HOME/.local/bin" "$bin_dir"; do
    case ":$path_for_app:" in *":$d:"*) ;; *) path_for_app="$path_for_app:$d" ;; esac
  done
  PATH="$path_for_app" "$REPO/app/scripts/bundle.sh" >/dev/null </dev/null
  # (only the app this replaces: another bundle's or a test's vimstorm is not it)
  app_re="$(printf '%s' "$apps/VimStorm.app/Contents/MacOS/vimstorm" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
  if ps -axo args= | grep -qE -- "^$app_re( |$)"; then
    echo "  note: VimStorm is running: quit it so the next launch (and vimstorm [path]) uses the new build"
  fi
  rm -rf "$apps/VimStorm.app.new"
  ditto "$REPO/app/target/bundle/VimStorm.app" "$apps/VimStorm.app.new"
  rm -rf "$apps/VimStorm.app"
  mv "$apps/VimStorm.app.new" "$apps/VimStorm.app"
  # LaunchServices caches Info.plist (LSEnvironment, document types): make it read the new one
  lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  if [ "${VIMSTORM_LSREGISTER:-1}" != 0 ] && [ -x "$lsregister" ]; then "$lsregister" -f "$apps/VimStorm.app"; fi
  echo "  $apps/VimStorm.app"
fi

# 3. The command: single instance (a running app takes the path), else starts the app ----------
mkdir -p "$bin_dir"
cli="$bin_dir/vimstorm"
# (escaped for sed's replacement: \ | & in the path)
app_path="$(printf '%s' "$apps/VimStorm.app" | sed 's/[\\|&]/\\&/g')"
sed "s|^installed_app=.*|installed_app=\"$app_path\"|" "$REPO/app/scripts/vimstorm" >"$cli.new"
chmod 755 "$cli.new"
mv "$cli.new" "$cli"
echo "  $cli"
case ":$user_path:" in
  *":$bin_dir:"*) ;;
  *) echo "  $bin_dir is not on your PATH: add it to use the vimstorm and abe commands" ;;
esac

# `abe` is Abe 3.x, the bundle's (the one the bridge runs): it replaces 1.x's link to the app binary and
# TS Abe's wrapper there. An old 1.x install's links go with it (one more release).
abe2="$apps/VimStorm.app/Contents/MacOS/abe"
if [ -x "$abe2" ]; then
  ln -sfn "$abe2" "$bin_dir/abe"
  echo "  $bin_dir/abe -> $abe2"
  # an abe serve started from the old binary keeps answering: stopped, unless sessions run in it
  if served="$("$abe2" status --json --no-start 2>/dev/null)"; then
    live="$(printf '%s' "$served" | sed -nE 's/.*"sessions":([0-9]+).*/\1/p')"
    if [ "${live:-0}" = 0 ]; then
      if "$abe2" serve stop >/dev/null 2>&1; then
        echo "  stopped the running abe serve: the next abe command starts the new one"
      else
        echo "  note: the running abe serve is the old abe and did not stop: abe serve stop"
      fi
    else
      echo "  note: the running abe serve is the old abe, with $live live sessions: once they end, abe serve stop (the next abe command starts the new one)"
    fi
  fi
  [ "$(readlink "$bin_dir/abe-hook" 2>/dev/null)" != "$REPO/bin/abe-hook" ] || rm -f "$bin_dir/abe-hook"
  [ ! -L "$REPO/plugins/copilot/skills" ] || rm -f "$REPO/plugins/copilot/skills"
  rmdir "$REPO/plugins/copilot" "$REPO/plugins" 2>/dev/null || true
else
  echo "  note: no Abe 3.x in $apps/VimStorm.app: run this script without VIMSTORM_SKIP_APP"
fi

# 4. Plugins, parsers, language servers: what is missing (all of it the first time) -------------
warmup_failed=0
if [ "${VIMSTORM_SKIP_WARMUP:-0}" != 1 ]; then
  say "Installing the app's plugins, parsers and language servers (what is missing; network)"
  "$REPO/app/scripts/warmup.sh" </dev/null || warmup_failed=1
fi

# Older installs ran Neovim in Ghostty with an include of the repo's ghostty/config (gone now): only a note,
# the Ghostty config is the user's
for c in "$HOME/Library/Application Support/com.mitchellh.ghostty/config"{,.ghostty} \
  "${XDG_CONFIG_HOME:-$HOME/.config}/ghostty/config"{,.ghostty}; do
  if [ -f "$c" ] && grep -qE '^[[:space:]]*config-file[[:space:]]*=.*/ghostty/config"?[[:space:]]*$' "$c"; then
    echo "  note: $c still includes VimStorm's old ghostty/config; remove that line"
  fi
done

if [ "$warmup_failed" = 1 ]; then
  echo "install.sh: not all of the app's plugins, parsers and language servers installed (above):" >&2
  echo "  run ./install.sh again to retry them (else the app's first start installs them in the background)" >&2
  exit 1
fi

say "Done"
cat <<'EOF'
Next, once (README.md › Install › Abe on a new Mac):
  1. logins: gh auth login, claude (then /login); abe login status checks them;
     an Azure board also needs az (brew install azure-cli, then az login)
  2. sessions run on this Mac; for your own boxes instead: ./install.sh --cloud, the cloud setup,
     then abe settings set serve.target cloud
  3. abe tools check, abe settings problems: what Abe 3.x still misses
  4. vimstorm [path] (or VimStorm in Applications), ⌘⌥A for the Board; :Copilot auth once
     macOS may ask once to let VimStorm find devices on local networks: Abe reaching a
     board served on this machine (127.0.0.1, the fake Azure DevOps); Allow is safe
EOF
