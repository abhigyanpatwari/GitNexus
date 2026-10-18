import { expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
import { executeParameterized } from '../../src/core/lbug/pool-adapter.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { LOCAL_BACKEND_SEED_DATA } from '../fixtures/local-backend-seed.js';

// Supply ranked FTS hits; exercise hydration with the real native graph and pool.
vi.mock('../../src/core/search/bm25-index.js', () => ({ searchFTSFromLbug: vi.fn() }));

withTestLbugDB(
  'bm25-symbol-hydration',
  (handle) => {
    it('matches individual native reads across files and node tables', async () => {
      const hits = [
        {
          filePath: 'src/auth.ts',
          score: 8,
          rank: 1,
          nodeIds: ['method:AuthService.authenticate', 'func:validate', 'func:login'],
        },
        { filePath: 'src/utils.ts', score: 4, rank: 2, nodeIds: ['func:hash'] },
        { filePath: 'src/deleted.ts', score: 2, rank: 3, nodeIds: ['func:deleted'] },
      ];
      vi.mocked(searchFTSFromLbug).mockResolvedValue({ results: hits, ftsAvailable: true });
      const expected = [];
      for (const hit of hits) {
        const symbols = await executeParameterized(
          handle.repoId,
          `MATCH (n) WHERE n.id IN $nodeIds
           RETURN n.id AS id, n.name AS name, labels(n)[0] AS type,
                  n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
           ORDER BY startLine, id`,
          { nodeIds: hit.nodeIds },
        );
        if (symbols.length) {
          expected.push(
            ...symbols.map(({ id, ...symbol }) => ({
              nodeId: id,
              ...symbol,
              type: symbol.type || undefined,
              bm25Score: hit.score,
            })),
          );
        } else {
          expected.push({
            name: 'deleted.ts',
            type: 'File',
            filePath: hit.filePath,
            bm25Score: hit.score,
          });
        }
      }

      const backend = new LocalBackend() as unknown as {
        bm25Search: (repo: { lbugPath: string }, query: string, limit: number) => Promise<unknown>;
      };
      expect(await backend.bm25Search({ lbugPath: handle.repoId }, 'authentication', 20)).toEqual({
        results: expected,
        ftsUsed: true,
      });
    });
  },
  { seed: LOCAL_BACKEND_SEED_DATA, poolAdapter: true },
);
