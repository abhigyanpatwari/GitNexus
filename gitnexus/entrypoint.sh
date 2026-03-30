#!/bin/sh
set -e

# Determine if we need --force (empty global registry means indexes exist but aren't registered)
FORCE_FLAG=""
INCREMENTAL_FLAG=""
if [ ! -f "$HOME/.gitnexus/registry.json" ] || [ "$(cat "$HOME/.gitnexus/registry.json" 2>/dev/null)" = "[]" ] || [ "$(cat "$HOME/.gitnexus/registry.json" 2>/dev/null)" = "" ]; then
  FORCE_FLAG="--force"
  echo "Global registry empty — forcing re-index to register repos"
elif [ "${GITNEXUS_INCREMENTAL:-0}" = "1" ]; then
  INCREMENTAL_FLAG="--incremental"
fi

# Index all mounted repositories
for repo in /data/repos/*/; do
  if [ -d "$repo/.git" ]; then
    echo "Indexing repository: $repo"
    gitnexus analyze $FORCE_FLAG $INCREMENTAL_FLAG "$repo" || echo "Warning: Failed to index $repo"
  fi
done

echo "Starting GitNexus eval-server on port 3456..."
cd /data/repos
exec gitnexus eval-server --port 3456
