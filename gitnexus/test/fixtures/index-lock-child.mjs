/**
 * Child process for the cross-process index-lock tests (#2658), using the BUILT
 * module (LOCK_MODULE). Two modes:
 *
 *  - default (HOLD): acquire the lock on LOCK_DIR, write MARKER once held, then
 *    hold until killed. Proves real cross-process exclusion and SIGKILL
 *    kill-recovery against a parent that uses the source module.
 *
 *  - MODE=EXCLUSIVE (SENTINEL set): acquire, then enter a critical section
 *    guarded by an O_EXCL sentinel create — if the sentinel already exists,
 *    another process holds the lock at the same time, which is the exact
 *    single-writer violation the test hunts. Hold briefly, remove the sentinel,
 *    release, exit 0. Exit 3 if the sentinel was already present (overlap).
 *    Used by the multi-reclaimer test where ≥2 children reclaim one dead holder.
 */
import { writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// LOCK_MODULE is an absolute path. On Windows `import('C:\\…')` throws
// ERR_UNSUPPORTED_ESM_URL_SCHEME (a bare drive path is read as a URL scheme), so
// convert to a file:// URL — required on Windows, harmless on POSIX.
const { acquireIndexLock } = await import(pathToFileURL(process.env.LOCK_MODULE).href);

if (process.env.MODE === 'EXCLUSIVE') {
  const lock = await acquireIndexLock(process.env.LOCK_DIR, { timeoutMs: 30_000, pollMs: 25 });
  try {
    // O_EXCL create fails if any other process is simultaneously in its own
    // critical section — that is a broken single-writer invariant.
    let fd;
    try {
      fd = openSync(process.env.SENTINEL, 'wx');
    } catch {
      process.exit(3); // overlap detected: two holders at once
    }
    closeSync(fd);
    // Hold the section briefly so concurrent reclaimers would collide here.
    await new Promise((r) => setTimeout(r, 150));
    unlinkSync(process.env.SENTINEL);
  } finally {
    lock.release();
  }
  process.exit(0);
} else {
  const lock = await acquireIndexLock(process.env.LOCK_DIR, { timeoutMs: 30_000, pollMs: 25 });
  writeFileSync(process.env.MARKER, String(process.pid));
  // Hold the lock until the parent kills us.
  setInterval(() => {}, 1000);
  // Release on a graceful signal (the SIGKILL path in the test never reaches this).
  const release = () => {
    try {
      lock.release();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', release);
  process.on('SIGINT', release);
}
