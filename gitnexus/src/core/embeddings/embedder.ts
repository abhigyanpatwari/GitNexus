/**
 * Embedder façade — HTTP or embedding sidecar.
 *
 * This module must not import the Hugging Face transformers package, the
 * ONNX Node binding, the ONNX resolvers, or the child-only local init
 * module. Local inference runs in the sidecar child; the parent keeps
 * Ladybug writes.
 */

import {
  DEFAULT_EMBEDDING_CONFIG,
  type EmbeddingConfig,
  type ModelProgressCallback,
} from './types.js';
import {
  isHttpMode,
  getHttpDimensions,
  httpEmbed,
  type EmbeddingRequestOptions,
} from './http-client.js';
import { getLocalEmbeddingRuntimeBlocker } from './runtime-support.js';
import { resolveEmbeddingRuntime } from './runtime-install.js';
import {
  ensureEmbeddingSidecar,
  getSidecarDevice,
  reapEmbeddingSidecarAndWait,
  sidecarEmbedBatch,
} from './embedding-sidecar-client.js';
import type { EmbeddingSidecarDevice } from './embedding-sidecar-protocol.js';

export type { ModelProgressCallback } from './types.js';

export interface EmbeddingSidecarHandle {
  readonly source: 'sidecar';
  readonly device: EmbeddingSidecarDevice;
}

export const getCurrentDevice = (): EmbeddingSidecarDevice | null => {
  if (isHttpMode()) return null;
  return getSidecarDevice();
};

export const initEmbedder = async (
  onProgress?: ModelProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  forceDevice?: EmbeddingSidecarDevice,
): Promise<EmbeddingSidecarHandle> => {
  if (isHttpMode()) {
    throw new Error(
      'initEmbedder() should not be called in HTTP mode. ' +
        'Use embedText()/embedBatch() which handle HTTP transparently.',
    );
  }

  const runtimeBlocker = getLocalEmbeddingRuntimeBlocker();
  if (runtimeBlocker) {
    throw new Error(runtimeBlocker);
  }

  const { device } = await ensureEmbeddingSidecar({
    onProgress,
    embeddingConfig: config,
    forceDevice,
  });
  return { source: 'sidecar', device };
};

export const getEmbedder = (): never => {
  if (isHttpMode()) {
    throw new Error(
      'getEmbedder() is not available in HTTP embedding mode. Use embedText()/embedBatch() instead.',
    );
  }
  throw new Error(
    'getEmbedder() is not available. Local inference runs in the embedding sidecar. Use embedText()/embedBatch() instead.',
  );
};

/**
 * Ready when HTTP embeddings are configured, or the local stack resolves
 * without importing ONNX (KTD11). Sidecar liveness is not required.
 */
export const isEmbedderReady = (): boolean => {
  return isHttpMode() || resolveEmbeddingRuntime() !== null;
};

export const getEmbeddingDimensions = (): number => {
  if (isHttpMode()) {
    return getHttpDimensions() ?? DEFAULT_EMBEDDING_CONFIG.dimensions;
  }
  return DEFAULT_EMBEDDING_CONFIG.dimensions;
};

export const embedText = async (
  text: string,
  options: EmbeddingRequestOptions = {},
): Promise<Float32Array> => {
  options.signal?.throwIfAborted();
  if (isHttpMode()) {
    const [vec] = await httpEmbed([text], options);
    return vec;
  }

  const runtimeBlocker = getLocalEmbeddingRuntimeBlocker();
  if (runtimeBlocker) {
    throw new Error(runtimeBlocker);
  }

  const [vec] = await sidecarEmbedBatch([text]);
  options.signal?.throwIfAborted();
  return vec;
};

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

  const runtimeBlocker = getLocalEmbeddingRuntimeBlocker();
  if (runtimeBlocker) {
    throw new Error(runtimeBlocker);
  }

  const vectors = await sidecarEmbedBatch(texts);
  options.signal?.throwIfAborted();
  return vectors;
};

export const embeddingToArray = (embedding: Float32Array): number[] => {
  return Array.from(embedding);
};

/**
 * Reap the sidecar. Never runs ONNX dispose in this process.
 */
export const disposeEmbedder = async (): Promise<void> => {
  await reapEmbeddingSidecarAndWait();
};
