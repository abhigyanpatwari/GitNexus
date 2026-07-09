/**
 * Integration test for issue #2338 (LadybugDB/ladybug#605 validation):
 * directly exercises the `TransactionManager` lock-order-inversion deadlock
 * between a `commit()`-triggered auto-checkpoint and a concurrent
 * `beginAutoTransaction()` — the race #605 fixes — under a shape close to
 * GitNexus's real concurrent-writer load.
 *
 * Deliberately bypasses `conn-lock.ts`/`lbug-adapter.ts`'s singleton: this
 * test opens its own `Database` at a fresh temp path and multiple raw
 * `Connection`s directly against `@ladybugdb/core`, so it proves the
 * *native* engine no longer deadlocks — not merely that GitNexus's app-level
 * serialization hides the problem. Production still routes every write
 * through the single serialized connection (see `conn-lock.ts`); this test
 * does not change that. It does reuse `lbug-config.ts`'s `createLbugDatabase`
 * for the constructor call itself, so it stays in sync with any future
 * signature change instead of hand-maintaining a second copy of the
 * positional arg list.
 *
 * Empirical grounding:
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
 *    checkpoint a gap to find zero active writers. 2 writers with a small,
 *    guaranteed non-zero jittered retry delay (1-3ms via `withRetry`'s
 *    `afterMs` override — validated across 12 consecutive local runs) avoids
 *    that guard while still reliably forcing the checkpoint-vs-reader race.
 *    NOTE: `isDbBusyError` (lbug-config.ts) does NOT recognize this specific
 *    "Only one write transaction..." message (its substring list is 'busy'/
 *    'lock'/'already in use') — GitNexus's production write-retry path
 *    (`withLbugDb`) would not retry on it today. Documented as a known gap
 *    in GUARDRAILS.md/RUNBOOK.md; out of scope to fix here since it's a
 *    production-code change beyond this validation test.
 *  - This exact test configuration was run against @ladybugdb/core 0.17.1
 *    (pre-#605) as a comparison: 1 of 4 runs hung for the full
 *    DEADLOCK_TIMEOUT_MS and failed — a direct reproduction of the
 *    lock-order-inversion deadlock, consistent with #605's own description
 *    of it as timing-dependent, not deterministic. 9 consecutive runs
 *    against 0.18.0 (post-#605) all passed cleanly (~2.5-4s each). This
 *    comparison is not asserted in CI (a 0.17.1 install isn't part of this
 *    suite going forward); see commit 91e583a5's message for the full
 *    run-count record.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { withRetry } from 'gitnexus-shared';
import { createTempDir } from '../helpers/test-db.js';
import { createLbugDatabase } from '../../src/core/lbug/lbug-config.js';
import { closeQueryResults } from '../../src/core/lbug/query-result-utils.js';

type LbugDatabase = InstanceType<typeof import('@ladybugdb/core').Database>;
type LbugConnection = InstanceType<typeof import('@ladybugdb/core').Connection>;

const WRITER_COUNT = 2;
const READER_COUNT = 3;
const ROWS_PER_WRITER = 800;

// Small enough to force frequent auto-checkpoints under the write volume
// above (empirically confirmed locally: reliably produces multiple
// checkpoints, including at least one racing a concurrent reader, across 5
// consecutive runs). Set via the same env var `createLbugDatabase` itself
// reads, rather than a raw constructor call, so this test tracks the real
// constructor signature instead of a hand-copied duplicate of it.
const CHECKPOINT_THRESHOLD_BYTES = 32 * 1024;

const isOnlyOneWriteTransactionError = (err: unknown): boolean =>
  (err instanceof Error ? err.message : String(err)).includes('Only one write transaction');

/**
 * LadybugDB fast-fails a write attempt with "Only one write transaction..."
 * when another connection currently holds the write slot, rather than
 * blocking. Retrying with a small jittered delay is what actually produces
 * overlapping write *attempts* across connections — the shape needed to
 * stress the commit()-vs-beginAutoTransaction() handoff #605 fixes. Uses
 * gitnexus-shared's `withRetry` (already the project's general-purpose
 * bounded-retry helper, see `embeddings/hf-env.ts`) instead of a hand-rolled
 * loop.
 */
