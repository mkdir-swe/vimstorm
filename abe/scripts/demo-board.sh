#!/usr/bin/env bash
# The demo board on a box: the fake Azure DevOps (packages/testing/src/servers/fake-ado) on a seed, for
# trying the Factory on a box without a real Azure DevOps org. A Factory run on a box moves its
# card from the box's serve (Active as it builds, Closed at Done), so the fake runs on the box
# itself and the box's serve is pointed at it; the Mac reads the same board through
# `abe box forward <box> <port>` (the line this prints).
#
#   ABE_ARTIFACTS_BUCKET=abe-artifacts-<tooling account> abe/scripts/demo-board.sh <box> <seed.json>
#   abe/scripts/demo-board.sh down <box>    the box's serve back on its own PATH, the fake gone
#
#   AWS_PROFILE       default abe-tooling (puts the build in the bucket; the box reads it as its role)
#   ABE               the abe command that reaches the box (default: abe on PATH)
#   ABE_BOARD_PORT    the fake's port on the box's 127.0.0.1 (default 18991)
#
# On the box (as root, through `abe box attach <box> -- …`): the build and the seed in
# /opt/abe-demo-board, a fake `az` there handing out a fixed fake token, the unit
# abe-demo-board (the fake on 127.0.0.1:<port>, started again with the box), and a drop-in for
# abe-serve giving it ABE_ADO_BASE_URL and that `az` first on its PATH. Run again it reseeds the
# board (the fake starts over); serve is restarted only when its drop-in changed, so a run going
# on keeps its session. The build and the seed are checked against their sha256 on the box. Nothing
# here touches a real Azure DevOps or a token.
set -euo pipefail

usage() {
  sed -n '2,21p' "$0" >&2
  exit 2
}
fail() {
  echo "demo-board: $*" >&2
  exit 1
}

abe_cmd=${ABE:-abe}

