import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export type CapabilityStatus = 'available' | 'degraded' | 'unavailable';
export type SemanticSearchMode = 'vector-index' | 'exact-scan' | 'unavailable';

export interface RuntimeFingerprint {
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  gitnexus: string;
  ladybugdb?: string;
  onnxruntime?: string;
}

export interface RuntimeCapabilities {
  graph: CapabilityStatus;
  fts: CapabilityStatus;
  vector: CapabilityStatus;
  semanticMode: SemanticSearchMode;
  exactScanLimit: number;
  reason?: string;
}

const packageVersion = (name: string): string | undefined => {
  try {
    return require(`${name}/package.json`).version;
  } catch {
    return undefined;
  }
};

const gitnexusVersion = (): string => {
  try {
    return require('../../../package.json').version;
  } catch {
    return 'unknown';
  }
};

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const DEFAULT_EXACT_SCAN_LIMIT = 10_000;

export const getExactScanLimit = (): number =>
  parsePositiveInt(process.env.GITNEXUS_SEMANTIC_EXACT_SCAN_LIMIT, DEFAULT_EXACT_SCAN_LIMIT);

export const getRuntimeFingerprint = (): RuntimeFingerprint => ({
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  gitnexus: gitnexusVersion(),
  ladybugdb: packageVersion('@ladybugdb/core'),
  onnxruntime: packageVersion('onnxruntime-node'),
});

export const isVectorExtensionSupportedByPlatform = (
  platform: NodeJS.Platform = process.platform,
): boolean => platform !== 'win32';

export const getRuntimeCapabilities = (): RuntimeCapabilities => {
  const vector = isVectorExtensionSupportedByPlatform() ? 'available' : 'unavailable';
  const exactScanLimit = getExactScanLimit();
  return {
    graph: 'available',
    fts: 'available',
    vector,
    semanticMode: vector === 'available' ? 'vector-index' : 'exact-scan',
    exactScanLimit,
    reason:
      vector === 'unavailable'
        ? 'LadybugDB VECTOR is disabled on this platform; semantic search uses exact scan when embeddings exist.'
        : undefined,
  };
};

export const defaultEmbeddingThreads = (): number => {
  const available =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(available / 2) || 1));
};
