#!/usr/bin/env bash
# Builds Abe's core base image on this machine (a box, or the Mac's Docker as a stand-in), tagged
# abe-base:latest and abe-base:<version>. The abe binary is its last layer: `bun run build:linux`
# from this checkout, or ABE_BIN (a box's installed linux-arm64 abe). BuildKit caches apt / npm, so
# a new abe rebuilds one layer. Labelled abe.version (the release's: <abe>/version on a box, else
# this build's, scripts/version.sh) and abe.hash (the binary's sha256): `abe workspace up` on a
# box builds it again the same way when the label is not the installed abe's (#62). A repo's
# workspace image is built by `abe workspace up` from the repo's own .abe/session/Dockerfile on
# top of abe-base:latest.
#   abe/images/build.sh
#   ABE_BIN=/usr/local/bin/abe abe/images/build.sh
set -euo pipefail
abe=$(cd "$(dirname "$0")/.." && pwd)
bin=$(mktemp -d)
trap 'rm -rf "$bin"' EXIT

if [ -n "${ABE_BIN:-}" ]; then
  cp "$ABE_BIN" "$bin/abe-linux-arm64"
else
  (cd "$abe" && bun run build:linux)
  cp "$abe/dist/abe-linux-arm64" "$bin/abe-linux-arm64"
fi
# As serve reads it (app.ts installedBase): the file's, unless empty, else the binary's own: the
# one scripts/version.sh gave the build just made (#188), else packages/serve's.
version=$(tr -d '[:space:]' <"$abe/version" 2>/dev/null || true)
if [ -z "$version" ] && [ -z "${ABE_BIN:-}" ] && [ -x "$abe/scripts/version.sh" ]; then
  version=$("$abe/scripts/version.sh")
fi
[ -n "$version" ] || version=$(jq -r .version "$abe/packages/serve/package.json")
if command -v sha256sum >/dev/null; then
  hash=$(sha256sum "$bin/abe-linux-arm64" | cut -d' ' -f1)
else
  hash=$(shasum -a 256 "$bin/abe-linux-arm64" | cut -d' ' -f1)
fi
# VimStorm's nvim config for the image's editor (#89): the release's /opt/abe/nvim on a box, this
# repo's nvim/ in a checkout, else none (an empty context: Neovim alone).
nvim=$abe/nvim
[ -f "$nvim/init.lua" ] || nvim=$abe/../nvim
if [ ! -f "$nvim/init.lua" ]; then
  nvim=$bin/no-nvim
  mkdir -p "$nvim"
fi
docker buildx build --platform linux/arm64 --load \
  -f "$abe/images/base/Dockerfile" --build-context abe-bin="$bin" \
  --build-context vimstorm-nvim="$nvim" \
  --build-arg ABE_VERSION="$version" --build-arg ABE_HASH="$hash" \
  -t abe-base:latest -t "abe-base:$version" "$abe/images/base"
docker image inspect -f '{{.Size}}' abe-base:latest |
  awk -v v="$version" '{ printf "abe-base:latest (%s) %d MB\n", v, $1 / 1000000 }'
