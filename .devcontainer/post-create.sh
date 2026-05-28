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
for p in plugins prompts memories skills config.toml; do
    [ -L "/home/node/.codex/$p" ] && rm "/home/node/.codex/$p"
done
for p in plugins rules commands agents skills; do
    [ -L "/home/node/.cursor/$p" ] && rm "/home/node/.cursor/$p"
done
mkdir -p /home/node/.claude/plugins /home/node/.cursor/plugins

# Shareable content is RW bind-mounted directly from host in
# devcontainer.json — reads/writes go bidirectionally, nothing for this
# script to do for those:
#   - Claude: plugins/{marketplaces,cache}, skills, agents, memory, commands
#   - Codex:  plugins (whole dir), prompts, memories, skills
#   - Cursor: plugins/{marketplaces,local}, rules, commands, agents, skills
#
# What stays per-container (in the named volume) and gets SYNCED from
# host on container-create:
#   - .credentials.json (Claude OAuth tokens)
#   - .claude/.claude.json (Claude identity: userID, oauthAccount,
#     migration tracking — different file from $HOME/.claude.json)
#   - settings.json (Claude), config.toml (Codex), mcp.json (Cursor) —
#     single config files that can't be bind-mounted (EXDEV on Windows)
#   - auth.json (Codex), cli-config.json (Cursor — conflates auth+settings)
#   - plugins registry JSONs with absolute paths (Claude + Cursor) —
#     translated below
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

# Plugin registry path translation (Claude + Cursor). Both write absolute
# OS-native install paths into their plugin registry JSONs —
# `C:\Users\X\.claude\plugins\...` on Windows, `/Users/X/.cursor/plugins/...`
# on macOS — so the host versions can't be bind-mounted into the Linux
# container (the CLI fails with `cache-miss` resolving a Windows path under
# Linux). For each CLI, read host's registry files, rewrite every absolute
# path ending in `/.<cli>/plugins/<rest>` to
# `/home/node/.<cli>/plugins/<rest>`, and write the result into the named
# volume. (Codex needs no translation — its enablement registry is
# config.toml with git URLs, not filesystem paths, so its whole plugins/
# dir is bind-mounted instead.)
node <<'NODE'
const fs = require("fs");
const path = require("path");

const buildRe = (cliName) =>
    new RegExp(`^(?:[A-Za-z]:)?[\\\\/].*?[\\\\/]\\.${cliName}[\\\\/]plugins[\\\\/](.*)$`);

const rewriteDeep = (obj, re, ctr) => {
    if (Array.isArray(obj)) return obj.map((v) => rewriteDeep(v, re, ctr));
    if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = rewriteDeep(v, re, ctr);
        return out;
    }
    if (typeof obj === "string")
        return obj.replace(re, (_, rest) => `${ctr}/${rest.replace(/\\/g, "/")}`);
    return obj;
};

const REGISTRIES = [
    {
        cli: "claude",
        host: "/host/.claude/plugins",
        ctr: "/home/node/.claude/plugins",
        files: ["known_marketplaces.json", "installed_plugins.json", "plugin-catalog-cache.json"],
    },
    {
        cli: "cursor",
        host: "/host/.cursor/plugins",
        ctr: "/home/node/.cursor/plugins",
        files: ["installed_plugins.json"],
    },
];

for (const reg of REGISTRIES) {
    const re = buildRe(reg.cli);
    fs.mkdirSync(reg.ctr, { recursive: true });
    for (const name of reg.files) {
        const src = path.join(reg.host, name);
        const dst = path.join(reg.ctr, name);
        if (!fs.existsSync(src) || fs.statSync(src).size === 0) continue;
        let data;
        try {
            data = JSON.parse(fs.readFileSync(src, "utf8"));
        } catch {
            continue;
        }
        fs.writeFileSync(dst, JSON.stringify(rewriteDeep(data, re, reg.ctr), null, 2));
    }
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
# `cursor-agent login` inside the container. mcp.json (Cursor's MCP server
# config) is a single file too — copy-on-create, not bind (EXDEV).
# hooks.json is deliberately NOT synced: Cursor hooks run shell commands,
# so sharing them would widen the supply-chain attack surface into the
# container. Add it yourself if you want host hooks inside the container.
sync_from_host \
    /host/.cursor/cli-config.json /home/node/.cursor/cli-config.json
sync_from_host \
    /host/.cursor/mcp.json /home/node/.cursor/mcp.json 644

echo "[post-create] done"
