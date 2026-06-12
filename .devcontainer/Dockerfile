# syntax=docker/dockerfile:1

# Base image: Microsoft's TypeScript+Node devcontainer image. It works on both
# linux/amd64 and linux/arm64, gets monthly security patches, and ships the
# non-root `node` user (UID 1000, i.e. user ID 1000), zsh + Oh My Zsh, eslint
# global, and the `gh` CLI.
#
# We pin the image by digest, not by tag. That way a silent upstream retag can't
# change the build under us. This matches the Dockerfile.cli /
# gitnexus/Dockerfile.test convention and issue #1451.
#
# We pin it as a bare `name@digest` with NO `:tag` prefix on purpose. The
# production Dockerfiles use plain `docker build`, but this one is built by
# `@devcontainers/cli` / the VS Code Dev Containers resolver. That resolver's
# image-name parser rejects the combined `name:tag@sha256:...` form.
#
# The digest below is for the `1-22-bookworm` tag. It is the multi-arch
# manifest-list digest, so it still picks the right platform. To refresh it when
# bumping the readable tag, run:
#   docker buildx imagetools inspect \
#     mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm \
#     --format '{{json .Manifest.Digest}}'
FROM mcr.microsoft.com/devcontainers/typescript-node@sha256:7c2e711a4f7b02f32d2da16192d5e05aa7c95279be4ce889cff5df316f251c1d

# Bun is installed via the official remote script (bun.sh/install), pinned by
# version. Claude Code and Cursor also use official install scripts (no version
# to pin). To harden Bun: switch to a pinned tarball + per-arch sha256
# (release artifacts at github.com/oven-sh/bun/releases).
ARG BUN_VERSION
ARG TZ=UTC
ARG USERNAME=node

# Copy the build-only ARGs into runtime ENV so shells and lifecycle scripts can
# read them. We deliberately do not set CLAUDE_CONFIG_DIR here. Its one true
# value lives in devcontainer.json `containerEnv`, and the runtime value wins
# anyway.
ENV BUN_VERSION=${BUN_VERSION} \
    BUN_INSTALL=/home/${USERNAME}/.bun \
    TZ=${TZ} \
    DEVCONTAINER=true \
    NODE_OPTIONS=--max-old-space-size=4096 \
    POWERLEVEL9K_DISABLE_GITSTATUS=true

# Native build toolchain that gitnexus/postinstall needs. It compiles
# tree-sitter native bindings, the vendored Dart/Proto/Swift grammars, and the
# @ladybugdb/core N-API addon (a native Node add-on). python3, make, and g++ are
# required. This mirrors the apt block in the existing Dockerfile.cli /
# gitnexus/Dockerfile.test images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 make g++ git curl ca-certificates bash unzip \
    && rm -rf /var/lib/apt/lists/*

# Create and chown the named-volume mount points (~/.npm, ~/.local,
# /commandhistory) up front. That way an empty volume inherits `node:node`
# ownership the first time it is mounted. The three CLI config dirs (~/.claude,
# ~/.codex, ~/.cursor) are bind-mounted from the host instead. A bind mount
# completely hides the image-side ownership, so those paths need no chown here.
RUN mkdir -p \
        /home/${USERNAME}/.npm \
        /home/${USERNAME}/.local/bin \
        /commandhistory \
    && chown -R ${USERNAME}:${USERNAME} \
        /home/${USERNAME}/.npm \
        /home/${USERNAME}/.local \
        /commandhistory

USER ${USERNAME}

# Install Claude Code via the official native installer. Downloads the latest
# self-contained binary for the running platform and places it at
# ~/.local/bin/claude — no Node.js runtime dependency, no version to pin.
RUN curl -fsSL https://claude.ai/install.sh | bash

# Install the Codex CLI globally via npm. No version pinned — @latest at build
# time. (Codex has no native binary installer; npm is the canonical method.)
RUN npm install -g @openai/codex

# Install the Cursor agent CLI via the official install script. Downloads the
# latest agent-cli-package for the running platform and places `cursor-agent`
# and `agent` into ~/.local/bin — no version or hash to pin.
RUN curl -fsSL https://cursor.com/install | bash

# Install Bun via the official remote installer, pinned by version. The first
# positional arg to `bash` is the release tag (`bun-vX.Y.Z`), so a specific
# version is fetched even though the install script itself is downloaded fresh
# on every build. NOTE: this is the ONE remote script we run unverified in
# this image — Cursor and the base image are pinned by sha256/digest. Hardening
# path: switch to a pinned tarball + per-arch sha256 in the Cursor style
# (artifacts at github.com/oven-sh/bun/releases). `BUN_INSTALL` is set in ENV
# above so the binary lands at a known path regardless of any rc-file edits
# the installer makes (which we ignore — we own the shell rc files).
RUN set -eux; \
    curl -fsSL --retry 3 --max-time 120 https://bun.sh/install \
        | bash -s "bun-v${BUN_VERSION}"; \
    test -x "${BUN_INSTALL}/bin/bun"

# Put ~/.local/bin and Bun's bin dir on PATH for interactive shells and
# lifecycle scripts. ~/.local/bin is where Cursor's installer drops the `agent`
# and `cursor-agent` symlinks; ${BUN_INSTALL}/bin is where the Bun installer
# drops `bun` / `bunx`.
ENV PATH=/home/${USERNAME}/.local/bin:${BUN_INSTALL}/bin:${PATH}
