/**
 * Integration test for issue #2338 (LadybugDB PR #605 validation, plan U4):
 * directly exercises the `TransactionManager` lock-order-inversion deadlock
 * between a `commit()`-triggered auto-checkpoint and a concurrent
 * `beginAutoTransaction()` — the race #605 fixes — under a shape close to
 * GitNexus's real concurrent-writer load.
 *
 * Deliberately bypasses `conn-lock.ts`/`lbug-adapter.ts`: this test opens its
 * own `Database` at a fresh temp path and multiple raw `Connection`s directly
 * against `@ladybugdb/core`, so it proves the *native* engine no longer
 * deadlocks — not merely that GitNexus's app-level serialization hides the
 * problem. Production still routes every write through the single serialized
 * connection (see `conn-lock.ts`); this test does not change that.
 *
 * Empirical grounding (see plan docs/plans/2026-07-01-001-...):
 *  - A pure-writer connection loop, even with a tiny `checkpointThreshold`,
 *    never produced a `.shadow` sidecar in local probing — `.shadow` is a
 *    "non-blocking concurrent checkpoint sidecar" (bridge-db.ts) that only
 *    appears when a checkpoint races a *concurrent reader*. Writers alone
 *    don't force it; this test mixes writer and reader connections.
 *  - LadybugDB enforces "only one write transaction at a time" as an
 *    immediate error (`Only one write transaction...`), not a blocking wait —
 *    so true overlapping write *attempts* (the shape needed to stress the
 *    #605 handoff) require each writer to retry on that specific error.
 *    Zero-delay hammering across 4 concurrent writers instead tripped a
 *    different native guard ("Timeout waiting for active write transactions
 *    to leave the system before checkpointing") by never giving the
 *    checkpoint a gap to find zero active writers. 2 writers with a small
 *    jittered retry delay (validated across 5 consecutive local runs) avoids
 *    that guard while still reliably forcing the checkpoint-vs-reader race.
 *  - This exact test configuration was run against @ladybugdb/core 0.17.1
 *    (pre-#605) as a comparison: 1 of 4 runs hung for the full
 *    DEADLOCK_TIMEOUT_MS and failed — a direct reproduction of the
 *    lock-order-inversion deadlock, consistent with #605's own description
 *    of it as timing-dependent, not deterministic. 9 consecutive runs
 *    against 0.18.0 (post-#605) all passed cleanly (~2.5-4s each). This
 *    comparison is not asserted in CI (a 0.17.1 install isn't part of this
 *    suite going forward) — see the PR description for the full record.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';

const WRITER_COUNT = 2;
const READER_COUNT = 3;
const ROWS_PER_WRITER = 800;

// Small enough to force frequent auto-checkpoints under the write volume
// above (empirically confirmed locally: reliably produces multiple
// checkpoints, including at least one racing a concurrent reader, across 5
// consecutive runs).
const CHECKPOINT_THRESHOLD_BYTES = 32 * 1024;
const MAX_DB_SIZE_BYTES = 512 * 1024 * 1024;

const isOnlyOneWriteTransactionError = (err: unknown): boolean =>
  (err instanceof Error ? err.message : String(err)).includes('Only one write transaction');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * LadybugDB fast-fails a write attempt with "Only one write transaction..."
 * when another connection currently holds the write slot, rather than
 * blocking. Retrying with a small jittered delay is what actually produces
 * overlapping write *attempts* across connections — the shape needed to
 * stress the commit()-vs-beginAutoTransaction() handoff #605 fixes.
 */
async function writeWithRetry(
  conn: InstanceType<typeof import('@ladybugdb/core').Connection>,
  query: string,
  maxAttempts = 500,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await conn.query(query);
      return;
    } catch (err) {
      if (!isOnlyOneWriteTransactionError(err) || attempt === maxAttempts) throw err;
      await sleep(1 + Math.floor(Math.random() * 3));
    }
  }
}

// Bounded timeout so a genuine deadlock fails the test instead of hanging CI
// (mirrors the convention in parse-impl-large-fixture.test.ts). 60s is far
// above the ~2.5s this run takes locally on Linux — deliberately generous
// margin since native LadybugDB operations are slower on Windows CI and this
// test is registered into the Windows-inclusive LBUG_NATIVE group. A timeout
// here is a genuine deadlock regression signal, not routine flake — if
// Windows CI shows this margin is too tight (or too loose to catch a real
// regression promptly), tighten/loosen this constant based on observed
// LBUG_NATIVE run times rather than guessing again.
const DEADLOCK_TIMEOUT_MS = 60_000;

