# Abe's install: the app's process group and ports, for the run-app skill's start and stop.
# Copied to .claude/skills/run-app/scripts/ports.sh and sourced by both (POSIX sh):
#
#   start:  . "$(dirname "$0")/ports.sh"
#           abe_run_start
#           abe_port_free 4100 || exit 1
#           npm run dev -- --port 4100 >"$ABE_RUN/web.log" 2>&1 &
#           abe_bound 4100 || exit 1
#           echo "http://localhost:4100"
#
#   stop:   . "$(dirname "$0")/ports.sh"
#           abe_stop
#
# Every part start runs with `&` stays in its process group (the one `abe run` gives it). A part
# that leaves it (a shim that forks the real server apart, like Volta's node) is still found by
# its port: the owner `abe_bound` saw, which descends from start, is stopped too. Anything else on
# a port is never touched: it is said what holds it. The port checks need lsof: without it they
# are off, and start and stop say so. Nothing here runs ps: it is setuid, which a sandbox refuses.

ABE_RUN="${ABE_RUN:-.abe/.run}"

# Whether the port checks are on: they need lsof. Off, it is said once, and why.
abe_ports_on() {
  command -v lsof >/dev/null 2>&1 && return 0
  if [ -z "${ABE_PORTS_SAID:-}" ]; then
    echo "port checks off: lsof is not on PATH, so start does not check that a port is free or that its own server bound it, and stop ends only the process group" >&2
    ABE_PORTS_SAID=1
  fi
  return 1
}

# Who listens on TCP port $1, as "pid command"; nothing when it is free (or lsof is missing).
abe_port_owner() {
  command -v lsof >/dev/null 2>&1 || return 0
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fpc 2>/dev/null |
    awk '/^p/ { p = substr($0, 2) } /^c/ { print p, substr($0, 2); exit }'
}

# Field $2 of pid $1 as lsof reads it: g its process group, R its parent.
abe_proc() {
  lsof -a -p "$1" -d cwd -F"$2" 2>/dev/null | sed -n "s/^$2//p" | head -n 1
}

# This shell's process group. Without lsof it is this shell's pid: `abe run` makes each script
# the leader of a group of its own.
abe_group() {
  if command -v lsof >/dev/null 2>&1; then abe_proc $$ g; else echo $$; fi
}

# Whether pid $1 is pid $2 or descends from it.
abe_descends() {
  abe_p=$1
  while [ -n "$abe_p" ] && [ "$abe_p" -gt 1 ]; do
    [ "$abe_p" = "$2" ] && return 0
    abe_p=$(abe_proc "$abe_p" R)
  done
  return 1
}

# start, first: the run's folder, its process group and no owners yet.
abe_run_start() {
  mkdir -p "$ABE_RUN"
  abe_group >"$ABE_RUN/pgid"
  : >"$ABE_RUN/owners"
}

# start, before a part: its port free; else what holds it, and no start.
abe_port_free() {
  abe_ports_on || return 0
  abe_o=$(abe_port_owner "$1")
  [ -z "$abe_o" ] && return 0
  echo "port $1 is held by ${abe_o#* } (pid ${abe_o%% *}): stop it first (abe run stop, or end that process)" >&2
  return 1
}

# start, after a part: up to $2 s (60) until this run's own server listens on port $1, its owner
# kept for stop. One there that is not this run's fails, saying what holds it.
abe_bound() {
  abe_ports_on || return 0
  abe_i=0
  abe_n=$((${2:-60} * 5))
  while [ "$abe_i" -lt "$abe_n" ]; do
    abe_o=$(abe_port_owner "$1")
    if [ -n "$abe_o" ]; then
      abe_pid=${abe_o%% *}
      if abe_descends "$abe_pid" $$; then
        echo "$1 $abe_pid" >>"$ABE_RUN/owners"
        return 0
      fi
      echo "port $1 is held by ${abe_o#* } (pid $abe_pid), not this run: stop it, then start again" >&2
      return 1
    fi
    sleep 0.2
    abe_i=$((abe_i + 1))
  done
  echo "nothing of this run listens on port $1 after ${2:-60} s: see $ABE_RUN/*.log" >&2
  return 1
}

# Whether pid or group $1 is still there. One this shell may not signal (a sandbox refuses it)
# counts as there.
abe_there() {
  abe_e=$(kill -0 -- "$1" 2>&1) && return 0
  case $abe_e in *"No such process"*) return 1 ;; esac
  return 0
}

# Signals pid or group $1 (`-<pgid>`) with TERM, up to 5 s for it to go, then KILL. One gone
# already is fine; fails when this shell may not signal it.
abe_end() {
  abe_there "$1" || return 0
  if ! kill -TERM -- "$1" 2>/dev/null; then
    abe_there "$1" && return 1
    return 0
  fi
  abe_i=0
  while abe_there "$1" && [ "$abe_i" -lt 25 ]; do
    sleep 0.2
    abe_i=$((abe_i + 1))
  done
  kill -KILL -- "$1" 2>/dev/null || :
  return 0
}

# stop: the run's whole process group, then each port it bound. Its owner still there is ended
# when it is the one start saw or descends from it; anything else is said and left as it is.
# What this shell may not signal is said, and the run is kept for a stop that may.
abe_stop() {
  [ -f "$ABE_RUN/pgid" ] || return 0
  abe_g=$(cat "$ABE_RUN/pgid")
  abe_me=$(abe_group)
  abe_rc=0
  abe_kept=
  if [ -n "$abe_g" ] && [ "$abe_g" != "$abe_me" ] && ! abe_end "-$abe_g"; then
    echo "could not stop process group $abe_g: this shell may not signal it (stop through \`abe run stop\`)" >&2
    abe_kept=1
  fi
  abe_ports_on || : >"$ABE_RUN/owners"
  while read -r abe_port abe_pid; do
    [ -n "$abe_port" ] || continue
    abe_o=$(abe_port_owner "$abe_port")
    [ -z "$abe_o" ] && continue
    abe_h=${abe_o%% *}
    if [ "$abe_h" = "$abe_pid" ] || abe_descends "$abe_h" "$abe_pid"; then
      if ! abe_end "$abe_h"; then
        echo "could not stop pid $abe_h on port $abe_port: this shell may not signal it (stop through \`abe run stop\`)" >&2
        abe_kept=1
      fi
    else
      echo "port $abe_port is held by ${abe_o#* } (pid $abe_h), not this run's: left as it is" >&2
      abe_rc=1
    fi
  done <"$ABE_RUN/owners"
  [ -z "$abe_kept" ] || return 1
  rm -f "$ABE_RUN/pgid" "$ABE_RUN/owners"
  return $abe_rc
}
