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
 * Implementation: a promise chain. Each caller installs a fresh unresolved tail,
 * awaits the previous holder's tail, runs, then releases its own in `finally`
 * (so a thrown op never wedges the connection). FIFO and re-entrancy-unsafe by
 * design — a wrapped helper MUST NOT call another wrapped helper.
 */
let tail: Promise<void> = Promise.resolve();

export const withConnLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  const prior = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prior;
  try {
    return await fn();
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
export const __resetConnLockForTests = (): void => {
  tail = Promise.resolve();
};
