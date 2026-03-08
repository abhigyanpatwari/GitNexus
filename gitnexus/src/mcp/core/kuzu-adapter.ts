/**
 * KuzuDB Adapter (Connection Pool)
 * 
 * Manages a pool of KuzuDB databases keyed by repoId, each with
 * multiple Connection objects for safe concurrent query execution.
 * 
 * KuzuDB Connections are NOT thread-safe — a single Connection
 * segfaults if concurrent .query() calls hit it simultaneously.
 * This adapter provides a checkout/return connection pool so each
 * concurrent query gets its own Connection from the same Database.
 * 
 * @see https://docs.kuzudb.com/concurrency — multiple Connections
 * from the same Database is the officially supported concurrency pattern.
 */

import fs from 'fs/promises';
import kuzu from 'kuzu';

/** Per-repo pool: one Database, many Connections */
interface PoolEntry {
  db: kuzu.Database;
  /** Available connections ready for checkout */
  available: kuzu.Connection[];
  /** Number of connections currently checked out */
  checkedOut: number;
  /** Queued waiters for when all connections are busy */
  waiters: Array<(conn: kuzu.Connection) => void>;
  lastUsed: number;
  dbPath: string;
}

const pool = new Map<string, PoolEntry>();

/** Max repos in the pool (LRU eviction) */
const MAX_POOL_SIZE = 5;
/** Idle timeout before closing a repo's connections */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** Max connections per repo (caps concurrent queries per repo) */
const MAX_CONNS_PER_REPO = 8;
/** Connections created eagerly on init */
const INITIAL_CONNS_PER_REPO = 2;

let idleTimer: ReturnType<typeof setInterval> | null = null;

/** Saved real stdout.write — used to silence KuzuDB native output without race conditions */
const realStdoutWrite = process.stdout.write.bind(process.stdout);
let stdoutSilenceCount = 0;

/**
 * Start the idle cleanup timer (runs every 60s)
 */
function ensureIdleTimer(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => {
    const now = Date.now();
    for (const [repoId, entry] of pool) {
      if (now - entry.lastUsed > IDLE_TIMEOUT_MS && entry.checkedOut === 0) {
        closeOne(repoId);
      }
    }
  }, 60_000);
  if (idleTimer && typeof idleTimer === 'object' && 'unref' in idleTimer) {
    (idleTimer as NodeJS.Timeout).unref();
  }
}

/**
 * Evict the least-recently-used repo if pool is at capacity
 */
function evictLRU(): void {
  if (pool.size < MAX_POOL_SIZE) return;

  let oldestId: string | null = null;
  let oldestTime = Infinity;
  for (const [id, entry] of pool) {
    if (entry.checkedOut === 0 && entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed;
      oldestId = id;
    }
  }
  if (oldestId) {
    closeOne(oldestId);
  }
}

/**
 * Remove a repo from the pool without calling native close methods.
 *
 * KuzuDB's native .closeSync() triggers N-API destructor hooks that
 * segfault on Linux/macOS.  Pool databases are opened read-only, so
 * there is no WAL to flush — just deleting the pool entry and letting
 * the GC (or process exit) reclaim native resources is safe.
 */
function closeOne(repoId: string): void {
  pool.delete(repoId);
}

/**
 * Create a new Connection from a repo's Database.
 * Silences stdout to prevent native module output from corrupting MCP stdio.
 */
function silenceStdout(): void {
  if (stdoutSilenceCount++ === 0) {
    process.stdout.write = (() => true) as any;
  }
}

function restoreStdout(): void {
  if (--stdoutSilenceCount <= 0) {
    stdoutSilenceCount = 0;
    process.stdout.write = realStdoutWrite;
  }
}

function createConnection(db: kuzu.Database): kuzu.Connection {
  silenceStdout();
  try {
    return new kuzu.Connection(db);
  } finally {
    restoreStdout();
  }
}

/** Query timeout in milliseconds */
const QUERY_TIMEOUT_MS = 30_000;
/** Waiter queue timeout in milliseconds */
const WAITER_TIMEOUT_MS = 15_000;

const LOCK_RETRY_ATTEMPTS = 3;
const LOCK_RETRY_DELAY_MS = 2000;

/**
 * Initialize (or reuse) a Database + connection pool for a specific repo.
 * Retries on lock errors (e.g., when `gitnexus analyze` is running).
 */
