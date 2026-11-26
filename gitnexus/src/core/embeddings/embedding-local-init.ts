/**
 * Child-only local ONNX embedder.
 *
 * Imported solely by `embedding-sidecar.ts`. Parent processes must not import
 * this module — it loads transformers.js / onnxruntime-node after the platform
 * guard, which is what isolation is meant to keep out of analyze/serve/MCP.
 */

if (!process.env.ORT_LOG_LEVEL) {
  process.env.ORT_LOG_LEVEL = '3';
}

import type { FeatureExtractionPipeline, ProgressInfo } from '@huggingface/transformers';
import {
  DEFAULT_EMBEDDING_CONFIG,
  type EmbeddingConfig,
  type ModelProgress,
  type ModelProgressCallback,
} from './types.js';
import type { EmbeddingSidecarDevice } from './embedding-sidecar-protocol.js';
import { resolveEmbeddingConfig } from './config.js';
import { applyHfEnvOverrides, isHfDownloadFailure, withHfDownloadRetry } from './hf-env.js';
import {
  getLocalEmbeddingRuntimeBlocker,
  getMissingLocalEmbeddingStackMessage,
} from './runtime-support.js';
import { ensureOnnxRuntimeCommonResolvable } from './onnxruntime-common-resolver.js';
import { ensureEmbeddingStackResolvable } from './runtime-install.js';
import {
  ensureOnnxRuntimeNodeMatchesSystem,
  isEffectiveCudaAvailable,
} from './onnxruntime-node-resolver.js';
import { logger } from '../logger.js';

let embedderInstance: FeatureExtractionPipeline | null = null;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;
let currentDevice: EmbeddingSidecarDevice | null = null;
let activeDimensions = DEFAULT_EMBEDDING_CONFIG.dimensions;

const formatDeviceLabel = (device: EmbeddingSidecarDevice): string => {
  switch (device) {
    case 'dml':
      return 'GPU (DirectML/DirectX12)';
    case 'cuda':
      return 'GPU (CUDA)';
    default:
      return device.toUpperCase();
  }
};

export const getCurrentDevice = (): EmbeddingSidecarDevice | null => currentDevice;

/**
 * Fixed texts embedded on the GPU device and on CPU at init (#3685). Some
 * DirectML adapters return vectors in a different space from CPU, which would
 * silently break semantic search against CPU-built or query-time vectors.
 */
export const GPU_PARITY_PROBE_TEXTS = [
  'function: parseConfig\nexport function parseConfig(path: string): Config { return JSON.parse(readFileSync(path, "utf8")); }',
  'class: UserRepository\nclass UserRepository:\n    def find_by_email(self, email):\n        return self.session.query(User).filter_by(email=email).first()',
];

/** fp32 GPU vs CPU agree to ~1e-5; the reported DirectML vectors had cosine ~0.37. */
export const GPU_PARITY_MIN_COSINE = 0.99;

const embedProbe = async (embedder: FeatureExtractionPipeline): Promise<Float32Array[]> => {
  const result = await embedder(GPU_PARITY_PROBE_TEXTS, { pooling: 'mean', normalize: true });
  const data = result.data as ArrayLike<number>;
  const dims = (result as { dims?: number[] }).dims;
  const width = dims?.[dims.length - 1] ?? data.length / GPU_PARITY_PROBE_TEXTS.length;
  return GPU_PARITY_PROBE_TEXTS.map(
    (_, i) => new Float32Array(Array.prototype.slice.call(data, i * width, (i + 1) * width)),
  );
};

const disposeQuietly = async (embedder: FeatureExtractionPipeline | null): Promise<void> => {
  try {
    await embedder?.dispose();
  } catch {
    // Best effort: a failed release must not change which device is used.
  }
};

const cosine = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? -1 : dot / Math.sqrt(na * nb);
};

/**
 * Embeds the probe texts on `gpuEmbedder` and on a CPU pipeline. Returns the
 * CPU pipeline when they disagree (the caller switches to it), or null when the
 * GPU vectors match. If the check itself fails, the GPU pipeline is kept.
 */
