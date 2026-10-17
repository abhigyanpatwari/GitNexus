#!/usr/bin/env bash
# Devcontainer updateContentCommand. Runs during container creation after
# workspace content is available. Run this script explicitly after pulling
# dependency changes into an already-running container. Syncing AI
# CLI state lives in post-create.sh, which runs once right after this.
#
# Why the split: updateContentCommand handles dependency readiness, while
# postCreateCommand handles AI CLI state. Installation receipts reuse unchanged
# dependency volumes and refresh them when inputs change. The AI CLI
# credential and path-translation work does not re-run each time.

set -euo pipefail
cd /workspace

echo "[install-deps] 1/4: chown workspace node_modules + npm cache mount points"
ownership_start=$SECONDS
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
         /home/node/.npm \
         /home/node/.gitnexus \
         /home/node/.cache/ms-playwright; do
    [ -d "$d" ] || continue
    sudo find "$d" -xdev \( ! -user node -o ! -group node \) -exec chown -h node:node {} +
done
echo "[install-deps] ownership repair: $((SECONDS - ownership_start))s"

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
# The tracked .husky/pre-commit is preserved. Verification below fails setup if
# regeneration was skipped or failed, so this cleanup cannot silently disable it.
# Husky upstream has no fix for this UID clash.
rm -rf .husky/_

echo "[install-deps] 3/4: restore dependencies, verify Husky, and build sources"
node .devcontainer/dependencies.cjs /workspace

echo "[install-deps] 4/4: environment summary"
node .devcontainer/doctor.cjs /workspace

echo "[install-deps] done"
