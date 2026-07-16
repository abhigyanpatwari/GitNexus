import fs from 'fs/promises';
import { createReadStream, createWriteStream, constants as fsConstants } from 'fs';
import { createInterface } from 'readline';
import { once } from 'events';
import { finished } from 'stream/promises';
import path from 'path';
import lbug from '@ladybugdb/core';
import { closeQueryResults } from './query-result-utils.js';
import { escapeCypherString } from './cypher-escape.js';
import { withConnLock } from './conn-lock.js';
import { isWalDriverActive } from './wal-driver-state.js';
import { KnowledgeGraph } from '../graph/types.js';
import {
  NODE_TABLES,
  REL_TABLE_NAME,
  SCHEMA_QUERIES,
  EMBEDDING_TABLE_NAME,
  CREATE_VECTOR_INDEX_QUERY,
  STALE_HASH_SENTINEL,
  NodeTableName,
} from './schema.js';
import { streamAllCSVsToDisk, type StreamedCSVResult } from './csv-generator.js';
import type { PdgEmitManifest } from './pdg-emit-sink.js';
import { getNodeLabel as deriveNodeLabel, type WriteStreamFactory } from './rel-pair-routing.js';
import { EMBEDDABLE_LABELS, type CachedEmbedding } from '../embeddings/types.js';
import { extensionManager, type ExtensionEnsureOptions } from './extension-loader.js';
import {
  classifyDeleteAllError,
  closeLbugConnection,
  HANDLE_RELEASE_PROBE_ATTEMPTS,
  HANDLE_RELEASE_PROBE_DELAY_MS,
  isDbBusyError,
  isOpenRetryExhausted,
  isWalCorruptionError,
  openLbugConnection,
  sleep,
  toNativeSafePath,
  resolveNativeSafeStorageDir,
  WAL_RECOVERY_SUGGESTION,
  waitForWindowsHandleRelease,
  type LbugConnectionHandle,
} from './lbug-config.js';
import {
  finalizeLbugSidecarsAfterClose,
  guardWalQuarantine,
  isMissingShadowSidecarError,
  isReadOnlyShadowReplayError,
  lbugLockRemediation,
  preflightLbugSidecars,
  quarantineWalForMissingShadow,
  renameFailureMessage,
  shadowSidecarRecoveryMessage,
} from './sidecar-recovery.js';
import { isVectorExtensionSupportedByPlatform } from '../platform/capabilities.js';

import { logger } from '../logger.js';
// ---------------------------------------------------------------------------
// Relationship CSV splitting — extracted for testability (PR #818)
// ---------------------------------------------------------------------------
// WriteStreamFactory is imported above from rel-pair-routing.ts (its canonical
// home) for splitRelCsvByLabelPair's signature; no external code imports it from
// here, so it is not re-exported.

/** Result of splitting the relationship CSV into per-label-pair files. */
export interface RelCsvSplitResult {
  relHeader: string;
  relsByPairMeta: Map<string, { csvPath: string; rows: number }>;
  pairWriteStreams: Map<string, import('fs').WriteStream>;
  skippedRels: number;
  totalValidRels: number;
}

/**
 * Split a relationship CSV into per-label-pair files on disk.
 *
 * @internal RETAINED AS A DIFFERENTIAL ORACLE. As of #2203 U2, production emit
 * routes relationships to per-pair files directly during the single pass (see
 * RelPairRouter in `rel-pair-routing.ts`), so this function has NO production
 * callers — it is kept ONLY so the byte-identity test in
 * `test/integration/csv-pipeline.test.ts` ("direct per-pair emit matches the
 * split oracle") can diff the direct-emit output against this proven path. Do
 * NOT delete it as dead code without also removing that test and accepting the
 * loss of the byte-identity guard (and likewise `test/unit/rel-csv-split.test.ts`).
 *
 * Streams the CSV line-by-line, routing each relationship to a file named
 * `rel_{fromLabel}_{toLabel}.csv`. Handles backpressure correctly: only one
 * drain listener per stream at a time, and readline resumes only when ALL
 * backpressured streams have drained.
 *
 * @param csvPath       Path to the combined relationship CSV
 * @param csvDir        Directory to write per-pair CSV files
 * @param validTables   Set of valid node table names
 * @param getNodeLabel  Function to extract the label from a node ID
 * @param wsFactory     Optional WriteStream factory (defaults to fs.createWriteStream)
 */
export const splitRelCsvByLabelPair = async (
  csvPath: string,
  csvDir: string,
  validTables: Set<string>,
  getNodeLabel: (id: string) => string,
  wsFactory: WriteStreamFactory = (p) => createWriteStream(p, 'utf-8'),
): Promise<RelCsvSplitResult> => {
  let relHeader = '';
  const relsByPairMeta = new Map<string, { csvPath: string; rows: number }>();
  const pairWriteStreams = new Map<string, import('fs').WriteStream>();
  let skippedRels = 0;
  let totalValidRels = 0;

  const inputStream = createReadStream(csvPath, 'utf-8');
  const rl = createInterface({ input: inputStream, crlfDelay: Infinity });

  // If any pair WriteStream errors (disk full, EMFILE, etc.) or the input
  // stream fails, we need to abort the pending `once(ws, 'drain')` await.
  // An AbortController gives us one signal to cancel all pending waits
  // without a custom state machine.
  const abortOnError = new AbortController();
  let streamError: Error | null = null;
  const markStreamError = (err: Error): void => {
    streamError ??= err;
    abortOnError.abort(err);
  };

  try {
    // `for await (const line of rl)` replaces the old manual
    // on('line')/pause()/resume()/waitingForDrain state machine: readline's
    // async iterator naturally serializes line delivery with our awaits, so
    // at most one ws can be in backpressure at a time and we just await its
    // 'drain' event.
    let isFirst = true;
    for await (const line of rl) {
      if (streamError) throw streamError;
      if (isFirst) {
        relHeader = line;
        isFirst = false;
        continue;
      }
      if (!line.trim()) continue;
      const match = line.match(/"([^"]*)","([^"]*)"/);
      if (!match) {
        skippedRels++;
        continue;
      }
      const fromLabel = getNodeLabel(match[1]);
      const toLabel = getNodeLabel(match[2]);
      if (!validTables.has(fromLabel) || !validTables.has(toLabel)) {
        skippedRels++;
        continue;
      }

      const pairKey = `${fromLabel}|${toLabel}`;
      let ws = pairWriteStreams.get(pairKey);
      if (!ws) {
        const pairCsvPath = path.join(csvDir, `rel_${fromLabel}_${toLabel}.csv`);
        ws = wsFactory(pairCsvPath);
        ws.on('error', markStreamError);
        pairWriteStreams.set(pairKey, ws);
        relsByPairMeta.set(pairKey, { csvPath: pairCsvPath, rows: 0 });
        if (!ws.write(relHeader + '\n')) {
          await once(ws, 'drain', { signal: abortOnError.signal });
        }
      }

      if (!ws.write(line + '\n')) {
        await once(ws, 'drain', { signal: abortOnError.signal });
      }
      relsByPairMeta.get(pairKey)!.rows++;
      totalValidRels++;
    }
    if (streamError) throw streamError;
  } catch (err) {
    // Tear down everything so no fd is left dangling. If the abort was caused
    // by a stream error, rethrow that error (more actionable than AbortError).
    for (const ws of pairWriteStreams.values()) ws.destroy();
    inputStream.destroy();
    throw streamError ?? err;
  } finally {
    // Readline 'close' fires before the underlying fs.ReadStream releases its
    // fd — on Windows that race caused ENOTEMPTY on the parent dir.
    // stream/promises.finished is the stdlib "wait until this stream is fully
    // closed" primitive and handles both success and error paths.
    await finished(inputStream).catch(() => {});
  }

  return { relHeader, relsByPairMeta, pairWriteStreams, skippedRels, totalValidRels };
};

let db: lbug.Database | null = null;
let conn: lbug.Connection | null = null;

// Serialize every operation on the shared singleton `conn`. LadybugDB's
// Connection is single-writer and is NOT safe for concurrent query execution;
// the periodic WAL-checkpoint driver overlapping a long `--pdg` COPY on this
// connection corrupted native state (`double free or corruption`). Each
// singleton-`conn` helper below runs its full query + drain inside withConnLock.
// Invariant: a wrapped helper MUST NOT call another wrapped helper (re-entry
// self-deadlocks); all current holders are leaf-level. `streamQuery` is
// deliberately NOT wrapped — its per-row callback can re-enter the adapter and
// it only runs on the read path where the checkpoint driver is inactive.
// See conn-lock.ts for the full rationale.
//
// The gate that decides whether an op must take withConnLock: only operations on
// the shared singleton `conn` serialize. Per-file / temp connections (distinct
// native objects with no shared engine state) must NOT block on — or be blocked
// by — the singleton's lock. Reads the live `conn` binding at call time (it's
// reassigned only at open/close, never mid-load).
const isSharedSingletonConn = (c: lbug.Connection): boolean => c === conn;

let currentDbPath: string | null = null;
let currentDbReadOnly = false;
let ftsLoaded = false;
let vectorExtensionLoaded = false;
// In-process guard so a repeated createVectorIndex() within one connection
// lifetime skips the DB round-trip (mirrors ensuredFTSIndexes). Reset wherever
// vectorExtensionLoaded resets, so it can never stay true against a swapped or
// closed connection.
let vectorIndexEnsured = false;

/**
 * In-process cache of FTS indexes observed against the current singleton
 * connection. Avoids repeated `CALL CREATE_FTS_INDEX` calls, which can trip
 * native duplicate-index/WAL edge cases. Cleared on re-init and close.
 *
 * Key format: `${tableName}:${indexName}`.
 */
const ensuredFTSIndexes = new Set<string>();

const ftsIndexKey = (tableName: string, indexName: string): string => `${tableName}:${indexName}`;

/**
 * Check if an error indicates a missing column or table (schema-level problem)
 * rather than a transient/connection error. Used for legacy DB fallback logic.
 */
const isMissingColumnOrTableError = (msg: string): boolean =>
  msg.includes('does not exist') ||
  // Kuzu-specific: "(table|column|property) ... not found" — narrow enough to avoid
  // matching transient errors like "connection not found" or "key not found".
  /(table|column|property).*not found/i.test(msg);

/** Expose the current Database for pool adapter reuse in tests. */
export const getDatabase = (): lbug.Database | null => db;

// Global session lock for operations that touch module-level lbug globals.
// This guarantees no DB switch can happen while an operation is running.
let sessionLock: Promise<void> = Promise.resolve();

/** Number of times to retry on a BUSY / lock-held error before giving up. */
const DB_LOCK_RETRY_ATTEMPTS = 3;
/** Base back-off in ms between BUSY retries (multiplied by attempt number). */
const DB_LOCK_RETRY_DELAY_MS = 500;

/**
 * Return true when the error message indicates a write was attempted against
 * a read-only LadybugDB connection. The MCP query pool opens DBs read-only,
 * so any path that calls a `CREATE_*` procedure there will surface this
 * (e.g. defensive `ensureFTSIndex` calls). Owners of the writable analyze
 * path should ignore this error — index creation is owned by `gitnexus
 * analyze` and either already happened or will happen on the next run.
 */
export const isReadOnlyDbError = (err: unknown): boolean => {
  // Walk the `cause` chain (bounded) so a wrapped read-only error — e.g. the
  // pool adapter's `new Error('…read-only.', { cause: nativeReadOnlyErr })` —
  // is still detected by callers that only see the wrapper (#2068 follow-up).
  // The same strict regex is re-applied at each level, so a non-read-only
  // chain stays false; the depth bound guards a cyclic `cause`.
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    const msg = cur instanceof Error ? cur.message : String(cur);
    if (/read-only database/i.test(msg)) return true;
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
};

const isMissingFileError = (err: unknown): boolean => {
  const errno = err as NodeJS.ErrnoException;
  return errno?.code === 'ENOENT';
};

const extractErrnoCode = (err: unknown): string | undefined => {
  const errno = err as NodeJS.ErrnoException;
  return errno?.code;
};

const MAX_LOGGED_ERROR_MESSAGE_LENGTH = 160;

const summarizeError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, MAX_LOGGED_ERROR_MESSAGE_LENGTH);

// ---------------------------------------------------------------------------
// Cross-process init lock
//
// Prevents a TOCTOU race in orphan sidecar cleanup: between checking that
// the main DB file is missing and unlinking sidecars, another process could
// create a fresh DB. The lock file (`${dbPath}.init.lock`) is created with
// O_CREAT | O_EXCL (atomic create-or-fail) and contains the owning PID +
// timestamp so stale locks from crashed processes can be reclaimed.
// ---------------------------------------------------------------------------

/** Maximum age (ms) before an init lock is considered stale. */
const INIT_LOCK_STALE_MS = 30_000;
/** Maximum attempts to acquire the init lock before giving up. */
const INIT_LOCK_MAX_ATTEMPTS = 6;
/** Delay between lock-acquisition retries (ms). */
const INIT_LOCK_RETRY_DELAY_MS = 500;

const initLockPath = (dbPath: string): string => `${dbPath}.init.lock`;

/**
 * Returns true when the process identified by `pid` is still running.
 * Uses `process.kill(pid, 0)` which sends signal 0 (a no-op probe) —
 * it throws ESRCH when the process does not exist.
 */
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Try to break a stale lock whose owning process has exited.
 * Returns `true` if the stale lock was removed (caller should retry acquire).
 * Returns `false` if the lock is still valid (another live process owns it).
 */
const tryBreakStaleLock = async (lockPath: string): Promise<boolean> => {
  try {
    const content = await fs.readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(content) as { pid?: number; ts?: number };

    // If the owning process is still alive AND the lock is not stale, don't break.
    if (typeof parsed.pid === 'number' && isProcessAlive(parsed.pid)) {
      // Even a live process's lock can be stale if it's been held too long
      // (e.g. the process is hung). Check the timestamp.
      if (typeof parsed.ts === 'number' && Date.now() - parsed.ts < INIT_LOCK_STALE_MS) {
        return false;
      }
    }

    // PID is gone or lock exceeded INIT_LOCK_STALE_MS — reclaim it.
    await fs.unlink(lockPath);
    logger.warn(
      `GitNexus: removed stale init lock (pid=${parsed.pid ?? '?'}, age=${typeof parsed.ts === 'number' ? `${Date.now() - parsed.ts}ms` : '?'})`,
    );
    return true;
  } catch (err) {
    // Lock file disappeared between our read and unlink, or is unreadable.
    // Either way, let the caller retry the acquire.
    if (isMissingFileError(err)) return true;
    // Permission error or corrupt content — log and let caller retry.
    const code = extractErrnoCode(err);
    logger.warn(
      `GitNexus: unable to inspect init lock (${code ?? 'UNKNOWN'}): ${summarizeError(err)}`,
    );
    return false;
  }
};

