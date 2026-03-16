/**
 * Embedder Module
 * 
 * Singleton factory for transformers.js embedding pipeline.
 * Handles model loading, caching, and both single and batch embedding operations.
 * 
 * Uses snowflake-arctic-embed-xs by default (22M params, 384 dims, ~90MB)
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { DEFAULT_EMBEDDING_CONFIG, type EmbeddingConfig, type ModelProgress } from './types';

// Module-level state for singleton pattern
let embedderInstance: FeatureExtractionPipeline | null = null;
let isInitializing = false;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;
let currentDevice: 'webgpu' | 'wasm' | null = null;

/**
 * Progress callback type for model loading
 */
export type ModelProgressCallback = (progress: ModelProgress) => void;

/**
 * Custom error thrown when WebGPU is not available
 * Allows UI to prompt user for fallback choice
 */
export class WebGPUNotAvailableError extends Error {
  constructor(originalError?: Error) {
    super('WebGPU not available in this browser');
    this.name = 'WebGPUNotAvailableError';
    this.cause = originalError;
  }
}

/**
 * Check if WebGPU is available in this browser
 * Quick check without loading the model
 */
export const checkWebGPUAvailability = async (): Promise<boolean> => {
  try {
    // Cast to any to avoid WebGPU types not being available in all TS configs
    const nav = navigator as any;
    if (!nav.gpu) {
      return false;
    }
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) {
      return false;
    }
    // Try to get a device - this is where it usually fails
    const device = await adapter.requestDevice();
    device.destroy(); // Clean up
    return true;
  } catch {
    return false;
  }
};

/**
 * Get the current device being used for inference
 */
export const getCurrentDevice = (): 'webgpu' | 'wasm' | null => currentDevice;

/**
 * Initialize the embedding model
 * Uses singleton pattern - only loads once, subsequent calls return cached instance
 * 
 * @param onProgress - Optional callback for model download progress
 * @param config - Optional configuration override
 * @param forceDevice - Force a specific device (bypasses WebGPU check)
 * @returns Promise resolving to the embedder pipeline
 * @throws WebGPUNotAvailableError if WebGPU is requested but unavailable
 */
export const initEmbedder = async (
  onProgress?: ModelProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  forceDevice?: 'webgpu' | 'wasm'
): Promise<FeatureExtractionPipeline> => {
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
  const requestedDevice = forceDevice || finalConfig.device;

  initPromise = (async () => {
    try {
      // Configure transformers.js environment
      env.allowLocalModels = false;
      
      if (import.meta.env.DEV) {
        console.log(`🧠 Loading embedding model: ${finalConfig.modelId}`);
      }

      const progressCallback = onProgress ? (data: any) => {
        const progress: ModelProgress = {
          status: data.status || 'progress',
          file: data.file,
          progress: data.progress,
          loaded: data.loaded,
          total: data.total,
        };
        onProgress(progress);
      } : undefined;

      // If WebGPU is requested (default), check availability first
      if (requestedDevice === 'webgpu') {
        if (import.meta.env.DEV) {
          console.log('🔧 Checking WebGPU availability...');
        }
        
        const webgpuAvailable = await checkWebGPUAvailability();
        
        if (!webgpuAvailable) {
          if (import.meta.env.DEV) {
            console.warn('⚠️ WebGPU not available');
          }
          isInitializing = false;
          initPromise = null;
          throw new WebGPUNotAvailableError();
        }
        
        // Try WebGPU
        try {
          if (import.meta.env.DEV) {
            console.log('🔧 Initializing WebGPU backend...');
          }
          
          // Type assertion needed due to complex union types in transformers.js
          embedderInstance = await (pipeline as any)(
            'feature-extraction',
            finalConfig.modelId,
            {
              device: 'webgpu',
              dtype: 'fp32',
              progress_callback: progressCallback,
            }
          );
          currentDevice = 'webgpu';
          
          if (import.meta.env.DEV) {
            console.log('✅ Using WebGPU backend');
          }
        } catch (err) {
          if (import.meta.env.DEV) {
            console.warn('⚠️ WebGPU initialization failed:', err);
          }
          isInitializing = false;
          initPromise = null;
          embedderInstance = null;
          throw new WebGPUNotAvailableError(err as Error);
        }
      } else {
        // WASM mode requested (user chose fallback)
        if (import.meta.env.DEV) {
          console.log('🔧 Initializing WASM backend (this will be slower)...');
        }
        
        // Type assertion needed due to complex union types in transformers.js
        embedderInstance = await (pipeline as any)(
          'feature-extraction',
          finalConfig.modelId,
          {
            device: 'wasm', // WASM-based CPU execution
            dtype: 'fp32',
            progress_callback: progressCallback,
          }
        );
        currentDevice = 'wasm';
        
        if (import.meta.env.DEV) {
          console.log('✅ Using WASM backend');
        }
      }

      if (import.meta.env.DEV) {
        console.log('✅ Embedding model loaded successfully');
      }

      return embedderInstance!;
    } catch (error) {
      // Re-throw WebGPUNotAvailableError as-is
      if (error instanceof WebGPUNotAvailableError) {
        throw error;
      }
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
  return embedderInstance !== null;
};

/**
 * Get the embedder instance (throws if not initialized)
 */
export const getEmbedder = (): FeatureExtractionPipeline => {
  if (!embedderInstance) {
    throw new Error('Embedder not initialized. Call initEmbedder() first.');
  }
  return embedderInstance;
};

/**
 * Embed a single text string
 * 
 * @param text - Text to embed
 * @returns Float32Array of embedding vector (384 dimensions)
 */
export const embedText = async (text: string): Promise<Float32Array> => {
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

