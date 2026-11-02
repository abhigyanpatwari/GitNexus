/**
 * Embedding sidecar IPC types.
 *
 * Declarations only — consumers `import type` so this leaf never pulls the
 * local ONNX init path or the parent façade. Mirrors `analyze-worker-protocol.ts`.
 */

import type { EmbeddingConfig, ModelProgress } from './types.js';

export type EmbeddingSidecarDevice = 'dml' | 'cuda' | 'cpu' | 'wasm';

export type SidecarRequest =
  | {
      id: number;
      type: 'init';
      embeddingConfig?: Partial<EmbeddingConfig>;
      forceDevice?: EmbeddingSidecarDevice;
    }
  | { id: number; type: 'embed'; texts: string[] };

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type SidecarRequestBody = DistributiveOmit<SidecarRequest, 'id'>;

export type SidecarResponse =
  | { id: number; type: 'ready'; device: EmbeddingSidecarDevice }
  | { id: number; type: 'progress'; progress: number; status: ModelProgress['status'] }
  | { id: number; type: 'vectors'; vectors: number[][] }
  | { id: number; type: 'error'; message: string };
