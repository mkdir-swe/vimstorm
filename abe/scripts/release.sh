#!/usr/bin/env bash
# Releases one `abe` build for the boxes: the linux-arm64 binary, its checksum and the box's
# image build (abe/images, plus packages/serve/package.json that images/build.sh reads, and the
# repo's nvim/ for the workspace image's editor) into
# the artifacts bucket (abe-org's terraform/box) under abe/<version>/. The binary built here
# carries the version (`abe status` says it; the Mac compares a box's with its own, #188). Once
# all three are put it writes abe/current (the version, one line): every box's boot reads it
# (abe-org terraform/modules/box-boot; its `abe_version` only while abe/current is missing), so a
# box's next start installs this release. The steps: docs/cloud.md › A new abe on your box.
#
#   ABE_ARTIFACTS_BUCKET=abe-artifacts-<tooling account> abe/scripts/release.sh [--force] [--no-current]
#
#   ABE_RELEASE_VERSION  the version (default: packages/serve's version and the commit,
#                        e.g. 2.2.0-4b7ffbcf; a tree with changes needs one named)
#   ABE_BIN              a built binary to release instead of `bun run build:linux` (needs
#                        ABE_RELEASE_VERSION)
#   AWS_PROFILE          default abe-tooling
#   --force              put a version that is already there again
#   --no-current         leave abe/current as it is (the boxes stay on theirs)
#
# A version is written once: one already in the bucket is refused without --force.
set -euo pipefail

usage() {
  sed -n '2,21p' "$0" >&2
  exit 2
}
fail() {
  echo "release: $*" >&2
  exit 1
}

force=false
current=true
for arg in "$@"; do
  case "$arg" in
    --force) force=true ;;
    --no-current) current=false ;;
    *) usage ;;
  esac
done
bucket=${ABE_ARTIFACTS_BUCKET:-}
[ -n "$bucket" ] || { echo "release: name the bucket in ABE_ARTIFACTS_BUCKET" >&2; usage; }
export AWS_PROFILE=${AWS_PROFILE:-abe-tooling} AWS_PAGER=""

abe=$(cd "$(dirname "$0")/.." && pwd)
version=${ABE_RELEASE_VERSION:-}
[ -z "${ABE_BIN:-}" ] || [ -n "$version" ] ||
  fail "ABE_BIN needs ABE_RELEASE_VERSION: a binary given is not this commit's build"
if [ -z "$version" ]; then
  # The same version a build of this commit says (scripts/version.sh, #188).
  version=$(ABE_VERSION="" bash "$abe/scripts/version.sh")
  case "$version" in
    *-dirty) fail "the abe workspace has changes: commit them or name ABE_RELEASE_VERSION" ;;
  esac
fi
case "$version" in
  *[!A-Za-z0-9._-]* | "") fail "a version is letters, digits, . _ and - only: $version" ;;
esac
prefix=abe/$version

listed=$(aws s3api list-objects-v2 --bucket "$bucket" --prefix "$prefix/" --output json) ||
  fail "s3://$bucket cannot be read"
if grep -q '"Key"' <<<"$listed" && ! $force; then
  fail "abe $version is already in s3://$bucket/$prefix/ (--force puts it again)"
fi

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
if [ -n "${ABE_BIN:-}" ]; then
  cp "$ABE_BIN" "$out/abe-linux-arm64"
else
  (cd "$abe" && ABE_VERSION=$version bun run build:linux >&2)
  cp "$abe/dist/abe-linux-arm64" "$out/abe-linux-arm64"
fi
if command -v sha256sum >/dev/null; then
  (cd "$out" && sha256sum abe-linux-arm64 >abe-linux-arm64.sha256)
else
  (cd "$out" && shasum -a 256 abe-linux-arm64 >abe-linux-arm64.sha256)
fi
# The committed image build, as the box's /opt/abe, with VimStorm's nvim config beside it
# (/opt/abe/nvim: the workspace image's editor, #89).
stage=$out/stage
mkdir -p "$stage"
git -C "$abe" archive HEAD images packages/serve/package.json | tar -x -C "$stage"
parts=(images packages)
root=$(git -C "$abe" rev-parse --show-toplevel)
if git -C "$root" cat-file -e HEAD:nvim 2>/dev/null; then
  git -C "$root" archive --prefix=nvim/ HEAD:nvim | tar -x -C "$stage"
  parts+=(nvim)
fi
COPYFILE_DISABLE=1 tar -czf "$out/images.tar.gz" -C "$stage" "${parts[@]}"

put() {
  aws s3api put-object --bucket "$bucket" --key "$1" --body "$2" >/dev/null ||
    fail "s3://$bucket/$1 was not put"
}
put "$prefix/images.tar.gz" "$out/images.tar.gz"
put "$prefix/abe-linux-arm64.sha256" "$out/abe-linux-arm64.sha256"
put "$prefix/abe-linux-arm64" "$out/abe-linux-arm64"
echo "abe $version in s3://$bucket/$prefix/"

# The pin, last: a box never reads a version whose build is not all there.
if $current; then
  echo "$version" >"$out/current"
  put abe/current "$out/current"
  echo "abe/current = $version: each box installs it on its next start"
else
  echo "abe/current still names the boxes' release (--no-current)"
fi
echo "then: docs/cloud.md › A new abe on your box"
