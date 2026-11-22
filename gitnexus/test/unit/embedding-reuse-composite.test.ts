import { describe, expect, it } from 'vitest';
import { CompositeEmbeddingReuseSource } from '../../src/core/embeddings/embedding-reuse-composite.js';
import type { EmbeddingReuseSource } from '../../src/core/embeddings/embedding-job-runner.js';
import type { EmbeddingReuseOptions } from '../../src/core/embeddings/embedding-inputs.js';
import type { VectorNodeReceipt } from '../../src/core/lbug/vector-store.js';

// The fakes never inspect the reuse options; only the shape matters here.
const OPTS = { node: null } as unknown as EmbeddingReuseOptions;

const receipt = (nodeId: string, chunks: number): VectorNodeReceipt => ({
  nodeId,
  contentHash: `hash-${nodeId}`,
  chunks,
  complete: true,
  sourceStartLine: 3,
});

const fakeSource = (
  name: string,
  receipts: Map<string, VectorNodeReceipt>,
  options: { batchBytes?: number; requiresInputValidation?: boolean } = {},
): EmbeddingReuseSource & { reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    options: { batchBytes: options.batchBytes ?? 1024 },
    requiresInputValidation: options.requiresInputValidation,
    reusable: async (nodeId) => receipts.get(nodeId) ?? null,
    readChunks: async (r, start, length) => {
      reads.push(`${name}:${r.nodeId}:${start}:${length}`);
      return [];
    },
  };
};

describe('CompositeEmbeddingReuseSource (#3631)', () => {
  it('serves the first source that can prove a node and routes its chunk reads back', async () => {
    const own = fakeSource('own', new Map([['n1', receipt('n1', 2)]]));
    const sibling = fakeSource(
      'sibling',
      new Map([
        ['n1', receipt('n1', 9)],
        ['n2', receipt('n2', 3)],
      ]),
    );
    const composite = new CompositeEmbeddingReuseSource([own, sibling]);

    const first = await composite.reusable('n1', 'hash-n1', OPTS);
    expect(first!.chunks).toBe(2);
    await composite.readChunks(first!, 0, 2);
    expect(own.reads).toEqual(['own:n1:0:2']);
    expect(sibling.reads).toEqual([]);

    const second = await composite.reusable('n2', 'hash-n2', OPTS);
    expect(second!.chunks).toBe(3);
    await composite.readChunks(second!, 1, 1);
    expect(sibling.reads).toEqual(['sibling:n2:1:1']);

    await expect(composite.reusable('nope', 'hash-nope', OPTS)).resolves.toBeNull();
  });

  it('attributes served nodes and chunks per source', async () => {
    const own = fakeSource('own', new Map([['n1', receipt('n1', 2)]]));
    const sibling = fakeSource(
      'sibling',
      new Map([
        ['n2', receipt('n2', 3)],
        ['n3', receipt('n3', 1)],
      ]),
    );
    const composite = new CompositeEmbeddingReuseSource([own, sibling]);
    await composite.reusable('n1', 'hash-n1', OPTS);
    await composite.reusable('n2', 'hash-n2', OPTS);
    await composite.reusable('n3', 'hash-n3', OPTS);
    expect(composite.statsFor(own)).toEqual({ nodes: 1, chunks: 2 });
    expect(composite.statsFor(sibling)).toEqual({ nodes: 2, chunks: 4 });
  });

  it('takes the smallest batch budget and ORs input validation', () => {
    const a = fakeSource('a', new Map(), { batchBytes: 4096 });
    const b = fakeSource('b', new Map(), { batchBytes: 1024, requiresInputValidation: true });
    const composite = new CompositeEmbeddingReuseSource([a, b]);
    expect(composite.options.batchBytes).toBe(1024);
    expect(composite.requiresInputValidation).toBe(true);
    expect(new CompositeEmbeddingReuseSource([a]).requiresInputValidation).toBe(false);
  });

  it('rejects chunk reads for receipts it never issued', async () => {
    const composite = new CompositeEmbeddingReuseSource([fakeSource('a', new Map())]);
    await expect(composite.readChunks(receipt('ghost', 1), 0, 1)).rejects.toThrow(/no origin/);
  });
});
