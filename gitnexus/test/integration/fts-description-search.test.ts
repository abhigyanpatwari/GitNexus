/**
 * Integration test for issue #2299: doc-comment text stored in the `description`
 * column must be reachable via keyword (BM25/FTS) search.
 *
 * Drives the *production* `FTS_INDEXES` through the test harness (not a bespoke
 * fixture list), so removing `description` from a symbol table's index — or
 * dropping a table from FTS coverage — fails this test. Seed rows place the
 * searched keywords ONLY in `description` (never in `name`/`content`) to prove
 * the description column is what matches.
 */
import { describe, it, expect, vi } from 'vitest';
import { withTestLbugDB, type IndexedDBHandle } from '../helpers/test-indexed-db.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
import { FTS_INDEXES } from '../../src/core/search/fts-schema.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

// The public query surface (LocalBackend.callTool('query')) resolves the repo
// via the registry and routes BM25 through the pool adapter, so the third block
// below needs listRegisteredRepos mocked to point at the test DB. Inert for the
// two core-adapter blocks — they call searchFTSFromLbug directly (no registry).
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
  };
});

const SEED = [
  // Java class: Javadoc keywords live in `description`, NOT in name/content.
  `CREATE (n:Class {id: 'class:RetryScheduler', name: 'RetryScheduler', filePath: 'src/RetryScheduler.java', startLine: 5, endLine: 40, isExported: true, content: 'public class RetryScheduler schedules retries', description: 'Implements the circuit breaker pattern for distributed service mesh fault tolerance, isolating failing downstream dependencies to prevent cascade failures'})`,
  // Rust struct: a table with NO FTS index before this change. Keywords live in
  // `description` only — proves the new-table coverage half of the fix.
  `CREATE (n:Struct {id: 'struct:LruShard', name: 'LruShard', filePath: 'src/cache.rs', startLine: 1, endLine: 20, content: 'struct LruShard holds entries', description: 'least recently used eviction policy for a bounded capacity cache'})`,
];

const PRODUCTION_FTS_INDEXES = FTS_INDEXES.map((i) => ({
  table: i.table,
  indexName: i.indexName,
  columns: [...i.properties],
}));

withTestLbugDB(
  'fts-description-search',
  () => {
    describe('description column is keyword-searchable (#2299)', () => {
      it('finds a class by Javadoc keywords present only in description', async () => {
        const { results } = await searchFTSFromLbug('circuit breaker fault tolerance', 20);
        expect(results.map((r) => r.filePath)).toContain('src/RetryScheduler.java');
      });

      it('still finds the same class by name (no regression)', async () => {
        const { results } = await searchFTSFromLbug('RetryScheduler', 20);
        expect(results.map((r) => r.filePath)).toContain('src/RetryScheduler.java');
      });

      it('finds a Struct (previously un-indexed table) by its doc-comment keywords', async () => {
        const { results } = await searchFTSFromLbug('least recently used eviction', 20);
        expect(results.map((r) => r.filePath)).toContain('src/cache.rs');
      });
    });
  },
  {
    seed: SEED,
    ftsIndexes: PRODUCTION_FTS_INDEXES,
  },
);

// Second scenario: simulate a pre-#2299 database — FTS indexes built with the old
// name+content-only schema, and no Struct index at all — then run the real
// createSearchFTSIndexes() exactly as an incremental re-analyze / --repair-fts
// would. This proves the drop-then-create behavior actually UPGRADES a live stale
// index (the whole reason U2 exists): the old code's idempotent-by-name create
// would skip the existing class_fts and description search would stay broken.
const OLD_SCHEMA_FTS_INDEXES = [
  { table: 'File', indexName: 'file_fts', columns: ['name', 'content'] },
  { table: 'Class', indexName: 'class_fts', columns: ['name', 'content'] },
  // Struct intentionally omitted — pre-#2299 had no FTS index for it.
];

withTestLbugDB(
  'fts-description-reindex-upgrade',
  () => {
    describe('re-analyze upgrades stale FTS indexes so description becomes searchable (#2299)', () => {
      it('finds a class by description keywords after re-indexing an old name+content-only DB', async () => {
        const { results } = await searchFTSFromLbug('circuit breaker fault tolerance', 20);
        expect(results.map((r) => r.filePath)).toContain('src/RetryScheduler.java');
      });

      it('makes a previously un-indexed table (Struct) searchable after re-indexing', async () => {
        const { results } = await searchFTSFromLbug('least recently used eviction', 20);
        expect(results.map((r) => r.filePath)).toContain('src/cache.rs');
      });
    });
  },
  {
    seed: SEED,
    ftsIndexes: OLD_SCHEMA_FTS_INDEXES,
    afterSetup: async () => {
      // Real production index build over the now-stale DB — drops then recreates.
      const { createSearchFTSIndexes } = await import('../../src/core/search/fts-indexes.js');
      await createSearchFTSIndexes();
    },
  },
);

// Third scenario: prove the description-only keyword is reachable through the
// PUBLIC query surface (LocalBackend.callTool('query')), not just the
// searchFTSFromLbug helper the blocks above exercise. callTool resolves the repo
// via the registry and routes BM25 through the pool adapter — a different
// connection context than the core-adapter helper — so this block needs
// poolAdapter + a listRegisteredRepos mock + a LocalBackend built in afterSetup.
// Reuses the same description-only SEED and production FTS_INDEXES.
withTestLbugDB(
  'fts-description-search-public-query',
  (handle) => {
    describe('public query surface returns description-only matches (#2299)', () => {
      it('finds a class by description keywords via callTool("query")', async () => {
        const ext = handle as IndexedDBHandle & { _backend?: LocalBackend };
        expect(ext._backend).toBeDefined();
        const backend = ext._backend!;

        type QuerySymbol = { id: string };
        type QueryResult = {
          error?: unknown;
          definitions?: QuerySymbol[];
          process_symbols?: QuerySymbol[];
        };
        const result: QueryResult = await backend.callTool('query', {
          query: 'circuit breaker fault tolerance',
        });

        expect(result.error).toBeUndefined();
        const ids = [...(result.process_symbols ?? []), ...(result.definitions ?? [])].map(
          (s) => s.id,
        );
        expect(ids).toContain('class:RetryScheduler');
      });
    });
  },
  {
    seed: SEED,
    ftsIndexes: PRODUCTION_FTS_INDEXES,
    poolAdapter: true,
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'test-repo',
          path: '/test/repo',
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'abc123',
          stats: { files: 1, nodes: 2, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as IndexedDBHandle & { _backend?: LocalBackend })._backend = backend;
    },
  },
);
