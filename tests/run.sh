#!/usr/bin/env bash
# Headless app-mode engine tests: each file starts this checkout's nvim/ config as the VimStorm app does
# (`nvim --embed`, vim.g.vimstorm_app = 1, NVIM_APPNAME=vimstorm) with tests/harness.lua as its UI client.
# What the user sees is tested by the cargo suite (app/tests); these check the Lua engine (editing, LSP data,
# sessions, bookmarks, replace, folds, bridge payloads). Needs the app's plugins: app/scripts/warmup.sh once.
#   tests/run.sh               all tests (the list below)
#   tests/run.sh editing_test  one test (file name without .lua); several: tests/run.sh editing_test session_test
# Each test file gets its own copy of the fixtures (and its own nvim state / cache dirs), so files never see
# each other's edits, commits or sessions.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d /tmp/nvt.XXXXXX)" # short path: the nvim socket lives here (macOS limit ~104 chars)
trap 'rm -rf "$TMP"' EXIT

"$REPO/tests/fixtures.sh" "$TMP/fx" >/dev/null 2>&1 || { echo "fixtures failed"; exit 1; }

# the engine test files (explicit: no stray old *_test.lua gets picked up)
tests=()
for t in agent_files bookmarks editing editor_tabs feel layout_focus look lsp multicursor perf popups review search session tree workflow; do
  tests+=("$REPO/tests/${t}_test.lua")
done
if [ $# -gt 0 ]; then
  tests=()
  for t in "$@"; do
    [ -f "$REPO/tests/$t.lua" ] || { echo "no such test: $t"; exit 1; }
    tests+=("$REPO/tests/$t.lua")
  done
fi

# a hung test (blocking prompt, endless wait) fails after NVT_TIMEOUT seconds instead of blocking the run
LIMIT="${NVT_TIMEOUT:-300}"
TO="$(command -v timeout || command -v gtimeout || true)"
out="$TMP/out.txt"
times=()
for t in "${tests[@]}"; do
  name="$(basename "$t" .lua)"
  echo "== $name" >> "$out"
  cp -cR "$TMP/fx" "$TMP/$name" 2>/dev/null || cp -R "$TMP/fx" "$TMP/$name" # APFS clone, plain copy elsewhere
  start=$SECONDS
  # the controller: no config, shada or swap (the real state stays untouched)
  NVT_FIXTURES="$TMP/$name" NVT_OUT="$out" NVT_SOCK="$TMP/n.sock" NVT_HARNESS="$REPO/tests/harness.lua" \
    ${TO:+$TO -k 5 "$LIMIT"} nvim --headless -u NONE -i NONE -n -c "luafile $t" 2>/dev/null
  [ $? -eq 124 ] && echo "FAIL $name timed out after ${LIMIT}s" >> "$out"
  # a timed-out controller can leave its nested nvim behind
  pkill -f -- "--listen $TMP/n.sock" 2>/dev/null
  times+=("$name $((SECONDS - start))s")
  rm -rf "$TMP/$name"
done
cat "$out"
echo "== time per file: ${times[*]}"
echo "== $(grep -c '^PASS' "$out") passed, $(grep -c '^FAIL' "$out") failed"
! grep -q '^FAIL' "$out"
