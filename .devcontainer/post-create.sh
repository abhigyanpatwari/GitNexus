#!/usr/bin/env bash
# Devcontainer postCreate script. It runs once, right after the container is
# created. devcontainer.json wires it up via `postCreateCommand`. Workspace
# dependencies are installed elsewhere, in install-deps.sh (`updateContentCommand`).
# That script runs BEFORE this one — that is the order the devcontainer spec
# defines. This script does one job: sync the AI CLI credentials and identity
# from the host.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[post-create] 1/2: chown AI CLI named-volume mount points"
# Fix ownership on the named volumes (~/.claude, ~/.codex, ~/.cursor,
# /commandhistory). When they first mount, they take the user ID baked into the
# image, before any realignment. Then `updateRemoteUserUID: true` shifts the
# `node` user to a new ID. Now the volumes are owned by the old, stale ID, and
# writes into them fail. (~/.local is a directory in the image, not a volume.
# We chown it too, just to be safe.) install-deps.sh fixes the workspace side.
# This script fixes the AI CLI side, so each lifecycle hook handles its own part.
#
# There are two separate guards here, and they do different things. `-xdev`
# keeps find from descending into other filesystems. It stops at the volume's
# own filesystem and won't walk into the read-write host bind mounts layered at
# sub-paths (plugins/marketplaces, plugins/cache, skills, agents, memory,
# commands, codex/plugins, cursor/*). Those bind mounts live on a DIFFERENT
# filesystem (9p, virtiofs, or bind). Walking into them would rewrite the
# ownership of the host's own files on a Linux host whose user IDs don't line
# up. Worse, a permission error there would kill provisioning before
# credentials ever sync. `-h` tells chown to act on a symlink ITSELF instead of
# following it. So it never lands on a target across a filesystem boundary, and
# it never aborts on a broken symlink under `set -e`. For regular files and
# directories `-h` does nothing extra.
#
# The session volumes (mount group 6: .claude/projects, .codex/sessions,
# .cursor/chats, .cursor/projects) are their OWN filesystems mounted at
# sub-paths, so `-xdev` rooted at the config-volume parent deliberately skips
# them. That is why each one is listed as its own root below: rooted there,
# `-xdev` walks just that volume and chowns its top level, so the CLI's first
# write doesn't hit EACCES on a stale image UID. We DO chown these (unlike the
# host bind mounts) precisely because they are container-private volumes, not
# the host's own files.
DIRS=(
    /home/node/.claude
    /home/node/.claude/projects
    /home/node/.codex
    /home/node/.codex/sessions
    /home/node/.cursor
    /home/node/.cursor/chats
    /home/node/.cursor/projects
    /home/node/.local
    /commandhistory
)
for d in "${DIRS[@]}"; do
    # Skip a root that isn't present rather than aborting the whole run under
    # `set -e`. Docker creates every declared volume's mount point before this
    # script runs, so in the normal case all roots exist and this is a no-op.
    # The guard matters only if a session volume is later removed from
    # devcontainer.json without its matching DIRS entry being removed too — then
    # provisioning skips it instead of failing before credentials ever sync.
    [ -d "$d" ] || continue
    sudo find "$d" -xdev -exec chown -h node:node {} +
done

echo "[post-create] 2/2: sync AI CLI credentials + identity from host"
# Clean up after an older devcontainer design (Option B). Back then these paths
# were symlinks pointing into the read-only host stage
# (e.g. /home/node/.claude/plugins -> /host/.claude/plugins). The current setup
# bind-mounts sub-paths read-write, but it does not replace the parent symlink
# itself. So a write to, say, /home/node/.claude/plugins/known_marketplaces.json
# would follow the old symlink to a read-only host file and fail with a
# read-only-filesystem error. Delete those symlinks here. The mkdir -p below
# then recreates them as real directories in the named volume.
for p in plugins skills agents memory commands; do
    [ -L "/home/node/.claude/$p" ] && rm "/home/node/.claude/$p"
done
for p in plugins prompts memories skills config.toml; do
    [ -L "/home/node/.codex/$p" ] && rm "/home/node/.codex/$p"
done
for p in plugins rules commands agents skills; do
    [ -L "/home/node/.cursor/$p" ] && rm "/home/node/.cursor/$p"
done
mkdir -p /home/node/.claude/plugins /home/node/.cursor/plugins

