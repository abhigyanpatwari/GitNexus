# syntax=docker/dockerfile:1

# Base image: Microsoft's TypeScript+Node devcontainer image. Multi-arch
# (linux/amd64, linux/arm64), monthly security patching, ships the non-root
# `node` user (UID 1000), zsh + Oh My Zsh, eslint global, `gh` CLI.
FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# Build args. Version defaults are NOT set here — devcontainer.json
# `build.args` is the single source of truth. Standalone `docker build
# .devcontainer/` (e.g., CI smoke) must pass each version via --build-arg
# or the build will fail loudly rather than silently drift from the
# devcontainer-canonical pin.
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
ARG TZ=UTC
ARG USERNAME=node
# NOTE: there is intentionally no CURSOR_VERSION ARG. The cursor.com/install
# script does not honour a version pin, so an ARG would be dead config that
# implies a guarantee the installer can't keep. Cursor is currently installed
# unpinned (see the install step below); pinning is tracked as a follow-up in
# README § "What's not included (yet)".

# Promote build-only ARGs into runtime ENV so shells and lifecycle scripts
# can read them. CLAUDE_CONFIG_DIR is intentionally NOT set here — the
# canonical value lives in devcontainer.json `containerEnv` (single source
# of truth; runtime-time wins anyway).
ENV CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION} \
    CODEX_VERSION=${CODEX_VERSION} \
    TZ=${TZ} \
    DEVCONTAINER=true \
    NODE_OPTIONS=--max-old-space-size=4096 \
    POWERLEVEL9K_DISABLE_GITSTATUS=true

# Native build toolchain required by gitnexus/postinstall: tree-sitter
# native bindings, vendored Dart/Proto/Swift grammars, @ladybugdb/core
# N-API addon. python3/make/g++ are non-negotiable; mirrors the apt block
# in the existing Dockerfile.cli / gitnexus/Dockerfile.test images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 make g++ git curl ca-certificates bash \
    && rm -rf /var/lib/apt/lists/*

# Pre-create + chown the named-volume mount points (~/.npm, ~/.local,
# /commandhistory) so empty volumes inherit `node:node` ownership on first
# mount. The three CLI config dirs (~/.claude, ~/.codex, ~/.cursor) are
# bind-mounted from the host — bind mounts fully shadow image-side
# ownership, so no chown is needed for those paths here.
RUN mkdir -p \
        /home/${USERNAME}/.npm \
        /home/${USERNAME}/.local/bin \
        /commandhistory \
    && chown -R ${USERNAME}:${USERNAME} \
        /home/${USERNAME}/.npm \
        /home/${USERNAME}/.local \
        /commandhistory

USER ${USERNAME}

# Install Claude Code and Codex CLI globally as the `node` user. The base
# image configures /usr/local/share/npm-global as the npm-global prefix
# with the `npm` group writable by `node`, so `npm install -g` works
# without sudo. Both versions are pinned via build args — bump in
# devcontainer.json and rebuild to upgrade.
RUN npm install -g \
        @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
        @openai/codex@${CODEX_VERSION}

# Cursor CLI install. The official cursor.com/install script does not
# expose version pinning or a checksum, so we download to a temp file,
# log the sha256 to build output (so drift across rebuilds shows up in
# CI logs), then execute. Trust assumption: cursor.com's TLS chain is
# reliable. Long-term hardening (tracked as a follow-up): pin a specific
# downloads.cursor.com/lab/<version>/<arch>/agent-cli-package.tar.gz URL
# with a hard sha256 verification and skip the install script entirely.
#
# `timeout 300` wraps the installer because the script makes its OWN network
# requests (it downloads the actual Cursor binary) that `curl --max-time`
# above does NOT cover — without it a slow/hung Cursor CDN would block the
# Docker build indefinitely with no watchdog.
RUN curl -fsS --retry 3 --max-time 60 -o /tmp/cursor-install.sh https://cursor.com/install \
    && echo "Cursor installer sha256:" \
    && sha256sum /tmp/cursor-install.sh \
    && timeout 300 bash /tmp/cursor-install.sh \
    && rm -f /tmp/cursor-install.sh

# ~/.local/bin (where Cursor's installer drops `agent` and `cursor-agent`
# symlinks) on PATH for interactive shells and lifecycle scripts.
ENV PATH=/home/${USERNAME}/.local/bin:${PATH}
