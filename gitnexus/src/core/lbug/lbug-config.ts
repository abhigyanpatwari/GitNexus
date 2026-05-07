import type lbug from '@ladybugdb/core';

/**
 * Shared configuration for `@ladybugdb/core` `Database` construction.
 *
 * Two values changed meaningfully in `@ladybugdb/core` 0.16.0 and need to be
 * pinned explicitly by every caller, otherwise GitNexus regresses:
 *
 * 1. `maxDBSize` defaults to `0`, which the native runtime interprets as
 *    "use the platform's full mmap address space" — typically 8 TB on
 *    64-bit Linux. Constrained environments (CI runners, containers, WSL)
 *    cannot reserve that much address space and crash with
 *    `Buffer manager exception: Mmap for size 8796093022208 failed.`
 *    See LadybugDB upstream JSDoc:
 *    > "introduced temporarily for now to get around with the default 8TB
 *    > mmap address space limit some environment".
 *
 * 2. `enableCompression` flipped its default from `false` (0.15.x) to
 *    `true` (0.16.0). Existing call sites that relied on the positional
 *    default must now pass `false` explicitly to preserve behaviour.
 *
 * Putting both in one shared module guarantees every `new lbug.Database(...)`
 * call site agrees on the same ceiling and behaviour.
 */

/**
 * Upper bound for any single GitNexus LadybugDB file (graph index, group
 * bridge, install scratch, test fixture). 16 GiB is intentionally generous
 * for real-world code graphs (the GitNexus self-index uses < 50 MiB) while
 * remaining far below any 64-bit OS mmap ceiling.
 *
 * Override with the `GITNEXUS_LBUG_MAX_DB_SIZE` environment variable when
 * indexing genuinely huge monorepos. Values are coerced to a positive
 * integer; anything invalid falls back to the default.
 */
export const LBUG_MAX_DB_SIZE: number = (() => {
  const raw = process.env.GITNEXUS_LBUG_MAX_DB_SIZE;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return 16 * 1024 * 1024 * 1024;
})();

/** Matches WAL corruption errors from the LadybugDB engine. */
const WAL_CORRUPTION_RE = /corrupt(ed)?\s+wal|invalid\s+wal\s+record|wal.*corrupt|checksum.*wal/i;

export const WAL_RECOVERY_SUGGESTION =
  'WAL corruption detected. Run `gitnexus analyze` to rebuild the index.';

export function isWalCorruptionError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return WAL_CORRUPTION_RE.test(msg);
}

type LbugModule = typeof lbug;

export interface LbugDatabaseOptions {
  readOnly?: boolean;
  throwOnWalReplayFailure?: boolean;
}

export interface LbugConnectionHandle {
  db: lbug.Database;
  conn: lbug.Connection;
}

export function createLbugDatabase(
  lbugModule: LbugModule,
  databasePath: string,
  options: LbugDatabaseOptions = {},
): lbug.Database {
  // .d.ts declares fewer args than the native constructor accepts.
  return new (lbugModule.Database as any)(
    databasePath,
    0, // bufferManagerSize
    false, // enableCompression (pinned for v0.16.0)
    options.readOnly ?? false,
    LBUG_MAX_DB_SIZE,
    true, // autoCheckpoint
    -1, // checkpointThreshold
    options.throwOnWalReplayFailure ?? true,
    true, // enableChecksums
  ) as lbug.Database;
}

export async function openLbugConnection(
  lbugModule: LbugModule,
  databasePath: string,
  options: LbugDatabaseOptions = {},
): Promise<LbugConnectionHandle> {
  let db: lbug.Database | undefined;
  try {
    db = createLbugDatabase(lbugModule, databasePath, options);
    return { db, conn: new lbugModule.Connection(db) };
  } catch (err) {
    if (db) await db.close().catch(() => {});
    throw err;
  }
}

export async function closeLbugConnection(handle: LbugConnectionHandle): Promise<void> {
  await handle.conn.close().catch(() => {});
  await handle.db.close().catch(() => {});
}