if [ "${1:-}" = down ]; then
  [ $# -eq 2 ] || usage
  # shellcheck disable=SC2016
  down='
set -euo pipefail
changed=false
for f in /etc/systemd/system/abe-serve.service.d/demo-board.conf /etc/abe/demo-board.env; do
  if [ -e "$f" ]; then rm -f "$f"; changed=true; fi
done
systemctl disable -q --now abe-demo-board 2>/dev/null || true
rm -f /etc/systemd/system/abe-demo-board.service
rm -rf /opt/abe-demo-board
systemctl daemon-reload
if $changed; then systemctl restart abe-serve; echo "abe-serve restarted off the demo board"; fi
echo "demo board gone"
'
  "$abe_cmd" box attach "$2" -- sudo -n bash -c "$down" demo-board-down
  exit 0
fi

[ $# -eq 2 ] || usage
box=$1 seed=$2
[ -f "$seed" ] || fail "no seed file $seed"
bucket=${ABE_ARTIFACTS_BUCKET:-}
[ -n "$bucket" ] || fail "name the bucket in ABE_ARTIFACTS_BUCKET"
port=${ABE_BOARD_PORT:-18991}
case "$port" in *[!0-9]* | "") fail "ABE_BOARD_PORT is a port number: $port" ;; esac
export AWS_PROFILE=${AWS_PROFILE:-abe-tooling} AWS_PAGER=""
region=${AWS_REGION:-eu-west-1}

here=$(cd "$(dirname "$0")/.." && pwd)
out=$here/dist/fake-ado-linux-arm64
(cd "$here" && bun build --compile --target=bun-linux-arm64 packages/testing/src/servers/fake-ado/server.ts --outfile "$out" >/dev/null)
sum=$(shasum -a 256 "$out" | cut -d' ' -f1)
seed_sum=$(shasum -a 256 "$seed" | cut -d' ' -f1)
# Under abe/ (what a box's role reads), by the build's and the seed's hashes: written once.
prefix=abe/demo-board/${sum:0:12}-${seed_sum:0:12}
aws s3 cp --region "$region" --only-show-errors "$out" "s3://$bucket/$prefix/fake-ado"
aws s3 cp --region "$region" --only-show-errors "$seed" "s3://$bucket/$prefix/seed.json"

# The box's half, as root. Its arguments: bucket, prefix, port, region, the build's and the seed's sha256.
# shellcheck disable=SC2016
remote='
set -euo pipefail
bucket=$1 prefix=$2 port=$3 region=$4 sum=$5 seed_sum=$6
d=/opt/abe-demo-board
install -d -m 0755 "$d" "$d/bin"
tmp=$(mktemp -d)
/snap/bin/aws s3 cp --region "$region" --only-show-errors "s3://$bucket/$prefix/fake-ado" "$tmp/fake-ado"
/snap/bin/aws s3 cp --region "$region" --only-show-errors "s3://$bucket/$prefix/seed.json" "$tmp/seed.json"
echo "$sum  $tmp/fake-ado" | sha256sum -c --quiet
echo "$seed_sum  $tmp/seed.json" | sha256sum -c --quiet
install -m 0755 "$tmp/fake-ado" "$d/fake-ado"
install -m 0644 "$tmp/seed.json" "$d/seed.json"
rm -rf "$tmp"
cat >"$d/bin/az" <<'"'"'AZ'"'"'
#!/bin/sh
# The demo board'"'"'s az: a fixed fake token for the fake Azure DevOps (never a real login).
echo '"'"'{"accessToken":"fake-token","expiresOn":"2099-01-01 00:00:00.000000","expires_on":4070908800}'"'"'
AZ
chmod 0755 "$d/bin/az"
cat >/etc/systemd/system/abe-demo-board.service <<UNIT
[Unit]
Description=The demo board: a fake Azure DevOps on 127.0.0.1:$port
Before=abe-serve.service

[Service]
DynamicUser=yes
LogsDirectory=abe-demo-board
# The fake ends when its stdin closes: a pipe that stays open.
ExecStart=/bin/sh -c "sleep infinity | $d/fake-ado --port $port --seed $d/seed.json --log /var/log/abe-demo-board/requests.log"
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
path=$(sed -n "s/^PATH=//p" /etc/abe/serve.env)
# None there would leave PATH ending in an empty entry: the working directory.
[ -n "$path" ] || { echo "demo-board: no PATH= line in /etc/abe/serve.env" >&2; exit 1; }
install -d -m 0755 /etc/systemd/system/abe-serve.service.d
changed=false
# put <file>: stdin into <file> when it differs (then serve is restarted).
put() {
  local new
  new=$(mktemp)
  cat >"$new"
  cmp -s "$new" "$1" || { install -m 0644 "$new" "$1"; changed=true; }
  rm -f "$new"
}
put /etc/abe/demo-board.env <<ENV
ABE_ADO_BASE_URL=http://127.0.0.1:$port
PATH=$d/bin:$path
ENV
# A later EnvironmentFile= wins over serve.env (an Environment= line would not).
put /etc/systemd/system/abe-serve.service.d/demo-board.conf <<CONF
# The demo board (abe/scripts/demo-board.sh): the box serve'"'"'s Board on the fake.
[Unit]
Wants=abe-demo-board.service
After=abe-demo-board.service

[Service]
EnvironmentFile=/etc/abe/demo-board.env
CONF
systemctl daemon-reload
systemctl enable -q abe-demo-board
systemctl restart abe-demo-board
for _ in $(seq 50); do
  [ "$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/")" != 000 ] && break
  sleep 0.2
done
if $changed; then systemctl restart abe-serve; echo "abe-serve restarted onto the demo board"; fi
echo "demo board on 127.0.0.1:$port (seed $(sha256sum "$d/seed.json" | cut -c1-12))"
'
"$abe_cmd" box attach "$box" -- sudo -n bash -c "$remote" demo-board "$bucket" "$prefix" "$port" "$region" "$sum" "$seed_sum"
echo "the Mac's view of it: $abe_cmd box forward $box $port, then ABE_ADO_BASE_URL=http://127.0.0.1:<local> for the Mac's serve"
