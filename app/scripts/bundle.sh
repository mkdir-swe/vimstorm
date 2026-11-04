#!/usr/bin/env bash
# Builds VimStorm.app (release build, ad-hoc signed) into DIR (default app/target/bundle/).
#   app/scripts/bundle.sh [--out DIR]
# The bundle carries Abe 3.x (abe/, built with bun: abe/dist/abe-darwin-arm64) as Contents/MacOS/abe,
# where the bridge looks for it (src/factory/bridge/process.rs), and the demo app `abe demo new` copies
# (examples/demo-shop) as Contents/Resources/demo-shop.
# VIMSTORM_BUNDLE_BINARY=<path>: bundle that binary instead of building (tests).
# VIMSTORM_BUNDLE_ABE=<path>: bundle that Abe 3.x instead of building it (tests).
# The app finds the repo (nvim/ config) through VIMSTORM_REPO in Info.plist's LSEnvironment (Finder / Dock /
# `open`) or the path baked into the binary (CARGO_MANIFEST_DIR), so it keeps working from /Applications.
# LSEnvironment also gets this shell's PATH: apps started by launchd only see /usr/bin:/bin:..., without
# nvim, git, rg, node.
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/.." && pwd -P)"
repo="$(cd "$app_dir/.." && pwd -P)"
out="$app_dir/target/bundle"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="${2:?--out needs a dir}"; shift 2 ;;
    --out=*) out="${1#--out=}"; shift ;;
    -h | --help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "bundle.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

user_path="$PATH"

name="VimStorm"

binary="${VIMSTORM_BUNDLE_BINARY:-}"
if [ -z "$binary" ]; then
  # cargo isn't on PATH by default here (rustup toolchain without the proxies)
  for d in "$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin" "$HOME/.cargo/bin"; do
    [ -x "$d/cargo" ] && PATH="$d:$PATH"
  done
  command -v cargo >/dev/null || { echo "bundle.sh: cargo not found (install rustup)" >&2; exit 1; }
  (cd "$app_dir" && cargo build --release)
  binary="$app_dir/target/release/vimstorm"
fi
[ -x "$binary" ] || { echo "bundle.sh: no binary at $binary" >&2; exit 1; }

# Abe 3.x (abe/README.md); stdout is only the bundle's path
abe="${VIMSTORM_BUNDLE_ABE:-}"
if [ -z "$abe" ]; then
  command -v bun >/dev/null || { echo "bundle.sh: bun not found, Abe 3.x is built with it (brew install oven-sh/bun/bun)" >&2; exit 1; }
  (cd "$repo/abe" && bun install --frozen-lockfile && bun run build:darwin) >&2
  abe="$repo/abe/dist/abe-darwin-arm64"
fi
[ -x "$abe" ] || { echo "bundle.sh: no Abe 3.x at $abe" >&2; exit 1; }

version="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$app_dir/Cargo.toml" | head -1)"
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
bundle="$out/$name.app"
tmp="$out/.$name.app.tmp"
rm -rf "$tmp"
mkdir -p "$tmp/Contents/MacOS" "$tmp/Contents/Resources"

cp "$binary" "$tmp/Contents/MacOS/vimstorm"
cp "$abe" "$tmp/Contents/MacOS/abe"
plist="$tmp/Contents/Info.plist"
cp "$app_dir/bundle/Info.plist" "$plist"
plutil -replace CFBundleVersion -string "$version" "$plist"
plutil -replace CFBundleShortVersionString -string "$version" "$plist"
plutil -replace LSEnvironment.VIMSTORM_REPO -string "$repo" "$plist"
plutil -replace LSEnvironment.PATH -string "$user_path" "$plist"
keys="CFBundleShortVersionString LSEnvironment.VIMSTORM_REPO LSEnvironment.PATH"
plutil -lint -s "$plist"
for key in $keys; do
  [ -n "$(plutil -extract "$key" raw -o - "$plist")" ] || { echo "bundle.sh: Info.plist $key is empty" >&2; exit 1; }
done

# icon: .icns from the pixel-art PNGs drawn per size (bundle/icon/<px>.png; scaling would blur the pixels)
iconset="$out/.$name.iconset"
rm -rf "$iconset"
mkdir -p "$iconset"
for s in 16 32 128 256 512; do
  cp "$app_dir/bundle/icon/$s.png" "$iconset/icon_${s}x${s}.png"
  cp "$app_dir/bundle/icon/$((s * 2)).png" "$iconset/icon_${s}x${s}@2x.png"
done
iconutil -c icns "$iconset" -o "$tmp/Contents/Resources/VimStorm.icns"
rm -rf "$iconset"
[ -s "$tmp/Contents/Resources/VimStorm.icns" ] || { echo "bundle.sh: no icon" >&2; exit 1; }

# licenses of what the binary embeds (fonts) and ports (NOTICE)
cp "$app_dir/NOTICE" "$app_dir"/assets/fonts/*-OFL.txt "$app_dir"/assets/fonts/WebStormIcons-NOTICE.txt \
  "$app_dir"/assets/fonts/WebStormIcons-LICENSE-Apache-2.0.txt "$tmp/Contents/Resources/"
cp "$app_dir/assets/icons/NOTICE" "$tmp/Contents/Resources/ICONS-NOTICE.txt"

# the demo app `abe demo new` copies (abe/README.md § Demo): Abe finds it beside Contents/MacOS/abe
rsync -a --exclude node_modules --exclude dist --exclude .scratch --exclude .DS_Store \
  "$repo/examples/demo-shop/" "$tmp/Contents/Resources/demo-shop/"
[ -s "$tmp/Contents/Resources/demo-shop/board/seed.json" ] || { echo "bundle.sh: no demo app" >&2; exit 1; }

# ad-hoc signature (no Developer ID): Apple Silicon needs a signature on every binary (--deep: abe too); a
# locally built bundle isn't quarantined, so Gatekeeper doesn't ask
codesign -s - --force --deep "$tmp"

rm -rf "$bundle"
mv "$tmp" "$bundle"
echo "$bundle"
