import { describe, expect, it } from 'vitest';
import { buildQueryPlan, combineRankedResults } from '../../src/core/search/query-expansion.js';

describe('query expansion', () => {
  it('keeps fan-out bounded and splits code identifiers', () => {
    const plan = buildQueryPlan({
      query: 'telegram dispatch scheduling pg-boss singletonKey package',
      goal: 'find dispatch route worker flow',
      taskContext: 'validate singletonKey dedupe',
    });

    expect(plan.bm25Queries).toHaveLength(4);
    expect(plan.semanticQueries).toHaveLength(2);
    expect(plan.semanticQueries.map((variant) => variant.kind)).toEqual(['primary', 'identifier']);
    expect(plan.bm25Queries[1].query).toContain('singleton Key');
    expect(plan.bm25Queries[2].query).toContain('job queue worker schedule');
  });

  it('reranks exact symbol and file-path matches after RRF', () => {
    const plan = buildQueryPlan({ query: 'registerPreRegisterRoute duplicate consent' });
    const ranked = combineRankedResults(
      [
        {
          source: 'bm25',
          results: [
            {
              nodeId: 'Function:src/other.ts:genericHandler',
              name: 'genericHandler',
              filePath: 'src/other.ts',
            },
            {
              nodeId: 'Function:src/modules/identity/api/pre-register.ts:registerPreRegisterRoute',
              name: 'registerPreRegisterRoute',
              filePath: 'src/modules/identity/api/pre-register.ts',
            },
          ],
        },
      ],
      2,
      plan,
      { keyFn: (result) => result.nodeId },
    );

    expect(ranked[0].data.name).toBe('registerPreRegisterRoute');
  });
});
