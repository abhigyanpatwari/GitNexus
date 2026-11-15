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
# The digest below is for `5.2.3-22-trixie` (Node 22.23.3). Workspace
# dependencies require at least Node 22.22.2 on the Node 22 line. It is the
# multi-arch manifest-list digest, so it still picks the right platform.
# Debian 13's libstdc++ supplies GLIBCXX_3.4.31, required by the packaged
# tree-sitter runtime. Debian 12's runtime is too old even with g++ installed.
# To refresh it when bumping the readable tag, run:
#   docker buildx imagetools inspect \
#     mcr.microsoft.com/devcontainers/typescript-node:5.2.3-22-trixie \
#     --format '{{json .Manifest.Digest}}'
FROM mcr.microsoft.com/devcontainers/typescript-node@sha256:e17cfac65d32af8e488fb00ee7b51b1e508b21958c05c8b652224a1f739deb08

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Bun is installed via the official remote script (bun.sh/install), pinned by
# version. Claude Code, Codex, and Cursor also use official install scripts.
# To harden Bun: switch to a pinned tarball + per-arch sha256
# (release artifacts at github.com/oven-sh/bun/releases).
ARG BUN_VERSION
ARG TZ=UTC
ARG USERNAME=node
ARG INSTALL_BROWSER_DEPS=false
ARG PLAYWRIGHT_VERSION

# Copy the build-only ARGs into runtime ENV so shells and lifecycle scripts can
# read them. We deliberately do not set CLAUDE_CONFIG_DIR here. Its one true
# value lives in devcontainer.json `containerEnv`, and the runtime value wins
# anyway.
ENV BUN_VERSION=${BUN_VERSION} \
    BUN_INSTALL=/home/${USERNAME}/.bun \
    TZ=${TZ} \
    DEVCONTAINER=true \
    POWERLEVEL9K_DISABLE_GITSTATUS=true

# Native build toolchain that gitnexus/postinstall needs. It compiles
# tree-sitter native bindings, the vendored Dart/Proto/Swift grammars, and the
# @ladybugdb/core N-API addon (a native Node add-on). python3, make, and g++ are
# required; libstdc++6 provides the C++ runtime for shipped native prebuilds.
# util-linux supplies findmnt/mount for the 9p helper; the remaining diagnostic
# tools support investigating process, memory and filesystem delays.
# This mirrors the apt block in the existing Dockerfile.cli /
# gitnexus/Dockerfile.test images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 make g++ libstdc++6 git curl ca-certificates bash unzip util-linux procps lsof strace time jq ripgrep \
    && rm -rf /var/lib/apt/lists/*

# UI profile: install OS dependencies at image-build time as root. Runtime
# browser downloads use the project's locked Playwright and a persistent volume.
RUN --mount=type=cache,target=/root/.npm \
    if [ "${INSTALL_BROWSER_DEPS}" = true ]; then \
        test -n "${PLAYWRIGHT_VERSION}" \
        && npm exec --yes --package="@playwright/test@${PLAYWRIGHT_VERSION}" -- playwright install-deps chromium \
        && rm -rf /var/lib/apt/lists/*; \
    fi

COPY bootstrap-native.cjs /usr/local/share/gitnexus-devcontainer/bootstrap-native.cjs

# Create and chown the named-volume mount points (~/.npm, ~/.local,
# /commandhistory) up front. That way an empty volume inherits `node:node`
# ownership the first time it is mounted. post-create.sh handles ownership on
# the CLI config volumes (~/.claude, ~/.codex, ~/.cursor), including reused ones.
RUN mkdir -p \
        /home/${USERNAME}/.npm \
        /home/${USERNAME}/.local/bin \
        /commandhistory \
    && chown -R ${USERNAME}:${USERNAME} \
        /home/${USERNAME}/.npm \
        /home/${USERNAME}/.local \
        /commandhistory

USER ${USERNAME}

# Native CLI installers use this directory for their launchers.
ENV PATH=/home/${USERNAME}/.local/bin:${BUN_INSTALL}/bin:${PATH}

# Install Claude Code via the official native installer. Downloads the latest
# self-contained binary for the running platform and places it at
# ~/.local/bin/claude — no Node.js runtime dependency, no version to pin.
RUN curl -fsSL --retry 3 --max-time 120 https://claude.ai/install.sh | bash \
    && /home/${USERNAME}/.local/bin/claude --version

# Install standalone Codex without npm or interactive onboarding. Keep a seed
# outside ~/.codex: its runtime config volume can hide image-installed packages
# on rebuild. post-create.sh restores the seed only if Codex cannot run.
RUN curl -fsSL --retry 3 --max-time 120 https://chatgpt.com/codex/install.sh -o /tmp/install-codex.sh \
    && CODEX_NON_INTERACTIVE=1 sh /tmp/install-codex.sh \
    && /home/${USERNAME}/.local/bin/codex --version \
    && mkdir -p /home/${USERNAME}/.local/share \
    && mv /home/${USERNAME}/.codex/packages/standalone /home/${USERNAME}/.local/share/codex-standalone \
    && rm /tmp/install-codex.sh

# Install the Cursor agent CLI via the official install script. Downloads the
# latest agent-cli-package for the running platform and places `cursor-agent`
# and `agent` into ~/.local/bin — no version or hash to pin.
RUN curl -fsSL --retry 3 --max-time 120 https://cursor.com/install | bash \
    && /home/${USERNAME}/.local/bin/cursor-agent --version

# Install Bun via the official remote installer, pinned by version. The first
# positional arg to `bash` is the release tag (`bun-vX.Y.Z`), so a specific
# version is fetched even though the install script itself is downloaded fresh
# on every build. The installer script itself is not pinned. `BUN_INSTALL` is
# set in ENV above so the binary lands at a known path regardless of rc-file edits
# the installer makes (which we ignore — we own the shell rc files).
RUN set -eux; \
    curl -fsSL --retry 3 --max-time 120 https://bun.sh/install \
        | bash -s "bun-v${BUN_VERSION}"; \
    test -x "${BUN_INSTALL}/bin/bun"