const itLbugMultiwriter = process.platform === 'win32' ? it.skip : it;
// ^ Windows LadybugDB file-lock/handle-release timing (documented elsewhere
// in this suite, e.g. lbug-core-adapter.test.ts) is a distinct, known
// platform quirk from what this test targets. Skipping here mirrors that
// established pattern rather than trying to disentangle the two failure
// modes in one assertion; a Windows-specific pass is tracked as follow-up
// once real LBUG_NATIVE CI timing data is available to size the timeout.

describe('concurrent multi-connection writes do not deadlock (#2338, LadybugDB #605)', () => {
  itLbugMultiwriter(
    'writer + reader connections on one Database complete without deadlock, forcing a real checkpoint-vs-reader race',
    async () => {
      const tmp = await createTempDir('gitnexus-lbug-multiwriter-');
      const dbPath = path.join(tmp.dbPath, 'lbug');

      try {
        const lbug = (await import('@ladybugdb/core')).default;

        // Raw constructor — deliberately not lbug-config.ts's
        // createLbugDatabase, so checkpointThreshold isn't pinned to
        // GitNexus's production default.
        const db = new lbug.Database(
          dbPath,
          0, // bufferManagerSize
          false, // enableCompression
          false, // readOnly
          MAX_DB_SIZE_BYTES,
          true, // autoCheckpoint
          CHECKPOINT_THRESHOLD_BYTES,
          true, // throwOnWalReplayFailure
          true, // enableChecksums
        );

        const setupConn = new lbug.Connection(db);
        await setupConn.query('CREATE NODE TABLE T(id INT64 PRIMARY KEY, val STRING)');
        await setupConn.close();

        const shadowPath = `${dbPath}.shadow`;
        let shadowSeen = false;
        const shadowWatcher = setInterval(() => {
          if (fs.existsSync(shadowPath)) shadowSeen = true;
        }, 5);

        const writers = Array.from({ length: WRITER_COUNT }, () => new lbug.Connection(db));
        const readers = Array.from({ length: READER_COUNT }, () => new lbug.Connection(db));

        const writeLoops = writers.map((conn, writerIdx) =>
          (async () => {
            for (let i = 0; i < ROWS_PER_WRITER; i++) {
              const id = writerIdx * ROWS_PER_WRITER + i;
              await writeWithRetry(conn, `CREATE (:T {id: ${id}, val: '${'x'.repeat(200)}'})`);
            }
          })(),
        );
        const readLoops = readers.map((conn) =>
          (async () => {
            for (let i = 0; i < ROWS_PER_WRITER; i++) {
              const res = await conn.query('MATCH (n:T) RETURN count(n) AS c');
              await res.getAll();
            }
          })(),
        );

        let timeoutHandle: NodeJS.Timeout | undefined;
        const raceResult = await Promise.race([
          Promise.all([...writeLoops, ...readLoops]).then(() => 'completed' as const),
          new Promise<'timeout'>((resolve) => {
            timeoutHandle = setTimeout(() => resolve('timeout'), DEADLOCK_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timeoutHandle);
        clearInterval(shadowWatcher);

        expect(
          raceResult,
          `deadlock suspected — concurrent writers/readers did not complete within ${DEADLOCK_TIMEOUT_MS}ms`,
        ).toBe('completed');

        // The interleaving #605 fixes is checkpoint-vs-concurrent-transaction;
        // if a checkpoint never actually raced a reader, this test could pass
        // without ever exercising that race.
        expect(
          shadowSeen,
          'expected a .shadow checkpoint sidecar to appear during the run — the checkpoint/reader race this test targets was never entered',
        ).toBe(true);

        for (const conn of [...writers, ...readers]) {
          await conn.close();
        }

        const verifyConn = new lbug.Connection(db);
        const countRes = await verifyConn.query('MATCH (n:T) RETURN count(n) AS c');
        const rows = await countRes.getAll();
        await verifyConn.close();

        expect(rows[0].c).toBe(WRITER_COUNT * ROWS_PER_WRITER);

        await db.close();
      } finally {
        await tmp.cleanup();
      }
    },
    DEADLOCK_TIMEOUT_MS + 10_000,
  );
});
