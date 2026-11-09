import { expect, it } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import {
  closeLbug,
  createFTSIndex,
  dropFTSIndex,
  executeQuery,
  initLbug,
} from '../../src/core/lbug/lbug-adapter.js';
import * as pool from '../../src/core/lbug/pool-adapter.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
import {
  createSearchFTSIndexes,
  verifySearchFTSIndexes,
} from '../../src/core/search/fts-indexes.js';
import { FTS_INDEXES } from '../../src/core/search/fts-schema.js';

withTestLbugDB(
  'fts-empty-tables',
  (handle) => {
    it('omits empty indexes, preserves core/pool search, and indexes newly populated tables', async () => {
      const catalog = await executeQuery('CALL SHOW_INDEXES() RETURN *');
      expect(
        catalog
          .filter((row) => row.index_type === 'FTS')
          .map((row) => row.table_name)
          .sort(),
      ).toEqual(['File', 'Function']);
      expect(await verifySearchFTSIndexes(executeQuery)).toEqual([]);

      const before = await searchFTSFromLbug('resilient nebula', 20);
      expect(before.ftsAvailable).toBe(true);
      expect(before.missingIndexes).toBeUndefined();
      expect(before.nonBenignErrors).toBeUndefined();
      expect(before.results.map((row) => row.filePath)).toEqual(['a.ts']);

      await closeLbug();
      await pool.initLbug(handle.repoId, handle.dbPath);
      try {
        expect(await searchFTSFromLbug('resilient nebula', 20, handle.repoId)).toEqual(before);
      } finally {
        await pool.closeLbug(handle.repoId);
      }
      await initLbug(handle.dbPath);

      // Independent control: explicitly create all configured native indexes,
      // including empty tables, and compare complete ranked results/scores.
      for (const index of FTS_INDEXES) {
        await createFTSIndex(index.table, index.indexName, [...index.properties]);
      }
      expect(await searchFTSFromLbug('resilient nebula', 20)).toEqual(before);

      await dropFTSIndex('Class', 'class_fts');
      await executeQuery(
        "CREATE (:Class {id: 'Class:b.ts:Quasar', name: 'Quasar', filePath: 'b.ts', " +
          "startLine: 1, endLine: 2, content: 'class Quasar {}', description: 'orbital lighthouse'})",
      );
      // The previous empty-table result must not be cached across mutations.
      expect(await verifySearchFTSIndexes(executeQuery)).toEqual(['Class.class_fts']);
      expect((await searchFTSFromLbug('orbital lighthouse')).missingIndexes).toEqual([
        'Class.class_fts',
      ]);
      await closeLbug();
      await pool.initLbug(handle.repoId, handle.dbPath);
      try {
        expect(
          (await searchFTSFromLbug('orbital lighthouse', 20, handle.repoId)).missingIndexes,
        ).toEqual(['Class.class_fts']);
      } finally {
        await pool.closeLbug(handle.repoId);
      }
      await initLbug(handle.dbPath);

      expect(await createSearchFTSIndexes()).toEqual([]);
      expect(await verifySearchFTSIndexes(executeQuery)).toEqual([]);
      const populated = await searchFTSFromLbug('orbital lighthouse');
      expect(populated.missingIndexes).toBeUndefined();
      expect(populated.results.map((row) => row.filePath)).toEqual(['b.ts']);

      await dropFTSIndex('Class', 'class_fts');
      await executeQuery('MATCH (n:Class) DELETE n');
      expect(await createSearchFTSIndexes()).toEqual([]);
      expect(await verifySearchFTSIndexes(executeQuery)).toEqual([]);
      expect(await searchFTSFromLbug('resilient nebula', 20)).toEqual(before);
    }, 120_000);
  },
  {
    seed: [
      "CREATE (:File {id: 'File:a.ts', name: 'a.ts', filePath: 'a.ts', content: 'resilient nebula'})",
      "CREATE (:Function {id: 'Function:a.ts:alpha', name: 'alpha', filePath: 'a.ts', " +
        "startLine: 1, endLine: 2, content: 'function alpha() {}', description: 'resilient nebula'})",
    ],
    // Gate the suite on native FTS availability through the existing helper.
    ftsIndexes: [
      { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
    ],
    afterSetup: async () => {
      expect(await createSearchFTSIndexes()).toEqual([]);
    },
  },
);
