#!/usr/bin/env bash
# A fake box on this Mac's Docker: `abe serve` as a box in a container, its state at
# /var/lib/abe-box in the Docker VM (the same path inside, so the bind mounts serve asks for exist).
#   abe/images/fake-box/run.sh up <seed-dir>   build abe-base + this image, start the box; <seed-dir>
#                                              holds <owner>/<repo>.git mirrors cloned on the Mac
#                                              (the box has no GitHub login: its mirrors fetch the seed)
#   abe/images/fake-box/run.sh abe <args…>     `abe <args…>` on the box
#   abe/images/fake-box/run.sh stop | start    the box stopping and starting (start runs up --all)
#   abe/images/fake-box/run.sh down            the box, its workspaces, Postgres, volumes, network
# What a box's launch template sets, from this shell's environment when given (#63, #90):
#   ABE_OWNER, ABE_BOX_NAME          whose box (its logins) and its name (its idle stop's, #92)
#   FAKEBOX_AWS_PROFILE              the box role's stand-in: this Mac's ~/.aws read-only, that profile
#   FAKEBOX_NO_BUILD=1               up uses the images there are (a provisioner's start)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
BOX=abe-fakebox
STATE=/var/lib/abe-box

up() {
  local seed=${1:?usage: run.sh up <seed-dir>}
  [ -n "${FAKEBOX_NO_BUILD:-}" ] || "$here/../build.sh"
  [ -n "${FAKEBOX_NO_BUILD:-}" ] || docker build -q -t abe-fakebox:latest "$here" >/dev/null
  docker rm -f "$BOX" >/dev/null 2>&1 || true
  local extra=(-e ABE_REACH_TARGET=cloud)
  for name in ABE_OWNER ABE_BOX_NAME ABE_IDLE_EVERY_MS; do
    [ -n "${!name:-}" ] && extra+=(-e "$name")
  done
  if [ -n "${FAKEBOX_AWS_PROFILE:-}" ]; then
    extra+=(-v "$HOME/.aws:/root/.aws:ro" -e "AWS_PROFILE=$FAKEBOX_AWS_PROFILE"
      -e AWS_REGION="${AWS_REGION:-eu-west-1}")
  fi
  # The image build where a box's boot unpacks it: up builds the base again from it when its
  # label is not this abe's (#62).
  docker run -d --name "$BOX" --label abe.fakebox=1 \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$here/..:/opt/abe/images:ro" \
    -v "$STATE:$STATE" -v "$seed:/seed:ro" "${extra[@]}" \
    abe-fakebox:latest >/dev/null
  # Each seeded repo becomes the box's mirror, fetching from the seed.
  docker exec "$BOX" sh -ec '
    cd /seed && for m in */*.git; do
      [ -d "'$STATE'/mirrors/repos/$m" ] && continue
      mkdir -p "'$STATE'/mirrors/repos/$(dirname "$m")"
      git clone -q --mirror "/seed/$m" "'$STATE'/mirrors/repos/$m"
    done'
  until docker exec "$BOX" abe status --no-start --json >/dev/null 2>&1; do sleep 0.2; done
  docker exec "$BOX" abe status --json
}

# Its workspaces (ADR 0022: one per card, `abe-ws-<card>`; a 2.2 box's `abe-workspace`), by label.
workspaces() { docker ps -aq --filter label=abe.role=workspace; }

# A box stopping: every container on it stops; disks (volumes) stay. Starting it brings back
# Postgres (its restart policy) and serve; the box's startup then runs `abe workspace up --all`,
# which starts every workspace again.
stop() {
  # shellcheck disable=SC2046
  docker stop -t 10 $(workspaces) abe-pg "$BOX" >/dev/null
}
start() {
  docker start abe-pg "$BOX" >/dev/null
  until docker exec "$BOX" abe status --no-start --json >/dev/null 2>&1; do sleep 0.2; done
  docker exec "$BOX" abe workspace up --all --json >/dev/null
}

down() {
  local volumes
  volumes=$(docker ps -a --filter label=abe.role=workspace \
    --format '{{.Label "abe.card"}}' | sed 's/^/abe-ws-/')
  # shellcheck disable=SC2046
  docker rm -f $(workspaces) abe-pg "$BOX" >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
  docker volume rm $volumes abe-workspace abe-pg-data >/dev/null 2>&1 || true
  docker network rm abe-net >/dev/null 2>&1 || true
  docker run --rm --user root -v /var/lib:/host abe-base:latest rm -rf /host/abe-box
}

case "${1:-}" in
  up) shift; up "$@" ;;
  abe) shift; docker exec "$BOX" abe "$@" ;;
  stop) stop ;;
  start) start ;;
  down) down ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
