import fs from 'fs/promises';
import { createReadStream, createWriteStream, constants as fsConstants } from 'fs';
import { createInterface } from 'readline';
import { once } from 'events';
import { finished } from 'stream/promises';
import path from 'path';
import lbug from '@ladybugdb/core';
import { KnowledgeGraph } from '../graph/types.js';
import {
  NODE_TABLES,
  REL_TABLE_NAME,
  SCHEMA_QUERIES,
  EMBEDDING_TABLE_NAME,
  STALE_HASH_SENTINEL,
  NodeTableName,
} from './schema.js';
import { streamAllCSVsToDisk } from './csv-generator.js';
import type { CachedEmbedding } from '../embeddings/types.js';
import { extensionManager, type ExtensionEnsureOptions } from './extension-loader.js';
import {
  closeLbugConnection,
  isDbBusyError,
  isOpenRetryExhausted,
  openLbugConnection,
  waitForWindowsHandleRelease,
  type LbugConnectionHandle,
} from './lbug-config.js';
import { isVectorExtensionSupportedByPlatform } from '../platform/capabilities.js';

import { logger } from '../logger.js';
// ---------------------------------------------------------------------------
// Relationship CSV splitting — extracted for testability (PR #818)
// ---------------------------------------------------------------------------

/** Factory for creating WriteStreams — injectable for testing. */
export type WriteStreamFactory = (filePath: string) => import('fs').WriteStream;

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
let currentDbPath: string | null = null;
let ftsLoaded = false;
let vectorExtensionLoaded = false;

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
  const msg = err instanceof Error ? err.message : String(err);
  return /read-only database/i.test(msg);
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

const normalizeCopyPath = (filePath: string): string => filePath.replace(/\\/g, '/');

