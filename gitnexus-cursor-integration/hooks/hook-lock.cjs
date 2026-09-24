const fs = require('fs');
const path = require('path');

const HOOK_LOCK_SUBDIR = '.hook-locks';
const HOOK_LOCK_MAX_INFLIGHT = 3;
const HOOK_LOCK_STALE_MS = 30000;

// Same file iff inode identity AND content metadata match. dev+ino alone is
// not enough: filesystems reuse a freed inode number immediately (ext4), so a
// slot recreated after an unlink can carry the stale file's ino. bigint stats
// keep Windows' 64-bit file ids exact.
function sameSlotFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

// Evict a slot judged stale from the `inspected` stat. Never unlink `slotPath`
// directly: another contender may have removed and recreated it since the
// inspection, and a path-based unlink would delete that fresh lock. Instead,
// atomically move whatever is at the path aside to a private tombstone,
// re-check it is the file we inspected, and only then delete it. A mismatch
// means we displaced a live owner's fresh lock: put it back with linkSync,
// which fails (EEXIST) rather than overwrite if a third contender claimed the
// empty path in the meantime.
function evictStaleSlot(slotPath, inspected) {
  const tombstone = `${slotPath}.evict-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(slotPath, tombstone);
  } catch {
    return; // Already evicted by another hook — the retry will hit EEXIST.
  }
  let isStale = false;
  try {
    isStale = sameSlotFile(fs.lstatSync(tombstone, { bigint: true }), inspected);
  } catch {
    /* tombstone unreadable — treat as not ours and try to restore it */
  }
  if (!isStale) {
    try {
      fs.linkSync(tombstone, slotPath);
    } catch {
      /* a third contender claimed the path first — its lock stands */
    }
  }
  try {
    fs.unlinkSync(tombstone);
  } catch {
    /* already gone */
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