/**
 * Acquire a cross-process init lock for `dbPath`.
 * Uses `O_CREAT | O_EXCL` for atomic create-or-fail semantics.
 *
 * Returns a release function that removes the lock file. The release
 * function is idempotent and safe to call even if the lock was already
 * cleaned up externally.
 *
 * Throws if the lock cannot be acquired after `INIT_LOCK_MAX_ATTEMPTS`.
 */
export const acquireInitLock = async (dbPath: string): Promise<() => Promise<void>> => {
  const lockPath = initLockPath(dbPath);
  const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });

  // Ensure the parent directory exists before creating the lock file.
  // On a fresh repo the `.gitnexus/` directory may not exist yet, and
  // fs.open with O_CREAT | O_EXCL would fail with ENOENT.
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 1; attempt <= INIT_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const handle = await fs.open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      );
      await handle.writeFile(payload);
      await handle.close();

      // Return the idempotent release function
      return async () => {
        try {
          await fs.unlink(lockPath);
        } catch (err) {
          if (!isMissingFileError(err)) {
            const code = extractErrnoCode(err);
            logger.warn(
              `GitNexus: failed to release init lock (${code ?? 'UNKNOWN'}): ${summarizeError(err)}`,
            );
          }
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw err; // Unexpected error — propagate immediately
      }

      // Lock file exists — check if it's stale
      const broken = await tryBreakStaleLock(lockPath);
      if (broken && attempt < INIT_LOCK_MAX_ATTEMPTS) {
        continue; // Stale lock removed — retry immediately
      }

      if (attempt === INIT_LOCK_MAX_ATTEMPTS) {
        throw new Error(
          `GitNexus: unable to acquire init lock after ${INIT_LOCK_MAX_ATTEMPTS} attempts — ` +
            `another gitnexus process may be initializing the same database (${lockPath})`,
        );
      }

      // Live process holds the lock — wait and retry
      await new Promise((resolve) => setTimeout(resolve, INIT_LOCK_RETRY_DELAY_MS));
    }
  }

  // Unreachable — loop always throws or returns
  throw new Error('GitNexus: init lock acquisition failed unexpectedly');
};

/** Exported for testing — returns the lock file path for a given dbPath. */
export const _initLockPathForTest = initLockPath;

const runWithSessionLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = sessionLock;
  let release: (() => void) | null = null;
  sessionLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await operation();
  } finally {
    release?.();
  }
};

const normalizeCopyPath = (filePath: string): string =>
  toNativeSafePath(filePath).replace(/\\/g, '/');

// Single-result convenience wrapper over the shared best-effort closer
// (drainQueryResult / readQueryRows close one cursor at a time).
const closeQueryResult = async (result: lbug.QueryResult): Promise<void> => {
  await closeQueryResults(result);
};

const drainQueryResult = async (
  queryResult: lbug.QueryResult | lbug.QueryResult[],
): Promise<void> => {
  const results = Array.isArray(queryResult) ? queryResult : [queryResult];
  let firstError: unknown;
  let hasError = false;
  for (const result of results) {
    try {
      await result.getAll();
    } catch (err) {
      if (!hasError) {
        firstError = err;
        hasError = true;
      }
    } finally {
      await closeQueryResult(result);
    }
  }
  if (hasError) throw firstError;
};

const readQueryRows = async (
  queryResult: lbug.QueryResult | lbug.QueryResult[],
): Promise<any[]> => {
  const results = Array.isArray(queryResult) ? queryResult : [queryResult];
  let rows: any[] = [];
  let firstError: unknown;
  let hasError = false;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    try {
      const resultRows = await result.getAll();
      if (i === 0) rows = resultRows;
    } catch (err) {
      if (!hasError) {
        firstError = err;
        hasError = true;
      }
    } finally {
      await closeQueryResult(result);
    }
  }
  if (hasError) throw firstError;
  return rows;
};

const queryAndDrain = async (targetConn: lbug.Connection, cypher: string): Promise<void> => {
  const run = async (): Promise<void> => {
    const queryResult = await targetConn.query(cypher);
    await drainQueryResult(queryResult);
  };
  // Serialize only when this runs on the shared singleton connection (the bulk
  // node/relationship COPY captures `writeConn = conn`); per-file / temp
  // connections skip the lock — see isSharedSingletonConn.
  return isSharedSingletonConn(targetConn) ? withConnLock(run) : run();
};

const READ_ONLY_SHADOW_REPLAY_PROBE = 'MATCH (n) RETURN n LIMIT 1';

/**
 * Serve-side entry to the shared WAL-quarantine safety gate. Refuses (throws)
 * when the `.shadow` is present on disk or the orphan WAL is too large to
 * safely discard; returns silently otherwise. The policy itself lives in
 * `guardWalQuarantine` (sidecar-recovery.ts) so serve and the MCP pool share
 * one source of truth (PR #1747 review D2; issue #2382 review, Finding B).
 */
const refuseLargeWalQuarantine = async (
  dbPath: string,
  mode: 'read-only' | 'writable',
  triggeringErr: unknown,
): Promise<void> => {
  await guardWalQuarantine(dbPath, mode, triggeringErr, logger);
};

const reopenReadOnlyAfterMissingShadow = async (
  dbPath: string,
  err: unknown,
): Promise<LbugConnectionHandle> => {
  await refuseLargeWalQuarantine(dbPath, 'read-only', err);
  try {
    await quarantineWalForMissingShadow(dbPath, {
      logger,
      level: 'warn',
      reason: 'read-only recovery',
    });
  } catch (renameErr) {
    throw new Error(renameFailureMessage(dbPath, renameErr));
  }

  const reopened = await openLbugConnection(lbug, dbPath, { readOnly: true });
  try {
    await queryAndDrain(reopened.conn, READ_ONLY_SHADOW_REPLAY_PROBE);
    return reopened;
  } catch (retryErr) {
    await closeLbugConnection(reopened);
    if (isMissingShadowSidecarError(retryErr) || isReadOnlyShadowReplayError(retryErr)) {
      throw new Error(shadowSidecarRecoveryMessage(dbPath, retryErr));
    }
    throw retryErr;
  }
};

const reopenWritableAfterMissingShadow = async (
  dbPath: string,
  err: unknown,
): Promise<LbugConnectionHandle> => {
  await refuseLargeWalQuarantine(dbPath, 'writable', err);
  try {
    await quarantineWalForMissingShadow(dbPath, {
      logger,
      level: 'warn',
      reason: 'writable recovery',
    });
  } catch (renameErr) {
    throw new Error(renameFailureMessage(dbPath, renameErr));
  }

  return await openLbugConnection(lbug, dbPath);
};

const ensureReadOnlyConnectionUsable = async (
  dbPath: string,
  handle: LbugConnectionHandle,
): Promise<LbugConnectionHandle> => {
  let shadowReplayErr: unknown;
  try {
    await queryAndDrain(handle.conn, READ_ONLY_SHADOW_REPLAY_PROBE);
    return handle;
  } catch (err) {
    if (isMissingShadowSidecarError(err)) {
      await closeLbugConnection(handle);
      return await reopenReadOnlyAfterMissingShadow(dbPath, err);
    }
    if (!isReadOnlyShadowReplayError(err)) {
      await closeLbugConnection(handle);
      throw err;
    }
    shadowReplayErr = err;
  }

  await closeLbugConnection(handle);

  let writable: LbugConnectionHandle;
  try {
    writable = await openLbugConnection(lbug, dbPath);
  } catch (openErr) {
    const code = extractErrnoCode(openErr);
    if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        shadowSidecarRecoveryMessage(dbPath, shadowReplayErr) +
          '\n  The workspace appears to be read-only — mount it read-write to perform shadow replay recovery,' +
          ' or re-run `gitnexus analyze` on a writable filesystem to rebuild the index.',
      );
    }
    throw openErr;
  }
  let missingShadowError: unknown;
  try {
    await queryAndDrain(writable.conn, READ_ONLY_SHADOW_REPLAY_PROBE);
  } catch (err) {
    if (isMissingShadowSidecarError(err)) {
      missingShadowError = err;
    } else {
      throw err;
    }
  } finally {
    await closeLbugConnection(writable);
  }
  if (missingShadowError) {
    return await reopenReadOnlyAfterMissingShadow(dbPath, missingShadowError);
  }

  const reopened = await openLbugConnection(lbug, dbPath, { readOnly: true });
  try {
    await queryAndDrain(reopened.conn, READ_ONLY_SHADOW_REPLAY_PROBE);
    return reopened;
  } catch (err) {
    await closeLbugConnection(reopened);
    if (isMissingShadowSidecarError(err)) {
      throw new Error(shadowSidecarRecoveryMessage(dbPath, err));
    }
    throw err;
  }
};

const resetOpenConnectionState = (): void => {
  currentDbPath = null;
  ftsLoaded = false;
  vectorExtensionLoaded = false;
  vectorIndexEnsured = false;
  ensuredFTSIndexes.clear();
};

const runSchemaCreationQueries = async (dbPath: string): Promise<unknown | null> => {
  for (const schemaQuery of SCHEMA_QUERIES) {
    try {
      await queryAndDrain(conn, schemaQuery);
    } catch (err) {
      if (isMissingShadowSidecarError(err)) {
        return err;
      }

      const msg = err instanceof Error ? err.message : String(err);
      // Suppression list:
      //   - "already exists": expected idempotent re-create on existing DBs
      //   - "could not set lock on file": LadybugDB v0.18.0 emits this on
      //     Windows when CREATE NODE TABLE runs against a path that was
      //     just opened (the WAL handle from a fresh Database briefly
      //     contests the table's first-write lock). The table is created
      //     anyway and any genuine cross-process lock contention surfaces
      //     on the next operation via withLbugDb's retry. Logging it here
      //     would just be noise in CI.
      //
      // WAL corruption: the first DDL write after DB open triggers WAL
      // replay — if the WAL file was left in a corrupt state by an
      // interrupted previous run, the native engine throws here. Rather
      // than logging a WARN and continuing in a broken state, close the
      // DB cleanly and surface an actionable error so the caller (serve,
      // MCP, analyze) can exit with a clear recovery message.
      if (isWalCorruptionError(err)) {
        await safeClose();
        resetOpenConnectionState();
        throw new Error(
          `LadybugDB WAL corruption detected at ${dbPath}. ${WAL_RECOVERY_SUGGESTION}\n` +
            `  Original error: ${msg.slice(0, 200)}`,
        );
      }
      if (!msg.includes('already exists') && !isDbBusyError(err) && !isReadOnlyDbError(err)) {
        logger.warn(`⚠️ Schema creation warning: ${msg.slice(0, 120)}`);
      }
    }
  }

  return null;
};

export const initLbug = async (dbPath: string) => {
  return runWithSessionLock(() => ensureLbugInitialized(dbPath));
};

/**
 * Execute multiple queries against one repo DB atomically.
 * While the callback runs, no other request can switch the active DB.
 *
 * Automatically retries up to DB_LOCK_RETRY_ATTEMPTS times when the
 * database is busy (e.g. `gitnexus analyze` holds the write lock).
 * Each retry waits DB_LOCK_RETRY_DELAY_MS * attempt milliseconds.
 */
export const withLbugDb = async <T>(
  dbPath: string,
  operation: () => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> => {
  let lastError: unknown;
  const readOnly = options.readOnly === true;
  for (let attempt = 1; attempt <= DB_LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await runWithSessionLock(async () => {
        await ensureLbugInitialized(dbPath, readOnly);
        return operation();
      });
    } catch (err) {
      lastError = err;
      // Skip outer retry when the inner open-retry already exhausted: the
      // ~1.5s open-time budget was just spent, repeating the full reset+
      // reopen cycle would only add 4-5s of tail latency without changing
      // the outcome (both layers consult the same isDbBusyError matcher).
      if (!isDbBusyError(err) || isOpenRetryExhausted(err) || attempt === DB_LOCK_RETRY_ATTEMPTS) {
        throw err;
      }
      // Close stale connection inside the session lock to prevent race conditions
      // with concurrent operations that might acquire the lock between cleanup steps
      await runWithSessionLock(async () => {
        await safeClose();
        currentDbPath = null;
        ftsLoaded = false;
        vectorExtensionLoaded = false;
        vectorIndexEnsured = false;
        ensuredFTSIndexes.clear();
      });
      // Sleep outside the lock — no need to block others while waiting
      await new Promise((resolve) => setTimeout(resolve, DB_LOCK_RETRY_DELAY_MS * attempt));
    }
  }
  // This line is unreachable — the loop either returns or throws inside,
  // but TypeScript needs an explicit throw to satisfy the return type.
  throw lastError;
};

const ensureLbugInitialized = async (dbPath: string, readOnly: boolean = false) => {
  if (conn && currentDbPath === dbPath && currentDbReadOnly === readOnly) {
    return { db, conn };
  }
  await doInitLbug(dbPath, readOnly);
  return { db, conn };
};

