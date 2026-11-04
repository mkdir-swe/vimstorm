#!/usr/bin/env bash
# Builds the compiled `abe` for one target with its version in it (#188): scripts/version.sh's
# ($ABE_VERSION when named), put in as ABE_BUILD_VERSION (packages/serve/src/process/version.ts), so
# `abe status` says which build it is.
#
#   abe/scripts/build.sh darwin|linux [outfile]   (default dist/abe-<target>-arm64)
set -euo pipefail
abe=$(cd "$(dirname "$0")/.." && pwd)
case "${1:-}" in
  darwin | linux) ;;
  *)
    echo "usage: scripts/build.sh darwin|linux [outfile]" >&2
    exit 2
    ;;
esac
out=${2:-$abe/dist/abe-$1-arm64}
version=$("$abe/scripts/version.sh")
# In the caller's folder: bun build leaves its scratch copies there (*.bun-build). The binary never
# reads the .env or bunfig.toml where it is typed: a checkout's env file would reach abe, the serve
# it starts and every hook, and a bunfig preload would run the checkout's code.
bun build --compile --target="bun-$1-arm64" --define "ABE_BUILD_VERSION=\"$version\"" \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  "$abe/packages/serve/src/main.ts" --outfile "$out"
echo "abe $version: $out" >&2
