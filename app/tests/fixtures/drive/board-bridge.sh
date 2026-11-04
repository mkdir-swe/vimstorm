#!/bin/bash
# A fake `abe ui bridge` for tests/drive.rs: a board of two cards, #101 and #202. ö / <Down> and
# l / <Up> move the selection, <CR> opens the selected card as a layer, <Esc> closes it. Every
# frame it reads goes to $DRIVE_BRIDGE_LOG. DRIVE_BRIDGE_BALLOON=<text>: an info balloon with that
# text on the first open. DRIVE_BRIDGE_TREE=<file>: that contract tree as the screen instead.
log="$DRIVE_BRIDGE_LOG"
cards=(101 202)
titles=("Free shipping banner" "Sign-in takes a plus address")
sel=0
rev=0
lrev=0
ballooned=
echo "start $*" >>"$log"
row() {
  local state=default
  [ "$sel" = "$1" ] && state=selected
  printf '{"kind":"ListRow","id":"card:%s","props":{"text":"#%s %s","state":"%s"}}' \
    "${cards[$1]}" "${cards[$1]}" "${titles[$1]}" "$state"
}
board() {
  rev=$((rev + 1))
  if [ -n "$DRIVE_BRIDGE_TREE" ]; then
    printf '{"v":2,"type":"tree","screen":"factory","rev":%d,"tree":%s}\n' "$rev" "$(tr -d '\n' <"$DRIVE_BRIDGE_TREE")"
    return
  fi
  printf '{"v":2,"type":"tree","screen":"factory","rev":%d,"tree":{"kind":"Island","props":{},"children":[%s,%s]}}\n' \
    "$rev" "$(row 0)" "$(row 1)"
}
layer() {
  lrev=$((lrev + 1))
  if [ -z "$1" ]; then
    printf '{"v":2,"type":"layer","rev":%d,"tree":null}\n' "$lrev"
  else
    printf '{"v":2,"type":"layer","rev":%d,"tree":{"kind":"PickLayer","id":"card","props":{"title":"#%s %s","rows":[{"id":"open","text":"Open card #%s"}]}}}\n' \
      "$lrev" "${cards[$sel]}" "${titles[$sel]}" "${cards[$sel]}"
  fi
}
while IFS= read -r line; do
  echo "$line" >>"$log"
  case "$line" in
  *'"type":"open"'*)
    board
    if [ -n "$DRIVE_BRIDGE_BALLOON" ] && [ -z "$ballooned" ]; then
      ballooned=1
      printf '{"v":2,"type":"shell","effect":{"kind":"balloon","tone":"info","text":"%s"}}\n' "$DRIVE_BRIDGE_BALLOON"
    fi
    ;;
  *'"key":"ö"'* | *'"key":"<Down>"'*)
    sel=1
    board
    ;;
  *'"key":"l"'* | *'"key":"<Up>"'*)
    sel=0
    board
    ;;
  *'"key":"<CR>"'*) layer open ;;
  *'"key":"<Esc>"'*) layer ;;
  esac
done
