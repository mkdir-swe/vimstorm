#!/usr/bin/env bash
# The version an abe build carries (#188): what `abe status` says, what the Mac compares a box's
# with. $ABE_VERSION when named (release.sh names the release's); else packages/serve's version
# and the commit, `2.2.0-1a2b3c4d`, with `-dirty` when the abe workspace has changes; outside a
# git checkout, the package's version alone.
#
#   abe/scripts/version.sh
set -euo pipefail
abe=$(cd "$(dirname "$0")/.." && pwd)

check() {
  case "$1" in
    *[!A-Za-z0-9._+-]* | "")
      echo "version: a version is letters, digits, . _ + and - only: $1" >&2
      exit 1
      ;;
  esac
  echo "$1"
}

if [ -n "${ABE_VERSION:-}" ]; then
  check "$ABE_VERSION"
  exit 0
fi
base=$(sed -n 's/^  "version": *"\([^"]*\)".*$/\1/p' "$abe/packages/serve/package.json" | head -n 1)
[ -n "$base" ] || {
  echo "version: no version in $abe/packages/serve/package.json" >&2
  exit 1
}
if ! sha=$(git -C "$abe" rev-parse --short=8 HEAD 2>/dev/null); then
  check "$base"
  exit 0
fi
dirty=""
[ -z "$(git -C "$abe" status --porcelain -- . 2>/dev/null)" ] || dirty=-dirty
check "$base-$sha$dirty"
