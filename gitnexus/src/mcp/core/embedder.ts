/**
 * Embedder Module (Read-Only)
 * 
 * Singleton factory for transformers.js embedding pipeline.
 * For MCP, we only need to compute query embeddings, not batch embed.
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';

/**
 * Check if CUDA is actually available on this system.
 * onnxruntime-node crashes with a native fatal error (not catchable by JS)
 * when attempting to load the CUDA provider without CUDA libraries installed.
 */
const isCudaAvailable = (): boolean => {
  try {
    execSync('nvidia-smi', { stdio: 'ignore', timeout: 3000 });
    const commonPaths = [
      '/usr/lib/x86_64-linux-gnu/libcuda.so',
      '/usr/lib/x86_64-linux-gnu/libcuda.so.1',
      '/usr/local/cuda/lib64/libcudart.so',
    ];
    return commonPaths.some(p => existsSync(p));
  } catch {
    return false;
  }
};

// Model config
const MODEL_ID = 'Snowflake/snowflake-arctic-embed-xs';
const EMBEDDING_DIMS = 384;

// Module-level state for singleton pattern
let embedderInstance: FeatureExtractionPipeline | null = null;
let isInitializing = false;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Initialize the embedding model (lazy, on first search)
 */
export const initEmbedder = async (): Promise<FeatureExtractionPipeline> => {
  if (embedderInstance) {
    return embedderInstance;
  }

  if (isInitializing && initPromise) {
    return initPromise;
  }

  isInitializing = true;

  initPromise = (async () => {
    try {
      env.allowLocalModels = false;
      
      console.error('GitNexus: Loading embedding model (first search may take a moment)...');

      // Try GPU first (DirectML on Windows, CUDA on Linux), fall back to CPU
      // IMPORTANT: Must verify CUDA before attempting — native crash if libs missing.
      const isWindows = process.platform === 'win32';
      const cudaAvailable = !isWindows && isCudaAvailable();
      const gpuDevice = isWindows ? 'dml' : (cudaAvailable ? 'cuda' : 'cpu');
      const devicesToTry: Array<'dml' | 'cuda' | 'cpu'> =
        gpuDevice === 'cpu' ? ['cpu'] : [gpuDevice, 'cpu'];
      
      for (const device of devicesToTry) {
        try {
          // Silence stdout during model load — ONNX Runtime and transformers.js
          // may write progress/init messages to stdout which corrupts MCP stdio protocol.
          const origWrite = process.stdout.write;
          process.stdout.write = (() => true) as any;
          try {
            embedderInstance = await (pipeline as any)(
              'feature-extraction',
              MODEL_ID,
              {
                device: device,
                dtype: 'fp32',
              }
            );
          } finally {
            process.stdout.write = origWrite;
          }
          console.error(`GitNexus: Embedding model loaded (${device})`);
          return embedderInstance!;
        } catch {
          if (device === 'cpu') throw new Error('Failed to load embedding model');
        }
      }

      throw new Error('No suitable device found');
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
 * Check if embedder is ready
 */
export const isEmbedderReady = (): boolean => embedderInstance !== null;

/**
 * Embed a query text for semantic search
 */
export const embedQuery = async (query: string): Promise<number[]> => {
  const embedder = await initEmbedder();
  
  const result = await embedder(query, {
    pooling: 'mean',
    normalize: true,
  });
  
  return Array.from(result.data as ArrayLike<number>);
};

/**
 * Get embedding dimensions
 */
export const getEmbeddingDims = (): number => EMBEDDING_DIMS;

/**
 * Cleanup embedder
 */
export const disposeEmbedder = async (): Promise<void> => {
  if (embedderInstance) {
    try {
      if ('dispose' in embedderInstance && typeof embedderInstance.dispose === 'function') {
        await embedderInstance.dispose();
      }
    } catch {}
    embedderInstance = null;
    initPromise = null;
  }
};
