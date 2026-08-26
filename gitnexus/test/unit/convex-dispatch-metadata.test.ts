import { describe, expect, it } from 'vitest';

import { queryConvexDispatchMetadata } from '../../src/mcp/local/convex-metadata.js';

describe('Convex dispatch metadata compatibility', () => {
  it('marks a pre-property index as conservatively incomplete', async () => {
    const missingProperty = async (): Promise<never> => {
      throw new Error('Cannot find property convexEndpointFactory for n');
    };

    const result = await queryConvexDispatchMetadata(
      '/tmp/old-index',
      'Const:x',
      'x',
      'Const',
      missingProperty,
    );

    expect(result?.staleIndex).toBe(true);
    expect(result?.boundary).toContain('re-index');
  });

  it('marks unrelated query failures as conservatively incomplete', async () => {
    const transientFailure = async (): Promise<never> => {
      throw new Error('database busy');
    };

    const result = await queryConvexDispatchMetadata(
      '/tmp/index',
      'Const:x',
      'x',
      'Const',
      transientFailure,
    );

    expect(result?.probeFailed).toBe(true);
    expect(result?.boundary).toContain('could not be checked');
  });

  it('queries Function metadata without an undeclared deterministic LIMIT', async () => {
    let cypher = '';
    const runQuery = async (_path: string, query: string) => {
      cypher = query;
      return [{ factory: 'query' }];
    };

    await expect(
      queryConvexDispatchMetadata('/tmp/index', 'Function:x', 'x', 'Function', runQuery),
    ).resolves.toMatchObject({ factory: 'query' });
    expect(cypher).toContain('MATCH (n:Function');
    expect(cypher).not.toContain('LIMIT');
  });
});
