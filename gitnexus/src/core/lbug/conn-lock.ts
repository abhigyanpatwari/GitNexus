/**
 * Serialize every operation on the shared singleton LadybugDB connection.
 *
 * LadybugDB is single-writer and its `Connection` is NOT safe for concurrent
 * query execution: dispatching two queries on one connection at the same time
 * lets two libuv workers mutate shared native engine state at once, corrupting
 * the heap. This surfaced as `double free or corruption (out)` / SIGSEGV at the
 * end of `analyze --pdg`, where the periodic WAL-checkpoint driver
 * (`wal-checkpoint-driver.ts`) fired `CHECKPOINT` on the same connection a
 * long-running PDG-table COPY was still using. `--pdg` makes those COPYs outlast
 * the driver's 5 s tick, so the overlap (rare without `--pdg`) becomes reliable.
 *
 * Every singleton-`conn` helper in `lbug-adapter.ts` runs its full query +
 * result-drain inside this lock, so the checkpoint driver, the bulk COPY, the
 * embedding writeback, and the PDG edge deletes are mutually exclusive — the
 * property that makes a strictly-serial workload stable.
 *
 * As of v0.18.0, none of LadybugDB's upstream fixes touch this specific risk
 * (concurrent queries on ONE connection) — the closest are a deadlock fix
 * between concurrent *connections* (LadybugDB/ladybug#605) and a narrow
 * database close/destroy-vs-GC race fix (#623), both different scenarios
 * from the one above. This lock's justification is unchanged.
 *
 * Implementation: a promise chain. Each caller installs a fresh unresolved tail,
 * awaits the previous holder's tail, runs, then releases its own in `finally`
 * (so a thrown op never wedges the connection). FIFO and non-reentrant: a wrapped
 * helper MUST NOT call another wrapped helper — the inner call would await its own
 * holder's tail and deadlock. The re-entry guard below catches this and throws
 * instead of hanging. A boolean flag can't do this: a legitimately-queued
 * top-level caller also runs while the lock is held, so only AsyncLocalStorage —
 * which marks the *async context* of the running `fn` — distinguishes a true
 * nested call from normal contention.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

let tail: Promise<void> = Promise.resolve();

// Set (to `true`) only inside a holding `fn`'s async context. A withConnLock call
// that observes it set is a nested/re-entrant call from within a critical section.
const inCriticalSection = new AsyncLocalStorage<true>();

export const withConnLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (inCriticalSection.getStore()) {
    throw new Error(
      'conn-lock re-entry: a withConnLock-wrapped helper called another wrapped ' +
        'helper, which would deadlock the single LadybugDB connection. Run the inner ' +
        'work outside the lock, or inline it. See src/core/lbug/conn-lock.ts.',
    );
  }
  const prior = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prior;
  try {
    return await inCriticalSection.run(true, fn);
  } finally {
    release();
  }
};

/**
 * Test-only: reset the lock chain to a fresh resolved tail. Production code has
 * no reason to call this — a leaked-but-resolved tail is harmless — but unit
 * tests want a clean chain per case.
 *
 * @internal
 */
export const _resetConnLockForTests = (): void => {
  tail = Promise.resolve();
};
