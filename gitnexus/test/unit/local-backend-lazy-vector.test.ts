import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _captureLogger } from '../../src/core/logger.js';

const executeQueryMock = vi.fn();
const ensureVectorExtensionMock = vi.fn();
const embedQueryMock = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  ensureVectorExtension: (...args: unknown[]) => ensureVectorExtensionMock(...args),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: (...args: unknown[]) => embedQueryMock(...args),
  getEmbeddingDims: () => 3,
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

interface SemanticSearchable {
  semanticSearch(repo: { lbugPath: string }, query: string, limit: number): Promise<unknown[]>;
}

const runSemanticSearch = (backend: LocalBackend): Promise<unknown[]> =>
  (backend as unknown as SemanticSearchable).semanticSearch({ lbugPath: '/tmp/index' }, 'q', 5);

describe('LocalBackend semantic search lazy VECTOR loading (#3021)', () => {
  beforeEach(() => {
    executeQueryMock.mockReset();
    ensureVectorExtensionMock.mockReset();
    embedQueryMock.mockReset();
    embedQueryMock.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it('does not probe VECTOR when the exact embedding count is zero', async () => {
    executeQueryMock.mockResolvedValueOnce([{ cnt: 0 }]);

    await expect(runSemanticSearch(new LocalBackend())).resolves.toEqual([]);

    expect(ensureVectorExtensionMock).not.toHaveBeenCalled();
    expect(embedQueryMock).not.toHaveBeenCalled();
  });

  it('probes VECTOR only after embeddings are found and keeps exact-scan fallback', async () => {
    executeQueryMock.mockResolvedValueOnce([{ cnt: 2 }]).mockResolvedValueOnce([]);
    ensureVectorExtensionMock.mockResolvedValue(false);

    await expect(runSemanticSearch(new LocalBackend())).resolves.toEqual([]);

    expect(ensureVectorExtensionMock).toHaveBeenCalledOnce();
    expect(ensureVectorExtensionMock).toHaveBeenCalledWith('/tmp/index');
    expect(executeQueryMock).toHaveBeenCalledTimes(2);
    expect(
      executeQueryMock.mock.calls.some(([, cypher]) =>
        String(cypher).includes('QUERY_VECTOR_INDEX'),
      ),
    ).toBe(false);
  });

  it('uses QUERY_VECTOR_INDEX only after the lazy VECTOR load succeeds', async () => {
    executeQueryMock
      .mockResolvedValueOnce([{ cnt: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    ensureVectorExtensionMock.mockResolvedValue(true);

    await expect(runSemanticSearch(new LocalBackend())).resolves.toEqual([]);

    expect(ensureVectorExtensionMock).toHaveBeenCalledOnce();
    expect(
      executeQueryMock.mock.calls.some(([, cypher]) =>
        String(cypher).includes('QUERY_VECTOR_INDEX'),
      ),
    ).toBe(true);
  });

  it('falls back to the exact scan when the lazy VECTOR load rejects', async () => {
    executeQueryMock.mockResolvedValueOnce([{ cnt: 2 }]).mockResolvedValueOnce([]);
    ensureVectorExtensionMock.mockRejectedValue(new Error('transient load failure'));

    await expect(runSemanticSearch(new LocalBackend())).resolves.toEqual([]);

    expect(executeQueryMock).toHaveBeenCalledTimes(2);
    expect(
      executeQueryMock.mock.calls.some(([, cypher]) =>
        String(cypher).includes('QUERY_VECTOR_INDEX'),
      ),
    ).toBe(false);
  });

  it('reports load and index-query failures independently', async () => {
    executeQueryMock.mockImplementation(async (_repoId: string, cypher: string) => {
      if (cypher.includes('COUNT(*) AS cnt')) return [{ cnt: 1 }];
      if (cypher.includes('QUERY_VECTOR_INDEX')) throw new Error('stale vector index');
      return [];
    });
    ensureVectorExtensionMock
      .mockRejectedValueOnce(new Error('transient load failure'))
      .mockResolvedValueOnce(true);
    const backend = new LocalBackend();
    const cap = _captureLogger();

    try {
      await expect(runSemanticSearch(backend)).resolves.toEqual([]);
      await expect(runSemanticSearch(backend)).resolves.toEqual([]);

      const messages = cap.records().map((record) => String(record.msg ?? ''));
      expect(
        messages.filter((message) => message.includes('vector extension load failed')),
      ).toHaveLength(1);
      expect(
        messages.filter((message) => message.includes('vector index query failed')),
      ).toHaveLength(1);
    } finally {
      cap.restore();
    }
  });
});
