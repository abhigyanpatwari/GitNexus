#!/usr/bin/env bash
# Restore the image's standalone Codex package into its mounted config volume.
# Optional paths allow migration tests to use isolated temporary directories.
set -euo pipefail

seed=${1:-/home/node/.local/share/codex-standalone}
standalone=${2:-/home/node/.codex/packages/standalone}
command=${3:-/home/node/.local/bin/codex}

if [ -x "$command" ] && "$command" --version >/dev/null 2>&1; then
    exit 0
fi

echo "[post-create]   restoring standalone Codex into its config volume"
test -d "$seed/releases"
test -L "$seed/current"
mkdir -p "$standalone/releases"
# Copy only packages; credentials, sessions and user configuration stay intact.
# Publish `current` after copying so an interrupted copy can be retried.
cp -r "$seed/releases/." "$standalone/releases/"
if [ -f "$seed/auto-update-version" ]; then
    cp "$seed/auto-update-version" "$standalone/auto-update-version"
fi
ln -sfn "$(readlink "$seed/current")" "$standalone/current"
"$command" --version
