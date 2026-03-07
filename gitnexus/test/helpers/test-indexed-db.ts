/**
 * Test helper: Indexed KuzuDB lifecycle manager
 *
 * Uses a shared KuzuDB created by globalSetup (test/global-setup.ts).
 * Each test file clears all data, reseeds, and initializes adapters —
 * avoiding per-file schema creation overhead.
 *
 * IMPORTANT: Always use detachKuzu() for cleanup — it calls .close() to null
 * native shared_ptrs (fast for read-only pool DBs), then clears JS refs.
 * This makes N-API destructor hooks during process.exit() no-ops, preventing
 * the C++ destructor hang seen on Ubuntu CI.
 *
 * Each test file gets a unique repoId to prevent MCP pool map collisions.
 * Seed data is NOT included — each test provides its own via options.seed.
 */
import path from 'path';
import kuzu from 'kuzu';
import { describe, beforeAll, afterAll, inject } from 'vitest';
import type { TestDBHandle } from './test-db.js';
import {
  NODE_TABLES,
  EMBEDDING_TABLE_NAME,
  NODE_SCHEMA_QUERIES,
  REL_SCHEMA_QUERIES,
} from '../../src/core/kuzu/schema.js';
import { createTempDir } from './test-db.js';

export interface IndexedDBHandle {
  /** Path to the KuzuDB database file */
  dbPath: string;
  /** Unique repoId for MCP pool adapter — prevents cross-file collisions */
  repoId: string;
  /** Temp directory handle for filesystem cleanup */
  tmpHandle: TestDBHandle;
  /** Cleanup: detaches adapters (null-out, no native .close()) */
  cleanup: () => Promise<void>;
}

let repoCounter = 0;

/**
 * Create a temporary KuzuDB with full schema (node tables + relationship tables).
 * Returns a handle with dbPath, unique repoId, and cleanup function.
 *
 * NOTE: Most tests should use `withTestKuzuDB` which shares a global DB.
 * This function creates a fully isolated DB — use only when you need
 * a separate DB instance (e.g. testing adapter lifecycle).
 *
 * @param prefix - Temp directory prefix for identification in logs
 */
export async function createTestKuzuDB(prefix: string): Promise<IndexedDBHandle> {
  const { detachKuzu: detachCoreKuzu } = await import('../../src/core/kuzu/kuzu-adapter.js');
  const { detachKuzu: detachPoolKuzu } = await import('../../src/mcp/core/kuzu-adapter.js');

  const tmpHandle = await createTempDir(`${prefix}-`);
  const pathMod = await import('path');
  const dbPath = pathMod.join(tmpHandle.dbPath, 'kuzu');
  const repoId = `test-${prefix}-${Date.now()}-${repoCounter++}`;

  // Create writable DB with schema
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);

  for (const q of NODE_SCHEMA_QUERIES) {
    await conn.query(q);
  }
  for (const q of REL_SCHEMA_QUERIES) {
    await conn.query(q);
  }

  conn.close();
  db.close();

  const cleanup = async () => {
    // Close + detach adapter refs — .close() nulls native shared_ptrs
    // so N-API destructor hooks during process.exit() are no-ops
    try { detachCoreKuzu(); } catch { /* best-effort */ }
    try { detachPoolKuzu(); } catch { /* best-effort */ }
    try { await tmpHandle.cleanup(); } catch { /* best-effort */ }
  };

  return { dbPath, repoId, tmpHandle, cleanup };
}

/**
 * Insert seed data into a KuzuDB via direct connection.
 * Opens a writable connection, runs the provided queries, then closes.
 *
 * @param dbPath - Path to the KuzuDB database file
 * @param queries - Array of Cypher INSERT/CREATE queries
 */
export async function seedTestData(dbPath: string, queries: string[]): Promise<void> {
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  for (const q of queries) {
    await conn.query(q);
  }
  conn.close();
  db.close();
}

/** FTS index definition for withTestKuzuDB */
export interface FTSIndexDef {
  table: string;
  indexName: string;
  columns: string[];
}

/**
 * Options for withTestKuzuDB lifecycle.
 *
 * Lifecycle: initKuzu → loadFTS → dropFTS → clearData → seed
 *            → createFTS → [closeCoreKuzu + poolInitKuzu] → afterSetup
 */
export interface WithTestKuzuDBOptions {
  /** Cypher CREATE queries to insert seed data (runs before core adapter opens). */
  seed?: string[];
  /** FTS indexes to create after seeding. */
  ftsIndexes?: FTSIndexDef[];
  /** Close core adapter and open pool adapter (read-only) after FTS setup. */
  poolAdapter?: boolean;
  /** Run after all lifecycle phases complete (mocks, dynamic imports, etc). */
  afterSetup?: (handle: IndexedDBHandle) => Promise<void>;
  /** Timeout for beforeAll in ms (default: 30000). */
  timeout?: number;
}

