#!/usr/bin/env bash
# Scope guard — LSP Read-Only Foundation (WI-9, Invariant 8)
#
# Asserts that the current branch (relative to origin/main-afk) has NOT
# modified any file under `gitnexus-web/`. The LSP cycle is supposed to
# be totally isolated to `gitnexus/src/core/ingestion/lsp/` + `cli/{lsp,verify}.ts`
# + the new commands' registrations in `cli/index.ts`. If this script
# exits non-zero, the change scope has leaked into the web app and the
# PR should be reviewed before merging.
#
# Usage:
#   ./gitnexus/scripts/check-scope-guard.sh           # diff vs origin/main-afk
#   BASE_REF=origin/main ./gitnexus/scripts/check-scope-guard.sh
#
# Exit codes:
#   0 — no diff under gitnexus-web/ (gate passes)
#   1 — diff found (gate fails)
#   2 — git error (e.g. base ref not found)
#
# Notes:
#   - We compare against the BASE_REF env var (default `origin/main-afk`).
#     CI can override this to point at any base.
#   - This script is intentionally tiny: no JSON parsing, no jq, no
#     dependency on the analyzer. It runs in <100ms on a clean tree.
#   - Tracked + untracked changes are both surfaced (untracked are rare
#     in this repo but a developer who `git add`ed a file outside the
#     LSP slice should still see the warning).

set -euo pipefail

# Resolve the repo root (one level up from this script's directory).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"

BASE_REF="${BASE_REF:-origin/main-afk}"
TARGET_PATH="${TARGET_PATH:-gitnexus-web/}"

# Verify the base ref exists. `git rev-parse --verify` returns non-zero
# when the ref is missing — we surface that as a clear "you forgot to
# fetch" hint instead of a confusing empty diff.
if ! git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null 2>&1; then
  echo "Scope guard FAILED: base ref '${BASE_REF}' not found." >&2
  echo "  Tip: run \`git fetch origin ${BASE_REF#origin/}\` first, or set BASE_REF." >&2
  exit 2
fi

# `--no-renames` keeps the output stable across runs; renames are
# rare in this slice anyway.
DIFF="$(git diff --no-renames --no-color "${BASE_REF}" -- "${TARGET_PATH}")"

if [[ -n "${DIFF}" ]]; then
  echo "Scope guard FAILED: '${TARGET_PATH}' has changes vs '${BASE_REF}'." >&2
  echo "The LSP read-only foundation cycle must not modify '${TARGET_PATH}'." >&2
  echo "---- diff ----" >&2
  echo "${DIFF}" >&2
  echo "---- end diff ----" >&2
  exit 1
fi

echo "Scope guard OK: '${TARGET_PATH}' is unchanged vs '${BASE_REF}'."
exit 0
