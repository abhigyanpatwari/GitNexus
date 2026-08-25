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

  it('keeps unrelated transient query failures fail-soft', async () => {
    const transientFailure = async (): Promise<never> => {
      throw new Error('database busy');
    };

    await expect(
      queryConvexDispatchMetadata('/tmp/index', 'Const:x', 'x', 'Const', transientFailure),
    ).resolves.toBeUndefined();
  });
});
