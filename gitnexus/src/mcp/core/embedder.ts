/**
 * Embedder Module (Read-Only)
 * 
 * Singleton factory for transformers.js embedding pipeline.
 * For MCP, we only need to compute query embeddings, not batch embed.
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { isHttpMode, getHttpDimensions, httpEmbedQuery } from '../../core/embeddings/http-client.js';

// Model config
const MODEL_ID = 'Snowflake/snowflake-arctic-embed-xs';

/**
 * Check whether onnxruntime-node ships the CUDA execution provider.
 * Resolves from transformers' module scope to find the same binary it will dlopen.
 */
function hasOrtCudaProvider(): boolean {
  try {
    const require = createRequire(import.meta.url);
    const transformersDir = dirname(require.resolve('@huggingface/transformers/package.json'));
    const ortRequire = createRequire(join(transformersDir, 'package.json'));
    const ortPath = dirname(ortRequire.resolve('onnxruntime-node/package.json'));
    const arch = process.arch;
    return existsSync(join(ortPath, 'bin', 'napi-v6', 'linux', arch, 'libonnxruntime_providers_cuda.so'));
  } catch {
    return false;
  }
}

/**
 * Check whether CUDA libraries are available on the system.
 * A failed CUDA attempt poisons ONNX Runtime process state, making the
 * CPU fallback fail too.  We must probe before ever requesting CUDA.
 */
function isCudaAvailable(): boolean {
  if (!hasOrtCudaProvider()) return false;

  try {
    const out = execFileSync('ldconfig', ['-p'], { timeout: 3000, encoding: 'utf-8' });
    if (out.includes('libcublasLt.so.12')) return true;
  } catch {
    // ldconfig not available
  }

  for (const envVar of ['CUDA_PATH', 'LD_LIBRARY_PATH']) {
    const val = process.env[envVar];
    if (!val) continue;
    for (const dir of val.split(':').filter(Boolean)) {
      if (existsSync(join(dir, 'lib64', 'libcublasLt.so.12')) ||
          existsSync(join(dir, 'lib', 'libcublasLt.so.12')) ||
          existsSync(join(dir, 'libcublasLt.so.12'))) return true;
    }
  }

  return false;
}

// Module-level state for singleton pattern
let embedderInstance: FeatureExtractionPipeline | null = null;
let isInitializing = false;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Initialize the embedding model (lazy, on first search)
 */
export const initEmbedder = async (): Promise<FeatureExtractionPipeline> => {
  if (isHttpMode()) {
    throw new Error('initEmbedder() should not be called in HTTP mode.');
  }

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

      // Try GPU first (DirectML on Windows, CUDA on Linux), fall back to CPU.
      // CRITICAL: probe for CUDA before requesting it — a failed CUDA attempt
      // poisons ONNX Runtime's native state so even CPU fallback fails.
      const isWindows = process.platform === 'win32';
      const gpuDevice = isWindows ? 'dml' : (isCudaAvailable() ? 'cuda' : 'cpu');
      const devicesToTry: Array<'dml' | 'cuda' | 'cpu'> =
        (gpuDevice === 'dml' || gpuDevice === 'cuda')
          ? [gpuDevice, 'cpu']
          : ['cpu'];
      
      for (const device of devicesToTry) {
        try {
          // Silence stdout and stderr during model load — ONNX Runtime and transformers.js
          // may write progress/init messages that corrupt MCP stdio protocol or produce
          // noisy warnings (e.g. node assignment to execution providers).
          const origStdout = process.stdout.write;
          const origStderr = process.stderr.write;
          process.stdout.write = (() => true) as any;
          process.stderr.write = (() => true) as any;
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
            process.stdout.write = origStdout;
            process.stderr.write = origStderr;
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
export const isEmbedderReady = (): boolean => isHttpMode() || embedderInstance !== null;

/**
 * Embed a query text for semantic search
 */
export const embedQuery = async (query: string): Promise<number[]> => {
  if (isHttpMode()) {
    return httpEmbedQuery(query);
  }

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
export const getEmbeddingDims = (): number => {
  return getHttpDimensions() ?? 384;
};

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
