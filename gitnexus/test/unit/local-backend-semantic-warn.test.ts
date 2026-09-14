/**
 * Tests that MCP semantic search surfaces a missing local embedding stack once
 * instead of silently degrading to BM25 (#2372) — the silent-degradation mode
 * #2370 exists to fix. executeQuery is mocked to report a populated embedding
 * table so execution reaches the embedder import, which is mocked to throw the
 * missing-stack message (R20 copy: default install no longer ships the stack).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';
import {
  LOCAL_EMBEDDING_SIDECAR_ABORT_LEAD,
  localEmbeddingStackMissingMessage,
} from '../../src/core/embeddings/runtime-support.js';

const executeQueryMock = vi.fn();
const embedQueryMock = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));
vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: (...args: unknown[]) => embedQueryMock(...args),
  getEmbeddingDims: () => 384,
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

interface SemanticSearchable {
  semanticSearch(repo: { lbugPath: string }, query: string, limit: number): Promise<unknown[]>;
}
const callSemanticSearch = (b: LocalBackend): Promise<unknown[]> =>
  (b as unknown as SemanticSearchable).semanticSearch({ lbugPath: '/tmp/x' }, 'q', 5);

const stackWarns = (cap: LoggerCapture): number =>
  cap
    .records()
    .filter(
      (r) =>
        typeof r.msg === 'string' &&
        r.msg.includes('query:vector') &&
        r.msg.includes('local embedding stack is not installed'),
    ).length;

describe('LocalBackend.semanticSearch — missing-stack warning (#2372)', () => {
  beforeEach(() => {
    executeQueryMock.mockReset().mockResolvedValue([{ cnt: 5 }]);
    embedQueryMock.mockReset();
  });

  it('warns once with the actionable message and returns [] on a pruned stack', async () => {
    embedQueryMock.mockRejectedValue(new Error(localEmbeddingStackMissingMessage()));
    const backend = new LocalBackend();
    const cap = _captureLogger();
    try {
      expect(await callSemanticSearch(backend)).toEqual([]);
      expect(await callSemanticSearch(backend)).toEqual([]);
      expect(stackWarns(cap)).toBe(1); // once per LocalBackend instance
      expect(
        (backend as unknown as { lastVectorDegradedReason?: string }).lastVectorDegradedReason,
      ).toContain('local embedding stack is not installed');
    } finally {
      cap.restore();
    }
  });

  it('stashes sidecar-abort text for query() warnings', async () => {
    embedQueryMock.mockRejectedValue(new Error(LOCAL_EMBEDDING_SIDECAR_ABORT_LEAD));
    const backend = new LocalBackend();
    const cap = _captureLogger();
    try {
      expect(await callSemanticSearch(backend)).toEqual([]);
      expect(
        (backend as unknown as { lastVectorDegradedReason?: string }).lastVectorDegradedReason,
      ).toBe(LOCAL_EMBEDDING_SIDECAR_ABORT_LEAD);
      expect(
        cap.records().some((r) => typeof r.msg === 'string' && r.msg.includes('sidecar aborted')),
      ).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it('stays silent for an unrelated error', async () => {
    embedQueryMock.mockRejectedValue(new Error('some unrelated failure'));
    const backend = new LocalBackend();
    const cap = _captureLogger();
    try {
      expect(await callSemanticSearch(backend)).toEqual([]);
      expect(stackWarns(cap)).toBe(0);
    } finally {
      cap.restore();
    }
  });
});