export const checkGpuParity = async (
  gpuEmbedder: FeatureExtractionPipeline,
  device: EmbeddingSidecarDevice,
  loadPipeline: (device: EmbeddingSidecarDevice) => Promise<FeatureExtractionPipeline>,
): Promise<FeatureExtractionPipeline | null> => {
  let cpuEmbedder: FeatureExtractionPipeline | null = null;
  let minCosine: number;
  try {
    cpuEmbedder = await loadPipeline('cpu');
    const gpuVectors = await embedProbe(gpuEmbedder);
    const cpuVectors = await embedProbe(cpuEmbedder);
    minCosine = Math.min(...gpuVectors.map((vec, i) => cosine(vec, cpuVectors[i])));
  } catch (err) {
    logger.warn(
      { device, err: err instanceof Error ? err.message : String(err) },
      `⚠️  Could not compare ${formatDeviceLabel(device)} embeddings with CPU; keeping ${device}`,
    );
    await disposeQuietly(cpuEmbedder);
    return null;
  }

  if (minCosine >= GPU_PARITY_MIN_COSINE) {
    await disposeQuietly(cpuEmbedder);
    return null;
  }
  logger.warn(
    { device, minCosine },
    `⚠️  ${formatDeviceLabel(device)} embeddings do not match CPU (cosine ${minCosine.toFixed(3)}); using CPU instead`,
  );
  await disposeQuietly(gpuEmbedder);
  return cpuEmbedder;
};