# Shareable content is bind-mounted read-write straight from the host in
# devcontainer.json. Changes flow both ways, so this script does nothing for it:
#   - Claude: plugins/{marketplaces,cache}, skills, agents, memory, commands
#   - Codex:  plugins (whole dir), prompts, memories, skills
#   - Cursor: plugins/{marketplaces,local}, rules, commands, agents, skills
#
# The rest stays per-container, in the named volume, and is COPIED from the host
# once when the container is created:
#   - .credentials.json (Claude OAuth tokens)
#   - .claude/.claude.json (Claude identity: userID, oauthAccount, and
#     migration tracking — a different file from $HOME/.claude.json)
#   - settings.json (Claude), config.toml (Codex), mcp.json (Cursor). These are
#     single config files, and single files can't be bind-mounted on Windows
#     (the EXDEV error explained below).
#   - auth.json (Codex), cli-config.json (Cursor — which mixes auth and settings)
#   - the plugin registry JSONs that contain absolute paths (Claude + Cursor).
#     Those are translated below.
#
# How the sync behaves: it ALWAYS overwrites from the host when the container is
# created. A fresh container then starts logged in as the host's user, if the
# host had credentials. From that point the container manages its own login,
# until the next rebuild copies the host files again. Logging out inside the
# container does NOT log out the host. Per-container login is the goal, and
# bind-mounting these files would instead make a logout shared between both.

sync_from_host() {
    local src=$1
    local dst=$2
    local mode=${3:-600}
    if [ -f "$src" ]; then
        rm -f "$dst"
        cp "$src" "$dst"
        chmod "$mode" "$dst"
    fi
}

sync_from_host \
    /host/.claude/.credentials.json /home/node/.claude/.credentials.json
sync_from_host \
    /host/.claude/.claude.json /home/node/.claude/.claude.json 644

# These config files are COPIED from the host, not bind-mounted. We tried
# bind-mounting them as single files and it didn't work. On Docker Desktop for
# Windows the named volume (ext4) and the host bind mount (9p drvfs) are
# different filesystems. Apps save a config by writing a temp file and renaming
# it over the real one, and that rename fails across filesystems (the "EXDEV" or
# "Device or resource busy" error). So copy the host's version into the named
# volume when the container is created. The container can then rewrite it freely
# until the next rebuild copies the host version again.
sync_from_host /host/.claude/settings.json /home/node/.claude/settings.json 644
sync_from_host /host/.codex/config.toml   /home/node/.codex/config.toml   644

# Seed $HOME/.claude.json from the host, but NOT as a straight copy. That file
# mixes two kinds of state. Some is portable account and onboarding state we
# want to keep: hasCompletedOnboarding, oauthAccount, userID, projects,
# tipsHistory. The rest describes how Claude is installed on the host, and that
# part is never valid here. This image installs Claude with `npm install -g`,
# but the host's `installMethod` (for example "native") makes Claude look for
# ~/.local/bin/claude and fail with
# "claude command not found at /home/node/.local/bin/claude". The fix strips the
# machine-specific fields and forces hasCompletedOnboarding, while handling a
# host file that isn't a JSON object. That logic lives in seed-claude-config.cjs
# so it can be unit-tested and prettier-checked
# (translate-plugin-registries.test.cjs).
node "$SCRIPT_DIR/seed-claude-config.cjs"

# Translate the plugin registry paths (Claude + Cursor). Both write absolute,
# OS-native install paths into their plugin registry JSONs —
# `C:\Users\X\.claude\plugins\...` on Windows, `/Users/X/.cursor/plugins/...`
# on macOS. That means the host versions can't be bind-mounted into the Linux
# container, because the CLI can't resolve a Windows path under Linux and fails
# with `cache-miss`. The translation rewrites those paths. It uses a regex, a
# deep rewrite, and the REGISTRIES table, all in translate-plugin-registries.cjs
# so it can be unit-tested and prettier-checked. Codex needs no translation. Its
# enablement registry is config.toml, and that holds git URLs rather than
# filesystem paths, so its whole plugins/ dir is bind-mounted instead.
node "$SCRIPT_DIR/translate-plugin-registries.cjs"

# Codex auth. Some hosts store credentials in the OS keyring instead of on disk
# (`cli_auth_credentials_store = "keyring"`, the default on macOS). Those hosts
# have no auth.json file, so the copy below quietly does nothing. In that case,
# log in inside the container with `codex login --device-auth`.
sync_from_host \
    /host/.codex/auth.json /home/node/.codex/auth.json

# Cursor CLI. Its cli-config.json holds both auth and settings in one file.
# Cursor has known upstream problems authenticating inside Docker, even when the
# config is copied correctly. If `cursor-agent` reports auth errors after the
# copy, run `cursor-agent login` again inside the container. mcp.json (Cursor's
# MCP server config) is also a single file, so it is copied on create rather
# than bind-mounted, for the same EXDEV reason as above. hooks.json is left out
# on purpose. Cursor hooks run shell commands, and sharing the host's hooks
# would widen the supply-chain attack surface inside the container. Copy it in
# yourself if you want the host's hooks in the container.
sync_from_host \
    /host/.cursor/cli-config.json /home/node/.cursor/cli-config.json
sync_from_host \
    /host/.cursor/mcp.json /home/node/.cursor/mcp.json 644

echo "[post-create] done"
