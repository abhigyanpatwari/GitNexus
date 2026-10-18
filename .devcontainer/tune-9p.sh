#!/usr/bin/env bash
# Best-effort 9p remount, enabled by default. Requires SYS_ADMIN; failures never
# block startup. A successful mount command does not prove msize changed.
set -u

if [ "${WORKSPACE_9P_TUNE:-1}" != "1" ]; then
    exit 0
fi

TARGET_MSIZE="${WORKSPACE_9P_MSIZE:-1048576}"
MOUNTPOINT="${1:-/workspace}"
if ! [[ "$TARGET_MSIZE" =~ ^[1-9][0-9]{0,9}$ ]] || (( TARGET_MSIZE > 2147483647 )); then
    echo "[tune-9p] invalid WORKSPACE_9P_MSIZE; use an integer from 1 to 2147483647"
    exit 0
fi

if ! command -v findmnt >/dev/null 2>&1; then
    echo "[tune-9p] findmnt unavailable; skipping"
    exit 0
fi
# Match the mountpoint itself, not the containing filesystem for an arbitrary
# directory. This avoids attempting a remount of the container root.
fstype=$(findmnt -rn --first-only --mountpoint "$MOUNTPOINT" -o FSTYPE 2>/dev/null || true)
if [ "$fstype" != "9p" ]; then
    echo "[tune-9p] ${MOUNTPOINT} is ${fstype:-unknown}, not 9p; nothing to do"
    exit 0
fi

if ! opts=$(findmnt -rn --first-only --mountpoint "$MOUNTPOINT" -o OPTIONS 2>/dev/null); then
    echo "[tune-9p] cannot read mount options; skipping"
    exit 0
fi
current=""
if [[ ",$opts," =~ ,msize=([1-9][0-9]{0,9}), ]]; then
    current="${BASH_REMATCH[1]}"
fi
echo "[tune-9p] ${MOUNTPOINT} 9p msize=${current:-unknown} (target ${TARGET_MSIZE})"
if [ -n "$current" ] && (( current >= TARGET_MSIZE )); then
    echo "[tune-9p] already at or above target"
    exit 0
fi

if ! command -v sudo >/dev/null 2>&1 || ! command -v timeout >/dev/null 2>&1; then
    echo "[tune-9p] sudo or timeout unavailable; skipping"
    exit 0
fi
if ! timeout --kill-after=1s 5s sudo -n mount -o "remount,msize=${TARGET_MSIZE}" "$MOUNTPOINT"; then
    echo "[tune-9p] remount failed or timed out; SYS_ADMIN may be missing, or the kernel/server rejected it"
    echo "[tune-9p] rebuild the devcontainer to apply its capAdd: [SYS_ADMIN] setting"
    exit 0
fi

newopts=$(findmnt -rn --first-only --mountpoint "$MOUNTPOINT" -o OPTIONS 2>/dev/null || true)
new=""
if [[ ",$newopts," =~ ,msize=([1-9][0-9]{0,9}), ]]; then
    new="${BASH_REMATCH[1]}"
fi
echo "[tune-9p] after remount msize=${new:-unknown}"
if [ -n "$new" ] && (( new >= TARGET_MSIZE )); then
    echo "[tune-9p] verified at or above target"
else
    echo "[tune-9p] remount returned success but no increase to the target was verified; the kernel or server may ignore or limit msize"
fi
exit 0