const doInitLbug = async (dbPath: string, readOnly: boolean = false) => {
  // Different database requested — close the old one first
  if (conn || db) {
    await safeClose();
    currentDbPath = null;
    ftsLoaded = false;
    vectorExtensionLoaded = false;
    vectorIndexEnsured = false;
    ensuredFTSIndexes.clear();
  }

  // ---------------------------------------------------------------------------
  // Read-only fast path: skip all filesystem mutations (path cleanup, init
  // lock, orphan sidecar removal, mkdir) so the open succeeds on read-only
  // filesystems such as Docker `:ro` bind mounts. The init lock exists to
  // prevent a TOCTOU race during DB *creation* — read-only opens never
  // create databases and don't need the lock.
  // ---------------------------------------------------------------------------
  if (readOnly) {
    await preflightLbugSidecars(dbPath, {
      mode: 'read-only',
      logger,
      allowQuarantine: false,
    });

    const opened = await openLbugConnection(lbug, dbPath, { readOnly: true });
    const usable = await ensureReadOnlyConnectionUsable(dbPath, opened);
    db = usable.db;
    conn = usable.conn;
    currentDbReadOnly = true;
  } else {
    // LadybugDB stores the database as a single file (not a directory).
    // If the path already exists, it must be a valid LadybugDB database file.
    // Remove stale empty directories or files from older versions.
    try {
      const stat = await fs.lstat(dbPath);
      if (stat.isSymbolicLink()) {
        // Never follow symlinks — just remove the link itself
        await fs.unlink(dbPath);
      } else if (stat.isDirectory()) {
        // Verify path is within expected storage directory before deleting
        const realPath = await fs.realpath(dbPath);
        const parentDir = path.dirname(dbPath);
        const realParent = await fs.realpath(parentDir);
        if (!realPath.startsWith(realParent + path.sep) && realPath !== realParent) {
          throw new Error(
            `Refusing to delete ${dbPath}: resolved path ${realPath} is outside storage directory`,
          );
        }
        // Old-style directory database or empty leftover - remove it
        await fs.rm(dbPath, { recursive: true, force: true });
      }
      // If it's a file, assume it's an existing LadybugDB database - LadybugDB will open it
    } catch (err) {
      if (!isMissingFileError(err)) {
        throw err;
      }
      // Path doesn't exist, which is what LadybugDB wants for a new database
    }

    // -------------------------------------------------------------------------
    // Cross-process critical section: acquire init lock, clean orphan sidecars,
    // and open the database. The lock prevents a TOCTOU race where another
    // process could create a fresh DB between our access() check and the
    // unlink() of stale sidecars.
    // -------------------------------------------------------------------------
    const releaseInitLock = await acquireInitLock(dbPath);
    try {
      // Crash-recovery cleanup: if the main DB file is missing, stale sidecars
      // from an interrupted run can block fresh opens indefinitely.
      try {
        await fs.access(dbPath);
      } catch (err) {
        if (isMissingFileError(err)) {
          // `.shadow` is documented by LadybugDB checkpointing and `.wal.checkpoint`
          // was observed in the #1618 crash loop that motivated this recovery path.
          const orphanSidecars = [`${dbPath}.shadow`, `${dbPath}.wal.checkpoint`];
          for (const sidecar of orphanSidecars) {
            try {
              await fs.unlink(sidecar);
              logger.warn(
                `GitNexus: removed orphan sidecar ${path.basename(sidecar)} (no main DB file present)`,
              );
            } catch (err) {
              if (isMissingFileError(err)) {
                continue;
              }
              const code = extractErrnoCode(err);
              logger.warn(
                `GitNexus: failed to remove orphan sidecar ${path.basename(sidecar)} (${code ?? 'UNKNOWN'}) while main DB file is missing; LadybugDB open may still fail: ${summarizeError(err)}`,
              );
            }
          }
        } else {
          const code = extractErrnoCode(err);
          logger.warn(
            `GitNexus: unable to verify main DB file before orphan sidecar cleanup (${code ?? 'UNKNOWN'}); skipping cleanup: ${summarizeError(err)}`,
          );
        }
      }

      // Ensure parent directory exists
      const parentDir = path.dirname(dbPath);
      await fs.mkdir(parentDir, { recursive: true });
      await preflightLbugSidecars(dbPath, {
        mode: 'write',
        logger,
        allowQuarantine: true,
      });

      const opened = await openLbugConnection(lbug, dbPath);
      db = opened.db;
      conn = opened.conn;
      currentDbReadOnly = false;
    } finally {
      await releaseInitLock();
    }
  }

  if (!readOnly) {
    const missingShadowError = await runSchemaCreationQueries(dbPath);
    if (missingShadowError) {
      await safeClose();
      resetOpenConnectionState();
      const reopened = await reopenWritableAfterMissingShadow(dbPath, missingShadowError);
      db = reopened.db;
      conn = reopened.conn;
      currentDbReadOnly = false;

      const retryMissingShadowError = await runSchemaCreationQueries(dbPath);
      if (retryMissingShadowError) {
        await safeClose();
        resetOpenConnectionState();
        throw new Error(shadowSidecarRecoveryMessage(dbPath, retryMissingShadowError));
      }
    }
  }

  // FTS powers baseline search, so initialize it with the core DB. Read-only
  // serve/MCP paths must never run DDL or trigger network INSTALL; analyze owns
  // schema/index creation and extension installation.
  await loadFTSExtension(undefined, readOnly ? { policy: 'load-only' } : {});

  currentDbPath = dbPath;
  return { db, conn };
};

export type LbugProgressCallback = (message: string) => void;

/**
 * Run a COPY, retrying once with IGNORE_ERRORS=true (which skips row-level
 * errors) on first failure. On a second failure, hand the RAW retry error to
 * `onError` — each call site formats + slices its own message (#2226 F5: node
 * COPY slices to 200 chars and throws; relationship COPY slices to 80 and warns,
 * so the helper must not pre-format and lose that distinction). `onError` may
 * throw to propagate the failure.
 */
const copyCsvWithRetry = async (
  targetConn: lbug.Connection,
  copyQuery: string,
  onError: (retryErr: unknown) => void,
): Promise<void> => {
  try {
    await queryAndDrain(targetConn, copyQuery);
  } catch {
    try {
      const retryQuery = copyQuery.replace(
        'auto_detect=false)',
        'auto_detect=false, IGNORE_ERRORS=true)',
      );
      await queryAndDrain(targetConn, retryQuery);
    } catch (retryErr) {
      onError(retryErr);
    }
  }
};

/**
 * Bulk-COPY every node CSV sequentially on the single writable connection
 * (LadybugDB allows one write txn at a time). Extracted from loadGraphToLbug so
 * it can run either at the node-phase boundary — overlapping the relationship
 * emit pass (#2203) — or after emit in the serial escape-hatch path. Each COPY
 * keeps the IGNORE_ERRORS=true retry; a hard failure throws (no node rows ⇒ the
 * relationship COPY would dangle on missing endpoints).
 */
const copyNodeCSVs = async (
  targetConn: lbug.Connection,
  nodeFileEntries: [NodeTableName, { csvPath: string; rows: number }][],
  log: (message: string) => void,
  totalSteps: number,
): Promise<void> => {
  let stepsDone = 0;
  for (const [table, { csvPath, rows }] of nodeFileEntries) {
    stepsDone++;
    log(`Loading nodes ${stepsDone}/${totalSteps}: ${table} (${rows.toLocaleString()} rows)`);

    const copyQuery = getCopyQuery(table, normalizeCopyPath(csvPath));
    await copyCsvWithRetry(targetConn, copyQuery, (retryErr) => {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      throw new Error(`COPY failed for ${table}: ${retryMsg.slice(0, 200)}`);
    });
  }
};

/**
 * Persist a KnowledgeGraph: stream CSVs, then bulk-COPY nodes (overlapped with
 * relationship emit — see the body) and relationships.
 *
 * NOT TRANSACTIONAL (#2226). Each `COPY` commits independently and there is no
 * surrounding transaction, so a failure partway through — a node `COPY` that
 * throws at the FK barrier, a relationship `COPY` failure, or a `pdgEmitManifest`
 * collision raised after node rows have already committed in the overlap path —
 * leaves a partially-loaded DB. The caller surfaces the error; recovery is a
 * `--force` re-analyze (a full rebuild), not a partial retry. Callers must not
 * assume the DB is either fully loaded or untouched after a rejection.
 */
export const loadGraphToLbug = async (
  graph: KnowledgeGraph,
  repoPath: string,
  storagePath: string,
  onProgress?: LbugProgressCallback,
  /**
   * Streamed PDG-emit manifest (#2202). When present (streaming was on, full
   * rebuild), the BasicBlock node CSV + per-pair PDG-edge CSVs it points at
   * were already flushed to disk during the emit loop; they are merged into the
   * COPY plan below so they load alongside the structural CSVs. When streaming
   * was on the in-memory `graph` holds zero BasicBlocks, so `streamAllCSVsToDisk`
   * emits none — the manifest is the sole source and there is no double-COPY.
   */
  pdgEmitManifest?: PdgEmitManifest,
) => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const log = onProgress || (() => {});

  // ── #2203 persistence-path profiling ──────────────────────────────────
  // Mirrors the PROF_SCOPE_RESOLUTION pattern (scope-resolution/pipeline/
  // run.ts): zero-cost when off — process.hrtime.bigint() is only read under
  // PROF_LBUG_LOAD=1, and the summary is logged behind the same gate. Fills
  // the gap that the DB-persistence path is un-timed today (the analyze
  // "emit" number is the scope-resolution emit bucket, not this COPY path).
  const PROF = process.env.PROF_LBUG_LOAD === '1';
  // Escape hatch / differential oracle (#2203): force the legacy strictly-serial
  // load order (emit everything, THEN COPY nodes, THEN COPY rels) instead of the
  // default node-COPY ‖ rel-emit overlap. Lets an operator revert the behavior at
  // runtime, and lets a test load the same graph both ways and assert identical
  // persisted content.
  const SERIAL = process.env.GITNEXUS_SERIAL_LBUG_LOAD === '1';
  const mark = (): bigint => (PROF ? process.hrtime.bigint() : 0n);
  const span = (a: bigint, b: bigint): string => (Number(b - a) / 1e6).toFixed(1);
  const tStart = mark();

  const csvDir = resolveNativeSafeStorageDir(storagePath, 'csv');

  // The single writable connection (LadybugDB is single-writer). Captured as a
  // const so the node-COPY closure has a non-null reference — TS cannot narrow
  // the reassignable module-level `conn` across the callback boundary.
  const writeConn = conn;
  const validTables = new Set<string>(NODE_TABLES as readonly string[]);

  // Merge the streamed PDG-emit node CSVs (#2202) into a node-file map. Collision
  // guard: a BasicBlock in the in-memory graph during a streamed run is an
  // invariant violation (streamAllCSVsToDisk would also emit basicblock.csv), so
  // fail loudly rather than drop rows (#2202 review #3). Runs at the node-phase
  // boundary so the manifest BasicBlock table COPYs with the structural CSVs.
  const mergeManifestNodeFiles = (
    nodeFilesMap: Map<NodeTableName, { csvPath: string; rows: number }>,
  ): void => {
    if (!pdgEmitManifest) return;
    for (const [table, meta] of pdgEmitManifest.nodeFiles) {
      if (nodeFilesMap.has(table)) {
        throw new Error(
          `Streaming PDG manifest collides with a structural node CSV for "${table}" — ` +
            `the in-memory graph should hold zero ${table} nodes when streaming. ` +
            `A ${table} node leaked into the graph during a streamed emit.`,
        );
      }
      nodeFilesMap.set(table, meta);
    }
  };

  // Node COPY is the only DB write that can overlap relationship CSV emit: the
  // rel pass writes new rel_*.csv files and never touches `conn`, while node COPY
  // uses `conn` and never touches the rel files. We start node COPY at the
  // node-phase boundary and let the rel pass run concurrently — the only
  // single-writer-safe parallelism (#2203). The rel COPY still waits for node
  // COPY (FK precondition), so the DB load order is unchanged.
  let nodeCopyPromise: Promise<void> | undefined;
  let nodeCopyError: unknown;
  const beginNodeCopy = (
    nodeFilesMap: Map<NodeTableName, { csvPath: string; rows: number }>,
  ): void => {
    mergeManifestNodeFiles(nodeFilesMap);
    const entries = [...nodeFilesMap.entries()];
    // copyNodeCSVs logs node progress as step/total; it processes only node
    // tables (the rel COPY has its own "Loading edges" progress line), so the
    // denominator is the node-table count — not +1 reserving a rel step.
    // .catch captures the failure so an overlapped (mid-emit) rejection cannot
    // surface as an unhandled rejection; it is rethrown at the FK barrier below.
    nodeCopyPromise = copyNodeCSVs(writeConn, entries, log, entries.length).catch((e) => {
      nodeCopyError = e;
    });
  };

  log('Streaming CSVs to disk...');
  let csvResult: StreamedCSVResult;
  try {
    csvResult = SERIAL
      ? await streamAllCSVsToDisk(graph, repoPath, csvDir)
      : await streamAllCSVsToDisk(graph, repoPath, csvDir, beginNodeCopy);
  } catch (emitErr) {
    // Relationship emit failed. In overlap mode a node COPY may be in flight —
    // settle it (the .catch above means this never rejects) before rethrowing so
    // it cannot leak as an unhandled rejection.
    if (nodeCopyPromise) await nodeCopyPromise;
    // If node COPY ALSO failed, emitErr wins the throw — log the swallowed node
    // error so a half-loaded DB isn't misattributed to the emit failure alone.
    if (nodeCopyError) {
      logger.warn(
        { err: nodeCopyError },
        '[lbug-load] node COPY also failed while relationship emit was failing',
      );
    }
    throw emitErr;
  }
  const tCsv = mark();

  // Merge the streamed PDG-emit per-pair rel CSVs (#2202) into the COPY plan —
  // collision-guarded. Done BEFORE node COPY so the serial escape hatch detects a
  // manifest/structural pair collision before committing any node rows (legacy
  // parity with the pre-overlap path), and the overlap path detects it as early
  // as csvResult is available. When a manifest is present, streaming was on and
  // the in-memory graph held zero BasicBlocks, so a structural collision means a
  // streaming-invariant violation — fail loudly rather than load corrupt data.
  if (pdgEmitManifest) {
    for (const [pairKey, meta] of pdgEmitManifest.relsByPair) {
      if (csvResult.relsByPair.has(pairKey)) {
        throw new Error(
          `Streaming PDG manifest collides with a structural relationship CSV for pair ` +
            `"${pairKey}" — a PDG edge leaked into the in-memory graph during a streamed emit.`,
        );
      }
      csvResult.relsByPair.set(pairKey, meta);
      csvResult.totalValidRels += meta.rows;
    }
  }

  // Serial path: all CSVs are on disk and node COPY has not started — start it
  // here so the barrier below blocks on it exactly as the legacy path did.
  if (SERIAL) beginNodeCopy(csvResult.nodeFiles);

  // FK barrier: node rows must exist before the relationship COPY resolves their
  // endpoints. In overlap mode most of node COPY was hidden behind rel emit, so
  // this await is the *residual* node-COPY time (≈0 when fully overlapped).
  if (nodeCopyPromise) await nodeCopyPromise;
  if (nodeCopyError) {
    throw nodeCopyError instanceof Error ? nodeCopyError : new Error(String(nodeCopyError));
  }
  const tCopyNodes = mark();

  // Bulk COPY relationships. They were already routed to per-FROM→TO-label-pair
  // files during the emit pass (#2203 U2) — there is no monolithic relations.csv
  // to re-read/re-split here; we COPY each pair file directly.
  const { relsByPair, relHeader, skippedRels, totalValidRels } = csvResult;
  let tCopyRels = tCopyNodes;
  let tFallback = tCopyNodes;

  const insertedRels = totalValidRels;
  const warnings: string[] = [];
  if (insertedRels > 0) {
    log(`Loading edges: ${insertedRels.toLocaleString()} across ${relsByPair.size} types`);

    let pairIdx = 0;
    let failedPairEdges = 0;
    const failedPairCsvPaths = new Set<string>();

    for (const [pairKey, { csvPath: pairCsvPath, rows }] of relsByPair) {
      pairIdx++;
      const [fromLabel, toLabel] = pairKey.split('|');
      const normalizedPath = normalizeCopyPath(pairCsvPath);
      // PARALLEL=false is load-bearing here too — see COPY_CSV_OPTS (#2203 / kuzudb/kuzu#5778).
      const copyQuery = `COPY ${REL_TABLE_NAME} FROM "${normalizedPath}" (from="${fromLabel}", to="${toLabel}", HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`;

      if (pairIdx % 5 === 0 || rows > 1000) {
        log(`Loading edges: ${pairIdx}/${relsByPair.size} types (${fromLabel} -> ${toLabel})`);
      }

      // Use the captured `writeConn` (not the module-level `conn`) for the rel
      // COPY, matching the node COPY above — one captured reference for the whole
      // bulk load (#2264 review P3). Same object during analyze (`conn` is only
      // reassigned at open/close under the session lock, never mid-load), so the
      // queryAndDrain `targetConn === conn` lock gate still engages.
      await copyCsvWithRetry(writeConn, copyQuery, (retryErr) => {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        warnings.push(`${fromLabel}->${toLabel} (${rows} edges): ${retryMsg.slice(0, 80)}`);
        failedPairEdges += rows;
        failedPairCsvPaths.add(pairCsvPath);
      });
      // Only delete if not in failedPairCsvPaths (needed for fallback)
      if (!failedPairCsvPaths.has(pairCsvPath)) {
        try {
          await fs.unlink(pairCsvPath);
        } catch {}
      }
    }
    tCopyRels = mark();

    if (failedPairCsvPaths.size > 0) {
      log(`Inserting ${failedPairEdges} edges individually (missing schema pairs)`);
      // Read failed pair files and merge for fallback inserts
      const allLines: string[] = [relHeader];
      for (const failedPath of failedPairCsvPaths) {
        try {
          const content = await fs.readFile(failedPath, 'utf-8');
          const lines = content.split('\n');
          // Skip header line (first) and empty lines
          for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim()) allLines.push(lines[i]);
          }
        } catch {}
        try {
          await fs.unlink(failedPath);
        } catch {}
      }
      if (allLines.length > 1) {
        await fallbackRelationshipInserts(allLines, validTables, deriveNodeLabel);
      }
    }
    tFallback = mark();
  }

  // Cleanup all CSVs (per-pair rel files are unlinked in the COPY loop above;
  // the remaining sweep below catches node CSVs + any leftover pair files).
  for (const [, { csvPath }] of csvResult.nodeFiles) {
    try {
      await fs.unlink(csvPath);
    } catch {}
  }
  try {
    const remaining = await fs.readdir(csvDir);
    for (const f of remaining) {
      try {
        await fs.unlink(path.join(csvDir, f));
      } catch {}
    }
  } catch {}
  try {
    await fs.rmdir(csvDir);
  } catch {}

  if (PROF) {
    const tEnd = mark();
    let totalNodeRows = 0;
    for (const [, { rows }] of csvResult.nodeFiles) totalNodeRows += rows;
    // `mode` records which load path ran. In overlap mode `csv-emit` is the wall
    // to streamAllCSVsToDisk's return (node COPY overlapped part of it) and
    // `copy-nodes` is the RESIDUAL node-COPY await after emit returned — it
    // trends to 0 as the overlap hides node COPY behind relationship emit. In
    // serial mode the buckets carry their legacy, disjoint meaning.
    logger.warn(
      `[lbug-load prof] mode=${SERIAL ? 'serial' : 'overlap'} csv-emit=${span(tStart, tCsv)}ms ` +
        `copy-nodes=${span(tCsv, tCopyNodes)}ms copy-rels=${span(tCopyNodes, tCopyRels)}ms ` +
        `fallback=${span(tCopyRels, tFallback)}ms total=${span(tStart, tEnd)}ms ` +
        `(${totalNodeRows} nodes, ${insertedRels} rels)`,
    );
  }

  return { success: true, insertedRels, skippedRels, warnings };
};

