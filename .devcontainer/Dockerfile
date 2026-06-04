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

# Build args. We deliberately set no version defaults here. devcontainer.json
# `build.args` is the single source of truth for versions. A standalone
# `docker build .devcontainer/` (for example, a CI smoke test) must pass each
# version with --build-arg. Without a default, the build fails loudly instead of
# silently drifting from the version pinned in devcontainer.json.
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
# Cursor is pinned by version plus a per-arch tarball sha256 hash. The install
# step below verifies that hash. All three values live in devcontainer.json
# build.args. They follow the same rule as the others: one source of truth, and
# no default so the build fails loudly if a value is missing.
ARG CURSOR_VERSION
ARG CURSOR_SHA256_X64
ARG CURSOR_SHA256_ARM64
# Bun is installed via the official remote script (bun.sh/install), pinned by
# version. UNLIKE Cursor and the npm packages, this install path runs an
# UNVERIFIED remote script — there is no tarball-hash check. Chosen explicitly
# at request time over the pin-by-sha256 alternative for install-script
# simplicity. To harden later, switch to a pinned tarball + per-arch sha256 in
# the Cursor style (release artifacts at github.com/oven-sh/bun/releases).
ARG BUN_VERSION
ARG TZ=UTC
ARG USERNAME=node

# Copy the build-only ARGs into runtime ENV so shells and lifecycle scripts can
# read them. We deliberately do not set CLAUDE_CONFIG_DIR here. Its one true
# value lives in devcontainer.json `containerEnv`, and the runtime value wins
# anyway.
ENV CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION} \
    CODEX_VERSION=${CODEX_VERSION} \
    CURSOR_VERSION=${CURSOR_VERSION} \
    BUN_VERSION=${BUN_VERSION} \
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

# Install Claude Code and the Codex CLI globally, as the `node` user. The base
# image sets /usr/local/share/npm-global as the npm-global prefix and makes the
# `npm` group writable by `node`. So `npm install -g` works without sudo. Both
# versions come from build args. To upgrade, bump them in devcontainer.json and
# rebuild.
RUN npm install -g \
        @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
        @openai/codex@${CODEX_VERSION}

# Install the Cursor CLI. It is pinned and hash-verified, and we run no remote
# script. The cursor.com/install script just detects os/arch, downloads a
# versioned tarball from
# downloads.cursor.com/lab/<version>/<os>/<arch>/agent-cli-package.tar.gz,
# extracts it, and symlinks `agent`/`cursor-agent` into ~/.local/bin. We do that
# ourselves against a PINNED version plus a per-arch sha256 hash. So the build
# runs no unverified remote code. This matches how we pin the base image and npm
# packages by digest (issue #1451). The download is fail-closed: if the hash
# does not match, the build aborts.
#
# To bump: set CURSOR_VERSION and both CURSOR_SHA256_* in devcontainer.json
# build.args. Get each arch's hash with:
#   curl -fSL https://downloads.cursor.com/lab/<ver>/linux/<x64|arm64>/agent-cli-package.tar.gz | sha256sum
#
# TARGETARCH is the per-platform build arg that BuildKit sets automatically. It
# must be (re)declared in this stage to be visible. When the build is a
# non-BuildKit `docker build`, TARGETARCH is unset, so we fall back to `dpkg
# --print-architecture`.
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
        amd64) cursor_arch=x64;   cursor_sha="${CURSOR_SHA256_X64}";; \
        arm64) cursor_arch=arm64; cursor_sha="${CURSOR_SHA256_ARM64}";; \
        *) echo "unsupported architecture for Cursor: $arch" >&2; exit 1;; \
    esac; \
    url="https://downloads.cursor.com/lab/${CURSOR_VERSION}/linux/${cursor_arch}/agent-cli-package.tar.gz"; \
    curl -fSL --retry 3 --max-time 120 -o /tmp/cursor.tgz "$url"; \
    echo "${cursor_sha}  /tmp/cursor.tgz" | sha256sum -c -; \
    dir="/home/${USERNAME}/.local/share/cursor-agent/versions/${CURSOR_VERSION}"; \
    install -d "$dir" "/home/${USERNAME}/.local/bin"; \
    tar --strip-components=1 -xzf /tmp/cursor.tgz -C "$dir"; \
    test -x "$dir/cursor-agent"; \
    ln -sf "$dir/cursor-agent" "/home/${USERNAME}/.local/bin/agent"; \
    ln -sf "$dir/cursor-agent" "/home/${USERNAME}/.local/bin/cursor-agent"; \
    rm -f /tmp/cursor.tgz

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
