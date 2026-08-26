/**
 * Child process for the cross-process group sync-lock tests (R9). Holds the
 * REAL `withGroupSyncLock` on GROUP_DIR so the parent's `syncGroup` contends
 * with a genuinely separate process — the only way to observe the property this
 * lock exists for. An in-process mock cannot: the socket backend's exclusion is
 * a kernel binding, and the file backend's is an O_EXCL create.
 *
 * Env:
 *   GROUP_LOCK_MODULE  file:// URL or path of the group-lock module to import.
 *   GROUP_DIR          the group directory to lock.
 *   MARKER             written (with our pid) once the lock is HELD.
 *   HOLD_MS            how long to hold before releasing. 0/unset = hold until
 *                      killed (used by the holder-death and no-contention cases).
 *   CONTRACTS          optional: path to write just before releasing, standing in
 *                      for the first sync's persist. Written LAST on purpose — if
 *                      the lock were absent the waiting sync would have written
 *                      first and this would overwrite it, which is exactly the
 *                      lost update the test hunts.
 *   RELEASED           optional: path stamped with Date.now() just before release.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// On Windows `import('C:\\…')` throws ERR_UNSUPPORTED_ESM_URL_SCHEME (a bare
// drive path reads as a URL scheme), so address the module as a file:// URL.
const spec = process.env.GROUP_LOCK_MODULE.startsWith('file:')
  ? process.env.GROUP_LOCK_MODULE
  : pathToFileURL(process.env.GROUP_LOCK_MODULE).href;
const { withGroupSyncLock } = await import(spec);

const holdMs = Number(process.env.HOLD_MS ?? 0);
// Nothing else keeps this process alive: the socket backend's server is unref'd
// and the file backend holds no open handle.
const keepalive = setInterval(() => {}, 1000);

await withGroupSyncLock(process.env.GROUP_DIR, async () => {
  writeFileSync(process.env.MARKER, String(process.pid));
  if (holdMs <= 0) {
    await new Promise(() => {}); // hold until the parent kills us
    return;
  }
  await new Promise((r) => setTimeout(r, holdMs));
  if (process.env.CONTRACTS) {
    writeFileSync(
      process.env.CONTRACTS,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        writtenBy: 'child',
        contracts: [],
        crossLinks: [],
        repoSnapshots: {},
        missingRepos: [],
        unreadableRepos: [],
      }),
    );
  }
  if (process.env.RELEASED) writeFileSync(process.env.RELEASED, String(Date.now()));
});

clearInterval(keepalive);
process.exit(0);
