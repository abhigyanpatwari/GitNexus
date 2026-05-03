import { defaultEmbeddingThreads } from '../platform/capabilities.js';
import { DEFAULT_EMBEDDING_CONFIG, type EmbeddingConfig } from './types.js';

const parsePositiveInt = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
};

const parseDevice = (value: string | undefined): EmbeddingConfig['device'] | undefined => {
  if (value === undefined) return undefined;
  if (
    value === 'auto' ||
    value === 'dml' ||
    value === 'cuda' ||
    value === 'cpu' ||
    value === 'wasm'
  ) {
    return value;
  }
  throw new Error(`embedding device must be one of auto, dml, cuda, cpu, wasm; got "${value}"`);
};

export const resolveEmbeddingConfig = (
  overrides: Partial<EmbeddingConfig> = {},
): EmbeddingConfig => {
  const env = process.env;
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...overrides,
    batchSize: parsePositiveInt(
      'GITNEXUS_EMBEDDING_BATCH_SIZE',
      env.GITNEXUS_EMBEDDING_BATCH_SIZE,
      overrides.batchSize ?? DEFAULT_EMBEDDING_CONFIG.batchSize,
    ),
    subBatchSize: parsePositiveInt(
      'GITNEXUS_EMBEDDING_SUB_BATCH_SIZE',
      env.GITNEXUS_EMBEDDING_SUB_BATCH_SIZE,
      overrides.subBatchSize ?? DEFAULT_EMBEDDING_CONFIG.subBatchSize,
    ),
    threads: parsePositiveInt(
      'GITNEXUS_EMBEDDING_THREADS',
      env.GITNEXUS_EMBEDDING_THREADS,
      overrides.threads ?? defaultEmbeddingThreads(),
    ),
    device:
      parseDevice(env.GITNEXUS_EMBEDDING_DEVICE) ??
      overrides.device ??
      DEFAULT_EMBEDDING_CONFIG.device,
  };
};
