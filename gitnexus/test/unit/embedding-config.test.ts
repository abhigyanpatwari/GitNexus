import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadCLIConfig = vi.fn();
const loadCLIConfigSync = vi.fn();

vi.mock('../../src/storage/repo-manager.js', () => ({
  loadCLIConfig,
  loadCLIConfigSync,
}));

const ENV_KEYS = [
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_API_KEY',
  'GITNEXUS_EMBEDDING_DIMS',
] as const;

describe('embedding config resolver', () => {
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    vi.resetModules();
    loadCLIConfig.mockResolvedValue({});
    loadCLIConfigSync.mockReturnValue({});
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.clearAllMocks();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('prefers explicit overrides over saved config and env', async () => {
    loadCLIConfigSync.mockReturnValue({
      embedding: {
        provider: 'custom',
        baseUrl: 'https://config.example/v1',
        model: 'config-model',
        apiKey: 'config-key',
        dimensions: 1024,
      },
    });
    process.env.GITNEXUS_EMBEDDING_URL = 'https://env.example/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'env-model';
    process.env.GITNEXUS_EMBEDDING_DIMS = '2048';

    const { resolveEmbeddingConfigSync } = await import('../../src/core/embeddings/config.js');
    const resolved = resolveEmbeddingConfigSync({
      provider: 'openai',
      baseUrl: 'https://override.example/v1',
      model: 'override-model',
      apiKey: 'override-key',
      dimensions: 3072,
    });

    expect(resolved).toMatchObject({
      mode: 'http',
      provider: 'openai',
      baseUrl: 'https://override.example/v1',
      model: 'override-model',
      apiKey: 'override-key',
      dimensions: 3072,
      explicitDimensionsSource: 'overrides',
    });
  });

  it('uses saved config before env fallback', async () => {
    loadCLIConfigSync.mockReturnValue({
      embedding: {
        provider: 'custom',
        baseUrl: 'https://config.example/v1',
        model: 'config-model',
        apiKey: 'config-key',
        dimensions: 1536,
      },
    });
    process.env.GITNEXUS_EMBEDDING_URL = 'https://env.example/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'env-model';
    process.env.GITNEXUS_EMBEDDING_DIMS = '2048';

    const { resolveEmbeddingConfigSync } = await import('../../src/core/embeddings/config.js');
    const resolved = resolveEmbeddingConfigSync();

    expect(resolved).toMatchObject({
      mode: 'http',
      provider: 'custom',
      baseUrl: 'https://config.example/v1',
      model: 'config-model',
      apiKey: 'config-key',
      dimensions: 1536,
      explicitDimensionsSource: 'config',
    });
  });

  it('falls back to environment configuration when saved config is empty', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'https://env.example/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'env-model';
    process.env.GITNEXUS_EMBEDDING_API_KEY = 'env-key';
    process.env.GITNEXUS_EMBEDDING_DIMS = '768';

    const { resolveEmbeddingConfigSync } = await import('../../src/core/embeddings/config.js');
    const resolved = resolveEmbeddingConfigSync();

    expect(resolved).toMatchObject({
      mode: 'http',
      provider: 'custom',
      baseUrl: 'https://env.example/v1',
      model: 'env-model',
      apiKey: 'env-key',
      dimensions: 768,
      explicitDimensionsSource: 'env',
    });
  });

  it('falls back to local defaults when no HTTP backend is configured', async () => {
    const { resolveEmbeddingConfigSync } = await import('../../src/core/embeddings/config.js');
    const resolved = resolveEmbeddingConfigSync();

    expect(resolved).toMatchObject({
      mode: 'local',
      provider: 'local',
      model: 'Snowflake/snowflake-arctic-embed-xs',
      dimensions: 384,
      apiKey: '',
    });
    expect(resolved.baseUrl).toBeUndefined();
    expect(resolved.explicitDimensionsSource).toBeUndefined();
  });

  it('ignores custom dimensions when local mode is forced', async () => {
    loadCLIConfigSync.mockReturnValue({
      embedding: {
        provider: 'local',
        dimensions: 3072,
      },
    });
    process.env.GITNEXUS_EMBEDDING_DIMS = '2048';

    const { resolveEmbeddingConfigSync } = await import('../../src/core/embeddings/config.js');
    const resolved = resolveEmbeddingConfigSync();

    expect(resolved.mode).toBe('local');
    expect(resolved.dimensions).toBe(384);
    expect(resolved.explicitDimensionsSource).toBeUndefined();
  });

  it('supports async resolution from saved config', async () => {
    loadCLIConfig.mockResolvedValue({
      embedding: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'text-embedding-model',
        apiKey: 'saved-key',
        dimensions: 1024,
      },
    });

    const { resolveEmbeddingConfig } = await import('../../src/core/embeddings/config.js');
    const resolved = await resolveEmbeddingConfig();

    expect(resolved).toMatchObject({
      mode: 'http',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'text-embedding-model',
      apiKey: 'saved-key',
      dimensions: 1024,
      explicitDimensionsSource: 'config',
    });
  });

  it('throws when dimensions are invalid', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'https://env.example/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'env-model';
    process.env.GITNEXUS_EMBEDDING_DIMS = '0';

    const { resolveEmbeddingConfigSync } = await import('../../src/core/embeddings/config.js');

    expect(() => resolveEmbeddingConfigSync()).toThrow(
      'GITNEXUS_EMBEDDING_DIMS must be a positive integer',
    );
  });
});
