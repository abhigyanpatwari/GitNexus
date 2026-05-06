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

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import {
  DEFAULT_EMBEDDING_CONFIG,
  type EmbeddingConfig,
  type EmbeddingDevice,
  type ModelProgress,
} from './types.js';
import { isHttpMode, getHttpDimensions, httpEmbed } from './http-client.js';
import { resolveEmbeddingConfig } from './config.js';
import { applyHfEnvOverrides } from './hf-env.js';
import {
  formatDeviceLabel,
  getDeviceCandidates,
  isAcceleratedDevice,
  type ConcreteEmbeddingDevice,
} from './devices.js';

// Module-level state for singleton pattern
let embedderInstance: FeatureExtractionPipeline | null = null;
let isInitializing = false;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;
let currentDevice: ConcreteEmbeddingDevice | null = null;

/**
 * Progress callback type for model loading
 */
export type ModelProgressCallback = (progress: ModelProgress) => void;

/**
 * Get the current device being used for inference
 */
export const getCurrentDevice = (): ConcreteEmbeddingDevice | null => currentDevice;

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
  forceDevice?: ConcreteEmbeddingDevice,
): Promise<FeatureExtractionPipeline> => {
  if (isHttpMode()) {
    throw new Error(
      'initEmbedder() should not be called in HTTP mode. ' +
        'Use embedText()/embedBatch() which handle HTTP transparently.',
    );
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
  const requestedDevice: EmbeddingDevice = forceDevice || finalConfig.device;

  initPromise = (async () => {
    try {
      // Configure transformers.js environment
      env.allowLocalModels = false;
      // Bridge user-controlled env vars to transformers.js: HF_HOME →
      // env.cacheDir, HF_ENDPOINT → env.remoteHost (#1205). Centralised in
      // applyHfEnvOverrides so the MCP embedder entry point behaves
      // identically.
      applyHfEnvOverrides(env);

      const isDev = process.env.NODE_ENV === 'development';
      if (isDev) {
        console.log(`🧠 Loading embedding model: ${finalConfig.modelId}`);
      }

      const progressCallback = onProgress
        ? (data: any) => {
            const progress: ModelProgress = {
              status: data.status || 'progress',
              file: data.file,
              progress: data.progress,
              loaded: data.loaded,
              total: data.total,
            };
            onProgress(progress);
          }
        : undefined;

      const devicesToTry = getDeviceCandidates(requestedDevice);

      for (const device of devicesToTry) {
        try {
          if (isDev) {
            const action = isAcceleratedDevice(device) ? 'Trying' : 'Using';
            console.log(`🔧 ${action} ${formatDeviceLabel(device)} backend...`);
          }

          embedderInstance = await (pipeline as any)('feature-extraction', finalConfig.modelId, {
            device: device,
            dtype: 'fp32',
            progress_callback: progressCallback,
            session_options: {
              logSeverityLevel: 3,
              intraOpNumThreads: finalConfig.threads,
              interOpNumThreads: 1,
              executionMode: 'sequential',
            },
          });
          currentDevice = device;

          if (isDev) {
            console.log(`✅ Using ${formatDeviceLabel(device)} backend`);
            console.log('✅ Embedding model loaded successfully');
          }

          return embedderInstance!;
        } catch (deviceError) {
          if (isDev && isAcceleratedDevice(device)) {
            console.log(`⚠️  ${formatDeviceLabel(device)} not available, trying next backend...`);
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
export const embedText = async (text: string): Promise<Float32Array> => {
  if (isHttpMode()) {
    const [vec] = await httpEmbed([text]);
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
export const embedBatch = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) {
    return [];
  }

  if (isHttpMode()) {
    return httpEmbed(texts);
  }

  const embedder = getEmbedder();

  // Process batch
  const result = await embedder(texts, {
    pooling: 'mean',
    normalize: true,
  });

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
