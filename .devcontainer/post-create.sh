#!/usr/bin/env bash
# Devcontainer postCreate script. It runs once, right after the container is
# created. devcontainer.json wires it up via `postCreateCommand`. Workspace
# dependencies are installed elsewhere, in install-deps.sh (`updateContentCommand`).
# That script runs BEFORE this one — that is the order the devcontainer spec
# defines. This script does one job: sync the AI CLI credentials and identity
# from the host.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[post-create] 1/4: chown AI CLI named-volume mount points"
# Fix ownership on the named volumes (~/.claude, ~/.codex, ~/.cursor,
# /commandhistory). When they first mount, they take the user ID baked into the
# image, before any realignment. Then `updateRemoteUserUID: true` shifts the
# `node` user to a new ID. Now the volumes are owned by the old, stale ID, and
# writes into them fail. (~/.local is a directory in the image, not a volume.
# We chown it too, just to be safe.) install-deps.sh fixes the workspace side.
# This script fixes the AI CLI side, so each lifecycle hook handles its own part.
#
# There are two separate guards here, and they do different things. `-xdev`
# keeps find from descending into other filesystems. The shareable dirs (skills,
# agents, plugins, memory, commands, prompts, rules) are no longer host bind
# mounts — they now live INSIDE the config volume (seeded in step 3/4), so
# `-xdev` correctly walks and chowns them as the container-private volume files
# they are. What `-xdev` still stops at are the SESSION volumes (mount group 6),
# which remain separate filesystems mounted at sub-paths (see below). `-h` tells
# chown to act on a symlink ITSELF instead of following it, so it never lands on
# a target across a filesystem boundary and never aborts on a broken symlink
# under `set -e` (a legacy Option-B symlink could still exist on a carried-over
# volume). For regular files and directories `-h` does nothing extra.
#
# The session volumes (mount group 6: .claude/projects, .codex/sessions,
# .cursor/chats, .cursor/projects) are their OWN filesystems mounted at
# sub-paths, so `-xdev` rooted at the config-volume parent deliberately skips
# them. That is why each one is listed as its own root below: rooted there,
# `-xdev` walks just that volume and chowns its top level, so the CLI's first
# write doesn't hit EACCES on a stale image UID. These are container-private
# volumes, not the host's own files — the read-only /host/.<cli> stages we copy
# from are mounted elsewhere and are never chowned.
DIRS=(
    /home/node/.claude
    /home/node/.claude/projects
    /home/node/.codex
    /home/node/.codex/sessions
    /home/node/.cursor
    /home/node/.cursor/chats
    /home/node/.cursor/projects
    /home/node/.config/gh
    /home/node/.local
    /commandhistory
)
# claude-mem volume: chown it ONLY on first create (its completion sentinel is
# absent). The step-4/4 seed copies the store as the node user, so a populated
# claude-mem volume is already node-owned on every later rebuild — a recursive
# `find` over a multi-GB store (the 7GB+ DB plus the Chroma index) just to
# re-stamp ownership that is already correct would add real latency to every
# rebuild for nothing. On first create the volume is empty, so this chown of the
# bare mount point is trivial and lets the seed write into it.
[ -f /home/node/.claude-mem/.claude-mem-seeded ] || DIRS+=(/home/node/.claude-mem)
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

echo "[post-create] 2/4: sync AI CLI credentials + identity from host"
# Clean up after an older devcontainer design (Option B). Back then these paths
# were symlinks pointing into the read-only host stage
# (e.g. /home/node/.claude/plugins -> /host/.claude/plugins). A write through
# such a symlink would land on a read-only host file and fail. Delete any that
# survive on a carried-over volume. The shareable dirs are now real directories
# in the named volume, seeded from the host in step 3/4 below.
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

# Shareable content (skills, agents, plugins, memory, commands, prompts, rules)
# is NO LONGER bind-mounted. It is COPIED once from the read-only host stage into
# the named volume in step 3/4 below, so a compromised in-container dependency
# can't write through to the host's on-disk CLI setup. This step handles only the
# credentials, identity, and single config files. Those stay per-container in the
# named volume and are COPIED from the host once when the container is created:
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