const closeQueryResult = async (result: lbug.QueryResult): Promise<void> => {
  try {
    await result.close();
  } catch {
    // Best-effort cleanup only.
  }
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
  const queryResult = await targetConn.query(cypher);
  await drainQueryResult(queryResult);
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
export const withLbugDb = async <T>(dbPath: string, operation: () => Promise<T>): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DB_LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await runWithSessionLock(async () => {
        await ensureLbugInitialized(dbPath);
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

const ensureLbugInitialized = async (dbPath: string) => {
  if (conn && currentDbPath === dbPath) {
    return { db, conn };
  }
  await doInitLbug(dbPath);
  return { db, conn };
};

const doInitLbug = async (dbPath: string) => {
  // Different database requested — close the old one first
  if (conn || db) {
    await safeClose();
    currentDbPath = null;
    ftsLoaded = false;
    vectorExtensionLoaded = false;
    ensuredFTSIndexes.clear();
  }

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

  // ---------------------------------------------------------------------------
  // Cross-process critical section: acquire init lock, clean orphan sidecars,
  // and open the database. The lock prevents a TOCTOU race where another
  // process could create a fresh DB between our access() check and the
  // unlink() of stale sidecars.
  // ---------------------------------------------------------------------------
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

    const opened = await openLbugConnection(lbug, dbPath);
    db = opened.db;
    conn = opened.conn;
  } finally {
    await releaseInitLock();
  }

  for (const schemaQuery of SCHEMA_QUERIES) {
    try {
      await queryAndDrain(conn, schemaQuery);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Suppression list:
      //   - "already exists": expected idempotent re-create on existing DBs
      //   - "could not set lock on file": LadybugDB v0.16.1 emits this on
      //     Windows when CREATE NODE TABLE runs against a path that was
      //     just opened (the WAL handle from a fresh Database briefly
      //     contests the table's first-write lock). The table is created
      //     anyway and any genuine cross-process lock contention surfaces
      //     on the next operation via withLbugDb's retry. Logging it here
      //     would just be noise in CI.
      if (!msg.includes('already exists') && !isDbBusyError(err)) {
        logger.warn(`⚠️ Schema creation warning: ${msg.slice(0, 120)}`);
      }
    }
  }

  // FTS powers baseline search, so initialize it with the core DB. VECTOR is
  // only required for semantic embeddings and is probed lazily there.
  await loadFTSExtension();

  currentDbPath = dbPath;
  return { db, conn };
};

export type LbugProgressCallback = (message: string) => void;

export const loadGraphToLbug = async (
  graph: KnowledgeGraph,
  repoPath: string,
  storagePath: string,
  onProgress?: LbugProgressCallback,
) => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const log = onProgress || (() => {});

  const csvDir = path.join(storagePath, 'csv');

  log('Streaming CSVs to disk...');
  const csvResult = await streamAllCSVsToDisk(graph, repoPath, csvDir);

  const validTables = new Set<string>(NODE_TABLES as readonly string[]);
  const getNodeLabel = (nodeId: string): string => {
    if (nodeId.startsWith('comm_')) return 'Community';
    if (nodeId.startsWith('proc_')) return 'Process';
    return nodeId.split(':')[0];
  };

  // Bulk COPY all node CSVs (sequential — LadybugDB allows only one write txn at a time)
  const nodeFiles = [...csvResult.nodeFiles.entries()];
  const totalSteps = nodeFiles.length + 1; // +1 for relationships
  let stepsDone = 0;

  for (const [table, { csvPath, rows }] of nodeFiles) {
    stepsDone++;
    log(`Loading nodes ${stepsDone}/${totalSteps}: ${table} (${rows.toLocaleString()} rows)`);

    const normalizedPath = normalizeCopyPath(csvPath);
    const copyQuery = getCopyQuery(table, normalizedPath);

    try {
      await queryAndDrain(conn, copyQuery);
    } catch (err) {
      try {
        const retryQuery = copyQuery.replace(
          'auto_detect=false)',
          'auto_detect=false, IGNORE_ERRORS=true)',
        );
        await queryAndDrain(conn, retryQuery);
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        throw new Error(`COPY failed for ${table}: ${retryMsg.slice(0, 200)}`);
      }
    }
  }

  // Bulk COPY relationships — split by FROM→TO label pair (LadybugDB requires it)
  const { relHeader, relsByPairMeta, pairWriteStreams, skippedRels, totalValidRels } =
    await splitRelCsvByLabelPair(csvResult.relCsvPath, csvDir, validTables, getNodeLabel);

  // Close all per-pair write streams before COPY. `stream/promises.finished`
  // resolves on the stream's 'finish' event and rejects on 'error' — replaces
  // a hand-rolled promisification with the stdlib primitive.
  await Promise.all(
    Array.from(pairWriteStreams.values()).map(async (ws) => {
      ws.end();
      await finished(ws);
    }),
  );

  const insertedRels = totalValidRels;
  const warnings: string[] = [];
  if (insertedRels > 0) {
    log(`Loading edges: ${insertedRels.toLocaleString()} across ${relsByPairMeta.size} types`);

    let pairIdx = 0;
    let failedPairEdges = 0;
    const failedPairCsvPaths = new Set<string>();

    for (const [pairKey, { csvPath: pairCsvPath, rows }] of relsByPairMeta) {
      pairIdx++;
      const [fromLabel, toLabel] = pairKey.split('|');
      const normalizedPath = normalizeCopyPath(pairCsvPath);
      const copyQuery = `COPY ${REL_TABLE_NAME} FROM "${normalizedPath}" (from="${fromLabel}", to="${toLabel}", HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`;

      if (pairIdx % 5 === 0 || rows > 1000) {
        log(`Loading edges: ${pairIdx}/${relsByPairMeta.size} types (${fromLabel} -> ${toLabel})`);
      }

      try {
        await queryAndDrain(conn, copyQuery);
      } catch (err) {
        try {
          const retryQuery = copyQuery.replace(
            'auto_detect=false)',
            'auto_detect=false, IGNORE_ERRORS=true)',
          );
          await queryAndDrain(conn, retryQuery);
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          warnings.push(`${fromLabel}->${toLabel} (${rows} edges): ${retryMsg.slice(0, 80)}`);
          failedPairEdges += rows;
          failedPairCsvPaths.add(pairCsvPath);
        }
      }
      // Only delete if not in failedPairCsvPaths (needed for fallback)
      if (!failedPairCsvPaths.has(pairCsvPath)) {
        try {
          await fs.unlink(pairCsvPath);
        } catch {}
      }
    }

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
        await fallbackRelationshipInserts(allLines, validTables, getNodeLabel);
      }
    }
  }

  // Cleanup all CSVs
  try {
    await fs.unlink(csvResult.relCsvPath);
  } catch {}
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

  return { success: true, insertedRels, skippedRels, warnings };
};