export const initKuzu = async (repoId: string, dbPath: string): Promise<void> => {
  const existing = pool.get(repoId);
  if (existing) {
    existing.lastUsed = Date.now();
    return;
  }

  // Check if database exists
  try {
    await fs.stat(dbPath);
  } catch {
    throw new Error(`KuzuDB not found at ${dbPath}. Run: gitnexus analyze`);
  }

  evictLRU();

  // Open in read-only mode — MCP server never writes to the database.
  // This allows multiple MCP server instances to read concurrently, and
  // avoids lock conflicts when `gitnexus analyze` is writing.
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt++) {
    silenceStdout();
    try {
      const db = new kuzu.Database(
        dbPath,
        0,     // bufferManagerSize (default)
        false, // enableCompression (default)
        true,  // readOnly
      );
      restoreStdout();

      // Pre-create a small pool of connections
      const available: kuzu.Connection[] = [];
      for (let i = 0; i < INITIAL_CONNS_PER_REPO; i++) {
        available.push(createConnection(db));
      }

      pool.set(repoId, { db, available, checkedOut: 0, waiters: [], lastUsed: Date.now(), dbPath });
      ensureIdleTimer();
      return;
    } catch (err: any) {
      restoreStdout();
      lastError = err instanceof Error ? err : new Error(String(err));
      const isLockError = lastError.message.includes('Could not set lock')
        || lastError.message.includes('lock');
      if (!isLockError || attempt === LOCK_RETRY_ATTEMPTS) break;
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_DELAY_MS * attempt));
    }
  }

  throw new Error(
    `KuzuDB unavailable for ${repoId}. Another process may be rebuilding the index. ` +
    `Retry later. (${lastError?.message || 'unknown error'})`
  );
};

/**
 * Checkout a connection from the pool.
 * Returns an available connection, or creates a new one if under the cap.
 * If all connections are busy and at cap, queues the caller until one is returned.
 */
function checkout(entry: PoolEntry): Promise<kuzu.Connection> {
  // Fast path: grab an available connection
  if (entry.available.length > 0) {
    entry.checkedOut++;
    return Promise.resolve(entry.available.pop()!);
  }

  // Grow the pool if under the cap
  const totalConns = entry.available.length + entry.checkedOut;
  if (totalConns < MAX_CONNS_PER_REPO) {
    entry.checkedOut++;
    return Promise.resolve(createConnection(entry.db));
  }

  // At capacity — queue the caller with a timeout.
  return new Promise<kuzu.Connection>((resolve, reject) => {
    const waiter = (conn: kuzu.Connection) => {
      clearTimeout(timer);
      resolve(conn);
    };
    const timer = setTimeout(() => {
      const idx = entry.waiters.indexOf(waiter);
      if (idx !== -1) entry.waiters.splice(idx, 1);
      reject(new Error(`Connection pool exhausted: timed out after ${WAITER_TIMEOUT_MS}ms waiting for a free connection`));
    }, WAITER_TIMEOUT_MS);
    entry.waiters.push(waiter);
  });
}

/**
 * Return a connection to the pool after use.
 * If there are queued waiters, hand the connection directly to the next one
 * instead of putting it back in the available array (avoids race conditions).
 */
function checkin(entry: PoolEntry, conn: kuzu.Connection): void {
  if (entry.waiters.length > 0) {
    // Hand directly to the next waiter — no intermediate available state
    const waiter = entry.waiters.shift()!;
    waiter(conn);
  } else {
    entry.checkedOut--;
    entry.available.push(conn);
  }
}

/**
 * Execute a query on a specific repo's connection pool.
 * Automatically checks out a connection, runs the query, and returns it.
 */
/** Race a promise against a timeout */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const executeQuery = async (repoId: string, cypher: string): Promise<any[]> => {
  const entry = pool.get(repoId);
  if (!entry) {
    throw new Error(`KuzuDB not initialized for repo "${repoId}". Call initKuzu first.`);
  }

  entry.lastUsed = Date.now();

  const conn = await checkout(entry);
  try {
    const queryResult = await withTimeout(conn.query(cypher), QUERY_TIMEOUT_MS, 'Query');
    const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    const rows = await result.getAll();
    return rows;
  } finally {
    checkin(entry, conn);
  }
};

/**
 * Execute a parameterized query on a specific repo's connection pool.
 * Uses prepare/execute pattern to prevent Cypher injection.
 */
export const executeParameterized = async (
  repoId: string,
  cypher: string,
  params: Record<string, any>,
): Promise<any[]> => {
  const entry = pool.get(repoId);
  if (!entry) {
    throw new Error(`KuzuDB not initialized for repo "${repoId}". Call initKuzu first.`);
  }

  entry.lastUsed = Date.now();

  const conn = await checkout(entry);
  try {
    const stmt = await withTimeout(conn.prepare(cypher), QUERY_TIMEOUT_MS, 'Prepare');
    if (!stmt.isSuccess()) {
      const errMsg = await stmt.getErrorMessage();
      throw new Error(`Prepare failed: ${errMsg}`);
    }
    const queryResult = await withTimeout(conn.execute(stmt, params), QUERY_TIMEOUT_MS, 'Execute');
    const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    const rows = await result.getAll();
    return rows;
  } finally {
    checkin(entry, conn);
  }
};

/**
 * Close one or all repo pools.
 * If repoId is provided, close only that repo's connections.
 * If omitted, close all repos.
 */
export const closeKuzu = async (repoId?: string): Promise<void> => {
  if (repoId) {
    closeOne(repoId);
    return;
  }

  for (const id of [...pool.keys()]) {
    closeOne(id);
  }

  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
};


/**
 * Check if a specific repo's pool is active
 */
export const isKuzuReady = (repoId: string): boolean => pool.has(repoId);
