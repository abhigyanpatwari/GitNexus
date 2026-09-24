const fs = require('fs');
const path = require('path');

const HOOK_LOCK_SUBDIR = '.hook-locks';
const HOOK_LOCK_MAX_INFLIGHT = 3;
const HOOK_LOCK_STALE_MS = 30000;

// An evictor's claim marker older than this belongs to a crashed evictor.
// The critical section it guards is two syscalls (lstat + unlink), so any
// live evictor finishes orders of magnitude sooner; kept well under
// HOOK_LOCK_STALE_MS so an orphan never blocks a slot for long.
const HOOK_LOCK_EVICT_MARKER_STALE_MS = 5000;

// Same file iff inode identity AND content metadata match. dev+ino alone is
// not enough: filesystems reuse a freed inode number immediately (ext4), so a
// slot recreated after an unlink can carry the stale file's ino. bigint stats
// keep Windows' 64-bit file ids exact.
function sameSlotFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

// Evict a slot judged stale from the `inspected` stat. A slot file is only
// ever deleted, never moved, and only while holding the per-slot
// `<slot>.evicting` marker (created O_EXCL), so two evictors cannot both
// delete: the loser leaves the slot alone and the caller's loop re-inspects
// it or moves on. Under the marker the slot is re-stat'd and deleted only if
// it is still the exact file inspected; identical dev/ino/size/mtimeNs means
// its content and age are unchanged, so the stale verdict still holds. A
// contender that recreated the slot since inspection fails the check and
// its lock stands.
//
// Residual races: (1) a marker older than HOOK_LOCK_EVICT_MARKER_STALE_MS is
// broken as a crashed evictor's orphan; if that evictor was instead stalled
// for seconds between its identity check and its unlink, both could act.
// Each still re-verifies identity immediately before its unlink, so the
// exposure is only that stall. (2) Between the identity check and the unlink
// (two adjacent syscalls), a live owner past HOOK_LOCK_STALE_MS could release
// and a new contender recreate the slot. Neither leaves state behind: a crash
// at any point orphans at most the marker, which expires on its own.
function evictStaleSlot(slotPath, inspected) {
  const marker = `${slotPath}.evicting`;
  try {
    const markerStat = fs.statSync(marker);
    if (Date.now() - markerStat.mtimeMs > HOOK_LOCK_EVICT_MARKER_STALE_MS) {
      fs.unlinkSync(marker);
    }
  } catch {
    /* no marker, or another contender already cleared it */
  }
  try {
    fs.writeFileSync(marker, String(process.pid), { flag: 'wx' });
  } catch {
    return; // Another evictor holds this slot — leave it to that evictor.
  }
  try {
    if (sameSlotFile(fs.lstatSync(slotPath, { bigint: true }), inspected)) {
      fs.unlinkSync(slotPath);
    }
  } catch {
    /* slot already gone — the retry claims it */
  } finally {
    try {
      fs.unlinkSync(marker);
    } catch {
      /* already gone */
    }
  }
}

function acquireHookSlot(gitNexusDir) {
  const lockDir = path.join(gitNexusDir, HOOK_LOCK_SUBDIR);
  try {
    fs.mkdirSync(lockDir, { recursive: true });
  } catch {
    // Cannot create lock dir (read-only fs, cross-user perm denial, out of
    // inodes, etc.) — fail closed by returning null. Caller skips augment.
    // Fail-open here would let N concurrent hooks all proceed unguarded and
    // reintroduce the #1486 fan-out the guard exists to prevent.
    return null;
  }

  const myPidStr = String(process.pid);

  for (let slot = 0; slot < HOOK_LOCK_MAX_INFLIGHT; slot++) {
    const slotPath = path.join(lockDir, `slot-${slot}.lock`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(slotPath, myPidStr, { flag: 'wx' });
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          try {
            // Only unlink if we still own the slot. If we appeared stale and
            // another hook took over, the file now belongs to it — leave alone.
            const content = fs.readFileSync(slotPath, 'utf-8').trim();
            if (content === myPidStr) fs.unlinkSync(slotPath);
          } catch {
            /* already removed or unreadable */
          }
        };
        process.on('exit', release);
        return release;
      } catch {
        // Slot exists. Decide whether to take it over.
        // Open once and inspect mtime + content via the same fd so there's
        // no TOCTOU between the metadata check and the content read
        // (codeql js/file-system-race).
        let fd;
        try {
          fd = fs.openSync(slotPath, 'r');
        } catch {
          continue; // Vanished between EEXIST and open — retry this slot.
        }
        let isLive = false;
        let mtimeMs = Date.now();
        let inspected = null;
        try {
          inspected = fs.fstatSync(fd, { bigint: true });
          mtimeMs = Number(inspected.mtimeMs);
          const buf = Buffer.alloc(32);
          const n = fs.readSync(fd, buf, 0, 32, 0);
          const ownerStr = buf.slice(0, n).toString('utf-8').trim();
          if (ownerStr === '') {
            // Owner created the file but hasn't written its PID yet. The
            // wx open+write window is microseconds; give it the benefit
            // of the doubt and treat as live.
            isLive = true;
          } else {
            const owner = Number.parseInt(ownerStr, 10);
            if (Number.isFinite(owner) && owner > 0) {
              try {
                process.kill(owner, 0);
                isLive = true;
              } catch (e) {
                // ESRCH = process gone → treat as dead. EPERM = process exists
                // but owned by another user (cross-user lock dir) → still alive,
                // keep the slot. Anything else: be conservative, assume alive.
                if (e && e.code === 'ESRCH') {
                  isLive = false;
                } else {
                  isLive = true;
                }
              }
            }
          }
        } catch {
          /* unreadable — treat as dead */
        } finally {
          try {
            fs.closeSync(fd);
          } catch {
            /* already closed */
          }
        }
        // For slots younger than HOOK_LOCK_STALE_MS, PID-liveness wins —
        // a slow-but-alive hook is never wrongly evicted. For older slots,
        // age is the final arbiter as a defense against PID reuse on long-
        // abandoned slots. 30s >> the 7s augment timeout, so a healthy run
        // never crosses this threshold.
        if (isLive && Date.now() - mtimeMs > HOOK_LOCK_STALE_MS) {
          isLive = false;
        }
        if (isLive) break; // Try the next slot.
        // No stat means we cannot prove which file we judged stale; leave it
        // (the retry re-inspects it) rather than risk deleting a fresh lock.
        if (inspected) evictStaleSlot(slotPath, inspected);
        // Loop and retry this slot.
      }
    }
  }

  return null;
}

module.exports = {
  HOOK_LOCK_SUBDIR,
  HOOK_LOCK_MAX_INFLIGHT,
  HOOK_LOCK_STALE_MS,
  acquireHookSlot,
};
