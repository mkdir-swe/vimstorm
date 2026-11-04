#!/bin/bash
# A fake `abe ui bridge` for tests/factory.rs: notes how it was started and every frame it reads
# in $FAKE_BRIDGE_LOG; on `open` it prints the frames in $FAKE_BRIDGE_FRAMES (contract fixture
# files, space separated) as one line each. FAKE_BRIDGE_DIE=always exits after that, =once only
# the first time (marker: $FAKE_BRIDGE_LOG.died). The key <F35> makes it exit too.
# FAKE_BRIDGE_REPLAY=<dir> (the contract's replay/<screen>/): on `open` it prints <dir>/0.json,
# and on the n-th key <dir>/<n>.json, the tree the TS screen gave after that key.
# $FAKE_BRIDGE_ON answers other frames: one rule a line, `<text the frame holds>=<frame files,
# space separated>`; each frame it prints gets the next `rev` (1, 2, …).
log="$FAKE_BRIDGE_LOG"
keys=0
echo "start $*" >>"$log"
rev=0
# each frame printed gets the next rev, as the bridge counts them
print() {
  for f in $1; do
    rev=$((rev + 1))
    tr -d '\n' <"$f" | sed -E "s/\"rev\": ?[0-9]+/\"rev\":$rev/"
    echo
  done
}
while IFS= read -r line; do
  echo "$line" >>"$log"
  case "$line" in
  *'"type":"open"'*)
    if [ -n "$FAKE_BRIDGE_REPLAY" ]; then
      tr -d '\n' <"$FAKE_BRIDGE_REPLAY/0.json"
      echo
    fi
    print "$FAKE_BRIDGE_FRAMES"
    if [ "$FAKE_BRIDGE_DIE" = always ]; then exit 1; fi
    if [ "$FAKE_BRIDGE_DIE" = once ] && [ ! -e "$log.died" ]; then
      touch "$log.died"
      exit 1
    fi
    ;;
  # <F35>: the bridge dies (a crash mid-run; the shell starts it again once)
  *'"key":"<F35>"'*) exit 1 ;;
  *'"kind":"key"'*)
    if [ -n "$FAKE_BRIDGE_REPLAY" ]; then
      keys=$((keys + 1))
      if [ -e "$FAKE_BRIDGE_REPLAY/$keys.json" ]; then
        tr -d '\n' <"$FAKE_BRIDGE_REPLAY/$keys.json"
        echo
      fi
    fi
    ;;
  esac
  if [ -n "$FAKE_BRIDGE_ON" ]; then
    while IFS= read -r rule; do
      [ -z "$rule" ] && continue
      case "$line" in
      *"${rule%%=*}"*) print "${rule#*=}" ;;
      esac
    done <<<"$FAKE_BRIDGE_ON"
  fi
done
