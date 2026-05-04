import { describe, expect, it } from 'vitest';
import { rankExactEmbeddingRows } from '../../src/core/embeddings/exact-search.js';

describe('rankExactEmbeddingRows', () => {
  it('orders rows by cosine distance and applies the limit', () => {
    const rows = [
      { nodeId: 'Function:b', chunkIndex: 0, startLine: 1, endLine: 1, embedding: [0, 1] },
      { nodeId: 'Function:a', chunkIndex: 0, startLine: 1, endLine: 1, embedding: [1, 0] },
    ];

    const ranked = rankExactEmbeddingRows(rows, [1, 0], 1, 2);

    expect(ranked).toEqual([
      {
        nodeId: 'Function:a',
        chunkIndex: 0,
        startLine: 1,
        endLine: 1,
        distance: 0,
      },
    ]);
  });
});