export const initLocalEmbedder = async (
  onProgress?: ModelProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  forceDevice?: EmbeddingSidecarDevice,
): Promise<FeatureExtractionPipeline> => {
  const runtimeBlocker = getLocalEmbeddingRuntimeBlocker();
  if (runtimeBlocker) {
    throw new Error(runtimeBlocker);
  }

  if (embedderInstance) {
    return embedderInstance;
  }

  if (initPromise) {
    return initPromise;
  }

  const finalConfig = resolveEmbeddingConfig(config);
  const gpuDevice: EmbeddingSidecarDevice = isEffectiveCudaAvailable()
    ? 'cuda'
    : process.platform === 'win32'
      ? 'dml'
      : 'cpu';
  const requestedDevice =
    forceDevice || (finalConfig.device === 'auto' ? gpuDevice : finalConfig.device);

  initPromise = (async () => {
    try {
      ensureEmbeddingStackResolvable();
      ensureOnnxRuntimeCommonResolvable();
      ensureOnnxRuntimeNodeMatchesSystem();
      const { pipeline, env } = await import('@huggingface/transformers').catch((err: unknown) => {
        const missing = getMissingLocalEmbeddingStackMessage(err);
        if (missing) throw new Error(missing);
        throw err;
      });

      env.allowLocalModels = false;
      applyHfEnvOverrides(env);

      const isDev = process.env.NODE_ENV === 'development';
      if (isDev) {
        logger.info(`🧠 Loading embedding model: ${finalConfig.modelId}`);
      }

      const progressCallback = onProgress
        ? (data: ProgressInfo) => {
            const progress: ModelProgress = {
              status:
                data.status === 'progress_total'
                  ? 'progress'
                  : ((data.status as ModelProgress['status']) ?? 'progress'),
              file: 'file' in data ? data.file : undefined,
              progress: 'progress' in data ? data.progress : undefined,
              loaded: 'loaded' in data ? data.loaded : undefined,
              total: 'total' in data ? data.total : undefined,
            };
            onProgress(progress);
          }
        : undefined;

      const devicesToTry: EmbeddingSidecarDevice[] =
        requestedDevice === 'dml' || requestedDevice === 'cuda'
          ? [requestedDevice, 'cpu']
          : [requestedDevice];

      const loadPipeline = (device: EmbeddingSidecarDevice): Promise<FeatureExtractionPipeline> =>
        withHfDownloadRetry(
          () =>
            pipeline('feature-extraction', finalConfig.modelId, {
              device: device,
              dtype: 'fp32',
              progress_callback: progressCallback,
              session_options: {
                logSeverityLevel: 3,
                intraOpNumThreads: finalConfig.threads,
                interOpNumThreads: 1,
                executionMode: 'sequential',
              },
            }),
          {
            onRetry: isDev
              ? (attempt, max, err) =>
                  logger.warn(
                    { attempt, max, err: err.message },
                    `⚠️  Model download network error (attempt ${attempt}/${max}), retrying…`,
                  )
              : undefined,
          },
        );

      for (const device of devicesToTry) {
        try {
          if (isDev && device === 'dml') {
            logger.info('🔧 Trying DirectML (DirectX12) GPU backend...');
          } else if (isDev && device === 'cuda') {
            logger.info('🔧 Trying CUDA GPU backend...');
          } else if (isDev && device === 'cpu') {
            logger.info('🔧 Using CPU backend...');
          } else if (isDev && device === 'wasm') {
            logger.info('🔧 Using WASM backend (slower)...');
          }

          embedderInstance = await loadPipeline(device);
          currentDevice = device;
          activeDimensions = finalConfig.dimensions;

          if (device === 'dml' || device === 'cuda') {
            const cpuEmbedder = await checkGpuParity(embedderInstance, device, loadPipeline);
            if (cpuEmbedder) {
              embedderInstance = cpuEmbedder;
              currentDevice = 'cpu';
              return embedderInstance;
            }
          }

          if (isDev) {
            logger.info(`✅ Using ${formatDeviceLabel(device)} backend`);
            logger.info('✅ Embedding model loaded successfully');
          }

          return embedderInstance!;
        } catch (deviceError) {
          const errMsg = deviceError instanceof Error ? deviceError.message : String(deviceError);
          if (isHfDownloadFailure(errMsg)) {
            const endpointHint = process.env.HF_ENDPOINT
              ? `The configured endpoint (${process.env.HF_ENDPOINT}) may be unreachable.`
              : `huggingface.co may be unreachable from your network.\n` +
                `  Set HF_ENDPOINT to a mirror and retry:\n` +
                `    HF_ENDPOINT=https://hf-mirror.com npx gitnexus analyze --embeddings\n` +
                `    (Windows: set HF_ENDPOINT=https://hf-mirror.com && npx gitnexus analyze --embeddings)`;
            throw new Error(`Failed to download embedding model: ${errMsg}\n  ${endpointHint}`);
          }
          if (isDev && (device === 'cuda' || device === 'dml')) {
            const gpuType = device === 'dml' ? 'DirectML' : 'CUDA';
            logger.info(`⚠️  ${gpuType} not available, falling back to CPU...`);
          }
          if (device === devicesToTry[devicesToTry.length - 1]) {
            throw deviceError;
          }
        }
      }

      throw new Error('No suitable device found for embedding model');
    } catch (error) {
      initPromise = null;
      embedderInstance = null;
      throw error;
    }
  })();

  return initPromise;
};

const getLocalEmbedder = (): FeatureExtractionPipeline => {
  if (!embedderInstance) {
    throw new Error('Embedder not initialized. Call initLocalEmbedder() first.');
  }
  return embedderInstance;
};

export const localEmbedBatch = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) {
    return [];
  }

  const embedder = getLocalEmbedder();
  const result = await embedder(texts, {
    pooling: 'mean',
    normalize: true,
  });

  const data = result.data as ArrayLike<number>;
  const dims = (result as { dims?: number[] }).dims;
  const dimensions =
    typeof dims?.[dims.length - 1] === 'number' ? dims[dims.length - 1] : activeDimensions;
  const embeddings: Float32Array[] = [];

  for (let i = 0; i < texts.length; i++) {
    const start = i * dimensions;
    const end = start + dimensions;
    embeddings.push(new Float32Array(Array.prototype.slice.call(data, start, end)));
  }

  return embeddings;
};
