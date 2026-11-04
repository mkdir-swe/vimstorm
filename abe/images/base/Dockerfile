# syntax=docker/dockerfile:1.7
# Abe's core base image (linux/arm64): what every session container has before a repo's own layer
# (`<repo>/.abe/session/Dockerfile`, `FROM ${BASE_IMAGE}`). Built by `abe/images/build.sh`.
# No logins, no tokens: those are restored per box at run time (ADR 0016, spec #37).
#
# The `abe-bin` build context holds `abe-linux-arm64` (build.sh: this checkout's
# `bun run build:linux`, or a box's installed binary). It is the last layer, so a new abe build
# rebuilds one layer.

ARG NODE_VERSION=22.23.4
ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION}-debian AS bun

# Debian 13 trixie: bookworm is oldstable on LTS, where Chromium gets no security updates.
FROM node:${NODE_VERSION}-trixie-slim

ARG CLAUDE_CODE_VERSION=2.1.308
ARG CHROME_DEVTOOLS_MCP_VERSION=1.11.0
# 5.9: TypeScript 7 ships no tsserver.js, which typescript-language-server needs.
ARG TYPESCRIPT_VERSION=5.9.3
ARG TS_LS_VERSION=6.0.2
ARG VSCODE_LS_VERSION=4.10.0

ENV LANG=C.UTF-8 \
    DEBIAN_FRONTEND=noninteractive

# OS tools and Chromium (Google Chrome has no linux-arm64 build). bubblewrap and socat: Claude
# Code's sandbox on Linux (the managed settings turn it on and refuse to start without it). chromium-sandbox (the setuid
# helper) is left out: no-new-privileges makes it useless; Chromium keeps its user-namespace
# sandbox under the workspace's seccomp profile instead.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git openssh-client tmux procps less jq ripgrep unzip tini \
      chromium fonts-liberation \
      bubblewrap socat

# gh from GitHub's apt repo.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh

# bun from its official image (the same glibc build the compiled abe targets).
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Node globals, pinned. claude-code's npm package links its native linux-arm64 binary (no Node at
# run time). PUPPETEER_SKIP_DOWNLOAD: chrome-devtools-mcp runs /usr/bin/chromium. Language servers
# are installed, never started here: they start when something needs them.
RUN --mount=type=cache,target=/root/.npm \
    PUPPETEER_SKIP_DOWNLOAD=1 npm install -g --no-audit --no-fund \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION} \
      typescript@${TYPESCRIPT_VERSION} \
      typescript-language-server@${TS_LS_VERSION} \
      vscode-langservers-extracted@${VSCODE_LS_VERSION}

# The session user: the node image's uid 1000 `node` renamed `abe`, so files in volumes keep the
# box user's uid. /run/abe is where the workspace's own serve socket is bind-mounted.
# The script user `abe-run` (uid 1001, #67): checks, the repo pack's setup and `abe run`'s pack
# scripts (code the agent wrote, run outside Claude Code's sandbox) run as it. It shares the clone
# and its .scratch with `abe` through the group `abe-work` (/workspace setgid and sticky, umask 002 where
# either writes) and never reads `abe`'s home (700: Claude Code's and gh's logins). Git trusts the
# clone and Before's worktree for both. /etc/claude-code is root's: the managed settings.
RUN groupmod -n abe node \
 && usermod -l abe -d /home/abe -m -s /bin/bash node \
 && groupadd -g 1001 abe-work \
 && useradd -m -u 1001 -g abe-work -s /bin/bash abe-run \
 && usermod -aG abe-work abe \
 && chmod 700 /home/abe /home/abe-run \
 && install -d -o abe -g abe-work -m 3775 /workspace \
 && install -d -o abe -g abe /run/abe \
 && install -d -o root -g root -m 755 /etc/claude-code \
 && git config --system --add safe.directory /workspace/repo \
 && git config --system --add safe.directory /workspace/repo-base

