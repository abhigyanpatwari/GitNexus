#!/usr/bin/env bash
# Devcontainer updateContentCommand. The Dev Container spec runs this when the
# container is created AND whenever workspace content changes (for example a
# lockfile update). This script installs workspace dependencies only. Syncing AI
# CLI state lives in post-create.sh, which runs once right after this.
#
# Why the split: updateContentCommand re-runs on content changes, but
# postCreateCommand runs only at container-create. Keeping `npm install` here
# means a rebuild after pulling new dependencies refreshes them. The AI CLI
# credential and path-translation work does not re-run each time.

set -euo pipefail
cd /workspace

echo "[install-deps] 1/4: chown workspace node_modules + npm cache mount points"
# The named volumes (workspace/*/node_modules and ~/.npm) are created at first
# mount. They inherit ownership from the image's UID before realignment. Then
# `updateRemoteUserUID: true` shifts the `node` user's UID. Now the volumes are
# owned by the old, stale UID and npm install cannot write to them. So we chown
# again here, after realignment. Running it again later changes nothing.
#
# We use `find -xdev` with `chown -h` (the same idiom as post-create.sh) instead
# of a plain `chown -R`. There are two separate guards. First, `-xdev` stops
# find from descending past each volume's own filesystem, so it won't recurse
# into a host folder mounted underneath. Second, `-h` makes chown change the
# symlink itself instead of following it to its target. Without `-h`, a symlink
# in the tree (one a dependency's postinstall drops, or a dangling
# node_modules/.bin link) would either send the chown onto a target on another
# filesystem, or fail to follow and abort the whole script under `set -e`. For
# regular files and directories `-h` does nothing, so the ownership fix is the
# same. Only change entries with the wrong owner or group: carried-over volumes
# can contain hundreds of thousands of files that already have correct ownership.
for d in /workspace/node_modules \
         /workspace/gitnexus/node_modules \
         /workspace/gitnexus-web/node_modules \
         /workspace/gitnexus-shared/node_modules \
         /home/node/.npm; do
    sudo find "$d" -xdev \( ! -user node -o ! -group node \) -exec chown -h node:node {} +
done

# Reuse the persistent npm cache without waiting for metadata freshness checks.
# Cache misses still use the registry. Keep install lifecycle scripts enabled for
# native addons and prepare builds; audits remain available via `npm audit`.
export npm_config_prefer_offline=true
export npm_config_audit=false
export npm_config_fund=false

echo "[install-deps] 2/4: clear stale .husky/_ runtime cache"
# On Docker Desktop for Windows, the bind-mount permission translation won't let
# the new container's `node` user overwrite a `.husky/_/h` file that an earlier
# container wrote under a different UID. So we delete it. `.husky/_` is a
# gitignored runtime cache, and husky rebuilds it during the root `npm install`.
# Husky upstream has no fix for this UID clash.
rm -rf .husky/_

echo "[install-deps] 3/4: npm install at root, then gitnexus-shared (build required)"
# Install order matters. Root goes first, for lint-staged, husky, and prettier.
# Then gitnexus-shared, which must be built before installing gitnexus-web or
# gitnexus. Both of those depend on it via `file:../gitnexus-shared`.
npm install
cd /workspace/gitnexus-shared
npm install
npm run build

echo "[install-deps] 4/4: npm install gitnexus-web, then gitnexus"
# Install both packages for CLI and UI development. The gitnexus `prepare`
# script compiles the CLI and shared package; the UI is built separately with
# `npm run build` in gitnexus-web (or `npm run build:web` in gitnexus).
cd /workspace/gitnexus-web
npm install
cd /workspace/gitnexus
npm install

echo "[install-deps] done"
