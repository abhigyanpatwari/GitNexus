/**
 * Child process for the cross-process index-lock test (#2658). Acquires the
 * lock on LOCK_DIR using the BUILT module (LOCK_MODULE), writes MARKER once
 * held, then holds until killed. Proves real cross-process exclusion and
 * SIGKILL kill-recovery against a parent that uses the source module.
 */
import { writeFileSync } from 'node:fs';

const { acquireIndexLock } = await import(process.env.LOCK_MODULE);
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