# Claude Code's first-run screens (theme, onboarding) skipped; its login is restored per box.
RUN printf '{"hasCompletedOnboarding":true,"theme":"dark"}\n' > /home/abe/.claude.json \
 && chown abe:abe /home/abe/.claude.json

# Neovim and VimStorm's config (#89): `g w` on a cloud session runs `NVIM_APPNAME=vimstorm nvim
# --embed` in this container (core/src/session/attach.ts), as the Mac's app runs it. The config is this
# repo's nvim/ (the `vimstorm-nvim` build context: build.sh's, or the release's /opt/abe/nvim on a
# box); its plugins (lazy-lock.json), treesitter parsers (tree-sitter's CLI and a C compiler) and
# Mason's language servers are installed here (vimstorm-warmup.lua), so a workspace opens without
# the network. An empty context (a build without the config) gets Neovim alone.
ARG NVIM_VERSION=0.12.6
ARG NVIM_SHA256=8f1f64a0bdb97247034038c3823c6cbad5bdf9ecd5751b85494b71c3ee04c815
# tree-sitter's own build: nvim-treesitter wants 0.26.1 or later, and not npm's.
ARG TREE_SITTER_VERSION=0.26.13
ARG TREE_SITTER_SHA256=088c5ebf4b4b558c8abfd167c9c4f9669c2f9070da3edd9c0157dc051d77ac5d
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && curl -fsSL -o /tmp/tree-sitter.gz \
      "https://github.com/tree-sitter/tree-sitter/releases/download/v${TREE_SITTER_VERSION}/tree-sitter-linux-arm64.gz" \
 && echo "${TREE_SITTER_SHA256}  /tmp/tree-sitter.gz" | sha256sum -c - \
 && gunzip -c /tmp/tree-sitter.gz > /usr/local/bin/tree-sitter \
 && chmod 0755 /usr/local/bin/tree-sitter \
 && rm /tmp/tree-sitter.gz \
 && curl -fsSL -o /tmp/nvim.tar.gz \
      "https://github.com/neovim/neovim/releases/download/v${NVIM_VERSION}/nvim-linux-arm64.tar.gz" \
 && echo "${NVIM_SHA256}  /tmp/nvim.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/nvim.tar.gz -C /opt \
 && ln -s /opt/nvim-linux-arm64/bin/nvim /usr/local/bin/nvim \
 && rm /tmp/nvim.tar.gz
COPY --from=vimstorm-nvim --chown=abe:abe . /home/abe/.config/vimstorm
COPY vimstorm-warmup.lua /opt/vimstorm-warmup.lua
USER abe
RUN if [ -f /home/abe/.config/vimstorm/init.lua ]; then \
      cd /tmp && NVIM_APPNAME=vimstorm nvim --headless --cmd 'let g:vimstorm_app = 1' \
        -c 'luafile /opt/vimstorm-warmup.lua'; \
    fi
USER root

# The workflow files' JSON Schema (core/schema/workflow.schema.json; this folder's copy, which
# schema.test.ts keeps the same): yaml-language-server in the image's nvim checks and completes a
# Layer's workflows/*.yaml with it (nvim/lua/config/yamlls.lua reads ABE_WORKFLOW_SCHEMA).
COPY workflow.schema.json /opt/abe/schema/workflow.schema.json

# DISABLE_AUTOUPDATER: an image is immutable. ABE_SOCKET: the workspace's own serve socket.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    CHROME_PATH=/usr/bin/chromium \
    ABE_SOCKET=/run/abe/serve.sock \
    ABE_WORKFLOW_SCHEMA=/opt/abe/schema/workflow.schema.json

# The abe it was built with (build.sh, or `abe workspace up` on a box): an image labelled with
# another release is built again, then every workspace image on it (#62).
ARG ABE_VERSION=dev
ARG ABE_HASH=dev
LABEL abe.version=${ABE_VERSION} abe.hash=${ABE_HASH}
COPY --from=abe-bin --chmod=0755 abe-linux-arm64 /usr/local/bin/abe

USER abe
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
