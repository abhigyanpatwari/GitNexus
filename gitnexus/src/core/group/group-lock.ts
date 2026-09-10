/**
 * Cross-process single-writer lock for one group's persisted state (R9).
 *
 * A group sync ends by REPLACING `contracts.json` and rebuilding `bridge.lbug`
 * from a snapshot it computed minutes earlier. Two syncs of the same group that
 * overlap therefore do not merge — the second one's write simply overwrites the
 * first one's, and whichever finishes last wins with a registry assembled from
 * repo state the other run never saw. Nothing detects it afterwards: both runs
 * report success, and the group's contracts silently describe a mixture that was
 * never true at any instant. This module serializes that section so one sync at
 * a time can be inside it.
 *
 * WHERE THE LOCK LIVES. On a dedicated `sync-lock` directory INSIDE the group
 * directory — mirroring `withRegistryLock`, which locks a `registry-lock`
 * directory beside the registry rather than the registry's own directory
 * (repo-manager.ts). {@link acquireIndexLock} is NOT reentrant and its file
 * backend writes `analyze.lock` into the directory it is handed, so pointing it
 * at a directory that some other code path might also lock — or that already
 * holds a per-repo index slot — reintroduces exactly the collision the registry
 * lock's own comment warns about. `<groupDir>/sync-lock` is a namespace nothing
 * else claims: group directories live under `~/.gitnexus/groups/<name>` (or
 * `$GITNEXUS_HOME`), never under a repo's `.gitnexus[/branches/<slug>]`.
 *
 * WHY IT FAILS CLOSED, like the registry lock. `withRegistryLock` also
 * refuses to continue unlocked on timeout: a lost registry update can drop a
 * concurrent registration. A group sync still fails closed for additional
 * reasons — it is long, expensive, operator-initiated, and a lost update
 * destroys contracts rather than a registry field.
 * A sync that cannot be protected must not run at all, and there are three
 * distinct ways it can fail to be protected; all three throw
 * {@link GroupSyncLockError}:
 *
 *   1. TIMEOUT — the holder is still alive when the ceiling elapses.
 *   2. LOCK-FREE DEGRADATION — `acquireIndexLock` answers a read-only or
 *      permission-denied filesystem with a no-op handle that is byte-identical
 *      to a real one at the API boundary. That is a deliberate tolerance for
 *      `analyze` (an unwritable index dir rejects every write anyway, so the
 *      lock is moot), but here it would hand back a handle that protects
 *      nothing while the sync went on to attempt its writes. The handle now
 *      carries {@link IndexLockHandle.lockFree}, so we can see it and refuse.
 *   3. ANY OTHER ACQUIRE FAILURE — e.g. `sync-lock` cannot be created because a
 *      regular file already occupies the path. Silently proceeding on an error
 *      we did not anticipate is the same unprotected run under another name.
 *
 * WHY THE CEILING IS PASSED EXPLICITLY. The magnitude is not the point — 10
 * minutes deliberately matches `acquireIndexLock`'s own default, because a group
 * sync is analyze-shaped and a legitimately queued second sync must be able to
 * wait out a full first one (the registry lock's 5s is sized for a sub-second
 * merge and is the wrong model here). The reason to pass it is
 * `resolveTimeoutMs`: it prefers an explicit argument over
 * `GITNEXUS_INDEX_LOCK_TIMEOUT_MS`, and that variable's `<= 0` case resolves to
 * `Number.POSITIVE_INFINITY`. Inheriting it would let an environment turn this
 * lock's fail-closed timeout into an unbounded hang.
 *
 * ACQUIRED EXACTLY ONCE, by `syncGroup`, around its whole persist section.
 * Nothing it calls beneath that point — `writeContractRegistry`,
 * `refreshPreservedBridgeMeta`, `writeBridgeUnlocked` — takes this lock; a
 * second acquisition would deadlock a non-reentrant primitive on the HAPPY
 * path, not on some edge case. `bridge-db.ts` exports the swap in both forms
 * for exactly that reason: `writeBridgeUnlocked` for the held-lock caller
 * (`syncGroup`), and the `writeBridge` wrapper, which acquires here, for direct
 * callers that are outside the region. The same split `repo-manager.ts` uses
 * for `registerRepoUnlocked` / `registerRepo`.
 *
 * SCOPE CAVEAT (recorded, not solved): the default socket backend uses Linux
 * abstract sockets, which are network-namespace-scoped. Two containers that
 * share a bind-mounted group directory but sit in separate netns will NOT
 * contend, exactly as documented for the index lock itself; forcing
 * `GITNEXUS_INDEX_LOCK_BACKEND=file` is what covers that deployment.
 */
import path from 'node:path';
import {
  acquireIndexLock,
  IndexLockTimeoutError,
  type IndexLockHandle,
} from '../../storage/index-lock.js';
import { logger } from '../logger.js';

/** Lock-directory name inside the group directory. Never the group dir itself. */
export const GROUP_SYNC_LOCK_DIRNAME = 'sync-lock';

