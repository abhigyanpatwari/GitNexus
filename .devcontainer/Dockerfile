# syntax=docker/dockerfile:1

# Base image: Microsoft's TypeScript+Node devcontainer image. Multi-arch
# (linux/amd64, linux/arm64), monthly security patching, ships the non-root
# `node` user (UID 1000), zsh + Oh My Zsh, eslint global, `gh` CLI.
#
# Digest-pinned (matches the Dockerfile.cli / gitnexus/Dockerfile.test
# convention and issue #1451) so a silent upstream retag can't change the
# build under us. Pinned as bare `name@digest` (NO `:tag` prefix) on purpose:
# unlike the production Dockerfiles (built with plain `docker build`), this one
# is built by `@devcontainers/cli` / the VS Code Dev Containers resolver, whose
# image-name parser rejects the combined `name:tag@sha256:...` form. The digest
# below corresponds to the `1-22-bookworm` tag and is the multi-arch
# manifest-list digest, so it still resolves the right platform. Refresh when
# bumping the readable tag:
#   docker buildx imagetools inspect \
#     mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm \
#     --format '{{json .Manifest.Digest}}'
FROM mcr.microsoft.com/devcontainers/typescript-node@sha256:7c2e711a4f7b02f32d2da16192d5e05aa7c95279be4ce889cff5df316f251c1d

# Build args. Version defaults are NOT set here — devcontainer.json
# `build.args` is the single source of truth. Standalone `docker build
# .devcontainer/` (e.g., CI smoke) must pass each version via --build-arg
# or the build will fail loudly rather than silently drift from the
# devcontainer-canonical pin.
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
# Cursor is pinned by version + per-arch tarball sha256 (verified in the
# install step below); all three live in devcontainer.json build.args, same
# single-source-of-truth / fail-loud-without-default rule as the others.
ARG CURSOR_VERSION
ARG CURSOR_SHA256_X64
ARG CURSOR_SHA256_ARM64
ARG TZ=UTC
ARG USERNAME=node

# Promote build-only ARGs into runtime ENV so shells and lifecycle scripts
# can read them. CLAUDE_CONFIG_DIR is intentionally NOT set here — the
# canonical value lives in devcontainer.json `containerEnv` (single source
# of truth; runtime-time wins anyway).
ENV CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION} \
    CODEX_VERSION=${CODEX_VERSION} \
    CURSOR_VERSION=${CURSOR_VERSION} \
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

# Cursor CLI install — pinned and hash-verified, no remote script executed.
# cursor.com/install merely detects os/arch and downloads a versioned tarball
# from downloads.cursor.com/lab/<version>/<os>/<arch>/agent-cli-package.tar.gz,
# then extracts it and symlinks `agent`/`cursor-agent` into ~/.local/bin. We
# replicate that directly against a PINNED version + per-arch sha256, so the
# build runs no unverified remote code (matches the base-image / npm digest-pin
# convention; issue #1451). The download is fail-closed: a sha mismatch aborts.
#
# Bump: set CURSOR_VERSION + both CURSOR_SHA256_* in devcontainer.json
# build.args. Re-hash each arch with:
#   curl -fSL https://downloads.cursor.com/lab/<ver>/linux/<x64|arm64>/agent-cli-package.tar.gz | sha256sum
#
# TARGETARCH is BuildKit's automatic per-platform build arg; it must be
# (re)declared in this stage to be in scope. Fall back to `dpkg
# --print-architecture` for a non-BuildKit `docker build`.
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

# ~/.local/bin (where Cursor's installer drops `agent` and `cursor-agent`
# symlinks) on PATH for interactive shells and lifecycle scripts.
ENV PATH=/home/${USERNAME}/.local/bin:${PATH}
