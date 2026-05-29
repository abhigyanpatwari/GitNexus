#!/usr/bin/env bash
# Devcontainer updateContentCommand — runs on container-create AND whenever
# workspace content changes (lockfile updates etc., per the Dev Container
# spec). Handles workspace dependency installation only; AI CLI state sync
# lives in post-create.sh which runs once after this.
#
# Why split out: `updateContentCommand` re-runs on content updates, while
# `postCreateCommand` runs only on container-create. Putting `npm install`
# here means a rebuild after pulling new dependencies refreshes them
# without re-running the AI CLI credential/path-translation work each time.

set -euo pipefail
cd /workspace

echo "[install-deps] 1/4: chown workspace node_modules + npm cache mount points"
# Named volumes (workspace/*/node_modules, ~/.npm) created at first mount
# inherit ownership from the image's pre-realignment UID. After
# `updateRemoteUserUID: true` shifts the `node` user, the volumes end up
# owned by the stale UID — npm install can't write. Re-chown
# post-realignment; idempotent on subsequent runs.
#
# `find -xdev -exec chown -h` (same idiom as post-create.sh) rather than a bare
# `chown -R`. Two distinct guards: `-xdev` bounds find's DESCENT to each
# volume's own filesystem (it won't recurse into a sub-mounted host bind), and
# `-h` makes chown act on a symlink ITSELF rather than dereferencing it. Without
# `-h`, a symlink inside the tree (a dep postinstall dropping one, or a dangling
# node_modules/.bin link) would either redirect the chown onto its cross-fs
# target or abort provisioning under `set -e` with a dereference error. `-h` is
# a no-op for regular files/dirs, so the intended ownership fix is unchanged.
for d in /workspace/node_modules \
         /workspace/gitnexus/node_modules \
         /workspace/gitnexus-web/node_modules \
         /workspace/gitnexus-shared/node_modules \
         /home/node/.npm; do
    sudo find "$d" -xdev -exec chown -h node:node {} +
done

echo "[install-deps] 2/4: clear stale .husky/_ runtime cache"
# Docker Desktop's Windows bind-mount permission translation refuses to
# let the new container's `node` user overwrite a `.husky/_/h` left by a
# prior container with a different effective UID. `.husky/_` is
# gitignored runtime cache; husky regenerates it during the root
# `npm install`. Upstream husky has no fix for this UID-clash case.
rm -rf .husky/_

echo "[install-deps] 3/4: npm install at root, then gitnexus-shared (build required)"
# Install order: root first (lint-staged + husky + prettier), then
# gitnexus-shared (build needed BEFORE gitnexus-web or gitnexus install
# because both consume it via `file:../gitnexus-shared`).
npm install
cd /workspace/gitnexus-shared
npm install
npm run build

echo "[install-deps] 4/4: npm install gitnexus-web, then gitnexus"
# gitnexus-web before gitnexus: gitnexus's `prepare` script runs
# scripts/build.js, which compiles gitnexus-web when the directory is
# present. In the devcontainer the full workspace is bind-mounted, so
# gitnexus-web/ is present at gitnexus install time (not the case in the
# production Dockerfiles, which COPY selectively).
cd /workspace/gitnexus-web
npm install
cd /workspace/gitnexus
npm install

echo "[install-deps] done"
