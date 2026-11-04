#!/usr/bin/env bash
# Box host (run as root at boot, after dockerd, e.g. a systemd unit After=docker.service).
# Containers on Docker bridges must not reach the instance metadata service (the box role).
# 1) DOCKER-USER is evaluated in FORWARD before Docker's own rules, for every bridge network.
#    Never run a workspace with --network host: host traffic skips FORWARD.
set -euo pipefail
iptables -N DOCKER-USER 2>/dev/null || true
iptables -C DOCKER-USER -d 169.254.169.254/32 -j DROP 2>/dev/null \
  || iptables -I DOCKER-USER 1 -d 169.254.169.254/32 -j DROP
# IMDS IPv6 endpoint (Nitro), only if the instance enables it.
if ip6tables -L DOCKER-USER -n >/dev/null 2>&1 || ip6tables -N DOCKER-USER 2>/dev/null; then
  ip6tables -C DOCKER-USER -d fd00:ec2::254/128 -j DROP 2>/dev/null \
    || ip6tables -I DOCKER-USER 1 -d fd00:ec2::254/128 -j DROP
fi
# 2) Belt and braces, in the box's Terraform (not here):
#    metadata_options { http_tokens = "required"  http_put_response_hop_limit = 1 }
#    IMDSv2 only, and the PUT token reply dies one hop out, so a bridged container (an extra hop)
#    never gets a token even if the iptables rule is missing.
iptables -S DOCKER-USER