# gh CLI auth + settings. Same copy-into-volume model as the credentials above:
# hosts.yml holds the GitHub token (mode 600), config.yml holds settings (644).
# Copied from the read-only /host/.config/gh stage into the gh-config named
# volume on create. Because the volume is writable, an in-container
# `gh auth login` / `gh auth refresh` persists across rebuilds; because the
# stage is read-only, nothing flows back to the host. If the host had no login,
# both copies quietly no-op and whatever the container wrote is kept.
sync_from_host /host/.config/gh/hosts.yml  /home/node/.config/gh/hosts.yml
sync_from_host /host/.config/gh/config.yml /home/node/.config/gh/config.yml 644

echo "[post-create] 3/4: seed shareable config dirs from host (first create only)"
# The shareable dirs (Claude skills/agents/memory/commands/plugins; Codex
# plugins/prompts/memories/skills; Cursor rules/commands/agents/skills/plugins)
# used to be read-write host bind mounts, so a write inside the container landed
# directly on the host's files. That exposed the host's on-disk CLI setup: a
# compromised workspace dependency running in the container could drop a malicious
# skill, agent, command, or plugin into the host's folders, which the next HOST
# session would then auto-load. To protect the host, these are no longer bound.
# Instead we COPY them once from the read-only /host/.<cli> stage into the
# per-container named volume, exactly like claude-mem (step 4/4) and the session
# volumes. The container gets its own writable copy and can NEVER write back to
# the host. The container also avoids the old read-only-stage EROFS failure,
# because it writes to its own volume copy, not a read-only mount.
#
# Seed-once, persist: a per-CLI marker file records that the copy has happened.
# On the first container-create the marker is absent, so we copy; on every later
# rebuild the marker is present, so we skip and keep whatever the container has
# accumulated. Host edits made AFTER the first create do NOT reach the container
# until you remove the config volume and rebuild (see README § Rebuild/reset).
seed_shareable() {
    # seed_shareable <cli> <subdir>...: copy each /host/.<cli>/<subdir> into the
    # named volume, once. Skips a subdir the host doesn't have. We use `cp -r`,
    # NOT `cp -a`/`cp -p`: this script runs as the non-root node user, and the
    # host-stage files are owned by a different UID, so trying to preserve
    # ownership would fail with EPERM and abort the run under `set -e` (the same
    # reason sync_from_host uses plain cp). `cp -r` copies contents owned by node
    # — exactly what we want — and preserves symlinks as symlinks (GNU default).
    local cli=$1
    shift
    local marker="/home/node/.$cli/.devcontainer-shareable-seeded"
    [ -f "$marker" ] && return 0
    for sub in "$@"; do
        local src="/host/.$cli/$sub"
        local dst="/home/node/.$cli/$sub"
        [ -d "$src" ] || continue
        mkdir -p "$dst"
        cp -r "$src/." "$dst/"
    done
}

# Decide which plugin registries to translate BEFORE seeding sets the markers.
# We translate only a CLI being seeded this run, so a plugin installed inside the
# container isn't overwritten by the host's registry on a later rebuild. Codex
# has no path-bearing registry (config.toml holds git URLs), so it's never here.
TRANSLATE_CLIS=()
[ -f /home/node/.claude/.devcontainer-shareable-seeded ] || TRANSLATE_CLIS+=(claude)
[ -f /home/node/.cursor/.devcontainer-shareable-seeded ] || TRANSLATE_CLIS+=(cursor)

seed_shareable claude skills agents memory commands plugins/marketplaces plugins/cache
seed_shareable codex plugins prompts memories skills
seed_shareable cursor rules commands agents skills plugins/marketplaces plugins/local

# Translate the path-bearing plugin registries (Claude + Cursor) for the CLIs we
# just seeded. They store absolute, OS-native install paths
# (`C:\Users\X\.claude\plugins\...` on Windows), which the Linux container can't
# resolve — it would fail with `cache-miss`. translate-plugin-registries.cjs
# rewrites those to the container's paths and writes the result into the volume.
if [ "${#TRANSLATE_CLIS[@]}" -gt 0 ]; then
    node "$SCRIPT_DIR/translate-plugin-registries.cjs" "${TRANSLATE_CLIS[@]}"
