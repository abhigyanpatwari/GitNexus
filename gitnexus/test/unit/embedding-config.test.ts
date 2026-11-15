import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveEmbeddingConfig } from '../../src/core/embeddings/config.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../../src/core/embeddings/types.js';

const OLD_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.GITNEXUS_EMBEDDING_MODEL_ID;
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('resolveEmbeddingConfig', () => {
  it('applies env overrides for local resource controls', () => {
    process.env.GITNEXUS_EMBEDDING_THREADS = '3';
    process.env.GITNEXUS_EMBEDDING_BATCH_SIZE = '7';
    process.env.GITNEXUS_EMBEDDING_SUB_BATCH_SIZE = '5';
    process.env.GITNEXUS_EMBEDDING_DEVICE = 'cpu';

    const config = resolveEmbeddingConfig();

    expect(config.threads).toBe(3);
    expect(config.batchSize).toBe(7);
    expect(config.subBatchSize).toBe(5);
    expect(config.device).toBe('cpu');
  });

  it('reads the local model id from GITNEXUS_EMBEDDING_MODEL_ID over explicit config', () => {
    process.env.GITNEXUS_EMBEDDING_MODEL_ID = '  Xenova/bge-base-en-v1.5  ';
    expect(resolveEmbeddingConfig({ modelId: 'other/model' }).modelId).toBe(
      'Xenova/bge-base-en-v1.5',
    );
  });

  it('keeps the explicit or default model id when GITNEXUS_EMBEDDING_MODEL_ID is unset or blank', () => {
    expect(resolveEmbeddingConfig().modelId).toBe(DEFAULT_EMBEDDING_CONFIG.modelId);
    process.env.GITNEXUS_EMBEDDING_MODEL_ID = '   ';
    expect(resolveEmbeddingConfig().modelId).toBe(DEFAULT_EMBEDDING_CONFIG.modelId);
    expect(resolveEmbeddingConfig({ modelId: 'other/model' }).modelId).toBe('other/model');
  });

  it('rejects invalid numeric env values', () => {
    process.env.GITNEXUS_EMBEDDING_THREADS = '0';

    expect(() => resolveEmbeddingConfig()).toThrow('GITNEXUS_EMBEDDING_THREADS');
  });

  it('resolves the final generated input budget from env over explicit config', () => {
    process.env.GITNEXUS_EMBEDDING_MAX_INPUT_CHARS = '2048';
    expect(resolveEmbeddingConfig({ maxInputChars: 8192 }).maxInputChars).toBe(2048);
  });

  it.each(['1', '0', '-1', '2.5', 'Infinity', '9007199254740992'])(
    'rejects invalid final input budget %s',
    (value) => {
      process.env.GITNEXUS_EMBEDDING_MAX_INPUT_CHARS = value;
      expect(() => resolveEmbeddingConfig()).toThrow('GITNEXUS_EMBEDDING_MAX_INPUT_CHARS');
    },
  );
});

describe('chunk policy configuration (#702)', () => {
  it('retains existing defaults and treats blank environment controls as unset', () => {
    process.env.GITNEXUS_EMBEDDING_CHUNK_SIZE = ' ';
    process.env.GITNEXUS_EMBEDDING_CHUNK_OVERLAP = '';
    process.env.GITNEXUS_EMBEDDING_CHUNK_STRATEGY = '\t';
    expect(resolveEmbeddingConfig()).toMatchObject({
      chunkSize: 1200,
      overlap: 120,
      chunkStrategy: 'ast',
    });
    expect(
      resolveEmbeddingConfig({ chunkSize: 500, overlap: 50, chunkStrategy: 'fixed' }),
    ).toMatchObject({ chunkSize: 500, overlap: 50, chunkStrategy: 'fixed' });
  });

  it('resolves environment controls over explicit values and accepts zero overlap', () => {
    process.env.GITNEXUS_EMBEDDING_CHUNK_SIZE = '500';
    process.env.GITNEXUS_EMBEDDING_CHUNK_OVERLAP = '0';
    process.env.GITNEXUS_EMBEDDING_CHUNK_STRATEGY = 'fixed';
    expect(
      resolveEmbeddingConfig({ chunkSize: 1000, overlap: 100, chunkStrategy: 'ast' }),
    ).toMatchObject({ chunkSize: 500, overlap: 0, chunkStrategy: 'fixed' });
  });

  it.each(['1', '0', '-1', '1.5', 'Infinity', '9007199254740992', 'garbage'])(
    'rejects invalid chunk size %s',
    (value) => {
      process.env.GITNEXUS_EMBEDDING_CHUNK_SIZE = value;
      expect(() => resolveEmbeddingConfig()).toThrow('GITNEXUS_EMBEDDING_CHUNK_SIZE');
    },
  );

  it.each(['-1', '1.5', 'Infinity', '1200', '1300', '9007199254740992', 'garbage'])(
    'rejects invalid overlap %s',
    (value) => {
      process.env.GITNEXUS_EMBEDDING_CHUNK_OVERLAP = value;
      expect(() => resolveEmbeddingConfig()).toThrow('GITNEXUS_EMBEDDING_CHUNK_OVERLAP');
    },
  );

  it('validates the effective pair, including programmatic overrides', () => {
    expect(() => resolveEmbeddingConfig({ chunkSize: 100 })).toThrow(
      'GITNEXUS_EMBEDDING_CHUNK_OVERLAP',
    );
    expect(() => resolveEmbeddingConfig({ chunkSize: NaN })).toThrow(
      'GITNEXUS_EMBEDDING_CHUNK_SIZE',
    );
    expect(() => resolveEmbeddingConfig({ overlap: -1 })).toThrow(
      'GITNEXUS_EMBEDDING_CHUNK_OVERLAP',
    );
    process.env.GITNEXUS_EMBEDDING_CHUNK_STRATEGY = 'unknown';
    expect(() => resolveEmbeddingConfig()).toThrow('GITNEXUS_EMBEDDING_CHUNK_STRATEGY');
  });
});
