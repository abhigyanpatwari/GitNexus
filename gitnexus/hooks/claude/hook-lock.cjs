const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HOOK_LOCK_SUBDIR = '.hook-locks';
const HOOK_LOCK_MAX_INFLIGHT = 3;
const HOOK_LOCK_STALE_MS = 30000;

// An evictor's claim marker older than this belongs to a crashed evictor.
// The critical section it guards is a few syscalls (token read, lstat,
// unlink), so any live evictor finishes orders of magnitude sooner; kept well
// under HOOK_LOCK_STALE_MS so an orphan never blocks a slot for long.
const HOOK_LOCK_EVICT_MARKER_STALE_MS = 5000;

// Same file iff inode identity AND content metadata match. dev+ino alone is
// not enough: filesystems reuse a freed inode number immediately (ext4), so a
// file recreated after an unlink can carry the old file's ino. bigint stats
// keep Windows' 64-bit file ids exact.
function sameSlotFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

function readMarkerToken(marker) {
  try {
    return fs.readFileSync(marker, 'utf-8');
  } catch {
    return null;
  }
}

// Stat and token of a marker, both taken from one open descriptor so they
// describe the same file (a path stat followed by a path read could straddle
// a replacement). O_NOFOLLOW where the platform has it: a marker is always a
// regular file this module created. Returns null when there is no marker.
function readMarkerSnapshot(marker) {
  let fd;
  try {
    fd = fs.openSync(marker, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    return { stat: fs.fstatSync(fd, { bigint: true }), token: fs.readFileSync(fd, 'utf-8') };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

// Break an evictor's claim marker only if it is an orphan: older than
// HOOK_LOCK_EVICT_MARKER_STALE_MS, and still the exact file (identity and
// owner token) judged old when it is re-checked just before the unlink. A
// marker released and re-created by a new claimant in between is fresh, so
// it fails the check and stays.
function breakOrphanedMarker(marker) {
  const seen = readMarkerSnapshot(marker);
  if (!seen || Date.now() - Number(seen.stat.mtimeMs) <= HOOK_LOCK_EVICT_MARKER_STALE_MS) return;
  const now = readMarkerSnapshot(marker);
  if (!now || !sameSlotFile(now.stat, seen.stat) || now.token !== seen.token) return;
  try {
    fs.unlinkSync(marker);
  } catch {
    /* another contender already cleared it */
  }
}

// Evict a slot judged stale from the `inspected` stat. A slot file is only
// ever deleted, never moved, and only by the evictor holding the per-slot
// `<slot>.evicting` marker, created O_EXCL with a token unique to this call.
// Every destructive step verifies first:
//  - the slot is unlinked only if the marker still carries our token (an
//    evictor stalled long enough for its marker to be broken as an orphan has
//    lost its claim and backs off) and the slot is still the exact file
//    inspected — identical dev/ino/size/mtimeNs means its content and age are
//    unchanged, so the stale verdict still holds, while a slot recreated since
//    inspection fails the check and its lock stands;
//  - our marker is removed only if it still carries our token, so a marker
//    that has passed to another claimant is left alone;
//  - an orphaned marker is broken only if it is still the old file it was
//    judged to be (see breakOrphanedMarker).
//
// Residual windows. POSIX has no conditional unlink, so each check-then-
// unlink pair keeps a gap of two adjacent syscalls:
//  (a) Slot: between the lstat identity check and unlinkSync(slot), a live
//      owner past HOOK_LOCK_STALE_MS could release and a new hook recreate the
//      slot, whose fresh lock would then be deleted. The consequence is at
//      most one extra concurrent augment beyond HOOK_LOCK_MAX_INFLIGHT for
//      that run — the cap is a load guard, and no data or index state
//      depends on it. The victim's release() sees a foreign or missing file
//      and leaves it alone.
//  (b) Marker: between the token re-read and unlinkSync(marker) (ours or an
//      orphan's), the marker could pass to another claimant, whose claim would
//      then be removed. That only re-opens the slot to one more evictor, which
//      still has to pass the slot identity check before deleting anything.
// Both need a stall of seconds landing on that exact syscall pair, and the
// only thing lost is one run's cap accounting, so they are accepted rather
// than traded for heavier machinery. A crash at any point orphans at most the
// marker, which the next contender breaks after it expires.
function evictStaleSlot(slotPath, inspected) {
  const marker = `${slotPath}.evicting`;
  breakOrphanedMarker(marker);
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(marker, token, { flag: 'wx' });
  } catch {
    return; // Another evictor holds this slot — leave it to that evictor.
  }
  try {
    if (
      readMarkerToken(marker) === token &&
      sameSlotFile(fs.lstatSync(slotPath, { bigint: true }), inspected)
    ) {
      fs.unlinkSync(slotPath);
    }
  } catch {
    /* slot already gone — the retry claims it */
  } finally {
    if (readMarkerToken(marker) === token) {
      try {
        fs.unlinkSync(marker);
      } catch {
        /* already gone */
      }
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
