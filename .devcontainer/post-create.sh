#!/usr/bin/env bash
# Devcontainer postCreate driver. Runs once after the container is created
# (per devcontainer.json `postCreateCommand`). Workspace dependency
# installation lives in install-deps.sh (`updateContentCommand`) which
# runs BEFORE this script — see the spec lifecycle. This script only
# handles AI CLI credential + identity sync from the host.

set -euo pipefail

echo "[post-create] 1/2: chown AI CLI named-volume mount points"
# Named volumes (~/.claude, ~/.codex, ~/.cursor, /commandhistory,
# ~/.local) inherit ownership from the image's pre-realignment UID at
# first mount. After `updateRemoteUserUID: true` shifts the `node` user,
# these end up owned by the stale UID — writes inside the volume fail.
# install-deps.sh handles the workspace-side chown; this script handles
# the AI CLI side so each lifecycle hook owns its own concern.
sudo chown -R node:node \
    /home/node/.claude \
    /home/node/.codex \
    /home/node/.cursor \
    /home/node/.local \
    /commandhistory

echo "[post-create] 2/2: sync AI CLI credentials + identity from host"
# Defensive cleanup for users upgrading from an earlier devcontainer
# design (Option B) where these paths were symlinks into the read-only
# host stage (e.g. /home/node/.claude/plugins -> /host/.claude/plugins).
# The current RW-bind topology overlays sub-paths but not the parent
# symlink itself, so writes to e.g. /home/node/.claude/plugins/known_marketplaces.json
# would resolve through the stale symlink to a read-only host file and
# EROFS. Drop the symlinks; mkdir -p below recreates them as real
# directories in the named volume.
for p in plugins skills agents memory commands; do
    [ -L "/home/node/.claude/$p" ] && rm "/home/node/.claude/$p"
done
for p in config.toml memories skills; do
    [ -L "/home/node/.codex/$p" ] && rm "/home/node/.codex/$p"
done
mkdir -p /home/node/.claude/plugins

# Plugins, skills, agents, memory, commands, settings.json, $HOME/.claude.json,
# Codex config.toml/memories/skills are all RW bind-mounted directly from
# host in devcontainer.json — they live on host and reads/writes go
# bidirectionally. Nothing for this script to do for those.
#
# What stays per-container (in the named volume) and gets SYNCED from
# host on container-create:
#   - .credentials.json (Claude OAuth tokens)
#   - .claude/.claude.json (Claude identity: userID, oauthAccount,
#     migration tracking — different file from $HOME/.claude.json)
#   - auth.json (Codex)
#   - cli-config.json (Cursor — conflates auth + settings)
#
# Sync semantics: ALWAYS overwrite from host on container-create, so a
# fresh container starts logged in as host's user (if host had creds).
# Container manages its own refresh from there until next rebuild.
# Logging out in container doesn't affect host. Per-container login is
# the design goal; bind-mounting these would make logout shared.

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

# State files that USED to be single-file bind mounts but couldn't be: on
# Docker Desktop Windows the named volume (ext4) and the host bind-mount
# (9p drvfs) are different filesystems, so atomic config writes
# (`tmp -> rename onto target`) trip EXDEV / Device-or-resource-busy.
# Copy host's version into the named volume on container-create; container
# can rewrite freely from there until next rebuild resyncs.
sync_from_host /host/.claude/settings.json /home/node/.claude/settings.json 644
sync_from_host /host/.claude.json         /home/node/.claude.json         644
sync_from_host /host/.codex/config.toml   /home/node/.codex/config.toml   644

# Plugin registry path translation. Claude writes absolute OS-native paths
# into known_marketplaces.json (`installLocation`), installed_plugins.json
# (`installPath`), and plugin-catalog-cache.json — `C:\Users\X\.claude\...`
# on Windows hosts, `/Users/X/.claude/...` on macOS — so the host versions
# can't be bind-mounted into the Linux container (Claude would fail with
# `cache-miss` trying to resolve a Windows path inside Linux). Read host's
# registry files, rewrite every absolute path that ends in
# `/.claude/plugins/<rest>` to `/home/node/.claude/plugins/<rest>`, and
# write the result into the container's named volume.
mkdir -p /home/node/.claude/plugins
node <<'NODE'
const fs = require("fs");
const path = require("path");

const HOST = "/host/.claude/plugins";
const CTR = "/home/node/.claude/plugins";

// Match any absolute path (Windows `C:\Users\…\.claude\plugins\<rest>`
// or POSIX `/Users/…/.claude/plugins/<rest>` or
// `/home/…/.claude/plugins/<rest>`) and translate to the container path.
const rewrite = (s) => {
    if (typeof s !== "string") return s;
    return s.replace(
        /^(?:[A-Za-z]:)?[\\/].*?[\\/]\.claude[\\/]plugins[\\/](.*)$/,
        (_, rest) => `${CTR}/${rest.replace(/\\/g, "/")}`,
    );
};

const rewriteDeep = (obj) => {
    if (Array.isArray(obj)) return obj.map(rewriteDeep);
    if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            out[k] = typeof v === "string" ? rewrite(v) : rewriteDeep(v);
        }
        return out;
    }
    return obj;
};

for (const name of [
    "known_marketplaces.json",
    "installed_plugins.json",
    "plugin-catalog-cache.json",
]) {
    const src = path.join(HOST, name);
    const dst = path.join(CTR, name);
    if (!fs.existsSync(src) || fs.statSync(src).size === 0) continue;
    let data;
    try {
        data = JSON.parse(fs.readFileSync(src, "utf8"));
    } catch {
        continue;
    }
    fs.writeFileSync(dst, JSON.stringify(rewriteDeep(data), null, 2));
}
NODE

# Codex auth. Hosts using OS keyring storage
# (`cli_auth_credentials_store = "keyring"`, default on macOS) have no
# auth.json on disk — the copy silently no-ops and
# `codex login --device-auth` inside the container is the path.
sync_from_host \
    /host/.codex/auth.json /home/node/.codex/auth.json

# Cursor CLI — cli-config.json conflates auth + settings. Cursor has known
# upstream issues authenticating inside Docker even with correctly-copied
# config; if `cursor-agent` reports auth errors after copy, re-run
# `cursor-agent login` inside the container.
sync_from_host \
    /host/.cursor/cli-config.json /home/node/.cursor/cli-config.json

echo "[post-create] done"