/** The dedicated lock namespace for one group: `<groupDir>/sync-lock`. */
export const getGroupSyncLockDir = (groupDir: string): string =>
  path.join(groupDir, GROUP_SYNC_LOCK_DIRNAME);

/**
 * Wait ceiling for the group sync lock (10 min). See the module header: the
 * magnitude matches `acquireIndexLock`'s analyze-sized default on purpose; the
 * reason it is passed EXPLICITLY is to keep `GITNEXUS_INDEX_LOCK_TIMEOUT_MS`
 * (whose `<= 0` case means unbounded) from turning fail-closed into a hang.
 */
export const GROUP_SYNC_LOCK_TIMEOUT_MS = 600_000;

/** Which of the three fail-closed exits produced a {@link GroupSyncLockError}. */
export type GroupSyncLockFailure = 'timeout' | 'lock-free' | 'unavailable';

/**
 * A group sync could not be protected, so it did not run. One class for all
 * three exits so both callers — the CLI command and the MCP service — have a
 * single thing to catch and report.
 */
export class GroupSyncLockError extends Error {
  readonly reason: GroupSyncLockFailure;
  readonly groupDir: string;
  constructor(reason: GroupSyncLockFailure, groupDir: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GroupSyncLockError';
    this.reason = reason;
    this.groupDir = groupDir;
  }
}

/**
 * Run `operation` as the only group sync touching `groupDir`, or throw
 * {@link GroupSyncLockError} without running it at all.
 *
 * The lock is released in a `finally`, so it is dropped whether the operation
 * succeeds or throws.
 */
export const withGroupSyncLock = async <T>(
  groupDir: string,
  operation: () => Promise<T>,
): Promise<T> => {
  let handle: IndexLockHandle;
  // The wrapper times the acquisition itself. `IndexLockTimeoutError` carries
  // `holder` and `holderKnown` and nothing else — the elapsed wait exists only
  // inside its inherited message string, so the figure has to be measured here
  // to be reported without that message. `Date.now()` matches how the primitive
  // measures its own wait.
  const acquireStartedAt = Date.now();
  try {
    handle = await acquireIndexLock(getGroupSyncLockDir(groupDir), {
      timeoutMs: GROUP_SYNC_LOCK_TIMEOUT_MS,
      // `acquireIndexLock`'s own `log` texts name an "analyze" holder, which
      // misattributes a group-sync wait — the same reason `withRegistryLock`
      // supplies its own line instead of passing `log` through.
      onWaitStart: () =>
        logger.info(
          { groupDir },
          'Waiting for another GitNexus process to finish syncing this group…',
        ),
    });
  } catch (err) {
    // The inherited message names "another gitnexus analyze" as the holder —
    // a cause this detection path cannot establish. Nothing but a group sync
    // ever locks `<groupDir>/sync-lock` (see the module header), and on the
    // socket backend the holder is not identifiable at all. Re-word it around
    // what IS known: which group, which operation, and how long we waited.
    if (err instanceof IndexLockTimeoutError) {
      throw new GroupSyncLockError(
        'timeout',
        groupDir,
        `Timed out after ${Date.now() - acquireStartedAt}ms waiting for the sync lock on ` +
          `group "${path.basename(groupDir)}" (${getGroupSyncLockDir(groupDir)}). ` +
          // `holderKnown` is false on the socket backend and on the file
          // backend's malformed/vanished-lock timeouts, where `holder` is a
          // placeholder (`pid -1`). Presenting that as a real owner would be the
          // same unestablished claim in a new form.
          (err.holderKnown
            ? `Held by pid ${err.holder.pid} on ${err.holder.hostname} ` +
              `(invocation ${err.holder.invocationId}). `
            : `The lock stayed held for the whole wait, but this lock backend ` +
              `cannot identify the holder. `) +
          `Nothing was written and this group was not synced. ` +
          `Re-run once the other sync of this group has finished.`,
        err,
      );
    }
    throw new GroupSyncLockError(
      'unavailable',
      groupDir,
      `Could not acquire the sync lock for this group (${getGroupSyncLockDir(groupDir)}): ` +
        `${err instanceof Error ? err.message : String(err)}. Nothing was written.`,
      err,
    );
  }

  if (handle.lockFree) {
    // A handle that owns nothing. Release it anyway (it is a no-op, but the
    // contract is that every handle is released) and refuse to run: this sync
    // would otherwise write `contracts.json` and `bridge.lbug` with no
    // protection at all against a concurrent sync doing the same.
    handle.release();
    throw new GroupSyncLockError(
      'lock-free',
      groupDir,
      `The sync lock for this group could not be created at ` +
        `${getGroupSyncLockDir(groupDir)} (read-only or permission-denied filesystem), ` +
        `so this sync cannot be protected against a concurrent one. Nothing was written. ` +
        `Make the group directory writable and re-run.`,
      undefined,
    );
  }

  try {
    return await operation();
  } finally {
    handle.release();
  }
};
