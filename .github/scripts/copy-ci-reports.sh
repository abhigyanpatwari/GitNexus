#!/usr/bin/env bash
# Preserve package paths even when an artifact contains only one package.
# Both directions copy the same allowlist, including on a cross-run restore.
set -euo pipefail
src=$1 dest=$2 mode=$3
files=()
if [[ "$CLI" == true ]]; then
  files+=(gitnexus/coverage/lcov.info)
  if [[ "$mode" == evidence ]]; then
    files+=(gitnexus/test-results.json)
  fi
fi
if [[ "$WEB" == true ]]; then
  files+=(gitnexus-web/coverage/lcov.info)
  if [[ "$mode" == evidence ]]; then files+=(gitnexus-web/web-test-results.json); fi
fi
for file in "${files[@]}"; do
  test -s "$src/$file"
  install -D -m 644 "$src/$file" "$dest/$file"
done