async function writeWithRetry(
  conn: LbugConnection,
  query: string,
  maxAttempts = 500,
): Promise<void> {
  await withRetry(
    async () => {
      const result = await conn.query(query);
      await closeQueryResults(result);
    },
    {
      maxAttempts,
      baseDelayMs: 1,
      capDelayMs: 3,
      isRetryable: (err) =>
        isOnlyOneWriteTransactionError(err)
          ? { retry: true, afterMs: 1 + Math.floor(Math.random() * 3) }
          : { retry: false },
    },
  );
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

// Unlike lbug-core-adapter.test.ts / lbug-close-handle-release.test.ts /
// lbug-orphan-sidecar-recovery.test.ts, this test never closes and reopens
// the Database mid-test (it opens once, holds connections for the run, and
// closes only in the teardown `finally`) — so their Win32 Error 33
// close-then-reopen lock-lingering quirk does not apply here. Runs on all
// three platforms, matching its LBUG_NATIVE registration in
// cross-platform-tests.ts and vitest.config.ts.

// The native checkpoint/reader race is intentionally timing-sensitive; retry
// once to absorb transient LadybugDB native exceptions while still failing a
// persistent deadlock or correctness regression.
describe(
  'concurrent multi-connection writes do not deadlock (#2338, LadybugDB #605)',
  { retry: 1 },
  () => {
    it(
      'writer + reader connections on one Database complete without deadlock, forcing a real checkpoint-vs-reader race',
      async () => {
        const tmp = await createTempDir('gitnexus-lbug-multiwriter-');
        const dbPath = path.join(tmp.dbPath, 'lbug');
        const previousThreshold = process.env.GITNEXUS_WAL_CHECKPOINT_THRESHOLD;
        process.env.GITNEXUS_WAL_CHECKPOINT_THRESHOLD = String(CHECKPOINT_THRESHOLD_BYTES);

        let db: LbugDatabase | undefined;
        let writers: LbugConnection[] = [];
        let readers: LbugConnection[] = [];
        let timeoutHandle: NodeJS.Timeout | undefined;
        let shadowWatcher: NodeJS.Timeout | undefined;

        try {
          const lbug = (await import('@ladybugdb/core')).default;

          db = createLbugDatabase(lbug, dbPath);
          const dbHandle = db;

          const setupConn = new lbug.Connection(dbHandle);
          const setupResult = await setupConn.query(
            'CREATE NODE TABLE T(id INT64 PRIMARY KEY, val STRING)',
          );
          await closeQueryResults(setupResult);
          await setupConn.close();

          const shadowPath = `${dbPath}.shadow`;
          let shadowSeen = false;
          shadowWatcher = setInterval(() => {
            if (fs.existsSync(shadowPath)) shadowSeen = true;
          }, 5);

          writers = Array.from({ length: WRITER_COUNT }, () => new lbug.Connection(dbHandle));
          readers = Array.from({ length: READER_COUNT }, () => new lbug.Connection(dbHandle));

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
                await closeQueryResults(res);
              }
            })(),
          );

          const raceResult = await Promise.race([
            Promise.all([...writeLoops, ...readLoops]).then(() => 'completed' as const),
            new Promise<'timeout'>((resolve) => {
              timeoutHandle = setTimeout(() => resolve('timeout'), DEADLOCK_TIMEOUT_MS);
            }),
          ]);

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

          const verifyConn = new lbug.Connection(db);
          readers.push(verifyConn); // closed by the outer finally even if the query below throws
          const countRes = await verifyConn.query('MATCH (n:T) RETURN count(n) AS c');
          // `query()` types as QueryResult | QueryResult[] (array only for
          // multi-statement scripts); this is a single statement, so narrow to
          // the single-result case rather than calling `.getAll()` on a type
          // that doesn't declare it.
          const singleCountRes = Array.isArray(countRes) ? countRes[0] : countRes;
          const rows = await singleCountRes.getAll();
          await closeQueryResults(countRes);

          expect(rows[0].c).toBe(WRITER_COUNT * ROWS_PER_WRITER);
        } finally {
          clearTimeout(timeoutHandle);
          clearInterval(shadowWatcher);
          for (const conn of [...writers, ...readers]) {
            await conn.close().catch(() => {});
          }
          await db?.close().catch(() => {});
          if (previousThreshold === undefined) {
            delete process.env.GITNEXUS_WAL_CHECKPOINT_THRESHOLD;
          } else {
            process.env.GITNEXUS_WAL_CHECKPOINT_THRESHOLD = previousThreshold;
          }
          await tmp.cleanup();
        }
      },
      DEADLOCK_TIMEOUT_MS + 10_000,
    );
  },
);
