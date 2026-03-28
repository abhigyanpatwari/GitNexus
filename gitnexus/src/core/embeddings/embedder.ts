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
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { DEFAULT_EMBEDDING_CONFIG, type EmbeddingConfig, type ModelProgress } from './types.js';
import { isHttpMode, getHttpDimensions, httpEmbed } from './http-client.js';

/**
 * Check whether the onnxruntime-node package that @huggingface/transformers
 * will actually load at runtime ships the CUDA execution provider.
 *
 * Critical: we resolve from transformers' own module scope, NOT from ours.
 * npm may install two copies — a top-level 1.24.x (our dep) and a nested
 * 1.21.0 (transformers' pinned dep). The guard must inspect whichever copy
 * transformers.js will dlopen, otherwise the check is meaningless.
 */
function hasOrtCudaProvider(): boolean {
  try {
    const require = createRequire(import.meta.url);
    // Resolve from @huggingface/transformers' scope so we find the same
    // onnxruntime-node binary that transformers.js will use at runtime
    const transformersDir = dirname(require.resolve('@huggingface/transformers/package.json'));
    const ortRequire = createRequire(join(transformersDir, 'package.json'));
    const ortPath = dirname(ortRequire.resolve('onnxruntime-node/package.json'));
    // ORT 1.24.x only ships CUDA binaries for linux/x64 (downloaded from NuGet
    // at postinstall). arm64 will correctly return false here until ORT adds support.
    const arch = process.arch;
    return existsSync(
      join(ortPath, 'bin', 'napi-v6', 'linux', arch, 'libonnxruntime_providers_cuda.so'),
    );
  } catch {
    return false;
  }
}

/**
 * Check whether CUDA libraries are actually available on this system.
 * ONNX Runtime's native layer crashes (uncatchable) if we attempt CUDA
 * without the required shared libraries, so we probe first.
 *
 * Checks both:
 * 1. That system CUDA libraries (libcublasLt) are present
 * 2. That onnxruntime-node ships the CUDA execution provider binary
 *
 * Both conditions must be true — system CUDA libs alone are not enough
 * if onnxruntime-node is a CPU-only build (versions < 1.24.0).
 */
function isCudaAvailable(): boolean {
  // First, verify onnxruntime-node has the CUDA provider binary.
  // Without this, requesting CUDA causes an uncatchable native crash.
  if (!hasOrtCudaProvider()) return false;

  // Primary: query the dynamic linker cache — covers all architectures,
  // distro layouts, and custom install paths registered with ldconfig
  try {
    const out = execFileSync('ldconfig', ['-p'], { timeout: 3000, encoding: 'utf-8' });
    if (out.includes('libcublasLt.so.12')) return true;
  } catch {
    // ldconfig not available (e.g. non-standard container)
  }

  // Fallback: check CUDA_PATH and LD_LIBRARY_PATH for environments where
  // ldconfig doesn't know about the CUDA install (conda, manual /opt/cuda, etc.)
  for (const envVar of ['CUDA_PATH', 'LD_LIBRARY_PATH']) {
    const val = process.env[envVar];
    if (!val) continue;
    for (const dir of val.split(':').filter(Boolean)) {
      if (
        existsSync(join(dir, 'lib64', 'libcublasLt.so.12')) ||
        existsSync(join(dir, 'lib', 'libcublasLt.so.12')) ||
        existsSync(join(dir, 'libcublasLt.so.12'))
      )
        return true;
    }
  }

  return false;
}

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

  // Return existing instance if available
  if (embedderInstance) {
    return embedderInstance;
  }

  // If already initializing, wait for that promise
  if (isInitializing && initPromise) {
    return initPromise;
  }

  isInitializing = true;

  const finalConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config };
  // On Windows, use DirectML for GPU acceleration (via DirectX12)
  // CUDA is only available on Linux x64 with onnxruntime-node
  // Probe for CUDA first — ONNX Runtime crashes (uncatchable native error)
  // if we attempt CUDA without the required shared libraries
  const isWindows = process.platform === 'win32';
  const gpuDevice = isWindows ? 'dml' : isCudaAvailable() ? 'cuda' : 'cpu';
  const requestedDevice =
    forceDevice || (finalConfig.device === 'auto' ? gpuDevice : finalConfig.device);

  initPromise = (async () => {
    try {
      // Configure transformers.js environment
      env.allowLocalModels = false;

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

      // Try GPU first if auto, fall back to CPU
      // Windows: dml (DirectML/DirectX12), Linux: cuda
      const devicesToTry: Array<'dml' | 'cuda' | 'cpu' | 'wasm'> =
        requestedDevice === 'dml' || requestedDevice === 'cuda'
          ? [requestedDevice, 'cpu']
          : [requestedDevice as 'cpu' | 'wasm'];

      for (const device of devicesToTry) {
        try {
          if (isDev && device === 'dml') {
            console.log('🔧 Trying DirectML (DirectX12) GPU backend...');
          } else if (isDev && device === 'cuda') {
            console.log('🔧 Trying CUDA GPU backend...');
          } else if (isDev && device === 'cpu') {
            console.log('🔧 Using CPU backend...');
          } else if (isDev && device === 'wasm') {
            console.log('🔧 Using WASM backend (slower)...');
          }

          embedderInstance = await (pipeline as any)('feature-extraction', finalConfig.modelId, {
            device: device,
            dtype: 'fp32',
            progress_callback: progressCallback,
            session_options: { logSeverityLevel: 3 },
          });
          currentDevice = device;

          if (isDev) {
            const label =
              device === 'dml'
                ? 'GPU (DirectML/DirectX12)'
                : device === 'cuda'
                  ? 'GPU (CUDA)'
                  : device.toUpperCase();
            console.log(`✅ Using ${label} backend`);
            console.log('✅ Embedding model loaded successfully');
          }

          return embedderInstance!;
        } catch (deviceError) {
          if (isDev && (device === 'cuda' || device === 'dml')) {
            const gpuType = device === 'dml' ? 'DirectML' : 'CUDA';
            console.log(`⚠️  ${gpuType} not available, falling back to CPU...`);
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
