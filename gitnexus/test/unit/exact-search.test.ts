import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { logger } from '../../src/core/logger.js';
import {
  DEFAULT_VECTOR_MAX_DISTANCE,
  getVectorMaxDistance,
} from '../../src/core/embeddings/config.js';
import { rankExactEmbeddingRows } from '../../src/core/embeddings/exact-search.js';

const withVectorDistanceEnv = (value: string | undefined, run: () => void) => {
  const previous = process.env.GITNEXUS_VECTOR_MAX_DISTANCE;
  try {
    if (value === undefined) delete process.env.GITNEXUS_VECTOR_MAX_DISTANCE;
    else process.env.GITNEXUS_VECTOR_MAX_DISTANCE = value;
    run();
  } finally {
    if (previous === undefined) delete process.env.GITNEXUS_VECTOR_MAX_DISTANCE;
    else process.env.GITNEXUS_VECTOR_MAX_DISTANCE = previous;
  }
};

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

  it('uses a configurable distance threshold for exact-scan fallback', () => {
    const rows = [
      { nodeId: 'Function:near', chunkIndex: 0, startLine: 1, endLine: 1, embedding: [1, 0] },
      { nodeId: 'Function:far', chunkIndex: 0, startLine: 1, endLine: 1, embedding: [0, 1] },
    ];

    withVectorDistanceEnv('1.1', () => {
      const ranked = rankExactEmbeddingRows(
        rows,
        [1, 0],
        10,
        getVectorMaxDistance(DEFAULT_VECTOR_MAX_DISTANCE),
      );

      expect(ranked.map((row) => row.nodeId)).toEqual(['Function:near', 'Function:far']);
    });
  });
});

describe('getVectorMaxDistance', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('returns the caller fallback when the env var is unset', () => {
    withVectorDistanceEnv(undefined, () => {
      expect(getVectorMaxDistance(0.6)).toBe(0.6);
    });
  });

  it('parses a positive numeric env override', () => {
    withVectorDistanceEnv('0.82', () => {
      expect(getVectorMaxDistance(0.6)).toBe(0.82);
    });
  });

  it('keeps the fallback for invalid values', () => {
    for (const value of ['0', '-0.1', 'not-a-number']) {
      withVectorDistanceEnv(value, () => {
        expect(getVectorMaxDistance(0.6)).toBe(0.6);
      });
    }
  });

  it('stays silent for unset, empty, and whitespace values', () => {
    for (const value of [undefined, '', '   ']) {
      withVectorDistanceEnv(value, () => {
        expect(getVectorMaxDistance(0.6)).toBe(0.6);
      });
    }
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('falls back and warns once for a non-finite value', () => {
    withVectorDistanceEnv('Infinity', () => {
      expect(getVectorMaxDistance(0.6)).toBe(0.6);
    });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });

  it('clamps values above the cosine ceiling to 2 and warns', () => {
    withVectorDistanceEnv('5', () => {
      expect(getVectorMaxDistance(0.6)).toBe(2);
    });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });

  it('accepts the ceiling value 2 without warning', () => {
    withVectorDistanceEnv('2', () => {
      expect(getVectorMaxDistance(0.6)).toBe(2);
    });
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('warns only once per offending value across repeated calls', () => {
    withVectorDistanceEnv('7', () => {
      expect(getVectorMaxDistance(0.6)).toBe(2);
      expect(getVectorMaxDistance(0.6)).toBe(2);
    });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });
});
