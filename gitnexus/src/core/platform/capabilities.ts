import fs from 'fs';
import os from 'os';
import path from 'path';
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
    // Packages whose `exports` map omits ./package.json (e.g. @ladybugdb/core)
    // reject the direct require with ERR_PACKAGE_PATH_NOT_EXPORTED, which made
    // doctor print "LadybugDB: unknown" on every platform (#2374). Resolve the
    // entry point instead and walk up to the package's own package.json.
    try {
      let dir = path.dirname(require.resolve(name));
      // Entry points sit at the package root or a shallow dist/ dir; a few
      // hops always reach the package's own package.json.
      for (let hops = 0; hops < 5; hops++) {
        const candidate = path.join(dir, 'package.json');
        if (fs.existsSync(candidate)) {
          const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
            name?: string;
            version?: string;
          };
          if (pkg.name === name) return pkg.version;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return undefined;
    } catch {
      return undefined;
    }
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
