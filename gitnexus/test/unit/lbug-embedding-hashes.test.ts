import { describe, expect, it, vi } from 'vitest';
import { STALE_HASH_SENTINEL } from '../../src/core/lbug/schema.js';
import { fetchExistingEmbeddingHashes } from '../../src/core/lbug/lbug-adapter.js';

describe('fetchExistingEmbeddingHashes', () => {
  it('treats rows without chunk-aware metadata as stale even when contentHash exists', async () => {
    const execQuery = vi.fn().mockResolvedValue([
      {
        nodeId: 'Function:src/main.ts:foo',
        chunkIndex: null,
        startLine: null,
        endLine: null,
        contentHash: 'abcdef1234567890abcdef1234567890abcdef12',
      },
    ]);

    const result = await fetchExistingEmbeddingHashes(execQuery);

    expect(result?.get('Function:src/main.ts:foo')).toBe(STALE_HASH_SENTINEL);
  });

  it('preserves contentHash for chunk-aware rows', async () => {
    const hash = 'abcdef1234567890abcdef1234567890abcdef12';
    const execQuery = vi.fn().mockResolvedValue([
      {
        nodeId: 'Function:src/main.ts:foo',
        chunkIndex: 0,
        startLine: 10,
        endLine: 12,
        contentHash: hash,
      },
    ]);

    const result = await fetchExistingEmbeddingHashes(execQuery);

    expect(result?.get('Function:src/main.ts:foo')).toBe(hash);
  });

  it('falls back to stale hashes when chunk-aware columns are missing from the schema', async () => {
    const execQuery = vi
      .fn()
      .mockRejectedValueOnce(new Error('Binder exception: column chunkIndex does not exist'))
      .mockResolvedValueOnce([{ nodeId: 'Function:src/main.ts:foo' }]);

    const result = await fetchExistingEmbeddingHashes(execQuery);

    expect(result?.get('Function:src/main.ts:foo')).toBe(STALE_HASH_SENTINEL);
    expect(execQuery).toHaveBeenCalledTimes(2);
  });
});
