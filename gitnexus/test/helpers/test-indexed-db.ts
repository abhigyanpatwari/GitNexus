/**
 * Test helper: Indexed LadybugDB lifecycle manager
 *
 * Uses a shared LadybugDB created by globalSetup (test/global-setup.ts).
 * Each test file clears all data, reseeds, and initializes adapters —
 * avoiding per-file schema creation overhead.
 *
 * Cleanup properly closes adapters and releases native resources.
 *
 * Each test file gets a unique repoId to prevent MCP pool map collisions.
 * Seed data is NOT included — each test provides its own via options.seed.
 */
/// <reference path="../vitest.d.ts" />
import path from 'path';
import { describe, beforeAll, afterAll, inject } from 'vitest';
import type { TestDBHandle } from './test-db.js';
import { NODE_TABLES, EMBEDDING_TABLE_NAME } from '../../src/core/lbug/schema.js';

export interface IndexedDBHandle {
  /** Path to the LadybugDB database file */
  dbPath: string;
  /** Unique repoId for MCP pool adapter — prevents cross-file collisions */
  repoId: string;
  /** Temp directory handle for filesystem cleanup */
  tmpHandle: TestDBHandle;
  /** Cleanup: closes adapters and releases native resources */
  cleanup: () => Promise<void>;
}

let repoCounter = 0;

/** FTS index definition for withTestLbugDB */
export interface FTSIndexDef {
  table: string;
  indexName: string;
  columns: string[];
}

/**
 * Options for withTestLbugDB lifecycle.
 *
 * Lifecycle: initLbug → loadFTS → dropFTS → clearData → seed
 *            → createFTS → [closeCoreLbug + poolInitLbug] → afterSetup
 */
export interface WithTestLbugDBOptions {
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
 * Manages the full LadybugDB test lifecycle using the shared global DB:
 * data clearing, reseeding, FTS indexes, adapter init/teardown.
 *
 * All data operations go through the core adapter's writable connection —
 * no raw lbug.Database() connections are opened.  This avoids file-lock
 * conflicts with orphaned native objects from previous test files.
 *
 * Each call is wrapped in its own `describe` block to isolate lifecycle
 * hooks — safe to call multiple times in the same file.
 */
export function withTestLbugDB(
  prefix: string,
  fn: (handle: IndexedDBHandle) => void,
  options?: WithTestLbugDBOptions,
): void {
  const ref: { handle: IndexedDBHandle | undefined } = { handle: undefined };
  const timeout = options?.timeout ?? 30000;

  const setup = async () => {
    // Get shared DB path from globalSetup (created once with full schema)
    const dbPath = inject<'lbugDbPath'>('lbugDbPath');
    const repoId = `test-${prefix}-${Date.now()}-${repoCounter++}`;

    const adapter = await import('../../src/core/lbug/lbug-adapter.js');

    // 1. Init core adapter (writable) — reuses existing connection if
    //    already open for this dbPath (no new native objects created).
    await adapter.initLbug(dbPath);

    // 2. Load FTS extension (idempotent — skips if already loaded)
    await adapter.loadFTSExtension();

    // 3. Drop stale FTS indexes from previous test file
    if (options?.ftsIndexes?.length) {
      for (const idx of options.ftsIndexes) {
        try {
          await adapter.dropFTSIndex(idx.table, idx.indexName);
        } catch {
          /* may not exist */
        }
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

    // 7. Open pool adapter by injecting the core adapter's writable Database.
    //    LadybugDB enforces file locks — writable + read-only can't coexist
    //    on the same path, and db.close() segfaults on macOS due to N-API
    //    destructor issues.  Reusing the writable Database avoids both problems.
    //    Write protection is enforced at the query validation layer (isWriteQuery)
    //    rather than at the native DB level.
    if (options?.poolAdapter) {
      const coreDb = adapter.getDatabase();
      if (!coreDb) throw new Error('withTestLbugDB: core adapter has no open Database');
      const { initLbugWithDb } = await import('../../src/mcp/core/lbug-adapter.js');
      await initLbugWithDb(repoId, coreDb, dbPath);
    }

    const cleanup = async () => {
      if (options?.poolAdapter) {
        const poolAdapter = await import('../../src/mcp/core/lbug-adapter.js');
        await poolAdapter.closeLbug(repoId);
      }
      await adapter.closeLbug();
    };

    // tmpHandle.dbPath → parent temp dir (not the lbug file) so tests
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
      if (!ref.handle)
        throw new Error('withTestLbugDB: handle not initialized — beforeAll has not run yet');
      return (ref.handle as any)[prop];
    },
  });

  // Wrap in describe to scope beforeAll/afterAll — prevents lifecycle
  // collisions when multiple withTestLbugDB calls share the same file.
  describe(`withTestLbugDB(${prefix})`, () => {
    beforeAll(setup, timeout);
    // Explicit timeout: KuzuDB's C++ destructor can hang on Windows during
    // native resource cleanup.  The vitest hookTimeout (120s) should apply
    // automatically, but some vitest versions fall back to testTimeout (30s)
    // for afterAll.  Pass 120s explicitly to avoid CI flakes on Windows.
    afterAll(async () => {
      if (ref.handle) await ref.handle.cleanup();
    }, 120_000);
    fn(lazyHandle);
  });
}
