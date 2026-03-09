/**
 * Test helper: Indexed KuzuDB lifecycle manager
 *
 * Uses a shared KuzuDB created by globalSetup (test/global-setup.ts).
 * Each test file clears all data, reseeds, and initializes adapters —
 * avoiding per-file schema creation overhead.
 *
 * Cleanup is intentionally a no-op: CI runs each KuzuDB test file in its
 * own vitest process, so the OS reclaims all native resources on exit.
 *
 * Each test file gets a unique repoId to prevent MCP pool map collisions.
 * Seed data is NOT included — each test provides its own via options.seed.
 */
/// <reference path="../vitest.d.ts" />
import path from 'path';
import { describe, beforeAll, afterAll, inject } from 'vitest';
import type { TestDBHandle } from './test-db.js';
import {
  NODE_TABLES,
  EMBEDDING_TABLE_NAME,
} from '../../src/core/kuzu/schema.js';

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
    const dbPath = inject<'kuzuDbPath'>('kuzuDbPath');
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

    // 7. Close core adapter (Windows only), then open pool adapter (read-only).
    //    On Windows, KuzuDB enforces file locks — writable + read-only
    //    can't coexist on the same path, so we must close the core first.
    //    On Linux/macOS, .close() deadlocks or segfaults via N-API
    //    destructor hooks, but concurrent Database instances on the same
    //    path are allowed, so we skip the close entirely.
    if (options?.poolAdapter) {
      if (process.platform === 'win32') {
        await adapter.closeKuzu();
      }
      const { initKuzu: poolInitKuzu } = await import('../../src/mcp/core/kuzu-adapter.js');
      await poolInitKuzu(repoId, dbPath);
    }

    // Cleanup: intentionally a no-op. We do NOT call detachKuzu() here
    // because .closeSync() segfaults on Linux (KuzuDB N-API destructor bug).
    // CI runs each KuzuDB test file in its own vitest process, so the OS
    // reclaims all native resources on process exit — no explicit cleanup needed.
    const cleanup = async () => {};

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
