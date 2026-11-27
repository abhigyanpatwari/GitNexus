#!/usr/bin/env bash
# Preserve package paths even when an artifact contains only one package.
# Both directions copy the same allowlist, including on a cross-run restore.
set -euo pipefail
src=$1 dest=$2 mode=$3
case "$mode" in
  evidence|lcov) ;;
  *) echo "Unknown report mode: $mode" >&2; exit 2 ;;
esac
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
  [[ -s "$src/$file" ]]
  install -D -m 644 "$src/$file" "$dest/$file"
done
