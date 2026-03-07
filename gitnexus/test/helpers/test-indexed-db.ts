/**
 * Test helper: Indexed KuzuDB lifecycle manager
 *
 * Uses a shared KuzuDB created by globalSetup (test/global-setup.ts).
 * Each test file clears all data, reseeds, and initializes adapters —
 * avoiding per-file schema creation overhead.
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
  /** Cleanup: closes BOTH adapters */
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
  const path = await import('path');
  const dbPath = path.join(tmpHandle.dbPath, 'kuzu');
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
    // 1. Detach (null out) core adapter refs — do NOT call .close() which
    //    triggers C++ destructors that hang/segfault in forked workers
    try { detachCoreKuzu(); } catch { /* best-effort */ }
    // 2. Detach MCP pool adapter refs for this repoId
    try { detachPoolKuzu(); } catch { /* best-effort */ }
    // 3. Remove temp directory (best-effort — DB files may still be locked)
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

/**
 * Clear all data from a shared KuzuDB, optionally drop FTS indexes, and reseed.
 *
 * Opens a writable connection, deletes all nodes (DETACH DELETE cascades
 * to relationships), drops stale FTS indexes, inserts seed data, then closes.
 *
 * @param dbPath - Path to the KuzuDB database file
 * @param seedQueries - Cypher CREATE queries for seed data
 * @param ftsIndexesToDrop - FTS index definitions to drop before reseeding
 */
export async function clearAndSeedData(
  dbPath: string,
  seedQueries?: string[],
  ftsIndexesToDrop?: FTSIndexDef[],
): Promise<void> {
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  try {
    // Drop stale FTS indexes before clearing data (requires extension loaded)
    if (ftsIndexesToDrop?.length) {
      try { await conn.query('LOAD EXTENSION fts'); } catch { /* may already be loaded */ }
      for (const idx of ftsIndexesToDrop) {
        try {
          await conn.query(`CALL DROP_FTS_INDEX('${idx.table}', '${idx.indexName}')`);
        } catch { /* index may not exist — first run */ }
      }
    }

    // Delete all nodes (DETACH DELETE cascades to relationships)
    for (const table of NODE_TABLES) {
      await conn.query(`MATCH (n:\`${table}\`) DETACH DELETE n`);
    }
    // Clear embeddings
    await conn.query(`MATCH (n:${EMBEDDING_TABLE_NAME}) DELETE n`);

    // Seed new data
    if (seedQueries?.length) {
      for (const q of seedQueries) {
        await conn.query(q);
      }
    }
  } finally {
    conn.close();
    db.close();
  }
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
 * Lifecycle: clearAndSeed → initKuzu → loadFTS → createIndexes
 *            → [closeCoreKuzu + poolInitKuzu] → afterSetup
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

    // 1. Clear all data + seed (opens a raw writable connection, then closes it)
    //    Also drops stale FTS indexes from previous test file
    await clearAndSeedData(dbPath, options?.seed, options?.ftsIndexes);

    // Build cleanup that explicitly closes adapters to release DB locks
    const cleanup = async () => {
      try {
        const { closeKuzu: closeCoreKuzu } = await import('../../src/core/kuzu/kuzu-adapter.js');
        await closeCoreKuzu();
      } catch { /* best-effort */ }
      try {
        const { closeKuzu: closePoolKuzu } = await import('../../src/mcp/core/kuzu-adapter.js');
        await closePoolKuzu();
      } catch { /* best-effort */ }
    };

    // No per-file temp dir — globalSetup manages the shared directory.
    // tmpHandle.dbPath points to the parent temp dir (not the kuzu file)
    // so tests that create sibling directories (e.g. 'storage') still work.
    const tmpDir = path.dirname(dbPath);
    const tmpHandle: TestDBHandle = { dbPath: tmpDir, cleanup: async () => {} };
    ref.handle = { dbPath, repoId, tmpHandle, cleanup };
    const handle = ref.handle;

    // 2. Init core adapter (writable)
    const {
      initKuzu,
      loadFTSExtension,
      createFTSIndex,
      closeKuzu: closeCoreKuzu,
    } = await import('../../src/core/kuzu/kuzu-adapter.js');
    await initKuzu(handle.dbPath);

    // 3. Load FTS extension
    await loadFTSExtension();

    // 4. Create FTS indexes (stale ones already dropped in clearAndSeedData)
    if (options?.ftsIndexes?.length) {
      for (const idx of options.ftsIndexes) {
        await createFTSIndex(idx.table, idx.indexName, idx.columns);
      }
    }

    // 5. Close core → open pool adapter (read-only)
    if (options?.poolAdapter) {
      await closeCoreKuzu();
      const { initKuzu: poolInitKuzu } = await import('../../src/mcp/core/kuzu-adapter.js');
      await poolInitKuzu(handle.repoId, handle.dbPath);
    }

    // 6. User's final setup (mocks, dynamic imports, etc.)
    if (options?.afterSetup) {
      await options.afterSetup(handle);
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
