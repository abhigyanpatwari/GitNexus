import { defaultEmbeddingThreads } from '../platform/capabilities.js';
import { logger } from '../logger.js';
import { DEFAULT_EMBEDDING_CONFIG, type EmbeddingConfig } from './types.js';

export const DEFAULT_VECTOR_MAX_DISTANCE = 0.5;
export const DEFAULT_MCP_VECTOR_MAX_DISTANCE = 0.6;

/**
 * Cosine distance over normalized embeddings is bounded to [0, 2], so any threshold
 * above this accepts every row and silently disables the relevance filter. Values
 * over the ceiling are clamped to it rather than passed through.
 */
export const VECTOR_MAX_DISTANCE_CEILING = 2;

const warned = new Set<string>();

const warnOnce = (key: string, message: string): void => {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
};

/**
 * Resolve the effective max accepted vector/semantic cosine distance.
 * Reads `GITNEXUS_VECTOR_MAX_DISTANCE`. Unset/empty/whitespace → silent fallback.
 * Invalid (non-numeric, <= 0, non-finite) → fallback plus a one-time warning.
 * Values above the cosine ceiling (2) are clamped to it with a one-time warning.
 */
export const getVectorMaxDistance = (fallback: number = DEFAULT_VECTOR_MAX_DISTANCE): number => {
  const raw = process.env.GITNEXUS_VECTOR_MAX_DISTANCE;
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warnOnce(
      `invalid:${raw}`,
      `  GITNEXUS_VECTOR_MAX_DISTANCE must be a positive number in (0, ${VECTOR_MAX_DISTANCE_CEILING}], got "${raw}" — using default ${fallback}`,
    );
    return fallback;
  }
  if (parsed > VECTOR_MAX_DISTANCE_CEILING) {
    warnOnce(
      `clamp:${raw}`,
      `  GITNEXUS_VECTOR_MAX_DISTANCE=${parsed} exceeds the cosine-distance ceiling (${VECTOR_MAX_DISTANCE_CEILING}) — clamping`,
    );
    return VECTOR_MAX_DISTANCE_CEILING;
  }
  return parsed;
};

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

/**
 * Resolve the local (transformers.js) model id. Reads `GITNEXUS_EMBEDDING_MODEL_ID`;
 * unset or blank falls back to the explicit config, then the built-in default.
 * HTTP mode names its model with `GITNEXUS_EMBEDDING_MODEL` instead.
 */
const resolveLocalModelId = (value: string | undefined, fallback: string): string => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
};

/** The local model id from the environment alone, without resolving the rest of the config. */
export const resolveLocalEmbeddingModelId = (): string =>
  resolveLocalModelId(process.env.GITNEXUS_EMBEDDING_MODEL_ID, DEFAULT_EMBEDDING_CONFIG.modelId);

/** A local model returned vectors of another width than the configured one. */
export class LocalEmbeddingDimensionError extends Error {
  constructor(modelId: string, actual: number, expected: number) {
    super(
      `Embedding dimension mismatch: local model ${modelId} returned ${actual}d vectors, ` +
        `but expected ${expected}d. Set GITNEXUS_EMBEDDING_DIMS=${actual} to match your model output.`,
    );
    this.name = 'LocalEmbeddingDimensionError';
  }
}

/**
 * Vector width of the local model. The built-in model is always
 * {@link DEFAULT_EMBEDDING_CONFIG.dimensions}; a custom model takes
 * `GITNEXUS_EMBEDDING_DIMS`, the same value the vector column is created with.
 */
export const resolveLocalEmbeddingDimensions = (): number => {
  if (resolveLocalEmbeddingModelId() === DEFAULT_EMBEDDING_CONFIG.modelId) {
    return DEFAULT_EMBEDDING_CONFIG.dimensions;
  }
  const raw = process.env.GITNEXUS_EMBEDDING_DIMS;
  if (raw === undefined) return DEFAULT_EMBEDDING_CONFIG.dimensions;
  if (!/^\d+$/.test(raw) || parseInt(raw, 10) <= 0) {
    throw new Error(`GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${raw}"`);
  }
  return parseInt(raw, 10);
};

export const resolveEmbeddingConfig = (
  overrides: Partial<EmbeddingConfig> = {},
): EmbeddingConfig => {
  const env = process.env;
  const chunkSizeValue = env.GITNEXUS_EMBEDDING_CHUNK_SIZE?.trim();
  const overlapValue = env.GITNEXUS_EMBEDDING_CHUNK_OVERLAP?.trim();
  const strategyValue = env.GITNEXUS_EMBEDDING_CHUNK_STRATEGY?.trim();
  const chunkSize = chunkSizeValue
    ? Number(chunkSizeValue)
    : (overrides.chunkSize ?? DEFAULT_EMBEDDING_CONFIG.chunkSize);
  const overlap = overlapValue
    ? Number(overlapValue)
    : (overrides.overlap ?? DEFAULT_EMBEDDING_CONFIG.overlap);
  const chunkStrategy =
    strategyValue || (overrides.chunkStrategy ?? DEFAULT_EMBEDDING_CONFIG.chunkStrategy);
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 2) {
    throw new Error('GITNEXUS_EMBEDDING_CHUNK_SIZE must be a safe integer of at least 2');
  }
  if (!Number.isSafeInteger(overlap) || overlap < 0 || overlap >= chunkSize) {
    throw new Error(
      'GITNEXUS_EMBEDDING_CHUNK_OVERLAP must be a safe integer from 0 to chunkSize - 1',
    );
  }
  if (chunkStrategy !== 'ast' && chunkStrategy !== 'fixed') {
    throw new Error('GITNEXUS_EMBEDDING_CHUNK_STRATEGY must be ast or fixed');
  }
  const maxInputChars = parsePositiveInt(
    'GITNEXUS_EMBEDDING_MAX_INPUT_CHARS',
    env.GITNEXUS_EMBEDDING_MAX_INPUT_CHARS,
    overrides.maxInputChars ?? DEFAULT_EMBEDDING_CONFIG.maxInputChars,
  );
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars < 2) {
    throw new Error('GITNEXUS_EMBEDDING_MAX_INPUT_CHARS must be a safe integer of at least 2');
  }
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...overrides,
    modelId: resolveLocalModelId(
      env.GITNEXUS_EMBEDDING_MODEL_ID,
      overrides.modelId ?? DEFAULT_EMBEDDING_CONFIG.modelId,
    ),
    chunkSize,
    overlap,
    chunkStrategy,
    maxInputChars,
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
