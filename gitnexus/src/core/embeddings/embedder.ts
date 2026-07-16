/**
 * Embedder Module
 *
 * Singleton factory for transformers.js embedding pipeline.
 * Handles model loading, caching, and both single and batch embedding operations.
 *
 * Uses snowflake-arctic-embed-xs by default (22M params, 384 dims, ~90MB)
 */

// Suppress ONNX Runtime native warnings (e.g. VerifyEachNodeIsAssignedToAnEp)
// Must be set BEFORE onnxruntime-node is imported by transformers.js
// Level 3 = Error only (skips Warning/Info)
if (!process.env.ORT_LOG_LEVEL) {
  process.env.ORT_LOG_LEVEL = '3';
}

// Type-only import: erased at compile time so loading this module never pulls
// in @huggingface/transformers (and its native onnxruntime-node binding) at
// runtime. The runtime values (pipeline, env) are dynamically imported inside
// initEmbedder, after the platform guard has passed (#1515).
import type { FeatureExtractionPipeline, ProgressInfo } from '@huggingface/transformers';
import { DEFAULT_EMBEDDING_CONFIG, type EmbeddingConfig, type ModelProgress } from './types.js';
import {
  isHttpMode,
  getHttpDimensions,
  httpEmbed,
  type EmbeddingRequestOptions,
} from './http-client.js';
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

// Module-level state for singleton pattern
let embedderInstance: FeatureExtractionPipeline | null = null;
let isInitializing = false;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;
let currentDevice: 'dml' | 'cuda' | 'cpu' | 'wasm' | null = null;

/**
 * Progress callback type for model loading
 */
export type ModelProgressCallback = (progress: ModelProgress) => void;

/**
 * Get the current device being used for inference
 */
export const getCurrentDevice = (): 'dml' | 'cuda' | 'cpu' | 'wasm' | null => currentDevice;

/**
 * Initialize the embedding model
 * Uses singleton pattern - only loads once, subsequent calls return cached instance
 *
 * @param onProgress - Optional callback for model download progress
 * @param config - Optional configuration override
 * @param forceDevice - Force a specific device
 * @returns Promise resolving to the embedder pipeline
 */