fi

# Record that each CLI's shareable surface is seeded, so later rebuilds keep the
# container's copy. Touch even when the host had nothing to copy — an empty CLI
# is still "seeded", and we don't want to re-scan the host on every rebuild.
#
# ORDERING INVARIANT — do NOT move these touches earlier (e.g. into
# seed_shareable per-CLI). The markers must be written only AFTER the registry
# translation above, because seed (cache copy) and translate (registry rewrite)
# are logically atomic: a marker set between them would let a later rebuild skip
# translation for an already-seeded CLI, leaving its cache/ in place but its
# registry still pointing at host paths (`cache-miss`). Writing all markers here,
# after translate, means any abort mid-seed leaves NO markers, so the next create
# re-runs the whole seed+translate. The cost is re-copying an already-copied CLI
# on retry; `cp -r` overwrites in place, so that is idempotent and cheap relative
# to a broken plugin registry.
for cli in claude codex cursor; do
    touch "/home/node/.$cli/.devcontainer-shareable-seeded"
done

echo "[post-create] 4/4: seed claude-mem store from host (first create only)"
# claude-mem keeps its memory in $HOME/.claude-mem — a SQLite DB (claude-mem.db
# plus -wal/-shm) and a Chroma vector store (chroma/chroma.sqlite3 + HNSW index
# binaries). It is mounted as a per-container named volume, NOT a host bind:
# pushing a multi-GB SQLite/WAL store over the 9p/virtiofs bind risks unreliable
# fcntl locking and corruption, especially if claude-mem ran on the host and in
# the container against the same files at once (see devcontainer.json).
#
# So seed it ONCE, then let the container own its copy. On every later rebuild
# we skip the copy and keep whatever the container has accumulated since —
# rebuilds never clobber it. The container's memory and the host's diverge from
# this seed point on; that is the deliberate cost of keeping SQLite off a shared
# bind. To re-seed from the host, remove the volume (`docker volume rm
# claude-mem-<id>`) and rebuild.
#
# The skip guard is a COMPLETION SENTINEL (.claude-mem-seeded), NOT the presence
# of claude-mem.db. Keying on the DB file would be a trap: a multi-GB `cp -r` can
# be interrupted (disk full, I/O error) and abort the script under `set -e`,
# leaving a PARTIAL claude-mem.db behind. The next create would then see that
# truncated file and treat the store as "already seeded", sticking the container
# with a corrupt DB forever. With a sentinel touched only AFTER `cp` returns 0,
# an interrupted seed leaves no sentinel; the next create clears the half-copied
# store and retries cleanly. CONSISTENCY: copying a live WAL database is only
# crash-consistent if claude-mem is NOT writing on the host during the copy — do
# not run claude-mem on the host during a first-create or a re-seed rebuild.
#
# `cp -r` (not `cp -a`/`cp -p`) copies the DB together with its -wal/-shm
# sidecars in one pass. We avoid preserving ownership for the same reason as the
# shareable seed above: this runs as the non-root node user against host-owned
# files, so `cp -a` would fail with EPERM and abort under `set -e`. `cp -r`
# leaves the copies owned by node. The host stage is read-only, so this can
# never write back to the host's live DB.
if [ -f /host/.claude-mem/claude-mem.db ] && [ ! -f /home/node/.claude-mem/.claude-mem-seeded ]; then
    echo "[post-create]   seeding ~/.claude-mem from host (one-time copy, may be several GB)"
    # Clear any partial store left by a previously-interrupted seed (mindepth 1
    # so the volume mount point itself is never removed), then copy and only then
    # write the sentinel. A partial store is node-owned (cp runs as node, and
    # step 1 re-chowns the volume whenever the sentinel is absent), so no sudo.
    find /home/node/.claude-mem -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -r /host/.claude-mem/. /home/node/.claude-mem/
    touch /home/node/.claude-mem/.claude-mem-seeded
else
    echo "[post-create]   skipping claude-mem seed (already seeded, or host has no store)"
fi

echo "[post-create] done"
