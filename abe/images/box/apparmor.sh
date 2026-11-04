#!/usr/bin/env bash
# Box host (run as root at boot, before Docker starts the workspace): loads the workspace
# container's AppArmor profile, abe-workspace (images/box/apparmor/abe-workspace: docker-default
# with only Claude Code's bubblewrap mounts), replacing an older one; parsed again on every boot.
# `abe workspace up` runs the container with --security-opt apparmor=abe-workspace. A host without
# AppArmor fails here: Docker would apply no profile there and run the workspace unconfined, so
# this unit fails and the workspace's, which requires it, never starts (and `up` refuses unless a
# container under the profile runs in it, enforced).
# ABE_APPARMOR_ENABLED: AppArmor's switch to read (tests; default the kernel's).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
enabled=${ABE_APPARMOR_ENABLED:-/sys/module/apparmor/parameters/enabled}
if [ "$(cat "$enabled" 2>/dev/null || echo N)" != Y ]; then
  echo "apparmor: AppArmor is not enabled on this host: abe-workspace not loaded, no workspace runs" >&2
  exit 1
fi
apparmor_parser -r "$here/apparmor/abe-workspace"
echo "apparmor: abe-workspace loaded"