// LadybugDB default ESCAPE is '\' (backslash), but our CSV uses RFC 4180 escaping ("" for literal quotes).
// Source code content is full of backslashes which confuse the auto-detection.
// We MUST explicitly set ESCAPE='"' to use RFC 4180 escaping, and disable auto_detect to prevent
// LadybugDB from overriding our settings based on sample rows.
const COPY_CSV_OPTS = `(HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`;

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

/** Fallback: insert relationships one-by-one if COPY fails */
const fallbackRelationshipInserts = async (
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

      const esc = (s: string) =>
        s.replace(/'/g, "''").replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      await queryAndDrain(
        conn,
        `
        MATCH (a:${escapeLabel(fromLabel)} {id: '${esc(fromId)}' }),
              (b:${escapeLabel(toLabel)} {id: '${esc(toId)}' })
        CREATE (a)-[:${REL_TABLE_NAME} {type: '${esc(relType)}', confidence: ${confidence}, reason: '${esc(reason)}', step: ${step}}]->(b)
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

const getCopyQuery = (table: NodeTableName, filePath: string): string => {
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
    return `COPY ${t}(id, name, filePath, responseKeys, errorKeys, middleware) FROM "${filePath}" ${COPY_CSV_OPTS}`;
  }
  if (table === 'Tool') {
    return `COPY ${t}(id, name, filePath, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
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
    const escapeValue = (v: any): string => {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number') return String(v);
      // Escape backslashes first (for Windows paths), then single quotes
      return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
    };

    // Build INSERT query based on node type
    const t = escapeTableName(label);
    let query: string;

    if (label === 'File') {
      query = `CREATE (n:File {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, content: ${escapeValue(properties.content || '')}})`;
    } else if (label === 'Folder') {
      query = `CREATE (n:Folder {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}})`;
    } else if (label === 'Section') {
      const descPart = properties.description
        ? `, description: ${escapeValue(properties.description)}`
        : '';
      query = `CREATE (n:Section {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, level: ${properties.level || 1}, content: ${escapeValue(properties.content || '')}${descPart}})`;
    } else if (TABLES_WITH_EXPORTED.has(label)) {
      const descPart = properties.description
        ? `, description: ${escapeValue(properties.description)}`
        : '';
      query = `CREATE (n:${t} {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, isExported: ${!!properties.isExported}, content: ${escapeValue(properties.content || '')}${descPart}})`;
    } else if (label === 'Property') {
      const descPart = properties.description
        ? `, description: ${escapeValue(properties.description)}`
        : '';
      query = `CREATE (n:${t} {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, content: ${escapeValue(properties.content || '')}${descPart}, declaredType: ${escapeValue(properties.declaredType || '')}})`;
    } else {
      // Multi-language tables (Struct, Impl, Trait, Macro, etc.) — no isExported
      const descPart = properties.description
        ? `, description: ${escapeValue(properties.description)}`
        : '';
      query = `CREATE (n:${t} {id: ${escapeValue(properties.id)}, name: ${escapeValue(properties.name)}, filePath: ${escapeValue(properties.filePath)}, startLine: ${properties.startLine || 0}, endLine: ${properties.endLine || 0}, content: ${escapeValue(properties.content || '')}${descPart}})`;
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

  const escapeValue = (v: any): string => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    // Escape backslashes first (for Windows paths), then single quotes, then newlines
    return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
  };

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
          query = `MERGE (n:File {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.content = ${escapeValue(properties.content || '')}`;
        } else if (label === 'Folder') {
          query = `MERGE (n:Folder {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}`;
        } else if (label === 'Section') {
          const descPart = properties.description
            ? `, n.description = ${escapeValue(properties.description)}`
            : '';
          query = `MERGE (n:Section {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.level = ${properties.level || 1}, n.content = ${escapeValue(properties.content || '')}${descPart}`;
        } else if (TABLES_WITH_EXPORTED.has(label)) {
          const descPart = properties.description
            ? `, n.description = ${escapeValue(properties.description)}`
            : '';
          query = `MERGE (n:${t} {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.isExported = ${!!properties.isExported}, n.content = ${escapeValue(properties.content || '')}${descPart}`;
        } else if (label === 'Property') {
          const descPart = properties.description
            ? `, n.description = ${escapeValue(properties.description)}`
            : '';
          query = `MERGE (n:${t} {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.content = ${escapeValue(properties.content || '')}${descPart}, n.declaredType = ${escapeValue(properties.declaredType || '')}`;
        } else {
          const descPart = properties.description
            ? `, n.description = ${escapeValue(properties.description)}`
            : '';
          query = `MERGE (n:${t} {id: ${escapeValue(properties.id)}}) SET n.name = ${escapeValue(properties.name)}, n.filePath = ${escapeValue(properties.filePath)}, n.startLine = ${properties.startLine || 0}, n.endLine = ${properties.endLine || 0}, n.content = ${escapeValue(properties.content || '')}${descPart}`;
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
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const queryResult = await conn.query(cypher);
  return await readQueryRows(queryResult);
};

export const streamQuery = async (
  cypher: string,
  onRow: (row: any) => void | Promise<void>,
): Promise<number> => {
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
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  const stmt = await conn.prepare(cypher);
  if (!stmt.isSuccess()) {
    const errMsg = await stmt.getErrorMessage();
    throw new Error(`Prepare failed: ${errMsg}`);
  }
  const queryResult = await conn.execute(stmt, params);
  return await readQueryRows(queryResult);
};

export const executeWithReusedStatement = async (
  cypher: string,
  paramsList: Array<Record<string, any>>,
): Promise<void> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  if (paramsList.length === 0) return;

  const SUB_BATCH_SIZE = 4;
  for (let i = 0; i < paramsList.length; i += SUB_BATCH_SIZE) {
    const subBatch = paramsList.slice(i, i + SUB_BATCH_SIZE);
    const stmt = await conn.prepare(cypher);
    if (!stmt.isSuccess()) {
      const errMsg = await stmt.getErrorMessage();
      throw new Error(`Prepare failed: ${errMsg}`);
    }
    try {
      for (const params of subBatch) {
        await drainQueryResult(await conn.execute(stmt, params));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const queryPreview = cypher.replace(/\s+/g, ' ').slice(0, 120);
      throw new Error(
        `Batch execution failed for rows ${i + 1}-${i + subBatch.length}: ${msg} (${queryPreview})`,
      );
    }
    // Note: LadybugDB PreparedStatement doesn't require explicit close()
  }
};

export const getLbugStats = async (): Promise<{ nodes: number; edges: number }> => {
  if (!conn) return { nodes: 0, edges: 0 };

  let totalNodes = 0;
  for (const tableName of NODE_TABLES) {
    try {
      const queryResult = await conn.query(
        `MATCH (n:${escapeTableName(tableName)}) RETURN count(n) AS cnt`,
      );
      const nodeRows = await readQueryRows(queryResult);
      if (nodeRows.length > 0) {
        totalNodes += Number(nodeRows[0]?.cnt ?? nodeRows[0]?.[0] ?? 0);
      }
    } catch {
      // ignore
    }
  }

  let totalEdges = 0;
  try {
    const queryResult = await conn.query(
      `MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS cnt`,
    );
    const edgeRows = await readQueryRows(queryResult);
    if (edgeRows.length > 0) {
      totalEdges = Number(edgeRows[0]?.cnt ?? edgeRows[0]?.[0] ?? 0);
    }
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
  if (!conn) {
    return { embeddingNodeIds: new Set(), embeddings: [] };
  }

  const embeddingNodeIds = new Set<string>();
  const embeddings: CachedEmbedding[] = [];
  try {
    // Schema migration detection: query with new columns to verify schema version.
    // Old schema only had (nodeId, embedding); new schema adds (id, chunkIndex, startLine, endLine, contentHash).
    // If the query fails (column missing), we return empty cache to force a full rebuild.
    try {
      const check = await conn.query(
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
      rows = await conn.query(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding, e.contentHash AS contentHash`,
      );
    } catch (err: any) {
      // Fallback for legacy DBs without contentHash column
      const msg = err?.message ?? '';
      if (isMissingColumnOrTableError(msg)) {
        hasContentHash = false;
        rows = await conn.query(
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
  if (!conn) return;
  try {
    const checkpointResult = await conn.query('CHECKPOINT');
    await drainQueryResult(checkpointResult);
  } catch {
    /* ignore — older LadybugDB or schemaless DB may not accept it */
  }
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
};

export const closeLbug = async (): Promise<void> => {
  await safeClose();
  currentDbPath = null;
  ftsLoaded = false;
  vectorExtensionLoaded = false;
  ensuredFTSIndexes.clear();
};

export const isLbugReady = (): boolean => conn !== null && db !== null;

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
    const escapedPath = filePath.replace(/'/g, "''");

    // Delete nodes from each table that has filePath
    // DETACH DELETE removes the node and all its relationships
    for (const tableName of NODE_TABLES) {
      // Skip tables that don't have filePath (Community, Process)
      if (tableName === 'Community' || tableName === 'Process') continue;

      try {
        // First count how many we'll delete
        const tn = escapeTableName(tableName);
        const countResult = await targetConn!.query(
          `MATCH (n:${tn}) WHERE n.filePath = '${escapedPath}' RETURN count(n) AS cnt`,
        );
        const rows = await readQueryRows(countResult);
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

    // Also delete any embeddings for nodes in this file
    try {
      await queryAndDrain(
        targetConn!,
        `MATCH (e:${EMBEDDING_TABLE_NAME}) WHERE e.nodeId STARTS WITH '${escapedPath}' DELETE e`,
      );
    } catch {
      // Embedding table may not exist or nodeId format may differ
    }

    return { deletedNodes };
  } finally {
    // Close per-query connection if used
    if (tempHandle) await closeLbugConnection(tempHandle);
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
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  const escaped = targetFilePath.replace(/'/g, "''");
  const cypher = `
    MATCH (a)-[r:${REL_TABLE_NAME}]->(b)
    WHERE r.type = 'IMPORTS' AND b.filePath = '${escaped}'
    RETURN DISTINCT a.filePath AS importer
  `;
  try {
    const queryResult = await conn.query(cypher);
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
  }
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
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }
  let nodesDeleted = 0;
  for (const label of ['Community', 'Process']) {
    try {
      const countResult = await conn.query(`MATCH (n:${label}) RETURN count(n) AS cnt`);
      const result = Array.isArray(countResult) ? countResult[0] : countResult;
      const rows = await result.getAll();
      const count = Number(rows[0]?.cnt ?? rows[0]?.[0] ?? 0);
      if (count > 0) {
        await conn.query(`MATCH (n:${label}) DETACH DELETE n`);
        nodesDeleted += count;
      }
    } catch {
      // Table may not exist yet on a freshly-initialized DB — fine.
    }
  }
  return { nodesDeleted };
};

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
  stemmer: string = 'porter',
): Promise<void> => {
  if (!conn) {
    throw new Error('LadybugDB not initialized. Call initLbug first.');
  }

  const key = ftsIndexKey(tableName, indexName);
  if (ensuredFTSIndexes.has(key)) return;

  if (!(await loadFTSExtension())) {
    return;
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
  stemmer: string = 'porter',
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

  // Escape backslashes and single quotes to prevent Cypher injection
  const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "''");

  const cypher = `
    CALL QUERY_FTS_INDEX('${tableName}', '${indexName}', '${escapedQuery}', conjunctive := ${conjunctive})
    RETURN node, score
    ORDER BY score DESC
    LIMIT ${limit}
  `;

  try {
    const queryResult = await conn.query(cypher);
    const rows = await readQueryRows(queryResult);

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
