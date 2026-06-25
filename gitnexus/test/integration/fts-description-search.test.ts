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
import { describe, it, expect } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
import { FTS_INDEXES } from '../../src/core/search/fts-schema.js';

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
