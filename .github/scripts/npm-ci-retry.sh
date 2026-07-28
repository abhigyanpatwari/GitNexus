#!/usr/bin/env bash
# Install a lock-pinned runtime, retrying only what a transient registry fault
# can change. `npm ci` re-creates node_modules from the committed lockfile and
# re-verifies every SHA-512 integrity on each attempt, so a retry can only
# reproduce the identical tree — never a different one. Each attempt is bounded
# so a hung registry cannot eat the job budget the model review needs.
#
# Usage: npm-ci-retry.sh <label> <runtime_dir> <npmrc>
set -euo pipefail

label="${1:?usage: npm-ci-retry.sh <label> <runtime_dir> <npmrc>}"
runtime_dir="${2:?missing runtime dir}"
npmrc="${3:?missing npmrc}"
attempts="${NPM_CI_RETRY_ATTEMPTS:-3}"
attempt_timeout="${NPM_CI_ATTEMPT_TIMEOUT_SECONDS:-600}"

for attempt in $(seq 1 "${attempts}"); do
  if timeout "${attempt_timeout}" npm ci \
    --prefix "${runtime_dir}" \
    --userconfig "${npmrc}" \
    --ignore-scripts=true \
    --audit=false \
    --fund=false \
    --registry=https://registry.npmjs.org/; then
    exit 0
  fi
  status=$?
  if [[ "${attempt}" -ge "${attempts}" ]]; then
    echo "The pinned ${label} install failed after ${attempts} attempts (last exit ${status})." >&2
    exit 1
  fi
  # 124 is `timeout`'s own signal that the attempt was killed, not that npm
  # rejected the lock; both are retried, but the log says which happened.
  if [[ "${status}" -eq 124 ]]; then
    echo "The pinned ${label} install exceeded ${attempt_timeout}s; retrying (${attempt}/${attempts})." >&2
  else
    echo "The pinned ${label} install failed (exit ${status}); retrying (${attempt}/${attempts})." >&2
  fi
  sleep "$((attempt * 5))"
done