/**
 * Manages the full KuzuDB test lifecycle using the shared global DB:
 * data clearing, reseeding, FTS indexes, adapter init/teardown.
 *
 * All data operations go through the core adapter's writable connection —
 * no raw kuzu.Database() connections are opened.  This avoids file-lock
 * conflicts with orphaned native objects from previous test files.
 *
 * Each call is wrapped in its own `describe` block to isolate lifecycle
 * hooks — safe to call multiple times in the same file.
 */
export function withTestKuzuDB(
  prefix: string,
  fn: (handle: IndexedDBHandle) => void,
  options?: WithTestKuzuDBOptions,
): void {
  const ref: { handle: IndexedDBHandle | undefined } = { handle: undefined };
  const timeout = options?.timeout ?? 30000;

  const setup = async () => {
    // Get shared DB path from globalSetup (created once with full schema)
    const dbPath = inject('kuzuDbPath');
    const repoId = `test-${prefix}-${Date.now()}-${repoCounter++}`;

    const adapter = await import('../../src/core/kuzu/kuzu-adapter.js');

    // 1. Init core adapter (writable) — reuses existing connection if
    //    already open for this dbPath (no new native objects created).
    await adapter.initKuzu(dbPath);

    // 2. Load FTS extension (idempotent — skips if already loaded)
    await adapter.loadFTSExtension();

    // 3. Drop stale FTS indexes from previous test file
    if (options?.ftsIndexes?.length) {
      for (const idx of options.ftsIndexes) {
        try { await adapter.dropFTSIndex(idx.table, idx.indexName); } catch { /* may not exist */ }
      }
    }

    // 4. Clear all data via adapter (DETACH DELETE cascades to relationships)
    for (const table of NODE_TABLES) {
      await adapter.executeQuery(`MATCH (n:\`${table}\`) DETACH DELETE n`);
    }
    await adapter.executeQuery(`MATCH (n:${EMBEDDING_TABLE_NAME}) DELETE n`);

    // 5. Seed new data via adapter
    if (options?.seed?.length) {
      for (const q of options.seed) {
        await adapter.executeQuery(q);
      }
    }

    // 6. Create FTS indexes on fresh data
    if (options?.ftsIndexes?.length) {
      for (const idx of options.ftsIndexes) {
        await adapter.createFTSIndex(idx.table, idx.indexName, idx.columns);
      }
    }

    // 7. Close core → open pool adapter (read-only)
    //    closeCoreKuzu() is safe here: it's during setup (within testTimeout),
    //    and was already used in the pre-shared-DB code.
    if (options?.poolAdapter) {
      await adapter.closeKuzu();
      const { initKuzu: poolInitKuzu } = await import('../../src/mcp/core/kuzu-adapter.js');
      await poolInitKuzu(repoId, dbPath);
    }

    // Build cleanup — detachKuzu() closes + nulls native refs (fast for read-only pool DBs)
    const cleanup = async () => {
      if (options?.poolAdapter) {
        // Pool adapter was used — detach pool refs
        try { (await import('../../src/mcp/core/kuzu-adapter.js')).detachKuzu(); } catch {}
      }
      // For core-only files: leave adapter alive for next file to reuse.
      // The global afterAll in test/setup.ts detaches everything on final exit.
    };

    // tmpHandle.dbPath → parent temp dir (not the kuzu file) so tests
    // that create sibling directories (e.g. 'storage') still work.
    const tmpDir = path.dirname(dbPath);
    const tmpHandle: TestDBHandle = { dbPath: tmpDir, cleanup: async () => {} };
    ref.handle = { dbPath, repoId, tmpHandle, cleanup };

    // 8. User's final setup (mocks, dynamic imports, etc.)
    if (options?.afterSetup) {
      await options.afterSetup(ref.handle);
    }
  };

  const lazyHandle = new Proxy({} as IndexedDBHandle, {
    get(_target, prop) {
      if (!ref.handle) throw new Error('withTestKuzuDB: handle not initialized — beforeAll has not run yet');
      return (ref.handle as any)[prop];
    },
  });

  // Wrap in describe to scope beforeAll/afterAll — prevents lifecycle
  // collisions when multiple withTestKuzuDB calls share the same file.
  describe(`withTestKuzuDB(${prefix})`, () => {
    beforeAll(setup, timeout);
    afterAll(async () => { if (ref.handle) await ref.handle.cleanup(); });
    fn(lazyHandle);
  });
}