// LadybugDB default ESCAPE is '\' (backslash), but our CSV uses RFC 4180 escaping ("" for literal quotes).
// Source code content is full of backslashes which confuse the auto-detection.
// We MUST explicitly set ESCAPE='"' to use RFC 4180 escaping, and disable auto_detect to prevent
// LadybugDB from overriding our settings based on sample rows.
//
// PARALLEL=false IS LOAD-BEARING FOR CORRECTNESS — DO NOT FLIP IT (#2203).
// LadybugDB's parallel CSV reader (Kuzu-derived; default PARALLEL=true) splits the
// file into byte ranges parsed concurrently, and CANNOT determine line boundaries
// when a quoted field contains an embedded newline — it errors with "Quoted newlines
// are not supported in parallel CSV reader. Please specify PARALLEL=FALSE", or worse,
// mis-parses silently (upstream kuzudb/kuzu#5778, still open). Our `content`/`text`
// columns hold source code, so quoted multiline fields are guaranteed. PARALLEL=false
// is therefore required, not conservative. The multiline-quoted round-trip in
// test/integration/copy-parallel-invariant.test.ts fails loudly if this is ever flipped.
// Exported so that test asserts the invariant statically as well.
export const COPY_CSV_OPTS = `(HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`;

// Multi-language table names that were created with backticks in CODE_ELEMENT_BASE
// and must always be referenced with backticks in queries
const BACKTICK_TABLES = new Set([
  'Struct',
  'Enum',
  'Macro',
  'Typedef',
  'Union',
  'Namespace',
  'Trait',
  'Impl',
  'TypeAlias',
  'Const',
  'Static',
  'Property',
  'Record',
  'Delegate',
  'Annotation',
  'Constructor',
  'Template',
  'Module',
]);

const escapeTableName = (table: string): string => {
  return BACKTICK_TABLES.has(table) ? `\`${table}\`` : table;
};

/**
 * Format one JS value as a Cypher literal for the adapter's string-built
 * statements: NULL/undefined → `NULL`, numbers pass through unquoted,
 * everything else becomes a single-quoted string literal escaped via
 * {@link escapeCypherString} (backslashes first, then quotes).
 *
 * Replaces three per-function closures that used SQL-style `''` doubling —
 * LadybugDB REJECTS doubling, so every value containing a quote made the
 * whole statement a parser error, invisible wherever the call site swallowed
 * per-row failures (#2409 escaping sweep, completed for tri-review
 * 4669518496 P2-2). Those closures also rewrote literal `\n`/`\r` into
 * two-character escape sequences; raw LF/CR are legal inside LadybugDB
 * single-quoted literals (live-probed on @ladybugdb/core 0.18.0), so the
 * replaces are gone and content now round-trips byte-identical.
 */
const formatCypherValue = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${escapeCypherString(String(v))}'`;
};

/**
 * Fallback: insert relationships one-by-one if COPY fails.
 *
 * Exported for the quoted-id round-trip tests in
 * `test/integration/lbug-core-adapter.test.ts` (the `DELETE_FILES_CHUNK_SIZE`
 * exported-for-tests precedent); production callers stay in this module.
 * Bails silently when the adapter singleton is closed.
 *
 * KNOWN PRE-EXISTING NARROWING (distinct from the `''` escaping bug, NOT
 * fixed here): the row regex below matches CSV fields with `[^"]*`, so an id
 * containing a double quote (CSV-escaped as `""`) never matches and the edge
 * is skipped. Tracked as part of the quote-in-id divergence documented in
 * `rel-pair-routing.ts`.
 */
export const fallbackRelationshipInserts = async (
  validRelLines: string[],
  validTables: Set<string>,
  getNodeLabel: (id: string) => string,
) => {
  if (!conn) return;
  const escapeLabel = (label: string): string => {
    return BACKTICK_TABLES.has(label) ? `\`${label}\`` : label;
  };

  for (let i = 1; i < validRelLines.length; i++) {
    const line = validRelLines[i];
    try {
      const match = line.match(/"([^"]*)","([^"]*)","([^"]*)",([0-9.]+),"([^"]*)",([0-9-]+)/);
      if (!match) continue;
      const [, fromId, toId, relType, confidenceStr, reason, stepStr] = match;
      const fromLabel = getNodeLabel(fromId);
      const toLabel = getNodeLabel(toId);
      if (!validTables.has(fromLabel) || !validTables.has(toLabel)) continue;

      const confidence = parseFloat(confidenceStr) || 1.0;
      const step = parseInt(stepStr) || 0;

      await queryAndDrain(
        conn,
        `
        MATCH (a:${escapeLabel(fromLabel)} {id: ${formatCypherValue(fromId)} }),
              (b:${escapeLabel(toLabel)} {id: ${formatCypherValue(toId)} })
        CREATE (a)-[:${REL_TABLE_NAME} {type: ${formatCypherValue(relType)}, confidence: ${confidence}, reason: ${formatCypherValue(reason)}, step: ${step}}]->(b)
      `,
      );
    } catch {
      // skip
    }
  }
};

/** Tables with isExported column (TypeScript/JS-native types) */
const TABLES_WITH_EXPORTED = new Set<string>([
  'Function',
  'Class',
  'Interface',
  'Method',
  'CodeElement',
]);

