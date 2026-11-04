# syntax=docker/dockerfile:1.7
# A box on a Mac's Docker (OrbStack), beside the real EC2 boxes (#53, #90): the core
# base image plus a Docker CLI, running `abe serve` as a box (ABE_BOX) against the Mac's daemon,
# and the aws CLI: the box reads its owner's logins from Secrets Manager (run.sh hands it a profile).
# A real box runs `abe serve` on the host instead; this exists because a macOS unix socket does not
# cross into a Linux container, so the box's serve must itself run on Linux. Started by run.sh.
FROM abe-base:latest
USER root
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends docker-cli docker-buildx awscli
ENV ABE_BOX=1 \
    ABE_STATE_DIR=/var/lib/abe-box \
    ABE_SOCKET=/var/lib/abe-box/serve.sock \
    ABE_WORKSPACE=
WORKDIR /var/lib/abe-box
CMD ["abe", "serve"]
