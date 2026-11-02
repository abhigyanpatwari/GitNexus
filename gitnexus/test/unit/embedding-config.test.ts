import { afterEach, describe, expect, it } from 'vitest';
import { resolveEmbeddingConfig } from '../../src/core/embeddings/config.js';

const OLD_ENV = { ...process.env };

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
