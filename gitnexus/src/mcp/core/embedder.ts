/**
 * Embedder Module (Read-Only)
 *
 * Singleton factory for transformers.js embedding pipeline.
 * For MCP, we only need to compute query embeddings, not batch embed.
 */

import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers';
import {
  isHttpMode,
  getHttpDimensions,
  httpEmbedQuery,
} from '../../core/embeddings/http-client.js';
import { silenceStdout, restoreStdout, realStderrWrite } from '../../core/lbug/pool-adapter.js';

// Model config
const MODEL_ID = 'Snowflake/snowflake-arctic-embed-xs';

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
      // Default cache to user-writable location. transformers.js defaults to
      // ./node_modules/.cache inside its own install dir, which is unwritable
      // when gitnexus is installed globally (e.g. /usr/lib/node_modules/).
      // Respect HF_HOME if set, otherwise fall back to ~/.cache/huggingface.
      env.cacheDir = process.env.HF_HOME ?? `${process.env.HOME}/.cache/huggingface`;

      console.error('GitNexus: Loading embedding model (first search may take a moment)...');

      // Try GPU first (DirectML on Windows, CUDA on Linux), fall back to CPU
      const isWindows = process.platform === 'win32';
      const gpuDevice = isWindows ? 'dml' : 'cuda';
      const devicesToTry: Array<'dml' | 'cuda' | 'cpu'> = [gpuDevice, 'cpu'];

      for (const device of devicesToTry) {
        try {
          // Silence stdout and stderr during model load — ONNX Runtime and transformers.js
          // may write progress/init messages that corrupt MCP stdio protocol or produce
          // noisy warnings (e.g. node assignment to execution providers).
          // Use the centralized silenceStdout() to avoid conflicts with pool-adapter's
          // own stdout patching (independent patching caused restore-order bugs).
          silenceStdout();
          process.stderr.write = (() => true) as any;
          try {
            embedderInstance = await (pipeline as any)('feature-extraction', MODEL_ID, {
              device: device,
              dtype: 'fp32',
            });
          } finally {
            restoreStdout();
            process.stderr.write = realStderrWrite;
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