export const getCopyQuery = (table: NodeTableName, filePath: string): string => {
  const t = escapeTableName(table);
  if (table === 'File') {
    return `COPY ${t}(id, name, filePath, content) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Folder') {
    return `COPY ${t}(id, name, filePath) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Community') {
    return `COPY ${t}(id, label, heuristicLabel, keywords, description, enrichedBy, cohesion, symbolCount) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Process') {
    return `COPY ${t}(id, label, heuristicLabel, processType, stepCount, communities, entryPointId, terminalId) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Section') {
    return `COPY ${t}(id, name, filePath, startLine, endLine, level, content, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Route') {
    return `COPY ${t}(id, name, filePath, responseKeys, errorKeys, middleware, method, handlerSymbolId) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Tool') {
    return `COPY ${t}(id, name, filePath, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'BasicBlock') {
    // Taint/PDG substrate (issue #2080) — no name column. `callees` is the
    // statement-precise inter-procedural reach substrate (space-joined leaf names);
    // `calleeIds` is its SOUND parallel (space-joined resolved callee ids, #2227).
    return `COPY ${t}(id, filePath, startLine, endLine, text, callees, calleeIds) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Method') {
    return `COPY ${t}(id, name, filePath, startLine, endLine, isExported, content, description, parameterCount, returnType) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Property') {
    return `COPY ${t}(id, name, filePath, startLine, endLine, content, description, declaredType) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  // TypeScript/JS code element tables have isExported; multi-language tables do not
  if (TABLES_WITH_EXPORTED.has(table)) {
    return `COPY ${t}(id, name, filePath, startLine, endLine, isExported, content, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  // Multi-language tables (Struct, Impl, Trait, Macro, etc.)
  return `COPY ${t}(id, name, filePath, startLine, endLine, content, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
};

/**
 * Insert a single node to LadybugDB
 * @param label - Node type (File, Function, Class, etc.)
 * @param properties - Node properties
 * @param dbPath - Path to LadybugDB database (optional if already initialized)
 */
export const insertNodeToLbug = async (
  label: string,
  properties: Record<string, any>,
  dbPath?: string,
): Promise<boolean> => {
  // Use provided dbPath or fall back to module-level db
  const targetDbPath = dbPath || (db ? undefined : null);
  if (!targetDbPath && !db) {
    throw new Error('LadybugDB not initialized. Provide dbPath or call initLbug first.');
  }

  try {
    // Values go through the module-scope formatCypherValue — the old local
    // closure used `''` doubling, which LadybugDB rejects (#2409 escaping
    // sweep, tri-review 4669518496 P2-2).

    // Build INSERT query based on node type
    const t = escapeTableName(label);
    let query: string;

    if (label === 'File') {
      query = `CREATE (n:File {id: ${formatCypherValue(properties.id)}, name: ${formatCypherValue(properties.name)}, filePath: ${formatCypherValue(properties.filePath)}, content: ${formatCypherValue(properties.content || '')}})`;
    } else if (label === 'Folder') {
      query = `CREATE (n:Folder {id: ${formatCypherValue(properties.id)}, name: ${formatCypherValue(properties.name)}, filePath: ${formatCypherValue(properties.filePath)}})`;
    } else if (label === 'Section') {
      const descPart = properties.description
        ? `, description: ${formatCypherValue(properties.description)}`
        : '';
      query = `CREATE (n:Section {id: ${formatCypherValue(properties.id)}, name: ${formatCypherValue(properties.name)}, filePath: ${formatCypherValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, level: ${properties.level || 1}, content: ${formatCypherValue(properties.content || '')}${descPart}})`;
    } else if (label === 'BasicBlock') {
      // Taint/PDG substrate (issue #2080) — no name column. `calleeIds` (#2227)
      // is the sound resolved-id parallel to the leaf-name `callees` set.
      query = `CREATE (n:BasicBlock {id: ${formatCypherValue(properties.id)}, filePath: ${formatCypherValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, text: ${formatCypherValue(properties.text || '')}, callees: ${formatCypherValue(properties.callees || '')}, calleeIds: ${formatCypherValue(properties.calleeIds || '')}})`;
    } else if (TABLES_WITH_EXPORTED.has(label)) {
      const descPart = properties.description
        ? `, description: ${formatCypherValue(properties.description)}`
        : '';
      query = `CREATE (n:${t} {id: ${formatCypherValue(properties.id)}, name: ${formatCypherValue(properties.name)}, filePath: ${formatCypherValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, isExported: ${!!properties.isExported}, content: ${formatCypherValue(properties.content || '')}${descPart}})`;
    } else if (label === 'Property') {
      const descPart = properties.description
        ? `, description: ${formatCypherValue(properties.description)}`
        : '';
      query = `CREATE (n:${t} {id: ${formatCypherValue(properties.id)}, name: ${formatCypherValue(properties.name)}, filePath: ${formatCypherValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, content: ${formatCypherValue(properties.content || '')}${descPart}, declaredType: ${formatCypherValue(properties.declaredType || '')}})`;
    } else {
      // Multi-language tables (Struct, Impl, Trait, Macro, etc.) — no isExported
      const descPart = properties.description
        ? `, description: ${formatCypherValue(properties.description)}`
        : '';
      query = `CREATE (n:${t} {id: ${formatCypherValue(properties.id)}, name: ${formatCypherValue(properties.name)}, filePath: ${formatCypherValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, content: ${formatCypherValue(properties.content || '')}${descPart}})`;
    }

    // Use per-query connection if dbPath provided (avoids lock conflicts)
    if (targetDbPath) {
      const tempHandle = await openLbugConnection(lbug, targetDbPath);
      try {
        await queryAndDrain(tempHandle.conn, query);
        return true;
      } finally {
        await closeLbugConnection(tempHandle);
      }
    } else if (conn) {
      // Use existing persistent connection (when called from analyze)
      await queryAndDrain(conn, query);
      return true;
    }

    return false;
  } catch (e: any) {
    // Node may already exist or other error
    logger.error({ err: e.message }, `Failed to insert ${label} node:`);
    return false;
  }
};

/**
 * Batch insert multiple nodes to LadybugDB using a single connection
 * @param nodes - Array of {label, properties} to insert
 * @param dbPath - Path to LadybugDB database
 * @returns Object with success count and error count
 */
export const batchInsertNodesToLbug = async (
  nodes: Array<{ label: string; properties: Record<string, any> }>,
  dbPath: string,
): Promise<{ inserted: number; failed: number }> => {
  if (nodes.length === 0) return { inserted: 0, failed: 0 };

  // Values go through the module-scope formatCypherValue — the old local
  // closure used `''` doubling, which LadybugDB rejects; the per-node catch
  // below counted every quoted value as a silent `failed` (#2409 escaping
  // sweep, tri-review 4669518496 P2-2).

  // Open a single connection for all inserts
  const tempHandle = await openLbugConnection(lbug, dbPath);
  const tempConn = tempHandle.conn;

  let inserted = 0;
  let failed = 0;

  try {
    for (const { label, properties } of nodes) {
      try {
        let query: string;

        // Use MERGE instead of CREATE for upsert behavior (handles duplicates gracefully)
        const t = escapeTableName(label);
        if (label === 'File') {
          query = `MERGE (n:File {id: ${formatCypherValue(properties.id)}}) SET n.name = ${formatCypherValue(properties.name)}, n.filePath = ${formatCypherValue(properties.filePath)}, n.content = ${formatCypherValue(properties.content || '')}`;
        } else if (label === 'Folder') {
          query = `MERGE (n:Folder {id: ${formatCypherValue(properties.id)}}) SET n.name = ${formatCypherValue(properties.name)}, n.filePath = ${formatCypherValue(properties.filePath)}`;
        } else if (label === 'Section') {
          const descPart = properties.description
            ? `, n.description = ${formatCypherValue(properties.description)}`
            : '';
          query = `MERGE (n:Section {id: ${formatCypherValue(properties.id)}}) SET n.name = ${formatCypherValue(properties.name)}, n.filePath = ${formatCypherValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.level = ${properties.level || 1}, n.content = ${formatCypherValue(properties.content || '')}${descPart}`;
        } else if (label === 'BasicBlock') {
          // Taint/PDG substrate (issue #2080) — no name column. `calleeIds`
          // (#2227) is the sound resolved-id parallel to the `callees` set.
          query = `MERGE (n:BasicBlock {id: ${formatCypherValue(properties.id)}}) SET n.filePath = ${formatCypherValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.text = ${formatCypherValue(properties.text || '')}, n.callees = ${formatCypherValue(properties.callees || '')}, n.calleeIds = ${formatCypherValue(properties.calleeIds || '')}`;
        } else if (TABLES_WITH_EXPORTED.has(label)) {
          const descPart = properties.description
            ? `, n.description = ${formatCypherValue(properties.description)}`
            : '';
          query = `MERGE (n:${t} {id: ${formatCypherValue(properties.id)}}) SET n.name = ${formatCypherValue(properties.name)}, n.filePath = ${formatCypherValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.isExported = ${!!properties.isExported}, n.content = ${formatCypherValue(properties.content || '')}${descPart}`;
        } else if (label === 'Property') {
          const descPart = properties.description
            ? `, n.description = ${formatCypherValue(properties.description)}`
            : '';
          query = `MERGE (n:${t} {id: ${formatCypherValue(properties.id)}}) SET n.name = ${formatCypherValue(properties.name)}, n.filePath = ${formatCypherValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.content = ${formatCypherValue(properties.content || '')}${descPart}, n.declaredType = ${formatCypherValue(properties.declaredType || '')}`;
        } else {
          const descPart = properties.description
            ? `, n.description = ${formatCypherValue(properties.description)}`
            : '';
          query = `MERGE (n:${t} {id: ${formatCypherValue(properties.id)}}) SET n.name = ${formatCypherValue(properties.name)}, n.filePath = ${formatCypherValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.content = ${formatCypherValue(properties.content || '')}${descPart}`;
        }

        await queryAndDrain(tempConn, query);
        inserted++;
      } catch (e: any) {
        // Don't console.error here - it corrupts MCP JSON-RPC on stderr
        failed++;
      }
    }
  } finally {
    await closeLbugConnection(tempHandle);
  }

  return { inserted, failed };
};

export const executeQuery = async (cypher: string): Promise<any[]> => {
  return await executePrepared(cypher, {});
};

export const streamQuery = async (
  cypher: string,
  onRow: (row: any) => void | Promise<void>,
): Promise<number> => {
  if (isWalDriverActive()) {
    // streamQuery reads rows on the singleton connection WITHOUT withConnLock; if
    // the WAL-checkpoint driver is live, those reads could race a CHECKPOINT — the
    // #2264 corruption window. Today the serve/read path never runs the driver
    // (analyze runs in a forked worker), so this fails loud only if a future
    // in-process analyze overlaps a stream. Run analysis in a worker, or stop the
    // driver before streaming. See conn-lock.ts.
    throw new Error(
      'streamQuery cannot run while the WAL-checkpoint driver is active (it would ' +
        'race a CHECKPOINT on the unlocked read connection — #2264).',
    );
  }
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const queryResult = await conn.query(cypher);
  const results = Array.isArray(queryResult) ? queryResult : [queryResult];
  const result = results[0];
  let rowCount = 0;
  let streamError: unknown;

  try {
    while (await result.hasNext()) {
      const row = await result.getNext();
      await onRow(row);
      rowCount++;
    }
    return rowCount;
  } catch (err) {
    streamError = err;
    throw err;
  } finally {
    try {
      await drainQueryResult(results);
    } catch (err) {
      if (streamError === undefined) throw err;
    }
  }
};

/**
 * Execute a single parameterized query (prepare/execute pattern).
 * Prevents Cypher injection by binding values as parameters.
 */
export const executePrepared = async (
  cypher: string,
  params: Record<string, any>,
): Promise<any[]> => {
  const c = conn;
  if (!c) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  return withConnLock(async () => {
    const stmt = await c.prepare(cypher);
    if (!stmt.isSuccess()) {
      const errMsg = await stmt.getErrorMessage();
      throw new Error(`Prepare failed: ${errMsg}`);
    }
    const queryResult = await c.execute(stmt, params);
    return await readQueryRows(queryResult);
  });
};

export const executeWithReusedStatement = async (
  cypher: string,
  paramsList: Array<Record<string, any>>,
): Promise<void> => {
  const c = conn;
  if (!c) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  if (paramsList.length === 0) return;

  const SUB_BATCH_SIZE = 4;
  for (let i = 0; i < paramsList.length; i += SUB_BATCH_SIZE) {
    const subBatch = paramsList.slice(i, i + SUB_BATCH_SIZE);
    // One critical section per sub-batch: the prepare + its executes run with
    // exclusive access to the connection (so the WAL checkpoint driver cannot
    // interleave a CHECKPOINT mid-batch), while the lock is released between
    // sub-batches to let the driver checkpoint during a long writeback.
    await withConnLock(async () => {
      const stmt = await c.prepare(cypher);
      if (!stmt.isSuccess()) {
        const errMsg = await stmt.getErrorMessage();
        throw new Error(`Prepare failed: ${errMsg}`);
      }
      try {
        for (const params of subBatch) {
          await drainQueryResult(await c.execute(stmt, params));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const queryPreview = cypher.replace(/\s+/g, ' ').slice(0, 120);
        throw new Error(
          `Batch execution failed for rows ${i + 1}-${i + subBatch.length}: ${msg} (${queryPreview})`,
        );
      }
      // Note: LadybugDB PreparedStatement doesn't require explicit close()
    });
  }
};

export const getLbugStats = async (): Promise<{ nodes: number; edges: number }> => {
  const c = conn;
  if (!c) return { nodes: 0, edges: 0 };

  // Called during analyze finalize while the WAL-checkpoint driver is still
  // running; each count read takes the connection lock so it cannot execute
  // concurrently with a driver CHECKPOINT. Per-query locking lets the driver
  // checkpoint between table counts rather than waiting for the whole sweep.
  let totalNodes = 0;
  for (const tableName of NODE_TABLES) {
    try {
      totalNodes += await withConnLock(async () => {
        const queryResult = await c.query(
          `MATCH (n:${escapeTableName(tableName)}) RETURN count(n) AS cnt`,
        );
        const nodeRows = await readQueryRows(queryResult);
        return nodeRows.length > 0 ? Number(nodeRows[0]?.cnt ?? nodeRows[0]?.[0] ?? 0) : 0;
      });
    } catch {
      // ignore
    }
  }

  let totalEdges = 0;
  try {
    totalEdges = await withConnLock(async () => {
      const queryResult = await c.query(
        `MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS cnt`,
      );
      const edgeRows = await readQueryRows(queryResult);
      return edgeRows.length > 0 ? Number(edgeRows[0]?.cnt ?? edgeRows[0]?.[0] ?? 0) : 0;
    });
  } catch {
    // ignore
  }

  return { nodes: totalNodes, edges: totalEdges };
};

/**
 * Load cached embeddings from LadybugDB before a rebuild.
 * Returns all embedding vectors so they can be re-inserted after the graph is reloaded,
 * avoiding expensive re-embedding of unchanged nodes.
 *
 * Detects old schema (no chunkIndex column) and returns empty cache to trigger rebuild.
 */
export const loadCachedEmbeddings = async (): Promise<{
  embeddingNodeIds: Set<string>;
  embeddings: CachedEmbedding[];
}> => {
  const c = conn;
  if (!c) {
    return { embeddingNodeIds: new Set(), embeddings: [] };
  }

  // The whole read runs inside the connection lock (#2264 review P2). It's safe
  // today only by call-ordering (loadCachedEmbeddings runs before the WAL driver
  // starts), but the lock makes it robust to future reordering — a concurrent
  // CHECKPOINT on the singleton connection is the documented corruption trigger.
  // Leaf read: no nested withConnLock-wrapped helpers inside.
  return withConnLock(async () => {
    const embeddingNodeIds = new Set<string>();
    const embeddings: CachedEmbedding[] = [];
    try {
      // Schema migration detection: query with new columns to verify schema version.
      // Old schema only had (nodeId, embedding); new schema adds (id, chunkIndex, startLine, endLine, contentHash).
      // If the query fails (column missing), we return empty cache to force a full rebuild.
      try {
        const check = await c.query(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex LIMIT 1`,
        );
        await readQueryRows(check);
      } catch {
        return { embeddingNodeIds: new Set(), embeddings: [] };
      }

      // Try to read contentHash alongside chunk columns
      let rows: any;
      let hasContentHash = true;
      try {
        rows = await c.query(
          `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding, e.contentHash AS contentHash`,
        );
      } catch (err: any) {
        // Fallback for legacy DBs without contentHash column
        const msg = err?.message ?? '';
        if (isMissingColumnOrTableError(msg)) {
          hasContentHash = false;
          rows = await c.query(
            `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding`,
          );
        } else {
          throw err;
        }
      }
      for (const row of await readQueryRows(rows)) {
        const nodeId = String(row.nodeId ?? row[0] ?? '');
        if (!nodeId) continue;
        embeddingNodeIds.add(nodeId);
        const embedding = row.embedding ?? row[4];
        if (embedding) {
          embeddings.push({
            nodeId,
            chunkIndex: Number(row.chunkIndex ?? row[1] ?? 0),
            startLine: Number(row.startLine ?? row[2] ?? 0),
            endLine: Number(row.endLine ?? row[3] ?? 0),
            embedding: Array.isArray(embedding)
              ? embedding.map(Number)
              : Array.from(embedding as any).map(Number),
            contentHash: hasContentHash ? (row.contentHash ?? row[5] ?? undefined) : undefined,
          });
        }
      }
    } catch {
      /* embedding table may not exist */
    }

    return { embeddingNodeIds, embeddings };
  });
};

/**
 * Fetch existing embedding hashes from CodeEmbedding table for incremental embedding.
 * Returns a Map<nodeId, contentHash> suitable for passing to `runEmbeddingPipeline`.
 * Handles legacy DBs without the `contentHash` column (all rows treated as stale with empty hash).
 * Returns undefined if the CodeEmbedding table does not exist.
 *
 * @param execQuery - Cypher query executor (typically pool-adapter's `executeQuery`)
 */
export const fetchExistingEmbeddingHashes = async (
  execQuery: (cypher: string) => Promise<any[]>,
): Promise<Map<string, string> | undefined> => {
  try {
    const rows = await execQuery(
      `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.contentHash AS contentHash`,
    );
    if (!rows || rows.length === 0) return undefined;
    const map = new Map<string, string>();
    for (const r of rows) {
      const nodeId = r.nodeId ?? r[0];
      const chunkIndex = r.chunkIndex ?? r[1];
      const startLine = r.startLine ?? r[2];
      const endLine = r.endLine ?? r[3];
      const hash = r.contentHash ?? r[4] ?? STALE_HASH_SENTINEL;
      if (nodeId) {
        const hasChunkMetadata =
          chunkIndex !== undefined &&
          chunkIndex !== null &&
          startLine !== undefined &&
          startLine !== null &&
          endLine !== undefined &&
          endLine !== null;
        // Empty/null contentHash or missing chunk metadata means legacy row — treat as stale.
        map.set(nodeId, hasChunkMetadata && hash ? hash : STALE_HASH_SENTINEL);
      }
    }
    return map;
  } catch (err: any) {
    const msg = err?.message ?? '';
    if (isMissingColumnOrTableError(msg)) {
      // Legacy rows missing chunk-aware columns — treat every row as stale.
      try {
        const rows = await execQuery(`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId`);
        if (!rows || rows.length === 0) return undefined;
        const map = new Map<string, string>();
        for (const r of rows) {
          const nodeId = r.nodeId ?? r[0];
          if (nodeId) map.set(nodeId, STALE_HASH_SENTINEL);
        }
        logger.info(
          `[embed] ${map.size} nodes in legacy DB (missing chunk-aware columns) — all treated as stale`,
        );
        return map;
      } catch (fallbackErr: any) {
        const fallbackMsg = fallbackErr?.message ?? '';
        if (isMissingColumnOrTableError(fallbackMsg)) {
          logger.info(
            `[embed] CodeEmbedding table not yet present — full embedding run (${fallbackMsg})`,
          );
          return undefined;
        }
        throw fallbackErr;
      }
    }
    throw err;
  }
};

/**
 * Flush the WAL so all pending writes are visible to subsequent readers.
 *
 * Best-effort: swallows errors from older LadybugDB versions or schemaless
 * databases that do not support the CHECKPOINT command.  A no-op when there
 * is nothing pending, so safe (and cheap) to call unconditionally after any
 * write path.
 *
 * Use this instead of safeClose when the connection must stay open
 * (e.g. the /api/embed handler that keeps serving queries after flushing).
 *
 * @see safeClose — CHECKPOINT + connection/database close
 */
export const flushWAL = async (): Promise<void> => {
  const c = conn;
  if (!c) return;
  try {
    await withConnLock(async () => {
      const checkpointResult = await c.query('CHECKPOINT');
      await drainQueryResult(checkpointResult);
    });
  } catch (err) {
    logger.debug(
      `GitNexus: LadybugDB CHECKPOINT skipped/failed during WAL flush: ${summarizeError(err)}`,
    );
  }
};

/**
 * Issue a manual `CHECKPOINT` against the current connection and surface
 * any engine error to the caller. Unlike {@link flushWAL}, this variant
 * does NOT swallow Ladybug rename/remove IO failures — the manual
 * checkpoint driver (`wal-checkpoint-driver.ts`) relies on the rejection
 * to drive its bounded retry loop. Returns `false` when no connection is
 * open (the caller treats this as a no-op success — there is no WAL to
 * flush). Returns `true` after a successful CHECKPOINT + drain.
 *
 * The split from `flushWAL` is deliberate: every other CHECKPOINT site
 * (server flush, safeClose) is best-effort and prefers a silent skip;
 * the manual driver, by contrast, must observe failures to decide
 * whether to retry.
 */
export const tryFlushWAL = async (): Promise<boolean> => {
  const c = conn;
  if (!c) return false;
  // Runs on the periodic WAL-checkpoint driver. The lock makes this CHECKPOINT
  // wait for any in-flight COPY / writeback on the singleton connection instead
  // of executing concurrently with it (the `analyze --pdg` heap-corruption bug).
  await withConnLock(async () => {
    const checkpointResult = await c.query('CHECKPOINT');
    await drainQueryResult(checkpointResult);
  });
  return true;
};

/**
 * Flush the WAL and close the connection and database handles.
 *
 * Consolidates the CHECKPOINT + close pattern into a single function so
 * callers never call conn.close() or db.close() directly (#1376).
 * An ESLint no-restricted-syntax rule enforces this — see eslint.config.mjs.
 *
 * @see flushWAL — CHECKPOINT-only (connection stays open)
 * @see closeLbug — safeClose + module state reset (full teardown)
 */
export const safeClose = async (): Promise<void> => {
  await flushWAL();
  // Capture before close — currentDbPath stays set so the Windows post-close
  // probe below knows which file to wait on.
  const closingDbPath = currentDbPath;
  if (conn) {
    try {
      // eslint-disable-next-line no-restricted-syntax -- sole authorised close site
      await conn.close();
    } catch {
      /* best-effort */
    }
    conn = null;
  }
  if (db) {
    try {
      // eslint-disable-next-line no-restricted-syntax -- sole authorised close site
      await db.close();
    } catch {
      /* best-effort */
    }
    db = null;
  }
  // Windows: libuv reports `db.close()` resolved before the kernel has
  // released the file handle. A subsequent `new Database(samePath)` in
  // the same process can race the release. The probe (lbug-config.ts)
  // forces any residual lock to surface as EBUSY/EPERM/EACCES so the
  // open-time retry absorbs the lag.
  if (process.platform === 'win32' && closingDbPath) {
    const released = await waitForWindowsHandleRelease(closingDbPath);
    if (!released) {
      // Probe exhausted with a lock code still in flight. The next
      // openLbugConnection will absorb whatever residual lag remains, but
      // a chronic warning helps operators spot AV interference (Windows
      // Defender holding the file far past the 250ms budget).
      logger.warn(
        { dbPath: closingDbPath },
        '⚠️ LadybugDB file handle still locked after close (Windows). If this repeats, check antivirus/Defender exclusions for the GitNexus storage directory.',
      );
    }
  }
  if (closingDbPath) {
    await finalizeLbugSidecarsAfterClose(closingDbPath, { logger });
  }
};

/**
 * CHECKPOINT for durability, then DELIBERATELY skip the native connection/database
 * teardown. The name encodes the contract — there is no boolean flag to misuse:
 * call this ONLY from a path that guarantees a `process.exit` immediately after
 * (the CLI analyze success/SIGINT paths and the forked worker).
 *
 * LadybugDB's ClientContext/Connection destructor can double-free after large
 * --pdg writes (gdb: `double free or corruption` in ClientContext::~ClientContext
 * via NodeConnection::Close), aborting the process AFTER a fully-written,
 * checkpointed index. flushWAL already persisted the data; process exit reclaims
 * the native handles. We leave the handles referenced and module state intact so a
 * GC finalizer cannot run the same destructor before exit, and any post-analyze
 * read reuses the live connection. Mirrors the pool adapter's fire-and-forget
 * native teardown (pool-adapter.ts) and the ONNX native-cleanup philosophy.
 * Workaround for a LadybugDB engine bug (to be reported upstream).
 *
 * SAFETY: only valid when a process.exit is guaranteed to follow. Long-lived
 * callers (MCP server, tests) leave `skipNativeCloseOnExit` unset, so
 * runFullAnalysis closes for real via {@link closeLbug} — never this.
 */
export const closeLbugBeforeExit = async (): Promise<void> => {
  await flushWAL();
  // NOTE (#2264): unlike safeClose, this deliberately does NOT run
  // finalizeLbugSidecarsAfterClose. That step inspects/quarantines orphan WAL +
  // sidecar files and is designed to run AFTER the native close has released the
  // WAL handle; running it here — with the connection still open — would risk a
  // Windows file-lock on the in-use WAL for no benefit. The CHECKPOINT above
  // already made the index durable, and the next run's preflightLbugSidecars
  // reconciles any residual WAL on open. The deferred sidecar housekeeping is the
  // accepted trade-off of skipping the native close to dodge the destructor
  // double-free.
};

export const closeLbug = async (): Promise<void> => {
  await safeClose();
  currentDbPath = null;
  ftsLoaded = false;
  vectorExtensionLoaded = false;
  vectorIndexEnsured = false;
  ensuredFTSIndexes.clear();
};

/**
 * Thrown by {@link wipeLbugDbFiles} when a data-bearing member of the
 * LadybugDB file family is still present after the bounded
 * remove-and-verify retries (#2409, tri-review 4669518496 P2-4), and by
 * run-analyze's dirty-recovery block when the crashed run's sidecars can
 * neither be parked nor removed (this shipping review, FIX 1 — same lock
 * class, same remediation, and the CLI already renders this type).
 *
 * Classify by TYPE (`err instanceof LbugWipeError`) — the repo norm from
 * #2385 — never by message text. The MESSAGE is nonetheless fully
 * self-contained (headline + blocked paths + remediation) because
 * `gitnexus serve` forwards only `err.message` over worker IPC
 * (analyze-worker-core.ts), so the serve surface has nothing but this
 * string to show the user. The holder framing deliberately covers the
 * own-process case (FIX 2, finder A): the blocking handle is often a
 * lingering one from THIS process's just-closed DB or a transient AV scan
 * — not necessarily another process — so an immediate re-run often
 * succeeds.
 */
export class LbugWipeError extends Error {
  /** Paths still present (or unverifiable) after all retries. */
  readonly survivors: readonly string[];

  constructor(survivors: readonly string[], options?: { headline?: string }) {
    super(
      `${
        options?.headline ??
        `Failed to remove the LadybugDB index files — still present after ` +
          `${HANDLE_RELEASE_PROBE_ATTEMPTS} attempts:`
      }\n` +
        survivors.map((p) => `  - ${p}`).join('\n') +
        `\nThe blocking handle may be another process, a lingering handle from this ` +
        `process's just-closed database, or an antivirus scan — an immediate re-run ` +
        `often succeeds. If it persists, ${lbugLockRemediation('re-run the analyze')}.`,
    );
    this.name = 'LbugWipeError';
    this.survivors = survivors;
  }
}

/**
 * Remove the LadybugDB file family and VERIFY each member is really gone.
 *
 * Owns the canonical 4-file family list — `<lbugPath>`, `.wal`, `.shadow`,
 * `.lock` — so run-analyze's two wipe sites (full rebuild + the #2409
 * escalation valve) can never drift apart. `.shadow` is included because a
 * checkpoint-in-flight crash leaves a shadow sidecar, and a stale shadow next
 * to a freshly created DB file is replay poison on the next open (#2409).
 *
 * Verification contract (tri-review 4669518496 P2-4 — the old inline loops
 * swallowed rm failures and let `initLbug` reopen a still-populated DB the
 * run believed it wiped): after `fs.rm({ recursive, force })`, each path is
 * probed and counts as GONE only when the probe rejects with **ENOENT**. A
 * resolving probe, or a rejection in the EPERM/EBUSY/EACCES class (Windows
 * delete-pending / handle-release lag — see HANDLE_RELEASE_LOCK_CODES in
 * lbug-config.ts), or any other code means the path is not verifiably gone:
 * it is retried on the shared handle-release budget
 * (HANDLE_RELEASE_PROBE_ATTEMPTS × linear HANDLE_RELEASE_PROBE_DELAY_MS,
 * lbug-config.ts — the previous private mirror constants were
 * documentation-coupled copies) and then handled by CLASS (this shipping
 * review, FIX 2):
 *
 *   - DATA-BEARING members (`<lbugPath>`, `.wal`, `.shadow`) — a survivor
 *     means the reopen would resurrect rows this run believes wiped: throw
 *     a typed {@link LbugWipeError}.
 *   - `.lock` — contentless: `initLbug` recreates it, and a genuinely held
 *     lock surfaces as initLbug's own lock-busy classification (a better
 *     error than this one). A `.lock`-only survivor (an AV-held
 *     delete-pending handle outlasting the budget previously failed a
 *     perfectly sound rebuild) logs a warning and CONTINUES.
 *
 * Linux unlinked-but-open (name gone, holder keeps the old inode) probes
 * ENOENT and is accepted by design — both production wipe sites run after a
 * real `closeLbug()`.
 *
 * Deliberately OUT of this contract: `cleanupOldKuzuFiles`
 * (repo-manager.ts) sweeps the LEGACY kuzu-era file family during storage
 * migration — different family, best-effort by design; and
 * `sweepStaleSidecars` (lbug-config.ts) is a test-fixture-gated open-retry
 * fallback that must never delete production files. Neither wipes the live
 * DB the run is about to recreate, so neither needs (or may share) the
 * loud-failure contract here.
 */
export const wipeLbugDbFiles = async (lbugPath: string): Promise<void> => {
  const lockPath = `${lbugPath}.lock`;
  const family = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.shadow`, lockPath];
  let survivors: string[] = [];

  for (let attempt = 1; attempt <= HANDLE_RELEASE_PROBE_ATTEMPTS; attempt++) {
    survivors = [];
    for (const f of family) {
      try {
        await fs.rm(f, { recursive: true, force: true });
      } catch {
        // `force: true` swallows ENOENT, so a rejection is a real failure —
        // but the ENOENT-probe below stays authoritative either way (another
        // process may have removed the path between the rm and the probe).
      }
      const gone = await fs.access(f).then(
        () => false, // still present
        (err: unknown) => (err as NodeJS.ErrnoException | null)?.code === 'ENOENT',
      );
      if (!gone) survivors.push(f);
    }
    if (survivors.length === 0) return;
    if (attempt < HANDLE_RELEASE_PROBE_ATTEMPTS) {
      await sleep(HANDLE_RELEASE_PROBE_DELAY_MS * attempt);
    }
  }

  // Class split (FIX 2): the contentless `.lock` never fails the wipe.
  const dataSurvivors = survivors.filter((f) => f !== lockPath);
  if (survivors.includes(lockPath)) {
    logger.warn(
      `GitNexus: ${lockPath} is still present after the wipe retries — continuing: the ` +
        'lock file is contentless and initLbug recreates it; a genuinely held lock will ' +
        "surface as the reopen's own lock-busy error.",
    );
  }
  if (dataSurvivors.length > 0) {
    throw new LbugWipeError(dataSurvivors);
  }
};

export const isLbugReady = (): boolean => conn !== null && db !== null;

/**
 * Multi-label alternation over exactly the labels that can own embedding
 * rows: EMBEDDABLE_LABELS plus File, which embedding-pipeline.ts embeds as
 * the zero-symbol fallback for text-only repositories (#2454). Reserved
 * keywords are backtick-escaped via {@link escapeTableName}. Probed on
 * @ladybugdb/core 0.18.0 (this shipping review, FIX 4): the full multi-label
 * alternation parses, executes, and deletes exactly the joined rows —
 * replacing the unlabeled `MATCH (n)` that scanned EVERY node table per
 * chunk (BasicBlock-dominated under `--pdg`) when only embeddable labels
 * can match an embedding row. Including File is free for code repositories:
 * they never hold File embedding rows, so the extra label joins nothing.
 */
const embeddableLabelMatch = (): string =>
  ['File', ...EMBEDDABLE_LABELS].map((l) => escapeTableName(l)).join('|');

// LADYBUGDB-CONTRACT: matches @ladybugdb/core ^0.18.0 native binder text,
// probe-recorded: `Binder exception: Table CodeEmbedding does not exist.`
// When bumping LadybugDB, re-validate — `git grep "LADYBUGDB-CONTRACT"`
// enumerates every version-coupled spot.
const isMissingEmbeddingTableError = (err: unknown): boolean => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(`Table ${EMBEDDING_TABLE_NAME} does not exist`);
};

/**
 * Delete all nodes (and their relationships) for a specific file from LadybugDB
 * @param filePath - The file path to delete nodes for
 * @param dbPath - Optional path to LadybugDB for per-query connection
 * @returns Object with counts of deleted nodes
 */
export const deleteNodesForFile = async (
  filePath: string,
  dbPath?: string,
): Promise<{ deletedNodes: number }> => {
  const usePerQuery = !!dbPath;

  // Set up connection (either use existing or create per-query)
  let tempHandle: LbugConnectionHandle | null = null;
  let tempConn: lbug.Connection | null = null;
  let targetConn: lbug.Connection | null = conn;

  if (usePerQuery) {
    tempHandle = await openLbugConnection(lbug, dbPath);
    tempConn = tempHandle.conn;
    targetConn = tempConn;
  } else if (!conn) {
    throw new Error('LadybugDB not initialized. Provide dbPath or call initLbug first.');
  }

  try {
    let deletedNodes = 0;
    const escapedPath = escapeCypherString(filePath);

    // Delete the file's embedding rows FIRST, while their owning nodes are
    // still present: node ids are label-first — generateId = `${label}:${name}`
    // (src/lib/utils.ts) with qualified names that embed the file path — so
    // the old `e.nodeId STARTS WITH '<filePath>'` shape never matched a row
    // (tri-review 4669518496 P2-1). Join through the nodes on exact id
    // equality instead, scoped to the embeddable labels (FIX 4 — see
    // embeddableLabelMatch); ordering is load-bearing — after the DETACH
    // DELETE loop below the join would match nothing.
    try {
      await queryAndDrain(
        targetConn!,
        `MATCH (n:${embeddableLabelMatch()}) WHERE n.filePath = '${escapedPath}' ` +
          `MATCH (e:${EMBEDDING_TABLE_NAME}) WHERE e.nodeId = n.id DELETE e`,
      );
    } catch (err) {
      // Deliberately legacy-permissive (pinned contract:
      // lbug-conn-serialization U5 and lbug-core-adapter expect this variant
      // to resolve `{deletedNodes: 0}` even on a bogus dbPath): the singular
      // variant swallows per-statement failures wholesale — its per-table
      // loop below does the same — so a partial rethrow here would be
      // incoherent with the rest of the function. The STRICT
      // rethrow-except-missing-table policy lives in deleteNodesForFiles,
      // the #2409 incremental writeback path (FIX 4). The one case worth a
      // diagnostic is the missing embedding table.
      if (isMissingEmbeddingTableError(err)) {
        logger.warn(
          { err },
          `deleteNodesForFile: ${EMBEDDING_TABLE_NAME} table does not exist — ` +
            'skipping embedding-row deletes for this DB.',
        );
      }
    }

    // Delete nodes from each table that has filePath
    // DETACH DELETE removes the node and all its relationships
    for (const tableName of NODE_TABLES) {
      // Skip tables that don't have filePath (Community, Process)
      if (tableName === 'Community' || tableName === 'Process') continue;

      try {
        // First count how many we'll delete. On the singleton connection this
        // count runs inside withConnLock (incremental --pdg writeback executes
        // while the WAL driver is live); per-query/temp connections skip the
        // lock, matching queryAndDrain's `targetConn === conn` gate — the sibling
        // DETACH DELETE below already routes through it. (#2264)
        const tn = escapeTableName(tableName);
        const countCypher = `MATCH (n:${tn}) WHERE n.filePath = '${escapedPath}' RETURN count(n) AS cnt`;
        const runCount = async () => readQueryRows(await targetConn!.query(countCypher));
        const rows = isSharedSingletonConn(targetConn!)
          ? await withConnLock(runCount)
          : await runCount();
        const count = Number(rows[0]?.cnt ?? rows[0]?.[0] ?? 0);

        if (count > 0) {
          // Delete nodes (and implicitly their relationships via DETACH)
          await queryAndDrain(
            targetConn!,
            `MATCH (n:${tn}) WHERE n.filePath = '${escapedPath}' DETACH DELETE n`,
          );
          deletedNodes += count;
        }
      } catch (e) {
        // Some tables may not support this query, skip
      }
    }

    return { deletedNodes };
  } finally {
    // Close per-query connection if used
    if (tempHandle) await closeLbugConnection(tempHandle);
  }
};

/**
 * Chunk size for {@link deleteNodesForFiles}. 200 paths keeps each
 * statement ~13KB (well inside parser limits) while a ~700-file write set
 * still collapses from ~13,000 statements to 124: 31 statements per chunk
 * (1 CodeEmbedding join-delete + 30 filePath-bearing node tables — the
 * 32-table NODE_TABLES roster minus Community/Process) × 4 chunks. The
 * original "~40" claim under-counted the per-chunk statement fan-out
 * (tri-review 4669518496 accuracy sweep).
 */
export const DELETE_FILES_CHUNK_SIZE = 200;

/**
 * Batched variant of {@link deleteNodesForFile} for the incremental
 * writeback (#2409). One `DETACH DELETE … WHERE n.filePath IN […]` per
 * node table per chunk of paths, instead of a count + delete per table
 * per FILE. The per-file loop issued ~13,000 single-row write
 * transactions on a ~700-file write set — a WAL-append storm that made
 * the incremental path slower than a full rebuild and is the write
 * pattern behind the native mid-writeback deaths reported in #2409.
 *
 * NO general error swallowing: a zero-match chunk is a no-op success by
 * construction (every node table except Community/Process has a filePath
 * column), so anything thrown here is a real engine failure the caller
 * must see — silently skipping was exactly how #2409 hid its root cause.
 * The single tolerated exception (FIX 4) is the missing-embedding-table
 * binder error on the embedding join-delete: a DB created without
 * EMBEDDING_SCHEMA cannot own embedding rows, so skipping that one
 * statement is sound, while failing would brick every incremental run on
 * such a DB until `--force`. Statement count per chunk is unchanged by the
 * multi-label join: 1 embedding join-delete + 30 node-table deletes = 31
 * (the rejected per-label fallback shape would have been 19 + 30 = 49).
 * Singleton-connection only: the analyze writeback owns the write lock,
 * and `queryAndDrain` routes through `withConnLock` for it (the WAL
 * checkpoint driver is live during this).
 */
export const deleteNodesForFiles = async (
  filePaths: readonly string[],
  options: { onChunk?: (filesDone: number, filesTotal: number) => void } = {},
): Promise<void> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  const targetConn = conn;
  let warnedMissingEmbeddingTable = false;
  for (let i = 0; i < filePaths.length; i += DELETE_FILES_CHUNK_SIZE) {
    const chunk = filePaths.slice(i, i + DELETE_FILES_CHUNK_SIZE);
    const listLiteral = `[${chunk.map((p) => `'${escapeCypherString(p)}'`).join(', ')}]`;
    // Embedding rows key on their OWNING NODE's id: generateId builds
    // label-first ids — `${label}:${name}` (src/lib/utils.ts) with qualified
    // names that embed the file path (e.g. `Function:src/f.ts:fn0:1`) — so
    // the previous bare-path `e.nodeId STARTS WITH '<filePath>'` OR-chain
    // could never match anything (tri-review 4669518496 P2-1: the embedding
    // delete was a no-op). Join through the nodes instead: one multi-label
    // MATCH over exactly the embeddable labels (FIX 4, probe-proven on
    // 0.18.0 — see embeddableLabelMatch; the old unlabeled `MATCH (n)`
    // scanned every node table per chunk, BasicBlock-dominated under
    // `--pdg`, when only embeddable labels can own rows), and
    // `e.nodeId = n.id` equality is exact — no `File:a.ts` / `File:a.tsx`
    // prefix collisions. ORDER IS LOAD-BEARING: this must run BEFORE the
    // DETACH DELETE loop below — once the nodes are gone the join matches
    // nothing (empirically verified against @ladybugdb/core 0.18.0).
    try {
      await queryAndDrain(
        targetConn,
        `MATCH (n:${embeddableLabelMatch()}) WHERE n.filePath IN ${listLiteral} ` +
          `MATCH (e:${EMBEDDING_TABLE_NAME}) WHERE e.nodeId = n.id DELETE e`,
      );
    } catch (err) {
      // Tolerate exactly the missing-embedding-table binder error: a
      // build-variant DB without EMBEDDING_SCHEMA would otherwise brick
      // every incremental run until `--force` (FIX 4). The no-swallow
      // policy stays for every real failure — anything else rethrows.
      if (!isMissingEmbeddingTableError(err)) throw err;
      if (!warnedMissingEmbeddingTable) {
        warnedMissingEmbeddingTable = true;
        logger.warn(
          { err },
          `deleteNodesForFiles: ${EMBEDDING_TABLE_NAME} table does not exist — ` +
            'skipping embedding-row deletes for this writeback.',
        );
      }
    }
    for (const tableName of NODE_TABLES) {
      // Community/Process are graph-wide (no filePath); the orchestrator
      // drops them wholesale via deleteAllCommunitiesAndProcesses.
      if (tableName === 'Community' || tableName === 'Process') continue;
      const tn = escapeTableName(tableName);
      await queryAndDrain(
        targetConn,
        `MATCH (n:${tn}) WHERE n.filePath IN ${listLiteral} DETACH DELETE n`,
      );
    }
    options.onChunk?.(Math.min(i + DELETE_FILES_CHUNK_SIZE, filePaths.length), filePaths.length);
  }
};

export const getEmbeddingTableName = (): string => EMBEDDING_TABLE_NAME;

/**
 * Return the distinct repo-relative paths of files that import
 * `targetFilePath` according to the IMPORTS edges currently in the
 * DB. Used by the incremental writeback path to expand the
 * "files-to-rewrite" set so that files importing a changed file get
 * their edges (which may have been refined by cross-file resolution)
 * re-emitted, rather than left stale in the DB.
 *
 * The DB query reads the *previous* run's state — pre-pipeline, before
 * any nodes are deleted — so the returned importers are "files that
 * USED TO import the target". That's the right set to invalidate:
 * those are the files whose edges in the DB might no longer match
 * what cross-file resolution produces given the changed file's new
 * exports.
 */
export const queryImporters = async (targetFilePath: string): Promise<string[]> => {
  const c = conn;
  if (!c) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  const escaped = escapeCypherString(targetFilePath);
  const cypher = `
    MATCH (a)-[r:${REL_TABLE_NAME}]->(b)
    WHERE r.type = 'IMPORTS' AND b.filePath = '${escaped}'
    RETURN DISTINCT a.filePath AS importer
  `;
  // Runs inside the connection lock: queryImporters is called in the importer-BFS
  // loop during incremental --pdg writeback while the WAL driver is live, so an
  // unlocked conn.query here could race a concurrent CHECKPOINT on the singleton.
  return withConnLock(async () => {
    let queryResult: lbug.QueryResult | lbug.QueryResult[] | undefined;
    try {
      queryResult = await c.query(cypher);
      const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
      const rows = await result.getAll();
      const out: string[] = [];
      for (const row of rows) {
        const v = (row as { importer?: unknown }).importer;
        if (typeof v === 'string' && v.length > 0) out.push(v);
      }
      return out;
    } catch {
      return [];
    } finally {
      if (queryResult) await closeQueryResults(queryResult);
    }
  });
};

/**
 * Batched variant of {@link queryImporters} for the incremental importer
 * BFS (#2409): distinct importers of ANY of the target paths, one query per
 * chunk per BFS depth instead of one query per frontier FILE (a ~700-file
 * frontier was ~700 sequential round-trips, each taking the connection lock
 * against the live WAL checkpoint driver — ~5.6s of the writeback measured).
 *
 * Same contract as the singular form: reads the pre-pipeline DB state and
 * swallows per-chunk query failures into a smaller result (correctness
 * degrades on that branch — under-expansion means possibly-stale edges —
 * but the DB stays writable and the writeback proceeds). Unlike the singular
 * form the degradation is not silent (tri-review 4669518496 P2-5): every
 * dropped chunk is logged and reported through `options.onChunkFailure`, so
 * the orchestrator can count it into the #2410 crash diagnostics
 * (`incrementalInProgress.droppedImporterChunks`).
 */
export const queryImportersBatch = async (
  targetFilePaths: readonly string[],
  options: {
    /**
     * Invoked once per chunk whose IMPORTS query failed and was dropped from
     * the expansion. Observability only — the degrade-don't-fail contract is
     * unchanged (the result just shrinks by the failed chunk's importers).
     */
    onChunkFailure?: (chunkIndex: number, chunkSize: number, err: unknown) => void;
  } = {},
): Promise<string[]> => {
  const c = conn;
  if (!c) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  const importers = new Set<string>();
  for (let i = 0; i < targetFilePaths.length; i += DELETE_FILES_CHUNK_SIZE) {
    // `i` only ever advances in whole chunk strides, so this is exact.
    const chunkIndex = i / DELETE_FILES_CHUNK_SIZE;
    const chunk = targetFilePaths.slice(i, i + DELETE_FILES_CHUNK_SIZE);
    const listLiteral = `[${chunk.map((p) => `'${escapeCypherString(p)}'`).join(', ')}]`;
    const cypher = `
      MATCH (a)-[r:${REL_TABLE_NAME}]->(b)
      WHERE r.type = 'IMPORTS' AND b.filePath IN ${listLiteral}
      RETURN DISTINCT a.filePath AS importer
    `;
    await withConnLock(async () => {
      let queryResult: lbug.QueryResult | lbug.QueryResult[] | undefined;
      try {
        queryResult = await c.query(cypher);
        const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
        const rows = await result.getAll();
        for (const row of rows) {
          const v = (row as { importer?: unknown }).importer;
          if (typeof v === 'string' && v.length > 0) importers.add(v);
        }
      } catch (err) {
        // Degrade-don't-fail, mirroring queryImporters — but LOUDLY
        // (tri-review 4669518496 P2-5): a dropped chunk means every importer
        // it would have surfaced keeps possibly-stale edges this run, and the
        // old bare `catch {}` left no trace of that anywhere. pino idiom:
        // `err` key — `error` serializes to `{}`.
        logger.warn(
          { err },
          `Incremental importer BFS: dropped chunk ${chunkIndex} (${chunk.length} target path(s)) — ` +
            'importer expansion degrades for this run; affected importers may keep stale edges until the next full rebuild.',
        );
        options.onChunkFailure?.(chunkIndex, chunk.length, err);
      } finally {
        if (queryResult) await closeQueryResults(queryResult);
      }
    });
  }
  // Cypher without ORDER BY is unordered — sort so downstream chunking and
  // logs are stable run-to-run (matches diffFileHashes' sorted outputs).
  return [...importers].sort();
};

/**
 * Drop every Community and Process node (and their MEMBER_OF /
 * STEP_IN_PROCESS edges via DETACH DELETE). Used at the start of an
 * incremental run so the communities and processes phases regenerate
 * them from scratch on the merged graph — required for the
 * "Leiden runs on the FULL graph" correctness invariant.
 */
export const deleteAllCommunitiesAndProcesses = async (): Promise<{
  nodesDeleted: number;
}> => {
  const c = conn;
  if (!c) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  // count + DETACH DELETE run inside the connection lock so they cannot execute
  // concurrently with the WAL-checkpoint driver's CHECKPOINT on the singleton
  // connection. This runs during incremental --pdg writeback while the driver is
  // live; mirrors the wrapped deleteAllInterprocTaintPaths / deleteAllCallSummaries.
  return withConnLock(async () => {
    let nodesDeleted = 0;
    for (const label of ['Community', 'Process']) {
      let countResult: lbug.QueryResult | lbug.QueryResult[] | undefined;
      try {
        countResult = await c.query(`MATCH (n:${label}) RETURN count(n) AS cnt`);
        const result = Array.isArray(countResult) ? countResult[0] : countResult;
        const rows = await result.getAll();
        const count = Number(rows[0]?.cnt ?? rows[0]?.[0] ?? 0);
        if (count > 0) {
          await closeQueryResults(await c.query(`MATCH (n:${label}) DETACH DELETE n`));
          nodesDeleted += count;
        }
      } catch {
        // Table may not exist yet on a freshly-initialized DB — fine.
      } finally {
        if (countResult) await closeQueryResults(countResult);
      }
    }
    return { nodesDeleted };
  });
};

/**
 * Shared mechanics for the delete-all-relationships-of-one-type family
 * ({@link deleteAllInterprocTaintPaths}, {@link deleteAllCallSummaries},
 * {@link deleteAllInjects}): count the typed CodeRelation rows, then DELETE
 * them (relationship-level — these are edge types, not node labels, so
 * endpoints are untouched).
 *
 * count + DELETE run as one critical section on the singleton connection so a
 * concurrent WAL-checkpoint cannot corrupt native state mid-delete (#pdg).
 *
 * @param relType       the CodeRelation `type` value to delete (e.g. 'INJECTS')
 * @param logTag        the `[tag]` prefix on the abort error message
 * @param duplicateNoun what the abort message says would be duplicated
 */
const deleteAllRelationshipsOfType = async (
  relType: string,
  logTag: string,
  duplicateNoun: string,
): Promise<{ edgesDeleted: number }> => {
  const c = conn;
  if (!c) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  return withConnLock(async () => {
    let edgesDeleted = 0;
    let countResult: lbug.QueryResult | lbug.QueryResult[] | undefined;
    try {
      countResult = await c.query(
        `MATCH ()-[r:CodeRelation]->() WHERE r.type = '${relType}' RETURN count(r) AS cnt`,
      );
      const result = Array.isArray(countResult) ? countResult[0] : countResult;
      const rows = await result.getAll();
      const count = Number(rows[0]?.cnt ?? rows[0]?.[0] ?? 0);
      if (count > 0) {
        await closeQueryResults(
          await c.query(`MATCH ()-[r:CodeRelation]->() WHERE r.type = '${relType}' DELETE r`),
        );
        edgesDeleted = count;
      }
    } catch (err) {
      // A missing table on a freshly-initialized DB is the benign, expected case
      // (the count query above is what throws) — stay silent. Any OTHER failure
      // (lock, disk, native error) would leave stale rows that the subsequent
      // re-extract then DUPLICATES (CodeRelation has no PK), so it must ABORT
      // the writeback (#2084 review P2-5): re-throw so the caller's crash-
      // recovery dirty flag forces a clean full rebuild on the next run, rather
      // than silently writing duplicate rows. The benign-vs-rethrow branch is
      // pure, extracted, and pinned by unit tests: `classifyDeleteAllError`
      // (lbug-config.ts, test/unit/lbug-delete-all-error.test.ts).
      const msg = err instanceof Error ? err.message : String(err);
      if (classifyDeleteAllError(err) === 'benign-missing-table') {
        if (countResult) await closeQueryResults(countResult);
        return { edgesDeleted };
      }
      if (countResult) await closeQueryResults(countResult);
      throw new Error(
        `[${logTag}] failed to clear existing ${relType} edges before incremental ` +
          `re-write (${msg}) — aborting to avoid ${duplicateNoun}; ` +
          `the next run will full-rebuild`,
      );
    }
    if (countResult) await closeQueryResults(countResult);
    return { edgesDeleted };
  });
};

/**
 * Drop every interprocedural `TAINT_PATH` relationship (#2084 M4 U6). Used at
 * the start of an incremental `--pdg` writeback so the `taintSummaries` phase
 * re-materialises them from scratch on the FULL recomputed graph.
 *
 * TAINT_PATH validity is a WHOLE-PROGRAM property (a flow A→C can be
 * invalidated by a change to an INTERMEDIATE function whose file is neither A
 * nor C). The endpoint-writability extract rule (`extractChangedSubgraph`)
 * cannot see that — an A→C edge between two unchanged files would be skipped
 * and a stale finding would survive. So, exactly like Community/Process, the
 * sound move is delete-all-then-rebuild: cheap because TAINT_PATH is sparse
 * (per-run capped), and the compute side already rebuilds every summary each
 * run. Relationship-level (TAINT_PATH is an edge type, not a node label), so a
 * plain DELETE on the typed CodeRelation rows — endpoints are untouched.
 */
export const deleteAllInterprocTaintPaths = async (): Promise<{ edgesDeleted: number }> =>
  deleteAllRelationshipsOfType(
    'TAINT_PATH',
    'taint-interproc',
    'duplicate cross-function findings',
  );

/**
 * Drop every `CALL_SUMMARY` relationship (PDG FU-C, U-C3). Used at the start of
 * an incremental `--pdg` writeback so the `callSummaries` phase re-materialises
 * them from scratch on the FULL recomputed graph.
 *
 * Mirrors {@link deleteAllInterprocTaintPaths}: CALL_SUMMARY is a self-loop edge
 * type (not a node label), so a plain DELETE on the typed CodeRelation rows
 * leaves endpoints untouched. `extractChangedSubgraph` re-includes ALL of them
 * from the fresh graph (`isGraphWideRelType`), so delete-all-then-rebuild keeps
 * an unchanged function's summary from being lost.
 */
export const deleteAllCallSummaries = async (): Promise<{ edgesDeleted: number }> =>
  deleteAllRelationshipsOfType('CALL_SUMMARY', 'call-summary', 'duplicate summaries');

/**
 * Drop every `INJECTS` relationship (DI collection injection, #2200). Used at
 * the start of an incremental writeback — UNCONDITIONALLY, unlike the
 * pdg-gated twins above, because the `di` phase runs on every persisting
 * analyze — so the phase re-materialises them from scratch on the FULL
 * recomputed graph.
 *
 * Mirrors {@link deleteAllInterprocTaintPaths}: INJECTS validity is a
 * whole-program property (a change to the interface, or a new/removed
 * implementer, on a THIRD file creates/invalidates edges between two
 * untouched files), so endpoint-writability extraction can't refresh them.
 * `extractChangedSubgraph` re-includes ALL of them from the fresh graph
 * (`isGraphWideRelType`), so delete-all-then-rebuild is the sound move.
 * Relationship-level (INJECTS is an edge type, not a node label), so a plain
 * DELETE on the typed CodeRelation rows — endpoints are untouched.
 */
export const deleteAllInjects = async (): Promise<{ edgesDeleted: number }> =>
  deleteAllRelationshipsOfType('INJECTS', 'di', 'duplicate INJECTS edges');

// ============================================================================
// Full-Text Search (FTS) Functions
// ============================================================================

/**
 * Load the FTS extension on the supplied connection (or the singleton
 * writable connection when none is given).
 *
 * Delegates to the shared `ExtensionManager` so install policy (auto /
 * load-only / never), out-of-process bounded INSTALL, and capability
 * caching are owned in one place. The module-level `ftsLoaded` flag is
 * kept purely as a per-call short-circuit on the singleton writable
 * connection so repeated callers (e.g. createFTSIndex) avoid an extra
 * `LOAD` round-trip per invocation. Pool adapter callers pass
 * `{ policy: 'load-only' }` so query paths never block on a network install.
 */
export const loadFTSExtension = async (
  targetConn?: lbug.Connection,
  opts: ExtensionEnsureOptions = {},
): Promise<boolean> => {
  const useModuleState = targetConn === undefined;
  if (useModuleState && ftsLoaded) return true;

  const c: lbug.Connection | null = targetConn ?? conn;
  if (!c) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const loaded = await extensionManager.ensure((sql) => queryAndDrain(c, sql), 'fts', 'FTS', opts);
  if (loaded && useModuleState) ftsLoaded = true;
  return loaded;
};

/**
 * Load the VECTOR extension on the supplied connection (or the singleton
 * writable connection when none is given). Returns false when VECTOR is
 * unavailable so semantic search can fall back to exact scan.
 */
export const loadVectorExtension = async (
  targetConn?: lbug.Connection,
  opts: ExtensionEnsureOptions = {},
): Promise<boolean> => {
  const useModuleState = targetConn === undefined;
  if (useModuleState && vectorExtensionLoaded) return true;
  // INSTALL VECTOR crashes with SIGSEGV on Windows: the KuzuDB native extension
  // installer has an unhandled error path on Windows that raises a fatal signal
  // that JS try/catch cannot intercept. Skip loading — vector/embedding search
  // is unavailable but all graph index queries still work. Do NOT set
  // vectorExtensionLoaded here: the flag means "successfully loaded", and a
  // subsequent call would otherwise short-circuit to `return true` at the top.
  if (process.platform === 'win32') return false;
  if (!isVectorExtensionSupportedByPlatform()) return false;

  const c: lbug.Connection | null = targetConn ?? conn;
  if (!c) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const loaded = await extensionManager.ensure(
    (sql) => queryAndDrain(c, sql),
    'VECTOR',
    'VECTOR',
    opts,
  );
  if (loaded && useModuleState) vectorExtensionLoaded = true;
  return loaded;
};
/**
 * Default stemmer for FTS indexes. Single source so the analyze path
 * (`getSearchFTSStemmer`) and the read-only `createFTSIndex`/`ensureFTSIndex`
 * defaults can never silently diverge.
 */
export const DEFAULT_FTS_STEMMER = 'porter';

/**
 * Create a full-text search index on a table
 * @param tableName - The node table name (e.g., 'File', 'CodeSymbol')
 * @param indexName - Name for the FTS index
 * @param properties - List of properties to index (e.g., ['name', 'code'])
 * @param stemmer - Stemming algorithm (default: 'porter')
 */
export const createFTSIndex = async (
  tableName: string,
  indexName: string,
  properties: string[],
  stemmer: string = DEFAULT_FTS_STEMMER,
): Promise<void> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const key = ftsIndexKey(tableName, indexName);
  if (ensuredFTSIndexes.has(key)) return;

  if (!(await loadFTSExtension())) {
    throw new Error(
      `FTS extension unavailable - cannot create FTS index ${tableName}.${indexName}. ` +
        'Run `gitnexus doctor` and ensure the LadybugDB FTS extension is installed and loadable on this machine.',
    );
  }

  const propList = properties.map((p) => `'${p}'`).join(', ');
  const query = `CALL CREATE_FTS_INDEX('${tableName}', '${indexName}', [${propList}], stemmer := '${stemmer}')`;

  try {
    await queryAndDrain(conn, query);
    ensuredFTSIndexes.add(key);
  } catch (e: any) {
    if (e.message?.includes('already exists')) {
      ensuredFTSIndexes.add(key);
      return;
    }
    throw e;
  }
};

/**
 * Create the HNSW vector index on the CodeEmbedding table.
 *
 * MUST run via `conn.query()` (here through `queryAndDrain`), NOT through the
 * prepared `executeQuery`/`conn.prepare()` path: `CALL CREATE_VECTOR_INDEX(...)`
 * compiles to multiple statements, which LadybugDB cannot prepare — it fails
 * with "Connection Exception: We do not support prepare multiple statements."
 * Routing index creation through `executeQuery` (prepared) is exactly what
 * broke vector-index creation during `analyze` (#2114; the singleton
 * `executeQuery` was switched to the prepared path in #1655 while FTS index
 * creation kept using `conn.query()`, which is why FTS survived and VECTOR did
 * not). Mirrors `createFTSIndex` above.
 *
 * Returns `true` on success (or when the index already exists — idempotent so
 * incremental re-runs don't spuriously downgrade to exact scan), `false` when
 * the VECTOR extension is unavailable or the connection is read-only. Any other
 * failure propagates so the caller can log it.
 */
export const createVectorIndex = async (): Promise<boolean> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  // Already built on this connection — skip the round-trip (mirrors createFTSIndex).
  if (vectorIndexEnsured) return true;
  if (!(await loadVectorExtension())) {
    return false;
  }
  try {
    await queryAndDrain(conn, CREATE_VECTOR_INDEX_QUERY);
    vectorIndexEnsured = true;
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Idempotent: a prior analyze already built the HNSW index.
    if (msg.includes('already exists')) {
      vectorIndexEnsured = true;
      return true;
    }
    // Read-only DB (e.g. the MCP query pool): writable analyze owns creation.
    if (isReadOnlyDbError(e)) return false;
    throw e;
  }
};

/**
 * Lazy-create an FTS index, caching the fact in-process.
 *
 * Kept for writable maintenance paths that need to lazily materialize an
 * index. Read-only query paths must not call this; production analysis owns
 * creating the configured search indexes before the database is served.
 *
 * Safe to call repeatedly — the in-process Set guarantees only the first
 * call hits LadybugDB. `closeLbug` clears the cache so re-init starts fresh.
 *
 * Defense in depth: if the active connection is read-only (e.g. the MCP
 * pool adapter), `CREATE_FTS_INDEX` will fail with "Cannot execute write
 * operations in a read-only database". Treat that as a no-op and cache
 * the key so callers don't loop on a path that can never succeed here —
 * the index is owned by `gitnexus analyze` (writable) and either already
 * exists or will be created on the next analyze.
 */
export const ensureFTSIndex = async (
  tableName: string,
  indexName: string,
  properties: string[],
  stemmer: string = DEFAULT_FTS_STEMMER,
): Promise<void> => {
  const key = ftsIndexKey(tableName, indexName);
  if (ensuredFTSIndexes.has(key)) return;
  try {
    await createFTSIndex(tableName, indexName, properties, stemmer);
  } catch (e) {
    // Read-only DB: writable analyze owns index creation; silently skip
    // and cache so callers don't loop on a path that can never succeed
    // here (the MCP query pool opens DBs read-only by design).
    if (isReadOnlyDbError(e)) {
      ensuredFTSIndexes.add(key);
      return;
    }
    throw e;
  }
};

/**
 * Query a full-text search index
 * @param tableName - The node table name
 * @param indexName - FTS index name
 * @param query - Search query string
 * @param limit - Maximum results
 * @param conjunctive - If true, all terms must match (AND); if false, any term matches (OR)
 * @returns Array of { node properties, score }
 */
export const queryFTS = async (
  tableName: string,
  indexName: string,
  query: string,
  limit: number = 20,
  conjunctive: boolean = false,
): Promise<
  Array<{ nodeId: string; name: string; filePath: string; score: number; [key: string]: any }>
> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', $query, conjunctive := ${conjunctive})
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;

  try {
    const rows = await executePrepared(cypher, { query });

    return rows.map((row: any) => {
      const node = row.node || row[0] || {};
      const score = row.score ?? row[1] ?? 0;
      return {
        nodeId: node.nodeId || node.id || '',
        name: node.name || '',
        filePath: node.filePath || '',
        score: typeof score === 'number' ? score : parseFloat(score) || 0,
        ...node,
      };
    });
  } catch (e: any) {
    // Return empty if index doesn't exist yet
    if (e.message?.includes('does not exist')) {
      return [];
    }
    throw e;
  }
};

/**
 * Drop an FTS index
 */
export const dropFTSIndex = async (tableName: string, indexName: string): Promise<void> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  try {
    await queryAndDrain(conn, `CALL DROP_FTS_INDEX('${tableName}', '${indexName}')`);
  } catch {
    // Index may not exist
  } finally {
    ensuredFTSIndexes.delete(ftsIndexKey(tableName, indexName));
  }
};
