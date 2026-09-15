import { beforeEach, describe, expect, it, vi } from 'vitest';

const { embedTextMock, isEmbedderReadyMock, loadVectorExtensionMock } = vi.hoisted(() => ({
  embedTextMock: vi.fn(),
  isEmbedderReadyMock: vi.fn(),
  loadVectorExtensionMock: vi.fn(async () => false),
}));

vi.mock('../../src/core/embeddings/embedder.js', () => ({
  initEmbedder: vi.fn(),
  embedBatch: vi.fn(),
  embedText: (...args: unknown[]) => embedTextMock(...args),
  embeddingToArray: (embedding: Float32Array) => Array.from(embedding),
  isEmbedderReady: () => isEmbedderReadyMock(),
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  loadVectorExtension: (...args: unknown[]) => loadVectorExtensionMock(...args),
  createVectorIndex: vi.fn(),
}));

describe('semanticSearch ready-check (KTD11)', () => {
  beforeEach(() => {
    embedTextMock.mockReset();
    isEmbedderReadyMock.mockReset();
    loadVectorExtensionMock.mockReset().mockResolvedValue(false);
  });

  it('does not throw when the stack is resolvable and no in-process singleton exists', async () => {
    isEmbedderReadyMock.mockReturnValue(true);
    embedTextMock.mockResolvedValue(new Float32Array(384));
    const executeQuery = vi.fn(async (cypher: string) => {
      if (cypher.includes('RETURN 1 AS ok')) return [{ ok: 1 }];
      if (cypher.includes('count(e) AS cnt')) return [{ cnt: 2 }];
      return [];
    });

    const { semanticSearch } = await import('../../src/core/embeddings/embedding-pipeline.js');
    await expect(semanticSearch(executeQuery, 'find auth', 5)).resolves.toEqual([]);
    expect(embedTextMock).toHaveBeenCalledTimes(1);
    expect(embedTextMock.mock.calls[0]?.[0]).toBe('find auth');
  });

  it('does not request a query vector when the embedding table is empty', async () => {
    isEmbedderReadyMock.mockReturnValue(true);
    embedTextMock.mockResolvedValue(new Float32Array(384));
    const executeQuery = vi.fn(async (cypher: string) => {
      if (cypher.includes('RETURN 1 AS ok')) return [];
      if (cypher.includes('count(e) AS cnt')) return [{ cnt: 0 }];
      return [];
    });

    const { semanticSearch } = await import('../../src/core/embeddings/embedding-pipeline.js');
    await expect(semanticSearch(executeQuery, 'find auth', 5)).resolves.toEqual([]);
    expect(embedTextMock).not.toHaveBeenCalled();
    expect(loadVectorExtensionMock).not.toHaveBeenCalled();
  });
});