export const initEmbedder = async (
  onProgress?: ModelProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  forceDevice?: 'dml' | 'cuda' | 'cpu' | 'wasm',
): Promise<FeatureExtractionPipeline> => {
  if (isHttpMode()) {
    throw new Error(
      'initEmbedder() should not be called in HTTP mode. ' +
        'Use embedText()/embedBatch() which handle HTTP transparently.',
    );
  }

  // Fail fast on platforms where the bundled native ONNX Runtime binding is not
  // shipped (macOS Intel, #1515). Must run before any transformers.js /
  // onnxruntime-node import or resolution — otherwise the native module load
  // crashes with a raw "Cannot find module ...onnxruntime_binding.node" that
  // ONNX_WEB_BACKEND=wasm cannot rescue (#1516). HTTP mode was already handled
  // above, so this only blocks the local-runtime path.
  const runtimeBlocker = getLocalEmbeddingRuntimeBlocker();
  if (runtimeBlocker) {
    throw new Error(runtimeBlocker);
  }

  // Return existing instance if available
  if (embedderInstance) {
    return embedderInstance;
  }

  // If already initializing, wait for that promise
  if (isInitializing && initPromise) {
    return initPromise;
  }

  isInitializing = true;

  const finalConfig = resolveEmbeddingConfig(config);
  // CUDA is probe-gated because ONNX Runtime can crash in native code when
  // provider libraries are missing. DirectML stays opt-in for the same reason.
  // Probe for CUDA first — ONNX Runtime crashes (uncatchable native error)
  // if we attempt CUDA without the required shared libraries
  const gpuDevice = isEffectiveCudaAvailable() ? 'cuda' : 'cpu';
  const requestedDevice =
    forceDevice || (finalConfig.device === 'auto' ? gpuDevice : finalConfig.device);

  initPromise = (async () => {
    try {
      // Lazy-load transformers.js only after the runtime guard has passed, so
      // unsupported platforms never reach the native ONNX import (#1515).
      // Registered FIRST so it sits last in the hook chain (registerHooks runs
      // the most recent hook first): when the optional stack was pruned at
      // install time (#2370), its bare specifiers fall back to the on-demand
      // runtime prefix.
      ensureEmbeddingStackResolvable();
      // Under pnpm-strict / `pnpm dlx`, transformers' phantom `onnxruntime-common`
      // import is unresolvable; register the fallback resolver first (#307).
      ensureOnnxRuntimeCommonResolvable();
      // Registered AFTER the common fallback so this hook resolves FIRST (Node
      // runs the most-recently-registered hook first): on CUDA-13 hosts it
      // redirects onnxruntime-node (and its version-matched onnxruntime-common)
      // to the CUDA-13 build before transformers imports them. No-op on matching
      // layouts, non-CUDA, Windows/DirectML, and macOS.
      ensureOnnxRuntimeNodeMatchesSystem();
      // The stack is an optionalDependency: npm prunes it when onnxruntime-node's
      // postinstall can't reach api.nuget.org (#2370). Rethrow with actionable
      // reinstall guidance instead of a raw ERR_MODULE_NOT_FOUND.
      const { pipeline, env } = await import('@huggingface/transformers').catch((err: unknown) => {
        const missing = getMissingLocalEmbeddingStackMessage(err);
        if (missing) throw new Error(missing);
        throw err;
      });

      // Configure transformers.js environment
      env.allowLocalModels = false;
      // Bridge user-controlled env vars to transformers.js: HF_HOME →
      // env.cacheDir, HF_ENDPOINT → env.remoteHost (#1205). Centralised in
      // applyHfEnvOverrides so the MCP embedder entry point behaves
      // identically.
      applyHfEnvOverrides(env);

      const isDev = process.env.NODE_ENV === 'development';
      if (isDev) {
        logger.info(`🧠 Loading embedding model: ${finalConfig.modelId}`);
      }

      const progressCallback = onProgress
        ? (data: ProgressInfo) => {
            const progress: ModelProgress = {
              // Map the `progress_total` aggregate event (not in ModelProgress.status)
              // back to 'progress' so callers don't need to handle it separately.
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

      // Try GPU first if auto, fall back to CPU
      // Windows: dml (DirectML/DirectX12), Linux: cuda
      const devicesToTry: Array<'dml' | 'cuda' | 'cpu' | 'wasm'> =
        requestedDevice === 'dml' || requestedDevice === 'cuda'
          ? [requestedDevice, 'cpu']
          : [requestedDevice as 'cpu' | 'wasm'];

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

          embedderInstance = await withHfDownloadRetry(
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
          currentDevice = device;

          if (isDev) {
            const label =
              device === 'dml'
                ? 'GPU (DirectML/DirectX12)'
                : device === 'cuda'
                  ? 'GPU (CUDA)'
                  : device.toUpperCase();
            logger.info(`✅ Using ${label} backend`);
            logger.info('✅ Embedding model loaded successfully');
          }

          return embedderInstance!;
        } catch (deviceError) {
          // Network errors and circuit-open errors are not device-specific —
          // they will fail the same way on every device. Rethrow immediately
          // with actionable HF_ENDPOINT guidance rather than silently falling
          // back to the next device.
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
          // Continue to next device in list
          if (device === devicesToTry[devicesToTry.length - 1]) {
            throw deviceError; // Last device failed, propagate error
          }
        }
      }

      throw new Error('No suitable device found for embedding model');
    } catch (error) {
      isInitializing = false;
      initPromise = null;
      embedderInstance = null;
      throw error;
    } finally {
      isInitializing = false;
    }
  })();

  return initPromise;
};

/**
 * Check if the embedder is initialized and ready
 */
export const isEmbedderReady = (): boolean => {
  return isHttpMode() || embedderInstance !== null;
};

/**
 * Get the effective embedding dimensions.
 * In HTTP mode, uses GITNEXUS_EMBEDDING_DIMS if set, otherwise the default.
 */
export const getEmbeddingDimensions = (): number => {
  if (isHttpMode()) {
    return getHttpDimensions() ?? DEFAULT_EMBEDDING_CONFIG.dimensions;
  }
  return DEFAULT_EMBEDDING_CONFIG.dimensions;
};

/**
 * Get the embedder instance (throws if not initialized)
 */
export const getEmbedder = (): FeatureExtractionPipeline => {
  if (isHttpMode()) {
    throw new Error(
      'getEmbedder() is not available in HTTP embedding mode. Use embedText()/embedBatch() instead.',
    );
  }
  if (!embedderInstance) {
    throw new Error('Embedder not initialized. Call initEmbedder() first.');
  }
  return embedderInstance;
};

/**
 * Embed a single text string
 *
 * @param text - Text to embed
 * @returns Float32Array of embedding vector
 */
export const embedText = async (
  text: string,
  options: EmbeddingRequestOptions = {},
): Promise<Float32Array> => {
  options.signal?.throwIfAborted();
  if (isHttpMode()) {
    const [vec] = await httpEmbed([text], options);
    return vec;
  }

  const embedder = getEmbedder();

  const result = await embedder(text, {
    pooling: 'mean',
    normalize: true,
  });

  // Result is a Tensor, convert to Float32Array
  return new Float32Array(result.data as ArrayLike<number>);
};

/**
 * Embed multiple texts in a single batch
 * More efficient than calling embedText multiple times
 *
 * @param texts - Array of texts to embed
 * @returns Array of Float32Array embedding vectors
 */
export const embedBatch = async (
  texts: string[],
  options: EmbeddingRequestOptions = {},
): Promise<Float32Array[]> => {
  options.signal?.throwIfAborted();
  if (texts.length === 0) {
    return [];
  }

  if (isHttpMode()) {
    return httpEmbed(texts, options);
  }

  const embedder = getEmbedder();

  // Process batch
  const result = await embedder(texts, {
    pooling: 'mean',
    normalize: true,
  });
  options.signal?.throwIfAborted();

  // Result shape is [batch_size, dimensions]
  // Need to split into individual vectors
  const data = result.data as ArrayLike<number>;
  const dimensions = DEFAULT_EMBEDDING_CONFIG.dimensions;
  const embeddings: Float32Array[] = [];

  for (let i = 0; i < texts.length; i++) {
    const start = i * dimensions;
    const end = start + dimensions;
    embeddings.push(new Float32Array(Array.prototype.slice.call(data, start, end)));
  }

  return embeddings;
};

/**
 * Convert Float32Array to regular number array (for LadybugDB storage)
 */
export const embeddingToArray = (embedding: Float32Array): number[] => {
  return Array.from(embedding);
};

/**
 * Cleanup the embedder (free memory)
 * Call this when done with embeddings
 */
export const disposeEmbedder = async (): Promise<void> => {
  if (embedderInstance) {
    // transformers.js pipelines may have a dispose method
    try {
      if ('dispose' in embedderInstance && typeof embedderInstance.dispose === 'function') {
        await embedderInstance.dispose();
      }
    } catch {
      // Ignore disposal errors
    }
    embedderInstance = null;
    initPromise = null;
  }
};
