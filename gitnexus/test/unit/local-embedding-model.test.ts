import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentHashForNode } from '../../src/core/embeddings/embedding-pipeline.js';
import { DEFAULT_EMBEDDING_CONFIG, type EmbeddableNode } from '../../src/core/embeddings/types.js';

const sidecarEmbedBatchMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/embeddings/embedding-sidecar-client.js', () => ({
  ensureEmbeddingSidecar: vi.fn(),
  getSidecarDevice: () => 'cpu',
  reapEmbeddingSidecarAndWait: vi.fn(),
  sidecarEmbedBatch: (...args: unknown[]) => sidecarEmbedBatchMock(...args),
}));

vi.mock('../../src/core/embeddings/runtime-support.js', () => ({
  assessLocalEmbeddingRuntime: () => ({ status: 'ready' }),
  getLocalEmbeddingRuntimeBlocker: () => null,
}));

const { embedBatch, embedText, getEmbeddingDimensions } =
  await import('../../src/core/embeddings/embedder.js');
const { resolveEmbeddingIdentity } =
  await import('../../src/core/embeddings/embedding-identity.js');

const ENV_KEYS = [
  'GITNEXUS_EMBEDDING_MODEL_ID',
  'GITNEXUS_EMBEDDING_DIMS',
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
] as const;
const savedEnv: Record<string, string | undefined> = {};

const vectors = (count: number, width: number): Float32Array[] =>
  Array.from({ length: count }, () => new Float32Array(width));

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  sidecarEmbedBatchMock.mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('local embedding model selection', () => {
  it('keeps the default model at 384 dimensions even when GITNEXUS_EMBEDDING_DIMS is set', () => {
    process.env.GITNEXUS_EMBEDDING_DIMS = '1024';
    expect(getEmbeddingDimensions()).toBe(DEFAULT_EMBEDDING_CONFIG.dimensions);
  });

  it('takes the vector width of a custom model from GITNEXUS_EMBEDDING_DIMS', () => {
    process.env.GITNEXUS_EMBEDDING_MODEL_ID = 'Xenova/bge-base-en-v1.5';
    expect(getEmbeddingDimensions()).toBe(384);
    process.env.GITNEXUS_EMBEDDING_DIMS = '768';
    expect(getEmbeddingDimensions()).toBe(768);
    process.env.GITNEXUS_EMBEDDING_DIMS = '768x';
    expect(() => getEmbeddingDimensions()).toThrow(
      'GITNEXUS_EMBEDDING_DIMS must be a positive integer',
    );
  });

  it('records the custom model and its width in the embedding identity', () => {
    process.env.GITNEXUS_EMBEDDING_MODEL_ID = 'Xenova/bge-base-en-v1.5';
    process.env.GITNEXUS_EMBEDDING_DIMS = '768';
    expect(resolveEmbeddingIdentity()).toEqual({
      model: 'Xenova/bge-base-en-v1.5',
      dimensions: 768,
      provider: 'local',
    });
  });

  it('rejects local vectors whose width differs from the configured dimensions', async () => {
    process.env.GITNEXUS_EMBEDDING_MODEL_ID = 'Xenova/bge-base-en-v1.5';
    sidecarEmbedBatchMock.mockResolvedValue(vectors(2, 768));

    await expect(embedBatch(['a', 'b'])).rejects.toThrow(
      'local model Xenova/bge-base-en-v1.5 returned 768d vectors, but expected 384d. ' +
        'Set GITNEXUS_EMBEDDING_DIMS=768',
    );
    sidecarEmbedBatchMock.mockResolvedValue(vectors(1, 768));
    await expect(embedText('a')).rejects.toThrow('Set GITNEXUS_EMBEDDING_DIMS=768');
  });

  it('returns local vectors that match the configured dimensions', async () => {
    process.env.GITNEXUS_EMBEDDING_MODEL_ID = 'Xenova/bge-base-en-v1.5';
    process.env.GITNEXUS_EMBEDDING_DIMS = '768';
    sidecarEmbedBatchMock.mockResolvedValue(vectors(2, 768));

    const result = await embedBatch(['a', 'b']);
    expect(result.map((vec) => vec.length)).toEqual([768, 768]);
  });

  it('changes the content hash for a custom model only', () => {
    const node: EmbeddableNode = {
      id: 'Function:foo:src/main.ts',
      name: 'foo',
      label: 'Function',
      filePath: 'src/main.ts',
      content: 'function foo() { return 1; }',
    };
    const base = contentHashForNode(node);

    expect(contentHashForNode(node, { modelId: DEFAULT_EMBEDDING_CONFIG.modelId })).toBe(base);
    const custom = contentHashForNode(node, { modelId: 'Xenova/bge-base-en-v1.5' });
    expect(custom).not.toBe(base);
    expect(contentHashForNode(node, { modelId: 'Xenova/bge-small-en-v1.5' })).not.toBe(custom);
  });
});
