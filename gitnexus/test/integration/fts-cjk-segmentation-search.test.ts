/**
 * End-to-end CJK sub-phrase FTS search (#2331).
 *
 * Proves R2 of the plan through the REAL pipeline, not a Cypher-seeded
 * shortcut — the same methodology lesson #2317/PR #2323 already established
 * (FTS searchability must be proven through a real search):
 *
 *   write a file containing contiguous CJK text on disk → loadGraphToLbug
 *   (streamAllCSVsToDisk → COPY, with GITNEXUS_FTS_CJK_SEGMENTATION=bigram
 *   segmenting `content` before it's written) → createFTSIndex(file_fts)
 *   → searchFTSFromLbug (bigram-segmenting the query the same way).
 *
 * Set at module scope so it is in effect before `withTestLbugDB`'s internal
 * `beforeAll` (which runs `beforeFTS`) executes.
 */
process.env.GITNEXUS_FTS_CJK_SEGMENTATION = 'bigram';

import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { buildTestGraph } from '../helpers/test-graph.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';

afterAll(() => {
  delete process.env.GITNEXUS_FTS_CJK_SEGMENTATION;
});

// Issue #2331's own example: "purchase order automatic approval process".
const CJK_PHRASE = '采购订单自动审批流程';
const FILE_BODY = `// ${CJK_PHRASE}\nexport function approve() {}\n`;

withTestLbugDB(
  'fts-cjk-segmentation-search',
  () => {
    describe('CJK sub-phrase search returns hits when bigram segmentation is enabled (#2331)', () => {
      it('finds the file for an exact sub-phrase not present as a standalone token', async () => {
        const { results } = await searchFTSFromLbug('审批流程', 20);
        expect(results.map((r) => r.filePath)).toContain('cjk.ts');
      });

      it('finds the file for a different sub-phrase from the same contiguous run', async () => {
        const { results } = await searchFTSFromLbug('采购订单', 20);
        expect(results.map((r) => r.filePath)).toContain('cjk.ts');
      });

      it('returns a positive BM25 score for the match', async () => {
        const { results } = await searchFTSFromLbug('审批流程', 20);
        const hit = results.find((r) => r.filePath === 'cjk.ts');
        expect(hit).toBeDefined();
        expect(hit!.score).toBeGreaterThan(0);
      });
    });
  },
  {
    ftsIndexes: [{ table: 'File', indexName: 'file_fts', columns: ['name', 'content'] }],
    beforeFTS: async (dbPath) => {
      const root = path.dirname(dbPath);
      const repoDir = path.join(root, 'repo');
      const storageDir = path.join(root, 'storage');
      await fs.mkdir(repoDir, { recursive: true });
      await fs.mkdir(storageDir, { recursive: true });
      await fs.writeFile(path.join(repoDir, 'cjk.ts'), FILE_BODY);

      const graph = buildTestGraph([
        { id: 'file:cjk.ts', label: 'File', name: 'cjk.ts', filePath: 'cjk.ts' },
      ]);
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.loadGraphToLbug(graph, repoDir, storageDir);
    },
  },
);
