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
import { DEFAULT_EMBEDDING_CONFIG, type EmbeddingConfig, type ModelProgress } from './types.js';
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
let isInitializing = false;
let initPromise: Promise<FeatureExtractionPipeline> | null = null;
let currentDevice: 'dml' | 'cuda' | 'cpu' | 'wasm' | null = null;

export type ModelProgressCallback = (progress: ModelProgress) => void;

export const getCurrentDevice = (): 'dml' | 'cuda' | 'cpu' | 'wasm' | null => currentDevice;

export const initLocalEmbedder = async (
  onProgress?: ModelProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  forceDevice?: 'dml' | 'cuda' | 'cpu' | 'wasm',
): Promise<FeatureExtractionPipeline> => {
  const runtimeBlocker = getLocalEmbeddingRuntimeBlocker();
  if (runtimeBlocker) {
    throw new Error(runtimeBlocker);
  }

  if (embedderInstance) {
    return embedderInstance;
  }

  if (isInitializing && initPromise) {
    return initPromise;
  }

  isInitializing = true;

  const finalConfig = resolveEmbeddingConfig(config);
  const gpuDevice = isEffectiveCudaAvailable() ? 'cuda' : 'cpu';
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

export const isLocalEmbedderReady = (): boolean => embedderInstance !== null;

export const getLocalEmbedder = (): FeatureExtractionPipeline => {
  if (!embedderInstance) {
    throw new Error('Embedder not initialized. Call initLocalEmbedder() first.');
  }
  return embedderInstance;
};

export const localEmbedText = async (text: string): Promise<Float32Array> => {
  const embedder = getLocalEmbedder();
  const result = await embedder(text, {
    pooling: 'mean',
    normalize: true,
  });
  return new Float32Array(result.data as ArrayLike<number>);
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
 * Child-only. Parent façades must never call this — ONNX dispose can SIGSEGV
 * the process that loaded the binding. The parent reaps the child instead.
 */
export const disposeLocalEmbedder = async (): Promise<void> => {
  if (embedderInstance) {
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
