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
import { assessLocalEmbeddingRuntime, getLocalEmbeddingRuntimeBlocker } from './runtime-support.js';
import {
  ensureEmbeddingSidecar,
  getSidecarDevice,
  reapEmbeddingSidecarAndWait,
  sidecarEmbedBatch,
} from './embedding-sidecar-client.js';
import type { EmbeddingSidecarDevice } from './embedding-sidecar-protocol.js';

export type { ModelProgressCallback } from './types.js';

export const getCurrentDevice = (): EmbeddingSidecarDevice | null => {
  if (isHttpMode()) return null;
  return getSidecarDevice();
};

export const initEmbedder = async (
  onProgress?: ModelProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  forceDevice?: EmbeddingSidecarDevice,
): Promise<{ device: EmbeddingSidecarDevice }> => {
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

  return ensureEmbeddingSidecar({
    onProgress,
    embeddingConfig: config,
    forceDevice,
  });
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
 * Ready when HTTP embeddings are configured, or local runtime assessment
 * is `ready` (blocker / prefix-unloadable / missing-stack are not ready).
 * Sidecar liveness is not required. Resolution alone is not enough: a leftover
 * 1.6.12 package-first tree on darwin/x64 still resolves, then embedText throws.
 */
export const isEmbedderReady = (): boolean => {
  return isHttpMode() || assessLocalEmbeddingRuntime().status === 'ready';
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

  const [vec] = await sidecarEmbedBatch([text], options);
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

  return sidecarEmbedBatch(texts, options);
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
